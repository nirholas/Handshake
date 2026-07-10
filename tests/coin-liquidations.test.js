// Coverage for api/coin/liquidations.js — the proxy in front of the
// standalone services/liquidation-collector. Tests the endpoint's
// composition/branching only (env gating, timeout, upstream failure, success
// pass-through), not the real collector or exchange streams beneath it.
//
// Hard requirement under test: NEVER fabricate liquidation data. Every
// non-2xx path must return 503 { error: 'collector_offline' } — no synthetic
// numbers, ever.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../api/_lib/http.js', () => ({
	wrap: (fn) => fn,
	cors: () => false,
	method: () => true,
	rateLimited: (res) => {
		res._json = { status: 429, body: { error: 'rate_limited' } };
		return res;
	},
	json: (res, status, body, headers = {}) => {
		res._json = { status, body, headers };
		return res;
	},
}));
vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: { marketDataIp: vi.fn(async () => ({ success: true })) },
	clientIp: () => '1.2.3.4',
}));

const { default: handler } = await import('../api/coin/liquidations.js');
const { limits } = await import('../api/_lib/rate-limit.js');

function fakeRes() {
	return { setHeader() {}, end() {}, statusCode: 200 };
}
function call(url = '/api/coin/liquidations') {
	const res = fakeRes();
	return handler({ method: 'GET', url, headers: {} }, res).then(() => res);
}

const ORIGINAL_ENV = process.env.LIQUIDATION_COLLECTOR_URL;
const originalFetch = global.fetch;

beforeEach(() => {
	limits.marketDataIp.mockResolvedValue({ success: true });
	global.fetch = vi.fn();
});

afterEach(() => {
	if (ORIGINAL_ENV === undefined) delete process.env.LIQUIDATION_COLLECTOR_URL;
	else process.env.LIQUIDATION_COLLECTOR_URL = ORIGINAL_ENV;
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

describe('GET /api/coin/liquidations', () => {
	it('503s with collector_offline when LIQUIDATION_COLLECTOR_URL is unset — no fetch attempted', async () => {
		delete process.env.LIQUIDATION_COLLECTOR_URL;
		const res = await call();
		expect(res._json.status).toBe(503);
		expect(res._json.body.error).toBe('collector_offline');
		expect(global.fetch).not.toHaveBeenCalled();
	});

	it('proxies a real collector snapshot through unchanged on success', async () => {
		process.env.LIQUIDATION_COLLECTOR_URL = 'http://localhost:3033';
		const snapshot = {
			liquidations: [
				{ exchange: 'Binance', price: 61234.5, qty: 0.42, severity: 'LARGE', side: 'LONG', symbol: 'BTC', time: 1735689600000, value: 257184.89 },
			],
			summary: {
				dominantSide: 'LONG PAIN', largeCount: 1, longCount: 1, longValue: 257184.89,
				megaCount: 0, shortCount: 0, shortValue: 0, totalCount: 1, totalValue: 257184.89,
			},
			symbolStats: [{ count: 1, longValue: 257184.89, shortValue: 0, symbol: 'BTC' }],
			timestamp: '2026-07-08T12:00:00.000Z',
		};
		global.fetch.mockResolvedValue({
			ok: true,
			json: async () => snapshot,
		});
		const res = await call();
		expect(global.fetch).toHaveBeenCalledWith(
			'http://localhost:3033/liquidations',
			expect.objectContaining({ headers: { accept: 'application/json' } }),
		);
		expect(res._json.status).toBe(200);
		expect(res._json.body).toEqual(snapshot);
		expect(res._json.headers['cache-control']).toContain('s-maxage=15');
		expect(res._json.headers['cache-control']).toContain('stale-while-revalidate=60');
	});

	it('503s with collector_offline when the upstream fetch times out', async () => {
		process.env.LIQUIDATION_COLLECTOR_URL = 'http://localhost:3033';
		global.fetch.mockRejectedValue(Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' }));
		const res = await call();
		expect(res._json.status).toBe(503);
		expect(res._json.body.error).toBe('collector_offline');
	});

	it('503s with collector_offline when the collector responds non-2xx', async () => {
		process.env.LIQUIDATION_COLLECTOR_URL = 'http://localhost:3033';
		global.fetch.mockResolvedValue({ ok: false, status: 502 });
		const res = await call();
		expect(res._json.status).toBe(503);
		expect(res._json.body.error).toBe('collector_offline');
	});

	it('503s when the collector is down (connection refused)', async () => {
		process.env.LIQUIDATION_COLLECTOR_URL = 'http://localhost:3033';
		global.fetch.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:3033'));
		const res = await call();
		expect(res._json.status).toBe(503);
		expect(res._json.body.error).toBe('collector_offline');
	});

	it('429s when rate limited, before touching the collector', async () => {
		limits.marketDataIp.mockResolvedValue({ success: false });
		process.env.LIQUIDATION_COLLECTOR_URL = 'http://localhost:3033';
		const res = await call();
		expect(res._json.status).toBe(429);
		expect(global.fetch).not.toHaveBeenCalled();
	});
});
