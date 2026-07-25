// Vendored from the three.ws monorepo: api/_lib/pump-vanity.js. Kept in sync
// by hand so this package is self-contained when published to npm. Do not edit
// here — edit the canonical api/_lib/pump-vanity.js and re-copy.

// Solana vanity address generator for pump.fun mint Keypairs.
//
// Vendored from nirholas/solana-wallet-toolkit (MIT) — TypeScript reference
// at typescript/src/lib/{generator,matcher,validation}.ts. Rewritten as a
// single JS module so it works inside Vercel's serverless runtime without
// a transpile step. Adds prefix + suffix + ignoreCase + async yielding so
// long prefixes don't block the event loop while we wait.

import { Keypair } from '@solana/web3.js';

// Solana base58 alphabet — excludes 0, O, I, l to avoid look-alikes.
export const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_CHARS = new Set(BASE58_ALPHABET);

const MAX_PATTERN_LENGTH = 6;
const DEFAULT_MAX_ITERATIONS = 2_000_000;
const YIELD_EVERY = 10_000;
// How often (in attempts) onProgress fires — aligned to a yield boundary. Kept
// in sync with the canonical api/_lib/pump-vanity.js.
const PROGRESS_EVERY = 25_000;

function validatePattern(pattern, label) {
	if (typeof pattern !== 'string' || pattern.length === 0) {
		throw vanityError('invalid_vanity', `${label} must be a non-empty string`);
	}
	if (pattern !== pattern.trim()) {
		throw vanityError('invalid_vanity', `${label} contains whitespace`);
	}
	if (pattern.length > MAX_PATTERN_LENGTH) {
		throw vanityError(
			'invalid_vanity',
			`${label} length ${pattern.length} exceeds max ${MAX_PATTERN_LENGTH} (would take an extremely long time)`,
		);
	}
	for (let i = 0; i < pattern.length; i++) {
		if (!BASE58_CHARS.has(pattern[i])) {
			throw vanityError(
				'invalid_vanity',
				`${label}: invalid base58 char '${pattern[i]}' at position ${i + 1}`,
			);
		}
	}
}

function vanityError(code, msg) {
	return Object.assign(new Error(msg), { status: 400, code });
}

export function isValidVanityPrefix(prefix) {
	if (!prefix || typeof prefix !== 'string') return false;
	if (prefix.length > MAX_PATTERN_LENGTH) return false;
	for (const c of prefix) if (!BASE58_CHARS.has(c)) return false;
	return true;
}

// Expected attempts under the exact Base58 distribution. Used by callers to set
// a reasonable maxIterations and to surface difficulty in error messages.
//
// This was 58^n (or 33^n when case-folding), which treats every position as an
// independent uniform symbol. That is right for a suffix and wrong for the
// leading character by up to 17×, see base58-distribution.js. Getting it wrong
// meant a "2-character" budget that clears `A?` in a second and cannot clear
// `z?` at all.
export { expectedAttempts as estimateAttempts } from './base58-distribution.js';

/**
 * Grind a Solana Keypair whose base58 address matches a prefix and/or suffix.
 *
 * @param {object} opts
 * @param {string} [opts.prefix]      — required base58 prefix
 * @param {string} [opts.suffix]      — required base58 suffix
 * @param {boolean} [opts.ignoreCase] — case-insensitive match
 * @param {number} [opts.maxIterations] — hard cap (default 2M)
 * @param {(sample:{iterations:number,elapsedMs:number,attemptsPerSec:number,sampleAddress:string})=>void} [opts.onProgress]
 *   — fired every PROGRESS_EVERY (25k) attempts with real, monotonic numbers.
 * @returns {Promise<{ keypair: Keypair, iterations: number, durationMs: number }>}
 */
export async function grindMintKeypair({
	prefix,
	suffix,
	ignoreCase = false,
	maxIterations = DEFAULT_MAX_ITERATIONS,
	onProgress,
	progressEvery = PROGRESS_EVERY,
} = {}) {
	if (!prefix && !suffix) {
		const kp = Keypair.generate();
		return { keypair: kp, iterations: 1, durationMs: 0 };
	}
	if (prefix) validatePattern(prefix, 'prefix');
	if (suffix) validatePattern(suffix, 'suffix');
	const sampleEvery = Math.max(1, Math.floor(progressEvery) || PROGRESS_EVERY);

	const targetPrefix = prefix ? (ignoreCase ? prefix.toLowerCase() : prefix) : null;
	const targetSuffix = suffix ? (ignoreCase ? suffix.toLowerCase() : suffix) : null;
	const pLen = targetPrefix?.length || 0;
	const sLen = targetSuffix?.length || 0;

	const start = Date.now();
	let lastProgressAt = start;
	let lastProgressAttempts = 0;

	for (let i = 1; i <= maxIterations; i++) {
		const kp = Keypair.generate();
		const addr = kp.publicKey.toBase58();

		// Emit a live progress sample from real numbers (kept in sync with the
		// canonical api/_lib/pump-vanity.js).
		if (onProgress && i % sampleEvery === 0) {
			const now = Date.now();
			const windowMs = now - lastProgressAt;
			const windowAttempts = i - lastProgressAttempts;
			const attemptsPerSec = windowMs > 0 ? (windowAttempts / windowMs) * 1000 : 0;
			lastProgressAt = now;
			lastProgressAttempts = i;
			try {
				onProgress({ iterations: i, elapsedMs: now - start, attemptsPerSec, sampleAddress: addr });
			} catch {
				// A misbehaving progress sink must never abort a paid grind.
			}
		}

		const head = ignoreCase ? addr.substring(0, pLen).toLowerCase() : addr.substring(0, pLen);
		if (targetPrefix && head !== targetPrefix) {
			if (i % YIELD_EVERY === 0) await new Promise((r) => setImmediate(r));
			continue;
		}
		const tail = ignoreCase ? addr.substring(addr.length - sLen).toLowerCase() : addr.substring(addr.length - sLen);
		if (targetSuffix && tail !== targetSuffix) {
			if (i % YIELD_EVERY === 0) await new Promise((r) => setImmediate(r));
			continue;
		}

		return { keypair: kp, iterations: i, durationMs: Date.now() - start };
	}

	throw Object.assign(
		new Error(
			`vanity ${prefix ? `prefix '${prefix}'` : ''}${prefix && suffix ? ' + ' : ''}${suffix ? `suffix '${suffix}'` : ''} not found in ${maxIterations} attempts (estimated ~${Math.round(estimateAttempts({ prefix, suffix, ignoreCase })).toLocaleString()})`,
		),
		{ status: 504, code: 'vanity_timeout' },
	);
}
