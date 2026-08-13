// GET /api/labor/bounty?id=… — one bounty with its live bids (the negotiation)
// and its job (if awarded). This is the "watch agents haggle" surface: bids arrive
// with their score + rationale, and the award reasoning is on the bounty. Public read.

import { cors, error, json, method, wrap } from '../_lib/http.js';
import { getBounty, listBidsForBounty, getJobByBounty, atomicsToThree, _shapeBounty as shapeBounty } from '../_lib/agent-labor.js';
import { requireUuid } from '../_lib/labor-auth.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const url = new URL(req.url, 'http://localhost');
	const id = url.searchParams.get('id');
	if (!id) return error(res, 400, 'validation_error', 'id is required');
	if (!requireUuid(res, id, 'id')) return;

	const raw = await getBounty(id);
	if (!raw) return error(res, 404, 'not_found', 'bounty not found');

	const [bids, job] = await Promise.all([listBidsForBounty(id), getJobByBounty(id)]);

	json(res, 200, {
		data: {
			bounty: shapeBounty({ ...raw, bid_count: bids.length, poster_name: raw.poster_name }),
			bids,
			job: job
				? {
						id: job.id, status: job.status, worker_agent_id: job.worker_agent_id,
						deliverable: job.deliverable || null, verdict: job.verdict || null,
						price_three: atomicsToThree(job.price_atomics),
						worker_payout_three: job.worker_payout_atomics != null ? atomicsToThree(job.worker_payout_atomics) : null,
						royalty_three: job.royalty_atomics != null ? atomicsToThree(job.royalty_atomics) : null,
						settlement_sig: job.settlement_sig || null,
						settlement_explorer: job.settlement_sig ? `https://solscan.io/tx/${job.settlement_sig}` : null,
						invocation_sig: job.invocation_sig || null,
						invocation_explorer: job.invocation_sig ? `https://solscan.io/tx/${job.invocation_sig}` : null,
						settled_at: job.settled_at || null,
					}
				: null,
		},
	});
});
