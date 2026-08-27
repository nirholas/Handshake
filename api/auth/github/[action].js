// GitHub social connect.
// Routes: /api/auth/github/connect    — redirect to GitHub OAuth
//         /api/auth/github/callback   — exchange code, store encrypted token
//         /api/auth/github/token      : connect with a personal access token
//         /api/auth/github/status     — connection status for the signed-in user
//         /api/auth/github/disconnect — revoke the grant and delete every memory
//                                       seeded from GitHub across the user's agents
//
// There are two ways in, and both land on the same encrypted row that the
// seeding endpoints read. OAuth is the nicer one, but it only exists on a
// deployment whose operator registered a GitHub OAuth app. The token path needs
// nothing provisioned, so self-hosters and this platform's users are never left
// with a Connect button that can only produce an error page.

import { sql } from '../../_lib/db.js';
import { getSessionUser } from '../../_lib/auth.js';
import { requireCsrf } from '../../_lib/csrf.js';
import { hmacSha256, constantTimeEquals } from '../../_lib/crypto.js';
import { cors, json, redirect, error, method, readJson, wrap, rateLimited } from '../../_lib/http.js';
import { limits, clientIp } from '../../_lib/rate-limit.js';
import { env } from '../../_lib/env.js';
import {
	encryptGithubToken,
	decryptGithubToken,
	classifyTokenScopes,
	looksLikeGithubToken,
	ALLOWED_TOKEN_SCOPES,
	RECOMMENDED_TOKEN_SCOPES,
} from '../../_lib/github-token.js';
import { revokeGrant, verifyToken } from '../../_lib/github-api.js';

import { fetchUpstream } from '../../_lib/upstream-fetch.js';
/** Where to send someone to mint a token with exactly the grants we accept. */
const TOKEN_CREATE_URL = `https://github.com/settings/tokens/new?description=three.ws%20agent%20memory&scopes=${RECOMMENDED_TOKEN_SCOPES.join(',')}`;
const TOKEN_MANAGE_URL = 'https://github.com/settings/tokens';

// ── CSRF state (HMAC-signed payload) ─────────────────────────────────────────

async function makeState(payload) {
	const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
	const sig = await hmacSha256(env.JWT_SECRET, data);
	return `${data}.${sig}`;
}

async function verifyState(state) {
	const dotIdx = state.lastIndexOf('.');
	if (dotIdx < 0) throw Object.assign(new Error('invalid state'), { status: 400 });
	const data = state.slice(0, dotIdx);
	const sig = state.slice(dotIdx + 1);
	const expected = await hmacSha256(env.JWT_SECRET, data);
	if (!constantTimeEquals(sig, expected)) throw Object.assign(new Error('invalid state signature'), { status: 400 });
	return JSON.parse(Buffer.from(data, 'base64url').toString());
}

// ── connect ───────────────────────────────────────────────────────────────────

async function handleConnect(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	if (!env.GITHUB_OAUTH_CLIENT_ID) {
		return error(res, 501, 'not_configured', 'GitHub OAuth is not configured');
	}

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const session = await getSessionUser(req);
	if (!session) return error(res, 401, 'unauthorized', 'sign in required');

	const url = new URL(req.url, 'http://x');
	const agentId = url.searchParams.get('agent_id') || '';

	const state = await makeState({ userId: session.id, agentId, ts: Date.now() });
	const redirectUri = `${env.APP_ORIGIN}/api/auth/github/callback`;

	const ghUrl = new URL('https://github.com/login/oauth/authorize');
	ghUrl.searchParams.set('client_id', env.GITHUB_OAUTH_CLIENT_ID);
	ghUrl.searchParams.set('redirect_uri', redirectUri);
	ghUrl.searchParams.set('scope', 'read:user,public_repo');
	ghUrl.searchParams.set('state', state);

	return redirect(res, ghUrl.toString());
}

// ── callback ──────────────────────────────────────────────────────────────────

async function handleCallback(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	// The IdP sends the user back here as a top-level GET navigation. Anything
	// else is not the OAuth flow, and the preflight above already says so.
	if (!method(req, res, ['GET'])) return;

	if (!env.GITHUB_OAUTH_CLIENT_ID || !env.GITHUB_OAUTH_CLIENT_SECRET) {
		return error(res, 501, 'not_configured', 'GitHub OAuth is not configured');
	}

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, 'http://x');
	const code = url.searchParams.get('code');
	const stateParam = url.searchParams.get('state');
	const ghError = url.searchParams.get('error');

	if (ghError) {
		return redirect(res, `${env.APP_ORIGIN}/settings?tab=connected-accounts&github=denied`);
	}
	if (!code || !stateParam) return error(res, 400, 'bad_request', 'missing code or state');

	let stateData;
	try {
		stateData = await verifyState(stateParam);
	} catch {
		return error(res, 400, 'invalid_state', 'invalid or tampered state parameter');
	}

	if (Date.now() - stateData.ts > 10 * 60 * 1000) {
		return error(res, 400, 'state_expired', 'OAuth state has expired — please try again');
	}

	// Session-bind: if a session is active it must match the state's userId so a
	// state token can't be replayed by a different user in their browser session.
	const callbackSession = await getSessionUser(req).catch(() => null);
	if (callbackSession && callbackSession.id !== stateData.userId) {
		return error(res, 403, 'session_mismatch', 'OAuth state does not match the current session');
	}

	// Exchange code for access token
	const tokenRes = await fetchUpstream('https://github.com/login/oauth/access_token', {
		method: 'POST',
		headers: { accept: 'application/json', 'content-type': 'application/json' },
		body: JSON.stringify({
			client_id: env.GITHUB_OAUTH_CLIENT_ID,
			client_secret: env.GITHUB_OAUTH_CLIENT_SECRET,
			code,
			redirect_uri: `${env.APP_ORIGIN}/api/auth/github/callback`,
		}),
	}, { name: 'github', timeoutMs: 10_000, attempts: 1, okWhen: () => true });
	if (!tokenRes.ok) {
		return redirect(res, `${env.APP_ORIGIN}/settings?tab=connected-accounts&github=error`);
	}
	const tokenData = await tokenRes.json();
	if (tokenData.error || !tokenData.access_token) {
		return redirect(res, `${env.APP_ORIGIN}/settings?tab=connected-accounts&github=error`);
	}

	// Fetch GitHub user profile
	const profileRes = await fetchUpstream('https://api.github.com/user', {
		headers: {
			authorization: `token ${tokenData.access_token}`,
			'user-agent': 'three.ws/1.0',
		},
	}, { name: 'github', timeoutMs: 10_000, attempts: 2, okWhen: () => true });
	if (!profileRes.ok) {
		return redirect(res, `${env.APP_ORIGIN}/settings?tab=connected-accounts&github=error`);
	}
	const profile = await profileRes.json();

	const encryptedToken = await encryptGithubToken(tokenData.access_token);

	await sql`
		INSERT INTO social_connections (user_id, provider, provider_uid, username, access_token, scopes, raw_data)
		VALUES (
			${stateData.userId},
			'github',
			${String(profile.id)},
			${profile.login},
			${encryptedToken},
			${tokenData.scope || 'read:user,public_repo'},
			${JSON.stringify({ connect_method: 'oauth' })}::jsonb
		)
		ON CONFLICT (user_id, provider) DO UPDATE SET
			provider_uid = EXCLUDED.provider_uid,
			username     = EXCLUDED.username,
			access_token = EXCLUDED.access_token,
			scopes       = EXCLUDED.scopes,
			raw_data     = EXCLUDED.raw_data,
			connected_at = now()
	`;

	const dest = stateData.agentId
		? `${env.APP_ORIGIN}/settings?tab=connected-accounts&github=connected&agent_id=${encodeURIComponent(stateData.agentId)}`
		: `${env.APP_ORIGIN}/settings?tab=connected-accounts&github=connected`;

	return redirect(res, dest);
}

// ── token connect ─────────────────────────────────────────────────────────────

/**
 * Connect with a personal access token instead of OAuth.
 *
 * This exists because OAuth is not always available: it needs an operator to
 * register a GitHub OAuth app and put its client id and secret on the service,
 * and until that happens /connect can only answer 501. A token needs nothing
 * provisioned on our side, so the consent flow, the catalog, the seed, and the
 * revoke all work on any deployment.
 *
 * Consent is at least as explicit as the OAuth screen: the user mints the token
 * themselves on GitHub, choosing its grants, and we refuse to store one carrying
 * access the feature cannot use (see ALLOWED_TOKEN_SCOPES). What the token is
 * then allowed to read is still narrowed twice more downstream, by the
 * public-only catalog and by the tick-boxes the user sets on it.
 */
async function handleTokenConnect(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const session = await getSessionUser(req);
	if (!session) return error(res, 401, 'unauthorized', 'sign in required');
	if (!(await requireCsrf(req, res, session.id))) return;

	const body = (await readJson(req)) ?? {};
	const token = typeof body.token === 'string' ? body.token.trim() : '';
	if (!looksLikeGithubToken(token)) {
		return error(res, 400, 'validation_error', 'paste a GitHub personal access token', {
			create_url: TOKEN_CREATE_URL,
		});
	}

	const check = await verifyToken(token);
	if (!check.valid) {
		return error(res, 400, 'invalid_token', 'GitHub rejected that token. Check it was copied in full and has not expired', {
			create_url: TOKEN_CREATE_URL,
		});
	}

	const scopeInfo = classifyTokenScopes(check.scopeHeader);
	if (!scopeInfo.allowed) {
		// Refusing here is the whole point: a token that can write to or read
		// private repositories is more access than seeding will ever use, and
		// storing it anyway would make the privacy promise on this feature false.
		return error(
			res,
			400,
			'token_scope_refused',
			`that token carries ${scopeInfo.refused.join(', ')}, which is more access than memory seeding needs. Create one with ${RECOMMENDED_TOKEN_SCOPES.join(', ')} instead`,
			{
				refused_scopes: scopeInfo.refused,
				allowed_scopes: ALLOWED_TOKEN_SCOPES,
				create_url: TOKEN_CREATE_URL,
			},
		);
	}

	const encryptedToken = await encryptGithubToken(token);
	const [row] = await sql`
		INSERT INTO social_connections (user_id, provider, provider_uid, username, access_token, scopes, raw_data)
		VALUES (
			${session.id},
			'github',
			${String(check.profile.id)},
			${check.profile.login},
			${encryptedToken},
			${scopeInfo.scopes.join(',')},
			${JSON.stringify({ connect_method: 'token', token_kind: scopeInfo.kind })}::jsonb
		)
		ON CONFLICT (user_id, provider) DO UPDATE SET
			provider_uid = EXCLUDED.provider_uid,
			username     = EXCLUDED.username,
			access_token = EXCLUDED.access_token,
			scopes       = EXCLUDED.scopes,
			raw_data     = EXCLUDED.raw_data,
			connected_at = now()
		RETURNING username, connected_at
	`;

	return json(res, 200, {
		connected: true,
		connect_method: 'token',
		token_kind: scopeInfo.kind,
		username: row.username,
		connected_at: row.connected_at,
		scopes: scopeInfo.scopes,
	});
}

// ── status ────────────────────────────────────────────────────────────────────

async function handleStatus(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const session = await getSessionUser(req);
	if (!session) return error(res, 401, 'unauthorized', 'sign in required');

	// Whether this deployment has a GitHub OAuth app at all. Without it every
	// connect click lands on a raw 501 from /connect, so the card needs to know
	// before it renders a button that cannot work.
	const configured = Boolean(env.GITHUB_OAUTH_CLIENT_ID && env.GITHUB_OAUTH_CLIENT_SECRET);

	// The token path needs nothing provisioned, so it is always on offer. The
	// card reads this to decide whether an unconfigured deployment is a dead end
	// (it is not) or simply one where pasting a token is the way in.
	const tokenConnect = {
		available: true,
		create_url: TOKEN_CREATE_URL,
		recommended_scopes: RECOMMENDED_TOKEN_SCOPES,
	};

	const [row] = await sql`
		SELECT username, connected_at, raw_data FROM social_connections
		WHERE user_id = ${session.id} AND provider = 'github'
	`;

	if (!row)
		return json(res, 200, { connected: false, configured, token_connect: tokenConnect, seeded_fact_count: 0 });

	const [seeded] = await sql`
		SELECT count(*)::int AS n
		FROM agent_memories m
		JOIN agent_identities a ON a.id = m.agent_id
		WHERE a.user_id = ${session.id} AND m.context->>'source' = 'github_seed'
	`;

	return json(res, 200, {
		connected: true,
		configured,
		token_connect: tokenConnect,
		// Rows written before the token path existed carry no marker, and OAuth
		// was the only way they could have been created.
		connect_method: connectMethod(row.raw_data),
		username: row.username,
		connected_at: row.connected_at,
		seeded_fact_count: seeded?.n ?? 0,
	});
}

/** Read the connect method off a stored row, defaulting pre-token rows to oauth. */
function connectMethod(rawData) {
	const parsed = typeof rawData === 'string' ? safeParse(rawData) : rawData;
	return parsed?.connect_method === 'token' ? 'token' : 'oauth';
}

function safeParse(text) {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

// ── disconnect ────────────────────────────────────────────────────────────────

/**
 * Revocation is not just "forget the token". Everything the connection was used
 * to learn goes with it: every memory seeded from GitHub, on every agent this
 * user owns, is deleted in the same transaction that drops the connection. An
 * OAuth grant is also revoked on GitHub's side so the token stops working there
 * too. A pasted personal access token cannot be revoked through the API by the
 * token itself, so that case reports honestly and hands back the page where the
 * user can delete it.
 */
async function handleDisconnect(req, res) {
	if (cors(req, res, { methods: 'POST,DELETE,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST', 'DELETE'])) return;

	const session = await getSessionUser(req);
	if (!session) return error(res, 401, 'unauthorized', 'sign in required');

	const [row] = await sql`
		SELECT id, access_token, raw_data FROM social_connections
		WHERE user_id = ${session.id} AND provider = 'github'
	`;
	if (!row) return json(res, 200, { disconnected: false, memories_deleted: 0 });
	const method_ = connectMethod(row.raw_data);

	const [deleted] = await sql.transaction([
		sql`
			DELETE FROM agent_memories
			WHERE context->>'source' = 'github_seed'
			  AND agent_id IN (SELECT id FROM agent_identities WHERE user_id = ${session.id})
			RETURNING id
		`,
		sql`DELETE FROM social_connections WHERE id = ${row.id}`,
	]);

	// GitHub-side revocation is best effort: the local grant is already gone, and
	// a GitHub outage must not leave the user's memories un-deleted. It also only
	// applies to OAuth: GitHub exposes no way to delete a personal access token
	// using that same token, so pretending to try one would only produce a
	// misleading `grant_revoked: false`.
	let revoked = false;
	if (method_ === 'oauth' && env.GITHUB_OAUTH_CLIENT_ID && env.GITHUB_OAUTH_CLIENT_SECRET) {
		try {
			const token = await decryptGithubToken(row.access_token);
			revoked = await revokeGrant(
				token,
				env.GITHUB_OAUTH_CLIENT_ID,
				env.GITHUB_OAUTH_CLIENT_SECRET,
			);
		} catch (e) {
			console.error('[auth/github] grant revoke failed', e?.message);
		}
	}

	return json(res, 200, {
		disconnected: true,
		connect_method: method_,
		memories_deleted: deleted.length,
		grant_revoked: revoked,
		// Only meaningful for a pasted token: the copy we held is destroyed, but
		// the token still exists on GitHub until the user deletes it there.
		revoke_url: method_ === 'token' ? TOKEN_MANAGE_URL : null,
	});
}

// ── dispatch ──────────────────────────────────────────────────────────────────

export default wrap(async (req, res) => {
	const url = new URL(req.url, 'http://x');
	const action = url.searchParams.get('action') || url.pathname.split('/').filter(Boolean).pop();

	if (action === 'connect') return handleConnect(req, res);
	if (action === 'callback') return handleCallback(req, res);
	if (action === 'token') return handleTokenConnect(req, res);
	if (action === 'status') return handleStatus(req, res);
	if (action === 'disconnect') return handleDisconnect(req, res);
	return error(res, 404, 'not_found', 'unknown github auth action');
});
