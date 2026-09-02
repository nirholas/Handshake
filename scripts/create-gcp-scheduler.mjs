#!/usr/bin/env node
// Sync the cron schedules declared in vercel.json to Google Cloud Scheduler jobs
// targeting the three-ws-api Cloud Run service. vercel.json's `crons` array is
// the source of truth for which crons exist and how many; this script never
// hardcodes a count.
//
// RUN STATE: a sync is CONFIG ONLY. It writes schedule, target URI, method,
// attempt deadline and the Authorization header, and it never changes whether an
// already-existing job is running. That default is load-bearing in both
// directions:
//
//   * Pausing on every sync would stop the whole fleet (payouts, buybacks,
//     treasury moves, the changelog push, the dead-man switch) while the declared
//     config still looked perfect. That is the failure `npm run check:cron-drift`
//     reports as NOT ENABLED and `npm run audit:cron-liveness` reports as DEAD:
//     invisible from the config, total in effect. It was this script's default
//     until the Vercel cutover made the double-fire risk it guarded against moot
//     (production has run only on Cloud Run since 2026-07-07), and
//     `scripts/gcp-triage.mjs` still hands an operator the bare command as the
//     "config-only" remedy for a single drifted cron.
//   * Blanket-resuming would silently undo a deliberate incident hold, which is a
//     legitimate reason for a job to sit PAUSED.
//
// A job this run CREATES starts ENABLED: a cron declared in vercel.json but
// created paused never fires, and nothing in the config would ever show it.
//
// The two blanket levers are explicit and mutually exclusive:
//
//   node scripts/create-gcp-scheduler.mjs --env-file <prod.env>           # sync config, leave run state alone
//   node scripts/create-gcp-scheduler.mjs --env-file <prod.env> --pause   # sync + pause EVERY job (stop the fleet)
//   node scripts/create-gcp-scheduler.mjs --env-file <prod.env> --resume  # sync + resume EVERY job (recover from --pause)
//   gcloud scheduler jobs resume cron--api-cron-uptime-check --location us-central1  # one job
//
// `--only <substring>[,<substring>]` narrows any of the above to the crons whose
// declared path contains one of those substrings, so repairing the single job
// `npm run check:cron-drift` reports MISSING does not re-touch the rest of the
// fleet:
//
//   node scripts/create-gcp-scheduler.mjs --env-file <prod.env> --only garment-job-sweep
//
// Auth: each job sends `Authorization: Bearer $CRON_SECRET`, exactly what the
// api/cron/* handlers already validate. The secret is read from --env-file, then
// process.env, then the live three-ws-api Cloud Run service (production's
// authoritative copy, and the only source on a machine whose .env lacks it).
// It is never hardcoded.

import { readFileSync } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import './lib/gcloud-path.mjs';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PROJECT = 'aerial-vehicle-466722-p5';
const LOCATION = 'us-central1';
const SERVICE_URL = 'https://three-ws-api-lp642k3kpa-uc.a.run.app';
const CONCURRENCY = 8;
// Scheduler's own request deadline; the longest handler maxDuration is 300s.
const ATTEMPT_DEADLINE = '320s';

/**
 * Scheduler job id for a cron path: `/api/cron/economy-tick` →
 * `cron--api-cron-economy-tick`. The path's leading slash becomes a hyphen of its
 * own, hence the double hyphen. Job ids allow [a-zA-Z0-9_-], max 500 chars.
 *
 * `scripts/check-cron-drift.mjs` imports this rather than re-deriving it: two
 * copies that drift by one character make every live job read as MISSING and
 * every declared cron read as unsynced.
 */
export function jobId(cronPath) {
	return `cron-${cronPath.replace(/[^a-zA-Z0-9]+/g, '-')}`.slice(0, 500);
}

/**
 * Which blanket run-state change the flags ask for, or null for none.
 * Throws when both levers are passed, since neither order of applying them is a
 * defensible guess at what the operator meant.
 */
export function runStateAction(argv) {
	const pause = argv.includes('--pause');
	const resume = argv.includes('--resume');
	if (pause && resume) {
		throw new Error('--pause and --resume are mutually exclusive; pass at most one.');
	}
	if (pause) return 'pause';
	if (resume) return 'resume';
	return null;
}

/**
 * Narrow a sync to the crons named by `--only <substring>[,<substring>...]`,
 * matched against the declared cron path. Without the flag every declared cron
 * is synced, which is the right default for a fleet-wide re-sync and the wrong
 * one for repairing a single drifted job: `npm run check:cron-drift` names one
 * path, and touching the other 110 healthy jobs to fix it is blast radius
 * nobody asked for. With `--pause`/`--resume` the flag bounds those levers to
 * the same subset instead of the whole fleet.
 *
 * A filter that matches nothing throws rather than syncing zero jobs, because a
 * mistyped path would otherwise report a clean run having done nothing at all.
 */
export function selectCrons(crons, argv) {
	const idx = argv.indexOf('--only');
	if (idx === -1) return crons;
	const raw = argv[idx + 1];
	if (!raw || raw.startsWith('--')) {
		throw new Error('--only needs a value, e.g. --only garment-job-sweep');
	}
	const needles = raw
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
	if (!needles.length) throw new Error('--only needs a value, e.g. --only garment-job-sweep');
	const picked = crons.filter((c) => needles.some((n) => c.path.includes(n)));
	if (!picked.length) {
		throw new Error(`--only ${raw} matched none of the ${crons.length} crons declared in vercel.json.`);
	}
	return picked;
}

/** Read CRON_SECRET out of a `--env-file <path>` argument, if one was given. */
export function cronSecretFromArgs(argv, readFile = (p) => readFileSync(p, 'utf8')) {
	const idx = argv.indexOf('--env-file');
	if (idx === -1 || !argv[idx + 1]) return null;
	for (const line of readFile(argv[idx + 1]).split('\n')) {
		const m = line.match(/^CRON_SECRET="?([^"\n]+)"?$/);
		if (m) return m[1];
	}
	return null;
}

/**
 * Read CRON_SECRET off the live Cloud Run service, which is where production's
 * authoritative copy lives. `.env` does not carry it and `vercel env pull`
 * returns empty for secret-type vars, so on a fresh machine this is the only
 * place it can come from. Every other thing this script does already requires
 * an authenticated gcloud session, so needing one here costs nothing extra.
 *
 * Returns null rather than throwing: a caller that also has `--env-file` or a
 * process env should not be denied by an unrelated gcloud failure.
 */
export function cronSecretFromService(describe = defaultDescribeService) {
	let svc;
	try {
		svc = JSON.parse(describe());
	} catch {
		return null;
	}
	const env = svc?.spec?.template?.spec?.containers?.[0]?.env || [];
	return env.find((e) => e.name === 'CRON_SECRET')?.value || null;
}

function defaultDescribeService() {
	return execFileSync(
		'gcloud',
		[
			'run',
			'services',
			'describe',
			'three-ws-api',
			`--region=${LOCATION}`,
			`--project=${PROJECT}`,
			'--format=json',
		],
		{ encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
	);
}

async function gcloud(cmdArgs) {
	return execFileP(
		'gcloud',
		['scheduler', 'jobs', ...cmdArgs, `--project=${PROJECT}`, `--location=${LOCATION}`, '--quiet'],
		{ maxBuffer: 4 * 1024 * 1024 },
	);
}

async function syncJob({ path: cronPath, schedule }, { secret, stateAction }) {
	const id = jobId(cronPath);
	const common = [
		`--schedule=${schedule}`,
		'--time-zone=Etc/UTC',
		`--uri=${SERVICE_URL}${cronPath}`,
		'--http-method=GET',
		`--attempt-deadline=${ATTEMPT_DEADLINE}`,
	];
	let action;
	try {
		await gcloud(['describe', id]);
		await gcloud(['update', 'http', id, ...common, `--update-headers=Authorization=Bearer ${secret}`]);
		action = 'updated';
	} catch {
		// gcloud creates a job ENABLED, which is what a freshly declared cron wants.
		await gcloud(['create', 'http', id, ...common, `--headers=Authorization=Bearer ${secret}`]);
		action = 'created';
	}
	let state = action === 'created' ? 'ENABLED' : 'unchanged';
	if (stateAction === 'pause') {
		await gcloud(['pause', id]).catch(() => {}); // already paused → fine
		state = 'PAUSED';
	} else if (stateAction === 'resume') {
		await gcloud(['resume', id]).catch(() => {}); // already enabled → fine
		state = 'ENABLED';
	}
	return { id, action, state };
}

async function main() {
	const argv = process.argv.slice(2);

	let stateAction;
	try {
		stateAction = runStateAction(argv);
	} catch (err) {
		console.error(err.message);
		process.exit(1);
	}

	const secret = cronSecretFromArgs(argv) || process.env.CRON_SECRET || cronSecretFromService();
	if (!secret) {
		console.error(
			'CRON_SECRET not set: pass --env-file <pulled prod.env>, export it, or authenticate gcloud so it can be read off the three-ws-api service.',
		);
		process.exit(1);
	}

	const { crons } = JSON.parse(readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
	if (!Array.isArray(crons) || crons.length === 0) {
		console.error('No crons found in vercel.json.');
		process.exit(1);
	}

	let selected;
	try {
		selected = selectCrons(crons, argv);
	} catch (err) {
		console.error(err.message);
		process.exit(1);
	}
	if (selected.length !== crons.length) {
		console.log(`--only: syncing ${selected.length} of ${crons.length} declared crons.`);
	}

	const queue = [...selected];
	const results = [];
	const failures = [];
	await Promise.all(
		Array.from({ length: CONCURRENCY }, async () => {
			while (queue.length) {
				const cron = queue.shift();
				try {
					const r = await syncJob(cron, { secret, stateAction });
					results.push(r);
					console.log(`${r.action} ${r.id} [${r.state}] (${cron.schedule})`);
				} catch (err) {
					failures.push({ cron, message: err.stderr || err.message });
					console.error(`FAILED ${cron.path}: ${(err.stderr || err.message).trim()}`);
				}
			}
		}),
	);

	const created = results.filter((r) => r.action === 'created');
	console.log(
		`\n${results.length}/${selected.length} jobs synced; ${created.length} created ENABLED; ${failures.length} failed.`,
	);
	console.log(
		stateAction
			? `Run state: every synced job ${stateAction === 'pause' ? 'PAUSED' : 'RESUMED'} by --${stateAction}.`
			: 'Run state: left untouched on existing jobs (pass --pause or --resume to change it).',
	);
	if (failures.length) process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await main();
}
