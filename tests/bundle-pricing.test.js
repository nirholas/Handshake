// Bundle pricing math.
//
// These are the numbers a seller reads before deciding what to charge, so a
// wrong one costs them real revenue. They are also the numbers the marketplace
// has no production rows to exercise: there is not a single multi-skill basket
// on the platform yet, precisely because bundles were unreachable until the
// routing fix. So the evidence path is pinned here rather than by observation.
//
// The DB half is verified separately: both queries in
// api/agents/[id]/bundles.js were run against the live schema on 2026-07-31, and
// the basket query was proved to exclude trial and bundle-access rows using real
// inserts under a sentinel reference, deleted afterwards.

import { describe, it, expect } from 'vitest';
import {
	median,
	simulatePrice,
	suggestPrice,
	toAtomic,
	DEFAULT_DISCOUNT,
} from '../api/_lib/bundle-pricing.js';

describe('toAtomic', () => {
	it('takes the three shapes an atomic amount arrives in', () => {
		expect(toAtomic(125000)).toBe(125000n);
		expect(toAtomic('125000')).toBe(125000n);
		expect(toAtomic(125000n)).toBe(125000n);
	});

	it('refuses a Number that has already lost digits instead of laundering it', () => {
		// 9007199254740993 cannot be represented: the literal is 9007199254740992
		// before this function is even called. Converting it would hand back a
		// string of the WRONG number, which is worse than failing.
		expect(() => toAtomic(9007199254740993)).toThrow(/not an exact integer/);
		expect(() => toAtomic(1.5)).toThrow(/not an exact integer/);
		expect(() => toAtomic('1.5')).toThrow(/not an integer/);
		expect(() => toAtomic(null)).toThrow(/not an integer/);
	});

	it('carries a value past Number.MAX_SAFE_INTEGER digit for digit', () => {
		expect(toAtomic('9007199254740993')).toBe(9007199254740993n);
	});
});

describe('median', () => {
	it('is null for no history, so callers must handle the empty case explicitly', () => {
		expect(median([])).toBeNull();
	});

	it('takes the middle of an odd list', () => {
		expect(median([100, 200, 900])).toBe(200n);
	});

	it('averages the two middles of an even list, rounded to a spendable integer', () => {
		// 100000 and 150000 average to 125000 exactly.
		expect(median([100000, 150000])).toBe(125000n);
		// An odd sum must not leak a fraction into a price.
		expect(median([100, 101])).toBe(101n);
	});

	it('averages two baskets that no float could add', () => {
		// Both baskets sit above Number.MAX_SAFE_INTEGER; their sum is larger still.
		expect(median(['9007199254740993', '9007199254740995'])).toBe(9007199254740994n);
	});
});

describe('suggestPrice', () => {
	it('anchors on the median basket when buyers have real history', () => {
		// Two real baskets, measured in the rolled-back probe: one buyer took two
		// skills for 100000, another took three for 150000.
		const s = suggestPrice(150000, [100000, 150000]);
		expect(s.basis).toBe('median_basket');
		expect(s.price).toBe(125000n);
		expect(s.median_basket).toBe(125000n);
	});

	it('never prices a bundle above buying the parts one at a time', () => {
		// A population that historically overspent (repeat buys, time passes) can
		// push the median past list. A bundle that costs more than the sum is not a
		// bundle, so the suggestion is capped.
		const s = suggestPrice(150000, [400000, 500000]);
		expect(s.price).toBe(150000n);
		// The raw median is still reported, so the cap is visible rather than hidden.
		expect(s.median_basket).toBe(450000n);
	});

	it('falls back to a labelled discount when there is no history to learn from', () => {
		const s = suggestPrice(150000, []);
		expect(s.basis).toBe('discount_off_list');
		expect(s.price).toBe(BigInt(Math.round(150000 * DEFAULT_DISCOUNT)));
		// null, not 0: a seller must be able to tell "no evidence" from "median 0".
		expect(s.median_basket).toBeNull();
	});

	it('never suggests a free bundle', () => {
		// Rounding a tiny sum toward zero would publish a giveaway as a price.
		expect(suggestPrice(1, []).price).toBe(1n);
		expect(suggestPrice(2, []).price).toBeGreaterThan(0n);
	});

	it('discounts a sum no float could hold, exactly', () => {
		// 20% off 9007199254740995 is 7205759403792796, which a float would round
		// to ...800. One atomic unit of $THREE is not much; a price that changes
		// depending on how it was computed is.
		expect(suggestPrice('9007199254740995', []).price).toBe(7205759403792796n);
	});

	it('does not mutate the caller\'s basket array', () => {
		// The handler reuses this array for simulatePrice; an in-place sort here
		// would reorder it underneath that call.
		const baskets = [300, 100, 200];
		suggestPrice(1000, baskets);
		expect(baskets).toEqual([300, 100, 200]);
	});
});

describe('simulatePrice', () => {
	const baskets = [100000, 150000];

	it('backtests revenue against what those buyers actually paid', () => {
		// At 125000, two historical buyers would have paid 250000; they paid 250000.
		const s = simulatePrice(125000, 150000, baskets);
		expect(s.backtest_revenue_atomic).toBe('250000');
		expect(s.revenue_delta_atomic).toBe('0');
	});

	it('reports a loss as a negative delta rather than hiding it', () => {
		// Underpricing is the mistake a discount rule of thumb makes, so it has to
		// be legible: at 90000 the bundle collects 180000 against 250000 actual.
		const s = simulatePrice(90000, 150000, baskets);
		expect(s.revenue_delta_atomic).toBe('-70000');
	});

	it('counts only the buyers who would have come out ahead', () => {
		// At 120000 the 150000 basket wins, the 100000 basket does not.
		expect(simulatePrice(120000, 150000, baskets).buyers_better_off).toBe(1);
		// Strictly greater: a buyer who paid exactly the bundle price gained nothing.
		expect(simulatePrice(100000, 150000, baskets).buyers_better_off).toBe(1);
		expect(simulatePrice(150000, 150000, baskets).buyers_better_off).toBe(0);
	});

	it('reports the discount to one decimal place', () => {
		const s = simulatePrice(125000, 150000, baskets);
		expect(s.discount_atomic).toBe('25000');
		expect(s.discount_percent).toBe(16.7);
	});

	it('reports a price above the sum of the parts as a negative discount', () => {
		// The page renders this as "above the sum of the parts", so the sign has to
		// survive the percentage math rather than being lost to an abs().
		const s = simulatePrice(180000, 150000, baskets);
		expect(s.discount_atomic).toBe('-30000');
		expect(s.discount_percent).toBe(-20);
	});

	it('returns zero revenue, not NaN, when there is no history', () => {
		const s = simulatePrice(125000, 150000, []);
		expect(s.backtest_revenue_atomic).toBe('0');
		expect(s.revenue_delta_atomic).toBe('0');
		expect(s.buyers_better_off).toBe(0);
	});

	it('does not divide by zero when nothing in the bundle has a list price', () => {
		expect(simulatePrice(500, 0, []).discount_percent).toBe(0);
	});

	it('computes revenue on a 9-decimal mint without losing a single unit', () => {
		// 9007199254740993 atomic units exceeds Number.MAX_SAFE_INTEGER. Stringifying
		// a Number result here would be theater: the rounding happens during the
		// multiply, long before String() is reached. Three buyers at that price is
		// 27021597764222979, which no float can represent.
		const big = '9007199254740993';
		const s = simulatePrice(big, big, [big, big, big]);
		expect(s.price).toBe('9007199254740993');
		expect(s.backtest_revenue_atomic).toBe('27021597764222979');
		// They paid the same, so the bundle changes nothing: exactly zero, not a
		// residue of two rounded 17-digit numbers being subtracted.
		expect(s.revenue_delta_atomic).toBe('0');
		expect(s.discount_atomic).toBe('0');
	});

	it('keeps one atomic unit of difference visible past MAX_SAFE_INTEGER', () => {
		// The whole point: a one-unit underprice on a huge basket must not vanish.
		const s = simulatePrice('9007199254740992', '9007199254740993', ['9007199254740993']);
		expect(s.discount_atomic).toBe('1');
		expect(s.revenue_delta_atomic).toBe('-1');
		expect(s.buyers_better_off).toBe(1);
	});
});
