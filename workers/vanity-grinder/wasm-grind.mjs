// Self-contained WASM grind loop for the batch grinder container.
//
// Loads the same Rust/ed25519-dalek WASM engine the serverless grinder uses
// (src/solana/vanity/wasm), but grinds a target to COMPLETION (no wall-clock
// budget) — batch CPU has all the time it needs. First match wins; the caller
// (grind-worker.mjs, running in a worker_thread) posts the found keypair back to
// the main thread, which seals it before any write.
//
// The .wasm ships in the image next to this file (see Dockerfile COPY).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { initSync, grind } from '../../src/solana/vanity/wasm/vanity_grinder.js';

// The .wasm sits next to its glue in the canonical source tree; the container
// preserves that repo-relative layout (see Dockerfile), so one path works both
// locally and in the image.
const WASM_PATH = fileURLToPath(new URL('../../src/solana/vanity/wasm/vanity_grinder_bg.wasm', import.meta.url));

// Keypairs per WASM call. Big enough that per-call overhead is negligible, small
// enough that a SIGTERM (spot preemption) is observed within a fraction of a
// second between batches.
const BATCH_SIZE = 25_000;

let ready = false;
function ensureWasm() {
	if (ready) return;
	initSync({ module: readFileSync(WASM_PATH) });
	ready = true;
}

/**
 * Grind one target to completion.
 *
 * @param {object} target
 * @param {string} [target.prefix]
 * @param {string} [target.suffix]
 * @param {boolean} [target.ignoreCase]
 * @param {object} [opts]
 * @param {() => boolean} [opts.stopRequested] - return true to abort (preemption).
 * @param {(attempts:number)=>void} [opts.onProgress] - called each batch.
 * @param {number} [opts.maxAttempts=Infinity] - give up after this many tries.
 * @param {number} [opts.batchSize=BATCH_SIZE] - keypairs per WASM call. The default
 *          suits batch containers; a smaller batch tightens the stop-poll latency
 *          (and lets tests drive the loop without grinding tens of thousands of keys).
 * @returns {{ publicKey?:string, secretKey?:Uint8Array, attempts:number, durationMs:number, status:'found'|'preempted'|'exhausted' }}
 *          status 'exhausted' when maxAttempts is hit with no match (a leading char
 *          can be near-impossible in Base58, so an unbounded grind could hang a
 *          worker forever); 'preempted' when stopRequested() aborts.
 */
export function grindToCompletion(target, opts = {}) {
	ensureWasm();
	const prefix = target.prefix || '';
	const suffix = target.suffix || '';
	const ignoreCase = !!target.ignoreCase;
	const { stopRequested, onProgress, maxAttempts = Infinity, batchSize = BATCH_SIZE } = opts;

	const seed = new Uint8Array(32);
	const startedAt = performance.now();
	let attempts = 0;

	for (;;) {
		if (stopRequested && stopRequested()) {
			return { attempts, durationMs: performance.now() - startedAt, status: 'preempted' };
		}
		crypto.getRandomValues(seed);
		const hit = grind(prefix, suffix, ignoreCase, batchSize, seed);
		attempts += batchSize;
		if (onProgress) onProgress(attempts);
		if (hit) {
			return {
				publicKey: hit.publicKey,
				secretKey: Uint8Array.from(hit.secretKey),
				attempts,
				durationMs: performance.now() - startedAt,
				status: 'found',
			};
		}
		if (attempts >= maxAttempts) {
			return { attempts, durationMs: performance.now() - startedAt, status: 'exhausted' };
		}
	}
}
