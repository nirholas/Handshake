// Unit tests for GET /api/play/solver, the solved economy of the /play worlds.
//
// The model itself is proven in tests/rate-model.test.js (including a seeded
// simulation of the real handlers). These tests cover the HTTP contract on top of
// it: query handling, the cache posture that makes a public reference cheap, and
// the guarantee that the served body is the model's own output rather than a
// reshaped copy that could drift from it.
//
// game-token.js is mocked because spin-wheel.js pulls it in transitively for the
// paid-spin path this endpoint never touches, and it constructs Solana clients and
// reads wallet env at import time.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../multiplayer/src/game-token.js', () => ({
	buildSpinPayment: vi.fn(),
	verifySpinPayment: vi.fn(),
	isWalletAddress: () => true,
	tokenConfigured: vi.fn(() => true),
	TOKEN_DECIMALS: 6,
	TOKEN_SYMBOL: '$THREE',
}));

const rlState = { success: true, limit: 60, remaining: 59, reset: 0 };
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: { publicIp: vi.fn(async () => rlState) },
	clientIp: vi.fn(() => '127.0.0.1'),
}));

const handler = (await import('../../api/play/solver.js')).default;
const { solveAt, allCurves, ASSUMPTIONS } = await import('../../multiplayer/src/rate-model.js');
const { LEVEL_CAP } = await import('../../multiplayer/src/economy.js');
const { TREES, ROCKS, FISHING_SPOTS } = await import('../../multiplayer/src/world-features.js');

function mockRes() {
	const chunks = [];
	return {
		statusCode: 0,
		headers: {},
		setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
		getHeader(k) { return this.headers[String(k).toLowerCase()]; },
		writeHead(status, headers) {
			this.statusCode = status;
			for (const [k, v] of Object.entries(headers || {})) this.setHeader(k, v);
			return this;
		},
		end(body) { if (body) chunks.push(body); return this; },
		get body() { return chunks.join(''); },
		get parsed() { return JSON.parse(chunks.join('')); },
	};
}

const mockReq = (url = '/api/play/solver', method = 'GET') => ({
	method,
	url,
	headers: { host: 'three.ws' },
	socket: { remoteAddress: '127.0.0.1' },
});

async function get(url) {
	const res = mockRes();
	await handler(mockReq(url), res);
	return res;
}

beforeEach(() => {
	rlState.success = true;
});

describe('GET /api/play/solver: contract', () => {
	it('serves the model at level 1 by default', async () => {
		const res = await get('/api/play/solver');
		expect(res.statusCode).toBe(200);
		expect(res.parsed.level).toBe(1);
		expect(res.parsed.requestedLevel).toBeNull();
		expect(res.parsed.levelClamped).toBe(false);
	});

	it('serves exactly what the model computes, not a reshaped copy', async () => {
		const res = await get('/api/play/solver?level=37&curves=0');
		const model = solveAt(37);
		// Every key the model produces has to survive to the wire unchanged, or the
		// endpoint has quietly become a second source of truth.
		for (const key of Object.keys(model)) {
			expect(res.parsed[key]).toEqual(model[key]);
		}
	});

	it('clamps an out-of-range level rather than rejecting it, and says so', async () => {
		const high = await get('/api/play/solver?level=5000');
		expect(high.statusCode).toBe(200);
		expect(high.parsed.level).toBe(LEVEL_CAP);
		expect(high.parsed.levelClamped).toBe(true);
		expect(high.parsed.requestedLevel).toBe('5000');

		const low = await get('/api/play/solver?level=0');
		expect(low.parsed.level).toBe(1);
		expect(low.parsed.levelClamped).toBe(true);

		const negative = await get('/api/play/solver?level=-12');
		expect(negative.parsed.level).toBe(1);
		expect(negative.parsed.levelClamped).toBe(true);
	});

	it('falls back to level 1 on a level that is not a number', async () => {
		const res = await get('/api/play/solver?level=banana');
		expect(res.statusCode).toBe(200);
		expect(res.parsed.level).toBe(1);
	});

	it('does not flag an in-range level as clamped', async () => {
		const res = await get('/api/play/solver?level=42');
		expect(res.parsed.level).toBe(42);
		expect(res.parsed.levelClamped).toBe(false);
	});

	it('includes the full level sweep by default and drops it on curves=0', async () => {
		const withCurves = await get('/api/play/solver?level=5');
		expect(Array.isArray(withCurves.parsed.curves)).toBe(true);
		expect(withCurves.parsed.curves).toHaveLength(allCurves().length);
		for (const c of withCurves.parsed.curves) {
			expect(c.cash).toHaveLength(LEVEL_CAP);
			expect(c.xp).toHaveLength(LEVEL_CAP);
		}

		const without = await get('/api/play/solver?level=5&curves=0');
		expect(without.parsed.curves).toBeUndefined();
	});

	it('rates every node the world defines', async () => {
		const res = await get('/api/play/solver?curves=0');
		const keys = res.parsed.activities.map((a) => a.key);
		for (const t of TREES) expect(keys).toContain(`chop:${t.id}`);
		for (const r of ROCKS) expect(keys).toContain(`mine:${r.id}`);
		for (const s of FISHING_SPOTS) expect(keys).toContain(`fish:${s.id}`);
	});

	it('publishes its assumptions and its method alongside the numbers', async () => {
		const res = await get('/api/play/solver?curves=0');
		expect(res.parsed.assumptions).toEqual(ASSUMPTIONS);
		expect(res.parsed.method.summary).toMatch(/closed-form/i);
		expect(res.parsed.method.source.length).toBeGreaterThanOrEqual(5);
		// The source list has to name real modules, since it is the audit trail for
		// the drift-free claim.
		for (const line of res.parsed.method.source) {
			expect(line).toMatch(/^multiplayer\/src\/[a-z-]+\.js:/);
		}
	});

	it('never recommends a rate the ladder marks unsustainable', async () => {
		for (const level of [1, 50, 99]) {
			const res = await get(`/api/play/solver?level=${level}&curves=0`);
			const cook = res.parsed.activities.find((a) => a.family === 'cook');
			expect(cook.sustainable).toBe(false);
			expect(res.parsed.bestRate.cashPerHour).toBeLessThan(cook.cashPerHour);
		}
	});

	it('moves every headline number when the level moves', async () => {
		const low = (await get('/api/play/solver?level=1&curves=0')).parsed;
		const high = (await get('/api/play/solver?level=90&curves=0')).parsed;
		expect(high.bestRate.cashPerHour).toBeGreaterThan(low.bestRate.cashPerHour);
		expect(high.bestXpRate.xpPerHour).toBeGreaterThan(low.bestXpRate.xpPerHour);
		expect(high.payback[0].minutes).toBeLessThan(low.payback[0].minutes);
	});
});

describe('GET /api/play/solver: caching and transport', () => {
	it('caches hard at the edge, because the body is pure static config', async () => {
		const res = await get('/api/play/solver');
		const cc = res.getHeader('cache-control');
		expect(cc).toMatch(/public/);
		expect(cc).toMatch(/s-maxage=\d+/);
		expect(cc).toMatch(/stale-while-revalidate=\d+/);
	});

	it('answers a CORS preflight and allows cross-origin reads', async () => {
		const res = mockRes();
		await handler(mockReq('/api/play/solver', 'OPTIONS'), res);
		expect(res.getHeader('access-control-allow-origin')).toBe('*');
	});

	it('rejects a write method', async () => {
		const res = mockRes();
		await handler(mockReq('/api/play/solver', 'POST'), res);
		expect(res.statusCode).toBe(405);
	});

	it('rate limits like any other public endpoint', async () => {
		rlState.success = false;
		const res = await get('/api/play/solver');
		expect(res.statusCode).toBe(429);
	});

	it('serves identical curves across requests, so the cache key stays stable', async () => {
		const a = await get('/api/play/solver?level=1');
		const b = await get('/api/play/solver?level=1');
		expect(a.body).toBe(b.body);
	});
});
