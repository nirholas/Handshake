/**
 * Base58 validation for Solana vanity prefixes/suffixes.
 *
 * Algorithm ported from nirholas/solana-wallet-toolkit
 * (typescript/src/lib/validation.ts). The toolkit excludes the four
 * commonly-confused characters (0, O, I, l) per the Bitcoin/Solana
 * Base58 alphabet.
 */

import { BASE58_ALPHABET, patternProbability } from './base58-distribution.js';

export { BASE58_ALPHABET };

const BASE58_CHARS = new Set(BASE58_ALPHABET);

const CONFUSED = {
	'0': '0 (zero) — use 1-9',
	O:   'O (uppercase o) — use other uppercase letters',
	I:   'I (uppercase i) — use other uppercase letters',
	l:   'l (lowercase L) — use other lowercase letters',
};

/** Hard ceiling regardless of paywall — past this, grinding is unrealistic in-browser. */
export const MAX_PATTERN_LENGTH = 6;

/** Length below which vanity is free; >= FREE_THRESHOLD requires the paid product. */
export const FREE_THRESHOLD = 5;

/**
 * Validate a vanity pattern (prefix or suffix).
 * @param {string} pattern
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validatePattern(pattern) {
	const errors = [];
	if (typeof pattern !== 'string' || pattern.length === 0) {
		return { valid: false, errors: ['pattern is empty'] };
	}
	if (pattern !== pattern.trim()) {
		errors.push('pattern has leading or trailing whitespace');
	}
	if (pattern.length > MAX_PATTERN_LENGTH) {
		errors.push(`length ${pattern.length} exceeds maximum of ${MAX_PATTERN_LENGTH}`);
	}
	for (let i = 0; i < pattern.length; i++) {
		const c = pattern[i];
		if (!BASE58_CHARS.has(c)) {
			const hint = CONFUSED[c];
			errors.push(`invalid character '${c}' at position ${i + 1}${hint ? ` — ${hint}` : ''}`);
		}
	}
	return { valid: errors.length === 0, errors };
}

/**
 * Estimate expected attempts to find a Base58 prefix of the given length.
 * @param {number} length
 * @returns {number}
 */
export function estimateAttempts(length) {
	return Math.pow(58, length);
}

/**
 * How many of the 58 Base58 characters satisfy a single requested character.
 *
 * Case-sensitive matching: exactly one. Case-insensitive matching: two when
 * the character is a letter whose other case is *also* a valid Base58 symbol
 * (the alphabet drops `0 O I l`, so e.g. `o`/`O`, `i`/`I`, `L`/`l` only have a
 * single valid case and stay at one).
 * @param {string} ch
 * @param {boolean} ignoreCase
 * @returns {number}
 */
function matchesPerChar(ch, ignoreCase) {
	if (!ignoreCase) return 1;
	const lower = ch.toLowerCase();
	const upper = ch.toUpperCase();
	if (lower !== upper && BASE58_CHARS.has(lower) && BASE58_CHARS.has(upper)) return 2;
	return 1;
}

/**
 * Identifier for the difficulty model a quote, price or certificate was
 * computed under. Certificates carry this string inside their signed
 * `difficulty` block so a receipt issued under the old model still verifies
 * against the model it was actually issued under.
 *
 *   v1 `58^effectiveLength` — every character uniform at 1/58. Correct for
 *      suffixes, wrong for the leading character by up to 17× (see
 *      base58-distribution.js). Retained for verification only.
 *   v2 `base58-exact/v2`    — exact Base58 positional distribution.
 */
export const DIFFICULTY_MODEL_V1 = '58^effectiveLength';
export const DIFFICULTY_MODEL_V2 = 'base58-exact/v2';
export const DIFFICULTY_MODEL = DIFFICULTY_MODEL_V2;

/**
 * Expected attempts to grind an address that starts with `prefix` and ends
 * with `suffix` — the mean of a geometric distribution, i.e. the reciprocal of
 * the per-address match probability under the exact Base58 distribution.
 *
 * The leading character is *not* uniform (Base58 is a positional encoding of a
 * 256-bit integer, so a 44-digit encoding can only lead with the first 17
 * symbols). `patternProbability` accounts for that exactly; see
 * [base58-distribution.js](./base58-distribution.js) for the derivation.
 *
 * @param {string} [prefix]
 * @param {string} [suffix]
 * @param {boolean} [ignoreCase=false]
 * @returns {number} expected attempts; `Infinity` for an unreachable pattern
 */
export function expectedAttempts(prefix = '', suffix = '', ignoreCase = false) {
	const p = patternProbability({ prefix: prefix || '', suffix: suffix || '', ignoreCase });
	return p > 0 ? 1 / p : Infinity;
}

/**
 * The superseded uniform-1/58 model, kept so certificates and inventory priced
 * before the correction still verify against the model they were issued under.
 * Do not use for new quotes — see `expectedAttempts`.
 *
 * @param {string} [prefix]
 * @param {string} [suffix]
 * @param {boolean} [ignoreCase=false]
 * @returns {number}
 */
export function expectedAttemptsUniform(prefix = '', suffix = '', ignoreCase = false) {
	let attempts = 1;
	for (const ch of (prefix || '') + (suffix || '')) {
		attempts *= 58 / matchesPerChar(ch, ignoreCase);
	}
	return attempts;
}

/**
 * Resolve the difficulty function for a model identifier.
 * @param {string} [model] identifier from a certificate's `difficulty.model`
 * @returns {(prefix?: string, suffix?: string, ignoreCase?: boolean) => number}
 */
export function difficultyModel(model) {
	return model === DIFFICULTY_MODEL_V1 ? expectedAttemptsUniform : expectedAttempts;
}

/**
 * The case-sensitive prefix length whose difficulty matches the given
 * expected-attempts count — i.e. log₅₈(attempts). Used to tier patterns
 * (fast vs. slow) consistently whether or not case-insensitivity is on.
 * @param {number} attempts
 * @returns {number}
 */
export function effectiveLength(attempts) {
	return attempts <= 1 ? 0 : Math.log(attempts) / Math.log(58);
}

/**
 * Format a duration estimate (seconds) as a human string.
 * @param {number} attempts expected attempts
 * @param {number} ratePerSecond combined rate across worker pool
 * @returns {string}
 */
export function formatTimeEstimate(attempts, ratePerSecond) {
	if (!ratePerSecond || ratePerSecond <= 0) return 'unknown';
	const seconds = attempts / ratePerSecond;
	if (seconds < 1)        return 'less than a second';
	if (seconds < 60)       return `~${Math.round(seconds)} seconds`;
	if (seconds < 3600)     return `~${Math.round(seconds / 60)} minutes`;
	if (seconds < 86400)    return `~${Math.round(seconds / 3600)} hours`;
	if (seconds < 31536000) return `~${Math.round(seconds / 86400)} days`;
	return `~${Math.round(seconds / 31536000)} years`;
}
