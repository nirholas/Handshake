// The Oracle fitting library, and the gate that decides what ships.
//
// Two things are worth pinning here above all else. First, the labels: they are
// the reason the engine was wrong, and a regression in TARGETS would be
// invisible in every downstream number while quietly poisoning the model. Second
// the promotion gate: it runs unattended every six hours with the authority to
// replace the model production scores with, so every way it can say no needs a
// test that proves it still says no.

import { describe, it, expect } from 'vitest';
import {
	TARGETS, FEATURES, HEADS, SCORE_HEAD, LABEL_VERSION, MIN_TRAINING_ROWS,
	TIER_PROBABILITY_ANCHORS,
	bucketLabel, encode, pruneDegenerate, fitLogistic, columnCounts, shrinkWeights,
	auc, precisionAt, brier, reliability, buildModel,
} from '../../api/_lib/oracle/fit.js';
import { judgeCandidate } from '../../api/cron/oracle-refit.js';

/**
 * A synthetic corpus with a real signal in it: `organic_score` drives the
 * outcome, everything else is noise. Deterministic (seeded LCG, no Math.random)
 * so a failure is always reproducible.
 */
function corpus(n = 8000) {
	let seed = 7;
	const rand = () => ((seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff) / 0x7fffffff);
	const rows = [];
	for (let i = 0; i < n; i++) {
		const organic = rand();
		const good = organic > 0.8 && rand() > 0.3;
		const collapsed = !good && rand() > 0.8;
		rows.push({
			features: {
				organic_score: organic,
				bundle_score: rand() * 0.5,
				snipe_ratio: rand(),
				unique_buyers: Math.floor(rand() * 60),
				buy_volume_sol: rand() * 30,
				mc_sol_first_seen: 28 + rand() * 8,
				dev_sold: rand() > 0.7,
			},
			category: rand() > 0.5 ? 'animal' : 'meme',
			creator_launches: Math.floor(rand() * 6),
			creator_wins: rand() > 0.8 ? 1 : 0,
			graduated: good && rand() > 0.7,
			ath_multiple: good ? 3 + rand() * 8 : rand() * 2,
			hold_multiple: good ? 1 + rand() * 4 : collapsed ? rand() * 0.4 : 0.6 + rand() * 0.3,
			outcome: good ? 'pumped' : 'flat',
		});
	}
	return rows;
}

describe('labels', () => {
	it('trains on version 2 rows, the price-independent ones', () => {
		expect(LABEL_VERSION).toBe(2);
	});

	it('a run the holder kept is a win; a run they lost is not', () => {
		const ran = { graduated: false, ath_multiple: 6 };
		expect(TARGETS.win({ ...ran, hold_multiple: 2.4 })).toBe(1);
		expect(TARGETS.win({ ...ran, hold_multiple: 1 })).toBe(1);
		// The exact case that made a Prime call sit on a chart that is a cliff:
		// ran 6x, then handed it all back.
		expect(TARGETS.win({ ...ran, hold_multiple: 0.2 })).toBe(0);
		expect(TARGETS.moon({ ...ran, hold_multiple: 0.2 })).toBe(1);
	});

	it('a rug is measured against what the holder paid, not against a dollar figure', () => {
		expect(TARGETS.rug({ graduated: false, hold_multiple: 0.3 })).toBe(1);
		expect(TARGETS.rug({ graduated: false, hold_multiple: 0.5 })).toBe(1);
		expect(TARGETS.rug({ graduated: false, hold_multiple: 0.51 })).toBe(0);
		// A coin that never moved is a dud, not a rug: nobody was taken.
		expect(TARGETS.rug({ graduated: false, hold_multiple: 0.95, ath_multiple: 1 })).toBe(0);
		// Graduating is the opposite of rugging by definition.
		expect(TARGETS.rug({ graduated: true, hold_multiple: 0.1 })).toBe(0);
	});

	it('refuses to guess when the survival ratio is missing', () => {
		// The old rule defaulted an unknown to "not rugged", which counted every
		// unmeasurable coin as a survivor. Unknown has to mean unknown.
		const noRatio = { graduated: false, ath_multiple: 9, hold_multiple: null };
		expect(TARGETS.win(noRatio)).toBe(0);
		expect(TARGETS.rug(noRatio)).toBe(0);
		expect(TARGETS.moon(noRatio)).toBe(1);
	});

	it('a win is always a run, for every row', () => {
		for (const row of corpus(500)) {
			if (TARGETS.win(row)) expect(TARGETS.moon(row)).toBe(1);
		}
	});
});

describe('bucketing', () => {
	it('is closed over the whole real line and puts a boundary in the upper bucket', () => {
		const f = { edges: [0.2, 0.4] };
		expect(bucketLabel(f, -1)).toBe('<0.2');
		expect(bucketLabel(f, 0.2)).toBe('0.2-0.4');
		expect(bucketLabel(f, 0.4)).toBe('>=0.4');
		expect(bucketLabel(f, 1e9)).toBe('>=0.4');
	});

	it('gives a missing value its own bucket rather than folding it into zero', () => {
		expect(bucketLabel({ edges: [0.5] }, null)).toBe('null');
		expect(bucketLabel({ edges: [0.5] }, undefined)).toBe('null');
		expect(bucketLabel({ categorical: true }, null)).toBe('unknown');
	});

	it('every feature reads its row without throwing on an empty one', () => {
		for (const f of FEATURES) expect(() => bucketLabel(f, f.get({}))).not.toThrow();
	});
});

describe('encode', () => {
	it('assigns one column per distinct feature/bucket pair', () => {
		const rows = corpus(300);
		const { X, stride, columns } = encode(rows, FEATURES.slice(0, 3));
		expect(stride).toBe(3);
		expect(X.length).toBe(rows.length * 3);
		expect(columns.size).toBeGreaterThan(3);
		for (const col of X) expect(col).toBeLessThan(columns.size);
	});
});

describe('pruneDegenerate', () => {
	const rows = corpus(2000);

	it('drops a feature that is always null', () => {
		const always = [{ key: 'dead_signal', pillar: 'structure', get: () => null, edges: [1] }];
		const { features, dropped } = pruneDegenerate(rows, always);
		expect(features).toHaveLength(0);
		expect(dropped[0].key).toBe('dead_signal');
		expect(dropped[0].bucket).toBe('null');
	});

	it('KEEPS a rare bucket with enough rows to fit, because rare is not useless', () => {
		// smart_money_count is non-zero on 0.3% of launches and is the strongest
		// signal in the corpus. A share-based rule would have deleted it.
		const rare = [{
			key: 'rare', pillar: 'pedigree', edges: [1],
			get: (r) => (r.creator_wins >= 1 ? 5 : 0),
		}];
		const { features, dropped } = pruneDegenerate(rows, rare);
		expect(features).toHaveLength(1);
		expect(dropped).toHaveLength(0);
	});

	it('drops a bucket too thin to fit a weight on', () => {
		const tooThin = [{
			key: 'thin', pillar: 'pedigree', edges: [1],
			get: (r, i) => 0,
		}];
		// A single constant bucket: no runner-up at all.
		expect(pruneDegenerate(rows, tooThin).dropped).toHaveLength(1);
	});
});

describe('metrics', () => {
	it('AUC is 1 for perfect separation, 0.5 for none, and tie-corrected', () => {
		expect(auc([0.1, 0.2, 0.8, 0.9], [0, 0, 1, 1])).toBe(1);
		expect(auc([0.9, 0.8, 0.2, 0.1], [0, 0, 1, 1])).toBe(0);
		expect(auc([0.5, 0.5, 0.5, 0.5], [0, 1, 0, 1])).toBe(0.5);
	});

	it('AUC refuses to invent a number when one class is missing', () => {
		expect(auc([0.1, 0.9], [1, 1])).toBe(0.5);
		expect(auc([], [])).toBe(0.5);
	});

	it('precisionAt reads the top slice by predicted probability', () => {
		const p = precisionAt([0.9, 0.8, 0.1, 0.05], [1, 1, 0, 0], 0.5);
		expect(p.n).toBe(2);
		expect(p.rate).toBe(1);
	});

	it('Brier punishes a confident wrong claim hardest', () => {
		expect(brier([1], [0])).toBe(1);
		expect(brier([0], [0])).toBe(0);
		expect(brier([0.5], [1])).toBe(0.25);
	});

	it('reliability tiles the probability line and reports observed against claimed', () => {
		const bands = reliability([0.01, 0.02, 0.9, 0.95], [0, 0, 1, 1]);
		expect(bands[0].lo).toBe(0);
		expect(bands[bands.length - 1].hi).toBe(1);
		expect(bands[0].observed).toBe(0);
		expect(bands[bands.length - 1].observed).toBe(1);
		for (let i = 1; i < bands.length; i++) expect(bands[i].lo).toBe(bands[i - 1].hi);
	});
});

describe('fitLogistic', () => {
	const rows = corpus(4000);
	const { X, stride, columns } = encode(rows);
	const y = Float64Array.from(rows.map(TARGETS.win));

	it('is deterministic: the same rows always give the same weights', () => {
		const a = fitLogistic(X, stride, y, columns.size, { epochs: 3 });
		const b = fitLogistic(X, stride, y, columns.size, { epochs: 3 });
		expect(Array.from(a.w)).toEqual(Array.from(b.w));
		expect(a.intercept).toBe(b.intercept);
	});

	it('learns the signal that is actually in the data', () => {
		const model = fitLogistic(X, stride, y, columns.size, { epochs: 8 });
		const high = columns.get('organic_score >=0.8');
		const low = columns.get('organic_score <0.2');
		expect(model.w[high]).toBeGreaterThan(model.w[low]);
	});

	it('stops at the deadline instead of being killed mid-fit', () => {
		const model = fitLogistic(X, stride, y, columns.size, { epochs: 50, deadlineAt: Date.now() - 1 });
		expect(model.epochs).toBe(0);
	});
});

describe('shrinkWeights', () => {
	it('leaves a well-evidenced weight nearly intact and guts a thin one', () => {
		const counts = Int32Array.from([100000, 200, 10]);
		const out = shrinkWeights({ intercept: 0, w: Float64Array.from([1, 1, 1]), epochs: 1 }, counts, 200);
		expect(out.w[0]).toBeGreaterThan(0.99);
		expect(out.w[1]).toBeCloseTo(0.5, 6);
		expect(out.w[2]).toBeLessThan(0.05);
	});

	it('never flips a sign, only moves toward saying nothing', () => {
		const counts = Int32Array.from([5, 5]);
		const out = shrinkWeights({ intercept: 0, w: Float64Array.from([2, -2]), epochs: 1 }, counts, 200);
		expect(out.w[0]).toBeGreaterThan(0);
		expect(out.w[1]).toBeLessThan(0);
		expect(Math.abs(out.w[0])).toBeLessThan(2);
	});

	it('counts the rows a column actually saw, on the slice it was fitted on', () => {
		const rows = corpus(1000);
		const { X, stride, columns } = encode(rows);
		const counts = columnCounts(X, stride, columns.size, rows.length);
		let total = 0;
		for (const c of counts) total += c;
		expect(total).toBe(rows.length * stride);
	});
});

describe('buildModel', () => {
	const { model, report } = buildModel(corpus(9000), { epochs: 4, fittedAt: '2026-08-28T00:00:00.000Z' });

	it('refuses to fit on too little data rather than shipping a guess', () => {
		expect(() => buildModel(corpus(100))).toThrow(/at least/);
		expect(() => buildModel(null)).toThrow(/at least/);
	});

	it('emits a v3 document scored on the survivable-win head', () => {
		expect(model.version).toBe(3);
		expect(model.score_head).toBe(SCORE_HEAD);
		expect(model.fitted_at).toBe('2026-08-28T00:00:00.000Z');
		for (const head of HEADS) expect(model.heads[head]).toBeTruthy();
	});

	it('holds out the newest quarter and evaluates on launches it never trained on', () => {
		expect(model.holdout.n).toBeGreaterThan(1000);
		expect(model.holdout.split_at + model.holdout.n).toBe(model.training_rows);
		for (const head of HEADS) {
			expect(model.holdout[head].auc).toBeGreaterThan(0);
			expect(model.holdout[head].auc).toBeLessThanOrEqual(1);
		}
	});

	it('recovers the planted signal', () => {
		expect(model.holdout.win.auc).toBeGreaterThan(0.75);
	});

	it('publishes sample size and observed rates for every bucket it kept', () => {
		for (const f of model.features) {
			for (const [bucket, stats] of Object.entries(f.buckets)) {
				expect(stats.n, `${f.key} ${bucket}`).toBeGreaterThan(0);
				for (const head of HEADS) {
					expect(Number.isFinite(stats.w[head])).toBe(true);
					expect(stats.rate[head]).toBeGreaterThanOrEqual(0);
					expect(stats.rate[head]).toBeLessThanOrEqual(1);
				}
			}
		}
	});

	it('stamps the platform anchors so a stored model is self-describing', () => {
		expect(model.tier_probability_anchors).toEqual({ ...TIER_PROBABILITY_ANCHORS });
	});

	it('reports what it dropped and never silently keeps it', () => {
		for (const d of report.dropped) {
			expect(model.features.some((f) => f.key === d.key)).toBe(false);
		}
	});

	it('marks a truncated fit as incomplete so the gate can refuse it', () => {
		const { model: cut } = buildModel(corpus(9000), { epochs: 50, deadlineAt: Date.now() - 1 });
		expect(cut.fit.complete).toBe(false);
		expect(cut.fit.epochs_run).toBeLessThan(50);
	});
});

// ── the promotion gate ───────────────────────────────────────────────────────
// Every one of these is a way production could end up serving a model nobody
// looked at, which is the failure mode of an unattended retrain.

const candidate = (over = {}) => ({
	score_head: 'win',
	training_rows: 300000,
	features: Array.from({ length: 25 }, (_, i) => ({ key: `f${i}`, buckets: {} })),
	fit: { epochs: 14, epochs_run: 14, complete: true },
	holdout: {
		n: 74000,
		win: { auc: 0.85, reliability: [{ lo: 0.45, hi: 1, n: 300, observed: 0.46 }] },
		rug: { auc: 0.92, reliability: [] },
		moon: { auc: 0.89, reliability: [] },
	},
	...over,
});

describe('judgeCandidate', () => {
	it('promotes the first model when there is no incumbent', () => {
		const v = judgeCandidate(candidate(), null);
		expect(v.promote).toBe(true);
		expect(v.reason).toMatch(/first model/);
	});

	it('refuses a fit that ran out of time', () => {
		const v = judgeCandidate(candidate({ fit: { epochs: 14, epochs_run: 6, complete: false } }), null);
		expect(v.promote).toBe(false);
		expect(v.reason).toMatch(/ran out of time/);
	});

	it('refuses a model whose ranking is too weak to publish at all', () => {
		const weak = candidate();
		weak.holdout.win.auc = 0.61;
		expect(judgeCandidate(weak, null).promote).toBe(false);
	});

	it('refuses a model whose top band stops earning what the tier claims', () => {
		const dishonest = candidate();
		dishonest.holdout.win.reliability = [{ lo: 0.45, hi: 1, n: 500, observed: 0.2 }];
		const v = judgeCandidate(dishonest, null);
		expect(v.promote).toBe(false);
		expect(v.reason).toMatch(/do not earn their claim/);
	});

	it('ignores a thin band, because 12 samples cannot convict a model', () => {
		const thin = candidate();
		thin.holdout.win.reliability = [{ lo: 0.45, hi: 1, n: 12, observed: 0 }];
		expect(judgeCandidate(thin, null).promote).toBe(true);
	});

	it('refuses a candidate whose feature set collapsed: that is a broken input', () => {
		const collapsed = candidate({ features: Array.from({ length: 4 }, (_, i) => ({ key: `f${i}` })) });
		const v = judgeCandidate(collapsed, candidate());
		expect(v.promote).toBe(false);
		expect(v.reason).toMatch(/feature set collapsed/);
	});

	it('refuses a challenger that is merely equal, so the live model stops churning', () => {
		const incumbent = candidate();
		const challenger = candidate();
		challenger.holdout.win.auc = 0.8501;
		const v = judgeCandidate(challenger, incumbent);
		expect(v.promote).toBe(false);
		expect(v.reason).toMatch(/no material gain/);
	});

	it('promotes a challenger that is genuinely better', () => {
		const incumbent = candidate();
		const challenger = candidate();
		challenger.holdout.win.auc = 0.87;
		const v = judgeCandidate(challenger, incumbent);
		expect(v.promote).toBe(true);
		expect(v.reason).toMatch(/0\.85 -> 0\.87/);
	});

	it('refuses a challenger that gained on win by wrecking the rug head', () => {
		const incumbent = candidate();
		const challenger = candidate();
		challenger.holdout.win.auc = 0.90;
		challenger.holdout.rug.auc = 0.80;
		const v = judgeCandidate(challenger, incumbent);
		expect(v.promote).toBe(false);
		expect(v.reason).toMatch(/rug head regressed/);
	});

	it('explains itself: every check is reported, pass or fail', () => {
		const v = judgeCandidate(candidate(), candidate());
		expect(v.checks.length).toBeGreaterThan(3);
		for (const c of v.checks) {
			expect(typeof c.check).toBe('string');
			expect(typeof c.pass).toBe('boolean');
			expect(typeof c.detail).toBe('string');
		}
	});
});

describe('constants that other code depends on', () => {
	it('keeps the training floor above a number that could be noise', () => {
		expect(MIN_TRAINING_ROWS).toBeGreaterThanOrEqual(1000);
	});

	it('anchors ascend and stay inside the unit interval', () => {
		const a = TIER_PROBABILITY_ANCHORS;
		expect(a.avoid).toBe(0);
		expect(a.watch).toBeLessThan(a.lean);
		expect(a.lean).toBeLessThan(a.strong);
		expect(a.strong).toBeLessThan(a.prime);
		expect(a.prime).toBeLessThan(1);
	});
});
