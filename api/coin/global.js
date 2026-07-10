// GET /api/coin/global
// ---------------------------------------------------------------------------
// Global market stats bar for the /coins page: total market cap, 24h volume,
// top-2 dominance shares, active coin count (CoinGecko /global) plus the
// Fear & Greed index (alternative.me — the standard free source). Each half is
// independent: if one upstream fails the other still renders. Cached 120s.

import { cors, json, method, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { geckoFetch } from '../_lib/coingecko.js';

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

let _fng = null; // { value, expiresAt }
const FNG_TTL_MS = 300_000;

async function fetchFearGreed() {
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
		geckoFetch('/global', { ttlMs: 120_000 }),
		fetchFearGreed(),
	]);

	let market = null;
	if (globalResult.status === 'fulfilled') {
		const g = globalResult.value?.data || {};
		// Top-2 dominance entries come from the runtime response, largest first —
		// no asset list is hardcoded here.
		const dominance = Object.entries(g.market_cap_percentage || {})
			.filter(([, v]) => Number.isFinite(v))
			.sort((a, b) => b[1] - a[1])
			.slice(0, 2)
			.map(([sym, pct]) => ({ symbol: sym.toUpperCase(), pct }));
		market = {
			market_cap_usd: num(g.total_market_cap?.usd),
			volume_24h_usd: num(g.total_volume?.usd),
			market_cap_change_pct_24h: num(g.market_cap_change_percentage_24h_usd),
			active_coins: num(g.active_cryptocurrencies),
			dominance,
		};
	}
	const fear_greed = fngResult.status === 'fulfilled' ? fngResult.value : null;

	if (!market && !fear_greed) {
		return error(res, 502, 'upstream_error', 'global market data is unavailable right now');
	}
	return json(res, 200, { market, fear_greed }, {
		'cache-control': 'public, max-age=60, s-maxage=120, stale-while-revalidate=600',
	});
});
