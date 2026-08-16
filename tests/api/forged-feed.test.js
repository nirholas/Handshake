// Tests for /api/forged, the public feed behind the /forged gallery: 3D props
// the platform's autonomous agents bought with real on-chain USDC via x402.
//
// The feed is provenance-carrying (payer wallet, price, settlement signature),
// so the shaping is the contract: atomic amounts become USDC, a signature
// becomes an explorer link, a GLB becomes a viewer link, and a row with none of
// those still renders. Network-free: the database, cache and rate limiter are
// mocked; what is under test is validation, shaping and the caching contract.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer } from 'node:http';

const ROWS = [
	{
		id: 141,
		ts: '2026-08-13T05:24:30.894Z',
		prompt: 'a go-kart with roll bar, 3D prop',
		category: 'vehicle',
		tier: 'standard',
		status: 'done',
		glb_url: 'https://models.example/forge/go-kart.glb',
		novelty: '0.09952',
		cluster_id: 2,
		tx_sig: 'SigOne',
		payer: 'X4o2UuVNMxnrgkzVy97kPF5gmS6CLRCVJGB48VastML',
		amount_atomic: '150000',
	},
	// A queued row: no GLB, no settlement yet. Every derived field must be null
	// rather than a broken link.
	{
		id: 142,
		ts: '2026-08-13T06:00:00.000Z',
		prompt: 'a sci-fi cargo pod, 3D prop',
		category: 'container',
		tier: 'draft',
		status: 'queued',
		glb_url: null,
		novelty: null,
		cluster_id: null,
		tx_sig: null,
		payer: null,
		amount_atomic: null,
	},
];

const STATS = [
	{ total: 2, done: 1, queued: 1, spent_atomic: '150000', latest_ts: '2026-08-13T06:00:00.000Z' },
];
const PER_CATEGORY = [{ category: 'vehicle', c: 1 }];

// The handler fires three queries in order (rows, stats, per-category); serve
// them positionally so each response lands where the handler expects it.
let queryCount = 0;
let dbError = null;

vi.mock('../../api/_lib/db.js', () => ({
	sql: vi.fn(async () => {
		if (dbError) throw dbError;
		queryCount += 1;
		if (queryCount === 1) return ROWS;
		if (queryCount === 2) return STATS;
		return PER_CATEGORY;
	}),
	isDbUnavailableError: (err) => err?.code === 'db_down',
}));

// Cache always misses so every case exercises the real query path, and records
// what the handler tried to store.
const cacheWrites = [];
vi.mock('../../api/_lib/cache.js', () => ({
	cacheGet: vi.fn(async () => null),
	cacheSet: vi.fn(async (key, value, ttl) => {
		cacheWrites.push({ key, value, ttl });
	}),
}));

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: { publicIp: vi.fn(async () => ({ success: true, limit: 60, remaining: 59, reset: 0 })) },
	clientIp: () => '127.0.0.1',
}));

let server;
let base;

beforeAll(async () => {
	const { default: handler } = await import('../../api/forged.js');
	server = createServer((req, res) => handler(req, res));
	await new Promise((r) => server.listen(0, '127.0.0.1', r));
	base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => server?.close());

beforeEach(() => {
	queryCount = 0;
	dbError = null;
	cacheWrites.length = 0;
});

describe('/api/forged feed', () => {
	it('shapes a paid prop into its provenance: USDC price, explorer link, viewer link', async () => {
		const r = await fetch(`${base}/api/forged?limit=2`);
		expect(r.status).toBe(200);
		expect(r.headers.get('cache-control')).toContain('max-age=20');

		const body = await r.json();
		const [paid, queued] = body.props;

		expect(paid.price_usdc).toBe(0.15);
		expect(paid.payer_short).toBe('X4o2Uu…stML');
		expect(paid.explorer_url).toContain('SigOne');
		expect(paid.viewer_url).toBe(
			`/app?src=${encodeURIComponent('https://models.example/forge/go-kart.glb')}`,
		);
		expect(paid.novelty).toBe(0.09952);

		// A row with no settlement and no model yields nulls, never a dead link.
		expect(queued.price_usdc).toBeNull();
		expect(queued.payer_short).toBeNull();
		expect(queued.explorer_url).toBeNull();
		expect(queued.viewer_url).toBeNull();

		expect(body.stats).toMatchObject({ total: 2, done: 1, queued: 1, spent_usdc: 0.15 });
		expect(body.stats.categories).toEqual({ vehicle: 1 });
	});

	it('caches the shaped payload under a key scoped to every filter', async () => {
		await fetch(`${base}/api/forged?category=vehicle&status=all&limit=7`);
		expect(cacheWrites).toHaveLength(1);
		expect(cacheWrites[0].key).toBe('forged:feed:vehicle:all:7');
		expect(cacheWrites[0].ttl).toBe(20);
	});

	it('rejects a category that matches no prop family, naming the real ones', async () => {
		const r = await fetch(`${base}/api/forged?category=not-a-family`);
		expect(r.status).toBe(400);
		const body = await r.json();
		expect(body.error).toBe('invalid_category');
		expect(body.error_description).toContain('vehicle');
		// Validation runs before any query: a bad filter costs no database work.
		expect(queryCount).toBe(0);
	});

	it('answers a brief database outage with a retryable 503, not a 500', async () => {
		dbError = Object.assign(new Error('connection terminated'), { code: 'db_down' });
		const r = await fetch(`${base}/api/forged`);
		expect(r.status).toBe(503);
		expect(r.headers.get('retry-after')).toBe('5');
		expect((await r.json()).error).toBe('db_unavailable');
	});

	it('is read-only: anything but GET is 405', async () => {
		const r = await fetch(`${base}/api/forged`, { method: 'POST' });
		expect(r.status).toBe(405);
	});
});
