// Free, KEYLESS public spot market-data clients for seven centralized
// exchanges: Binance, OKX, Bybit V5, KuCoin, Gate.io v4, MEXC, Bitget. Public
// market endpoints only (spot ticker / 24h stats and klines); no API key, no
// auth header, no account is involved anywhere in this module.
//
// These exist as DEEP fallback rungs for api/_lib/market-fallbacks.js: they
// are consulted only after the aggregators (CoinGecko, DefiLlama) and the
// US-datacenter-safe exchanges (Kraken, Coinbase, Bitfinex) have all failed.
// Two properties follow from that depth:
//
//   - Quotes are USDT pairs (BTCUSDT / BTC-USDT / BTC_USDT), the only quote
//     all seven venues share with real depth. The last price is used as a USD
//     proxy; USDT peg drift is basis points under normal conditions, well
//     inside the tolerance of a last-resort rung.
//   - Binance and Bybit geo-block US datacenter IPs (verified 2026-08-05:
//     api.binance.com answers HTTP 451 and api.bybit.com HTTP 403 from an
//     Azure US egress; OKX can be blocked from some clouds too, per the note
//     in api/_lib/sol-price.js). They are wired anyway: a block is an instant
//     non-2xx, so the shared failover primitive pays one fast round-trip,
//     benches the rung for its cooldown window, and moves on. From
//     non-blocked egress the rungs simply work.
//
// Every endpoint, symbol format, response shape and per-request candle cap in
// this file was verified against the live APIs with curl on 2026-08-05 before
// being written down. Verified quirks, so nobody "fixes" them back:
//   - MEXC /ticker/24hr `priceChangePercent` is a RATIO (0.0076 means 0.76%),
//     unlike Binance's same-named field, which is a percent. KuCoin
//     `changeRate`, Bybit `price24hPcnt` and Bitget `change24h` are ratios
//     too; Gate `change_percentage` is a percent; OKX has no change field at
//     all (derived here from `open24h`).
//   - OKX /market/candles and Bitget /market/candles cap one request at 300
//     rows, so neither can serve the 365d chart window in one call and both
//     omit that rung. KuCoin /market/candles returns only 100 rows without an
//     explicit startAt/endAt range, so its candle URLs always carry one.

import { fetchFirst } from '../../src/shared/failover-fetch.js';

const asPrice = (v) => {
	const n = Number(v);
	return Number.isFinite(n) && n > 0 ? n : null;
};

const asNum = (v) => {
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
};

// ── Symbol mapping ───────────────────────────────────────────────────────────

/** CoinGecko coin id → base asset symbol, for the ids the platform prices. */
export const CEX_BASE_BY_ID = {
	bitcoin: 'BTC',
	ethereum: 'ETH',
	solana: 'SOL',
};

/** The seven venues, deepest spot liquidity first. Keys into the tables below. */
export const CEX_VENUES = ['binance', 'okx', 'bybit', 'kucoin', 'gate', 'mexc', 'bitget'];

/**
 * Venue-native USDT pair for a base asset symbol.
 * BTC → BTCUSDT (Binance/Bybit/MEXC/Bitget), BTC-USDT (OKX/KuCoin),
 * BTC_USDT (Gate.io). Returns null for an unknown venue or a malformed base.
 * @param {string} venue  one of CEX_VENUES
 * @param {string} base   base asset symbol, e.g. "BTC"
 */
export function cexPair(venue, base) {
	const b = String(base || '').trim().toUpperCase();
	if (!/^[A-Z0-9]{1,20}$/.test(b)) return null;
	switch (venue) {
		case 'binance':
		case 'bybit':
		case 'mexc':
		case 'bitget':
			return `${b}USDT`;
		case 'okx':
		case 'kucoin':
			return `${b}-USDT`;
		case 'gate':
			return `${b}_USDT`;
		default:
			return null;
	}
}

// ── Ticker parsers ───────────────────────────────────────────────────────────
// Each takes the venue's raw JSON body and returns { price, change_24h } with
// price a positive number and change_24h a percent (or null when the venue
// omitted it), or null when the body is not a healthy ticker. All exported so
// the tests can pin them to captured live bodies.

/** Binance /api/v3/ticker/24hr: `lastPrice`; `priceChangePercent` is a percent. */
export function parseBinanceTicker(raw) {
	const price = asPrice(raw?.lastPrice);
	return price ? { price, change_24h: asNum(raw?.priceChangePercent) } : null;
}

/** OKX /api/v5/market/ticker: data[0].last; 24h change derived from open24h. */
export function parseOkxTicker(raw) {
	if (raw?.code !== '0') return null;
	const d = Array.isArray(raw.data) ? raw.data[0] : null;
	const price = asPrice(d?.last);
	if (!price) return null;
	const open = asPrice(d?.open24h);
	return { price, change_24h: open ? ((price - open) / open) * 100 : null };
}

/** Bybit /v5/market/tickers (spot): result.list[0]; `price24hPcnt` is a ratio. */
export function parseBybitTicker(raw) {
	if (raw?.retCode !== 0) return null;
	const d = Array.isArray(raw?.result?.list) ? raw.result.list[0] : null;
	const price = asPrice(d?.lastPrice);
	if (!price) return null;
	const ratio = asNum(d?.price24hPcnt);
	return { price, change_24h: ratio == null ? null : ratio * 100 };
}

/** KuCoin /api/v1/market/stats: data.last; `changeRate` is a ratio. */
export function parseKucoinTicker(raw) {
	if (raw?.code !== '200000') return null;
	const d = raw.data;
	const price = asPrice(d?.last);
	if (!price) return null;
	const ratio = asNum(d?.changeRate);
	return { price, change_24h: ratio == null ? null : ratio * 100 };
}

/** Gate /api/v4/spot/tickers: [0].last; `change_percentage` is a percent. */
export function parseGateTicker(raw) {
	const d = Array.isArray(raw) ? raw[0] : null;
	const price = asPrice(d?.last);
	return price ? { price, change_24h: asNum(d?.change_percentage) } : null;
}

/** MEXC /api/v3/ticker/24hr: `lastPrice`; `priceChangePercent` is a RATIO. */
export function parseMexcTicker(raw) {
	const price = asPrice(raw?.lastPrice);
	if (!price) return null;
	const ratio = asNum(raw?.priceChangePercent);
	return { price, change_24h: ratio == null ? null : ratio * 100 };
}

/** Bitget /api/v2/spot/market/tickers: data[0].lastPr; `change24h` is a ratio. */
export function parseBitgetTicker(raw) {
	if (raw?.code !== '00000') return null;
	const d = Array.isArray(raw.data) ? raw.data[0] : null;
	const price = asPrice(d?.lastPr);
	if (!price) return null;
	const ratio = asNum(d?.change24h);
	return { price, change_24h: ratio == null ? null : ratio * 100 };
}

const TICKERS = {
	binance: {
		url: (pair) => `https://api.binance.com/api/v3/ticker/24hr?symbol=${pair}`,
		parse: parseBinanceTicker,
	},
	okx: {
		url: (pair) => `https://www.okx.com/api/v5/market/ticker?instId=${pair}`,
		parse: parseOkxTicker,
	},
	bybit: {
		url: (pair) => `https://api.bybit.com/v5/market/tickers?category=spot&symbol=${pair}`,
		parse: parseBybitTicker,
	},
	kucoin: {
		url: (pair) => `https://api.kucoin.com/api/v1/market/stats?symbol=${pair}`,
		parse: parseKucoinTicker,
	},
	gate: {
		url: (pair) => `https://api.gateio.ws/api/v4/spot/tickers?currency_pair=${pair}`,
		parse: parseGateTicker,
	},
	mexc: {
		url: (pair) => `https://api.mexc.com/api/v3/ticker/24hr?symbol=${pair}`,
		parse: parseMexcTicker,
	},
	bitget: {
		url: (pair) => `https://api.bitget.com/api/v2/spot/market/tickers?symbol=${pair}`,
		parse: parseBitgetTicker,
	},
};

/**
 * fetchFirst providers yielding { price, change_24h } for a base asset symbol,
 * one rung per venue, deepest liquidity first.
 * @param {string} base  base asset symbol, e.g. "BTC"
 */
export function cexTickerProviders(base) {
	const out = [];
	for (const venue of CEX_VENUES) {
		const pair = cexPair(venue, base);
		if (!pair) continue;
		const t = TICKERS[venue];
		out.push({
			name: venue,
			url: t.url(pair),
			parse: async (r) => t.parse(await r.json()),
		});
	}
	return out;
}

/**
 * The same rungs narrowed to the spot price alone, for splicing into a
 * price-failover chain (market-fallbacks.js fetchCoinPriceUsd).
 * @param {string} base  base asset symbol, e.g. "BTC"
 */
export function cexPriceProviders(base) {
	return cexTickerProviders(base).map((p) => ({
		...p,
		parse: async (r) => (await p.parse(r))?.price ?? null,
	}));
}

/**
 * Spot ticker for a base asset across the seven venues: the first healthy
 * venue answers. Resolves { price, change_24h, source } or null when every
 * venue is down or blocked; never throws, because these are last-resort rungs
 * and callers want the primary chain's error, not this one's.
 * @param {string} base  base asset symbol, e.g. "BTC"
 */
export async function fetchCexTicker(base) {
	const providers = cexTickerProviders(base);
	if (!providers.length) return null;
	try {
		const { value, source } = await fetchFirst(providers, { timeoutMs: 6000, label: `cex-ticker:${base}` });
		return { ...value, source };
	} catch {
		return null;
	}
}

// ── Candles (klines) ─────────────────────────────────────────────────────────
// Normalized to the [[timestamp_ms, close], ...] oldest-first series the coin
// chart renders (see fetchExchangeChart in market-fallbacks.js). Interval per
// chart window mirrors the Kraken rung: 5m for 1d, 1h for 7d, 4h for 30d, 1d
// for 90d/365d. A venue that cannot cover a window in ONE request omits that
// window rather than serving a silently truncated chart.

// Candles needed to span each window at the chosen interval.
const CANDLE_LIMIT = { 1: 288, 7: 168, 30: 180, 90: 90, 365: 365 };

// Verified row layouts (index of the close price, timestamp unit, sort order):
//   binance [openTime_ms, o, h, l, c, vol, closeTime_ms, quoteVol]  oldest first
//   okx     [ts_ms, o, h, l, c, vol, volCcy, volCcyQuote, confirm]  newest first
//   bybit   [start_ms, o, h, l, c, vol, turnover]                   newest first
//   kucoin  [t_s, open, close, high, low, vol, turnover]            newest first
//   gate    [t_s, quoteVol, close, high, low, open, baseVol, done]  oldest first
//   mexc    [openTime_ms, o, h, l, c, vol, closeTime_ms, quoteVol]  oldest first
//   bitget  [ts_ms, o, h, l, c, baseVol, usdtVol, quoteVol]         oldest first
// The normalizer sorts ascending regardless, so sort order never matters.
const CANDLES = {
	binance: {
		interval: { 1: '5m', 7: '1h', 30: '4h', 90: '1d', 365: '1d' },
		url: (pair, interval, days) =>
			`https://api.binance.com/api/v3/klines?symbol=${pair}&interval=${interval}&limit=${CANDLE_LIMIT[days]}`,
		rows: (raw) => (Array.isArray(raw) ? raw : null),
		closeIndex: 4,
		tsMs: true,
	},
	okx: {
		// No 365: /market/candles caps a request at 300 rows (verified).
		interval: { 1: '5m', 7: '1H', 30: '4H', 90: '1D' },
		url: (pair, interval, days) =>
			`https://www.okx.com/api/v5/market/candles?instId=${pair}&bar=${interval}&limit=${Math.min(CANDLE_LIMIT[days], 300)}`,
		rows: (raw) => (raw?.code === '0' && Array.isArray(raw.data) ? raw.data : null),
		closeIndex: 4,
		tsMs: true,
	},
	bybit: {
		interval: { 1: '5', 7: '60', 30: '240', 90: 'D', 365: 'D' },
		url: (pair, interval, days) =>
			`https://api.bybit.com/v5/market/kline?category=spot&symbol=${pair}&interval=${interval}&limit=${CANDLE_LIMIT[days]}`,
		rows: (raw) => (raw?.retCode === 0 && Array.isArray(raw?.result?.list) ? raw.result.list : null),
		closeIndex: 4,
		tsMs: true,
	},
	kucoin: {
		interval: { 1: '5min', 7: '1hour', 30: '4hour', 90: '1day', 365: '1day' },
		// Without startAt/endAt KuCoin returns only the latest 100 rows
		// (verified), which silently truncates every window except 90d; with a
		// range it returns up to 1500, covering all of ours.
		url: (pair, interval, days, now) => {
			const endAt = Math.floor(now / 1000);
			const startAt = endAt - days * 86_400;
			return `https://api.kucoin.com/api/v1/market/candles?type=${interval}&symbol=${pair}&startAt=${startAt}&endAt=${endAt}`;
		},
		rows: (raw) => (raw?.code === '200000' && Array.isArray(raw.data) ? raw.data : null),
		closeIndex: 2,
		tsMs: false,
	},
	gate: {
		interval: { 1: '5m', 7: '1h', 30: '4h', 90: '1d', 365: '1d' },
		url: (pair, interval, days) =>
			`https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=${pair}&interval=${interval}&limit=${CANDLE_LIMIT[days]}`,
		rows: (raw) => (Array.isArray(raw) ? raw : null),
		closeIndex: 2,
		tsMs: false,
	},
	mexc: {
		// MEXC's hour interval is named 60m, not 1h (verified; 1h is rejected).
		interval: { 1: '5m', 7: '60m', 30: '4h', 90: '1d', 365: '1d' },
		url: (pair, interval, days) =>
			`https://api.mexc.com/api/v3/klines?symbol=${pair}&interval=${interval}&limit=${CANDLE_LIMIT[days]}`,
		rows: (raw) => (Array.isArray(raw) ? raw : null),
		closeIndex: 4,
		tsMs: true,
	},
	bitget: {
		// No 365: /market/candles caps a request at 300 rows (verified).
		interval: { 1: '5min', 7: '1h', 30: '4h', 90: '1day' },
		url: (pair, interval, days) =>
			`https://api.bitget.com/api/v2/spot/market/candles?symbol=${pair}&granularity=${interval}&limit=${Math.min(CANDLE_LIMIT[days], 300)}`,
		rows: (raw) => (raw?.code === '00000' && Array.isArray(raw.data) ? raw.data : null),
		closeIndex: 4,
		tsMs: true,
	},
};

/**
 * Venue candle rows → [[timestamp_ms, close], ...] ascending, clipped to the
 * window; null when no row lands inside it. Exported for tests.
 * @param {any[]} rows        the venue's row array (any sort order)
 * @param {{closeIndex:number, tsMs:boolean}} layout
 * @param {number} days       chart window in days
 * @param {number} [now]      epoch ms, injectable for tests
 */
export function normalizeCexCandles(rows, { closeIndex, tsMs }, days, now = Date.now()) {
	if (!Array.isArray(rows)) return null;
	const cutoff = now - days * 86_400_000;
	const out = rows
		.map((r) => [Number(r?.[0]) * (tsMs ? 1 : 1000), Number(r?.[closeIndex])])
		.filter(([t, c]) => Number.isFinite(t) && t >= cutoff && Number.isFinite(c) && c > 0)
		.sort((a, b) => a[0] - b[0]);
	return out.length ? out : null;
}

/**
 * fetchFirst providers yielding the chart series for a window, one rung per
 * venue that can cover it in a single request, deepest liquidity first.
 * Rung names are `<venue>-klines`, keeping their failover cooldowns separate
 * from the same venue's ticker rung (the Kraken rungs follow this pattern).
 * @param {string} base   base asset symbol, e.g. "BTC"
 * @param {number} days   chart window: 1 | 7 | 30 | 90 | 365
 * @param {number} [now]  epoch ms, injectable for tests
 */
export function cexCandleProviders(base, days, now = Date.now()) {
	if (!CANDLE_LIMIT[days]) return [];
	const out = [];
	for (const venue of CEX_VENUES) {
		const pair = cexPair(venue, base);
		if (!pair) continue;
		const c = CANDLES[venue];
		const interval = c.interval[days];
		if (!interval) continue;
		out.push({
			name: `${venue}-klines`,
			url: c.url(pair, interval, days, now),
			parse: async (r) => normalizeCexCandles(c.rows(await r.json()), c, days, now),
		});
	}
	return out;
}
