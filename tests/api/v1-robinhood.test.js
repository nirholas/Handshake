// GET /api/v1/robinhood/{chain,stocks,stocks-detail,coins,coins-detail,launches}
// — free Robinhood Chain market data endpoints built on api/_lib/robinhood.js.
//
// The lib itself hits real on-chain multicall + Blockscout + DefiLlama +
// CoinGecko + DexScreener, so these tests mock every named export the
// handlers import from it (pinning the handler's own composition/validation
// logic, not the upstreams) and stub the gateway's rate limiters to always
// pass except in the dedicated 429 test. Real upstream behavior (multicall
// shape, Blockscout log filtering, DexScreener chainId) was verified live
// during development — see api/_lib/robinhood.js.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'node:stream';

let robinhoodReadOk = true;
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		apiV1: async () => ({ success: true, limit: 120, remaining: 119, reset: Date.now() + 60_000 }),
		robinhoodRead: async () =>
			robinhoodReadOk
				? { success: true, limit: 60, remaining: 59, reset: Date.now() + 60_000 }
				: { success: false, limit: 60, remaining: 0, reset: Date.now() + 60_000 },
	},
	clientIp: () => '203.0.113.7',
}));

const AAPL = { symbol: 'AAPL', name: 'Apple • Robinhood Token', address: '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9', decimals: 18, feed: '0x6B22A786bAa607d76728168703a39Ea9C99f2cD0', uiMultiplierAtGeneration: '1000000000000000000' };
const NFLX = { symbol: 'NFLX', name: 'Netflix • Robinhood Token', address: '0x3b8262A63d25f0477c4DDE23F83cfe22Cb768C93', decimals: 18, feed: null, uiMultiplierAtGeneration: '1000000000000000000' };

vi.mock('../../api/_lib/robinhood.js', () => ({
	stockRegistry: () => ({ tokens: [AAPL, NFLX], feedCount: 34, tokenCount: 95 }),
	findStock: (symbol) => (String(symbol).toUpperCase() === 'AAPL' ? AAPL : null),
	chainlinkSnapshot: async () => ({
		[AAPL.address.toLowerCase()]: { symbol: 'AAPL', priceUsd: 315.5, updatedAt: 1783710274, uiMultiplier: '1000000000000000000', totalSupply: '1000000000000000000000' },
	}),
	dexSnapshot: async (addresses) => {
		const out = {};
		if (addresses.map((a) => a.toLowerCase()).includes(AAPL.address.toLowerCase())) {
			out[AAPL.address.toLowerCase()] = { dexId: 'uniswap', pairAddress: '0xpair', priceUsd: '311.89', quoteToken: { symbol: 'USDG' }, liquidity: { usd: 17423.19 }, volume: { h24: 6580.92 }, priceChange: { h24: 1.2 } };
		}
		return out;
	},
	dexPairsForToken: async (address) =>
		address.toLowerCase() === AAPL.address.toLowerCase()
			? [{ dexId: 'uniswap', pairAddress: '0xpair', priceUsd: '311.89', quoteToken: { symbol: 'USDG' }, liquidity: { usd: 17423.19 }, volume: { h24: 6580.92 }, priceChange: { h24: 1.2 }, url: 'https://dexscreener.com/robinhood/0xpair' }]
			: [],
	bestDexPair: async () => null,
	feedRoundHistory: async () => [{ roundId: '1', priceUsd: 310, updatedAt: 1783700000 }, { roundId: '2', priceUsd: 315.5, updatedAt: 1783710274 }],
	blockscoutStats: async () => ({ average_block_time: 101.0, coin_price: '1800.58', gas_prices: { slow: 0.06, average: 0.07, fast: 0.16 }, total_transactions: 500000, total_addresses: 20000, total_blocks: 7700000 }),
	blockscoutToken: async (address) =>
		address.toLowerCase() === AAPL.address.toLowerCase()
			? { holders_count: '6260', circulating_market_cap: '464146.563', icon_url: 'https://cdn.robinhood.com/aapl.png', total_supply: '1471146000000000000000', decimals: '18', symbol: 'AAPL', name: 'Apple • Robinhood Token' }
			: null,
	blockscoutHolders: async () => [{ address: '0xholder1', isContract: false, value: '1000000000000000000' }],
	blockscoutTransfers: async () => [{ hash: '0xtxhash', from: '0xfrom', to: '0xto', value: '1', timestamp: '2026-07-12T00:00:00Z' }],
	chainTvlHistory: async () => [{ date: 1782950400, tvl: 1342 }, { date: 1783641600, tvl: 74423718 }],
	chainTvlCurrent: async () => 131505729.36833173,
	coingeckoCategory: async () => [
		{ id: 'cash-cat', symbol: 'cashcat', name: 'CashCat', current_price: 0.177596, market_cap: 176098811, market_cap_rank: 1, total_volume: 5000000, price_change_percentage_24h_in_currency: 3.2, price_change_percentage_7d_in_currency: 10.1, sparkline_in_7d: { price: [0.1, 0.15, 0.17] } },
	],
	recentLaunches: async () => [{ launchpad: 'NOXA', type: 'instant', token: '0xtoken1234567890123456789012345678901234', deployer: '0xdeployer', block: 6880646, txHash: '0xtxhash', timestamp: '2026-07-11T10:44:33Z' }],
	publicClient: () => ({ getBlockNumber: async () => 7700000n }),
	BLOCKSCOUT_BASE: 'https://robinhoodchain.blockscout.com',
	premiumPct: (dexUsd, navUsd) => {
		const d = Number(dexUsd), n = Number(navUsd);
		if (!Number.isFinite(d) || !Number.isFinite(n) || n <= 0) return null;
		return ((d - n) / n) * 100;
	},
	asOf: () => '2026-07-12T00:00:00.000Z',
}));

beforeEach(() => {
	robinhoodReadOk = true;
});
afterEach(() => {
	vi.restoreAllMocks();
});

function makeReq({ url, host = 'three.ws' } = {}) {
	const stream = Readable.from([]);
	stream.method = 'GET';
	stream.url = url;
	stream.headers = { host };
	return stream;
}

function makeRes() {
	return {
		statusCode: 200,
		_h: {},
		writableEnded: false,
		headersSent: false,
		setHeader(k, v) { this._h[k.toLowerCase()] = v; },
		getHeader(k) { return this._h[k.toLowerCase()]; },
		end(body) { this._body = body; this.writableEnded = true; },
	};
}

async function dispatch(modulePath, url) {
	const mod = await import(modulePath);
	const req = makeReq({ url });
	const res = makeRes();
	await mod.default(req, res);
	return { res, body: res._body ? JSON.parse(res._body) : null };
}

describe('GET /api/v1/robinhood/chain', () => {
	it('returns chain stats with tvl and gas', async () => {
		const { res, body } = await dispatch('../../api/v1/robinhood/chain.js', '/api/v1/robinhood/chain');
		expect(res.statusCode).toBe(200);
		expect(body.data.chain.chainId).toBe(4663);
		expect(body.data.tvlUsd).toBeCloseTo(131505729.37, 0);
		expect(body.data.gas.average).toBe(0.07);
		expect(body.data.tvlHistory.length).toBe(2);
		expect(body.data.source).toMatch(/blockscout/);
	});
});

describe('GET /api/v1/robinhood/stocks', () => {
	it('returns the board with NAV, DEX price, and premium', async () => {
		const { res, body } = await dispatch('../../api/v1/robinhood/stocks.js', '/api/v1/robinhood/stocks');
		expect(res.statusCode).toBe(200);
		expect(body.data.count).toBe(2);
		const aapl = body.data.stocks.find((s) => s.symbol === 'AAPL');
		expect(aapl.navPriceUsd).toBe(315.5);
		expect(aapl.dexPriceUsd).toBeCloseTo(311.89, 2);
		expect(aapl.premiumPct).toBeCloseTo(-1.144, 2);
		expect(body.data.disclosure).toMatch(/US persons/);
	});

	it('filters by ?q=', async () => {
		const { body } = await dispatch('../../api/v1/robinhood/stocks.js', '/api/v1/robinhood/stocks?q=nflx');
		expect(body.data.stocks.length).toBe(1);
		expect(body.data.stocks[0].symbol).toBe('NFLX');
	});

	it('rate-limits at 429', async () => {
		robinhoodReadOk = false;
		const { res, body } = await dispatch('../../api/v1/robinhood/stocks.js', '/api/v1/robinhood/stocks');
		expect(res.statusCode).toBe(429);
		expect(body.error).toBe('rate_limited');
	});
});

describe('GET /api/v1/robinhood/stocks-detail', () => {
	it('returns 400 without a symbol', async () => {
		const { res, body } = await dispatch('../../api/v1/robinhood/stocks-detail.js', '/api/v1/robinhood/stocks-detail');
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('validation_error');
	});

	it('returns 404 for an unknown symbol', async () => {
		const { res, body } = await dispatch('../../api/v1/robinhood/stocks-detail.js', '/api/v1/robinhood/stocks-detail?symbol=ZZZZ');
		expect(res.statusCode).toBe(404);
		expect(body.error).toBe('not_found');
	});

	it('returns full detail for AAPL', async () => {
		const { res, body } = await dispatch('../../api/v1/robinhood/stocks-detail.js', '/api/v1/robinhood/stocks-detail?symbol=aapl');
		expect(res.statusCode).toBe(200);
		expect(body.data.symbol).toBe('AAPL');
		expect(body.data.nav.priceUsd).toBe(315.5);
		expect(body.data.nav.history.length).toBe(2);
		expect(body.data.dex.pairs.length).toBe(1);
		expect(body.data.holdersCount).toBe(6260);
		expect(body.data.holders.length).toBe(1);
		expect(body.data.recentTransfers.length).toBe(1);
		expect(body.data.links.explorer).toMatch(/^https:\/\/robinhoodchain\.blockscout\.com\/token\//);
	});
});

describe('GET /api/v1/robinhood/coins', () => {
	it('returns the memecoin screener', async () => {
		const { res, body } = await dispatch('../../api/v1/robinhood/coins.js', '/api/v1/robinhood/coins?category=meme');
		expect(res.statusCode).toBe(200);
		expect(body.data.category).toBe('meme');
		expect(body.data.coins[0].symbol).toBe('CASHCAT');
		expect(body.data.coins[0].marketCapUsd).toBe(176098811);
	});
});

describe('GET /api/v1/robinhood/coins-detail', () => {
	it('returns 400 for an invalid address', async () => {
		const { res, body } = await dispatch('../../api/v1/robinhood/coins-detail.js', '/api/v1/robinhood/coins-detail?address=not-an-address');
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('validation_error');
	});

	it('returns 200 with pools + holders for a known token', async () => {
		const { res, body } = await dispatch('../../api/v1/robinhood/coins-detail.js', `/api/v1/robinhood/coins-detail?address=${AAPL.address}`);
		expect(res.statusCode).toBe(200);
		expect(body.data.pools.length).toBe(1);
		expect(body.data.holdersCount).toBe(6260);
	});

	it('returns 404 when no market or token record exists', async () => {
		const { res, body } = await dispatch('../../api/v1/robinhood/coins-detail.js', '/api/v1/robinhood/coins-detail?address=0x000000000000000000000000000000000000dEaD');
		expect(res.statusCode).toBe(404);
		expect(body.error).toBe('not_found');
	});
});

describe('GET /api/v1/robinhood/launches', () => {
	it('returns recent launches enriched with market data', async () => {
		const { res, body } = await dispatch('../../api/v1/robinhood/launches.js', '/api/v1/robinhood/launches');
		expect(res.statusCode).toBe(200);
		expect(body.data.launches.length).toBe(1);
		expect(body.data.launches[0].launchpad).toBe('NOXA');
		expect(body.data.launchpads.length).toBe(2);
	});
});

describe('/api/v1 catalog', () => {
	it('registers all six free Robinhood Chain endpoints', async () => {
		const { CATALOG } = await import('../../api/v1/_catalog.js');
		const ids = ['v1.robinhood.chain', 'v1.robinhood.stocks', 'v1.robinhood.stocks-detail', 'v1.robinhood.coins', 'v1.robinhood.coins-detail', 'v1.robinhood.launches'];
		for (const id of ids) {
			const entry = CATALOG.find((e) => e.id === id);
			expect(entry, `${id} missing from catalog`).toBeTruthy();
			expect(entry.method).toBe('GET');
			expect(entry.auth).toBe('public');
		}
	});
});
