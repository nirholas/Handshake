// The seven keyless CEX rungs (Binance, OKX, Bybit, KuCoin, Gate.io, MEXC,
// Bitget) behind the market-data fallback chain: every rung must be REACHABLE,
// proven by failing the rungs above it at the transport level, and every
// parser must be pinned to the venue's real wire shape.
//
// Why transport level: a chain tested only with parse errors looks healthy
// while the real failure mode (dead socket, DNS failure, abort, geo-block)
// walks straight past it (see tests/api/llm-free-chain-reachability.test.js
// for the incident that made this the house pattern). Each reachability case
// kills the rungs above the target the way a provider actually dies and
// asserts the target answers.
//
// The ticker fixtures are captured LIVE bodies (curl, 2026-08-05), so the
// parsers are pinned to what the venues really send, including the quirk this
// suite exists to protect: MEXC/KuCoin/Bybit/Bitget report 24h change as a
// RATIO while Binance/Gate report a percent and OKX reports nothing at all.
// Binance and Bybit geo-block the capture host (HTTP 451/403), so their
// fixtures follow their documented shapes instead; both shapes are also in
// the family a sibling venue verifies live (MEXC mirrors Binance's schema).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
	CEX_BASE_BY_ID,
	CEX_VENUES,
	cexPair,
	parseBinanceTicker,
	parseOkxTicker,
	parseBybitTicker,
	parseKucoinTicker,
	parseGateTicker,
	parseMexcTicker,
	parseBitgetTicker,
	cexTickerProviders,
	cexPriceProviders,
	cexCandleProviders,
	normalizeCexCandles,
} from '../../api/_lib/cex-public.js';

// ── Captured live ticker bodies (curl, 2026-08-05) ───────────────────────────

const OKX_TICKER = {
	code: '0',
	msg: '',
	data: [
		{
			instType: 'SPOT',
			instId: 'BTC-USDT',
			last: '64639',
			open24h: '64101.3',
			high24h: '65026.6',
			low24h: '63880.7',
			vol24h: '7026.55757809',
			ts: '1785974196267',
		},
	],
};

const KUCOIN_STATS = {
	code: '200000',
	data: {
		time: 1785974195546,
		symbol: 'BTC-USDT',
		changeRate: '0.0079',
		changePrice: '512.5',
		high: '65026.5',
		low: '63879',
		last: '64636.3',
		averagePrice: '64235.82318744',
	},
};

const GATE_TICKER = [
	{
		currency_pair: 'BTC_USDT',
		last: '64637.3',
		lowest_ask: '64637.3',
		highest_bid: '64637.2',
		change_percentage: '0.84',
		base_volume: '5766.149367',
		high_24h: '65019.8',
		low_24h: '63880',
	},
];

const MEXC_TICKER = {
	symbol: 'BTCUSDT',
	priceChange: '491.31',
	priceChangePercent: '0.0076', // a RATIO: 0.76%, not 0.0076%
	lastPrice: '64631.33',
	openPrice: '64140.02',
	highPrice: '65000',
	lowPrice: '63900',
	volume: '6395.70584489',
};

const BITGET_TICKER = {
	code: '00000',
	msg: 'success',
	requestTime: 1785974198119,
	data: [
		{
			symbol: 'BTCUSDT',
			lastPr: '64635.01',
			high24h: '65025',
			low24h: '63880.77',
			change24h: '0.00841', // a ratio
			open: '64096.26',
		},
	],
};

// Documented shapes (capture host is geo-blocked by these two venues).
const BINANCE_TICKER = { symbol: 'BTCUSDT', lastPrice: '64640.1', priceChangePercent: '0.84', openPrice: '64101.3' };
const BYBIT_TICKER = {
	retCode: 0,
	retMsg: 'OK',
	result: { category: 'spot', list: [{ symbol: 'BTCUSDT', lastPrice: '64638.5', price24hPcnt: '0.0079' }] },
};

// The live geo-block bodies (Binance answers this with HTTP 451, Bybit's 403
// carries an HTML-ish CloudFront page that is not even JSON).
const BINANCE_GEOBLOCK = { code: 0, msg: "Service unavailable from a restricted location according to 'b. Eligibility' in https://www.binance.com/en/terms." };

describe('cexPair symbol mapping', () => {
	it('maps a base symbol to each venue-native USDT pair', () => {
		expect(cexPair('binance', 'btc')).toBe('BTCUSDT');
		expect(cexPair('bybit', 'BTC')).toBe('BTCUSDT');
		expect(cexPair('mexc', 'BTC')).toBe('BTCUSDT');
		expect(cexPair('bitget', 'BTC')).toBe('BTCUSDT');
		expect(cexPair('okx', 'BTC')).toBe('BTC-USDT');
		expect(cexPair('kucoin', 'BTC')).toBe('BTC-USDT');
		expect(cexPair('gate', 'BTC')).toBe('BTC_USDT');
	});

	it('rejects unknown venues and malformed bases', () => {
		expect(cexPair('nasdaq', 'BTC')).toBeNull();
		expect(cexPair('binance', '')).toBeNull();
		expect(cexPair('binance', 'B T C')).toBeNull();
		expect(cexPair('gate', '../etc')).toBeNull();
	});
});

describe('ticker parsers pinned to live wire shapes', () => {
	it('Binance: percent field stays a percent', () => {
		expect(parseBinanceTicker(BINANCE_TICKER)).toEqual({ price: 64640.1, change_24h: 0.84 });
	});

	it('OKX: derives 24h change from open24h', () => {
		const t = parseOkxTicker(OKX_TICKER);
		expect(t.price).toBe(64639);
		expect(t.change_24h).toBeCloseTo(((64639 - 64101.3) / 64101.3) * 100, 6);
	});

	it('Bybit: price24hPcnt ratio is scaled to a percent', () => {
		expect(parseBybitTicker(BYBIT_TICKER)).toEqual({ price: 64638.5, change_24h: 0.79 });
	});

	it('KuCoin: changeRate ratio is scaled to a percent', () => {
		const t = parseKucoinTicker(KUCOIN_STATS);
		expect(t.price).toBe(64636.3);
		expect(t.change_24h).toBeCloseTo(0.79, 6);
	});

	it('Gate: change_percentage stays a percent', () => {
		expect(parseGateTicker(GATE_TICKER)).toEqual({ price: 64637.3, change_24h: 0.84 });
	});

	it('MEXC: priceChangePercent is a RATIO and must be scaled, unlike Binance', () => {
		const t = parseMexcTicker(MEXC_TICKER);
		expect(t.price).toBe(64631.33);
		expect(t.change_24h).toBeCloseTo(0.76, 6);
		expect(t.change_24h).not.toBeCloseTo(0.0076, 6);
	});

	it('Bitget: change24h ratio is scaled to a percent', () => {
		const t = parseBitgetTicker(BITGET_TICKER);
		expect(t.price).toBe(64635.01);
		expect(t.change_24h).toBeCloseTo(0.841, 6);
	});

	it('rejects error and geo-block bodies as misses, not prices', () => {
		expect(parseBinanceTicker(BINANCE_GEOBLOCK)).toBeNull();
		expect(parseOkxTicker({ code: '51001', msg: 'Instrument ID does not exist', data: [] })).toBeNull();
		expect(parseBybitTicker({ retCode: 10001, retMsg: 'params error', result: {} })).toBeNull();
		expect(parseKucoinTicker({ code: '400100', msg: 'symbol not exists' })).toBeNull();
		expect(parseGateTicker({ label: 'INVALID_CURRENCY_PAIR' })).toBeNull();
		expect(parseMexcTicker({ msg: 'Invalid symbol.', code: -1121 })).toBeNull();
		expect(parseBitgetTicker({ code: '40034', msg: 'Parameter does not exist', data: null })).toBeNull();
	});
});

describe('candle normalization pinned to live row layouts', () => {
	// Explicit `now` beside the captured timestamps so the fixtures never age
	// out of the window as the suite gets older.
	const NOW = 1_785_974_400_000;

	it('OKX rows (ms, close at index 4, newest first) sort ascending', () => {
		const rows = [
			['1785970800000', '64638.3', '64751.8', '64581.6', '64638.9', '74.78', '4835416', '4835416', '0'],
			['1785967200000', '64730.6', '64792.6', '64633.8', '64638.4', '45.05', '2914820', '2914820', '1'],
		];
		expect(normalizeCexCandles(rows, { closeIndex: 4, tsMs: true }, 7, NOW)).toEqual([
			[1785967200000, 64638.4],
			[1785970800000, 64638.9],
		]);
	});

	it('KuCoin rows (seconds, close at index 2, newest first) convert to ms', () => {
		const rows = [
			['1785970800', '64626.9', '64636.3', '64750.1', '64571.6', '21.08', '1362973'],
			['1785967200', '64731.8', '64634.9', '64785.4', '64625.5', '16.58', '1073089'],
		];
		expect(normalizeCexCandles(rows, { closeIndex: 2, tsMs: false }, 7, NOW)).toEqual([
			[1785967200000, 64634.9],
			[1785970800000, 64636.3],
		]);
	});

	it('Gate rows (seconds, close at index 2, oldest first) convert to ms', () => {
		const rows = [
			['1785963600', '8785034.29', '64732.3', '64831.1', '64666.6', '64831.1', '135.70', 'true'],
			['1785967200', '4848473.09', '64635.1', '64782.3', '64633.4', '64732.3', '74.93', 'true'],
		];
		expect(normalizeCexCandles(rows, { closeIndex: 2, tsMs: false }, 7, NOW)).toEqual([
			[1785963600000, 64732.3],
			[1785967200000, 64635.1],
		]);
	});

	it('MEXC/Binance-family rows (ms, close at index 4, oldest first) pass through', () => {
		const rows = [
			[1785963600000, '64840.38', '64840.38', '64669.12', '64742.09', '239.42', 1785967200000, '15497514.5'],
			[1785967200000, '64742.09', '64773.04', '64628.25', '64633.83', '139.56', 1785970800000, '9029060.18'],
		];
		expect(normalizeCexCandles(rows, { closeIndex: 4, tsMs: true }, 7, NOW)).toEqual([
			[1785963600000, 64742.09],
			[1785967200000, 64633.83],
		]);
	});

	it('clips rows outside the window and returns null when nothing survives', () => {
		const stale = [['1685963600000', '1', '1', '1', '30000', '1']];
		expect(normalizeCexCandles(stale, { closeIndex: 4, tsMs: true }, 7, NOW)).toBeNull();
		expect(normalizeCexCandles('not-rows', { closeIndex: 4, tsMs: true }, 7, NOW)).toBeNull();
	});
});

describe('provider construction stays keyless and liquidity-ordered', () => {
	it('ticker rungs cover all seven venues in order, with no credential anywhere', () => {
		const providers = cexTickerProviders('BTC');
		expect(providers.map((p) => p.name)).toEqual(CEX_VENUES);
		for (const p of providers) {
			expect(p.url).toMatch(/^https:\/\//);
			// Keyless is the whole point: no key/secret/signature/passphrase param
			// and no custom headers may ever creep into these URLs.
			expect(p.url).not.toMatch(/key|secret|sign|passphrase|token/i);
			expect(p.init).toBeUndefined();
		}
	});

	it('price rungs mirror the ticker rungs one-to-one', () => {
		expect(cexPriceProviders('SOL').map((p) => p.name)).toEqual(CEX_VENUES);
	});

	it('candle rungs use venue-native pair and interval names for the 7d window', () => {
		const NOW = 1_785_974_400_000;
		const byName = Object.fromEntries(cexCandleProviders('BTC', 7, NOW).map((p) => [p.name, p.url]));
		expect(Object.keys(byName)).toEqual(CEX_VENUES.map((v) => `${v}-klines`));
		expect(byName['binance-klines']).toContain('symbol=BTCUSDT&interval=1h&limit=168');
		expect(byName['okx-klines']).toContain('instId=BTC-USDT&bar=1H');
		expect(byName['bybit-klines']).toContain('category=spot&symbol=BTCUSDT&interval=60');
		expect(byName['mexc-klines']).toContain('interval=60m'); // MEXC rejects "1h" (verified 400 -1121)
		expect(byName['gate-klines']).toContain('currency_pair=BTC_USDT&interval=1h');
		expect(byName['bitget-klines']).toContain('granularity=1h');
		// KuCoin truncates to 100 rows without an explicit range (verified), so
		// the URL must always carry one.
		expect(byName['kucoin-klines']).toContain(`startAt=${Math.floor(NOW / 1000) - 7 * 86_400}`);
		expect(byName['kucoin-klines']).toContain(`endAt=${Math.floor(NOW / 1000)}`);
	});

	it('venues that cannot cover 365d in one request omit that rung', () => {
		const names = cexCandleProviders('BTC', 365).map((p) => p.name);
		expect(names).toEqual(['binance-klines', 'bybit-klines', 'kucoin-klines', 'gate-klines', 'mexc-klines']);
	});

	it('an unknown window or malformed base yields no rungs', () => {
		expect(cexCandleProviders('BTC', 14)).toEqual([]);
		expect(cexCandleProviders('B T C', 7)).toEqual([]);
	});
});

// ── Reachability through the market-fallbacks chain ──────────────────────────
// The chain in exchange-rung order for fetchCoinPriceUsd('bitcoin'). Every
// host is distinct, so a rung is identified by host alone.

const PRICE_CHAIN = [
	{ name: 'coingecko', host: 'api.coingecko.com', body: { bitcoin: { usd: 64650.5 } }, price: 64650.5 },
	{
		name: 'llama',
		host: 'coins.llama.fi',
		body: { coins: { 'coingecko:bitcoin': { price: 64649.4 } } },
		price: 64649.4,
	},
	{ name: 'kraken', host: 'api.kraken.com', body: { result: { XXBTZUSD: { c: ['64648.3', '1.0'] } } }, price: 64648.3 },
	{ name: 'coinbase', host: 'api.coinbase.com', body: { data: { amount: '64647.2' } }, price: 64647.2 },
	{
		name: 'bitfinex',
		host: 'api-pub.bitfinex.com',
		body: [64646, 5.1, 64647, 3.2, 540, 0.008, 64646.1, 900, 65000, 63800],
		price: 64646.1,
	},
	{ name: 'binance', host: 'api.binance.com', body: BINANCE_TICKER, price: 64640.1 },
	{ name: 'okx', host: 'www.okx.com', body: OKX_TICKER, price: 64639 },
	{ name: 'bybit', host: 'api.bybit.com', body: BYBIT_TICKER, price: 64638.5 },
	{ name: 'kucoin', host: 'api.kucoin.com', body: KUCOIN_STATS, price: 64636.3 },
	{ name: 'gate', host: 'api.gateio.ws', body: GATE_TICKER, price: 64637.3 },
	{ name: 'mexc', host: 'api.mexc.com', body: MEXC_TICKER, price: 64631.33 },
	{ name: 'bitget', host: 'api.bitget.com', body: BITGET_TICKER, price: 64635.01 },
];

const FIRST_CEX_RUNG = 5; // index of binance in PRICE_CHAIN

const okJson = (body) => ({ ok: true, status: 200, json: async () => body });
const httpBlock = (status, body) => ({ ok: false, status, json: async () => body });

// How a provider actually dies: the socket drops, or the attempt is aborted.
function transportFailure(kind) {
	if (kind === 'abort') return Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
	return Object.assign(new Error('fetch failed: ECONNRESET'), { cause: { code: 'ECONNRESET' } });
}

describe('market-fallbacks chain: every CEX rung is reachable', () => {
	const savedFetch = globalThis.fetch;
	let mf;

	beforeEach(async () => {
		// Fresh module graph per test: the failover primitive's cooldown map is
		// process-wide, and a rung benched by one test must not skew the next.
		vi.resetModules();
		mf = await import('../../api/_lib/market-fallbacks.js');
	});

	afterEach(() => {
		globalThis.fetch = savedFetch;
		vi.restoreAllMocks();
	});

	for (let i = FIRST_CEX_RUNG; i < PRICE_CHAIN.length; i++) {
		const rung = PRICE_CHAIN[i];
		it(`reaches ${rung.name} when the ${i} rung(s) above it die at the transport level`, async () => {
			const tried = [];
			globalThis.fetch = vi.fn(async (url) => {
				const u = String(url);
				const idx = PRICE_CHAIN.findIndex((r) => u.includes(r.host));
				expect(idx, `unexpected fetch: ${u}`).toBeGreaterThanOrEqual(0);
				tried.push(PRICE_CHAIN[idx].name);
				if (idx < i) throw transportFailure(idx % 2 === 0 ? 'reset' : 'abort');
				return okJson(PRICE_CHAIN[idx].body);
			});

			const price = await mf.fetchCoinPriceUsd('bitcoin');
			expect(price).toBe(rung.price);
			// Every rung above was actually attempted, in the documented order.
			expect(tried).toEqual(PRICE_CHAIN.slice(0, i + 1).map((r) => r.name));
		});
	}

	it('walks past the real Binance 451 and Bybit 403 geo-blocks to a venue that answers', async () => {
		globalThis.fetch = vi.fn(async (url) => {
			const u = String(url);
			if (u.includes('api.binance.com')) return httpBlock(451, BINANCE_GEOBLOCK);
			if (u.includes('api.bybit.com')) return httpBlock(403, {});
			if (u.includes('www.okx.com')) throw transportFailure('reset');
			if (u.includes('api.kucoin.com')) return okJson(KUCOIN_STATS);
			throw transportFailure('abort'); // aggregators and USD exchanges are down
		});
		const price = await mf.fetchCoinPriceUsd('bitcoin');
		expect(price).toBe(64636.3);
	});

	it('serves the 7d chart from a CEX kline rung when Kraken, Coinbase and Binance die', async () => {
		const h1 = 3_600_000;
		const t0 = Date.now() - 2 * h1;
		// OKX layout: [ts_ms, o, h, l, c, ...], newest first.
		const okxRows = [
			[String(t0 + h1), '101', '106', '100', '105', '1', '1', '1', '1'],
			[String(t0), '100', '104', '99', '103', '1', '1', '1', '1'],
		];
		globalThis.fetch = vi.fn(async (url) => {
			const u = String(url);
			if (u.includes('www.okx.com')) return okJson({ code: '0', msg: '', data: okxRows });
			throw transportFailure('reset');
		});
		const series = await mf.fetchExchangeChart('bitcoin', 7);
		expect(series).toEqual([
			[t0, 103],
			[t0 + h1, 105],
		]);
	});

	it('never asks OKX or Bitget for the 365d window and serves it from Gate', async () => {
		const day = 86_400_000;
		const t0 = Date.now() - 2 * day;
		// Gate layout: [t_s, quoteVol, close, high, low, open, baseVol, done].
		const gateRows = [
			[String(Math.floor(t0 / 1000)), '900000', '64000', '64500', '63500', '63800', '14', 'true'],
			[String(Math.floor((t0 + day) / 1000)), '910000', '64100', '64600', '63600', '64000', '14', 'true'],
		];
		const asked = new Set();
		globalThis.fetch = vi.fn(async (url) => {
			const u = String(url);
			asked.add(new URL(u).host);
			if (u.includes('api.gateio.ws')) return okJson(gateRows);
			throw transportFailure('abort');
		});
		const series = await mf.fetchExchangeChart('bitcoin', 365);
		expect(series).toEqual([
			[Math.floor(t0 / 1000) * 1000, 64000],
			[Math.floor((t0 + day) / 1000) * 1000, 64100],
		]);
		expect(asked.has('www.okx.com')).toBe(false);
		expect(asked.has('api.bitget.com')).toBe(false);
	});

	it('maps every EXCHANGE_PAIRS id to a CEX base symbol', () => {
		for (const id of Object.keys(mf.EXCHANGE_PAIRS)) {
			expect(CEX_BASE_BY_ID[id], `missing CEX base for ${id}`).toBeTruthy();
		}
	});
});
