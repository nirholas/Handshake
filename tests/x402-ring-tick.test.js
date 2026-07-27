import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
	ringTickConfig,
	planTick,
	planBackpressure,
	governedCalls,
	minUsdcForTick,
	dailyRemaining,
	tickBudget,
	assessBackpressure,
	gateOnRingConfig,
} from '../api/_lib/x402/ring-tick-plan.js';
import { CHEAP_ENDPOINTS, RING_SETTLE_ENDPOINT } from '../api/_lib/x402/pipelines/volume-shared.js';
import { warnCapExceeded } from '../api/_lib/x402/pay.js';
import { validateRingConfig } from '../api/_lib/x402/ring-config.js';

// ── Cadence: weighted rotation ─────────────────────────────────────────────────
describe('ring-tick planTick — cadence', () => {
	const CHEAP = CHEAP_ENDPOINTS.length; // 11 in the stock catalog

	// Reproduce the cron's Redis reservation in memory: each tick reserves
	// cheapNeeded indices, advancing a shared cursor.
	function simulate(ticks, { calls = 3, settleEveryN = 5 } = {}) {
		let cursor = 0;
		const out = [];
		for (let seq = 1; seq <= ticks; seq++) {
			const isSettle = settleEveryN > 0 && seq % settleEveryN === 0;
			const cheapNeeded = Math.max(0, calls - (isSettle ? 1 : 0));
			const cheapStart = cursor;
			cursor += cheapNeeded;
			const plan = planTick({ tickSeq: seq, calls, settleEveryN, cheapCount: CHEAP, cheapStart });
			out.push({ seq, ...plan });
		}
		return out;
	}

	it('fires ring-settle on exactly every Nth tick', () => {
		const plans = simulate(20, { settleEveryN: 5 });
		const settleTicks = plans.filter((p) => p.isSettleTick).map((p) => p.seq);
		expect(settleTicks).toEqual([5, 10, 15, 20]);
	});

	it('cheap tips dominate the per-minute count', () => {
		const plans = simulate(10, { calls: 3, settleEveryN: 5 });
		const totalCalls = plans.reduce((n, p) => n + p.cheapIndices.length + (p.isSettleTick ? 1 : 0), 0);
		const settleCalls = plans.filter((p) => p.isSettleTick).length;
		const cheapCalls = totalCalls - settleCalls;
		expect(totalCalls).toBe(30); // 10 ticks × 3 calls
		expect(settleCalls).toBe(2); // ticks 5 and 10
		expect(cheapCalls).toBe(28); // the overwhelming majority
	});

	it('every cheap index is within the catalog and rotates for variety', () => {
		const plans = simulate(12, { calls: 3, settleEveryN: 5 });
		const all = plans.flatMap((p) => p.cheapIndices);
		for (const i of all) {
			expect(Number.isInteger(i)).toBe(true);
			expect(i).toBeGreaterThanOrEqual(0);
			expect(i).toBeLessThan(CHEAP);
		}
		expect(new Set(all).size).toBeGreaterThan(1);
	});

	it('a non-settle tick pays only cheap endpoints', () => {
		const plan = planTick({ tickSeq: 1, calls: 3, settleEveryN: 5, cheapCount: CHEAP, cheapStart: 0 });
		expect(plan.isSettleTick).toBe(false);
		expect(plan.cheapIndices).toHaveLength(3);
	});

	it('a settle tick reserves one slot for ring-settle', () => {
		const plan = planTick({ tickSeq: 5, calls: 3, settleEveryN: 5, cheapCount: CHEAP, cheapStart: 0 });
		expect(plan.isSettleTick).toBe(true);
		expect(plan.cheapIndices).toHaveLength(2);
		expect(RING_SETTLE_ENDPOINT?.key).toBe('ring-settle');
	});

	it('settleEveryN=0 disables the ring-settle carrier', () => {
		const plans = simulate(10, { settleEveryN: 0 });
		expect(plans.every((p) => !p.isSettleTick)).toBe(true);
	});
});

// ── Cap enforcement ─────────────────────────────────────────────────────────────
describe('ring-tick budgets', () => {
	it('tick budget is the smaller of tick cap and daily remaining', () => {
		expect(tickBudget(0, 50_000_000, 1_100_000)).toBe(1_100_000);
		expect(tickBudget(49_500_000, 50_000_000, 1_100_000)).toBe(500_000); // daily nearly spent
	});

	it('daily cap halts the tick (budget 0, never negative)', () => {
		expect(tickBudget(50_000_000, 50_000_000, 1_100_000)).toBe(0);
		expect(tickBudget(60_000_000, 50_000_000, 1_100_000)).toBe(0); // overshoot clamps to 0
		expect(dailyRemaining(60_000_000, 50_000_000)).toBe(0);
	});

	it('minimum payer USDC is the ring-settle price on a settle tick, headroom otherwise', () => {
		expect(minUsdcForTick({ isSettleTick: true, ringSettlePriceAtomic: 1_000_000 })).toBe(1_000_000);
		expect(minUsdcForTick({ isSettleTick: false, ringSettlePriceAtomic: 1_000_000 })).toBe(20_000);
	});
});

// ── Back-pressure ───────────────────────────────────────────────────────────────
describe('ring-tick back-pressure', () => {
	const FLOOR = 20_000_000; // 0.02 SOL
	const MIN_USDC = 1_000_000;

	it('below the SOL floor → clean no-op with sponsor_sol_floor', () => {
		const r = assessBackpressure({ solLamports: 10_000_000, usdcAtomic: 5_000_000, floorLamports: FLOOR, minUsdcAtomic: MIN_USDC });
		expect(r.ok).toBe(false);
		expect(r.reason).toBe('sponsor_sol_floor');
	});

	it('insufficient payer USDC → insufficient_payer_usdc', () => {
		const r = assessBackpressure({ solLamports: 50_000_000, usdcAtomic: 100_000, floorLamports: FLOOR, minUsdcAtomic: MIN_USDC });
		expect(r.ok).toBe(false);
		expect(r.reason).toBe('insufficient_payer_usdc');
	});

	it('an RPC read failure (NaN balance) → rpc_balance_unavailable', () => {
		expect(assessBackpressure({ solLamports: Number.NaN, usdcAtomic: 5_000_000, floorLamports: FLOOR, minUsdcAtomic: MIN_USDC }).reason).toBe('rpc_balance_unavailable');
		expect(assessBackpressure({ solLamports: 50_000_000, usdcAtomic: Number.NaN, floorLamports: FLOOR, minUsdcAtomic: MIN_USDC }).reason).toBe('rpc_balance_unavailable');
	});

	it('healthy balances → tick proceeds', () => {
		const r = assessBackpressure({ solLamports: 50_000_000, usdcAtomic: 5_000_000, floorLamports: FLOOR, minUsdcAtomic: MIN_USDC });
		expect(r.ok).toBe(true);
		expect(r.reason).toBeNull();
	});

	it('the floor is checked before USDC (settlement is paused, so USDC is moot)', () => {
		const r = assessBackpressure({ solLamports: 1, usdcAtomic: 0, floorLamports: FLOOR, minUsdcAtomic: MIN_USDC });
		expect(r.reason).toBe('sponsor_sol_floor');
	});
});

// ── Degrade: settle-unaffordable falls back to a cheap-only tick ─────────────────
describe('ring-tick planBackpressure — settle-unaffordable degrade', () => {
	const FLOOR = 20_000_000; // 0.02 SOL
	const SETTLE = 1_000_000; // $1.00
	const base = { solLamports: 50_000_000, floorLamports: FLOOR, ringSettlePriceAtomic: SETTLE };

	it('an affordable settle tick proceeds unchanged', () => {
		const r = planBackpressure({ ...base, isSettleTick: true, usdcAtomic: 5_000_000 });
		expect(r.settleTick).toBe(true);
		expect(r.degraded).toBe(false);
		expect(r.backpressure.ok).toBe(true);
	});

	it('settle price above payer USDC degrades to a cheap-only tick (never a dead tick)', () => {
		// $0.50 in the wallet: can't cover the $1.00 settle, easily covers tips.
		const r = planBackpressure({ ...base, isSettleTick: true, usdcAtomic: 500_000 });
		expect(r.settleTick).toBe(false);
		expect(r.degraded).toBe(true);
		expect(r.backpressure.ok).toBe(true);
		expect(r.minUsdcAtomic).toBe(20_000); // re-assessed against tip headroom
	});

	it('below even the tip headroom → still a hard skip', () => {
		const r = planBackpressure({ ...base, isSettleTick: true, usdcAtomic: 1_000 });
		expect(r.settleTick).toBe(false);
		expect(r.degraded).toBe(false);
		expect(r.backpressure.ok).toBe(false);
		expect(r.backpressure.reason).toBe('insufficient_payer_usdc');
	});

	it('SOL floor and RPC faults never degrade — the whole tick skips', () => {
		const floor = planBackpressure({ ...base, isSettleTick: true, solLamports: 1_000, usdcAtomic: 5_000_000 });
		expect(floor.settleTick).toBe(true); // decision untouched; the skip is the outcome
		expect(floor.degraded).toBe(false);
		expect(floor.backpressure.reason).toBe('sponsor_sol_floor');

		const rpc = planBackpressure({ ...base, isSettleTick: true, solLamports: Number.NaN, usdcAtomic: 5_000_000 });
		expect(rpc.degraded).toBe(false);
		expect(rpc.backpressure.reason).toBe('rpc_balance_unavailable');
	});

	it('a non-settle tick is passed through verbatim', () => {
		const r = planBackpressure({ ...base, isSettleTick: false, usdcAtomic: 500_000 });
		expect(r.settleTick).toBe(false);
		expect(r.degraded).toBe(false);
		expect(r.backpressure.ok).toBe(true);
	});
});

// ── Config gate: run only on a clean (no-error) envelope ────────────────────────
describe('ring-tick config gate', () => {
	it('blocks when any ERROR-severity finding exists', () => {
		const g = gateOnRingConfig([
			{ code: 'facilitator_url_external', severity: 'error' },
			{ code: 'ring_self_pay_off', severity: 'warn' },
		]);
		expect(g.blocked).toBe(true);
		expect(g.errors).toHaveLength(1);
		expect(g.warnings).toHaveLength(1);
	});

	it('does NOT block on warn-only findings (sponsor mode still settles in-house)', () => {
		const g = gateOnRingConfig([{ code: 'ring_self_pay_off', severity: 'warn' }]);
		expect(g.blocked).toBe(false);
		expect(g.warnings).toHaveLength(1);
	});

	it('a clean envelope is not blocked', () => {
		expect(gateOnRingConfig([]).blocked).toBe(false);
	});
});

// ── Config knobs + budget separation from the autonomous loop ───────────────────
describe('ringTickConfig', () => {
	const SAVED = {};
	const KEYS = [
		'X402_RING_TICK_ENABLED', 'X402_RING_TICK_CALLS', 'X402_RING_SETTLE_EVERY_N_TICKS',
		'X402_RING_TICK_CAP_ATOMIC', 'X402_RING_DAILY_CAP_ATOMIC', 'X402_AUTONOMOUS_DAILY_CAP_ATOMIC',
	];
	beforeEach(() => { for (const k of KEYS) { SAVED[k] = process.env[k]; delete process.env[k]; } });
	afterEach(() => { for (const k of KEYS) { if (SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k]; } });

	it('sensible defaults out of the box', () => {
		const c = ringTickConfig();
		expect(c.enabled).toBe(true);
		expect(c.calls).toBe(3);
		expect(c.settleEveryN).toBe(5);
		expect(c.tickCapAtomic).toBe(1_100_000);
		expect(c.dailyCapAtomic).toBe(50_000_000);
	});

	it('X402_RING_TICK_ENABLED=false disables it; other values keep it on', () => {
		process.env.X402_RING_TICK_ENABLED = 'false';
		expect(ringTickConfig().enabled).toBe(false);
		process.env.X402_RING_TICK_ENABLED = 'true';
		expect(ringTickConfig().enabled).toBe(true);
	});

	it('the ring tick daily cap is SEPARATE from the autonomous loop cap', () => {
		process.env.X402_RING_DAILY_CAP_ATOMIC = '50000000';
		process.env.X402_AUTONOMOUS_DAILY_CAP_ATOMIC = '999';
		// Reading the ring tick config never picks up the autonomous loop's cap.
		expect(ringTickConfig().dailyCapAtomic).toBe(50_000_000);
	});

	it('rejects garbage numeric env, falling back to the default', () => {
		process.env.X402_RING_TICK_CALLS = 'not-a-number';
		expect(ringTickConfig().calls).toBe(3);
	});
});

// ── Price-vs-cap contradiction is impossible to hit silently ────────────────────
describe('price-vs-cap coherence', () => {
	const SAVED = {};
	const KEYS = ['X402_PRICE_RING_SETTLE', 'X402_VOLUME_PER_RUN_CAP_ATOMIC'];
	beforeEach(() => { for (const k of KEYS) { SAVED[k] = process.env[k]; delete process.env[k]; } });
	afterEach(() => { for (const k of KEYS) { if (SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k]; } });

	it('validateRingConfig flags ring_price_exceeds_run_cap when price > cap', () => {
		process.env.X402_PRICE_RING_SETTLE = '1000000'; // $1.00
		process.env.X402_VOLUME_PER_RUN_CAP_ATOMIC = '50000'; // $0.05 (the old, broken pairing)
		const codes = validateRingConfig().map((f) => f.code);
		expect(codes).toContain('ring_price_exceeds_run_cap');
	});

	it('no contradiction once the cap accommodates the price (stock defaults)', () => {
		process.env.X402_PRICE_RING_SETTLE = '1000000'; // $1.00
		process.env.X402_VOLUME_PER_RUN_CAP_ATOMIC = '1100000'; // $1.10 (the new default)
		const codes = validateRingConfig().map((f) => f.code);
		expect(codes).not.toContain('ring_price_exceeds_run_cap');
	});

	it('warnCapExceeded logs loudly and throttles per (url,cap) signature', () => {
		const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			warnCapExceeded('https://three.ws/api/x402/ring-settle', 1_000_000, 50_000);
			expect(spy).toHaveBeenCalledTimes(1);
			expect(spy.mock.calls[0][0]).toMatch(/SKIPPED/);
			expect(spy.mock.calls[0][0]).toMatch(/ring-settle/);
			// Same signature again within the hour is throttled.
			warnCapExceeded('https://three.ws/api/x402/ring-settle', 1_000_000, 50_000);
			expect(spy).toHaveBeenCalledTimes(1);
			// A different cap is a different signature — logs again.
			warnCapExceeded('https://three.ws/api/x402/ring-settle', 1_000_000, 60_000);
			expect(spy).toHaveBeenCalledTimes(2);
		} finally {
			spy.mockRestore();
		}
	});
});

describe('ring-tick runway governor', () => {
	const base = {
		configuredCalls: 94,
		floorLamports: 20_000_000,   // 0.02 SOL untouchable floor
		feePerCallLamports: 7_000,
		runwayDays: 3,
	};

	it('rich payer runs at the configured rate, unthrottled', () => {
		// 5 SOL spendable / 3d / 7000 lamports = ~237k calls/day = 164/min > 94
		const g = governedCalls({ ...base, solLamports: 5_020_000_000 });
		expect(g.calls).toBe(94);
		expect(g.throttled).toBe(false);
	});

	it('lean payer throttles below the configured rate', () => {
		// 0.5 SOL spendable / 3d / 7000 = ~23.8k calls/day = 16/min
		const g = governedCalls({ ...base, solLamports: 520_000_000 });
		expect(g.calls).toBe(16);
		expect(g.throttled).toBe(true);
	});

	it('payer at the floor yields zero calls (runway exhausted)', () => {
		const g = governedCalls({ ...base, solLamports: 20_000_000 });
		expect(g.calls).toBe(0);
		expect(g.throttled).toBe(true);
	});

	it('keeps a heartbeat above the floor when the runway target wants zero', () => {
		// 0.01 SOL spendable / 3d / 7000 = 476/day < 1440 → runway says 0/min, but
		// the payer is above the hard floor, so the heartbeat keeps the ring alive.
		// Hoarding this band is what deadlocked the economy (no calls → no settles
		// → no sweep → no fuel → no recovery).
		const g = governedCalls({ ...base, solLamports: 30_000_000 });
		expect(g.calls).toBe(1);
		expect(g.heartbeat).toBe(true);
		expect(g.throttled).toBe(true);
	});

	it('minCalls=0 restores strict runway-only governing', () => {
		const g = governedCalls({ ...base, solLamports: 30_000_000, minCalls: 0 });
		expect(g.calls).toBe(0);
		expect(g.heartbeat).toBe(false);
	});

	it('honours a larger heartbeat but never above the configured rate', () => {
		const g = governedCalls({ ...base, solLamports: 30_000_000, minCalls: 5 });
		expect(g.calls).toBe(5);
		const capped = governedCalls({
			...base, configuredCalls: 2, solLamports: 30_000_000, minCalls: 5,
		});
		expect(capped.calls).toBe(2);
	});

	it('the heartbeat never fires at or below the floor', () => {
		expect(governedCalls({ ...base, solLamports: 20_000_000, minCalls: 9 }).calls).toBe(0);
		expect(governedCalls({ ...base, solLamports: 1_000_000, minCalls: 9 }).calls).toBe(0);
	});

	it('does not flag heartbeat when the runway itself sustains the rate', () => {
		const g = governedCalls({ ...base, solLamports: 520_000_000 });
		expect(g.calls).toBe(16);
		expect(g.heartbeat).toBe(false);
	});

	it('NaN balance (RPC fault) fails closed to zero calls', () => {
		const g = governedCalls({ ...base, solLamports: Number.NaN });
		expect(g.calls).toBe(0);
		expect(g.throttled).toBe(true);
	});

	it('never raises above configuredCalls no matter the balance', () => {
		const g = governedCalls({ ...base, configuredCalls: 3, solLamports: 100_000_000_000 });
		expect(g.calls).toBe(3);
	});

	it('config exposes governor knobs with sane defaults and overrides', () => {
		const dflt = ringTickConfig({});
		expect(dflt.feePerCallLamports).toBe(7_000);
		expect(dflt.runwayDays).toBe(3);
		const set = ringTickConfig({
			X402_RING_FEE_PER_CALL_LAMPORTS: '6500',
			X402_RING_TARGET_RUNWAY_DAYS: '7',
		});
		expect(set.feePerCallLamports).toBe(6_500);
		expect(set.runwayDays).toBe(7);
	});
});

// ── Artifact reserve: ring churn must not starve the value-producing pipelines ──
describe('ring-tick artifact reserve', () => {
	const FLOOR = 20_000_000;
	const SETTLE = 10_000_000;   // $10 ring-settle, the shape that drained the float
	const RESERVE = 1_000_000;   // $1.00 held back for forge props
	const base = {
		solLamports: 500_000_000, floorLamports: FLOOR,
		ringSettlePriceAtomic: SETTLE, artifactReserveAtomic: RESERVE,
	};

	it('a settle that would eat the reserve degrades to cheap-only', () => {
		// $10.50 held: enough for the $10 settle only by spending into the reserve.
		const r = planBackpressure({ ...base, isSettleTick: true, usdcAtomic: 10_500_000 });
		expect(r.settleTick).toBe(false);
		expect(r.degraded).toBe(true);
	});

	it('a settle clear of the reserve still fires', () => {
		// $11.50 held: $10 settle leaves the full $1 reserve intact.
		const r = planBackpressure({ ...base, isSettleTick: true, usdcAtomic: 11_500_000 });
		expect(r.settleTick).toBe(true);
		expect(r.backpressure.ok).toBe(true);
	});

	it('cheap tips cannot nibble the reserve either', () => {
		// $1.01 held: only $0.01 is spendable, under the $0.02 tip headroom.
		const r = planBackpressure({ ...base, isSettleTick: false, usdcAtomic: 1_010_000 });
		expect(r.backpressure.ok).toBe(false);
		expect(r.backpressure.reason).toBe('insufficient_payer_usdc');
	});

	it('zero reserve preserves the previous behaviour exactly', () => {
		const withZero = planBackpressure({ ...base, artifactReserveAtomic: 0, isSettleTick: true, usdcAtomic: 10_500_000 });
		expect(withZero.settleTick).toBe(true);
		expect(withZero.backpressure.ok).toBe(true);
	});

	it('an RPC fault still reports rpc_balance_unavailable, not a reserve skip', () => {
		const r = planBackpressure({ ...base, isSettleTick: true, usdcAtomic: Number.NaN });
		expect(r.backpressure.reason).toBe('rpc_balance_unavailable');
	});

	it('config exposes the reserve with a $1.00 default and an override', () => {
		expect(ringTickConfig({}).artifactReserveAtomic).toBe(1_000_000);
		expect(ringTickConfig({ X402_ARTIFACT_RESERVE_ATOMIC: '2500000' }).artifactReserveAtomic).toBe(2_500_000);
	});
});
