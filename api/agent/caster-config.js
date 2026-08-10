// POST /api/agent/caster-config
//
// Generates a scoped API key for an agent and returns a ready-to-copy
// .env file + Docker run command for the agent-screen-caster service.
// The key is stored hashed: this is the only time the plaintext is returned.
//
// Body: { agentId: string }
// Auth: session cookie (CSRF-guarded) or a bearer token carrying the `profile`
// scope. Same contract as api/api-keys.js, because this endpoint mints exactly
// the same kind of live key.

import { cors, json, method, readJson, wrap, error, rateLimited } from '../_lib/http.js';
import { getSessionUser, authenticateBearer, extractBearer, hasScope } from '../_lib/auth.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { requireCsrf } from '../_lib/csrf.js';
import { randomToken, sha256 } from '../_lib/crypto.js';
import { isUuid } from '../_lib/validate.js';
import { sql } from '../_lib/db.js';

const CASTER_SCOPE = 'agents:read agents:write';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	// getSessionUser returns the user row (`id`), authenticateBearer takes the
	// raw token and returns `{ userId, scope }`. Mixing the two shapes up is what
	// made every call here answer 401 regardless of credentials.
	const session = await getSessionUser(req);
	const bearer = session ? null : await authenticateBearer(extractBearer(req));
	if (!session && !bearer) return error(res, 401, 'unauthorized', 'sign in required');
	if (bearer && !hasScope(bearer.scope, 'profile')) {
		return error(res, 403, 'insufficient_scope', 'requires profile scope');
	}
	const userId = session?.id ?? bearer.userId;

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	// Minting a live key off a cookie session is precisely the request worth
	// forging cross-site, so the cookie lane carries the same CSRF guard as
	// api/api-keys.js. requireCsrf is a no-op for bearer callers.
	if (!(await requireCsrf(req, res, userId))) return;

	const body = await readJson(req);
	const agentId = typeof body?.agentId === 'string' ? body.agentId.trim() : '';
	if (!isUuid(agentId)) return error(res, 400, 'validation_error', 'valid agentId required');

	// Confirm the caller owns this agent.
	const [agentRow] = await sql`
		SELECT id, name, display_name FROM agent_identities
		WHERE id = ${agentId} AND user_id = ${userId} AND deleted_at IS NULL
	`;
	if (!agentRow) return error(res, 403, 'forbidden', 'not your agent');

	const agentName = agentRow.name || agentRow.display_name || agentId.slice(0, 8);

	// Create the API key.
	const rawToken  = `sk_live_${randomToken(32)}`;
	const prefix    = rawToken.slice(0, 14);
	const tokenHash = await sha256(rawToken);
	const keyName   = `Screen Caster: ${agentName}`;

	const [keyRow] = await sql`
		INSERT INTO api_keys (user_id, name, token_hash, prefix, scope)
		VALUES (${userId}, ${keyName}, ${tokenHash}, ${prefix}, ${CASTER_SCOPE})
		RETURNING id, created_at
	`;

	const envBlock = [
		`# Screen Caster: ${agentName}`,
		`# Generated ${new Date().toISOString()}`,
		``,
		`AGENT_ID=${agentId}`,
		`AGENT_BEARER_TOKEN=${rawToken}`,
		`PUSH_URL=https://three.ws/api/agent-screen-push`,
		``,
		`# Task: pump-monitor | trade`,
		`TASK=pump-monitor`,
		`# Mint to watch (pump-monitor) or JSON trade spec (trade):`,
		`TASK_ARG=FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump`,
		``,
		`FRAME_INTERVAL_MS=400`,
		`JPEG_QUALITY=72`,
		`HEADLESS=true`,
	].join('\n');

	const dockerCmd = [
		`docker run --rm \\`,
		`  -e AGENT_ID=${agentId} \\`,
		`  -e AGENT_BEARER_TOKEN=${rawToken} \\`,
		`  -e PUSH_URL=https://three.ws/api/agent-screen-push \\`,
		`  -e TASK=pump-monitor \\`,
		`  -e TASK_ARG=FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump \\`,
		`  three-ws/agent-screen-caster`,
	].join('\n');

	return json(res, 200, {
		keyId:     keyRow.id,
		prefix,
		agentId,
		agentName,
		scope:     CASTER_SCOPE,
		createdAt: keyRow.created_at,
		envBlock,
		dockerCmd,
	});
});
