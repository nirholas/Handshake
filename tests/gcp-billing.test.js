// GCP credit burn — projection math + config resolution contract.
//
// The projection is the load-bearing part of spend observability: it decides
// whether the platform is on track, burning too fast (runaway before expiry), or
// too slow (>30% of the grant expiring unused). It's pure and deterministic, so
// it's tested exhaustively here; the BigQuery I/O around it is exercised live.

import { describe, it, expect } from 'vitest';
import {
	projectExhaustion,
	averageDailyBurn,
	resolveBillingConfig,
	billingConfigured,
	BillingUnavailableError,
	BillingExportMissingError,
	usd,
} from '../api/_lib/gcp-billing.js';

const NOW = new Date('2026-07-06T00:00:00Z');
const DAY = 86_400_000;

describe('projectExhaustion', () => {
	it('flags runaway when credits exhaust before expiry', () => {
		// $60k used, $2k/day, $100k grant → $40k left / $2k = 20d runway, expiry 90d out.
		const p = projectExhaustion({
			creditUsed: 60_000,
			avgDailyBurn: 2_000,
			creditTotal: 100_000,
			now: NOW,
			expiry: new Date(NOW.getTime() + 90 * DAY),
		});
		expect(p.status).toBe('runaway');
		expect(Math.round(p.daysRunway)).toBe(20);
		expect(new Date(p.exhaustionDate).getTime()).toBeLessThan(NOW.getTime() + 90 * DAY);
		expect(p.remainingUsd).toBe(40_000);
	});

	it('flags underutilized when >30% projected unused at expiry', () => {
		// $5k used, $100/day, $100k grant, expiry 90d out.
		// projected = 5k + 100*90 = 14k → 86% unused.
		const p = projectExhaustion({
			creditUsed: 5_000,
			avgDailyBurn: 100,
			creditTotal: 100_000,
			now: NOW,
			expiry: new Date(NOW.getTime() + 90 * DAY),
		});
		expect(p.status).toBe('underutilized');
		expect(p.projectedUnusedPct).toBeGreaterThan(0.3);
		expect(Math.round(p.projectedSpendByExpiryUsd)).toBe(14_000);
	});

	it('reports on-track when spend lands within the sweet spot', () => {
		// $20k used, $900/day, $100k grant, expiry 90d out.
		// projected = 20k + 900*90 = 101k → capped at 100k → 0% unused; runway 88.9d < 90d?
		// remaining 80k / 900 = 88.9d runway, expiry 90d → runway>? 88.9<90 so runaway.
		// Use a burn that lands on-track: $850/day → projected 20k+76.5k=96.5k (3.5% unused),
		// runway 80k/850=94.1d > 90d → on-track.
		const p = projectExhaustion({
			creditUsed: 20_000,
			avgDailyBurn: 850,
			creditTotal: 100_000,
			now: NOW,
			expiry: new Date(NOW.getTime() + 90 * DAY),
		});
		expect(p.status).toBe('on-track');
		expect(p.projectedUnusedPct).toBeLessThan(0.3);
		expect(p.daysRunway).toBeGreaterThan(p.daysToExpiry);
	});

	it('reports idle with infinite runway when there is no burn', () => {
		const p = projectExhaustion({ creditUsed: 1_000, avgDailyBurn: 0, creditTotal: 100_000, now: NOW, expiry: new Date(NOW.getTime() + 90 * DAY) });
		expect(p.status).toBe('idle');
		expect(p.daysRunway).toBe(Infinity);
		expect(p.projectedUnusedUsd).toBe(99_000);
	});

	it('degrades gracefully with no credit total (unknown)', () => {
		const p = projectExhaustion({ creditUsed: 500, avgDailyBurn: 100, creditTotal: null, now: NOW, expiry: null });
		expect(p.status).toBe('unknown');
		expect(p.remainingUsd).toBeNull();
		expect(p.headline).toMatch(/GCP_CREDIT_TOTAL_USD/);
	});

	it('gives runway without expiry set', () => {
		const p = projectExhaustion({ creditUsed: 50_000, avgDailyBurn: 1_000, creditTotal: 100_000, now: NOW, expiry: null });
		expect(p.status).toBe('on-track');
		expect(Math.round(p.daysRunway)).toBe(50);
		expect(p.daysToExpiry).toBeNull();
	});
});

describe('averageDailyBurn', () => {
	it('divides the trailing window sum by the requested day count', () => {
		const daily = [
			{ creditUsed: 100 }, { creditUsed: 200 }, { creditUsed: 300 },
			{ creditUsed: 400 }, { creditUsed: 500 }, { creditUsed: 600 }, { creditUsed: 700 },
		];
		// last 7 sum = 2800 / 7 = 400
		expect(averageDailyBurn(daily, 7)).toBe(400);
		// last 3 sum = 1800 / 3 = 600
		expect(averageDailyBurn(daily, 3)).toBe(600);
	});

	it('divides by the requested window even with fewer rows (true daily rate)', () => {
		// A lane live 3 of the last 7 days still reports a real 7-day rate.
		const daily = [{ creditUsed: 700 }, { creditUsed: 700 }, { creditUsed: 700 }];
		expect(averageDailyBurn(daily, 7)).toBeCloseTo(300, 5);
	});

	it('handles the snake_case column name from BigQuery rows', () => {
		expect(averageDailyBurn([{ credit_used: 70 }], 7)).toBeCloseTo(10, 5);
	});

	it('returns 0 for empty input', () => {
		expect(averageDailyBurn([], 7)).toBe(0);
		expect(averageDailyBurn(null, 7)).toBe(0);
	});
});

describe('resolveBillingConfig', () => {
	it('throws BillingUnavailableError when unconfigured', () => {
		expect(() => resolveBillingConfig({})).toThrow(BillingUnavailableError);
		expect(billingConfigured({})).toBe(false);
	});

	it('derives the standard export table from the billing account id', () => {
		const cfg = resolveBillingConfig({
			GOOGLE_CLOUD_PROJECT: 'proj-1',
			GCP_BILLING_DATASET: 'billing',
			GCP_BILLING_ACCOUNT_ID: '01ABCD-234567-89EFGH',
		});
		expect(cfg.table).toBe('gcp_billing_export_v1_01ABCD_234567_89EFGH');
		expect(cfg.fqTable).toBe('`proj-1.billing.gcp_billing_export_v1_01ABCD_234567_89EFGH`');
	});

	it('uses the resource export prefix when kind=resource', () => {
		const cfg = resolveBillingConfig({
			GOOGLE_CLOUD_PROJECT: 'p',
			GCP_BILLING_DATASET: 'd',
			GCP_BILLING_ACCOUNT_ID: 'AA-BB-CC',
			GCP_BILLING_EXPORT_KIND: 'resource',
		});
		expect(cfg.table).toBe('gcp_billing_export_resource_v1_AA_BB_CC');
	});

	it('sanitizes credit-type overrides to enum tokens only (no SQL injection)', () => {
		const cfg = resolveBillingConfig({
			GOOGLE_CLOUD_PROJECT: 'p',
			GCP_BILLING_DATASET: 'd',
			GCP_BILLING_TABLE: 't',
			GCP_CREDIT_TYPES: "PROMOTION, FREE_TRIAL, '); DROP TABLE x;--",
		});
		expect(cfg.creditTypes).toEqual(['PROMOTION', 'FREE_TRIAL']);
	});

	it('parses the credit total and expiry', () => {
		const cfg = resolveBillingConfig({
			GOOGLE_CLOUD_PROJECT: 'p', GCP_BILLING_DATASET: 'd', GCP_BILLING_TABLE: 't',
			GCP_CREDIT_TOTAL_USD: '100000', GCP_CREDIT_EXPIRY: '2027-07-01',
		});
		expect(cfg.creditTotalUsd).toBe(100_000);
		expect(cfg.creditExpiry.toISOString().slice(0, 10)).toBe('2027-07-01');
	});
});

describe('BillingExportMissingError', () => {
	// The burn cron branches on this type to tell "one console step short of
	// wired" apart from a real BigQuery or auth fault. Getting the hierarchy
	// wrong in either direction is a live bug: too narrow and every existing
	// `instanceof BillingUnavailableError` catch stops firing, too wide and the
	// cron pages ops daily about a step no retry can complete.
	it('is catchable as a BillingUnavailableError', () => {
		const err = new BillingExportMissingError('Billing export table not found: nope');
		expect(err).toBeInstanceOf(BillingUnavailableError);
		expect(err).toBeInstanceOf(Error);
	});

	it('carries a code distinct from a generic billing outage', () => {
		expect(new BillingExportMissingError('x').code).toBe('billing_export_missing');
		expect(new BillingUnavailableError('x').code).toBe('billing_unavailable');
		expect(new BillingUnavailableError('x')).not.toBeInstanceOf(BillingExportMissingError);
	});

	it('keeps the underlying cause when one is given', () => {
		const cause = new Error('404 from BigQuery');
		expect(new BillingExportMissingError('missing', cause).cause).toBe(cause);
	});
});

describe('usd', () => {
	it('formats with two decimals and thousands separators', () => {
		expect(usd(1234.5)).toBe('$1,234.50');
		expect(usd(0)).toBe('$0.00');
		expect(usd(null)).toBe('—');
		expect(usd(NaN)).toBe('—');
	});
});
