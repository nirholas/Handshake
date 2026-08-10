// Endpoint tests for the /go bounty board handlers: submissions and resolve.
//
// Drives the real handlers with a fake req/res and mocked DB / auth / CSRF /
// rate-limit. http.js (json/cors/method/wrap) runs for real, so status codes
// and the JSON envelope are genuinely exercised.
//
// These pin the boundary behaviour an audit found missing: a non-uuid path
// segment and junk pagination both reached a uuid-typed query and 500'd, a
// signed-out resolve 500'd instead of answering 401, and none of the
// state-changing routes demanded a CSRF token.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Tagged-template `sql` that returns whatever the test queued, in order.
const queue = [];
const sqlCalls = [];
vi.mock('../api/_lib/db.js', () => {
	const sql = vi.fn(async (...args) => {
		sqlCalls.push(args);
		return queue.length ? queue.shift() : [];
	});
	sql.transaction = vi.fn(async (statements) => Promise.all(statements));
	return { sql, isDbUnavailableError: () => false, isDbCapacityError: () => false };
});

let session = null;
vi.mock('../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => session),
	authenticateBearer: vi.fn(async () => null),
	extractBearer: vi.fn(() => null),
}));

let csrfOk = true;
vi.mock('../api/_lib/csrf.js', () => ({
	requireCsrf: vi.fn(async (req, res) => {
		if (csrfOk) return true;
		res.statusCode = 403;
		res.end(JSON.stringify({ error: 'csrf_missing' }));
		return false;
	}),
}));

vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: {
		bountySubmit: vi.fn(async () => ({ success: true, limit: 10, remaining: 9, reset: 0 })),
	},
	clientIp: vi.fn(() => '127.0.0.1'),
}));

vi.mock('../api/_lib/bounty-likes.js', () => ({ enrichLikes: vi.fn(async (rows) => rows) }));

import submissions from '../api/bounties/[id]/submissions.js';
import resolve from '../api/bounties/[id]/resolve.js';

const BID = 'a60e33b7-63b2-496a-bf2c-93b179c619e6';
const SID = '9ffd34d7-4cb7-4573-9fc7-1dd8d1f18528';
const USER = { id: 'cfda5143-fc65-426c-ae82-96628e263adf', display_name: 'qa' };

function mockRes() {
	return {
		statusCode: 200,
		headers: {},
		body: '',
		headersSent: false,
		writableEnded: false,
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = v;
		},
		getHeader(k) {
			return this.headers[k.toLowerCase()];
		},
		end(payload) {
			this.headersSent = true;
			this.writableEnded = true;
			this.body = payload || '';
		},
		get json() {
			try {
				return JSON.parse(this.body);
			} catch {
				return null;
			}
		},
	};
}

function mockReq({ method = 'GET', id = BID, url = null, body = undefined } = {}) {
	const req = {
		method,
		url: url || `/api/bounties/${id}/submissions`,
		query: { id },
		headers: {},
	};
	if (body !== undefined) {
		req.headers['content-type'] = 'application/json';
		req.rawBody = Buffer.from(JSON.stringify(body), 'utf8');
	}
	return req;
}

// Pull the interpolated values of the Nth sql`` call (args after the strings).
function interpolations(n) {
	return sqlCalls[n].slice(1);
}

beforeEach(() => {
	queue.length = 0;
	sqlCalls.length = 0;
	session = null;
	csrfOk = true;
	vi.clearAllMocks();
});

describe('GET /api/bounties/:id/submissions', () => {
	it('404s a non-uuid bounty id without touching the database', async () => {
		const res = mockRes();
		await submissions(mockReq({ id: 'not-a-uuid' }), res);
		expect(res.statusCode).toBe(404);
		expect(res.json.error).toBe('not_found');
		expect(sqlCalls).toHaveLength(0);
	});

	it('falls back to the default page size when limit/offset are unparseable', async () => {
		queue.push([]);
		const res = mockRes();
		await submissions(
			mockReq({ url: `/api/bounties/${BID}/submissions?limit=abc&offset=abc` }),
			res,
		);
		expect(res.statusCode).toBe(200);
		expect(res.json).toEqual({ submissions: [] });
		expect(interpolations(0)).toEqual([BID, 20, 0]);
	});

	it('clamps limit to the 1..50 window', async () => {
		queue.push([]);
		const over = mockRes();
		await submissions(mockReq({ url: `/api/bounties/${BID}/submissions?limit=999` }), over);
		expect(interpolations(0)[1]).toBe(50);

		sqlCalls.length = 0;
		queue.push([]);
		const under = mockRes();
		await submissions(mockReq({ url: `/api/bounties/${BID}/submissions?limit=-5` }), under);
		expect(interpolations(0)[1]).toBe(1);
	});
});

describe('POST /api/bounties/:id/submissions', () => {
	it('401s an anonymous submitter', async () => {
		const res = mockRes();
		await submissions(mockReq({ method: 'POST', body: { content: 'hi' } }), res);
		expect(res.statusCode).toBe(401);
		expect(res.json.error).toBe('unauthorized');
	});

	it('403s without a CSRF token', async () => {
		session = USER;
		csrfOk = false;
		const res = mockRes();
		await submissions(mockReq({ method: 'POST', body: { content: 'hi' } }), res);
		expect(res.statusCode).toBe(403);
	});

	it('rejects a non-http media_url', async () => {
		session = USER;
		queue.push([{ id: BID, status: 'open', expires_at: null }]);
		const res = mockRes();
		await submissions(
			mockReq({ method: 'POST', body: { media_url: 'javascript:alert(1)' } }),
			res,
		);
		expect(res.statusCode).toBe(400);
		expect(res.json.error_description).toMatch(/http\(s\) URL/);
	});

	it('creates the submission and bumps the bounty counter', async () => {
		session = USER;
		queue.push([{ id: BID, status: 'open', expires_at: null }]);
		queue.push([{ id: SID, bounty_id: BID, content: 'proof' }]);
		queue.push([]);
		const res = mockRes();
		await submissions(mockReq({ method: 'POST', body: { content: 'proof' } }), res);
		expect(res.statusCode).toBe(201);
		expect(res.json.submission.id).toBe(SID);
		expect(sqlCalls).toHaveLength(3);
	});
});

describe('POST /api/bounties/:id/resolve', () => {
	function resolveReq(body, id = BID) {
		const req = mockReq({ method: 'POST', id, body });
		req.url = `/api/bounties/${id}/resolve`;
		return req;
	}

	it('401s a signed-out caller instead of throwing on a null session', async () => {
		const res = mockRes();
		await resolve(resolveReq({ submission_id: SID }), res);
		expect(res.statusCode).toBe(401);
		expect(res.json.error).toBe('unauthorized');
		expect(sqlCalls).toHaveLength(0);
	});

	it('404s a non-uuid bounty id without touching the database', async () => {
		session = USER;
		const res = mockRes();
		await resolve(resolveReq({ submission_id: SID }, 'not-a-uuid'), res);
		expect(res.statusCode).toBe(404);
		expect(sqlCalls).toHaveLength(0);
	});

	it('400s a non-uuid submission_id', async () => {
		session = USER;
		queue.push([{ id: BID, user_id: USER.id, status: 'open', reward_sol: '0.01' }]);
		const res = mockRes();
		await resolve(resolveReq({ submission_id: 'junk' }), res);
		expect(res.statusCode).toBe(400);
		expect(res.json.error_description).toMatch(/uuid/);
	});

	it('403s a caller who does not own the bounty', async () => {
		session = { id: 'ad25b0a1-263e-4be7-89f8-adbf0363ee7c' };
		queue.push([{ id: BID, user_id: USER.id, status: 'open', reward_sol: '0.01' }]);
		const res = mockRes();
		await resolve(resolveReq({ submission_id: SID }), res);
		expect(res.statusCode).toBe(403);
	});

	it('409s a bounty that is already resolved', async () => {
		session = USER;
		queue.push([{ id: BID, user_id: USER.id, status: 'closed', reward_sol: '0.01' }]);
		const res = mockRes();
		await resolve(resolveReq({ submission_id: SID }), res);
		expect(res.statusCode).toBe(409);
		expect(res.json.error).toBe('already_closed');
	});

	it('writes the winner, the losers, and the closure in one transaction', async () => {
		session = USER;
		queue.push([{ id: BID, user_id: USER.id, status: 'open', reward_sol: '0.01' }]);
		queue.push([{ id: SID }]);
		queue.push([]);
		queue.push([{ id: SID, status: 'accepted', tx_hash: 'sig' }]);
		queue.push([]);
		const res = mockRes();
		await resolve(resolveReq({ submission_id: SID, tx_hash: ' sig ' }), res);
		expect(res.statusCode).toBe(200);
		expect(res.json.winner).toEqual({ id: SID, status: 'accepted', tx_hash: 'sig' });

		const { sql } = await import('../api/_lib/db.js');
		expect(sql.transaction).toHaveBeenCalledOnce();
		expect(sql.transaction.mock.calls[0][0]).toHaveLength(3);
	});
});
