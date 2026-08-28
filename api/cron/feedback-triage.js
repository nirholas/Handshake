// GET /api/cron/feedback-triage - score, classify, and cluster what visitors said.
//
// Runs off the request path on purpose: a visitor who reports a problem gets an
// instant acknowledgement, and the model reads their report a minute later. A
// slow or unavailable LLM chain therefore degrades the queue's sharpness, never
// the visitor's experience, and never loses a report.

import { cors, json, method, wrapCron } from '../_lib/http.js';
import { requireCron } from '../_lib/cron-auth.js';
import { untriagedReports, saveTriage } from '../_lib/feedback/store.js';
import { triageReport } from '../_lib/feedback/triage.js';

export const maxDuration = 120;

const BATCH_LIMIT = Number(process.env.FEEDBACK_TRIAGE_BATCH) || 25;
const TIME_BUDGET_MS = 100_000;

export default wrapCron(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;
	if (!requireCron(req, res)) return;

	const started = Date.now();
	const pending = await untriagedReports(BATCH_LIMIT);
	let triaged = 0;
	let failed = 0;
	const clusters = new Set();

	for (const report of pending) {
		// Anything the budget does not reach keeps triaged_at null, so it sorts to
		// the front of the next tick rather than being skipped.
		if (Date.now() - started > TIME_BUDGET_MS) break;
		try {
			const verdict = await triageReport(report);
			const row = await saveTriage(report.id, verdict);
			if (row) {
				triaged += 1;
				if (row.cluster_key) clusters.add(row.cluster_key);
			}
		} catch (err) {
			failed += 1;
			console.warn(`[feedback-triage] ${report.id}: ${err?.message || err}`);
		}
	}

	return json(res, 200, {
		ok: true,
		pending: pending.length,
		triaged,
		failed,
		clusters: clusters.size,
		ms: Date.now() - started,
	});
});
