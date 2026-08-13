// POST /api/labor/award — the poster (owner of the posting agent) awards a bid.
// Moves no money on its own (the reward is already escrowed): it transitions the
// bounty to 'working', creates the job, and rejects the other bids. If the worker
// is autonomous, the autopilot then performs + settles the job through to payout.

import { cors, error, json, method, readJson, wrap } from '../_lib/http.js';
import { authWrite, loadOwnedAgent } from '../_lib/labor-auth.js';
import { getBounty, getBid, listBidsForBounty, getJobByBounty } from '../_lib/agent-labor.js';
import { applyAward } from '../_lib/labor-match.js';
import { runAutopilot } from '../_lib/labor-settle.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const auth = await authWrite(req, res);
	if (!auth) return;
	const { userId } = auth;

	const body = (await readJson(req)) || {};
	const { bountyId, bidId } = body;
	if (!bountyId || !bidId) return error(res, 400, 'validation_error', 'bountyId and bidId are required');

	const bounty = await getBounty(bountyId);
	if (!bounty) return error(res, 404, 'not_found', 'bounty not found');

	try {
		await loadOwnedAgent(bounty.poster_agent_id, userId); // caller must own the poster
	} catch (e) {
		return error(res, e.status || 400, e.code || 'bad_request', e.message);
	}

	if (bounty.status !== 'open') return error(res, 409, 'bounty_closed', `this bounty is ${bounty.status}, cannot be awarded`);

	const rawBid = await getBid(bidId);
	if (!rawBid || rawBid.bounty_id !== bountyId) return error(res, 404, 'bid_not_found', 'bid not found for this bounty');
	if (rawBid.status !== 'pending') return error(res, 409, 'bid_unavailable', `that bid is ${rawBid.status}`);

	const shaped = (await listBidsForBounty(bountyId)).find((b) => b.id === bidId);
	const winner = { ...shaped, worker_user_id: rawBid.worker_user_id, price_atomics: String(rawBid.price_atomics) };
	const rationale = `Awarded by owner to ${winner.worker_name} — ${winner.price_three} $THREE, score ${winner.score ?? 'n/a'}.`;

	const awarded = await applyAward({ bounty, winner, rationale, auto: false });

	// If the worker is autonomous, drive perform → verify → settle to completion.
	const autopilot = await runAutopilot(bountyId).catch(() => null);
	const job = (await getJobByBounty(bountyId)) || awarded.job;

	return json(res, 200, {
		ok: true,
		award: { bounty_id: bountyId, bid_id: bidId, worker_agent_id: winner.worker_agent_id, rationale, job_id: job?.id || null, status: job?.status || 'working' },
		autopilot: autopilot || { bids: 0, awarded: true, settled: null, settledNow: false },
	});
});
