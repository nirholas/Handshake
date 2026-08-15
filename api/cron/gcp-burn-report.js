// @ts-check
// GET /api/cron/gcp-burn-report — daily GCP credit burn report → ops channel.
//
// Runs once a day. Builds the attributed burn report from the BigQuery billing
// export (api/_lib/gcp-billing.js) and posts a summary to the PRIVATE ops
// Telegram channel (sendOpsAlert → TELEGRAM_ALERTS_CHAT_ID): credit consumed,
// daily burn, days of runway, projected exhaustion vs expiry, and the
// under-utilization guard (>30% of the grant projected unused at expiry).
//
// Both failure modes ping the channel:
//   • runaway     — credits exhaust BEFORE expiry → throttle / kill-switch
//   • underutilized — credits expire unused        → scale a lane up
// A healthy on-track day posts a quiet one-line status (deduped) so the channel
// still shows the report ran.
//
// If the billing export isn't wired yet the cron no-ops quietly (one alert/day
// max, deduped) rather than erroring: the alerting scaffold is allowed to exist
// before the export lands. Two states count as not-wired, and both take that
// quiet path: the env vars are missing, or they resolve to a table BigQuery does
// not have because the billing account was never pointed at the dataset. Only
// the second one is reachable once GCP_BILLING_ACCOUNT_ID is set, since the
// table name is derived from it and always resolves.
//
// Kept as a concrete file (not [name].js) so the burn module + its fetch/crypto
// deps don't share a cold start with the heavy SDK bundles.

import { json, method, wrapCron } from '../_lib/http.js';
import { sendOpsAlert } from '../_lib/alerts.js';
import { buildBurnReport, billingConfigured, BillingExportMissingError, BillingUnavailableError, resolveBillingConfig, usd, PROGRAM_LANES } from '../_lib/gcp-billing.js';
import { requireCron } from '../_lib/cron-auth.js';

const STATUS_EMOJI = { runaway: '🔴', underutilized: '🟡', 'on-track': '🟢', idle: '⚪', unknown: '⚪' };

// Both not-wired states share one title and one dedup signature on purpose: they
// are the same operator situation (no burn data yet, one setup step outstanding),
// so they must not page the channel twice in a day between them.
const NOT_WIRED_TITLE = 'GCP burn report: billing export not wired';

// The one console step that turns the not-wired state into a live report, with
// the exact table the config expects so the operator can confirm the match
// instead of guessing which of the three env vars is at fault.
function missingExportDetail(err) {
	const lines = ['The billing export table does not exist yet in BigQuery.'];
	try {
		const cfg = resolveBillingConfig();
		lines.push(`Expected ${cfg.fqTable}`);
	} catch {
		lines.push(err.message);
	}
	lines.push('Enable it once (console-only, no gcloud or API path): Billing → Billing export → BigQuery export → Edit settings → select the dataset. BigQuery then creates the table and this report goes live on the next run.');
	lines.push('See docs/ops/gcp-credits.md.');
	return lines.join('\n');
}

function formatReport(report) {
	const { totals, projection: p, burn } = report;
	const lines = [];
	lines.push(`Consumed ${usd(totals.creditUsed)}${p.creditTotalUsd ? ` of ${usd(p.creditTotalUsd)} (${Math.round((totals.creditUsed / p.creditTotalUsd) * 100)}%)` : ''}`);
	lines.push(`Burn ${usd(burn.avg7dPerDay)}/day (7d), ${usd(burn.avg30dPerDay)}/day (30d)`);
	if (p.daysRunway != null && p.daysRunway !== Infinity) {
		lines.push(`Runway ~${Math.round(p.daysRunway)}d → exhausts ${String(p.exhaustionDate).slice(0, 10)}`);
	}
	if (p.expiry) lines.push(`Expiry ${String(p.expiry).slice(0, 10)} (${Math.round(p.daysToExpiry)}d)`);
	lines.push('');
	lines.push(p.headline);
	if (p.status === 'underutilized' || p.status === 'idle') {
		lines.push('Scale up: ' + Object.entries(PROGRAM_LANES)
			.filter(([k]) => k !== '(unlabeled)')
			.map(([, m]) => m.label)
			.join(', '));
	}
	return lines.join('\n');
}

export default wrapCron(async (req, res) => {
	if (!method(req, res, ['GET'])) return;
	if (!requireCron(req, res)) return;

	if (!billingConfigured()) {
		// Scaffold exists before the export lands — say so once/day, don't error.
		await sendOpsAlert(
			NOT_WIRED_TITLE,
			'Set GOOGLE_CLOUD_PROJECT + GCP_BILLING_DATASET + GCP_BILLING_TABLE (or GCP_BILLING_ACCOUNT_ID, which derives the table). See docs/ops/gcp-credits.md.',
			{ signature: 'gcp-burn-unconfigured' },
		);
		return json(res, 200, { ok: true, configured: false, reason: 'env_missing' });
	}

	let report;
	try {
		report = await buildBurnReport({});
	} catch (err) {
		// The env resolves to a table BigQuery does not have: the billing account
		// was never pointed at the dataset. That is the same not-wired state as
		// missing env, one console step short of done, so it takes the quiet
		// once-a-day path with the exact step to take. Reported as a failure it
		// paged ops daily for weeks about something no retry can fix, which is how
		// a real BigQuery or auth outage would have gone unnoticed in the noise.
		if (err instanceof BillingExportMissingError) {
			const expected = missingExportDetail(err);
			await sendOpsAlert(NOT_WIRED_TITLE, expected, { signature: 'gcp-burn-unconfigured' });
			return json(res, 200, { ok: true, configured: false, reason: 'export_table_missing' });
		}
		const msg = err instanceof BillingUnavailableError ? err.message : (err?.message || String(err));
		await sendOpsAlert('GCP burn report failed', msg, { signature: 'gcp-burn-failed' });
		return json(res, 200, { ok: false, error: msg });
	}

	const p = report.projection;
	const emoji = STATUS_EMOJI[p.status] || '⚪';
	const body = formatReport(report);

	// Runaway + under-utilization get a distinct signature so they aren't deduped
	// against the daily on-track status line and always land.
	const signature =
		p.status === 'runaway' ? 'gcp-burn-runaway'
		: p.status === 'underutilized' ? 'gcp-burn-underutilized'
		: `gcp-burn-daily:${new Date().toISOString().slice(0, 10)}`;

	await sendOpsAlert(`${emoji} GCP daily burn — ${p.status}`, body, { signature });

	return json(res, 200, {
		ok: true,
		status: p.status,
		creditUsed: report.totals.creditUsed,
		daysRunway: p.daysRunway,
		projectedUnusedPct: p.projectedUnusedPct,
	});
});
