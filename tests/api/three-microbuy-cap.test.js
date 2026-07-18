// The safety-critical sizing rule for the $THREE micro-buy daily cap. Pure BigInt
// math — the one place "never spend past the ceiling" is decided, used by both the
// Redis fast path and the DB fallback in api/_lib/token/microbuy.js. If this rule is
// wrong, the micro-buy loop can overspend real USDC, so it is pinned here.

import { describe, it, expect } from 'vitest';
import { wouldExceedCap, usdToUsdcAtomics } from '../../api/_lib/token/buyback-math.js';

describe('wouldExceedCap — micro-buy daily cap rule', () => {
	const cap = usdToUsdcAtomics(50); // $50 daily ceiling → 50_000_000 atomics
	const buy = usdToUsdcAtomics(0.01); // $0.01 per buy → 10_000 atomics

	it('allows a buy strictly under the cap', () => {
		expect(wouldExceedCap(0n, buy, cap)).toBe(false);
		expect(wouldExceedCap(cap - buy, buy, cap)).toBe(false); // exactly fills the cap
	});

	it('refuses the buy that would cross the cap', () => {
		expect(wouldExceedCap(cap, buy, cap)).toBe(true); // already at the cap
		expect(wouldExceedCap(cap - buy + 1n, buy, cap)).toBe(true); // one atomic over
	});

	it('is exact at the boundary — the last affordable buy fills the cap precisely', () => {
		// $50 / $0.01 = 5000 buys. The 5000th fills it; the 5001st is refused.
		let spent = 0n;
		let allowed = 0;
		for (let i = 0; i < 6000; i++) {
			if (wouldExceedCap(spent, buy, cap)) break;
			spent += buy;
			allowed += 1;
		}
		expect(allowed).toBe(5000);
		expect(spent).toBe(cap);
	});

	it('accepts string / number / bigint atomics interchangeably', () => {
		expect(wouldExceedCap('49990000', 10000, cap)).toBe(false); // $49.99 + $0.01 = $50.00
		expect(wouldExceedCap('49990001', 10000, cap)).toBe(true); // one atomic over
	});

	it('a zero cap refuses any positive buy but allows a zero buy', () => {
		expect(wouldExceedCap(0n, buy, 0n)).toBe(true);
		expect(wouldExceedCap(0n, 0n, 0n)).toBe(false);
	});
});
