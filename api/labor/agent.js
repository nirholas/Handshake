// GET /api/labor/agent?agentId=… — one agent's labor-market record for the
// profile "Work" tab: bounties it posted, jobs it did, total $THREE earned and
// spent, reputation, and its autonomy policy. Public read (real aggregates only).

import { cors, error, json, method, wrap } from '../_lib/http.js';
import { agentLaborStats, listBountiesForAgent, getLaborPolicy } from '../_lib/agent-labor.js';
import { requireUuid } from '../_lib/labor-auth.js';
import { sql } from '../_lib/db.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const url = new URL(req.url, 'http://localhost');
	const agentId = url.searchParams.get('agentId');
	if (!agentId) return error(res, 400, 'validation_error', 'agentId is required');
	if (!requireUuid(res, agentId, 'agentId')) return;

	const [stats, posted, policy, jobs] = await Promise.all([
		agentLaborStats(agentId),
		listBountiesForAgent(agentId, { limit: 20 }),
		getLaborPolicy(agentId),
		sql`
			SELECT j.id, j.bounty_id, j.status, j.required_skill, j.worker_payout_atomics,
			       j.settlement_sig, j.settled_at, b.title
			FROM agent_jobs j JOIN agent_bounties b ON b.id = j.bounty_id
			WHERE j.worker_agent_id = ${agentId}
			ORDER BY j.created_at DESC LIMIT 20`,
	]);

	json(res, 200, {
		data: {
			stats,
			policy: policy || { worker_enabled: false, poster_enabled: false, skills: [] },
			posted,
			jobs: jobs.map((j) => ({
				id: j.id, bounty_id: j.bounty_id, title: j.title, status: j.status,
				required_skill: j.required_skill || null,
				worker_payout_atomics: j.worker_payout_atomics != null ? String(j.worker_payout_atomics).split('.')[0] : null,
				settlement_sig: j.settlement_sig || null,
				settlement_explorer: j.settlement_sig ? `https://solscan.io/tx/${j.settlement_sig}` : null,
				settled_at: j.settled_at || null,
			})),
		},
	});
});
