// Pins what a conviction score MEANS, and pins the two ways every surface used
// to get it wrong.
//
// 1. A score is a rank on a 0-100 line, not a percentage. 86 claims P=0.55.
//    Three surfaces (the backtest table, its Brier score, the calibration cron)
//    read score/100 as the prediction, which overstated the engine's own claim by
//    up to 4x and made a calibrated ranking look wildly overconfident.
// 2. The engine is fitted to predict a 3x run or a graduation, judged whether or
//    not the coin later collapsed, while the platform's headline win rate
//    excludes anything that ever rugged. Grading the ranking on the stricter
//    definition without saying so is how a correct 100/prime call on a coin that
//    ran 6.7x and then died read as a broken engine.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
	PREDICTED_EVENT, SCORE_ANCHORS, MODEL,
	probabilityFromScore, scoreFromProbability,
} from '../../api/_lib/oracle/conviction.js';
import { ladderCheck, assembleBands, brierScore } from '../../api/oracle/backtest.js';
import { verdictOddsHtml, outcomeStripHtml } from '../../api/oracle-share.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('score to probability', () => {
	it('is the inverse of the probability to score map at every anchor', () => {
		for (const [p, s] of SCORE_ANCHORS) {
			expect(scoreFromProbability(p)).toBe(s);
			expect(probabilityFromScore(s)).toBeCloseTo(p, 6);
		}
	});

	it('does not read the score as a percentage', () => {
		// The exact bug: a score of 86 claims 55%, and the old tables printed 86%.
		expect(probabilityFromScore(86)).toBeCloseTo(MODEL.tier_probability_anchors.prime, 6);
		expect(probabilityFromScore(86)).toBeLessThan(0.86);
		expect(probabilityFromScore(34)).toBeCloseTo(MODEL.tier_probability_anchors.watch, 6);
	});

	it('is monotone and bounded across the whole line', () => {
		let prev = -1;
		for (let s = 0; s <= 100; s++) {
			const p = probabilityFromScore(s);
			expect(p).toBeGreaterThanOrEqual(0);
			expect(p).toBeLessThanOrEqual(1);
			expect(p).toBeGreaterThanOrEqual(prev);
			prev = p;
		}
	});

	it('clamps garbage instead of returning NaN', () => {
		expect(probabilityFromScore(null)).toBe(0);
		expect(probabilityFromScore('nope')).toBe(0);
		expect(probabilityFromScore(1e9)).toBe(1);
		expect(probabilityFromScore(-40)).toBe(0);
	});

	it('names the event it predicts, and that a collapse now DOES undo a hit', () => {
		// v2 ranked the bare spike and said so: a later collapse did not undo a
		// hit. v3 ranks the survivable win, which is the reverse claim, and the
		// caveat has to change with it or every surface quoting it starts lying.
		expect(PREDICTED_EVENT.id).toBe('runs_and_holds');
		expect(PREDICTED_EVENT.label).toMatch(/3x/);
		expect(PREDICTED_EVENT.label).toMatch(/at first sight/);
		expect(PREDICTED_EVENT.caveat).toMatch(/NOT a hit/);
	});
});

describe('ladder monotonicity', () => {
	const band = (name, rate, lo, hi, n = 500) => ({ band: name, n, realized: rate, ci: { lo, hi } });

	it('accepts a dip whose confidence intervals overlap', () => {
		const out = ladderCheck([band('0-10', 5, 3, 7), band('10-20', 4, 2, 6), band('20-30', 9, 7, 11)], 'realized', 'ci');
		expect(out.monotonic).toBe(true);
		expect(out.inversions).toEqual([]);
	});

	it('flags a dip the intervals cannot explain, and names both bands', () => {
		const out = ladderCheck([band('60-70', 16, 15, 18), band('70-80', 11, 9, 13)], 'realized', 'ci');
		expect(out.monotonic).toBe(false);
		expect(out.inversions[0]).toMatchObject({ band: '70-80', realized: 11, below_band: '60-70', below_realized: 16 });
	});

	it('never calls a real inversion monotonic just because it is small', () => {
		// The retired check allowed any drop under 5 points, which is exactly the
		// size of the drop production was shipping.
		const out = ladderCheck([band('20-30', 6, 6, 7, 10724), band('30-40', 3, 3, 3, 8037)], 'realized', 'ci');
		expect(out.monotonic).toBe(false);
	});

	it('ignores bands too thin to judge', () => {
		const out = ladderCheck([band('80-90', 40, 30, 55, 20), band('90-100', 10, 8, 12, 800)], 'realized', 'ci');
		expect(out.judged_bands).toBe(1);
		expect(out.monotonic).toBe(true);
	});
});

describe('calibration bands', () => {
	// The real shape of the top band in production (n=792, 208 clean wins, 540 that
	// ran 3x or graduated) split across two exact scores.
	const rows = [
		{ score: 16, n: 24344, spikes: 3200, wins: 1184 },
		{ score: 95, n: 500, spikes: 340, wins: 130 },
		{ score: 100, n: 292, spikes: 200, wins: 78 },
	];

	it('reports both realized rates against the claim the score actually makes', () => {
		const [low, top] = assembleBands(rows);
		expect(low.band).toBe('10-20');
		expect(top.band).toBe('90-100');
		expect(top.n).toBe(792);
		expect(top.realized).toBe(26);        // graduated or 2x without ever rugging
		expect(top.realized_spike).toBe(68);  // the trained event
		// The retired code would have printed 95 here (the band midpoint). What it
		// prints instead is the probability the 90-100 band actually claims, which
		// moved when v3 re-anchored the ladder for a harder target.
		expect(top.predicted).toBeLessThan(95);
		// It is the sample-weighted mean of what each score in the band claims,
		// which is anchor-independent and therefore still true after a re-anchor.
		const inBand = rows.filter((r) => r.score >= 90);
		const weighted = inBand.reduce((a, r) => a + r.n * probabilityFromScore(r.score), 0)
			/ inBand.reduce((a, r) => a + r.n, 0);
		expect(top.predicted).toBe(Math.round(100 * weighted));
	});

	it('drops empty bands instead of inventing zero rows', () => {
		expect(assembleBands(rows).map((b) => b.band)).toEqual(['10-20', '90-100']);
		expect(assembleBands([])).toEqual([]);
	});

	it('puts a perfect 100 in the top band rather than off the end', () => {
		const bands = assembleBands([{ score: 100, n: 10, spikes: 5, wins: 3 }]);
		expect(bands).toHaveLength(1);
		expect(bands[0].band).toBe('90-100');
		expect(bands[0].n).toBe(10);
	});

	it('scores Brier per exact score, not per band', () => {
		// Pinned loosely on purpose: the exact value tracks the tier anchors, and
		// re-pinning a magic constant on every re-anchor teaches nobody anything.
		// What must hold is that it is scored per exact score, which the bounds and
		// the degenerate cases below establish.
		expect(brierScore(rows)).toBeGreaterThan(0.12);
		expect(brierScore(rows)).toBeLessThan(0.14);
		expect(brierScore([])).toBeNull();
		// A claim of 1.0 that never happens is the worst possible score.
		expect(brierScore([{ score: 100, n: 1, spikes: 0 }])).toBe(1);
	});
});

describe('the coin page states the odds and the outcome next to the score', () => {
	it('quotes the band hit rate rather than implying the score is a probability', () => {
		const html = verdictOddsHtml(100, '2026-08-14T03:02:07.434Z', '2026-08-14T03:01:13.000Z');
		expect(html).toMatch(/band have won/);
		expect(html).toMatch(/54s after this coin surfaced/);
		expect(html).toMatch(/not the odds of a safe hold/);
		expect(html).not.toMatch(/100% of calls/);
	});

	it('renders a rugged run as a run that rugged', () => {
		const html = outcomeStripHtml({ graduated: false, rugged: true, ath_multiple: '6.675', last_market_cap_usd: '2204.27' });
		expect(html).toMatch(/peak <b>6\.7x<\/b>/);
		expect(html).toMatch(/rugged/);
		expect(html).toMatch(/\$2\.2K/);
	});

	it('says nothing when the market has not resolved the coin', () => {
		expect(outcomeStripHtml({ graduated: false, rugged: false, ath_multiple: null })).toBe('');
		expect(outcomeStripHtml(null)).toBe('');
	});

	it('keeps the hero honesty lines server-rendered, so a share preview carries them too', () => {
		const src = readFileSync(join(ROOT, 'api/oracle-share.js'), 'utf8');
		expect(src).toMatch(/id="ocOdds"/);
		expect(src).toMatch(/id="ocSince"/);
		// The client mirrors both (buildless file, no imports) and must keep filling them.
		const client = readFileSync(join(ROOT, 'public/oracle-coin.js'), 'utf8');
		expect(client).toMatch(/#ocOdds/);
		expect(client).toMatch(/#ocSince/);
	});
});
