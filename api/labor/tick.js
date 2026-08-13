// POST /api/labor/tick: cron driver for the Agent Labor Market.
// Advances autonomous bounties that haven't reached a terminal state inline:
//   • open bounties that already drew bids (auto-award if the poster opted in)
//   • recently posted bounties nobody has bid on yet (retry the auto-bid sweep)
//   • working jobs with an autonomous worker (perform, verify, settle)
//   • delivered/verifying jobs (settle now)
// Authenticated with the Vercel cron Bearer secret. No-op (503) if unset.
//
// Every scan below is capped at BATCH so a tick stays inside its budget, and each
// deliberately selects ONLY rows this tick can actually advance. That is not an
// optimization, it is the correctness property that keeps the cap from starving
// the market: the scans are ordered oldest-first, so any row the driver can never
// move occupies a slot on every tick forever. Two such rows existed:
//   • a 'working' job whose worker never opted into autonomy. runAutopilot
//     returns immediately for it, so it can only ever leave 'working' through
//     the manual /deliver endpoint. Ten of them (a human sitting on ten jobs)
//     used to consume the entire job batch and no autonomous job was ever driven
//     again. The scan now requires worker_enabled, mirroring the policy join the
//     bounty scan already had.
//   • an open bounty holding fewer pending bids than its poster's min_bids.
//     autoAwardIfReady declines it until more bids arrive, which may be never.
//     Award-ready bounties now sort ahead of bid-gathering ones, so a bounty
//     whose money is ready to move cannot be blocked behind ten that are not.
// Same reasoning drives the job ordering: delivered/verifying jobs are one step
// from releasing escrow, so they settle before working jobs spend the tick on an
// LLM perform call.
//
// The zero-bid lane is the market's only bootstrap retry. Auto-bidding is gated
// on the WORKER's policy (findAutoBidders reads worker_enabled), never on the
// poster's, which is why /post calls runAutopilot for every bounty regardless of
// the poster's settings. The award scan above cannot stand in for that: it needs
// a pending bid AND a poster auto-award policy, so a bounty whose post-time sweep
// matched nobody (no autonomous worker held the skill yet, or the pitch router
// was down that second) had no path back to a bid, ever. It gets one here for a
// bounded window: a row ages out of BID_RETRY_WINDOW on its own, so an unbiddable
// bounty cannot squat a slot forever the way the two rows above used to. An
// attempt with no matching worker costs one indexed SELECT and no LLM call.

import { json, method, wrap } from '../_lib/http.js';
import { sql } from '../_lib/db.js';
import { ensureLaborTables, getBounty, getJob } from '../_lib/agent-labor.js';
import { runAutopilot, runSettlement } from '../_lib/labor-settle.js';
import { requireCron } from '../_lib/cron-auth.js';

const BATCH = 10;
const MAX_REPORTED_ERRORS = 5;
// How long after posting a bounty keeps getting auto-bid sweeps. Long enough to
// outlast a router outage or a worker enabling autonomy right after the post,
// short enough that a bounty nobody can serve leaves the scan on its own.
const BID_RETRY_WINDOW = '1 hour';

export default wrap(async (req, res) => {
	if (!method(req, res, ['POST', 'GET'])) return;
	if (!requireCron(req, res)) return;

	await ensureLaborTables();

	const openBounties = await sql`
		WITH candidates AS (
			SELECT b.id, b.created_at, p.min_bids,
			       (SELECT count(*) FROM agent_bids bd
			         WHERE bd.bounty_id = b.id AND bd.status = 'pending') AS pending_bids
			FROM agent_bounties b
			JOIN agent_labor_policies p
			  ON p.agent_id = b.poster_agent_id AND p.poster_enabled AND p.auto_award
			WHERE b.status = 'open'
		)
		SELECT id FROM candidates
		WHERE pending_bids > 0
		ORDER BY (pending_bids >= min_bids) DESC, created_at ASC
		LIMIT ${BATCH}`;

	const unbidBounties = await sql`
		SELECT b.id FROM agent_bounties b
		WHERE b.status = 'open'
		  AND b.created_at > now() - ${BID_RETRY_WINDOW}::interval
		  AND NOT EXISTS (
		        SELECT 1 FROM agent_bids bd
		         WHERE bd.bounty_id = b.id AND bd.status = 'pending')
		ORDER BY b.created_at ASC
		LIMIT ${BATCH}`;

	const stuckJobs = await sql`
		SELECT j.id, j.bounty_id, j.status FROM agent_jobs j
		WHERE j.created_at < now() - interval '15 seconds'
		  AND (
		    j.status IN ('delivered','verifying')
		    OR (j.status = 'working' AND EXISTS (
		          SELECT 1 FROM agent_labor_policies wp
		           WHERE wp.agent_id = j.worker_agent_id AND wp.worker_enabled))
		  )
		ORDER BY (j.status <> 'working') DESC, j.created_at ASC
		LIMIT ${BATCH}`;

	// The two bounty scans are disjoint by construction (one requires a pending
	// bid, the other requires none), so no bounty is driven twice in a tick.
	const bounties = [...openBounties, ...unbidBounties];

	const results = {
		scanned: bounties.length + stuckJobs.length,
		bids: 0, awarded: 0, settled: 0, failed: 0,
	};
	const errors = [];

	// One bad row must not cost the rest of the batch. Every past accounting loss
	// here came from an unguarded row read throwing mid-loop: the work already
	// done stayed done on-chain, but the tick 5xx'd and reported none of it.
	const note = (scope, err) => {
		results.failed++;
		const message = err?.message || String(err);
		console.error(`[labor-tick] ${scope} failed`, message);
		if (errors.length < MAX_REPORTED_ERRORS) errors.push(`${scope}: ${message.slice(0, 160)}`);
	};

	for (const b of bounties) {
		try {
			const r = await runAutopilot(b.id);
			results.bids += r?.bids || 0;
			if (r?.awarded) results.awarded++;
			if (r?.settledNow) results.settled++;
		} catch (err) {
			note(`bounty ${b.id}`, err);
		}
	}

	for (const j of stuckJobs) {
		try {
			if (j.status === 'working') {
				// The scan already proved the worker is autonomous; runAutopilot
				// re-reads the bounty itself, so no extra fetch is needed here.
				const r = await runAutopilot(j.bounty_id);
				results.bids += r?.bids || 0;
				if (r?.settledNow) results.settled++;
				continue;
			}
			// Delivered/verifying: settle now from the full job row.
			const bounty = await getBounty(j.bounty_id);
			if (!bounty) continue;
			const full = await getJob(j.id);
			if (!full) continue;
			// A settle another caller already claimed comes back idempotent. Counting
			// it would report someone else's payout as this tick's work.
			const r = await runSettlement({ job: full, bounty });
			if (r?.status === 'settled' && !r.idempotent) results.settled++;
		} catch (err) {
			note(`job ${j.id}`, err);
		}
	}

	// A lane where every scanned row threw is an outage, not an idle minute, and
	// the economy tick's summary (and /api/status behind it) can only say so if
	// this response does. `reason` is what that summary surfaces.
	const allFailed = results.scanned > 0 && results.failed === results.scanned;
	return json(res, allFailed ? 502 : 200, {
		ok: !allFailed,
		...results,
		...(errors.length ? { errors } : {}),
		...(results.failed ? { reason: `${results.failed}/${results.scanned} items failed` } : {}),
	});
});
