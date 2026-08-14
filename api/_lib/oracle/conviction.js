// Oracle: the fused conviction engine, v2 (fitted from real outcomes).
//
// v1 was a hand-tuned four-pillar heuristic. Audited against 92,546 labeled
// launches (2026-08-09), several of its strongest opinions turned out to be
// backwards at the 90-second observation window: it penalized top-10 holder
// concentration (empirically the 0.3-0.9 band graduates/pumps 5-8x the base
// rate, because "low concentration" at 90s usually means nobody bought), it
// penalized mid-range snipe ratios (0.1-0.7 is 2.7-3.6x base), it penalized an
// oversized dev buy (>=6 SOL is 1.36x base), and its category priors ranked
// flavors the outcome data does not distinguish. Its unknown-pedigree cap also
// made the Strong/Prime tiers unreachable in practice: in 202k live scores the
// engine never once produced a score above 71.
//
// v2 replaces the hand-tuned internals with a bucketed logistic model fitted on
// the labeled outcome set (scripts/oracle-fit.mjs, refit as the data grows).
// Every weight is a per-bucket log-odds contribution shipped with its sample
// size and observed good-rate in conviction-model.json: not a black box, a
// lookup table anyone can audit. "Good" = the coin graduated or hit >= 3x ATH.
// Holdout (newest 25% of labels, never seen in training): AUC 0.879 vs 0.627
// for v1; precision in the top decile 62.5% vs 24.1%.
//
// What stays from v1:
//   - The module is PURE: CoinIntel in, verdict out. No I/O, no DB, no clock
//     (the model JSON is a build-time constant loaded once at import).
//   - The four-pillar presentation (WHO/HOW/WHAT/MOVE), reasons, badges,
//     confidence, and the public tier ladder (86/72/56/34).
//   - The smart-money overlay: proven/flagged wallets are too rare in the
//     training window to fit (214 proven wallets platform-wide), so their
//     adjustments remain expert priors, expressed in log-odds and documented.
//   - One hard cap: a serial-rugger creator still ceilings the final score.
//     The data agrees with this one (5+ launches, 0 graduations: 0.26x base).
//
// What the score MEANS: the model's P(good) mapped through fixed probability
// anchors onto the 0-100 line. That number is a RANK, and it is the training
// label's probability, not the platform's win rate. The two were never the
// same and for a long time nothing said so, which is how a card could read
// "conviction 99" while that band went on to win 26% of the time.
//
// So the tier ladder no longer sits on the training anchors. It sits on
// conviction-calibration.json: an isotonic fit of the REALIZED win rate per
// score band over every coin Oracle scored that the market has since resolved
// (61,916 coins at the 2026-08-14 fit, win = graduated or >= 2x ATH without
// rugging, base rate 5.4%). That fit exposes exactly five rungs the data can
// tell apart, and the tier boundaries are their edges:
//
//   Avoid   score  0-10    0.7% win   0.13x base
//   Watch   score 10-40    4.9% win   0.89x base
//   Lean    score 40-60    7.3% win   1.34x base
//   Strong  score 60-90   15.0% win   2.75x base
//   Prime   score 90-100  26.3% win   4.82x base
//
// The old ladder (86/72/56/34) split the flat 60-90 plateau into Prime and
// Strong, so those two tiers were statistically identical (12% vs 13%), while
// Watch sat below Avoid. Every rung above is now a distinct measured claim, and
// hitRateFor() serves the rate itself so the UI can quote the odds instead of
// letting a 99 imply 99%. Refit with scripts/oracle-calibrate.mjs.

import MODEL_JSON from './conviction-model.json' with { type: 'json' };
import CALIBRATION_JSON from './conviction-calibration.json' with { type: 'json' };
import { isProven, isFlagged } from './archetype.js';

export const MODEL = MODEL_JSON;
export const CALIBRATION = CALIBRATION_JSON;

// Tier thresholds on the final 0-100 score, set on the rung edges of the
// realized-outcome fit above.
const TIERS = [
	{ min: 90, tier: 'prime', label: 'Prime' },
	{ min: 60, tier: 'strong', label: 'Strong' },
	{ min: 40, tier: 'lean', label: 'Lean' },
	{ min: 10, tier: 'watch', label: 'Watch' },
	{ min: 0, tier: 'avoid', label: 'Avoid' },
];

/** The public tier for a 0-100 conviction score. Single source of the ladder. */
export function tierForScore(score) {
	const s = clamp(num(score));
	return TIERS.find((t) => s >= t.min) || TIERS[TIERS.length - 1];
}

/**
 * The realized hit rate for a score, straight from the production calibration.
 * This is what the score is worth in outcomes: of every resolved coin Oracle
 * scored into this band, `rate` is the fraction that won and `lift` is how many
 * times the market's own base rate that is.
 *
 * @param {number} score 0-100 conviction
 * @returns {{rate:number, lift:number, band:string, n:number, baseRate:number}}
 */
export function hitRateFor(score) {
	const s = clamp(num(score));
	const bands = CALIBRATION.bands || [];
	const band = bands.find((b) => s >= b.lo && s < b.hi) || bands[bands.length - 1] || null;
	return {
		rate: band ? band.calibrated : CALIBRATION.base_rate,
		lift: band ? band.lift : 1,
		band: band ? `${band.lo}-${band.hi}` : null,
		n: band ? band.n : 0,
		baseRate: CALIBRATION.base_rate,
	};
}

// Piecewise-linear map from model probability to the 0-100 score line, anchored
// so each tier boundary corresponds to a fixed P(good). Monotone, invertible.
const A = MODEL.tier_probability_anchors;
const SCORE_ANCHORS = [
	[0, 0],
	[A.watch, 34],
	[A.lean, 56],
	[A.strong, 72],
	[A.prime, 86],
	[1, 100],
];

export { SCORE_ANCHORS };

// What the score PREDICTS, stated once here so every surface can quote it
// instead of implying something broader. The training label is
// `outcome in ('graduated','pumped')`, where 'pumped' means the coin peaked at
// >= 3x its market cap at first sight (workers/agent-sniper/intel/learn.js), and
// that label is deliberately judged INDEPENDENTLY of a later collapse: a launch
// that ran 6x and then rugged is a hit. So conviction ranks the odds of a RUN,
// never the odds of a safe hold, and a high score on a coin whose chart is now
// dead is not necessarily a miss.
//
// Three surfaces grade the engine on a different, stricter question instead
// (graduated, or >= 2x while never rugging: api/oracle/{stats,backtest,wins}.js).
// That number is the right one for a holder and the wrong one for judging the
// ranking, so anything that shows it must show WHICH question it answers. Both
// are real; presenting one as the other is what made a working engine read as a
// broken one.
export const PREDICTED_EVENT = Object.freeze({
	id: 'spike_or_graduate',
	label: 'graduates, or peaks at 3x or more above its market cap at first sight',
	short: 'spikes 3x or graduates',
	caveat: 'A later collapse does not undo a hit. Conviction ranks the odds of a run, not the odds of a safe hold.',
});

const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const sigmoid = (z) => 1 / (1 + Math.exp(-z));

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
 * Inverse of scoreFromProbability: the P(PREDICTED_EVENT) a given score actually
 * claims. The score line is not a percentage (a score of 86 claims 55%, not
 * 86%), so any surface comparing a score to a realized rate has to convert
 * first. Every calibration table we shipped used score/100 as the prediction,
 * which overstated the engine's own claim by up to 4x and made a working ranking
 * look wildly overconfident on top of its real overconfidence.
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

// ── Feature extraction ────────────────────────────────────────────────────────
// The model was trained on the raw launch-time signals JSONB. intel.launch (from
// sources.js) carries those exact values; the derived CoinIntel fields act as
// fallbacks so hand-built intel (tests, older callers) still scores.
const pct01 = (v) => (v == null ? null : num(v) / 100); // 0..100 display -> 0..1 raw

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
	concentration_top10: (it) => rawNum(it, 'concentration_top10') ?? pct01(it.structure?.top10Pct),
	unique_buyers: (it) => rawNum(it, 'unique_buyers') ?? (it.structure?.uniqueBuyers ?? null),
	buy_sell_ratio: (it) => {
		const r = rawNum(it, 'buy_sell_ratio');
		if (r != null) return r;
		const buys = num(it.behavior?.buyCount);
		const sells = num(it.behavior?.sellCount);
		return sells > 0 ? buys / sells : null;
	},
	buy_volume_sol: (it) => rawNum(it, 'buy_volume_sol') ?? (it.behavior?.buyVolSol ?? null),
	largest_buy_sol: (it) => rawNum(it, 'largest_buy_sol'),
	avg_buy_sol: (it) => {
		const r = rawNum(it, 'avg_buy_sol');
		if (r != null) return r;
		const vol = num(it.behavior?.buyVolSol);
		const buys = num(it.behavior?.buyCount);
		return buys > 0 ? vol / buys : null;
	},
	dev_buy_sol: (it) => rawNum(it, 'dev_buy_sol') ?? (it.behavior?.devBuySol ?? null),
	mc_sol_first_seen: (it) => rawNum(it, 'mc_sol_first_seen'),
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
// reason carries the observed good-rate from the model itself: the engine
// quotes its own training data instead of asserting vibes.
const FEATURE_TEXT = {
	organic_score: 'organic demand',
	bundle_score: 'launch coordination',
	snipe_ratio: 'open sniped',
	coordination_score: 'buy coordination',
	timing_entropy: 'buy-timing spread',
	concentration_top1: 'top-holder share',
	concentration_top10: 'top-10 holder share',
	unique_buyers: 'unique early buyers',
	buy_sell_ratio: 'buy/sell pressure',
	buy_volume_sol: 'early buy volume (SOL)',
	largest_buy_sol: 'largest single buy (SOL)',
	avg_buy_sol: 'average buy size (SOL)',
	dev_buy_sol: 'dev buy size (SOL)',
	mc_sol_first_seen: 'market cap at first sight (SOL)',
	dev_sold: 'dev selling in the window',
	creator_record: 'creator launch history',
	category: 'narrative category',
};

function reasonText(feature, bucketLabel, stats) {
	const what = FEATURE_TEXT[feature.key] || feature.key;
	const rate = Math.round((stats?.good_rate ?? 0) * 100);
	const rel = MODEL.base_good_rate > 0 ? (stats?.good_rate ?? 0) / MODEL.base_good_rate : 0;
	const vs = rel >= 1.15 ? `${rel.toFixed(1)}x base rate`
		: rel <= 0.85 ? `${rel.toFixed(1)}x base rate`
		: 'near base rate';
	if (feature.key === 'creator_record') {
		const CREATOR_TEXT = {
			has_wins: 'creator has shipped a graduated launch before',
			serial_no_wins: 'creator has 5+ prior launches, none graduated',
			repeat_no_wins: 'creator relaunches without a single graduation',
			first_launch: 'first launch from this creator',
			unknown: 'creator history unknown',
		};
		return `${CREATOR_TEXT[bucketLabel] || bucketLabel}: ${rate}% of such launches worked (${vs})`;
	}
	if (feature.key === 'category') {
		return `${bucketLabel} narrative: ${rate}% of such launches worked (${vs})`;
	}
	if (feature.key === 'dev_sold') {
		return `${bucketLabel === '>=0.5' ? 'dev sold inside the window' : 'dev held through the window'}: ${rate}% of such launches worked (${vs})`;
	}
	return `${what} ${bucketLabel}: ${rate}% of similar launches worked (${vs})`;
}

// ── Smart-money overlay (expert priors, in log-odds) ─────────────────────────
// Proven/flagged wallets are too rare in the training window to fit weights for
// (214 proven wallets platform-wide at fit time), but when they DO show up they
// are the highest-fidelity signal available, so they stay as explicit
// adjustments on the fused log-odds. Magnitudes are conservative: +0.75 is
// roughly a 2.1x odds bump, comparable to a strong fitted bucket.
export function smartMoneyOverlay(sm = {}, creator = {}) {
	const reasons = [];
	let z = 0;
	let cap = 100;

	const notable = Array.isArray(sm.notable) ? sm.notable : [];
	const provenWallets = notable.filter((w) => isProven(w.label, w.score));
	const flaggedWallets = notable.filter((w) => isFlagged(w.label));
	const provenCount = Math.max(num(sm.smartWalletCount), provenWallets.length);

	if (provenCount >= 5) { z += 0.75; reasons.push(`${provenCount} smart-money wallets already in`); }
	else if (provenCount >= 3) { z += 0.55; reasons.push(`${provenCount} smart-money wallets in`); }
	else if (provenCount >= 1) { z += 0.35; reasons.push(`${provenCount} smart-money wallet in`); }

	const proven = num(sm.provenBuyLamports);
	const total = num(sm.totalBuyLamports);
	if (total > 0 && proven > 0) {
		const share = proven / total;
		if (share >= 0.4) { z += 0.3; reasons.push(`${Math.round(share * 100)}% of buy volume is proven money`); }
		else if (share >= 0.2) { z += 0.15; }
	}

	if (flaggedWallets.length) {
		z -= 0.45 * Math.min(3, flaggedWallets.length);
		reasons.push(`${flaggedWallets.length} flagged wallet${flaggedWallets.length > 1 ? 's' : ''} (rugger/dumper) in the book`);
	}

	const provenSell = num(sm.provenSellLamports);
	if (proven > 0 && provenSell > 0) {
		const exitShare = provenSell / proven;
		if (exitShare >= 0.5) { z -= 0.7; reasons.push(`smart money already sold ${Math.round(exitShare * 100)}% of its position`); }
		else if (exitShare >= 0.25) { z -= 0.35; reasons.push(`smart money trimming (${Math.round(exitShare * 100)}% sold)`); }
	}

	// The one hard cap that survives v2: a serial-rugger creator ceilings the
	// final score at Watch no matter what the rest of the book looks like. The
	// outcome data backs it (5+ launches with 0 graduations: 3.5% good, 0.26x
	// base) and the guarantee matters product-wise: a graveyard dev can never
	// present as Strong.
	const launches = num(creator?.launches);
	const launchWins = num(creator?.launchWins);
	if (isFlagged(creator?.label) || (launches >= 3 && launchWins === 0)) {
		z -= 1.2; cap = 45;
		reasons.push(launches >= 3
			? `creator has ${launches} prior launches, none graduated: rug pattern`
			: 'creator wallet flagged as a rugger');
	}
	const creatorDump = num(creator?.dumpRate);
	if (launches >= 2 && creatorDump >= 0.5) {
		z -= 0.3; reasons.push(`creator dumps ${Math.round(creatorDump * 100)}% of their launches`);
	}

	return { z, cap, reasons, provenCount, flaggedCount: flaggedWallets.length };
}

// ── The engine ────────────────────────────────────────────────────────────────

/**
 * Evaluate the fitted model against one CoinIntel: per-feature bucket hits,
 * per-pillar log-odds sums, and the fused probability. Pure.
 *
 * @param {object} intel normalized CoinIntel (see sources.js)
 * @returns {{
 *   z:number, p:number,
 *   pillarZ:{pedigree:number,structure:number,narrative:number,momentum:number},
 *   hits:Array<{key:string,pillar:string,bucket:string,w:number,stats:object,present:boolean}>
 * }}
 */
export function evaluateModel(intel = {}) {
	let z = MODEL.intercept;
	const pillarZ = { pedigree: 0, structure: 0, narrative: 0, momentum: 0 };
	const hits = [];
	for (const feature of MODEL.features) {
		const getter = FEATURE_VALUE[feature.key];
		const value = getter ? getter(intel) : null;
		const bucket = bucketLabelFor(feature, value);
		const stats = feature.buckets[bucket];
		if (!stats) {
			// A bucket never seen in training (e.g. hand-built intel with no data)
			// contributes nothing rather than inventing a weight.
			hits.push({ key: feature.key, pillar: feature.pillar, bucket, w: 0, stats: null, present: value != null });
			continue;
		}
		z += stats.w;
		pillarZ[feature.pillar] = (pillarZ[feature.pillar] || 0) + stats.w;
		hits.push({ key: feature.key, pillar: feature.pillar, bucket, w: stats.w, stats, present: value != null && bucket !== 'null' });
	}
	return { z, p: sigmoid(z), pillarZ, hits };
}

/**
 * Fuse everything into Oracle Conviction. Same return contract as v1 (score,
 * tier, pillars, reasons, badges, caps, confidence) with the internals swapped
 * for the fitted model + smart-money overlay.
 *
 * @param {object} intel normalized CoinIntel (see sources.js)
 */
export function convict(intel = {}) {
	const evaled = evaluateModel(intel);
	const overlay = smartMoneyOverlay(intel.smartMoney, intel.creator);

	const z = evaled.z + overlay.z;
	const p = sigmoid(z);

	let score = scoreFromProbability(p);
	const cap = overlay.cap;
	score = clamp(Math.min(score, cap));

	const tier = TIERS.find((t) => score >= t.min) || TIERS[TIERS.length - 1];

	// Pillar sub-scores: what each pillar's own evidence (plus, for pedigree, the
	// smart-money overlay) would imply alone, on the same probability->score map.
	// Transparent and unit-consistent with the fused number.
	const pillarScore = (key, extraZ = 0) =>
		scoreFromProbability(sigmoid(MODEL.intercept + (evaled.pillarZ[key] || 0) + extraZ));
	const pillars = {
		pedigree: pillarScore('pedigree', overlay.z),
		structure: pillarScore('structure'),
		narrative: pillarScore('narrative'),
		momentum: pillarScore('momentum'),
	};

	// Confidence: fraction of model features observed (not defaulted/null),
	// weighted equally. The fitted null-buckets DO carry signal (a coin with no
	// sells yet is informative), so this is a presentation aid, not a prior.
	const present = evaled.hits.filter((h) => h.present).length;
	const confidence = clamp(Math.round((present / Math.max(1, evaled.hits.length)) * 100));
	const confidenceLabel = confidence >= 70 ? 'high' : confidence >= 45 ? 'medium' : 'low';

	// Reasons: strongest model evidence first (by |log-odds|), each quoting the
	// observed outcome rate for its bucket, then the smart-money overlay's.
	const modelReasons = evaled.hits
		.filter((h) => h.stats && Math.abs(h.w) >= 0.08)
		.sort((a, b) => Math.abs(b.w) - Math.abs(a.w))
		.slice(0, 7)
		.map((h) => ({
			pillar: h.pillar,
			text: reasonText(MODEL.features.find((f) => f.key === h.key), h.bucket, h.stats),
		}));
	const reasons = [
		...overlay.reasons.map((t) => ({ pillar: 'pedigree', text: t })),
		...modelReasons,
	];
	if (!reasons.length) reasons.push({ pillar: 'structure', text: 'no decisive evidence either way yet' });

	// Badges (compact pills for cards). structure-flag: strong fitted negative
	// evidence from a structure feature. pedigree-flag: the rugger cap fired.
	const badges = [];
	if (overlay.provenCount >= 3) badges.push('smart-money');
	if (evaled.hits.some((h) => h.pillar === 'structure' && h.w <= -0.5)) badges.push('structure-flag');
	if (cap < 100) badges.push('pedigree-flag');
	if (String(intel.narrative?.category || intel.category).toLowerCase() === 'news') badges.push('news');
	if (pillars.momentum >= 72) badges.push('momentum');
	if (confidence < 45) badges.push('thin-data');
	if (score >= 86) badges.push('prime');

	return {
		score,
		tier: tier.tier,
		tierLabel: tier.label,
		probability: Number(p.toFixed(4)),
		pillars,
		weights: PILLAR_WEIGHTS,
		structureCap: 100,
		pedigreeCap: cap,
		confidence,
		confidenceLabel,
		reasons,
		badges,
		model: { version: MODEL.version, fitted_at: MODEL.fitted_at, training_rows: MODEL.training_rows },
	};
}

// Pillar weights, derived from the model instead of hand-picked: each pillar's
// share of the total log-odds range its features can span. Exposed on every
// verdict (the UI renders these as the pillar-weight labels).
export const PILLAR_WEIGHTS = (() => {
	const span = { pedigree: 0, structure: 0, narrative: 0, momentum: 0 };
	for (const f of MODEL.features) {
		const ws = Object.values(f.buckets).map((b) => b.w);
		if (!ws.length) continue;
		span[f.pillar] += Math.max(...ws) - Math.min(...ws);
	}
	const total = Object.values(span).reduce((a, b) => a + b, 0) || 1;
	const out = {};
	for (const [k, v] of Object.entries(span)) out[k] = Number((v / total).toFixed(2));
	return Object.freeze(out);
})();

// Legacy alias: v1 exported hand-picked WEIGHTS; keep the name pointing at the
// derived pillar weights so older readers keep working.
export const WEIGHTS = PILLAR_WEIGHTS;

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
