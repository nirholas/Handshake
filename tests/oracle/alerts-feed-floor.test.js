// Oracle Telegram feed floor: unit tests.
//
// The channel feed posts a coin when it crosses the tier floor OR the raw
// score floor. The score path is load-bearing: the live score distribution
// tops out below the strong tier (72), so a tier-only gate would leave the
// channel permanently silent. These tests pin the default gate (strong tier
// OR score ≥ 56, the Lean boundary from conviction.js TIERS).

import { describe, it, expect } from 'vitest';
import { feedEligible } from '../../api/_lib/oracle/alerts.js';

describe('feedEligible', () => {
	it('passes prime and strong tiers regardless of score', () => {
		expect(feedEligible({ tier: 'prime', score: 90 })).toBe(true);
		expect(feedEligible({ tier: 'strong', score: 72 })).toBe(true);
	});

	it('passes a lean coin at or above the score floor', () => {
		expect(feedEligible({ tier: 'lean', score: 56 })).toBe(true);
		expect(feedEligible({ tier: 'lean', score: 63 })).toBe(true);
	});

	it('rejects coins below both floors', () => {
		expect(feedEligible({ tier: 'watch', score: 55 })).toBe(false);
		expect(feedEligible({ tier: 'avoid', score: 12 })).toBe(false);
		expect(feedEligible({ tier: 'lean', score: 40 })).toBe(false);
	});

	it('handles missing or malformed fields without throwing', () => {
		expect(feedEligible({})).toBe(false);
		expect(feedEligible(null)).toBe(false);
		expect(feedEligible({ tier: 'nope', score: 'NaN' })).toBe(false);
		expect(feedEligible({ tier: 'unknown', score: 99 })).toBe(true);
	});
});
