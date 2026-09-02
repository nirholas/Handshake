#!/usr/bin/env node
// Bulk text-to-motion seeding for the animation library (work order GCP-05, B).
//
// Generates clips from data/motion-prompts.json on our own Cloud Run GPU lane,
// gates every one of them (api/_lib/motion-seed.js), publishes the keepers to
// the R2 clip library, and lists them in the marketplace under the platform
// creator with a rotating free subset.
//
// The run is resumable: every prompt's outcome is written to a checkpoint file
// as it lands, and a re-run skips anything already terminal. Killing the process
// costs at most the clips currently in flight.
//
//   # measure quality without publishing anything (no credentials needed)
//   node scripts/gcp/seed-motion.mjs --count 20 --dry-run
//
//   # real run: needs R2 + DATABASE_URL, so it runs where those live
//   node scripts/gcp/seed-motion.mjs --count 200 --concurrency 6
//
// Transport: with GCP_TEXT2MOTION_URL set the runner calls the provider in
// process, which is the only way a bulk run works. /api/forge-motion is rate
// limited per IP (it is a public endpoint), so driving a few hundred clips
// through it earns a 429 with a 49 minute retry-after after roughly the first
// two. Pass --origin to force the HTTP path anyway, which is useful for proving
// the deployed route end to end on a handful of clips.
//
// Safety: the lane is asserted per job. /api/forge-motion returns a base64url
// envelope naming the worker it dispatched to, and a job that did not land on
// our own self-hosted Cloud Run text2motion service aborts the whole run rather
// than quietly billing a paid third party for a few hundred clips.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import {
	motionPrompts,
	motionPromptLibrary,
	gateMotionClip,
	toLibraryClip,
	manifestEntryFor,
	mergeManifest,
	libraryClipName,
	freeClipNames,
	rotationEpoch,
	FREE_ROTATION,
	LIBRARY_MANIFEST_KEY,
	GENERATED_CLIP_DIR,
} from '../../api/_lib/motion-seed.js';

const REPO = resolve(dirname(new URL(import.meta.url).pathname), '../..');

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
	const out = {
		count: 25,
		concurrency: 4,
		categories: null,
		dryRun: false,
		origin: process.env.SEED_MOTION_ORIGIN || 'https://three.ws',
		checkpoint: resolve(REPO, '.seed-motion-checkpoint.json'),
		// Default to the provider directly when this process can reach it.
		transport: process.env.GCP_TEXT2MOTION_URL ? 'in-process' : 'http',
		price: 0.75,
		currency: 'USDC',
		freeSize: FREE_ROTATION.SIZE,
		pollTimeoutMs: 300_000,
		retry: 1,
	};
	for (let i = 2; i < argv.length; i += 1) {
		const arg = argv[i];
		const next = () => argv[++i];
		switch (arg) {
			case '--count': out.count = Math.max(1, Number(next()) || out.count); break;
			case '--concurrency': out.concurrency = Math.min(12, Math.max(1, Number(next()) || out.concurrency)); break;
			case '--categories': out.categories = String(next() || '').split(',').map((s) => s.trim()).filter(Boolean); break;
			case '--dry-run': out.dryRun = true; break;
			case '--origin':
				out.origin = String(next() || out.origin).replace(/\/$/, '');
				out.transport = 'http';
				break;
			case '--in-process': out.transport = 'in-process'; break;
			case '--checkpoint': out.checkpoint = resolve(String(next())); break;
			case '--price': out.price = Math.max(0, Number(next()) || 0); break;
			case '--free-size': out.freeSize = Math.max(0, Number(next()) || 0); break;
			case '--retry': out.retry = Math.max(0, Math.min(3, Number(next()) || 0)); break;
			case '--help':
				console.log('Usage: seed-motion.mjs [--count N] [--concurrency N] [--categories a,b] [--dry-run] [--in-process] [--origin URL] [--price N] [--free-size N] [--checkpoint PATH]');
				process.exit(0);
				break;
			default:
				if (arg.startsWith('--')) {
					console.error(`unknown flag: ${arg}`);
					process.exit(2);
				}
		}
	}
	return out;
}

// ── Checkpoint ──────────────────────────────────────────────────────────────

function loadCheckpoint(path) {
	if (!existsSync(path)) return { version: 1, started_at: new Date().toISOString(), results: {} };
	try {
		const parsed = JSON.parse(readFileSync(path, 'utf8'));
		if (parsed && typeof parsed.results === 'object') return parsed;
	} catch (err) {
		console.error(`[checkpoint] unreadable (${err.message}), starting a fresh one`);
	}
	return { version: 1, started_at: new Date().toISOString(), results: {} };
}

function saveCheckpoint(path, state) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(state, null, '\t')}\n`);
}

const TERMINAL = new Set(['published', 'accepted', 'rejected', 'failed']);

// ── Lane assertion ──────────────────────────────────────────────────────────

// The provider packs its job id as base64url JSON: { mode, taskId, baseUrl, ... }
// (packJobId in api/_providers/gcp.js). Reading the baseUrl back out is how a
// bulk run proves it is spending credits on our own fleet and not on a hosted
// lane that happens to be configured as a fallback.
export function decodeJobEnvelope(jobId) {
	try {
		const json = Buffer.from(String(jobId), 'base64url').toString('utf8');
		const parsed = JSON.parse(json);
		return parsed && typeof parsed === 'object' ? parsed : null;
	} catch {
		return null;
	}
}

export function assertSelfHostedLane(jobId) {
	const env = decodeJobEnvelope(jobId);
	if (!env) throw new Error('lane assertion failed: job id is not a provider envelope');
	if (env.mode !== 'text2motion') throw new Error(`lane assertion failed: mode ${env.mode}`);
	let host;
	try {
		host = new URL(env.baseUrl).host;
	} catch {
		throw new Error(`lane assertion failed: unusable baseUrl ${env.baseUrl}`);
	}
	// Our own Cloud Run services only. Anything else is a paid third party and a
	// bulk run must never reach one.
	if (!/\.run\.app$/.test(host)) {
		throw new Error(`lane assertion failed: ${host} is not a self-hosted Cloud Run lane`);
	}
	if (!/^model-text2motion/.test(host)) {
		throw new Error(`lane assertion failed: unexpected worker ${host}`);
	}
	return { host, taskId: env.taskId };
}

// ── Generation ──────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let providerPromise = null;
function motionProvider() {
	if (!providerPromise) {
		providerPromise = import('../../api/_providers/gcp.js').then(({ createRegenProvider }) => {
			const provider = createRegenProvider();
			if (!provider.supportsMode('text2motion')) {
				throw new Error('the text2motion lane is not configured: set GCP_TEXT2MOTION_URL and GCP_RECONSTRUCTION_KEY');
			}
			return provider;
		});
	}
	return providerPromise;
}

/** Submit + poll straight against the provider, with no public endpoint in between. */
async function generateInProcess(prompt, opts, duration, fps) {
	const provider = await motionProvider();
	const job = await provider.submit({
		mode: 'text2motion',
		sourceUrl: null,
		params: { prompt: prompt.prompt, duration_seconds: duration, fps },
	});
	const lane = assertSelfHostedLane(job.extJobId);

	const deadline = Date.now() + opts.pollTimeoutMs;
	let delay = 4_000;
	while (Date.now() < deadline) {
		await sleep(delay);
		delay = Math.min(delay * 1.3, 12_000);
		const state = await provider.poll(job.extJobId);
		if (state.status === 'done' || state.status === 'succeeded') {
			// The provider surfaces a finished motion job as resultClipUrl (a
			// three.js AnimationClip JSON), alongside the frame count and fps the
			// worker actually produced.
			const clipUrl = state.resultClipUrl;
			if (!clipUrl) throw new Error('worker reported done with no clip');
			const res = await fetch(clipUrl, { signal: AbortSignal.timeout(60_000) });
			if (!res.ok) throw new Error(`clip fetch failed: HTTP ${res.status}`);
			return {
				clip: await res.json(),
				lane,
				duration,
				fps: typeof state.fps === 'number' ? state.fps : fps,
				clipUrl,
			};
		}
		if (state.status === 'failed' || state.status === 'error') {
			throw new Error(`worker failed: ${state.error || 'unknown'}`);
		}
	}
	throw new Error('timed out waiting for the worker');
}

async function generateOne(prompt, opts) {
	const defaults = motionPromptLibrary().defaults ?? {};
	const duration = Number(prompt.duration_seconds) || Number(defaults.duration_seconds) || 4;
	const fps = Number(defaults.fps) || 30;

	if (opts.transport === 'in-process') return generateInProcess(prompt, opts, duration, fps);

	const started = await fetch(`${opts.origin}/api/forge-motion`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ prompt: prompt.prompt, duration_seconds: duration, fps }),
		signal: AbortSignal.timeout(60_000),
	});
	if (started.status === 429) {
		throw new Error(
			'rate limited by /api/forge-motion: run with --in-process (GCP_TEXT2MOTION_URL) for a bulk batch',
		);
	}
	if (started.status === 503) throw new Error('text2motion lane is unconfigured (GCP_TEXT2MOTION_URL)');
	if (!started.ok) throw new Error(`submit failed: HTTP ${started.status} ${(await started.text()).slice(0, 160)}`);
	const job = await started.json();
	const lane = assertSelfHostedLane(job.job_id);

	const deadline = Date.now() + opts.pollTimeoutMs;
	let delay = 4_000;
	while (Date.now() < deadline) {
		await sleep(delay);
		delay = Math.min(delay * 1.3, 12_000);
		const res = await fetch(`${opts.origin}/api/forge-motion?job=${encodeURIComponent(job.job_id)}`, {
			signal: AbortSignal.timeout(30_000),
		});
		if (!res.ok) continue;
		const state = await res.json();
		if (state.status === 'done' || state.status === 'succeeded') {
			if (!state.clip_url) throw new Error('worker reported done with no clip');
			const clipRes = await fetch(state.clip_url, { signal: AbortSignal.timeout(60_000) });
			if (!clipRes.ok) throw new Error(`clip fetch failed: HTTP ${clipRes.status}`);
			return { clip: await clipRes.json(), lane, duration, fps, clipUrl: state.clip_url };
		}
		if (state.status === 'failed' || state.status === 'error') {
			throw new Error(`worker failed: ${state.error || 'unknown'}`);
		}
	}
	throw new Error('timed out waiting for the worker');
}

// ── Publishing ──────────────────────────────────────────────────────────────

async function publishAccepted(accepted, opts) {
	const { putObject, getObjectBuffer, publicUrl, objectStorageConfigured } = await import('../../api/_lib/r2.js');
	if (!objectStorageConfigured()) {
		throw new Error('object storage is not configured: set the R2 credentials or pass --dry-run');
	}

	const entries = [];
	for (const item of accepted) {
		const body = Buffer.from(JSON.stringify(item.libraryClip));
		const key = `${GENERATED_CLIP_DIR}${item.name}.json`;
		await putObject({ key, body, contentType: 'application/json', metadata: { prompt_id: item.prompt.id } });
		entries.push(
			manifestEntryFor(item.libraryClip, {
				label: item.prompt.label,
				icon: item.prompt.icon,
				loop: item.prompt.loop,
				bytes: body.byteLength,
				url: publicUrl(key),
				thumb: null,
			}),
		);
		item.storageKey = key;
		item.bytes = body.byteLength;
	}

	let existing = [];
	try {
		const buf = await getObjectBuffer(LIBRARY_MANIFEST_KEY);
		const parsed = JSON.parse(buf.toString('utf8'));
		existing = Array.isArray(parsed) ? parsed : parsed.clips ?? [];
	} catch (err) {
		if (err?.name !== 'NoSuchKey' && err?.$metadata?.httpStatusCode !== 404) throw err;
	}
	const merged = mergeManifest(existing, entries);
	await putObject({
		key: LIBRARY_MANIFEST_KEY,
		body: Buffer.from(JSON.stringify({ generated_at: new Date().toISOString(), clips: merged })),
		contentType: 'application/json',
	});
	return { manifestTotal: merged.length, published: entries.length };
}

async function listInMarketplace(accepted, opts) {
	const { sql } = await import('../../api/_lib/db.js');
	const owner = (await sql`select id from users where username = 'three' limit 1`)[0];
	if (!owner) throw new Error('platform creator "three" not found; create it before listing');

	// The free subset is decided over the whole generated collection, not just
	// this batch, so a later batch cannot hand out a second set of free clips.
	const allNames = (
		await sql`select slug from animation_clips where format = 'three.ws.animation.v1' and slug like 'gen-%' and deleted_at is null`
	).map((r) => r.slug);
	const names = [...new Set([...allNames, ...accepted.map((a) => a.name)])];
	const free = new Set(freeClipNames(names, { size: opts.freeSize }));

	let listed = 0;
	for (const item of accepted) {
		const isFree = free.has(item.name);
		const clip = item.libraryClip;
		await sql`
			insert into animation_clips (
				owner_id, slug, name, description, kind, format, duration_ms, frame_count, fps,
				loop, storage_key, artifact_key, artifact_bytes, artifact_mime, tags, visibility,
				price_amount, price_currency, listed
			) values (
				${owner.id}, ${item.name}, ${item.prompt.label},
				${item.prompt.prompt}, 'animation', 'three.ws.animation.v1',
				${Math.round(clip.duration * 1000)}, ${item.gate.metrics.frames || 0}, ${item.fps},
				${Boolean(item.prompt.loop)}, ${item.storageKey}, ${item.storageKey}, ${item.bytes},
				'application/json', ${item.prompt.tags ?? []}, 'public',
				${isFree ? 0 : opts.price}, ${opts.currency}, true
			)
			on conflict (slug) do update set
				name = excluded.name,
				description = excluded.description,
				duration_ms = excluded.duration_ms,
				frame_count = excluded.frame_count,
				storage_key = excluded.storage_key,
				artifact_key = excluded.artifact_key,
				artifact_bytes = excluded.artifact_bytes,
				price_amount = excluded.price_amount,
				listed = true,
				updated_at = now()
		`;
		listed += 1;
	}
	return { listed, freeCount: [...free].length, epoch: rotationEpoch() };
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
	const opts = parseArgs(process.argv);
	const state = loadCheckpoint(opts.checkpoint);

	let pool = motionPrompts();
	if (opts.categories) pool = pool.filter((p) => opts.categories.includes(p.category));
	const todo = pool.filter((p) => !TERMINAL.has(state.results[p.id]?.status)).slice(0, opts.count);

	if (todo.length === 0) {
		console.log('nothing to do: every selected prompt is already terminal in the checkpoint');
		return;
	}

	const via = opts.transport === 'in-process' ? 'the provider in process' : opts.origin;
	console.log(
		`seeding ${todo.length} clips via ${via} (concurrency ${opts.concurrency}, ${opts.dryRun ? 'DRY RUN, nothing published' : 'publishing'})`,
	);

	const accepted = [];
	const rejected = [];
	const failed = [];
	let aborted = null;
	let cursor = 0;

	const worker = async () => {
		while (cursor < todo.length && !aborted) {
			const prompt = todo[cursor++];
			let lastErr = null;
			for (let attempt = 0; attempt <= opts.retry && !aborted; attempt += 1) {
				try {
					const out = await generateOne(prompt, opts);
					const gate = gateMotionClip(out.clip, { expectedDuration: out.duration, loop: prompt.loop });
					const name = libraryClipName(prompt.id, out.lane.taskId);
					const record = {
						status: gate.ok ? 'accepted' : 'rejected',
						name,
						task_id: out.lane.taskId,
						lane: out.lane.host,
						reasons: gate.reasons,
						metrics: gate.metrics,
						at: new Date().toISOString(),
					};
					state.results[prompt.id] = record;
					saveCheckpoint(opts.checkpoint, state);
					if (gate.ok) {
						accepted.push({
							prompt,
							name,
							fps: out.fps,
							gate,
							libraryClip: toLibraryClip(out.clip, {
								name,
								promptId: prompt.id,
								prompt: prompt.prompt,
								category: prompt.category,
								loop: prompt.loop,
								taskId: out.lane.taskId,
							}),
						});
						console.log(`  accept  ${prompt.id}`);
					} else {
						rejected.push({ prompt, reasons: gate.reasons, metrics: gate.metrics });
						console.log(`  reject  ${prompt.id}  ${gate.reasons.join(',')}`);
					}
					lastErr = null;
					break;
				} catch (err) {
					lastErr = err;
					if (/lane assertion failed/.test(err.message)) {
						aborted = err;
						break;
					}
				}
			}
			if (lastErr && !aborted) {
				failed.push({ prompt, error: lastErr.message });
				state.results[prompt.id] = { status: 'failed', error: lastErr.message, at: new Date().toISOString() };
				saveCheckpoint(opts.checkpoint, state);
				console.log(`  fail    ${prompt.id}  ${lastErr.message}`);
			}
		}
	};

	await Promise.all(Array.from({ length: Math.min(opts.concurrency, todo.length) }, worker));

	if (aborted) {
		console.error(`\nABORTED: ${aborted.message}`);
		console.error('No bulk generation may run on a lane that is not our own. Nothing was published.');
		process.exitCode = 3;
		return;
	}

	const attempted = accepted.length + rejected.length;
	const rate = attempted ? (100 * accepted.length) / attempted : 0;
	console.log(
		`\ngenerated ${attempted} (${failed.length} infrastructure failures), accepted ${accepted.length}, accept rate ${rate.toFixed(1)}%`,
	);
	const reasonCounts = {};
	for (const r of rejected) for (const reason of r.reasons) {
		const key = reason.split(':')[0];
		reasonCounts[key] = (reasonCounts[key] ?? 0) + 1;
	}
	if (Object.keys(reasonCounts).length) console.log('reject reasons:', reasonCounts);

	if (opts.dryRun) {
		console.log('\ndry run: no clips uploaded, no marketplace rows written');
		return;
	}
	if (accepted.length === 0) {
		console.log('\nnothing accepted, so nothing to publish');
		return;
	}

	const pub = await publishAccepted(accepted, opts);
	console.log(`published ${pub.published} clips, manifest now holds ${pub.manifestTotal}`);
	const listing = await listInMarketplace(accepted, opts);
	console.log(`listed ${listing.listed} in the marketplace, ${listing.freeCount} free this epoch (#${listing.epoch})`);
	for (const item of accepted) {
		state.results[item.prompt.id] = { ...state.results[item.prompt.id], status: 'published' };
	}
	saveCheckpoint(opts.checkpoint, state);
}

// Only run when invoked directly, so the lane assertion stays unit-testable.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
	main().catch((err) => {
		console.error(err);
		process.exit(1);
	});
}
