import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { OracleModel, TIERS, bucketLabel } from '../src/index.js';

// The real shipped model, not a fixture. The package's whole promise is that it
// scores the same as production, so the test has to hold it to the same weights
// production boots on. If the bootstrap changes shape, this fails first.
const DOC = JSON.parse(readFileSync(new URL('../../../api/_lib/oracle/conviction-model.json', import.meta.url), 'utf8'));

const strongLaunch = () => ({
	organic_score: 0.85, bundle_score: 0.04, snipe_ratio: 0.12, timing_entropy: 0.82,
	concentration_top1: 0.04, concentration_top5: 0.42, concentration_top10: 0.55,
	unique_buyers: 44, unique_sellers: 2, buy_sell_ratio: 6.2,
	buy_volume_sol: 31, sell_volume_sol: 1.1, net_volume_sol: 30, trade_count: 61,
	largest_buy_sol: 6.4, avg_buy_sol: 0.71, median_buy_sol: 0.3,
	dev_buy_sol: 1.3, dev_sell_sol: 0, dev_sold: false, mc_sol_first_seen: 29.2,
	smart_money_count: 3, coordination_score: 0.05,
	creator_launches: 4, creator_wins: 2, category: 'animal',
});

const deadLaunch = () => ({
	organic_score: 0.04, bundle_score: 0.82, snipe_ratio: 0.93, timing_entropy: 0.08,
	concentration_top1: 0.52, concentration_top5: 0.96, concentration_top10: 0.99,
	unique_buyers: 1, unique_sellers: 14, buy_sell_ratio: 0.18,
	buy_volume_sol: 0.2, sell_volume_sol: 16, net_volume_sol: -15.8, trade_count: 52,
	largest_buy_sol: 0.08, avg_buy_sol: 0.01, median_buy_sol: 0.008,
	dev_buy_sol: 0.01, dev_sell_sol: 3.2, dev_sold: true, mc_sol_first_seen: 41,
	smart_money_count: 0, coordination_score: 0.62,
	creator_launches: 8, creator_wins: 0, category: 'unknown',
});

test('loads the shipped v3 model', () => {
	const m = new OracleModel(DOC);
	assert.ok(m.version >= 3, 'expected a v3+ model');
	assert.equal(m.scoreHead, 'win');
	assert.ok(m.trainingRows > 50_000);
	assert.ok(m.document.features.length >= 15);
});

test('refuses a v2 model rather than scoring it wrong', () => {
	// A v2 document has scalar weights and no heads. Scoring it with v3 code
	// would read `stats.w.win` off a number and silently produce zeros, which is
	// exactly the kind of quiet wrongness this package exists to rule out.
	const v2 = { version: 2, features: [{ key: 'organic_score', buckets: { '<0.2': { w: -1 } } }] };
	assert.throws(() => new OracleModel(v2), /v3\+ model/);
});

test('refuses a document with no features', () => {
	assert.throws(() => new OracleModel({ version: 3, features: [] }), /no features/);
	assert.throws(() => new OracleModel(null), /model document/);
});

test('accepts the full API envelope as well as a bare model', () => {
	const wrapped = new OracleModel({ model: DOC });
	const bare = new OracleModel(DOC);
	assert.equal(wrapped.score(strongLaunch()).score, bare.score(strongLaunch()).score);
});

test('separates a strong launch from a dead one', () => {
	const m = new OracleModel(DOC);
	const strong = m.score(strongLaunch());
	const dead = m.score(deadLaunch());
	assert.ok(strong.score > dead.score, `expected ${strong.score} > ${dead.score}`);
	assert.ok(strong.probabilities.win > dead.probabilities.win);
	assert.equal(dead.tier, 'avoid');
});

test('publishes all three heads and the give-back ratio', () => {
	const m = new OracleModel(DOC);
	const v = m.score(strongLaunch());
	for (const head of ['win', 'rug', 'moon']) {
		assert.ok(typeof v.probabilities[head] === 'number', `missing ${head}`);
		assert.ok(v.probabilities[head] >= 0 && v.probabilities[head] <= 1);
	}
	assert.ok(v.rugRisk >= 0 && v.rugRisk <= 100);
	assert.ok(v.upside >= 0 && v.upside <= 100);
	// give-back is 1 - win/moon: a run you keep cannot also be a run you lost.
	assert.ok(v.giveBackRisk >= 0 && v.giveBackRisk <= 100);
});

test('the score line is not a percentage, and the two maps invert', () => {
	const m = new OracleModel(DOC);
	// 86 is Prime and claims the prime anchor, which is well under 0.86.
	assert.ok(m.probabilityFromScore(86) < 0.6);
	assert.equal(m.probabilityFromScore(86), m.anchors.prime);
	for (const s of [0, 34, 56, 72, 86, 100]) {
		assert.equal(m.scoreFromProbability(m.probabilityFromScore(s)), s, `round trip failed at ${s}`);
	}
});

test('tiers are monotone and cover the whole line', () => {
	const m = new OracleModel(DOC);
	let last = 101;
	for (const t of TIERS) {
		assert.ok(t.min < last, 'tiers must descend');
		last = t.min;
	}
	assert.equal(m.tierFor(0).tier, 'avoid');
	assert.equal(m.tierFor(100).tier, 'prime');
	assert.equal(m.tierFor(-5).tier, 'avoid');
});

test('explain() adds up to the probability it reports', () => {
	const m = new OracleModel(DOC);
	const ex = m.explain(strongLaunch());
	const summed = ex.math.terms.reduce((a, t) => a + t.log_odds, ex.math.intercept);
	assert.ok(Math.abs(summed - ex.math.total_log_odds) < 1e-3, 'terms must sum to the stated log-odds');
	assert.ok(Math.abs(ex.math.probability - ex.probabilities.win) < 1e-3, 'stated math must match the verdict');
});

test('every reason carries the sample count behind it', () => {
	const m = new OracleModel(DOC);
	const v = m.score(strongLaunch());
	assert.ok(v.why.length > 0);
	for (const w of v.why) {
		assert.ok(Number.isFinite(w.weight));
		assert.ok(w.samples > 0, `${w.feature} claimed evidence with no samples`);
		assert.ok(w.observed && typeof w.observed.win === 'number');
	}
	// Sorted by absolute influence so the headline reason really is the headline.
	for (let i = 1; i < v.why.length; i++) {
		assert.ok(Math.abs(v.why[i - 1].weight) >= Math.abs(v.why[i].weight));
	}
});

test('missing signals land in the fitted null bucket, not at zero', () => {
	const m = new OracleModel(DOC);
	const empty = m.score({});
	assert.ok(Number.isFinite(empty.score));
	assert.equal(empty.confidence, 0);
	// A launch we know nothing about must not outrank one we know is strong.
	assert.ok(empty.score < m.score(strongLaunch()).score);
});

test('confidence tracks how much was actually supplied', () => {
	const m = new OracleModel(DOC);
	assert.equal(m.score({}).confidence, 0);
	assert.ok(m.score(strongLaunch()).confidence > 80);
});

test('bucketLabel matches the fitter on edges, nulls, and categories', () => {
	const feature = { edges: [0.2, 0.4] };
	assert.equal(bucketLabel(feature, 0.1), '<0.2');
	assert.equal(bucketLabel(feature, 0.2), '0.2-0.4');
	assert.equal(bucketLabel(feature, 0.9), '>=0.4');
	assert.equal(bucketLabel(feature, null), 'null');
	assert.equal(bucketLabel({ categorical: true }, 'animal'), 'animal');
	assert.equal(bucketLabel({ categorical: true }, null), 'unknown');
});

test('creator history buckets from raw counts or a pre-bucketed label', () => {
	const m = new OracleModel(DOC);
	const base = strongLaunch();
	const viaCounts = m.score({ ...base, creator_launches: 6, creator_wins: 0 });
	const viaLabel = m.score({ ...base, creator_record: 'serial_no_wins', creator_launches: undefined, creator_wins: undefined });
	assert.equal(viaCounts.score, viaLabel.score);
});

test('performance() reports the held-out numbers the weights shipped with', () => {
	const m = new OracleModel(DOC);
	const perf = m.performance();
	assert.ok(perf.auc > 0.7, `win AUC ${perf.auc} is too low to publish`);
	assert.ok(perf.holdout_n > 1000);
	assert.ok(perf.reliability.length > 0);
	assert.ok(m.performance('rug').auc > 0.7, 'the rug head must rank too');
});

test('verify() reproduces AUC on a caller-supplied sample', () => {
	const m = new OracleModel(DOC);
	// Strong launches win, dead ones do not: a perfectly separable sample, so a
	// correct AUC implementation has to return exactly 1.
	const samples = [
		...Array.from({ length: 5 }, () => ({ signals: strongLaunch(), outcome: 1 })),
		...Array.from({ length: 5 }, () => ({ signals: deadLaunch(), outcome: 0 })),
	];
	const out = m.verify(samples);
	assert.equal(out.n, 10);
	assert.equal(out.auc, 1);
	assert.equal(out.base_rate, 0.5);
	assert.ok(out.brier >= 0 && out.brier <= 1);
});

test('verify() refuses an empty sample instead of returning a made-up AUC', () => {
	const m = new OracleModel(DOC);
	assert.throws(() => m.verify([]), /non-empty/);
});

test('diff() against itself reports no movement', () => {
	const m = new OracleModel(DOC);
	const d = m.diff(new OracleModel(DOC));
	assert.equal(d.moves.length, 0);
	assert.equal(d.auc.from, d.auc.to);
});

test('diff() finds a moved weight and a removed bucket', () => {
	const m = new OracleModel(DOC);
	const mutated = JSON.parse(JSON.stringify(DOC));
	const feature = mutated.features[0];
	const [firstBucket, ...rest] = Object.keys(feature.buckets);
	feature.buckets[firstBucket].w.win += 0.5;
	const gone = rest[0];
	delete feature.buckets[gone];

	const d = m.diff(new OracleModel(mutated));
	const moved = d.moves.find((x) => x.key === `${feature.key}/${firstBucket}`);
	assert.ok(moved, 'expected the bumped bucket in the diff');
	assert.ok(Math.abs(moved.delta - 0.5) < 1e-6);
	assert.ok(d.moves.some((x) => x.key === `${feature.key}/${gone}` && x.kind === 'gone'));
});

test('rank() orders launches best first and respects the limit', () => {
	const m = new OracleModel(DOC);
	const ranked = m.rank([
		{ mint: 'dead', signals: deadLaunch() },
		{ mint: 'strong', signals: strongLaunch() },
	]);
	assert.equal(ranked[0].mint, 'strong');
	assert.equal(m.rank([{ signals: strongLaunch() }, { signals: deadLaunch() }], { limit: 1 }).length, 1);
});

test('scoring never mutates the caller signals or the model document', () => {
	const m = new OracleModel(DOC);
	const signals = strongLaunch();
	const before = JSON.stringify(signals);
	const docBefore = JSON.stringify(m.document);
	m.explain(signals);
	assert.equal(JSON.stringify(signals), before);
	assert.equal(JSON.stringify(m.document), docBefore);
});

test('fetch() surfaces a failed request instead of scoring on nothing', async () => {
	await assert.rejects(
		OracleModel.fetch({ fetch: async () => ({ ok: false, status: 503, statusText: 'Service Unavailable' }) }),
		/503/,
	);
	await assert.rejects(
		OracleModel.fetch({ fetch: async () => ({ ok: true, json: async () => ({ ok: true }) }) }),
		/no model/,
	);
});

test('fetch() builds the model from a well-formed response', async () => {
	const m = await OracleModel.fetch({
		network: 'mainnet',
		fetch: async (url) => {
			assert.ok(url.includes('network=mainnet'));
			return { ok: true, json: async () => ({ ok: true, model: DOC }) };
		},
	});
	assert.equal(m.version, DOC.version);
});
