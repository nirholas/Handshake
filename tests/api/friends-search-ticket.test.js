// /api/friends/search and /api/friends/presence-ticket — the two read-only
// friends endpoints.
//
// The search endpoint hands its term straight to an ILIKE wrapped in wildcards,
// so the term's length is the one thing it has to bound: an unbounded query
// string became an unbounded pattern matched against every row in `users`. That
// cap is pinned here, alongside the auth gate both endpoints share.
//
// Mocks: the auth, rate-limit, and store boundaries only. The real handlers and
// the real api/_lib/http.js response layer run.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const ME = '00000000-0000-0000-0000-0000000000aa';

const authState = { account: { userId: ME } };
vi.mock('../../api/_lib/account-auth.js', () => ({
	resolveAccount: vi.fn(async () => authState.account),
}));

const rlState = { success: true };
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		publicIp: vi.fn(async () => rlState),
		authedReadIp: vi.fn(async () => rlState),
	},
	clientIp: vi.fn(() => '127.0.0.1'),
}));

const searchUsers = vi.fn(async () => []);
vi.mock('../../api/_lib/friends-store.js', () => ({
	searchUsers: (...a) => searchUsers(...a),
}));

const signPresenceTicket = vi.fn(async () => ({ token: 'payload.sig', expiresIn: 600 }));
vi.mock('../../api/_lib/presence-store.js', () => ({
	signPresenceTicket: (...a) => signPresenceTicket(...a),
}));

const { default: searchHandler } = await import('../../api/friends/search.js');
const { default: ticketHandler } = await import('../../api/friends/presence-ticket.js');

function makeRes() {
	return {
		statusCode: 200,
		_h: {},
		setHeader(k, v) { this._h[k.toLowerCase()] = v; },
		getHeader(k) { return this._h[k.toLowerCase()]; },
		end(body) { this._body = body; },
	};
}

async function call(handler, url) {
	const res = makeRes();
	await handler({ method: 'GET', headers: {}, query: {}, url }, res);
	let body = null;
	try { body = JSON.parse(res._body); } catch { /* non-JSON body stays null */ }
	return { res, body };
}

const search = (qs) => call(searchHandler, `/api/friends/search${qs}`);
const ticket = () => call(ticketHandler, '/api/friends/presence-ticket');

beforeEach(() => {
	vi.clearAllMocks();
	rlState.success = true;
	authState.account = { userId: ME };
	searchUsers.mockResolvedValue([]);
	signPresenceTicket.mockResolvedValue({ token: 'payload.sig', expiresIn: 600 });
});

describe('GET /api/friends/search', () => {
	it('returns annotated hits for a real term', async () => {
		const hits = [{ id: 'u-1', name: 'ada', username: 'ada', avatarUrl: null, relationship: 'none' }];
		searchUsers.mockResolvedValue(hits);
		const { res, body } = await search('?q=ada');
		expect(res.statusCode).toBe(200);
		expect(body.data.results).toEqual(hits);
		expect(searchUsers).toHaveBeenCalledWith(ME, 'ada');
	});

	it('treats a missing q as an empty term rather than erroring', async () => {
		const { res } = await search('');
		expect(res.statusCode).toBe(200);
		expect(searchUsers).toHaveBeenCalledWith(ME, '');
	});

	it('rejects an oversized term instead of handing an unbounded pattern to Postgres', async () => {
		const { res, body } = await search(`?q=${'a'.repeat(201)}`);
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('bad_query');
		expect(searchUsers).not.toHaveBeenCalled();
	});

	it('accepts a term exactly at the cap', async () => {
		const { res } = await search(`?q=${'a'.repeat(200)}`);
		expect(res.statusCode).toBe(200);
		expect(searchUsers).toHaveBeenCalledWith(ME, 'a'.repeat(200));
	});

	it('requires a signed-in account', async () => {
		authState.account = null;
		const { res, body } = await search('?q=ada');
		expect(res.statusCode).toBe(401);
		expect(body.error).toBe('unauthorized');
		expect(searchUsers).not.toHaveBeenCalled();
	});
});

describe('GET /api/friends/presence-ticket', () => {
	it('mints a ticket for the caller and reports its lifetime', async () => {
		const { res, body } = await ticket();
		expect(res.statusCode).toBe(200);
		expect(body.data).toEqual({ token: 'payload.sig', expiresIn: 600 });
		// The ticket is bound to the resolved account, never to anything the
		// client sent — that binding is the whole point of the endpoint.
		expect(signPresenceTicket).toHaveBeenCalledWith(ME);
	});

	it('refuses to mint a ticket for an anonymous caller', async () => {
		authState.account = null;
		const { res, body } = await ticket();
		expect(res.statusCode).toBe(401);
		expect(body.error).toBe('unauthorized');
		expect(signPresenceTicket).not.toHaveBeenCalled();
	});

	it('answers 429 before minting when the read limit trips', async () => {
		rlState.success = false;
		const { res, body } = await ticket();
		expect(res.statusCode).toBe(429);
		expect(body.error).toBe('rate_limited');
		expect(signPresenceTicket).not.toHaveBeenCalled();
	});
});
