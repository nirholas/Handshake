// Contract tests for the /api/coin/* market read endpoints.
//
// These eight handlers all sit in front of a rate-limited third-party upstream
// (CoinGecko keyless, alternative.me, public Ethereum RPCs). What matters is
// not the happy path alone but what a caller sees when an upstream is throttled
// or half-answers: a typed 4xx/5xx JSON envelope, never a stack trace, never a
// partially-shaped body, and never a 502 when a working fallback exists.
//
// Each load() resets the module registry first, because every one of these
// handlers keeps a per-instance memory cache: without it a success case would
// serve the following failure case its cached payload and the test would pass
// for the wrong reason.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../api/_lib/zauth.js', () => ({ instrument: () => {}, drain: async () => {} }));
vi.mock('../../api/_lib/sentry.js', () => ({ captureException: () => {} }));
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: { marketDataIp: async () => ({ success: true }) },
	clientIp: () => '203.0.113.7',
}));

const geckoFetch = vi.fn();
vi.mock('../../api/_lib/coingecko.js', () => ({
	geckoFetch: (...a) => geckoFetch(...a),
	isPlausibleCoinId: (id) => /^[a-z0-9][a-z0-9_-]*$/.test(id),
	htmlToText: (s) => String(s || '').replace(/<[^>]+>/g, '').trim(),
	COINGECKO_BASE: 'https://api.coingecko.com/api/v3',
}));

const fetchGlobalMarket = vi.fn();
const fetchCoinPriceUsd = vi.fn();
const fetchCoinPriceUsdOrNull = vi.fn();
vi.mock('../../api/_lib/market-fallbacks.js', () => ({
	fetchGlobalMarket: (...a) => fetchGlobalMarket(...a),
	fetchCoinPriceUsd: (...a) => fetchCoinPriceUsd(...a),
	fetchCoinPriceUsdOrNull: (...a) => fetchCoinPriceUsdOrNull(...a),
}));

const fetchHyperliquidPerps = vi.fn();
vi.mock('../../api/_lib/hyperliquid.js', () => ({
	fetchHyperliquidPerps: (...a) => fetchHyperliquidPerps(...a),
}));

const fetchDeribitSummary = vi.fn();
vi.mock('../../api/_lib/deribit.js', () => ({
	fetchDeribitSummary: (...a) => fetchDeribitSummary(...a),
}));

function makeRes() {
	return {
		statusCode: 200,
		_h: {},
		setHeader(k, v) { this._h[k.toLowerCase()] = v; },
		getHeader(k) { return this._h[k.toLowerCase()]; },
		end(body) { this._body = body; },
	};
}

/** Fresh handler instance (empties the module's in-process cache). */
async function load(path) {
	vi.resetModules();
	return (await import(path)).default;
}

async function call(handler, url, httpMethod = 'GET') {
	const res = makeRes();
	await handler({ url, method: httpMethod, headers: {} }, res);
	return { res, body: res._body ? JSON.parse(res._body) : null };
}

const upstream = (status) => {
	const err = new Error(`CoinGecko ${status}`);
	err.status = status;
	return err;
};

const CATEGORIES = [
	{
		id: 'layer-1',
		name: 'Layer 1 (L1)',
		market_cap: 1_500_000_000_000,
		market_cap_change_24h: -1.25,
		volume_24h: 70_000_000_000,
		top_3_coins: ['https://img/btc.png', 'https://img/eth.png', 'https://img/sol.png', 'https://img/bnb.png'],
		content: '<p>Layer 1 blockchains settle their own transactions.</p>',
	},
	{
		id: 'smart-contract-platform',
		name: 'Smart Contract Platform',
		market_cap: 900_000_000_000,
		market_cap_change_24h: 0.4,
		volume_24h: 40_000_000_000,
		top_3_coins: [],
	},
	{
		id: 'meme-token',
		name: 'Meme',
		market_cap: Number.NaN,
		market_cap_change_24h: null,
		volume_24h: 5_000_000_000,
		top_3_coins: null,
	},
];

beforeEach(() => {
	geckoFetch.mockReset();
	fetchGlobalMarket.mockReset();
	fetchCoinPriceUsd.mockReset();
	fetchCoinPriceUsdOrNull.mockReset();
	fetchHyperliquidPerps.mockReset();
	fetchDeribitSummary.mockReset();
});

describe('/api/coin/categories', () => {
	it('shapes the sector leaderboard and drops non-finite numbers', async () => {
		geckoFetch.mockResolvedValue(CATEGORIES);
		const { res, body } = await call(await load('../../api/coin/categories.js'), '/api/coin/categories');
		expect(res.statusCode).toBe(200);
		expect(body.categories).toHaveLength(3);
		expect(body.categories[0]).toMatchObject({ id: 'layer-1', market_cap: 1_500_000_000_000 });
		// NaN upstream must land as null, never as the string "NaN" in JSON.
		expect(body.categories[2].market_cap).toBeNull();
		// The avatar stack renders three icons; a longer upstream list is capped.
		expect(body.categories[0].top_3_coins).toHaveLength(3);
		expect(body.categories[2].top_3_coins).toEqual([]);
		expect(res.getHeader('cache-control')).toContain('s-maxage=600');
	});

	it('answers 502 with a typed envelope when the upstream is throttled', async () => {
		geckoFetch.mockRejectedValue(upstream(429));
		const { res, body } = await call(await load('../../api/coin/categories.js'), '/api/coin/categories');
		expect(res.statusCode).toBe(502);
		expect(body.error).toBe('upstream_error');
		expect(res.getHeader('cache-control')).toBe('no-store');
	});

	it('rejects a non-GET method', async () => {
		const { res, body } = await call(await load('../../api/coin/categories.js'), '/api/coin/categories', 'POST');
		expect(res.statusCode).toBe(405);
		expect(body.error).toBe('method_not_allowed');
	});
});

describe('/api/coin/category', () => {
	it('rejects an id that is not a slug', async () => {
		const { res, body } = await call(await load('../../api/coin/category.js'), '/api/coin/category?id=Layer%201!');
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('bad_id');
		expect(geckoFetch).not.toHaveBeenCalled();
	});

	it('404s a slug the upstream does not list', async () => {
		geckoFetch.mockResolvedValue(CATEGORIES);
		const { res, body } = await call(await load('../../api/coin/category.js'), '/api/coin/category?id=no-such-sector');
		expect(res.statusCode).toBe(404);
		expect(body.error).toBe('not_found');
	});

	it('derives rank, categorized share, and rank-nearest neighbours', async () => {
		geckoFetch.mockResolvedValue(CATEGORIES);
		const { res, body } = await call(
			await load('../../api/coin/category.js'),
			'/api/coin/category?id=smart-contract-platform',
		);
		expect(res.statusCode).toBe(200);
		expect(body.category.rank).toBe(2);
		// share is of the SUM of category market caps (1.5T + 0.9T), not of total crypto.
		expect(body.category.share_of_total).toBeCloseTo((900 / 2400) * 100, 6);
		expect(body.related.map((r) => r.id)).toEqual(['layer-1', 'meme-token']);
	});

	it('strips upstream HTML out of the description', async () => {
		geckoFetch.mockResolvedValue(CATEGORIES);
		const { body } = await call(await load('../../api/coin/category.js'), '/api/coin/category?id=layer-1');
		expect(body.category.description).toBe('Layer 1 blockchains settle their own transactions.');
	});
});

describe('/api/coin/global', () => {
	it('renders each half independently when the other upstream fails', async () => {
		fetchGlobalMarket.mockRejectedValue(new Error('all sources down'));
		globalThis.fetch = vi.fn(async () => ({
			ok: true,
			json: async () => ({ data: [{ value: '31', value_classification: 'Fear' }] }),
		}));
		const { res, body } = await call(await load('../../api/coin/global.js'), '/api/coin/global');
		expect(res.statusCode).toBe(200);
		expect(body.market).toBeNull();
		expect(body.fear_greed).toEqual({ value: 31, label: 'Fear' });
	});

	it('502s only when both halves fail', async () => {
		fetchGlobalMarket.mockRejectedValue(new Error('all sources down'));
		globalThis.fetch = vi.fn(async () => ({ ok: false, status: 503 }));
		const { res, body } = await call(await load('../../api/coin/global.js'), '/api/coin/global');
		expect(res.statusCode).toBe(502);
		expect(body.error).toBe('upstream_error');
	});
});

describe('/api/coin/exchanges', () => {
	const ROWS = [
		{
			id: 'binance',
			name: 'Binance',
			trade_volume_24h_btc: '120000',
			trust_score: 10,
			trust_score_rank: 1,
			url: 'https://www.binance.com',
		},
		{
			id: 'sketchy',
			name: 'Sketchy',
			trade_volume_24h_btc: 'n/a',
			trust_score: 1,
			trust_score_rank: 99,
			url: 'javascript:alert(1)',
		},
	];

	it('converts BTC volume to USD with the live price', async () => {
		geckoFetch.mockResolvedValue(ROWS);
		fetchCoinPriceUsd.mockResolvedValue(60_000);
		const { res, body } = await call(await load('../../api/coin/exchanges.js'), '/api/coin/exchanges');
		expect(res.statusCode).toBe(200);
		expect(body.btc_usd).toBe(60_000);
		expect(body.exchanges[0].volume_24h_usd).toBe(120_000 * 60_000);
		// A non-numeric upstream volume must not become NaN in the JSON body.
		expect(body.exchanges[1].volume_24h_btc).toBeNull();
		expect(body.exchanges[1].volume_24h_usd).toBeNull();
		// Only http(s) links reach the client.
		expect(body.exchanges[1].url).toBeNull();
	});

	it('still serves the table when the price feed is down', async () => {
		geckoFetch.mockResolvedValue(ROWS);
		fetchCoinPriceUsd.mockRejectedValue(new Error('price sources down'));
		const { res, body } = await call(await load('../../api/coin/exchanges.js'), '/api/coin/exchanges');
		expect(res.statusCode).toBe(200);
		expect(body.btc_usd).toBeNull();
		expect(body.exchanges[0].volume_24h_btc).toBe(120_000);
		expect(body.exchanges[0].volume_24h_usd).toBeNull();
	});

	it('502s when the exchange list itself is unavailable', async () => {
		geckoFetch.mockRejectedValue(upstream(429));
		fetchCoinPriceUsd.mockResolvedValue(60_000);
		const { res, body } = await call(await load('../../api/coin/exchanges.js'), '/api/coin/exchanges');
		expect(res.statusCode).toBe(502);
		expect(body.error).toBe('upstream_error');
	});
});

describe('/api/coin/derivatives', () => {
	it('falls back to Hyperliquid when CoinGecko is throttled', async () => {
		geckoFetch.mockRejectedValue(upstream(429));
		fetchDeribitSummary.mockResolvedValue(null);
		fetchHyperliquidPerps.mockResolvedValue([
			{ market: 'Hyperliquid', symbol: 'BTC-USD', price: 64_093, funding_rate: 0.01, open_interest: 1, volume_24h: 2 },
		]);
		const { res, body } = await call(await load('../../api/coin/derivatives.js'), '/api/coin/derivatives');
		expect(res.statusCode).toBe(200);
		expect(body.source).toBe('hyperliquid');
		expect(body.tickers[0].symbol).toBe('BTC-USD');
	});

	it('keeps only perpetuals and sorts them by 24h volume', async () => {
		geckoFetch.mockResolvedValue([
			{ market: 'A', symbol: 'ETH', contract_type: 'perpetual', price: 1, volume_24h: 10 },
			{ market: 'B', symbol: 'BTC', contract_type: 'perpetual', price: 2, volume_24h: 99 },
			{ market: 'C', symbol: 'BTC-DEC', contract_type: 'futures', price: 3, volume_24h: 500 },
		]);
		fetchDeribitSummary.mockResolvedValue(null);
		const { body } = await call(await load('../../api/coin/derivatives.js'), '/api/coin/derivatives');
		expect(body.source).toBe('coingecko');
		expect(body.tickers.map((t) => t.symbol)).toEqual(['BTC', 'ETH']);
	});

	it('502s the exchanges view on an empty upstream payload', async () => {
		geckoFetch.mockResolvedValue([]);
		const { res, body } = await call(
			await load('../../api/coin/derivatives.js'),
			'/api/coin/derivatives?view=exchanges',
		);
		expect(res.statusCode).toBe(502);
		expect(body.error).toBe('upstream_error');
	});
});

describe('/api/coin/exchange', () => {
	it('rejects an id outside the slug charset', async () => {
		const { res, body } = await call(await load('../../api/coin/exchange.js'), '/api/coin/exchange?id=%21%21bad');
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('bad_id');
	});

	it('serves the spot profile with the normalized volume from the ranked list', async () => {
		fetchCoinPriceUsdOrNull.mockResolvedValue(60_000);
		geckoFetch.mockImplementation(async (path) => {
			if (path === '/exchanges/binance') {
				return {
					name: 'Binance',
					description: '<p>An exchange.</p>',
					url: 'https://www.binance.com',
					trade_volume_24h_btc: 120_000,
					tickers: [
						{
							base: '0x1234567890abcdef1234567890abcdef12345678',
							target: 'USDT',
							converted_last: { usd: 1 },
							converted_volume: { usd: 2 },
						},
					],
				};
			}
			if (path.startsWith('/exchanges/binance/volume_chart')) return [[1_700_000_000_000, '13421.89']];
			if (path.startsWith('/exchanges?')) return [{ id: 'binance', trade_volume_24h_btc_normalized: 99_000 }];
			throw upstream(404);
		});
		const { res, body } = await call(await load('../../api/coin/exchange.js'), '/api/coin/exchange?id=binance');
		expect(res.statusCode).toBe(200);
		expect(body.detail.type).toBe('spot');
		expect(body.detail.trade_volume_24h_btc_normalized).toBe(99_000);
		expect(body.detail.description).toBe('An exchange.');
		// A contract-address base symbol is truncated, not dumped into the pair cell.
		expect(body.detail.tickers[0].pair).toBe('0x1234…5678/USDT');
		expect(body.volume_chart).toEqual([[1_700_000_000_000, 13_421.89]]);
	});

	it('falls back to the derivatives namespace when the spot lookup 404s', async () => {
		fetchCoinPriceUsdOrNull.mockResolvedValue(60_000);
		geckoFetch.mockImplementation(async (path) => {
			if (path.startsWith('/derivatives/exchanges/')) {
				return { name: 'Deriv Venue', open_interest_btc: '4200', number_of_perpetual_pairs: 120, tickers: [] };
			}
			throw upstream(404);
		});
		const { res, body } = await call(await load('../../api/coin/exchange.js'), '/api/coin/exchange?id=deriv-venue');
		expect(res.statusCode).toBe(200);
		expect(body.detail.type).toBe('derivatives');
		expect(body.detail.open_interest_btc).toBe(4200);
		expect(body.volume_chart).toBeNull();
	});

	it('404s when neither namespace knows the id', async () => {
		fetchCoinPriceUsdOrNull.mockResolvedValue(null);
		geckoFetch.mockRejectedValue(upstream(404));
		const { res, body } = await call(await load('../../api/coin/exchange.js'), '/api/coin/exchange?id=ghost-venue');
		expect(res.statusCode).toBe(404);
		expect(body.error).toBe('not_found');
	});
});

describe('/api/coin/fear-greed', () => {
	const fngRows = (n) =>
		Array.from({ length: n }, (_, i) => ({
			value: String(30 + i),
			value_classification: 'Fear',
			timestamp: String(1_700_000_000 + i * 86_400),
		}));

	it('reports a week-over-week comparison point once a week of history exists', async () => {
		globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ data: fngRows(30) }) }));
		const { res, body } = await call(await load('../../api/coin/fear-greed.js'), '/api/coin/fear-greed?limit=30');
		expect(res.statusCode).toBe(200);
		expect(body.history).toHaveLength(30);
		// History is returned oldest-first even though alternative.me sends newest-first.
		expect(body.history[0].ts).toBeLessThan(body.history[29].ts);
		expect(body.current.value).toBe(59);
		// Exactly 7 days back, not "the oldest point we happen to have".
		expect(body.previous_week.ts).toBe(body.current.ts - 7 * 86_400_000);
	});

	it('reports no previous week rather than comparing the latest reading to itself', async () => {
		globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ data: fngRows(1) }) }));
		const { res, body } = await call(await load('../../api/coin/fear-greed.js'), '/api/coin/fear-greed?limit=1');
		expect(res.statusCode).toBe(200);
		expect(body.previous_week).toBeNull();
	});

	it('502s when alternative.me is unavailable', async () => {
		globalThis.fetch = vi.fn(async () => ({ ok: false, status: 503 }));
		const { res, body } = await call(await load('../../api/coin/fear-greed.js'), '/api/coin/fear-greed');
		expect(res.statusCode).toBe(502);
		expect(body.error).toBe('upstream_error');
	});
});

describe('/api/coin/gas', () => {
	const feeHistory = {
		baseFeePerGas: ['0x3b9aca00', '0x77359400'], // 1 gwei, then 2 gwei pending
		reward: [
			['0x3b9aca00', '0x77359400', '0xb2d05e00'], // 1 / 2 / 3 gwei
			['0x3b9aca00', '0x77359400', '0xb2d05e00'],
		],
	};

	it('derives slow/standard/fast from eth_feeHistory and prices each action', async () => {
		globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ result: feeHistory }) }));
		fetchCoinPriceUsd.mockResolvedValue(2000);
		const { res, body } = await call(await load('../../api/coin/gas.js'), '/api/coin/gas');
		expect(res.statusCode).toBe(200);
		expect(body.base_fee_gwei).toBe(2);
		expect(body.tiers.map((t) => t.key)).toEqual(['slow', 'standard', 'fast']);
		expect(body.tiers.map((t) => t.gas_price_gwei)).toEqual([3, 4, 5]);
		const transfer = body.tiers[0].actions.find((a) => a.key === 'transfer');
		expect(transfer.usd).toBeCloseTo(3 * 1e-9 * 21_000 * 2000, 12);
	});

	it('serves the oracle without USD costs when the price feed is down', async () => {
		globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ result: feeHistory }) }));
		fetchCoinPriceUsd.mockRejectedValue(new Error('price sources down'));
		const { res, body } = await call(await load('../../api/coin/gas.js'), '/api/coin/gas');
		expect(res.statusCode).toBe(200);
		expect(body.eth_price_usd).toBeNull();
		expect(body.tiers[0].actions.every((a) => a.usd === null)).toBe(true);
	});

	it('502s when every RPC in the failover chain fails', async () => {
		globalThis.fetch = vi.fn(async () => ({ ok: false, status: 502 }));
		fetchCoinPriceUsd.mockResolvedValue(2000);
		const { res, body } = await call(await load('../../api/coin/gas.js'), '/api/coin/gas');
		expect(res.statusCode).toBe(502);
		expect(body.error).toBe('upstream_error');
	});
});
