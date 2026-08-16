// Tests for /api/home-stats, the live "trusted by" numbers on the home page.
//
// The contract that matters here is honesty: the strip renders real Neon counts
// or it renders nothing. A database outage must never degrade into fabricated
// or zeroed numbers, so the failure path answers { available: false } and the
// home page hides the strip. Network-free: the database and rate limiter are
// mocked; what is under test is the payload shape, the caching contract and
// that failure path.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer } from 'node:http';

// One count per query, in the order the handler fires them: agents, on-chain
// agents, widgets, chains, attestations, forge models.
const COUNTS = [3167, 148470, 613, 18, 3000, 14553];

let queryCount = 0;
let dbError = null;

vi.mock('../../api/_lib/db.js', () => ({
	sql: vi.fn(async () => {
		if (dbError) throw dbError;
		const n = COUNTS[queryCount] ?? 0;
		queryCount += 1;
		return [{ n }];
	}),
}));

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: { publicIp: vi.fn(async () => ({ success: true, limit: 60, remaining: 59, reset: 0 })) },
	clientIp: () => '127.0.0.1',
}));

let server;
let base;

beforeAll(async () => {
	const { default: handler } = await import('../../api/home-stats.js');
	server = createServer((req, res) => handler(req, res));
	await new Promise((r) => server.listen(0, '127.0.0.1', r));
	base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => server?.close());

beforeEach(() => {
	queryCount = 0;
	dbError = null;
});

describe('/api/home-stats', () => {
	it('serves every real count the home strip renders, edge-cached', async () => {
		const r = await fetch(`${base}/api/home-stats`);
		expect(r.status).toBe(200);
		expect(r.headers.get('cache-control')).toContain('s-maxage=60');
		expect(r.headers.get('cache-control')).toContain('stale-while-revalidate=300');

		const body = await r.json();
		expect(body).toMatchObject({
			available: true,
			agents: 3167,
			onchain_agents: 148470,
			widgets: 613,
			chains: 18,
			attestations: 3000,
			forge_models: 14553,
		});
		// Each metric is its own count, so a dropped or reordered query shows up
		// as a wrong number rather than silently.
		expect(queryCount).toBe(6);
		expect(Number.isNaN(Date.parse(body.updated_at))).toBe(false);
	});

	it('reports unavailable rather than fabricating numbers when the database is down', async () => {
		dbError = new Error('connection terminated unexpectedly');
		const r = await fetch(`${base}/api/home-stats`);
		// 200 with an explicit flag: the home page hides the strip on this, and a
		// marketing metric is never worth flapping the page into an error state.
		expect(r.status).toBe(200);
		expect(await r.json()).toEqual({ available: false, reason: 'db_unavailable' });
		// The shortened cache window lets a recovered database show up quickly.
		expect(r.headers.get('cache-control')).toContain('s-maxage=15');
	});

	it('is read-only: anything but GET is 405', async () => {
		const r = await fetch(`${base}/api/home-stats`, { method: 'POST' });
		expect(r.status).toBe(405);
	});
});
