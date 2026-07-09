import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import bs58 from 'bs58';

globalThis.crypto ??= webcrypto;

const wasmPath = fileURLToPath(
	new URL('../src/solana/vanity/wasm/vanity_grinder_bg.wasm', import.meta.url),
);
const wasmBytes = readFileSync(wasmPath);

let grind;

beforeAll(async () => {
	const mod = await import('../src/solana/vanity/wasm/vanity_grinder.js');
	await mod.default({ module_or_path: wasmBytes });
	grind = mod.grind;
});

function findOne(prefix, ignoreCase = false, maxIters = 200, batch = 5000) {
	for (let i = 0; i < maxIters; i++) {
		const seed = new Uint8Array(32);
		crypto.getRandomValues(seed);
		const hit = grind(prefix, '', ignoreCase, batch, seed);
		if (hit) return hit;
	}
	return null;
}

describe('vanity-grinder WASM', () => {
	it('returns a keypair whose public key starts with the requested prefix', () => {
		// 'A' is in the high-probability bucket (first 17 base58 chars), so
		// a single 5000-key batch lands a hit on essentially every run.
		const hit = findOne('A');
		expect(hit).not.toBeNull();
		expect(hit.publicKey.startsWith('A')).toBe(true);
		expect(hit.secretKey).toBeInstanceOf(Uint8Array);
		expect(hit.secretKey.length).toBe(64);
	});

	it('honors ignoreCase: prefix "ab" matches addresses starting with "AB" or "ab"', () => {
		const hit = findOne('ab', true, 500);
		expect(hit).not.toBeNull();
		expect(hit.publicKey.slice(0, 2).toLowerCase()).toBe('ab');
	});

	it('secret key signs a message that verifies against the returned public key', () => {
		const hit = findOne('B');
		expect(hit).not.toBeNull();

		// Solana secret key = 32-byte seed || 32-byte public key
		const seed = hit.secretKey.slice(0, 32);
		const pubFromSecret = hit.secretKey.slice(32);

		// The embedded pubkey matches what the seed derives
		const derivedPub = ed25519.getPublicKey(seed);
		expect(Buffer.from(derivedPub).equals(Buffer.from(pubFromSecret))).toBe(true);

		// The base58 publicKey decodes to the same 32 bytes
		const decoded = bs58.decode(hit.publicKey);
		expect(Buffer.from(decoded).equals(Buffer.from(pubFromSecret))).toBe(true);

		// Sign / verify roundtrip
		const msg = new TextEncoder().encode('hello vanity grinder');
		const sig = ed25519.sign(msg, seed);
		expect(ed25519.verify(sig, msg, pubFromSecret)).toBe(true);

		// Tampered message must NOT verify
		const tampered = new TextEncoder().encode('hello vanity grinde');
		expect(ed25519.verify(sig, tampered, pubFromSecret)).toBe(false);
	});

	it('one batch (5000) returns within budget — bounds the worker abort latency', () => {
		// The worker drives grind() in 5000-key batches and only checks the
		// abort flag between batches. Real-browser WASM hits ~50ms per batch.
		// This is a WALL-clock read: when the full suite saturates every core,
		// this fork gets scheduler-starved and a 3s cap flaked. 10s still fails
		// on any real regression (an accidental jumbo batch or a quadratic bug
		// is orders of magnitude, not seconds) without tripping on contention.
		const seed = new Uint8Array(32);
		crypto.getRandomValues(seed);
		const t0 = performance.now();
		grind('zzzzzz', '', false, 5000, seed); // 6-char — won't match
		const elapsed = performance.now() - t0;
		expect(elapsed).toBeLessThan(10_000);
	});

	it('returns null when no match in batch', () => {
		// 6-char lowercase prefix is statistically near-impossible to hit in
		// a single 5000-key batch (P ≈ 10^-12).
		const seed = new Uint8Array(32);
		crypto.getRandomValues(seed);
		const hit = grind('zzzzzz', '', false, 5000, seed);
		expect(hit).toBeNull();
	});
});

describe('grindToCompletion stop signal', () => {
	// Regression guard: the batch grinder aborts an in-flight target the moment the
	// shared stop flag flips — NOT only when the (near-impossible) target completes.
	// grindToCompletion runs a synchronous loop, so it must poll stopRequested()
	// between batches; if it ignored it, an unlucky worker would hang for minutes.
	it('returns status "preempted" quickly when stopRequested flips true', async () => {
		const { grindToCompletion } = await import('../workers/vanity-grinder/wasm-grind.mjs');
		let batches = 0;
		const t0 = performance.now();
		const result = grindToCompletion(
			{ prefix: 'zzzzzz', suffix: '', ignoreCase: false }, // near-impossible → never a natural hit
			{ stopRequested: () => batches >= 2, onProgress: () => { batches += 1; } },
		);
		expect(result.status).toBe('preempted');
		expect(result.attempts).toBeGreaterThan(0);
		// Wall-clock read under a fully-parallel suite: scheduler starvation can
		// stretch two ~50ms batches into seconds. The contract is "preempts after
		// ~2 batches, not minutes" — 15s guards that without contention flakes.
		expect(performance.now() - t0).toBeLessThan(15_000);
	});

	it('gives up with status "exhausted" at maxAttempts on an unreachable target', async () => {
		const { grindToCompletion } = await import('../workers/vanity-grinder/wasm-grind.mjs');
		const result = grindToCompletion(
			{ prefix: 'zzzzzz', suffix: '', ignoreCase: false },
			{ stopRequested: () => false, maxAttempts: 50_000 },
		);
		expect(result.status).toBe('exhausted');
		expect(result.attempts).toBeGreaterThanOrEqual(50_000);
	});
});
