// GitHub OAuth social connect.
// Routes: /api/auth/github/connect    — redirect to GitHub OAuth
//         /api/auth/github/callback   — exchange code, store encrypted token
//         /api/auth/github/status     — connection status for the signed-in user
//         /api/auth/github/disconnect — revoke the grant and delete every memory
//                                       seeded from GitHub across the user's agents

import { sql } from '../../_lib/db.js';
import { getSessionUser } from '../../_lib/auth.js';
import { hmacSha256, constantTimeEquals } from '../../_lib/crypto.js';
import { cors, json, redirect, error, method, wrap, rateLimited } from '../../_lib/http.js';
import { limits, clientIp } from '../../_lib/rate-limit.js';
import { env } from '../../_lib/env.js';
import { encryptGithubToken, decryptGithubToken } from '../../_lib/github-token.js';
import { revokeGrant } from '../../_lib/github-api.js';

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
	const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
		method: 'POST',
		headers: { accept: 'application/json', 'content-type': 'application/json' },
		body: JSON.stringify({
			client_id: env.GITHUB_OAUTH_CLIENT_ID,
			client_secret: env.GITHUB_OAUTH_CLIENT_SECRET,
			code,
			redirect_uri: `${env.APP_ORIGIN}/api/auth/github/callback`,
		}),
	});
	if (!tokenRes.ok) {
		return redirect(res, `${env.APP_ORIGIN}/settings?tab=connected-accounts&github=error`);
	}
	const tokenData = await tokenRes.json();
	if (tokenData.error || !tokenData.access_token) {
		return redirect(res, `${env.APP_ORIGIN}/settings?tab=connected-accounts&github=error`);
	}

	// Fetch GitHub user profile
	const profileRes = await fetch('https://api.github.com/user', {
		headers: {
			authorization: `token ${tokenData.access_token}`,
			'user-agent': 'three.ws/1.0',
		},
	});
	if (!profileRes.ok) {
		return redirect(res, `${env.APP_ORIGIN}/settings?tab=connected-accounts&github=error`);
	}
	const profile = await profileRes.json();

	const encryptedToken = await encryptGithubToken(tokenData.access_token);

	await sql`
		INSERT INTO social_connections (user_id, provider, provider_uid, username, access_token, scopes)
		VALUES (
			${stateData.userId},
			'github',
			${String(profile.id)},
			${profile.login},
			${encryptedToken},
			${tokenData.scope || 'read:user,public_repo'}
		)
		ON CONFLICT (user_id, provider) DO UPDATE SET
			provider_uid = EXCLUDED.provider_uid,
			username     = EXCLUDED.username,
			access_token = EXCLUDED.access_token,
			scopes       = EXCLUDED.scopes,
			connected_at = now()
	`;

	const dest = stateData.agentId
		? `${env.APP_ORIGIN}/settings?tab=connected-accounts&github=connected&agent_id=${encodeURIComponent(stateData.agentId)}`
		: `${env.APP_ORIGIN}/settings?tab=connected-accounts&github=connected`;

	return redirect(res, dest);
}

// ── status ────────────────────────────────────────────────────────────────────

async function handleStatus(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const session = await getSessionUser(req);
	if (!session) return error(res, 401, 'unauthorized', 'sign in required');

	const [row] = await sql`
		SELECT username, connected_at FROM social_connections
		WHERE user_id = ${session.id} AND provider = 'github'
	`;

	if (!row) return json(res, 200, { connected: false, seeded_fact_count: 0 });

	const [seeded] = await sql`
		SELECT count(*)::int AS n
		FROM agent_memories m
		JOIN agent_identities a ON a.id = m.agent_id
		WHERE a.user_id = ${session.id} AND m.context->>'source' = 'github_seed'
	`;

	return json(res, 200, {
		connected: true,
		username: row.username,
		connected_at: row.connected_at,
		seeded_fact_count: seeded?.n ?? 0,
	});
}

// ── disconnect ────────────────────────────────────────────────────────────────

/**
 * Revocation is not just "forget the token". Everything the connection was used
 * to learn goes with it: every memory seeded from GitHub, on every agent this
 * user owns, is deleted in the same transaction that drops the connection. The
 * grant is also revoked on GitHub's side so the token stops working there too.
 */
async function handleDisconnect(req, res) {
	if (cors(req, res, { methods: 'POST,DELETE,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST', 'DELETE'])) return;

	const session = await getSessionUser(req);
	if (!session) return error(res, 401, 'unauthorized', 'sign in required');

	const [row] = await sql`
		SELECT id, access_token FROM social_connections
		WHERE user_id = ${session.id} AND provider = 'github'
	`;
	if (!row) return json(res, 200, { disconnected: false, memories_deleted: 0 });

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
	// a GitHub outage must not leave the user's memories un-deleted.
	let revoked = false;
	if (env.GITHUB_OAUTH_CLIENT_ID && env.GITHUB_OAUTH_CLIENT_SECRET) {
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
		memories_deleted: deleted.length,
		grant_revoked: revoked,
	});
}

// ── dispatch ──────────────────────────────────────────────────────────────────

export default wrap(async (req, res) => {
	const url = new URL(req.url, 'http://x');
	const action = url.searchParams.get('action') || url.pathname.split('/').filter(Boolean).pop();

	if (action === 'connect') return handleConnect(req, res);
	if (action === 'callback') return handleCallback(req, res);
	if (action === 'status') return handleStatus(req, res);
	if (action === 'disconnect') return handleDisconnect(req, res);
	return error(res, 404, 'not_found', 'unknown github auth action');
});
