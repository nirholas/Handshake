// POST /api/vision — public image-understanding endpoint.
//
// A thin HTTP surface over the canonical vision lib (api/_lib/vision.js): the
// free-first NIM VLM chain, paid backstop, SSRF guard, and spend-ledger all live
// there and are inherited here — this file does not re-implement provider policy.
// The capability already powers Forge upload checks, the Fact Checker, and
// gallery alt text internally; exposing it over HTTP is the additive part, so
// external agents and the client can ask a free model about an image too.
//
// Request: raw image bytes as the body (Content-Type sets the image type), or a
//   JSON body { image: <base64 or data URI>, imageUrl?, prompt?, maxTokens? }.
//   `imageUrl` must be a public https URL (the model server fetches it — the lib
//   SSRF-guards it). Query/JSON: prompt (the question; defaults to a concise
//   describe), maxTokens.
// Response: { text, provider, model }.

import { cors, method, readBody, readJson, error, json, wrap, rateLimited } from './_lib/http.js';
import { getSessionUser, authenticateBearer, extractBearer } from './_lib/auth.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import { describeImage, visionConfigured, VisionUnavailableError } from './_lib/vision.js';

export const maxDuration = 60;

// 12 MiB — comfortably covers a high-res viewer screenshot or photo while
// bounding the in-memory buffer per request.
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const VISION_TIMEOUT_MS = 20_000;
// Overall budget for the WHOLE request, not just the provider chain. It used to
// bound only describeImage, which meant the real wall clock was this plus
// whatever the body read took first, up to READ_BODY_TIMEOUT_MS (15s) for a
// 12 MB upload on a slow link, so ~39s worst case. That overruns a 30s gateway
// timeout, and the caller gets an opaque 504 from the edge instead of the clean,
// diagnosable one this endpoint is careful to produce (2026-08-07: two 504s on
// agent uploads with no matching app-level error, the signature of the request
// dying above the handler).
//
// Charging the upload against the same budget keeps the endpoint's total under
// the gateway's, so a slow upload eats into model time rather than adding to it.
const VISION_DEADLINE_MS = 24_000;
// Floor for the model chain after a slow upload: below this even the fastest
// lane cannot answer, so it is better to say so than to burn the remainder.
const VISION_MIN_CHAIN_MS = 4_000;

const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const DEFAULT_PROMPT =
	'Describe this 3D model or avatar render in two sentences: subject, style, and notable details. Be concrete and concise.';

function isAcceptedImageType(ct) {
	const type = String(ct || '').split(';')[0].trim().toLowerCase();
	return ACCEPTED_TYPES.includes(type) ? type : null;
}

export default wrap(async function handler(req, res) {
	const startedAt = Date.now();
	if (cors(req, res, { methods: 'GET,POST,OPTIONS' })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	// Capability probe — lets a UI decide whether to offer "describe / critique"
	// affordances without guessing. Cheap, unauthenticated, briefly cacheable.
	if (req.method === 'GET' || req.method === 'HEAD') {
		return json(
			res,
			200,
			{ configured: visionConfigured(), imageTypes: ACCEPTED_TYPES },
			{ 'cache-control': 'public, max-age=60' },
		);
	}

	if (!visionConfigured()) {
		return error(res, 503, 'not_configured', 'Vision is not configured (set NVIDIA_API_KEY, GOOGLE_CLOUD_PROJECT for the Vertex Gemini credits anchor, or OPENAI_API_KEY for the paid backstop)');
	}

	// Metered like the other free NVIDIA lanes.
	const session = await getSessionUser(req);
	const bearer = session ? null : await authenticateBearer(extractBearer(req));
	const userId = session?.id ?? bearer?.userId ?? null;
	if (userId) {
		const rl = await limits.visionUser(userId);
		if (!rl.success) return rateLimited(res, rl, 'Vision rate limit exceeded, try again later');
	} else {
		const rl = await limits.visionIp(clientIp(req));
		if (!rl.success) return rateLimited(res, rl, 'Vision rate limit exceeded, sign in for a higher limit');
	}

	const url = new URL(req.url, 'http://localhost');
	const q = url.searchParams;
	const contentType = req.headers['content-type'] || '';
	const isJson = contentType.split(';')[0].trim().toLowerCase() === 'application/json';

	let imageBase64 = null;
	let imageUrl = null;
	let mimeType = 'image/jpeg';
	let prompt = q.get('prompt') || DEFAULT_PROMPT;
	let maxTokens = Number(q.get('maxTokens')) || 512;

	try {
		if (isJson) {
			const body = await readJson(req, Math.ceil(MAX_IMAGE_BYTES * 1.4)); // base64 inflates ~33%
			if (typeof body.imageUrl === 'string' && body.imageUrl.trim()) {
				imageUrl = body.imageUrl.trim();
			} else if (typeof body.image === 'string' && body.image) {
				const dataUri = body.image.match(/^data:(image\/[a-z+]+);base64,(.*)$/i);
				imageBase64 = dataUri ? dataUri[2] : body.image.replace(/^data:[^,]*,/, '');
				mimeType = dataUri ? dataUri[1].toLowerCase() : (isAcceptedImageType(body.imageType) || 'image/jpeg');
			} else {
				return error(res, 400, 'bad_request', 'image (base64/data URI) or imageUrl is required');
			}
			if (typeof body.prompt === 'string' && body.prompt.trim()) prompt = body.prompt;
			if (Number(body.maxTokens)) maxTokens = Number(body.maxTokens);
		} else {
			const t = isAcceptedImageType(contentType);
			if (!t) {
				return error(
					res,
					415,
					'unsupported_media_type',
					`Unsupported image Content-Type "${contentType.split(';')[0] || 'none'}". Send image/jpeg, image/png, image/webp, or image/gif (or a JSON body with a base64 image / imageUrl).`,
				);
			}
			mimeType = t;
			imageBase64 = (await readBody(req, MAX_IMAGE_BYTES)).toString('base64');
		}
	} catch (e) {
		if (e?.status === 413) return error(res, 413, 'payload_too_large', 'image exceeds the 12 MB limit');
		return error(res, e?.status || 400, 'bad_request', e?.message || 'could not read request body');
	}

	// What is left of the request budget after auth, rate limiting, and the body
	// read. describeImage caps each provider attempt at min(timeoutMs, remaining),
	// so handing it the true remainder is what keeps the endpoint's own 504 ahead
	// of the gateway's.
	const chainBudgetMs = VISION_DEADLINE_MS - (Date.now() - startedAt);
	if (chainBudgetMs < VISION_MIN_CHAIN_MS) {
		return error(
			res,
			504,
			'deadline_exceeded',
			'Reading the image used the request budget before a model could run. Send a smaller image, or an imageUrl instead of inline bytes.',
		);
	}

	try {
		const out = await describeImage({
			prompt: String(prompt).slice(0, 2000),
			imageUrl,
			imageBase64,
			mimeType,
			maxTokens: Math.min(Math.max(maxTokens, 16), 2048),
			timeoutMs: Math.min(VISION_TIMEOUT_MS, chainBudgetMs),
			deadlineMs: chainBudgetMs,
			track: { userId, tool: 'api/vision' },
		});
		return json(
			res,
			200,
			{ text: out.text, provider: out.provider, model: out.model },
			{ 'cache-control': 'no-store' },
		);
	} catch (e) {
		if (e instanceof VisionUnavailableError) {
			return error(res, 503, 'not_configured', e.message);
		}
		// invalid_image_url / no_image are caller errors (400); everything else is
		// an upstream failure surfaced as 502.
		const status = e?.code === 'invalid_image_url' || e?.code === 'no_image' ? 400 : (e?.status || 502);
		// When the whole chain failed, the last rung's message alone is actively
		// misleading (it names the backstop's billing state, not the reason the
		// free lanes ahead of it did not answer). Every rung that was tried is
		// listed so an operator sees which one to fix. Provider error bodies only;
		// no request content and no credentials pass through here.
		const lanes = Array.isArray(e?.lanes) ? e.lanes : [];
		const summary = lanes.length
			? ` Chain: ${lanes.map((l) => `${l.provider}=${l.status ?? 'unreachable'}`).join(', ')}.`
			: '';
		return error(
			res,
			status,
			e?.code || 'upstream_error',
			`Image understanding failed: ${e?.message || 'unknown error'}.${summary}`,
			lanes.length ? { lanes } : undefined,
		);
	}
});
