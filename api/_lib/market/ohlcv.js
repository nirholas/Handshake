// Keyless on-chain OHLCV source for the Granite Oracle, backed by the public
// GeckoTerminal API (https://www.geckoterminal.com/dex-api). No API key, real
// candles, deep history (up to 1000 points): enough to fill the >=512-point
// context window the Granite TimeSeries forecaster requires.
//
// GeckoTerminal is the first rung, never the only one. Every exported read has
// a second source and a last-good tier behind it:
//   - fetchOhlcv:      GeckoTerminal -> Birdeye pair OHLCV (keyed, same pool
//                      address) -> CEX klines for majors (close-only, flagged)
//   - topPoolForToken: GeckoTerminal -> DexScreener deepest pair -> Birdeye markets
//   - trendingPools:   GeckoTerminal, then the last good board
// A value that was served live once is remembered in the shared cache
// (cacheWrapLastGood) so a GeckoTerminal outage answers with the previous
// candles rather than a 502. Nothing here fabricates a candle: when every rung
// fails and nothing is cached, the real upstream status is thrown.

import { createCache } from '../mem-cache.js';
import { cacheWrapLastGood } from '../cache.js';
import { fetchUpstream } from '../upstream-fetch.js';
import { fetchFirstOrNull } from '../../../src/shared/failover-fetch.js';
import { cexCandleProviders } from '../cex-public.js';

const BASE = 'https://api.geckoterminal.com/api/v2';
const BIRDEYE_BASE = 'https://public-api.birdeye.so';
const DEXSCREENER_TOKENS = 'https://api.dexscreener.com/latest/dex/tokens';
const UA = 'three.ws-granite-oracle/1.0';

// Small in-memory cache: GeckoTerminal's free tier is ~30 req/min and candle
// data only changes once per bar, so a short TTL keeps us well under the cap.
const cache = createCache({ max: 256 }); // url -> { value, expiresAt }
const TTL_MS = 20_000;

// Shared-cache windows for the last-good tier. The fresh TTL mirrors the
// in-memory one; the stale window is how long an outage can be ridden out.
const LKG_FRESH_S = 20;
const LKG_STALE_S = 24 * 3600;
const POOL_FRESH_S = 300;
const TRENDING_FRESH_S = 60;

// Bounded retries for transient upstream throttling. GeckoTerminal's free tier
// bursts into 429s and occasional 5xx; the shared upstream fetch applies
// jittered backoff and honours Retry-After. 404 and other client errors are
// NOT retried.
const MAX_ATTEMPTS = 3;

// DexScreener chain slug for a GeckoTerminal network id. The two agree for the
// networks this oracle serves; anything else maps to itself.
const DEX_CHAIN_BY_NETWORK = { solana: 'solana', eth: 'ethereum', base: 'base', bsc: 'bsc' };

const num = (v) => {
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
};

// Normalise an upstream failure to the status ladder callers branch on: 404
// (unknown token/pool) and 429 (throttled) pass through, everything else is a
// 502 so the route answers "upstream trouble", never a generic 500.
function tagged(message, status) {
	const s = status === 404 ? 404 : status === 429 ? 429 : status === 400 ? 400 : 502;
	return Object.assign(new Error(message), { status: s });
}

async function gecko(path) {
	const url = `${BASE}${path}`;
	const now = Date.now();
	const hit = cache.get(url);
	if (hit && hit.expiresAt > now) return hit.value;

	let res;
	try {
		res = await fetchUpstream(
			url,
			{ headers: { accept: 'application/json', 'user-agent': UA } },
			{ timeoutMs: 12_000, attempts: MAX_ATTEMPTS, label: 'GeckoTerminal' },
		);
	} catch (e) {
		const status = e?.status;
		if (typeof status === 'number' && status !== 503) {
			throw tagged(`GeckoTerminal ${status}: ${String(e.body || e.message || '').slice(0, 160)}`, status);
		}
		throw tagged(`GeckoTerminal unreachable: ${e?.message || e}`, 502);
	}
	const text = await res.text();
	let json;
	try {
		json = JSON.parse(text);
	} catch {
		throw tagged('GeckoTerminal returned non-JSON', 502);
	}
	cache.set(url, { value: json, expiresAt: now + TTL_MS });
	return json;
}

// Strip GeckoTerminal's "network_" id prefix (e.g. "solana_<addr>" -> "<addr>").
function bareId(id) {
	if (typeof id !== 'string') return '';
	const i = id.indexOf('_');
	return i >= 0 ? id.slice(i + 1) : id;
}

// pandas-style cadence string the forecast API expects, from a GeckoTerminal
// timeframe + aggregate (e.g. hour/1 -> "1h", minute/15 -> "15min", day/1 -> "1D").
export function freqFor(timeframe, aggregate = 1) {
	const n = Math.max(1, Number(aggregate) || 1);
	if (timeframe === 'minute') return `${n}min`;
	if (timeframe === 'day') return `${n}D`;
	return `${n}h`; // hour
}

// Seconds per bar for a timeframe + aggregate.
export function barSeconds(timeframe, aggregate = 1) {
	const n = Math.max(1, Number(aggregate) || 1);
	if (timeframe === 'minute') return 60 * n;
	if (timeframe === 'day') return 86_400 * n;
	return 3_600 * n;
}

// Birdeye OHLCV `type` for a timeframe + aggregate, or null when Birdeye has no
// matching bar (the rung is skipped rather than answering with the wrong cadence).
export function birdeyeTypeFor(timeframe, aggregate = 1) {
	const n = Math.max(1, Number(aggregate) || 1);
	const table = {
		minute: { 1: '1m', 3: '3m', 5: '5m', 15: '15m', 30: '30m' },
		hour: { 1: '1H', 2: '2H', 4: '4H', 6: '6H', 8: '8H', 12: '12H' },
		day: { 1: '1D', 3: '3D', 7: '1W' },
	};
	return table[timeframe]?.[n] ?? null;
}

// Chart window (days) a CEX kline request must cover to hold `limit` bars of
// this cadence, snapped to the windows cex-public.js can serve in one call.
function cexDaysFor(timeframe, aggregate, limit) {
	const spanDays = (barSeconds(timeframe, aggregate) * Math.max(1, limit)) / 86_400;
	for (const d of [1, 7, 30, 90, 365]) if (spanDays <= d) return d;
	return 365;
}

// Rung 2 for topPoolForToken: DexScreener's deepest pair for the token. Pair
// addresses are the on-chain AMM pool accounts, the same ids GeckoTerminal uses.
function dexscreenerPoolProvider(mint, network) {
	const chain = DEX_CHAIN_BY_NETWORK[network] || network;
	return {
		name: 'dexscreener-pool',
		url: `${DEXSCREENER_TOKENS}/${encodeURIComponent(mint)}`,
		parse: async (r) => {
			const data = await r.json();
			const pairs = (Array.isArray(data?.pairs) ? data.pairs : []).filter(
				(p) => p?.pairAddress && (p.chainId === chain || !p.chainId),
			);
			if (!pairs.length) return null;
			pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
			return pairs[0].pairAddress;
		},
	};
}

// Rung 3 for topPoolForToken: Birdeye's market list for the token (keyed).
function birdeyePoolProvider(mint, network) {
	const key = process.env.BIRDEYE_API_KEY;
	if (!key || network !== 'solana') return null;
	return {
		name: 'birdeye-markets',
		url: `${BIRDEYE_BASE}/defi/v2/markets?address=${encodeURIComponent(mint)}&sort_by=liquidity&sort_type=desc&offset=0&limit=1`,
		init: { headers: { 'X-API-KEY': key, 'x-chain': 'solana', accept: 'application/json' } },
		parse: async (r) => {
			const data = await r.json();
			const item = data?.data?.items?.[0];
			return item?.address || null;
		},
	};
}

async function topPoolLive(mint, network) {
	let geckoErr = null;
	try {
		const json = await gecko(`/networks/${network}/tokens/${mint}/pools?page=1`);
		const pool = json?.data?.[0];
		if (pool) return pool.attributes?.address || bareId(pool.id);
		geckoErr = tagged(`no pools found for token ${mint}`, 404);
	} catch (e) {
		geckoErr = e;
	}
	// GeckoTerminal does not know the token, or is down: ask the keyless
	// DexScreener index, then Birdeye. A miss everywhere keeps GeckoTerminal's
	// verdict (404 = genuinely no market) so the route's empty state still fires.
	const providers = [dexscreenerPoolProvider(mint, network), birdeyePoolProvider(mint, network)].filter(Boolean);
	const pool = await fetchFirstOrNull(providers, { timeoutMs: 6000, label: `top-pool:${mint}` });
	if (pool) return pool;
	throw geckoErr;
}

// Top (most-liquid) pool for a token mint. Returns the pool address.
export async function topPoolForToken(mint, network = 'solana') {
	return cacheWrapLastGood(
		`ohlcv:toppool:v1:${network}:${mint}`,
		POOL_FRESH_S,
		() => topPoolLive(mint, network),
		{ staleTtlSeconds: LKG_STALE_S },
	);
}

function normalizeTrending(json, limit) {
	return (json?.data || []).slice(0, limit).map((p) => {
		const a = p.attributes || {};
		return {
			pool: a.address || bareId(p.id),
			name: a.name || 'Unknown',
			baseMint: bareId(p.relationships?.base_token?.data?.id),
			priceUsd: a.base_token_price_usd != null ? Number(a.base_token_price_usd) : null,
			change24h:
				a.price_change_percentage?.h24 != null
					? Number(a.price_change_percentage.h24)
					: null,
		};
	});
}

// Trending pools, normalised for the on-screen picker. The board turns over
// slowly, so the last good one is served through a GeckoTerminal outage.
export async function trendingPools(network = 'solana', limit = 8) {
	return cacheWrapLastGood(
		`ohlcv:trending:v1:${network}:${limit}`,
		TRENDING_FRESH_S,
		async () => normalizeTrending(await gecko(`/networks/${network}/trending_pools?page=1`), limit),
		{ staleTtlSeconds: LKG_STALE_S },
	);
}

const tokenOf = (m) => (m ? { name: m.name, symbol: m.symbol, address: m.address } : null);

function sortCandles(rows) {
	return rows
		.filter((d) => Number.isFinite(d.t) && Number.isFinite(d.c) && d.c > 0)
		.sort((a, b) => a.t - b.t);
}

async function geckoCandles({ pool, network, timeframe, aggregate, limit }) {
	const json = await gecko(
		`/networks/${network}/pools/${pool}/ohlcv/${timeframe}?aggregate=${aggregate}&limit=${limit}&currency=usd`,
	);
	const list = json?.data?.attributes?.ohlcv_list;
	if (!Array.isArray(list)) throw tagged('GeckoTerminal returned no candles', 502);
	// Upstream is newest-first; reverse to chronological and coerce to numbers.
	const candles = sortCandles(
		list.map((row) => ({
			t: Number(row[0]),
			o: Number(row[1]),
			h: Number(row[2]),
			l: Number(row[3]),
			c: Number(row[4]),
			v: Number(row[5] ?? 0),
		})),
	);
	const meta = json?.meta || {};
	return { candles, base: tokenOf(meta.base), quote: tokenOf(meta.quote), source: 'geckoterminal' };
}

// Birdeye's pair OHLCV takes the same pool address GeckoTerminal does, so it
// is a like-for-like second source for any Solana pool once the key is set.
async function birdeyePairCandles({ pool, network, timeframe, aggregate, limit }) {
	const key = process.env.BIRDEYE_API_KEY;
	const type = birdeyeTypeFor(timeframe, aggregate);
	if (!key || network !== 'solana' || !type) return null;
	const to = Math.floor(Date.now() / 1000);
	const from = to - barSeconds(timeframe, aggregate) * limit;
	const url =
		`${BIRDEYE_BASE}/defi/ohlcv/pair?address=${encodeURIComponent(pool)}` +
		`&type=${type}&time_from=${from}&time_to=${to}`;
	const res = await fetchUpstream(
		url,
		{ headers: { 'X-API-KEY': key, 'x-chain': 'solana', accept: 'application/json' } },
		{ timeoutMs: 10_000, attempts: 2, name: 'birdeye:ohlcv-pair', label: 'Birdeye pair OHLCV' },
	);
	const payload = await res.json().catch(() => null);
	const items = payload?.data?.items;
	if (!Array.isArray(items) || !items.length) return null;
	const candles = sortCandles(
		items.map((it) => ({
			t: Number(it.unixTime),
			o: Number(it.o),
			h: Number(it.h),
			l: Number(it.l),
			c: Number(it.c),
			v: Number(it.v ?? 0),
		})),
	);
	return candles.length ? { candles, base: null, quote: null, source: 'birdeye' } : null;
}

// Last rung, majors only: exchange klines for the pool's base asset. The
// shared CEX layer yields a close series, so each bar is flagged close-only
// (open/high/low equal the close) rather than passing invented wicks off as
// real ones. Forecasters that consume `c` are unaffected; renderers can hide
// the wick.
async function cexCandles({ baseSymbol, timeframe, aggregate, limit }) {
	if (!baseSymbol) return null;
	const days = cexDaysFor(timeframe, aggregate, limit);
	const providers = cexCandleProviders(String(baseSymbol).toUpperCase(), days);
	if (!providers.length) return null;
	const rows = await fetchFirstOrNull(providers, { timeoutMs: 6000, label: `cex-klines:${baseSymbol}` });
	if (!Array.isArray(rows) || !rows.length) return null;
	const candles = sortCandles(
		rows.map(([tsMs, close]) => ({ t: Math.floor(tsMs / 1000), o: close, h: close, l: close, c: close, v: 0 })),
	);
	return candles.length ? { candles, base: { symbol: String(baseSymbol).toUpperCase() }, quote: { symbol: 'USD' }, source: 'cex', closeOnly: true } : null;
}

async function fetchOhlcvLive(args) {
	let firstErr = null;
	try {
		return await geckoCandles(args);
	} catch (e) {
		firstErr = e;
	}
	for (const rung of [birdeyePairCandles, cexCandles]) {
		try {
			const out = await rung(args);
			if (out) return out;
		} catch (e) {
			if (!firstErr) firstErr = e;
		}
	}
	throw firstErr || tagged('no OHLCV source answered', 502);
}

// Fetch OHLCV candles for a pool, returned oldest -> newest (chronological), plus
// the base/quote token metadata GeckoTerminal includes in the same response.
//   timeframe: 'minute' | 'hour' | 'day'   aggregate: bars per candle   limit: <=1000
//   baseSymbol: optional base-asset ticker (e.g. 'SOL') that unlocks the CEX rung
// Result carries `source` ('geckoterminal' | 'birdeye' | 'cex') and, for the
// CEX rung, `closeOnly: true`.
export async function fetchOhlcv({
	pool,
	network = 'solana',
	timeframe = 'hour',
	aggregate = 1,
	limit = 1000,
	baseSymbol = null,
}) {
	if (!pool) throw tagged('pool is required', 400);
	const args = { pool, network, timeframe, aggregate, limit, baseSymbol };
	const key = `ohlcv:candles:v1:${network}:${pool}:${timeframe}:${aggregate}:${limit}`;
	const out = await cacheWrapLastGood(key, LKG_FRESH_S, () => fetchOhlcvLive(args), {
		staleTtlSeconds: LKG_STALE_S,
	});
	return {
		...out,
		freq: freqFor(timeframe, aggregate),
		timeframe,
		aggregate,
	};
}
