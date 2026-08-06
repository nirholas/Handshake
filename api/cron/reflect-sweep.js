// GET /api/cron/reflect-sweep — scheduled memory-consolidation pass.
//
// Walks agents with recent activity (new memories or actions) that haven't
// reflected within the debounce window and runs a real reflection pass for each
// (api/_lib/reflection.js). This is the "while you were away" engine: the user
// comes back to find their agent has genuinely consolidated what it saw.
//
// Cost discipline (no silent caps):
//   • A cheap SQL pre-filter skips agents with no recent activity or a run in the
//     last 30 minutes, so the engine isn't invoked for idle agents.
//   • The engine itself re-checks the per-agent daily cap + debounce + minimum
//     new-signal threshold and records every skip in agent_reflection_runs.
//   • A wall-clock budget bounds the batch; whatever it couldn't reach is logged
//     and picked up on the next tick — never silently dropped.

import { sql } from '../_lib/db.js';
import { env } from '../_lib/env.js';
import { cors, error, json, method, wrapCron } from '../_lib/http.js';
import { runReflection } from '../_lib/reflection.js';
import { requireCron } from '../_lib/cron-auth.js';

export const maxDuration = 120;

// How many agents to attempt per tick, and the wall-clock budget. The cron runs
// every 30 min, so a backlog drains over a few ticks rather than in one long run.
const BATCH_LIMIT = Number(process.env.REFLECT_SWEEP_BATCH) || 12;
const TIME_BUDGET_MS = 100_000;

export default wrapCron(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;
	if (!requireCron(req, res)) return;

	const startedAt = Date.now();

	// Pre-filter: agents with activity in the last 36h and no reflection run in
	// the last 30 minutes (the engine's debounce is authoritative; this just
	// avoids waking it for agents that would only be told to wait).
	const candidates = await sql`
		WITH active AS (
			SELECT agent_id FROM agent_memories WHERE created_at > now() - interval '36 hours'
			UNION
			SELECT agent_id FROM agent_actions  WHERE created_at > now() - interval '36 hours'
		)
		SELECT a.id, a.name, a.description, a.user_id
		FROM agent_identities a
		JOIN active ac ON ac.agent_id = a.id
		WHERE a.deleted_at IS NULL
		  AND NOT EXISTS (
			SELECT 1 FROM agent_reflection_runs r
			WHERE r.agent_id = a.id AND r.created_at > now() - interval '30 minutes'
		  )
		ORDER BY a.id
		LIMIT ${BATCH_LIMIT}
	`;

	const summary = { eligible: candidates.length, processed: 0, dreamsCreated: 0, skipped: 0, errors: 0, deferred: 0 };

	for (const agent of candidates) {
		if (Date.now() - startedAt > TIME_BUDGET_MS) {
			summary.deferred = candidates.length - summary.processed;
			console.log(`[reflect-sweep] time budget reached; deferring ${summary.deferred} agents to next tick`);
			break;
		}
		summary.processed++;
		try {
			const result = await runReflection({
				agentId: agent.id,
				userId: agent.user_id,
				trigger: 'cron',
				agent: { name: agent.name, description: agent.description },
			});
			if (result.status === 'ok') summary.dreamsCreated += result.created.length;
			else if (result.status === 'skipped') summary.skipped++;
			else summary.errors++;
		} catch (err) {
			summary.errors++;
			console.error(`[reflect-sweep] agent=${agent.id} failed:`, err?.message);
		}
	}

	summary.elapsedMs = Date.now() - startedAt;
	return json(res, 200, summary);
});
