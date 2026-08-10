// Unit tests for /api/aws-marketplace/link, the endpoint that attaches an AWS
// Marketplace subscription to a three.ws account.
//
// Both behaviours pinned here were live defects found by probing the running
// handler:
//   • getSessionUser RESOLVES null for an anonymous caller (it only throws when
//     the lookup itself fails), so the handler ran the customer lookup and then
//     crashed on `user.id`: an anonymous POST got a 500, and the 404-vs-500
//     split answered "does this customer exist?" for a caller with no session.
//   • The UPDATE is guarded on user_id, but the handler returned ok:true
//     regardless of whether it matched. A customer already linked to someone
//     else reported success while nothing changed, and the very next call
//     (issue-key, which does check ownership) answered 403.
//
// The sql tag is mocked so the authorization logic is asserted without touching
// a real database.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const sqlMock = vi.fn();
vi.mock('../../api/_lib/db.js', () => ({
	sql: Object.assign(
		(...args) => sqlMock(...args),
		{ transaction: (...args) => sqlMock(...args) },
	),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

const getSessionUserMock = vi.fn();
vi.mock('../../api/_lib/auth.js', async (importOriginal) => {
	const actual = await importOriginal();
	return { ...actual, getSessionUser: (...a) => getSessionUserMock(...a) };
});

const { default: handler } = await import('../../api/aws-marketplace/link.js');

const OWNER = 'user-owner-1';
const OTHER = 'user-other-2';
const CUSTOMER = 'THREEsynthetic-awsmp-test';

function makeReq(body = { customer: CUSTOMER }) {
	const raw = Buffer.from(JSON.stringify(body));
	return {
		method: 'POST',
		url: '/api/aws-marketplace/link',
		headers: { 'content-type': 'application/json', 'user-agent': 'vitest' },
		rawBody: raw,
		query: {},
	};
}

function makeRes() {
	const headers = {};
	let body = '';
	const res = {
		statusCode: 200,
		headersSent: false,
		writableEnded: false,
		setHeader: (k, v) => { headers[k.toLowerCase()] = v; },
		getHeader: (k) => headers[k.toLowerCase()],
		end: (chunk) => { body = chunk ?? ''; res.writableEnded = true; },
		_get: () => ({ status: res.statusCode, headers, body: body ? JSON.parse(body) : null }),
	};
	return res;
}

/** Row shape the handler's first SELECT returns. */
function customerRow(overrides = {}) {
	return {
		customer_identifier: CUSTOMER,
		subscription_status: 'active',
		user_id: null,
		...overrides,
	};
}

beforeEach(() => {
	sqlMock.mockReset();
	getSessionUserMock.mockReset();
});

describe('POST /api/aws-marketplace/link', () => {
	it('returns 401 (not 500) when there is no session', async () => {
		getSessionUserMock.mockResolvedValue(null);
		const res = makeRes();
		await handler(makeReq(), res);
		expect(res._get().status).toBe(401);
		expect(res._get().body).toEqual({ error: 'unauthenticated' });
	});

	it('does not touch the database for an anonymous caller', async () => {
		getSessionUserMock.mockResolvedValue(null);
		await handler(makeReq(), makeRes());
		// No customer lookup means no "does this customer exist" oracle.
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('returns 401 when the session lookup itself throws', async () => {
		getSessionUserMock.mockRejectedValue(new Error('session store down'));
		const res = makeRes();
		await handler(makeReq(), res);
		expect(res._get().status).toBe(401);
	});

	it('links an unclaimed customer to the signed-in user', async () => {
		getSessionUserMock.mockResolvedValue({ id: OWNER });
		sqlMock
			.mockResolvedValueOnce([customerRow()])
			.mockResolvedValueOnce([{ customer_identifier: CUSTOMER }]);
		const res = makeRes();
		await handler(makeReq(), res);
		expect(res._get().status).toBe(200);
		expect(res._get().body).toEqual({ ok: true });
	});

	it('is idempotent for the account that already owns the customer', async () => {
		getSessionUserMock.mockResolvedValue({ id: OWNER });
		sqlMock
			.mockResolvedValueOnce([customerRow({ user_id: OWNER })])
			.mockResolvedValueOnce([{ customer_identifier: CUSTOMER }]);
		const res = makeRes();
		await handler(makeReq(), res);
		expect(res._get().status).toBe(200);
	});

	it('refuses to report success when the customer belongs to another account', async () => {
		getSessionUserMock.mockResolvedValue({ id: OTHER });
		sqlMock.mockResolvedValueOnce([customerRow({ user_id: OWNER })]);
		const res = makeRes();
		await handler(makeReq(), res);
		expect(res._get().status).toBe(403);
		expect(res._get().body).toEqual({ error: 'customer_linked_to_other_account' });
		// It must stop at the lookup: no UPDATE may be attempted.
		expect(sqlMock).toHaveBeenCalledTimes(1);
	});

	it('reports the conflict when the guarded UPDATE matches nothing (lost race)', async () => {
		// Ownership was free at SELECT time and taken by the time we wrote: the
		// UPDATE guard held and matched zero rows, so ok:true would be a lie.
		getSessionUserMock.mockResolvedValue({ id: OTHER });
		sqlMock
			.mockResolvedValueOnce([customerRow()])
			.mockResolvedValueOnce([]);
		const res = makeRes();
		await handler(makeReq(), res);
		expect(res._get().status).toBe(403);
		expect(res._get().body).toEqual({ error: 'customer_linked_to_other_account' });
	});

	it('returns 404 for an unknown customer', async () => {
		getSessionUserMock.mockResolvedValue({ id: OWNER });
		sqlMock.mockResolvedValueOnce([]);
		const res = makeRes();
		await handler(makeReq(), res);
		expect(res._get().status).toBe(404);
	});

	it('returns 409 for a cancelled subscription', async () => {
		getSessionUserMock.mockResolvedValue({ id: OWNER });
		sqlMock.mockResolvedValueOnce([customerRow({ subscription_status: 'cancelled' })]);
		const res = makeRes();
		await handler(makeReq(), res);
		expect(res._get().status).toBe(409);
		expect(res._get().body).toEqual({ error: 'subscription_inactive', status: 'cancelled' });
	});

	it('returns 400 when the customer field is missing', async () => {
		getSessionUserMock.mockResolvedValue({ id: OWNER });
		const res = makeRes();
		await handler(makeReq({}), res);
		expect(res._get().status).toBe(400);
		expect(res._get().body).toEqual({ error: 'missing_customer' });
	});

	it('rejects a non-POST method', async () => {
		const req = makeReq();
		req.method = 'GET';
		const res = makeRes();
		await handler(req, res);
		expect(res._get().status).toBe(405);
		expect(res.getHeader('allow')).toBe('POST');
	});
});
