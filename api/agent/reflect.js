// POST /api/agent/reflect — run a real reflection pass for an agent (owner-only).
//
// Body: { agentId, force? }
// Triggers the memory-consolidation engine (api/_lib/reflection.js): the agent
// reads its own recent raw memories + signed action log, runs a real LLM pass,
// and persists schema-valid "dreams" (each citing the source memory ids it drew
// from). Debounced + daily-capped server-side, so the review surface can call
// this on open without spamming the model. `force` (owner-initiated "Reflect
// now") bypasses the debounce.
//
// Response: { status, reason?, created: [dream...], candidates, capped }

import { sql } from '../_lib/db.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { cors, json, method, readJson, wrap, error, rateLimited } from '../_lib/http.js';
import { requireCsrf } from '../_lib/csrf.js';
import { isUuid } from '../_lib/validate.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { runReflection } from '../_lib/reflection.js';

export const maxDuration = 60;

async function resolveAuth(req) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id };
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) return { userId: bearer.userId };
	return null;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required');
	if (!(await requireCsrf(req, res, auth.userId))) return;

	const body = await readJson(req);
	const agentId = body?.agentId || body?.agent_id;
	// agent_identities.id is a uuid column: a non-uuid would surface as a 500
	// from Postgres (22P02) instead of the 400 the caller can actually fix.
	if (!isUuid(agentId)) return error(res, 400, 'validation_error', 'valid agentId required');

	const [agent] = await sql`
		SELECT id, user_id, name, description
		FROM agent_identities
		WHERE id = ${agentId} AND deleted_at IS NULL
	`;
	if (!agent) return error(res, 404, 'not_found', 'agent not found');
	if (agent.user_id !== auth.userId) return error(res, 403, 'forbidden', 'not your agent');

	// Reflection is an LLM call — rate-limit per caller independently of the
	// engine's own debounce (which protects the model spend over a longer window).
	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl, 'too many reflection requests');

	const force = body.force === true;
	const result = await runReflection({
		agentId,
		userId: auth.userId,
		trigger: force ? 'manual' : 'on-demand',
		agent: { name: agent.name, description: agent.description },
		force,
	});

	const code = result.status === 'error' ? 502 : 200;
	return json(res, code, result);
});
