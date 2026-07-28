// GET /api/web-search?q=<text>&sources=<n>
// ---------------------------------------------------------------------------
// Public grounded web search. Until now three.ws had no live web-search
// endpoint at all: /api/search federates the platform's OWN entities
// (avatars/agents/models/worlds/coins) and the intel surfaces run on RSS.
// This endpoint answers open-web questions with cited sources, backed by
// Vertex Gemini's Google Search grounding (api/_lib/web-search.js) — the same
// credits-funded GCP surface as the chat anchor, so it needs no third-party
// key and no per-seat quota.
//
// Response 200: { enabled, q, answer, sources: [{title,url,domain}], queries }
// When the deployment has no GCP project (local dev without credentials) the
// endpoint degrades to { enabled: false } rather than a 500 — same designed
// "warming up" state as /api/search without a database.

import { cors, json, method, wrap, rateLimited } from './_lib/http.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import { groundedSearch, webSearchAvailable } from './_lib/web-search.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, 'http://x');
	// Same control-character guard as /api/search: this string is forwarded to
	// an upstream API and echoed back in the response.
	// eslint-disable-next-line no-control-regex
	const q = (url.searchParams.get('q') || '')
		.replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
		.trim()
		.slice(0, 400);
	const rawSources = parseInt(url.searchParams.get('sources') || '8', 10);
	const maxSources = Number.isFinite(rawSources) ? Math.min(Math.max(rawSources, 1), 20) : 8;

	if (!webSearchAvailable()) return json(res, 200, { enabled: false, q, sources: [] });
	if (!q) return json(res, 400, { error: 'q required' });

	let result;
	try {
		result = await groundedSearch(q, { maxSources });
	} catch (err) {
		// Upstream failure is a real error state, not an empty result — tell the
		// caller it can retry, and keep the message generic (the raw upstream
		// detail goes to logs, not to the public).
		console.error('[web-search]', err?.message || err);
		return json(res, 502, { error: 'search upstream failed, retry shortly' });
	}

	return json(
		res,
		200,
		{ enabled: true, q, ...result },
		// Grounded answers are not personalized; a short edge cache absorbs
		// repeat queries (each miss is a billed Gemini call).
		{ 'cache-control': 'public, s-maxage=60, stale-while-revalidate=300' },
	);
});
