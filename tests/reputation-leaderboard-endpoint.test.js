/**
 * HTTP-level tests for GET /api/reputation/leaderboard, the public ranking the
 * trending page and the theater roster both render.
 *
 * The scoring math has its own suites (tests/wallet-reputation.test.js and the
 * pure formula in src/shared/agent-financial-reputation.js); this one covers the
 * handler around it, and pins the three failures the endpoint shipped with:
 *
 *   1. `?limit=abc` parsed to NaN, survived to slice(0, NaN), and answered 200
 *      with an empty board after a full scoring pass. A caller could not tell
 *      that from "no agent on this platform is trusted".
 *   2. The candidate-pool query swallowed every database error and degraded to
 *      an empty pool, so an outage published an empty leaderboard as truth.
 *   3. The pool was capped at 90 with no ORDER BY while the real candidate set
 *      is larger, so Postgres handed back an arbitrary slice: the top-scoring
 *      agent could be missing from the board, and two identical requests could
 *      rank differently.
 *
 * Only the impure edges are stubbed (database, Redis, CDN URL builder, the
 * per-agent reputation read, the rate limiter). The handler, its validation, its
 * cache decisions, and its wire shape are the real module.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

class DbDown extends Error {
	constructor() {
		super('connection to server failed');
		this.name = 'DbDown';
	}
}

// Every sql`` call the handler makes, as the raw template strings, so the pool
// query's contract (ordered, deterministic) is assertable.
const queries = [];
let poolRows = [];
let poolError = null;

vi.mock('../api/_lib/db.js', () => ({
	sql: Object.assign(
		vi.fn(async (strings) => {
			queries.push(strings.join(' ? '));
			if (poolError) throw poolError;
			return poolRows;
		}),
		{ transaction: vi.fn() },
	),
	isDbUnavailableError: (err) => err instanceof DbDown,
	isDbCapacityError: () => false,
	isStoragePressured: async () => ({ pressured: false, sizeMb: 1, highWaterMb: 470 }),
}));

vi.mock('../api/_lib/redis.js', () => ({ getRedis: async () => null }));
vi.mock('../api/_lib/r2.js', () => ({ thumbnailUrl: (key) => `https://cdn.test/${key}` }));

const scoreAgentsLite = vi.fn();
vi.mock('../api/_lib/trust/wallet-reputation.js', () => ({
	scoreAgentsLite: (...a) => scoreAgentsLite(...a),
}));

const publicIp = vi.fn(async () => ({ success: true, limit: 60, remaining: 59, reset: Date.now() + 60_000 }));
vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: { publicIp: (...a) => publicIp(...a) },
	clientIp: () => '127.0.0.1',
}));

const { default: handler } = await import('../api/reputation/leaderboard.js');

function mockRes() {
	return {
		statusCode: 200,
		_headers: {},
		_body: '',
		_ended: false,
		setHeader(k, v) {
			this._headers[k.toLowerCase()] = v;
		},
		getHeader(k) {
			return this._headers[k.toLowerCase()];
		},
		end(b) {
			this._body = b || '';
			this._ended = true;
		},
		get json() {
			try {
				return JSON.parse(this._body);
			} catch {
				return null;
			}
		},
	};
}

function mockReq(query = '') {
	return {
		method: 'GET',
		url: '/api/reputation/leaderboard' + (query ? `?${query}` : ''),
		headers: { host: 'three.ws', origin: 'https://three.ws' },
	};
}

const read = async (query = '') => {
	const res = mockRes();
	await handler(mockReq(query), res);
	return res;
};

// Three real-shaped candidates: a public avatar, a private one (thumbnail must
// stay hidden), and an agent with no track record (filtered out as "new").
const ROWS = [
	{
		id: 'be3548cd-420b-416d-92dd-a826f417866d',
		name: 'Harbor #21',
		solana_address: '4Nex4B1MiquVWMF1FuDPHwBWQZWhQZTirichyBFwtxBV',
		avatar_thumbnail_key: 'thumb/harbor.png',
		avatar_visibility: 'public',
	},
	{
		id: '3bd520d8-4c4f-4d4a-b472-3555ce241071',
		name: 'Meridian #22',
		solana_address: null,
		avatar_thumbnail_key: 'thumb/meridian.png',
		avatar_visibility: 'private',
	},
	{
		id: '9507e401-b4dd-42e6-a1eb-806ee0ac28d4',
		name: 'Glyph #21',
		solana_address: '9FkceMhUuLi6VmKfcwsXx5UnAoVjVfj6kzokPaY6uDWo',
		avatar_thumbnail_key: null,
		avatar_visibility: 'public',
	},
];

const rep = (score, isNew = false) => ({
	score,
	tier: 'established',
	tierLabel: 'Established',
	accent: '#7dd3fc',
	isNew,
	totals: { settled_usd: score, distinct_tippers: 4, holds_three: true },
});

beforeEach(() => {
	queries.length = 0;
	poolRows = ROWS;
	poolError = null;
	scoreAgentsLite.mockReset();
	// Deliberately out of score order, and with the lowest-id agent scoring
	// highest, so a passing rank assertion can only come from the sort.
	scoreAgentsLite.mockImplementation(async (ids) =>
		new Map([
			[ids[1], rep(31.9)],
			[ids[0], rep(32.4)],
			[ids[2], rep(9.1, true)],
		]),
	);
	publicIp.mockResolvedValue({ success: true, limit: 60, remaining: 59, reset: Date.now() + 60_000 });
});

describe('GET /api/reputation/leaderboard', () => {
	it('ranks scored agents by score and returns the auditable wire shape', async () => {
		const res = await read('limit=5');
		expect(res.statusCode).toBe(200);
		const body = res.json;
		expect(body.count).toBe(2); // the "new" agent is dropped
		expect(body.scored).toBe(3);
		expect(body.agents.map((a) => [a.rank, a.name, a.score])).toEqual([
			[1, 'Harbor #21', 32.4],
			[2, 'Meridian #22', 31.9],
		]);
		const top = body.agents[0];
		expect(top.tier).toBe('established');
		expect(top.tier_label).toBe('Established');
		expect(top.totals.holds_three).toBe(true);
		expect(top.agent_url).toBe(`https://three.ws/agents/${ROWS[0].id}`);
		expect(top.breakdown_url).toBe(`https://three.ws/agents/${ROWS[0].id}/wallet#reputation`);
		expect(top.avatar_thumbnail_url).toBe('https://cdn.test/thumb/harbor.png');
		expect(Date.parse(body.generated_at)).not.toBeNaN();
		expect(res.getHeader('x-cache')).toBe('MISS');
	});

	it('never leaks a private avatar thumbnail', async () => {
		const body = (await read('limit=5')).json;
		expect(body.agents.find((a) => a.name === 'Meridian #22').avatar_thumbnail_url).toBeNull();
	});

	it('scores a deterministic, footprint-ordered pool rather than an arbitrary slice', async () => {
		await read('limit=5');
		const pool = queries.find((q) => q.includes('from agent_identities'));
		expect(pool).toMatch(/order by\s+settled_usd desc nulls last, i\.id/);
		// The tie-break on i.id is what makes two identical requests agree.
		expect(pool.indexOf('order by')).toBeLessThan(pool.lastIndexOf('limit'));
	});

	it('honours limit, clamping numeric values the way the SDK client does', async () => {
		expect((await read('limit=1')).json.count).toBe(1);
		expect((await read('limit=0')).json.count).toBe(1);
		expect((await read('limit=-5')).json.count).toBe(1);
		expect((await read('limit=999')).json.count).toBe(2);
		expect((await read('limit=1.9')).json.count).toBe(1);
		expect((await read()).json.count).toBe(2);
		// A blank limit means "unspecified", not zero rows: Number('') is 0.
		expect((await read('limit=')).json.count).toBe(2);
		expect((await read('limit=%20')).json.count).toBe(2);
	});

	it('rejects a non-numeric limit with 400 instead of an empty board', async () => {
		for (const q of ['limit=abc', 'limit=null', 'limit=1e999', 'limit=12px']) {
			const res = await read(q);
			expect(res.statusCode, q).toBe(400);
			expect(res.json.error, q).toBe('bad_request');
			expect(res.json.error_description, q).toMatch(/limit must be a number between 1 and 50/);
		}
		// And it costs nothing: the request is refused before the scoring pass.
		expect(scoreAgentsLite).not.toHaveBeenCalled();
	});

	it('answers 503 when the database is down instead of publishing an empty board', async () => {
		poolError = new DbDown();
		const res = await read('limit=5');
		expect(res.statusCode).toBe(503);
		expect(res.json.agents).toBeUndefined();
		expect(res.getHeader('retry-after')).toBe('30');
		expect(scoreAgentsLite).not.toHaveBeenCalled();
	});

	it('returns a designed empty board when nobody has a track record yet', async () => {
		scoreAgentsLite.mockImplementation(async (ids) => new Map(ids.map((id) => [id, rep(4.2, true)])));
		const res = await read('limit=5');
		expect(res.statusCode).toBe(200);
		expect(res.json).toMatchObject({ count: 0, scored: 3, agents: [] });
	});

	it('refuses non-GET methods and answers the CORS preflight', async () => {
		const post = mockRes();
		await handler({ ...mockReq(), method: 'POST' }, post);
		expect(post.statusCode).toBe(405);
		expect(post.json.error).toBe('method_not_allowed');

		const preflight = mockRes();
		await handler({ ...mockReq(), method: 'OPTIONS' }, preflight);
		expect(preflight.statusCode).toBe(204);
		expect(preflight.getHeader('access-control-allow-origin')).toBe('*');
	});

	it('surfaces a rate limit as 429 without touching the database', async () => {
		publicIp.mockResolvedValue({ success: false, limit: 60, remaining: 0, reset: Date.now() + 30_000 });
		const res = await read('limit=5');
		expect(res.statusCode).toBe(429);
		expect(queries).toHaveLength(0);
	});
});
