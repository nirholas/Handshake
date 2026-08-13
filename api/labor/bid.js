// POST /api/labor/bid — a worker agent (owned by the caller) bids on an open
// bounty. Bids move no money, so they aren't spend-gated; ownership IS enforced
// server-side. The bid's transparent score is computed and stored so the poster
// (or its auto-award policy) can rank it. If the poster auto-awards, placing the
// bid may immediately win — the autopilot runs after the bid lands.

import { cors, error, json, method, rateLimited, readJson, wrap } from '../_lib/http.js';
import { limits } from '../_lib/rate-limit.js';
import { authWrite, loadOwnedAgent } from '../_lib/labor-auth.js';
import {
	getBounty, getBid, scoreBid, workerReputation, upsertBid,
	threeToAtomics, _toBig as toBig, atomicsToThree,
} from '../_lib/agent-labor.js';
import { runAutopilot } from '../_lib/labor-settle.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const auth = await authWrite(req, res);
	if (!auth) return;
	const { userId } = auth;

	const rl = await limits.laborBid(userId || 'anon');
	if (!rl.success) return rateLimited(res, rl, 'bid rate limit exceeded');

	const body = (await readJson(req)) || {};
	const { bountyId, workerAgentId, priceThree, priceAtomics, etaSeconds = null, pitch = null } = body;
	if (!bountyId || !workerAgentId) return error(res, 400, 'validation_error', 'bountyId and workerAgentId are required');

	let worker;
	try {
		worker = await loadOwnedAgent(workerAgentId, userId);
	} catch (e) {
		return error(res, e.status || 400, e.code || 'bad_request', e.message);
	}

	const bounty = await getBounty(bountyId);
	if (!bounty) return error(res, 404, 'not_found', 'bounty not found');
	if (bounty.status !== 'open') return error(res, 409, 'bounty_closed', `this bounty is ${bounty.status}, not open for bids`);
	if (bounty.poster_agent_id === workerAgentId) return error(res, 400, 'self_bid', 'an agent cannot bid on its own bounty');

	const reward = toBig(bounty.reward_atomics);
	const price = priceAtomics != null ? toBig(priceAtomics) : threeToAtomics(priceThree);
	if (price <= 0n) return error(res, 400, 'validation_error', 'bid price must be greater than zero');
	if (price > reward) {
		return error(res, 400, 'over_reward', `your bid (${atomicsToThree(price)} $THREE) exceeds the reward (${atomicsToThree(reward)} $THREE)`);
	}
	const eta = Number.isFinite(Number(etaSeconds)) && Number(etaSeconds) > 0 ? Math.round(Number(etaSeconds)) : null;

	const { reputation } = await workerReputation(workerAgentId);
	const score = scoreBid({ priceAtomics: price, rewardAtomics: reward, etaSeconds: eta, reputation });

	const bid = await upsertBid({
		bountyId, workerAgentId, workerUserId: userId, priceAtomics: price, etaSeconds: eta,
		pitch: pitch ? String(pitch).slice(0, 400) : `${worker.name || 'Agent'} bids ${atomicsToThree(price)} $THREE`,
		score, reputation, rationale: 'manual bid by owner', auto: false,
	});

	// A manual bid can still trigger the poster's auto-award. Drive the autopilot
	// (bounded; it only acts within the participants' opted-in policies).
	const autopilot = await runAutopilot(bountyId).catch(() => null);

	return json(res, 200, {
		ok: true,
		bid: {
			id: bid.id, bounty_id: bountyId, worker_agent_id: workerAgentId,
			price_atomics: String(toBig(bid.price_atomics)), price_three: atomicsToThree(bid.price_atomics),
			eta_seconds: eta, score, reputation, status: bid.status,
		},
		autopilot: autopilot || { bids: 0, awarded: false, settled: null, settledNow: false },
	});
});
