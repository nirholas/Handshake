#!/usr/bin/env node
// Verify that the cron schedules declared in vercel.json are (a) valid cron
// expressions and (b) actually what Cloud Scheduler is running.
//
// vercel.json is a LIVE config file: the Express server reads its `routes`, and
// `scripts/create-gcp-scheduler.mjs` seeds Cloud Scheduler from its `crons`.
// But nothing verified the two stayed in agreement. A schedule edited in
// vercel.json without a re-sync, a job paused by hand during an incident and
// never resumed, or a job deleted outright, all fail silently: the declared
// config looks right while the job never fires.
//
// Usage:
//   node scripts/check-cron-drift.mjs              # validate + compare to live
//   node scripts/check-cron-drift.mjs --offline    # validate expressions only
//   node scripts/check-cron-drift.mjs --json       # machine-readable report
//
// Exits non-zero when drift or an invalid expression is found, so it can gate a
// deploy.

import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CronExpressionParser } from 'cron-parser';

const execFileP = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PROJECT = 'aerial-vehicle-466722-p5';
const LOCATION = 'us-central1';

const argv = process.argv.slice(2);
const OFFLINE = argv.includes('--offline');
const AS_JSON = argv.includes('--json');

// Must match scripts/create-gcp-scheduler.mjs exactly, or every job reads as
// missing.
function jobId(cronPath) {
	return `cron-${cronPath.replace(/[^a-zA-Z0-9]+/g, '-')}`.slice(0, 500);
}

/** Parse a cron expression, returning its next fire times or an error. */
function validate(schedule) {
	try {
		const it = CronExpressionParser.parse(schedule, { tz: 'UTC' });
		const next = [it.next().toISOString(), it.next().toISOString()];
		return { ok: true, next };
	} catch (err) {
		return { ok: false, error: err.message };
	}
}

/** Interval in minutes between the next two fires, as a load signal. */
function intervalMinutes(next) {
	if (!next || next.length < 2) return null;
	return Math.round((Date.parse(next[1]) - Date.parse(next[0])) / 60_000);
}

async function liveJobs() {
	const { stdout } = await execFileP(
		'gcloud',
		[
			'scheduler', 'jobs', 'list',
			`--project=${PROJECT}`,
			`--location=${LOCATION}`,
			'--format=json',
			'--quiet',
		],
		{ maxBuffer: 16 * 1024 * 1024 },
	);
	const rows = JSON.parse(stdout || '[]');
	const byId = new Map();
	for (const job of rows) {
		// name is fully qualified: projects/…/locations/…/jobs/<id>
		const id = String(job.name || '').split('/').pop();
		byId.set(id, { schedule: job.schedule, state: job.state, timeZone: job.timeZone });
	}
	return byId;
}

const { crons } = JSON.parse(readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
if (!Array.isArray(crons) || !crons.length) {
	console.error('No crons found in vercel.json.');
	process.exit(1);
}

const invalid = [];
const declared = [];
for (const { path: cronPath, schedule } of crons) {
	const v = validate(schedule);
	if (!v.ok) {
		invalid.push({ path: cronPath, schedule, error: v.error });
		continue;
	}
	declared.push({
		path: cronPath,
		schedule,
		id: jobId(cronPath),
		everyMinutes: intervalMinutes(v.next),
		nextFire: v.next[0],
	});
}

// Duplicate paths would make one job silently overwrite the other on sync.
const seen = new Map();
const duplicates = [];
for (const d of declared) {
	if (seen.has(d.id)) duplicates.push({ id: d.id, paths: [seen.get(d.id), d.path] });
	else seen.set(d.id, d.path);
}

const report = {
	declared: declared.length,
	invalid,
	duplicates,
	missing: [],
	mismatched: [],
	paused: [],
	orphaned: [],
	checkedLive: false,
};

if (!OFFLINE) {
	try {
		const live = await liveJobs();
		report.checkedLive = true;
		for (const d of declared) {
			const job = live.get(d.id);
			if (!job) {
				report.missing.push({ path: d.path, id: d.id, schedule: d.schedule });
				continue;
			}
			if (String(job.schedule).trim() !== String(d.schedule).trim()) {
				report.mismatched.push({
					path: d.path,
					id: d.id,
					declared: d.schedule,
					live: job.schedule,
				});
			}
			if (job.state && job.state !== 'ENABLED') {
				report.paused.push({ path: d.path, id: d.id, state: job.state });
			}
		}
		const declaredIds = new Set(declared.map((d) => d.id));
		for (const [id, job] of live) {
			if (id.startsWith('cron-') && !declaredIds.has(id)) {
				report.orphaned.push({ id, schedule: job.schedule, state: job.state });
			}
		}
	} catch (err) {
		report.liveError = err.message.split('\n')[0];
	}
}

const problems =
	report.invalid.length +
	report.duplicates.length +
	report.missing.length +
	report.mismatched.length +
	report.paused.length;

if (AS_JSON) {
	console.log(JSON.stringify(report, null, 2));
	process.exit(problems ? 1 : 0);
}

console.log(`Declared crons in vercel.json: ${report.declared}`);
const busiest = [...declared]
	.filter((d) => d.everyMinutes != null)
	.sort((a, b) => a.everyMinutes - b.everyMinutes)
	.slice(0, 5);
if (busiest.length) {
	console.log('Most frequent:');
	for (const d of busiest) console.log(`  every ${d.everyMinutes}m  ${d.path}`);
}

for (const [label, rows, fmt] of [
	['INVALID expression', report.invalid, (r) => `${r.path}  "${r.schedule}"  ${r.error}`],
	['DUPLICATE job id', report.duplicates, (r) => `${r.id}  ${r.paths.join(' vs ')}`],
	['MISSING in Cloud Scheduler', report.missing, (r) => `${r.path}  (${r.id})`],
	['SCHEDULE MISMATCH', report.mismatched, (r) => `${r.path}  declared "${r.declared}"  live "${r.live}"`],
	['NOT ENABLED', report.paused, (r) => `${r.path}  state=${r.state}`],
	['ORPHANED job (no longer declared)', report.orphaned, (r) => `${r.id}  "${r.schedule}"`],
]) {
	if (!rows.length) continue;
	console.log(`\n${label}: ${rows.length}`);
	for (const r of rows) console.log(`  ${fmt(r)}`);
}

if (report.liveError) {
	console.log(`\nCould not read Cloud Scheduler: ${report.liveError}`);
	console.log('Expression validation still ran. Re-run after `gcloud auth login` to compare live jobs.');
} else if (!OFFLINE && !problems) {
	console.log('\nNo drift: every declared cron exists, is enabled, and matches its live schedule.');
} else if (OFFLINE && !problems) {
	console.log('\nAll cron expressions are valid (offline mode: live jobs not compared).');
}

// Orphans alone do not fail the check — a job intentionally left behind during
// a migration is not a broken deploy. Everything else is.
process.exit(problems ? 1 : 0);
