// Consolidated OAuth 2.1 endpoints dispatcher.
// Routes: /oauth/authorize, /oauth/consent (post-login redirect alias for authorize),
//         /oauth/token, /oauth/register, /oauth/revoke, /oauth/introspect

import { sql } from '../_lib/db.js';
import {
	getSessionUser, csrfTokenFor, verifyCsrfToken, isSameSiteOrigin,
	mintAccessToken, issueRefreshToken, rotateRefreshToken,
	revokeRefreshToken, verifyAccessToken,
} from '../_lib/auth.js';
import { randomToken, sha256, sha256Base64Url, constantTimeEquals } from '../_lib/crypto.js';
import { cors, method, wrap, error, redirect, readForm, readJson, json, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { env } from '../_lib/env.js';
import { z } from 'zod';
import { parse } from '../_lib/validate.js';
import { filterRegisterableScope } from '../_lib/oauth-scopes.js';

// ── authorize ─────────────────────────────────────────────────────────────────

function redirectUriMatches(requested, registered) {
	let reqUrl;
	try { reqUrl = new URL(requested); } catch { return false; }
	if (reqUrl.hash || reqUrl.search) return false;
	return registered.some((entry) => {
		let regUrl;
		try { regUrl = new URL(entry); } catch { return false; }
		return reqUrl.protocol === regUrl.protocol && reqUrl.host === regUrl.host && reqUrl.port === regUrl.port && reqUrl.pathname === regUrl.pathname;
	});
}

function parseQuery(url) {
	return Object.fromEntries(new URL(url, 'http://x').searchParams);
}

function intersectScopes(requested, allowed) {
	const a = new Set(allowed.split(/\s+/).filter(Boolean));
	return requested.split(/\s+/).filter((s) => a.has(s)).join(' ') || allowed;
}

// RFC 8707 §2: an authorization server that does not recognize the requested
// `resource` MUST reject the request with `invalid_target`. Every consumer of an
// access token on this platform verifies `aud === env.MCP_RESOURCE`
// (verifyAccessToken in api/_lib/auth.js defaults the audience to it), so
// honoring an arbitrary resource minted a token that no endpoint here would ever
// accept: the client got a 200 and a credential that failed everywhere, instead
// of one clear error at the point the mistake was made.
// Returns the canonical resource, or null when the request names another one.
function canonicalResource(requested) {
	if (requested === undefined || requested === null || requested === '') return env.MCP_RESOURCE;
	const strip = (s) => String(s).replace(/\/+$/, '');
	return strip(requested) === strip(env.MCP_RESOURCE) ? env.MCP_RESOURCE : null;
}

// The registerable scope set and the filter that enforces it live in
// ../_lib/oauth-scopes.js, shared with api/wk.js so the scopes this endpoint
// keeps and the scopes /.well-known/oauth-protected-resource advertises are
// read from one array and cannot drift apart.

function scopeLabel(s) {
	const labels = { 'avatars:read': 'Read your avatars', 'avatars:write': 'Create and update avatars', 'avatars:delete': 'Delete your avatars', profile: 'See your name and email', offline_access: 'Stay signed in across sessions', 'memory:read': 'Recall your agents’ memories', 'memory:write': 'Store and forget your agents’ memories', 'agents:read': 'Screen your agents’ identities', 'agents:write': 'Register your agents on-chain', 'wallet:read': 'See your agent wallet balance and spending caps', 'wallet:write': 'Spend USDC from your agent wallet, within your caps', 'services:write': 'Publish paid services that earn USDC to your agent wallet', 'home:read': 'See the state of your connected home', 'home:act': 'Control your connected home (unlocking, opening and disarming still need your explicit yes each time)' };
	return labels[s] || esc(s);
}

function esc(s) {
	return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function renderConsent(res, { client, user, params, csrf, grantedScope }) {
	res.statusCode = 200;
	res.setHeader('content-type', 'text/html; charset=utf-8');
	res.setHeader('cache-control', 'no-store');
	// form-action governs the WHOLE submission redirect chain, not just the POST
	// target. The form posts to /api/oauth/authorize ('self'), which then 302s to
	// the client's redirect_uri (e.g. https://claude.ai/...). Without the client
	// origin here, that cross-origin hop is blocked and the OAuth code never
	// reaches the client. redirect_uri is already validated against the client's
	// registered URIs before we render, so trusting its origin is safe.
	let redirectOrigin = '';
	try { redirectOrigin = ` ${new URL(params.redirect_uri).origin}`; } catch { /* validated upstream */ }
	res.setHeader('content-security-policy', `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'${redirectOrigin}; frame-ancestors 'none'; base-uri 'none'`);
	res.setHeader('x-frame-options', 'DENY');
	res.setHeader('x-content-type-options', 'nosniff');
	res.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
	res.setHeader('strict-transport-security', 'max-age=63072000; includeSubDomains; preload');
	// List exactly what the POST branch will grant, never the raw `scope` the
	// client asked for. They diverge whenever a client requests a scope it did
	// not register: intersectScopes drops it and falls back to the client's
	// registered scope, so showing the request itself made the consent screen
	// promise one set of permissions and the issued code carry another.
	const scopeList = grantedScope.split(/\s+/).filter(Boolean);
	res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorize ${esc(client.name)} · three.ws</title><style>:root{color-scheme:light dark}body{font:16px/1.5 -apple-system,system-ui,Segoe UI,Roboto,sans-serif;background:#0b0b10;color:#eee;margin:0;min-height:100vh;display:grid;place-items:center;padding:24px}.card{background:#14141c;border:1px solid #2a2a36;border-radius:16px;padding:28px 28px 24px;max-width:440px;width:100%;box-shadow:0 10px 40px rgba(0,0,0,.4)}h1{font-size:20px;margin:0 0 8px}.sub{color:#aaa;margin:0 0 20px}.who{display:flex;align-items:center;gap:10px;margin-bottom:16px;padding:10px 12px;background:#1b1b25;border-radius:10px}.dot{width:32px;height:32px;border-radius:50%;background:linear-gradient(135deg,#6a5cff,#ff5ca8);display:grid;place-items:center;color:#fff;font-weight:600}ul{margin:12px 0 20px;padding-left:0;list-style:none}li{padding:8px 0;border-bottom:1px solid #22222e;display:flex;gap:10px}li:last-child{border:0}li::before{content:"✓";color:#6a5cff}.actions{display:flex;gap:10px}button{flex:1;padding:12px 16px;border-radius:10px;border:0;font-size:15px;font-weight:600;cursor:pointer}.allow{background:#6a5cff;color:#fff}.deny{background:transparent;color:#aaa;border:1px solid #2a2a36}.foot{margin-top:16px;font-size:12px;color:#777}a{color:#9a8cff}</style></head><body><form class="card" method="post" action="/api/oauth/authorize"><h1>Authorize <b>${esc(client.name)}</b></h1><p class="sub">Grant this application access to your three.ws account.</p><div class="who"><div class="dot">${esc((user.display_name || user.email)[0].toUpperCase())}</div><div><div>${esc(user.display_name || user.email)}</div><div style="color:#888;font-size:13px">${esc(user.email)}</div></div></div><p style="margin:0 0 4px"><b>${esc(client.name)}</b> will be able to:</p><ul>${scopeList.map((s) => `<li>${scopeLabel(s)}</li>`).join('')}</ul><input type="hidden" name="csrf" value="${esc(csrf || '')}"> ${Object.entries(params).filter(([k]) => k !== 'csrf' && k !== 'decision').map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('')}<div class="actions"><button class="deny" type="submit" name="decision" value="deny">Cancel</button><button class="allow" type="submit" name="decision" value="allow">Authorize</button></div><p class="foot">You can revoke access any time from your <a href="/dashboard/connections">dashboard</a>.</p></form></body></html>`);
}

async function handleAuthorize(req, res) {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'POST'])) return;
	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);
	const params = req.method === 'POST' ? await readForm(req) : parseQuery(req.url);
	const { response_type, client_id, redirect_uri, scope, state, code_challenge, code_challenge_method, resource } = params;
	if (response_type !== 'code') return error(res, 400, 'unsupported_response_type', 'only response_type=code supported');
	if (!client_id) return error(res, 400, 'invalid_request', 'client_id required');
	if (!redirect_uri) return error(res, 400, 'invalid_request', 'redirect_uri required');
	if (!code_challenge) return error(res, 400, 'invalid_request', 'code_challenge required (PKCE)');
	if (!code_challenge_method) return error(res, 400, 'invalid_request', 'code_challenge_method required (must be S256)');
	if (code_challenge_method !== 'S256') return error(res, 400, 'invalid_request', 'code_challenge_method must be S256');
	const targetResource = canonicalResource(resource);
	if (!targetResource) return error(res, 400, 'invalid_target', `unknown resource, this server only issues tokens for ${env.MCP_RESOURCE}`);
	const rows = await sql`select * from oauth_clients where client_id = ${client_id} limit 1`;
	const client = rows[0];
	if (!client) return error(res, 400, 'invalid_client', 'unknown client');
	if (!redirectUriMatches(redirect_uri, client.redirect_uris)) return error(res, 400, 'invalid_redirect_uri', 'redirect_uri not registered');
	const user = await getSessionUser(req);
	if (!user) {
		const next = encodeURIComponent(`/oauth/consent?${new URLSearchParams(params).toString()}`);
		return redirect(res, `/login?next=${next}`);
	}
	const grantedScope = intersectScopes(scope || client.scope, client.scope);
	if (req.method === 'GET') {
		const csrf = await csrfTokenFor(req);
		return renderConsent(res, { client, user, params, csrf, grantedScope });
	}
	if (!isSameSiteOrigin(req)) return error(res, 403, 'forbidden', 'cross-site request blocked');
	if (!(await verifyCsrfToken(req, params.csrf))) return error(res, 403, 'forbidden', 'invalid csrf token');
	if (params.decision !== 'allow') {
		const denied = new URL(redirect_uri);
		denied.searchParams.set('error', 'access_denied');
		if (state) denied.searchParams.set('state', state);
		return redirect(res, denied.toString());
	}
	const code = randomToken(24);
	await sql`insert into oauth_auth_codes (code, client_id, user_id, redirect_uri, scope, resource, code_challenge, code_challenge_method, expires_at) values (${code}, ${client_id}, ${user.id}, ${redirect_uri}, ${grantedScope}, ${targetResource}, ${code_challenge}, 'S256', now() + ${'60 seconds'}::interval)`;
	const back = new URL(redirect_uri);
	back.searchParams.set('code', code);
	if (state) back.searchParams.set('state', state);
	return redirect(res, back.toString());
}

// ── token ─────────────────────────────────────────────────────────────────────

// RFC 6749 §2.3.1 credentials from the Authorization header, or null when the
// header is absent or carries no `id:secret` pair.
function basicAuthCredentials(req) {
	const h = req.headers.authorization || '';
	if (!h.toLowerCase().startsWith('basic ')) return null;
	let decoded;
	try { decoded = Buffer.from(h.slice(6), 'base64').toString('utf8'); } catch { return null; }
	const sep = decoded.indexOf(':');
	if (sep < 0) return null;
	return { id: decoded.slice(0, sep), secret: decoded.slice(sep + 1) };
}

function resolveClientId(req, form) {
	return form.client_id || basicAuthCredentials(req)?.id || null;
}

// RFC 7009 §2.1 (revoke) and RFC 7662 §2.1 (introspect) both require a client to
// authenticate exactly as it does at the token endpoint. Only the token endpoint
// read the Authorization header, so a client that registered with
// `token_endpoint_auth_method=client_secret_basic` and then sent its credentials
// the only way that method allows got a 400 for a missing client_id at both
// other endpoints, and a 401 the moment it added client_id to the form: it had
// no way to revoke or introspect a token it owned. One resolver for all three.
// Returns { ok: true, client, clientId } or { ok: false, reason, clientId },
// where reason is 'no_client_id' | 'unknown_client' | 'bad_credentials'; each
// caller maps the failure to the status its RFC prescribes.
async function authenticateClient(req, form) {
	const clientId = resolveClientId(req, form);
	if (!clientId) return { ok: false, reason: 'no_client_id', clientId: null };
	const rows = await sql`select * from oauth_clients where client_id = ${clientId} limit 1`;
	const client = rows[0];
	if (!client) return { ok: false, reason: 'unknown_client', clientId };
	if (client.client_type === 'confidential') {
		const secret = form.client_secret || basicAuthCredentials(req)?.secret || '';
		const providedHash = await sha256(secret);
		if (!client.client_secret_hash || !constantTimeEquals(providedHash, client.client_secret_hash)) {
			return { ok: false, reason: 'bad_credentials', clientId };
		}
	}
	return { ok: true, client, clientId };
}

// RFC 6749 §5.2: when a client authenticated with the Authorization header and
// the credentials are rejected, the 401 MUST carry a WWW-Authenticate challenge
// naming the same scheme. Without it the response is a malformed 401, and the
// HTTP clients that enforce that (fetch wrappers and OAuth libraries that retry
// on a challenge) either loop on the same bad secret or surface a transport
// error instead of "your client secret is wrong".
function invalidClientCredentials(req, res) {
	if (String(req.headers.authorization || '').toLowerCase().startsWith('basic ')) {
		res.setHeader('www-authenticate', 'Basic realm="oauth", error="invalid_client", error_description="bad client credentials"');
	}
	return error(res, 401, 'invalid_client', 'bad client credentials');
}

function isSubsetScope(requested, stored) {
	const allowed = new Set(stored.split(/\s+/).filter(Boolean));
	const asked = requested.split(/\s+/).filter(Boolean);
	return asked.length > 0 && asked.every((s) => allowed.has(s));
}

async function handleToken(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS' })) return;
	if (!method(req, res, ['POST'])) return;
	const form = await readForm(req);
	const clientId = resolveClientId(req, form);
	if (!clientId) return error(res, 400, 'invalid_client', 'client_id required');
	const rl = await limits.oauthToken(clientId);
	if (!rl.success) return rateLimited(res, rl, 'too many token requests');
	// RFC 8707 §2.2: the token request MAY repeat `resource`, and a server that
	// does not recognize the one it names MUST answer `invalid_target`. /oauth/
	// authorize has enforced that since the audience bug; the token endpoint
	// ignored the parameter, which reintroduced the exact failure canonicalResource
	// exists to prevent: a client naming another resource got a 200 and a token
	// whose `aud` was this server's, then hit 401s at every endpoint it tried.
	// Checked before the client lookup, exactly as authorize does it: the answer
	// is the same for every caller and it is already public in the well-known
	// metadata, so there is nothing to gain from spending a query first.
	if (!canonicalResource(form.resource)) return error(res, 400, 'invalid_target', `unknown resource, this server only issues tokens for ${env.MCP_RESOURCE}`);
	const auth = await authenticateClient(req, form);
	if (!auth.ok) {
		if (auth.reason === 'unknown_client') return error(res, 400, 'invalid_client', 'unknown client');
		return invalidClientCredentials(req, res);
	}
	const client = auth.client;
	const grantType = form.grant_type;
	if (grantType === 'authorization_code') {
		const { code, redirect_uri, code_verifier } = form;
		if (!code || !redirect_uri || !code_verifier) return error(res, 400, 'invalid_request', 'code, redirect_uri, code_verifier required');
		const r = await sql`select * from oauth_auth_codes where code = ${code} limit 1`;
		const row = r[0];
		if (!row) return error(res, 400, 'invalid_grant', 'unknown code');
		if (row.consumed_at) {
			await sql`update oauth_refresh_tokens set revoked_at = now() where user_id = ${row.user_id} and client_id = ${client.client_id} and revoked_at is null`;
			return error(res, 400, 'invalid_grant', 'authorization code already used');
		}
		if (new Date(row.expires_at) < new Date()) return error(res, 400, 'invalid_grant', 'code expired');
		if (row.client_id !== client.client_id) return error(res, 400, 'invalid_grant', 'client mismatch');
		if (row.redirect_uri !== redirect_uri) return error(res, 400, 'invalid_grant', 'redirect_uri mismatch');
		if (await sha256Base64Url(code_verifier) !== row.code_challenge) return error(res, 400, 'invalid_grant', 'PKCE verification failed');
		// Consume atomically: the consumed_at check above + this update was a TOCTOU
		// window where two concurrent requests with the same code + verifier could both
		// mint tokens (OAuth 2.1 §4.1.3 requires single use). Only the request whose
		// conditional UPDATE returns a row proceeds; a lost race means the code was just
		// used — revoke any tokens already issued from it and reject.
		const consumed = await sql`update oauth_auth_codes set consumed_at = now() where code = ${code} and consumed_at is null returning code`;
		if (!consumed[0]) {
			await sql`update oauth_refresh_tokens set revoked_at = now() where user_id = ${row.user_id} and client_id = ${client.client_id} and revoked_at is null`;
			return error(res, 400, 'invalid_grant', 'authorization code already used');
		}
		const accessToken = await mintAccessToken({ userId: row.user_id, clientId: client.client_id, scope: row.scope, resource: row.resource || env.MCP_RESOURCE });
		const wantsRefresh = client.grant_types.includes('refresh_token');
		const refresh = wantsRefresh ? await issueRefreshToken({ userId: row.user_id, clientId: client.client_id, scope: row.scope, resource: row.resource }) : null;
		return json(res, 200, { access_token: accessToken, token_type: 'Bearer', expires_in: 3600, scope: row.scope, ...(refresh ? { refresh_token: refresh.token } : {}) });
	}
	if (grantType === 'refresh_token') {
		const { refresh_token, scope } = form;
		if (!refresh_token) return error(res, 400, 'invalid_request', 'refresh_token required');
		let result;
		try {
			result = await rotateRefreshToken({ oldSecret: refresh_token, clientId: client.client_id, narrowScope: (stored) => { if (!scope) return stored; if (!isSubsetScope(scope, stored)) throw Object.assign(new Error('requested scope exceeds granted scope'), { status: 400, code: 'invalid_scope' }); return scope.split(/\s+/).filter(Boolean).join(' '); } });
		} catch (err) { return error(res, err.status || 400, err.code || 'invalid_grant', err.message); }
		const accessToken = await mintAccessToken({ userId: result.userId, clientId: client.client_id, scope: result.scope, resource: result.resource || env.MCP_RESOURCE });
		return json(res, 200, { access_token: accessToken, token_type: 'Bearer', expires_in: 3600, scope: result.scope, refresh_token: result.next.token });
	}
	return error(res, 400, 'unsupported_grant_type', `grant_type=${grantType} not supported`);
}

// ── register (dynamic client registration) ────────────────────────────────────

const registerSchema = z.object({
	redirect_uris: z.array(z.string().url()).min(1).max(10),
	client_name: z.string().trim().min(1).max(120).optional(),
	client_uri: z.string().url().optional(),
	logo_uri: z.string().url().optional(),
	scope: z.string().max(500).optional(),
	grant_types: z.array(z.string()).min(1).max(8).optional(),
	response_types: z.array(z.string()).min(1).max(8).optional(),
	token_endpoint_auth_method: z.enum(['none', 'client_secret_basic', 'client_secret_post']).optional(),
	software_id: z.string().max(120).optional(),
	software_version: z.string().max(60).optional(),
});

// Schemes a browser or OS handler EXECUTES rather than navigates to. Zod's
// .url() is a bare `new URL()` check, so `javascript:alert(document.cookie)` and
// `data:text/html,<script>…` both pass it: without this list a self-registering
// client could park a script URL in oauth_clients, and the consent page would
// then splice its "origin" (the literal string `null`) into the CSP form-action
// allowlist and 302 the browser at it after approval.
const EXECUTABLE_URI_SCHEMES = new Set(['javascript:', 'data:', 'vbscript:', 'blob:', 'file:', 'about:', 'filesystem:', 'view-source:']);
// RFC 8252 §8.3 permits loopback redirects over plain http, IPv6 included.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// Returns a rejection reason, or null when the URI is an acceptable target.
function redirectUriRejection(uri) {
	let u;
	try { u = new URL(uri); } catch { return 'redirect_uri must be an absolute URI'; }
	const scheme = u.protocol.toLowerCase();
	if (EXECUTABLE_URI_SCHEMES.has(scheme)) return `redirect URI scheme "${scheme}" is not allowed`;
	if (scheme === 'https:') return null;
	if (scheme === 'http:') return LOOPBACK_HOSTS.has(u.hostname) ? null : 'non-https redirect URIs only allowed for localhost';
	// A private-use scheme (RFC 8252 §7.1) is how native clients receive the
	// code: `com.example.app:/oauth2redirect` or `myapp://callback`. The slash
	// after the colon is what separates a navigable target from an inline
	// payload, so require it for any scheme outside http/https.
	if (!/^[a-z][a-z0-9+.-]*:\//i.test(uri)) return 'a private-use redirect URI needs a path, e.g. com.example.app:/callback';
	return null;
}

// Mirrors what /.well-known/oauth-authorization-server advertises (api/wk.js).
// RFC 7591 §3.2.2: metadata naming a grant or response type the server does not
// support is rejected, rather than stored as a promise the token endpoint would
// break later with `unsupported_grant_type`.
const SUPPORTED_GRANT_TYPES = new Set(['authorization_code', 'refresh_token']);
const SUPPORTED_RESPONSE_TYPES = new Set(['code']);

async function handleRegister(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS' })) return;
	if (!method(req, res, ['POST'])) return;
	const rl = await limits.oauthRegisterIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl, 'too many registrations from this IP');
	const body = parse(registerSchema, await readJson(req));
	for (const uri of body.redirect_uris) {
		const rejection = redirectUriRejection(uri);
		if (rejection) return error(res, 400, 'invalid_redirect_uri', rejection);
	}
	if (body.grant_types) {
		const unsupported = body.grant_types.filter((g) => !SUPPORTED_GRANT_TYPES.has(g));
		if (unsupported.length) return error(res, 400, 'invalid_client_metadata', `unsupported grant_types: ${unsupported.join(', ')}`);
		if (!body.grant_types.includes('authorization_code')) return error(res, 400, 'invalid_client_metadata', 'grant_types must include authorization_code');
	}
	if (body.response_types) {
		const unsupported = body.response_types.filter((r) => !SUPPORTED_RESPONSE_TYPES.has(r));
		if (unsupported.length) return error(res, 400, 'invalid_client_metadata', `unsupported response_types: ${unsupported.join(', ')}`);
	}
	const authMethod = body.token_endpoint_auth_method ?? 'none';
	const clientType = authMethod === 'none' ? 'public' : 'confidential';
	const clientId = `mcp_${randomToken(18)}`;
	let clientSecret = null, secretHash = null;
	if (clientType === 'confidential') { clientSecret = randomToken(32); secretHash = await sha256(clientSecret); }
	const scope = filterRegisterableScope(body.scope ?? 'avatars:read');
	const grantTypes = body.grant_types ?? ['authorization_code', 'refresh_token'];
	const responseTypes = body.response_types ?? ['code'];
	await sql`insert into oauth_clients (client_id, client_secret_hash, client_type, name, logo_uri, client_uri, redirect_uris, grant_types, response_types, token_endpoint_auth, scope, software_id, software_version, dynamically_registered) values (${clientId}, ${secretHash}, ${clientType}, ${body.client_name ?? 'MCP Client'}, ${body.logo_uri ?? null}, ${body.client_uri ?? null}, ${body.redirect_uris}, ${grantTypes}, ${responseTypes}, ${authMethod}, ${scope}, ${body.software_id ?? null}, ${body.software_version ?? null}, true)`;
	// RFC 7591 §3.2.1 makes client_secret_expires_at REQUIRED whenever a secret is
	// issued, with 0 meaning "never expires". Omitting it left a spec-following
	// client with no way to tell a non-expiring secret from a missing field, and
	// the secrets minted here genuinely have no expiry.
	//
	// The same section makes the response the authoritative record of what was
	// registered, so it echoes every optional field that was actually stored.
	// Dropping logo_uri, client_uri, software_id and software_version told a
	// client its metadata had been rejected when the row above had just saved it,
	// and a client that re-registers to "fix" that gets a second client_id.
	return json(res, 201, {
		client_id: clientId,
		...(clientSecret ? { client_secret: clientSecret, client_secret_expires_at: 0 } : {}),
		client_id_issued_at: Math.floor(Date.now() / 1000),
		token_endpoint_auth_method: authMethod,
		redirect_uris: body.redirect_uris,
		grant_types: grantTypes,
		response_types: responseTypes,
		scope,
		client_name: body.client_name ?? 'MCP Client',
		...(body.client_uri ? { client_uri: body.client_uri } : {}),
		...(body.logo_uri ? { logo_uri: body.logo_uri } : {}),
		...(body.software_id ? { software_id: body.software_id } : {}),
		...(body.software_version ? { software_version: body.software_version } : {}),
	});
}

// ── revoke ────────────────────────────────────────────────────────────────────

async function handleRevoke(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS' })) return;
	if (!method(req, res, ['POST'])) return;
	const form = await readForm(req);
	const { token } = form;
	const clientId = resolveClientId(req, form);
	if (!token || !clientId) return error(res, 400, 'invalid_request', 'token and client_id required');
	// Rate-limit per IP: revocation is unauthenticated for public clients, so cap
	// it to deny a token-probing oracle / brute-force surface (RFC 7009 hardening).
	const rlRevoke = await limits.authIp(clientIp(req));
	if (!rlRevoke.success) return rateLimited(res, rlRevoke);
	const auth = await authenticateClient(req, form);
	if (!auth.ok) {
		if (auth.reason === 'unknown_client') return json(res, 200, {});
		return invalidClientCredentials(req, res);
	}
	// `token_type_hint` is advisory and RFC 7009 §2.1 requires extending the
	// search when the token is not found under the hinted type. Access tokens
	// here are stateless JWTs with no server-side record to revoke, so the
	// refresh-token lookup IS the whole search: skipping it on
	// `token_type_hint=access_token` answered 200 OK to a client revoking a
	// refresh token under a wrong hint while leaving that token live for its
	// full 30-day life.
	await revokeRefreshToken(token, auth.clientId);
	return json(res, 200, {});
}

// ── introspect ────────────────────────────────────────────────────────────────

async function handleIntrospect(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS' })) return;
	if (!method(req, res, ['POST'])) return;
	const form = await readForm(req);
	const { token } = form;
	const requestedClientId = resolveClientId(req, form);
	if (!token || !requestedClientId) return error(res, 400, 'invalid_request', 'token and client_id required');
	// Rate-limit per IP: introspection is unauthenticated for public clients
	// (RFC 7662 §2.1). Capping it denies a token validity/scope/sub probing oracle.
	const rlIntrospect = await limits.authIp(clientIp(req));
	if (!rlIntrospect.success) return rateLimited(res, rlIntrospect);
	const auth = await authenticateClient(req, form);
	if (!auth.ok) {
		if (auth.reason === 'unknown_client') return json(res, 200, { active: false });
		return invalidClientCredentials(req, res);
	}
	const clientId = auth.clientId;
	try {
		const payload = await verifyAccessToken(token);
		if (payload.client_id && payload.client_id !== clientId) return json(res, 200, { active: false });
		return json(res, 200, { active: true, scope: payload.scope, client_id: payload.client_id, sub: payload.sub, aud: payload.aud, iss: payload.iss, exp: payload.exp, iat: payload.iat, token_type: 'Bearer' });
	} catch {
		const h = await sha256(token);
		const r = await sql`select user_id, scope, expires_at, revoked_at from oauth_refresh_tokens where token_hash = ${h} and client_id = ${clientId} limit 1`;
		const row = r[0];
		if (!row || row.revoked_at || new Date(row.expires_at) < new Date()) return json(res, 200, { active: false });
		return json(res, 200, { active: true, scope: row.scope, client_id: clientId, sub: row.user_id, token_type: 'refresh_token' });
	}
}

// ── dispatcher ────────────────────────────────────────────────────────────────

const DISPATCH = {
	authorize:  handleAuthorize,
	consent:    handleAuthorize,
	token:      handleToken,
	register:   handleRegister,
	revoke:     handleRevoke,
	introspect: handleIntrospect,
};

export default wrap(async (req, res) => {
	const action = req.query?.action ?? new URL(req.url, 'http://x').pathname.split('/').pop();
	const fn = DISPATCH[action];
	if (!fn) return error(res, 404, 'not_found', `unknown oauth action: ${action}`);
	return fn(req, res);
});
