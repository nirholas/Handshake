// GET /api/coin/markets?page=1&per_page=100     → ranked market table rows
// GET /api/coin/markets?q=<text>                → coin search (id/name/symbol)
// ---------------------------------------------------------------------------
// Powers the /coins index. Table mode proxies CoinGecko /coins/markets with
// 7d sparklines (downsampled server-side so 100 rows stay ~50KB); search mode
// proxies /search for the type-ahead. Both cached in-memory + CDN.

import { cors, json, method, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { geckoFetch } from '../_lib/coingecko.js';
import { downsample } from '../../src/shared/coin-format.js';

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function shapeRow(c) {
	return {
		id: c.id,
		symbol: (c.symbol || '').toUpperCase(),
		name: c.name || c.id,
		image: c.image || null,
		rank: num(c.market_cap_rank),
		price: num(c.current_price),
		change_24h: num(c.price_change_percentage_24h_in_currency ?? c.price_change_percentage_24h),
		change_7d: num(c.price_change_percentage_7d_in_currency),
		market_cap: num(c.market_cap),
		volume_24h: num(c.total_volume),
		sparkline: downsample(
			(c.sparkline_in_7d?.price || []).filter((v) => Number.isFinite(v)),
			32,
		),
	};
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.marketDataIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const params = new URL(req.url, 'http://x').searchParams;
	const q = (params.get('q') || '').trim();

	try {
		if (q) {
			if (q.length > 64) return error(res, 400, 'bad_query', 'search query too long');
			const raw = await geckoFetch(`/search?query=${encodeURIComponent(q)}`, { ttlMs: 300_000 });
			const coins = (raw?.coins || []).slice(0, 10).map((c) => ({
				id: c.id,
				name: c.name,
				symbol: (c.symbol || '').toUpperCase(),
				thumb: c.thumb || null,
				rank: num(c.market_cap_rank),
			}));
			return json(res, 200, { coins }, {
				'cache-control': 'public, max-age=120, s-maxage=300, stale-while-revalidate=600',
			});
		}

		const page = Math.min(Math.max(1, parseInt(params.get('page') || '1', 10) || 1), 20);
		const perPage = Math.min(Math.max(10, parseInt(params.get('per_page') || '100', 10) || 100), 250);
		const raw = await geckoFetch(
			`/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${perPage}&page=${page}` +
				`&sparkline=true&price_change_percentage=24h,7d`,
			{ ttlMs: 60_000, timeoutMs: 10_000 },
		);
		if (!Array.isArray(raw)) throw new Error('unexpected upstream payload');
		return json(res, 200, { coins: raw.map(shapeRow), page, per_page: perPage }, {
			'cache-control': 'public, max-age=30, s-maxage=60, stale-while-revalidate=300',
		});
	} catch {
		return error(res, 502, 'upstream_error', 'market data is unavailable right now — retry shortly');
	}
});
