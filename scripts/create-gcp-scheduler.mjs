#!/usr/bin/env node
// Sync the 76 cron schedules in vercel.json to Google Cloud Scheduler jobs
// targeting the three-ws-api Cloud Run service. Part of the Vercel → GCP
// migration (see server/README.md).
//
// SAFETY: jobs are created PAUSED by default. Vercel's crons keep running
// until cutover, and double-firing money-moving jobs (treasury-topup,
// economy-tick, …) is not acceptable. Flip them live per-job or all at once
// only after the Vercel crons are disabled:
//
//   node scripts/create-gcp-scheduler.mjs --env-file <prod.env>          # sync, paused
//   node scripts/create-gcp-scheduler.mjs --env-file <prod.env> --resume # sync + resume ALL
//   gcloud scheduler jobs resume cron--api-cron-uptime-check --location us-central1  # one job
//
// Auth: each job sends `Authorization: Bearer $CRON_SECRET`, exactly what the
// api/cron/* handlers already validate (Vercel used the same header). The
// secret is read from --env-file or process.env — never hardcoded.

import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
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
// Scheduler's own request deadline; the longest Vercel maxDuration is 300s.
const ATTEMPT_DEADLINE = '320s';

const args = process.argv.slice(2);
const resume = args.includes('--resume');
const envFileIdx = args.indexOf('--env-file');
if (envFileIdx !== -1 && args[envFileIdx + 1]) {
	for (const line of readFileSync(args[envFileIdx + 1], 'utf8').split('\n')) {
		const m = line.match(/^CRON_SECRET="?([^"\n]+)"?$/);
		if (m) process.env.CRON_SECRET = m[1];
	}
}
const CRON_SECRET = process.env.CRON_SECRET;
if (!CRON_SECRET) {
	console.error('CRON_SECRET not set — pass --env-file <pulled prod.env> or export it.');
	process.exit(1);
}

const { crons } = JSON.parse(readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
if (!Array.isArray(crons) || crons.length === 0) {
	console.error('No crons found in vercel.json.');
	process.exit(1);
}

// /api/cron/economy-tick → cron--api-cron-economy-tick (Scheduler job ids
// allow [a-zA-Z0-9_-], max 500 chars).
function jobId(cronPath) {
	return `cron-${cronPath.replace(/[^a-zA-Z0-9]+/g, '-')}`.slice(0, 500);
}

async function gcloud(cmdArgs) {
	return execFileP(
		'gcloud',
		[
			'scheduler',
			'jobs',
			...cmdArgs,
			`--project=${PROJECT}`,
			`--location=${LOCATION}`,
			'--quiet',
		],
		{
			maxBuffer: 4 * 1024 * 1024,
		},
	);
}

async function syncJob({ path: cronPath, schedule }) {
	const id = jobId(cronPath);
	const common = [
		`--schedule=${schedule}`,
		'--time-zone=Etc/UTC',
		`--uri=${SERVICE_URL}${cronPath}`,
		'--http-method=GET',
		`--attempt-deadline=${ATTEMPT_DEADLINE}`,
		`--update-headers=Authorization=Bearer ${CRON_SECRET}`,
	];
	let action;
	try {
		await gcloud(['describe', id]);
		await gcloud(['update', 'http', id, ...common]);
		action = 'updated';
	} catch {
		await gcloud([
			'create',
			'http',
			id,
			`--schedule=${schedule}`,
			'--time-zone=Etc/UTC',
			`--uri=${SERVICE_URL}${cronPath}`,
			'--http-method=GET',
			`--attempt-deadline=${ATTEMPT_DEADLINE}`,
			`--headers=Authorization=Bearer ${CRON_SECRET}`,
		]);
		action = 'created';
	}
	if (resume) {
		await gcloud(['resume', id]).catch(() => {}); // already enabled → fine
	} else {
		await gcloud(['pause', id]).catch(() => {}); // already paused → fine
	}
	return { id, action, state: resume ? 'ENABLED' : 'PAUSED' };
}

const queue = [...crons];
const results = [];
const failures = [];
await Promise.all(
	Array.from({ length: CONCURRENCY }, async () => {
		while (queue.length) {
			const cron = queue.shift();
			try {
				const r = await syncJob(cron);
				results.push(r);
				console.log(`${r.action} ${r.id} [${r.state}] (${cron.schedule})`);
			} catch (err) {
				failures.push({ cron, message: err.stderr || err.message });
				console.error(`FAILED ${cron.path}: ${(err.stderr || err.message).trim()}`);
			}
		}
	}),
);

console.log(
	`\n${results.length}/${crons.length} jobs synced (${resume ? 'ENABLED' : 'PAUSED'}); ${failures.length} failed.`,
);
if (failures.length) process.exit(1);
