/**
 * POST /api/input-photo — photo → avatar pipeline.
 *
 * Validates the photo contains a face using vision, then submits it to
 * /api/forge as an image-conditioned generation with an avatar-optimised
 * prompt so the result is a humanoid mesh ready to be auto-rigged.
 *
 * Privacy — transient by default:
 *   • The source image is NEVER stored in the creation log (preview_image_url)
 *     unless the caller sets privacy_opt_in:true.
 *   • If the caller also supplies storage_key (the R2 key returned by
 *     /api/forge-upload), the object is deleted from R2 immediately after the
 *     generation job is created — before this response is returned.
 *   • No image bytes or face data are ever written to application logs or Sentry.
 *   • With privacy_opt_in:true the key is kept and the preview image is visible
 *     in the creation history, matching the standard Forge behaviour.
 *
 * Request:
 *   POST /api/input-photo
 *   Content-Type: application/json
 *   {
 *     image_url:       string,  // public https URL of the uploaded photo (required)
 *     storage_key?:    string,  // R2 key from /api/forge-upload (for transient delete)
 *     privacy_opt_in?: boolean, // default false — keep image in creation log
 *     tier?:           string,  // "draft" | "standard" | "high"  (default "standard")
 *     skip_face_check?: boolean // override face-presence gate
 *   }
 *
 * Response 200:
 *   { job_id, creation_id, mode:"photo_to_avatar", auto_rig:true,
 *     privacy_note:string, ... }
 *
 * Error 422 face_not_detected  — face check failed (guidable)
 * Error 422 image_not_usable   — image too blurry / no subject etc.
 * Error 503 not_configured     — vision or generation backend unavailable
 */

import { cors, json, method, readJson, wrap, rateLimited, error } from './_lib/http.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import { visionConfigured, describeImage } from './_lib/vision.js';
import { deleteObject } from './_lib/r2.js';
import { env } from './_lib/env.js';
import { fetchUpstream } from './_lib/upstream-fetch.js';

export const maxDuration = 60;

// R2 key format written by /api/forge-upload.
const R2_KEY_RE = /^forge\/uploads\/[a-f0-9]{12}\/[a-f0-9-]{36}\.(png|jpg|webp)$/;
const HTTP_URL_RE = /^https?:\/\/.{1,2044}$/;

// Vision prompt tuned for face detection in selfies / portraits.
// We only need a boolean "face present?" — keep it cheap (64 tokens max).
const FACE_CHECK_PROMPT =
	'Does this image contain a clearly visible human face or humanoid character face? ' +
	'Reply with compact JSON only, no prose:\n' +
	'{"face":true|false,"reason":"<≤10 words describing what is in the image>"}\n' +
	'Mark face:false only when there is genuinely no face at all (e.g. landscape, text, ' +
	'an inanimate object with no visible face). When in doubt, mark face:true.';

// Avatar generation hint injected into the forge prompt.
const AVATAR_PROMPT_HINT =
	'full body humanoid avatar, front-facing, neutral A-pose, plain background';

const PRIVACY_NOTE_TRANSIENT =
	'Your photo was processed transiently and was not stored. ' +
	'It will not appear in creation history or be visible to others.';
const PRIVACY_NOTE_RETAINED =
	'You opted in to retaining your photo. It is stored as the preview image ' +
	'for this creation and may appear in your creation history.';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS' })) return;
	if (!method(req, res, ['POST'])) return;

	const ip = clientIp(req);
	const rl = await limits.mcp3dGenerate(ip);
	if (!rl.success) {
		return rateLimited(res, rl, 'Generation limit reached. Try again shortly.');
	}

	const body = await readJson(req, 8_000).catch(() => null);

	const imageUrl = typeof body?.image_url === 'string' ? body.image_url.trim() : '';
	if (!HTTP_URL_RE.test(imageUrl) || imageUrl.length > 2048) {
		return error(res, 400, 'invalid_image_url',
			'image_url must be a public https URL, max 2048 characters.');
	}

	const storageKey =
		typeof body?.storage_key === 'string' && R2_KEY_RE.test(body.storage_key.trim())
			? body.storage_key.trim()
			: null;
	const privacyOptIn = body?.privacy_opt_in === true;
	const skipFaceCheck = body?.skip_face_check === true;

	const tier = ['draft', 'standard', 'high'].includes(body?.tier) ? body.tier : 'standard';

	// Face validation — skip gracefully if vision is not configured.
	if (!skipFaceCheck && visionConfigured()) {
		try {
			const vision = await describeImage({
				prompt: FACE_CHECK_PROMPT,
				imageUrl,
				maxTokens: 64,
				timeoutMs: 12_000,
				track: { tool: 'api/input-photo' },
			});
			let parsed = null;
			try {
				const clean = vision.text.replace(/^```[a-z]*\n?|\n?```$/g, '').trim();
				parsed = JSON.parse(clean);
			} catch { /* malformed — fail open */ }

			if (parsed && parsed.face === false) {
				return json(res, 422, {
					error: 'face_not_detected',
					reason: parsed.reason || 'no face found',
					message:
						'No face was detected in that image. ' +
						'Upload a clear selfie or portrait where your face is visible. ' +
						'For non-portrait objects, use the standard Photo or Sketch modality.',
					override: { field: 'skip_face_check', value: true },
				});
			}
		} catch { /* vision unavailable — fail open, let forge validate */ }
	}

	// Build the forge request: image→3D with avatar-hint prompt.
	const forgeBody = {
		image_urls: [imageUrl],
		prompt: AVATAR_PROMPT_HINT,
		path: 'image',
		tier,
		// Suppress forge's own vision pre-check (we already ran ours) so we don't
		// double-charge the vision quota on every photo-to-avatar submission.
		skip_validation: true,
	};

	// Self-call /api/forge — keeps generation logic in one place.
	// env.APP_ORIGIN always resolves (api/_lib/env.js falls back to the canonical
	// origin), so this self-call lands on the deployment's own /api/forge.
	const forgeOrigin = env.APP_ORIGIN;
	let forgeResp;
	try {
		// The self-call is cheap (forge queues a job and answers with its id), but
		// unbounded it could hold this handler until the platform killed it, which
		// the client reads as a dead endpoint rather than a slow one. One attempt
		// only: this POST enqueues a generation, so replaying it would queue a
		// second job and bill the user twice. Forge's own status codes are handled
		// below, so a non-2xx must come back as a Response rather than throw.
		forgeResp = await fetchUpstream(`${forgeOrigin}/api/forge`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				// Thread the real client IP so forge's rate limiter sees the right caller.
				'x-forwarded-for': ip,
				'x-forge-client': req.headers['x-forge-client'] || '',
			},
			body: JSON.stringify(forgeBody),
		}, { name: 'self:forge-submit', timeoutMs: 30_000, attempts: 1, okWhen: () => true });
	} catch {
		return error(res, 502, 'generation_unreachable',
			'Could not reach the generation service. Please try again.');
	}

	const forgeData = await forgeResp.json().catch(() => null);

	if (!forgeResp.ok || !forgeData) {
		// Surface forge's own error code if available, otherwise re-map.
		const code = forgeData?.error || 'generation_failed';
		const msg = forgeData?.message || 'Generation failed. Please try again.';
		return json(res, forgeResp.status >= 500 ? 502 : forgeResp.status, {
			error: code,
			message: msg,
		});
	}

	// Transient privacy: delete the R2 object now that the provider has the URL.
	// We fire-and-forget this — a delete failure must not block the response.
	if (!privacyOptIn && storageKey) {
		deleteObject(storageKey).catch(() => { /* best-effort */ });
	}

	return json(res, 200, {
		...forgeData,
		mode: 'photo_to_avatar',
		auto_rig: true,
		privacy_retained: privacyOptIn,
		privacy_note: privacyOptIn ? PRIVACY_NOTE_RETAINED : PRIVACY_NOTE_TRANSIENT,
	}, { 'cache-control': 'no-store' });
});
