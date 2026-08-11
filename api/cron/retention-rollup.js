// @ts-check
// GET /api/cron/retention-rollup — weekly week-2 retention rollup on minted agents.
//
// This is the cron that makes the README roadmap's phase-2 verification metric a
// number instead of an aspiration: "users return to converse with their own
// agent; >=30% week-2 retention on minted agents".
//
// Once a week it recomputes every cohort in the trailing window (owners grouped
// by the ISO week they minted their first agent on-chain) and upserts one row per
// (cohort week, metric) into `agent_retention_cohorts`. Recomputing the tail on
// every run rather than only the newest week is deliberate: a cohort's window
// stays open for 14 days after each member's mint, and a visit recorded today can
// legitimately move a cohort that was rolled up last week. Rows carry
// `is_complete` so a consumer can tell a final number from a moving one, and the
// upsert is idempotent, so a re-run (or a retry after a partial failure) converges
// instead of double-counting.
//
// Weekly cadence matches the metric: a daily run would rewrite the same rows with
// the same values six times for nothing. The trailing window is wide enough that
// a missed week is repaired by the next run with no backfill step.

import { json, method, wrapCron } from '../_lib/http.js';
import { requireCron } from '../_lib/cron-auth.js';
import { sendOpsAlert } from '../_lib/alerts.js';
import {
	computeRetentionCohorts,
	cohortRecords,
	upsertCohortRecord,
	utcDay,
} from '../_lib/retention.js';

// Half a year of cohorts. Wide enough that a skipped run, a late visit, or a
// retroactive mint correction is absorbed on the next tick; small enough that the
// whole rollup is a single cheap aggregate plus a bounded set of upserts.
const COHORT_WEEKS = 26;

export default wrapCron(async (req, res) => {
	if (!method(req, res, ['GET'])) return;
	if (!requireCron(req, res)) return;

	const today = utcDay();
	const rows = await computeRetentionCohorts({ weeks: COHORT_WEEKS, today });
	const records = cohortRecords(rows, today);

	let written = 0;
	let errors = 0;
	for (const rec of records) {
		try {
			await upsertCohortRecord(rec);
			written += 1;
		} catch (err) {
			errors += 1;
			console.error(
				`[retention-rollup] upsert failed for ${rec.cohortWeek}/${rec.metric}:`,
				err?.message,
			);
		}
	}

	if (errors > 0) {
		sendOpsAlert(
			'retention rollup write errors',
			`${errors}/${records.length} cohort upserts failed. Week-2 retention will read stale until the next run.`,
			{ signature: 'retention-rollup-errors' },
		);
	}

	// The newest cohort whose window has fully closed — the number the roadmap
	// gate is actually read against.
	const latestComplete = records
		.filter((r) => r.metric === 'week2_converse' && r.isComplete)
		.sort((a, b) => (a.cohortWeek < b.cohortWeek ? 1 : -1))[0] ?? null;

	return json(res, 200, {
		ok: true,
		cohorts: rows.length,
		written,
		errors,
		latestComplete: latestComplete
			? {
					cohortWeek: latestComplete.cohortWeek,
					mintedOwners: latestComplete.mintedOwners,
					retainedOwners: latestComplete.retainedOwners,
					retentionRate: latestComplete.retentionRate,
				}
			: null,
		ranAt: new Date().toISOString(),
	});
});
