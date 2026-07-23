// POST /api/agent/session
//
// Mint a long-lived bearer token for a specific agent the caller owns.
// Returned token is used as AGENT_BEARER_TOKEN by the screen-caster service.
//
// Request body: { agentId: string }
//
// Response: {
//   agentId, agentName, avatarUrl,
//   token,              // JWT — paste into AGENT_BEARER_TOKEN
//   expiresAt,          // ISO string, 7 days from now
//   commands: { node, docker }  // ready-to-run launch strings
// }
//
// Auth: requires a signed-in session or an existing bearer token.

import { SignJWT } from 'jose';
import { cors, json, method, readJson, wrap, error } from '../_lib/http.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { env } from '../_lib/env.js';
import { sql } from '../_lib/db.js';

const SESSION_TTL_SEC = 60 * 60 * 24 * 7; // 7 days

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

	const auth = await getSessionUser(req).catch(() => null)
		// extractBearer yields the token string authenticateBearer expects —
		// passing the raw request object always threw inside and silently
		// disabled bearer auth on this endpoint (fail-closed, but a bug).
		|| await authenticateBearer(extractBearer(req)).catch(() => null);
	if (!auth?.userId) return error(res, 401, 'unauthorized', 'sign in required');

	const body = await readJson(req, res);
	if (!body) return;

	const { agentId } = body;
	if (!agentId) return error(res, 400, 'validation_error', 'agentId required');

	// Verify ownership and fetch agent details in one query.
	const [agent] = await sql`
		SELECT id, name, meta
		FROM agent_identities
		WHERE id = ${agentId}
		  AND user_id = ${auth.userId}
		  AND deleted_at IS NULL
		LIMIT 1
	`;
	if (!agent) return error(res, 403, 'forbidden', 'agent not found or not yours');

	const token      = await mintCasterToken({ userId: auth.userId, agentId });
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
		`TASK_ARG="FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump"`,
		`node services/agent-screen-caster/index.js`,
	].join(' \\\n  ');

	const dockerCmd = [
		`docker run --rm`,
		`  -e AGENT_ID="${agentId}"`,
		`  -e AGENT_BEARER_TOKEN="${token}"`,
		`  -e PUSH_URL="${pushUrl}"`,
		`  -e TASK=pump-monitor`,
		`  -e TASK_ARG="FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump"`,
		`  ghcr.io/nirholas/three-ws-agent-screen:latest`,
	].join(' \\\n');

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
