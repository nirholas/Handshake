/**
 * The true probability distribution of Base58-encoded Solana addresses.
 *
 * ── Why this module exists ───────────────────────────────────────────────────
 * Every difficulty, rarity, price and time estimate in the vanity product used
 * to assume each Base58 character is uniform: probability 1/58 per position, so
 * an n-character pattern costs 58ⁿ attempts. That is correct for *trailing*
 * characters and wrong for the *leading* one, because Base58 is a positional
 * numeral encoding of a 32-byte integer, not a string of independent symbols.
 *
 * A 32-byte value spans [0, 2²⁵⁶). Base58 encodes it in 44 digits when the value
 * is ≥ 58⁴³ and 43 digits otherwise, and 2²⁵⁶ / 58⁴³ ≈ 17.05 — so a 44-digit
 * encoding can only ever lead with one of the first 17 alphabet symbols, while
 * the ~5.9% of values short enough to encode in 43 digits can lead with anything.
 * The result is a 58× spread in how hard a leading character is to hit:
 *
 *     '2'…'H'  P ≈ 5.906e-2   (3.43× *easier* than the uniform model claims)
 *     'J'      P ≈ 1.434e-2   (0.83×)
 *     'K'…'z'  P ≈ 1.018e-3   (0.059× — 17× *harder* than claimed)
 *     '1'      P ≈ 3.906e-3   (a leading zero byte, 1/256)
 *
 * Measured against the uniform model on the live inventory, the median address
 * was 17× harder to grind than its stored difficulty claimed, and patterns
 * leading with '2'–'H' were up to 1.75× easier. Since price and rarity tier are
 * both derived from difficulty, the whole book was mispriced in both directions.
 *
 * ── What this module computes ────────────────────────────────────────────────
 * `prefixProbability` is *exact*, not an approximation or a fitted table: it
 * counts, with BigInt interval arithmetic, how many of the 2²⁵⁶ possible keys
 * encode to a string with the requested prefix. It handles leading-zero bytes
 * (which encode as '1') and arbitrary prefix lengths.
 *
 * Trailing characters genuinely are uniform — the low-order digits of a huge
 * uniform integer are equidistributed to within O(58ⁿ / 2²⁴⁸), far below double
 * precision — so `suffixProbability` stays 58⁻ⁿ.
 *
 * Pure and isomorphic: no I/O, no crypto, identical in browser and server.
 * Pinned against direct sampling of real keypairs in tests/vanity-rarity.test.js.
 */

export const BASE58_ALPHABET =
	'123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

const INDEX = new Map([...BASE58_ALPHABET].map((c, i) => [c, i]));

/** Solana public keys are 32 bytes; the encoded value space is [0, 2²⁵⁶). */
const KEY_BYTES = 32;
const TOTAL = 1n << BigInt(8 * KEY_BYTES);

/** Powers of 58 up to the longest encoding a 32-byte value can produce. */
const POW58 = [1n];
for (let i = 1; i <= 64; i++) POW58.push(POW58[i - 1] * 58n);

/**
 * Fixed-point scale for BigInt → Number conversion. 10²⁵ keeps ~16 significant
 * digits for probabilities as small as 58⁻⁶ × 1e-3 ≈ 3e-14, which is well past
 * the 6-character `MAX_PATTERN_LENGTH` ceiling.
 */
const SCALE = 10n ** 25n;
const SCALE_N = 1e25;

/**
 * Count the 32-byte values whose Base58 encoding begins with `prefix`.
 * @param {string} prefix
 * @returns {bigint} number of matching values in [0, 2²⁵⁶)
 */
function prefixCount(prefix) {
	if (!prefix) return TOTAL;
	for (const ch of prefix) {
		if (!INDEX.has(ch)) return 0n; // not a Base58 symbol — unreachable
	}

	// Leading '1's are leading *zero bytes*, not digits of the numeral.
	let zeros = 0;
	while (zeros < prefix.length && prefix[zeros] === '1') zeros++;
	if (zeros > KEY_BYTES) return 0n;
	const rest = prefix.slice(zeros);

	// All-'1' prefix: every value with at least that many leading zero bytes.
	if (rest === '') return TOTAL >> BigInt(8 * zeros);

	// Otherwise the zero-byte run must be *exactly* `zeros` long: the next
	// encoded character is rest[0], which is not '1'. So the remaining bytes
	// form a value with a non-zero leading byte.
	const width = KEY_BYTES - zeros;
	if (width < 1) return 0n;
	const lo = 1n << BigInt(8 * (width - 1));
	const hi = 1n << BigInt(8 * width);

	let value = 0n;
	for (const ch of rest) value = value * 58n + BigInt(INDEX.get(ch));

	// Strings of total length L that start with `rest` occupy the contiguous
	// integer range [value·58^(L-|rest|), (value+1)·58^(L-|rest|)). Those ranges
	// are disjoint across L, so the matches are their summed overlap with
	// [lo, hi). rest[0] ≠ '1' guarantees each range sits inside the band of
	// values that actually encode to length L, so no extra clamping is needed.
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

/**
 * Every Base58-valid case spelling of `pattern`.
 *
 * The alphabet omits `0 O I l`, so some letters have only one usable case:
 * a case-insensitive 'I' can only ever match a literal 'i'. Returns an empty
 * array when a character has no valid spelling at all.
 * @param {string} pattern
 * @returns {string[]}
 */
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

/**
 * Exact probability that a uniformly random Solana address starts with `prefix`.
 *
 * @param {string} prefix
 * @param {boolean} [ignoreCase=false]
 * @returns {number} probability in [0, 1]; 0 when the prefix is unreachable
 */
export function prefixProbability(prefix, ignoreCase = false) {
	if (!prefix) return 1;
	const variants = ignoreCase ? caseVariants(prefix) : [prefix];
	if (variants.length === 0) return 0;
	// Distinct spellings match disjoint value sets, so the counts simply add.
	let count = 0n;
	for (const variant of variants) count += prefixCount(variant);
	if (count === 0n) return 0;
	return Number((count * SCALE) / TOTAL) / SCALE_N;
}

/**
 * Probability that a uniformly random Solana address ends with `suffix`.
 *
 * Unlike the prefix, this really is 58⁻ⁿ: the low-order digits of a uniform
 * 256-bit integer are equidistributed to within O(58ⁿ / 2²⁴⁸), which is ~1e-64
 * at the 6-character ceiling — far below double precision.
 *
 * @param {string} suffix
 * @param {boolean} [ignoreCase=false]
 * @returns {number} probability in [0, 1]
 */
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

/**
 * Probability that a random address satisfies both ends of a vanity pattern.
 *
 * Prefix and suffix are treated as independent. For the 6-character ceiling on
 * each side that costs at most O(58¹² / 2²⁴⁸) ≈ 1e-53 of relative error.
 *
 * @param {object} pattern
 * @param {string} [pattern.prefix]
 * @param {string} [pattern.suffix]
 * @param {boolean} [pattern.ignoreCase=false]
 * @returns {number} probability in [0, 1]
 */
export function patternProbability({ prefix = '', suffix = '', ignoreCase = false } = {}) {
	return prefixProbability(prefix || '', ignoreCase) * suffixProbability(suffix || '', ignoreCase);
}

/**
 * The per-character leading probability table, for docs, UI hints and tests.
 * Keys are the 58 alphabet symbols; values are exact probabilities summing to 1.
 * @type {Readonly<Record<string, number>>}
 */
export const LEADING_CHAR_PROBABILITY = Object.freeze(
	Object.fromEntries([...BASE58_ALPHABET].map((c) => [c, prefixProbability(c, false)])),
);

/**
 * How much harder (>1) or easier (<1) a leading character is than the naive
 * uniform-1/58 model claims. Useful for explaining a quote to a buyer.
 * @param {string} ch
 * @returns {number}
 */
export function leadingCharDifficultyRatio(ch) {
	const p = LEADING_CHAR_PROBABILITY[ch];
	if (!p) return Infinity;
	return (1 / 58) / p;
}
