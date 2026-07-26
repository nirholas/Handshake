/**
 * Resilience of GET /api/pump/trending — the feed behind the home card,
 * communities, constellation, and the 3D visualizer.
 *
 * Pins three load/outage behaviours so they can't regress:
 *   1. Birdeye down → transparent pump.fun fallback (same shape).
 *   2. A Birdeye failure trips a cooldown breaker, so the next cache-miss skips
 *      Birdeye instead of re-paying its timeout during an outage.
 *   3. When BOTH live sources are down, a recent-enough cached feed is served as
 *      `stale: true` rather than dead-ending on a 502.
 *
 * fetch + the rate limiter are stubbed; module state is reset per test via
 * resetModules so the process-local cache/breaker start clean.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

beforeAll(() => {
	process.env.BIRDEYE_API_KEY = 'test-birdeye-key';
});

vi.mock('../../api/_lib/rate-limit.js', async (importActual) => {
	const actual = await importActual();
	return {
		...actual,
		limits: {
			...actual.limits,
			publicIp: vi.fn(async () => ({ success: true, reset: Date.now() + 1000 })),
			// The handler moved to the dedicated lobby bucket (435652d20); stub it
			// too or the real limiter 429s the second request in a test.
			marketFeedIp: vi.fn(async () => ({ success: true, reset: Date.now() + 1000 })),
		},
		clientIp: () => '203.0.113.9',
	};
});

function birdeyeBody() {
	return JSON.stringify({
		data: { tokens: [{ address: 'A'.repeat(40), symbol: 'BIRD', name: 'Bird', price: 1.5, rank: 1 }] },
	});
}
function pumpBody() {
	return JSON.stringify([{ mint: 'B'.repeat(40), symbol: 'PUMP', name: 'Pump', image_uri: '' }]);
}

function mockFetch({ birdeyeOk = true, pumpOk = true } = {}) {
	global.fetch = vi.fn(async (url) => {
		const u = String(url);
		if (u.includes('birdeye.so')) {
			return birdeyeOk ? new Response(birdeyeBody(), { status: 200 }) : new Response('x', { status: 500 });
		}
		if (u.includes('pump.fun')) {
			return pumpOk ? new Response(pumpBody(), { status: 200 }) : new Response('x', { status: 500 });
		}
		throw new Error(`unrouted fetch: ${u}`);
	});
}

function makeReq(url) {
	return { method: 'GET', url, headers: {}, on() {} };
}
function makeRes() {
	return {
		statusCode: 200,
		headers: {},
		body: null,
		setHeader(n, v) {
			this.headers[String(n).toLowerCase()] = v;
		},
		getHeader(n) {
			return this.headers[String(n).toLowerCase()];
		},
		end(b) {
			this.body = b ? JSON.parse(b) : null;
		},
	};
}

async function freshHandler() {
	vi.resetModules();
	return (await import('../../api/pump/trending.js')).default;
}

let savedFetch;
beforeEach(() => {
	savedFetch = global.fetch;
});
afterEach(() => {
	global.fetch = savedFetch;
	vi.useRealTimers();
});

describe('pump/trending resilience', () => {
	it('falls back to pump.fun when Birdeye fails', async () => {
		const handler = await freshHandler();
		mockFetch({ birdeyeOk: false, pumpOk: true });
		const res = makeRes();
		await handler(makeReq('/api/pump/trending?limit=5'), res);

		expect(res.statusCode).toBe(200);
		expect(Array.isArray(res.body.data)).toBe(true);
		expect(res.body.data[0].symbol).toBe('PUMP');
	});

	it('trips the Birdeye breaker so the next cache-miss skips it', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-06-21T00:00:00Z'));
		const handler = await freshHandler();
		mockFetch({ birdeyeOk: false, pumpOk: true });
		// First call: Birdeye fails (trips breaker), pump serves it, caches the batch.
		await handler(makeReq('/api/pump/trending?limit=5'), makeRes());
		global.fetch.mockClear();
		// getTrendingSlim caches one canonical batch that serves EVERY limit, so a
		// bigger limit no longer misses. Force a real miss by moving past the 30s
		// fresh TTL while staying inside the 60s Birdeye cooldown: the refetch must
		// skip Birdeye and go straight to pump.fun.
		vi.setSystemTime(new Date('2026-06-21T00:00:45Z')); // +45s
		await handler(makeReq('/api/pump/trending?limit=40'), makeRes());

		const urls = global.fetch.mock.calls.map((c) => String(c[0]));
		expect(urls.some((u) => u.includes('birdeye.so'))).toBe(false);
		expect(urls.some((u) => u.includes('pump.fun'))).toBe(true);
	});

	it('serves the last good feed as stale when BOTH sources are down', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-06-21T00:00:00Z'));
		const handler = await freshHandler();

		// Prime the cache with a good pump.fun feed at limit=25.
		mockFetch({ birdeyeOk: false, pumpOk: true });
		const primed = makeRes();
		await handler(makeReq('/api/pump/trending?limit=25'), primed);
		expect(primed.body.data[0].symbol).toBe('PUMP');

		// Advance past the 30s fresh TTL but within the 10-min stale window, and take
		// BOTH live sources down.
		vi.setSystemTime(new Date('2026-06-21T00:01:00Z')); // +60s
		mockFetch({ birdeyeOk: false, pumpOk: false });
		const res = makeRes();
		await handler(makeReq('/api/pump/trending?limit=25'), res);

		expect(res.statusCode).toBe(200);
		expect(res.body.stale).toBe(true);
		expect(res.body.data[0].symbol).toBe('PUMP');
	});

	it('502s only when both are down and there is no usable cache', async () => {
		const handler = await freshHandler();
		mockFetch({ birdeyeOk: false, pumpOk: false });
		const res = makeRes();
		await handler(makeReq('/api/pump/trending?limit=25'), res);

		expect(res.statusCode).toBe(502);
		expect(res.body.error).toBe('upstream_error');
	});
});
