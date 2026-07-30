// Unit tests for GET /api/leaderboard/unified, the cross-surface leaderboard
// (user-value campaign, work order 06; retired, see git history). Five real metrics, each
// a COUNT/SUM over an existing table, merged with profile data, ranked, paged,
// and with the requester's own row always pinned even when it is off-page.
//
// Mocks: sql (the per-metric ranking query + the profile lookup), rate-limit,
// auth (session / bearer resolution), r2's thumbnailUrl. All offline.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlQueue = [];
vi.mock('../../api/_lib/db.js', () => ({
	sql: Object.assign(
		vi.fn(() => Promise.resolve(sqlQueue.length ? sqlQueue.shift() : [])),
		{ transaction: vi.fn(async (fns) => { for (const f of fns) await f; }) },
	),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

const rlState = { success: true, limit: 60, remaining: 0, reset: 0 };
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: { publicIp: vi.fn(async () => rlState) },
	clientIp: vi.fn(() => '127.0.0.1'),
}));

const authState = { session: null, bearer: null };
vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => authState.session),
	extractBearer: vi.fn(() => authState.bearer),
	authenticateBearer: vi.fn(async () => authState.session),
}));

vi.mock('../../api/_lib/r2.js', () => ({
	thumbnailUrl: (k) => (k ? `https://r2.example/thumb/${k}` : null),
}));

const { default: handler } = await import('../../api/leaderboard/unified.js');

function makeRes() {
	return {
		statusCode: 200,
		_h: {},
		setHeader(k, v) { this._h[k.toLowerCase()] = v; },
		getHeader(k) { return this._h[k.toLowerCase()]; },
		end(body) { this._body = body; },
	};
}
async function call(query = {}) {
	const qs = new URLSearchParams(query).toString();
	const res = makeRes();
	await handler({ method: 'GET', headers: {}, query, url: `/api/leaderboard/unified${qs ? `?${qs}` : ''}` }, res);
	let body = null;
	try { body = JSON.parse(res._body); } catch {}
	return { res, body };
}

const U1 = '00000000-0000-0000-0000-0000000000a1';
const U2 = '00000000-0000-0000-0000-0000000000a2';
const U3 = '00000000-0000-0000-0000-0000000000a3';

beforeEach(() => {
	sqlQueue.length = 0;
	rlState.success = true;
	authState.session = null;
	authState.bearer = null;
});

describe('GET /api/leaderboard/unified: contract', () => {
	it('defaults to the creations metric and labels it', async () => {
		sqlQueue.push([]); // ranking rows
		const { res, body } = await call();
		expect(res.statusCode).toBe(200);
		expect(body.metric).toBe('creations');
		expect(body.metricLabel).toBe('Creations');
	});

	it('rejects an unknown metric with a list of the valid ones', async () => {
		const { res, body } = await call({ metric: 'vibes' });
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('bad_metric');
		expect(body.error_description).toContain('creations');
		expect(body.error_description).toContain('walk_distance');
	});

	it('accepts every documented metric', async () => {
		for (const metric of ['creations', 'remixes_received', 'launches', 'followers', 'walk_distance']) {
			sqlQueue.length = 0;
			sqlQueue.push([]);
			const { res, body } = await call({ metric });
			expect(res.statusCode).toBe(200);
			expect(body.metric).toBe(metric);
		}
	});

	it('serves an empty board without a profile lookup, and never 500s', async () => {
		sqlQueue.push([]); // ranking rows
		const { res, body } = await call();
		expect(res.statusCode).toBe(200);
		expect(body).toMatchObject({ total: 0, rows: [], hasMore: false, me: null });
		expect(res.getHeader('cache-control')).toContain('s-maxage=30');
	});
});

describe('GET /api/leaderboard/unified: ranking', () => {
	it('ranks by value descending, drops zero-value rows, and resolves profiles', async () => {
		sqlQueue.push([
			{ user_id: U1, value: '3' },
			{ user_id: U2, value: '9' },
			{ user_id: U3, value: '0' }, // no real activity, never ranked
		]);
		sqlQueue.push([
			{ id: U1, username: 'alice', display_name: 'Alice', thumbnail_key: 'k1' },
			{ id: U2, username: 'bob', display_name: 'Bob', thumbnail_key: null },
		]);

		const { body } = await call();
		expect(body.total).toBe(2);
		expect(body.rows.map((r) => [r.rank, r.username, r.value])).toEqual([
			[1, 'bob', 9],
			[2, 'alice', 3],
		]);
		expect(body.rows[1].profileUrl).toBe('/u/alice');
		expect(body.rows[1].handle).toBe('@alice');
		expect(body.rows[1].avatar).toBe('https://r2.example/thumb/k1');
		expect(body.rows[0].avatar).toBeNull();
	});

	it('pages with limit/offset and keeps global rank numbers', async () => {
		sqlQueue.push([
			{ user_id: U1, value: '5' },
			{ user_id: U2, value: '9' },
			{ user_id: U3, value: '1' },
		]);
		sqlQueue.push([{ id: U1, username: 'alice', display_name: 'Alice', thumbnail_key: null }]);

		const { body } = await call({ limit: '1', offset: '1' });
		expect(body.rows).toHaveLength(1);
		expect(body.rows[0]).toMatchObject({ rank: 2, username: 'alice' });
		expect(body.hasMore).toBe(true);
		expect(body.total).toBe(3);
	});

	it('rounds walk distance to centimetres instead of truncating to whole metres', async () => {
		sqlQueue.push([{ user_id: U1, value: 1234.5678 }]);
		sqlQueue.push([{ id: U1, username: 'alice', display_name: 'Alice', thumbnail_key: null }]);
		const { body } = await call({ metric: 'walk_distance' });
		expect(body.rows[0].value).toBe(1234.57);
	});

	it('falls back to a neutral handle for a ranked user with no public username', async () => {
		sqlQueue.push([{ user_id: U1, value: '2' }]);
		sqlQueue.push([]); // profile row missing (deleted account)
		const { body } = await call();
		expect(body.rows[0].handle).toBe('three.ws creator');
		expect(body.rows[0].profileUrl).toBeNull();
	});
});

describe('GET /api/leaderboard/unified: the requester row', () => {
	it('pins the signed-in viewer even when their rank is off-page', async () => {
		authState.session = { id: U3 };
		sqlQueue.push([
			{ user_id: U1, value: '9' },
			{ user_id: U2, value: '5' },
			{ user_id: U3, value: '1' },
		]);
		sqlQueue.push([
			{ id: U1, username: 'alice', display_name: 'Alice', thumbnail_key: null },
			{ id: U3, username: 'carol', display_name: 'Carol', thumbnail_key: null },
		]);

		const { body } = await call({ limit: '1' });
		expect(body.rows.map((r) => r.username)).toEqual(['alice']);
		expect(body.me).toMatchObject({ rank: 3, username: 'carol', value: 1, onPage: false });
	});

	it('marks the viewer as on-page when they are in the returned slice', async () => {
		authState.session = { id: U1 };
		sqlQueue.push([{ user_id: U1, value: '4' }]);
		sqlQueue.push([{ id: U1, username: 'alice', display_name: 'Alice', thumbnail_key: null }]);

		const { body } = await call();
		expect(body.me).toMatchObject({ rank: 1, onPage: true });
	});

	it('returns an unranked placeholder for a signed-in user with no activity', async () => {
		authState.session = { id: U3 };
		sqlQueue.push([{ user_id: U1, value: '4' }]);
		sqlQueue.push([
			{ id: U1, username: 'alice', display_name: 'Alice', thumbnail_key: null },
			{ id: U3, username: 'carol', display_name: 'Carol', thumbnail_key: null },
		]);

		const { body } = await call();
		expect(body.me).toMatchObject({ rank: null, unranked: true, value: 0, username: 'carol', onPage: false });
	});

	it('leaves me null for an anonymous caller; the board itself stays public', async () => {
		sqlQueue.push([{ user_id: U1, value: '4' }]);
		sqlQueue.push([{ id: U1, username: 'alice', display_name: 'Alice', thumbnail_key: null }]);
		const { res, body } = await call();
		expect(res.statusCode).toBe(200);
		expect(body.me).toBeNull();
	});
});
