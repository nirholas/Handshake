// GET /api/coin/ohlc?id=<coingecko-id>&days=<1|7|30|90|365>
// ---------------------------------------------------------------------------
// Price series for the /coin/:id chart. Proxies CoinGecko market_chart (close
// prices — the chart renders a line, not candles) and returns a compact
// [[timestamp_ms, price], …] array. Granularity is upstream-chosen per window
// (5-minutely for 1d, hourly ≤90d, daily beyond). Cached 120s + CDN.
//
// When CoinGecko fails (its keyless tier 429s under load), the headline assets
// fall back to exchange candles (Kraken OHLC, then Coinbase Exchange) via
// fetchExchangeChart — real trade prints, so they lead. Every other coin falls
// back to DefiLlama's oracle (fetchLlamaChart), which is addressed by the same
// CoinGecko id and therefore needs no mapping: the long tail keeps its chart
// through a CoinGecko outage instead of blanking. A 404 (unknown coin) never
// falls back: that is an answer, not an outage.

import { cors, json, method, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { geckoFetch, isPlausibleCoinId } from '../_lib/coingecko.js';
import { fetchExchangeChart } from '../_lib/market-fallbacks.js';
import { fetchLlamaChart } from '../_lib/coin-fallbacks.js';

export const VALID_DAYS = new Set([1, 7, 30, 90, 365]);

// Exported for the paid Market Data API (api/_lib/market-data/) — the x402
// market-chart endpoint sells the same price series this page renders.
// Callers must validate id/days first; a 404 from upstream carries err.status.
export async function buildPriceChart(id, days) {
	let raw;
	try {
		raw = await geckoFetch(`/coins/${id}/market_chart?vs_currency=usd&days=${days}`, {
			ttlMs: 120_000,
			timeoutMs: 10_000,
		});
	} catch (err) {
		if (err?.status === 404) throw err;
		const exchange = await fetchExchangeChart(id, days);
		if (exchange) return { data: exchange, days, source: 'exchange' };
		const oracle = await fetchLlamaChart(id, days);
		if (oracle) return { data: oracle, days, source: 'defillama' };
		throw err;
	}
	const data = (raw?.prices || [])
		.filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))
		.map(([t, v]) => [Math.round(t), v]);
	return { data, days, source: 'coingecko' };
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
		const { data, source } = await buildPriceChart(id, days);
		const cacheHeaders = {
			'cache-control': 'public, max-age=60, s-maxage=120, stale-while-revalidate=600',
		};
		// An empty series is an answer (dead or unlisted market), not an outage:
		// 200 keeps it CDN-cacheable and out of the 5xx monitors; the chart UI
		// renders its designed no-data state for anything shorter than 2 points.
		if (!data.length) return json(res, 200, { data: [], days, source }, cacheHeaders);
		return json(res, 200, { data, days, source }, cacheHeaders);
	} catch (err) {
		if (err?.status === 404) return error(res, 404, 'not_found', `no coin with id "${id}"`);
		return error(res, 502, 'upstream_error', 'chart data is unavailable right now — retry shortly');
	}
});
