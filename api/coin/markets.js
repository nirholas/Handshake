// GET /api/coin/markets?page=1&per_page=100     → ranked market table rows
// GET /api/coin/markets?q=<text>                → coin search (id/name/symbol)
// GET /api/coin/markets?category=<slug>&…       → table rows for one category
// ---------------------------------------------------------------------------
// Powers the /coins index and the /category/:id coins table. Table mode
// proxies CoinGecko /coins/markets with 7d sparklines (downsampled
// server-side so 100 rows stay ~50KB), optionally scoped to a CoinGecko
// category id; search mode proxies /search for the type-ahead. Both cached
// in-memory + CDN.

import { cors, json, method, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { geckoFetch } from '../_lib/coingecko.js';
import { fetchMarketsTable } from '../_lib/market-fallbacks.js';

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// Exported for the paid Market Data API (api/_lib/market-data/) — the x402
// market-coins endpoint offers the same type-ahead id resolver this page uses.
export async function searchCoins(q) {
	const raw = await geckoFetch(`/search?query=${encodeURIComponent(q)}`, { ttlMs: 300_000 });
	return {
		coins: (raw?.coins || []).slice(0, 10).map((c) => ({
			id: c.id,
			name: c.name,
			symbol: (c.symbol || '').toUpperCase(),
			thumb: c.thumb || null,
			rank: num(c.market_cap_rank),
		})),
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
			return json(res, 200, await searchCoins(q), {
				'cache-control': 'public, max-age=120, s-maxage=300, stale-while-revalidate=600',
			});
		}

		const page = Math.min(Math.max(1, parseInt(params.get('page') || '1', 10) || 1), 20);
		const perPage = Math.min(Math.max(10, parseInt(params.get('per_page') || '100', 10) || 100), 250);
		// Optional CoinGecko category id (e.g. layer-1, artificial-intelligence) —
		// scopes the table to one sector for the /category/:id coins list.
		const category = (params.get('category') || '').trim().toLowerCase();
		if (category && !/^[a-z0-9-]{1,80}$/.test(category)) {
			return error(res, 400, 'bad_category', 'category must be a CoinGecko category id');
		}
		// CoinGecko primary → CoinLore fallback (see api/_lib/market-fallbacks.js).
		// A CoinGecko rate-limit no longer blanks the /coins table; CoinLore backs
		// it up (top-N only — category scoping and 7d sparklines are CoinGecko-only
		// and degrade gracefully).
		const { rows } = await fetchMarketsTable({ page, perPage, category });
		return json(res, 200, { coins: rows, page, per_page: perPage, category: category || null }, {
			'cache-control': 'public, max-age=30, s-maxage=60, stale-while-revalidate=300',
		});
	} catch {
		return error(res, 502, 'upstream_error', 'market data is unavailable right now — retry shortly');
	}
});
