// Earned autonomy: how much rope an arm gets, decided by its own realized record.
//
// The fleet's two self-improvement loops (api/cron/sniper-optimize.js tunes each
// arm's knobs, scripts/sniper-evolve.mjs moves budget between arms) used to treat
// every arm identically: the same hard bounds, the same per-run step, the same
// short list of writable fields, the same context in front of the LLM judge. That
// is backwards. An arm that has proven it makes money should be allowed to explore
// further and be told more; an arm that has proven it loses money should be held
// tighter until it recovers.
//
// This module is the pure policy that decides that. Given one arm's real trading
// record it returns a TIER, and the tier scales four things:
//
//   1. BOUNDS:    how far the optimizer may move each knob.
//   2. STEP:      how fast it may move it per run.
//   3. WRITABLE:  which knobs it may touch at all (higher tiers unlock the entry
//                  universe, the LLM confidence bar, and the take-initials ladder).
//   4. KNOWLEDGE: how much evidence the LLM judge is handed before it decides.
//
// Plus a budget weight the evolution loop uses to concentrate the fixed fleet
// budget on earned arms.
//
// WHAT THIS NEVER TOUCHES. The deterministic safety rails are not "guardrails" in
// the sense meant here and no tier can reach them: the trade firewall's real
// buy→sell round-trip, Mayhem exclusion, max_price_impact, SOL headroom, the daily
// loss cap, max_concurrent_positions, and the fleet daily budget ceiling are all
// enforced in executeBuy and out of this module's reach. A tier widens the space
// an arm may search; it never removes the floor under it. The worst an autonomous
// arm can do is take a firewall-vetted, stop-loss-protected, budget-bounded trade.
//
// Pure: no I/O, no clock, no DB. Every input is passed in, so the whole policy is
// unit-testable and the same function decides the tier everywhere it is read.

/** Tiers, least to most rope. */
export const TIER_ORDER = ['probation', 'standard', 'trusted', 'autonomous'];

/** A per-trade realized average this close to zero is noise, not profit. */
export const MIN_EDGE_PCT = 0.5;

/** Evidence gates. Sample sizes are real closed fills, never paper. */
export const GATES = {
	trusted: { closed: 12, avgPnlPct: MIN_EDGE_PCT },
	autonomous: { closed: 40, avgPnlPct: 5 },
	// Aligned with the evolution loop's MIN_SAMPLES_RETIRE: below this an arm has
	// not lost enough times for the loss to mean anything.
	probation: { closed: 15, avgPnlPct: -MIN_EDGE_PCT },
};

// Hard ranges per tier. `standard` is the historical behaviour byte-for-byte, so
// an un-tiered caller is unchanged. Higher tiers widen the search space; probation
// narrows it. per_trade_lamports ceilings rise with tier, but the arm's daily
// budget (set by the evolution loop out of a fixed fleet total) remains the real
// spend ceiling regardless of what is allowed here.
export const TIER_BOUNDS = {
	probation: {
		take_profit_pct: { min: 15, max: 150 },
		trailing_stop_pct: { min: 8, max: 40 },
		stop_loss_pct: { min: 10, max: 40 },
		max_hold_seconds: { min: 120, max: 3_600 },
		min_quality_score: { min: 0, max: 100 },
		min_oracle_score: { min: 0, max: 100 },
		per_trade_lamports: { min: 2_000_000, max: 50_000_000 },
	},
	standard: {
		take_profit_pct: { min: 15, max: 300 },
		trailing_stop_pct: { min: 8, max: 50 },
		stop_loss_pct: { min: 10, max: 50 },
		max_hold_seconds: { min: 120, max: 7_200 },
		min_quality_score: { min: 0, max: 100 },
		min_oracle_score: { min: 0, max: 100 },
		per_trade_lamports: { min: 2_000_000, max: 200_000_000 },
	},
	trusted: {
		take_profit_pct: { min: 10, max: 500 },
		trailing_stop_pct: { min: 5, max: 60 },
		stop_loss_pct: { min: 10, max: 60 },
		max_hold_seconds: { min: 60, max: 21_600 },
		min_quality_score: { min: 0, max: 100 },
		min_oracle_score: { min: 0, max: 100 },
		per_trade_lamports: { min: 2_000_000, max: 350_000_000 },
		// Unlocked at this tier.
		llm_min_confidence: { min: 0.35, max: 0.95 },
		min_market_cap_usd: { min: 1_000, max: 500_000 },
		max_market_cap_usd: { min: 10_000, max: 5_000_000 },
		initials_out_multiple: { min: 1.5, max: 5 },
		moonbag_min_pct: { min: 5, max: 60 },
	},
	autonomous: {
		take_profit_pct: { min: 5, max: 1_000 },
		trailing_stop_pct: { min: 3, max: 75 },
		// Never null, never absent: the stop is the one thing every tier keeps.
		stop_loss_pct: { min: 10, max: 65 },
		max_hold_seconds: { min: 30, max: 86_400 },
		min_quality_score: { min: 0, max: 100 },
		min_oracle_score: { min: 0, max: 100 },
		per_trade_lamports: { min: 2_000_000, max: 500_000_000 },
		llm_min_confidence: { min: 0.25, max: 0.95 },
		min_market_cap_usd: { min: 500, max: 1_000_000 },
		max_market_cap_usd: { min: 5_000, max: 10_000_000 },
		initials_out_multiple: { min: 1.5, max: 10 },
		moonbag_min_pct: { min: 5, max: 75 },
		max_creator_launches: { min: 1, max: 100 },
	},
};

/** Per-run step multiplier: earned arms converge (and explore) faster. */
export const TIER_STEP_SCALE = {
	probation: 0.5,
	standard: 1,
	trusted: 1.75,
	autonomous: 2.5,
};

/**
 * Fitness multiplier the evolution loop applies before splitting the fixed fleet
 * budget. Concentrates capital on earned arms without changing the fleet total or
 * removing the per-arm exploration floor.
 */
export const TIER_BUDGET_WEIGHT = {
	probation: 0.6,
	standard: 1,
	trusted: 1.5,
	autonomous: 2.2,
};

/**
 * How much evidence the LLM judge is handed before it rules on a launch.
 *   base:     the launch brief + market-realness read (the historical prompt).
 *   informed: plus the ground-truth base rate, the learned signal weights, and
 *              this arm's own realized track record.
 *   full:     plus the conditional win-rate table (which signal buckets actually
 *              win) and the arm's own verdict calibration.
 */
export const TIER_KNOWLEDGE = {
	probation: 'base',
	standard: 'base',
	trusted: 'informed',
	autonomous: 'full',
};

/** Fields every tier may write (the historical set). */
const BASE_WRITABLE = [
	'take_profit_pct', 'trailing_stop_pct', 'stop_loss_pct', 'max_hold_seconds',
	'min_quality_score', 'min_oracle_score', 'per_trade_lamports',
];

/** Fields each tier unlocks on top of BASE_WRITABLE. */
const TIER_UNLOCKS = {
	probation: [],
	standard: [],
	// An arm that makes money earns the right to widen its own hunting ground,
	// lower its own confidence bar, and let its winners run on the ladder.
	trusted: ['llm_min_confidence', 'min_market_cap_usd', 'max_market_cap_usd', 'initials_out_multiple', 'moonbag_min_pct'],
	autonomous: ['llm_min_confidence', 'min_market_cap_usd', 'max_market_cap_usd', 'initials_out_multiple', 'moonbag_min_pct', 'max_creator_launches'],
};

/**
 * Fields that may be set from unset (null).
 *
 * trailing_stop_pct is here for every tier on purpose: an arm carrying a null
 * trailing stop has no way out of a fading position except the hard stop or the
 * timeout, and setting one only ever protects. The ladder fields need unset→set
 * because that is precisely how the take-initials exit gets turned on.
 */
const BASE_UNSET_OK = ['take_profit_pct', 'min_oracle_score', 'min_quality_score', 'trailing_stop_pct'];
const TIER_UNSET_OK = {
	probation: [],
	standard: [],
	trusted: ['initials_out_multiple'],
	autonomous: ['initials_out_multiple'],
};

const norm = (tier) => (TIER_ORDER.includes(tier) ? tier : 'standard');

/** Rank comparison helper: `atLeast('trusted', tier)`. */
export function atLeast(minTier, tier) {
	return TIER_ORDER.indexOf(norm(tier)) >= TIER_ORDER.indexOf(norm(minTier));
}

/** Hard ranges for a tier. */
export function boundsFor(tier) {
	return TIER_BOUNDS[norm(tier)];
}

/** Per-run step ceilings for a tier, derived from the standard steps. */
export function stepsFor(tier, baseSteps) {
	const scale = TIER_STEP_SCALE[norm(tier)];
	const out = {};
	for (const [field, step] of Object.entries(baseSteps)) {
		// Fractional steps (per_trade_fraction) scale but stay a sane fraction.
		out[field] = field.endsWith('_fraction') ? Math.min(0.75, step * scale) : step * scale;
	}
	return out;
}

/** The set of fields a tier's optimizer may write. */
export function writableFor(tier) {
	return new Set([...BASE_WRITABLE, ...TIER_UNLOCKS[norm(tier)]]);
}

/** The set of fields a tier may set from null. */
export function unsetOkFor(tier) {
	return new Set([...BASE_UNSET_OK, ...TIER_UNSET_OK[norm(tier)]]);
}

/** Budget concentration weight for the evolution loop. */
export function budgetWeightFor(tier) {
	return TIER_BUDGET_WEIGHT[norm(tier)];
}

/** How deep a knowledge pack this tier's judge receives. */
export function knowledgeFor(tier) {
	return TIER_KNOWLEDGE[norm(tier)];
}

/**
 * Classify one arm from its realized record. Recomputed from scratch on every
 * optimizer run against a trailing window, so a tier is always current: an arm
 * that stops making money loses its rope on the next pass without anyone
 * intervening, and a demoted arm earns it back the same way.
 *
 * `avgPnlPct` (mean realized P&L per closed trade) is the edge measure rather
 * than win rate on purpose: an arm can win 36% of the time and still be the most
 * profitable on the board, and that arm is exactly the one that has earned room.
 *
 * @param {object} record
 * @param {number} record.closed           real closed fills in the window
 * @param {number} [record.wins]           real winning fills (reported, not gating)
 * @param {number} record.netPnlLamports   realized net P&L over the window
 * @param {number} record.avgPnlPct        mean realized P&L % per closed trade
 * @returns {{ tier:string, reason:string, evidence:object }}
 */
export function classifyAutonomy(record) {
	const closed = Number(record?.closed) || 0;
	const net = Number(record?.netPnlLamports) || 0;
	const avg = Number(record?.avgPnlPct) || 0;
	const wins = Number(record?.wins) || 0;
	const evidence = {
		closed, wins, net_pnl_sol: Number((net / 1e9).toFixed(6)), avg_pnl_pct: Number(avg.toFixed(2)),
		win_rate_pct: closed > 0 ? Math.round((wins / closed) * 100) : 0,
	};

	const profitable = net > 0 && avg >= MIN_EDGE_PCT;
	const bleeding = net < 0 && avg <= -MIN_EDGE_PCT;

	if (profitable && closed >= GATES.autonomous.closed && avg >= GATES.autonomous.avgPnlPct) {
		return {
			tier: 'autonomous',
			reason: `Sustained profit: +${avg.toFixed(1)}% average over ${closed} real trades (net ${evidence.net_pnl_sol} SOL). Full field access, widest bounds, complete knowledge pack.`,
			evidence,
		};
	}
	if (profitable && closed >= GATES.trusted.closed) {
		return {
			tier: 'trusted',
			reason: `Profitable with a real sample: +${avg.toFixed(1)}% average over ${closed} real trades (net ${evidence.net_pnl_sol} SOL). Entry universe, confidence bar and take-initials ladder unlocked.`,
			evidence,
		};
	}
	if (bleeding && closed >= GATES.probation.closed) {
		return {
			tier: 'probation',
			reason: `Proven bleed: ${avg.toFixed(1)}% average over ${closed} real trades (net ${evidence.net_pnl_sol} SOL). Bounds narrowed and steps halved until the record recovers.`,
			evidence,
		};
	}
	return {
		tier: 'standard',
		reason: closed < GATES.trusted.closed
			? `Insufficient evidence: ${closed} real trades. Standard bounds until the record can carry a verdict.`
			: `No decisive edge: ${avg.toFixed(1)}% average over ${closed} real trades. Standard bounds.`,
		evidence,
	};
}

/** One-line human summary of what a tier grants. For reports and the UI. */
export function describeTier(tier) {
	const t = norm(tier);
	return {
		probation: 'Held tight: narrowed bounds, half steps, size capped at 0.05 SOL, base knowledge.',
		standard: 'Default: historical bounds and steps, base knowledge.',
		trusted: 'Earned: wider bounds, 1.75x steps, entry universe + confidence bar + ladder unlocked, informed knowledge pack.',
		autonomous: 'Fully earned: widest bounds, 2.5x steps, every tunable field unlocked, complete knowledge pack.',
	}[t];
}
