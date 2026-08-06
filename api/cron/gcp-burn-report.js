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
// max, deduped) rather than erroring — the alerting scaffold is allowed to exist
// before prompt 01's export lands.
//
// Kept as a concrete file (not [name].js) so the burn module + its fetch/crypto
// deps don't share a cold start with the heavy SDK bundles.

import { json, method, wrapCron } from '../_lib/http.js';
import { error } from '../_lib/http.js';
import { sendOpsAlert } from '../_lib/alerts.js';
import { buildBurnReport, billingConfigured, BillingUnavailableError, usd, PROGRAM_LANES } from '../_lib/gcp-billing.js';
import { requireCron } from '../_lib/cron-auth.js';

const STATUS_EMOJI = { runaway: '🔴', underutilized: '🟡', 'on-track': '🟢', idle: '⚪', unknown: '⚪' };

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
			'GCP burn report — billing export not wired',
			'Set GOOGLE_CLOUD_PROJECT + GCP_BILLING_DATASET + GCP_BILLING_TABLE (prompt 01). See docs/gcp-credits.md.',
			{ signature: 'gcp-burn-unconfigured' },
		);
		return json(res, 200, { ok: true, configured: false });
	}

	let report;
	try {
		report = await buildBurnReport({});
	} catch (err) {
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
