// GET /api/strategies?sort=performance, the published marketplace's default order.
//
// Performance is not a database column: it is aggregated in the handler from real
// closed on-chain positions, so the SQL page cannot also be the answer. Ordering by
// published_at and taking `limit` rows would rank only the newest slice and still
// label it a performance ranking, hiding the best-performing strategy on the
// platform behind whatever was published most recently. The handler scans a wider
// candidate pool, ranks it, and only then trims to `limit`.
//
// Network-free: database, auth and rate limiter are mocked. What is under test is
// the ordering contract and the size of the pool the handler asks Postgres for.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer } from 'node:http';

const OWNER = '5f2f1b3c-1d4e-4a2b-8c9d-0e1f2a3b4c5d';

function strategy(id, name, publishedAt) {
	return {
		id,
		name,
		slug: name.toLowerCase(),
		description: null,
		config: {},
		version: 1,
		published: true,
		published_at: publishedAt,
		owner_id: OWNER,
		fork_of: null,
		forked_from: null,
		forks_count: 0,
		equips_count: 0,
		created_at: publishedAt,
		updated_at: publishedAt,
	};
}

// Newest first, which is the order the SQL returns them in.
const NEWEST_UNPROVEN = strategy('11111111-1111-4111-8111-111111111111', 'Newest', '2026-08-15T00:00:00.000Z');
const MID_MODEST = strategy('22222222-2222-4222-8222-222222222222', 'Modest', '2026-06-01T00:00:00.000Z');
const OLDEST_BEST = strategy('33333333-3333-4333-8333-333333333333', 'Best', '2026-01-01T00:00:00.000Z');

// Real closed positions: only the two older strategies have ever traded.
const POSITIONS = [
	{
		strategy_id: MID_MODEST.id,
		closed: 4, open: 0, wins: 3, losses: 1,
		pnl_lamports: '100000000', entry_lamports: '1000000000',
		worst_lamports: '-20000000', last_closed_at: '2026-07-01T00:00:00.000Z',
	},
	{
		strategy_id: OLDEST_BEST.id,
		closed: 9, open: 1, wins: 8, losses: 1,
		pnl_lamports: '5000000000', entry_lamports: '1000000000',
		worst_lamports: '-10000000', last_closed_at: '2026-07-20T00:00:00.000Z',
	},
];

const calls = [];

vi.mock('../../api/_lib/db.js', () => ({
	sql: vi.fn(async (...args) => {
		const text = Array.isArray(args[0]) ? args[0].join('?') : String(args[0]);
		calls.push({ text, values: args.slice(1) });
		if (text.includes('agent_strategy_positions')) return POSITIONS;
		if (text.includes('FROM users')) return [{ id: OWNER, name: 'Audit owner' }];
		if (text.includes('FROM agent_strategies')) return [NEWEST_UNPROVEN, MID_MODEST, OLDEST_BEST];
		return [];
	}),
	isDbUnavailableError: () => false,
}));

vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => null),
	authenticateBearer: vi.fn(async () => null),
	extractBearer: () => null,
}));

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		publicIp: vi.fn(async () => ({ success: true, limit: 60, remaining: 59, reset: 0 })),
		authedReadIp: vi.fn(async () => ({ success: true, limit: 60, remaining: 59, reset: 0 })),
		authIp: vi.fn(async () => ({ success: true, limit: 60, remaining: 59, reset: 0 })),
	},
	clientIp: () => '127.0.0.1',
}));

let server;
let base;

beforeAll(async () => {
	const { default: handler } = await import('../../api/strategies.js');
	server = createServer((req, res) => handler(req, res));
	await new Promise((r) => server.listen(0, '127.0.0.1', r));
	base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => server?.close());
beforeEach(() => { calls.length = 0; });

/** The value the list query passed as its LIMIT (always the last interpolation). */
const listLimit = () => calls.find((c) => c.text.includes('FROM agent_strategies')).values.at(-1);

describe('/api/strategies?sort=performance', () => {
	it('ranks the whole published pool, not just the newest page', async () => {
		const r = await fetch(`${base}/api/strategies?sort=performance&limit=1`);
		expect(r.status).toBe(200);

		const { data } = await r.json();
		expect(data.sort).toBe('performance');
		expect(data.strategies).toHaveLength(1);
		// 500% ROI beats 10%, and both beat an unproven strategy published yesterday.
		expect(data.strategies[0].name).toBe('Best');
		expect(data.strategies[0].performance).toMatchObject({ proven: true, trades: 9, roi_pct: 500 });
	});

	it('asks Postgres for a candidate pool rather than one page', async () => {
		await fetch(`${base}/api/strategies?sort=performance&limit=1`);
		expect(listLimit()).toBe(200);
	});

	it('leaves a database-ordered sort paging normally', async () => {
		await fetch(`${base}/api/strategies?sort=forks&limit=7`);
		expect(listLimit()).toBe(7);
	});

	it('sorts unproven strategies below proven ones, newest first among them', async () => {
		const { data } = await (await fetch(`${base}/api/strategies?sort=performance&limit=10`)).json();
		expect(data.strategies.map((s) => s.name)).toEqual(['Best', 'Modest', 'Newest']);
		expect(data.strategies[2].performance).toMatchObject({ proven: false, trades: 0 });
	});
});
