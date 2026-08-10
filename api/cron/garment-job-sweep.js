// @ts-check
// GET /api/cron/garment-job-sweep — re-drive orphaned garment generation jobs.
//
// The garment-forge worker claims work at EXECUTION time against a durable
// GCS record (see workers/garment-forge/main.py "Durable work claiming"), so
// a job whose instance is reclaimed mid-pipeline — scale-to-zero, a revision
// rollout, a crash — stays recoverable instead of dying in the instance's
// in-process queue. Recovery is not automatic though: something has to ask a
// live instance to look. That is this cron.
//
// Without it the worker's whole claim/retry machinery is inert: an orphaned
// job sits at "queued" until the stale watchdog buries it, which is exactly
// the failure the claiming work was built to prevent (observed 2026-07-26:
// 12 of 22 batch jobs lost to a reclaimed instance).
//
// Every 10 minutes: one authenticated POST to the worker's /sweep, which
// takes a lock, lists claimable records, and re-drives them under the normal
// concurrency limit. Overlapping ticks and live instances cannot double-run a
// job — the claim is an atomic generation-matched write.

import { error, json, method, reportServerError, wrapCron } from '../_lib/http.js';
import { requireCron } from '../_lib/cron-auth.js';

export default wrapCron(async (req, res) => {
	if (!method(req, res, ['GET'])) return;
	if (!requireCron(req, res)) return;

	const base = (process.env.GCP_GARMENT_FORGE_URL || '').replace(/\/$/, '');
	const key = process.env.GCP_RECONSTRUCTION_KEY || '';
	if (!base || !key) {
		// Not an error: a deployment without the garment lane configured simply
		// has nothing to sweep.
		return json(res, 200, { ok: true, skipped: 'not_configured' });
	}

	const upstream = await fetch(`${base}/sweep`, {
		method: 'POST',
		headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
		body: '{}',
	}).catch((err) => {
		reportServerError(err instanceof Error ? err : new Error(String(err)), {
			code: 'garment_sweep_unreachable',
			context: { base },
		});
		return null;
	});
	if (!upstream) {
		return error(res, 502, 'sweep_unreachable', 'garment-forge worker unreachable');
	}
	if (!upstream.ok) {
		const detail = await upstream.text().catch(() => '');
		reportServerError(new Error(`garment sweep returned ${upstream.status}: ${detail.slice(0, 200)}`), {
			code: 'garment_sweep_failed',
			context: { status: upstream.status },
		});
		return error(res, 502, 'sweep_failed', `worker returned ${upstream.status}`);
	}

	const result = await upstream.json().catch(() => ({}));
	return json(res, 200, { ok: true, ...result });
});
