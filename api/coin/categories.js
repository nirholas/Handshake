// GET /api/coin/categories
// ---------------------------------------------------------------------------
// Crypto category leaderboard for the /categories page. Proxies CoinGecko
// /coins/categories?order=market_cap_desc and shapes each row down to the
// fields the page renders — id, name, market cap, 24h market-cap change, 24h
// volume, and the top-3 coin icons for the avatar stack. Non-finite numbers
// collapse to null so the client never renders NaN. Cached 5 min in-memory
// + CDN, like the sibling coin endpoints.

import { cors, json, method, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { geckoFetch } from '../_lib/coingecko.js';

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function shapeCategory(c) {
	return {
		id: c.id,
		name: c.name || c.id,
		market_cap: num(c.market_cap),
		market_cap_change_24h: num(c.market_cap_change_24h),
		volume_24h: num(c.volume_24h),
		top_3_coins: Array.isArray(c.top_3_coins)
			? c.top_3_coins.filter((u) => typeof u === 'string' && u).slice(0, 3)
			: [],
	};
}

// Exported for the paid Market Data API (api/_lib/market-data/) — the x402
// market-categories endpoint sells the same sector leaderboard this page renders.
export async function buildCategories() {
	const raw = await geckoFetch('/coins/categories?order=market_cap_desc', {
		ttlMs: 300_000,
		timeoutMs: 10_000,
	});
	if (!Array.isArray(raw)) throw new Error('unexpected upstream payload');
	return { categories: raw.filter((c) => c && typeof c.id === 'string').map(shapeCategory) };
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.marketDataIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	try {
		return json(
			res,
			200,
			await buildCategories(),
			{
				'cache-control': 'public, max-age=300, s-maxage=600, stale-while-revalidate=1800',
			},
		);
	} catch {
		return error(
			res,
			502,
			'upstream_error',
			'category data is unavailable right now — retry shortly',
		);
	}
});
