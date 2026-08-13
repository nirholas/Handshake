// api/oauth/[action].js: the OAuth 2.1 authorization server the MCP clients
// connect through (/oauth/authorize, /token, /register, /revoke, /introspect).
//
// It shipped with no test coverage at all, and an audit of it found four live
// defects that these tests pin shut:
//   1. the consent screen listed the scope the client ASKED for while the code
//      it issued carried the client's registered scope, so a user could approve
//      one set of permissions and grant another;
//   2. `resource` was passed straight through to the token audience, minting a
//      credential that every consumer on the platform rejects instead of
//      failing with RFC 8707 `invalid_target`;
//   3. dynamic registration accepted `javascript:` and `data:` redirect URIs,
//      because zod's .url() is a bare `new URL()` check;
//   4. /oauth/revoke skipped the refresh-token lookup whenever the caller sent
//      `token_type_hint=access_token`, answering 200 OK while leaving the token
//      live for its full 30-day life (RFC 7009 section 2.1 requires extending
//      the search past a hint that does not resolve).
//
// Only the database is doubled. auth.js is real, so PKCE, the JWT mint/verify
// round trip, and refresh-token rotation run their production code here.

import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.PUBLIC_APP_ORIGIN = 'https://three.ws';
process.env.JWT_SECRET ||= 'vitest-ephemeral-jwt-secret-00000000000000';

vi.mock('../api/_lib/zauth.js', () => ({ instrument: () => {}, drain: async () => {} }));
vi.mock('../api/_lib/sentry.js', () => ({ captureException: () => {} }));
vi.mock('../api/_lib/audit.js', () => ({ logAudit: vi.fn() }));
vi.mock('../api/_lib/streaks.js', () => ({ recordDailyActivity: vi.fn(async () => {}) }));
vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: {
		authIp: vi.fn(async () => ({ success: true })),
		oauthToken: vi.fn(async () => ({ success: true })),
		oauthRegisterIp: vi.fn(async () => ({ success: true })),
	},
	clientIp: () => '127.0.0.1',
}));

// ── in-memory stand-in for the three oauth tables ────────────────────────────
const db = { clients: [], codes: [], refresh: [] };
const statements = [];

function future(seconds) {
	return new Date(Date.now() + seconds * 1000).toISOString();
}

const sqlMock = vi.fn(async (strings, ...values) => {
	const text = strings.join('?').replace(/\s+/g, ' ').trim();
	statements.push({ text, values });

	if (text.startsWith('select * from oauth_clients where client_id')) {
		const [clientId] = values;
		return db.clients.filter((c) => c.client_id === clientId).slice(0, 1);
	}
	if (text.startsWith('insert into oauth_clients')) {
		const [client_id, client_secret_hash, client_type, name, logo_uri, client_uri, redirect_uris, grant_types, response_types, token_endpoint_auth, scope] = values;
		db.clients.push({ client_id, client_secret_hash, client_type, name, logo_uri, client_uri, redirect_uris, grant_types, response_types, token_endpoint_auth, scope });
		return [];
	}
	if (text.startsWith('insert into oauth_auth_codes')) {
		const [code, client_id, user_id, redirect_uri, scope, resource, code_challenge] = values;
		db.codes.push({ code, client_id, user_id, redirect_uri, scope, resource, code_challenge, code_challenge_method: 'S256', consumed_at: null, expires_at: future(60) });
		return [];
	}
	if (text.startsWith('select * from oauth_auth_codes where code')) {
		const [code] = values;
		return db.codes.filter((c) => c.code === code).slice(0, 1);
	}
	if (text.startsWith('update oauth_auth_codes set consumed_at')) {
		const [code] = values;
		const row = db.codes.find((c) => c.code === code && !c.consumed_at);
		if (!row) return [];
		row.consumed_at = new Date().toISOString();
		return [{ code: row.code }];
	}
	if (text.startsWith('insert into oauth_refresh_tokens')) {
		const [token_hash, client_id, user_id, scope, resource] = values;
		const row = { id: `rt-${db.refresh.length + 1}`, token_hash, client_id, user_id, scope, resource, revoked_at: null, replaced_by: null, expires_at: future(2_592_000) };
		db.refresh.push(row);
		return [{ id: row.id }];
	}
	if (text.startsWith('select id, user_id, scope, resource, expires_at, revoked_at from oauth_refresh_tokens')) {
		const [hash, clientId] = values;
		return db.refresh.filter((r) => r.token_hash === hash && r.client_id === clientId).slice(0, 1);
	}
	if (text.startsWith('select user_id, scope, expires_at, revoked_at from oauth_refresh_tokens')) {
		const [hash, clientId] = values;
		return db.refresh.filter((r) => r.token_hash === hash && r.client_id === clientId).slice(0, 1);
	}
	if (text.startsWith('update oauth_refresh_tokens set revoked_at = now(), replaced_by')) {
		const [replacedBy, id] = values;
		const row = db.refresh.find((r) => r.id === id);
		if (row) { row.revoked_at = new Date().toISOString(); row.replaced_by = replacedBy; }
		return [];
	}
	if (text.startsWith('update oauth_refresh_tokens set revoked_at = now() where token_hash')) {
		const [hash, clientId] = values;
		const row = db.refresh.find((r) => r.token_hash === hash && r.client_id === clientId && !r.revoked_at);
		if (!row) return [];
		row.revoked_at = new Date().toISOString();
		return [{ id: row.id, user_id: row.user_id }];
	}
	if (text.startsWith('update oauth_refresh_tokens set revoked_at = now() where user_id')) {
		const [userId, clientId] = values;
		for (const r of db.refresh) {
			if (r.user_id === userId && r.client_id === clientId && !r.revoked_at) r.revoked_at = new Date().toISOString();
		}
		return [];
	}
	throw new Error(`unmodeled query: ${text}`);
});
// http.js's wrap() classifies caught errors with these predicates, so the mock
// has to export them alongside sql or every handler error becomes a crash
// inside the catch block instead of the intended status code.
vi.mock('../api/_lib/db.js', () => ({
	sql: (strings, ...values) => sqlMock(strings, ...values),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
	isStoragePressured: () => false,
}));

const getSessionUser = vi.fn();
vi.mock('../api/_lib/auth.js', async () => {
	const actual = await vi.importActual('../api/_lib/auth.js');
	return { ...actual, getSessionUser: (...args) => getSessionUser(...args) };
});

const { default: handler } = await import('../api/oauth/[action].js');
const { csrfTokenFor, verifyAccessToken } = await import('../api/_lib/auth.js');
const { sha256, sha256Base64Url } = await import('../api/_lib/crypto.js');

// ── request/response doubles ─────────────────────────────────────────────────
const SESSION_COOKIE = '__Host-sid=session-token-for-tests';
const ORIGIN = 'https://three.ws';
const RESOURCE = 'https://three.ws/api/mcp';

function makeRes() {
	const r = { statusCode: 200, _h: {}, _b: null };
	r.setHeader = (k, v) => { r._h[k.toLowerCase()] = v; };
	r.getHeader = (k) => r._h[k.toLowerCase()];
	r.end = (b) => { r._b = b === undefined ? '' : b; };
	Object.defineProperty(r, 'body', { get: () => r._b ?? '' });
	Object.defineProperty(r, 'json', { value: () => JSON.parse(r._b) });
	return r;
}

async function call(action, { method = 'GET', query = {}, form, jsonBody, headers = {} } = {}) {
	const search = new URLSearchParams({ action, ...query }).toString();
	const req = {
		method,
		url: `/api/oauth/${action}?${search}`,
		query: { action, ...query },
		headers: { origin: ORIGIN, cookie: SESSION_COOKIE, ...headers },
		socket: { remoteAddress: '127.0.0.1' },
	};
	if (form) {
		req.headers['content-type'] = 'application/x-www-form-urlencoded';
		req.body = new URLSearchParams(form).toString();
	} else if (jsonBody) {
		req.headers['content-type'] = 'application/json';
		req.body = JSON.stringify(jsonBody);
	}
	const res = makeRes();
	await handler(req, res);
	return res;
}

const VERIFIER = 'a'.repeat(64);
let CHALLENGE;

function seedClient(overrides = {}) {
	const client = {
		client_id: 'mcp_test_client',
		client_secret_hash: null,
		client_type: 'public',
		name: 'Test MCP Client',
		redirect_uris: ['https://client.example/cb'],
		grant_types: ['authorization_code', 'refresh_token'],
		response_types: ['code'],
		token_endpoint_auth: 'none',
		scope: 'avatars:read profile',
		...overrides,
	};
	db.clients.push(client);
	return client;
}

const authorizeQuery = (extra = {}) => ({
	response_type: 'code',
	client_id: 'mcp_test_client',
	redirect_uri: 'https://client.example/cb',
	code_challenge: CHALLENGE,
	code_challenge_method: 'S256',
	...extra,
});

const csrf = () => csrfTokenFor({ headers: { cookie: SESSION_COOKIE } });

async function approve(extra = {}) {
	return call('authorize', { method: 'POST', form: { ...authorizeQuery(extra), csrf: await csrf(), decision: 'allow' } });
}

async function issueTokens() {
	const authorized = await approve();
	const code = new URL(authorized.getHeader('location')).searchParams.get('code');
	const res = await call('token', { method: 'POST', form: { grant_type: 'authorization_code', client_id: 'mcp_test_client', code, redirect_uri: 'https://client.example/cb', code_verifier: VERIFIER } });
	return res.json();
}

beforeEach(async () => {
	CHALLENGE ||= await sha256Base64Url(VERIFIER);
	db.clients.length = 0;
	db.codes.length = 0;
	db.refresh.length = 0;
	statements.length = 0;
	sqlMock.mockClear();
	getSessionUser.mockReset();
	getSessionUser.mockResolvedValue({ id: 'user-1', email: 'ada@example.com', display_name: 'Ada' });
});

describe('GET /oauth/authorize', () => {
	it('renders a consent screen listing the scope that will actually be granted', async () => {
		seedClient();
		// The client asks for a scope it never registered. intersectScopes drops it
		// and falls back to the registered scope, so the screen must say so.
		const res = await call('authorize', { query: authorizeQuery({ scope: 'memory:write' }) });
		expect(res.statusCode).toBe(200);
		expect(res.getHeader('content-type')).toContain('text/html');
		expect(res.body).toContain('Read your avatars');
		expect(res.body).toContain('See your name and email');
		expect(res.body).not.toContain('Store and forget');
	});

	it('allows the client origin in form-action so the post-consent 302 is not blocked', async () => {
		seedClient();
		const res = await call('authorize', { query: authorizeQuery() });
		expect(res.getHeader('content-security-policy')).toContain("form-action 'self' https://client.example");
	});

	it('sends an anonymous visitor to /login with the consent URL as the return target', async () => {
		seedClient();
		getSessionUser.mockResolvedValue(null);
		const res = await call('authorize', { query: authorizeQuery() });
		expect(res.statusCode).toBe(302);
		expect(decodeURIComponent(res.getHeader('location'))).toContain('/oauth/consent?');
	});

	it('rejects a redirect_uri the client never registered', async () => {
		seedClient();
		const res = await call('authorize', { query: authorizeQuery({ redirect_uri: 'https://attacker.example/cb' }) });
		expect(res.statusCode).toBe(400);
		expect(res.json().error).toBe('invalid_redirect_uri');
		expect(db.codes).toHaveLength(0);
	});

	it('rejects an unknown resource with invalid_target instead of minting an unusable token', async () => {
		seedClient();
		const res = await call('authorize', { query: authorizeQuery({ resource: 'https://someone-else.example/api' }) });
		expect(res.statusCode).toBe(400);
		expect(res.json().error).toBe('invalid_target');
		expect(db.codes).toHaveLength(0);
	});

	it('rejects a non-S256 PKCE challenge', async () => {
		seedClient();
		const res = await call('authorize', { query: authorizeQuery({ code_challenge_method: 'plain' }) });
		expect(res.statusCode).toBe(400);
		expect(res.json().error_description).toContain('S256');
	});
});

describe('POST /oauth/authorize', () => {
	it('issues a code carrying the intersected scope and the canonical resource', async () => {
		seedClient();
		const res = await approve({ scope: 'profile memory:write' });
		expect(res.statusCode).toBe(302);
		const back = new URL(res.getHeader('location'));
		expect(back.origin + back.pathname).toBe('https://client.example/cb');
		expect(back.searchParams.get('code')).toBeTruthy();
		expect(db.codes[0].scope).toBe('profile');
		expect(db.codes[0].resource).toBe(RESOURCE);
	});

	it('preserves state and returns access_denied when the user cancels', async () => {
		seedClient();
		const res = await call('authorize', { method: 'POST', form: { ...authorizeQuery({ state: 'xyz' }), csrf: await csrf(), decision: 'deny' } });
		const back = new URL(res.getHeader('location'));
		expect(back.searchParams.get('error')).toBe('access_denied');
		expect(back.searchParams.get('state')).toBe('xyz');
		expect(db.codes).toHaveLength(0);
	});

	it('refuses an approval without a valid CSRF token', async () => {
		seedClient();
		const res = await call('authorize', { method: 'POST', form: { ...authorizeQuery(), csrf: 'forged', decision: 'allow' } });
		expect(res.statusCode).toBe(403);
		expect(db.codes).toHaveLength(0);
	});

	it('refuses an approval posted from another origin', async () => {
		seedClient();
		const res = await call('authorize', { method: 'POST', form: { ...authorizeQuery(), csrf: await csrf(), decision: 'allow' }, headers: { origin: 'https://attacker.example' } });
		expect(res.statusCode).toBe(403);
		expect(db.codes).toHaveLength(0);
	});
});

describe('POST /oauth/token', () => {
	it('exchanges a code for a verifiable access token and a refresh token', async () => {
		seedClient();
		const out = await issueTokens();
		expect(out.token_type).toBe('Bearer');
		expect(out.scope).toBe('avatars:read profile');
		expect(out.refresh_token).toBeTruthy();
		const payload = await verifyAccessToken(out.access_token);
		expect(payload.sub).toBe('user-1');
		expect(payload.aud).toBe(RESOURCE);
		expect(payload.client_id).toBe('mcp_test_client');
	});

	it('rejects a wrong PKCE verifier without consuming the code', async () => {
		seedClient();
		const code = new URL((await approve()).getHeader('location')).searchParams.get('code');
		const res = await call('token', { method: 'POST', form: { grant_type: 'authorization_code', client_id: 'mcp_test_client', code, redirect_uri: 'https://client.example/cb', code_verifier: 'b'.repeat(64) } });
		expect(res.statusCode).toBe(400);
		expect(res.json().error).toBe('invalid_grant');
		expect(db.codes[0].consumed_at).toBeNull();
	});

	it('rejects a redirect_uri that differs from the one the code was issued for', async () => {
		seedClient({ redirect_uris: ['https://client.example/cb', 'https://client.example/other'] });
		const code = new URL((await approve()).getHeader('location')).searchParams.get('code');
		const res = await call('token', { method: 'POST', form: { grant_type: 'authorization_code', client_id: 'mcp_test_client', code, redirect_uri: 'https://client.example/other', code_verifier: VERIFIER } });
		expect(res.statusCode).toBe(400);
		expect(res.json().error_description).toContain('redirect_uri mismatch');
	});

	it('revokes the issued tokens when a code is replayed', async () => {
		seedClient();
		const code = new URL((await approve()).getHeader('location')).searchParams.get('code');
		const form = { grant_type: 'authorization_code', client_id: 'mcp_test_client', code, redirect_uri: 'https://client.example/cb', code_verifier: VERIFIER };
		await call('token', { method: 'POST', form });
		const replay = await call('token', { method: 'POST', form });
		expect(replay.statusCode).toBe(400);
		expect(replay.json().error_description).toContain('already used');
		expect(db.refresh.every((r) => r.revoked_at)).toBe(true);
	});

	it('rotates a refresh token and refuses to widen the scope back', async () => {
		seedClient();
		const first = await issueTokens();

		const narrowed = await call('token', { method: 'POST', form: { grant_type: 'refresh_token', client_id: 'mcp_test_client', refresh_token: first.refresh_token, scope: 'profile' } });
		expect(narrowed.statusCode).toBe(200);
		expect(narrowed.json().scope).toBe('profile');

		const widened = await call('token', { method: 'POST', form: { grant_type: 'refresh_token', client_id: 'mcp_test_client', refresh_token: narrowed.json().refresh_token, scope: 'avatars:read profile' } });
		expect(widened.statusCode).toBe(400);
		expect(widened.json().error).toBe('invalid_scope');
	});

	it('detects refresh-token reuse and kills the whole chain', async () => {
		seedClient();
		const first = await issueTokens();
		await call('token', { method: 'POST', form: { grant_type: 'refresh_token', client_id: 'mcp_test_client', refresh_token: first.refresh_token } });
		const reuse = await call('token', { method: 'POST', form: { grant_type: 'refresh_token', client_id: 'mcp_test_client', refresh_token: first.refresh_token } });
		expect(reuse.statusCode).toBe(400);
		expect(reuse.json().error).toBe('refresh_reuse_detected');
		expect(db.refresh.every((r) => r.revoked_at)).toBe(true);
	});

	it('rejects a confidential client presenting the wrong secret', async () => {
		seedClient({ client_type: 'confidential', client_secret_hash: await sha256('the-real-secret'), token_endpoint_auth: 'client_secret_post' });
		const res = await call('token', { method: 'POST', form: { grant_type: 'authorization_code', client_id: 'mcp_test_client', client_secret: 'guessed', code: 'x', redirect_uri: 'https://client.example/cb', code_verifier: VERIFIER } });
		expect(res.statusCode).toBe(401);
		expect(res.json().error).toBe('invalid_client');
	});

	it('reports an unsupported grant type', async () => {
		seedClient();
		const res = await call('token', { method: 'POST', form: { grant_type: 'client_credentials', client_id: 'mcp_test_client' } });
		expect(res.statusCode).toBe(400);
		expect(res.json().error).toBe('unsupported_grant_type');
	});
});

describe('POST /oauth/register', () => {
	it('registers a public client and drops privileged scopes it asked for', async () => {
		const res = await call('register', { method: 'POST', jsonBody: { redirect_uris: ['https://client.example/cb'], client_name: 'Probe', scope: 'avatars:read permissions:redeem' } });
		expect(res.statusCode).toBe(201);
		const out = res.json();
		expect(out.client_id).toMatch(/^mcp_/);
		expect(out.scope).toBe('avatars:read');
		expect(out.client_secret).toBeUndefined();
	});

	it('returns a one-time secret for a confidential client and stores only its hash', async () => {
		const res = await call('register', { method: 'POST', jsonBody: { redirect_uris: ['https://client.example/cb'], token_endpoint_auth_method: 'client_secret_basic' } });
		const out = res.json();
		expect(out.client_secret).toBeTruthy();
		expect(db.clients[0].client_secret_hash).toBe(await sha256(out.client_secret));
		expect(db.clients[0].client_secret_hash).not.toBe(out.client_secret);
	});

	it.each([
		['javascript:alert(document.cookie)'],
		['data:text/html,<script>alert(1)</script>'],
		['file:///etc/passwd'],
		['vbscript:msgbox(1)'],
	])('refuses the executable redirect URI %s', async (uri) => {
		const res = await call('register', { method: 'POST', jsonBody: { redirect_uris: [uri] } });
		expect(res.statusCode).toBe(400);
		expect(res.json().error).toBe('invalid_redirect_uri');
		expect(db.clients).toHaveLength(0);
	});

	it('still accepts loopback http and native private-use redirect URIs', async () => {
		const res = await call('register', { method: 'POST', jsonBody: { redirect_uris: ['http://127.0.0.1:8976/cb', 'http://localhost:1410/cb', 'com.example.app:/oauth2redirect', 'myapp://callback'] } });
		expect(res.statusCode).toBe(201);
	});

	it('refuses plain http on a public host', async () => {
		const res = await call('register', { method: 'POST', jsonBody: { redirect_uris: ['http://attacker.example/cb'] } });
		expect(res.statusCode).toBe(400);
		expect(res.json().error_description).toContain('localhost');
	});

	it('refuses metadata naming a grant or response type this server does not support', async () => {
		const implicit = await call('register', { method: 'POST', jsonBody: { redirect_uris: ['https://client.example/cb'], grant_types: ['authorization_code', 'implicit'] } });
		expect(implicit.statusCode).toBe(400);
		expect(implicit.json().error).toBe('invalid_client_metadata');

		const token = await call('register', { method: 'POST', jsonBody: { redirect_uris: ['https://client.example/cb'], response_types: ['token'] } });
		expect(token.statusCode).toBe(400);
		expect(token.json().error).toBe('invalid_client_metadata');
		expect(db.clients).toHaveLength(0);
	});

	it('rejects a body that carries no redirect_uris at all', async () => {
		const res = await call('register', { method: 'POST', jsonBody: { redirect_uris: [] } });
		expect(res.statusCode).toBe(400);
		expect(res.json().error).toBe('validation_error');
	});
});

describe('POST /oauth/revoke', () => {
	it('revokes a refresh token', async () => {
		seedClient();
		const { refresh_token } = await issueTokens();
		const res = await call('revoke', { method: 'POST', form: { token: refresh_token, client_id: 'mcp_test_client' } });
		expect(res.statusCode).toBe(200);
		expect(db.refresh[0].revoked_at).toBeTruthy();
	});

	it('revokes a refresh token even when the caller hints the wrong token type', async () => {
		seedClient();
		const { refresh_token } = await issueTokens();
		const res = await call('revoke', { method: 'POST', form: { token: refresh_token, token_type_hint: 'access_token', client_id: 'mcp_test_client' } });
		expect(res.statusCode).toBe(200);
		expect(db.refresh[0].revoked_at).toBeTruthy();
	});

	it('answers 200 for an unknown client without disclosing that it is unknown', async () => {
		const res = await call('revoke', { method: 'POST', form: { token: 'whatever', client_id: 'mcp_nope' } });
		expect(res.statusCode).toBe(200);
		expect(res.json()).toEqual({});
	});
});

describe('POST /oauth/introspect', () => {
	it('reports an access token as active with its scope and subject', async () => {
		seedClient();
		const tokens = await issueTokens();
		const res = await call('introspect', { method: 'POST', form: { token: tokens.access_token, client_id: 'mcp_test_client' } });
		expect(res.json()).toMatchObject({ active: true, sub: 'user-1', scope: 'avatars:read profile', token_type: 'Bearer' });
	});

	it('reports a refresh token as active', async () => {
		seedClient();
		const tokens = await issueTokens();
		const res = await call('introspect', { method: 'POST', form: { token: tokens.refresh_token, client_id: 'mcp_test_client' } });
		expect(res.json()).toMatchObject({ active: true, sub: 'user-1', token_type: 'refresh_token' });
	});

	it('will not confirm a token that belongs to another client', async () => {
		seedClient();
		const tokens = await issueTokens();
		seedClient({ client_id: 'mcp_other', redirect_uris: ['https://other.example/cb'] });
		const res = await call('introspect', { method: 'POST', form: { token: tokens.access_token, client_id: 'mcp_other' } });
		expect(res.json()).toEqual({ active: false });
	});

	it('reports a revoked refresh token as inactive', async () => {
		seedClient();
		const tokens = await issueTokens();
		await call('revoke', { method: 'POST', form: { token: tokens.refresh_token, client_id: 'mcp_test_client' } });
		const res = await call('introspect', { method: 'POST', form: { token: tokens.refresh_token, client_id: 'mcp_test_client' } });
		expect(res.json()).toEqual({ active: false });
	});

	it('reports a garbage token as inactive rather than erroring', async () => {
		seedClient();
		const res = await call('introspect', { method: 'POST', form: { token: 'not-a-token', client_id: 'mcp_test_client' } });
		expect(res.json()).toEqual({ active: false });
	});
});

describe('dispatcher', () => {
	it('404s an unknown action', async () => {
		const res = await call('bogus');
		expect(res.statusCode).toBe(404);
		expect(res.json().error).toBe('not_found');
	});

	it('rejects a method the action does not serve', async () => {
		const res = await call('token', { method: 'GET' });
		expect(res.statusCode).toBe(405);
	});
});
