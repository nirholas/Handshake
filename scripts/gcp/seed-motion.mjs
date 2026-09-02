#!/usr/bin/env node
/**
 * Bulk text-to-motion seeding for the animation library.
 *
 * Generates one clip per entry in data/motion-prompts.json through the
 * self-hosted GPU lane (workers/model-text2motion behind POST /api/forge-motion),
 * puts every result through the deterministic quality gate
 * (api/_lib/motion-quality.js), stages the keepers, and publishes them to the
 * generated half of the library manifest.
 *
 * The run is resumable and idempotent. A checkpoint records the verdict for
 * every prompt id, so re-running picks up where the last run stopped and never
 * re-spends GPU time on a prompt that already produced a keeper. Rejects are
 * kept too, with the full metric set, because tuning the gate off real failures
 * is the only way the thresholds stay honest.
 *
 *   node scripts/gcp/seed-motion.mjs                       # whole library, resume
 *   node scripts/gcp/seed-motion.mjs --limit=12            # smoke batch
 *   node scripts/gcp/seed-motion.mjs --categories=idle,emote
 *   node scripts/gcp/seed-motion.mjs --concurrency=4
 *   node scripts/gcp/seed-motion.mjs --retry-rejects       # re-roll past rejects
 *   node scripts/gcp/seed-motion.mjs --publish             # upload + manifest
 *   node scripts/gcp/seed-motion.mjs --report              # checkpoint stats only
 *
 * SPEND SAFETY. Every job is submitted with no backend named, so the platform's
 * own free-first resolver picks the lane. Before a clip is accepted the run
 * decodes the provider's job envelope and asserts the work actually ran on a
 * self-hosted Cloud Run GPU service. If a job ever comes back from a paid
 * third-party lane the batch aborts immediately rather than quietly billing a
 * few hundred generations to someone else's API.
 *
 * PUBLISHING. --publish needs the R2 credentials the production API uses
 * (S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_BUCKET,
 * S3_PUBLIC_DOMAIN). Clips go to animations/library/generated/clips/ and the
 * generated manifest is rebuilt from the staged keepers. That manifest is a
 * different object from the Mixamo one on purpose: each publisher rebuilds its
 * own and would otherwise delete the other's catalog (see api/animations/library.js).
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { gateMotionClip, explainMotionGate, MOTION_GATE_VERSION } from '../../api/_lib/motion-quality.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');

const args = Object.fromEntries(
	process.argv.slice(2).map((a) => {
		const m = a.match(/^--([^=]+)(?:=(.*))?$/);
		return m ? [m[1], m[2] ?? true] : [a, true];
	}),
);

const ORIGIN = String(args.origin || process.env.SEED_ORIGIN || 'https://three.ws').replace(/\/+$/, '');
const OUT_DIR = resolve(ROOT, String(args.out || 'animation-sources/.motion-clips'));
const CLIPS_DIR = join(OUT_DIR, 'clips');
const REJECTS_DIR = join(OUT_DIR, 'rejected');
const CHECKPOINT = join(OUT_DIR, 'checkpoint.json');
const PROMPTS_PATH = join(ROOT, 'data/motion-prompts.json');

const LIMIT = args.limit ? Number(args.limit) : Infinity;
const CONCURRENCY = Math.max(1, Math.min(Number(args.concurrency) || 3, 8));
const CATEGORIES = typeof args.categories === 'string' ? args.categories.split(',').map((s) => s.trim()) : null;
const RETRY_REJECTS = !!args['retry-rejects'];
const PUBLISH = !!args.publish;
const REPORT_ONLY = !!args.report;

const R2_PREFIX = 'animations/library/generated';
const CLIP_NAME_PREFIX = 'gen-';

// Poll budget per job. The lane answers a 4 s clip in 15-40 s warm and pays a
// cold start on the first job of an idle hour (the keepwarm cron only holds it
// open during peak), so the ceiling is generous and the interval is short
// enough that a warm lane is not left waiting on a sleep.
const POLL_INTERVAL_MS = 4_000;
const POLL_BUDGET_MS = 5 * 60_000;
const SUBMIT_TIMEOUT_MS = 30_000;
// How long a bulk run will sit out the endpoint's per-IP hourly ceiling before
// giving up and leaving the rest for the next resume. Default is one full window.
const MAX_WAIT_SECONDS = Number(args['max-wait']) || 3900;

// A job envelope must name one of these hosts. Anything else is a paid
// third-party lane and aborts the batch (see SPEND SAFETY above).
const SELF_HOSTED_HOST_RE = /(^|\.)run\.app$/i;

function log(...parts) {
	console.log(...parts);
}

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

function ensureDirs() {
	for (const d of [OUT_DIR, CLIPS_DIR, REJECTS_DIR]) mkdirSync(d, { recursive: true });
}

function loadCheckpoint() {
	if (!existsSync(CHECKPOINT)) return { version: MOTION_GATE_VERSION, prompts: {} };
	try {
		const parsed = JSON.parse(readFileSync(CHECKPOINT, 'utf8'));
		return { version: parsed.version || MOTION_GATE_VERSION, prompts: parsed.prompts || {} };
	} catch {
		// A truncated checkpoint (killed mid-write) must not strand the catalog.
		// Losing it costs re-generation, not correctness, since every accepted
		// clip is also on disk and re-derived below.
		log('  checkpoint unreadable, starting a fresh one');
		return { version: MOTION_GATE_VERSION, prompts: {} };
	}
}

function saveCheckpoint(state) {
	writeFileSync(CHECKPOINT, JSON.stringify(state, null, 2));
}

function loadPrompts() {
	const data = JSON.parse(readFileSync(PROMPTS_PATH, 'utf8'));
	const defaults = data.defaults || {};
	const all = Array.isArray(data.prompts) ? data.prompts : [];
	return all.map((p) => ({
		...p,
		duration_seconds: Number(p.duration_seconds) || Number(defaults.duration_seconds) || 4,
		fps: Number(p.fps) || Number(defaults.fps) || 30,
	}));
}

/**
 * Decode the provider's job envelope (base64url JSON, packJobId in
 * api/_providers/gcp.js) far enough to name the host that ran the work.
 * An envelope we cannot read is treated as unknown, which aborts the batch:
 * "I could not tell which lane billed this" is not a reason to keep spending.
 */
function laneFromJobId(jobId) {
	try {
		const json = JSON.parse(Buffer.from(String(jobId), 'base64url').toString('utf8'));
		const host = new URL(json.baseUrl).hostname;
		return { host, mode: json.mode || null };
	} catch {
		return { host: null, mode: null };
	}
}

class PaidLaneError extends Error {}

/**
 * Submit one generation, waiting out the endpoint's per-IP hourly ceiling when
 * it is hit. A bulk run is exactly the caller that ceiling exists to pace, so
 * the honest response to a 429 is to wait the window out, not to hammer it or
 * to record hundreds of fake failures. `--max-wait` caps how long the run is
 * willing to sit still; past that the prompt is left undecided for the next
 * resume.
 */
async function submitJob(prompt) {
	for (let attempt = 0; ; attempt++) {
		const res = await fetch(`${ORIGIN}/api/forge-motion`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				prompt: prompt.prompt,
				duration_seconds: prompt.duration_seconds,
				fps: prompt.fps,
			}),
			signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
		});
		const data = await res.json().catch(() => ({}));
		if (res.status === 429) {
			const retryAfter = Number(data.retry_after) || Number(res.headers.get('retry-after')) || 60;
			if (attempt > 0 || retryAfter > MAX_WAIT_SECONDS) {
				throw new Error(
					`rate limited for another ${retryAfter}s (--max-wait is ${MAX_WAIT_SECONDS}s); resume this run later`,
				);
			}
			log(`  wait   ${prompt.id.padEnd(28)} rate limited, sleeping ${retryAfter}s`);
			await sleep((retryAfter + 5) * 1000);
			continue;
		}
		if (res.status === 503) throw new Error(`text-to-motion is unconfigured on ${ORIGIN}: ${data.message || ''}`);
		if (!res.ok || !data.job_id) throw new Error(`submit ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
		return finishSubmit(data);
	}
}

function finishSubmit(data) {
	const lane = laneFromJobId(data.job_id);
	if (!lane.host || !SELF_HOSTED_HOST_RE.test(lane.host)) {
		throw new PaidLaneError(
			`job ran on ${lane.host || 'an unidentifiable lane'}, which is not a self-hosted Cloud Run GPU service`,
		);
	}
	return { jobId: data.job_id, lane: lane.host };
}

async function awaitClip(jobId) {
	const deadline = Date.now() + POLL_BUDGET_MS;
	while (Date.now() < deadline) {
		await sleep(POLL_INTERVAL_MS);
		const res = await fetch(`${ORIGIN}/api/forge-motion?job=${encodeURIComponent(jobId)}`, {
			signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
		});
		const data = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(`poll ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
		if (data.error) throw new Error(`worker: ${data.error}`);
		if (data.clip_url) return data.clip_url;
		if (data.status === 'failed') throw new Error('worker reported failed with no error text');
	}
	throw new Error(`no clip after ${Math.round(POLL_BUDGET_MS / 1000)}s`);
}

async function fetchClip(url) {
	const res = await fetch(url, { signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS) });
	if (!res.ok) throw new Error(`clip fetch ${res.status}`);
	return res.json();
}

function clipName(prompt, body) {
	const hash = createHash('sha1').update(body).digest('hex').slice(0, 12);
	return `${CLIP_NAME_PREFIX}${prompt.id}-${hash}`;
}

/**
 * Run one prompt end to end. Returns the checkpoint record; never throws for a
 * quality reject (that is a result), only for infrastructure faults and for the
 * paid-lane abort, which the caller re-raises.
 */
async function runPrompt(prompt) {
	const started = Date.now();
	const { jobId, lane } = await submitJob(prompt);
	const clipUrl = await awaitClip(jobId);
	const raw = await fetchClip(clipUrl);
	const elapsedSeconds = Math.round((Date.now() - started) / 1000);

	const verdict = gateMotionClip(raw, {
		loop: prompt.loop === true,
		requestedDuration: prompt.duration_seconds,
	});

	// The clip is renamed to its library identity before it is written, so the
	// staged file, the manifest entry and the published object always agree.
	const body = JSON.stringify({ ...raw, name: 'pending' });
	const name = clipName(prompt, body);
	const clip = { ...raw, name };
	const serialized = JSON.stringify(clip);

	const record = {
		prompt_id: prompt.id,
		label: prompt.label,
		category: prompt.category,
		icon: prompt.icon || '🎬',
		loop: prompt.loop === true,
		name,
		lane,
		clip_source_url: clipUrl,
		elapsed_seconds: elapsedSeconds,
		gate_version: verdict.gateVersion,
		status: verdict.pass ? 'accepted' : 'rejected',
		reasons: verdict.reasons,
		detail: verdict.detail || '',
		metrics: verdict.metrics,
		decided_at: new Date().toISOString(),
	};

	if (verdict.pass) {
		writeFileSync(join(CLIPS_DIR, `${name}.json`), serialized);
		record.bytes = Buffer.byteLength(serialized);
	} else {
		writeFileSync(
			join(REJECTS_DIR, `${name}.json`),
			JSON.stringify({ record, explanations: explainMotionGate(verdict.reasons), clip }, null, 1),
		);
	}
	return record;
}

function shouldRun(record) {
	if (!record) return true;
	if (record.status === 'accepted') return false;
	if (record.status === 'rejected') return RETRY_REJECTS;
	return true; // a prior infrastructure error is always worth retrying
}

// ── Reporting ────────────────────────────────────────────────────────────────

function report(state) {
	const records = Object.values(state.prompts);
	const accepted = records.filter((r) => r.status === 'accepted');
	const rejected = records.filter((r) => r.status === 'rejected');
	const errored = records.filter((r) => r.status === 'error');
	const decided = accepted.length + rejected.length;

	log('');
	log('── Batch result ───────────────────────────────────────────');
	log(`  prompts attempted : ${records.length}`);
	log(`  accepted          : ${accepted.length}`);
	log(`  rejected          : ${rejected.length}`);
	log(`  infra errors      : ${errored.length}`);
	log(`  accept rate       : ${decided ? ((accepted.length / decided) * 100).toFixed(1) : '0.0'}%  (of gated clips)`);

	const gpuSeconds = records.reduce((s, r) => s + (Number(r.elapsed_seconds) || 0), 0);
	log(`  lane seconds      : ${gpuSeconds} (${(gpuSeconds / 60).toFixed(1)} min of GPU wall time)`);
	if (accepted.length) {
		log(`  seconds/accepted  : ${(gpuSeconds / accepted.length).toFixed(1)}`);
	}

	if (rejected.length) {
		/** @type {Record<string, number>} */
		const tally = {};
		for (const r of rejected) for (const reason of r.reasons || []) tally[reason] = (tally[reason] || 0) + 1;
		log('  reject reasons    :');
		for (const [reason, n] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
			log(`      ${String(n).padStart(4)}  ${reason}  (${explainMotionGate([reason])[0]})`);
		}
	}
	if (errored.length) {
		log('  infra errors      :');
		for (const r of errored.slice(0, 8)) log(`      ${r.prompt_id}: ${r.detail}`);
	}
	log('');
	return { accepted: accepted.length, rejected: rejected.length, errored: errored.length, gpuSeconds };
}

// ── Publish ──────────────────────────────────────────────────────────────────

function stagedManifestEntries(state, publicDomain) {
	const entries = [];
	for (const record of Object.values(state.prompts)) {
		if (record.status !== 'accepted') continue;
		const file = join(CLIPS_DIR, `${record.name}.json`);
		if (!existsSync(file)) continue;
		entries.push({
			name: record.name,
			label: record.label,
			icon: record.icon || '🎬',
			loop: record.loop === true,
			duration: record.metrics?.duration ?? 0,
			bytes: record.bytes ?? Buffer.byteLength(readFileSync(file)),
			url: `${publicDomain}/${R2_PREFIX}/clips/${record.name}.json`,
			category: record.category,
			source: 'generated',
		});
	}
	return entries.sort((a, b) => a.name.localeCompare(b.name));
}

async function publish(state) {
	const endpoint =
		process.env.S3_ENDPOINT ||
		(process.env.R2_ACCOUNT_ID ? `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : null);
	const accessKeyId = process.env.S3_ACCESS_KEY_ID || process.env.R2_ACCESS_KEY_ID;
	const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY || process.env.R2_SECRET_ACCESS_KEY;
	const bucket = process.env.S3_BUCKET || process.env.R2_BUCKET;
	const publicDomain = (process.env.S3_PUBLIC_DOMAIN || '').replace(/\/+$/, '');

	if (!endpoint || !accessKeyId || !secretAccessKey || !bucket || !publicDomain) {
		log('  publish skipped: storage credentials are not set in this environment.');
		log('  Needs S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_BUCKET, S3_PUBLIC_DOMAIN');
		log('  (they live on the three-ws-api Cloud Run service, not in the repo).');
		return { published: 0 };
	}

	const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
	const client = new S3Client({ region: 'auto', endpoint, credentials: { accessKeyId, secretAccessKey } });
	const entries = stagedManifestEntries(state, publicDomain);

	let uploaded = 0;
	for (const entry of entries) {
		const body = readFileSync(join(CLIPS_DIR, `${entry.name}.json`));
		await client.send(
			new PutObjectCommand({
				Bucket: bucket,
				Key: `${R2_PREFIX}/clips/${entry.name}.json`,
				Body: body,
				ContentType: 'application/json',
				CacheControl: 'public, max-age=31536000, immutable',
			}),
		);
		uploaded++;
		if (uploaded % 20 === 0) log(`  uploaded ${uploaded}/${entries.length}`);
	}

	await client.send(
		new PutObjectCommand({
			Bucket: bucket,
			Key: `${R2_PREFIX}/manifest.json`,
			Body: JSON.stringify({ generated_at: new Date().toISOString(), clips: entries }),
			ContentType: 'application/json',
			CacheControl: 'public, max-age=60',
		}),
	);
	log(`  ${R2_PREFIX}/manifest.json → ${entries.length} generated clips live via /api/animations/library`);
	return { published: entries.length };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
	ensureDirs();
	const state = loadCheckpoint();

	if (REPORT_ONLY) {
		report(state);
		return;
	}

	if (PUBLISH && Object.values(state.prompts).every((r) => r.status !== 'accepted')) {
		log('Nothing staged to publish. Run a generation batch first.');
		return;
	}

	if (!PUBLISH || args.limit || args.categories) {
		let prompts = loadPrompts();
		if (CATEGORIES) prompts = prompts.filter((p) => CATEGORIES.includes(p.category));
		const queue = prompts.filter((p) => shouldRun(state.prompts[p.id])).slice(0, LIMIT);

		log(`Seeding motion from ${PROMPTS_PATH.replace(`${ROOT}/`, '')}`);
		log(`  origin      ${ORIGIN}`);
		log(`  queue       ${queue.length} prompt(s) of ${prompts.length} (${Object.keys(state.prompts).length} already decided)`);
		log(`  concurrency ${CONCURRENCY}`);
		log(`  staging     ${OUT_DIR.replace(`${ROOT}/`, '')}`);
		log('');

		let index = 0;
		let aborted = null;
		const worker = async () => {
			while (index < queue.length && !aborted) {
				const prompt = queue[index++];
				try {
					const record = await runPrompt(prompt);
					state.prompts[prompt.id] = record;
					const mark = record.status === 'accepted' ? 'keep  ' : 'reject';
					const why = record.status === 'accepted' ? '' : `  ${record.reasons.join(',')}`;
					log(`  ${mark} ${prompt.id.padEnd(28)} ${String(record.elapsed_seconds).padStart(3)}s${why}`);
				} catch (err) {
					if (err instanceof PaidLaneError) {
						aborted = err;
						break;
					}
					state.prompts[prompt.id] = {
						prompt_id: prompt.id,
						status: 'error',
						detail: err?.message || String(err),
						decided_at: new Date().toISOString(),
					};
					log(`  error  ${prompt.id.padEnd(28)} ${err?.message || err}`);
				}
				saveCheckpoint(state);
			}
		};
		await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
		saveCheckpoint(state);

		if (aborted) {
			report(state);
			console.error(`\nABORTED: ${aborted.message}`);
			console.error('No bulk generation may run on a paid third-party lane. Fix the lane resolution and re-run.');
			process.exitCode = 3;
			return;
		}
	}

	const stats = report(state);
	if (PUBLISH) await publish(state);

	// A batch that gated nothing at all is an infrastructure failure dressed up
	// as a clean run, so it exits non-zero rather than reporting "0 accepted".
	if (stats.accepted === 0 && stats.rejected === 0) process.exitCode = 4;
}

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
