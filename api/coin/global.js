// GET /api/coin/global
// ---------------------------------------------------------------------------
// Global market stats bar for the /coins page: total market cap, 24h volume,
// top-2 dominance shares, active coin count plus the Fear & Greed index
// (alternative.me — the standard free source). The market stats read failover
// across three free sources (CoinGecko → CoinPaprika → CoinLore, see
// api/_lib/market-fallbacks.js) so a single-provider rate-limit no longer
// blanks the bar. Each half is independent: if one upstream fails the other
// still renders. Cached 120s.

import { cors, json, method, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { fetchGlobalMarket } from '../_lib/market-fallbacks.js';

let _fng = null; // { value, expiresAt }
const FNG_TTL_MS = 300_000;

// Exported for the paid Market Data API (api/_lib/market-data/) — the x402
// market-global endpoint sells the same fear & greed reading this page renders.
export async function fetchFearGreed() {
	const now = Date.now();
	if (_fng && _fng.expiresAt > now) return _fng.value;
	const resp = await fetch('https://api.alternative.me/fng/?limit=1', {
		headers: { accept: 'application/json', 'user-agent': 'three.ws/1.0' },
		signal: AbortSignal.timeout(6000),
	});
	if (!resp.ok) throw new Error(`fng ${resp.status}`);
	const raw = await resp.json();
	const d = raw?.data?.[0];
	const value = d ? { value: Number(d.value), label: d.value_classification || null } : null;
	if (!value || !Number.isFinite(value.value)) throw new Error('fng payload');
	_fng = { value, expiresAt: now + FNG_TTL_MS };
	return value;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.marketDataIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const [globalResult, fngResult] = await Promise.allSettled([
		fetchGlobalMarket(),
		fetchFearGreed(),
	]);

	const market = globalResult.status === 'fulfilled' ? globalResult.value : null;
	const fear_greed = fngResult.status === 'fulfilled' ? fngResult.value : null;

	if (!market && !fear_greed) {
		return error(res, 502, 'upstream_error', 'global market data is unavailable right now');
	}
	return json(res, 200, { market, fear_greed }, {
		'cache-control': 'public, max-age=60, s-maxage=120, stale-while-revalidate=600',
	});
});
