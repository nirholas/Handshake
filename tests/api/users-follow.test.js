// Unit tests for the site-wide follow graph:
//   GET/POST/DELETE /api/users/:username/follow
//   GET              /api/users/:username/follows
//   GET              /api/users/me/feed
//
// Mocks: sql, auth, csrf, rate-limit, feed (publishUserEvent). All offline —
// no DATABASE_URL or Redis needed. Verifies the user_follows edge semantics
// (idempotent follow/unfollow, self-follow rejected, anonymous-safe reads,
// 401 on anonymous mutation) and the follow-event shape documented in
// api/_lib/feed.js (USER_EVENT_TYPES.follow).

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock layer ──────────────────────────────────────────────────────────────

const authState = { session: null };
vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => authState.session),
}));

vi.mock('../../api/_lib/csrf.js', () => ({ requireCsrf: vi.fn(async () => true) }));

const sqlQueue = [];
const sqlCalls = [];
vi.mock('../../api/_lib/db.js', () => ({
	sql: Object.assign(
		vi.fn(async (...args) => {
			sqlCalls.push(args);
			return sqlQueue.length ? sqlQueue.shift() : [];
		}),
		{ transaction: vi.fn(async (fns) => { for (const f of fns) await f; }) },
	),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

const rlState = { success: true };
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		authIp: vi.fn(async () => rlState),
		authedReadIp: vi.fn(async () => rlState),
	},
	clientIp: vi.fn(() => '127.0.0.1'),
}));

const publishUserEvent = vi.fn();
vi.mock('../../api/_lib/feed.js', () => ({ publishUserEvent }));

vi.mock('../../api/_lib/r2.js', () => ({ publicUrl: (k) => `https://r2.example/${k}` }));

const { default: followHandler } = await import('../../api/users/[username]/follow.js');
const { default: followsHandler } = await import('../../api/users/[username]/follows.js');
const { default: meFeedHandler } = await import('../../api/users/me/feed.js');

// ── request/response helpers ────────────────────────────────────────────────

function makeReq({ method = 'GET', query = {} } = {}) {
	return { method, query, headers: {} };
}
function makeRes() {
	return {
		statusCode: 200,
		_h: {},
		setHeader(k, v) { this._h[k.toLowerCase()] = v; },
		getHeader(k) { return this._h[k.toLowerCase()]; },
		end(body) { this._body = body; },
	};
}
async function call(handler, req) {
	const res = makeRes();
	await handler(req, res);
	let body = null;
	try { body = JSON.parse(res._body); } catch {}
	return { res, body };
}

const VIEWER = { id: '00000000-0000-0000-0000-000000000001', username: 'alice', display_name: 'Alice' };
const TARGET = { id: '00000000-0000-0000-0000-000000000002', username: 'bob' };

beforeEach(() => {
	sqlQueue.length = 0;
	sqlCalls.length = 0;
	publishUserEvent.mockReset();
	authState.session = null;
	rlState.success = true;
});

describe('GET /api/users/:username/follow', () => {
	it('anonymous viewer sees counts with both edges false, no session required', async () => {
		sqlQueue.push([{ id: TARGET.id, username: TARGET.username }]); // target lookup
		sqlQueue.push([{ followers_count: 4, following_count: 1 }]); // counts()
		const { res, body } = await call(followHandler, makeReq({ query: { username: 'bob' } }));
		expect(res.statusCode).toBe(200);
		expect(body.following).toBe(false);
		expect(body.followed_by).toBe(false);
		expect(body.followers_count).toBe(4);
		expect(body.following_count).toBe(1);
	});

	it('404s for an unknown username', async () => {
		sqlQueue.push([]); // target lookup: no row
		const { res, body } = await call(followHandler, makeReq({ query: { username: 'ghost' } }));
		expect(res.statusCode).toBe(404);
		expect(body.error).toBe('not_found');
	});

	it('signed-in viewer sees following/followed_by from the edge rows', async () => {
		authState.session = VIEWER;
		sqlQueue.push([{ id: TARGET.id, username: TARGET.username }]); // target lookup
		sqlQueue.push([{ followers_count: 2, following_count: 0 }]); // counts()
		sqlQueue.push([{ follower_id: VIEWER.id, following_id: TARGET.id }]); // edges(): viewer follows target
		const { body } = await call(followHandler, makeReq({ query: { username: 'bob' } }));
		expect(body.following).toBe(true);
		expect(body.followed_by).toBe(false);
	});
});

describe('POST /api/users/:username/follow', () => {
	it('401s for an anonymous mutation instead of failing silently or 500ing', async () => {
		sqlQueue.push([{ id: TARGET.id, username: TARGET.username }]); // target lookup
		const { res, body } = await call(followHandler, makeReq({ method: 'POST', query: { username: 'bob' } }));
		expect(res.statusCode).toBe(401);
		expect(body.error).toBe('unauthorized');
		expect(publishUserEvent).not.toHaveBeenCalled();
	});

	it('rejects self-follow with 400', async () => {
		authState.session = TARGET;
		sqlQueue.push([{ id: TARGET.id, username: TARGET.username }]); // target lookup (self)
		const { res, body } = await call(followHandler, makeReq({ method: 'POST', query: { username: TARGET.username } }));
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('bad_request');
	});

	it('inserts the edge, fires a follow event in the documented shape, and is idempotent', async () => {
		authState.session = VIEWER;
		sqlQueue.push([{ id: TARGET.id, username: TARGET.username }]); // target lookup
		sqlQueue.push([{ follower_id: VIEWER.id }]); // insert ... returning follower_id (new edge)
		sqlQueue.push([{ followers_count: 5, following_count: 1 }]); // counts()
		sqlQueue.push([{ follower_id: VIEWER.id, following_id: TARGET.id }]); // edges()

		const { res, body } = await call(followHandler, makeReq({ method: 'POST', query: { username: 'bob' } }));
		expect(res.statusCode).toBe(200);
		expect(body.following).toBe(true);
		expect(body.followers_count).toBe(5);

		expect(publishUserEvent).toHaveBeenCalledTimes(1);
		const [recipientId, event] = publishUserEvent.mock.calls[0];
		expect(recipientId).toBe(TARGET.id);
		expect(event).toMatchObject({
			type: 'follow',
			actor: 'Alice',
			follower_username: 'alice',
			link: '/u/alice',
		});
	});

	it('re-following (conflict, no new row) does not re-fire the notification', async () => {
		authState.session = VIEWER;
		sqlQueue.push([{ id: TARGET.id, username: TARGET.username }]); // target lookup
		sqlQueue.push([]); // insert ... on conflict do nothing → no row returned
		sqlQueue.push([{ followers_count: 5, following_count: 1 }]); // counts()
		sqlQueue.push([{ follower_id: VIEWER.id, following_id: TARGET.id }]); // edges()

		await call(followHandler, makeReq({ method: 'POST', query: { username: 'bob' } }));
		expect(publishUserEvent).not.toHaveBeenCalled();
	});
});

describe('DELETE /api/users/:username/follow', () => {
	it('unfollows and reflects the new state, without emitting a follow event', async () => {
		authState.session = VIEWER;
		sqlQueue.push([{ id: TARGET.id, username: TARGET.username }]); // target lookup
		sqlQueue.push([]); // delete
		sqlQueue.push([{ followers_count: 3, following_count: 1 }]); // counts()
		sqlQueue.push([]); // edges(): no row either direction

		const { body } = await call(followHandler, makeReq({ method: 'DELETE', query: { username: 'bob' } }));
		expect(body.following).toBe(false);
		expect(publishUserEvent).not.toHaveBeenCalled();
	});
});

describe('GET /api/users/:username/follows', () => {
	it('lists followers with per-row is_following for the signed-in viewer', async () => {
		authState.session = VIEWER;
		sqlQueue.push([{ id: TARGET.id }]); // target lookup
		sqlQueue.push([
			{ id: VIEWER.id, username: 'alice', display_name: 'Alice', avatar_url: null, bio: null, created_at: '2026-07-01T00:00:00Z', is_following: false },
		]);
		const { body } = await call(followsHandler, makeReq({ query: { username: 'bob', type: 'followers' } }));
		expect(body.type).toBe('followers');
		expect(body.users).toHaveLength(1);
		expect(body.users[0]).toMatchObject({ username: 'alice', is_following: false, is_self: true });
	});

	it('defaults to followers and paginates via has_more', async () => {
		sqlQueue.push([{ id: TARGET.id }]); // target lookup
		sqlQueue.push(Array.from({ length: 50 }, (_, i) => ({
			id: `u${i}`, username: `u${i}`, display_name: `U${i}`, avatar_url: null, bio: null,
			created_at: '2026-07-01T00:00:00Z', is_following: false,
		})));
		const { body } = await call(followsHandler, makeReq({ query: { username: 'bob' } }));
		expect(body.type).toBe('followers');
		expect(body.has_more).toBe(true);
	});
});

// GET /api/users/me/feed?scope=following is the "people I follow" activity
// filter that 02-activity-feed.md's mission depends on — and it's under active
// concurrent development by that prompt's agent (its query set and response
// shape changed shape mid-session while this file was being written). We only
// assert the follow-graph-specific contract here: default scope requires auth,
// and the zero-following case degrades to an empty (never a crashed) feed. The
// merge/render logic for avatars/agents/coins/models/worlds/follows itself is
// 02's surface to test.
describe('GET /api/users/me/feed (default scope=following)', () => {
	it('401s for an anonymous caller — the following feed is inherently personal', async () => {
		const { res, body } = await call(meFeedHandler, makeReq());
		expect(res.statusCode).toBe(401);
		expect(body.error).toBe('unauthorized');
	});

	it('degrades to an empty, well-formed feed when following nobody (never 500s)', async () => {
		authState.session = VIEWER;
		sqlQueue.push([{ following_count: 0 }]);
		const { res, body } = await call(meFeedHandler, makeReq());
		expect(res.statusCode).toBe(200);
		expect(body).toMatchObject({ items: [], following_count: 0, scope: 'following' });
	});
});
