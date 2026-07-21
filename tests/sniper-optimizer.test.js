/**
 * Autonomous sniper optimizer: pure decision logic.
 *
 * proposeAdjustments is pure (no DB, no I/O). These lock in that it:
 *   - no-ops below the minimum sample,
 *   - sets a take-profit when winners are timing out unrealized (the first-trade lesson),
 *   - de-risks a stop-loss-heavy, low-win-rate arm,
 *   - never exceeds its per-run step or hard bounds,
 *   - never emits a no-op proposal,
 *   - scales a proven arm up only within the hard ceiling.
 */

import { describe, it, expect } from 'vitest';
import { proposeAdjustments, bestOracleThreshold, MIN_SAMPLE, BOUNDS, STEP } from '../api/_lib/sniper-optimizer.js';

const baseConfig = {
	decision_mode: 'rules',
	per_trade_lamports: 50_000_000,
	daily_budget_lamports: 200_000_000,
	max_concurrent_positions: 1,
	take_profit_pct: null,
	trailing_stop_pct: 25,
	stop_loss_pct: 30,
	max_hold_seconds: 1800,
	min_quality_score: null,
	min_oracle_score: null,
};

function stats(over) {
	return {
		closed: 10, wins: 6, winRate: 60, avgPnlPct: 12, bestPnlPct: 46,
		worstPnlPct: -20, avgHoldSeconds: 1700, netPnlLamports: 30_000_000,
		exitReasons: {}, ...over,
	};
}

describe('proposeAdjustments', () => {
	it('no-ops below the minimum sample', () => {
		const r = proposeAdjustments(stats({ closed: MIN_SAMPLE - 1 }), baseConfig);
		expect(r.acted).toBe(false);
		expect(r.proposals).toHaveLength(0);
	});

	it('sets a take-profit when winners are timing out unrealized (the first-trade lesson)', () => {
		const r = proposeAdjustments(
			stats({ closed: 10, wins: 8, winRate: 80, avgPnlPct: 30, bestPnlPct: 46, exitReasons: { timeout: 6, trailing_stop: 4 } }),
			{ ...baseConfig, take_profit_pct: null },
		);
		const tp = r.proposals.find((p) => p.field === 'take_profit_pct');
		expect(tp).toBeTruthy();
		expect(tp.from).toBe(null);
		expect(tp.to).toBeGreaterThanOrEqual(BOUNDS.take_profit_pct.min);
		expect(tp.to).toBeLessThanOrEqual(BOUNDS.take_profit_pct.max);
	});

	it('de-risks a stop-loss-heavy, low-win-rate arm and tightens selection', () => {
		const r = proposeAdjustments(
			stats({ closed: 12, wins: 3, winRate: 25, avgPnlPct: -8, netPnlLamports: -40_000_000, exitReasons: { stop_loss: 8, timeout: 4 } }),
			{ ...baseConfig, min_quality_score: 40 },
		);
		const size = r.proposals.find((p) => p.field === 'per_trade_lamports');
		const quality = r.proposals.find((p) => p.field === 'min_quality_score');
		expect(size).toBeTruthy();
		expect(size.to).toBeLessThan(baseConfig.per_trade_lamports); // cut size
		expect(quality).toBeTruthy();
		expect(quality.to).toBe(45); // +STEP
	});

	it('never moves a field by more than its per-run step', () => {
		// A wildly-off trailing arm: proposal must still be within STEP of current.
		const r = proposeAdjustments(
			stats({ closed: 10, wins: 6, winRate: 60, avgPnlPct: 3, bestPnlPct: 80, exitReasons: { trailing_stop: 7, timeout: 3 } }),
			{ ...baseConfig, trailing_stop_pct: 25 },
		);
		const trail = r.proposals.find((p) => p.field === 'trailing_stop_pct');
		if (trail) expect(Math.abs(trail.to - 25)).toBeLessThanOrEqual(STEP.trailing_stop_pct);
	});

	it('clamps every proposal to its hard bounds', () => {
		const r = proposeAdjustments(
			stats({ closed: 20, wins: 18, winRate: 90, avgPnlPct: 60, bestPnlPct: 300, exitReasons: { timeout: 10, take_profit: 10 } }),
			{ ...baseConfig, take_profit_pct: null, per_trade_lamports: 190_000_000 },
		);
		for (const p of r.proposals) {
			const b = BOUNDS[p.field];
			expect(p.to).toBeGreaterThanOrEqual(b.min);
			expect(p.to).toBeLessThanOrEqual(b.max);
		}
	});

	it('scales a proven arm up but never past the hard per-trade ceiling', () => {
		const r = proposeAdjustments(
			stats({ closed: 20, wins: 16, winRate: 80, avgPnlPct: 25, exitReasons: { take_profit: 12, trailing_stop: 8 } }),
			{ ...baseConfig, per_trade_lamports: 190_000_000 },
		);
		const size = r.proposals.find((p) => p.field === 'per_trade_lamports');
		if (size) expect(size.to).toBeLessThanOrEqual(BOUNDS.per_trade_lamports.max);
	});

	it('never emits a no-op proposal', () => {
		const r = proposeAdjustments(
			stats({ closed: 15, wins: 9, exitReasons: { trailing_stop: 8, timeout: 7 } }),
			baseConfig,
		);
		for (const p of r.proposals) expect(p.to).not.toBe(p.from);
	});
});

describe('bestOracleThreshold (Bridge 2)', () => {
	it('finds the conviction floor where wins concentrate', () => {
		// Low-conviction coins mostly lose; >=70 mostly win.
		const buckets = [
			{ lo: 30, closed: 6, wins: 1 },
			{ lo: 50, closed: 4, wins: 1 },
			{ lo: 70, closed: 5, wins: 4 },
			{ lo: 85, closed: 3, wins: 3 },
		];
		expect(bestOracleThreshold(buckets)).toBe(70);
	});

	it('returns null when conviction does not separate outcomes', () => {
		const buckets = [
			{ lo: 30, closed: 5, wins: 3 },
			{ lo: 70, closed: 5, wins: 3 },
		];
		expect(bestOracleThreshold(buckets)).toBeNull();
	});

	it('returns null on too little data', () => {
		expect(bestOracleThreshold([{ lo: 70, closed: 3, wins: 3 }])).toBeNull();
		expect(bestOracleThreshold([])).toBeNull();
		expect(bestOracleThreshold(null)).toBeNull();
	});
});

describe('Rule O: optimizer uses Oracle conviction', () => {
	it('sets min_oracle_score toward the winning conviction band', () => {
		const r = proposeAdjustments(
			stats({
				closed: 18, wins: 8, winRate: 44, avgPnlPct: 5,
				exitReasons: { stop_loss: 6, trailing_stop: 6, timeout: 6 },
				oracleBuckets: [
					{ lo: 30, closed: 8, wins: 1 },
					{ lo: 50, closed: 4, wins: 1 },
					{ lo: 70, closed: 6, wins: 5 },
				],
			}),
			{ ...baseConfig, min_oracle_score: null },
		);
		const o = r.proposals.find((p) => p.field === 'min_oracle_score');
		expect(o).toBeTruthy();
		expect(o.from).toBe(null);
		expect(o.to).toBe(70);
	});

	it('does nothing when the arm has no oracle-scored trades', () => {
		const r = proposeAdjustments(
			stats({ closed: 12, wins: 7, oracleBuckets: [] }),
			{ ...baseConfig, min_oracle_score: null },
		);
		expect(r.proposals.find((p) => p.field === 'min_oracle_score')).toBeFalsy();
	});
});
