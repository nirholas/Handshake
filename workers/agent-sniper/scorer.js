// agent-sniper — entry scoring. Pure, no I/O.
//
// Given an enriched mint event (from connectPumpFunFeed) and a strategy row,
// decide whether the agent should snipe it. Returns { pass, score, reasons }.
// `reasons` always explains the verdict — kept on skipped events too so the
// logs show WHY a mint was passed over, which is what you stare at when tuning.

import { learnedScore } from './intel/learn.js';
import { assessMarketRealness } from '../../api/_lib/market-realness.js';

function n(v) {
	if (v == null) return null;
	const x = Number(v);
	return Number.isFinite(x) ? x : null;
}

function envNum(k) {
	const v = process.env[k];
	if (v == null || v === '') return null;
	const x = Number(v);
	return Number.isFinite(x) ? x : null;
}

// Fleet-wide market-cap SAFETY BAND. Set these on the worker to enforce a band
// across EVERY agent at once, without editing each stored strategy — the fix for a
// fleet that was armed with no market-cap bounds and is buying $4k dust. A
// per-strategy min/max only TIGHTENS this band, it can never loosen it. Unset =
// no clamp (legacy behaviour). e.g. SNIPER_MIN_MC_FLOOR_USD=10000,
// SNIPER_MAX_MC_CEIL_USD=100000 to enforce the 10k–100k rule everywhere.
//
// NOTE: on a blind `new_mint` snipe the create-event market cap is ~$4k, so a
// 10k floor correctly rejects brand-new launches — to actually BUY inside the
// band, the strategy must use the `intel_confirmed` trigger, which scores a coin
// AFTER it has pumped into range. That is the intended, non-rug entry.
const MC_FLOOR = envNum('SNIPER_MIN_MC_FLOOR_USD');
const MC_CEIL = envNum('SNIPER_MAX_MC_CEIL_USD');

// Combine a per-strategy bound with the fleet band: min tightens UP, max tightens DOWN.
function tightenMin(stratMin, floor) {
	if (stratMin == null) return floor;
	if (floor == null) return stratMin;
	return Math.max(stratMin, floor);
}
function tightenMax(stratMax, ceil) {
	if (stratMax == null) return ceil;
	if (ceil == null) return stratMax;
	return Math.min(stratMax, ceil);
}

/**
 * Market-cap band gate — the single source of truth for the owner's "buy only
 * $10k–$100k" rule. The effective band is the per-strategy bound tightened by the
 * fleet-wide safety band (SNIPER_MIN_MC_FLOOR_USD / SNIPER_MAX_MC_CEIL_USD). It
 * FAILS CLOSED: an unknown market cap fails the min gate, because we must never
 * buy blind into a band we can't even price the coin into — that was the rug hole.
 * Returns a skip reason string when out of band (or unknown while a min exists),
 * or null when the coin is inside the band / no band is configured.
 *
 * Shared by scoreMint, scoreIntel, AND the executeBuy chokepoint so EVERY trigger
 * path (new_mint / intel / alpha / first_claim / radar / swarm) enforces the same
 * rule — not just the two scorers that happened to implement it.
 */
export function marketCapBandReason(mcUsdRaw, strat) {
	const mcUsd = n(mcUsdRaw);
	const minMc = tightenMin(n(strat.min_market_cap_usd), MC_FLOOR);
	const maxMc = tightenMax(n(strat.max_market_cap_usd), MC_CEIL);
	if (minMc != null && (mcUsd == null || mcUsd < minMc)) return `mc_below_min:${mcUsd ?? 'n/a'}<${minMc}`;
	if (maxMc != null && mcUsd != null && mcUsd > maxMc) return `mc_above_max:${Math.round(mcUsd)}>${maxMc}`;
	return null;
}

/**
 * @param {object} mint  enriched PumpPortal mint event
 * @param {object} strat agent_sniper_strategies row
 * @returns {{ pass: boolean, score: number, reasons: string[] }}
 */
export function scoreMint(mint, strat) {
	const reasons = [];
	let score = 0;

	// ── hard filters (any failure → skip) ────────────────────────────────────
	if (strat.require_sol_quote && mint.is_usdc_pair) {
		return { pass: false, score: 0, reasons: ['quote_not_sol'] };
	}

	const bandReason = marketCapBandReason(mint.market_cap_usd, strat);
	if (bandReason) return { pass: false, score: 0, reasons: [bandReason] };

	const launches = n(mint.creator_launches);
	const graduated = n(mint.creator_graduated);
	const maxLaunches = n(strat.max_creator_launches);
	const minGrad = n(strat.min_creator_graduated);
	// Serial-rugger guard, FAIL CLOSED: many launches → skip; and if a launch cap
	// is set but the creator's history couldn't be read (enrich timeout), skip too
	// rather than let a serial rugger slip through on a null. Matches the fail-closed
	// launch gate in api/_lib/agent-strategy-runtime.js.
	if (maxLaunches != null && (launches == null || launches > maxLaunches)) {
		return { pass: false, score: 0, reasons: [launches == null ? 'creator_launches_unknown' : 'creator_too_many_launches'] };
	}
	if (minGrad != null && (graduated == null || graduated < minGrad)) {
		return { pass: false, score: 0, reasons: ['creator_too_few_graduated'] };
	}

	const hasSocials = !!(mint.twitter || mint.telegram || mint.website);
	if (strat.require_socials && !hasSocials) {
		return { pass: false, score: 0, reasons: ['no_socials'] };
	}

	// ── soft signals (contribute to score; tie-break / future ranking) ───────
	if (hasSocials) { score += 1; reasons.push('has_socials'); }
	if (graduated != null && graduated > 0) { score += graduated; reasons.push(`creator_graduated:${graduated}`); }
	const initBuy = n(mint.initial_buy_sol);
	if (initBuy != null && initBuy >= 1) { score += 1; reasons.push(`initial_buy:${initBuy.toFixed(2)}sol`); }
	const mcUsd = n(mint.market_cap_usd);
	if (mcUsd != null) reasons.push(`mc_usd:${Math.round(mcUsd)}`);

	return { pass: true, score, reasons };
}

/**
 * Decide whether to buy a coin AFTER the Coin Intelligence Engine has finished
 * observing it. Drives `trigger='intel_confirmed'` strategies. Unlike scoreMint
 * (which fires blind on the create event), this has the full picture: bundle
 * likelihood, organic score, concentration, dev behaviour, classification, and
 * the learned weights. It can afford to be picky — a passed-over coin costs
 * nothing, a bundle-rug costs real SOL.
 *
 * @param {object} rec    finished intel record (from intel/watcher.js)
 * @param {object} strat  agent_sniper_strategies row (trigger=intel_confirmed)
 * @param {object|null} weights  learned weights (from intel/store.getLearnedWeights)
 * @returns {{ pass: boolean, score: number, reasons: string[] }}
 */
export function scoreIntel(rec, strat, weights = null) {
	const reasons = [];
	const s = rec?.signals || {};

	// ── hard gates ───────────────────────────────────────────────────────────
	// Market-cap band first — this is the trigger meant to buy INSIDE the band
	// (a coin observed after it pumped into range), so the fleet band applies here
	// too. Unknown mcap fails a min gate: never buy what we can't price into band.
	const bandReason = marketCapBandReason(rec.market_cap_usd, strat);
	if (bandReason) return { pass: false, score: 0, reasons: [bandReason] };
	const minQ = n(strat.min_quality_score);
	if (minQ != null && (rec.quality_score == null || rec.quality_score < minQ)) {
		return { pass: false, score: 0, reasons: [`quality_below_min:${rec.quality_score}`] };
	}
	const maxBundle = n(strat.max_bundle_score);
	if (maxBundle != null && s.bundle_score != null && s.bundle_score > maxBundle) {
		return { pass: false, score: 0, reasons: [`bundle_above_max:${s.bundle_score}`] };
	}
	const maxConc = n(strat.max_concentration_top1);
	if (maxConc != null && s.concentration_top1 != null && s.concentration_top1 > maxConc) {
		return { pass: false, score: 0, reasons: [`whale_concentration:${s.concentration_top1}`] };
	}
	// avoid_dev_dump defaults true (column default) — treat undefined as true.
	if (strat.avoid_dev_dump !== false && s.dev_sold) {
		return { pass: false, score: 0, reasons: ['dev_dumped'] };
	}
	const cats = Array.isArray(strat.allowed_categories) ? strat.allowed_categories.filter(Boolean) : [];
	if (cats.length && rec.category && !cats.includes(rec.category)) {
		return { pass: false, score: 0, reasons: [`category_excluded:${rec.category}`] };
	}
	// Reuse the new-mint hard filters that still apply post-observation.
	if (strat.require_socials && !(rec.twitter || rec.telegram || rec.website)) {
		return { pass: false, score: 0, reasons: ['no_socials'] };
	}

	// Market-realness gate (the painted-stairstep defense). A big candle that then
	// stairsteps up on a handful of wallets with no sellers is a chart painted to
	// trap momentum bots; in the platform's own 62k labeled outcomes a genuine
	// two-sided market (>=20 buyers & >=5 sellers) wins 52% vs a ~12% base, while a
	// painted one-sided rise barely beats a coin flip. Two optional per-strategy
	// hard gates, off by default so existing arms are unchanged:
	//   require_two_sided_market — demand the proven two-sided bar before buying.
	//   min_unique_sellers       — demand a floor of real sellers (a two-sided market).
	const market = assessMarketRealness(s);
	if (strat.require_two_sided_market === true && !market.twoSided) {
		return { pass: false, score: 0, reasons: [`not_two_sided:${market.read}`] };
	}
	const minSellers = n(strat.min_unique_sellers);
	if (minSellers != null && (market.sellers == null || market.sellers < minSellers)) {
		return { pass: false, score: 0, reasons: [`too_few_sellers:${market.sellers ?? 0}<${minSellers}`] };
	}

	// Smart-money gate (task 03). `rec.smart_money` is the live graph read attached
	// by the worker (getSmartMoneyForMint). It honours two optional strategy knobs:
	//   require_smart_money   — demand at least one reputable, non-sybil buyer.
	//   min_smart_money_score — demand the coin's 0..100 pedigree score clears a bar.
	// Both skip silently when the graph hasn't scored this coin yet (computed:false)
	// — a brand-new coin lacks history; the other gates still protect the snipe.
	const sm = rec.smart_money || null;
	const smComputed = !!(sm && sm.computed);
	if (smComputed) {
		if (strat.require_smart_money === true && (sm.count ?? 0) < 1) {
			return { pass: false, score: 0, reasons: ['no_smart_money'] };
		}
		const minSm = n(strat.min_smart_money_score);
		if (minSm != null && (n(sm.smart_money_score) ?? 0) < minSm) {
			return { pass: false, score: 0, reasons: [`smart_money_below_min:${sm.smart_money_score}<${minSm}`] };
		}
	}

	// ── score: baseline quality + learned model + organic, minus risk ─────────
	let score = (rec.quality_score ?? 0) / 100;
	reasons.push(`quality:${rec.quality_score}`);
	if (s.organic_score != null) { score += s.organic_score * 0.5; reasons.push(`organic:${s.organic_score}`); }
	if (s.bundle_score != null) { score -= s.bundle_score * 0.5; if (s.bundle_score >= 0.4) reasons.push(`bundle:${s.bundle_score}`); }

	const learned = learnedScore(s, weights);
	if (learned != null) { score += learned; reasons.push(`learned:${learned}`); }

	// Market realness: reward a genuine two-sided market, drag a painted stairstep.
	// Always on (no knob) so EVERY intel arm's ranking reflects the single strongest
	// signal in the data, centered so a neutral market neither helps nor hurts.
	if (market.buyers != null && !market.flags.includes('insufficient_trades')) {
		score += (market.realness - 0.5) * 0.8;
		if (market.twoSided) reasons.push('two_sided');
		if (market.painted) reasons.push(`painted:${market.read}`);
	}

	// Smart-money lifts the score (proven money in) and a dominant sybil cluster
	// drags it (a manufactured "wide base"). Pure contribution — no I/O here.
	if (smComputed) {
		const smScore = n(sm.smart_money_score) ?? 0;
		const smCount = sm.count ?? 0;
		if (smCount > 0) { score += Math.min(0.5, (smScore / 100) * 0.5); reasons.push(`smart_money:${smScore}/${smCount}`); }
		if (sm.sybil_flag) { score -= 0.4; reasons.push('sybil_cluster'); }
	}

	if (rec.category) reasons.push(`cat:${rec.category}`);
	for (const flag of rec.risk_flags || []) reasons.push(`flag:${flag}`);

	return { pass: true, score: Number(score.toFixed(4)), reasons };
}
