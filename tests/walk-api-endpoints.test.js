// The /api/walk surface (control channel, session sync, pilot, leaderboard) had
// no handler-level coverage, and four defects lived there because of it:
//
//   1. api/walk/control/[action].js parsed the walk client's live-state report
//      (?x=&z=&facing=&motion=&cenv=) as one all-or-nothing object, so a single
//      unexpected field (a motion name a newer client reports, a NaN from a
//      half-initialised frame) silently discarded the position in that same
//      poll. /state then served a stale avatar with nothing anywhere to explain
//      it.
//   2. the same file validated a command body BEFORE checking the control
//      token, so an unauthenticated caller got schema feedback.
//   3. api/walk/session.js spent the write-rate budget on reads and keyed it by
//      IP, collapsing every walker behind one NAT into one 30/hour bucket while
//      the client saves on a 30s heartbeat.
//   4. api/walk/pilot.js read `user.id` only, but authenticateBearer returns
//      `{ userId }`, so an API-key caller planned anonymously: no per-user rate
//      bucket and no LLM spend attribution.
//
// These tests pin all four.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlCalls = [];
const sqlHandlers = { fn: null };
function sqlMock(strings, ...values) {
	const text = Array.isArray(strings) ? strings.join('?') : String(strings);
	sqlCalls.push({ text, values });
	return Promise.resolve(sqlHandlers.fn ? sqlHandlers.fn(text, values) || [] : []);
}
vi.mock('../api/_lib/db.js', () => ({
	sql: (...a) => sqlMock(...a),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
	isStoragePressured: () => false,
}));

const getSessionUserMock = vi.fn(async () => null);
const authenticateBearerMock = vi.fn(async () => null);
const extractBearerMock = vi.fn(() => null);
vi.mock('../api/_lib/auth.js', () => ({
	getSessionUser: (...a) => getSessionUserMock(...a),
	authenticateBearer: (...a) => authenticateBearerMock(...a),
	extractBearer: (...a) => extractBearerMock(...a),
	hasScope: () => true,
}));

const rlCalls = [];
const rl = (name) => (key) => {
	rlCalls.push({ name, key });
	return Promise.resolve({ success: true, limit: 100, remaining: 99, reset: Date.now() + 60_000 });
};
vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: {
		irlInteractIp: rl('irlInteractIp'),
		publicIp: rl('publicIp'),
		walkSessionWrite: rl('walkSessionWrite'),
		prefsWrite: rl('prefsWrite'),
		chatIp: rl('chatIp'),
		chatUser: rl('chatUser'),
	},
	clientIp: () => '203.0.113.7',
}));

vi.mock('../api/_lib/env.js', () => ({ env: {} }));
vi.mock('../api/_lib/sentry.js', () => ({ captureException: vi.fn() }));
vi.mock('../api/_lib/alerts.js', () => ({ sendOpsAlert: vi.fn() }));
vi.mock('../api/_lib/zauth.js', () => ({ instrument: () => false, drain: vi.fn() }));
vi.mock('../api/_lib/r2.js', () => ({
	thumbnailUrl: (key) => (key ? `https://cdn.test/${key}` : null),
}));

const llmCompleteMock = vi.fn(async () => ({ text: '{"action":{"type":"wait","ms":900}}', model: 'test-model' }));
vi.mock('../api/_lib/llm.js', () => ({
	llmComplete: (...a) => llmCompleteMock(...a),
	llmConfigured: () => true,
	LlmUnavailableError: class LlmUnavailableError extends Error {},
}));

const { default: controlHandler } = await import('../api/walk/control/[action].js');
const { default: sessionHandler } = await import('../api/walk/session.js');
const { default: pilotHandler } = await import('../api/walk/pilot.js');
const { default: leaderboardHandler } = await import('../api/walk/leaderboard.js');

const SESSION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function makeReqRes(method, url, { body, headers, query } = {}) {
	const req = {
		method,
		url,
		headers: { host: 'three.ws', ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
		query: query || {},
	};
	if (body !== undefined) req.body = body;
	const res = {
		statusCode: 0,
		body: null,
		headers: {},
		setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
		getHeader(k) { return this.headers[k.toLowerCase()]; },
		removeHeader(k) { delete this.headers[k.toLowerCase()]; },
		writeHead(code, h) { this.statusCode = code; if (h) Object.assign(this.headers, h); return this; },
		end(b) { this.body = b ?? null; },
		get headersSent() { return this.body !== null; },
		get writableEnded() { return this.body !== null; },
	};
	return { req, res };
}

const parsed = (res) => JSON.parse(res.body);

// A live control session the token resolves to, and the walk_control_* traffic
// a poll produces.
function stubLiveControlSession() {
	sqlHandlers.fn = (text) => {
		if (/from walk_control_sessions/.test(text)) {
			return [{
				id: SESSION_ID,
				owner_id: USER_ID,
				avatar_id: null,
				env_id: null,
				pos_x: null,
				pos_z: null,
				facing: null,
				motion: null,
				current_env: null,
				client_seen_at: null,
				created_at: new Date().toISOString(),
				expires_at: new Date(Date.now() + 3_600_000).toISOString(),
			}];
		}
		return [];
	};
}

beforeEach(() => {
	sqlCalls.length = 0;
	rlCalls.length = 0;
	sqlHandlers.fn = null;
	getSessionUserMock.mockReset().mockResolvedValue(null);
	authenticateBearerMock.mockReset().mockResolvedValue(null);
	extractBearerMock.mockReset().mockReturnValue(null);
	llmCompleteMock.mockClear();
});

describe('GET /api/walk/control/poll', () => {
	it('keeps every valid live-state field when one of them is invalid', async () => {
		stubLiveControlSession();
		const { req, res } = makeReqRes(
			'GET',
			`/api/walk/control/poll?sessionId=${SESSION_ID}&ck=tok&x=7.25&z=-3.5&facing=1.1&motion=sprint&cenv=beach`,
			{ query: { action: 'poll' } },
		);
		await controlHandler(req, res);

		expect(res.statusCode).toBe(200);
		const update = sqlCalls.find((c) => /update walk_control_sessions/.test(c.text));
		expect(update).toBeTruthy();
		// pos_x, pos_z, facing, motion, current_env, id — motion alone is dropped.
		expect(update.values.slice(0, 6)).toEqual(['3600 seconds', 7.25, -3.5, 1.1, null, 'beach']);
	});

	it('keeps a valid motion when a numeric field is unparseable', async () => {
		stubLiveControlSession();
		const { req, res } = makeReqRes(
			'GET',
			`/api/walk/control/poll?sessionId=${SESSION_ID}&ck=tok&x=abc&motion=run`,
			{ query: { action: 'poll' } },
		);
		await controlHandler(req, res);

		expect(res.statusCode).toBe(200);
		const update = sqlCalls.find((c) => /update walk_control_sessions/.test(c.text));
		expect(update.values.slice(0, 6)).toEqual(['3600 seconds', null, null, null, 'run', null]);
	});
});

describe('POST /api/walk/control/move', () => {
	it('rejects an unauthorized caller before it validates the body', async () => {
		sqlHandlers.fn = () => []; // no session resolves for this token
		const { req, res } = makeReqRes('POST', '/api/walk/control/move', {
			query: { action: 'move' },
			headers: { authorization: 'Bearer not-a-real-token' },
			body: { x: 'left' },
		});
		await controlHandler(req, res);

		expect(res.statusCode).toBe(401);
		expect(parsed(res).error).toBe('invalid_control_token');
	});
});

describe('/api/walk/session', () => {
	beforeEach(() => {
		getSessionUserMock.mockResolvedValue({ id: USER_ID });
	});

	it('does not spend the write budget on a read', async () => {
		const { req, res } = makeReqRes('GET', '/api/walk/session');
		await sessionHandler(req, res);

		expect(res.statusCode).toBe(204);
		expect(rlCalls.map((c) => c.name)).toEqual(['publicIp']);
	});

	it('meters a write per user, not per IP', async () => {
		sqlHandlers.fn = (text) => (/insert into walk_sessions/.test(text)
			? [{ updated_at: '2026-08-15T00:00:00.000Z' }]
			: []);
		const { req, res } = makeReqRes('PUT', '/api/walk/session', { body: { state: { envId: 'park' } } });
		await sessionHandler(req, res);

		expect(res.statusCode).toBe(200);
		const write = rlCalls.find((c) => c.name === 'walkSessionWrite');
		expect(write).toEqual({ name: 'walkSessionWrite', key: USER_ID });
	});
});

describe('POST /api/walk/pilot', () => {
	it('attributes a bearer/API-key caller so their plan is rate-limited and their spend tracked', async () => {
		extractBearerMock.mockReturnValue('sk_live_probe');
		authenticateBearerMock.mockResolvedValue({ userId: USER_ID, scope: '', source: 'apikey' });

		const { req, res } = makeReqRes('POST', '/api/walk/pilot', { body: { instruction: 'open the docs' } });
		await pilotHandler(req, res);

		expect(res.statusCode).toBe(200);
		expect(rlCalls.find((c) => c.name === 'chatUser')).toEqual({ name: 'chatUser', key: USER_ID });
		expect(llmCompleteMock.mock.calls[0][0].track).toEqual({ userId: USER_ID, tool: 'walk-pilot' });
	});
});

describe('GET /api/walk/leaderboard', () => {
	it('gives an unranked walker the same row shape as a ranked one', async () => {
		getSessionUserMock.mockResolvedValue({ id: USER_ID });
		sqlHandlers.fn = (text) => {
			if (/from users u/.test(text)) {
				return [{
					id: USER_ID,
					username: 'walkerone',
					display_name: 'Walker One',
					avatar_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
					thumbnail_key: 'thumb/cccccccc.png',
				}];
			}
			return []; // no metrics anywhere: the walker is unranked
		};

		const { req, res } = makeReqRes('GET', '/api/walk/leaderboard?period=weekly&metric=distance');
		await leaderboardHandler(req, res);

		expect(res.statusCode).toBe(200);
		const { me, rows, total } = parsed(res);
		expect(total).toBe(0);
		expect(rows).toEqual([]);
		expect(me).toEqual({
			rank: null,
			key: `u:${USER_ID}`,
			userId: USER_ID,
			anonId: null,
			username: 'walkerone',
			handle: '@walkerone',
			profileUrl: '/u/walkerone',
			avatarId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
			avatar: 'https://cdn.test/thumb/cccccccc.png',
			value: 0,
			deltaFromYesterday: 0,
			onPage: false,
			unranked: true,
		});
	});

	it('reads a walker profile and its thumbnail from the same avatar row', async () => {
		getSessionUserMock.mockResolvedValue({ id: USER_ID });
		sqlHandlers.fn = (text) => (/from users u/.test(text) ? [] : []);

		const { req, res } = makeReqRes('GET', '/api/walk/leaderboard?period=weekly&metric=distance');
		await leaderboardHandler(req, res);

		const profileQuery = sqlCalls.find((c) => /from users u/.test(c.text));
		expect(profileQuery).toBeTruthy();
		// One lateral pick, not two independent subqueries that can disagree.
		expect(profileQuery.text).toMatch(/left join lateral/);
		expect(profileQuery.text.match(/from avatars/g)).toHaveLength(1);
	});
});
