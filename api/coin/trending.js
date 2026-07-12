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

// Fallback trending signal when CoinGecko /search/trending is down. CoinGecko's
// list is search-interest across all chains; the only FREE, keyless equivalent
// is GeckoTerminal's on-chain trending — a different signal (pool activity, not
// searches). We scope it to Solana so every token's address is a mint the
// /coin/:id detail page can resolve (link integrity), and map the included
// base-token metadata into the same coin shape the page renders. Categories and
// NFTs have no on-chain analogue, so they come back empty (the page hides empty
// sections) — a populated coins list beats a blank trending page during an
// upstream outage. The `source` marker lets the client badge the degraded feed.
async function trendingFromGeckoTerminal() {
	const resp = await fetch(
		'https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?include=base_token&page=1',
		{ headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) },
	);
	if (!resp.ok) throw new Error(`geckoterminal ${resp.status}`);
	const d = await resp.json();
	const included = new Map((Array.isArray(d?.included) ? d.included : []).map((i) => [i.id, i.attributes || {}]));
	const seen = new Set();
	const coins = [];
	for (const p of Array.isArray(d?.data) ? d.data : []) {
		const a = p?.attributes || {};
		const tok = included.get(p?.relationships?.base_token?.data?.id) || {};
		const mint = str(tok.address);
		// Dedup: one token can head several trending pools; keep its first (deepest).
		if (!mint || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint) || seen.has(mint)) continue;
		seen.add(mint);
		const img = str(tok.image_url);
		coins.push({
			id: mint, // base58 mint → /coin/:id resolves it via the contract lookup
			name: str(tok.name) || str(tok.symbol) || mint,
			symbol: str(tok.symbol)?.toUpperCase() ?? null,
			image: img && /^https?:\/\//i.test(img) ? img : null,
			rank: null,
			score: coins.length, // trending position (0 = hottest)
			// GeckoTerminal returns every numeric attribute as a string — coerce.
			// Prefer market cap, fall back to FDV; a missing value coerces to 0, so
			// null it out (0 means "unknown" here, not a real $0 cap).
			price_usd: num(Number(a.base_token_price_usd)),
			change_24h_pct: num(Number(a.price_change_percentage?.h24)),
			market_cap_usd: num(Number(a.market_cap_usd ?? a.fdv_usd)) || null,
			volume_24h_usd: num(Number(a.volume_usd?.h24)) || null,
			sparkline_url: null,
		});
		if (coins.length >= 15) break;
	}
	if (!coins.length) throw new Error('geckoterminal: no trending tokens');
	return { coins, categories: [], nfts: [], source: 'geckoterminal' };
}

// Exported for the paid Market Data API (api/_lib/market-data/) — the x402
// market-trending endpoint sells the same trending lists this page renders.
export async function buildTrending() {
	try {
		const raw = await geckoFetch('/search/trending', { ttlMs: 120_000, timeoutMs: 10_000 });
		return { ...shape(raw), source: 'coingecko' };
	} catch (err) {
		// CoinGecko down/rate-limited — fall back to on-chain trending rather than
		// blanking the page. If that's also down, surface the original error so the
		// handler renders its designed "retry shortly" state.
		try {
			return await trendingFromGeckoTerminal();
		} catch {
			throw err;
		}
	}
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.marketDataIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	try {
		return json(res, 200, await buildTrending(), {
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
