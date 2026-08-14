// Oracle conviction calibration: the realized-outcome layer.
//
// The score is a rank on a 0-100 line, not a percentage, and the platform grades
// the engine on a stricter question than the score predicts. These tests pin the
// three pieces that keep those facts from drifting back into each other: the
// isotonic fit that produces the table, the lookup that serves it, and the
// card-ready reasons the engine now emits so a feed card can say WHY a coin
// scored instead of replaying a per-tier template.

import { describe, it, expect } from 'vitest';
import {
	convict,
	hitRateFor,
	tierForScore,
	CALIBRATION,
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

describe('the shipped calibration table', () => {
	it('tiles the whole 0-100 score line with no gap or overlap', () => {
		const bands = CALIBRATION.bands;
		expect(bands[0].lo).toBe(0);
		expect(bands[bands.length - 1].hi).toBe(100);
		for (let i = 1; i < bands.length; i++) expect(bands[i].lo).toBe(bands[i - 1].hi);
	});

	it('is monotone: a higher band never claims a lower rate', () => {
		const rates = CALIBRATION.bands.map((b) => b.calibrated);
		for (let i = 1; i < rates.length; i++) expect(rates[i]).toBeGreaterThanOrEqual(rates[i - 1]);
	});

	it('carries the sample it was fitted on and names the event it counts', () => {
		expect(CALIBRATION.resolved_n).toBeGreaterThan(5000);
		expect(CALIBRATION.base_rate).toBeGreaterThan(0);
		expect(CALIBRATION.base_rate).toBeLessThan(1);
		expect(CALIBRATION.win_definition).toMatch(/graduated/);
		expect(CALIBRATION.win_definition).toMatch(/rugged/);
	});

	it('states a lift consistent with its own rate and base rate', () => {
		for (const b of CALIBRATION.bands) {
			expect(b.lift).toBeCloseTo(b.calibrated / CALIBRATION.base_rate, 1);
		}
	});
});

describe('hitRateFor', () => {
	it('serves the band a score falls in', () => {
		const top = hitRateFor(95);
		expect(top.band).toBe('90-100');
		expect(top.rate).toBe(CALIBRATION.bands[CALIBRATION.bands.length - 1].calibrated);
		expect(top.n).toBeGreaterThan(0);
	});

	it('puts a boundary score in the band that starts there, not the one that ends', () => {
		expect(hitRateFor(90).band).toBe('90-100');
		expect(hitRateFor(89).band).toBe('80-90');
	});

	it('clamps out-of-range and non-numeric input instead of returning nothing', () => {
		expect(hitRateFor(100).band).toBe('90-100');
		expect(hitRateFor(140).band).toBe('90-100');
		expect(hitRateFor(-20).band).toBe('0-10');
		expect(hitRateFor(null).band).toBe('0-10');
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

	it('grades a stricter event than the score claims, so it always reads lower', () => {
		// The score predicts a run (graduate or 3x, collapse-independent); this
		// counts only the runs that never rugged. Conflating them is what made a
		// working engine read as a broken one, so the gap is asserted, not assumed.
		expect(hitRateFor(95).rate).toBeLessThan(0.55);
		expect(hitRateFor(95).lift).toBeGreaterThan(3);
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
		expect(v.score).toBeGreaterThanOrEqual(86);
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
