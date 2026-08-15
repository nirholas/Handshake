#!/usr/bin/env node
// scripts/gcp/burn-report.mjs — attributed GCP credit burn report.
//
// Reads the BigQuery billing export and prints, for the $100k credit program:
//   • credit consumed to date + gross cost
//   • spend by service (Vertex AI, Cloud Run, Compute, Storage, BigQuery, …)
//   • spend by lane label (vertex-claude | imagen | forge-gpu | vanity | unlabeled)
//   • trailing 7d / 30d daily burn rate
//   • projected exhaustion date vs the credit expiry date
//   • the under-utilization guard: >30% of the grant unused at expiry → scale up
//
// Usage:
//   node scripts/gcp/burn-report.mjs            # human-readable
//   node scripts/gcp/burn-report.mjs --json     # machine-readable (cron/dashboard)
//
// Config (env, also read from a local .env if present):
//   GOOGLE_CLOUD_PROJECT        project holding the billing dataset
//   GCP_BILLING_DATASET         dataset name (e.g. billing_export)
//   GCP_BILLING_TABLE           full export table  — OR —
//   GCP_BILLING_ACCOUNT_ID      billing account id (derives the standard table name)
//   GCP_CREDIT_TOTAL_USD        grant size, e.g. 100000  (enables projection)
//   GCP_CREDIT_EXPIRY           ISO date the credits expire, e.g. 2027-07-01
//   GCP_CREDIT_TYPES            optional override of the credit-type filter
//
// Auth: uses GCP_SERVICE_ACCOUNT_JSON if set; otherwise falls back to the local
// `gcloud auth print-access-token` (so it works after `gcloud auth login`).

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');

// Minimal .env loader (no dependency) so a local `.env` supplies config without
// exporting every var by hand. Only sets keys not already in the environment.
function loadDotEnv() {
	const envPath = resolve(REPO_ROOT, '.env');
	if (!existsSync(envPath)) return;
	for (const line of readFileSync(envPath, 'utf8').split('\n')) {
		const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
		if (!m) continue;
		const key = m[1];
		if (process.env[key] != null) continue;
		let val = m[2];
		if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
			val = val.slice(1, -1);
		}
		process.env[key] = val;
	}
}

loadDotEnv();

const { buildBurnReport, BillingUnavailableError, PROGRAM_LANES, usd } = await import(
	resolve(REPO_ROOT, 'api/_lib/gcp-billing.js')
);
const { getGcpAccessToken, gcpAuthConfigured } = await import(resolve(REPO_ROOT, 'api/_lib/gcp-auth.js'));

// Token function: service account when present, else the local gcloud identity.
async function localTokenFn() {
	if (gcpAuthConfigured()) return getGcpAccessToken();
	try {
		return execFileSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8' }).trim();
	} catch (err) {
		throw new BillingUnavailableError(
			'No GCP_SERVICE_ACCOUNT_JSON and `gcloud auth print-access-token` failed. Run `gcloud auth login` (and `gcloud config set project <id>`) first.',
			err,
		);
	}
}

const asJson = process.argv.includes('--json');

function fmtDate(iso) {
	if (!iso) return '—';
	return new Date(iso).toISOString().slice(0, 10);
}

function bar(pct, width = 24) {
	const filled = Math.max(0, Math.min(width, Math.round((pct || 0) * width)));
	return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function printHuman(report) {
	const { totals, projection: p, byService, byLane, burn, config } = report;
	const lines = [];
	lines.push('');
	lines.push('  GCP CREDIT BURN REPORT');
	lines.push(`  ${config.project} · ${config.dataset}.${config.table} · ${report.generatedAt.slice(0, 19)}Z`);
	lines.push('  ' + '─'.repeat(60));

	lines.push('');
	lines.push('  CREDIT CONSUMPTION');
	lines.push(`    Consumed to date   ${usd(totals.creditUsed)}`);
	if (config.creditTotalUsd) {
		const pct = totals.creditUsed / config.creditTotalUsd;
		lines.push(`    Grant total        ${usd(config.creditTotalUsd)}`);
		lines.push(`    Remaining          ${usd(p.remainingUsd)}`);
		lines.push(`    Progress           ${bar(pct)} ${(pct * 100).toFixed(1)}%`);
	}
	lines.push(`    Gross cost (pre-credit) ${usd(totals.grossCost)}`);
	lines.push(`    Usage window       ${fmtDate(totals.firstUsage)} → ${fmtDate(totals.lastUsage)}`);

	lines.push('');
	lines.push('  BURN RATE & RUNWAY');
	lines.push(`    Daily burn (7d)    ${usd(burn.avg7dPerDay)}/day`);
	lines.push(`    Daily burn (30d)   ${usd(burn.avg30dPerDay)}/day`);
	if (p.daysRunway != null) {
		lines.push(`    Runway             ${p.daysRunway === Infinity ? '∞ (idle)' : `~${Math.round(p.daysRunway)} days`}`);
		lines.push(`    Projected exhaust  ${fmtDate(p.exhaustionDate)}`);
	}
	if (p.expiry) {
		lines.push(`    Credit expiry      ${fmtDate(p.expiry)} (${Math.round(p.daysToExpiry)}d away)`);
	}

	const badge = { 'runaway': '🔴 RUNAWAY', 'underutilized': '🟡 UNDER-UTILIZED', 'on-track': '🟢 ON TRACK', 'idle': '⚪ IDLE', 'unknown': '⚪ UNKNOWN' }[p.status] || p.status;
	lines.push('');
	lines.push(`  STATUS  ${badge}`);
	lines.push(`    ${p.headline}`);
	if (p.status === 'underutilized' || p.status === 'idle') {
		lines.push('    Scale-up options:');
		for (const [lane, meta] of Object.entries(PROGRAM_LANES)) {
			if (lane === '(unlabeled)') continue;
			lines.push(`      · ${meta.label}: ${meta.scaleUp}`);
		}
	}

	lines.push('');
	lines.push('  SPEND BY SERVICE');
	for (const s of byService.slice(0, 10)) {
		lines.push(`    ${s.service.padEnd(28)} ${usd(s.creditUsed).padStart(14)}`);
	}

	lines.push('');
	lines.push('  SPEND BY LANE (attribution)');
	if (byLane.length === 0) {
		lines.push('    (no labeled spend yet — run scripts/gcp/label-resources.sh)');
	}
	for (const l of byLane.slice(0, 12)) {
		const name = PROGRAM_LANES[l.lane]?.label || l.lane;
		lines.push(`    ${name.padEnd(24)} ${usd(l.creditUsed).padStart(14)}   [program=${l.program}]`);
	}
	lines.push('');
	console.log(lines.join('\n'));
}

try {
	const report = await buildBurnReport({ tokenFn: localTokenFn });
	if (asJson) {
		console.log(JSON.stringify(report, null, 2));
	} else {
		printHuman(report);
	}
	// Non-zero exit on a runaway so a cron/CI wrapper can alert on the exit code.
	process.exit(report.projection.status === 'runaway' ? 2 : 0);
} catch (err) {
	if (err instanceof BillingUnavailableError) {
		// A missing export table is a one-time console step, not a fault: name the
		// step instead of leaving the reader with a bare BigQuery "not found".
		const notWired = err.code === 'billing_export_missing';
		const hint = 'Enable it once (console-only): Billing → Billing export → BigQuery export → Edit settings → select the dataset. See docs/ops/gcp-credits.md.';
		if (asJson) {
			console.log(JSON.stringify({ error: err.code || 'billing_unavailable', message: err.message, ...(notWired ? { hint } : {}) }, null, 2));
		} else {
			console.error(`\n  ⚠️  Burn report unavailable\n     ${err.message}\n${notWired ? `     ${hint}\n` : ''}`);
		}
		process.exit(3);
	}
	console.error(err?.stack || err);
	process.exit(1);
}
