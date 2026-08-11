#!/usr/bin/env node
// Batch vanity grinder — the premium-inventory producer.
//
// Runs a pool of WASM grind workers (one per vCPU) over a target list, SEALS each
// found keypair in-process (api/_lib/vanity-vault.js) BEFORE any write, and
// appends the ENCRYPTED record to an output JSONL (and, when configured, straight
// into the vanity_inventory table). Plaintext keys never touch disk, a log, or
// the network.
//
// RESUMABLE, on two levels:
//   • A checkpoint FILE records which targets this container already finished.
//   • With WRITE_DB=1 the completed-set is ALSO seeded from `vanity_inventory`
//     itself, because a Cloud Run task's /tmp checkpoint dies with the task. The
//     DB is the only state that survives a spot preemption, so without this every
//     retry re-ground patterns already sitting on the shelf.
// SIGTERM (the preemption signal) flushes the checkpoint and exits cleanly so no
// in-flight state is lost. An interrupted target simply restarts from scratch (a
// random search has no resumable inner state; expected work is unchanged).
// MAX_RUNTIME_SEC does the same thing proactively: it winds the run down and
// exits 0 BEFORE the platform's task timeout kills it, so a long shard reports a
// successful execution with a real summary instead of a timeout failure.
//
// Designed for GCP spot CPU (Cloud Run Job or a GCE spot MIG) but runs anywhere
// with Node — the local dev run that seeds the initial inventory uses the exact
// same code path (see docs/ops/gcp-credits.md).
//
// Config (all via env):
//   OUTPUT_FILE      encrypted JSONL out (default ./out/inventory.jsonl)
//   CHECKPOINT_FILE  resume state       (default ./out/checkpoint.json)
//   SUMMARY_FILE     throughput summary (default ./out/summary.json)
//   TARGETS_FILE     JSON array of {prefix?,suffix?,ignoreCase} (default: built-in list)
//   INCLUDE_5        '1' to include slow 5-char stretch targets
//   IGNORE_CASE      '1' to fold case on prefix targets
//   MAX_FOUND        stop after N addresses (default: all targets)
//   MAX_RUNTIME_SEC  wind down cleanly after N seconds (default: no budget)
//   MAX_ATTEMPTS_PER_TARGET  give up on one target after N tries (default 200M)
//   WORKERS          worker count (default: available parallelism)
//   RETENTION_DAYS   ciphertext retention after reveal (default 0 = delete-on-reveal)
//   BATCH_LABEL      label for this run (default: timestamped)
//   RUNNER           'local' | 'cloud-run-job' | 'gce-spot-mig'
//   SHARD_INDEX/SHARD_COUNT  partition the target list across parallel instances
//   WRITE_DB         '1' to upsert into vanity_inventory (needs DATABASE_URL)
//   VANITY_KMS_KEY   (optional) KMS crypto-key resource → envelope encryption
//   WALLET_ENCRYPTION_KEY  the secret-box master key (required unless KMS)

import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync, appendFileSync, writeFileSync, readFileSync, existsSync, openSync, fsyncSync, closeSync } from 'node:fs';
import os from 'node:os';
import bs58 from 'bs58';

import { defaultTargets, targetId, labelFor } from './targets.mjs';
import { resolveGceShardIndex } from './gce-shard.mjs';
import { computeRarity } from '../../src/solana/vanity/rarity.js';
import { priceFromRarity } from '../../api/_lib/vanity-inventory-pricing.js';
import { sealSecret, preferredScheme } from '../../api/_lib/vanity-vault.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const env = process.env;

const OUTPUT_FILE = resolve(env.OUTPUT_FILE || join(HERE, 'out', 'inventory.jsonl'));
const CHECKPOINT_FILE = resolve(env.CHECKPOINT_FILE || join(HERE, 'out', 'checkpoint.json'));
const SUMMARY_FILE = resolve(env.SUMMARY_FILE || join(HERE, 'out', 'summary.json'));
const RETENTION_DAYS = Math.max(0, parseInt(env.RETENTION_DAYS || '0', 10) || 0);
const MAX_FOUND = env.MAX_FOUND ? parseInt(env.MAX_FOUND, 10) : Infinity;
// Wall-clock budget. Cloud Run kills a task at its --task-timeout and reports the
// whole execution FAILED even though every sealed key already landed in the DB
// (observed on execution vanity-grinder-jx97w: 2/4 tasks "The configured timeout
// was reached"). Setting this a couple of minutes under the platform timeout lets
// the run stop itself, write its summary, and exit 0.
const MAX_RUNTIME_SEC = Math.max(0, parseInt(env.MAX_RUNTIME_SEC || '0', 10) || 0);
const WORKER_COUNT = Math.max(1, parseInt(env.WORKERS || String(os.availableParallelism?.() || os.cpus().length), 10));
const RUNNER = env.RUNNER || 'local';
const BATCH_LABEL = env.BATCH_LABEL || `batch-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const WRITE_DB = env.WRITE_DB === '1' || env.WRITE_DB === 'true';

// Which slice of the target list this instance owns.
//
// Cloud Run Jobs hand every task its ordinal in CLOUD_RUN_TASK_INDEX. A GCE MIG
// hands out nothing: its VMs get identical container-env and randomly-suffixed
// names, so every VM used to read shard 0 and grind the same targets as all its
// siblings. gce-shard.mjs resolves a real position from the instance group.
async function resolveShardIndex(shardCount) {
	if (env.SHARD_INDEX != null && env.SHARD_INDEX !== '') {
		return { index: Math.max(0, parseInt(env.SHARD_INDEX, 10) || 0), source: 'env' };
	}
	if (env.CLOUD_RUN_TASK_INDEX != null && env.CLOUD_RUN_TASK_INDEX !== '') {
		return { index: Math.max(0, parseInt(env.CLOUD_RUN_TASK_INDEX, 10) || 0), source: 'cloud-run-task' };
	}
	if (shardCount > 1 && RUNNER === 'gce-spot-mig') {
		const resolved = await resolveGceShardIndex(shardCount);
		return { index: resolved.index, source: resolved.source };
	}
	return { index: 0, source: 'default' };
}

async function loadTargets() {
	let list;
	if (env.TARGETS_FILE && existsSync(resolve(env.TARGETS_FILE))) {
		const raw = JSON.parse(readFileSync(resolve(env.TARGETS_FILE), 'utf8'));
		list = raw.map((t) => ({ ignoreCase: !!t.ignoreCase, ...t, label: t.label || labelFor(t) }));
	} else {
		list = defaultTargets({ include5: env.INCLUDE_5 === '1', ignoreCase: env.IGNORE_CASE === '1' });
	}
	const shardCount = Math.max(1, parseInt(env.SHARD_COUNT || '1', 10));
	if (shardCount === 1) return list;
	const { index, source } = await resolveShardIndex(shardCount);
	console.log(`[grind] shard ${index}/${shardCount} (source: ${source})`);
	return list.filter((_, i) => i % shardCount === index % shardCount);
}

// Durable resume signal. A Cloud Run task's checkpoint file lives in the task's
// own ephemeral /tmp, so a preemption or retry loses it entirely; the inventory
// table is the only state that survives. Seeding the completed-set from patterns
// already in stock is what makes a retried shard continue instead of restart.
// Never fatal: a DB hiccup must not stop a grinder that can still write a JSONL.
async function loadDbCompleted() {
	if (!WRITE_DB) return 0;
	try {
		const store = await import('../../api/_lib/vanity-inventory-store.js');
		const patterns = await store.availableTargetPatterns();
		let added = 0;
		for (const p of patterns) {
			const id = targetId({ prefix: p.prefix || '', suffix: p.suffix || '', ignoreCase: p.ignoreCase });
			if (!completed.has(id)) {
				completed.add(id);
				added += 1;
			}
		}
		return added;
	} catch (err) {
		console.error(`[grind] could not read inventory for resume (${err.message}); grinding the full shard`);
		return 0;
	}
}

function loadCheckpoint() {
	if (existsSync(CHECKPOINT_FILE)) {
		try {
			return JSON.parse(readFileSync(CHECKPOINT_FILE, 'utf8'));
		} catch {
			/* corrupt checkpoint — start fresh */
		}
	}
	return { batchLabel: BATCH_LABEL, completed: [], found: 0, startedAt: new Date().toISOString() };
}

let checkpoint = loadCheckpoint();
const completed = new Set(checkpoint.completed || []);

function saveCheckpoint() {
	checkpoint.completed = [...completed];
	writeFileSync(CHECKPOINT_FILE, JSON.stringify(checkpoint, null, '\t'));
}

// Append an encrypted record durably (fsync so a preemption can't lose a found key).
function appendEncrypted(record) {
	const fd = openSync(OUTPUT_FILE, 'a');
	try {
		appendFileSync(fd, JSON.stringify(record) + '\n');
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

// Lazily-loaded DB writer (only pulled in when WRITE_DB is set, so a file-only run
// never needs Neon/DATABASE_URL).
let _dbStore = null;
async function dbUpsert(item) {
	if (!WRITE_DB) return;
	if (!_dbStore) _dbStore = await import('../../api/_lib/vanity-inventory-store.js');
	await _dbStore.upsertInventoryItem(item);
}

// ── Stats ────────────────────────────────────────────────────────────────────
const stats = { found: checkpoint.found || 0, totalAttempts: 0, startedAt: performance.now() };

// ── Seal + persist a found keypair (MAIN thread only) ────────────────────────
async function persistFound({ target, publicKey, secretKey, attempts, durationMs }) {
	const rarity = computeRarity({ prefix: target.prefix, suffix: target.suffix, ignoreCase: target.ignoreCase });
	const { priceUsd } = priceFromRarity(rarity);

	// The plaintext bundle — sealed immediately, never written in the clear.
	const secretKeyBase58 = bs58.encode(Buffer.from(secretKey));
	const plaintext = JSON.stringify({
		format: 'keypair',
		address: publicKey,
		secretKeyBase58,
		secretKey: Array.from(secretKey),
	});
	const { ciphertext, scheme } = await sealSecret(plaintext);
	// Scrub the plaintext material from local scope ASAP.
	secretKey.fill(0);

	const record = {
		address: publicKey,
		prefix: target.prefix || null,
		suffix: target.suffix || null,
		ignoreCase: !!target.ignoreCase,
		patternLabel: target.label || labelFor(target),
		format: 'keypair',
		difficultyAttempts: rarity.expectedAttempts,
		rarityBits: rarity.rarityBits,
		rarityTier: rarity.tier,
		rarityScore: rarity.rarityScore,
		priceUsd,
		retentionDays: RETENTION_DAYS,
		secretCiphertext: ciphertext,
		secretScheme: scheme,
		batchLabel: BATCH_LABEL,
		groundAt: new Date().toISOString(),
		attempts,
		foundInMs: Math.round(durationMs),
	};
	appendEncrypted(record);
	await dbUpsert({
		address: record.address,
		prefix: record.prefix,
		suffix: record.suffix,
		ignoreCase: record.ignoreCase,
		patternLabel: record.patternLabel,
		format: record.format,
		difficultyAttempts: record.difficultyAttempts,
		rarityBits: record.rarityBits,
		rarityTier: record.rarityTier,
		rarityScore: record.rarityScore,
		secretCiphertext: ciphertext,
		secretScheme: scheme,
		priceUsd,
		retentionDays: RETENTION_DAYS,
	});

	stats.found += 1;
	checkpoint.found = stats.found;
	completed.add(targetId(target));
	saveCheckpoint();
	// One safe, secret-free progress line.
	console.log(`[grind] found ${record.patternLabel} → ${publicKey} (${attempts.toLocaleString()} attempts, ${Math.round(durationMs)}ms) $${priceUsd} [${scheme}]`);
}

// ── Orchestration ────────────────────────────────────────────────────────────
let stopping = false;
// Why the run wound down early, so the summary distinguishes a real spot
// preemption (retry the shard) from an intentional stop (quota met, budget spent).
let stopReason = '';
let onStop = null;
const workers = [];

// The stop signal is a SharedArrayBuffer flag, NOT a postMessage. A worker grinds
// in a SYNCHRONOUS loop (grindToCompletion) that never yields to its event loop
// mid-target, so a queued 'stop' message would sit unprocessed until the whole
// target finishes — a hard target would then ignore stop for minutes. A shared
// atomic, by contrast, is read directly inside the sync loop at each batch
// boundary, so every worker aborts within one ~sub-second batch.
const stopBuffer = new SharedArrayBuffer(4);
const stopFlag = new Int32Array(stopBuffer);

// Abort every worker's in-flight grind. Flip the shared flag; workers observe it
// between batches (~sub-second) and post 'aborted', letting the run wind down.
function stopAllWorkers() {
	Atomics.store(stopFlag, 0, 1);
}

async function main() {
	mkdirSync(dirname(OUTPUT_FILE), { recursive: true });
	// Fail fast if we can't encrypt — never grind keys we can't seal.
	try {
		await sealSecret('preflight');
	} catch (err) {
		console.error(`[grind] FATAL: cannot seal secrets (${err.message}). Set WALLET_ENCRYPTION_KEY (or VANITY_KMS_KEY). Refusing to grind unsealed keys.`);
		process.exit(3);
	}

	console.log(`[grind] ${BATCH_LABEL} runner=${RUNNER} scheme=${preferredScheme()} workers=${WORKER_COUNT}`);
	const all = await loadTargets();
	const fromDb = await loadDbCompleted();
	if (fromDb) console.log(`[grind] ${fromDb} target(s) already in stock per vanity_inventory, skipping them`);
	const pending = all.filter((t) => !completed.has(targetId(t)));
	console.log(`[grind] targets: ${all.length} total, ${all.length - pending.length} already done, ${pending.length} to grind`);
	if (MAX_RUNTIME_SEC) console.log(`[grind] runtime budget: ${MAX_RUNTIME_SEC}s`);
	if (!pending.length) {
		await writeSummary(all.length);
		console.log('[grind] nothing to do — inventory target list already complete.');
		return;
	}

	let cursor = 0;
	let active = 0;
	let deadline = null;

	await new Promise((resolveAll) => {
		let settled = false;
		const maybeFinish = () => {
			if (settled) return;
			if ((cursor >= pending.length && active === 0) || (stopping && active === 0)) {
				settled = true;
				stopAllWorkers();
				resolveAll();
			}
		};
		// A SIGTERM (spot preemption) sets `stopping` and asks workers to abort; once
		// each in-flight target reports 'aborted' (active hits 0) the run winds down.
		onStop = () => {
			stopAllWorkers();
			maybeFinish();
		};

		// Proactive wind-down before the platform's task timeout turns a productive
		// run into a FAILED execution. Same path as SIGTERM: flush, let workers
		// abort at their next batch boundary, write the summary, exit 0.
		if (MAX_RUNTIME_SEC) {
			deadline = setTimeout(() => {
				if (stopping) return;
				console.log(`[grind] runtime budget ${MAX_RUNTIME_SEC}s reached: checkpointing and finishing cleanly`);
				stopping = true;
				stopReason = 'runtime-budget';
				saveCheckpoint();
				onStop();
			}, MAX_RUNTIME_SEC * 1000);
		}

		const assign = (worker) => {
			// Quota already met, possibly on the FIRST assign, when a resumed
			// checkpoint carries found >= MAX_FOUND. Winding the run down here is
			// what stops that case from idling every worker with no target while
			// `active` never rises off zero and the run never settles.
			if (stats.found >= MAX_FOUND) {
				stopping = true;
				stopReason = stopReason || 'max-found';
				stopAllWorkers();
				maybeFinish();
				return;
			}
			if (stopping || cursor >= pending.length) {
				maybeFinish();
				return;
			}
			const target = pending[cursor++];
			active += 1;
			worker.postMessage({ type: 'grind', target });
		};

		for (let i = 0; i < WORKER_COUNT; i++) {
			const worker = new Worker(join(HERE, 'grind-worker.mjs'), { workerData: { index: i, stopBuffer } });
			workers.push(worker);
			worker.on('message', async (msg) => {
				if (msg.type === 'ready') {
					assign(worker);
					return;
				}
				if (msg.type === 'progress') {
					stats.totalAttempts += msg.attempts;
					return;
				}
				if (msg.type === 'found') {
					stats.totalAttempts += msg.attempts;
					try {
						await persistFound(msg);
					} catch (err) {
						console.error(`[grind] persist failed for ${msg.publicKey}: ${err.message}`);
					}
					active -= 1;
					if (stats.found >= MAX_FOUND) {
						// Target reached: abort every in-flight worker NOW so none grinds
						// its current (possibly hard) target to completion. Each aborts at
						// its next batch boundary and reports 'aborted', winding active to 0.
						stopping = true;
						stopReason = stopReason || 'max-found';
						stopAllWorkers();
						maybeFinish();
						return;
					}
					assign(worker);
					return;
				}
				if (msg.type === 'exhausted') {
					// Near-impossible pattern (rare Base58 leading char). Give up
					// permanently so a resume doesn't retry it, and free the worker.
					stats.totalAttempts += msg.attempts || 0;
					completed.add(targetId(msg.target));
					checkpoint.exhausted = (checkpoint.exhausted || []);
					if (!checkpoint.exhausted.includes(targetId(msg.target))) checkpoint.exhausted.push(targetId(msg.target));
					saveCheckpoint();
					console.log(`[grind] gave up on ${msg.target.label || targetId(msg.target)} after ${(msg.attempts || 0).toLocaleString()} attempts (pattern too rare) — skipping`);
					active -= 1;
					if (stopping) { maybeFinish(); return; }
					assign(worker);
					return;
				}
				if (msg.type === 'aborted') {
					// Preemption: leave the target un-completed so the next run retries it.
					// Its attempts still count: they were real ed25519 work, and dropping
					// them made every budget-terminated run report 0 keys/sec, which is
					// exactly the shape of run MAX_RUNTIME_SEC makes routine.
					stats.totalAttempts += msg.attempts || 0;
					active -= 1;
					maybeFinish();
				}
			});
			worker.on('error', (err) => {
				console.error(`[grind] worker error: ${err.message}`);
				active = Math.max(0, active - 1);
				maybeFinish();
			});
		}
	});

	if (deadline) clearTimeout(deadline);
	for (const w of workers) await w.terminate();
	await writeSummary(all.length);
}

async function writeSummary(targetCount) {
	const elapsedSec = (performance.now() - stats.startedAt) / 1000;
	const keysPerSec = elapsedSec > 0 ? stats.totalAttempts / elapsedSec : 0;
	const summary = {
		batchLabel: BATCH_LABEL,
		runner: RUNNER,
		workers: WORKER_COUNT,
		scheme: preferredScheme(),
		targetCount,
		found: stats.found,
		totalAttempts: stats.totalAttempts,
		elapsedSec: Math.round(elapsedSec * 100) / 100,
		keysPerSec: Math.round(keysPerSec),
		keysPerSecPerWorker: Math.round(keysPerSec / WORKER_COUNT),
		stopReason: stopReason || (stopping ? 'signal' : 'complete'),
		// A real spot preemption (SIGTERM) leaves work on the table and the shard
		// should be retried. Hitting MAX_FOUND or the runtime budget is a clean,
		// intentional stop; reporting those as "preempted" made a healthy run look
		// like a failure.
		preempted: stopReason === 'signal',
		finishedAt: new Date().toISOString(),
	};
	writeFileSync(SUMMARY_FILE, JSON.stringify(summary, null, '\t'));
	console.log(`[grind] summary: found ${summary.found}, ${summary.keysPerSec.toLocaleString()} keys/sec (${summary.keysPerSecPerWorker.toLocaleString()}/worker), ${summary.elapsedSec}s`);
	return summary;
}

// Spot preemption: SIGTERM arrives ~30s before shutdown. Flush + exit cleanly.
for (const sig of ['SIGTERM', 'SIGINT']) {
	process.on(sig, () => {
		if (stopping) return;
		console.log(`[grind] ${sig} received — checkpointing and shutting down`);
		stopping = true;
		stopReason = 'signal';
		saveCheckpoint();
		if (onStop) onStop();
	});
}

main().catch((err) => {
	console.error('[grind] fatal:', err);
	process.exit(1);
});
