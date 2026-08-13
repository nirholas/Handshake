// POST /api/friends: the graph-mutation contract.
//
// One endpoint fans out to six store actions, so the dispatch table and the
// input guards in front of it are the whole security surface: an unknown action
// must not fall through to a mutation, a target that is not a UUID must never
// reach the store, and a store-thrown contract error (self-add, unknown user,
// no pending request) must surface with its own status and code rather than
// collapsing into a 500. The live-notification side effects are pinned too,
// because they fire per action and the request/accept split is easy to invert.
//
// Mocks: the auth, rate-limit, CSRF, presence, and friends-store boundaries
// only. The real handler and the real api/_lib/http.js response layer run.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const ME = '00000000-0000-0000-0000-0000000000aa';
const OTHER = '00000000-0000-0000-0000-0000000000bb';

const authState = { account: { userId: ME } };
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

const csrfState = { ok: true };
vi.mock('../../api/_lib/csrf.js', () => ({
	requireCsrf: vi.fn(async () => csrfState.ok),
}));

const notifyMultiplayer = vi.fn(async () => ({ delivered: true }));
vi.mock('../../api/_lib/presence-store.js', () => ({
	readPresence: vi.fn(async () => ({})),
	notifyMultiplayer: (...a) => notifyMultiplayer(...a),
}));

const store = {
	listGraph: vi.fn(async () => ({ friends: [], incoming: [], outgoing: [] })),
	sendRequest: vi.fn(async () => ({ status: 'requested' })),
	acceptRequest: vi.fn(async () => ({ friendshipId: 'f-1' })),
	declineRequest: vi.fn(async () => ({ ok: true })),
	removeFriend: vi.fn(async () => ({ ok: true })),
	muteUser: vi.fn(async () => ({ ok: true })),
	unmuteUser: vi.fn(async () => ({ ok: true })),
};
vi.mock('../../api/_lib/friends-store.js', () => ({
	listGraph: (...a) => store.listGraph(...a),
	sendRequest: (...a) => store.sendRequest(...a),
	acceptRequest: (...a) => store.acceptRequest(...a),
	declineRequest: (...a) => store.declineRequest(...a),
	removeFriend: (...a) => store.removeFriend(...a),
	muteUser: (...a) => store.muteUser(...a),
	unmuteUser: (...a) => store.unmuteUser(...a),
}));

const { default: handler } = await import('../../api/friends/index.js');

function makeRes() {
	return {
		statusCode: 200,
		_h: {},
		setHeader(k, v) { this._h[k.toLowerCase()] = v; },
		getHeader(k) { return this._h[k.toLowerCase()]; },
		end(body) { this._body = body; },
	};
}

async function post(payload) {
	const res = makeRes();
	await handler({
		method: 'POST',
		url: '/api/friends',
		query: {},
		headers: { 'content-type': 'application/json' },
		rawBody: Buffer.from(JSON.stringify(payload)),
	}, res);
	let body = null;
	try { body = JSON.parse(res._body); } catch { /* non-JSON body stays null */ }
	return { res, body };
}

// Every store call this suite could possibly reach, used to assert that a
// rejected request mutated nothing at all, not merely that one action was skipped.
const mutators = () => [
	store.sendRequest, store.acceptRequest, store.declineRequest,
	store.removeFriend, store.muteUser, store.unmuteUser,
];

beforeEach(() => {
	vi.clearAllMocks();
	rlState.success = true;
	csrfState.ok = true;
	authState.account = { userId: ME };
	store.sendRequest.mockResolvedValue({ status: 'requested' });
	store.acceptRequest.mockResolvedValue({ friendshipId: 'f-1' });
	store.declineRequest.mockResolvedValue({ ok: true });
	store.removeFriend.mockResolvedValue({ ok: true });
	store.muteUser.mockResolvedValue({ ok: true });
	store.unmuteUser.mockResolvedValue({ ok: true });
});

describe('POST /api/friends dispatch', () => {
	it('sends a fresh request and notifies the target', async () => {
		const { res, body } = await post({ action: 'request', to: OTHER });
		expect(res.statusCode).toBe(200);
		expect(body.data).toEqual({ status: 'requested' });
		expect(store.sendRequest).toHaveBeenCalledWith(ME, OTHER);
		expect(notifyMultiplayer).toHaveBeenCalledWith('friend_request', OTHER, { from: ME });
	});

	it('notifies an accept (not a request) when the invite was reciprocal', async () => {
		store.sendRequest.mockResolvedValue({ status: 'accepted', relationship: 'friends' });
		await post({ action: 'request', to: OTHER });
		expect(notifyMultiplayer).toHaveBeenCalledWith('friend_accept', OTHER, { from: ME });
	});

	it('stays silent when the relationship already existed', async () => {
		store.sendRequest.mockResolvedValue({ status: 'exists', relationship: 'friends' });
		const { res } = await post({ action: 'request', to: OTHER });
		expect(res.statusCode).toBe(200);
		expect(notifyMultiplayer).not.toHaveBeenCalled();
	});

	it('accepts an incoming request and notifies the requester', async () => {
		const { res, body } = await post({ action: 'accept', userId: OTHER });
		expect(res.statusCode).toBe(200);
		expect(body.data).toEqual({ friendshipId: 'f-1' });
		expect(notifyMultiplayer).toHaveBeenCalledWith('friend_accept', OTHER, { from: ME });
	});

	it.each([
		['decline', 'declineRequest'],
		['remove', 'removeFriend'],
		['mute', 'muteUser'],
		['unmute', 'unmuteUser'],
	])('routes %s to the store without a live notification', async (action, fn) => {
		const { res, body } = await post({ action, userId: OTHER });
		expect(res.statusCode).toBe(200);
		expect(body.data).toEqual({ ok: true });
		expect(store[fn]).toHaveBeenCalledWith(ME, OTHER);
		expect(notifyMultiplayer).not.toHaveBeenCalled();
	});
});

describe('POST /api/friends input guards', () => {
	it('rejects an unknown action without touching the store', async () => {
		const { res, body } = await post({ action: 'block', userId: OTHER });
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('bad_action');
		for (const fn of mutators()) expect(fn).not.toHaveBeenCalled();
	});

	it('rejects a missing action', async () => {
		const { res, body } = await post({ userId: OTHER });
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('bad_action');
	});

	it('rejects a target that is not a uuid', async () => {
		const { res, body } = await post({ action: 'remove', userId: 'me-please' });
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('bad_target');
		for (const fn of mutators()) expect(fn).not.toHaveBeenCalled();
	});

	it('rejects an object smuggled in where the target id belongs', async () => {
		const { res, body } = await post({ action: 'remove', userId: { id: OTHER } });
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('bad_target');
	});

	it('stops a cookie-session caller that fails the CSRF check', async () => {
		csrfState.ok = false;
		const { res } = await post({ action: 'remove', userId: OTHER });
		for (const fn of mutators()) expect(fn).not.toHaveBeenCalled();
		// requireCsrf owns the response; the handler must not write a second one.
		expect(res._body).toBeUndefined();
	});

	it('answers 429 before mutating when the per-account action limit trips', async () => {
		rlState.success = false;
		const { res, body } = await post({ action: 'remove', userId: OTHER });
		expect(res.statusCode).toBe(429);
		expect(body.error_description).toBe('slow down');
		for (const fn of mutators()) expect(fn).not.toHaveBeenCalled();
	});

	it('requires a signed-in account', async () => {
		authState.account = null;
		const { res, body } = await post({ action: 'remove', userId: OTHER });
		expect(res.statusCode).toBe(401);
		expect(body.error).toBe('unauthorized');
	});
});

describe('POST /api/friends store contract errors', () => {
	// The store throws Errors carrying { status, code }. api/_lib/http.js wrap()
	// hands a sub-500 status straight through with its code, so these stay
	// actionable for the caller instead of becoming an opaque internal_error.
	it.each([
		['self_add', 400, 'You cannot add yourself.', 'request'],
		['not_found', 404, 'User not found.', 'request'],
	])('surfaces %s as %i', async (code, status, message, action) => {
		store.sendRequest.mockRejectedValue(Object.assign(new Error(message), { status, code }));
		const { res, body } = await post({ action, to: OTHER });
		expect(res.statusCode).toBe(status);
		expect(body.error).toBe(code);
		expect(body.error_description).toBe(message);
	});

	it('surfaces a missing pending request as 404 no_request', async () => {
		store.acceptRequest.mockRejectedValue(
			Object.assign(new Error('No pending request from that user.'), { status: 404, code: 'no_request' }),
		);
		const { res, body } = await post({ action: 'accept', userId: OTHER });
		expect(res.statusCode).toBe(404);
		expect(body.error).toBe('no_request');
		expect(notifyMultiplayer).not.toHaveBeenCalled();
	});

	it('does not leak an internal database code through a 5xx', async () => {
		store.removeFriend.mockRejectedValue(Object.assign(new Error('connection terminated'), { code: '57P01' }));
		const { res, body } = await post({ action: 'remove', userId: OTHER });
		expect(res.statusCode).toBe(500);
		expect(body.error).toBe('internal_error');
		expect(JSON.stringify(body)).not.toContain('57P01');
	});
});
