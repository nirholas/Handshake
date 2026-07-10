// GET /api/crypto/trending
// -------------------------
// Free, keyless "what's hot right now" feed for AI agents. Returns Solana tokens
// ranked by MOMENTUM — a blend of windowed trade volume, buy pressure, a volume
// spike (anomaly) signal, and short-window price change — fused across pump.fun,
// DexScreener's boosted board, and (best-effort) GMGN smart money.
//
// A discovery agent asks one URL instead of scraping five sites: it gets a
// ranked list it can act on (surface, alert, position) without wiring up its own
// scoring. The ranking signal is documented in api/_lib/crypto-trending.js and
// docs/crypto-api.md.
//
// Query:
//   window = 5m | 1h | 24h          (default 1h) — trade window the score measures
//   limit  = 1..50                  (default 20)
//   source = pumpfun | all          (default all) — 'pumpfun' restricts to the
//                                     pump.fun board; 'all' fuses every source
//
// Response: { window, tokens: [{ mint, symbol, name, marketCapUsd, volumeUsd,
//   change, score, url }], count, ts, sources[] }  — tokens ranked by score desc.
//
// Never 500s on a well-formed request: every source failing yields 200 with an
// empty ranking + a note. Bad window/source/limit are coerced to sane defaults.

import { cors, json, method, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { composeTrending, WINDOWS } from '../_lib/crypto-trending.js';

const SOURCES = new Set(['pumpfun', 'all']);

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.marketDataIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const p = new URL(req.url, `http://${req.headers.host || 'x'}`).searchParams;
	const window = WINDOWS.has(p.get('window')) ? p.get('window') : '1h';
	const source = SOURCES.has(p.get('source')) ? p.get('source') : 'all';
	const rawLimit = Number(p.get('limit'));
	const limit = Math.min(50, Math.max(1, Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 20));

	const result = await composeTrending({ window, limit, source });

	// A live, momentum-ranked feed shifts minute to minute but doesn't need
	// sub-minute freshness; a short CDN cache absorbs bursts of agents polling the
	// same window without hammering the pump.fun / DexScreener upstreams. An empty
	// result (all sources down) is cached only briefly so we retry the live feeds soon.
	const cache = result.count
		? 'public, max-age=30, s-maxage=30, stale-while-revalidate=30'
		: 'public, max-age=5, s-maxage=5';
	return json(res, 200, result, { 'cache-control': cache });
});
