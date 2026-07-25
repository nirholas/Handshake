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
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { initSync, grind } from './wasm/vanity_grinder.js';
import { validatePattern, estimateAttempts, expectedAttempts, BASE58_ALPHABET } from './validation.js';

export { BASE58_ALPHABET, validatePattern, estimateAttempts, expectedAttempts };

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

/** Measured single-threaded WASM throughput. Override where the host is slower. */
export const KEYPAIR_ATTEMPTS_PER_SECOND = Number(
	globalThis.process?.env?.KEYPAIR_GRIND_RATE || 25_000,
);

/**
 * Minimum ratio of affordable to expected attempts before a job is accepted.
 * A geometric grind clears `n` attempts with probability 1 − e^(−n/E), so n/E ≥ 3
 * finishes ~95% of the time.
 */
const FEASIBILITY_MARGIN = 3;

/**
 * Reject a pattern the budget cannot realistically satisfy.
 *
 * `MAX_SERVER_PATTERN_LENGTH` alone is not a sufficient guard. Base58's leading
 * character spans a 58× difficulty range (see base58-distribution.js), so a
 * 3-character pattern is ~57k attempts when it leads with '2'-'H' and ~3.3M when
 * it leads with 'K'-'z', the latter needs ~132s, three times the budget. Such a
 * request used to be accepted, grind for the full 45s, and fail.
 *
 * @param {string} prefix
 * @param {string} suffix
 * @param {boolean} ignoreCase
 * @param {number} timeBudgetMs
 * @throws {Error} status 400 / code `pattern_infeasible`
 */
export function assertKeypairFeasible(prefix, suffix, ignoreCase, timeBudgetMs) {
	const expected = expectedAttempts(prefix || '', suffix || '', ignoreCase);
	const affordable = (timeBudgetMs / 1000) * KEYPAIR_ATTEMPTS_PER_SECOND;
	if (expected * FEASIBILITY_MARGIN <= affordable) return;

	const seconds = Math.ceil(expected / KEYPAIR_ATTEMPTS_PER_SECOND);
	const chance = Math.round((1 - Math.exp(-affordable / expected)) * 100);
	throw Object.assign(
		new Error(
			`pattern needs ~${Math.round(expected).toLocaleString('en-US')} attempts ` +
				`(~${seconds}s at ${KEYPAIR_ATTEMPTS_PER_SECOND.toLocaleString('en-US')}/sec), but the ` +
				`${Math.round(timeBudgetMs / 1000)}s budget only affords ` +
				`~${Math.round(affordable).toLocaleString('en-US')}, about a ${chance}% chance of a hit. ` +
				`Base58's leading character is not uniform: the 40 symbols from 'K' to 'z' are ~17× ` +
				`harder to lead with than '2'-'H'. Try a prefix starting with one of 2-9 or A-H, move ` +
				`the pattern to the suffix (uniform 1/58 per character), or grind it in the browser at ` +
				`/vanity, which parallelizes across all your cores.`,
		),
		{ status: 400, code: 'pattern_infeasible', expectedAttempts: Math.round(expected) },
	);
}

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
// serverless cold start.
//
// Locating the .wasm at runtime is the subtle part. The natural
// `new URL('./wasm/...', import.meta.url)` resolves relative to THIS module —
// but when a large route (e.g. api/pump/[action].js) bundles grinder-node.js
// inline, import.meta.url becomes the bundle's path and the lookup points at a
// `wasm/` dir next to the route that nothing ships there
// (ENOENT /var/task/api/pump/wasm/vanity_grinder_bg.wasm in prod). So we try a
// list of candidate locations and use the first that exists:
//   1. module-relative (works when this file ships unbundled);
//   2. the repo source path under the function root (/var/task), which the
//      route's `includeFiles: "src/solana/vanity/wasm/**"` glob guarantees.
// Whichever build strategy Vercel picks, one of these resolves.
function readWasmBytes() {
	const candidates = [];
	try {
		candidates.push(fileURLToPath(new URL('./wasm/vanity_grinder_bg.wasm', import.meta.url)));
	} catch {
		/* import.meta.url not a file URL in some bundlers — skip */
	}
	candidates.push(
		join(process.cwd(), 'src/solana/vanity/wasm/vanity_grinder_bg.wasm'),
		join(process.cwd(), 'dist/src/solana/vanity/wasm/vanity_grinder_bg.wasm'),
	);

	let lastErr;
	for (const p of candidates) {
		try {
			return readFileSync(p);
		} catch (err) {
			lastErr = err;
		}
	}
	throw Object.assign(
		new Error(
			`vanity grinder WASM not found in any known location (tried: ${candidates.join(', ')})`,
		),
		{ cause: lastErr, code: 'wasm_not_bundled' },
	);
}

function ensureWasm() {
	if (wasmReady) return;
	initSync({ module: readWasmBytes() });
	wasmReady = true;
}

/**
 * Estimate the combined difficulty (expected attempts) for a pattern.
 *
 * Uses the exact Base58 distribution rather than 58^length: the leading
 * character spans a 58× difficulty range, so a length-only estimate is wrong by
 * up to 17× in either direction. See
 * [base58-distribution.js](./base58-distribution.js).
 *
 * @param {string} prefix
 * @param {string} suffix
 * @param {boolean} [ignoreCase=false]
 * @returns {number}
 */
export function expectedAttemptsFor(prefix, suffix, ignoreCase = false) {
	return expectedAttempts(prefix || '', suffix || '', ignoreCase);
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

	assertKeypairFeasible(prefix, suffix, ignoreCase, timeBudgetMs);

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
