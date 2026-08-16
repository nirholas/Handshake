// Query-parameter boundary tests for api/three/[action].js.
//
//   GET /api/three/stats?since_days=...  (the aggregate window)
//   GET /api/three/earnings?before=...   (the earnings page cursor)
//
// Both params are interpolated into SQL as a Postgres cast (`::interval` and
// `::timestamptz`). Before these guards, a caller could send `since_days=abc` or
// `before=garbage` and get a 5xx back: the cast failed deep in the query instead
// of the value being rejected at the boundary. These tests pin the contract that
// a bad value is a typed 400 and a good one still reaches the ledger.
//
// The ledger reads and the session are mocked so the endpoint runs without a DB;
// the aggregate SQL itself is exercised by the token-payments tests.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { Readable } from 'node:stream';

const getSessionUser = vi.fn();
const economyStats = vi.fn();
const creatorEarnings = vi.fn();
const listRewardsDistributions = vi.fn();
const getBalances = vi.fn();

vi.mock('../../api/_lib/auth.js', async (orig) => ({
	...(await orig()),
	getSessionUser: (...a) => getSessionUser(...a),
}));
vi.mock('../../api/_lib/token/index.js', async (orig) => ({
	...(await orig()),
	economyStats: (...a) => economyStats(...a),
	creatorEarnings: (...a) => creatorEarnings(...a),
	listRewardsDistributions: (...a) => listRewardsDistributions(...a),
}));
vi.mock('../../api/_lib/balances.js', async (orig) => ({
	...(await orig()),
	getBalances: (...a) => getBalances(...a),
}));

let handler;

const WALLET = 'So11111111111111111111111111111111111111112';

function mockRes() {
	return {
		statusCode: 200,
		_headers: {},
		_body: '',
		_ended: false,
		setHeader(k, v) { this._headers[k.toLowerCase()] = v; },
		getHeader(k) { return this._headers[k.toLowerCase()]; },
		end(b) { this._body = b || ''; this._ended = true; },
		get json() { try { return JSON.parse(this._body); } catch { return null; } },
	};
}

function mockReq({ method = 'GET', url = '/' } = {}) {
	const r = Readable.from([]);
	r.method = method;
	r.url = url;
	r.headers = { origin: 'http://localhost:3000' };
	return r;
}

const get = async (url) => {
	const res = mockRes();
	await handler(mockReq({ url }), res);
	return res;
};

beforeAll(async () => {
	process.env.NODE_ENV = 'development';
	handler = (await import('../../api/three/[action].js')).default;
});

beforeEach(() => {
	vi.clearAllMocks();
	getSessionUser.mockResolvedValue(null);
	getBalances.mockResolvedValue({ tokens: [] });
	economyStats.mockResolvedValue({
		since: null,
		payment_count: 0,
		gross_atomics: '0',
		by_role: {},
		by_purpose: [],
		mint: null,
		decimals: null,
	});
	listRewardsDistributions.mockResolvedValue({
		total_reflected_atomics: '0',
		run_count: 0,
		items: [],
	});
	creatorEarnings.mockResolvedValue({
		total_atomics: '0',
		sale_count: 0,
		mint: null,
		decimals: null,
		items: [],
		next_cursor: null,
	});
});

describe('GET /api/three/stats?since_days=', () => {
	it('rejects a value that is not a finite number with a typed 400', async () => {
		for (const bad of ['notanumber', 'Infinity', '1e400', 'NaN']) {
			const res = await get(`/api/three/stats?since_days=${encodeURIComponent(bad)}`);
			expect(res.statusCode, bad).toBe(400);
			expect(res.json.error, bad).toBe('invalid_since_days');
		}
		// A rejected window must never reach the ledger query.
		expect(economyStats).not.toHaveBeenCalled();
	});

	it('passes a real window through to the ledger', async () => {
		const res = await get('/api/three/stats?since_days=7');
		expect(res.statusCode).toBe(200);
		expect(economyStats).toHaveBeenCalledWith({ sinceDays: 7 });
	});

	it('treats an omitted or empty value as no window', async () => {
		await get('/api/three/stats');
		expect(economyStats).toHaveBeenLastCalledWith({ sinceDays: null });
		await get('/api/three/stats?since_days=');
		expect(economyStats).toHaveBeenLastCalledWith({ sinceDays: null });
	});

	it('clamps an out-of-range window instead of overflowing the interval', async () => {
		await get('/api/three/stats?since_days=999999999999');
		expect(economyStats).toHaveBeenLastCalledWith({ sinceDays: 3650 });
		await get('/api/three/stats?since_days=-5');
		expect(economyStats).toHaveBeenLastCalledWith({ sinceDays: 1 });
		// Fractional days floor to whole days rather than failing the cast.
		await get('/api/three/stats?since_days=3.7');
		expect(economyStats).toHaveBeenLastCalledWith({ sinceDays: 3 });
	});
});

describe('GET /api/three/earnings?before=', () => {
	beforeEach(() => {
		getSessionUser.mockResolvedValue({ id: 'user-1', wallet_address: WALLET });
	});

	it('rejects a cursor that is not a timestamp with a typed 400', async () => {
		const res = await get('/api/three/earnings?before=garbage');
		expect(res.statusCode).toBe(400);
		expect(res.json.error).toBe('invalid_cursor');
		expect(creatorEarnings).not.toHaveBeenCalled();
	});

	it('passes a real cursor through to the ledger', async () => {
		const cursor = '2026-01-01T00:00:00.000Z';
		const res = await get(`/api/three/earnings?before=${encodeURIComponent(cursor)}`);
		expect(res.statusCode).toBe(200);
		expect(creatorEarnings).toHaveBeenCalledWith({
			sellerWallet: WALLET,
			limit: 50,
			before: cursor,
		});
	});

	it('treats an empty cursor as the first page and clamps the limit', async () => {
		await get('/api/three/earnings?before=&limit=99999');
		expect(creatorEarnings).toHaveBeenLastCalledWith({
			sellerWallet: WALLET,
			limit: 200,
			before: null,
		});
	});

	it('returns an empty ledger without a query when the account has no wallet', async () => {
		getSessionUser.mockResolvedValue({ id: 'user-2', wallet_address: null });
		const res = await get('/api/three/earnings');
		expect(res.statusCode).toBe(200);
		expect(res.json.items).toEqual([]);
		expect(creatorEarnings).not.toHaveBeenCalled();
	});
});
