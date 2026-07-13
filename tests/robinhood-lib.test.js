// Pure-function unit tests for api/_lib/robinhood.js helpers — unmocked
// (the module's I/O-bearing exports are covered via mocks in
// tests/api/v1-robinhood.test.js; this file pins the arithmetic itself).

import { describe, it, expect } from 'vitest';
import { premiumPct } from '../api/_lib/robinhood.js';

describe('premiumPct', () => {
	it('computes a signed percentage premium/discount', () => {
		expect(premiumPct(105, 100)).toBeCloseTo(5, 6);
		expect(premiumPct(95, 100)).toBeCloseTo(-5, 6);
	});

	it('returns null — not -100% — when the DEX price is missing', () => {
		// Regression: Number(null) === 0, which is finite, so a naive
		// `!Number.isFinite(Number(dexUsd))` guard let a missing DEX price fall
		// through as amountOut=0 and compute a fake "-100% premium" for every
		// Stock Token with no Uniswap pool yet.
		expect(premiumPct(null, 100)).toBeNull();
		expect(premiumPct(undefined, 100)).toBeNull();
	});

	it('returns null when the NAV price is missing or non-positive', () => {
		expect(premiumPct(100, null)).toBeNull();
		expect(premiumPct(100, undefined)).toBeNull();
		expect(premiumPct(100, 0)).toBeNull();
		expect(premiumPct(100, -5)).toBeNull();
	});

	it('returns null for non-numeric input', () => {
		expect(premiumPct('not a number', 100)).toBeNull();
		expect(premiumPct(100, 'not a number')).toBeNull();
	});
});
