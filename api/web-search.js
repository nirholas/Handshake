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

import { cors, json, error, method, wrap, rateLimited } from './_lib/http.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import { groundedSearch, webSearchAvailable } from './_lib/web-search.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

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

	// Availability and input are checked BEFORE the quota is spent: a deployment
	// with no GCP project, or a caller who forgot ?q=, must not burn a slot on a
	// request that could never reach upstream.
	if (!webSearchAvailable()) return json(res, 200, { enabled: false, q, sources: [] });
	if (!q) return error(res, 400, 'missing_query', 'q is required');

	// A DEDICATED bucket, not the generic 240/min publicIp one: every miss here
	// is a billed Vertex Gemini call plus a Google Search round-trip, so the
	// shared bucket would let a scraper turn platform credits into a free SERP
	// API. 20 per 10 minutes covers a person refining a query and prices bulk
	// extraction out; `critical` fails closed on a Redis outage rather than
	// uncapping paid inference.
	const rl = await limits.webSearchIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	let result;
	try {
		result = await groundedSearch(q, { maxSources });
	} catch (err) {
		// Upstream failure is a real error state, not an empty result — tell the
		// caller it can retry, and keep the message generic (the raw upstream
		// detail goes to logs, not to the public). Uses the shared error() shape
		// so a client parsing {error, error_description} does not have to special
		// case this one handler.
		console.error('[web-search]', err?.message || err);
		return error(res, 502, 'upstream_error', 'search upstream failed, retry shortly');
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
