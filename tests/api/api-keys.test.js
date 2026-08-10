import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Readable } from 'node:stream';

// ── Mocks ─────────────────────────────────────────────────────────────────

const authState = {
	session: null,
	bearer: null,
};

vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => authState.session),
	authenticateBearer: vi.fn(async () => authState.bearer),
	extractBearer: vi.fn(() => null),
	hasScope: vi.fn((scope, needed) => {
		if (!scope) return false;
		return scope.split(/\s+/).includes(needed);
	}),
}));

const sqlState = {
	queue: [],
	calls: [],
};

vi.mock('../../api/_lib/db.js', () => ({
	sql: vi.fn(async (strings, ...values) => {
		sqlState.calls.push({ query: strings.join('?'), values });
		if (sqlState.queue.length === 0) return [];
		return sqlState.queue.shift();
	}),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

const rlState = { success: true };

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		authIp: vi.fn(async () => ({ success: rlState.success })),
	},
	clientIp: vi.fn(() => '127.0.0.1'),
}));

vi.mock('../../api/_lib/csrf.js', () => ({
	requireCsrf: vi.fn(async () => true),
	issueCsrf: vi.fn(async () => ({ token: 'mock-csrf', expiresIn: 3600 })),
}));

const { default: handler } = await import('../../api/api-keys.js');
const { default: revokeHandler } = await import('../../api/api-keys/[id].js');

// ── Helpers ───────────────────────────────────────────────────────────────

function makeReq({ method = 'GET', url = '/api/api-keys', headers = {}, body = null } = {}) {
	const base = body ? Readable.from([Buffer.from(JSON.stringify(body))]) : Readable.from([]);
	base.method = method;
	base.url = url;
	base.headers = {
		host: 'localhost',
		...(body ? { 'content-type': 'application/json' } : {}),
		...headers,
	};
	return base;
}

function makeRes() {
	return {
		statusCode: 200,
		headers: {},
		body: '',
		writableEnded: false,
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = v;
		},
		end(chunk) {
			if (chunk !== undefined) this.body += chunk;
			this.writableEnded = true;
		},
	};
}

async function invoke(reqOpts) {
	const req = makeReq(reqOpts);
	const res = makeRes();
	await handler(req, res);
	const payload = res.body ? JSON.parse(res.body) : null;
	return { res, status: res.statusCode, body: payload };
}

// Revoke lives at api/api-keys/[id].js. Vercel populates req.query from the
// dynamic route segment; replicate that here since makeReq only models the body.
async function invokeRevoke({ id, ...reqOpts } = {}) {
	const req = makeReq({ method: 'DELETE', url: `/api/api-keys/${id}`, ...reqOpts });
	req.query = { id };
	const res = makeRes();
	await revokeHandler(req, res);
	const payload = res.body ? JSON.parse(res.body) : null;
	return { res, status: res.statusCode, body: payload };
}

beforeEach(() => {
	authState.session = null;
	authState.bearer = null;
	sqlState.queue = [];
	sqlState.calls = [];
	rlState.success = true;
});

// ── Tests ─────────────────────────────────────────────────────────────────

describe('GET /api/api-keys — list', () => {
	it('returns 401 when unauthenticated', async () => {
		const { status, body } = await invoke({ method: 'GET' });
		expect(status).toBe(401);
		expect(body.error).toBe('unauthorized');
	});

	it('does NOT return raw tokens (token_hash column not selected)', async () => {
		authState.session = { id: 'user-1' };
		sqlState.queue.push([
			{
				id: 'k1',
				name: 'My key',
				prefix: 'sk_live_abc123',
				scope: 'avatars:read avatars:write',
				last_used_at: null,
				expires_at: null,
				revoked_at: null,
				created_at: '2024-01-01T00:00:00Z',
			},
		]);

		const { status, body } = await invoke({ method: 'GET' });

		expect(status).toBe(200);
		expect(body.data).toHaveLength(1);
		expect(body.data[0].id).toBe('k1');
		// No raw `token` field, no token_hash
		expect(body.data[0].token).toBeUndefined();
		expect(body.data[0].token_hash).toBeUndefined();
		// Raw-token strings must never appear in the response
		const serialized = JSON.stringify(body);
		expect(serialized).not.toMatch(/sk_live_[a-f0-9]{32,}/);

		// Verify the SELECT doesn't include token_hash
		const selectCall = sqlState.calls[0];
		expect(selectCall.query).not.toMatch(/token_hash/);
	});
});

describe('POST /api/api-keys — create', () => {
	it('returns 401 when unauthenticated', async () => {
		const { status, body } = await invoke({
			method: 'POST',
			body: { name: 'New key' },
		});
		expect(status).toBe(401);
		expect(body.error).toBe('unauthorized');
	});

	it('returns the raw token exactly once on creation', async () => {
		authState.session = { id: 'user-2' };
		sqlState.queue.push([
			{
				id: 'k2',
				name: 'Publish',
				prefix: 'sk_live_xxxxxx',
				scope: 'avatars:read avatars:write',
				expires_at: null,
				created_at: '2024-01-01T00:00:00Z',
			},
		]);

		const { status, body } = await invoke({
			method: 'POST',
			body: { name: 'Publish' },
		});

		expect(status).toBe(201);
		expect(body.data.id).toBe('k2');
		expect(typeof body.data.token).toBe('string');
		expect(body.data.token).toMatch(/^sk_live_[A-Za-z0-9_-]+$/);
		expect(body.data.token.length).toBeGreaterThan(20);

		// The INSERT must persist a hash, never the raw token
		const insertCall = sqlState.calls.find((c) => /insert into api_keys/i.test(c.query));
		expect(insertCall).toBeTruthy();
		for (const v of insertCall.values) {
			expect(v).not.toBe(body.data.token);
		}
	});

	it('rejects unknown scopes with 400', async () => {
		authState.session = { id: 'user-3' };
		const { status, body } = await invoke({
			method: 'POST',
			body: { name: 'Bad', scope: 'avatars:read bogus:scope' },
		});
		expect(status).toBe(400);
		expect(body.error).toBe('validation_error');
	});
});

describe('method routing', () => {
	it('rejects PUT with 405', async () => {
		const { status, body } = await invoke({ method: 'PUT' });
		expect(status).toBe(405);
		expect(body.error).toBe('method_not_allowed');
	});

	it('short-circuits OPTIONS (CORS preflight) with 204', async () => {
		const { status } = await invoke({
			method: 'OPTIONS',
			headers: { origin: 'http://localhost:3000' },
		});
		expect(status).toBe(204);
	});
});

// api_keys.id is a uuid column and the handler rejects anything else with a
// 400 before it reaches Postgres, so the revoke tests use real uuids.
const KEY_ID = '9f2b6d41-6c1b-4a0e-9a5f-2f0c9c4d7b31';

describe('DELETE /api/api-keys/:id — revoke 200', () => {
	it('returns 401 when unauthenticated', async () => {
		const { status, body } = await invokeRevoke({ id: KEY_ID });
		expect(status).toBe(401);
		expect(body.error).toBe('unauthorized');
	});

	it('revokes the owner’s live key and returns { id, revoked: true }', async () => {
		authState.session = { id: 'user-1' };
		// UPDATE ... returning id — one row means the live key was found + revoked.
		sqlState.queue.push([{ id: KEY_ID }]);

		const { status, body } = await invokeRevoke({ id: KEY_ID });

		expect(status).toBe(200);
		expect(body.data).toEqual({ id: KEY_ID, revoked: true });

		// The UPDATE must scope to the owner and only touch live keys, so a key
		// can't be revoked by a non-owner or revoked twice.
		const updateCall = sqlState.calls.find((c) => /update api_keys/i.test(c.query));
		expect(updateCall).toBeTruthy();
		expect(updateCall.query).toMatch(/set revoked_at = now\(\)/i);
		expect(updateCall.query).toMatch(/user_id =/i);
		expect(updateCall.query).toMatch(/revoked_at is null/i);
		expect(updateCall.values).toContain(KEY_ID);
		expect(updateCall.values).toContain('user-1');
	});

	it('omits the revoked key from the subsequent list (filtered by revoked_at is null)', async () => {
		authState.session = { id: 'user-1' };

		// Revoke the live key.
		sqlState.queue.push([{ id: KEY_ID }]);
		const revoke = await invokeRevoke({ id: KEY_ID });
		expect(revoke.status).toBe(200);

		// The list endpoint filters on `revoked_at is null`, so the revoked key
		// no longer comes back.
		sqlState.queue.push([]);
		const list = await invoke({ method: 'GET' });
		expect(list.status).toBe(200);
		expect(list.body.data).toEqual([]);

		const selectCall = sqlState.calls.find((c) => /select[\s\S]*from api_keys/i.test(c.query));
		expect(selectCall).toBeTruthy();
		expect(selectCall.query).toMatch(/revoked_at is null/i);
	});

	it('returns 404 when the same key is revoked again', async () => {
		authState.session = { id: 'user-1' };

		// First revoke succeeds.
		sqlState.queue.push([{ id: KEY_ID }]);
		const first = await invokeRevoke({ id: KEY_ID });
		expect(first.status).toBe(200);

		// Second revoke: the `revoked_at is null` guard matches nothing → no row.
		sqlState.queue.push([]);
		const second = await invokeRevoke({ id: KEY_ID });
		expect(second.status).toBe(404);
		expect(second.body.error).toBe('not_found');
	});
});

describe('DELETE /api/api-keys/:id — malformed id', () => {
	// api_keys.id is a uuid column, so a non-uuid segment used to reach Postgres
	// and come back as 22P02 → 500 with a support ref. Bad input is a 400.
	it.each(['not-a-uuid', ' ', '', "'; drop table api_keys; --"])(
		'returns 400 for %j without touching the database',
		async (id) => {
			authState.session = { id: 'user-1' };

			const { status, body } = await invokeRevoke({ id });

			expect(status).toBe(400);
			expect(body.error).toBe('invalid_id');
			expect(sqlState.calls.find((c) => /update api_keys/i.test(c.query))).toBeUndefined();
		},
	);

	it('returns 400 when the id segment is missing entirely', async () => {
		authState.session = { id: 'user-1' };
		const req = makeReq({ method: 'DELETE', url: '/api/api-keys/' });
		req.query = {};
		const res = makeRes();
		await revokeHandler(req, res);

		expect(res.statusCode).toBe(400);
		expect(JSON.parse(res.body).error).toBe('invalid_id');
	});
});

describe('DELETE /api/api-keys/:id — 404 unknown id', () => {
	it('returns 404 for a well-formed but non-existent id', async () => {
		authState.session = { id: 'user-1' };
		// UPDATE matches no row → empty result.
		sqlState.queue.push([]);

		const { status, body } = await invokeRevoke({ id: '00000000-0000-4000-8000-000000000000' });
		expect(status).toBe(404);
		expect(body.error).toBe('not_found');
	});

	it('returns 404 for another user’s key (ownership scoping)', async () => {
		// user-2 attempts to revoke a key owned by user-1: the `user_id` predicate
		// excludes it, so the UPDATE affects no row.
		authState.session = { id: 'user-2' };
		sqlState.queue.push([]);

		const { status, body } = await invokeRevoke({ id: KEY_ID });
		expect(status).toBe(404);
		expect(body.error).toBe('not_found');

		// Confirm the requester's id (not the owner's) scopes the query.
		const updateCall = sqlState.calls.find((c) => /update api_keys/i.test(c.query));
		expect(updateCall.values).toContain('user-2');
	});
});
