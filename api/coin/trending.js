// GET /api/coin/trending
// ---------------------------------------------------------------------------
// Most-searched assets on CoinGecko over the last 24h — powers /markets/trending.
// Proxies CoinGecko /search/trending, the one trending surface the coin-pages
// proxy never called. That endpoint returns three lists (coins, categories,
// NFTs); each carries a `data` block that mixes raw numbers with pre-formatted
// display strings ("$1,234,567"), so every money field is parsed defensively —
// number passes through, a "$…"/","-grouped string is stripped to digits and
// parsed, anything else collapses to null so the client never renders NaN.
// Cached 2 min in-memory + CDN, like the sibling coin endpoints.

import { cors, json, method, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { geckoFetch } from '../_lib/coingecko.js';

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

// CoinGecko trending money fields arrive either as a raw number (categories'
// data.market_cap) or a locale-formatted display string ("$1,234,567.89" for
// coins/NFTs). Accept both: keep finite numbers, strip a string down to its
// numeric core (drop the currency glyph and thousands separators) and parse,
// and fail to null on anything else so no NaN reaches the page.
function parseMoney(v) {
	if (typeof v === 'number') return Number.isFinite(v) ? v : null;
	if (typeof v === 'string') {
		const cleaned = v.replace(/[^0-9.]/g, '');
		if (!cleaned) return null;
		const n = Number.parseFloat(cleaned);
		return Number.isFinite(n) ? n : null;
	}
	return null;
}

// Only pass through a sparkline that is an absolute http(s) URL — CoinGecko
// serves these as ready-to-embed SVGs; a client <img> renders them directly.
function sparklineUrl(v) {
	const s = str(v);
	return s && /^https?:\/\//i.test(s) ? s : null;
}

function shapeCoin(entry, index) {
	const it = entry?.item || {};
	const d = it.data || {};
	return {
		id: str(it.id),
		name: str(it.name) || str(it.id),
		symbol: str(it.symbol)?.toUpperCase() ?? null,
		image: str(it.small) || str(it.thumb) || str(it.large) || null,
		rank: num(it.market_cap_rank),
		score: index, // trending position (0 = most searched)
		price_usd: num(d.price),
		change_24h_pct: num(d.price_change_percentage_24h?.usd),
		market_cap_usd: parseMoney(d.market_cap),
		volume_24h_usd: parseMoney(d.total_volume),
		sparkline_url: sparklineUrl(d.sparkline),
	};
}

function shapeCategory(c) {
	const d = c?.data || {};
	return {
		// CoinGecko category ids in /search/trending are numeric; the slug is the
		// human-readable path segment the /category/:slug page routes on.
		id: c?.id ?? null,
		slug: str(c?.slug),
		name: str(c?.name) || str(c?.slug) || 'Unnamed sector',
		coins_count: num(c?.coins_count),
		mcap_change_1h_pct: num(c?.market_cap_1h_change),
		market_cap_usd: parseMoney(d.market_cap),
	};
}

function shapeNft(n) {
	const d = n?.data || {};
	return {
		id: str(n?.id),
		name: str(n?.name) || str(n?.id),
		symbol: str(n?.symbol)?.toUpperCase() ?? null,
		thumb: str(n?.thumb) || null,
		floor_price_native: num(n?.floor_price_in_native_currency),
		native_currency_symbol: str(n?.native_currency_symbol)?.toUpperCase() ?? null,
		floor_price_usd: parseMoney(d.floor_price),
		floor_change_24h_pct: num(n?.floor_price_24h_percentage_change),
		volume_24h_usd: parseMoney(d.h24_volume),
	};
}

function shape(raw) {
	const coins = Array.isArray(raw?.coins)
		? raw.coins.map(shapeCoin).filter((c) => c.id)
		: [];
	const categories = Array.isArray(raw?.categories)
		? raw.categories.map(shapeCategory).filter((c) => c.name)
		: [];
	const nfts = Array.isArray(raw?.nfts) ? raw.nfts.map(shapeNft).filter((n) => n.id) : [];
	return { coins, categories, nfts };
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.marketDataIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	try {
		const raw = await geckoFetch('/search/trending', { ttlMs: 120_000, timeoutMs: 10_000 });
		return json(res, 200, shape(raw), {
			'cache-control': 'public, max-age=60, s-maxage=120, stale-while-revalidate=600',
		});
	} catch {
		return error(
			res,
			502,
			'upstream_error',
			'trending data is unavailable right now — retry shortly',
		);
	}
});
