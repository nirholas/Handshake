// GET /api/coin/ohlc?id=<coingecko-id>&days=<1|7|30|90|365>
// ---------------------------------------------------------------------------
// Price series for the /coin/:id chart. Proxies CoinGecko market_chart (close
// prices — the chart renders a line, not candles) and returns a compact
// [[timestamp_ms, price], …] array. Granularity is upstream-chosen per window
// (5-minutely for 1d, hourly ≤90d, daily beyond). Cached 120s + CDN.

import { cors, json, method, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { geckoFetch, isPlausibleCoinId } from '../_lib/coingecko.js';

export const VALID_DAYS = new Set([1, 7, 30, 90, 365]);

// Exported for the paid Market Data API (api/_lib/market-data/) — the x402
// market-chart endpoint sells the same price series this page renders.
// Callers must validate id/days first; a 404 from upstream carries err.status.
export async function buildPriceChart(id, days) {
	const raw = await geckoFetch(`/coins/${id}/market_chart?vs_currency=usd&days=${days}`, {
		ttlMs: 120_000,
		timeoutMs: 10_000,
	});
	const data = (raw?.prices || [])
		.filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))
		.map(([t, v]) => [Math.round(t), v]);
	return { data, days };
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.marketDataIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const params = new URL(req.url, 'http://x').searchParams;
	const id = (params.get('id') || '').trim().toLowerCase();
	if (!isPlausibleCoinId(id)) {
		return error(res, 400, 'bad_id', 'id must be a CoinGecko coin id (lowercase slug)');
	}
	const days = parseInt(params.get('days') || '30', 10);
	if (!VALID_DAYS.has(days)) {
		return error(res, 400, 'bad_days', 'days must be one of 1, 7, 30, 90, 365');
	}

	try {
		const { data } = await buildPriceChart(id, days);
		if (!data.length) return error(res, 502, 'no_data', 'no price history for this coin');
		return json(res, 200, { data, days }, {
			'cache-control': 'public, max-age=60, s-maxage=120, stale-while-revalidate=600',
		});
	} catch (err) {
		if (err?.status === 404) return error(res, 404, 'not_found', `no coin with id "${id}"`);
		return error(res, 502, 'upstream_error', 'chart data is unavailable right now — retry shortly');
	}
});
