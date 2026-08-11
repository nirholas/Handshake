// Core-path smoke test for the batch vanity grinder (workers/vanity-grinder).
//
// Everything below drives the REAL grind.mjs as a child process against the real
// WASM engine and the real seal primitive (api/_lib/vanity-vault.js) with a real
// AES-256-GCM key. Nothing is stubbed: the assertions are about the artifacts the
// production job actually produces on Cloud Run.
//
// What it pins:
//   1. The producer contract: a run finds its targets, and the JSONL it writes
//      holds ONLY ciphertext (a leaked plaintext key here is the worst bug this
//      worker can have).
//   2. The consumer contract: that ciphertext opens back to a signing keypair
//      whose public key really is the ground vanity address.
//   3. Resume: a second run over the same checkpoint grinds nothing.
//   4. The MAX_FOUND-already-met hang: a resumed run whose quota is satisfied
//      used to idle every worker forever instead of exiting.
//   5. Sharding: SHARD_COUNT partitions the target list into disjoint slices that
//      cover it exactly once.
//
// tests/vanity-wasm-grinder.test.js covers the grind loop itself (stop signal,
// exhaustion). This file covers the orchestration around it.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ed25519 } from '@noble/curves/ed25519.js';
import bs58 from 'bs58';

const execFileAsync = promisify(execFile);
const GRIND = fileURLToPath(new URL('../workers/vanity-grinder/grind.mjs', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

// A dedicated 32+ char key so the run seals under the v2 secret-box path (never
// the JWT_SECRET fallback) and this test never depends on a developer's .env.
const TEST_KEY = 'vanity-grinder-batch-test-key-0123456789';

// One-char targets: every one lands inside a single 25k-key WASM batch, so the
// whole orchestration path exercises in well under a second per run.
const TARGETS = [
	{ prefix: 'A', ignoreCase: false },
	{ suffix: 'z', ignoreCase: false },
	{ prefix: 'b', ignoreCase: true },
];

let dir;
let targetsFile;

function runGrind(extraEnv = {}, { timeoutMs = 60_000 } = {}) {
	return execFileAsync('node', [GRIND], {
		cwd: REPO_ROOT,
		timeout: timeoutMs,
		env: {
			...process.env,
			WALLET_ENCRYPTION_KEY: TEST_KEY,
			VANITY_KMS_KEY: '', // never reach for KMS in a unit run
			WRITE_DB: '0',
			TARGETS_FILE: targetsFile,
			WORKERS: '2',
			...extraEnv,
		},
	});
}

function readRecords(file) {
	return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), 'vanity-grind-'));
	targetsFile = join(dir, 'targets.json');
	writeFileSync(targetsFile, JSON.stringify(TARGETS));
});

afterAll(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('batch vanity grinder end to end', () => {
	const out = () => join(dir, 'inventory.jsonl');
	const checkpoint = () => join(dir, 'checkpoint.json');
	const summary = () => join(dir, 'summary.json');

	let records;

	it('grinds every target and writes an encrypted record per hit', async () => {
		const { stdout } = await runGrind({
			OUTPUT_FILE: out(),
			CHECKPOINT_FILE: checkpoint(),
			SUMMARY_FILE: summary(),
			BATCH_LABEL: 'vitest-batch',
		});
		expect(stdout).toContain('[grind] summary:');

		records = readRecords(out());
		expect(records).toHaveLength(TARGETS.length);

		const parsedSummary = JSON.parse(readFileSync(summary(), 'utf8'));
		expect(parsedSummary.found).toBe(TARGETS.length);
		expect(parsedSummary.scheme).toBe('aes-256-gcm');
		// A completed run is not a preemption; the shard needs no retry.
		expect(parsedSummary.preempted).toBe(false);
		expect(parsedSummary.stopReason).toBe('complete');

		// Each address really matches the pattern that produced it.
		for (const r of records) {
			if (r.prefix) {
				const head = r.address.slice(0, r.prefix.length);
				expect(r.ignoreCase ? head.toLowerCase() : head).toBe(r.ignoreCase ? r.prefix.toLowerCase() : r.prefix);
			}
			if (r.suffix) {
				const tail = r.address.slice(-r.suffix.length);
				expect(r.ignoreCase ? tail.toLowerCase() : tail).toBe(r.ignoreCase ? r.suffix.toLowerCase() : r.suffix);
			}
			expect(r.priceUsd).toBeGreaterThan(0);
			expect(r.rarityTier).toBeTruthy();
		}
	});

	it('never writes plaintext key material to disk', () => {
		const raw = readFileSync(out(), 'utf8');
		for (const r of records) {
			// No plaintext-bearing field survives into the record.
			expect(r.secretKey).toBeUndefined();
			expect(r.secretKeyBase58).toBeUndefined();
			expect(typeof r.secretCiphertext).toBe('string');
			expect(r.secretCiphertext.length).toBeGreaterThan(64);
		}
		// And the ciphertext is genuinely opaque: no base58 run long enough to be a
		// 64-byte Solana secret key appears anywhere in the file.
		const base58Runs = raw.match(/[1-9A-HJ-NP-Za-km-z]{80,}/g) || [];
		for (const run of base58Runs) {
			expect(() => bs58.decode(run)).toThrow();
		}
	});

	it('the sealed ciphertext opens to a keypair that signs for the ground address', async () => {
		process.env.WALLET_ENCRYPTION_KEY = TEST_KEY;
		delete process.env.VANITY_KMS_KEY;
		// Deliberately WITHOUT a session secret: JWT_SECRET is only a legacy decrypt
		// candidate, and a deployment carrying a dedicated WALLET_ENCRYPTION_KEY must
		// still open its own records without one (api/_lib/secret-box.js).
		delete process.env.JWT_SECRET;
		const { openSecret } = await import('../api/_lib/vanity-vault.js');

		for (const r of records) {
			const plain = JSON.parse(await openSecret(r.secretCiphertext, r.secretScheme));
			expect(plain.address).toBe(r.address);

			const secretKey = Uint8Array.from(plain.secretKey);
			expect(secretKey).toHaveLength(64);
			// Solana secret key layout: 32-byte seed || 32-byte public key.
			const seed = secretKey.slice(0, 32);
			const pub = secretKey.slice(32);
			expect(Buffer.from(ed25519.getPublicKey(seed)).equals(Buffer.from(pub))).toBe(true);
			expect(Buffer.from(bs58.decode(r.address)).equals(Buffer.from(pub))).toBe(true);
			expect(bs58.encode(Buffer.from(secretKey))).toBe(plain.secretKeyBase58);

			const msg = new TextEncoder().encode(`spend ${r.address}`);
			expect(ed25519.verify(ed25519.sign(msg, seed), msg, pub)).toBe(true);
		}
	});

	it('resumes: a second run over the same checkpoint grinds nothing', async () => {
		const before = readRecords(out()).length;
		const { stdout } = await runGrind({
			OUTPUT_FILE: out(),
			CHECKPOINT_FILE: checkpoint(),
			SUMMARY_FILE: join(dir, 'summary-resume.json'),
		});
		expect(stdout).toContain('0 to grind');
		expect(readRecords(out())).toHaveLength(before);
	});

	// Regression: assign() used to return without winding the run down when the
	// found-quota was already satisfied by a resumed checkpoint. Every worker then
	// sat idle with `active` stuck at 0, so the run never settled and the container
	// burned its full task timeout doing nothing.
	it('exits instead of hanging when a resumed checkpoint already meets MAX_FOUND', async () => {
		const cp = join(dir, 'checkpoint-quota.json');
		writeFileSync(cp, JSON.stringify({ batchLabel: 'quota', completed: [], found: 5 }));
		const { stdout } = await runGrind(
			{
				OUTPUT_FILE: join(dir, 'quota.jsonl'),
				CHECKPOINT_FILE: cp,
				SUMMARY_FILE: join(dir, 'summary-quota.json'),
				MAX_FOUND: '2',
			},
			{ timeoutMs: 30_000 },
		);
		expect(stdout).toContain('[grind] summary:');
		// Quota was already met, so nothing new was ground.
		expect(existsSync(join(dir, 'quota.jsonl'))).toBe(false);
		expect(JSON.parse(readFileSync(join(dir, 'summary-quota.json'), 'utf8')).stopReason).toBe('max-found');
	});

	// The headline production failure: a shard that outlives its Cloud Run
	// --task-timeout was killed and the whole execution reported FAILED, even
	// though every key it had sealed was already in the DB. The grinder now stops
	// itself first, and reports the work it really did.
	it('winds down and exits 0 when MAX_RUNTIME_SEC expires mid-target', async () => {
		const targets = join(dir, 'unreachable.json');
		writeFileSync(targets, JSON.stringify([{ prefix: 'zzzzz', ignoreCase: false }]));
		const summaryFile = join(dir, 'summary-budget.json');
		const { stdout } = await runGrind(
			{
				TARGETS_FILE: targets,
				OUTPUT_FILE: join(dir, 'budget.jsonl'),
				CHECKPOINT_FILE: join(dir, 'checkpoint-budget.json'),
				SUMMARY_FILE: summaryFile,
				MAX_RUNTIME_SEC: '2',
			},
			{ timeoutMs: 60_000 },
		);
		expect(stdout).toContain('runtime budget 2s reached');
		const parsed = JSON.parse(readFileSync(summaryFile, 'utf8'));
		expect(parsed.stopReason).toBe('runtime-budget');
		// A budget stop is intentional, not a preemption needing a shard retry.
		expect(parsed.preempted).toBe(false);
		// Aborted targets still report the ed25519 work they actually did.
		expect(parsed.totalAttempts).toBeGreaterThan(0);
	});

	it('shards the target list into disjoint slices that cover it exactly once', async () => {
		const addresses = [];
		for (const index of ['0', '1']) {
			const file = join(dir, `shard-${index}.jsonl`);
			await runGrind({
				OUTPUT_FILE: file,
				CHECKPOINT_FILE: join(dir, `shard-${index}-checkpoint.json`),
				SUMMARY_FILE: join(dir, `shard-${index}-summary.json`),
				SHARD_COUNT: '2',
				SHARD_INDEX: index,
			});
			addresses.push(readRecords(file).map((r) => r.patternLabel));
		}
		const [shard0, shard1] = addresses;
		expect(shard0.length + shard1.length).toBe(TARGETS.length);
		expect(shard0.filter((label) => shard1.includes(label))).toEqual([]);
	});
});

describe('GCE MIG shard resolution', () => {
	// The MIG runner has no ordinal in its environment; without a resolver every VM
	// read shard 0 and duplicated the same work. The hash is the coordination-free
	// fallback used when the instance-group listing is unavailable.
	it('hashShardIndex is deterministic and always in range', async () => {
		const { hashShardIndex } = await import('../workers/vanity-grinder/gce-shard.mjs');
		const names = Array.from({ length: 200 }, (_, i) => `vanity-grinder-${i.toString(36)}xk`);
		for (const name of names) {
			const index = hashShardIndex(name, 8);
			expect(index).toBeGreaterThanOrEqual(0);
			expect(index).toBeLessThan(8);
			expect(hashShardIndex(name, 8)).toBe(index);
		}
		// It must actually spread; a constant would reproduce the all-on-shard-0 bug.
		expect(new Set(names.map((n) => hashShardIndex(n, 8))).size).toBeGreaterThan(1);
	});

	it('falls back to shard 0 off GCE rather than blocking on the metadata server', async () => {
		const { resolveGceShardIndex } = await import('../workers/vanity-grinder/gce-shard.mjs');
		const t0 = performance.now();
		const resolved = await resolveGceShardIndex(4, () => {});
		expect(resolved.source).toBe('unavailable');
		expect(resolved.index).toBe(0);
		// The metadata probe is bounded; a hung DNS lookup must not stall a run.
		expect(performance.now() - t0).toBeLessThan(15_000);
	});
});
