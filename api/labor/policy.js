// /api/labor/policy — read or set an agent's labor-market autonomy policy.
//   GET  ?agentId=…  → the agent's policy (public; powers the "for hire" badge).
//   PUT  { agentId, … } → owner-gated upsert of the worker/poster autonomy config.

import { cors, error, json, method, readJson, wrap } from '../_lib/http.js';
import { authWrite, loadOwnedAgent, ownershipError, requireUuid } from '../_lib/labor-auth.js';
import { getLaborPolicy, upsertLaborPolicy, parseAtomics, parseThree } from '../_lib/agent-labor.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,PUT,OPTIONS', credentials: true })) return;

	// HEAD is the read, not the write: without this it fell past the GET branch,
	// passed the method gate (HEAD is allowed wherever GET is), and hit authWrite.
	if (req.method === 'GET' || req.method === 'HEAD') {
		const url = new URL(req.url, 'http://localhost');
		const agentId = url.searchParams.get('agentId');
		if (!agentId) return error(res, 400, 'validation_error', 'agentId is required');
		if (!requireUuid(res, agentId, 'agentId')) return;
		const policy = await getLaborPolicy(agentId);
		return json(res, 200, { data: policy || { agent_id: agentId, worker_enabled: false, poster_enabled: false, skills: [] } });
	}

	if (!method(req, res, ['GET', 'PUT'])) return;

	const auth = await authWrite(req, res);
	if (!auth) return;
	const { userId } = auth;

	const body = (await readJson(req)) || {};
	const { agentId } = body;
	if (!agentId) return error(res, 400, 'validation_error', 'agentId is required');
	if (!requireUuid(res, agentId, 'agentId')) return;

	// Both ceilings are optional, but a malformed one must be refused rather than
	// coerced: silently storing zero would turn "bid up to 5 $THREE" into a policy
	// that can never bid, and a policy the owner cannot see is wrong.
	const ceilings = {};
	for (const [field, three, atomics] of [
		['maxBid', body.maxBidThree, body.maxBidAtomics],
		['minReward', body.minRewardThree, body.minRewardAtomics],
	]) {
		if (three == null && atomics == null) {
			ceilings[field] = null;
			continue;
		}
		const parsed = three != null ? parseThree(three) : parseAtomics(atomics);
		if (parsed == null) {
			return error(res, 400, 'validation_error', `${field}Three/${field}Atomics must be a non-negative amount`);
		}
		ceilings[field] = parsed;
	}
	if (body.minBids != null && !(Number.isInteger(Number(body.minBids)) && Number(body.minBids) >= 1)) {
		return error(res, 400, 'validation_error', 'minBids must be an integer of at least 1');
	}
	if (body.meta != null && (typeof body.meta !== 'object' || Array.isArray(body.meta))) {
		return error(res, 400, 'validation_error', 'meta must be an object');
	}

	try {
		await loadOwnedAgent(agentId, userId);
	} catch (e) {
		return ownershipError(res, e);
	}

	const policy = await upsertLaborPolicy(agentId, userId, {
		workerEnabled: !!body.workerEnabled,
		posterEnabled: !!body.posterEnabled,
		autoAward: !!body.autoAward,
		skills: Array.isArray(body.skills) ? body.skills : [],
		minBids: body.minBids,
		maxBidAtomics: ceilings.maxBid,
		minRewardAtomics: ceilings.minReward,
		meta: body.meta || {},
	});

	return json(res, 200, { ok: true, data: policy });
});
