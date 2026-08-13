/**
 * GET /api/marketplace/check-skill-access?agent_id=…&skill=…
 * Returns { has_access: boolean } for the authenticated caller.
 */

import { authenticateBearer, extractBearer, getSessionUser } from '../_lib/auth.js';
import { cors, error, json, method, wrap, rateLimited } from '../_lib/http.js';
import { clientIp, limits } from '../_lib/rate-limit.js';
import { MonetizationService } from '../_lib/services/MonetizationService.js';
import { isUuid } from '../_lib/validate.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const session = await getSessionUser(req);
	const bearer = session ? null : await authenticateBearer(extractBearer(req));
	const userId = session?.id || bearer?.userId;
	if (!userId) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.widgetRead(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, 'http://x');
	const agentId = url.searchParams.get('agent_id');
	const skill = url.searchParams.get('skill');
	if (!agentId || !skill) {
		return error(res, 400, 'validation_error', 'agent_id and skill required');
	}
	// agent_skill_prices.agent_id is a uuid column: a malformed id would reach
	// Postgres as 22P02 and surface as a 500 on plain bad input.
	if (!isUuid(agentId)) {
		return error(res, 400, 'validation_error', 'agent_id must be a valid uuid');
	}

	const service = new MonetizationService(userId);
	const { has_access } = await service.checkSkillOwnership(agentId, skill);
	return json(res, 200, { data: { has_access } });
});
