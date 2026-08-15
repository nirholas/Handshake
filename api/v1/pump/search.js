// GET /api/v1/pump/search?q=<query>&limit=8
//
// Free, keyless text search over Solana pump.fun / meme tokens by name,
// symbol, or mint: the one pump.fun capability with no live equivalent
// elsewhere in the platform's free crypto surfaces (trending, bonding-curve
// progress, launches, and whale activity all already ship as free endpoints
// under /api/crypto/*, see docs/crypto-api.md). This registers the same
// Birdeye-first/pump.fun-fallback search the site's command palette already
// uses (api/pump/search.js) under the versioned, cataloged /api/v1 surface so
// agents can discover it via GET /api/v1.
//
// Both routes share one implementation, api/_lib/pump-search.js
// `searchPumpTokens`, so this is a thin wrapper, not a fork.

import { defineEndpoint, fail } from '../../_lib/gateway.js';
import { limits, clientIp } from '../../_lib/rate-limit.js';
import { rateLimited } from '../../_lib/http.js';
import { searchPumpTokens } from '../../_lib/pump-search.js';

export default defineEndpoint({
	name: 'v1.pump.search',
	method: 'GET',
	auth: 'public',
	handler: async ({ req, res, query }) => {
		// Dedicated per-IP budget on top of the gateway's shared apiV1 burst guard:
		// this fans out to a real Birdeye/pump.fun upstream on every cache miss, so
		// it caps a scripted enumeration flood the same way the sibling free reads do.
		const rl = await limits.publicIp(clientIp(req));
		if (!rl.success) return rateLimited(res, rl, 'pump search is capped at 60 requests/min per IP');

		const q = typeof query.q === 'string' ? query.q.trim().slice(0, 64) : '';
		if (!q) fail(400, 'validation_error', 'query param "q" is required: pass a token name, symbol, or mint');

		const rawLimit = Number(query.limit || '8');
		const limit = Math.min(20, Math.max(1, Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 8));

		const results = await searchPumpTokens(q, limit);
		// A miss is a valid, common outcome: [] with 200, never a 404/500.
		res.setHeader('cache-control', 'public, max-age=15, s-maxage=30');
		return { results, count: results.length, q };
	},
});
