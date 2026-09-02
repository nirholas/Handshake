// Tests for the wallet fee governor's pure decision logic
// (api/_lib/x402/wallet-fee-governor.js).
//
// The governor meters daily SOL fee burn per FEE-PAYING WALLET so every
// pipeline sharing that wallet draws from one budget — the shared-wallet
// counterpart of the ring tick's governedCalls(). These tests pin the budget
// arithmetic, the heartbeat floor, the admission boundary, and the fail-open
// contract for unknown spend.

import { describe, it, expect } from 'vitest';
import {
	walletFeeGovernorConfig,
	walletDailyFeeBudgetLamports,
	assessWalletFeeBudget,
	pacedFeeBudgetLamports,
	utcDayElapsedFraction,
} from '../api/_lib/x402/wallet-fee-governor.js';

describe('walletFeeGovernorConfig', () => {
	it('defaults: enabled, 3-day runway, 0.01 SOL heartbeat, 20s cache', () => {
		const cfg = walletFeeGovernorConfig({});
		expect(cfg.enabled).toBe(true);
		expect(cfg.runwayDays).toBe(3);
		expect(cfg.minBudgetLamports).toBe(10_000_000);
		expect(cfg.spentCacheMs).toBe(20_000);
		// Intraday pacing is opt-in: it moves which gate refuses a starved wallet
		// first, so it must never switch on by accident.
		expect(cfg.paceDay).toBe(false);
		expect(cfg.paceMinSliceLamports).toBe(200_000);
	});

	it('only an explicit "true" enables intraday pacing', () => {
		expect(walletFeeGovernorConfig({ X402_WALLET_FEE_PACE_DAY: 'true' }).paceDay).toBe(true);
		expect(walletFeeGovernorConfig({ X402_WALLET_FEE_PACE_DAY: 'TRUE' }).paceDay).toBe(true);
		expect(walletFeeGovernorConfig({ X402_WALLET_FEE_PACE_DAY: '1' }).paceDay).toBe(false);
		expect(walletFeeGovernorConfig({ X402_WALLET_FEE_PACE_DAY: 'yes' }).paceDay).toBe(false);
		expect(walletFeeGovernorConfig({}).paceDay).toBe(false);
	});

	it('only an explicit "false" disables it', () => {
		expect(walletFeeGovernorConfig({ X402_WALLET_FEE_GOVERNOR_ENABLED: 'false' }).enabled).toBe(false);
		expect(walletFeeGovernorConfig({ X402_WALLET_FEE_GOVERNOR_ENABLED: 'FALSE' }).enabled).toBe(false);
		expect(walletFeeGovernorConfig({ X402_WALLET_FEE_GOVERNOR_ENABLED: '0' }).enabled).toBe(true);
		expect(walletFeeGovernorConfig({ X402_WALLET_FEE_GOVERNOR_ENABLED: '' }).enabled).toBe(true);
	});

	it('garbage numeric env falls back to defaults; runway clamps at 0.5', () => {
		const cfg = walletFeeGovernorConfig({
			X402_WALLET_FEE_RUNWAY_DAYS: 'soon',
			X402_WALLET_FEE_MIN_BUDGET_LAMPORTS: '-5',
			X402_WALLET_FEE_SPENT_CACHE_MS: '10',
		});
		expect(cfg.runwayDays).toBe(3);
		expect(cfg.minBudgetLamports).toBe(10_000_000);
		expect(cfg.spentCacheMs).toBe(1_000); // clamped to the 1s floor
		expect(walletFeeGovernorConfig({ X402_WALLET_FEE_RUNWAY_DAYS: '0.1' }).runwayDays).toBe(0.5);
	});
});

describe('walletDailyFeeBudgetLamports', () => {
	it('spreads spendable SOL (balance minus floor) over the runway', () => {
		expect(walletDailyFeeBudgetLamports({
			solLamports: 320_000_000, floorLamports: 20_000_000, runwayDays: 3, minBudgetLamports: 10_000_000,
		})).toBe(100_000_000);
	});

	it('never drops below the heartbeat floor while balance is known', () => {
		// Wallet just above its hard floor: runway math says ~0/day, the
		// heartbeat keeps a minimum pulse so the economy can restart itself.
		expect(walletDailyFeeBudgetLamports({
			solLamports: 21_000_000, floorLamports: 20_000_000, runwayDays: 3, minBudgetLamports: 10_000_000,
		})).toBe(10_000_000);
	});

	it('unknown balance → zero budget (the settle path refuses upstream anyway)', () => {
		expect(walletDailyFeeBudgetLamports({
			solLamports: NaN, floorLamports: 20_000_000, runwayDays: 3, minBudgetLamports: 10_000_000,
		})).toBe(0);
	});
});

describe('utcDayElapsedFraction', () => {
	it('runs 0 at the UTC reset and approaches 1 at the end of the day', () => {
		expect(utcDayElapsedFraction(Date.UTC(2026, 7, 1, 0, 0, 0))).toBe(0);
		expect(utcDayElapsedFraction(Date.UTC(2026, 7, 1, 6, 0, 0))).toBe(0.25);
		expect(utcDayElapsedFraction(Date.UTC(2026, 7, 1, 12, 0, 0))).toBe(0.5);
		expect(utcDayElapsedFraction(Date.UTC(2026, 7, 1, 23, 59, 59))).toBeCloseTo(1, 4);
	});

	it('an unreadable clock reports a full day so pacing cannot throttle', () => {
		expect(utcDayElapsedFraction(Number.NaN)).toBe(1);
	});
});

describe('pacedFeeBudgetLamports', () => {
	it('unlocks the budget in proportion to the elapsed UTC day', () => {
		expect(pacedFeeBudgetLamports({
			budgetLamports: 10_000_000, dayElapsedFraction: 0.5,
		})).toBe(5_000_000);
		expect(pacedFeeBudgetLamports({
			budgetLamports: 10_000_000, dayElapsedFraction: 0.25,
		})).toBe(2_500_000);
	});

	it('never exceeds the daily budget, so pacing grants no extra spend', () => {
		expect(pacedFeeBudgetLamports({
			budgetLamports: 10_000_000, dayElapsedFraction: 1,
		})).toBe(10_000_000);
		// Out-of-range fractions clamp rather than overshoot.
		expect(pacedFeeBudgetLamports({
			budgetLamports: 10_000_000, dayElapsedFraction: 4,
		})).toBe(10_000_000);
		expect(pacedFeeBudgetLamports({
			budgetLamports: 10_000_000, dayElapsedFraction: -1, minSliceLamports: 0,
		})).toBe(0);
	});

	it('keeps a minimum slice alive right after the reset', () => {
		// 00:00 exactly: proportional share is 0, the slice keeps a pulse.
		expect(pacedFeeBudgetLamports({
			budgetLamports: 10_000_000, dayElapsedFraction: 0, minSliceLamports: 200_000,
		})).toBe(200_000);
	});

	it('the minimum slice never exceeds a budget smaller than itself', () => {
		expect(pacedFeeBudgetLamports({
			budgetLamports: 50_000, dayElapsedFraction: 0, minSliceLamports: 200_000,
		})).toBe(50_000);
	});

	it('an unreadable clock falls back to the full budget (fail open)', () => {
		expect(pacedFeeBudgetLamports({
			budgetLamports: 10_000_000, dayElapsedFraction: Number.NaN,
		})).toBe(10_000_000);
	});

	it('the production burst that motivated pacing is admitted gradually', () => {
		// 2026-08-01: a 10,000,000 lamport budget was spent by ~1,002 settles at
		// ~10,002 lamports each before midday, then every later settle refused.
		// Paced, the same budget cannot all be drawn before the day is over.
		const budget = 10_000_000;
		const spentByMidday = 1_002 * 10_002;
		const unlockedAtMidday = pacedFeeBudgetLamports({
			budgetLamports: budget, dayElapsedFraction: 0.5, minSliceLamports: 200_000,
		});
		expect(unlockedAtMidday).toBe(5_000_000);
		expect(spentByMidday).toBeGreaterThan(unlockedAtMidday);
		// Budget still left for the evening, which is what the flatline destroyed.
		const unlockedLate = pacedFeeBudgetLamports({
			budgetLamports: budget, dayElapsedFraction: 0.95, minSliceLamports: 200_000,
		});
		expect(unlockedLate).toBeGreaterThan(unlockedAtMidday);
	});
});

describe('assessWalletFeeBudget', () => {
	it('admits while projected spend fits the budget, boundary inclusive', () => {
		expect(assessWalletFeeBudget({
			spentTodayLamports: 90_000, budgetLamports: 100_000, nextFeeLamports: 10_000,
		}).ok).toBe(true);
	});

	it('refuses one lamport over, with a parseable reason', () => {
		const v = assessWalletFeeBudget({
			spentTodayLamports: 90_001, budgetLamports: 100_000, nextFeeLamports: 10_000,
		});
		expect(v.ok).toBe(false);
		expect(v.reason).toBe('fee_runway_exhausted:90001+10000>100000');
	});

	it('fails OPEN on unknown spend — the meter paces, the SOL floor protects', () => {
		expect(assessWalletFeeBudget({
			spentTodayLamports: NaN, budgetLamports: 0, nextFeeLamports: 10_000,
		}).ok).toBe(true);
	});
});

// ── Recurrence guard for the 2026-08-01 fee_runway_exhausted wave ────────────
// The outage: a near-floor fee wallet gets a sub-day budget, exhausts it hours
// after the 00:00 UTC reset, and every settle for the rest of the day fails
// with fee_runway_exhausted (85k rejects vs 562 rail-shaped failures). These
// tests pin the relationship between the default config and the MEASURED
// production constants, so a future default change that re-creates a sub-day
// budget fails CI instead of failing the rail.
describe('recurrence guard: default config sustains a full day at measured burn', () => {
	// Measured 2026-08-01 (see prompts/finish/backlog-01-x402-settle-runway.md):
	// per-settle fee 6,000-8,000 lamports (pin the upper bound), total fee burn
	// 0.06-0.09 SOL/day over successful settles (pin the upper bound), and the
	// treasury self-heal holds the master wallet at ECONOMY_MASTER_OPERATING_SOL
	// (0.3 SOL in production as of this fix).
	const PER_SETTLE_FEE_LAMPORTS = 8_000;
	const MEASURED_DAILY_BURN_LAMPORTS = 90_000_000;
	const OPERATING_POINT_LAMPORTS = 300_000_000;
	const FLOOR_LAMPORTS = 20_000_000; // X402_SPONSOR_SOL_FLOOR_LAMPORTS default

	it('a wallet held at the operating point funds a full day of measured burn', () => {
		const cfg = walletFeeGovernorConfig({});
		const budget = walletDailyFeeBudgetLamports({
			solLamports: OPERATING_POINT_LAMPORTS,
			floorLamports: FLOOR_LAMPORTS,
			runwayDays: cfg.runwayDays,
			minBudgetLamports: cfg.minBudgetLamports,
		});
		expect(budget).toBeGreaterThanOrEqual(MEASURED_DAILY_BURN_LAMPORTS);
	});

	it('the heartbeat floor alone still admits >=1,000 settles/day', () => {
		const cfg = walletFeeGovernorConfig({});
		expect(Math.floor(cfg.minBudgetLamports / PER_SETTLE_FEE_LAMPORTS))
			.toBeGreaterThanOrEqual(1_000);
	});

	it('the production runway override (1 day) triples the default budget', () => {
		const base = walletDailyFeeBudgetLamports({
			solLamports: OPERATING_POINT_LAMPORTS, floorLamports: FLOOR_LAMPORTS,
			runwayDays: walletFeeGovernorConfig({}).runwayDays, minBudgetLamports: 0,
		});
		const prod = walletDailyFeeBudgetLamports({
			solLamports: OPERATING_POINT_LAMPORTS, floorLamports: FLOOR_LAMPORTS,
			runwayDays: walletFeeGovernorConfig({ X402_WALLET_FEE_RUNWAY_DAYS: '1' }).runwayDays,
			minBudgetLamports: 0,
		});
		expect(prod).toBeGreaterThanOrEqual(base * 3);
	});
});
