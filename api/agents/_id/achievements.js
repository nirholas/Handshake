/**
 * GET /api/agents/:id/achievements
 *
 * The agent's earned + locked achievements, computed from REAL platform data
 * (coins launched, graduations/migrations, peak market cap, distinct supporters,
 * buyback burns, reputation tier, tenure). The gather + cache + pure scoring all
 * live in api/_lib/agent-achievements-data.js so the OG card and the leaderboard
 * read the exact same numbers off the same Redis entry.
 *
 * Public read — the badges are a trust signal others rely on, so owner and
 * visitor see the same set.
 */

import { cors, json, error, method, wrap, rateLimited } from '../../_lib/http.js';
import { limits, clientIp } from '../../_lib/rate-limit.js';
import { isUuid } from '../../_lib/validate.js';
import { loadAgentAchievements } from '../../_lib/agent-achievements-data.js';

export const handleAchievements = wrap(async (req, res, agentId) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;
	if (!isUuid(String(agentId || ''))) return error(res, 404, 'not_found', 'agent not found');

	const rl = await limits.agentProfileIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const body = await loadAgentAchievements(agentId);
	if (!body) return error(res, 404, 'not_found', 'agent not found');

	if (body._cache === 'HIT') res.setHeader('X-Cache', 'HIT');
	delete body._cache;
	res.setHeader('cache-control', 'public, max-age=60');
	return json(res, 200, body);
});

export default handleAchievements;
