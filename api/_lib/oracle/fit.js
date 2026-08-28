// Oracle conviction: the fitting library.
//
// One implementation of "turn labeled launches into a conviction model", shared
// by the CLI (scripts/oracle-fit.mjs) and the production learning loop
// (api/cron/oracle-refit.js). Before this module existed the fit lived only in
// the CLI as top-level script code, so nothing could call it, so nobody ever
// reran it: the shipped model sat frozen at its 2026-08-09 weights while the
// labeled set grew eight-fold underneath it. A model that cannot be refit by a
// machine will not be refit.
//
// The module is PURE: rows in, model out. No database, no filesystem, no clock
// beyond the `fittedAt` the caller passes. That is what makes it testable and
// what lets the same code run in a cron request and in a terminal.
//
// Three heads, not one
// --------------------
// v2 fit a single target: `outcome in ('graduated','pumped')`, i.e. "did this
// coin spike 3x or graduate". That question is real but it is not the question a
// holder asks, and the gap between them is exactly why a high score could sit on
// a coin whose chart is a cliff: over the seven days to 2026-08-28, Prime-tier
// coins hit that target 58.2% of the time AND rugged 53.0% of the time, with
// 27.8% doing both. A 3x-then-zero is a model success and a holder disaster.
//
// So v3 fits three heads over one shared design matrix:
//
//   win  = graduated, or peaked >= 3x, AND did not rug     (base 4.89%)
//   rug  = fell to <= 25% of the market cap at first sight (base 90.97%)
//   moon = graduated, or peaked >= 3x                      (base 10.67%)
//
// The published conviction score anchors on `win`. `rug` is published beside it
// as its own number, because on pump.fun nine launches in ten end below a
// quarter of where you found them and a ranking that hides that is lying by
// omission. `moon` is kept because it is what v2 ranked, so the two stay
// comparable and a regression in either is visible.
//
// Degenerate features drop themselves
// -----------------------------------
// Two of v2's seventeen features (`fresh_wallet_ratio`, `bubblemap_connectivity`)
// are null in 300,000 of 300,000 recent training rows: nothing populates
// `observation.walletMeta`, and the funder graph needs a HELIUS_API_KEY that is
// not set, so 42 of 713,908 recent wallets resolve a funder. A third
// (`coordination_score`) collapses to `bundle_score * 0.6` once the null
// bubblemap term drops out, which is why the live intel weights list the two as
// identical. Rather than hardcode that list and watch it rot, the fitter
// measures it: any feature whose modal bucket covers at least DEGENERATE_SHARE
// of rows carries no information and is dropped, by name, into the report. If
// the funder graph is ever wired up, those features return on the next fit with
// no code change at all.

// A feature is dropped only when it cannot support a second weight: one bucket,
// or a runner-up bucket too small to fit anything on. Deliberately NOT a share
// test. `smart_money_count` is non-zero on 0.3% of launches and those launches
// win 82% of the time against a 4.55% base; a "99.5% of rows sit in one bucket"
// rule would throw away the strongest signal in the dataset for being rare,
// which is the opposite of what rarity means here.
const MIN_MINORITY_ROWS = 200;

/** Rows with fewer labeled examples than this are not worth fitting. */
export const MIN_TRAINING_ROWS = 5000;

/**
 * Public tier boundaries, expressed as the P(win) each one claims.
 *
 * These are absolute probabilities, not lifts, so a score keeps its meaning as
 * the market moves: "Prime" is a claim that at least 45% of coins scored that
 * way go on to run without rugging, and it is checkable. They are held fixed
 * across refits on purpose; the promotion gate (api/cron/oracle-refit.js) tests
 * every candidate against them and refuses one whose bands no longer clear
 * their own claim. A ladder that silently re-anchors itself every six hours can
 * never be wrong, which is another way of saying it never says anything.
 */
export const TIER_PROBABILITY_ANCHORS = Object.freeze({
	avoid: 0, watch: 0.05, lean: 0.12, strong: 0.25, prime: 0.45,
});

const numOrNull = (v) => {
	const n = Number(v);
	return v == null || v === '' || !Number.isFinite(n) ? null : n;
};
const sig = (k) => (r) => numOrNull(r?.features?.[k]);

/**
 * The labeling rule this fitter trains against. Rows stamped with an older rule
 * are not comparable and the loader must exclude them; see the migration
 * 20260828170000_oracle_price_independent_labels.sql for why version 1 rows are
 * unusable (their `rugged` flag is a readout of the SOL price, not the coin).
 */
export const LABEL_VERSION = 2;

/** A holder who bought at first sight is under water below this multiple. */
const RUG_HOLD_MULTIPLE = 0.5;
/** How far a coin has to run to count as a run at all. */
const MOON_ATH_MULTIPLE = 3;

const isMoon = (r) => r?.graduated === true || Number(r?.ath_multiple) >= MOON_ATH_MULTIPLE;
// Number(null) is 0, not NaN, so a plain Number()/isFinite() guard reads a
// missing ratio as "down 100%" and labels every unmeasurable coin a rug. Route
// it through the same null check the feature getters use.
const holdMultiple = (r) => numOrNull(r?.hold_multiple);

/**
 * The three labels, derived from one training row.
 *
 * All three are computed from ratios that the SOL price cannot move:
 * `hold_multiple` is `ath_multiple * (last_market_cap_usd / ath_market_cap_usd)`,
 * and the two USD figures come from the same API response, so the price cancels.
 * That property is the whole point. The previous rug test compared a bonding
 * curve's dollar value to a hardcoded $3,000, and since an empty pump.fun curve
 * is worth a fixed 27.958993 SOL, it labeled the identical dead coin "rugged"
 * or "survivor" depending on whether SOL happened to be above $107.3 that day.
 *
 * A row with no `hold_multiple` cannot answer the survival question, so it is
 * neither a win nor a rug rather than being silently counted as safe.
 */
export const TARGETS = Object.freeze({
	win: (r) => (isMoon(r) && holdMultiple(r) !== null && holdMultiple(r) >= 1 ? 1 : 0),
	rug: (r) => (r?.graduated !== true && holdMultiple(r) !== null && holdMultiple(r) <= RUG_HOLD_MULTIPLE ? 1 : 0),
	moon: (r) => (isMoon(r) ? 1 : 0),
});

/** The head the public 0-100 score is anchored on. */
export const SCORE_HEAD = 'win';

export const HEADS = Object.freeze(['win', 'rug', 'moon']);

/**
 * Feature definitions. Each reads a training row (the `oracle_training_set`
 * shape) and returns a raw value; `edges` bucket it into one-hot columns, and a
 * `categorical` feature uses its string value as the bucket directly. Buckets,
 * not slopes, because several of these signals are genuinely non-monotone:
 * mid-range snipe ratios and top-10 concentration both beat their own extremes,
 * and a linear term would fight the data at both ends.
 */
export const FEATURES = [
	// structure: how the launch is put together
	{ key: 'organic_score', pillar: 'structure', get: sig('organic_score'), edges: [0.2, 0.4, 0.6, 0.8] },
	{ key: 'bundle_score', pillar: 'structure', get: sig('bundle_score'), edges: [0.1, 0.3, 0.5] },
	{ key: 'snipe_ratio', pillar: 'structure', get: sig('snipe_ratio'), edges: [0.1, 0.3, 0.7] },
	{ key: 'coordination_score', pillar: 'structure', get: sig('coordination_score'), edges: [0.1, 0.3] },
	{ key: 'timing_entropy', pillar: 'structure', get: sig('timing_entropy'), edges: [0.2, 0.4, 0.6, 0.8] },
	{ key: 'concentration_top1', pillar: 'structure', get: sig('concentration_top1'), edges: [0.05, 0.15, 0.3] },
	{ key: 'concentration_top5', pillar: 'structure', get: sig('concentration_top5'), edges: [0.3, 0.6, 0.9] },
	{ key: 'concentration_top10', pillar: 'structure', get: sig('concentration_top10'), edges: [0.3, 0.9] },
	{ key: 'fresh_wallet_ratio', pillar: 'structure', get: sig('fresh_wallet_ratio'), edges: [0.2, 0.5, 0.8] },
	{ key: 'bubblemap_connectivity', pillar: 'structure', get: sig('bubblemap_connectivity'), edges: [0.1, 0.3, 0.6] },

	// momentum: what the first 90 seconds of tape actually did
	{ key: 'unique_buyers', pillar: 'momentum', get: sig('unique_buyers'), edges: [1, 5, 15, 40] },
	{ key: 'unique_sellers', pillar: 'momentum', get: sig('unique_sellers'), edges: [1, 3, 10] },
	{ key: 'buy_sell_ratio', pillar: 'momentum', get: sig('buy_sell_ratio'), edges: [0.5, 1, 2, 4] },
	{ key: 'buy_volume_sol', pillar: 'momentum', get: sig('buy_volume_sol'), edges: [0.5, 8, 25] },
	{ key: 'sell_volume_sol', pillar: 'momentum', get: sig('sell_volume_sol'), edges: [0.1, 2, 10] },
	{ key: 'net_volume_sol', pillar: 'momentum', get: sig('net_volume_sol'), edges: [0, 1, 5, 20] },
	{ key: 'trade_count', pillar: 'momentum', get: sig('trade_count'), edges: [3, 12, 40] },
	{ key: 'largest_buy_sol', pillar: 'momentum', get: sig('largest_buy_sol'), edges: [0.2, 2.5, 5] },
	{ key: 'avg_buy_sol', pillar: 'momentum', get: sig('avg_buy_sol'), edges: [0.05, 0.5] },
	{ key: 'median_buy_sol', pillar: 'momentum', get: sig('median_buy_sol'), edges: [0.02, 0.15, 1] },
	{ key: 'mc_sol_first_seen', pillar: 'momentum', get: sig('mc_sol_first_seen'), edges: [28, 30, 35] },

	// pedigree: who launched it, and what the wallets on it are worth
	{ key: 'dev_buy_sol', pillar: 'pedigree', get: sig('dev_buy_sol'), edges: [0.05, 0.5, 2] },
	{ key: 'dev_sell_sol', pillar: 'pedigree', get: sig('dev_sell_sol'), edges: [0.0001, 0.5, 2] },
	{
		key: 'dev_sold', pillar: 'pedigree',
		get: (r) => (r?.features?.dev_sold === true ? 1 : r?.features?.dev_sold === false ? 0 : null),
		edges: [0.5],
	},
	// Fitted, not assumed. v2 left smart money to a hand-written log-odds overlay
	// because "214 proven wallets platform-wide" was too thin to fit. It is not
	// thin any more: 1,437 of 459,496 recent labeled launches had at least one
	// proven wallet buy inside the observation window, and those launches won
	// 81.98% of the time against a 4.55% base. That is the strongest thing this
	// dataset knows, and it belongs in the model, measured, next to its own
	// sample size, rather than in a hand-picked constant nobody rechecks.
	{ key: 'smart_money_count', pillar: 'pedigree', get: sig('smart_money_count'), edges: [1, 2, 4] },
	{
		key: 'creator_record', pillar: 'pedigree', categorical: true,
		get: (r) => {
			const launches = numOrNull(r?.creator_launches);
			const wins = numOrNull(r?.creator_wins);
			if (launches == null) return 'unknown';
			if (wins != null && wins >= 1) return 'has_wins';
			if (launches >= 5) return 'serial_no_wins';
			if (launches >= 2) return 'repeat_no_wins';
			return 'first_launch';
		},
	},

	// narrative: what the coin says it is
	{ key: 'category', pillar: 'narrative', categorical: true, get: (r) => String(r?.category || 'unknown').toLowerCase() },
];

/**
 * The bucket label a value falls in, for one feature. Exported because the
 * scorer has to reproduce it exactly: a mismatch here would score production
 * against buckets that were never fitted, silently.
 */
export function bucketLabel(feature, value) {
	if (feature.categorical) return String(value ?? 'unknown');
	if (value == null) return 'null';
	const edges = feature.edges || [];
	for (let i = 0; i < edges.length; i++) {
		if (value < edges[i]) return i === 0 ? `<${edges[0]}` : `${edges[i - 1]}-${edges[i]}`;
	}
	return `>=${edges[edges.length - 1]}`;
}

/** Column key for one feature/bucket pair. Space-separated; bucket labels never contain one. */
const colKey = (featureKey, label) => `${featureKey} ${label}`;

/**
 * One-hot encode rows into a flat design matrix.
 *
 * Flat Int32Array rather than an array of arrays: at three quarters of a million
 * rows the nested version spends more time chasing pointers than doing
 * arithmetic, and the fit has to finish inside a 300-second cron.
 *
 * @param {object[]} rows training rows
 * @param {object[]} features feature definitions to encode (post-degeneracy filter)
 * @returns {{X:Int32Array, stride:number, columns:Map<string,number>}}
 */
export function encode(rows, features = FEATURES) {
	const columns = new Map();
	const stride = features.length;
	const X = new Int32Array(rows.length * stride);
	for (let i = 0; i < rows.length; i++) {
		for (let f = 0; f < stride; f++) {
			const feature = features[f];
			const key = colKey(feature.key, bucketLabel(feature, feature.get(rows[i])));
			let col = columns.get(key);
			if (col === undefined) {
				col = columns.size;
				columns.set(key, col);
			}
			X[i * stride + f] = col;
		}
	}
	return { X, stride, columns };
}

/**
 * Drop features that carry no information in this dataset, and say which.
 *
 * A feature whose modal bucket covers essentially every row (an always-null
 * signal, a constant) contributes a fixed offset the intercept already absorbs.
 * Keeping it costs a column, a weight, and a line of UI that claims evidence
 * where there is none.
 *
 * @returns {{features:object[], dropped:{key:string, bucket:string, share:number}[]}}
 */
export function pruneDegenerate(rows, features = FEATURES, minMinorityRows = MIN_MINORITY_ROWS) {
	const kept = [];
	const dropped = [];
	for (const feature of features) {
		const counts = new Map();
		for (const row of rows) {
			const label = bucketLabel(feature, feature.get(row));
			counts.set(label, (counts.get(label) || 0) + 1);
		}
		const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
		const top = ranked[0] || ['null', rows.length];
		const runnerUp = ranked[1] || null;
		if (!runnerUp || runnerUp[1] < minMinorityRows) {
			dropped.push({
				key: feature.key,
				bucket: top[0],
				share: Number((rows.length ? top[1] / rows.length : 1).toFixed(4)),
				runner_up: runnerUp ? { bucket: runnerUp[0], n: runnerUp[1] } : null,
			});
		} else {
			kept.push(feature);
		}
	}
	return { features: kept, dropped };
}

/**
 * Logistic regression by SGD over a one-hot design matrix.
 *
 * Deterministic: the shuffle runs off a seeded LCG, so the same rows always
 * produce the same weights and a promotion decision is reproducible. Honours a
 * wall-clock deadline by stopping between epochs, because a cron killed mid-fit
 * produces nothing at all, while one that stops a few epochs short produces a
 * candidate the gate can still judge on its merits.
 *
 * @returns {{intercept:number, w:Float64Array, epochs:number}}
 */
export function fitLogistic(X, stride, y, nCols, {
	epochs = 24, lr = 0.05, l2 = 1e-4, seed = 42, deadlineAt = Infinity, rowCount = null,
} = {}) {
	const n = rowCount ?? y.length;
	let pos = 0;
	for (let i = 0; i < n; i++) pos += y[i];
	let intercept = Math.log((pos + 1) / (n - pos + 1));
	const w = new Float64Array(nCols);
	const idx = new Int32Array(n);
	for (let i = 0; i < n; i++) idx[i] = i;

	let state = seed >>> 0;
	const rand = () => ((state = (Math.imul(state, 1103515245) + 12345) & 0x7fffffff) / 0x7fffffff);

	let done = 0;
	for (let e = 0; e < epochs; e++) {
		if (Date.now() > deadlineAt) break;
		for (let i = n - 1; i > 0; i--) {
			const j = (rand() * (i + 1)) | 0;
			const t = idx[i]; idx[i] = idx[j]; idx[j] = t;
		}
		const step = lr / (1 + e * 0.15);
		for (let k = 0; k < n; k++) {
			const r = idx[k];
			const row = r * stride;
			let z = intercept;
			for (let f = 0; f < stride; f++) z += w[X[row + f]];
			const err = y[r] - 1 / (1 + Math.exp(-z));
			intercept += step * err;
			for (let f = 0; f < stride; f++) {
				const c = X[row + f];
				w[c] += step * (err - l2 * w[c]);
			}
		}
		done = e + 1;
	}
	return { intercept, w, epochs: done };
}

/**
 * How many rows landed in each one-hot column.
 *
 * Needed to shrink weights by the evidence behind them, so it is measured on the
 * exact slice a model was fitted on rather than on the whole corpus.
 */
export function columnCounts(X, stride, nCols, rowCount) {
	const counts = new Int32Array(nCols);
	const end = (rowCount ?? X.length / stride) * stride;
	for (let i = 0; i < end; i++) counts[X[i]]++;
	return counts;
}

/**
 * Evidence to trust a bucket's own opinion over the population's. A bucket with
 * SHRINK_PRIOR rows keeps half its fitted weight; one with ten times that keeps
 * 91% of it; one with 34 rows keeps 15%.
 */
const SHRINK_PRIOR = 200;

/**
 * Pull thinly-evidenced weights toward zero, in proportion to their sample size.
 *
 * Without this, a bucket holding 34 launches can emit a -0.64 log-odds opinion
 * that survives into production and reverses the verdict on a coin. That
 * particular one was real: `smart_money_count >= 4` fitted NEGATIVE on the
 * survivable-win head despite those launches winning at four times the base
 * rate, because with 34 rows the regression happily assigns them whatever
 * residual the correlated volume and buyer-count features leave behind.
 *
 * The shrinkage is the standard empirical-Bayes one, `n / (n + prior)`: a bucket
 * with plenty of evidence keeps essentially all of its weight, and a bucket with
 * almost none says almost nothing. Applied before evaluation, never after, so
 * the holdout numbers describe the weights that actually ship.
 *
 * @param {{intercept:number, w:Float64Array, epochs:number}} model
 * @param {Int32Array} counts rows per column, from columnCounts()
 */
export function shrinkWeights(model, counts, prior = SHRINK_PRIOR) {
	const w = new Float64Array(model.w.length);
	for (let c = 0; c < w.length; c++) {
		const n = counts[c] || 0;
		w[c] = model.w[c] * (n / (n + prior));
	}
	return { ...model, w };
}

/** Predicted probability for one row of the flat design matrix. */
export function predictRow(model, X, stride, i) {
	let z = model.intercept;
	const row = i * stride;
	for (let f = 0; f < stride; f++) z += model.w[X[row + f]];
	return 1 / (1 + Math.exp(-z));
}

/** Area under the ROC curve, tie-corrected (Mann-Whitney U). */
export function auc(scores, labels) {
	const order = [...scores.keys()].sort((a, b) => scores[a] - scores[b]);
	let sumPosRanks = 0, nPos = 0, nNeg = 0;
	for (let i = 0; i < order.length;) {
		let j = i;
		while (j < order.length && scores[order[j]] === scores[order[i]]) j++;
		const avgRank = (i + j + 1) / 2;
		for (let k = i; k < j; k++) {
			if (labels[order[k]] === 1) { sumPosRanks += avgRank; nPos++; } else nNeg++;
		}
		i = j;
	}
	if (!nPos || !nNeg) return 0.5;
	return (sumPosRanks - (nPos * (nPos + 1)) / 2) / (nPos * nNeg);
}

/** Positive rate among the top `frac` of rows by predicted probability. */
export function precisionAt(scores, labels, frac) {
	const order = [...scores.keys()].sort((a, b) => scores[b] - scores[a]);
	const n = Math.max(1, Math.round(order.length * frac));
	let good = 0;
	for (let i = 0; i < n; i++) good += labels[order[i]];
	return { n, rate: good / n };
}

/** Mean squared error of the probability against the outcome. Lower is better. */
export function brier(scores, labels) {
	let sum = 0;
	for (let i = 0; i < scores.length; i++) sum += (scores[i] - labels[i]) ** 2;
	return scores.length ? sum / scores.length : 0;
}

/**
 * Observed rate per predicted-probability band: does a claim of 45% happen 45%
 * of the time? This is the table the promotion gate reads and the public model
 * endpoint publishes.
 */
export function reliability(scores, labels, edges = [0, 0.05, 0.12, 0.25, 0.45, 1.0001]) {
	const out = [];
	for (let i = 0; i + 1 < edges.length; i++) {
		let n = 0, good = 0, sumP = 0;
		for (let k = 0; k < scores.length; k++) {
			if (scores[k] >= edges[i] && scores[k] < edges[i + 1]) { n++; good += labels[k]; sumP += scores[k]; }
		}
		out.push({
			lo: edges[i],
			hi: Math.min(1, edges[i + 1]),
			n,
			observed: n ? Number((good / n).toFixed(4)) : null,
			predicted: n ? Number((sumP / n).toFixed(4)) : null,
		});
	}
	return out;
}

function evaluate(scores, labels, base) {
	return {
		auc: Number(auc(scores, labels).toFixed(4)),
		brier: Number(brier(scores, labels).toFixed(5)),
		base_rate: Number(base.toFixed(4)),
		precision: Object.fromEntries([0.01, 0.05, 0.1, 0.25].map((frac) => {
			const p = precisionAt(scores, labels, frac);
			return [`top${Math.round(frac * 100)}`, {
				n: p.n,
				rate: Number(p.rate.toFixed(4)),
				lift: Number((p.rate / (base || 1)).toFixed(2)),
			}];
		})),
		reliability: reliability(scores, labels),
	};
}

/**
 * Fit a full three-head conviction model from labeled rows.
 *
 * Rows MUST arrive oldest-first: the holdout is the newest `holdoutFrac` of
 * them, so the evaluation answers "would this model have worked on launches it
 * had never seen", which is the only question worth asking about a model that
 * runs on a live feed.
 *
 * @param {object[]} rows oracle_training_set rows, oldest first
 * @param {object} [opts]
 * @param {string} [opts.fittedAt] ISO timestamp to stamp on the model
 * @param {number} [opts.holdoutFrac] share held out for evaluation
 * @param {number} [opts.epochs] SGD passes per head
 * @param {number} [opts.deadlineAt] epoch-millis wall clock to stop fitting by
 * @returns {{model:object, report:object}}
 */
export function buildModel(rows, {
	fittedAt = new Date().toISOString(), holdoutFrac = 0.25, epochs = 24, deadlineAt = Infinity,
} = {}) {
	if (!Array.isArray(rows) || rows.length < MIN_TRAINING_ROWS) {
		throw new Error(`need at least ${MIN_TRAINING_ROWS} labeled rows to fit, got ${rows?.length ?? 0}`);
	}

	const { features, dropped } = pruneDegenerate(rows);
	if (!features.length) throw new Error('every feature is degenerate on this dataset; nothing to fit');

	const { X, stride, columns } = encode(rows, features);
	const cut = Math.min(rows.length - 1, Math.max(MIN_TRAINING_ROWS, Math.floor(rows.length * (1 - holdoutFrac))));
	const holdoutN = rows.length - cut;

	const ys = {};
	const baseRates = {};
	for (const head of HEADS) {
		const y = new Float64Array(rows.length);
		let pos = 0;
		for (let i = 0; i < rows.length; i++) { y[i] = TARGETS[head](rows[i]); pos += y[i]; }
		ys[head] = y;
		baseRates[head] = pos / rows.length;
	}

	// Per head: fit on the older slice to earn an honest holdout number, then
	// refit on everything for the weights that actually ship. The holdout model
	// is thrown away; wasting the newest quarter of the data in production would
	// be paying for the evaluation twice.
	const holdout = { n: holdoutN, split_at: cut };
	const heads = {};
	let epochsRun = 0;
	const trainCounts = columnCounts(X, stride, columns.size, cut);
	const allCounts = columnCounts(X, stride, columns.size, rows.length);

	for (const head of HEADS) {
		const trained = shrinkWeights(
			fitLogistic(X, stride, ys[head], columns.size, { epochs, deadlineAt, rowCount: cut }),
			trainCounts,
		);
		const scores = new Array(holdoutN);
		const labels = new Array(holdoutN);
		let holdoutPos = 0;
		for (let i = 0; i < holdoutN; i++) {
			scores[i] = predictRow(trained, X, stride, cut + i);
			labels[i] = ys[head][cut + i];
			holdoutPos += labels[i];
		}
		holdout[head] = evaluate(scores, labels, holdoutPos / Math.max(1, holdoutN));

		const full = shrinkWeights(
			fitLogistic(X, stride, ys[head], columns.size, { epochs, deadlineAt }),
			allCounts,
		);
		epochsRun = Math.max(epochsRun, full.epochs);
		heads[head] = {
			intercept: Number(full.intercept.toFixed(4)),
			base_rate: Number(baseRates[head].toFixed(4)),
			w: full.w,
		};
	}

	// Emit per-feature, per-bucket weights with their provenance: sample size and
	// the observed rate of all three outcomes. Anyone can read why a coin scored
	// what it scored, and check the claim against the count behind it.
	const bucketCounts = new Map();
	for (let i = 0; i < rows.length; i++) {
		for (let f = 0; f < stride; f++) {
			const col = X[i * stride + f];
			let agg = bucketCounts.get(col);
			if (!agg) { agg = { n: 0, win: 0, rug: 0, moon: 0 }; bucketCounts.set(col, agg); }
			agg.n++;
			for (const head of HEADS) agg[head] += ys[head][i];
		}
	}

	const modelFeatures = features.map((feature) => {
		const buckets = {};
		for (const [key, col] of columns) {
			const sep = key.indexOf(' ');
			if (key.slice(0, sep) !== feature.key) continue;
			const agg = bucketCounts.get(col) || { n: 0, win: 0, rug: 0, moon: 0 };
			buckets[key.slice(sep + 1)] = {
				n: agg.n,
				w: Object.fromEntries(HEADS.map((h) => [h, Number(heads[h].w[col].toFixed(4))])),
				rate: Object.fromEntries(HEADS.map((h) => [h, Number((agg[h] / Math.max(1, agg.n)).toFixed(4))])),
			};
		}
		return {
			key: feature.key,
			pillar: feature.pillar,
			categorical: !!feature.categorical,
			edges: feature.edges || null,
			buckets,
		};
	});

	const model = {
		version: 3,
		fitted_at: fittedAt,
		training_rows: rows.length,
		score_head: SCORE_HEAD,
		heads: Object.fromEntries(HEADS.map((h) => [h, { intercept: heads[h].intercept, base_rate: heads[h].base_rate }])),
		tier_probability_anchors: { ...TIER_PROBABILITY_ANCHORS },
		features: modelFeatures,
		dropped_features: dropped,
		holdout,
		fit: {
			epochs,
			shrink_prior: SHRINK_PRIOR,
			epochs_run: epochsRun,
			columns: columns.size,
			features: features.length,
			complete: epochsRun >= epochs,
		},
	};

	return {
		model,
		report: {
			rows: rows.length,
			base_rates: Object.fromEntries(HEADS.map((h) => [h, Number(baseRates[h].toFixed(4))])),
			dropped,
			holdout,
			complete: model.fit.complete,
		},
	};
}
