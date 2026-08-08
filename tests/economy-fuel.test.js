// Pure decision/bounds tests for the economy-fuel USDC→SOL auto-refuel.
// planRefuel takes no RPC/DB, so every guard is exercised here.
import { describe, it, expect } from 'vitest';
import { planRefuel } from '../api/_lib/economy-fuel.js';

const CAPS = {
	perRunUsd: 25,
	dailyUsd: 100,
	usdcKeep: 0,
	minGapSol: 0.1,
	targetSol: 1.0,
	minSwapUsd: 1,
};
const base = {
	masterSol: 0.02,        // sitting at reserve, the starved case
	reserveSol: 0.02,
	runCapSol: 2,
	deficitSol: 0.6,        // circ + others want ~0.6 SOL
	usdcAvailable: 150,
	spentTodayUsd: 0,
	solUsd: 170,
	caps: CAPS,
};

describe('planRefuel', () => {
	it('acts when the master is starved and USDC is available', () => {
		const r = planRefuel(base);
		expect(r.act).toBe(true);
		// wants ~1 SOL of headroom (target) → ~170 USD, clamped to the 25 USD per-run cap
		expect(r.spendUsd).toBe(25);
		expect(r.gapSol).toBeCloseTo(0.6, 6);
	});

	it('does nothing when the master already has enough spendable SOL', () => {
		const r = planRefuel({ ...base, masterSol: 1.0 });
		expect(r.act).toBe(false);
		expect(r.reason).toBe('sufficient_sol');
	});

	it('does nothing when the gap is below the minimum', () => {
		// spendable 0.05 over reserve, deficit 0.1 → gap 0.05 < minGapSol 0.1
		const r = planRefuel({ ...base, masterSol: 0.07, deficitSol: 0.1 });
		expect(r.act).toBe(false);
		expect(r.reason).toBe('sufficient_sol');
	});

	it('stops at the daily cap', () => {
		const r = planRefuel({ ...base, spentTodayUsd: 100 });
		expect(r.act).toBe(false);
		expect(r.reason).toBe('daily_cap_reached');
	});

	it('respects the daily cap partially (only remaining budget)', () => {
		const r = planRefuel({ ...base, spentTodayUsd: 96 });
		expect(r.act).toBe(true);
		expect(r.spendUsd).toBe(4); // 100 - 96 remaining, under per-run cap
	});

	it('never spends USDC below the keep-floor', () => {
		const r = planRefuel({ ...base, usdcAvailable: 5, caps: { ...CAPS, usdcKeep: 5 } });
		expect(r.act).toBe(false);
		expect(r.reason).toBe('no_spare_usdc');
	});

	it('reports no_spare_usdc when the wallet is dry', () => {
		const r = planRefuel({ ...base, usdcAvailable: 0 });
		expect(r.act).toBe(false);
		expect(r.reason).toBe('no_spare_usdc');
	});

	it('will not act without a live SOL price', () => {
		const r = planRefuel({ ...base, solUsd: 0 });
		expect(r.act).toBe(false);
		expect(r.reason).toBe('no_sol_price');
	});

	it('is bounded by the run cap when the deficit is huge', () => {
		const r = planRefuel({ ...base, deficitSol: 999, usdcAvailable: 100000, caps: { ...CAPS, perRunUsd: 100000, dailyUsd: 100000 } });
		expect(r.act).toBe(true);
		// gap is clamped to runCapSol (2) - spendable(0) = 2 SOL; buy toward that, not 999
		expect(r.spendUsd).toBeLessThanOrEqual(2 * base.solUsd * 1.03 + 0.01);
	});

	it('spends a sub-dollar USDC balance rather than letting the sponsor stay under its floor', () => {
		// The 2026-08-07 outage: sponsor 171k lamports under its SOL floor (Solana
		// accepts withdrawn, paid routes 503ing) holding $0.54 USDC. The old $1
		// hardcoded minimum refused the swap, so the only lane that could refill
		// the master without owner money was dead. $0.54 buys ~0.0035 SOL, which
		// clears that breach ~20x over, so the lane must act.
		const r = planRefuel({ ...base, usdcAvailable: 0.5446, caps: { ...CAPS, minSwapUsd: 0.1 } });
		expect(r.act).toBe(true);
		expect(r.spendUsd).toBeCloseTo(0.5446, 4);
	});

	it('still refuses a swap that would cost more in fees than it buys in gas', () => {
		const r = planRefuel({ ...base, usdcAvailable: 0.02, caps: { ...CAPS, minSwapUsd: 0.1 } });
		expect(r.act).toBe(false);
		expect(r.reason).toBe('no_spare_usdc');
	});

	it('sizes the buy toward the target buffer, not just the gap', () => {
		// small gap (0.15) but target is 1.0 → buy ~1 SOL of headroom
		const r = planRefuel({ ...base, deficitSol: 0.17, usdcAvailable: 100000, caps: { ...CAPS, perRunUsd: 100000, dailyUsd: 100000 } });
		expect(r.act).toBe(true);
		expect(r.spendUsd).toBeGreaterThan(0.5 * base.solUsd); // more than just the 0.15 gap
	});
});
