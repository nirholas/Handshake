// Tests for /api/auth/persona/* — token issuance, verification, jwks,
// tenant-origin allowlist. DB + r2 are mocked.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Readable } from 'node:stream';

// ── Env (must be set before the handler imports `env`) ────────────────────
process.env.PUBLIC_APP_ORIGIN = 'https://three.ws';
process.env.JWT_SECRET = 'test-secret-must-be-long-enough-32bytes!!';
process.env.JWT_KID = 'k-test';

// ── Mocks ─────────────────────────────────────────────────────────────────

const authState = { session: null };
vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => authState.session),
}));

const sqlState = { queue: [] };
vi.mock('../../api/_lib/db.js', () => ({
	sql: vi.fn(async () => {
		if (sqlState.queue.length === 0) return [];
		return sqlState.queue.shift();
	}),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

vi.mock('../../api/_lib/r2.js', () => ({
	publicUrl: (key) => `https://cdn.three.ws/${key}`,
	// thumbnailUrl mirrors r2.js: null for a missing key or the legacy *_og.png form.
	thumbnailUrl: (key) =>
		!key || /^https?:\/\/.*_og\.png$/i.test(key) ? null : `https://cdn.three.ws/${key}`,
}));

vi.mock('../../api/_lib/crypto.js', () => ({
	randomToken: (n) => 'r'.repeat(n),
}));

const { default: handler } = await import('../../api/auth/persona/[action].js');

// ── Helpers ───────────────────────────────────────────────────────────────

function makeReq({ method = 'GET', url = '/', query = {}, body = null } = {}) {
	const base = body ? Readable.from([Buffer.from(JSON.stringify(body))]) : Readable.from([]);
	base.method = method;
	base.url = url;
	base.query = query;
	base.headers = {
		host: 'three.ws',
		...(body ? { 'content-type': 'application/json' } : {}),
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

async function invoke({ action, ...reqOpts }) {
	const reqQuery = reqOpts.query || {};
	// The handler reads `action` from `req.query` (Vercel populates it from
	// the `[action].js` slug) but reads token/audience via `new URL(req.url)`.
	// Encode the latter into the URL so both code paths see the values.
	const qs = new URLSearchParams(reqQuery).toString();
	const url = qs ? `/?${qs}` : '/';
	const req = makeReq({ ...reqOpts, url, query: { action, ...reqQuery } });
	const res = makeRes();
	await handler(req, res);
	const payload = res.body ? JSON.parse(res.body) : null;
	return { res, status: res.statusCode, body: payload };
}

beforeEach(() => {
	authState.session = null;
	sqlState.queue = [];
});

// ── Tests ─────────────────────────────────────────────────────────────────

describe('POST /api/auth/persona/issue', () => {
	it('rejects unauthenticated callers with 401', async () => {
		const { status, body } = await invoke({
			action: 'issue',
			method: 'POST',
			body: { tenant_origin: 'https://demo.three.ws' },
		});
		expect(status).toBe(401);
		expect(body.error).toBe('unauthorized');
	});

	it('rejects an arbitrary tenant origin (not on three.ws)', async () => {
		authState.session = { id: 'user-1' };
		const { status, body } = await invoke({
			action: 'issue',
			method: 'POST',
			body: { tenant_origin: 'https://evil.example' },
		});
		expect(status).toBe(400);
		expect(body.error).toBe('invalid_request');
		expect(body.error_description).toContain('three.ws');
	});

	it('rejects a tenant origin with a path / query / hash', async () => {
		authState.session = { id: 'user-1' };
		for (const bad of [
			'https://demo.three.ws/foo',
			'https://demo.three.ws/?x=1',
			'https://demo.three.ws/#h',
		]) {
			const { status } = await invoke({
				action: 'issue',
				method: 'POST',
				body: { tenant_origin: bad },
			});
			expect(status).toBe(400);
		}
	});

	it('accepts localhost dev origins on http', async () => {
		authState.session = { id: 'user-1' };
		sqlState.queue.push([{ id: 'a-1', name: 'Av', storage_key: 'u/1/a.glb', thumbnail_key: null }]);
		const { status, body } = await invoke({
			action: 'issue',
			method: 'POST',
			body: { tenant_origin: 'http://localhost:3000' },
		});
		expect(status).toBe(200);
		expect(body.tenant_origin).toBe('http://localhost:3000');
	});

	it('returns 404 when the user has no avatar', async () => {
		authState.session = { id: 'user-1' };
		sqlState.queue.push([]);
		const { status, body } = await invoke({
			action: 'issue',
			method: 'POST',
			body: { tenant_origin: 'https://demo.three.ws' },
		});
		expect(status).toBe(404);
		expect(body.error).toBe('no_avatar');
	});

	it('issues a 24h HS256 token when no persona keypair is configured', async () => {
		authState.session = { id: 'user-1' };
		sqlState.queue.push([
			{ id: 'a-1', name: 'My Avatar', storage_key: 'u/1/a.glb', thumbnail_key: null },
		]);
		const { status, body } = await invoke({
			action: 'issue',
			method: 'POST',
			body: { tenant_origin: 'https://demo.three.ws' },
		});
		expect(status).toBe(200);
		expect(body.token).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
		expect(body.expires_in).toBe(60 * 60 * 24);
		expect(body.avatar).toEqual({
			id: 'a-1',
			name: 'My Avatar',
			url: 'https://cdn.three.ws/u/1/a.glb',
			thumbnail_url: null,
		});
		expect(body.alg).toBe('HS256');
	});

	it('issues a token bound to a specific avatar id when provided', async () => {
		authState.session = { id: 'user-1' };
		sqlState.queue.push([
			{
				id: 'a-2',
				name: 'Other',
				storage_key: 'u/1/other.glb',
				thumbnail_key: 'u/1/other.png',
			},
		]);
		const { status, body } = await invoke({
			action: 'issue',
			method: 'POST',
			body: { tenant_origin: 'https://demo.three.ws', avatar_id: 'a-2' },
		});
		expect(status).toBe(200);
		expect(body.avatar.id).toBe('a-2');
		expect(body.avatar.thumbnail_url).toBe('https://cdn.three.ws/u/1/other.png');
	});
});

describe('GET /api/auth/persona/verify', () => {
	it('rejects a missing token', async () => {
		const { status, body } = await invoke({
			action: 'verify',
			query: { audience: 'https://demo.three.ws' },
		});
		expect(status).toBe(400);
		expect(body.error_description).toContain('token');
	});

	it('rejects a missing audience', async () => {
		const { status, body } = await invoke({
			action: 'verify',
			query: { token: 'abc' },
		});
		expect(status).toBe(400);
		expect(body.error_description).toContain('audience');
	});

	it('round-trips an issued token: issue then verify with matching audience', async () => {
		authState.session = { id: 'user-1' };
		sqlState.queue.push([
			{ id: 'a-1', name: 'Av', storage_key: 'u/1/a.glb', thumbnail_key: null },
		]);
		const issue = await invoke({
			action: 'issue',
			method: 'POST',
			body: { tenant_origin: 'https://demo.three.ws' },
		});
		expect(issue.status).toBe(200);

		const verify = await invoke({
			action: 'verify',
			query: { token: issue.body.token, audience: 'https://demo.three.ws' },
		});
		expect(verify.status).toBe(200);
		expect(verify.body.ok).toBe(true);
		expect(verify.body.sub).toBe('user-1');
		expect(verify.body.aud).toBe('https://demo.three.ws');
		expect(verify.body.avatar.id).toBe('a-1');
		expect(verify.body.scope).toBe('persona:read avatar:read');
	});

	it('rejects a token whose audience does not match the requested audience', async () => {
		authState.session = { id: 'user-1' };
		sqlState.queue.push([
			{ id: 'a-1', name: 'Av', storage_key: 'u/1/a.glb', thumbnail_key: null },
		]);
		const issue = await invoke({
			action: 'issue',
			method: 'POST',
			body: { tenant_origin: 'https://demo.three.ws' },
		});
		const verify = await invoke({
			action: 'verify',
			query: { token: issue.body.token, audience: 'https://evil.three.ws' },
		});
		expect(verify.status).toBe(401);
		expect(verify.body.error).toBe('invalid_token');
	});

	it('rejects garbage tokens', async () => {
		const { status, body } = await invoke({
			action: 'verify',
			query: { token: 'not-a-jwt', audience: 'https://demo.three.ws' },
		});
		expect(status).toBe(401);
		expect(body.error).toBe('invalid_token');
	});
});

describe('GET /api/auth/persona/me', () => {
	it('requires a session', async () => {
		const { status, body } = await invoke({ action: 'me' });
		expect(status).toBe(401);
		expect(body.error).toBe('unauthorized');
	});

	it('returns the user’s avatars when signed in', async () => {
		authState.session = { id: 'user-1', email: 'u@three.ws' };
		sqlState.queue.push([
			{
				id: 'a-1',
				name: 'A',
				storage_key: 'u/1/a.glb',
				thumbnail_key: null,
				created_at: '2026-05-17',
				visibility: 'public',
			},
			{
				id: 'a-2',
				name: 'B',
				storage_key: 'u/1/b.glb',
				thumbnail_key: 'u/1/b.png',
				created_at: '2026-05-16',
				visibility: 'private',
			},
		]);
		const { status, body } = await invoke({ action: 'me' });
		expect(status).toBe(200);
		expect(body.user.email).toBe('u@three.ws');
		expect(body.avatars).toHaveLength(2);
		expect(body.avatars[1].thumbnail_url).toBe('https://cdn.three.ws/u/1/b.png');
	});
});

describe('GET /.well-known/jwks.json (action=jwks)', () => {
	it('returns an empty key set when no persona keypair is configured', async () => {
		// Make sure no env key is set.
		delete process.env.PERSONA_JWKS_PRIVATE_KEY_PEM;
		const { status, body, res } = await invoke({ action: 'jwks' });
		expect(status).toBe(200);
		expect(body.keys).toEqual([]);
		expect(res.headers['x-three-ws-status']).toContain('HS256');
	});
});

describe('dispatcher', () => {
	it('returns 404 for unknown actions', async () => {
		const { status, body } = await invoke({ action: 'who' });
		expect(status).toBe(404);
		expect(body.error).toBe('not_found');
	});
});
