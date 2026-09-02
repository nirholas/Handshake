#!/usr/bin/env node
/**
 * Bulk avatar catalog seeding on the self-hosted GPU fleet.
 *
 * Generates avatars from api/_lib/seed-prompts.js through the platform's own
 * free-first lane, puts every result through the FULL catalog quality gate
 * (api/_lib/seed-quality.js: mesh sanity AND the vision judge), and reports
 * the accept rate and the lane time each accepted asset cost.
 *
 * WHY THIS EXISTS ALONGSIDE THE CRON. api/cron/forge-seed-cron.js already
 * trickles avatars into the catalog, but it runs inside a 70 s function wall
 * and therefore ships with SEED_CRON_VISION off: only the deterministic mesh
 * stage of the gate runs there. That is why the catalog's recorded reject rate
 * is a fraction of a percent, not because generation is nearly perfect, but
 * because the judge that would catch a headless torso or a fused-limb blob has
 * never been in the path. This runner has no function wall, so it runs both
 * stages, and its accept rate is the first honest number the catalog has had.
 *
 *   node scripts/gcp/seed-avatars.mjs --limit=25            # a real batch
 *   node scripts/gcp/seed-avatars.mjs --limit=500 --concurrency=4
 *   node scripts/gcp/seed-avatars.mjs --categories=accessory
 *   node scripts/gcp/seed-avatars.mjs --no-vision           # mesh stage only
 *   node scripts/gcp/seed-avatars.mjs --report              # checkpoint stats
 *
 * RESUMABLE. Every decision is written to a checkpoint keyed by the bare prompt
 * string (the same key the cron de-duplicates on), so a re-run never re-spends
 * GPU time on a prompt that already produced a keeper, and an interrupted batch
 * resumes exactly where it stopped.
 *
 * SPEND SAFETY. Submissions name no backend, so the platform's own free-first
 * resolver picks the lane, and the backend it actually used comes back on the
 * response. Every result is checked against api/_lib/forge-tiers.js's free-lane
 * set before it is gated; the first asset produced by a paid third-party lane
 * aborts the whole batch. Bulk generation must burn Google credits on our own
 * fleet or nothing at all.
 *
 * Rejected assets are kept with the full verdict so the thresholds can be tuned
 * against real failures. With R2 credentials present they also land under the
 * forge/rejected/ prefix, exactly where the cron puts its own rejects.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SEED_PROMPTS, composeSeedPrompt } from '../../api/_lib/seed-prompts.js';
import { evaluateSeedAsset, remoteTransport } from '../../api/_lib/seed-quality.js';
import { isFreeBackend } from '../../api/_lib/forge-tiers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');

const args = Object.fromEntries(
	process.argv.slice(2).map((a) => {
		const m = a.match(/^--([^=]+)(?:=(.*))?$/);
		return m ? [m[1], m[2] ?? true] : [a, true];
	}),
);

const ORIGIN = String(args.origin || process.env.SEED_ORIGIN || 'https://three.ws').replace(/\/+$/, '');
const OUT_DIR = resolve(ROOT, String(args.out || '.seed-batches/avatars'));
const CHECKPOINT = join(OUT_DIR, 'checkpoint.json');
const REJECTS_DIR = join(OUT_DIR, 'rejected');

const LIMIT = args.limit ? Number(args.limit) : 25;
const CONCURRENCY = Math.max(1, Math.min(Number(args.concurrency) || 3, 8));
const CATEGORIES = typeof args.categories === 'string' ? args.categories.split(',').map((s) => s.trim()) : null;
const VISION = args['no-vision'] !== true;
const REPORT_ONLY = !!args.report;
const RETRY_REJECTS = !!args['retry-rejects'];

const SUBMIT_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 6_000;
const POLL_BUDGET_MS = 12 * 60_000;
// The gate renders and judges through the live platform, and a cold render
// container plus two judge calls is comfortably slower than a generation.
const GATE_TIMEOUT_MS = 180_000;

function log(...parts) {
	console.log(...parts);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class PaidLaneError extends Error {}

function loadCheckpoint() {
	if (!existsSync(CHECKPOINT)) return { prompts: {} };
	try {
		return { prompts: JSON.parse(readFileSync(CHECKPOINT, 'utf8')).prompts || {} };
	} catch {
		log('  checkpoint unreadable, starting a fresh one');
		return { prompts: {} };
	}
}

function saveCheckpoint(state) {
	writeFileSync(CHECKPOINT, JSON.stringify({ updated_at: new Date().toISOString(), ...state }, null, 2));
}

/**
 * A stable, filesystem-safe key for a prompt. The prompt string itself is the
 * identity (matching the cron's de-duplication), hashed so it can also name a
 * reject sidecar.
 */
function promptKey(prompt) {
	let h = 0;
	for (let i = 0; i < prompt.length; i++) h = (Math.imul(31, h) + prompt.charCodeAt(i)) | 0;
	return `p${(h >>> 0).toString(36)}`;
}

function freshSeed() {
	return Math.floor(Math.random() * 2 ** 31);
}

async function submitForge(entry) {
	const res = await fetch(`${ORIGIN}/api/forge`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'x-forge-client': `seed-batch-${promptKey(entry.prompt)}` },
		body: JSON.stringify({
			// The composed prompt carries the rig-readiness framing the auto-rigger
			// needs (full body, arms clear of the torso, neutral stance); the bare
			// library string stays the checkpoint key, exactly as in the cron.
			prompt: composeSeedPrompt(entry),
			tier: 'draft',
			path: 'image',
			seed: freshSeed(),
		}),
		signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
	});
	const body = await res.json().catch(() => ({}));
	if (res.status === 429) {
		const retryAfter = Number(body.retry_after) || 60;
		throw new Error(`rate limited for ${retryAfter}s; resume this run later`);
	}
	if (!res.ok) throw new Error(`forge submit ${res.status}: ${body.error_description || body.error || 'no body'}`);
	return body;
}

async function awaitMesh(submitBody) {
	// Warm self-host lanes answer inline with job_id null; the rest are polled.
	if (submitBody.status === 'done' && submitBody.glb_url) {
		return { glbUrl: submitBody.glb_url, backend: submitBody.backend || null };
	}
	const jobId = submitBody.job_id;
	if (!jobId) throw new Error('forge returned neither a finished mesh nor a job id');

	const deadline = Date.now() + POLL_BUDGET_MS;
	while (Date.now() < deadline) {
		await sleep(POLL_INTERVAL_MS);
		const res = await fetch(`${ORIGIN}/api/forge?job=${encodeURIComponent(jobId)}`, {
			signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
		});
		const body = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(`forge poll ${res.status}`);
		if (body.status === 'done' && body.glb_url) {
			return { glbUrl: body.glb_url, backend: body.backend || submitBody.backend || null };
		}
		if (body.status === 'failed' || body.error) {
			throw new Error(`lane failed: ${body.error_description || body.error || 'no detail'}`);
		}
	}
	throw new Error(`no mesh after ${Math.round(POLL_BUDGET_MS / 1000)}s`);
}

async function runPrompt(entry, transport) {
	const transportRequested = !!transport;
	const started = Date.now();
	const submitBody = await submitForge(entry);
	const { glbUrl, backend } = await awaitMesh(submitBody);

	// The one non-negotiable check: bulk seeding may never leave the credits.
	if (backend && !isFreeBackend(backend)) {
		throw new PaidLaneError(`lane "${backend}" is a paid backend, not part of the free/self-hosted set`);
	}

	const res = await fetch(glbUrl, { signal: AbortSignal.timeout(GATE_TIMEOUT_MS) });
	if (!res.ok) throw new Error(`mesh fetch ${res.status}`);
	const glbBuffer = Buffer.from(await res.arrayBuffer());

	const verdict = await evaluateSeedAsset({
		glbBuffer,
		glbUrl,
		prompt: entry.prompt,
		category: entry.category || 'avatar',
		transport,
	});
	const elapsedSeconds = Math.round((Date.now() - started) / 1000);

	// A gate that could not RUN is not a verdict. evaluateSeedAsset reports a
	// dead render or judge as vision.status 'unavailable' and leaves the vision
	// half passing, so an asset that never faced the judge would otherwise be
	// counted as a keeper on the mesh stage alone, which is precisely the
	// weakness this runner exists to remove. It is recorded as 'ungated' and
	// retried on the next resume instead.
	const visionRan = !transportRequested || verdict.vision?.status === 'judged';
	const status = !visionRan ? 'ungated' : verdict.accepted ? 'accepted' : 'rejected';

	return {
		key: promptKey(entry.prompt),
		prompt: entry.prompt,
		category: entry.category || 'avatar',
		theme: entry.theme || null,
		backend,
		glb_url: glbUrl,
		bytes: glbBuffer.length,
		elapsed_seconds: elapsedSeconds,
		status,
		reasons: verdict.reasons || [],
		detail: status === 'ungated' ? `vision gate unavailable: ${verdict.vision?.error || 'no detail'}` : '',
		mesh: verdict.mesh || null,
		vision: verdict.vision || null,
		decided_at: new Date().toISOString(),
	};
}

function shouldRun(record) {
	if (!record) return true;
	if (record.status === 'accepted') return false;
	if (record.status === 'rejected') return RETRY_REJECTS;
	// 'ungated' and 'error' both mean the run learned nothing about this prompt.
	return true;
}

function report(state) {
	const records = Object.values(state.prompts);
	const accepted = records.filter((r) => r.status === 'accepted');
	const rejected = records.filter((r) => r.status === 'rejected');
	const errored = records.filter((r) => r.status === 'error');
	const ungated = records.filter((r) => r.status === 'ungated');
	const gated = accepted.length + rejected.length;
	const laneSeconds = records.reduce((s, r) => s + (Number(r.elapsed_seconds) || 0), 0);

	log('');
	log('── Batch result ───────────────────────────────────────────');
	log(`  attempted        : ${records.length}`);
	log(`  accepted         : ${accepted.length}`);
	log(`  rejected         : ${rejected.length}`);
	log(`  infra errors     : ${errored.length}`);
	log(`  ungated          : ${ungated.length}  (vision judge unavailable, no verdict reached)`);
	log(`  accept rate      : ${gated ? ((accepted.length / gated) * 100).toFixed(1) : '0.0'}%  (of gated assets)`);
	log(`  lane seconds     : ${laneSeconds} (${(laneSeconds / 60).toFixed(1)} min)`);
	if (accepted.length) log(`  seconds/accepted : ${(laneSeconds / accepted.length).toFixed(1)}`);

	const backends = {};
	for (const r of records) if (r.backend) backends[r.backend] = (backends[r.backend] || 0) + 1;
	if (Object.keys(backends).length) {
		log(`  lanes used       : ${Object.entries(backends).map(([b, n]) => `${b}×${n}`).join(', ')}`);
	}

	if (rejected.length) {
		const tally = {};
		for (const r of rejected) for (const reason of r.reasons || []) tally[reason] = (tally[reason] || 0) + 1;
		log('  reject reasons   :');
		for (const [reason, n] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
			log(`      ${String(n).padStart(4)}  ${reason}`);
		}
	}
	if (ungated.length) {
		log(`  ungated because  : ${ungated[0].detail}`);
	}
	if (errored.length) {
		log('  infra errors     :');
		for (const r of errored.slice(0, 8)) log(`      ${r.detail}`);
	}
	log('');
	return {
		accepted: accepted.length,
		rejected: rejected.length,
		errored: errored.length,
		ungated: ungated.length,
		laneSeconds,
	};
}

async function main() {
	mkdirSync(OUT_DIR, { recursive: true });
	mkdirSync(REJECTS_DIR, { recursive: true });
	const state = loadCheckpoint();

	if (REPORT_ONLY) {
		report(state);
		return;
	}

	let pool = SEED_PROMPTS;
	if (CATEGORIES) pool = pool.filter((p) => CATEGORIES.includes(p.category));
	const queue = pool.filter((p) => shouldRun(state.prompts[promptKey(p.prompt)])).slice(0, LIMIT);

	// Render + judge run through the live platform's own HTTP surfaces, so the
	// batch enforces the identical gate from a machine with no GCP credentials.
	const transport = VISION ? remoteTransport({ origin: ORIGIN, timeoutMs: GATE_TIMEOUT_MS }) : null;

	log('Seeding the avatar catalog from api/_lib/seed-prompts.js');
	log(`  origin      ${ORIGIN}`);
	log(`  queue       ${queue.length} prompt(s) of ${pool.length} (${Object.keys(state.prompts).length} already decided)`);
	log(`  gate        mesh${VISION ? ' + vision judge (render + Vertex via /api/vision)' : ' only (--no-vision)'}`);
	log(`  concurrency ${CONCURRENCY}`);
	log('');

	let index = 0;
	let aborted = null;
	const worker = async () => {
		while (index < queue.length && !aborted) {
			const entry = queue[index++];
			const key = promptKey(entry.prompt);
			try {
				const record = await runPrompt(entry, transport);
				state.prompts[key] = record;
				if (record.status === 'rejected') {
					writeFileSync(join(REJECTS_DIR, `${key}.json`), JSON.stringify(record, null, 1));
				}
				const mark =
					record.status === 'accepted' ? 'keep  ' : record.status === 'ungated' ? 'ungate' : 'reject';
				const why = record.status === 'accepted' ? '' : `  ${record.reasons.join(',') || record.detail}`;
				log(`  ${mark} ${String(record.elapsed_seconds).padStart(3)}s  ${entry.prompt.slice(0, 52).padEnd(52)}${why}`);
			} catch (err) {
				if (err instanceof PaidLaneError) {
					aborted = err;
					break;
				}
				state.prompts[key] = {
					key,
					prompt: entry.prompt,
					status: 'error',
					detail: err?.message || String(err),
					decided_at: new Date().toISOString(),
				};
				log(`  error       ${entry.prompt.slice(0, 52).padEnd(52)}  ${err?.message || err}`);
			}
			saveCheckpoint(state);
		}
	};
	await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
	saveCheckpoint(state);

	if (aborted) {
		report(state);
		console.error(`\nABORTED: ${aborted.message}`);
		console.error('Bulk seeding must run on the free self-hosted fleet. Fix lane resolution and re-run.');
		process.exitCode = 3;
		return;
	}

	const stats = report(state);
	// Gating nothing at all is an infrastructure failure wearing a clean run's
	// clothes, so it must not exit zero.
	if (stats.accepted === 0 && stats.rejected === 0) process.exitCode = 4;
}

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
