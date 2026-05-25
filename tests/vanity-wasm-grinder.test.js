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
		// abort flag between batches. Real-browser WASM hits ~50ms per batch;
		// shared CI runners (codespaces, GH Actions) can stretch to ~2s under
		// load. Cap at 3s so we still catch a true regression without flaking.
		const seed = new Uint8Array(32);
		crypto.getRandomValues(seed);
		const t0 = performance.now();
		grind('zzzzzz', '', false, 5000, seed); // 6-char — won't match
		const elapsed = performance.now() - t0;
		expect(elapsed).toBeLessThan(3000);
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
