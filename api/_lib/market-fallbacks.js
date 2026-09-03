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
import { COINGECKO_BASE, geckoHeaders } from './coingecko.js';
import { PAPRIKA_BASE, paprikaGet } from './coinpaprika.js';
import { CEX_BASE_BY_ID, cexPriceProviders, cexCandleProviders } from './cex-public.js';
import { downsample } from '../../src/shared/coin-format.js';
import { cacheGet, cacheSet } from './cache.js';

// null/undefined and the empty string must stay null, not become 0: Number(null)
// is 0, which is how a coin CoinGecko reports with market_cap_rank: null landed
// in the table as rank 0 and sorted above Bitcoin (observed live 2026-09-03 on
// tradable-singapore-fintech-ssl-2). The same coercion turned every absent
// price, market cap and volume into a confident $0.00.
const num = (v) => {
	if (v == null || v === '') return null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
};

// Headers come from the shared geckoFetch client (geckoHeaders) so the demo-key
// health state is process-wide: once geckoFetch benches an exhausted key, these
// failover rungs stop attaching it too, instead of each burning a 429 first.

const asPrice = (v) => {
	const n = Number(v);
	return Number.isFinite(n) && n > 0 ? n : null;
};

// ── Exchange tickers for the headline assets ─────────────────────────────────
// Two tiers. The US-datacenter-safe exchanges lead: Kraken, Coinbase Exchange
// and Bitfinex all serve datacenter traffic and quote real USD. Behind them
// sit the seven keyless CEX rungs from api/_lib/cex-public.js (Binance, OKX,
// Bybit, KuCoin, Gate.io, MEXC, Bitget), USDT-quoted, deepest liquidity first.
// Binance and Bybit geo-block US datacenter IPs (and OKX can from some clouds,
// see the note in api/_lib/sol-price.js), but a block is an instant non-2xx:
// the failover primitive pays one fast attempt, benches the rung for its
// cooldown, and moves on to a venue that answers, so they are no longer
// excluded as "permanently dead". Only the CoinGecko ids the platform actually
// prices by id are mapped; an unmapped id just skips the exchange rungs.

export const EXCHANGE_PAIRS = {
	bitcoin: { kraken: 'XBTUSD', coinbase: 'BTC-USD', bitfinex: 'tBTCUSD' },
	ethereum: { kraken: 'ETHUSD', coinbase: 'ETH-USD', bitfinex: 'tETHUSD' },
	solana: { kraken: 'SOLUSD', coinbase: 'SOL-USD', bitfinex: 'tSOLUSD' },
};

// Kraken /0/public/Ticker: the result key is Kraken's internal pair name
// (XBTUSD comes back as XXBTZUSD), so take the first result entry rather than
// re-deriving their aliasing. `c` is [last trade price, lot volume].
export function parseKrakenTicker(raw) {
	const pair = Object.values(raw?.result || {})[0];
	return asPrice(pair?.c?.[0]);
}

/** Coinbase /v2/prices/:pair/spot → { data: { amount } }. */
export function parseCoinbaseSpot(raw) {
	return asPrice(raw?.data?.amount);
}

/** Bitfinex v2 ticker array: index 6 is LAST_PRICE. */
export function parseBitfinexTicker(raw) {
	return asPrice(Array.isArray(raw) ? raw[6] : null);
}

function exchangePriceProviders(id) {
	const pairs = EXCHANGE_PAIRS[id];
	if (!pairs) return [];
	const base = CEX_BASE_BY_ID[id];
	return [
		{
			name: 'kraken',
			url: `https://api.kraken.com/0/public/Ticker?pair=${pairs.kraken}`,
			parse: async (r) => parseKrakenTicker(await r.json()),
		},
		{
			name: 'coinbase',
			url: `https://api.coinbase.com/v2/prices/${pairs.coinbase}/spot`,
			parse: async (r) => parseCoinbaseSpot(await r.json()),
		},
		{
			name: 'bitfinex',
			url: `https://api-pub.bitfinex.com/v2/ticker/${pairs.bitfinex}`,
			parse: async (r) => parseBitfinexTicker(await r.json()),
		},
		// Keyless CEX tail: Binance → OKX → Bybit → KuCoin → Gate → MEXC → Bitget.
		...(base ? cexPriceProviders(base) : []),
	];
}

// ── Spot USD price by CoinGecko id ───────────────────────────────────────────
// For the endpoints that price a headline asset (ETH for /gas, BTC for
// /exchanges) via CoinGecko /simple/price. Both those reads were single-source;
// DefiLlama's coins oracle is keyed by the SAME CoinGecko id (`coingecko:<id>`),
// so it's a drop-in second source with no id-mapping. Returns a positive number
// or throws when both are down; callers price best-effort and tolerate a throw.

/**
 * Live USD spot price for a CoinGecko coin id. CoinGecko → DefiLlama failover,
 * extended with Kraken → Coinbase → Bitfinex exchange tickers for the headline
 * assets in EXCHANGE_PAIRS, so BTC/ETH/SOL pricing survives even a
 * simultaneous aggregator outage.
 * @param {string} coingeckoId  e.g. "ethereum", "bitcoin", "solana"
 * @returns {Promise<number>}   positive USD price
 * @throws when every free source is down.
 */
export async function fetchCoinPriceUsd(coingeckoId) {
	const id = String(coingeckoId || '')
		.trim()
		.toLowerCase();
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
			...exchangePriceProviders(id),
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
	try {
		const { value } = await fetchFirst(
			[
				{
					name: 'coingecko',
					url: `${COINGECKO_BASE}/global`,
					init: { headers: geckoHeaders() },
					parse: async (r) => normalizeGeckoGlobal(await r.json()),
				},
			],
			{ timeoutMs: 6000, label: 'global-market' },
		);
		return value;
	} catch {
		/* fall through to the free backups below */
	}
	// CoinPaprika sits on its own client rather than in the provider list above,
	// because its free tier allows sixty requests an HOUR across every caller on
	// this deployment and answers a spent budget with a 402 — a status the shared
	// failover primitive would discard as just another failure. paprikaGet
	// recognises it, benches the source process-wide, and returns null so this
	// rung is skipped outright until the block lifts. See api/_lib/coinpaprika.js.
	const paprika = normalizePaprikaGlobal(await paprikaGet(`${PAPRIKA_BASE}/global`, 6000));
	if (paprika) return paprika;
	const { value } = await fetchFirst(
		[
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
		sparkline: downsample(
			(c.sparkline_in_7d?.price || []).filter((v) => Number.isFinite(v)),
			32,
		),
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
// How long a category table stays replayable after its last successful fetch.
// Category membership moves slowly (a coin joins "layer-1" rarely), so a day of
// coverage spans any realistic CoinGecko rate-limit window while still expiring
// on its own if a category is genuinely retired.
const LKG_TTL_SECONDS = 86_400;

/**
 * A page of ranked market rows. `sparkline` (default true) fetches the trailing
 * 7d price series CoinGecko bundles into each row; a caller that renders no
 * chart column passes false and CoinGecko leaves the arrays out, which is most
 * of the response weight at 250 rows. The fallback providers carry no
 * sparklines either way, so the flag only shapes the CoinGecko rung.
 */
export async function fetchMarketsTable({ page, perPage, category, sparkline = true }) {
	const providers = [
		{
			name: 'coingecko',
			url:
				`${COINGECKO_BASE}/coins/markets?vs_currency=usd&order=market_cap_desc` +
				`&per_page=${perPage}&page=${page}&sparkline=${sparkline ? 'true' : 'false'}` +
				'&price_change_percentage=24h,7d' +
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

	// Category scoping has no second live provider: CoinGecko is the only free
	// source with a category taxonomy (CoinLore and CoinPaprika expose none), so
	// a rate-limited key used to 502 every /category/:id page while the
	// unscoped table stayed up on its CoinLore rung. Last-known-good is that
	// missing rung: real rows this same endpoint fetched earlier, replayed with
	// an explicit staleness marker so the page can label them, instead of a
	// blank error state. Nothing is synthesized; a cold cache still fails.
	const lkgKey = category
		? `coin:markets:lkg:${category}:p${page}:pp${perPage}${sparkline ? '' : ':nospark'}`
		: null;
	try {
		const { value, source } = await fetchFirst(providers, {
			timeoutMs: 10_000,
			label: 'markets-table',
		});
		if (lkgKey && Array.isArray(value) && value.length) {
			// Best-effort write: a cache outage must never fail a healthy read.
			cacheSet(lkgKey, { rows: value, at: Date.now() }, LKG_TTL_SECONDS).catch(() => {});
		}
		return { rows: value, source };
	} catch (err) {
		if (!lkgKey) throw err;
		const cached = await cacheGet(lkgKey).catch(() => null);
		if (!Array.isArray(cached?.rows) || !cached.rows.length) throw err;
		return {
			rows: cached.rows,
			source: 'last-known-good',
			stale: true,
			asOf: cached.at ?? null,
		};
	}
}

// ── Price-series (chart) failover ────────────────────────────────────────────
// Backs up CoinGecko /market_chart for the /coin/:id line chart, which renders
// close prices as [[timestamp_ms, price], ...]. Exchange candle endpoints
// (Kraken OHLC, Coinbase Exchange candles, then the keyless CEX kline rungs
// from api/_lib/cex-public.js) cover the EXCHANGE_PAIRS majors: when CoinGecko
// is rate-limited, the BTC/ETH/SOL charts stay live instead of blanking.
// Long-tail coins have no exchange mapping and keep CoinGecko as their only
// source, exactly as before.

// Kraken OHLC interval (minutes) per chart window. Kraken returns up to 720
// candles per interval, so every window fits in one request: 5m covers 2.5d,
// 1h covers 30d, 4h covers 120d, 1d covers ~2y.
const KRAKEN_INTERVAL = { 1: 5, 7: 60, 30: 240, 90: 1440, 365: 1440 };

// Coinbase Exchange granularity (seconds) per window. Their API allows only
// {60,300,900,3600,21600,86400} and at most 300 candles per request, so the
// 365d window cannot be served in one call and is left to Kraken.
const COINBASE_GRANULARITY = { 1: 300, 7: 3600, 30: 21600, 90: 86400 };

/**
 * Kraken /0/public/OHLC → [[timestamp_ms, close], ...] clipped to the window.
 * Rows are [t_s, open, high, low, close, vwap, volume, count], oldest first.
 */
export function normalizeKrakenChart(raw, days, now = Date.now()) {
	const rows = Object.values(raw?.result || {}).find(Array.isArray);
	if (!Array.isArray(rows)) return null;
	const cutoff = now - days * 86_400_000;
	const out = rows
		.map((r) => [Number(r?.[0]) * 1000, Number(r?.[4])])
		.filter(([t, c]) => Number.isFinite(t) && t >= cutoff && Number.isFinite(c) && c > 0);
	return out.length ? out : null;
}

/**
 * Coinbase Exchange /products/:pair/candles → [[timestamp_ms, close], ...].
 * Rows are [t_s, low, high, open, close, volume], newest first.
 */
export function normalizeCoinbaseChart(raw, days, now = Date.now()) {
	if (!Array.isArray(raw)) return null;
	const cutoff = now - days * 86_400_000;
	const out = raw
		.map((r) => [Number(r?.[0]) * 1000, Number(r?.[4])])
		.filter(([t, c]) => Number.isFinite(t) && t >= cutoff && Number.isFinite(c) && c > 0)
		.sort((a, b) => a[0] - b[0]);
	return out.length ? out : null;
}

/**
 * Exchange-candle backup for the coin price chart. Returns [[timestamp_ms,
 * close], ...] oldest-first, or null when the id has no exchange mapping or
 * every exchange is down. Never throws: this only runs when CoinGecko already
 * failed, and the caller wants that original error if the backup misses too.
 * @param {string} id    CoinGecko coin id (must be in EXCHANGE_PAIRS)
 * @param {number} days  chart window: 1 | 7 | 30 | 90 | 365
 */
export async function fetchExchangeChart(id, days) {
	const pairs = EXCHANGE_PAIRS[id];
	if (!pairs || !KRAKEN_INTERVAL[days]) return null;
	const providers = [
		{
			name: 'kraken-ohlc',
			url: `https://api.kraken.com/0/public/OHLC?pair=${pairs.kraken}&interval=${KRAKEN_INTERVAL[days]}`,
			parse: async (r) => normalizeKrakenChart(await r.json(), days),
		},
	];
	if (COINBASE_GRANULARITY[days]) {
		providers.push({
			name: 'coinbase-candles',
			url:
				`https://api.exchange.coinbase.com/products/${pairs.coinbase}/candles` +
				`?granularity=${COINBASE_GRANULARITY[days]}`,
			init: { headers: { accept: 'application/json', 'user-agent': 'three.ws/1.0' } },
			parse: async (r) => normalizeCoinbaseChart(await r.json(), days),
		});
	}
	// Keyless CEX kline tail (Binance → OKX → Bybit → KuCoin → Gate → MEXC →
	// Bitget): venues that cannot cover this window in one request self-omit.
	const base = CEX_BASE_BY_ID[id];
	if (base) providers.push(...cexCandleProviders(base, days));
	try {
		const { value } = await fetchFirst(providers, { timeoutMs: 8000, label: `chart:${id}` });
		return value;
	} catch {
		return null;
	}
}
