// Tests for the personal-access-token route into GitHub memory seeding.
//
// The token path exists because OAuth is not always available: it needs an
// operator to register a GitHub OAuth app, and until that happens /connect can
// only answer 501. What is covered here is the part that makes the token path
// safe to offer: the scope policy that refuses a token carrying more access than
// seeding can use, and the disconnect that must not claim a GitHub-side
// revocation it never performed.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	classifyTokenScopes,
	looksLikeGithubToken,
	encryptGithubToken,
	ALLOWED_TOKEN_SCOPES,
} from '../api/_lib/github-token.js';

// ── Pure scope policy ─────────────────────────────────────────────────────────

describe('classifyTokenScopes', () => {
	it('treats a missing header as a fine-grained token and accepts it', () => {
		// Fine-grained tokens and GitHub App user tokens omit x-oauth-scopes
		// entirely; their permissions were already narrowed at creation.
		expect(classifyTokenScopes(null)).toEqual({
			kind: 'fine_grained',
			scopes: [],
			allowed: true,
			refused: [],
		});
		expect(classifyTokenScopes(undefined).kind).toBe('fine_grained');
	});

	it('accepts a no-scope classic token', () => {
		// A scopeless classic PAT still reads public data, which is all the
		// catalog is ever built from.
		const out = classifyTokenScopes('');
		expect(out).toEqual({ kind: 'classic', scopes: [], allowed: true, refused: [] });
	});

	it('accepts the scopes seeding actually uses', () => {
		const out = classifyTokenScopes('read:user, public_repo');
		expect(out.allowed).toBe(true);
		expect(out.scopes).toEqual(['read:user', 'public_repo']);
		expect(out.refused).toEqual([]);
	});

	it('refuses full repo access, which reaches private repositories', () => {
		// The catalog is public-only by construction, so `repo` is strictly more
		// access than the feature can ever use.
		const out = classifyTokenScopes('read:user, repo');
		expect(out.allowed).toBe(false);
		expect(out.refused).toEqual(['repo']);
	});

	it('refuses destructive and admin scopes and names every one of them', () => {
		const out = classifyTokenScopes('delete_repo, admin:org, workflow, read:user');
		expect(out.allowed).toBe(false);
		expect(out.refused).toEqual(['delete_repo', 'admin:org', 'workflow']);
	});

	it('is an allowlist, so a scope GitHub invents later is refused by default', () => {
		const out = classifyTokenScopes('some:future_scope');
		expect(out.allowed).toBe(false);
		expect(out.refused).toEqual(['some:future_scope']);
		expect(ALLOWED_TOKEN_SCOPES).not.toContain('some:future_scope');
	});

	it('never contains a scope that grants private repository access', () => {
		expect(ALLOWED_TOKEN_SCOPES).not.toContain('repo');
		expect(ALLOWED_TOKEN_SCOPES).not.toContain('delete_repo');
		expect(ALLOWED_TOKEN_SCOPES.some((s) => s.startsWith('admin:'))).toBe(false);
		expect(ALLOWED_TOKEN_SCOPES.some((s) => s.startsWith('write:'))).toBe(false);
	});
});

describe('looksLikeGithubToken', () => {
	it('accepts realistic token shapes', () => {
		expect(looksLikeGithubToken('ghp_' + 'a'.repeat(36))).toBe(true);
		expect(looksLikeGithubToken('github_pat_' + 'b'.repeat(60))).toBe(true);
		expect(looksLikeGithubToken('  ghu_' + 'c'.repeat(36) + '  ')).toBe(true);
	});

	it('rejects input that cannot be a token at all', () => {
		expect(looksLikeGithubToken('')).toBe(false);
		expect(looksLikeGithubToken('short')).toBe(false);
		expect(looksLikeGithubToken('ghp_with a space in it padding padding')).toBe(false);
		expect(looksLikeGithubToken('x'.repeat(256))).toBe(false);
		expect(looksLikeGithubToken(null)).toBe(false);
		expect(looksLikeGithubToken(12345)).toBe(false);
	});
});

// ── Route ─────────────────────────────────────────────────────────────────────

const sqlMock = vi.fn();
sqlMock.transaction = vi.fn(async () => []);
vi.mock('../api/_lib/db.js', () => ({
	sql: sqlMock,
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

const getSessionUserMock = vi.fn();
vi.mock('../api/_lib/auth.js', () => ({
	getSessionUser: (...a) => getSessionUserMock(...a),
}));

const requireCsrfMock = vi.fn();
vi.mock('../api/_lib/csrf.js', () => ({ requireCsrf: (...a) => requireCsrfMock(...a) }));

// Hoisted so the module mock below can close over it: this file statically
// imports github-token.js, which pulls env.js in before a plain const would be
// initialised.
const envMock = vi.hoisted(() => ({
	APP_ORIGIN: 'http://localhost:3000',
	ISSUER: 'http://t',
	MCP_RESOURCE: 'http://t',
	JWT_SECRET: 'test-secret-value-for-hkdf-derivation',
	GITHUB_OAUTH_CLIENT_ID: '',
	GITHUB_OAUTH_CLIENT_SECRET: '',
}));
vi.mock('../api/_lib/env.js', () => ({ env: envMock }));

vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: { authIp: async () => ({ success: true, limit: 30, remaining: 29, reset: Date.now() + 60_000 }) },
	clientIp: () => '127.0.0.1',
}));

const verifyTokenMock = vi.fn();
const revokeGrantMock = vi.fn();
vi.mock('../api/_lib/github-api.js', () => ({
	verifyToken: (...a) => verifyTokenMock(...a),
	revokeGrant: (...a) => revokeGrantMock(...a),
}));

const { default: handler } = await import('../api/auth/github/[action].js');

const USER = '55555555-5555-4555-8555-555555555555';

function mkReq({ method = 'POST', action = 'token', body = null, headers = {} } = {}) {
	return {
		method,
		url: `/api/auth/github/${action}?action=${action}`,
		headers: { 'content-type': 'application/json', ...headers },
		on(event, cb) {
			if (event === 'data' && body != null) {
				const buf = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
				queueMicrotask(() => {
					cb(buf);
					this._endCb?.();
				});
			} else if (event === 'end') {
				this._endCb = cb;
				if (body == null) queueMicrotask(() => cb());
			}
		},
		destroy() {},
	};
}

function mkRes() {
	return {
		statusCode: 200,
		headers: {},
		body: undefined,
		writableEnded: false,
		headersSent: false,
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = v;
		},
		getHeader(k) {
			return this.headers[k.toLowerCase()];
		},
		end(b) {
			this.body = b;
			this.writableEnded = true;
		},
	};
}

const parseBody = (res) => (res.body ? JSON.parse(res.body) : undefined);
const GOOD_TOKEN = 'ghp_' + 'a'.repeat(36);

beforeEach(() => {
	sqlMock.mockReset().mockImplementation(() => Promise.resolve([]));
	sqlMock.transaction.mockReset().mockResolvedValue([[]]);
	getSessionUserMock.mockReset().mockResolvedValue({ id: USER });
	requireCsrfMock.mockReset().mockResolvedValue(true);
	verifyTokenMock.mockReset();
	revokeGrantMock.mockReset().mockResolvedValue(true);
	envMock.GITHUB_OAUTH_CLIENT_ID = '';
	envMock.GITHUB_OAUTH_CLIENT_SECRET = '';
});

describe('POST /api/auth/github/token', () => {
	it('stores a token GitHub accepts and reports the connect method', async () => {
		verifyTokenMock.mockResolvedValue({
			valid: true,
			status: 200,
			profile: { id: 42, login: 'octocat' },
			scopeHeader: 'read:user',
		});
		sqlMock.mockImplementation(() =>
			Promise.resolve([{ username: 'octocat', connected_at: '2026-08-16T00:00:00Z' }]),
		);

		const res = mkRes();
		await handler(mkReq({ body: { token: GOOD_TOKEN } }), res);

		expect(res.statusCode).toBe(200);
		const out = parseBody(res);
		expect(out.connected).toBe(true);
		expect(out.connect_method).toBe('token');
		expect(out.username).toBe('octocat');
		expect(out.scopes).toEqual(['read:user']);
	});

	it('never writes the token in the clear', async () => {
		verifyTokenMock.mockResolvedValue({
			valid: true,
			status: 200,
			profile: { id: 42, login: 'octocat' },
			scopeHeader: 'read:user',
		});
		sqlMock.mockImplementation(() =>
			Promise.resolve([{ username: 'octocat', connected_at: '2026-08-16T00:00:00Z' }]),
		);

		await handler(mkReq({ body: { token: GOOD_TOKEN } }), mkRes());

		// Every interpolated value across every query this call made.
		const written = sqlMock.mock.calls.flatMap((call) => call.slice(1)).map(String);
		expect(written.some((v) => v.includes(GOOD_TOKEN))).toBe(false);
		// The encrypted blob did get stored, so the check above is meaningful.
		expect(written.some((v) => v.length > 40)).toBe(true);
	});

	it('refuses a token that carries more access than seeding needs', async () => {
		verifyTokenMock.mockResolvedValue({
			valid: true,
			status: 200,
			profile: { id: 42, login: 'octocat' },
			scopeHeader: 'repo, delete_repo',
		});

		const res = mkRes();
		await handler(mkReq({ body: { token: GOOD_TOKEN } }), res);

		expect(res.statusCode).toBe(400);
		const out = parseBody(res);
		expect(out.error).toBe('token_scope_refused');
		expect(out.refused_scopes).toEqual(['repo', 'delete_repo']);
		expect(out.create_url).toContain('github.com/settings/tokens/new');
		// Nothing was stored.
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('reports a token GitHub rejects as a user error, not an outage', async () => {
		verifyTokenMock.mockResolvedValue({ valid: false, status: 401 });

		const res = mkRes();
		await handler(mkReq({ body: { token: GOOD_TOKEN } }), res);

		expect(res.statusCode).toBe(400);
		expect(parseBody(res).error).toBe('invalid_token');
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('rejects input that cannot be a token without calling GitHub', async () => {
		const res = mkRes();
		await handler(mkReq({ body: { token: 'nope' } }), res);

		expect(res.statusCode).toBe(400);
		expect(parseBody(res).error).toBe('validation_error');
		expect(verifyTokenMock).not.toHaveBeenCalled();
	});

	it('requires a session', async () => {
		getSessionUserMock.mockResolvedValue(null);

		const res = mkRes();
		await handler(mkReq({ body: { token: GOOD_TOKEN } }), res);

		expect(res.statusCode).toBe(401);
		expect(verifyTokenMock).not.toHaveBeenCalled();
	});

	it('requires CSRF, so another site cannot connect a token to your account', async () => {
		requireCsrfMock.mockResolvedValue(false);

		const res = mkRes();
		await handler(mkReq({ body: { token: GOOD_TOKEN } }), res);

		expect(verifyTokenMock).not.toHaveBeenCalled();
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('refuses a GET, because connecting is a mutation', async () => {
		const res = mkRes();
		await handler(mkReq({ method: 'GET', body: null }), res);

		expect(res.statusCode).toBe(405);
	});
});

describe('GET /api/auth/github/status', () => {
	it('offers the token path even with no OAuth app configured', async () => {
		sqlMock.mockImplementation(() => Promise.resolve([]));

		const res = mkRes();
		await handler(mkReq({ method: 'GET', action: 'status', body: null }), res);

		const out = parseBody(res);
		expect(out.connected).toBe(false);
		expect(out.configured).toBe(false);
		// The card reads this to decide that an unconfigured deployment is not a
		// dead end. Before the token path it rendered an "Unavailable" tag.
		expect(out.token_connect.available).toBe(true);
		expect(out.token_connect.recommended_scopes).toContain('read:user');
	});

	it('reports how a live connection was made', async () => {
		let call = 0;
		sqlMock.mockImplementation(() => {
			call += 1;
			if (call === 1)
				return Promise.resolve([
					{
						username: 'octocat',
						connected_at: '2026-08-16T00:00:00Z',
						raw_data: { connect_method: 'token' },
					},
				]);
			return Promise.resolve([{ n: 7 }]);
		});

		const res = mkRes();
		await handler(mkReq({ method: 'GET', action: 'status', body: null }), res);

		const out = parseBody(res);
		expect(out.connected).toBe(true);
		expect(out.connect_method).toBe('token');
		expect(out.seeded_fact_count).toBe(7);
	});

	it('reads a row written before the token path existed as an OAuth connection', async () => {
		let call = 0;
		sqlMock.mockImplementation(() => {
			call += 1;
			if (call === 1)
				return Promise.resolve([
					{ username: 'octocat', connected_at: '2026-08-16T00:00:00Z', raw_data: {} },
				]);
			return Promise.resolve([{ n: 0 }]);
		});

		const res = mkRes();
		await handler(mkReq({ method: 'GET', action: 'status', body: null }), res);

		expect(parseBody(res).connect_method).toBe('oauth');
	});
});

describe('POST /api/auth/github/disconnect', () => {
	it('deletes seeded memories and does not claim a revocation it cannot perform', async () => {
		envMock.GITHUB_OAUTH_CLIENT_ID = 'client-id';
		envMock.GITHUB_OAUTH_CLIENT_SECRET = 'client-secret';
		sqlMock.mockImplementation(() =>
			Promise.resolve([{ id: 'conn-1', access_token: 'enc', raw_data: { connect_method: 'token' } }]),
		);
		sqlMock.transaction.mockResolvedValue([[{ id: 'm1' }, { id: 'm2' }], []]);

		const res = mkRes();
		await handler(mkReq({ method: 'POST', action: 'disconnect', body: null }), res);

		const out = parseBody(res);
		expect(out.disconnected).toBe(true);
		expect(out.memories_deleted).toBe(2);
		expect(out.connect_method).toBe('token');
		expect(out.grant_revoked).toBe(false);
		expect(out.revoke_url).toBe('https://github.com/settings/tokens');
		// GitHub exposes no way to delete a PAT using that same PAT, so the OAuth
		// grant revoke must not run against one.
		expect(revokeGrantMock).not.toHaveBeenCalled();
	});

	it('still revokes the grant for an OAuth connection', async () => {
		envMock.GITHUB_OAUTH_CLIENT_ID = 'client-id';
		envMock.GITHUB_OAUTH_CLIENT_SECRET = 'client-secret';
		// A real ciphertext: the revoke only runs if the stored token decrypts,
		// which is the same gate production hits.
		const stored = await encryptGithubToken('gho_' + 'd'.repeat(36));
		sqlMock.mockImplementation(() =>
			Promise.resolve([{ id: 'conn-1', access_token: stored, raw_data: { connect_method: 'oauth' } }]),
		);
		sqlMock.transaction.mockResolvedValue([[{ id: 'm1' }], []]);

		const res = mkRes();
		await handler(mkReq({ method: 'POST', action: 'disconnect', body: null }), res);

		const out = parseBody(res);
		expect(out.connect_method).toBe('oauth');
		expect(out.revoke_url).toBeNull();
		expect(revokeGrantMock).toHaveBeenCalledTimes(1);
	});
});
