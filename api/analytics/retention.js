/**
 * GET /api/analytics/retention — week-2 retention on minted agents.
 *
 * Serves the cohort table `api/cron/retention-rollup.js` writes: owners grouped
 * by the ISO week they minted their first agent on-chain, and how many of them
 * came back to that agent during days 7..13. It is the read side of the README
 * roadmap's phase-2 verification metric.
 *
 * Query params
 *   metric — `week2_converse` (default; the roadmap's "return to converse")
 *            or `week2_return` (came back at all, conversation or not).
 *   weeks  — how many cohort weeks to return, 1..104. Default 26.
 *
 * Admin-only. The numbers are platform-wide business metrics, not the caller's
 * own data, so the gate is the same `requireAdmin` every other platform-internal
 * surface uses. A signed-in non-admin gets a 403, which the dashboard treats as
 * "hide the panel" rather than an error.
 */

import { cors, json, method, wrap } from '../_lib/http.js';
import { requireAdmin } from '../_lib/admin.js';
import {
	RETENTION_METRICS,
	RETENTION_METRIC_LABELS,
	WEEK2_TARGET_RATE,
	readCohorts,
	summarizeCohorts,
} from '../_lib/retention.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;
	if (!(await requireAdmin(req, res))) return;

	const url = new URL(req.url, 'http://internal');
	const requested = url.searchParams.get('metric') || RETENTION_METRICS[0];
	const metric = RETENTION_METRICS.includes(requested) ? requested : RETENTION_METRICS[0];
	const weeks = Math.min(Math.max(parseInt(url.searchParams.get('weeks') || '26', 10) || 26, 1), 104);

	const cohorts = await readCohorts({ metric, limit: weeks });

	return json(res, 200, {
		metric,
		metric_label: RETENTION_METRIC_LABELS[metric],
		target: WEEK2_TARGET_RATE,
		// Oldest first — chart order, so the client never has to re-sort.
		cohorts: cohorts.map((c) => ({
			cohort_week: c.cohort_week,
			minted_owners: c.minted_owners,
			retained_owners: c.retained_owners,
			retention_rate: Number(c.retention_rate),
			window_start: c.window_start,
			window_end: c.window_end,
			is_complete: c.is_complete,
			computed_at: c.computed_at,
		})),
		summary: summarizeCohorts(cohorts),
	});
});
