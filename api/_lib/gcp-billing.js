// Cloud Billing → BigQuery burn attribution + projection.
//
// The $100k GCP credit program (prompts/gcp-credits/) burns across several
// lanes — Vertex Claude, Imagen, the self-host GPU forge fleet, vanity mining.
// This module reads the BigQuery billing export (line-item, label-attributable
// cost data) and turns it into an attributed burn report: credit consumed to
// date, spend by service, spend by lane label, daily burn rate, and — the
// number that actually matters — projected credit-exhaustion date vs the credit
// expiry date, plus the inverse failure mode (credits left unused at expiry).
//
// One implementation, two consumers:
//   • scripts/gcp/burn-report.mjs      — human-readable CLI + --json
//   • api/cron/gcp-burn-report.js       — daily ops ping
//
// Auth reuses the shared Vertex service account (api/_lib/gcp-auth.js,
// cloud-platform scope). In serverless (no gcloud/bq CLI) the query runs over
// the BigQuery REST jobs.query endpoint; the CLI script can also feed a token
// from `gcloud auth print-access-token` for local runs.
//
// Everything degrades to a designed error (BillingUnavailableError) rather than
// throwing raw when the export dataset isn't wired yet — a burn report that
// can't reach BigQuery must say so clearly, not 500.

import { getGcpAccessToken } from './gcp-auth.js';

const DAY_MS = 86_400_000;

// Credit types that represent the grant we're burning down. Sustained- and
// committed-use discounts on paid spend are excluded by default so the "credit
// consumed" number tracks the promotional/startup grant, not routine discounts.
// Override with GCP_CREDIT_TYPES (comma-separated) if the grant lands under a
// different credit type in this billing account.
const DEFAULT_CREDIT_TYPES = ['PROMOTION', 'FREE_TRIAL', 'COMMITTED_USAGE_DISCOUNT', 'SUBSCRIPTION_BENEFIT'];

// The label every program resource carries (prompts 02–06). Attribution hangs
// off this: `program=gcp-credits` scopes the burn, `lane=<name>` splits it.
export const PROGRAM_LABEL = 'gcp-credits';

// Known lanes, for display ordering + the under-utilization scale-up hints.
export const PROGRAM_LANES = Object.freeze({
	'vertex-claude': { label: 'Vertex Claude', scaleUp: 'flip VERTEX_CLAUDE_PRIMARY on for production chat traffic' },
	imagen: { label: 'Imagen', scaleUp: 'route more forge image generations through Vertex Imagen' },
	'forge-gpu': { label: 'Forge GPU fleet', scaleUp: 'raise seed-batch volume / min-instances on the Cloud Run GPU workers' },
	vanity: { label: 'Vanity mining', scaleUp: 'schedule larger vanity grinder runs' },
	'(unlabeled)': { label: 'Unlabeled', scaleUp: 'label the resource (scripts/gcp/label-resources.sh) so this spend is attributable' },
});

export class BillingUnavailableError extends Error {
	constructor(message, cause) {
		super(message);
		this.name = 'BillingUnavailableError';
		this.code = 'billing_unavailable';
		if (cause) this.cause = cause;
	}
}

// The export exists in config but not in BigQuery: the dataset is there and the
// table name resolves, yet the billing account was never pointed at it. This is
// a NOT-WIRED state awaiting a one-time owner console action (Billing → Billing
// export → BigQuery export), not a runtime fault, and callers must be able to
// tell the two apart: reported as a failure it pages ops every single day about
// a step no amount of retrying can complete. Subclasses BillingUnavailableError
// so every existing `instanceof` catch keeps working unchanged.
export class BillingExportMissingError extends BillingUnavailableError {
	constructor(message, cause) {
		super(message, cause);
		this.name = 'BillingExportMissingError';
		this.code = 'billing_export_missing';
	}
}

function readEnv(name) {
	return (typeof process !== 'undefined' && process.env?.[name]) || null;
}

// Resolve the fully-qualified billing export table + program config from env.
// Throws BillingUnavailableError (not a raw error) when a required piece is
// missing so every caller can branch to a "not wired yet" state.
export function resolveBillingConfig(env = process.env) {
	const project = env.GOOGLE_CLOUD_PROJECT || env.GCP_BILLING_PROJECT || null;
	const dataset = env.GCP_BILLING_DATASET || null;
	// Standard export table name is derived from the billing account id with
	// dashes replaced by underscores. `resource` export prefixes with
	// `gcp_billing_export_resource_v1_`; standard uses `gcp_billing_export_v1_`.
	let table = env.GCP_BILLING_TABLE || null;
	if (!table && env.GCP_BILLING_ACCOUNT_ID) {
		const suffix = env.GCP_BILLING_ACCOUNT_ID.replace(/-/g, '_');
		const kind = (env.GCP_BILLING_EXPORT_KIND || 'standard').toLowerCase();
		const prefix = kind === 'resource' ? 'gcp_billing_export_resource_v1_' : 'gcp_billing_export_v1_';
		table = `${prefix}${suffix}`;
	}
	if (!project || !dataset || !table) {
		throw new BillingUnavailableError(
			'BigQuery billing export not configured. Set GOOGLE_CLOUD_PROJECT, GCP_BILLING_DATASET, and GCP_BILLING_TABLE (or GCP_BILLING_ACCOUNT_ID). See docs/ops/gcp-credits.md.',
		);
	}

	const creditTypes = (env.GCP_CREDIT_TYPES
		? env.GCP_CREDIT_TYPES.split(',')
		: DEFAULT_CREDIT_TYPES
	)
		.map((t) => t.trim().toUpperCase())
		.filter((t) => /^[A-Z_]+$/.test(t)); // only well-formed enum tokens reach SQL

	const creditTotalUsd = Number(env.GCP_CREDIT_TOTAL_USD || 0) || null;
	const creditExpiry = env.GCP_CREDIT_EXPIRY ? new Date(env.GCP_CREDIT_EXPIRY) : null;

	return {
		project,
		dataset,
		table,
		fqTable: `\`${project}.${dataset}.${table}\``,
		creditTypes,
		creditTotalUsd,
		creditExpiry: creditExpiry && !Number.isNaN(creditExpiry.getTime()) ? creditExpiry : null,
		programLabel: env.GCP_CREDIT_PROGRAM || PROGRAM_LABEL,
	};
}

// True when the billing export is wired well enough to attempt a query.
export function billingConfigured(env = process.env) {
	try {
		resolveBillingConfig(env);
		return true;
	} catch {
		return false;
	}
}

// ── BigQuery REST query ─────────────────────────────────────────────────────

// Run one standard-SQL query via the BigQuery jobs.query REST endpoint and
// return rows as plain objects keyed by the SELECT aliases. `tokenFn` lets the
// CLI inject a `gcloud`-minted token; defaults to the shared SA token.
export async function queryBilling(query, { project, tokenFn = getGcpAccessToken, timeoutMs = 60_000 } = {}) {
	let token;
	try {
		token = await tokenFn();
	} catch (err) {
		throw new BillingUnavailableError(`GCP auth unavailable: ${err?.message || err}`, err);
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	let res;
	try {
		res = await fetch(
			`https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(project)}/queries`,
			{
				method: 'POST',
				headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
				body: JSON.stringify({ query, useLegacySql: false, timeoutMs: Math.min(timeoutMs, 55_000) }),
				signal: controller.signal,
			},
		);
	} catch (err) {
		throw new BillingUnavailableError(`BigQuery unreachable: ${err?.message || err}`, err);
	} finally {
		clearTimeout(timer);
	}

	const data = await res.json().catch(() => ({}));
	if (!res.ok) {
		const msg = data?.error?.message || `BigQuery returned ${res.status}`;
		// A missing dataset/table is the "not wired yet" case, not a hard fault.
		if (res.status === 404 || /Not found|does not exist/i.test(msg)) {
			throw new BillingExportMissingError(`Billing export table not found: ${msg}`);
		}
		throw new BillingUnavailableError(`BigQuery query failed: ${msg}`);
	}

	return mapRows(data);
}

// Map a jobs.query response { schema.fields[], rows[{ f:[{v}] }] } into plain
// row objects. Numeric-typed columns are coerced to Number; everything else
// stays a string (BigQuery returns all scalars as strings over REST).
function mapRows(data) {
	const fields = data?.schema?.fields || [];
	const rows = data?.rows || [];
	const numeric = new Set(['INTEGER', 'INT64', 'FLOAT', 'FLOAT64', 'NUMERIC', 'BIGNUMERIC']);
	return rows.map((r) => {
		const obj = {};
		(r.f || []).forEach((cell, i) => {
			const field = fields[i];
			if (!field) return;
			const raw = cell?.v;
			obj[field.name] = raw != null && numeric.has(field.type) ? Number(raw) : raw;
		});
		return obj;
	});
}

// SQL fragment: credit amount (negative) restricted to the grant credit types.
function creditSumExpr(creditTypes) {
	const list = creditTypes.map((t) => `'${t}'`).join(', ');
	const filter = list ? `WHERE c.type IN (${list})` : '';
	return `IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) c ${filter}), 0)`;
}

// ── Report assembly ─────────────────────────────────────────────────────────

// Build the full attributed burn report. Runs four aggregate queries in
// parallel, then folds in the pure projection math.
export async function buildBurnReport({ now = new Date(), env = process.env, tokenFn } = {}) {
	const cfg = resolveBillingConfig(env);
	const creditExpr = creditSumExpr(cfg.creditTypes);
	const q = (query) => queryBilling(query, { project: cfg.project, tokenFn });

	const totalsQ = `
		SELECT
			SUM(cost) AS gross_cost,
			-SUM(${creditExpr}) AS credit_used,
			MIN(usage_start_time) AS first_usage,
			MAX(usage_start_time) AS last_usage
		FROM ${cfg.fqTable}`;

	const byServiceQ = `
		SELECT
			service.description AS service,
			SUM(cost) AS gross,
			-SUM(${creditExpr}) AS credit_used
		FROM ${cfg.fqTable}
		GROUP BY service
		ORDER BY credit_used DESC
		LIMIT 25`;

	const byLaneQ = `
		SELECT
			IFNULL((SELECT l.value FROM UNNEST(labels) l WHERE l.key = 'lane'), '(unlabeled)') AS lane,
			IFNULL((SELECT l.value FROM UNNEST(labels) l WHERE l.key = 'program'), '(none)') AS program,
			SUM(cost) AS gross,
			-SUM(${creditExpr}) AS credit_used
		FROM ${cfg.fqTable}
		GROUP BY lane, program
		ORDER BY credit_used DESC
		LIMIT 50`;

	const dailyQ = `
		SELECT
			DATE(usage_start_time) AS day,
			SUM(cost) AS gross,
			-SUM(${creditExpr}) AS credit_used
		FROM ${cfg.fqTable}
		WHERE usage_start_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY)
		GROUP BY day
		ORDER BY day`;

	const [totals, byService, byLane, daily] = await Promise.all([
		q(totalsQ),
		q(byServiceQ),
		q(byLaneQ),
		q(dailyQ),
	]);

	const t = totals[0] || {};
	const creditUsed = Number(t.credit_used || 0);
	const grossCost = Number(t.gross_cost || 0);

	const avg7 = averageDailyBurn(daily, 7);
	const avg30 = averageDailyBurn(daily, 30);
	// Projection uses the shorter trailing window when it's meaningfully higher
	// (a lane just ramped) so a fresh runaway isn't averaged away by quiet weeks.
	const avgDailyBurn = Math.max(avg7, avg30 * 0.5) || avg30 || avg7;

	const projection = projectExhaustion({
		creditUsed,
		avgDailyBurn,
		creditTotal: cfg.creditTotalUsd,
		now,
		expiry: cfg.creditExpiry,
	});

	return {
		generatedAt: now.toISOString(),
		config: {
			project: cfg.project,
			dataset: cfg.dataset,
			table: cfg.table,
			creditTotalUsd: cfg.creditTotalUsd,
			creditExpiry: cfg.creditExpiry ? cfg.creditExpiry.toISOString() : null,
			creditTypes: cfg.creditTypes,
		},
		totals: {
			creditUsed,
			grossCost,
			firstUsage: t.first_usage || null,
			lastUsage: t.last_usage || null,
		},
		byService: byService.map((r) => ({
			service: r.service || '(unknown)',
			gross: Number(r.gross || 0),
			creditUsed: Number(r.credit_used || 0),
		})),
		byLane: byLane.map((r) => ({
			lane: r.lane || '(unlabeled)',
			program: r.program || '(none)',
			gross: Number(r.gross || 0),
			creditUsed: Number(r.credit_used || 0),
		})),
		daily: daily.map((r) => ({ day: r.day, gross: Number(r.gross || 0), creditUsed: Number(r.credit_used || 0) })),
		burn: { avg7dPerDay: avg7, avg30dPerDay: avg30, usedForProjection: avgDailyBurn },
		projection,
	};
}

// Average daily credit burn over the trailing `days` window of the daily rows.
// Pure; exported for tests.
export function averageDailyBurn(daily, days) {
	if (!Array.isArray(daily) || daily.length === 0) return 0;
	const window = daily.slice(-days);
	const sum = window.reduce((acc, r) => acc + Number(r.creditUsed ?? r.credit_used ?? 0), 0);
	// Divide by the window length actually requested (not rows present) so a
	// lane live for 3 of the last 7 days still reports a true 7-day daily rate.
	return sum / days;
}

// Pure projection: given credit consumed to date, an average daily burn, the
// total grant, and the expiry date, compute runway + the two failure modes
// (runaway before expiry, or >30% unused at expiry). Exported for tests.
export function projectExhaustion({ creditUsed, avgDailyBurn, creditTotal, now = new Date(), expiry }) {
	const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
	const expiryMs = expiry ? (expiry instanceof Date ? expiry.getTime() : new Date(expiry).getTime()) : null;
	const daysToExpiry = expiryMs != null ? Math.max(0, (expiryMs - nowMs) / DAY_MS) : null;

	const out = {
		creditTotalUsd: creditTotal ?? null,
		creditUsedUsd: creditUsed,
		remainingUsd: creditTotal != null ? Math.max(0, creditTotal - creditUsed) : null,
		avgDailyBurnUsd: avgDailyBurn,
		daysToExpiry,
		expiry: expiryMs != null ? new Date(expiryMs).toISOString() : null,
		daysRunway: null,
		exhaustionDate: null,
		projectedSpendByExpiryUsd: null,
		projectedUnusedUsd: null,
		projectedUnusedPct: null,
		status: 'unknown', // 'on-track' | 'runaway' | 'underutilized' | 'idle' | 'unknown'
		headline: '',
	};

	if (creditTotal == null) {
		out.headline = 'Set GCP_CREDIT_TOTAL_USD to enable runway + exhaustion projection.';
		return out;
	}

	const remaining = out.remainingUsd;

	if (avgDailyBurn <= 0) {
		out.daysRunway = Infinity;
		out.status = 'idle';
		out.projectedSpendByExpiryUsd = creditUsed;
		out.projectedUnusedUsd = remaining;
		out.projectedUnusedPct = creditTotal > 0 ? remaining / creditTotal : null;
		out.headline = 'No burn detected — credits are idle. Scale a lane up or they expire unused.';
		return out;
	}

	out.daysRunway = remaining / avgDailyBurn;
	out.exhaustionDate = new Date(nowMs + out.daysRunway * DAY_MS).toISOString();

	if (daysToExpiry != null) {
		const projectedSpend = Math.min(creditTotal, creditUsed + avgDailyBurn * daysToExpiry);
		out.projectedSpendByExpiryUsd = projectedSpend;
		out.projectedUnusedUsd = Math.max(0, creditTotal - projectedSpend);
		out.projectedUnusedPct = creditTotal > 0 ? out.projectedUnusedUsd / creditTotal : null;

		if (out.daysRunway < daysToExpiry) {
			out.status = 'runaway';
			out.headline = `On current burn, credits run out in ~${Math.round(out.daysRunway)}d — ${Math.round(daysToExpiry - out.daysRunway)}d BEFORE expiry. Throttle or the platform loses the free lane early.`;
		} else if (out.projectedUnusedPct > 0.3) {
			out.status = 'underutilized';
			out.headline = `At current burn ~${Math.round(out.projectedUnusedPct * 100)}% of the grant ($${Math.round(out.projectedUnusedUsd).toLocaleString()}) expires UNUSED. Scale up.`;
		} else {
			out.status = 'on-track';
			out.headline = `On track: ~${Math.round(out.projectedUnusedPct * 100)}% unused at expiry, ~${Math.round(out.daysRunway)}d runway.`;
		}
	} else {
		out.status = 'on-track';
		out.headline = `~${Math.round(out.daysRunway)}d of runway at current burn (set GCP_CREDIT_EXPIRY to check against the deadline).`;
	}

	return out;
}

// Human-readable USD.
export function usd(n) {
	if (n == null || Number.isNaN(n)) return '—';
	return `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
