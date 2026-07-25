/**
 * Earned autonomy: an arm's realized record decides how much rope it gets.
 *
 * These lock in the policy that matters when real money is behind it:
 *   - profit earns freedom, and a flat/noise record does not,
 *   - a bleeding arm is demoted, not merely left alone,
 *   - the tier is symmetric: it can be lost as easily as it is gained,
 *   - higher tiers only ever WIDEN bounds and unlock fields, never narrow them,
 *   - no tier can remove the stop-loss or reach a safety rail.
 */

import { describe, expect, it } from 'vitest';
import {
	GATES,
	MIN_EDGE_PCT,
	TIER_ORDER,
	atLeast,
	boundsFor,
	budgetWeightFor,
	classifyAutonomy,
	describeTier,
	knowledgeFor,
	stepsFor,
	unsetOkFor,
	writableFor,
} from '../api/_lib/sniper-autonomy.js';

const record = (over) => ({ closed: 20, wins: 8, netPnlLamports: 5_000_000, avgPnlPct: 2, ...over });

describe('classifyAutonomy', () => {
	it('promotes a profitable arm with a real sample to trusted', () => {
		const r = classifyAutonomy(record({ closed: 33, wins: 12, netPnlLamports: 2_671_000, avgPnlPct: 0.81 }));
		expect(r.tier).toBe('trusted');
		expect(r.evidence.closed).toBe(33);
		expect(r.reason).toMatch(/profitable/i);
	});

	it('does not promote on a win rate alone when the arm loses money', () => {
		// 60% of trades win but the losers are bigger: this is not an edge.
		const r = classifyAutonomy(record({ closed: 62, wins: 37, netPnlLamports: -20_105_000, avgPnlPct: -3.24 }));
		expect(r.tier).toBe('probation');
	});

	it('promotes a low-hit-rate arm that is genuinely profitable', () => {
		// The case the win-rate-only view gets wrong: rare but large winners. A 16%
		// hit rate would look like a failing arm; the P&L says it is the best one.
		const r = classifyAutonomy(record({ closed: 45, wins: 7, netPnlLamports: 90_000_000, avgPnlPct: 12 }));
		expect(r.tier).toBe('autonomous');
		expect(r.evidence.win_rate_pct).toBeLessThan(20);
	});

	it('treats a noise-level edge as no edge', () => {
		const r = classifyAutonomy(record({ closed: 40, wins: 10, netPnlLamports: 81_000, avgPnlPct: 0.04 }));
		expect(r.tier).toBe('standard');
		expect(r.reason).toMatch(/no decisive edge/i);
	});

	it('holds back on an insufficient sample regardless of the numbers', () => {
		const hot = classifyAutonomy(record({ closed: 3, wins: 3, netPnlLamports: 500_000_000, avgPnlPct: 400 }));
		expect(hot.tier).toBe('standard');
		const cold = classifyAutonomy(record({ closed: 6, wins: 0, netPnlLamports: -40_000_000, avgPnlPct: -60 }));
		expect(cold.tier).toBe('standard');
	});

	it('demotes a proven bleed to probation', () => {
		const r = classifyAutonomy(record({ closed: 30, wins: 1, netPnlLamports: -23_442_000, avgPnlPct: -13 }));
		expect(r.tier).toBe('probation');
		expect(r.reason).toMatch(/bleed/i);
	});

	it('is symmetric: the same arm loses its tier when the record turns', () => {
		const good = { closed: 50, wins: 20, netPnlLamports: 60_000_000, avgPnlPct: 8 };
		expect(classifyAutonomy(good).tier).toBe('autonomous');
		// Same sample size, record has gone negative.
		expect(classifyAutonomy({ ...good, netPnlLamports: -60_000_000, avgPnlPct: -8 }).tier).toBe('probation');
	});

	it('requires the autonomous gate on both sample and edge', () => {
		// Enough edge, not enough sample → trusted, not autonomous.
		expect(classifyAutonomy(record({ closed: GATES.autonomous.closed - 1, netPnlLamports: 9e7, avgPnlPct: 20 })).tier).toBe('trusted');
		// Enough sample, edge below the autonomous bar → trusted.
		expect(classifyAutonomy(record({ closed: GATES.autonomous.closed + 10, netPnlLamports: 9e6, avgPnlPct: 2 })).tier).toBe('trusted');
	});

	it('never throws on missing or malformed input', () => {
		expect(classifyAutonomy(undefined).tier).toBe('standard');
		expect(classifyAutonomy({}).tier).toBe('standard');
		expect(classifyAutonomy({ closed: 'x', netPnlLamports: null, avgPnlPct: NaN }).tier).toBe('standard');
	});

	it('reports evidence a human can check', () => {
		const r = classifyAutonomy(record({ closed: 20, wins: 5, netPnlLamports: 1e9, avgPnlPct: 6 }));
		expect(r.evidence).toMatchObject({ closed: 20, wins: 5, net_pnl_sol: 1, win_rate_pct: 25 });
	});
});

describe('tier grants', () => {
	it('only ever widens as the tier rises', () => {
		const fields = ['take_profit_pct', 'trailing_stop_pct', 'max_hold_seconds', 'per_trade_lamports'];
		for (let i = 1; i < TIER_ORDER.length; i++) {
			const lower = boundsFor(TIER_ORDER[i - 1]);
			const higher = boundsFor(TIER_ORDER[i]);
			for (const f of fields) {
				expect(higher[f].max, `${TIER_ORDER[i]}.${f}.max`).toBeGreaterThanOrEqual(lower[f].max);
				expect(higher[f].min, `${TIER_ORDER[i]}.${f}.min`).toBeLessThanOrEqual(lower[f].min);
			}
		}
	});

	it('keeps a hard stop-loss at every tier, including the most autonomous', () => {
		for (const tier of TIER_ORDER) {
			const b = boundsFor(tier).stop_loss_pct;
			expect(b).toBeTruthy();
			expect(b.min).toBeGreaterThan(0);       // a 0% stop would be no stop
			expect(b.max).toBeLessThanOrEqual(65);  // and it can never widen to "never sell"
		}
	});

	it('never exposes a safety rail as writable at any tier', () => {
		// These are enforced in executeBuy and must stay out of every loop's reach.
		const rails = [
			'max_concurrent_positions', 'firewall_level', 'max_price_impact_pct',
			'daily_budget_lamports', 'kill_switch', 'enabled', 'slippage_bps',
		];
		for (const tier of TIER_ORDER) {
			const writable = writableFor(tier);
			for (const rail of rails) expect(writable.has(rail), `${tier} must not write ${rail}`).toBe(false);
		}
	});

	it('unlocks the exploration fields only once an arm is trusted', () => {
		const earnedOnly = ['llm_min_confidence', 'min_market_cap_usd', 'max_market_cap_usd', 'initials_out_multiple'];
		for (const f of earnedOnly) {
			expect(writableFor('probation').has(f)).toBe(false);
			expect(writableFor('standard').has(f)).toBe(false);
			expect(writableFor('trusted').has(f)).toBe(true);
			expect(writableFor('autonomous').has(f)).toBe(true);
		}
	});

	it('lets any tier set a missing trailing stop, since that only protects', () => {
		for (const tier of TIER_ORDER) expect(unsetOkFor(tier).has('trailing_stop_pct')).toBe(true);
	});

	it('lets only an earned arm switch the ladder on from unset', () => {
		expect(unsetOkFor('standard').has('initials_out_multiple')).toBe(false);
		expect(unsetOkFor('trusted').has('initials_out_multiple')).toBe(true);
	});

	it('scales steps and budget weight monotonically with tier', () => {
		const base = { take_profit_pct: 15, per_trade_fraction: 0.2 };
		let prevStep = 0;
		let prevWeight = 0;
		for (const tier of TIER_ORDER) {
			const step = stepsFor(tier, base).take_profit_pct;
			expect(step).toBeGreaterThan(prevStep);
			prevStep = step;
			const w = budgetWeightFor(tier);
			expect(w).toBeGreaterThan(prevWeight);
			prevWeight = w;
		}
	});

	it('keeps a scaled size step a sane fraction', () => {
		for (const tier of TIER_ORDER) {
			const f = stepsFor(tier, { per_trade_fraction: 0.2 }).per_trade_fraction;
			expect(f).toBeGreaterThan(0);
			expect(f).toBeLessThanOrEqual(0.75);
		}
	});

	it('deepens the knowledge pack only for earned tiers', () => {
		expect(knowledgeFor('probation')).toBe('base');
		expect(knowledgeFor('standard')).toBe('base');
		expect(knowledgeFor('trusted')).toBe('informed');
		expect(knowledgeFor('autonomous')).toBe('full');
	});

	it('falls back to standard for an unknown tier rather than guessing', () => {
		expect(boundsFor('bogus')).toEqual(boundsFor('standard'));
		expect(writableFor(undefined)).toEqual(writableFor('standard'));
		expect(budgetWeightFor(null)).toBe(budgetWeightFor('standard'));
		expect(knowledgeFor('')).toBe('base');
	});

	it('orders tiers correctly', () => {
		expect(atLeast('trusted', 'autonomous')).toBe(true);
		expect(atLeast('trusted', 'trusted')).toBe(true);
		expect(atLeast('trusted', 'standard')).toBe(false);
		expect(atLeast('trusted', 'probation')).toBe(false);
	});

	it('describes every tier', () => {
		for (const tier of TIER_ORDER) expect(describeTier(tier)).toBeTruthy();
	});

	it('treats the edge floor as the profit/noise boundary', () => {
		const justUnder = classifyAutonomy(record({ closed: 20, netPnlLamports: 1, avgPnlPct: MIN_EDGE_PCT - 0.01 }));
		const justOver = classifyAutonomy(record({ closed: 20, netPnlLamports: 1, avgPnlPct: MIN_EDGE_PCT }));
		expect(justUnder.tier).toBe('standard');
		expect(justOver.tier).toBe('trusted');
	});
});
