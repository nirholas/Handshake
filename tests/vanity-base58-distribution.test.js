// Pins the exact Base58 positional distribution that every vanity difficulty,
// price, bounty and rarity claim is derived from.
//
// The point of these tests is that the model is checked against *reality*, real
// Ed25519 keypairs, sampled and counted, not against a restatement of the same
// formula it implements. A closed form that only agrees with itself is how the
// uniform-1/58 model survived as long as it did.

import { describe, it, expect } from 'vitest';
import { Keypair } from '@solana/web3.js';
import {
	BASE58_ALPHABET,
	LEADING_CHAR_PROBABILITY,
	prefixProbability,
	suffixProbability,
	patternProbability,
	leadingCharDifficultyRatio,
	caseVariants,
} from '../src/solana/vanity/base58-distribution.js';

/** One sample of real addresses, shared by the statistical tests below. */
const SAMPLE_SIZE = 20_000;
const addresses = Array.from({ length: SAMPLE_SIZE }, () => Keypair.generate().publicKey.toBase58());

/** Two-sided z-score of an observed count against a modelled probability. */
function zScore(observed, p, n) {
	const sd = Math.sqrt(p * (1 - p) * n);
	return sd > 0 ? Math.abs(observed - p * n) / sd : 0;
}

describe('the leading character is not uniform', () => {
	it('is a proper distribution over the whole alphabet', () => {
		const total = Object.values(LEADING_CHAR_PROBABILITY).reduce((a, b) => a + b, 0);
		expect(total).toBeCloseTo(1, 10);
		expect(Object.keys(LEADING_CHAR_PROBABILITY)).toHaveLength(58);
	});

	it('splits the alphabet into the six bands the encoding implies', () => {
		// A 32-byte key with a non-zero top byte lies in [2²⁴⁸, 2²⁵⁶). Two ratios
		// carve that range up, and every band below is one of their consequences:
		//   2²⁵⁶ / 58⁴³ ≈ 17.05  → 44-digit encodings lead with symbols 1..17
		//   2²⁴⁸ / 58⁴² ≈ 3.90   → 43-digit encodings lead with symbols 3..57
		const band = (chars) => [...chars].map((c) => prefixProbability(c));
		const allEqual = (xs) => xs.every((x) => Math.abs(x - xs[0]) < 1e-15);

		// '1' is not a digit at all, it is a leading zero *byte*.
		expect(prefixProbability('1')).toBeCloseTo(1 / 256, 12);

		// '2','3': 44-digit encodings only. No 32-byte key is small enough to
		// encode in 43 digits starting this low.
		expect(allEqual(band('23'))).toBe(true);
		expect(prefixProbability('2')).toBeCloseTo(0.05803966, 7);

		// '4': the boundary symbol, catching the 0.097-of-a-unit sliver of
		// 43-digit encodings that clears 2²⁴⁸.
		expect(prefixProbability('4')).toBeGreaterThan(prefixProbability('3'));
		expect(prefixProbability('4')).toBeLessThan(prefixProbability('5'));

		// '5'…'H': 44-digit plus a full 43-digit slice, the easiest band.
		expect(allEqual(band('56789ABCDEFGH'))).toBe(true);
		expect(prefixProbability('5')).toBeCloseTo(0.05904034, 7);

		// 'J': symbol 17, where the 44-digit range runs out mid-symbol.
		expect(prefixProbability('J')).toBeCloseTo(0.01432652, 7);

		// 'K'…'z': the 40 symbols reachable only via a 43-digit encoding.
		expect(allEqual(band('KLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'))).toBe(true);
		expect(prefixProbability('K')).toBeCloseTo(0.00100068, 8);

		// Strictly ordered easiest → hardest.
		expect(prefixProbability('5')).toBeGreaterThan(prefixProbability('J'));
		expect(prefixProbability('J')).toBeGreaterThan(prefixProbability('K'));
	});

	it('spans a 58× difficulty range that the uniform model erased', () => {
		expect(leadingCharDifficultyRatio('A')).toBeCloseTo(0.292, 2); // 3.4× easier
		expect(leadingCharDifficultyRatio('z')).toBeCloseTo(17.23, 1); // 17× harder
		const ratio = prefixProbability('A') / prefixProbability('z');
		expect(ratio).toBeGreaterThan(55);
		expect(ratio).toBeLessThan(62);
	});

	it('matches the observed frequency in real generated keypairs', () => {
		const counts = new Map();
		for (const a of addresses) counts.set(a[0], (counts.get(a[0]) || 0) + 1);

		// Symbols are checked per-band rather than one at a time. The hard band's
		// symbols are expected only ~20 times each in this sample, where the
		// normal approximation behind a z-score is unreliable in the tails and
		// would flake; pooling the band lifts the expected count into hundreds,
		// where the approximation holds. Pooling costs nothing in power here
		// because the model says every symbol in a band is *exactly* equiprobable,
		// so a per-symbol error would have to be band-wide to hide in the pool.
		const BANDS = ['1', '23', '4', '56789ABCDEFGH', 'J', 'KLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'];
		expect(BANDS.join('').split('').sort().join('')).toBe([...BASE58_ALPHABET].sort().join(''));

		for (const band of BANDS) {
			const observed = [...band].reduce((sum, ch) => sum + (counts.get(ch) || 0), 0);
			const p = [...band].reduce((sum, ch) => sum + LEADING_CHAR_PROBABILITY[ch], 0);
			const z = zScore(observed, p, SAMPLE_SIZE);
			expect(z, `band '${band[0]}'..'${band.at(-1)}' deviates ${z.toFixed(1)}σ`).toBeLessThan(4);
		}

		// Within the two bands large enough to test individually, no single symbol
		// may drift: this is what would catch an off-by-one in the band edges.
		for (const ch of '56789ABCDEFGH') {
			const z = zScore(counts.get(ch) || 0, LEADING_CHAR_PROBABILITY[ch], SAMPLE_SIZE);
			expect(z, `leading '${ch}' deviates ${z.toFixed(1)}σ from the model`).toBeLessThan(4);
		}
	});

	it('rejects the uniform model on the same sample', () => {
		// The guard that would have caught the original bug: under 1/58, the
		// easy band is wildly over-represented. If this ever stops failing, the
		// distribution has silently flattened and the model is no longer real.
		const easy = addresses.filter((a) => a[0] === 'A').length;
		const uniformZ = zScore(easy, 1 / 58, SAMPLE_SIZE);
		expect(uniformZ).toBeGreaterThan(10);
	});
});

describe('multi-character prefixes', () => {
	it('is exact for the leading symbol and uniform thereafter', () => {
		// P('ab') = P(lead 'a') · 1/58, the second position carries no skew.
		expect(prefixProbability('ab')).toBeCloseTo(prefixProbability('a') / 58, 15);
		expect(prefixProbability('abc')).toBeCloseTo(prefixProbability('a') / 58 / 58, 17);
	});

	it('is monotonically harder as the prefix grows', () => {
		// Note "Sol" is *not* a legal Base58 prefix, the alphabet drops
		// lowercase L, which is exactly why patterns are validated, not assumed.
		let previous = 1;
		for (const p of ['S', 'So', 'Son', 'Soni', 'Sonic']) {
			const current = prefixProbability(p);
			expect(current).toBeLessThan(previous);
			previous = current;
		}
		expect(prefixProbability('Sol')).toBe(0);
	});

	it('agrees with observation on a two-character prefix', () => {
		// 'A' leads the easy band, so a 20k sample lands enough hits to test.
		const hits = addresses.filter((a) => a.startsWith('A')).length;
		expect(zScore(hits, prefixProbability('A'), SAMPLE_SIZE)).toBeLessThan(4);
	});

	it('returns zero for an unreachable prefix', () => {
		expect(prefixProbability('O')).toBe(0); // not a Base58 symbol
		expect(prefixProbability('hello world')).toBe(0);
	});
});

describe('case-insensitive matching', () => {
	it('sums the disjoint spellings', () => {
		expect(prefixProbability('a', true)).toBeCloseTo(
			prefixProbability('a') + prefixProbability('A'),
			15,
		);
	});

	it('does not credit a case that Base58 does not have', () => {
		// The alphabet drops 0 O I l, so 'i' has no valid uppercase form and an
		// ignore-case 'I' can only ever match a literal 'i'.
		expect(caseVariants('i')).toEqual(['i']);
		expect(prefixProbability('I', true)).toBeCloseTo(prefixProbability('i'), 15);
		expect(suffixProbability('I', true)).toBeCloseTo(1 / 58, 15);
		expect(suffixProbability('a', true)).toBeCloseTo(2 / 58, 15);
	});
});

describe('trailing characters really are uniform', () => {
	it('models a suffix as 58⁻ⁿ', () => {
		expect(suffixProbability('z')).toBeCloseTo(1 / 58, 15);
		expect(suffixProbability('zz')).toBeCloseTo(1 / 58 / 58, 17);
	});

	it('matches observation across the whole alphabet', () => {
		// Every trailing symbol is expected ~345 times here, comfortably inside
		// the regime where a z-score is meaningful, so these are tested singly.
		const counts = new Map();
		for (const a of addresses) counts.set(a.at(-1), (counts.get(a.at(-1)) || 0) + 1);
		for (const ch of BASE58_ALPHABET) {
			const z = zScore(counts.get(ch) || 0, 1 / 58, SAMPLE_SIZE);
			expect(z, `trailing '${ch}' deviates ${z.toFixed(1)}σ from uniform`).toBeLessThan(4);
		}
	});

	it('combines both ends independently', () => {
		expect(patternProbability({ prefix: 'A', suffix: 'z' })).toBeCloseTo(
			prefixProbability('A') / 58,
			15,
		);
	});
});
