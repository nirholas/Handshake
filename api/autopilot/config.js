// /api/autopilot/config — the agent's autopilot permission/scope model (owner-only).
//
// GET  ?agentId=  → { config, trust }
// POST { agentId, ...patch } → { config }   (patch: enabled, scopes, auto_execute,
//                                            daily_spend_sol, require_confirm)
//
// Scope lives on agent_identities.meta.autopilot and is enforced server-side at
// execution time (api/_lib/autopilot.js). Nothing the agent does is possible
// without a scope the owner granted here. $THREE is the only coin referenced.

import { sql } from '../_lib/db.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { cors, json, method, readJson, wrap, error } from '../_lib/http.js';
import { requireCsrf } from '../_lib/csrf.js';
import { getAutopilotConfig, setAutopilotConfig, computeTrust } from '../_lib/autopilot.js';
import { isUuid } from '../_lib/validate.js';

async function resolveAuth(req) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id };
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) return { userId: bearer.userId };
	return null;
}

async function ownedAgent(req, res, agentId, auth) {
	if (!agentId) {
		error(res, 400, 'validation_error', 'agentId required');
		return null;
	}
	if (!isUuid(agentId)) {
		error(res, 400, 'validation_error', 'agentId must be a uuid');
		return null;
	}
	const [agent] = await sql`
		SELECT id, user_id, name, meta FROM agent_identities WHERE id = ${agentId} AND deleted_at IS NULL
	`;
	if (!agent) {
		error(res, 404, 'not_found', 'agent not found');
		return null;
	}
	if (agent.user_id !== auth.userId) {
		error(res, 403, 'forbidden', 'not your agent');
		return null;
	}
	return agent;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required');

	if (req.method === 'GET') {
		const url = new URL(req.url, 'http://x');
		const agentId = url.searchParams.get('agentId') || url.searchParams.get('agent_id');
		const agent = await ownedAgent(req, res, agentId, auth);
		if (!agent) return;
		const config = getAutopilotConfig(agent.meta);
		const trust = await computeTrust({ agentId });
		return json(res, 200, { config, trust });
	}

	if (!(await requireCsrf(req, res, auth.userId))) return;
	const body = await readJson(req);
	const agentId = body.agentId || body.agent_id;
	const agent = await ownedAgent(req, res, agentId, auth);
	if (!agent) return;

	const patch = {};
	if ('enabled' in body) patch.enabled = body.enabled === true;
	if (body.scopes && typeof body.scopes === 'object') patch.scopes = body.scopes;
	if (body.auto_execute && typeof body.auto_execute === 'object') patch.auto_execute = body.auto_execute;
	if ('daily_spend_sol' in body) patch.daily_spend_sol = body.daily_spend_sol;
	if ('require_confirm' in body) patch.require_confirm = body.require_confirm === true;

	const config = await setAutopilotConfig(agentId, patch);
	return json(res, 200, { config });
});
