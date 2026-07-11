// Free-API failover for the global coin datapoints that were single-source
// CoinGecko. CoinGecko's keyless tier rate-limits aggressively (a shared
// datacenter IP gets 429'd under load), so a CoinGecko blip used to blank the
// whole /coins stats bar and market table. This module fronts those reads with
// an ordered list of FREE, keyless public APIs — CoinGecko first (richest),
// then CoinPaprika and CoinLore — using the shared failover-fetch primitive so
// one dead upstream moves on to the next instead of surfacing an error.
//
// Every provider is normalized to the SAME shape the endpoints already emit, so
// the page renders identically no matter which source answered. Fallbacks that
// can't supply a field (CoinLore has no coin logos; neither fallback has 7d
// sparklines) leave it null/[] — the page already degrades gracefully on those.
//
// Sources (all keyless, verified live):
//   CoinGecko   api.coingecko.com   — primary; full dominance map + sparklines
//   CoinPaprika api.coinpaprika.com — global stats (BTC dominance only)
//   CoinLore    api.coinlore.com    — global stats + ranked ticker table
//
// See api/_lib/market/token-market.js for the analogous Solana-mint failover
// and api/_lib/sol-price.js for the SOL-spot failover.

import { fetchFirst } from '../../src/shared/failover-fetch.js';
import { COINGECKO_BASE } from './coingecko.js';
import { downsample } from '../../src/shared/coin-format.js';

const num = (v) => {
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
};

// CoinGecko demo key (optional) lifts the public rate limit — same header the
// shared geckoFetch uses. Absent key just means the stricter keyless tier.
function geckoHeaders() {
	const h = { accept: 'application/json', 'user-agent': 'three.ws/1.0' };
	const key = (process.env.COINGECKO_API_KEY || '').trim();
	if (key) h['x-cg-demo-api-key'] = key;
	return h;
}

const asPrice = (v) => {
	const n = Number(v);
	return Number.isFinite(n) && n > 0 ? n : null;
};

// ── Spot USD price by CoinGecko id ───────────────────────────────────────────
// For the endpoints that price a headline asset (ETH for /gas, BTC for
// /exchanges) via CoinGecko /simple/price. Both those reads were single-source;
// DefiLlama's coins oracle is keyed by the SAME CoinGecko id (`coingecko:<id>`),
// so it's a drop-in second source with no id-mapping. Returns a positive number
// or throws when both are down; callers price best-effort and tolerate a throw.

/**
 * Live USD spot price for a CoinGecko coin id, CoinGecko → DefiLlama failover.
 * @param {string} coingeckoId  e.g. "ethereum", "bitcoin", "solana"
 * @returns {Promise<number>}   positive USD price
 * @throws when every free source is down.
 */
export async function fetchCoinPriceUsd(coingeckoId) {
	const id = String(coingeckoId || '').trim().toLowerCase();
	if (!/^[a-z0-9][a-z0-9_-]{0,99}$/.test(id)) throw new Error(`bad coin id: ${coingeckoId}`);
	const { value } = await fetchFirst(
		[
			{
				name: 'coingecko',
				url: `${COINGECKO_BASE}/simple/price?ids=${id}&vs_currencies=usd`,
				init: { headers: geckoHeaders() },
				parse: async (r) => asPrice((await r.json())?.[id]?.usd),
			},
			{
				name: 'llama',
				url: `https://coins.llama.fi/prices/current/coingecko:${id}`,
				parse: async (r) => asPrice((await r.json())?.coins?.[`coingecko:${id}`]?.price),
			},
		],
		{ timeoutMs: 6000, label: `price:${id}` },
	);
	return value;
}

/** Like fetchCoinPriceUsd but resolves to null instead of throwing. */
export async function fetchCoinPriceUsdOrNull(coingeckoId) {
	try {
		return await fetchCoinPriceUsd(coingeckoId);
	} catch {
		return null;
	}
}

// ── Global market stats ──────────────────────────────────────────────────────
// Normalized shape: { market_cap_usd, volume_24h_usd, market_cap_change_pct_24h,
//                     active_coins, dominance: [{ symbol, pct }] }

/** CoinGecko /global → normalized global stats (full top-2 dominance). */
export function normalizeGeckoGlobal(raw) {
	const g = raw?.data;
	if (!g || typeof g !== 'object') return null;
	const mcap = num(g.total_market_cap?.usd);
	if (mcap == null) return null; // no headline number → treat as a miss, try next
	// Top-2 dominance entries from the runtime response, largest first — no asset
	// list is hardcoded.
	const dominance = Object.entries(g.market_cap_percentage || {})
		.filter(([, v]) => Number.isFinite(v))
		.sort((a, b) => b[1] - a[1])
		.slice(0, 2)
		.map(([sym, pct]) => ({ symbol: sym.toUpperCase(), pct }));
	return {
		market_cap_usd: mcap,
		volume_24h_usd: num(g.total_volume?.usd),
		market_cap_change_pct_24h: num(g.market_cap_change_percentage_24h_usd),
		active_coins: num(g.active_cryptocurrencies),
		dominance,
	};
}

/** CoinPaprika /v1/global → normalized global stats (BTC dominance only). */
export function normalizePaprikaGlobal(raw) {
	if (!raw || typeof raw !== 'object') return null;
	const mcap = num(raw.market_cap_usd);
	if (mcap == null) return null;
	const btcDom = num(raw.bitcoin_dominance_percentage);
	return {
		market_cap_usd: mcap,
		volume_24h_usd: num(raw.volume_24h_usd),
		market_cap_change_pct_24h: num(raw.market_cap_change_24h),
		active_coins: num(raw.cryptocurrencies_number),
		dominance: btcDom != null ? [{ symbol: 'BTC', pct: btcDom }] : [],
	};
}

/** CoinLore /api/global/ (array with one object) → normalized global stats. */
export function normalizeLoreGlobal(raw) {
	const g = Array.isArray(raw) ? raw[0] : raw;
	if (!g || typeof g !== 'object') return null;
	const mcap = num(g.total_mcap);
	if (mcap == null) return null;
	const dominance = [];
	const btcDom = num(g.btc_d);
	const ethDom = num(g.eth_d);
	if (btcDom != null) dominance.push({ symbol: 'BTC', pct: btcDom });
	if (ethDom != null) dominance.push({ symbol: 'ETH', pct: ethDom });
	return {
		market_cap_usd: mcap,
		volume_24h_usd: num(g.total_volume),
		market_cap_change_pct_24h: num(g.mcap_change),
		active_coins: num(g.coins_count),
		dominance,
	};
}

/**
 * Global market stats with CoinGecko → CoinPaprika → CoinLore failover.
 * @returns {Promise<{market_cap_usd:number|null, volume_24h_usd:number|null,
 *   market_cap_change_pct_24h:number|null, active_coins:number|null,
 *   dominance:Array<{symbol:string,pct:number}>}>}
 * @throws when every free source is down.
 */
export async function fetchGlobalMarket() {
	const { value } = await fetchFirst(
		[
			{
				name: 'coingecko',
				url: `${COINGECKO_BASE}/global`,
				init: { headers: geckoHeaders() },
				parse: async (r) => normalizeGeckoGlobal(await r.json()),
			},
			{
				name: 'coinpaprika',
				url: 'https://api.coinpaprika.com/v1/global',
				parse: async (r) => normalizePaprikaGlobal(await r.json()),
			},
			{
				name: 'coinlore',
				url: 'https://api.coinlore.com/api/global/',
				parse: async (r) => normalizeLoreGlobal(await r.json()),
			},
		],
		{ timeoutMs: 6000, label: 'global-market' },
	);
	return value;
}

// ── Ranked market table ──────────────────────────────────────────────────────
// Normalized row shape (matches src/shared/market-table.js coinRow):
//   { id, symbol, name, image, rank, price, change_24h, change_7d,
//     market_cap, volume_24h, sparkline: number[] }

/** CoinGecko /coins/markets row → normalized table row (with 7d sparkline). */
export function normalizeGeckoRow(c) {
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
		sparkline: downsample((c.sparkline_in_7d?.price || []).filter((v) => Number.isFinite(v)), 32),
	};
}

// CoinLore ticker row → normalized table row. `nameid` is a CoinGecko-compatible
// slug (e.g. "bitcoin") for the top coins, so the /coin/:id detail links keep
// working through a CoinGecko outage; long-tail slugs can diverge, but the table
// only falls back to CoinLore when CoinGecko itself is down — at which point the
// detail page is degraded regardless. No logos or 7d series in this feed → image
// null, sparkline empty (the page renders both gracefully).
function normalizeLoreRow(c) {
	const id = (c.nameid || '').trim();
	if (!id) return null;
	return {
		id,
		symbol: (c.symbol || '').toUpperCase(),
		name: c.name || id,
		image: null,
		rank: num(c.rank),
		price: num(c.price_usd),
		change_24h: num(c.percent_change_24h),
		change_7d: num(c.percent_change_7d),
		market_cap: num(c.market_cap_usd),
		volume_24h: num(c.volume24),
		sparkline: [],
	};
}

/**
 * Ranked market table with CoinGecko → CoinLore failover.
 *
 * CoinGecko is the only source with 7d sparklines and category scoping, so when
 * a `category` is requested the fallback is skipped (it can't honor the filter —
 * serving an unfiltered table would be wrong data). Without a category, CoinLore
 * backs up the plain top-N list. CoinLore caps a page at 100 rows.
 *
 * @param {{ page:number, perPage:number, category?:string }} opts
 * @returns {Promise<{ rows: object[], source: string }>}
 * @throws when every eligible source is down.
 */
export async function fetchMarketsTable({ page, perPage, category }) {
	const providers = [
		{
			name: 'coingecko',
			url:
				`${COINGECKO_BASE}/coins/markets?vs_currency=usd&order=market_cap_desc` +
				`&per_page=${perPage}&page=${page}&sparkline=true&price_change_percentage=24h,7d` +
				(category ? `&category=${encodeURIComponent(category)}` : ''),
			init: { headers: geckoHeaders() },
			parse: async (r) => {
				const raw = await r.json();
				if (!Array.isArray(raw)) return null;
				return raw.map(normalizeGeckoRow);
			},
		},
	];
	if (!category) {
		const start = (page - 1) * perPage;
		const limit = Math.min(perPage, 100); // CoinLore hard-caps a page at 100
		providers.push({
			name: 'coinlore',
			url: `https://api.coinlore.com/api/tickers/?start=${start}&limit=${limit}`,
			parse: async (r) => {
				const raw = await r.json();
				const data = Array.isArray(raw?.data) ? raw.data : null;
				if (!data) return null;
				const rows = data.map(normalizeLoreRow).filter(Boolean);
				return rows.length ? rows : null;
			},
		});
	}
	const { value, source } = await fetchFirst(providers, { timeoutMs: 10_000, label: 'markets-table' });
	return { rows: value, source };
}
