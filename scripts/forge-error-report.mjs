#!/usr/bin/env node
/**
 * Forge generation error report. Ranks what is actually failing, from the
 * outcome ledger (`forge_creations`), over a real window.
 *
 * /api/healthz already answers "is generation healthy right now?" over a fixed
 * 6-hour window (api/_lib/ops/forge-health-sensor.js). That window is tuned to
 * page on a burst, and at ~7 image jobs an hour it is regularly too small to
 * judge at all (a quiet afternoon reads `unknown`). Triage needs the other
 * question: over the last week, which failure class recurs most, on which lane,
 * and what does it actually say? This is that query, as a command, so nobody
 * hand-writes it against production again.
 *
 * Usage:
 *   node scripts/forge-error-report.mjs                 # last 7 days
 *   node scripts/forge-error-report.mjs --days 30
 *   node scripts/forge-error-report.mjs --days 7 --json
 *   node scripts/forge-error-report.mjs --class lost_task   # every message in one class
 *   node scripts/forge-error-report.mjs --include-recovered # count failed-over attempts too
 *
 * Reads DATABASE_URL from .env.local, then .env, then the shell (same order as
 * scripts/apply-migrations.mjs). Read-only: it runs SELECTs and nothing else.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { neon } from '@neondatabase/serverless';
import { classifyForgeError } from '../api/_lib/ops/forge-error-class.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');

for (const envFile of ['.env.local', '.env']) {
	try {
		const raw = readFileSync(path.resolve(REPO_ROOT, envFile), 'utf8');
		for (const line of raw.split('\n')) {
			const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
			if (!m || process.env[m[1]]) continue;
			let val = m[2].trim();
			if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
				val = val.slice(1, -1);
			}
			process.env[m[1]] = val;
		}
	} catch { /* file not present */ }
}

const args = process.argv.slice(2);
const flag = (name, fallback) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const DAYS = Math.max(1, Math.min(365, Number(flag('days', '7')) || 7));
const JSON_OUT = args.includes('--json');
const ONLY_CLASS = flag('class', null);
// A failed attempt that was automatically re-dispatched to another lane is not
// a user-visible failure: the successor row carries the same request to its real
// outcome. Ranking those by default puts a class the platform already recovers
// from at rank 1, which is exactly how this report would waste a triager's day.
const INCLUDE_RECOVERED = args.includes('--include-recovered');

if (!process.env.DATABASE_URL) {
	console.error('DATABASE_URL is not set. Add it to .env.local or export it in your shell.');
	console.error('Production\'s value lives on the Cloud Run service:');
	console.error('  gcloud run services describe three-ws-api --region us-central1 \\');
	console.error('    --project aerial-vehicle-466722-p5 --format=yaml | grep -A1 DATABASE_URL');
	process.exit(2);
}

const sql = neon(process.env.DATABASE_URL);

function maskUrl(url) {
	try {
		const u = new URL(url);
		if (u.password) u.password = '***';
		return u.toString();
	} catch {
		return '<DATABASE_URL>';
	}
}

const pct = (n, d) => (d > 0 ? `${((n / d) * 100).toFixed(1)}%` : 'n/a');

async function main() {
	const since = `${DAYS} days`;

	const [totals] = await sql`
		SELECT count(*) FILTER (WHERE status = 'done')::int    AS done,
		       count(*) FILTER (WHERE status = 'failed')::int  AS failed,
		       count(*) FILTER (WHERE status NOT IN ('done', 'failed'))::int AS open,
		       count(*) FILTER (WHERE superseded_by IS NOT NULL)::int AS recovered,
		       count(*)::int AS rows
		FROM forge_creations
		WHERE created_at >= now() - ${since}::interval
	`;

	// Raw failures, newest first. The classifier runs here rather than in SQL:
	// grouping on the stored text would count each occurrence's own ids and
	// durations as a separate class, which is the whole reason this report needs
	// to exist. Bounded by the window and by forge's real volume.
	const failures = await sql`
		SELECT id, error, created_at,
		       COALESCE(backend, '(none)') AS backend,
		       COALESCE(path, '(none)')    AS path
		FROM forge_creations
		WHERE status = 'failed'
		  AND created_at >= now() - ${since}::interval
		  AND (${INCLUDE_RECOVERED} OR superseded_by IS NULL)
		ORDER BY created_at DESC
	`;

	/** @type {Map<string, { id: string, label: string, n: number, lanes: Map<string, number>, paths: Map<string, number>, first: string, last: string, samples: string[] }>} */
	const classes = new Map();
	for (const row of failures) {
		const c = classifyForgeError(row.error);
		const key = c.id === 'other' ? `other:${c.normalized}` : c.id;
		let entry = classes.get(key);
		if (!entry) {
			entry = { id: c.id, label: c.label, n: 0, lanes: new Map(), paths: new Map(), first: row.created_at, last: row.created_at, samples: [] };
			classes.set(key, entry);
		}
		entry.n += 1;
		entry.lanes.set(row.backend, (entry.lanes.get(row.backend) || 0) + 1);
		entry.paths.set(row.path, (entry.paths.get(row.path) || 0) + 1);
		if (row.created_at < entry.first) entry.first = row.created_at;
		if (row.created_at > entry.last) entry.last = row.created_at;
		if (entry.samples.length < 3 && row.error) entry.samples.push(String(row.error).slice(0, 200));
	}

	const ranked = [...classes.entries()]
		.map(([key, e]) => ({
			key,
			id: e.id,
			label: e.label,
			count: e.n,
			share: failures.length ? e.n / failures.length : 0,
			lanes: [...e.lanes.entries()].sort((a, b) => b[1] - a[1]).map(([lane, n]) => ({ lane, n })),
			paths: [...e.paths.entries()].sort((a, b) => b[1] - a[1]).map(([p, n]) => ({ path: p, n })),
			firstSeen: e.first,
			lastSeen: e.last,
			samples: e.samples,
		}))
		.sort((a, b) => b.count - a.count);

	const done = totals?.done ?? 0;
	const failedRows = totals?.failed ?? 0;
	const recovered = totals?.recovered ?? 0;
	// The attempts nobody recovered: one row per request the user actually lost.
	const lost = Math.max(0, failedRows - recovered);
	const judged = done + lost;

	const report = {
		windowDays: DAYS,
		database: maskUrl(process.env.DATABASE_URL),
		generations: totals?.rows ?? 0,
		done,
		failed: failedRows,
		recovered,
		lost,
		stillOpen: totals?.open ?? 0,
		includesRecovered: INCLUDE_RECOVERED,
		successRate: judged > 0 ? done / judged : null,
		classes: ranked,
	};

	if (JSON_OUT) {
		console.log(JSON.stringify(report, null, 2));
		return;
	}

	console.log(`Forge generation errors, last ${DAYS} day(s), on ${report.database}\n`);
	console.log(`  generations ${report.generations}   done ${done}   failed ${failedRows}   still running ${report.stillOpen}`);
	console.log(`  of those failures, ${recovered} were re-dispatched to another lane and finished there; ${lost} were lost`);
	console.log(`  success rate ${report.successRate == null ? 'n/a (no finished generations)' : pct(done, judged)} (recovered attempts are not counted against it)\n`);

	if (!ranked.length) {
		console.log(
			recovered && !INCLUDE_RECOVERED
				? `  No unrecovered failures in this window. Re-run with --include-recovered to rank the ${recovered} that failed over.`
				: '  No failed generations in this window. Nothing to rank.',
		);
		return;
	}
	if (recovered && !INCLUDE_RECOVERED) {
		console.log(`  (${recovered} recovered attempt(s) excluded; --include-recovered to rank them too)\n`);
	}

	if (ONLY_CLASS) {
		const picked = ranked.filter((c) => c.id === ONLY_CLASS);
		if (!picked.length) {
			console.error(`  No class "${ONLY_CLASS}" in this window. Classes present: ${[...new Set(ranked.map((c) => c.id))].join(', ')}`);
			process.exitCode = 1;
			return;
		}
		for (const c of picked) {
			console.log(`  ${c.id}: ${c.count} failure(s), ${pct(c.count, failures.length)} of all failures`);
			console.log(`    lanes: ${c.lanes.map((l) => `${l.lane}×${l.n}`).join(', ')}`);
			console.log(`    paths: ${c.paths.map((p) => `${p.path}×${p.n}`).join(', ')}`);
			console.log(`    first ${new Date(c.firstSeen).toISOString()}   last ${new Date(c.lastSeen).toISOString()}`);
			for (const s of c.samples) console.log(`    · ${s}`);
			console.log('');
		}
		return;
	}

	console.log('  rank  n     share   class                  worst lane            message');
	ranked.forEach((c, i) => {
		const lane = c.lanes[0] ? `${c.lanes[0].lane}×${c.lanes[0].n}` : '(none)';
		console.log(
			`  ${String(i + 1).padEnd(5)} ${String(c.count).padEnd(5)} ${pct(c.count, failures.length).padEnd(7)} ` +
			`${c.id.padEnd(22)} ${lane.padEnd(21)} ${(c.samples[0] || c.label).slice(0, 70)}`,
		);
	});

	const top = ranked[0];
	console.log(`\n  Top class: ${top.id} (${top.label})`);
	console.log(`    ${top.count} of ${failures.length} failures (${pct(top.count, failures.length)}), lanes ${top.lanes.map((l) => `${l.lane}×${l.n}`).join(', ')}`);
	console.log(`    last seen ${new Date(top.lastSeen).toISOString()}`);
	console.log(`    drill in: node scripts/forge-error-report.mjs --days ${DAYS} --class ${top.id}`);
}

main().catch((e) => {
	console.error('FAILED:', e?.message || e);
	process.exitCode = 1;
});
