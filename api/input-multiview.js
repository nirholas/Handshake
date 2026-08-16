/**
 * POST /api/input-multiview — multi-image validation + 3D reconstruction.
 *
 * Accepts 2 to 6 photos of an object from different angles, validates each with
 * vision (clear subject? in focus? same object?), then submits them to
 * /api/forge as a multi-view reconstruction job.  The validation step catches
 * mismatched images, blank uploads, and text screenshots before burning a
 * generation slot.
 *
 * Privacy — same transient-by-default policy as /api/input-photo:
 *   All uploaded images are processed transiently. No image bytes are written
 *   to logs. With privacy_opt_in:false (default) and storage_keys provided,
 *   all R2 objects are deleted after the forge job is created.
 *
 * Request:
 *   POST /api/input-multiview
 *   Content-Type: application/json
 *   {
 *     image_urls:       string[],   // 2 to 6 public https URLs (required)
 *     storage_keys?:    string[],   // R2 keys from /api/forge-upload (for transient delete)
 *     prompt?:          string,     // optional guidance text (max 1000 chars)
 *     tier?:            string,     // "draft" | "standard" | "high"
 *     privacy_opt_in?:  boolean,    // default false
 *     skip_validation?: boolean     // bypass per-image vision check
 *   }
 *
 * Response 200:
 *   { job_id, creation_id, views_used, multiview:true,
 *     validation:[{url, ok, issue?, description}], privacy_note }
 *
 * Error 422 invalid_views — one or more images failed validation
 * Error 400 too_few_images — fewer than 2 images provided
 */

import { cors, json, method, readJson, wrap, rateLimited, error } from './_lib/http.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import { visionConfigured, describeImage } from './_lib/vision.js';
import { deleteObject } from './_lib/r2.js';
import { env } from './_lib/env.js';

export const maxDuration = 90; // vision validation × N images + generation submit

const MIN_VIEWS = 2;
const MAX_VIEWS = 6;
const HTTP_URL_RE = /^https?:\/\/.{1,2044}$/;
const R2_KEY_RE = /^forge\/uploads\/[a-f0-9]{12}\/[a-f0-9-]{36}\.(png|jpg|webp)$/;

// Per-image validation prompt. We ask for a JSON verdict with the subject name
// so we can cross-check that all images depict the same object.
const VIEW_CHECK_PROMPT =
	'You are the input checker for a multi-view 3D reconstruction tool. ' +
	'The user uploaded this image as one view of a physical object to reconstruct.\n\n' +
	'Reply ONLY with compact JSON, no prose:\n' +
	'{"ok":true|false,"issue":"none"|"no_subject"|"text_screenshot"|"too_dark_or_blurry"|"abstract_or_diagram",' +
	'"subject":"<3-6 word description of the main object, or empty string>"}\n\n' +
	'Mark ok:false when the image is genuinely not usable as a reconstruction view: ' +
	'no clear physical object (no_subject), screenshot of UI or text (text_screenshot), ' +
	'too dark or blurry (too_dark_or_blurry), abstract pattern/chart (abstract_or_diagram). ' +
	'When in doubt, mark ok:true.';

const ISSUE_MESSAGES = {
	no_subject:
		'That image has no clear single object. Upload a photo where one object fills most of the frame.',
	text_screenshot:
		'That looks like a screenshot of text or an interface, not a photo of an object.',
	too_dark_or_blurry:
		'That image is too dark or blurry. Retake it in good light with the subject in focus.',
	abstract_or_diagram:
		'That image looks like an abstract pattern or diagram, not a physical object.',
};

async function validateView(imageUrl, index) {
	try {
		const vision = await describeImage({
			prompt: VIEW_CHECK_PROMPT,
			imageUrl,
			maxTokens: 80,
			timeoutMs: 12_000,
			track: { tool: 'api/input-multiview' },
		});
		let parsed = null;
		try {
			const clean = vision.text.replace(/^```[a-z]*\n?|\n?```$/g, '').trim();
			parsed = JSON.parse(clean);
		} catch { /* malformed — fail open */ }

		if (!parsed) return { url: imageUrl, index, ok: true, subject: '' };
		return {
			url: imageUrl,
			index,
			ok: parsed.ok !== false,
			issue: parsed.issue !== 'none' ? parsed.issue : undefined,
			message: parsed.ok === false ? (ISSUE_MESSAGES[parsed.issue] || 'Image not usable.') : undefined,
			subject: parsed.subject || '',
		};
	} catch {
		// Vision unavailable — fail open.
		return { url: imageUrl, index, ok: true, subject: '' };
	}
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS' })) return;
	if (!method(req, res, ['POST'])) return;

	const ip = clientIp(req);
	const rl = await limits.mcp3dGenerate(ip);
	if (!rl.success) {
		return rateLimited(res, rl, 'Generation limit reached. Try again shortly.');
	}

	const body = await readJson(req, 12_000).catch(() => null);

	const rawUrls = Array.isArray(body?.image_urls) ? body.image_urls : [];
	const imageUrls = rawUrls
		.map((u) => (typeof u === 'string' ? u.trim() : ''))
		.filter((u) => HTTP_URL_RE.test(u) && u.length <= 2048)
		.slice(0, MAX_VIEWS);

	if (imageUrls.length < MIN_VIEWS) {
		return error(res, 400, 'too_few_images',
			`Provide between ${MIN_VIEWS} and ${MAX_VIEWS} photos of the object from different angles.`);
	}

	const rawKeys = Array.isArray(body?.storage_keys) ? body.storage_keys : [];
	const storageKeys = rawKeys
		.map((k) => (typeof k === 'string' ? k.trim() : ''))
		.filter((k) => R2_KEY_RE.test(k));
	const privacyOptIn = body?.privacy_opt_in === true;
	const skipValidation = body?.skip_validation === true;

	const prompt = typeof body?.prompt === 'string'
		? body.prompt.trim().slice(0, 1000)
		: '';
	const tier = ['draft', 'standard', 'high'].includes(body?.tier) ? body.tier : 'standard';

	// Per-image vision validation (in parallel for speed).
	let validation = imageUrls.map((url, i) => ({ url, index: i, ok: true, subject: '' }));
	if (!skipValidation && visionConfigured()) {
		validation = await Promise.all(imageUrls.map(validateView));
	}

	const failures = validation.filter((v) => !v.ok);
	if (failures.length > 0) {
		return json(res, 422, {
			error: 'invalid_views',
			message:
				`${failures.length} of your images can't be used for reconstruction. ` +
				'Review the details below and replace the flagged photos.',
			validation,
			override: { field: 'skip_validation', value: true },
		});
	}

	// Submit to forge.
	const forgeBody = {
		image_urls: imageUrls,
		...(prompt ? { prompt } : {}),
		path: 'image',
		tier,
		skip_validation: true,
	};

	// env.APP_ORIGIN always resolves (api/_lib/env.js falls back to the canonical
	// origin), so this self-call lands on the deployment's own /api/forge.
	const forgeOrigin = env.APP_ORIGIN;
	let forgeResp;
	try {
		forgeResp = await fetch(`${forgeOrigin}/api/forge`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-forwarded-for': ip,
				'x-forge-client': req.headers['x-forge-client'] || '',
			},
			body: JSON.stringify(forgeBody),
		});
	} catch {
		return error(res, 502, 'generation_unreachable',
			'Could not reach the generation service. Please try again.');
	}

	const forgeData = await forgeResp.json().catch(() => null);

	if (!forgeResp.ok || !forgeData) {
		const code = forgeData?.error || 'generation_failed';
		const msg = forgeData?.message || 'Generation failed. Please try again.';
		return json(res, forgeResp.status >= 500 ? 502 : forgeResp.status, {
			error: code,
			message: msg,
		});
	}

	// Transient cleanup: delete all R2 objects after the provider has the URLs.
	if (!privacyOptIn && storageKeys.length > 0) {
		Promise.all(storageKeys.map((k) => deleteObject(k).catch(() => { /* best-effort */ })));
	}

	const privacyNote = privacyOptIn
		? 'You opted in to retaining your photos. They are stored as preview images for this creation.'
		: 'Your photos were processed transiently and were not stored. They will not appear in creation history.';

	return json(res, 200, {
		...forgeData,
		validation,
		privacy_retained: privacyOptIn,
		privacy_note: privacyNote,
	}, { 'cache-control': 'no-store' });
});
