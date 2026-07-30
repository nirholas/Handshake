// The $THREE top-up must be sized against what the buyer actually needs, and a
// listing the tick cannot fund must be refused BEFORE any SOL is spent.
//
// The engine used to buy a fixed 0.012 SOL of $THREE regardless of the listing
// price. At roughly 100 $THREE per 0.012 SOL that covers almost nothing: skills
// list at 80-1200 $THREE and assets at 600-4000, so most of the marketplace was
// structurally unbuyable. Each attempt still paid a real trade fee, skipped with
// "still short on $THREE after top-up buy", and repeated on the next tick, so
// marketplace GMV read zero while fees went out the door.
//
// The cap matters as much as the sizing. planBudget prices the tick's paid
// actions at a fixed estimate, so an action that sizes its own spend has to stay
// inside its share of the treasury or it overspends the very budget it was
// planned from and starves the actions queued behind it.

import { describe, it, expect } from 'vitest';
import { planThreeTopUp } from '../api/_lib/circulation.js';

// Live-ish rate: 0.012 SOL bought 100.871486 $THREE (6 decimals) on 2026-07-26,
// so ~8_405_957_167 atomic units per SOL.
const RATE = 100_871_486 / 0.012;
const three = (whole) => (BigInt(whole) * 10n ** 6n).toString();

describe('planThreeTopUp', () => {
	it('buys nothing when the buyer already holds enough', () => {
		const r = planThreeTopUp({ needAtomic: three(200), haveAtomic: three(250), atomicPerSol: RATE, maxSol: 0.06 });
		expect(r.sufficient).toBe(true);
		expect(r.sol).toBe(0);
	});

	it('sizes the buy to the shortfall, not to a fixed slice', () => {
		// Needs 500, holds 100: the 400 shortfall costs ~0.0476 SOL + 8% headroom.
		const r = planThreeTopUp({ needAtomic: three(500), haveAtomic: three(100), atomicPerSol: RATE, maxSol: 0.09 });
		expect(r.sufficient).toBe(true);
		expect(r.sol).toBeGreaterThan(0.05);
		expect(r.sol).toBeLessThan(0.06);
		// The old behaviour: a fixed 0.012 could never have cleared this.
		expect(r.sol).toBeGreaterThan(0.012);
	});

	it('refuses without spending when the shortfall costs more than the cap', () => {
		// A 4000 $THREE asset needs ~0.48 SOL, far over a lean tick's share.
		const r = planThreeTopUp({ needAtomic: three(4000), haveAtomic: 0n, atomicPerSol: RATE, maxSol: 0.06 });
		expect(r.sufficient).toBe(false);
		expect(r.reason).toBe('above_cap');
		expect(r.sol).toBe(0);
		// The caller needs the real number to report why it skipped.
		expect(r.wantedSol).toBeGreaterThan(0.4);
	});

	it('never buys below the minimum probe size', () => {
		// A 1 $THREE shortfall is worth a fraction of a lamport of effort; the
		// floor keeps the buy above pump's dust threshold.
		const r = planThreeTopUp({ needAtomic: three(1), haveAtomic: 0n, atomicPerSol: RATE, maxSol: 0.06, minSol: 0.012 });
		expect(r.sufficient).toBe(true);
		expect(r.sol).toBe(0.012);
	});

	it('refuses when the quote produced no usable rate', () => {
		for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
			const r = planThreeTopUp({ needAtomic: three(100), haveAtomic: 0n, atomicPerSol: bad, maxSol: 0.06 });
			expect(r.sufficient).toBe(false);
			expect(r.reason).toBe('no_rate');
			expect(r.sol).toBe(0);
		}
	});

	it('treats the cap as a hard stop even when the shortfall is barely over it', () => {
		const need = three(500);
		const justUnder = planThreeTopUp({ needAtomic: need, haveAtomic: 0n, atomicPerSol: RATE, maxSol: 0.07 });
		expect(justUnder.sufficient).toBe(true);
		const justOver = planThreeTopUp({ needAtomic: need, haveAtomic: 0n, atomicPerSol: RATE, maxSol: justUnder.sol - 0.000001 });
		expect(justOver.sufficient).toBe(false);
		expect(justOver.reason).toBe('above_cap');
	});

	it('carries the shortfall through so a skip can report the real gap', () => {
		const r = planThreeTopUp({ needAtomic: three(900), haveAtomic: three(150), atomicPerSol: RATE, maxSol: 0.001 });
		expect(r.shortfallAtomic).toBe(three(750));
	});
});
