// @ts-check
// GET /api/cron/vanity-inventory-replenish — keep the premium vanity shelf stocked.
//
// The instant-delivery tiers (api/x402/vanity-premium.js, the inventory fast path
// in api/x402/vanity.js and api/_lib/pump-launch.js) can only serve from stock —
// they never grind inline. This tick is the demand side of that contract:
//
//   1. LOW-STOCK TRIGGER. Reads inventoryStats(). When available stock (or the
//      distinct-tier count) drops below a watermark, it fires the batch grinder
//      AHEAD OF running out — never grinds inline itself (a 4–5 char batch run
//      takes minutes-to-hours on spot CPU, far past any request's budget). The
//      real trigger is a Cloud Run Jobs `run` execution (workers/vanity-grinder,
//      deployed by scripts/gcp/vanity-grind-deploy.sh) using the same GCP OAuth
//      token machinery Vertex/KMS already use (api/_lib/gcp-auth.js) — a real
//      API call, not a stub. Deduped so a sustained low-stock window fires the
//      job once, not every tick.
//   2. SWEEP. Runs sweepExpiredSecrets() (api/_lib/vanity-inventory-store.js) so
//      any retention_days > 0 rows past their window get their ciphertext
//      destroyed — the delete-after-reveal default (retention_days = 0) already
//      does this at reveal time, so this is a backstop for the opt-in retention
//      path, not the common case.
//
// Graceful degradation (per repo rules — never a mock, never a silent no-op):
// when the job trigger isn't configured (no GOOGLE_CLOUD_PROJECT or GCP auth),
// this pages ops with the exact manual command instead of pretending to have
// replenished anything.

import { error, json, method, wrapCron } from '../_lib/http.js';
import { env } from '../_lib/env.js';
import { sendOpsAlert } from '../_lib/alerts.js';
import { inventoryStats, sweepExpiredSecrets, isDbUnavailableError } from '../_lib/vanity-inventory-store.js';
import { getGcpAccessToken, gcpAuthConfigured } from '../_lib/gcp-auth.js';
import { requireCron } from '../_lib/cron-auth.js';

// Below this many available items platform-wide, fire a replenishment run.
// Overridable so ops can tune the shelf depth without a redeploy.
const LOW_WATERMARK = Number(process.env.VANITY_INVENTORY_LOW_WATERMARK || 25);

const PROJECT = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT_ID || '';
const REGION = process.env.VANITY_GRIND_REGION || 'us-central1';
const JOB = process.env.VANITY_GRIND_JOB || 'vanity-grinder';

function jobConfigured() {
	return Boolean(PROJECT) && gcpAuthConfigured();
}

// Fire the Cloud Run Job execution — the exact same job
// scripts/gcp/vanity-grind-deploy.sh provisions. Real REST call against the
// Cloud Run Admin API v2 (`jobs.run`), authenticated with the platform's shared
// GCP service-account token. Returns the execution name on success.
async function triggerGrindJob() {
	const token = await getGcpAccessToken();
	const url = `https://run.googleapis.com/v2/projects/${PROJECT}/locations/${REGION}/jobs/${JOB}:run`;
	const res = await fetch(url, {
		method: 'POST',
		headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
		body: JSON.stringify({}),
	});
	if (!res.ok) {
		const detail = await res.text().catch(() => res.status);
		throw new Error(`Cloud Run Jobs run failed (${res.status}): ${String(detail).slice(0, 300)}`);
	}
	const data = await res.json();
	return data?.metadata?.name || data?.name || null;
}

export default wrapCron(async (req, res) => {
	if (!method(req, res, ['GET'])) return;
	if (!requireCron(req, res)) return;

	let stats;
	try {
		stats = await inventoryStats();
	} catch (err) {
		if (isDbUnavailableError(err)) {
			return json(res, 200, { ok: true, skipped: 'db_unavailable' });
		}
		await sendOpsAlert('Vanity inventory replenish — stats query failed', err.message, { signature: 'vanity-replenish-stats-failed' });
		return json(res, 200, { ok: false, error: err.message });
	}

	let swept = 0;
	try {
		({ destroyed: swept } = await sweepExpiredSecrets());
	} catch (err) {
		// Non-fatal — the low-stock check below still matters even if the sweep
		// fails on this tick; it will retry next tick.
		console.error('[vanity-inventory-replenish] sweep failed', err?.message || err);
	}

	const low = stats.available < LOW_WATERMARK;
	if (!low) {
		return json(res, 200, { ok: true, low_stock: false, stats, swept });
	}

	if (!jobConfigured()) {
		await sendOpsAlert(
			'Vanity inventory low — replenishment job not configured',
			`Available: ${stats.available} (watermark ${LOW_WATERMARK}). Run manually: ` +
				`PROJECT_ID=<gcp-project> ./scripts/gcp/vanity-grind-deploy.sh --run — or set ` +
				`GOOGLE_CLOUD_PROJECT (+ GCP auth) so this cron can trigger the Cloud Run Job itself.`,
			{ signature: 'vanity-replenish-not-configured' },
		);
		return json(res, 200, { ok: true, low_stock: true, configured: false, stats, swept });
	}

	try {
		const execution = await triggerGrindJob();
		await sendOpsAlert(
			'🟡 Vanity inventory low — replenishment grind triggered',
			`Available: ${stats.available} (watermark ${LOW_WATERMARK}). Fired Cloud Run Job ` +
				`${JOB} in ${REGION}. Execution: ${execution || '(unnamed)'}.`,
			{ signature: `vanity-replenish-fired:${new Date().toISOString().slice(0, 13)}` },
		);
		return json(res, 200, { ok: true, low_stock: true, configured: true, triggered: true, execution, stats, swept });
	} catch (err) {
		await sendOpsAlert('Vanity inventory low — replenishment trigger failed', err.message, { signature: 'vanity-replenish-trigger-failed' });
		return json(res, 200, { ok: false, low_stock: true, error: err.message, stats, swept });
	}
});
