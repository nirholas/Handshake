// GET /api/v1/pump/trending?window=5m|1h|24h&limit=1..25&source=pumpfun|all
//
// Free, keyless momentum-ranked "what's hot right now" feed for Solana tokens:
// registers the free Crypto Data API's trending engine (api/_lib/crypto-trending.js
// `composeTrending`, already live at GET /api/crypto/trending) under the
// versioned, cataloged /api/v1 surface so agents can discover it via GET /api/v1.
// Same engine, same ranking signal (documented in crypto-trending.js +
// docs/crypto-api.md): this is a thin wrapper, not a fork, capped slimmer (25
// vs 50) to keep the v1 door fast.
//
// Tokens are ranked by a 0-100 momentum score fusing windowed volume, buy
// pressure, a volume-spike signal, and price change across pump.fun,
// DexScreener, and (best-effort) GMGN smart money. Never 500s: every source
// failing yields 200 with an empty ranking + a note.

import { defineEndpoint } from '../../_lib/gateway.js';
import { rateLimited } from '../../_lib/http.js';
import { limits, clientIp } from '../../_lib/rate-limit.js';
import { composeTrending, WINDOWS } from '../../_lib/crypto-trending.js';

const SOURCES = new Set(['pumpfun', 'all']);
const MAX_LIMIT = 25;

export default defineEndpoint({
	name: 'v1.pump.trending',
	method: 'GET',
	auth: 'public',
	handler: async ({ req, res, query }) => {
		// Dedicated-shared budget with the sibling free pump.fun v1 reads and the
		// /api/crypto/trending door this wraps, fans out to real upstreams on a
		// cache miss, so this caps a scripted enumeration flood.
		const rl = await limits.publicIp(clientIp(req));
		if (!rl.success) return rateLimited(res, rl, 'pump trending is capped at 60 requests/min per IP');

		const window = WINDOWS.has(query.window) ? query.window : '1h';
		const source = SOURCES.has(query.source) ? query.source : 'all';
		const rawLimit = Number(query.limit);
		const limit = Math.min(MAX_LIMIT, Math.max(1, Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 20));

		const result = await composeTrending({ window, limit, source });

		// A live, momentum-ranked feed shifts minute to minute but doesn't need
		// sub-minute freshness; a short CDN cache absorbs bursts of agents polling
		// the same window. An empty result (all sources down) is cached only
		// briefly so we retry the live feeds soon, set before returning so the
		// gateway's secure-by-default no-store doesn't override it.
		res.setHeader(
			'cache-control',
			result.count ? 'public, max-age=30, s-maxage=30, stale-while-revalidate=30' : 'public, max-age=5, s-maxage=5',
		);
		return result;
	},
});
