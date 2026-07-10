import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Test the endpoint's COMPOSITION + branching (param validation, filters,
// mapping, empty vs upstream-down), not the network beneath it. The curve math
// (mapBondingStatus) is pure and stays REAL — the whole point is that /launches
// and /bonding can never disagree on bondingProgressPct.
vi.mock('../api/_lib/http.js', () => ({
	wrap: (fn) => fn,
	cors: () => false,
	method: () => true,
	rateLimited: (res) => {
		res._json = { status: 429, body: { error: 'rate_limited' } };
		return res;
	},
	error: (res, status, code, message, extra = {}) => {
		res._json = { status, body: { error: code, error_description: message, ...extra } };
		return res;
	},
	json: (res, status, body) => {
		res._json = { status, body };
		return res;
	},
}));
vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: { marketDataIp: vi.fn(async () => ({ success: true })) },
	clientIp: () => '1.2.3.4',
}));
// Keep the real module (pump-bonding.js imports isGraduated from it) and stub
// only the network fetch.
vi.mock('../api/_lib/pump-launch-feed.js', async (importOriginal) => ({
	...(await importOriginal()),
	fetchRecentPumpCoins: vi.fn(),
}));

import handler, { toLaunch } from '../api/crypto/launches.js';
import { fetchRecentPumpCoins } from '../api/_lib/pump-launch-feed.js';
import { limits } from '../api/_lib/rate-limit.js';

const NOW = Date.parse('2026-07-07T12:00:00.000Z');

// Synthetic pump.fun coin objects only — never a real third-party mint.
function coin(n, { ageMin = 5, mcUsd = 5000, reserves = 700_000_000 * 1e6, complete = false } = {}) {
	return {
		mint: `THREEsynthetic${String(n).padStart(30, '1')}`,
		name: `Synthetic ${n}`,
		symbol: `SYN${n}`,
		created_timestamp: NOW - ageMin * 60_000,
		usd_market_cap: mcUsd,
		real_token_reserves: complete ? 0 : reserves,
		real_sol_reserves: complete ? 0 : 12 * 1e9,
		bonding_curve: `THREEsyntheticCurve${String(n).padStart(24, '1')}`,
		creator: `THREEsyntheticDev${String(n).padStart(26, '1')}`,
		image_uri: null,
		complete,
	};
}

function fakeRes() {
	return { setHeader() {}, end() {}, statusCode: 200 };
}
function call(url) {
	const res = fakeRes();
	return handler({ method: 'GET', url, headers: {} }, res).then(() => res);
}

beforeEach(() => {
	fetchRecentPumpCoins.mockReset();
	limits.marketDataIp.mockResolvedValue({ success: true });
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
});
afterEach(() => {
	vi.useRealTimers();
});

describe('toLaunch mapping', () => {
	it('maps a raw coin to the documented launch shape', () => {
		const l = toLaunch(coin(1, { ageMin: 3.5, mcUsd: 6543.21 }), NOW);
		expect(l).toEqual({
			mint: expect.stringMatching(/^THREEsynthetic/),
			name: 'Synthetic 1',
			symbol: 'SYN1',
			createdAt: new Date(NOW - 3.5 * 60_000).toISOString(),
			ageMinutes: 3.5,
			marketCapUsd: 6543.21,
			bondingProgressPct: expect.any(Number),
			graduated: false,
			dev: expect.stringMatching(/^THREEsyntheticDev/),
			url: expect.stringContaining('https://pump.fun/coin/THREEsynthetic'),
			imageUrl: null,
		});
		// 700M of the 793.1M-token float still unsold → ~11.7% bought out.
		expect(l.bondingProgressPct).toBeCloseTo((1 - 700_000_000 / 793_100_000) * 100, 1);
	});

	it('marks a completed coin graduated with progress pinned to 100', () => {
		const l = toLaunch(coin(2, { complete: true }), NOW);
		expect(l.graduated).toBe(true);
		expect(l.bondingProgressPct).toBe(100);
	});

	it('degrades missing timestamps to null age, never NaN', () => {
		const c = coin(3);
		delete c.created_timestamp;
		const l = toLaunch(c, NOW);
		expect(l.createdAt).toBeNull();
		expect(l.ageMinutes).toBeNull();
	});
});

describe('GET /api/crypto/launches', () => {
	it('returns launches newest-first with count/ts/source', async () => {
		fetchRecentPumpCoins.mockResolvedValue({
			kind: 'ok',
			coins: [coin(1, { ageMin: 10 }), coin(2, { ageMin: 1 }), coin(3, { ageMin: 5 })],
		});
		const res = await call('/api/crypto/launches');
		expect(res._json.status).toBe(200);
		const { launches, count, source, ts } = res._json.body;
		expect(count).toBe(3);
		expect(source).toBe('pumpfun');
		expect(typeof ts).toBe('string');
		expect(launches.map((l) => l.ageMinutes)).toEqual([1, 5, 10]);
	});

	it('defaults to 20 and caps limit at 100 instead of erroring', async () => {
		fetchRecentPumpCoins.mockResolvedValue({
			kind: 'ok',
			coins: Array.from({ length: 60 }, (_, i) => coin(i)),
		});
		const def = await call('/api/crypto/launches');
		expect(def._json.body.count).toBe(20);
		const capped = await call('/api/crypto/launches?limit=100');
		expect(capped._json.body.count).toBe(60);
		// Upstream is always asked for the full window so filters can't under-fill.
		expect(fetchRecentPumpCoins).toHaveBeenCalledWith({ limit: 100 });
	});

	it('400s malformed limit / minMarketCap / maxAgeMin before any upstream call', async () => {
		for (const [qs, code] of [
			['limit=abc', 'invalid_limit'],
			['limit=0', 'invalid_limit'],
			['limit=2.5', 'invalid_limit'],
			['minMarketCap=-5', 'invalid_min_market_cap'],
			['minMarketCap=zzz', 'invalid_min_market_cap'],
			['maxAgeMin=0', 'invalid_max_age_min'],
			['maxAgeMin=nope', 'invalid_max_age_min'],
		]) {
			const res = await call(`/api/crypto/launches?${qs}`);
			expect(res._json.status, qs).toBe(400);
			expect(res._json.body.error, qs).toBe(code);
		}
		expect(fetchRecentPumpCoins).not.toHaveBeenCalled();
	});

	it('filters by minMarketCap, dropping coins whose cap is unknown', async () => {
		const unknownCap = coin(9);
		delete unknownCap.usd_market_cap;
		fetchRecentPumpCoins.mockResolvedValue({
			kind: 'ok',
			coins: [coin(1, { mcUsd: 500 }), coin(2, { mcUsd: 9000 }), unknownCap],
		});
		const res = await call('/api/crypto/launches?minMarketCap=1000');
		expect(res._json.body.count).toBe(1);
		expect(res._json.body.launches[0].symbol).toBe('SYN2');
	});

	it('filters by maxAgeMin', async () => {
		fetchRecentPumpCoins.mockResolvedValue({
			kind: 'ok',
			coins: [coin(1, { ageMin: 2 }), coin(2, { ageMin: 30 }), coin(3, { ageMin: 9 })],
		});
		const res = await call('/api/crypto/launches?maxAgeMin=10');
		expect(res._json.body.launches.map((l) => l.symbol)).toEqual(['SYN1', 'SYN3']);
	});

	it('200s an empty filtered sweep with a helpful note, not an error', async () => {
		fetchRecentPumpCoins.mockResolvedValue({ kind: 'ok', coins: [coin(1, { mcUsd: 10 })] });
		const res = await call('/api/crypto/launches?minMarketCap=1000000');
		expect(res._json.status).toBe(200);
		expect(res._json.body).toMatchObject({ launches: [], count: 0, source: 'pumpfun' });
		expect(res._json.body.note).toContain('no launches match');
	});

	it('200s (never 5xx) when the feed is unreachable, with an honest source note', async () => {
		fetchRecentPumpCoins.mockResolvedValue({ kind: 'upstream_down', coins: [] });
		const res = await call('/api/crypto/launches');
		expect(res._json.status).toBe(200);
		expect(res._json.body).toMatchObject({ launches: [], count: 0, source: 'pumpfun:unavailable' });
		expect(res._json.body.note).toContain('retry');
	});

	it('429s when the per-IP limit is exhausted', async () => {
		limits.marketDataIp.mockResolvedValue({ success: false });
		const res = await call('/api/crypto/launches');
		expect(res._json.status).toBe(429);
		expect(fetchRecentPumpCoins).not.toHaveBeenCalled();
	});
});
