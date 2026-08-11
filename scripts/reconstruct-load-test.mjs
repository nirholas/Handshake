#!/usr/bin/env node
/**
 * reconstruct-load-test — does the selfie→avatar lane actually hold the launch
 * target of 10,000 avatars/day?
 *
 * The reconstruction worker (workers/avatar-reconstruction) answers POST
 * /reconstruct in tens of milliseconds and then does the real work in a FastAPI
 * BackgroundTask behind an in-process semaphore (MAX_CONCURRENT_JOBS). That
 * shape makes throughput invisible to every cheap probe: the submit latency is
 * flat no matter how deep the backlog is, and Cloud Run's request-concurrency
 * signal sees an idle instance while eight vCPUs grind. The only way to know
 * what the lane holds is to submit real photos, poll every job to a terminal
 * state, and measure completion rate against wall clock. That is this script.
 *
 * Two arrival models, because they answer different questions:
 *
 *   --n 5                       BURST. Fire N jobs at once and watch the
 *                               completion times cluster. Waves of C mean one
 *                               instance is serving everything with
 *                               MAX_CONCURRENT_JOBS=C; that is the fastest way
 *                               to see the real per-instance concurrency.
 *   --rate 10000 --duration 600 SUSTAINED. Open-loop arrivals at a target
 *                               expressed in jobs/day (10000/day = one job
 *                               every 8.64 s), held for --duration seconds.
 *                               Open loop matters: a closed loop that waits for
 *                               each job before sending the next can never
 *                               build a backlog, so it always "passes".
 *
 * Targets:
 *
 *   --target worker    POST /reconstruct + GET /jobs/:id straight at the Cloud
 *                      Run service. Needs GCP_RECONSTRUCTION_URL and
 *                      GCP_RECONSTRUCTION_KEY. This is the mode for sustained
 *                      runs: no per-user rate limit, no platform bookkeeping,
 *                      and it isolates the worker from everything around it.
 *   --target platform  POST /api/avatars/reconstruct + GET
 *                      /api/avatars/regenerate-status through three.ws with a
 *                      real signed-in account (RECON_LOAD_EMAIL /
 *                      RECON_LOAD_PASSWORD, falling back to AUDIT_EMAIL /
 *                      AUDIT_PASSWORD). Measures what a user actually waits
 *                      for, including provider selection and the avatar
 *                      materialization that follows a finished mesh. Capped by
 *                      the platform's 60 uploads/hour/user limit, so a long
 *                      sustained run needs --target worker.
 *
 * Photos are the 41 published reference faces the fidelity suite already uses
 * (gs://three-ws-avatar-reconstructions/eval-refs, publicly readable, Vertex
 * generated — no real person's photo is submitted). They are listed live rather
 * than bundled, and each job gets a different face so nothing is served from a
 * cache and every job exercises face detection for real.
 *
 * Usage:
 *   node scripts/reconstruct-load-test.mjs --target platform --n 5
 *   node scripts/reconstruct-load-test.mjs --rate 10000 --duration 600
 *   node scripts/reconstruct-load-test.mjs --rate 30000 --duration 900 --json
 *
 * Exit codes: 0 target met · 1 target missed or jobs failed · 2 bad usage ·
 * 3 credentials missing.
 */

import { inspectGlb, isValidGlbHeader } from '../api/_lib/glb-inspect.js';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const REF_BUCKET = 'three-ws-avatar-reconstructions';
const REF_PREFIX = 'eval-refs/';
const DEFAULT_ORIGIN = 'https://three.ws';

// A job that has not reached a terminal state by here is counted as stuck, not
// waited on forever. The worker's own Cloud Run request timeout is 120 s and a
// healthy job finishes in single-digit seconds, so ten minutes only trips when
// the lane is genuinely backed up.
const JOB_DEADLINE_MS = 10 * 60 * 1000;
const POLL_MS = 2000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function parseArgs(argv) {
	const opts = {
		target: 'auto',
		origin: DEFAULT_ORIGIN,
		n: null,
		ratePerDay: null,
		durationSec: 600,
		// Fraction of the arrival rate that must actually complete for the run to
		// pass. Below 1.0 on purpose: an open-loop run that lands 96% of a target
		// it held for ten minutes has proved the capacity, and demanding 100%
		// makes a single slow photo fetch fail an otherwise healthy lane.
		minCompletionRatio: 0.95,
		minSuccessRatio: 0.9,
		photos: null,
		json: false,
		help: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const next = () => argv[++i];
		switch (argv[i]) {
			case '--target': opts.target = next(); break;
			case '--origin': opts.origin = String(next()).replace(/\/+$/, ''); break;
			case '--n': opts.n = Number(next()); break;
			case '--rate': opts.ratePerDay = Number(next()); break;
			case '--duration': opts.durationSec = Number(next()); break;
			case '--min-completion': opts.minCompletionRatio = Number(next()); break;
			case '--min-success': opts.minSuccessRatio = Number(next()); break;
			case '--photos': opts.photos = String(next()).split(',').map((s) => s.trim()).filter(Boolean); break;
			case '--json': opts.json = true; break;
			case '-h': case '--help': opts.help = true; break;
			default:
				return { ...opts, error: `unknown flag: ${argv[i]}` };
		}
	}
	if (opts.n == null && opts.ratePerDay == null) opts.n = 5;
	if (opts.n != null && !(opts.n > 0)) return { ...opts, error: '--n must be a positive number' };
	if (opts.ratePerDay != null && !(opts.ratePerDay > 0)) return { ...opts, error: '--rate must be a positive number of jobs/day' };
	if (opts.ratePerDay != null && !(opts.durationSec > 0)) return { ...opts, error: '--duration must be a positive number of seconds' };
	if (!['auto', 'worker', 'platform'].includes(opts.target)) return { ...opts, error: `--target must be worker or platform` };
	return opts;
}

/**
 * Submission offsets in ms from t0.
 *
 * Burst mode returns all zeros; sustained mode spaces arrivals evenly at the
 * target rate. Even spacing rather than Poisson jitter is deliberate — this
 * measures whether the lane sustains a rate, and Poisson bunching would make
 * consecutive runs of the same configuration disagree with each other.
 */
export function arrivalOffsets({ n, ratePerDay, durationSec }) {
	if (ratePerDay) {
		const intervalMs = 86_400_000 / ratePerDay;
		const count = Math.max(1, Math.floor((durationSec * 1000) / intervalMs));
		return Array.from({ length: count }, (_, i) => Math.round(i * intervalMs));
	}
	return Array.from({ length: n }, () => 0);
}

export function percentile(values, p) {
	if (!values.length) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
	return sorted[i];
}

/** Object keys out of a GCS XML bucket listing. */
export function photoKeysFromListing(xml) {
	return [...String(xml).matchAll(/<Key>([^<]+)<\/Key>/g)]
		.map((m) => m[1])
		.filter((k) => /\.(png|jpe?g|webp)$/i.test(k));
}

/**
 * Verdict for a finished run.
 *
 * `achievedPerDay` extrapolates from jobs that actually reached a good GLB over
 * the wall clock of the run, which is the only number that means anything for
 * capacity planning: submits that 202'd and then stranded are not throughput.
 */
export function summarize(records, { targetPerDay = null, wallMs, minCompletionRatio, minSuccessRatio }) {
	const byOutcome = {};
	for (const r of records) byOutcome[r.outcome] = (byOutcome[r.outcome] || 0) + 1;
	const ok = records.filter((r) => r.outcome === 'ok');
	const latencies = ok.map((r) => r.elapsedMs);
	const terminal = records.filter((r) => r.outcome !== 'stuck' && r.outcome !== 'pending');
	const achievedPerDay = wallMs > 0 ? (ok.length / (wallMs / 86_400_000)) : 0;
	const successRatio = records.length ? ok.length / records.length : 0;
	const completionRatio = targetPerDay ? achievedPerDay / targetPerDay : null;
	const failures = [
		...new Set(records.filter((r) => r.outcome !== 'ok').map((r) => `${r.outcome}${r.note ? `: ${r.note}` : ''}`)),
	].slice(0, 8);
	return {
		submitted: records.length,
		completed: ok.length,
		terminal: terminal.length,
		byOutcome,
		p50Ms: percentile(latencies, 50),
		p95Ms: percentile(latencies, 95),
		maxMs: latencies.length ? Math.max(...latencies) : null,
		queueWaitP95Ms: percentile(ok.map((r) => r.queuedMs).filter((v) => v != null), 95),
		achievedPerDay,
		targetPerDay,
		completionRatio,
		successRatio,
		failures,
		pass:
			successRatio >= minSuccessRatio &&
			(completionRatio == null || completionRatio >= minCompletionRatio),
	};
}

/**
 * Per-instance job concurrency implied by a burst run.
 *
 * With C jobs allowed in flight per instance, a burst of N against a single
 * instance completes in ceil(N/C) waves of roughly equal latency. Counting how
 * many jobs finished inside the first job's latency window recovers C without
 * any access to the service's logs, which is what makes this usable from a
 * machine that only has the public endpoint.
 */
export function impliedConcurrency(records) {
	const ok = records.filter((r) => r.outcome === 'ok').sort((a, b) => a.finishedAt - b.finishedAt);
	if (ok.length < 2) return null;
	const first = ok[0];
	const window = first.elapsedMs * 1.25;
	return ok.filter((r) => r.finishedAt - first.startedAt <= window).length;
}

// ── photo corpus ─────────────────────────────────────────────────────────────

async function listReferencePhotos() {
	const res = await fetch(
		`https://storage.googleapis.com/${REF_BUCKET}?list-type=2&prefix=${encodeURIComponent(REF_PREFIX)}&max-keys=100`,
	);
	if (!res.ok) throw new Error(`could not list reference photos (HTTP ${res.status})`);
	const keys = photoKeysFromListing(await res.text());
	if (!keys.length) throw new Error('reference photo bucket returned no images');
	return keys.map((k) => `https://storage.googleapis.com/${REF_BUCKET}/${k}`);
}

// ── drivers ──────────────────────────────────────────────────────────────────

/** Straight at the Cloud Run worker: the contract in workers/avatar-reconstruction. */
function workerDriver({ url, key }) {
	const auth = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };
	return {
		name: `worker ${url}`,
		async submit({ photo, jobId }) {
			const res = await fetch(`${url}/reconstruct`, {
				method: 'POST',
				headers: auth,
				body: JSON.stringify({ images: [photo], job_id: jobId, body_type: 'neutral' }),
			});
			const body = await res.json().catch(() => ({}));
			if (!res.ok) {
				const err = new Error(String(body.detail || body.error || `HTTP ${res.status}`));
				err.status = res.status;
				throw err;
			}
			return { ref: body.job_id || jobId };
		},
		async poll(ref) {
			const res = await fetch(`${url}/jobs/${encodeURIComponent(ref)}`, { headers: auth });
			if (res.status === 404) return { status: 'queued' };
			if (!res.ok) return { status: 'unknown' };
			const body = await res.json().catch(() => ({}));
			return { status: body.status, glbUrl: body.glb_url || null, error: body.error || null };
		},
	};
}

/** Through the product: sign in, submit, poll the same endpoints the site calls. */
async function platformDriver({ origin, email, password }) {
	const res = await fetch(`${origin}/api/auth/login`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ email, password }),
	});
	if (!res.ok) {
		const body = await res.text().catch(() => '');
		throw new Error(`login failed (HTTP ${res.status}) ${body.slice(0, 160)}`);
	}
	const cookie = (res.headers.getSetCookie?.() || [])
		.map((c) => c.split(';')[0])
		.join('; ');
	if (!cookie) throw new Error('login returned no session cookie');
	const headers = { cookie, 'content-type': 'application/json' };
	return {
		name: `platform ${origin}`,
		async submit({ photo, jobId }) {
			const r = await fetch(`${origin}/api/avatars/reconstruct`, {
				method: 'POST',
				headers,
				body: JSON.stringify({ name: `capacity ${jobId}`, photos: [photo], visibility: 'private' }),
			});
			const body = await r.json().catch(() => ({}));
			if (!r.ok) {
				const err = new Error(String(body.message || body.error || `HTTP ${r.status}`));
				err.status = r.status;
				throw err;
			}
			return { ref: body.jobId, provider: body.provider || null };
		},
		async poll(ref) {
			const r = await fetch(`${origin}/api/avatars/regenerate-status?jobId=${encodeURIComponent(ref)}`, { headers });
			if (!r.ok) return { status: 'unknown' };
			const body = await r.json().catch(() => ({}));
			// The platform status payload is camelCase (resultGlbUrl), the worker's
			// is snake_case (glb_url). Reading only one of them makes every job
			// look stuck forever while it is quietly finishing.
			return {
				status: body.status,
				glbUrl: body.resultGlbUrl || body.result_glb_url || null,
				error: body.error || body.error_description || null,
			};
		},
	};
}

async function resolveDriver(opts) {
	const workerUrl = process.env.GCP_RECONSTRUCTION_URL;
	const workerKey = process.env.GCP_RECONSTRUCTION_KEY;
	const email = process.env.RECON_LOAD_EMAIL || process.env.AUDIT_EMAIL;
	const password = process.env.RECON_LOAD_PASSWORD || process.env.AUDIT_PASSWORD;
	const wantWorker = opts.target === 'worker' || (opts.target === 'auto' && workerUrl && workerKey);

	if (wantWorker) {
		if (!workerUrl || !workerKey) {
			throw Object.assign(
				new Error(
					'worker mode needs GCP_RECONSTRUCTION_URL and GCP_RECONSTRUCTION_KEY (both live on the three-ws-api Cloud Run service and in .env)',
				),
				{ exitCode: 3 },
			);
		}
		return workerDriver({ url: workerUrl.replace(/\/+$/, ''), key: workerKey });
	}
	if (!email || !password) {
		throw Object.assign(
			new Error(
				'platform mode needs RECON_LOAD_EMAIL / RECON_LOAD_PASSWORD (or AUDIT_EMAIL / AUDIT_PASSWORD) for a real account on the target origin',
			),
			{ exitCode: 3 },
		);
	}
	return platformDriver({ origin: opts.origin, email, password });
}

// ── run ──────────────────────────────────────────────────────────────────────

async function runJob(driver, { photo, index, stamp }) {
	const jobId = `loadtest-${stamp}-${index}`;
	const rec = {
		index,
		photo: photo.split('/').pop(),
		provider: null,
		outcome: 'pending',
		startedAt: Date.now(),
		finishedAt: null,
		elapsedMs: null,
		queuedMs: null,
		meshes: null,
		note: '',
	};
	let ref;
	try {
		const submitted = await driver.submit({ photo, jobId });
		ref = submitted.ref;
		rec.provider = submitted.provider ?? null;
		if (!ref) {
			rec.outcome = 'no_job_id';
			rec.finishedAt = Date.now();
			rec.elapsedMs = rec.finishedAt - rec.startedAt;
			return rec;
		}
	} catch (err) {
		rec.outcome = err?.status === 429 ? 'rate_limited' : 'submit_failed';
		rec.note = String(err?.message || err).slice(0, 140);
		rec.finishedAt = Date.now();
		rec.elapsedMs = rec.finishedAt - rec.startedAt;
		return rec;
	}

	const deadline = rec.startedAt + JOB_DEADLINE_MS;
	let lastStatus = 'queued';
	while (Date.now() < deadline) {
		await sleep(POLL_MS);
		let update;
		try {
			update = await driver.poll(ref);
		} catch {
			continue;
		}
		if (update.status && update.status !== 'unknown') {
			// The first observation of a non-queued state is the closest thing to a
			// queue-wait measurement available from outside: it is when the worker
			// took the job off the semaphore.
			if (rec.queuedMs == null && update.status !== 'queued') rec.queuedMs = Date.now() - rec.startedAt;
			lastStatus = update.status;
		}
		if (update.status === 'done' && update.glbUrl) {
			rec.finishedAt = Date.now();
			rec.elapsedMs = rec.finishedAt - rec.startedAt;
			await verifyGlb(rec, update.glbUrl);
			return rec;
		}
		if (update.status === 'failed' || update.status === 'error') {
			rec.outcome = 'failed';
			rec.note = String(update.error || 'reconstruction failed').slice(0, 140);
			rec.finishedAt = Date.now();
			rec.elapsedMs = rec.finishedAt - rec.startedAt;
			return rec;
		}
	}
	rec.outcome = 'stuck';
	rec.note = `never left "${lastStatus}" inside ${Math.round(JOB_DEADLINE_MS / 1000)}s`;
	rec.finishedAt = Date.now();
	rec.elapsedMs = rec.finishedAt - rec.startedAt;
	return rec;
}

/**
 * A done job only counts once its GLB parses with geometry. A lane that returns
 * 200 and an empty file is a failure that a status-only test reports as success.
 */
async function verifyGlb(rec, glbUrl) {
	try {
		const res = await fetch(glbUrl);
		if (!res.ok) {
			rec.outcome = 'glb_unreachable';
			rec.note = `GLB fetch HTTP ${res.status}`;
			return;
		}
		const buf = Buffer.from(await res.arrayBuffer());
		if (!isValidGlbHeader(buf)) {
			rec.outcome = 'bad_glb';
			rec.note = `not a GLB (${buf.length} bytes)`;
			return;
		}
		const info = inspectGlb(buf);
		rec.meshes = info?.meshCount ?? null;
		rec.outcome = info && info.meshCount > 0 ? 'ok' : 'glb_no_geometry';
	} catch (err) {
		rec.outcome = 'glb_unreachable';
		rec.note = String(err?.message || err).slice(0, 140);
	}
}

const secs = (ms) => (ms == null ? 'n/a' : `${(ms / 1000).toFixed(1)}s`);

function printHelp() {
	console.log(`reconstruct-load-test — throughput proof for the selfie→avatar lane

  --target worker|platform   where to submit (default: worker when
                             GCP_RECONSTRUCTION_URL + GCP_RECONSTRUCTION_KEY are
                             set, else platform)
  --origin <url>             platform origin (default ${DEFAULT_ORIGIN})
  --n <count>                burst mode: submit count jobs at once (default 5)
  --rate <jobs/day>          sustained mode: hold this arrival rate
  --duration <seconds>       sustained mode run length (default 600)
  --min-completion <ratio>   pass threshold vs --rate (default 0.95)
  --min-success <ratio>      pass threshold on job success (default 0.9)
  --photos <urls>            comma-separated photo URLs (default: the published
                             eval-refs reference faces)
  --json                     machine-readable summary
`);
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	if (opts.help) return printHelp(), 0;
	if (opts.error) {
		console.error(opts.error);
		return 2;
	}

	let driver;
	try {
		driver = await resolveDriver(opts);
	} catch (err) {
		console.error(String(err?.message || err));
		return err?.exitCode || 3;
	}

	const photos = opts.photos?.length ? opts.photos : await listReferencePhotos();
	const offsets = arrivalOffsets(opts);
	const stamp = String(process.hrtime.bigint()).slice(-8);
	const mode = opts.ratePerDay
		? `sustained ${opts.ratePerDay}/day for ${opts.durationSec}s (${offsets.length} jobs, one every ${(86_400 / opts.ratePerDay).toFixed(1)}s)`
		: `burst of ${offsets.length}`;
	if (!opts.json) {
		console.log(`[reconstruct-load] ${mode} against ${driver.name}`);
		console.log(`[reconstruct-load] ${photos.length} reference faces, one per job (round robin)`);
	}

	const t0 = Date.now();
	const records = await Promise.all(
		offsets.map(async (offset, index) => {
			if (offset > 0) await sleep(offset);
			return runJob(driver, { photo: photos[index % photos.length], index, stamp });
		}),
	);
	const wallMs = Date.now() - t0;

	const summary = summarize(records, {
		targetPerDay: opts.ratePerDay,
		wallMs,
		minCompletionRatio: opts.minCompletionRatio,
		minSuccessRatio: opts.minSuccessRatio,
	});
	const concurrency = opts.ratePerDay ? null : impliedConcurrency(records);

	if (opts.json) {
		console.log(JSON.stringify({ mode, driver: driver.name, wallMs, summary, concurrency, records }, null, 2));
		return summary.pass ? 0 : 1;
	}

	console.log('\nidx photo                                   outcome        elapsed  queued  meshes note');
	for (const r of records.sort((a, b) => a.index - b.index)) {
		console.log(
			[
				String(r.index).padEnd(3),
				String(r.photo).slice(0, 38).padEnd(38),
				String(r.outcome).padEnd(14),
				secs(r.elapsedMs).padStart(7),
				secs(r.queuedMs).padStart(7),
				String(r.meshes ?? '-').padStart(6),
				r.note ? ` ${r.note}` : '',
			].join(' '),
		);
	}

	console.log(`\noutcomes: ${JSON.stringify(summary.byOutcome)}`);
	console.log(`latency: p50=${secs(summary.p50Ms)} p95=${secs(summary.p95Ms)} max=${secs(summary.maxMs)}`);
	console.log(`queue wait p95: ${secs(summary.queueWaitP95Ms)}`);
	if (concurrency) {
		console.log(`implied per-instance job concurrency: ${concurrency} (jobs finished inside the first job's latency)`);
	}
	console.log(
		`throughput: ${summary.completed} verified GLBs in ${secs(wallMs)} = ${Math.round(summary.achievedPerDay).toLocaleString('en-US')}/day` +
			(summary.targetPerDay ? ` against a ${summary.targetPerDay.toLocaleString('en-US')}/day target (${(summary.completionRatio * 100).toFixed(0)}%)` : ''),
	);
	if (summary.failures.length) console.log(`failures: ${summary.failures.join(' | ')}`);
	console.log(summary.pass ? 'PASS' : 'FAIL');
	return summary.pass ? 0 : 1;
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
	process.exit(await main());
}
