// Endpoint tests for the profile social-graph and creations-feed handlers:
//   GET/POST/DELETE /api/users/:username/follow
//   GET            /api/users/:username/follows
//   GET            /api/users/:username/creations
//
// Each drives the real handler with a fake req/res and a mocked DB, auth, CSRF,
// and rate limiter. http.js (json/cors/method/wrap) runs for real, so the status
// codes and the error envelope are genuinely exercised. The cases below cover
// the main path plus the three failure modes the handlers are responsible for:
// a rate-limited public read, a malformed cursor, and a follower list whose rows
// belong to accounts that never claimed a username.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Tagged-template `sql` that returns whatever the test queued, in order, and
// records the interpolated SQL text so a test can assert on the predicate.
const queue = [];
const statements = [];
vi.mock('../api/_lib/db.js', () => ({
	sql: vi.fn(async (strings) => {
		statements.push(Array.isArray(strings) ? strings.join('?') : String(strings));
		return queue.length ? queue.shift() : [];
	}),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

let session = null;
vi.mock('../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => session),
	authenticateBearer: vi.fn(async () => null),
	extractBearer: vi.fn(() => null),
}));

let csrfOk = true;
vi.mock('../api/_lib/csrf.js', () => ({
	requireCsrf: vi.fn(async () => csrfOk),
}));

const ok = { success: true, limit: 60, remaining: 59, reset: Date.now() + 1000 };
let readAllowed = true;
vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: {
		authedReadIp: vi.fn(async () => (readAllowed ? ok : { ...ok, success: false, remaining: 0 })),
		authIp: vi.fn(async () => ok),
	},
	clientIp: vi.fn(() => '127.0.0.1'),
}));

const publishUserEvent = vi.fn();
vi.mock('../api/_lib/feed.js', () => ({ publishUserEvent: (...a) => publishUserEvent(...a) }));
vi.mock('../api/_lib/r2.js', () => ({
	publicUrl: (k) => `https://cdn.test/${k}`,
	thumbnailUrl: (k) => (k ? `https://cdn.test/${k}` : null),
}));

// Creation stores: each test sets what the three sources return.
const listCreationsByUser = vi.fn(async () => []);
const listDioramasByUser = vi.fn(async () => []);
const listRestylesByUser = vi.fn(async () => []);
vi.mock('../api/_lib/forge-store.js', () => ({
	listCreationsByUser: (...a) => listCreationsByUser(...a),
}));
vi.mock('../api/_lib/diorama-store.js', () => ({
	listDioramasByUser: (...a) => listDioramasByUser(...a),
}));
vi.mock('../api/_lib/material-restyle-store.js', () => ({
	listRestylesByUser: (...a) => listRestylesByUser(...a),
}));

import followHandler from '../api/users/[username]/follow.js';
import followsHandler from '../api/users/[username]/follows.js';
import creationsHandler from '../api/users/[username]/creations.js';

function mockRes() {
	return {
		statusCode: 200,
		headers: {},
		body: null,
		headersSent: false,
		writableEnded: false,
		setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
		getHeader(k) { return this.headers[k.toLowerCase()]; },
		end(payload) { this.headersSent = true; this.writableEnded = true; this.body = payload; },
		get json() { return this.body ? JSON.parse(this.body) : null; },
	};
}

const req = (url, over = {}) => ({
	method: 'GET',
	url,
	headers: {},
	socket: {},
	query: {},
	...over,
});

beforeEach(() => {
	queue.length = 0;
	statements.length = 0;
	session = null;
	csrfOk = true;
	readAllowed = true;
	listCreationsByUser.mockResolvedValue([]);
	listDioramasByUser.mockResolvedValue([]);
	listRestylesByUser.mockResolvedValue([]);
	vi.clearAllMocks();
});

describe('GET /api/users/:username/follow', () => {
	it('returns the viewer-specific edge and the counts', async () => {
		session = { id: 'viewer1' };
		queue.push([{ id: 'target1', username: 'creator' }]); // target lookup
		queue.push([{ followers_count: 3, following_count: 1 }]); // counts()
		queue.push([{ follower_id: 'viewer1', following_id: 'target1' }]); // edges()

		const res = mockRes();
		await followHandler(req('/api/users/creator/follow', { query: { username: 'creator' } }), res);

		expect(res.statusCode).toBe(200);
		expect(res.json).toEqual({
			following: true,
			followed_by: false,
			followers_count: 3,
			following_count: 1,
		});
	});

	it('counts only reachable profiles, so the badge matches the list', async () => {
		queue.push([{ id: 'target1', username: 'creator' }]);
		queue.push([{ followers_count: 0, following_count: 0 }]);

		const res = mockRes();
		await followHandler(req('/api/users/creator/follow', { query: { username: 'creator' } }), res);

		expect(res.statusCode).toBe(200);
		const countsSql = statements[1];
		expect(countsSql).toContain('u.username is not null');
		expect(countsSql).toContain('u.deleted_at is null');
	});

	it('rate-limits the public GET before it touches the database', async () => {
		readAllowed = false;

		const res = mockRes();
		await followHandler(req('/api/users/creator/follow', { query: { username: 'creator' } }), res);

		expect(res.statusCode).toBe(429);
		expect(statements).toHaveLength(0);
	});

	it('rejects an invalid username with a 400 envelope', async () => {
		const res = mockRes();
		await followHandler(req('/api/users/ab/follow', { query: { username: 'ab' } }), res);

		expect(res.statusCode).toBe(400);
		expect(res.json.error).toBe('validation_error');
		expect(statements).toHaveLength(0);
	});

	it('401s an anonymous POST and never writes an edge', async () => {
		queue.push([{ id: 'target1', username: 'creator' }]);

		const res = mockRes();
		await followHandler(
			req('/api/users/creator/follow', { method: 'POST', query: { username: 'creator' } }),
			res,
		);

		expect(res.statusCode).toBe(401);
		expect(statements).toHaveLength(1); // target lookup only
	});

	it('notifies the target only on a newly created edge', async () => {
		session = { id: 'viewer1', username: 'fan' };
		queue.push([{ id: 'target1', username: 'creator' }]);
		queue.push([{ follower_id: 'viewer1' }]); // insert RETURNING: new edge
		queue.push([{ followers_count: 1, following_count: 0 }]);
		queue.push([{ follower_id: 'viewer1', following_id: 'target1' }]);

		const res = mockRes();
		await followHandler(
			req('/api/users/creator/follow', { method: 'POST', query: { username: 'creator' } }),
			res,
		);

		expect(res.statusCode).toBe(200);
		expect(res.json.following).toBe(true);
		expect(publishUserEvent).toHaveBeenCalledTimes(1);
		expect(publishUserEvent.mock.calls[0][1]).toMatchObject({ type: 'follow', link: '/u/fan' });
	});

	it('does not re-notify when the edge already existed', async () => {
		session = { id: 'viewer1', username: 'fan' };
		queue.push([{ id: 'target1', username: 'creator' }]);
		queue.push([]); // insert RETURNING: conflict, no new row
		queue.push([{ followers_count: 1, following_count: 0 }]);
		queue.push([{ follower_id: 'viewer1', following_id: 'target1' }]);

		const res = mockRes();
		await followHandler(
			req('/api/users/creator/follow', { method: 'POST', query: { username: 'creator' } }),
			res,
		);

		expect(res.statusCode).toBe(200);
		expect(publishUserEvent).not.toHaveBeenCalled();
	});

	it('refuses a self-follow', async () => {
		session = { id: 'target1', username: 'creator' };
		queue.push([{ id: 'target1', username: 'creator' }]);

		const res = mockRes();
		await followHandler(
			req('/api/users/creator/follow', { method: 'POST', query: { username: 'creator' } }),
			res,
		);

		expect(res.statusCode).toBe(400);
		expect(res.json.error_description).toMatch(/cannot follow yourself/);
	});
});

describe('GET /api/users/:username/follows', () => {
	it('lists followers with the viewer follow-state per row', async () => {
		session = { id: 'viewer1' };
		queue.push([{ id: 'target1' }]); // target lookup
		queue.push([
			{
				id: 'u2',
				username: 'alice',
				display_name: 'Alice',
				avatar_url: 'u/alice.png',
				bio: 'builder',
				created_at: '2026-08-01T00:00:00.000Z',
				is_following: true,
			},
		]);

		const res = mockRes();
		await followsHandler(req('/api/users/creator/follows', { query: { username: 'creator' } }), res);

		expect(res.statusCode).toBe(200);
		expect(res.json.type).toBe('followers');
		expect(res.json.users).toEqual([
			{
				username: 'alice',
				display_name: 'Alice',
				avatar_url: 'https://cdn.test/u/alice.png',
				bio: 'builder',
				followed_at: '2026-08-01T00:00:00.000Z',
				is_following: true,
				is_self: false,
			},
		]);
		expect(res.json.has_more).toBe(false);
		expect(res.json.next_offset).toBe(1);
	});

	it('excludes username-less accounts in SQL so the page is not silently emptied', async () => {
		queue.push([{ id: 'target1' }]);
		queue.push([]);

		const res = mockRes();
		await followsHandler(
			req('/api/users/creator/follows?type=following', {
				query: { username: 'creator', type: 'following' },
			}),
			res,
		);

		expect(res.statusCode).toBe(200);
		expect(res.json.type).toBe('following');
		expect(statements[1]).toContain('u.username is not null');
	});

	it('404s an unknown username', async () => {
		queue.push([]); // no target

		const res = mockRes();
		await followsHandler(req('/api/users/ghosted/follows', { query: { username: 'ghosted' } }), res);

		expect(res.statusCode).toBe(404);
		expect(res.json.error).toBe('not_found');
	});
});

describe('GET /api/users/:username/creations', () => {
	it('merges the three creation sources into one recency-ordered feed', async () => {
		queue.push([{ id: 'target1' }]);
		listCreationsByUser.mockResolvedValue([
			{ id: 'm1', type: 'model', prompt: 'a sword', glbUrl: 'https://cdn.test/m1.glb', category: 'prop', isRemix: false, createdAt: '2026-08-03T00:00:00.000Z' },
		]);
		listDioramasByUser.mockResolvedValue([
			{ id: 'w1', type: 'world', title: 'Reef', prompt: 'a reef', thumbnailGlb: 'https://cdn.test/w1.glb', mood: 'calm', createdAt: '2026-08-05T00:00:00.000Z' },
		]);
		listRestylesByUser.mockResolvedValue([
			{ id: 'r1', type: 'restyle', action: 'variants', prompt: null, glbUrl: 'https://cdn.test/r1.glb', category: 'colorway variant', createdAt: '2026-08-04T00:00:00.000Z' },
		]);

		const res = mockRes();
		await creationsHandler(
			req('/api/users/creator/creations', { query: { username: 'creator' } }),
			res,
		);

		expect(res.statusCode).toBe(200);
		expect(res.json.items.map((i) => i.id)).toEqual(['w1', 'r1', 'm1']);
		expect(res.json.items[1].title).toBe('Colorway variant');
		expect(res.json.next).toBe(null); // fewer items than the page size
	});

	it('rejects a malformed cursor instead of returning a silently empty page', async () => {
		queue.push([{ id: 'target1' }]);

		const res = mockRes();
		await creationsHandler(
			req('/api/users/creator/creations?before=not-a-date', { query: { username: 'creator' } }),
			res,
		);

		expect(res.statusCode).toBe(400);
		expect(res.json.error).toBe('validation_error');
		expect(res.json.error_description).toMatch(/ISO 8601/);
		expect(listCreationsByUser).not.toHaveBeenCalled();
	});

	it('normalizes a valid cursor to ISO before handing it to the stores', async () => {
		queue.push([{ id: 'target1' }]);

		const res = mockRes();
		await creationsHandler(
			req('/api/users/creator/creations?before=2026-08-05T00%3A00%3A00.000Z&type=model', {
				query: { username: 'creator' },
			}),
			res,
		);

		expect(res.statusCode).toBe(200);
		expect(listCreationsByUser).toHaveBeenCalledWith({
			userId: 'target1',
			limit: 25,
			before: '2026-08-05T00:00:00.000Z',
		});
		expect(listDioramasByUser).not.toHaveBeenCalled(); // type=model narrows the fan-out
	});

	it('rejects an unknown type filter', async () => {
		queue.push([{ id: 'target1' }]);

		const res = mockRes();
		await creationsHandler(
			req('/api/users/creator/creations?type=sculpture', { query: { username: 'creator' } }),
			res,
		);

		expect(res.statusCode).toBe(400);
		expect(res.json.error_description).toMatch(/model\|world\|restyle/);
	});
});
