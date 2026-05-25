// Consolidated OAuth 2.1 endpoints dispatcher.
// Routes: /oauth/authorize, /oauth/consent (post-login redirect alias for authorize),
//         /oauth/token, /oauth/register, /oauth/revoke, /oauth/introspect

import { sql } from '../_lib/db.js';
import {
	getSessionUser, csrfTokenFor, verifyCsrfToken, isSameSiteOrigin,
	mintAccessToken, issueRefreshToken, rotateRefreshToken,
	revokeRefreshToken, authenticateBearer, verifyAccessToken,
} from '../_lib/auth.js';
import { randomToken, sha256, sha256Base64Url, constantTimeEquals } from '../_lib/crypto.js';
import { cors, method, wrap, error, redirect, readForm, readJson, json } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { env } from '../_lib/env.js';
import { z } from 'zod';
import { parse } from '../_lib/validate.js';

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

function scopeLabel(s) {
	const labels = { 'avatars:read': 'Read your avatars', 'avatars:write': 'Create and update avatars', 'avatars:delete': 'Delete your avatars', profile: 'See your name and email', offline_access: 'Stay signed in across sessions' };
	return labels[s] || esc(s);
}

function esc(s) {
	return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function renderConsent(res, { client, user, params, csrf }) {
	res.statusCode = 200;
	res.setHeader('content-type', 'text/html; charset=utf-8');
	res.setHeader('cache-control', 'no-store');
	res.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
	res.setHeader('x-frame-options', 'DENY');
	res.setHeader('x-content-type-options', 'nosniff');
	res.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
	res.setHeader('strict-transport-security', 'max-age=63072000; includeSubDomains; preload');
	const scope = params.scope || client.scope;
	const scopeList = scope.split(/\s+/).filter(Boolean);
	res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorize ${esc(client.name)} · three.ws</title><style>:root{color-scheme:light dark}body{font:16px/1.5 -apple-system,system-ui,Segoe UI,Roboto,sans-serif;background:#0b0b10;color:#eee;margin:0;min-height:100vh;display:grid;place-items:center;padding:24px}.card{background:#14141c;border:1px solid #2a2a36;border-radius:16px;padding:28px 28px 24px;max-width:440px;width:100%;box-shadow:0 10px 40px rgba(0,0,0,.4)}h1{font-size:20px;margin:0 0 8px}.sub{color:#aaa;margin:0 0 20px}.who{display:flex;align-items:center;gap:10px;margin-bottom:16px;padding:10px 12px;background:#1b1b25;border-radius:10px}.dot{width:32px;height:32px;border-radius:50%;background:linear-gradient(135deg,#6a5cff,#ff5ca8);display:grid;place-items:center;color:#fff;font-weight:600}ul{margin:12px 0 20px;padding-left:0;list-style:none}li{padding:8px 0;border-bottom:1px solid #22222e;display:flex;gap:10px}li:last-child{border:0}li::before{content:"✓";color:#6a5cff}.actions{display:flex;gap:10px}button{flex:1;padding:12px 16px;border-radius:10px;border:0;font-size:15px;font-weight:600;cursor:pointer}.allow{background:#6a5cff;color:#fff}.deny{background:transparent;color:#aaa;border:1px solid #2a2a36}.foot{margin-top:16px;font-size:12px;color:#777}a{color:#9a8cff}</style></head><body><form class="card" method="post" action="/api/oauth/authorize"><h1>Authorize <b>${esc(client.name)}</b></h1><p class="sub">Grant this application access to your three.ws account.</p><div class="who"><div class="dot">${esc((user.display_name || user.email)[0].toUpperCase())}</div><div><div>${esc(user.display_name || user.email)}</div><div style="color:#888;font-size:13px">${esc(user.email)}</div></div></div><p style="margin:0 0 4px"><b>${esc(client.name)}</b> will be able to:</p><ul>${scopeList.map((s) => `<li>${scopeLabel(s)}</li>`).join('')}</ul><input type="hidden" name="csrf" value="${esc(csrf || '')}"> ${Object.entries(params).filter(([k]) => k !== 'csrf' && k !== 'decision').map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('')}<div class="actions"><button class="deny" type="submit" name="decision" value="deny">Cancel</button><button class="allow" type="submit" name="decision" value="allow">Authorize</button></div><p class="foot">You can revoke access any time from your <a href="/dashboard/connections">dashboard</a>.</p></form></body></html>`);
}

async function handleAuthorize(req, res) {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'POST'])) return;
	const params = req.method === 'POST' ? await readForm(req) : parseQuery(req.url);
	const { response_type, client_id, redirect_uri, scope, state, code_challenge, code_challenge_method, resource } = params;
	if (response_type !== 'code') return error(res, 400, 'unsupported_response_type', 'only response_type=code supported');
	if (!client_id) return error(res, 400, 'invalid_request', 'client_id required');
	if (!redirect_uri) return error(res, 400, 'invalid_request', 'redirect_uri required');
	if (!code_challenge) return error(res, 400, 'invalid_request', 'code_challenge required (PKCE)');
	if (!code_challenge_method) return error(res, 400, 'invalid_request', 'code_challenge_method required (must be S256)');
	if (code_challenge_method !== 'S256') return error(res, 400, 'invalid_request', 'code_challenge_method must be S256');
	const rows = await sql`select * from oauth_clients where client_id = ${client_id} limit 1`;
	const client = rows[0];
	if (!client) return error(res, 400, 'invalid_client', 'unknown client');
	if (!redirectUriMatches(redirect_uri, client.redirect_uris)) return error(res, 400, 'invalid_redirect_uri', 'redirect_uri not registered');
	const user = await getSessionUser(req);
	if (!user) {
		const next = encodeURIComponent(`/oauth/consent?${new URLSearchParams(params).toString()}`);
		return redirect(res, `/login?next=${next}`);
	}
	if (req.method === 'GET') {
		const csrf = await csrfTokenFor(req);
		return renderConsent(res, { client, user, params, csrf });
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
	const grantedScope = intersectScopes(scope || client.scope, client.scope);
	await sql`insert into oauth_auth_codes (code, client_id, user_id, redirect_uri, scope, resource, code_challenge, code_challenge_method, expires_at) values (${code}, ${client_id}, ${user.id}, ${redirect_uri}, ${grantedScope}, ${resource ?? env.MCP_RESOURCE}, ${code_challenge}, 'S256', now() + ${'60 seconds'}::interval)`;
	const back = new URL(redirect_uri);
	back.searchParams.set('code', code);
	if (state) back.searchParams.set('state', state);
	return redirect(res, back.toString());
}

// ── token ─────────────────────────────────────────────────────────────────────

function basicAuthUser(req) {
	const h = req.headers.authorization || '';
	if (!h.toLowerCase().startsWith('basic ')) return null;
	try { return Buffer.from(h.slice(6), 'base64').toString('utf8').split(':')[0]; } catch { return null; }
}
function basicAuthPass(req) {
	const h = req.headers.authorization || '';
	if (!h.toLowerCase().startsWith('basic ')) return null;
	try { return Buffer.from(h.slice(6), 'base64').toString('utf8').split(':').slice(1).join(':'); } catch { return null; }
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
	const clientId = form.client_id || basicAuthUser(req);
	if (!clientId) return error(res, 400, 'invalid_client', 'client_id required');
	const rl = await limits.oauthToken(clientId);
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many token requests');
	const rows = await sql`select * from oauth_clients where client_id = ${clientId} limit 1`;
	const client = rows[0];
	if (!client) return error(res, 400, 'invalid_client', 'unknown client');
	if (client.client_type === 'confidential') {
		const secret = form.client_secret || basicAuthPass(req) || '';
		const providedHash = await sha256(secret);
		if (!client.client_secret_hash || !constantTimeEquals(providedHash, client.client_secret_hash)) return error(res, 401, 'invalid_client', 'bad client credentials');
	}
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
		await sql`update oauth_auth_codes set consumed_at = now() where code = ${code}`;
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
	grant_types: z.array(z.string()).optional(),
	response_types: z.array(z.string()).optional(),
	token_endpoint_auth_method: z.enum(['none', 'client_secret_basic', 'client_secret_post']).optional(),
	software_id: z.string().max(120).optional(),
	software_version: z.string().max(60).optional(),
});

async function handleRegister(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS' })) return;
	if (!method(req, res, ['POST'])) return;
	const rl = await limits.oauthRegisterIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many registrations from this IP');
	const body = parse(registerSchema, await readJson(req));
	for (const uri of body.redirect_uris) {
		const u = new URL(uri);
		if (u.protocol === 'http:' && !/^localhost$|^127\.0\.0\.1$/.test(u.hostname)) return error(res, 400, 'invalid_redirect_uri', 'non-https redirect URIs only allowed for localhost');
	}
	const authMethod = body.token_endpoint_auth_method ?? 'none';
	const clientType = authMethod === 'none' ? 'public' : 'confidential';
	const clientId = `mcp_${randomToken(18)}`;
	let clientSecret = null, secretHash = null;
	if (clientType === 'confidential') { clientSecret = randomToken(32); secretHash = await sha256(clientSecret); }
	const scope = body.scope ?? 'avatars:read';
	const grantTypes = body.grant_types ?? ['authorization_code', 'refresh_token'];
	const responseTypes = body.response_types ?? ['code'];
	await sql`insert into oauth_clients (client_id, client_secret_hash, client_type, name, logo_uri, client_uri, redirect_uris, grant_types, response_types, token_endpoint_auth, scope, software_id, software_version, dynamically_registered) values (${clientId}, ${secretHash}, ${clientType}, ${body.client_name ?? 'MCP Client'}, ${body.logo_uri ?? null}, ${body.client_uri ?? null}, ${body.redirect_uris}, ${grantTypes}, ${responseTypes}, ${authMethod}, ${scope}, ${body.software_id ?? null}, ${body.software_version ?? null}, true)`;
	return json(res, 201, { client_id: clientId, ...(clientSecret ? { client_secret: clientSecret } : {}), client_id_issued_at: Math.floor(Date.now() / 1000), token_endpoint_auth_method: authMethod, redirect_uris: body.redirect_uris, grant_types: grantTypes, response_types: responseTypes, scope, client_name: body.client_name ?? 'MCP Client' });
}

// ── revoke ────────────────────────────────────────────────────────────────────

async function handleRevoke(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS' })) return;
	if (!method(req, res, ['POST'])) return;
	const form = await readForm(req);
	const { token, token_type_hint, client_id, client_secret } = form;
	if (!token || !client_id) return error(res, 400, 'invalid_request', 'token and client_id required');
	const rows = await sql`select * from oauth_clients where client_id = ${client_id} limit 1`;
	const client = rows[0];
	if (!client) return json(res, 200, {});
	if (client.client_type === 'confidential') {
		const hash = await sha256(client_secret ?? '');
		if (!client.client_secret_hash || !constantTimeEquals(hash, client.client_secret_hash)) return error(res, 401, 'invalid_client', 'bad client credentials');
	}
	if (token_type_hint !== 'access_token') await revokeRefreshToken(token, client_id);
	return json(res, 200, {});
}

// ── introspect ────────────────────────────────────────────────────────────────

async function handleIntrospect(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS' })) return;
	if (!method(req, res, ['POST'])) return;
	const form = await readForm(req);
	const { token, client_id, client_secret } = form;
	if (!token || !client_id) return error(res, 400, 'invalid_request', 'token and client_id required');
	const rows = await sql`select * from oauth_clients where client_id = ${client_id} limit 1`;
	const client = rows[0];
	if (!client) return json(res, 200, { active: false });
	if (client.client_type === 'confidential') {
		const hash = await sha256(client_secret ?? '');
		if (!client.client_secret_hash || !constantTimeEquals(hash, client.client_secret_hash)) return error(res, 401, 'invalid_client', 'bad client credentials');
	}
	try {
		const payload = await verifyAccessToken(token);
		if (payload.client_id && payload.client_id !== client_id) return json(res, 200, { active: false });
		return json(res, 200, { active: true, scope: payload.scope, client_id: payload.client_id, sub: payload.sub, aud: payload.aud, iss: payload.iss, exp: payload.exp, iat: payload.iat, token_type: 'Bearer' });
	} catch {
		const h = await sha256(token);
		const r = await sql`select user_id, scope, expires_at, revoked_at from oauth_refresh_tokens where token_hash = ${h} and client_id = ${client_id} limit 1`;
		const row = r[0];
		if (!row || row.revoked_at || new Date(row.expires_at) < new Date()) return json(res, 200, { active: false });
		return json(res, 200, { active: true, scope: row.scope, client_id, sub: row.user_id, token_type: 'refresh_token' });
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
