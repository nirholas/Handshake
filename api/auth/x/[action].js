// X (Twitter) OAuth 2.0 PKCE flow. Dispatches on ?action=connect|callback.
// Env required: X_OAUTH_CLIENT_ID, X_OAUTH_CLIENT_SECRET
// If unset, /connect returns 501 not_configured.
//
// /connect takes an optional ?scope=read|full (default full, see
// api/_lib/x-scopes.js). The memory-seeding card asks for `read` so an owner who
// only wants their agent to sound like them never has to grant permission to
// post as them; the posting surfaces ask for `full`.
//
// PKCE state ({code_verifier, user_id, agent_id}) is carried in a short-lived,
// HMAC-signed httpOnly cookie keyed by the OAuth `state` param. No external
// store needed; the cookie is sent back on the top-level redirect from x.com
// thanks to SameSite=Lax.

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { sql } from '../../_lib/db.js';
import { getSessionUser } from '../../_lib/auth.js';
import {
	sha256Base64Url,
	randomToken,
	hmacSha256,
	constantTimeEquals,
} from '../../_lib/crypto.js';
import { cors, method, wrap, error, redirect, rateLimited, wantsHtmlNavigation } from '../../_lib/http.js';
import { limits, clientIp } from '../../_lib/rate-limit.js';
import { env } from '../../_lib/env.js';
import { revokeAllSeedConsentsForUser } from '../../_lib/x-seed-consent.js';
import { resolveScopeSet } from '../../_lib/x-scopes.js';

// ── Signed-cookie PKCE state ─────────────────────────────────────────────────

const STATE_COOKIE = '__Host-xoa';
const STATE_TTL_SEC = 600;

function b64urlEncode(str) {
	return Buffer.from(str, 'utf8').toString('base64url');
}
function b64urlDecode(s) {
	return Buffer.from(s, 'base64url').toString('utf8');
}

async function signState({ state, codeVerifier, userId, agentId, scopeSet }) {
	const payload = {
		s: state,
		v: codeVerifier,
		u: userId,
		a: agentId,
		k: scopeSet,
		e: Math.floor(Date.now() / 1000) + STATE_TTL_SEC,
	};
	const body = b64urlEncode(JSON.stringify(payload));
	const sig = await hmacSha256(env.JWT_SECRET, body);
	return `${body}.${sig}`;
}

async function verifyState(token, expectedState) {
	if (!token || typeof token !== 'string') return null;
	const dot = token.indexOf('.');
	if (dot < 1) return null;
	const body = token.slice(0, dot);
	const sig = token.slice(dot + 1);
	const expected = await hmacSha256(env.JWT_SECRET, body);
	if (!constantTimeEquals(sig, expected)) return null;
	let payload;
	try {
		payload = JSON.parse(b64urlDecode(body));
	} catch {
		return null;
	}
	if (!payload || payload.s !== expectedState) return null;
	if (typeof payload.e !== 'number' || payload.e < Math.floor(Date.now() / 1000)) return null;
	return {
		codeVerifier: payload.v,
		userId: payload.u,
		agentId: payload.a,
		scopeSet: resolveScopeSet(payload.k).name,
	};
}

function readStateCookie(req) {
	const cookie = req.headers.cookie || '';
	const m = cookie.match(/(?:^|;\s*)__Host-xoa=([^;]+)/);
	return m ? decodeURIComponent(m[1]) : null;
}

function stateCookie(value, { clear = false } = {}) {
	if (clear) {
		return `${STATE_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
	}
	return `${STATE_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${STATE_TTL_SEC}`;
}

// ── Token encryption (AES-256-GCM, key from JWT_SECRET via HKDF) ─────────────

function _deriveKey() {
	return hkdfSync('sha256', Buffer.from(env.JWT_SECRET), '', 'x-token', 32);
}

export function encryptToken(plaintext) {
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', _deriveKey(), iv);
	const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
	const tag = cipher.getAuthTag();
	return `${iv.toString('base64url')}.${enc.toString('base64url')}.${tag.toString('base64url')}`;
}

export function decryptToken(ciphertext) {
	const parts = ciphertext.split('.');
	if (parts.length !== 3) throw new Error('malformed ciphertext');
	const [ivB64, encB64, tagB64] = parts;
	const decipher = createDecipheriv(
		'aes-256-gcm',
		_deriveKey(),
		Buffer.from(ivB64, 'base64url'),
	);
	decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
	return Buffer.concat([
		decipher.update(Buffer.from(encB64, 'base64url')),
		decipher.final(),
	]).toString('utf8');
}

// ── Where a finished or refused connect sends the browser back to ────────────

// A read-only connect can only have come from the memory-seeding card, so it
// goes back to Settings (with the agent it targets) rather than to the agent
// editor's posting tab, which is about the write access that grant deliberately
// does not carry. The callback and the connect endpoint both route through this
// so a refusal lands on the same surface a success would.
function connectReturnUrl({ scopeSet, agentId, outcome }) {
	if (scopeSet === 'read') {
		const q = new URLSearchParams({ tab: 'connected-accounts', x: outcome });
		if (agentId) q.set('agent_id', agentId);
		return `/settings?${q.toString()}`;
	}
	return agentId
		? `/agents/${encodeURIComponent(agentId)}/edit?tab=social&x=${outcome}`
		: `/settings?tab=connected-accounts&x=${outcome}`;
}

// ── GET /api/auth/x/connect ───────────────────────────────────────────────────

async function handleConnect(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const url = new URL(req.url, env.APP_ORIGIN);
	const agentId = url.searchParams.get('agent_id') || null;
	const scopeSet = resolveScopeSet(url.searchParams.get('scope'));

	if (!env.X_OAUTH_CLIENT_ID || !env.X_OAUTH_CLIENT_SECRET) {
		// Every Connect X button on the site is an anchor or a location assignment,
		// so an unconfigured deployment used to answer a top-level navigation with a
		// raw JSON body in the address bar. Send the browser back to the surface it
		// came from with an outcome the page explains instead; API and agent callers
		// still get the 501 envelope they parse.
		if (wantsHtmlNavigation(req)) {
			return redirect(
				res,
				connectReturnUrl({ scopeSet: scopeSet.name, agentId, outcome: 'unconfigured' }),
			);
		}
		return error(res, 501, 'not_configured', 'X OAuth is not configured');
	}

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const user = await getSessionUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	const codeVerifier = randomToken(32); // 43-char base64url
	const codeChallenge = await sha256Base64Url(codeVerifier);
	const state = randomToken(16);

	const signed = await signState({
		state,
		codeVerifier,
		userId: user.id,
		agentId,
		scopeSet: scopeSet.name,
	});
	res.setHeader('set-cookie', stateCookie(signed));

	const authUrl = new URL('https://twitter.com/i/oauth2/authorize');
	authUrl.searchParams.set('response_type', 'code');
	authUrl.searchParams.set('client_id', env.X_OAUTH_CLIENT_ID);
	authUrl.searchParams.set('redirect_uri', `${env.APP_ORIGIN}/api/auth/x/callback`);
	// The full set's media.write lets a connected account upload screenshots /
	// walk clips via the v2 media-upload endpoint (see api/share/x.js) before
	// attaching them to a tweet. The read set drops every write scope: it is what
	// memory seeding needs and all it needs.
	authUrl.searchParams.set('scope', scopeSet.value);
	authUrl.searchParams.set('state', state);
	authUrl.searchParams.set('code_challenge', codeChallenge);
	authUrl.searchParams.set('code_challenge_method', 'S256');

	return redirect(res, authUrl.toString());
}

// ── GET /api/auth/x/callback ──────────────────────────────────────────────────

async function handleCallback(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	if (!env.X_OAUTH_CLIENT_ID || !env.X_OAUTH_CLIENT_SECRET) {
		return error(res, 501, 'not_configured', 'X OAuth is not configured');
	}

	const url = new URL(req.url, env.APP_ORIGIN);
	const code = url.searchParams.get('code');
	const state = url.searchParams.get('state');

	if (!state) return error(res, 400, 'validation_error', 'missing state');

	const cookieToken = readStateCookie(req);
	const stateData = await verifyState(cookieToken, state);
	// Burn the cookie regardless of validity so a leaked/replayed token can't be reused.
	res.setHeader('set-cookie', stateCookie('', { clear: true }));
	if (!stateData) return error(res, 400, 'invalid_state', 'OAuth state expired or invalid');

	const { codeVerifier, userId, agentId: stateAgentId, scopeSet } = stateData;
	// Return to the surface that started the connect, the same one a refusal at
	// /connect lands on.
	const backTo = (outcome) =>
		connectReturnUrl({ scopeSet, agentId: stateAgentId, outcome });
	const successRedirect = backTo('connected');
	const errorRedirect = backTo('error');
	const deniedRedirect = backTo('denied');

	if (url.searchParams.get('error')) return redirect(res, deniedRedirect);
	if (!code) return error(res, 400, 'validation_error', 'missing code');

	// Exchange code for tokens
	const creds = Buffer.from(`${env.X_OAUTH_CLIENT_ID}:${env.X_OAUTH_CLIENT_SECRET}`).toString(
		'base64',
	);
	const tokenRes = await fetch('https://api.twitter.com/2/oauth2/token', {
		method: 'POST',
		headers: {
			'content-type': 'application/x-www-form-urlencoded',
			authorization: `Basic ${creds}`,
		},
		body: new URLSearchParams({
			code,
			grant_type: 'authorization_code',
			client_id: env.X_OAUTH_CLIENT_ID,
			redirect_uri: `${env.APP_ORIGIN}/api/auth/x/callback`,
			code_verifier: codeVerifier,
		}).toString(),
	});

	if (!tokenRes.ok) {
		console.error('[x-oauth] token exchange failed', await tokenRes.text());
		return redirect(res, errorRedirect);
	}

	const tokens = await tokenRes.json().catch(() => ({}));
	const { access_token, refresh_token, expires_in } = tokens;
	// X echoes the scopes it actually granted, which can be narrower than what we
	// asked for if the user unticked a permission. Record them: social_connections
	// .scopes is NOT NULL, and the memory-seeding consent screen shows the owner
	// what this connection is allowed to do.
	const grantedScopes = typeof tokens.scope === 'string' ? tokens.scope : '';
	if (!access_token) {
		console.error('[x-oauth] token response carried no access_token');
		return redirect(res, errorRedirect);
	}
	const expiresAt = new Date(Date.now() + (expires_in ?? 7200) * 1000).toISOString();

	// Fetch X profile
	const profileRes = await fetch(
		'https://api.twitter.com/2/users/me?user.fields=name,username,description,public_metrics',
		{ headers: { authorization: `Bearer ${access_token}` } },
	);
	if (!profileRes.ok) {
		console.error('[x-oauth] profile fetch failed', await profileRes.text());
		return redirect(res, errorRedirect);
	}
	const { data: profile } = await profileRes.json().catch(() => ({}));
	// X answers 200 with an `errors` array (and no `data`) for a suspended or
	// otherwise unreadable account. Treat a profile without an id as a failed
	// connect and send the user back to the UI, not into a NULL provider_uid
	// insert that 500s on the not-null constraint.
	if (!profile?.id) {
		console.error('[x-oauth] profile response missing data.id');
		return redirect(res, errorRedirect);
	}

	const encAccess = encryptToken(access_token);
	const encRefresh = refresh_token ? encryptToken(refresh_token) : null;

	// Reconnecting a DIFFERENT X account retires every memory-seeding grant made
	// for the previous one and deletes the memories it produced. Consent was
	// given for that account's posts, and it does not transfer to this one.
	const [prior] = await sql`
		SELECT provider_uid FROM social_connections
		WHERE user_id = ${userId} AND provider = 'x'
		LIMIT 1
	`;
	if (prior?.provider_uid && prior.provider_uid !== profile.id) {
		await revokeAllSeedConsentsForUser(userId, 'x_account_changed');
	}

	// Upsert by (user_id, provider) — uses the existing unique constraint
	await sql`
		INSERT INTO social_connections
			(user_id, provider, provider_uid, username, access_token, refresh_token, expires_at, raw_data, scopes)
		VALUES
			(${userId}, 'x', ${profile.id}, ${profile.username}, ${encAccess}, ${encRefresh}, ${expiresAt}, ${JSON.stringify(profile)}, ${grantedScopes})
		ON CONFLICT (user_id, provider) DO UPDATE SET
			provider_uid    = EXCLUDED.provider_uid,
			username        = EXCLUDED.username,
			access_token    = EXCLUDED.access_token,
			refresh_token   = EXCLUDED.refresh_token,
			expires_at      = EXCLUDED.expires_at,
			raw_data        = EXCLUDED.raw_data,
			scopes          = EXCLUDED.scopes,
			disconnected_at = NULL,
			updated_at      = now()
	`;

	return redirect(res, successRedirect);
}

// ── dispatch ──────────────────────────────────────────────────────────────────

export default wrap(async (req, res) => {
	const action = req.query?.action ?? new URL(req.url, 'http://x').pathname.split('/').filter(Boolean).pop();
	if (action === 'connect') return handleConnect(req, res);
	if (action === 'callback') return handleCallback(req, res);
	return error(res, 404, 'not_found', 'unknown action');
});
