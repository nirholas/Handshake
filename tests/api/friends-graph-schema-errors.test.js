// GET /api/friends: how the handler classifies a schema-level database error.
//
// The friends graph deliberately degrades to an empty graph when its tables are
// not migrated yet, so a fresh environment renders the social UI instead of a
// 500. That degradation used to be keyed on substrings of the error message
// ("relation", "does not exist"), which quietly over-matched: Postgres phrases a
// missing COLUMN as `column "responded_at" of relation "friendships" does not
// exist`, so a HALF-applied migration took the same branch. The endpoint then
// answered 200 with an empty graph and every user looked like they had no
// friends, no requests, and no pending invites, with nothing anywhere surfacing
// the broken schema.
//
// The classification is now the Postgres SQLSTATE: 42P01 (undefined_table) is
// the only code that may degrade. These tests pin both sides of that line.
//
// Mocks: the auth, rate-limit, presence, and friends-store boundaries only. The
// real handler, the real api/_lib/http.js response layer, and the real control
// flow all run.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const authState = { account: { userId: '00000000-0000-0000-0000-0000000000aa' } };
vi.mock('../../api/_lib/account-auth.js', () => ({
	resolveAccount: vi.fn(async () => authState.account),
}));

const rlState = { success: true };
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		publicIp: vi.fn(async () => rlState),
		chatUser: vi.fn(async () => rlState),
	},
	clientIp: vi.fn(() => '127.0.0.1'),
}));

vi.mock('../../api/_lib/csrf.js', () => ({ requireCsrf: vi.fn(async () => true) }));

vi.mock('../../api/_lib/presence-store.js', () => ({
	readPresence: vi.fn(async () => ({})),
	notifyMultiplayer: vi.fn(async () => ({ delivered: false, reason: 'unconfigured' })),
}));

const listGraph = vi.fn();
vi.mock('../../api/_lib/friends-store.js', () => ({
	listGraph: (...a) => listGraph(...a),
	sendRequest: vi.fn(),
	acceptRequest: vi.fn(),
	declineRequest: vi.fn(),
	removeFriend: vi.fn(),
	muteUser: vi.fn(),
	unmuteUser: vi.fn(),
}));

const { default: friendsHandler } = await import('../../api/friends/index.js');

// A NeonDbError as the driver actually surfaces it: a `code` carrying the
// SQLSTATE alongside the human-readable message.
function dbError(code, message) {
	return Object.assign(new Error(message), { name: 'NeonDbError', code });
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

async function get() {
	const req = { method: 'GET', headers: {}, url: '/api/friends', query: {} };
	const res = makeRes();
	await friendsHandler(req, res);
	let body = null;
	try { body = JSON.parse(res._body); } catch { /* non-JSON body stays null */ }
	return { res, body };
}

beforeEach(() => {
	listGraph.mockReset();
	rlState.success = true;
	authState.account = { userId: '00000000-0000-0000-0000-0000000000aa' };
});

describe('GET /api/friends schema-error classification', () => {
	it('degrades to an empty graph when the friends tables are not migrated (42P01)', async () => {
		listGraph.mockRejectedValue(dbError('42P01', 'relation "friendships" does not exist'));
		const { res, body } = await get();
		expect(res.statusCode).toBe(200);
		expect(body.data).toEqual({ friends: [], incoming: [], outgoing: [] });
	});

	it('surfaces a half-applied migration instead of reporting an empty graph (42703)', async () => {
		// The message contains both "relation" and "does not exist", which is
		// exactly what made the old substring test swallow it.
		listGraph.mockRejectedValue(
			dbError('42703', 'column "responded_at" of relation "friendships" does not exist'),
		);
		const { res, body } = await get();
		expect(res.statusCode).toBe(500);
		expect(body.data).toBeUndefined();
		expect(body.error).toBe('internal_error');
	});

	it('surfaces any other database failure rather than hiding the graph', async () => {
		listGraph.mockRejectedValue(dbError('57014', 'canceling statement due to statement timeout'));
		const { res } = await get();
		expect(res.statusCode).toBe(500);
	});

	it('returns the real graph, presence-annotated, on the success path', async () => {
		listGraph.mockResolvedValue({
			friends: [{ id: 'f-1', name: 'ada' }],
			incoming: [],
			outgoing: [],
		});
		const { res, body } = await get();
		expect(res.statusCode).toBe(200);
		expect(body.data.friends).toEqual([
			{ id: 'f-1', name: 'ada', online: false, realm: null, server: null },
		]);
	});
});
