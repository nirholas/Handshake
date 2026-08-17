// Tests for the settle-path forward simulation (api/_lib/x402/runway-sim.js),
// the model behind /economy-lab.
//
// The simulation's whole value claim is fidelity: it applies the REAL governor
// functions in the REAL order the settle path uses (hard SOL floor first, then
// the wallet fee governor). These tests pin that ordering, the per-settle
// budget recomputation, the UTC day reset, and the three-lever solver, using
// the exact production shape that starved settlement on 2026-07-31: a fee
// wallet sitting on its floor with a governor budget of one heartbeat.

import { describe, it, expect } from 'vitest';
import {
	simulateRunway,
	equilibriumSettlesPerDay,
	solveForThroughput,
	envDiff,
	formatSol,
	LAMPORTS_PER_SOL,
	MIN_FEE_LAMPORTS,
	MAX_ATTEMPTS,
} from '../api/_lib/x402/runway-sim.js';

// A comfortable wallet: 1 SOL, 0.02 SOL floor, stock 3-day/0.01-SOL governor.
const HEALTHY = {
	startLamports: LAMPORTS_PER_SOL,
	floorLamports: 20_000_000,
	runwayDays: 3,
	minBudgetLamports: 10_000_000,
	feeLamports: 5_000,
};

describe('simulateRunway — admission ordering', () => {
	it('refuses on the hard SOL floor before the governor is consulted', () => {
		// Below the floor the settle path returns fee_wallet_below_floor and never
		// reaches the meter, so every refusal must be attributed to the floor.
		const { summary, series } = simulateRunway({
			...HEALTHY,
			startLamports: 19_000_000, // under the 0.02 SOL floor
			demandPerHour: 10,
			hours: 2,
		});
		expect(summary.admitted).toBe(0);
		expect(summary.refusedFloor).toBe(20);
		expect(summary.refusedGovernor).toBe(0);
		expect(summary.limiter).toBe('floor');
		expect(summary.verdict).toBe('starved');
		expect(series[0].reason).toBe('fee_wallet_below_floor:19000000<20000000');
	});

	it('admits every attempt when budget and balance both allow it', () => {
		const { summary } = simulateRunway({ ...HEALTHY, demandPerHour: 5, hours: 4 });
		expect(summary.admitted).toBe(20);
		expect(summary.refused).toBe(0);
		expect(summary.verdict).toBe('healthy');
		expect(summary.limiter).toBe('demand');
		expect(summary.feesBurnedLamports).toBe(20 * 5_000);
	});

	it('stops at the governor budget, not at the balance, when the wallet is rich', () => {
		// 1 SOL, floor 0.02 → spendable 0.98 SOL. The naive read is 0.98/3 days =
		// 0.3266 SOL/day = 65,333 settles. The real answer is 49,000, because the
		// governor recomputes its budget from the LIVE balance on every settle, so
		// spending shrinks the budget authorising the next spend. The fixed point
		// is spendable/(fee·(runwayDays+1)) = 0.98 SOL / (5,000 × 4).
		const { summary } = simulateRunway({
			...HEALTHY, demandPerHour: 10_000, hours: 24, startHourOfDay: 0,
		});
		expect(summary.refusedGovernor).toBeGreaterThan(0);
		expect(summary.refusedFloor).toBe(0);
		expect(summary.limiter).toBe('governor');
		expect(summary.admitted).toBe(49_000);
	});

	it('the closed form agrees with the simulation it explains', () => {
		const { summary } = simulateRunway({
			...HEALTHY, demandPerHour: 10_000, hours: 24, startHourOfDay: 0,
		});
		expect(equilibriumSettlesPerDay({
			spendableLamports: HEALTHY.startLamports - HEALTHY.floorLamports,
			feeLamports: HEALTHY.feeLamports,
			runwayDays: HEALTHY.runwayDays,
			minBudgetLamports: HEALTHY.minBudgetLamports,
		})).toBe(summary.admitted);
	});
});

describe('simulateRunway — the 2026-07-31 starvation shape', () => {
	// The production failure: the fee wallet sits essentially ON its floor, so
	// spendable SOL is ~0 and the runway term contributes nothing. Only the
	// heartbeat floor keeps any settlement alive at all, and it caps the day.
	const STARVED = {
		startLamports: 28_700_000, // 0.0287 SOL
		floorLamports: 20_000_000, // 0.02 SOL
		runwayDays: 3,
		minBudgetLamports: 10_000_000, // 0.01 SOL heartbeat
		feeLamports: 5_000,
	};

	it('the heartbeat promises more throughput than the wallet can fund', () => {
		const { summary } = simulateRunway({ ...STARVED, demandPerHour: 500, hours: 24 });
		// The heartbeat budget (0.01 SOL / 5,000 = 2,000 settles) is not the
		// binding constraint here: only 0.0087 SOL sits above the hard floor, so
		// the wallet runs out of spendable SOL at 1,741 and the FLOOR refuses the
		// rest. Reading the config alone would have predicted 2,000 and blamed the
		// governor. This is the distinction the lab exists to make visible.
		expect(summary.admitted).toBe(1_741);
		expect(summary.limiter).toBe('floor');
		expect(summary.verdict).toBe('starved');
		expect(summary.refusedFloor).toBeGreaterThan(0);
	});

	it('reports the exact hour throughput first breaks, so the alert has a clock', () => {
		const { summary } = simulateRunway({ ...STARVED, demandPerHour: 500, hours: 24 });
		// 1,741 admitted at 500/hour → the 4th hour (index 3) is the first refusal.
		expect(summary.firstRefusalHour).toBe(3);
	});

	it('pacing is off unless asked for, so the floor stays the visible limiter', () => {
		const unpaced = simulateRunway({ ...STARVED, demandPerHour: 500, hours: 24 });
		const explicitlyOff = simulateRunway({ ...STARVED, demandPerHour: 500, hours: 24, paceDay: false });
		expect(explicitlyOff.summary.admitted).toBe(unpaced.summary.admitted);
		expect(explicitlyOff.summary.limiter).toBe('floor');
	});

	it('pacing spreads the same day of budget instead of front-loading it', () => {
		// A wallet with real spendable SOL, so the governor (not the floor) is the
		// binding gate and pacing is the only thing under test.
		const FUNDED = {
			startLamports: 2_000_000_000, // 2 SOL
			floorLamports: 10_000_000,
			runwayDays: 3,
			minBudgetLamports: 10_000_000,
			feeLamports: 5_000,
		};
		const burst = simulateRunway({ ...FUNDED, demandPerHour: 5_000, hours: 24, startHourOfDay: 0 });
		const paced = simulateRunway({
			...FUNDED, demandPerHour: 5_000, hours: 24, startHourOfDay: 0, paceDay: true,
		});

		// Same day, same wallet: pacing must not hand out extra throughput.
		expect(paced.summary.admitted).toBeLessThanOrEqual(burst.summary.admitted);

		// The point of pacing: budget still available late in the day. Unpaced, the
		// last hour is dead because the whole allowance went early.
		const lastHour = (r) => r.series[r.series.length - 1].admitted;
		expect(lastHour(burst)).toBe(0);
		expect(lastHour(paced)).toBeGreaterThan(0);
	});

	it('a heartbeat raise cannot rescue a wallet that has no spendable SOL', () => {
		const wider = simulateRunway({ ...STARVED, minBudgetLamports: 50_000_000, demandPerHour: 500, hours: 24 });
		// Same 1,741: widening the governor changes nothing once the hard floor is
		// what binds. Only funding moves this number, which is exactly the
		// misdiagnosis the three-lever solver prevents.
		expect(wider.summary.admitted).toBe(1_741);
		expect(wider.summary.endLamports).toBeGreaterThanOrEqual(STARVED.floorLamports - STARVED.feeLamports);
	});

	it('funding, not config, is what restores throughput here', () => {
		const funded = simulateRunway({
			...STARVED, funding: [{ hour: 0, lamports: 500_000_000 }], demandPerHour: 500, hours: 24,
		});
		// 0.5 SOL clears every constraint at this demand: all 12,000 attempts land
		// and the limiter becomes demand, i.e. nothing in the rail is holding back.
		expect(funded.summary.admitted).toBe(12_000);
		expect(funded.summary.refused).toBe(0);
		expect(funded.summary.limiter).toBe('demand');
		expect(funded.summary.verdict).toBe('healthy');
	});

	it('disabling the governor exposes the hard floor as the only remaining stop', () => {
		const { summary } = simulateRunway({
			...STARVED, governorEnabled: false, demandPerHour: 5_000, hours: 24,
		});
		expect(summary.refusedGovernor).toBe(0);
		expect(summary.refusedFloor).toBeGreaterThan(0);
		expect(summary.limiter).toBe('floor');
		// (28.7M − 20M)/5k = 1,740 settles land the balance exactly ON the floor;
		// production's strict `<` admits one more before refusing.
		expect(summary.admitted).toBe(1_741);
	});
});

describe('simulateRunway — time', () => {
	it('resets the daily meter at UTC midnight, not at hour 0 of the sim', () => {
		// Seeded at 23:00 UTC with the day's budget already spent: hour 0 refuses,
		// hour 1 crosses midnight and admits again.
		const { series } = simulateRunway({
			...HEALTHY,
			spentTodayLamports: 400_000_000, // well past the 0.3266 SOL budget
			startHourOfDay: 23,
			demandPerHour: 2,
			hours: 3,
		});
		expect(series[0].admitted).toBe(0);
		expect(series[1].admitted).toBe(2);
		expect(series[1].spentTodayLamports).toBe(2 * 5_000);
	});

	it('applies funding at the top of its hour and records it', () => {
		const { summary, series } = simulateRunway({
			startLamports: 19_000_000,
			floorLamports: 20_000_000,
			runwayDays: 3,
			minBudgetLamports: 10_000_000,
			feeLamports: 5_000,
			demandPerHour: 4,
			hours: 4,
			funding: [{ hour: 2, lamports: 500_000_000 }],
		});
		expect(series[0].admitted).toBe(0); // under the floor
		expect(series[2].fundedLamports).toBe(500_000_000);
		expect(series[2].admitted).toBe(4); // funded, so it clears the floor
		expect(summary.fundedLamports).toBe(500_000_000);
	});

	it('bounds the attempt loop instead of hanging on an absurd horizon', () => {
		const { summary } = simulateRunway({ ...HEALTHY, demandPerHour: 100_000, hours: 24 * 30 });
		expect(summary.truncated).toBe(true);
		expect(summary.admitted + summary.refused).toBeLessThanOrEqual(MAX_ATTEMPTS);
	});
});

describe('simulateRunway — input hardening', () => {
	it('clamps a sub-base-fee estimate to the 1-signature floor', () => {
		const { summary } = simulateRunway({ ...HEALTHY, feeLamports: 1, demandPerHour: 3, hours: 1 });
		expect(summary.feesBurnedLamports).toBe(3 * MIN_FEE_LAMPORTS);
	});

	it('survives a fully empty input without throwing', () => {
		const { summary } = simulateRunway({});
		expect(summary.admitted).toBe(0);
		// Not 'healthy': nothing was attempted, so nothing was proved.
		expect(summary.verdict).toBe('idle');
	});

	it('calls a projection with no demand idle, not healthy', () => {
		// The live shape that exposed this: a fee wallet UNDER its hard floor, so
		// not one settle could land, on a rail nobody sent traffic to that day. The
		// old contract reported verdict 'healthy' and a 100% admission rate for it,
		// which is the exact misdiagnosis /economy-lab exists to prevent.
		const { summary } = simulateRunway({
			startLamports: 899_107,
			floorLamports: 2_000_000,
			runwayDays: 1,
			minBudgetLamports: 10_000_000,
			feeLamports: 5_000,
			demandPerHour: 0,
			hours: 72,
		});
		expect(summary.demanded).toBe(0);
		expect(summary.verdict).toBe('idle');
		expect(summary.admissionRate).toBeNull();
		expect(summary.limiter).toBe('none');
	});

	it('reports the same wallet as starved the moment any demand arrives', () => {
		const { summary } = simulateRunway({
			startLamports: 899_107,
			floorLamports: 2_000_000,
			runwayDays: 1,
			minBudgetLamports: 10_000_000,
			feeLamports: 5_000,
			demandPerHour: 60,
			hours: 72,
		});
		expect(summary.admitted).toBe(0);
		expect(summary.refusedFloor).toBe(60 * 72);
		expect(summary.verdict).toBe('starved');
		expect(summary.limiter).toBe('floor');
		expect(summary.admissionRate).toBe(0);
	});

	it('never lets the balance go negative', () => {
		const { summary } = simulateRunway({
			startLamports: 12_000, floorLamports: 0, runwayDays: 0.5,
			minBudgetLamports: 10_000_000, feeLamports: 5_000, demandPerHour: 100, hours: 2,
		});
		expect(summary.endLamports).toBeGreaterThanOrEqual(0);
	});
});

describe('solveForThroughput', () => {
	const STARVED = {
		startLamports: 28_700_000,
		floorLamports: 20_000_000,
		runwayDays: 3,
		minBudgetLamports: 10_000_000,
		feeLamports: 5_000,
	};

	it('quotes the exact deposit that reaches the target at the current runway', () => {
		const s = solveForThroughput({ ...STARVED, targetSettlesPerDay: 10_000 });
		// 10,000 × 5,000 = 0.05 SOL/day × 3 days + 0.02 floor = 0.17 SOL needed.
		expect(s.requiredDailyBudgetLamports).toBe(50_000_000);
		expect(s.fund.lamports).toBe(170_000_000 - 28_700_000);
		expect(s.alreadyMet).toBe(false);
	});

	it('offers the heartbeat lever at exactly the required daily budget', () => {
		const s = solveForThroughput({ ...STARVED, targetSettlesPerDay: 10_000 });
		expect(s.minBudget.lamports).toBe(50_000_000);
	});

	it('withholds the runway lever when there is nothing spendable to spread', () => {
		const s = solveForThroughput({
			...STARVED, startLamports: 20_000_000, targetSettlesPerDay: 10_000,
		});
		expect(s.runwayDays).toBeNull();
		expect(s.fund).not.toBeNull();
	});

	it('reports a target already met rather than inventing work', () => {
		const s = solveForThroughput({
			startLamports: LAMPORTS_PER_SOL, floorLamports: 20_000_000, runwayDays: 3,
			minBudgetLamports: 10_000_000, feeLamports: 5_000, targetSettlesPerDay: 100,
		});
		expect(s.alreadyMet).toBe(true);
		expect(s.fund).toBeNull();
	});
});

describe('envDiff', () => {
	it('emits only the keys that actually changed', () => {
		const live = { runwayDays: 3, minBudgetLamports: 10_000_000, floorLamports: 20_000_000, governorEnabled: true };
		const changes = envDiff(live, { ...live, minBudgetLamports: 50_000_000 });
		expect(changes).toEqual([
			{ env: 'X402_WALLET_FEE_MIN_BUDGET_LAMPORTS', from: '10000000', to: '50000000' },
		]);
	});

	it('returns nothing when the proposal matches live', () => {
		const live = { runwayDays: 3, minBudgetLamports: 10_000_000 };
		expect(envDiff(live, { ...live })).toEqual([]);
	});
});

describe('formatSol', () => {
	it('trims trailing zeros without losing precision', () => {
		expect(formatSol(LAMPORTS_PER_SOL)).toBe('1');
		expect(formatSol(28_700_000)).toBe('0.0287');
		expect(formatSol(0)).toBe('0');
	});
});
