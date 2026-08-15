import { describe, it, expect } from 'vitest';
import {
	sharePriceE6, sharesForDeposit, payoutForShares, settleRedemption,
	sharesRedeemableNow, drawdownBps, isDrawdownBreached, depositExceedsCap,
	tradeExceedsPerTrade, tradeExceedsDailyBudget, nextPeak, roiBps,
	usdcToAtomics, atomicsToUsdc, SHARE_PRICE_SCALE,
	parseAmountInput, clampTermBps, TERM_BOUNDS,
} from '../api/_lib/vault-accounting.js';

const USDC = 1_000_000n; // 1 USDC in atomics

describe('share price', () => {
	it('is exactly par (1.0) for an empty vault', () => {
		expect(sharePriceE6(0n, 0n)).toBe(SHARE_PRICE_SCALE);
		expect(sharePriceE6(5_000n * USDC, 0n)).toBe(SHARE_PRICE_SCALE);
	});

	it('reflects NAV per share once shares exist', () => {
		// 100 USDC NAV across 50 shares-worth of atomics → 2.0 USDC/share.
		expect(sharePriceE6(100n * USDC, 50n * USDC)).toBe(2_000_000n);
	});
});

describe('sharesForDeposit', () => {
	it('mints 1:1 at par on the first deposit', () => {
		expect(sharesForDeposit(100n * USDC, 0n, 0n)).toBe(100n * USDC);
	});

	it('mints 1:1 when a wiped-out vault has no recoverable NAV', () => {
		expect(sharesForDeposit(100n * USDC, 0n, 500n * USDC)).toBe(100n * USDC);
	});

	it('mints fewer shares as the price rises above par', () => {
		// NAV doubled to 2.0/share → a 100 USDC deposit buys 50 shares-worth.
		const total = 100n * USDC;
		const navBefore = 200n * USDC; // price 2.0
		expect(sharesForDeposit(100n * USDC, navBefore, total)).toBe(50n * USDC);
	});

	it('does not dilute existing holders: price after deposit is unchanged', () => {
		const total = 100n * USDC;
		const navBefore = 150n * USDC; // price 1.5
		const minted = sharesForDeposit(60n * USDC, navBefore, total);
		const navAfter = navBefore + 60n * USDC;
		const totalAfter = total + minted;
		// New price must not exceed the old price (floored mint can only help holders).
		expect(sharePriceE6(navAfter, totalAfter)).toBeGreaterThanOrEqual(sharePriceE6(navBefore, total) - 1n);
		expect(sharePriceE6(navAfter, totalAfter)).toBeLessThanOrEqual(sharePriceE6(navBefore, total) + 1n);
	});
});

describe('payoutForShares', () => {
	it('pays the pro-rata claim', () => {
		// 25 of 100 shares against 200 USDC NAV → 50 USDC.
		expect(payoutForShares(25n * USDC, 200n * USDC, 100n * USDC)).toBe(50n * USDC);
	});

	it('the last holder out takes the entire remaining NAV (no dust stranded)', () => {
		const nav = 999_999n; // an awkward, indivisible amount
		const total = 7n;
		expect(payoutForShares(total, nav, total)).toBe(nav);
	});

	it('never overdraws: the sum of all backers redeeming at once is ≤ NAV', () => {
		const nav = 1_000_000_001n; // not cleanly divisible
		const shareSplit = [333_333n, 333_333n, 333_334n];
		const total = shareSplit.reduce((a, b) => a + b, 0n);
		const sum = shareSplit.reduce((acc, s) => acc + payoutForShares(s, nav, total), 0n);
		expect(sum).toBeLessThanOrEqual(nav);
	});
});

describe('settleRedemption — performance fee', () => {
	it('charges fee only on realized gain above cost basis', () => {
		// Backer holds 100 shares, basis 100 USDC; NAV doubled (200 USDC, 100 shares).
		const r = settleRedemption({
			shares: 100n * USDC, backerShares: 100n * USDC, costBasisAtomics: 100n * USDC,
			navAtomics: 200n * USDC, totalShares: 100n * USDC, feeBps: 1000, // 10%
		});
		expect(r.grossPayout).toBe(200n * USDC);
		expect(r.gain).toBe(100n * USDC);
		expect(r.fee).toBe(10n * USDC); // 10% of the 100 USDC gain
		expect(r.netPayout).toBe(190n * USDC);
	});

	it('charges ZERO fee on a loss — never touches principal', () => {
		const r = settleRedemption({
			shares: 100n * USDC, backerShares: 100n * USDC, costBasisAtomics: 100n * USDC,
			navAtomics: 60n * USDC, totalShares: 100n * USDC, feeBps: 2000,
		});
		expect(r.gain).toBe(-40n * USDC);
		expect(r.fee).toBe(0n);
		expect(r.netPayout).toBe(60n * USDC);
	});

	it('charges fee only on the realized slice for a partial redemption', () => {
		// Redeem half the position; basis attributed to the half is half the basis.
		const r = settleRedemption({
			shares: 50n * USDC, backerShares: 100n * USDC, costBasisAtomics: 100n * USDC,
			navAtomics: 200n * USDC, totalShares: 100n * USDC, feeBps: 1000,
		});
		expect(r.costPortion).toBe(50n * USDC);
		expect(r.grossPayout).toBe(100n * USDC);
		expect(r.gain).toBe(50n * USDC);
		expect(r.fee).toBe(5n * USDC);
		expect(r.netPayout).toBe(95n * USDC);
		expect(r.remainingBasis).toBe(50n * USDC);
	});

	it('net payout + fee always reconciles to the gross payout', () => {
		for (const [navMul, feeBps] of [[3n, 1500], [1n, 1000], [7n, 500]]) {
			const r = settleRedemption({
				shares: 40n * USDC, backerShares: 100n * USDC, costBasisAtomics: 100n * USDC,
				navAtomics: navMul * 100n * USDC, totalShares: 100n * USDC, feeBps,
			});
			expect(r.netPayout + r.fee).toBe(r.grossPayout);
		}
	});
});

describe('sharesRedeemableNow — honest partial liquidity', () => {
	it('caps redeemable shares at what free USDC can actually pay', () => {
		// NAV 200 USDC across 100 shares (price 2.0), only 50 USDC liquid.
		// 50 USDC pays for 25 shares-worth.
		const n = sharesRedeemableNow({
			requestedShares: 100n * USDC, navAtomics: 200n * USDC,
			totalShares: 100n * USDC, freeAtomics: 50n * USDC,
		});
		expect(n).toBe(25n * USDC);
		// And that slice's payout never exceeds the free balance.
		expect(payoutForShares(n, 200n * USDC, 100n * USDC)).toBeLessThanOrEqual(50n * USDC);
	});

	it('returns the full request when liquidity is ample', () => {
		const n = sharesRedeemableNow({
			requestedShares: 10n * USDC, navAtomics: 100n * USDC,
			totalShares: 100n * USDC, freeAtomics: 100n * USDC,
		});
		expect(n).toBe(10n * USDC);
	});

	it('returns 0 with no free liquidity', () => {
		expect(sharesRedeemableNow({ requestedShares: 10n * USDC, navAtomics: 100n * USDC, totalShares: 100n * USDC, freeAtomics: 0n })).toBe(0n);
	});
});

describe('drawdown circuit breaker', () => {
	it('is 0 at or above the peak', () => {
		expect(drawdownBps(100n * USDC, 100n * USDC)).toBe(0);
		expect(drawdownBps(100n * USDC, 120n * USDC)).toBe(0);
	});

	it('measures the drop from peak in bps', () => {
		expect(drawdownBps(100n * USDC, 75n * USDC)).toBe(2500); // 25% down
		expect(drawdownBps(100n * USDC, 90n * USDC)).toBe(1000); // 10% down
	});

	it('trips exactly at the threshold and beyond', () => {
		expect(isDrawdownBreached(100n * USDC, 75n * USDC, 2500)).toBe(true);
		expect(isDrawdownBreached(100n * USDC, 76n * USDC, 2500)).toBe(false);
		expect(isDrawdownBreached(100n * USDC, 50n * USDC, 2500)).toBe(true);
	});

	it('a halted over-limit loss: a trade that drops NAV past the cap is caught', () => {
		const peak = 1_000n * USDC;
		const maxBps = 2000; // 20% max drawdown
		const navAfterBadTrade = 700n * USDC; // 30% down
		expect(isDrawdownBreached(peak, navAfterBadTrade, maxBps)).toBe(true);
	});

	it('never trips when disabled (max 0)', () => {
		expect(isDrawdownBreached(100n * USDC, 1n, 0)).toBe(false);
	});
});

describe('caps and budgets', () => {
	it('per-backer cap blocks an over-cap deposit, allows within', () => {
		expect(depositExceedsCap(800n * USDC, 300n * USDC, 1000n * USDC)).toBe(true);
		expect(depositExceedsCap(800n * USDC, 200n * USDC, 1000n * USDC)).toBe(false);
		expect(depositExceedsCap(800n * USDC, 300n * USDC, null)).toBe(false); // no cap
	});

	it('per-trade ceiling', () => {
		expect(tradeExceedsPerTrade(60n * USDC, 50n * USDC)).toBe(true);
		expect(tradeExceedsPerTrade(50n * USDC, 50n * USDC)).toBe(false);
	});

	it('rolling daily budget', () => {
		expect(tradeExceedsDailyBudget(400n * USDC, 200n * USDC, 500n * USDC)).toBe(true);
		expect(tradeExceedsDailyBudget(300n * USDC, 200n * USDC, 500n * USDC)).toBe(false);
	});
});

describe('peak roll + roi + conversions', () => {
	it('peak only ratchets up', () => {
		expect(nextPeak(100n * USDC, 120n * USDC)).toBe(120n * USDC);
		expect(nextPeak(100n * USDC, 80n * USDC)).toBe(100n * USDC);
	});

	it('roi bps tracks share price vs par', () => {
		expect(roiBps(150n * USDC, 100n * USDC)).toBe(5000); // +50%
		expect(roiBps(80n * USDC, 100n * USDC)).toBe(-2000); // -20%
		expect(roiBps(0n, 0n)).toBe(0);
	});

	it('usdc <-> atomics round-trips for clean values', () => {
		expect(usdcToAtomics(12.5)).toBe(12_500_000n);
		expect(atomicsToUsdc(12_500_000n)).toBe(12.5);
		expect(usdcToAtomics(-5)).toBe(0n);
	});
});

describe('drawdown breaker tracks SHARE PRICE, not raw NAV', () => {
	// The breaker must measure NAV-per-share so capital flows (deposits/redemptions)
	// never falsely trip it — only real trading losses do.
	it('a deposit moves NAV but not share price → no false drawdown', () => {
		let total = sharesForDeposit(100n * USDC, 0n, 0n); // 100 shares @ par
		const priceBefore = sharePriceE6(100n * USDC, total);
		// Second backer deposits 100 at the same price.
		const minted = sharesForDeposit(100n * USDC, 100n * USDC, total);
		total += minted;
		const priceAfter = sharePriceE6(200n * USDC, total);
		expect(priceAfter).toBe(priceBefore); // price unchanged by the deposit
		const peak = nextPeak(priceBefore, priceAfter);
		expect(isDrawdownBreached(peak, priceAfter, 2500)).toBe(false);
	});

	it('a redemption moves NAV but not share price → no false drawdown', () => {
		const total = sharesForDeposit(200n * USDC, 0n, 0n); // 200 shares @ par
		const peak = sharePriceE6(200n * USDC, total);
		// A backer redeems half: 100 shares burned, 100 USDC leaves → NAV 100, shares 100.
		const priceAfter = sharePriceE6(100n * USDC, total - 100n * USDC);
		expect(priceAfter).toBe(peak); // still par — no loss
		expect(isDrawdownBreached(peak, priceAfter, 2500)).toBe(false);
	});

	it('a losing trade DOES drop share price and trips the breaker', () => {
		const total = 100n * USDC;
		const peak = sharePriceE6(100n * USDC, total); // par
		const priceAfterLoss = sharePriceE6(70n * USDC, total); // 30% trading loss
		expect(isDrawdownBreached(peak, priceAfterLoss, 2500)).toBe(true);
	});
});

describe('end-to-end lifecycle conservation', () => {
	it('deposit → gain → two redemptions never overpays the vault', () => {
		let totalShares = 0n;
		// Alice deposits 100 at par.
		const aliceShares = sharesForDeposit(100n * USDC, 0n, totalShares);
		totalShares += aliceShares;
		let aliceBasis = 100n * USDC;
		// Bob deposits 100 at par (NAV is 100 before his deposit).
		const bobShares = sharesForDeposit(100n * USDC, 100n * USDC, totalShares);
		totalShares += bobShares;
		let bobBasis = 100n * USDC;
		// The agent trades the 200 USDC up to 300 USDC NAV (+50%).
		let nav = 300n * USDC;

		// Track real custody: only the NET payout leaves the wallet; the fee stays
		// in the vault as owner-accruable, and is excluded from backer NAV.
		let vaultBalance = nav;
		let accruedFee = 0n;

		// Alice redeems everything.
		const aliceOut = settleRedemption({
			shares: aliceShares, backerShares: aliceShares, costBasisAtomics: aliceBasis,
			navAtomics: vaultBalance - accruedFee, totalShares, feeBps: 1000,
		});
		vaultBalance -= aliceOut.netPayout; // only the net leaves the wallet
		accruedFee += aliceOut.fee;         // fee retained, owner-claimable
		totalShares -= aliceShares;

		// Bob redeems everything against backer-NAV (vault balance minus owner fee).
		const bobOut = settleRedemption({
			shares: bobShares, backerShares: bobShares, costBasisAtomics: bobBasis,
			navAtomics: vaultBalance - accruedFee, totalShares, feeBps: 1000,
		});
		vaultBalance -= bobOut.netPayout;
		accruedFee += bobOut.fee;

		// Both backers gained symmetrically: 150 gross, 145 net (10% fee on 50 gain).
		expect(aliceOut.netPayout).toBe(145n * USDC);
		expect(bobOut.netPayout).toBe(145n * USDC);
		// The vault never pays more than it holds, and ends with exactly the owner fees.
		expect(vaultBalance).toBe(accruedFee);
		expect(accruedFee).toBe(10n * USDC);
		expect(vaultBalance).toBeGreaterThanOrEqual(0n);
	});
});

describe('parseAmountInput (the HTTP boundary guard)', () => {
	it('accepts the shapes a real caller sends', () => {
		expect(parseAmountInput('2500000')).toBe(2_500_000n);
		expect(parseAmountInput(2_500_000)).toBe(2_500_000n);
		expect(parseAmountInput(2_500_000n)).toBe(2_500_000n);
		expect(parseAmountInput('  2500000  ')).toBe(2_500_000n);
		expect(parseAmountInput('0')).toBe(0n);
		// A decimal tail truncates down, never up into funds that aren't there.
		expect(parseAmountInput('2500000.99')).toBe(2_500_000n);
	});

	it('returns null for anything BigInt() would throw on, so the handler can answer 400', () => {
		for (const bad of ['abc', '', '   ', '1e6', '0x10', '1,000', '-5', -5, NaN, Infinity, null, undefined, {}, [], true]) {
			expect(parseAmountInput(bad)).toBeNull();
		}
	});
});

describe('clampTermBps', () => {
	it('clamps into the term bound and rounds to a whole bps', () => {
		expect(clampTermBps(9999, TERM_BOUNDS.performanceFeeBps)).toBe(5000);
		expect(clampTermBps(-1, TERM_BOUNDS.performanceFeeBps)).toBe(0);
		expect(clampTermBps(1234.6, TERM_BOUNDS.performanceFeeBps)).toBe(1235);
		expect(clampTermBps(0, TERM_BOUNDS.maxDrawdownBps)).toBe(100);
		expect(clampTermBps(99_999, TERM_BOUNDS.maxDrawdownBps)).toBe(9000);
	});

	it('returns null (never NaN) for a value that is not a number', () => {
		expect(clampTermBps('abc', TERM_BOUNDS.performanceFeeBps)).toBeNull();
		expect(clampTermBps(NaN, TERM_BOUNDS.maxDrawdownBps)).toBeNull();
		expect(clampTermBps(Infinity, TERM_BOUNDS.maxDrawdownBps)).toBeNull();
	});
});
