// POST /api/labor/tick — cron driver for the Agent Labor Market.
// Advances autonomous bounties that haven't reached a terminal state inline:
//   • open bounties (collect auto-bids, auto-award if the poster opted in)
//   • working jobs with an autonomous worker (perform → verify → settle)
//   • delivered/verifying jobs (settle now)
// Authenticated with the Vercel cron Bearer secret. No-op (503) if unset.

import { json, method, wrap } from '../_lib/http.js';
import { sql } from '../_lib/db.js';
import { ensureLaborTables, getBounty, getJob } from '../_lib/agent-labor.js';
import { runAutopilot, runSettlement } from '../_lib/labor-settle.js';
import { requireCron } from '../_lib/cron-auth.js';

export default wrap(async (req, res) => {
	if (!method(req, res, ['POST', 'GET'])) return;
	if (!requireCron(req, res)) return;

	await ensureLaborTables();

	// Resumable work: open bounties with at least one bid + auto-award posters, and
	// any job stuck mid-pipeline. Cap the batch so a tick stays well within budget.
	const openBounties = await sql`
		SELECT b.id FROM agent_bounties b
		JOIN agent_labor_policies p ON p.agent_id = b.poster_agent_id AND p.poster_enabled AND p.auto_award
		WHERE b.status = 'open'
		  AND EXISTS (SELECT 1 FROM agent_bids bd WHERE bd.bounty_id = b.id AND bd.status = 'pending')
		ORDER BY b.created_at ASC LIMIT 10`;

	const stuckJobs = await sql`
		SELECT j.id, j.bounty_id, j.status FROM agent_jobs j
		WHERE j.status IN ('working','delivered','verifying')
		  AND j.created_at < now() - interval '15 seconds'
		ORDER BY j.created_at ASC LIMIT 10`;

	const results = { awarded: 0, settled: 0, scanned: openBounties.length + stuckJobs.length };

	for (const b of openBounties) {
		const r = await runAutopilot(b.id).catch(() => null);
		if (r?.awarded) results.awarded++;
		if (r?.settled === 'settled') results.settled++;
	}

	for (const j of stuckJobs) {
		const bounty = await getBounty(j.bounty_id);
		if (!bounty) continue;
		if (j.status === 'working') {
			// Only autonomous workers are driven to perform; runAutopilot enforces that.
			const r = await runAutopilot(j.bounty_id).catch(() => null);
			if (r?.settled === 'settled') results.settled++;
		} else {
			// Delivered/verifying: settle now from the full job row.
			const full = await getJob(j.id);
			if (!full) continue;
			const r = await runSettlement({ job: full, bounty }).catch(() => null);
			if (r?.status === 'settled') results.settled++;
		}
	}

	json(res, 200, { ok: true, ...results });
});
