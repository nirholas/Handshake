// Deribit (api/_lib/deribit.js): unit + wiring tests.
//
// Pins the public/ticker → derivatives-ticker-row mapping and the unit
// conversions the /derivatives comparability depends on: decimal 8h funding →
// percent, and linear (USDC-settled) open interest in base units → USD
// notional, while inverse open interest passes through as the USD it already
// is. Also pins the options-book aggregation (base-currency filter, USD open
// interest via underlying price, put/call split off the -C/-P suffix), the
// JSON-RPC envelope handling (Deribit signals bad params with HTTP 200 + an
// `error` object), and the /api/coin/derivatives soft-fail wiring.
//
// No live network: fixtures are trimmed real-shaped captures from
// www.deribit.com/api/v2/public/* (verified 2026-08-05), and the envelope +
// wiring cases run against a stubbed global fetch.

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
	normalizeDeribitPerp,
	summarizeDeribitOptions,
	deribitGet,
	DERIBIT_PERPS,
	DERIBIT_OPTION_BOOKS,
} from '../../api/_lib/deribit.js';

const realFetch = global.fetch;
afterEach(() => {
	global.fetch = realFetch;
	vi.restoreAllMocks();
});

// ── Fixtures: trimmed but real-shaped captures ───────────────────────────────
const BTC_TICKER = {
	instrument_name: 'BTC-PERPETUAL',
	state: 'open',
	mark_price: 64000,
	index_price: 63990.5,
	last_price: 64001.5,
	open_interest: 730_000_000, // inverse contract: already USD notional
	funding_8h: 0.0001,
	current_funding: 0.00005,
	stats: { high: 64970, low: 63856.5, price_change: 0.792, volume: 3583.7, volume_usd: 230_776_660 },
};

const SOL_TICKER = {
	instrument_name: 'SOL_USDC-PERPETUAL',
	state: 'open',
	mark_price: 74,
	index_price: 73.96,
	open_interest: 200_000, // linear contract: base (SOL) units
	funding_8h: -0.00004,
	stats: { price_change: 0.3974, volume: 269_194.1, volume_usd: 19_916_271 },
};

// The shared USDC book mixes bases (SOL_USDC-*, XRP_USDC-*, ...); the
// aggregate must keep only the requested one.
const USDC_OPTION_BOOK = [
	{
		instrument_name: 'SOL_USDC-26MAR27-80-C',
		base_currency: 'SOL',
		quote_currency: 'USDC',
		open_interest: 100,
		underlying_price: 75,
		volume_usd: 1000,
		mark_iv: 58.13,
	},
	{
		instrument_name: 'SOL_USDC-26MAR27-60-P',
		base_currency: 'SOL',
		quote_currency: 'USDC',
		open_interest: 50,
		underlying_price: 75,
		volume_usd: 250,
	},
	{
		instrument_name: 'XRP_USDC-26MAR27-1-C',
		base_currency: 'XRP',
		quote_currency: 'USDC',
		open_interest: 9999,
		underlying_price: 1,
		volume_usd: 5,
	},
	// A dead strike: no open interest / volume yet, still a listed contract.
	{
		instrument_name: 'SOL_USDC-26MAR27-90-C',
		base_currency: 'SOL',
		quote_currency: 'USDC',
		open_interest: 0,
		underlying_price: 75,
		volume_usd: 0,
	},
];

const rpcOk = (result) => ({
	ok: true,
	status: 200,
	json: async () => ({ jsonrpc: '2.0', result, testnet: false }),
});

describe('DERIBIT instrument config', () => {
	it('tracks BTC/ETH as inverse and SOL as USDC-linear, options books to match', () => {
		expect(DERIBIT_PERPS.map((p) => p.asset)).toEqual(['BTC', 'ETH', 'SOL']);
		expect(DERIBIT_PERPS.find((p) => p.asset === 'BTC')).toMatchObject({
			instrument: 'BTC-PERPETUAL',
			linear: false,
		});
		expect(DERIBIT_PERPS.find((p) => p.asset === 'SOL')).toMatchObject({
			instrument: 'SOL_USDC-PERPETUAL',
			linear: true,
		});
		// SOL options live under the shared USDC listing, not currency=SOL.
		expect(DERIBIT_OPTION_BOOKS.find((b) => b.asset === 'SOL').currency).toBe('USDC');
	});
});

describe('normalizeDeribitPerp', () => {
	it('maps an inverse perp: USD open interest passes through, funding decimal → percent', () => {
		const row = normalizeDeribitPerp(BTC_TICKER, DERIBIT_PERPS[0]);
		expect(row).toEqual({
			market: 'Deribit',
			symbol: 'BTC-PERPETUAL',
			index_id: 'BTC',
			price: 64000,
			change_24h: 0.792, // stats.price_change is already a percentage
			funding_rate: 0.01, // 0.0001 decimal 8h → 0.01%
			open_interest: 730_000_000,
			volume_24h: 230_776_660,
		});
	});

	it('maps a linear perp: base-unit open interest × mark price, negative funding keeps its sign', () => {
		const row = normalizeDeribitPerp(SOL_TICKER, DERIBIT_PERPS[2]);
		expect(row.index_id).toBe('SOL');
		expect(row.open_interest).toBe(14_800_000); // 200k SOL × $74
		expect(row.funding_rate).toBeCloseTo(-0.004, 9);
	});

	it('null-safes a partial ticker and rejects one without a positive mark price', () => {
		const row = normalizeDeribitPerp({ mark_price: 2 }, DERIBIT_PERPS[1]);
		expect(row).toEqual({
			market: 'Deribit',
			symbol: 'ETH-PERPETUAL',
			index_id: 'ETH',
			price: 2,
			change_24h: null,
			funding_rate: null,
			open_interest: null,
			volume_24h: null,
		});
		expect(normalizeDeribitPerp(null, DERIBIT_PERPS[0])).toBeNull();
		expect(normalizeDeribitPerp({ mark_price: 0 }, DERIBIT_PERPS[0])).toBeNull();
	});
});

describe('summarizeDeribitOptions', () => {
	it('filters by base currency, converts OI to USD via underlying, splits put/call', () => {
		const s = summarizeDeribitOptions(USDC_OPTION_BOOK, 'SOL');
		expect(s).toEqual({
			asset: 'SOL',
			contracts: 3, // XRP row excluded, dead SOL strike still counted
			open_interest: 11_250, // (100 + 50 + 0) coins × $75
			volume_24h: 1250,
			put_call_ratio: 0.5, // 50 put OI / 100 call OI
		});
	});

	it('returns a zeroed aggregate (ratio null) for empty or malformed books', () => {
		const empty = { asset: 'BTC', contracts: 0, open_interest: 0, volume_24h: 0, put_call_ratio: null };
		expect(summarizeDeribitOptions([], 'BTC')).toEqual(empty);
		expect(summarizeDeribitOptions(null, 'BTC')).toEqual(empty);
		expect(summarizeDeribitOptions('Route not found', 'BTC')).toEqual(empty);
	});

	it('leaves the ratio null when no call OI exists (division guard)', () => {
		const puts = [
			{ instrument_name: 'ETH-1JAN27-1500-P', base_currency: 'ETH', open_interest: 5, underlying_price: 2000, volume_usd: 10 },
		];
		expect(summarizeDeribitOptions(puts, 'ETH').put_call_ratio).toBeNull();
	});
});

describe('deribitGet JSON-RPC envelope', () => {
	it('unwraps result and builds the public URL with params', async () => {
		global.fetch = vi.fn().mockResolvedValue(rpcOk({ index_price: 64579.78 }));
		const result = await deribitGet('get_index_price', { index_name: 'btc_usd' });
		expect(result).toEqual({ index_price: 64579.78 });
		const url = String(global.fetch.mock.calls[0][0]);
		expect(url).toBe('https://www.deribit.com/api/v2/public/get_index_price?index_name=btc_usd');
	});

	it('throws on an RPC error even though the HTTP status is 200', async () => {
		global.fetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({
				jsonrpc: '2.0',
				error: { code: -32602, message: 'Invalid params' },
			}),
		});
		await expect(deribitGet('ticker', { instrument_name: 'NOPE' })).rejects.toThrow(
			/deribit rpc -32602/,
		);
	});

	it('throws with the status on a non-2xx response', async () => {
		global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
		await expect(deribitGet('ticker', { instrument_name: 'BTC-PERPETUAL' })).rejects.toMatchObject(
			{ status: 503 },
		);
	});
});

// ── /api/coin/derivatives wiring ─────────────────────────────────────────────
// Fresh module instances per case (vi.resetModules) because the builder holds
// a 60s in-memory cache with no reset hook.

const GECKO_ROWS = [
	{
		market: 'Binance (Futures)',
		symbol: 'BTCUSDT',
		index_id: 'BTC',
		price: '64000',
		price_percentage_change_24h: 1.2,
		contract_type: 'perpetual',
		funding_rate: 0.005,
		open_interest: 5_000_000_000,
		volume_24h: 20_000_000_000,
	},
];

// Route every upstream the builder can touch; anything unexpected fails loud.
const stubUpstreams = ({ deribitDown = false } = {}) => {
	global.fetch = vi.fn(async (input) => {
		const url = String(input);
		if (url.includes('api.coingecko.com')) {
			return { ok: true, status: 200, json: async () => GECKO_ROWS };
		}
		if (url.includes('deribit.com')) {
			if (deribitDown) return { ok: false, status: 503, json: async () => ({}) };
			const u = new URL(url);
			if (url.includes('/ticker')) {
				const name = u.searchParams.get('instrument_name');
				return rpcOk(name === 'SOL_USDC-PERPETUAL' ? SOL_TICKER : { ...BTC_TICKER, instrument_name: name });
			}
			if (url.includes('/get_index_price')) return rpcOk({ index_price: 64579.78 });
			if (url.includes('/get_book_summary_by_currency')) {
				return rpcOk(u.searchParams.get('currency') === 'USDC' ? USDC_OPTION_BOOK : []);
			}
		}
		throw new Error(`Unexpected fetch: ${url}`);
	});
};

describe('buildDerivativeTickers deribit block', () => {
	it('attaches indexes, perps, and options next to the primary ticker table', async () => {
		vi.resetModules();
		stubUpstreams();
		const { buildDerivativeTickers } = await import('../../api/coin/derivatives.js');
		const value = await buildDerivativeTickers();

		expect(value.source).toBe('coingecko');
		expect(value.tickers).toHaveLength(1);
		expect(value.deribit.indexes).toEqual({ BTC: 64579.78, ETH: 64579.78, SOL: 64579.78 });
		expect(value.deribit.perps.map((r) => r.market)).toEqual(['Deribit', 'Deribit', 'Deribit']);
		expect(value.deribit.perps.map((r) => r.index_id).sort()).toEqual(['BTC', 'ETH', 'SOL']);
		// Empty BTC/ETH books are dropped; the USDC book yields the SOL aggregate.
		expect(value.deribit.options).toEqual([
			{ asset: 'SOL', contracts: 3, open_interest: 11_250, volume_24h: 1250, put_call_ratio: 0.5 },
		]);
	});

	it('fails soft: an unreachable Deribit yields deribit:null, never a thrown table', async () => {
		vi.resetModules();
		stubUpstreams({ deribitDown: true });
		const { buildDerivativeTickers } = await import('../../api/coin/derivatives.js');
		const value = await buildDerivativeTickers();

		expect(value.tickers).toHaveLength(1);
		expect(value.source).toBe('coingecko');
		expect(value.deribit).toBeNull();
	});
});
