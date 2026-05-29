/**
 * Solana vanity address grinder — Node / serverless backend.
 *
 * The browser path (`grinder.js`) races a pool of Web Workers driving the
 * WASM module. Serverless functions have no Worker pool, so this module runs
 * the same Rust + ed25519-dalek WASM grinder single-threaded on the request
 * thread, bounded by a wall-clock budget. First match wins; if the budget is
 * exhausted without a hit we throw `GrindExhaustedError` so the caller can
 * decline to charge the buyer (the x402 paid endpoint settles payment only
 * after a successful grind).
 *
 * Throughput is ~25k keypairs/sec single-threaded in WASM, so the practical
 * server-side ceiling is a 3-character combined pattern (≈195k expected
 * attempts, found inside the default 45s budget ~99.5% of the time). Longer
 * patterns belong in the browser grinder at /vanity, which parallelizes
 * across every core on the user's machine.
 *
 * The returned `secretKey` is a Uint8Array(64) — Solana's standard Ed25519
 * keypair format, compatible with `Keypair.fromSecretKey()`.
 */

import { readFileSync } from 'node:fs';

import { initSync, grind } from './wasm/vanity_grinder.js';
import { validatePattern, estimateAttempts, BASE58_ALPHABET } from './validation.js';

export { BASE58_ALPHABET, validatePattern, estimateAttempts };

// Largest combined (prefix + suffix) length the server will grind. Past this,
// the expected attempt count blows past what a single WASM thread can clear
// inside a serverless time budget — the browser grinder handles the rest.
export const MAX_SERVER_PATTERN_LENGTH = 3;

// Default wall-clock budget for a single grind. Sized to clear a 3-char
// pattern (~195k expected attempts at ~25k/s) with ~99.5% probability while
// leaving headroom under a 60s function maxDuration for verify + settle.
const DEFAULT_TIME_BUDGET_MS = 45_000;

// Keypairs generated per WASM call. Large enough that per-call overhead is
// negligible, small enough that we re-check the time budget promptly.
const BATCH_SIZE = 20_000;

let wasmReady = false;

export class GrindExhaustedError extends Error {
	constructor(attempts, durationMs) {
		super(`grind budget exhausted after ${attempts} attempts in ${Math.round(durationMs)}ms`);
		this.name = 'GrindExhaustedError';
		this.code = 'grind_exhausted';
		this.status = 504;
		this.attempts = attempts;
		this.durationMs = durationMs;
	}
}

// Lazily instantiate the WASM module once per process. `initSync` takes the
// raw bytes — no fetch, no top-level await — which is what we want in a
// serverless cold start. The .wasm file is shipped alongside this module via
// the route's `includeFiles` glob in vercel.json.
function ensureWasm() {
	if (wasmReady) return;
	const wasmPath = new URL('./wasm/vanity_grinder_bg.wasm', import.meta.url);
	initSync({ module: readFileSync(wasmPath) });
	wasmReady = true;
}

/**
 * Estimate the combined difficulty (expected attempts) for a pattern.
 * @param {string} prefix
 * @param {string} suffix
 * @returns {number}
 */
export function expectedAttemptsFor(prefix, suffix) {
	return estimateAttempts((prefix?.length || 0) + (suffix?.length || 0));
}

/**
 * @typedef {object} NodeGrindResult
 * @property {string} publicKey      - Base58 address.
 * @property {Uint8Array} secretKey  - 64-byte Ed25519 secret key.
 * @property {number} attempts       - Total keypairs tried.
 * @property {number} durationMs     - Wall-clock duration.
 */

/**
 * Grind for a vanity Solana address on the request thread.
 *
 * @param {object} opts
 * @param {string} [opts.prefix]            Base58 prefix to match.
 * @param {string} [opts.suffix]            Base58 suffix to match.
 * @param {boolean} [opts.ignoreCase=false] Case-insensitive match.
 * @param {number} [opts.timeBudgetMs]      Wall-clock budget before giving up.
 * @returns {NodeGrindResult}
 * @throws {Error} on invalid pattern (status 400) or exhausted budget (status 504).
 */
export function grindVanityNode(opts = {}) {
	const prefix = opts.prefix || '';
	const suffix = opts.suffix || '';
	const ignoreCase = !!opts.ignoreCase;
	const timeBudgetMs = opts.timeBudgetMs || DEFAULT_TIME_BUDGET_MS;

	if (!prefix && !suffix) {
		throw Object.assign(new Error('prefix or suffix is required'), {
			status: 400,
			code: 'validation_error',
		});
	}
	for (const [label, pattern] of [['prefix', prefix], ['suffix', suffix]]) {
		if (!pattern) continue;
		const v = validatePattern(pattern);
		if (!v.valid) {
			throw Object.assign(new Error(`invalid ${label}: ${v.errors.join('; ')}`), {
				status: 400,
				code: 'validation_error',
			});
		}
	}
	const combinedLength = prefix.length + suffix.length;
	if (combinedLength > MAX_SERVER_PATTERN_LENGTH) {
		throw Object.assign(
			new Error(
				`combined pattern length ${combinedLength} exceeds the server limit of ` +
					`${MAX_SERVER_PATTERN_LENGTH} characters — grind longer patterns in the ` +
					`browser at /vanity, which parallelizes across all your cores`,
			),
			{ status: 400, code: 'pattern_too_long' },
		);
	}

	ensureWasm();

	const startedAt = performance.now();
	const seed = new Uint8Array(32);
	let attempts = 0;

	while (performance.now() - startedAt < timeBudgetMs) {
		crypto.getRandomValues(seed);
		const hit = grind(prefix, suffix, ignoreCase, BATCH_SIZE, seed);
		attempts += BATCH_SIZE;
		if (hit) {
			return {
				publicKey: hit.publicKey,
				secretKey: Uint8Array.from(hit.secretKey),
				attempts,
				durationMs: performance.now() - startedAt,
			};
		}
	}

	throw new GrindExhaustedError(attempts, performance.now() - startedAt);
}
