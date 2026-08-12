// GET/POST/PATCH /api/dashboard/prefs: the durable, cross-device backup of the
// dashboard's UI preferences.
//
// Two properties are worth pinning here. The first is the auth contract: prefs
// belong to one account, so every method has to reject an anonymous caller, the
// cookie lane has to be CSRF-guarded, and the bearer lane (API keys, MCP) has to
// work without one. The second is the PATCH merge. A page load fires several
// independent patches for unrelated keys (tour completion, walk state, the
// settings form); when the merge was a JS-side read-modify-write, whichever
// write lost the race was silently dropped. Eight concurrent patches against a
// local server backed by the real database kept 2 of 8 keys before the fix and
// 8 of 8 after, so the tests below assert the merge happens inside the statement
// and never as a preceding SELECT.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlMock = vi.fn();
vi.mock('../api/_lib/db.js', () => ({
	sql: (...a) => sqlMock(...a),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

const getSessionUserMock = vi.fn();
const authenticateBearerMock = vi.fn();
const extractBearerMock = vi.fn();
vi.mock('../api/_lib/auth.js', () => ({
	getSessionUser: (...a) => getSessionUserMock(...a),
	authenticateBearer: (...a) => authenticateBearerMock(...a),
	extractBearer: (...a) => extractBearerMock(...a),
}));

const csrfOk = { value: true };
const requireCsrfMock = vi.fn(async (req, res) => {
	if (csrfOk.value) return true;
	res.statusCode = 403;
	res.end(JSON.stringify({ error: 'csrf_missing' }));
	return false;
});
vi.mock('../api/_lib/csrf.js', () => ({ requireCsrf: (...a) => requireCsrfMock(...a) }));

const rlOk = { value: true };
const prefsWriteMock = vi.fn(async () => ({ success: rlOk.value, limit: 30, remaining: 0, reset: 1_000 }));
vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: { prefsWrite: (...a) => prefsWriteMock(...a) },
	clientIp: () => '203.0.113.9',
}));

vi.mock('../api/_lib/env.js', () => ({
	env: { APP_ORIGIN: 'http://localhost:3000', ISSUER: 'http://t', MCP_RESOURCE: 'http://t' },
}));

const { default: handler } = await import('../api/dashboard/prefs.js');

const USER = '0f6932b1-fede-436c-b6de-d41a8119c8b0';

function mkReq({ method = 'GET', headers = {}, body = null } = {}) {
	const hdrs = { ...headers };
	if (body != null && !hdrs['content-type']) hdrs['content-type'] = 'application/json';
	return {
		method,
		url: '/api/dashboard/prefs',
		headers: hdrs,
		on(event, cb) {
			if (event === 'data' && body != null) {
				const buf = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
				queueMicrotask(() => { cb(buf); this._endCb?.(); });
			} else if (event === 'end') {
				this._endCb = cb;
				if (body == null) queueMicrotask(cb);
			}
		},
		destroy() {},
	};
}

function mkRes() {
	return {
		statusCode: 200, headers: {}, body: undefined, writableEnded: false,
		setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
		getHeader(k) { return this.headers[k.toLowerCase()]; },
		end(b) { this.body = b; this.writableEnded = true; },
	};
}

const parse = (res) => (res.body ? JSON.parse(res.body) : undefined);
// The tagged-template call recorded for query N, flattened back to its SQL text.
const queryText = (n) => sqlMock.mock.calls[n][0].join('?');

let sqlQueue = [];
beforeEach(() => {
	sqlQueue = [];
	sqlMock.mockReset().mockImplementation(() => Promise.resolve(sqlQueue.length ? sqlQueue.shift() : []));
	getSessionUserMock.mockReset().mockResolvedValue({ id: USER });
	authenticateBearerMock.mockReset().mockResolvedValue(null);
	extractBearerMock.mockReset().mockReturnValue(null);
	requireCsrfMock.mockClear();
	prefsWriteMock.mockClear();
	csrfOk.value = true;
	rlOk.value = true;
});

describe('auth contract', () => {
	it('answers 401 to an anonymous GET', async () => {
		getSessionUserMock.mockResolvedValue(null);
		const res = mkRes();
		await handler(mkReq(), res);
		expect(res.statusCode).toBe(401);
		expect(parse(res).error).toBe('unauthorized');
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('answers 401 to an anonymous write without touching the rate limiter', async () => {
		getSessionUserMock.mockResolvedValue(null);
		const res = mkRes();
		await handler(mkReq({ method: 'POST', body: { prefs: { a: 1 } } }), res);
		expect(res.statusCode).toBe(401);
		expect(prefsWriteMock).not.toHaveBeenCalled();
	});

	it('rejects an unsupported method with 405', async () => {
		const res = mkRes();
		await handler(mkReq({ method: 'DELETE' }), res);
		expect(res.statusCode).toBe(405);
	});

	it('short-circuits a CORS preflight with 204', async () => {
		const res = mkRes();
		await handler(mkReq({ method: 'OPTIONS', headers: { origin: 'http://localhost:3000' } }), res);
		expect(res.statusCode).toBe(204);
		expect(res.headers['access-control-allow-methods']).toContain('PATCH');
		expect(sqlMock).not.toHaveBeenCalled();
	});
});

describe('GET', () => {
	it('returns the stored prefs for the session user', async () => {
		sqlQueue = [[{ prefs: { theme: 'dark', tours: { welcome: true } } }]];
		const res = mkRes();
		await handler(mkReq(), res);
		expect(res.statusCode).toBe(200);
		expect(parse(res)).toEqual({ prefs: { theme: 'dark', tours: { welcome: true } } });
		expect(sqlMock.mock.calls[0][1]).toBe(USER);
	});

	it('returns an empty object for a user with no row yet', async () => {
		sqlQueue = [[]];
		const res = mkRes();
		await handler(mkReq(), res);
		expect(parse(res)).toEqual({ prefs: {} });
	});

	it('serves a bearer caller (API key / MCP) with no session cookie', async () => {
		getSessionUserMock.mockResolvedValue(null);
		extractBearerMock.mockReturnValue('sk_live_abc');
		authenticateBearerMock.mockResolvedValue({ userId: USER, scope: '' });
		sqlQueue = [[{ prefs: { compact: true } }]];
		const res = mkRes();
		await handler(mkReq({ headers: { authorization: 'Bearer sk_live_abc' } }), res);
		expect(res.statusCode).toBe(200);
		expect(parse(res)).toEqual({ prefs: { compact: true } });
	});
});

describe('PATCH merge', () => {
	it('merges inside the statement, with no read-modify-write', async () => {
		sqlQueue = [[{ ok: 1 }]];
		const res = mkRes();
		await handler(mkReq({ method: 'PATCH', body: { prefs: { tours: { welcome: true } } } }), res);
		expect(res.statusCode).toBe(200);
		expect(parse(res)).toEqual({ ok: true });
		// Exactly one round trip, and it is the upsert, never a SELECT first.
		expect(sqlMock).toHaveBeenCalledTimes(1);
		const q = queryText(0);
		expect(q).toMatch(/INSERT INTO user_prefs/);
		expect(q).toMatch(/user_prefs\.prefs \|\| EXCLUDED\.prefs/);
		expect(q).not.toMatch(/SELECT/);
		expect(sqlMock.mock.calls[0][1]).toBe(USER);
		expect(JSON.parse(sqlMock.mock.calls[0][2])).toEqual({ tours: { welcome: true } });
	});

	it('guards the size cap in the same statement and 400s when it blocks the update', async () => {
		sqlQueue = [[]]; // DO UPDATE … WHERE matched nothing: merged doc over the cap
		const res = mkRes();
		await handler(mkReq({ method: 'PATCH', body: { prefs: { pad: 'y'.repeat(100) } } }), res);
		expect(res.statusCode).toBe(400);
		expect(parse(res).error).toBe('prefs_too_large');
		expect(queryText(0)).toMatch(/octet_length/);
		expect(sqlMock.mock.calls[0][3]).toBe(16 * 1024);
	});

	it('requires CSRF on the cookie lane', async () => {
		csrfOk.value = false;
		const res = mkRes();
		await handler(mkReq({ method: 'PATCH', body: { prefs: { a: 1 } } }), res);
		expect(res.statusCode).toBe(403);
		expect(sqlMock).not.toHaveBeenCalled();
		expect(prefsWriteMock).not.toHaveBeenCalled();
	});

	it('skips the CSRF check for a bearer caller', async () => {
		getSessionUserMock.mockResolvedValue(null);
		extractBearerMock.mockReturnValue('sk_live_abc');
		authenticateBearerMock.mockResolvedValue({ userId: USER, scope: '' });
		csrfOk.value = false; // would 403 if consulted
		sqlQueue = [[{ ok: 1 }]];
		const res = mkRes();
		await handler(
			mkReq({ method: 'PATCH', headers: { authorization: 'Bearer sk_live_abc' }, body: { prefs: { a: 1 } } }),
			res,
		);
		expect(res.statusCode).toBe(200);
		expect(requireCsrfMock).not.toHaveBeenCalled();
	});

	it('answers 429 when the write limiter is exhausted', async () => {
		rlOk.value = false;
		const res = mkRes();
		await handler(mkReq({ method: 'PATCH', body: { prefs: { a: 1 } } }), res);
		expect(res.statusCode).toBe(429);
		expect(parse(res).error).toBe('rate_limited');
		expect(res.headers['retry-after']).toBeDefined();
		expect(sqlMock).not.toHaveBeenCalled();
	});
});

describe('POST replace', () => {
	it('writes the incoming document verbatim', async () => {
		sqlQueue = [[]];
		const res = mkRes();
		await handler(mkReq({ method: 'POST', body: { prefs: { theme: 'light' } } }), res);
		expect(res.statusCode).toBe(200);
		expect(parse(res)).toEqual({ ok: true });
		const q = queryText(0);
		expect(q).toMatch(/prefs = EXCLUDED\.prefs/);
		expect(q).not.toMatch(/user_prefs\.prefs \|\|/);
		expect(JSON.parse(sqlMock.mock.calls[0][2])).toEqual({ theme: 'light' });
	});
});

describe('input validation', () => {
	it('rejects a non-object prefs value', async () => {
		const res = mkRes();
		await handler(mkReq({ method: 'POST', body: { prefs: 'nope' } }), res);
		expect(res.statusCode).toBe(400);
		expect(parse(res).error).toBe('validation_error');
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('rejects a missing prefs key', async () => {
		const res = mkRes();
		await handler(mkReq({ method: 'POST', body: {} }), res);
		expect(res.statusCode).toBe(400);
		expect(parse(res).error).toBe('validation_error');
	});

	it('rejects a payload over the 16 KB cap before it reaches the database', async () => {
		const res = mkRes();
		await handler(mkReq({ method: 'POST', body: { prefs: { big: 'x'.repeat(20_000) } } }), res);
		expect(res.statusCode).toBe(400);
		expect(parse(res).error_description).toMatch(/exceed 16384 bytes/);
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('rejects a non-JSON content type with 415', async () => {
		const res = mkRes();
		await handler(mkReq({ method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'prefs=1' }), res);
		expect(res.statusCode).toBe(415);
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('rejects malformed JSON with a 400 envelope, not a stack trace', async () => {
		const res = mkRes();
		await handler(mkReq({ method: 'POST', body: '{"prefs":' }), res);
		expect(res.statusCode).toBe(400);
		expect(parse(res).error).toBe('bad_request');
	});
});
