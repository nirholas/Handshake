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
import { proposeAdjustments, bestOracleThreshold, MIN_SAMPLE, MIN_SAMPLE_WINLESS, BOUNDS, STEP } from '../api/_lib/sniper-optimizer.js';
import { boundsFor } from '../api/_lib/sniper-autonomy.js';

const BOUNDS_TRUSTED = boundsFor('trusted');

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

	// The production blind spot this rule closes: rules-proven sat at 0 wins in
	// 6 closes and intel-quality at 0 in 11, both bleeding at full size because
	// every throttle rule waited for a bigger sample.
	it('throttles a winless arm below MIN_SAMPLE (and proposes nothing else)', () => {
		const r = proposeAdjustments(
			stats({ closed: MIN_SAMPLE_WINLESS, wins: 0, winRate: 0, avgPnlPct: -30, netPnlLamports: -56_000_000, exitReasons: { stop_loss: 4, timeout: 2 } }),
			baseConfig,
		);
		expect(r.acted).toBe(true);
		expect(r.proposals).toHaveLength(1);
		expect(r.proposals[0].field).toBe('per_trade_lamports');
		expect(r.proposals[0].to).toBeLessThan(baseConfig.per_trade_lamports);
		expect(r.notes).toContain('candidate_for_disable');
	});

	it('throttles a winless arm between MIN_SAMPLE and the sustained-underperformance sample', () => {
		const r = proposeAdjustments(
			stats({ closed: 11, wins: 0, winRate: 0, avgPnlPct: -25, netPnlLamports: -126_000_000, exitReasons: { stop_loss: 6, timeout: 5 } }),
			baseConfig,
		);
		const size = r.proposals.find((p) => p.field === 'per_trade_lamports');
		expect(size).toBeTruthy();
		expect(size.to).toBeLessThan(baseConfig.per_trade_lamports);
		expect(r.notes).toContain('candidate_for_disable');
	});

	it('still no-ops a winless arm below the winless floor', () => {
		const r = proposeAdjustments(
			stats({ closed: MIN_SAMPLE_WINLESS - 1, wins: 0, winRate: 0, netPnlLamports: -10_000_000 }),
			baseConfig,
		);
		expect(r.acted).toBe(false);
		expect(r.proposals).toHaveLength(0);
	});

	it('does not throttle a small winless sample that is not losing money', () => {
		const r = proposeAdjustments(
			stats({ closed: MIN_SAMPLE_WINLESS, wins: 0, winRate: 0, netPnlLamports: 0 }),
			baseConfig,
		);
		expect(r.acted).toBe(false);
	});

	// Lesson one of the fleet's own postmortem: win rate and unweighted average
	// percent are vanity metrics. Position sizes vary ~50x, so an arm can post a
	// positive average percent while losing real money on its big bets.
	it('shrinks size when average percent is positive but net PnL is negative', () => {
		const r = proposeAdjustments(
			stats({ closed: 25, wins: 10, winRate: 40, avgPnlPct: 6.4, netPnlLamports: -223_000_000, exitReasons: { trailing_stop: 13, timeout: 12 } }),
			baseConfig,
		);
		const size = r.proposals.find((p) => p.field === 'per_trade_lamports');
		expect(size).toBeTruthy();
		expect(size.to).toBeLessThan(baseConfig.per_trade_lamports);
		expect(r.notes).toContain('size_weighted_divergence');
	});

	it('never scales a money-losing arm up on win rate alone', () => {
		// 60% win rate and +12% average would have passed the old provenByWinRate
		// gate and handed this arm a BIGGER position while it bled real SOL.
		const r = proposeAdjustments(
			stats({ closed: 20, wins: 12, winRate: 60, avgPnlPct: 12, netPnlLamports: -80_000_000 }),
			baseConfig,
		);
		const size = r.proposals.find((p) => p.field === 'per_trade_lamports');
		expect(size).toBeTruthy();
		expect(size.to).toBeLessThan(baseConfig.per_trade_lamports); // shrunk, not grown
	});

	it('still scales a genuinely profitable high-win-rate arm up', () => {
		const r = proposeAdjustments(
			stats({ closed: 20, wins: 12, winRate: 60, avgPnlPct: 12, netPnlLamports: 40_000_000 }),
			baseConfig,
		);
		const size = r.proposals.find((p) => p.field === 'per_trade_lamports');
		expect(size).toBeTruthy();
		expect(size.to).toBeGreaterThan(baseConfig.per_trade_lamports);
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

	// The silent-death bug: this optimizer owns per_trade_lamports while the
	// evolution loop owns daily_budget_lamports, and neither read the other. A size
	// above the arm's whole daily budget fails `spent + size <= budget` on every
	// evaluation, even at zero spend — two live arms sat armed and unable to buy for
	// a week that way.
	it('never proposes a bet larger than the arm’s own daily budget', () => {
		const r = proposeAdjustments(
			stats({ closed: 20, wins: 16, winRate: 80, avgPnlPct: 25, exitReasons: { take_profit: 12, trailing_stop: 8 } }),
			{ ...baseConfig, per_trade_lamports: 19_000_000, daily_budget_lamports: 20_000_000 },
			{ tier: 'trusted' },
		);
		const size = r.proposals.find((p) => p.field === 'per_trade_lamports');
		if (size) expect(size.to).toBeLessThanOrEqual(20_000_000);
	});

	it('leaves sizing alone when the budget comfortably covers it', () => {
		const r = proposeAdjustments(
			stats({ closed: 20, wins: 16, winRate: 80, avgPnlPct: 25, exitReasons: { take_profit: 12, trailing_stop: 8 } }),
			baseConfig,
			{ tier: 'trusted' },
		);
		const size = r.proposals.find((p) => p.field === 'per_trade_lamports');
		if (size) expect(size.to).toBeGreaterThan(baseConfig.per_trade_lamports);
	});

	it('never emits a no-op proposal', () => {
		const r = proposeAdjustments(
			stats({ closed: 15, wins: 9, exitReasons: { trailing_stop: 8, timeout: 7 } }),
			baseConfig,
		);
		for (const p of r.proposals) expect(p.to).not.toBe(p.from);
	});
});

describe('earned autonomy: the optimizer scales with the arm', () => {
	// A profitable arm: net positive, real sample, winners that run past the average
	// exit. This is the record that buys extra freedom.
	const profitable = stats({
		closed: 33, wins: 12, winRate: 36, avgPnlPct: 6, bestPnlPct: 71,
		netPnlLamports: 2_671_000, exitReasons: { trailing_stop: 12, timeout: 11, stop_loss: 10 },
	});

	it('defaults to standard behaviour when no tier is passed', () => {
		const untiered = proposeAdjustments(profitable, baseConfig);
		const standard = proposeAdjustments(profitable, baseConfig, { tier: 'standard' });
		expect(untiered.proposals).toEqual(standard.proposals);
		expect(untiered.tier).toBe('standard');
	});

	it('refuses to touch an unlocked field for an arm that has not earned it', () => {
		const config = { ...baseConfig, decision_mode: 'llm', llm_min_confidence: 0.65, min_market_cap_usd: 10_000 };
		for (const tier of ['standard', 'probation']) {
			const r = proposeAdjustments(profitable, config, { tier });
			expect(r.proposals.find((p) => p.field === 'llm_min_confidence')).toBeFalsy();
			expect(r.proposals.find((p) => p.field === 'min_market_cap_usd')).toBeFalsy();
			expect(r.proposals.find((p) => p.field === 'initials_out_multiple')).toBeFalsy();
		}
	});

	it('lowers a profitable LLM arm’s confidence floor so it takes more shots', () => {
		const r = proposeAdjustments(
			profitable,
			{ ...baseConfig, decision_mode: 'llm', llm_min_confidence: 0.65 },
			{ tier: 'trusted' },
		);
		const conf = r.proposals.find((p) => p.field === 'llm_min_confidence');
		expect(conf).toBeTruthy();
		expect(conf.to).toBeLessThan(0.65);
		expect(conf.to).toBeGreaterThanOrEqual(BOUNDS_TRUSTED.llm_min_confidence.min);
		// Float dust must never reach the DB.
		expect(String(conf.to)).toMatch(/^0\.\d{1,2}$/);
	});

	it('widens a profitable arm’s market-cap band outward on both sides', () => {
		const r = proposeAdjustments(
			profitable,
			{ ...baseConfig, min_market_cap_usd: 10_000, max_market_cap_usd: 100_000 },
			{ tier: 'trusted' },
		);
		const lo = r.proposals.find((p) => p.field === 'min_market_cap_usd');
		const hi = r.proposals.find((p) => p.field === 'max_market_cap_usd');
		expect(lo.to).toBeLessThan(10_000);
		expect(hi.to).toBeGreaterThan(100_000);
	});

	it('never narrows the universe of an arm with no band set', () => {
		const r = proposeAdjustments(profitable, { ...baseConfig, min_market_cap_usd: null, max_market_cap_usd: null }, { tier: 'trusted' });
		expect(r.proposals.find((p) => p.field === 'min_market_cap_usd')).toBeFalsy();
		expect(r.proposals.find((p) => p.field === 'max_market_cap_usd')).toBeFalsy();
	});

	it('turns the take-initials ladder on for an earned arm whose winners run', () => {
		const r = proposeAdjustments(profitable, { ...baseConfig, initials_out_multiple: null }, { tier: 'trusted' });
		const ladder = r.proposals.find((p) => p.field === 'initials_out_multiple');
		expect(ladder).toBeTruthy();
		expect(ladder.from).toBe(null);
		expect(ladder.to).toBe(2);
		expect(r.notes).toContain('ladder_enabled');
	});

	it('scales a net-profitable arm up even at a low win rate', () => {
		// 36% hit rate: Rule D's win-rate path never fires, the profit path must.
		const r = proposeAdjustments(profitable, baseConfig, { tier: 'trusted' });
		const size = r.proposals.find((p) => p.field === 'per_trade_lamports');
		expect(size).toBeTruthy();
		expect(size.to).toBeGreaterThan(baseConfig.per_trade_lamports);
		expect(size.reason).toMatch(/does not need a high hit rate/);
	});

	it('still de-risks a losing arm at every tier, including the top one', () => {
		const bleeding = stats({
			closed: 30, wins: 1, winRate: 3, avgPnlPct: -13, netPnlLamports: -23_442_000,
			exitReasons: { stop_loss: 24, timeout: 6 },
		});
		for (const tier of ['probation', 'standard', 'trusted', 'autonomous']) {
			const r = proposeAdjustments(bleeding, baseConfig, { tier });
			const size = r.proposals.find((p) => p.field === 'per_trade_lamports');
			expect(size, `${tier} must cut size on a bleeding arm`).toBeTruthy();
			expect(size.to).toBeLessThan(baseConfig.per_trade_lamports);
			// A losing arm never gets a freedom proposal, whatever tier it holds.
			expect(r.proposals.find((p) => p.field === 'llm_min_confidence')).toBeFalsy();
			expect(r.proposals.find((p) => p.field === 'initials_out_multiple')).toBeFalsy();
		}
	});

	it('clamps every proposal to the acting tier’s bounds', () => {
		for (const tier of ['probation', 'standard', 'trusted', 'autonomous']) {
			const r = proposeAdjustments(
				profitable,
				{ ...baseConfig, decision_mode: 'llm', llm_min_confidence: 0.4, min_market_cap_usd: 2_000, per_trade_lamports: 190_000_000 },
				{ tier },
			);
			const b = boundsFor(tier);
			for (const p of r.proposals) {
				expect(p.to, `${tier}.${p.field}`).toBeGreaterThanOrEqual(b[p.field].min);
				expect(p.to, `${tier}.${p.field}`).toBeLessThanOrEqual(b[p.field].max);
			}
		}
	});

	it('holds a probation arm to a smaller step than a standard one', () => {
		const heavy = stats({
			closed: 20, wins: 4, winRate: 20, avgPnlPct: -9, netPnlLamports: -30_000_000,
			exitReasons: { stop_loss: 14, timeout: 6 },
		});
		const config = { ...baseConfig, min_quality_score: 40 };
		const onProbation = proposeAdjustments(heavy, config, { tier: 'probation' });
		const onStandard = proposeAdjustments(heavy, config, { tier: 'standard' });
		const q = (r) => r.proposals.find((p) => p.field === 'min_quality_score')?.to;
		expect(q(onProbation) - 40).toBeLessThan(q(onStandard) - 40);
	});

	it('never emits a NaN proposal from a malformed column value', () => {
		const r = proposeAdjustments(
			profitable,
			{ ...baseConfig, decision_mode: 'llm', llm_min_confidence: 'not-a-number', min_market_cap_usd: undefined, per_trade_lamports: 'oops' },
			{ tier: 'trusted' },
		);
		for (const p of r.proposals) expect(Number.isFinite(p.to), `${p.field} → ${p.to}`).toBe(true);
	});

	it('reports the tier it acted under', () => {
		expect(proposeAdjustments(profitable, baseConfig, { tier: 'autonomous' }).tier).toBe('autonomous');
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
