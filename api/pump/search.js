// GET /api/pump/search?q=<query>&limit=8
// ------------------------------------
// Name/symbol search over Solana tokens for the site-wide command palette
// (public/search.js) and any other surface that needs to resolve a coin by
// query. Returns the same item shape as /api/pump/trending so consumers can
// share rendering code.
//
// The Birdeye-first, pump.fun-fallback search logic lives in
// api/_lib/pump-search.js (`searchPumpTokens`) — shared with the free,
// versioned /api/v1/pump/search endpoint so neither route forks the upstream
// logic. This handler adds the palette-specific process-local response cache.
//
// Response: { data: [ { mint, symbol, name, logo, price_usd, rank } ] }

import { cors, json, method, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { searchPumpTokens } from '../_lib/pump-search.js';

// Process-local cache keyed by normalized query. Palette keystrokes are
// debounced client-side, but repeated queries (same token typed twice) and many
// tabs still benefit from a short TTL so we don't hammer the upstreams.
const _cache = new Map(); // key -> { value, expiresAt }
const TTL_MS = 30_000;
const CACHE_MAX = 100;

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	// Same dedicated lobby bucket as /api/pump/trending — the /play coin search
	// must not starve because unrelated endpoints drained the shared publicIp pool.
	const rl = await limits.marketFeedIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const params = new URL(req.url, 'http://x').searchParams;
	const q = (params.get('q') || '').trim().slice(0, 64);
	if (!q) return json(res, 200, { data: [] }, { 'cache-control': 'no-store' });

	const rawLimit = Number(params.get('limit') || '8');
	const limit = Math.min(20, Math.max(1, Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 8));

	const key = q.toLowerCase() + '|' + limit;
	const now = Date.now();
	const hit = _cache.get(key);
	if (hit && hit.expiresAt > now) {
		return json(res, 200, { data: hit.value }, { 'cache-control': 'public, max-age=15, s-maxage=30' });
	}

	// No matches found is a valid, common outcome — searchPumpTokens returns []
	// rather than throwing, so this is never an error path.
	const data = await searchPumpTokens(q, limit);

	if (_cache.size >= CACHE_MAX) _cache.clear();
	_cache.set(key, { value: data, expiresAt: now + TTL_MS });
	return json(res, 200, { data }, { 'cache-control': 'public, max-age=15, s-maxage=30' });
});
