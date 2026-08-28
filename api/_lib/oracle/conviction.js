// Oracle: the fused conviction engine, v3 (three heads, learned continuously).
//
// What changed and why
// --------------------
// v1 was a hand-tuned four-pillar heuristic. v2 replaced its internals with a
// bucketed logistic model fitted on labeled launches, which was the right move
// and left two problems that took until 2026-08-28 to find.
//
// PROBLEM ONE: the model was frozen. The weights shipped as a JSON file baked
// into the container at build time, and the only thing that could refit them was
// a human running a script by hand. Nobody did. The model sat at its 2026-08-09
// fit of 92,906 rows while the labeled set grew past 750,000, and evaluated on a
// current holdout it had given up six points of top-decile precision (53.7% vs
// 59.8% for a fresh fit). A model that can only learn when a person remembers to
// teach it does not learn. Weights now live in `oracle_model_versions` and a
// cron refits and re-promotes them (api/cron/oracle-refit.js); this file's JSON
// is the bootstrap for a cold container and for tests.
//
// PROBLEM TWO, the serious one: the label was measuring the price of SOL.
// `rugged` was decided by two tests, "fell to <= 25% of the market cap at first
// sight" and "market cap under $3,000". A pump.fun bonding curve with no real
// reserves is worth exactly 30 * 1e9 / 1073000191 = 27.958993 SOL, and we first
// see a coin in its opening 90 seconds when its cap is 28-38 SOL, so the floor
// is 73-99% of first sight and the first test can never fire. That left a
// hardcoded dollar threshold judging a floor worth 27.958993 SOL. Of 206,428
// coins labeled rugged, 206,419 were under $3,000; of 25,180 labeled survivors,
// the cheapest was exactly $3,000. Identical dead curves, sorted by whether SOL
// was above roughly $107.3 that day.
//
// So v2's score ranked "graduates or spikes 3x", the rug filter that was
// supposed to temper it was noise, and a Prime call could sit on a coin that
// ran 3x and went to zero. That is the complaint this version answers.
//
// v3: three heads over one design matrix
// --------------------------------------
//   win  = it ran (graduated or 3x) AND a holder from first sight is still up
//   rug  = a holder from first sight is down more than half
//   moon = it ran, regardless of what happened after (what v2 ranked)
//
// All three read `hold_multiple = ath_multiple * (last_mc_usd / ath_mc_usd)`,
// where both dollar figures come from the same API response so the SOL price
// cancels. Holdout on 74,211 unseen launches: win AUC 0.8465 (13.2x lift in the
// top percentile), rug AUC 0.9175, moon AUC 0.8954. The rug head scored 0.484,
// worse than a coin flip, against the old label; the label was the problem.
//
// The published 0-100 score anchors on `win`. Rug risk is published beside it as
// its own number rather than folded in, because "this will probably run" and
// "this will probably take your money" are different questions and a single
// number that averages them tells you neither.
//
// What stays from v2
// ------------------
//   - The module is PURE: CoinIntel in, verdict out. No I/O, no clock. The
//     active model is swapped in by a caller (setActiveModel) rather than
//     fetched here, so this file stays a function of its inputs.
//   - The four-pillar presentation (WHO/HOW/WHAT/MOVE), reasons, badges,
//     confidence, and the public tier ladder (86/72/56/34).
//   - One hard cap: a serial-rugger creator ceilings the final score.
//
// What went away
// --------------
// The hand-written smart-money log-odds overlay. v2 added between +0.35 and
// +0.75 by hand because "214 proven wallets platform-wide" was too thin to fit.
// There are now 732 labeled launches with a proven wallet in them and the model
// fits the feature directly: 2-4 smart wallets in the first 90 seconds means a
// 55.0% survivable-win rate and 0 rugs in 351 samples. When the active model
// carries a fitted `smart_money_count` feature the overlay's smart-money and
// creator-history terms stand down automatically, because counting the same
// evidence twice is not conservatism, it is a bug.

import BOOTSTRAP_MODEL from './conviction-model.json' with { type: 'json' };
import { isProven, isFlagged } from './archetype.js';

// Tier thresholds on the final 0-100 score. Unchanged since v1: the ladder is a
// public contract and the probability each rung claims is what moves, not the
// number printed on the pill.
const TIERS = [
	{ min: 86, tier: 'prime', label: 'Prime' },
	{ min: 72, tier: 'strong', label: 'Strong' },
	{ min: 56, tier: 'lean', label: 'Lean' },
	{ min: 34, tier: 'watch', label: 'Watch' },
	{ min: 0, tier: 'avoid', label: 'Avoid' },
];

const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const sigmoid = (z) => 1 / (1 + Math.exp(-z));
const pct01 = (v) => (v == null ? null : num(v) / 100);

/**
 * Bring any shipped model shape to one internal form.
 *
 * A v2 document has a single flat feature list with scalar `w`/`good_rate` and
 * ranks the `moon` question. A v3 document has three heads and per-head weights.
 * Normalising here rather than at every read site means a container that boots
 * on the old bootstrap JSON, or a database row written before the upgrade,
 * scores exactly as it always did instead of throwing on a missing field.
 *
 * @param {object} raw a v2 or v3 model document
 * @returns {object} canonical model
 */
export function normalizeModel(raw) {
	if (!raw || typeof raw !== 'object') throw new Error('conviction: model must be an object');
	if (!Array.isArray(raw.features) || !raw.features.length) throw new Error('conviction: model has no features');

	if (Number(raw.version) >= 3) {
		if (!raw.heads || !raw.heads[raw.score_head || 'win']) throw new Error('conviction: v3 model is missing its score head');
		return {
			version: Number(raw.version),
			fitted_at: raw.fitted_at || null,
			training_rows: Number(raw.training_rows) || 0,
			score_head: raw.score_head || 'win',
			heads: raw.heads,
			tier_probability_anchors: raw.tier_probability_anchors,
			features: raw.features,
			dropped_features: raw.dropped_features || [],
			holdout: raw.holdout || null,
			fit: raw.fit || null,
		};
	}

	// v2 -> canonical. Its single target is the `moon` question, so that is the
	// head it scores on, and it publishes no rug opinion at all.
	return {
		version: 2,
		fitted_at: raw.fitted_at || null,
		training_rows: Number(raw.training_rows) || 0,
		score_head: 'moon',
		heads: { moon: { intercept: Number(raw.intercept) || 0, base_rate: Number(raw.base_good_rate) || 0 } },
		tier_probability_anchors: raw.tier_probability_anchors,
		features: raw.features.map((f) => ({
			key: f.key,
			pillar: f.pillar,
			categorical: !!f.categorical,
			edges: f.edges || null,
			buckets: Object.fromEntries(Object.entries(f.buckets || {}).map(([label, b]) => [label, {
				n: b.n,
				w: { moon: Number(b.w) || 0 },
				rate: { moon: Number(b.good_rate) || 0 },
			}])),
		})),
		dropped_features: [],
		holdout: null,
		fit: null,
	};
}

// ── Active model (swappable, with derived tables recomputed on every swap) ────
// `export let` gives importers a live binding, so a promotion at runtime is
// visible everywhere without a single caller re-importing anything.

export let MODEL = normalizeModel(BOOTSTRAP_MODEL);
export let SCORE_ANCHORS = [];
export let PILLAR_WEIGHTS = {};
export let WEIGHTS = {};
export let PREDICTED_EVENT = {};

/** The event each head predicts, in words, so no surface has to guess. */
const HEAD_EVENTS = {
	win: {
		id: 'runs_and_holds',
		label: 'graduates or peaks at 3x or more, AND is still worth at least what it cost at first sight',
		short: 'runs without giving it back',
		caveat: 'This is the holder question. A coin that spiked 3x and then collapsed is NOT a hit here, which is what separates v3 from every earlier version of this score.',
	},
	moon: {
		id: 'spike_or_graduate',
		label: 'graduates, or peaks at 3x or more above its market cap at first sight',
		short: 'spikes 3x or graduates',
		caveat: 'A later collapse does not undo a hit. This ranks the odds of a run, not the odds of a safe hold.',
	},
};

function derivePillarWeights(model) {
	const head = model.score_head;
	const span = { pedigree: 0, structure: 0, narrative: 0, momentum: 0 };
	for (const f of model.features) {
		const ws = Object.values(f.buckets).map((b) => num(b.w?.[head]));
		if (!ws.length) continue;
		span[f.pillar] = (span[f.pillar] || 0) + (Math.max(...ws) - Math.min(...ws));
	}
	const total = Object.values(span).reduce((a, b) => a + b, 0) || 1;
	const out = {};
	for (const [k, v] of Object.entries(span)) out[k] = Number((v / total).toFixed(2));
	return Object.freeze(out);
}

function deriveAnchors(model) {
	const a = model.tier_probability_anchors || { avoid: 0, watch: 0.05, lean: 0.12, strong: 0.25, prime: 0.45 };
	return [[0, 0], [a.watch, 34], [a.lean, 56], [a.strong, 72], [a.prime, 86], [1, 100]];
}

function applyModel(model) {
	MODEL = model;
	SCORE_ANCHORS = deriveAnchors(model);
	PILLAR_WEIGHTS = derivePillarWeights(model);
	WEIGHTS = PILLAR_WEIGHTS;
	PREDICTED_EVENT = Object.freeze({ ...(HEAD_EVENTS[model.score_head] || HEAD_EVENTS.moon) });
	return MODEL;
}

/**
 * Install a model as the one every score uses from now on.
 *
 * Validated before it is installed, and installed atomically: a malformed
 * document throws and leaves the previous model serving traffic, because the
 * failure mode of a scoring engine that accepts a bad model is silently wrong
 * numbers, which is worse than a loud refusal and a stale but correct one.
 *
 * @param {object} raw a v2 or v3 model document
 * @returns {object} the canonical model now in force
 */
export function setActiveModel(raw) {
	return applyModel(normalizeModel(raw));
}

/** Fall back to the model compiled into this build. */
export function resetModel() {
	return applyModel(normalizeModel(BOOTSTRAP_MODEL));
}

/** The model currently scoring, for anything that needs to report provenance. */
export function activeModel() {
	return MODEL;
}

/** True when the active model fits `key` itself, so no expert prior should. */
function isFitted(key) {
	return MODEL.features.some((f) => f.key === key);
}

applyModel(MODEL);

/** The public tier for a 0-100 conviction score. Single source of the ladder. */
export function tierForScore(score) {
	const s = clamp(num(score));
	return TIERS.find((t) => s >= t.min) || TIERS[TIERS.length - 1];
}

/** Map a probability to the 0-100 score line through the tier anchors. */
export function scoreFromProbability(p) {
	const x = Math.max(0, Math.min(1, num(p)));
	for (let i = 1; i < SCORE_ANCHORS.length; i++) {
		const [p0, s0] = SCORE_ANCHORS[i - 1];
		const [p1, s1] = SCORE_ANCHORS[i];
		if (x <= p1) return clamp(Math.round(s0 + ((x - p0) / (p1 - p0)) * (s1 - s0)));
	}
	return 100;
}

/**
 * Inverse of scoreFromProbability: the probability a given score actually
 * claims. The score line is not a percentage (86 claims 45%, not 86%), so any
 * surface comparing a score to a realized rate has to convert first. Every
 * calibration table we published before 2026-08-14 used score/100 as the
 * prediction, which overstated the engine's own claim by up to 4x.
 *
 * @param {number} score 0-100 conviction score
 * @returns {number} probability in [0,1]
 */
export function probabilityFromScore(score) {
	const s = clamp(num(score));
	for (let i = 1; i < SCORE_ANCHORS.length; i++) {
		const [p0, s0] = SCORE_ANCHORS[i - 1];
		const [p1, s1] = SCORE_ANCHORS[i];
		if (s <= s1) return s1 === s0 ? p1 : p0 + ((s - s0) / (s1 - s0)) * (p1 - p0);
	}
	return 1;
}

/**
 * The measured hit rate behind a score, taken from the active model's own
 * holdout reliability curve.
 *
 * This used to read a separate hand-generated calibration file whose stated
 * win definition was "graduated or (ath_multiple >= 2 and not rugged)", i.e. it
 * was built on the SOL-price-dependent rug flag and its numbers were noise.
 * Reading the model's own holdout instead means the published rate is always
 * the rate that exact model earned on launches it had never seen, and it can
 * never drift out of sync with the weights, because it ships with them.
 *
 * @param {number} score 0-100 conviction
 * @returns {{rate:number|null, lift:number|null, band:string|null, n:number, baseRate:number|null, predicts:object}}
 */
export function hitRateFor(score) {
	const head = MODEL.score_head;
	const holdout = MODEL.holdout?.[head];
	const base = holdout?.base_rate ?? MODEL.heads?.[head]?.base_rate ?? null;
	const p = probabilityFromScore(score);
	const bands = holdout?.reliability || [];
	const band = bands.find((b) => p >= b.lo && p < b.hi) || bands[bands.length - 1] || null;
	const rate = band?.observed ?? null;
	return {
		rate,
		lift: rate != null && base ? Number((rate / base).toFixed(2)) : null,
		band: band ? `${band.lo}-${band.hi}` : null,
		n: band?.n ?? 0,
		baseRate: base,
		predicts: PREDICTED_EVENT,
	};
}

// ── Feature extraction ────────────────────────────────────────────────────────
// The model is fitted on the raw launch-time signals JSONB. `intel.launch` (from
// sources.js) carries those exact values; the derived CoinIntel fields act as
// fallbacks so hand-built intel (tests, older callers) still scores.

function rawNum(intel, key) {
	const v = intel?.launch?.[key];
	const n = Number(v);
	return v == null || !Number.isFinite(n) ? null : n;
}

const FEATURE_VALUE = {
	organic_score: (it) => rawNum(it, 'organic_score') ?? pct01(it.structure?.organicScore),
	bundle_score: (it) => rawNum(it, 'bundle_score') ?? pct01(it.structure?.bundleScore),
	snipe_ratio: (it) => rawNum(it, 'snipe_ratio') ?? pct01(it.structure?.snipeRatio),
	coordination_score: (it) => rawNum(it, 'coordination_score'),
	timing_entropy: (it) => rawNum(it, 'timing_entropy'),
	concentration_top1: (it) => rawNum(it, 'concentration_top1'),
	concentration_top5: (it) => rawNum(it, 'concentration_top5'),
	concentration_top10: (it) => rawNum(it, 'concentration_top10') ?? pct01(it.structure?.top10Pct),
	fresh_wallet_ratio: (it) => rawNum(it, 'fresh_wallet_ratio'),
	bubblemap_connectivity: (it) => rawNum(it, 'bubblemap_connectivity'),
	unique_buyers: (it) => rawNum(it, 'unique_buyers') ?? (it.structure?.uniqueBuyers ?? null),
	unique_sellers: (it) => rawNum(it, 'unique_sellers'),
	buy_sell_ratio: (it) => {
		const r = rawNum(it, 'buy_sell_ratio');
		if (r != null) return r;
		const buys = num(it.behavior?.buyCount);
		const sells = num(it.behavior?.sellCount);
		return sells > 0 ? buys / sells : null;
	},
	buy_volume_sol: (it) => rawNum(it, 'buy_volume_sol') ?? (it.behavior?.buyVolSol ?? null),
	sell_volume_sol: (it) => rawNum(it, 'sell_volume_sol'),
	net_volume_sol: (it) => rawNum(it, 'net_volume_sol'),
	trade_count: (it) => rawNum(it, 'trade_count'),
	largest_buy_sol: (it) => rawNum(it, 'largest_buy_sol'),
	avg_buy_sol: (it) => {
		const r = rawNum(it, 'avg_buy_sol');
		if (r != null) return r;
		const vol = num(it.behavior?.buyVolSol);
		const buys = num(it.behavior?.buyCount);
		return buys > 0 ? vol / buys : null;
	},
	median_buy_sol: (it) => rawNum(it, 'median_buy_sol'),
	dev_buy_sol: (it) => rawNum(it, 'dev_buy_sol') ?? (it.behavior?.devBuySol ?? null),
	dev_sell_sol: (it) => rawNum(it, 'dev_sell_sol'),
	mc_sol_first_seen: (it) => rawNum(it, 'mc_sol_first_seen'),
	smart_money_count: (it) => rawNum(it, 'smart_money_count')
		?? (it.smartMoney?.smartWalletCount ?? null),
	dev_sold: (it) => {
		const raw = it?.launch?.dev_sold;
		if (raw === true) return 1;
		if (raw === false) return 0;
		const pct = it.structure?.devSoldPct;
		return pct == null ? null : (num(pct) > 0 ? 1 : 0);
	},
	creator_record: (it) => {
		const launches = num(it.creator?.launches);
		const wins = num(it.creator?.launchWins);
		if (!launches && !it.creator?.label) return 'unknown';
		if (wins >= 1) return 'has_wins';
		if (launches >= 5) return 'serial_no_wins';
		if (launches >= 2) return 'repeat_no_wins';
		return 'first_launch';
	},
	category: (it) => String(it.category || it.narrative?.category || 'unknown').toLowerCase(),
};

function bucketLabelFor(feature, value) {
	if (feature.categorical) return String(value ?? 'unknown');
	if (value == null) return 'null';
	const edges = feature.edges || [];
	for (let i = 0; i < edges.length; i++) {
		if (value < edges[i]) return i === 0 ? `<${edges[0]}` : `${edges[i - 1]}-${edges[i]}`;
	}
	return `>=${edges[edges.length - 1]}`;
}

// Plain-language templates so a bucket hit reads as a fact, not a code. Each
// reason carries the observed rate from the model itself: the engine quotes its
// own training data instead of asserting vibes.
const FEATURE_TEXT = {
	organic_score: 'organic demand',
	bundle_score: 'launch coordination',
	snipe_ratio: 'open sniped',
	coordination_score: 'buy coordination',
	timing_entropy: 'buy-timing spread',
	concentration_top1: 'top-holder share',
	concentration_top5: 'top-5 holder share',
	concentration_top10: 'top-10 holder share',
	fresh_wallet_ratio: 'fresh-wallet share',
	bubblemap_connectivity: 'funder clustering',
	unique_buyers: 'unique early buyers',
	unique_sellers: 'unique early sellers',
	buy_sell_ratio: 'buy/sell pressure',
	buy_volume_sol: 'early buy volume (SOL)',
	sell_volume_sol: 'early sell volume (SOL)',
	net_volume_sol: 'net early flow (SOL)',
	trade_count: 'trades in the window',
	largest_buy_sol: 'largest single buy (SOL)',
	avg_buy_sol: 'average buy size (SOL)',
	median_buy_sol: 'median buy size (SOL)',
	dev_buy_sol: 'dev buy size (SOL)',
	dev_sell_sol: 'dev sell size (SOL)',
	mc_sol_first_seen: 'market cap at first sight (SOL)',
	smart_money_count: 'proven wallets in the book',
	dev_sold: 'dev selling in the window',
	creator_record: 'creator launch history',
	category: 'narrative category',
};

const CREATOR_TEXT = {
	has_wins: 'creator has shipped a graduated launch before',
	serial_no_wins: 'creator has 5+ prior launches, none graduated',
	repeat_no_wins: 'creator relaunches without a single graduation',
	first_launch: 'first launch from this creator',
	unknown: 'creator history unknown',
};

// Features whose reason reads as a fact about the launch rather than a
// measurement of it, so the sentence says "such launches" instead of "similar".
const SUCH = new Set(['creator_record', 'category', 'dev_sold', 'smart_money_count']);

// One card-ready phrase per fitted bucket. The fallback ("organic demand
// 0.6-0.8") is readable to whoever fitted the model and to nobody else, and
// reasons are the headline of every feed card, so each bucket says what it means
// in the units a trader already thinks in.
const PHRASE = {
	organic_score: {
		'<0.2': 'almost no organic demand', '0.2-0.4': 'weak organic demand',
		'0.4-0.6': 'middling organic demand', '0.6-0.8': 'solid organic demand',
		'>=0.8': 'strong organic demand',
	},
	bundle_score: {
		'<0.1': 'no sign of a bundled launch', '0.1-0.3': 'faint bundling',
		'0.3-0.5': 'partly bundled', '>=0.5': 'heavily bundled',
	},
	snipe_ratio: {
		'<0.1': 'barely sniped at open', '0.1-0.3': 'lightly sniped at open',
		'0.3-0.7': 'heavily sniped at open', '>=0.7': 'almost entirely sniped at open',
	},
	coordination_score: {
		'<0.1': 'buyers acting independently', '0.1-0.3': 'some coordinated buying',
		'>=0.3': 'coordinated buying',
	},
	timing_entropy: {
		'<0.2': 'buys landing in one burst', '0.2-0.4': 'buys clustered in time',
		'0.4-0.6': 'buys moderately spread out', '0.6-0.8': 'buys well spread in time',
		'>=0.8': 'buys evenly spread in time',
	},
	concentration_top1: {
		'<0.05': 'no holder above 5%', '0.05-0.15': 'top holder at 5-15%',
		'0.15-0.3': 'top holder at 15-30%', '>=0.3': 'top holder above 30%',
	},
	concentration_top5: {
		'<0.3': 'top 5 under 30% of supply', '0.3-0.6': 'top 5 holding 30-60%',
		'0.6-0.9': 'top 5 holding 60-90%', '>=0.9': 'top 5 holding over 90%',
	},
	concentration_top10: {
		'<0.3': 'top 10 under 30% of supply', '0.3-0.9': 'top 10 holding 30-90%',
		'>=0.9': 'top 10 holding over 90%',
	},
	unique_buyers: {
		'<1': 'no buyers yet', '1-5': 'under 5 early buyers', '5-15': '5-15 early buyers',
		'15-40': '15-40 early buyers', '>=40': '40+ early buyers',
	},
	unique_sellers: {
		'<1': 'nobody has sold yet', '1-3': '1-3 sellers already out',
		'3-10': '3-10 sellers already out', '>=10': '10+ sellers already out',
	},
	buy_sell_ratio: {
		'<0.5': 'more sellers than buyers', '0.5-1': 'sells keeping pace with buys',
		'1-2': 'buys leading sells', '2-4': 'buys 2-4x the sells', '>=4': 'buys 4x+ the sells',
		null: 'nobody has sold yet',
	},
	buy_volume_sol: {
		'<0.5': 'under 0.5 SOL bought', '0.5-8': '0.5-8 SOL bought early',
		'8-25': '8-25 SOL bought early', '>=25': '25+ SOL bought early',
	},
	sell_volume_sol: {
		'<0.1': 'almost nothing sold back', '0.1-2': '0.1-2 SOL sold back',
		'2-10': '2-10 SOL sold back', '>=10': '10+ SOL already sold back',
	},
	net_volume_sol: {
		'<0': 'more SOL left than arrived', '0-1': 'under 1 SOL of net inflow',
		'1-5': '1-5 SOL of net inflow', '5-20': '5-20 SOL of net inflow', '>=20': '20+ SOL of net inflow',
	},
	trade_count: {
		'<3': 'under 3 trades in the window', '3-12': '3-12 trades in the window',
		'12-40': '12-40 trades in the window', '>=40': '40+ trades in the window',
	},
	largest_buy_sol: {
		'<0.2': 'no buy above 0.2 SOL', '0.2-2.5': 'biggest buy 0.2-2.5 SOL',
		'2.5-5': 'biggest buy 2.5-5 SOL', '>=5': 'a 5+ SOL single buy',
	},
	avg_buy_sol: {
		'<0.05': 'dust-sized average buy', '0.05-0.5': 'average buy 0.05-0.5 SOL',
		'>=0.5': 'average buy above 0.5 SOL',
	},
	median_buy_sol: {
		'<0.02': 'dust-sized median buy', '0.02-0.15': 'median buy 0.02-0.15 SOL',
		'0.15-1': 'median buy 0.15-1 SOL', '>=1': 'median buy above 1 SOL',
	},
	dev_buy_sol: {
		'<0.05': 'dev barely bought their own launch', '0.05-0.5': 'dev bought 0.05-0.5 SOL',
		'0.5-2': 'dev bought 0.5-2 SOL', '>=2': 'dev bought 2+ SOL of their own launch',
	},
	dev_sell_sol: {
		'<0.0001': 'dev has not sold a lamport', '0.0001-0.5': 'dev sold under 0.5 SOL',
		'0.5-2': 'dev sold 0.5-2 SOL', '>=2': 'dev dumped 2+ SOL',
	},
	mc_sol_first_seen: {
		'<28': 'spotted below a 28 SOL cap', '28-30': 'spotted at a 28-30 SOL cap',
		'30-35': 'spotted at a 30-35 SOL cap', '>=35': 'already past a 35 SOL cap when spotted',
	},
	smart_money_count: {
		'<1': 'no proven wallet in the book', '1-2': 'one proven wallet already in',
		'2-4': '2-3 proven wallets already in', '>=4': '4+ proven wallets already in',
	},
	dev_sold: {
		'<0.5': 'dev held through the window', '>=0.5': 'dev sold inside the window',
	},
};

/**
 * The subject half of a reason: what the model saw, with no outcome statistics
 * attached. Emitted alongside the full sentence because a card has room for the
 * observation but not the sentence, and a card that re-derives it by splitting
 * the sentence on a colon breaks the first time the wording moves.
 */
function reasonSubject(feature, bucketLabel) {
	if (feature.key === 'creator_record') return CREATOR_TEXT[bucketLabel] || bucketLabel;
	if (feature.key === 'category') return `${bucketLabel} narrative`;
	const phrased = PHRASE[feature.key]?.[bucketLabel];
	if (phrased) return phrased;
	return `${FEATURE_TEXT[feature.key] || feature.key} ${bucketLabel}`;
}

function reasonText(feature, bucketLabel, stats) {
	const head = MODEL.score_head;
	const base = MODEL.heads?.[head]?.base_rate || 0;
	const observed = num(stats?.rate?.[head]);
	const rate = Math.round(observed * 100);
	const rel = base > 0 ? observed / base : 0;
	const vs = rel >= 1.15 || rel <= 0.85 ? `${rel.toFixed(1)}x base rate` : 'near base rate';
	const kind = SUCH.has(feature.key) ? 'such' : 'similar';
	return `${reasonSubject(feature, bucketLabel)}: ${rate}% of ${kind} launches worked (${vs})`;
}

// ── Expert priors, for the evidence the model cannot fit ─────────────────────
// Everything the active model fits is left to the active model. What survives
// here is evidence that has no column in the training set: whether the proven
// wallets in the book are already selling, whether any of them are tagged
// ruggers, and the serial-rugger ceiling. Magnitudes are in log-odds and stay
// conservative: 0.7 is roughly a 2x odds move, comparable to a strong bucket.

/**
 * @param {object} sm smart-money summary from sources.js
 * @param {object} creator creator reputation
 * @returns {{z:number, cap:number, reasons:string[], provenCount:number, flaggedCount:number, suppressed:string[]}}
 */
export function smartMoneyOverlay(sm = {}, creator = {}) {
	const reasons = [];
	const suppressed = [];
	let z = 0;
	let cap = 100;

	const notable = Array.isArray(sm.notable) ? sm.notable : [];
	const provenWallets = notable.filter((w) => isProven(w.label, w.score));
	const flaggedWallets = notable.filter((w) => isFlagged(w.label));
	const provenCount = Math.max(num(sm.smartWalletCount), provenWallets.length);

	// Presence of smart money is a fitted feature now. Adding a hand-picked bonus
	// on top would count the same wallets twice, which is how a 0.35 prior turns
	// into a systematically inflated score once the data catches up to it.
	if (isFitted('smart_money_count')) {
		if (provenCount >= 1) suppressed.push('smart_money_count');
	} else {
		if (provenCount >= 5) { z += 0.75; reasons.push(`${provenCount} smart-money wallets already in`); }
		else if (provenCount >= 3) { z += 0.55; reasons.push(`${provenCount} smart-money wallets in`); }
		else if (provenCount >= 1) { z += 0.35; reasons.push(`${provenCount} smart-money wallet in`); }

		const provenBuy = num(sm.provenBuyLamports);
		const totalBuy = num(sm.totalBuyLamports);
		if (totalBuy > 0 && provenBuy > 0) {
			const share = provenBuy / totalBuy;
			if (share >= 0.4) { z += 0.3; reasons.push(`${Math.round(share * 100)}% of buy volume is proven money`); }
			else if (share >= 0.2) { z += 0.15; }
		}
	}

	// Not fitted, and not derivable from anything that is: the training set
	// records who bought, never who is a tagged rugger.
	if (flaggedWallets.length) {
		z -= 0.45 * Math.min(3, flaggedWallets.length);
		reasons.push(`${flaggedWallets.length} flagged wallet${flaggedWallets.length > 1 ? 's' : ''} (rugger/dumper) in the book`);
	}

	// Also not fitted: smart money buying and smart money still holding are very
	// different states, and only the first one is in the feature set.
	const proven = num(sm.provenBuyLamports);
	const provenSell = num(sm.provenSellLamports);
	if (proven > 0 && provenSell > 0) {
		const exitShare = provenSell / proven;
		if (exitShare >= 0.5) { z -= 0.7; reasons.push(`smart money already sold ${Math.round(exitShare * 100)}% of its position`); }
		else if (exitShare >= 0.25) { z -= 0.35; reasons.push(`smart money trimming (${Math.round(exitShare * 100)}% sold)`); }
	}

	// The one hard cap. `creator_record` is a fitted feature, so the log-odds
	// nudge stands down when the model carries it, but the CEILING stays either
	// way: it is a product guarantee, not a probability estimate. A dev with a
	// graveyard behind them can never present as Strong, whatever the tape says.
	const launches = num(creator?.launches);
	const launchWins = num(creator?.launchWins);
	const serialRugger = isFlagged(creator?.label) || (launches >= 3 && launchWins === 0);
	if (serialRugger) {
		cap = 45;
		if (isFitted('creator_record')) suppressed.push('creator_record');
		else z -= 1.2;
		reasons.push(launches >= 3
			? `creator has ${launches} prior launches, none graduated: rug pattern`
			: 'creator wallet flagged as a rugger');
	}
	const creatorDump = num(creator?.dumpRate);
	if (launches >= 2 && creatorDump >= 0.5 && !isFitted('creator_record')) {
		z -= 0.3;
		reasons.push(`creator dumps ${Math.round(creatorDump * 100)}% of their launches`);
	}

	return { z, cap, reasons, provenCount, flaggedCount: flaggedWallets.length, suppressed };
}

// ── The engine ────────────────────────────────────────────────────────────────

/**
 * Evaluate the active model against one CoinIntel: per-feature bucket hits,
 * per-pillar log-odds sums, and a probability for every head. Pure.
 *
 * @param {object} intel normalized CoinIntel (see sources.js)
 * @returns {{z:number, p:number, heads:Record<string,number>, pillarZ:object, hits:Array<object>}}
 */
export function evaluateModel(intel = {}) {
	const headKeys = Object.keys(MODEL.heads);
	const z = Object.fromEntries(headKeys.map((h) => [h, num(MODEL.heads[h].intercept)]));
	const pillarZ = { pedigree: 0, structure: 0, narrative: 0, momentum: 0 };
	const hits = [];
	const head = MODEL.score_head;

	for (const feature of MODEL.features) {
		const getter = FEATURE_VALUE[feature.key];
		const value = getter ? getter(intel) : null;
		const bucket = bucketLabelFor(feature, value);
		const stats = feature.buckets[bucket];
		if (!stats) {
			// A bucket never seen in training (hand-built intel, a category the
			// classifier invented this week) contributes nothing rather than
			// inventing a weight for it.
			hits.push({ key: feature.key, pillar: feature.pillar, bucket, w: 0, stats: null, present: value != null });
			continue;
		}
		for (const h of headKeys) z[h] += num(stats.w?.[h]);
		pillarZ[feature.pillar] = (pillarZ[feature.pillar] || 0) + num(stats.w?.[head]);
		hits.push({
			key: feature.key,
			pillar: feature.pillar,
			bucket,
			w: num(stats.w?.[head]),
			stats,
			// A categorical that fell back to 'unknown' is a default, not an
			// observation: counting it inflated the confidence of a coin we knew
			// nothing about.
			present: value != null && bucket !== 'null' && bucket !== 'unknown',
		});
	}

	return {
		z: z[head],
		p: sigmoid(z[head]),
		heads: Object.fromEntries(headKeys.map((h) => [h, sigmoid(z[h])])),
		headZ: z,
		pillarZ,
		hits,
	};
}

/**
 * Fuse everything into an Oracle verdict.
 *
 * Same contract as v2 (score, tier, pillars, reasons, badges, caps, confidence)
 * plus the three-head numbers: `rugRisk` is the probability a holder from first
 * sight ends up down more than half, published as its own figure rather than
 * blended into the score.
 *
 * @param {object} intel normalized CoinIntel (see sources.js)
 */
export function convict(intel = {}) {
	const evaled = evaluateModel(intel);
	const overlay = smartMoneyOverlay(intel.smartMoney, intel.creator);
	const head = MODEL.score_head;

	const z = evaled.z + overlay.z;
	const p = sigmoid(z);

	const cap = overlay.cap;
	const score = clamp(Math.min(scoreFromProbability(p), cap));
	const tier = TIERS.find((t) => score >= t.min) || TIERS[TIERS.length - 1];

	// The overlay is evidence about this coin, not about this coin's upside
	// specifically, so it shifts every head it can. A book full of ruggers makes
	// a run less likely AND a collapse more likely.
	const probabilities = {};
	for (const [h, hp] of Object.entries(evaled.heads)) {
		const shift = h === 'rug' ? -overlay.z : overlay.z;
		probabilities[h] = Number(sigmoid(Math.log(hp / (1 - hp)) + shift).toFixed(4));
	}
	probabilities[head] = Number(p.toFixed(4));

	// Coherence. `win` is "it ran AND the holder kept it", so a win is a subset of
	// a run and P(win) can never exceed P(moon). The three heads are fitted
	// independently, which is what lets each one use the evidence its own question
	// needs, and it also means nothing in the arithmetic enforces that. On thin
	// launches it genuinely inverts (0.0008 against 0.0001 on a dead fixture), and
	// a published pair that violates its own definition is indefensible however
	// small the numbers are. Raise the weaker claim rather than lower the stronger
	// one: the run head is the one with less at stake here.
	if (probabilities.win != null && probabilities.moon != null && probabilities.win > probabilities.moon) {
		probabilities.moon = probabilities.win;
	}

	const rugRisk = probabilities.rug != null ? clamp(Math.round(probabilities.rug * 100)) : null;
	const upside = probabilities.moon != null ? clamp(Math.round(probabilities.moon * 100)) : null;

	// The number the three heads exist to produce, and the one nobody else
	// publishes: GIVEN this coin runs, how often does a coin like it hand the run
	// straight back? P(runs) and P(runs and holds) are both estimated, so their
	// ratio is the share of runs that survive, and one minus that is the trap.
	// A 90%-upside coin with a 90% give-back is exactly the "horrible coin the
	// Oracle called good" that every earlier version of this score produced,
	// because every earlier version only ever computed the first number.
	const giveBackRisk = probabilities.moon > 0 && probabilities.win != null
		? clamp(Math.round((1 - Math.min(1, probabilities.win / probabilities.moon)) * 100))
		: null;

	// Pillar sub-scores: what each pillar's own evidence (plus, for pedigree, the
	// overlay) would imply alone, on the same probability-to-score map.
	const pillarScore = (key, extraZ = 0) =>
		scoreFromProbability(sigmoid(num(MODEL.heads[head].intercept) + (evaled.pillarZ[key] || 0) + extraZ));
	const pillars = {
		pedigree: pillarScore('pedigree', overlay.z),
		structure: pillarScore('structure'),
		narrative: pillarScore('narrative'),
		momentum: pillarScore('momentum'),
	};

	// Confidence: fraction of model features actually observed. The fitted null
	// buckets DO carry signal (a coin with no sells yet is informative), so this
	// is a presentation aid, not a prior.
	const present = evaled.hits.filter((h) => h.present).length;
	const confidence = clamp(Math.round((present / Math.max(1, evaled.hits.length)) * 100));
	const confidenceLabel = confidence >= 70 ? 'high' : confidence >= 45 ? 'medium' : 'low';

	// Reasons: strongest model evidence first (by absolute log-odds), each
	// quoting the observed outcome rates for its bucket, then the overlay's.
	const modelReasons = evaled.hits
		.filter((h) => h.stats && Math.abs(h.w) >= 0.08)
		.sort((a, b) => Math.abs(b.w) - Math.abs(a.w))
		.slice(0, 7)
		.map((h) => {
			const feature = MODEL.features.find((f) => f.key === h.key);
			const base = MODEL.heads[head].base_rate || 0;
			const observed = num(h.stats.rate?.[head]);
			return {
				pillar: h.pillar,
				text: reasonText(feature, h.bucket, h.stats),
				// Structured twin of `text` so a card can render the observation and
				// its lift without re-parsing English.
				subject: reasonSubject(feature, h.bucket),
				rate: Math.round(observed * 100),
				rugRate: h.stats.rate?.rug != null ? Math.round(num(h.stats.rate.rug) * 100) : null,
				samples: h.stats.n ?? null,
				lift: base > 0 ? Number((observed / base).toFixed(1)) : null,
			};
		});
	const reasons = [
		...overlay.reasons.map((t) => ({ pillar: 'pedigree', text: t })),
		...modelReasons,
	];
	if (!reasons.length) reasons.push({ pillar: 'structure', text: 'no decisive evidence either way yet' });

	// Badges (compact pills for cards).
	const badges = [];
	if (overlay.provenCount >= 3 || (num(intel.launch?.smart_money_count) >= 3)) badges.push('smart-money');
	if (evaled.hits.some((h) => h.pillar === 'structure' && h.w <= -0.5)) badges.push('structure-flag');
	if (cap < 100) badges.push('pedigree-flag');
	if (String(intel.narrative?.category || intel.category).toLowerCase() === 'news') badges.push('news');
	// Momentum earns a badge only when that pillar's evidence ALONE would carry
	// the coin to prime. At the old 72 it fired on 93% of the live feed, which is
	// a decoration, not a signal.
	if (pillars.momentum >= 86) badges.push('momentum');
	if (confidence < 45) badges.push('thin-data');
	// The whole point of v3: a coin can rank well on upside and still be the
	// wrong thing to hold, and the card has to say so out loud.
	if (rugRisk != null && rugRisk >= 60) badges.push('rug-risk');
	// It will probably run, and it will probably not let you keep it.
	if (giveBackRisk != null && giveBackRisk >= 70 && upside >= 25) badges.push('give-back');

	return {
		score,
		tier: tier.tier,
		tierLabel: tier.label,
		probability: Number(p.toFixed(4)),
		probabilities,
		rugRisk,
		upside,
		giveBackRisk,
		survival: rugRisk == null ? null : 100 - rugRisk,
		predicts: PREDICTED_EVENT,
		pillars,
		weights: PILLAR_WEIGHTS,
		structureCap: 100,
		pedigreeCap: cap,
		confidence,
		confidenceLabel,
		reasons,
		badges,
		model: {
			version: MODEL.version,
			fitted_at: MODEL.fitted_at,
			training_rows: MODEL.training_rows,
			score_head: MODEL.score_head,
		},
	};
}

/** Map a tier to a UI tone (mirrors the page's CSS class suffixes). */
export function tierTone(tier) {
	switch (tier) {
		case 'prime': return 'good';
		case 'strong': return 'good';
		case 'lean': return 'warn';
		case 'watch': return 'neutral';
		default: return 'bad';
	}
}
