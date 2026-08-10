// POST /api/agent/session
//
// Mint a long-lived bearer token for a specific agent the caller owns.
// Returned token is used as AGENT_BEARER_TOKEN by the screen-caster service.
//
// Request body: { agentId: string }
//
// Response: {
//   agentId, agentName, avatarUrl,
//   token,              // JWT to paste into AGENT_BEARER_TOKEN
//   expiresAt,          // ISO string, 7 days from now
//   commands: { node, docker }  // ready-to-run launch strings
// }
//
// Auth: requires a signed-in session (plus an X-CSRF-Token header) or an
// existing bearer token.

import { SignJWT } from 'jose';
import { cors, json, method, readJson, wrap, error } from '../_lib/http.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { isUuid } from '../_lib/validate.js';
import { requireCsrf } from '../_lib/csrf.js';
import { env } from '../_lib/env.js';
import { sql } from '../_lib/db.js';

const SESSION_TTL_SEC = 60 * 60 * 24 * 7; // 7 days

// Default watch target for the pump-monitor task: the platform's own coin.
const THREE_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

function jwtKey() {
	return new TextEncoder().encode(env.JWT_SECRET);
}

async function mintCasterToken({ userId, agentId }) {
	const now = Math.floor(Date.now() / 1000);
	return new SignJWT({
		token_use: 'access',
		scope:     'agent:screen',
		agent_id:  agentId,
	})
		.setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
		.setIssuer(env.ISSUER)
		.setSubject(userId)
		.setAudience(env.MCP_RESOURCE)
		.setIssuedAt(now)
		.setExpirationTime(now + SESSION_TTL_SEC)
		.sign(jwtKey());
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	// The two auth sources report the user id under DIFFERENT keys: a cookie
	// session yields the users row (`id`), a bearer token yields `{ userId }`.
	// Reading `userId` off the session result matched nothing, so every
	// signed-in caller got a 401 and the watch panel's "generate session"
	// button (src/shared/agent-watch-panel.js, cookie-only) could never mint a
	// token. Read each source with its own key, and fall through to the bearer
	// when the cookie resolves nothing. api/agent-screen-push.js, the endpoint
	// this token is minted for, already does exactly this.
	const session = await getSessionUser(req).catch(() => null);
	const userId = session?.id
		|| (await authenticateBearer(extractBearer(req)).catch(() => null))?.userId
		|| null;
	if (!userId) return error(res, 401, 'unauthorized', 'sign in required');

	// Minting a 7-day bearer token is a state-changing POST, and a cookie rides
	// along automatically on a cross-site request. requireCsrf exempts bearer
	// callers (the token is its own proof of intent), so only the browser path
	// pays for it, exactly as the other cookie-authenticated mutations do.
	if (!(await requireCsrf(req, res, userId))) return;

	// Bound the body: this is a two-field request, and passing `res` here as the
	// limit disabled the size cap entirely (every comparison against an object
	// is false), letting one caller stream an unbounded body into memory.
	const body = await readJson(req, 4_000);
	if (!body || typeof body !== 'object') {
		return error(res, 400, 'validation_error', 'JSON object body required');
	}

	const agentId = typeof body.agentId === 'string' ? body.agentId.trim() : '';
	// agent_identities.id is a uuid column: an unvalidated string reaches
	// Postgres as a 22P02 cast error, which surfaces as an unhandled 500 plus a
	// Sentry event and an ops alert instead of the 400 the caller deserves.
	if (!isUuid(agentId)) return error(res, 400, 'validation_error', 'valid agentId required');

	// Verify ownership and fetch agent details in one query.
	const [agent] = await sql`
		SELECT id, name, meta
		FROM agent_identities
		WHERE id = ${agentId}
		  AND user_id = ${userId}
		  AND deleted_at IS NULL
		LIMIT 1
	`;
	if (!agent) return error(res, 403, 'forbidden', 'agent not found or not yours');

	const token      = await mintCasterToken({ userId, agentId });
	const expiresAt  = new Date(Date.now() + SESSION_TTL_SEC * 1000).toISOString();
	const agentName  = agent.name || 'Agent';
	const avatarUrl  = agent.meta?.studio?.avatar_glb_url
		|| agent.meta?.studio?.avatar_model_url
		|| '';

	const pushUrl   = 'https://three.ws/api/agent-screen-push';
	const streamUrl = 'https://three.ws/agent-screen?agentId=' + encodeURIComponent(agentId);

	const nodeCmd = [
		`AGENT_ID="${agentId}"`,
		`AGENT_BEARER_TOKEN="${token}"`,
		`PUSH_URL="${pushUrl}"`,
		`TASK=pump-monitor`,
		`TASK_ARG="${THREE_MINT}"`,
		`node services/agent-screen-caster/index.js`,
	].join(' \\\n  ');

	// The container lane builds from the service's own Dockerfile, which is the
	// path services/agent-screen-caster/README.md documents. There is no
	// published registry image for this service, so naming one handed the
	// operator a pull that can only fail.
	const dockerCmd = [
		'docker build -t agent-screen-caster services/agent-screen-caster',
		[
			`docker run --rm`,
			`  -e AGENT_ID="${agentId}"`,
			`  -e AGENT_BEARER_TOKEN="${token}"`,
			`  -e PUSH_URL="${pushUrl}"`,
			`  -e TASK=pump-monitor`,
			`  -e TASK_ARG="${THREE_MINT}"`,
			`  agent-screen-caster`,
		].join(' \\\n'),
	].join('\n\n');

	return json(res, 200, {
		agentId,
		agentName,
		avatarUrl,
		token,
		expiresAt,
		streamUrl,
		commands: { node: nodeCmd, docker: dockerCmd },
	});
});
