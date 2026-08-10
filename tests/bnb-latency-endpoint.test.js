/**
 * GET /api/bnb/latency integration tests.
 *
 * `probeAllLanes` (api/_lib/bnb/latency-lanes.js) and `api/_lib/rate-limit.js`
 * are mocked so the suite runs deterministically without four live RPCs. The
 * measurement math itself is covered in tests/bnb-latency-helpers.test.js;
 * this file exercises the HTTP boundary only: the honest per-lane failure
 * shape, the TTL cache behind the polling /bnb-latency page, rate limiting,
 * and method/CORS handling.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const rl = { ok: true };
vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: { publicIp: vi.fn(async () => ({ success: rl.ok, reset: Date.now() + 60_000, reason: rl.ok ? undefined : 'quota' })) },
	clientIp: () => '127.0.0.1',
}));

const laneState = { calls: 0, bnbDown: false };
vi.mock('../api/_lib/bnb/latency-lanes.js', async () => {
	const actual = await vi.importActual('../api/_lib/bnb/latency-lanes.js');
	return {
		...actual,
		probeAllLanes: vi.fn(async () => {
			laneState.calls += 1;
			return [
				laneState.bnbDown
					? { id: 'bnb', name: 'BNB Chain', chainId: 56, ok: false, error: 'every RPC refused' }
					: { id: 'bnb', name: 'BNB Chain', chainId: 56, ok: true, avgBlockTimeMs: 450, latestBlock: 115_000_000, sampleBlocks: 60, target: 450, measuredAt: new Date().toISOString() },
				{ id: 'base', name: 'Base', chainId: 8453, ok: true, avgBlockTimeMs: 2000, latestBlock: 49_000_000, sampleBlocks: 30, target: 2000, measuredAt: new Date().toISOString() },
			];
		}),
	};
});

const { default: handler } = await import('../api/bnb/latency.js');

function makeRes() {
	const r = { statusCode: 200, _h: {}, _b: null };
	r.setHeader = (k, v) => { r._h[k] = v; };
	r.getHeader = (k) => r._h[k];
	r.end = (b) => { r._b = b; };
	Object.defineProperty(r, '_s', { get() { return this.statusCode; } });
	Object.defineProperty(r, 'json', { value: () => JSON.parse(r._b) });
	return r;
}
async function call({ method = 'GET' } = {}) {
	const req = {
		method,
		url: '/api/bnb/latency',
		headers: { origin: 'https://three.ws', host: 'three.ws' },
		socket: { remoteAddress: '127.0.0.1' },
	};
	const res = makeRes();
	await handler(req, res);
	return res;
}

// The handler caches the whole lane set in module state for 4s. Advance the
// clock a minute between tests so each starts from a cold cache and the cache
// assertion below counts only its own probes.
let tick = 0;
beforeEach(() => {
	vi.useFakeTimers({ shouldAdvanceTime: true });
	vi.setSystemTime(new Date(Date.UTC(2026, 0, 1) + ++tick * 60_000));
	rl.ok = true;
	laneState.calls = 0;
	laneState.bnbDown = false;
});
afterEach(() => {
	vi.useRealTimers();
	vi.clearAllMocks();
});

describe('GET /api/bnb/latency measured lanes', () => {
	it('200 with every lane measured and a request-level timestamp', async () => {
		const r = await call();
		expect(r._s).toBe(200);
		const body = r.json();
		expect(Array.isArray(body.lanes)).toBe(true);
		expect(body.lanes.map((l) => l.id)).toEqual(['bnb', 'base']);
		expect(body.lanes.every((l) => l.ok)).toBe(true);
		expect(typeof body.measuredAt).toBe('string');
	});

	it('one dead chain never fails the request, and never gets a fabricated number', async () => {
		laneState.bnbDown = true;
		const r = await call();
		expect(r._s).toBe(200);
		const bnb = r.json().lanes.find((l) => l.id === 'bnb');
		expect(bnb.ok).toBe(false);
		expect(bnb.avgBlockTimeMs).toBeUndefined();
		expect(r.json().lanes.find((l) => l.id === 'base').ok).toBe(true);
	});

	it('serves the cached lane set inside the TTL rather than re-probing per poll', async () => {
		await call();
		expect(laneState.calls).toBe(1);
		await call();
		expect(laneState.calls).toBe(1);
	});
});

describe('GET /api/bnb/latency boundary handling', () => {
	it('429 carries retry-after so the polling page can back off', async () => {
		rl.ok = false;
		const r = await call();
		expect(r._s).toBe(429);
		expect(r.json().error).toBe('rate_limited');
		expect(Number(r.getHeader('retry-after'))).toBeGreaterThan(0);
		expect(laneState.calls).toBe(0);
	});

	it('405 on a non-GET method', async () => {
		const r = await call({ method: 'POST' });
		expect(r._s).toBe(405);
	});

	it('204 on the CORS preflight', async () => {
		const r = await call({ method: 'OPTIONS' });
		expect(r._s).toBe(204);
		expect(r.getHeader('access-control-allow-methods')).toContain('GET');
	});
});
