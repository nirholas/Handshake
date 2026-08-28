/*
 * @three-ws/oracle-model
 *
 * The three.ws Oracle scores every pump.fun launch in its first ninety seconds.
 * This package is that scorer, running on your machine, with the real weights.
 *
 * Not a client for a scoring API. The model is a lookup table of bucket weights
 * (roughly 32KB of JSON), so `OracleModel.fetch()` downloads it once and every
 * score after that is local arithmetic: no key, no rate limit, no network, no
 * telemetry back to us. Pin a model version and you can reproduce any score the
 * platform has ever published, forever, offline.
 *
 * That is the point. A prediction product that publishes only its outputs is
 * asking to be believed. One that publishes the machine can be checked.
 *
 *   import { OracleModel } from '@three-ws/oracle-model';
 *
 *   const oracle = await OracleModel.fetch();
 *   const verdict = oracle.score({
 *     organic_score: 0.82, unique_buyers: 41, buy_volume_sol: 26,
 *     snipe_ratio: 0.12, smart_money_count: 2, dev_sold: false,
 *   });
 *
 *   verdict.score          // 0-100, anchored on P(runs and holds)
 *   verdict.tier           // avoid | watch | lean | strong | prime
 *   verdict.rugRisk        // P(a first-sight holder ends down more than half)
 *   verdict.giveBackRisk   // P(hands the run straight back | it runs)
 *   verdict.why            // every bucket that moved it, with its sample count
 *
 * Zero dependencies. Runs in Node 18+, Deno, Bun, Cloudflare Workers, and the
 * browser.
 */

const DEFAULT_ENDPOINT = 'https://three.ws/api/oracle/model';

/** Tier boundaries on the 0-100 score line. A public contract since v1. */
export const TIERS = Object.freeze([
	{ min: 86, tier: 'prime', label: 'Prime' },
	{ min: 72, tier: 'strong', label: 'Strong' },
	{ min: 56, tier: 'lean', label: 'Lean' },
	{ min: 34, tier: 'watch', label: 'Watch' },
	{ min: 0, tier: 'avoid', label: 'Avoid' },
]);

const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));
const sigmoid = (z) => 1 / (1 + Math.exp(-z));
const numOrNull = (v) => {
	const n = Number(v);
	return v == null || v === '' || !Number.isFinite(n) ? null : n;
};

/**
 * Which bucket a raw signal value falls into, for one feature.
 *
 * This has to match the fitter exactly or you are reading weights that were
 * never trained on the thing you are asking about, so it is one function and
 * both sides use it.
 *
 * @param {object} feature a feature entry from the model document
 * @param {number|string|null} value the raw signal
 * @returns {string} the bucket label
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

/** Human-readable name for each signal, for the `why` list. */
const LABELS = {
	organic_score: 'organic demand',
	bundle_score: 'launch coordination',
	snipe_ratio: 'sniped at open',
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
	dev_sold: 'dev sold in the window',
	creator_record: 'creator launch history',
	category: 'narrative category',
};

/**
 * Turn caller input into the raw value each feature expects.
 *
 * Callers pass a flat bag of signals, which is what the observation pipeline
 * produces anyway. Two of them are derived rather than raw, so they get a
 * fallback: `creator_record` is bucketed from launch counts, and `dev_sold` is a
 * boolean the model sees as 0 or 1.
 */
function featureValue(feature, signals) {
	if (feature.key === 'creator_record') {
		if (typeof signals.creator_record === 'string') return signals.creator_record;
		const launches = numOrNull(signals.creator_launches);
		const wins = numOrNull(signals.creator_wins);
		if (launches == null) return 'unknown';
		if (wins != null && wins >= 1) return 'has_wins';
		if (launches >= 5) return 'serial_no_wins';
		if (launches >= 2) return 'repeat_no_wins';
		return 'first_launch';
	}
	if (feature.key === 'category') return String(signals.category ?? 'unknown').toLowerCase();
	if (feature.key === 'dev_sold') {
		const raw = signals.dev_sold;
		if (raw === true) return 1;
		if (raw === false) return 0;
		return numOrNull(raw);
	}
	return numOrNull(signals[feature.key]);
}

/**
 * A three.ws Oracle conviction model, loaded and ready to score.
 *
 * Construct from a model document (`new OracleModel(doc)`), or fetch the live
 * one with `OracleModel.fetch()`.
 */
export class OracleModel {
	/**
	 * @param {object} doc a model document, as served by GET /api/oracle/model
	 */
	constructor(doc) {
		if (!doc || typeof doc !== 'object') throw new TypeError('OracleModel: expected a model document');
		const model = doc.model && doc.model.features ? doc.model : doc;
		if (!Array.isArray(model.features) || !model.features.length) {
			throw new TypeError('OracleModel: document has no features; pass the object from GET /api/oracle/model');
		}
		if (Number(model.version) < 3) {
			throw new TypeError(`OracleModel: this package needs a v3+ model, got v${model.version}`);
		}
		/** @type {object} the raw model document, exactly as published */
		this.document = model;
		this.version = Number(model.version);
		this.fittedAt = model.fitted_at || null;
		this.trainingRows = Number(model.training_rows) || 0;
		this.scoreHead = model.score_head || 'win';
		this.heads = model.features.length ? Object.keys(model.heads || { win: null }) : [];
		this.anchors = model.tier_probability_anchors || { avoid: 0, watch: 0.05, lean: 0.12, strong: 0.25, prime: 0.45 };
		this.holdout = model.holdout || null;
		this.droppedFeatures = model.dropped_features || [];
		this._scoreAnchors = [
			[0, 0], [this.anchors.watch, 34], [this.anchors.lean, 56],
			[this.anchors.strong, 72], [this.anchors.prime, 86], [1, 100],
		];
	}

	/**
	 * Download the live model.
	 *
	 * One request. Cache the result and reuse the instance; nothing about scoring
	 * touches the network again.
	 *
	 * @param {object} [opts]
	 * @param {string} [opts.endpoint] override the API base (self-hosting, testing)
	 * @param {string} [opts.network] mainnet (default) or devnet
	 * @param {typeof fetch} [opts.fetch] inject a fetch implementation
	 * @param {AbortSignal} [opts.signal]
	 * @returns {Promise<OracleModel>}
	 */
	static async fetch({ endpoint = DEFAULT_ENDPOINT, network = 'mainnet', fetch: fetchImpl, signal } = {}) {
		const f = fetchImpl || globalThis.fetch;
		if (typeof f !== 'function') throw new Error('OracleModel.fetch: no fetch available; pass one in opts.fetch');
		const url = `${endpoint}${endpoint.includes('?') ? '&' : '?'}network=${encodeURIComponent(network)}`;
		const res = await f(url, { headers: { accept: 'application/json' }, signal });
		if (!res.ok) throw new Error(`OracleModel.fetch: ${res.status} ${res.statusText} from ${url}`);
		const body = await res.json();
		if (!body?.model) throw new Error('OracleModel.fetch: response had no model');
		return new OracleModel(body.model);
	}

	/** Map a probability onto the 0-100 score line through the tier anchors. */
	scoreFromProbability(p) {
		const x = Math.max(0, Math.min(1, Number(p) || 0));
		for (let i = 1; i < this._scoreAnchors.length; i++) {
			const [p0, s0] = this._scoreAnchors[i - 1];
			const [p1, s1] = this._scoreAnchors[i];
			if (x <= p1) return clamp(Math.round(s0 + ((x - p0) / (p1 - p0)) * (s1 - s0)));
		}
		return 100;
	}

	/**
	 * The probability a score claims.
	 *
	 * The score line is not a percentage. A score of 86 claims a 45% chance, not
	 * an 86% one, and every table that treated it as a percentage overstated the
	 * engine's own claim by up to four times.
	 */
	probabilityFromScore(score) {
		const s = clamp(Number(score) || 0);
		for (let i = 1; i < this._scoreAnchors.length; i++) {
			const [p0, s0] = this._scoreAnchors[i - 1];
			const [p1, s1] = this._scoreAnchors[i];
			if (s <= s1) return s1 === s0 ? p1 : p0 + ((s - s0) / (s1 - s0)) * (p1 - p0);
		}
		return 1;
	}

	/** The tier a 0-100 score sits in. */
	tierFor(score) {
		const s = clamp(Number(score) || 0);
		return TIERS.find((t) => s >= t.min) || TIERS[TIERS.length - 1];
	}

	/**
	 * Score one launch.
	 *
	 * @param {object} signals flat bag of launch-time signals. Everything is
	 *   optional: a missing signal lands in the model's fitted `null` bucket,
	 *   which carries real information (a coin nobody has sold yet is telling you
	 *   something) rather than being treated as zero.
	 * @returns {{
	 *   score:number, tier:string, tierLabel:string,
	 *   probabilities:Record<string,number>,
	 *   rugRisk:number|null, upside:number|null, giveBackRisk:number|null,
	 *   confidence:number, why:Array<object>, model:object
	 * }}
	 */
	score(signals = {}) {
		const heads = Object.keys(this.document.heads || {});
		const z = {};
		for (const h of heads) z[h] = Number(this.document.heads[h]?.intercept) || 0;

		const why = [];
		let observed = 0;
		for (const feature of this.document.features) {
			const value = featureValue(feature, signals);
			const bucket = bucketLabel(feature, value);
			const stats = feature.buckets?.[bucket];
			// 'null' and 'unknown' are what a feature reads when the caller supplied
			// nothing. Both are real fitted buckets that carry signal, but neither is
			// an observation, and counting them as one made an empty input look 8%
			// confident instead of 0%.
			if (value != null && bucket !== 'null' && bucket !== 'unknown') observed++;
			if (!stats) continue;
			for (const h of heads) z[h] += Number(stats.w?.[h]) || 0;
			why.push({
				feature: feature.key,
				label: LABELS[feature.key] || feature.key,
				pillar: feature.pillar,
				bucket,
				value,
				weight: Number(stats.w?.[this.scoreHead]) || 0,
				samples: stats.n ?? 0,
				// What actually happened to the launches in this bucket. The whole
				// claim, checkable against the count beside it.
				observed: stats.rate || null,
			});
		}
		why.sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));

		const probabilities = {};
		for (const h of heads) probabilities[h] = Number(sigmoid(z[h]).toFixed(4));

		const p = probabilities[this.scoreHead] ?? 0;
		const score = this.scoreFromProbability(p);
		const tier = this.tierFor(score);

		const rugRisk = probabilities.rug != null ? clamp(Math.round(probabilities.rug * 100)) : null;
		const upside = probabilities.moon != null ? clamp(Math.round(probabilities.moon * 100)) : null;
		const giveBackRisk = probabilities.moon > 0 && probabilities.win != null
			? clamp(Math.round((1 - Math.min(1, probabilities.win / probabilities.moon)) * 100))
			: null;

		return {
			score,
			tier: tier.tier,
			tierLabel: tier.label,
			probabilities,
			rugRisk,
			upside,
			giveBackRisk,
			confidence: clamp(Math.round((observed / Math.max(1, this.document.features.length)) * 100)),
			why,
			model: { version: this.version, fitted_at: this.fittedAt, training_rows: this.trainingRows, score_head: this.scoreHead },
		};
	}

	/**
	 * The same score, with the arithmetic shown.
	 *
	 * Returns every term that went into the log-odds sum and what it added, so a
	 * reader can add the column up by hand and land on the same probability. Use
	 * it to audit a published score, or to work out which signal to change.
	 */
	explain(signals = {}) {
		const verdict = this.score(signals);
		const head = this.scoreHead;
		const intercept = Number(this.document.heads?.[head]?.intercept) || 0;
		const terms = verdict.why.map((w) => ({
			term: `${w.feature} = ${w.bucket}`,
			log_odds: w.weight,
			samples: w.samples,
			observed_rate: w.observed?.[head] ?? null,
		}));
		const total = terms.reduce((a, t) => a + t.log_odds, intercept);
		return {
			...verdict,
			math: {
				head,
				intercept,
				terms,
				total_log_odds: Number(total.toFixed(4)),
				probability: Number(sigmoid(total).toFixed(4)),
				formula: 'p = 1 / (1 + exp(-(intercept + sum(term log_odds))))',
			},
		};
	}

	/**
	 * What the model earned on launches it had never seen, per head.
	 *
	 * AUC, Brier score, precision at the top 1/5/10/25%, and the reliability
	 * curve. Published with the weights so nobody has to take the ranking on
	 * trust, including us.
	 */
	performance(head = this.scoreHead) {
		const h = this.holdout?.[head];
		if (!h) return null;
		return {
			head,
			holdout_n: this.holdout.n,
			auc: h.auc,
			brier: h.brier,
			base_rate: h.base_rate,
			precision: h.precision,
			reliability: h.reliability,
		};
	}

	/**
	 * Check the model against outcomes you collected yourself.
	 *
	 * Give it launches with a known result and it returns AUC, Brier, and the
	 * reliability curve on YOUR data. If our published numbers do not survive
	 * contact with an independent sample, this is how you find out, and we would
	 * rather you could.
	 *
	 * @param {Array<{signals:object, outcome:boolean|number}>} samples
	 * @param {string} [head] which question the outcome answers
	 */
	verify(samples, head = this.scoreHead) {
		if (!Array.isArray(samples) || !samples.length) throw new TypeError('verify: pass a non-empty array of {signals, outcome}');
		const ps = [];
		const ys = [];
		for (const s of samples) {
			ps.push(this.score(s.signals || {}).probabilities[head] ?? 0);
			ys.push(s.outcome ? 1 : 0);
		}

		const order = [...ps.keys()].sort((a, b) => ps[a] - ps[b]);
		let sumPosRanks = 0, nPos = 0, nNeg = 0;
		for (let i = 0; i < order.length;) {
			let j = i;
			while (j < order.length && ps[order[j]] === ps[order[i]]) j++;
			const avgRank = (i + j + 1) / 2;
			for (let k = i; k < j; k++) {
				if (ys[order[k]] === 1) { sumPosRanks += avgRank; nPos++; } else nNeg++;
			}
			i = j;
		}
		const auc = nPos && nNeg ? (sumPosRanks - (nPos * (nPos + 1)) / 2) / (nPos * nNeg) : 0.5;
		const brier = ps.reduce((a, p, i) => a + (p - ys[i]) ** 2, 0) / ps.length;

		const edges = [0, 0.05, 0.12, 0.25, 0.45, 1.0001];
		const reliability = [];
		for (let i = 0; i + 1 < edges.length; i++) {
			let n = 0, good = 0, sumP = 0;
			for (let k = 0; k < ps.length; k++) {
				if (ps[k] >= edges[i] && ps[k] < edges[i + 1]) { n++; good += ys[k]; sumP += ps[k]; }
			}
			reliability.push({
				lo: edges[i], hi: Math.min(1, edges[i + 1]), n,
				observed: n ? Number((good / n).toFixed(4)) : null,
				predicted: n ? Number((sumP / n).toFixed(4)) : null,
			});
		}
		return {
			head, n: ps.length,
			base_rate: Number((ys.reduce((a, b) => a + b, 0) / ys.length).toFixed(4)),
			auc: Number(auc.toFixed(4)),
			brier: Number(brier.toFixed(5)),
			reliability,
		};
	}

	/**
	 * What changed between two model versions.
	 *
	 * Every bucket whose weight moved, biggest move first, with the sample count
	 * behind each one. This is the closest you can get to watching a model change
	 * its mind, and it works entirely on documents you already downloaded.
	 *
	 * @param {OracleModel|object} other the model to compare against
	 * @param {number} [threshold] ignore moves smaller than this in log-odds
	 */
	diff(other, threshold = 0.02) {
		const to = other instanceof OracleModel ? other : new OracleModel(other);
		const head = this.scoreHead;
		const index = (m) => {
			const out = new Map();
			for (const f of m.document.features) {
				for (const [bucket, stats] of Object.entries(f.buckets || {})) {
					out.set(`${f.key}/${bucket}`, { w: Number(stats.w?.[head]) || 0, n: stats.n });
				}
			}
			return out;
		};
		const a = index(this);
		const b = index(to);
		const moves = [];
		for (const [key, cur] of b) {
			const prev = a.get(key);
			if (!prev) { moves.push({ key, kind: 'new', from: null, to: cur.w, delta: cur.w, samples: cur.n }); continue; }
			const delta = Number((cur.w - prev.w).toFixed(4));
			if (Math.abs(delta) >= threshold) moves.push({ key, kind: 'moved', from: prev.w, to: cur.w, delta, samples: cur.n });
		}
		for (const [key, prev] of a) {
			if (!b.has(key)) moves.push({ key, kind: 'gone', from: prev.w, to: null, delta: -prev.w, samples: prev.n });
		}
		moves.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
		return {
			head,
			from: { fitted_at: this.fittedAt, training_rows: this.trainingRows },
			to: { fitted_at: to.fittedAt, training_rows: to.trainingRows },
			auc: { from: this.performance(head)?.auc ?? null, to: to.performance(head)?.auc ?? null },
			moves,
		};
	}

	/** Rank a list of launches by score, best first. Convenience for scanners. */
	rank(launches, { key = 'signals', limit = Infinity } = {}) {
		return launches
			.map((l) => ({ ...l, verdict: this.score(l?.[key] ?? l) }))
			.sort((a, b) => b.verdict.score - a.verdict.score)
			.slice(0, limit);
	}
}

/**
 * Score one launch against the live model, fetching it if needed.
 *
 * Convenience for a one-off. In anything that scores more than once, hold onto
 * an `OracleModel` instead so the download happens once.
 *
 * @param {object} signals
 * @param {object} [opts] forwarded to OracleModel.fetch
 */
let _shared = null;
export async function score(signals, opts = {}) {
	if (!_shared) _shared = await OracleModel.fetch(opts);
	return _shared.score(signals);
}

export default OracleModel;
