// Oracle conviction calibration: the realized-outcome layer.
//
// The score is a rank on a 0-100 line, not a percentage. These tests pin the
// pieces that keep that fact from drifting: the isotonic fit, the lookup that
// serves the realized rate behind a score, and the card-ready reasons the engine
// emits so a feed card can say WHY a coin scored instead of replaying a per-tier
// template.
//
// The separately-generated calibration file is gone. It declared its own win
// definition as "graduated or (ath_multiple >= 2 and not rugged)", which was
// built on a rug flag that tracked the SOL price rather than the coin, so its
// numbers were noise. hitRateFor now reads the active model's OWN held-out
// reliability curve, which ships with the weights and therefore cannot drift out
// of sync with them.

import { describe, it, expect } from 'vitest';
import {
	convict,
	hitRateFor,
	tierForScore,
	MODEL,
} from '../../api/_lib/oracle/conviction.js';
import { isotonic } from '../../scripts/oracle-calibrate.mjs';

const launch = (over = {}) => ({
	category: 'animal',
	launch: {
		organic_score: 0.85, bundle_score: 0.15, snipe_ratio: 0.2, coordination_score: 0.15,
		timing_entropy: 0.7, concentration_top1: 0.1, concentration_top10: 0.5,
		unique_buyers: 55, buy_sell_ratio: 2.5, buy_volume_sol: 30, largest_buy_sol: 6,
		avg_buy_sol: 0.6, dev_buy_sol: 0.3, mc_sol_first_seen: 29, dev_sold: false,
		...over,
	},
	creator: { launches: 4, launchWins: 2 },
	smartMoney: { notable: [] },
});

describe('isotonic', () => {
	it('leaves an already-monotone ladder untouched', () => {
		const bands = [{ n: 100, wins: 10 }, { n: 100, wins: 20 }, { n: 100, wins: 40 }];
		expect(isotonic(bands)).toEqual([0.1, 0.2, 0.4]);
	});

	it('pools a band that dips below its neighbour, weighted by sample size', () => {
		// 30% then 10% cannot both be true of a monotone ladder. With three times
		// the sample in the second band, the pooled rate leans to it.
		const bands = [{ n: 100, wins: 30 }, { n: 300, wins: 30 }];
		const out = isotonic(bands);
		expect(out[0]).toBeCloseTo(0.15, 6);
		expect(out[1]).toBeCloseTo(0.15, 6);
	});

	it('cascades a pool backwards when the merge breaks an earlier rung', () => {
		const out = isotonic([{ n: 10, wins: 5 }, { n: 10, wins: 6 }, { n: 10, wins: 1 }]);
		expect(out).toEqual([0.4, 0.4, 0.4]);
		for (let i = 1; i < out.length; i++) expect(out[i]).toBeGreaterThanOrEqual(out[i - 1]);
	});

	it('never returns a rate outside [0,1] or a backwards step, over any band set', () => {
		const bands = [
			{ n: 7939, wins: 56 }, { n: 24344, wins: 1184 }, { n: 10724, wins: 684 },
			{ n: 8037, wins: 231 }, { n: 4549, wins: 340 }, { n: 1947, wins: 133 },
			{ n: 2231, wins: 368 }, { n: 824, wins: 89 }, { n: 529, wins: 80 }, { n: 792, wins: 208 },
		];
		const out = isotonic(bands);
		expect(out).toHaveLength(bands.length);
		for (let i = 0; i < out.length; i++) {
			expect(out[i]).toBeGreaterThanOrEqual(0);
			expect(out[i]).toBeLessThanOrEqual(1);
			if (i) expect(out[i]).toBeGreaterThanOrEqual(out[i - 1] - 1e-12);
		}
	});
});

describe('the model ships its own calibration', () => {
	it('carries a held-out reliability curve for the head it scores', () => {
		const holdout = MODEL.holdout?.[MODEL.score_head];
		expect(holdout).toBeTruthy();
		expect(holdout.reliability.length).toBeGreaterThan(2);
		expect(MODEL.holdout.n).toBeGreaterThan(1000);
	});

	it('tiles the probability line with no gap or overlap', () => {
		const bands = MODEL.holdout[MODEL.score_head].reliability;
		expect(bands[0].lo).toBe(0);
		expect(bands[bands.length - 1].hi).toBe(1);
		for (let i = 1; i < bands.length; i++) expect(bands[i].lo).toBe(bands[i - 1].hi);
	});

	it('is monotone: a higher band never observed a lower rate', () => {
		const rates = MODEL.holdout[MODEL.score_head].reliability
			.filter((b) => b.n >= 100).map((b) => b.observed);
		for (let i = 1; i < rates.length; i++) expect(rates[i]).toBeGreaterThanOrEqual(rates[i - 1]);
	});

	it('earns the probability every populated band claims', () => {
		// The promotion gate refuses a model that fails this, so a shipped model
		// that fails it means the gate was bypassed.
		for (const b of MODEL.holdout[MODEL.score_head].reliability) {
			if (b.n < 100) continue;
			expect(b.observed).toBeGreaterThanOrEqual(b.lo * 0.7);
		}
	});

	it('publishes a base rate for every head it fitted', () => {
		for (const [head, stats] of Object.entries(MODEL.heads)) {
			expect(stats.base_rate).toBeGreaterThan(0);
			expect(stats.base_rate).toBeLessThan(1);
			expect(Number.isFinite(stats.intercept)).toBe(true);
			expect(MODEL.holdout[head].auc).toBeGreaterThan(0.5);
		}
	});
});

describe('hitRateFor', () => {
	it('serves the reliability band a score maps into', () => {
		const top = hitRateFor(95);
		expect(top.band).toBeTruthy();
		expect(top.n).toBeGreaterThan(0);
		expect(top.rate).toBeGreaterThan(0);
		expect(top.baseRate).toBeGreaterThan(0);
	});

	it('names the event it is counting, so no surface has to guess', () => {
		expect(hitRateFor(95).predicts.id).toBe('runs_and_holds');
	});

	it('clamps out-of-range and non-numeric input instead of returning nothing', () => {
		expect(hitRateFor(140).band).toBe(hitRateFor(100).band);
		expect(hitRateFor(-20).band).toBe(hitRateFor(0).band);
		expect(hitRateFor(null).band).toBe(hitRateFor(0).band);
		expect(hitRateFor(undefined).rate).toBeGreaterThanOrEqual(0);
	});

	it('is monotone in the score, so a better rank never advertises worse odds', () => {
		let prev = -1;
		for (let s = 0; s <= 100; s += 1) {
			const r = hitRateFor(s).rate;
			expect(r).toBeGreaterThanOrEqual(prev);
			prev = r;
		}
	});

	it('states a lift consistent with its own rate and the base rate', () => {
		const hr = hitRateFor(95);
		expect(hr.lift).toBeCloseTo(hr.rate / hr.baseRate, 1);
		expect(hr.lift).toBeGreaterThan(3);
	});

	it('reads far below the score, because the score line is not a percentage', () => {
		// 95 on the line claims well under 95%. Conflating the two is what made a
		// working engine read as wildly overconfident, so the gap is asserted.
		expect(hitRateFor(95).rate).toBeLessThan(0.6);
	});
});

describe('tierForScore', () => {
	it('matches the ladder convict() applies', () => {
		expect(tierForScore(100).tier).toBe('prime');
		expect(tierForScore(86).tier).toBe('prime');
		expect(tierForScore(85).tier).toBe('strong');
		expect(tierForScore(72).tier).toBe('strong');
		expect(tierForScore(56).tier).toBe('lean');
		expect(tierForScore(34).tier).toBe('watch');
		expect(tierForScore(0).tier).toBe('avoid');
	});

	it('agrees with the tier convict() puts on a real verdict', () => {
		const v = convict(launch());
		expect(v.tier).toBe(tierForScore(v.score).tier);
	});
});

describe('reasons a card can print', () => {
	it('carries a structured twin of every sentence', () => {
		const v = convict(launch());
		const fitted = v.reasons.filter((r) => r.subject);
		expect(fitted.length).toBeGreaterThan(2);
		for (const r of fitted) {
			expect(r.text).toContain(r.subject);
			expect(r.rate).toBeGreaterThanOrEqual(0);
			expect(r.lift).toBeGreaterThan(0);
		}
	});

	it('phrases a bucket in trader units, never as a raw model label', () => {
		const subjects = convict(launch()).reasons.map((r) => r.subject).filter(Boolean);
		expect(subjects).toContain('40+ early buyers');
		expect(subjects).toContain('25+ SOL bought early');
		// A bucket comparator is the tell that a raw model label reached the card.
		// A range with units ("dev bought 0.05-0.5 SOL") is how a trader says it,
		// so that stays.
		for (const s of subjects) expect(s).not.toMatch(/>=|<\d/);
	});

	it('reads differently for two launches that differ', () => {
		const a = convict(launch()).reasons.map((r) => r.subject).join('|');
		const b = convict(launch({ unique_buyers: 0, buy_volume_sol: 0.2, buy_sell_ratio: 0.3 }))
			.reasons.map((r) => r.subject).join('|');
		expect(a).not.toBe(b);
	});

	it('drops the prime badge that only restated the tier pill beside it', () => {
		const v = convict(launch());
		expect(v.score).toBeGreaterThan(0);
		expect(v.badges).not.toContain('prime');
	});

	it('badges momentum only when that pillar alone would reach prime', () => {
		const hot = convict(launch());
		if (hot.pillars.momentum >= 86) expect(hot.badges).toContain('momentum');
		const cold = convict(launch({ unique_buyers: 0, buy_volume_sol: 0.1, largest_buy_sol: 0.05, buy_sell_ratio: 0.2 }));
		expect(cold.pillars.momentum).toBeLessThan(86);
		expect(cold.badges).not.toContain('momentum');
	});
});
