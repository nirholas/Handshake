// The true probability distribution of Base58-encoded Solana addresses.
//
// Base58 is a positional encoding of a 256-bit integer, not a string of
// independent symbols, so the LEADING character is not uniform. 2²⁵⁶/58⁴³ ≈
// 17.05 means a 44-digit encoding can only lead with one of the first 17
// symbols, while the ~5.9% of keys small enough to encode in 43 digits can lead
// with anything. The spread across the alphabet is 58×:
//
//     '2'…'H'  P ≈ 5.9e-2   (~3.4× easier than a uniform 1/58 model claims)
//     'J'      P ≈ 1.4e-2
//     'K'…'z'  P ≈ 1.0e-3   (~17× harder)
//     '1'      P = 1/256     (a leading zero byte, not a digit)
//
// Trailing characters genuinely are uniform, so a suffix stays 58⁻ⁿ.
//
// This file is a deliberate standalone copy of
// src/solana/vanity/base58-distribution.js: the MCP server ships as its own
// zero-dependency npm package and cannot import from the site source. The two
// are held in agreement by tests/vanity-model-parity.test.js.

export const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

const INDEX = new Map([...BASE58_ALPHABET].map((c, i) => [c, i]));
const KEY_BYTES = 32;
const TOTAL = 1n << BigInt(8 * KEY_BYTES);
const POW58 = [1n];
for (let i = 1; i <= 64; i++) POW58.push(POW58[i - 1] * 58n);
const SCALE = 10n ** 25n;

/** Count the 32-byte values whose Base58 encoding begins with `prefix`. */
function prefixCount(prefix) {
	if (!prefix) return TOTAL;
	for (const ch of prefix) if (!INDEX.has(ch)) return 0n;

	// Leading '1's are leading zero BYTES, not digits of the numeral.
	let zeros = 0;
	while (zeros < prefix.length && prefix[zeros] === '1') zeros++;
	if (zeros > KEY_BYTES) return 0n;
	const rest = prefix.slice(zeros);
	if (rest === '') return TOTAL >> BigInt(8 * zeros);

	const width = KEY_BYTES - zeros;
	if (width < 1) return 0n;
	const lo = 1n << BigInt(8 * (width - 1));
	const hi = 1n << BigInt(8 * width);

	let value = 0n;
	for (const ch of rest) value = value * 58n + BigInt(INDEX.get(ch));

	let count = 0n;
	for (let pad = 0; pad + rest.length <= 64; pad++) {
		const unit = POW58[pad];
		const start = value * unit;
		if (start >= hi) break;
		const end = (value + 1n) * unit;
		const a = start > lo ? start : lo;
		const b = end < hi ? end : hi;
		if (b > a) count += b - a;
	}
	return count;
}

/** Every Base58-valid case spelling of `pattern` (empty when unreachable). */
export function caseVariants(pattern) {
	let out = [''];
	for (const ch of pattern) {
		const lower = ch.toLowerCase();
		const upper = ch.toUpperCase();
		const set = new Set();
		if (INDEX.has(ch)) set.add(ch);
		if (lower !== upper) {
			if (INDEX.has(lower)) set.add(lower);
			if (INDEX.has(upper)) set.add(upper);
		}
		if (set.size === 0) return [];
		const options = [...set];
		out = out.flatMap((head) => options.map((c) => head + c));
	}
	return out;
}

/** Exact probability that a random Solana address starts with `prefix`. */
export function prefixProbability(prefix, ignoreCase = false) {
	if (!prefix) return 1;
	const variants = ignoreCase ? caseVariants(prefix) : [prefix];
	if (variants.length === 0) return 0;
	let count = 0n;
	for (const variant of variants) count += prefixCount(variant);
	if (count === 0n) return 0;
	return Number((count * SCALE) / TOTAL) / 1e25;
}

/** Probability that a random Solana address ends with `suffix` (uniform 58⁻ⁿ). */
export function suffixProbability(suffix, ignoreCase = false) {
	if (!suffix) return 1;
	let p = 1;
	for (const ch of suffix) {
		const lower = ch.toLowerCase();
		const upper = ch.toUpperCase();
		const set = new Set();
		if (INDEX.has(ch)) set.add(ch);
		if (lower !== upper && ignoreCase) {
			if (INDEX.has(lower)) set.add(lower);
			if (INDEX.has(upper)) set.add(upper);
		}
		if (set.size === 0) return 0;
		p *= set.size / 58;
	}
	return p;
}

/** Expected attempts for a vanity pattern; Infinity when unreachable. */
export function expectedAttempts({ prefix = '', suffix = '', ignoreCase = false } = {}) {
	const p = prefixProbability(prefix || '', ignoreCase) * suffixProbability(suffix || '', ignoreCase);
	return p > 0 ? 1 / p : Infinity;
}
