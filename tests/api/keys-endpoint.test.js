import { describe, it, expect, beforeEach, vi } from 'vitest';
import { invoke } from '../_helpers/monetization.js';

// Contract pins for the developer API key endpoints (api/keys).
//
// Two behaviours here were live defects found by probing the deployed handlers:
//   1. DELETE /api/keys/<non-uuid> handed a malformed id straight to Postgres.
//      api_keys.id is a uuid column, so 22P02 surfaced to the caller as a 500
//      with a support ref for what is plainly bad input.
//   2. List, create, and revoke shared one 30/hour bucket, so the dashboard's
//      list-on-load traffic could exhaust the budget and then refuse a revoke,
//      locking an owner out of killing a leaked key.
// Each is pinned below, alongside the ordinary success and auth paths.

const authState = { session: null };
const sqlState = { queue: [], calls: [] };
const rlState = { calls: [], fail: new Set() };

vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => authState.session),
	authenticateBearer: vi.fn(async () => null),
	extractBearer: vi.fn(() => null),
}));

vi.mock('../../api/_lib/db.js', () => {
	const sql = vi.fn(async (strings, ...values) => {
		sqlState.calls.push({
			query: Array.isArray(strings) ? strings.join('?') : String(strings),
			values,
		});
		return sqlState.queue.length ? sqlState.queue.shift() : [];
	});
	return { sql, isDbUnavailableError: () => false, isDbCapacityError: () => false };
});

function limiter(name) {
	return vi.fn(async () => {
		rlState.calls.push(name);
		return rlState.fail.has(name)
			? { success: false, limit: 1, remaining: 0, reset: Date.now() + 1000 }
			: { success: true, limit: 100, remaining: 99, reset: Date.now() + 1000 };
	});
}

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		apiKeyManage: limiter('manage'),
		apiKeyList: limiter('list'),
		apiKeyRevoke: limiter('revoke'),
	},
	clientIp: vi.fn(() => '127.0.0.1'),
}));

vi.mock('../../api/_lib/csrf.js', () => ({ requireCsrf: vi.fn(async () => true) }));

const auditState = { entries: [] };
vi.mock('../../api/_lib/audit.js', () => ({
	logAudit: vi.fn((entry) => {
		auditState.entries.push(entry);
	}),
}));

const { default: keysHandler } = await import('../../api/keys/index.js');
const { default: revokeHandler } = await import('../../api/keys/[id].js');

const USER = { id: 'user-1' };
const KEY_ID = '2c25ec0c-f1a3-475d-9a9f-fe926c832db5';

beforeEach(() => {
	authState.session = { ...USER };
	sqlState.queue = [];
	sqlState.calls = [];
	rlState.calls = [];
	rlState.fail = new Set();
	auditState.entries = [];
});

describe('GET /api/keys', () => {
	it('returns the caller keys without any secret material', async () => {
		sqlState.queue.push([
			{
				id: KEY_ID,
				name: 'prod server',
				prefix: 'sk_live_abcd',
				scope: 'avatars:read',
				last_used_at: null,
				expires_at: null,
				revoked_at: null,
				created_at: '2026-08-13T01:04:36.801Z',
			},
		]);
		const { status, body } = await invoke(keysHandler, { method: 'GET', url: '/api/keys' });
		expect(status).toBe(200);
		expect(body.keys).toHaveLength(1);
		expect(body.keys[0].id).toBe(KEY_ID);
		expect(JSON.stringify(body)).not.toMatch(/token_hash|secret/);
		// Scoped to the caller, never a bare select over every user's keys.
		expect(sqlState.calls[0].values).toContain(USER.id);
	});

	it('reads on the list bucket, never the mint bucket', async () => {
		await invoke(keysHandler, { method: 'GET', url: '/api/keys' });
		expect(rlState.calls).toEqual(['list']);
	});

	it('401s an anonymous caller before touching the database', async () => {
		authState.session = null;
		const { status, body } = await invoke(keysHandler, { method: 'GET', url: '/api/keys' });
		expect(status).toBe(401);
		expect(body.error).toBe('unauthorized');
		expect(sqlState.calls).toHaveLength(0);
	});

	it('surfaces a 429 with retry metadata when the list bucket is spent', async () => {
		rlState.fail = new Set(['list']);
		const { status, res } = await invoke(keysHandler, { method: 'GET', url: '/api/keys' });
		expect(status).toBe(429);
		expect(res.headers['retry-after']).toBeDefined();
	});
});

describe('POST /api/keys', () => {
	it('mints a key, returns the secret once, and records the issuance', async () => {
		sqlState.queue.push([
			{
				id: KEY_ID,
				name: 'ci runner',
				prefix: 'sk_test_abcd',
				scope: 'avatars:read',
				expires_at: null,
				created_at: '2026-08-13T01:04:36.801Z',
			},
		]);
		const { status, body } = await invoke(keysHandler, {
			method: 'POST',
			url: '/api/keys',
			body: { name: 'ci runner', scope: 'avatars:read', environment: 'test' },
		});
		expect(status).toBe(201);
		expect(body.key.secret).toMatch(/^sk_test_/);
		expect(rlState.calls).toEqual(['manage']);
		const audit = auditState.entries.find((e) => e.action === 'create_api_key');
		expect(audit).toBeTruthy();
		expect(audit.resourceId).toBe(KEY_ID);
		// The trail records which key was minted, never the credential itself.
		expect(JSON.stringify(audit)).not.toContain(body.key.secret);
	});

	it('rejects an unknown scope with a 400 and writes nothing', async () => {
		const { status, body } = await invoke(keysHandler, {
			method: 'POST',
			url: '/api/keys',
			body: { name: 'bad', scope: 'avatars:read bogus:scope' },
		});
		expect(status).toBe(400);
		expect(body.error).toBe('validation_error');
		expect(body.error_description).toContain('bogus:scope');
		expect(sqlState.calls).toHaveLength(0);
	});

	it('rejects an explicitly empty scope instead of minting a powerless key', async () => {
		const { status, body } = await invoke(keysHandler, {
			method: 'POST',
			url: '/api/keys',
			body: { name: 'scopeless', scope: '   ' },
		});
		expect(status).toBe(400);
		expect(body.error).toBe('validation_error');
		expect(sqlState.calls).toHaveLength(0);
	});

	it('applies the default scope when the field is omitted entirely', async () => {
		sqlState.queue.push([{ id: KEY_ID, name: 'defaults', prefix: 'sk_live_abcd', scope: '', expires_at: null, created_at: '2026-08-13T01:04:36.801Z' }]);
		await invoke(keysHandler, { method: 'POST', url: '/api/keys', body: { name: 'defaults' } });
		expect(sqlState.calls[0].values).toContain('avatars:read avatars:write');
	});

	it('stores a repeated scope once', async () => {
		sqlState.queue.push([{ id: KEY_ID, name: 'dupes', prefix: 'sk_live_abcd', scope: '', expires_at: null, created_at: '2026-08-13T01:04:36.801Z' }]);
		await invoke(keysHandler, {
			method: 'POST',
			url: '/api/keys',
			body: { name: 'dupes', scope: 'avatars:read avatars:read profile' },
		});
		expect(sqlState.calls[0].values).toContain('avatars:read profile');
	});

	it('rejects a missing name with a structured 400', async () => {
		const { status, body } = await invoke(keysHandler, {
			method: 'POST',
			url: '/api/keys',
			body: {},
		});
		expect(status).toBe(400);
		expect(body.error).toBe('validation_error');
		expect(sqlState.calls).toHaveLength(0);
	});
});

describe('DELETE /api/keys/:id', () => {
	it('revokes the caller key and records the revocation', async () => {
		sqlState.queue.push([{ id: KEY_ID }]);
		const { status, body } = await invoke(revokeHandler, {
			method: 'DELETE',
			url: `/api/keys/${KEY_ID}`,
			query: { id: KEY_ID },
		});
		expect(status).toBe(200);
		expect(body.ok).toBe(true);
		expect(rlState.calls).toEqual(['revoke']);
		expect(auditState.entries.some((e) => e.action === 'revoke_api_key')).toBe(true);
	});

	it('rejects a non-uuid id with a 400 instead of a 500, and issues no query', async () => {
		const { status, body } = await invoke(revokeHandler, {
			method: 'DELETE',
			url: '/api/keys/not-a-uuid',
			query: { id: 'not-a-uuid' },
		});
		expect(status).toBe(400);
		expect(body.error).toBe('invalid_id');
		expect(sqlState.calls).toHaveLength(0);
	});

	it('404s a key that belongs to someone else or is already revoked', async () => {
		sqlState.queue.push([]);
		const { status, body } = await invoke(revokeHandler, {
			method: 'DELETE',
			url: `/api/keys/${KEY_ID}`,
			query: { id: KEY_ID },
		});
		expect(status).toBe(404);
		expect(body.error).toBe('not_found');
		expect(auditState.entries).toHaveLength(0);
	});

	it('401s an anonymous caller before touching the database', async () => {
		authState.session = null;
		const { status, body } = await invoke(revokeHandler, {
			method: 'DELETE',
			url: `/api/keys/${KEY_ID}`,
			query: { id: KEY_ID },
		});
		expect(status).toBe(401);
		expect(body.error).toBe('unauthorized');
		expect(sqlState.calls).toHaveLength(0);
	});

	it('rejects a method other than DELETE', async () => {
		const { status } = await invoke(revokeHandler, {
			method: 'GET',
			url: `/api/keys/${KEY_ID}`,
			query: { id: KEY_ID },
		});
		expect(status).toBe(405);
	});
});
