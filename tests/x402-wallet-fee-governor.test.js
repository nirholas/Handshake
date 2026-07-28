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
} from '../api/_lib/x402/wallet-fee-governor.js';

describe('walletFeeGovernorConfig', () => {
	it('defaults: enabled, 3-day runway, 0.01 SOL heartbeat, 20s cache', () => {
		const cfg = walletFeeGovernorConfig({});
		expect(cfg.enabled).toBe(true);
		expect(cfg.runwayDays).toBe(3);
		expect(cfg.minBudgetLamports).toBe(10_000_000);
		expect(cfg.spentCacheMs).toBe(20_000);
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
