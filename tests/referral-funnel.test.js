/**
 * Referral share funnel: getReferralFunnel() unit tests.
 *
 * The funnel is the read side of POST /api/referral/visit: without it the
 * referral_visits table is write-only and the visit → signup → activation loop
 * is unmeasurable. These tests pin the three counts to the three queries that
 * produce them, the lookback clamp, and the "empty prior stage" rule that makes
 * a conversion rate null instead of a fake 0%.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Counts returned by each of the funnel's three queries, keyed by the table the
// query reads. Each test sets these, then asserts on the derived payload.
const dbState = { visits: 0, signups: 0, activations: 0 };
// Every interval literal the queries bind, so the lookback clamp is observable.
const boundSince = [];

vi.mock('../api/_lib/db.js', () => ({
	sql: vi.fn(async (strings, ...values) => {
		const q = strings.join('?').toLowerCase();
		for (const v of values) if (v instanceof Date) boundSince.push(v);
		if (/from referral_visits/.test(q)) return [{ count: dbState.visits }];
		if (/from credit_ledger/.test(q)) return [{ count: dbState.activations }];
		if (/from users/.test(q)) return [{ count: dbState.signups }];
		return [];
	}),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

vi.mock('../api/_lib/cache.js', () => ({
	cacheWrap: async (_key, _ttl, fn) => fn(),
}));

vi.mock('../api/_lib/email.js', () => ({
	sendReferralCommissionEmail: async () => ({ sent: false }),
}));

const { getReferralFunnel } = await import('../api/_lib/referrals.js');

beforeEach(() => {
	dbState.visits = 0;
	dbState.signups = 0;
	dbState.activations = 0;
	boundSince.length = 0;
});

describe('getReferralFunnel', () => {
	it('reports each stage and both conversion rates', async () => {
		dbState.visits = 200;
		dbState.signups = 50;
		dbState.activations = 20;

		const f = await getReferralFunnel('user-1');
		expect(f.visits).toBe(200);
		expect(f.signups).toBe(50);
		expect(f.activations).toBe(20);
		expect(f.visit_to_signup_pct).toBe(25);
		expect(f.signup_to_activation_pct).toBe(40);
	});

	it('rounds conversion rates to one decimal', async () => {
		dbState.visits = 3;
		dbState.signups = 1;
		const f = await getReferralFunnel('user-1');
		expect(f.visit_to_signup_pct).toBe(33.3);
	});

	it('returns null, not 0%, when the prior stage is empty', async () => {
		const f = await getReferralFunnel('user-1');
		expect(f.visits).toBe(0);
		expect(f.signups).toBe(0);
		expect(f.visit_to_signup_pct).toBeNull();
		expect(f.signup_to_activation_pct).toBeNull();
	});

	it('defaults to a 30-day lookback and binds a matching cutoff', async () => {
		const before = Date.now();
		const f = await getReferralFunnel('user-1');
		expect(f.days).toBe(30);
		expect(boundSince.length).toBe(3);
		const expected = before - 30 * 24 * 60 * 60 * 1000;
		for (const since of boundSince) {
			expect(Math.abs(since.getTime() - expected)).toBeLessThan(5_000);
		}
	});

	it('accepts a caller-supplied window and clamps it to a year', async () => {
		expect((await getReferralFunnel('u', { days: 7 })).days).toBe(7);
		expect((await getReferralFunnel('u', { days: '90' })).days).toBe(90);
		expect((await getReferralFunnel('u', { days: 5000 })).days).toBe(365);
	});

	it('falls back to the default window on junk input', async () => {
		expect((await getReferralFunnel('u', { days: 0 })).days).toBe(30);
		expect((await getReferralFunnel('u', { days: -10 })).days).toBe(30);
		expect((await getReferralFunnel('u', { days: 'abc' })).days).toBe(30);
		expect((await getReferralFunnel('u', {})).days).toBe(30);
	});

	it('tolerates a row shape with no count (a stage that returned nothing)', async () => {
		dbState.visits = null;
		dbState.signups = null;
		dbState.activations = null;
		const f = await getReferralFunnel('user-1');
		expect(f.visits).toBe(0);
		expect(f.signups).toBe(0);
		expect(f.activations).toBe(0);
		expect(f.visit_to_signup_pct).toBeNull();
	});
});
