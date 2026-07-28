// Autonomous sniper optimizer: pure decision logic (no I/O).
//
// Given one arm's REAL trading record over a window and its current config,
// propose bounded, explainable adjustments to the knobs a human owner already
// tunes. Every proposal is clamped to a hard range AND to a small per-run step,
// so a single run can never lurch an arm to an extreme. The cron
// (api/cron/sniper-optimize.js) persists these proposals and, in apply mode,
// enacts them only for arms that opted in (auto_optimize = true).
//
// This never touches the deterministic safety rails (trade firewall, Mayhem
// exclusion, budgets, concurrency). It only moves policy knobs, each bounded.
//
// EARNED AUTONOMY. The range, the step, and the set of writable fields are not
// fixed: they come from the arm's tier (api/_lib/sniper-autonomy.js), which is
// recomputed from its realized record on every run. A profitable arm gets wider
// bounds, bigger steps, and access to fields a losing arm cannot touch (its entry
// universe, its LLM confidence bar, the take-initials ladder); an arm that is
// bleeding gets narrower bounds and half steps until it recovers. Callers that
// pass no tier get 'standard', which is the historical behaviour exactly.
//
// Design: rules are ordered by priority; the first rule to claim a field wins,
// so proposals never conflict. Each rule cites the evidence that triggered it.
// Rules O/A/B/C/S/E tighten and run for every tier. Rules D/F/G/H hand room back to
// an arm that earned it and are gated on tier + realized profit.

import { atLeast, boundsFor, stepsFor, unsetOkFor, writableFor } from './sniper-autonomy.js';

// Minimum closed real trades before the optimizer will act on an arm. Below
// this the sample is noise and every rule no-ops.
export const MIN_SAMPLE = 8;

// Exception floor for arms with ZERO wins. A 0-for-6 record with net losses is
// evidence enough to shrink the bet while the sample grows (only Rule E may act
// on it); waiting for the general MIN_SAMPLE let winless arms bleed unthrottled.
export const MIN_SAMPLE_WINLESS = 6;

// Hard ranges for the DEFAULT tier. Every tier's ranges live in
// api/_lib/sniper-autonomy.js (TIER_BOUNDS); this export is the 'standard' row,
// kept as the public constant so existing callers and tests read one source of
// truth rather than a second copy that can drift.
export const BOUNDS = boundsFor('standard');

// Max change a single run may make to each field at the DEFAULT tier. Small steps
// → the loop converges gradually and every move stays observable. Higher tiers
// scale these up (TIER_STEP_SCALE), probation halves them.
export const STEP = {
	take_profit_pct: 15,
	trailing_stop_pct: 5,
	stop_loss_pct: 5,
	max_hold_seconds: 300,
	min_quality_score: 5,
	min_oracle_score: 5,
	per_trade_fraction: 0.2, // ≤20% size change per run
	// Tier-unlocked fields. Only reachable once an arm has earned the field.
	llm_min_confidence: 0.05,
	min_market_cap_usd: 5_000,
	max_market_cap_usd: 25_000,
	initials_out_multiple: 0.5,
	moonbag_min_pct: 5,
	max_creator_launches: 5,
};

// Fields written as whole numbers. Everything else keeps its natural precision
// (llm_min_confidence and initials_out_multiple are fractional by nature).
const INTEGER_FIELDS = new Set([
	'max_hold_seconds', 'per_trade_lamports', 'min_market_cap_usd', 'max_market_cap_usd', 'max_creator_launches',
]);

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const num = (v) => (v == null ? null : Number(v));

/**
 * Oracle-aware entry threshold (Bridge 2). Given an arm's realized win rate
 * bucketed by the Oracle conviction the coin had at entry, find the conviction
 * floor that best separates winners from losers: the threshold T where trades
 * with conviction >= T win meaningfully more than the arm overall, with enough
 * sample above T to trust it. Returns the target floor, or null when the data
 * does not support a move. Pure.
 *
 * @param {Array<{lo:number, closed:number|string, wins:number|string}>} buckets
 * @param {{ minAbove?:number, minLift?:number, minTotal?:number }} [opts]
 */
export function bestOracleThreshold(buckets, { minAbove = 4, minLift = 0.15, minTotal = 6 } = {}) {
	const b = (buckets || [])
		.map((x) => ({ lo: Number(x.lo), closed: Number(x.closed) || 0, wins: Number(x.wins) || 0 }))
		.filter((x) => x.closed > 0)
		.sort((a, z) => a.lo - z.lo);
	if (!b.length) return null;
	const total = b.reduce((s, x) => s + x.closed, 0);
	const totalWins = b.reduce((s, x) => s + x.wins, 0);
	if (total < minTotal) return null;
	const overall = totalWins / total;
	let best = null;
	for (const cand of b) {
		if (cand.lo <= 0) continue; // a zero floor is "no filter", never a proposal
		const above = b.filter((x) => x.lo >= cand.lo);
		const closedAbove = above.reduce((s, x) => s + x.closed, 0);
		const winsAbove = above.reduce((s, x) => s + x.wins, 0);
		if (closedAbove < minAbove || closedAbove === total) continue; // need a real, informative cut
		const rateAbove = winsAbove / closedAbove;
		const lift = rateAbove - overall;
		if (lift >= minLift && (!best || rateAbove > best.rateAbove)) best = { threshold: cand.lo, rateAbove };
	}
	return best ? best.threshold : null;
}

// Move `from` toward `to` but never by more than `step`, then clamp to bounds.
// Returns the bounded target, or null if `from` is already there.
function boundedToward(from, to, step, bounds) {
	const target0 = clamp(to, bounds.min, bounds.max);
	if (from == null) return target0; // unset → set directly (only used where allowed)
	const delta = target0 - from;
	const capped = Math.abs(delta) <= step ? target0 : from + Math.sign(delta) * step;
	return clamp(capped, bounds.min, bounds.max);
}

function share(exitReasons, key, total) {
	if (!total) return 0;
	return (Number(exitReasons?.[key]) || 0) / total;
}

/**
 * @param {object} stats  { closed, wins, winRate(0-100), avgPnlPct, bestPnlPct,
 *                          worstPnlPct, avgHoldSeconds, netPnlLamports,
 *                          exitReasons: {timeout, stop_loss, trailing_stop, take_profit,...} }
 * @param {object} config the current agent_sniper_strategies row
 * @param {{ tier?: string }} [opts] earned-autonomy tier; omitted = 'standard'
 * @returns {{ proposals: Array<{field,from,to,reason}>, sample:number, acted:boolean, notes:string[], tier:string }}
 */
export function proposeAdjustments(stats, config, opts = {}) {
	const proposals = [];
	const claimed = new Set();
	const notes = [];
	const sample = Number(stats?.closed) || 0;
	const mode = (config?.decision_mode || 'rules');

	// Tier decides how far, how fast, and which fields at all.
	const tier = opts.tier || 'standard';
	const bounds = boundsFor(tier);
	const steps = stepsFor(tier, STEP);
	const writable = writableFor(tier);
	const unsetOk = unsetOkFor(tier);
	const earned = atLeast('trusted', tier);

	// A winless arm is not noise. Every pattern rule below waits for MIN_SAMPLE,
	// but an arm that has NEVER won while losing real money is already a pattern:
	// it gets the single de-risking rule (Rule E) and nothing else, so it cannot
	// bleed indefinitely under the radar of the general sample gate.
	const wins = num(stats?.wins) ?? 0;
	const winlessBleeder =
		wins === 0 && sample >= MIN_SAMPLE_WINLESS &&
		(num(stats?.netPnlLamports) ?? 0) < 0 && num(config?.per_trade_lamports) != null;

	if (sample < MIN_SAMPLE && !winlessBleeder) {
		return { proposals, sample, acted: false, tier, notes: [`sample ${sample} < ${MIN_SAMPLE}, no action`] };
	}

	const winRate = num(stats.winRate) ?? 0;
	const avg = num(stats.avgPnlPct) ?? 0;
	const best = num(stats.bestPnlPct) ?? 0;
	const netPnl = num(stats.netPnlLamports) ?? 0;
	const er = stats.exitReasons || {};

	const tp = num(config.take_profit_pct);
	const trail = num(config.trailing_stop_pct);
	const perTrade = num(config.per_trade_lamports);
	const quality = num(config.min_quality_score);
	const oracle = num(config.min_oracle_score);
	const confidence = num(config.llm_min_confidence);
	const mcapMin = num(config.min_market_cap_usd);
	const mcapMax = num(config.max_market_cap_usd);
	const ladder = num(config.initials_out_multiple);
	const creatorCap = num(config.max_creator_launches);

	const propose = (field, to, reason) => {
		if (claimed.has(field)) return;
		if (!writable.has(field)) return;   // the tier has not earned this field
		const b = bounds[field];
		if (!b) return;
		const from = num(config[field]);
		let target;
		if (field === 'per_trade_lamports') {
			target = to; // already computed absolute
			// Never propose a bet the arm's OWN daily budget cannot fund. This
			// optimizer owns per_trade_lamports while the evolution loop owns
			// daily_budget_lamports, and neither used to read the other's knob — so
			// a size could drift above the day's whole budget, after which
			// `spent + size <= budget` failed on every evaluation and the arm went
			// silently dead. The budget is the ceiling; a bet may equal it, never
			// exceed it.
			const dailyBudget = num(config.daily_budget_lamports);
			if (dailyBudget != null && dailyBudget > 0 && target > dailyBudget) target = dailyBudget;
		} else {
			target = boundedToward(from, to, steps[field], b);
		}
		target = clamp(target, b.min, b.max);
		// A non-numeric column value (num() of a bad string is NaN, and NaN != null)
		// would otherwise propagate all the way into an UPDATE. Refuse it here:
		// clamp cannot rescue a NaN and nothing downstream re-checks.
		if (!Number.isFinite(target)) return;
		if (INTEGER_FIELDS.has(field)) target = Math.round(target);
		else target = Number(target.toFixed(2));
		if (from != null && target === from) return; // no-op
		if (from == null && !unsetOk.has(field)) return; // some fields must not be set from unset
		claimed.add(field);
		proposals.push({ field, from, to: target, reason });
	};

	// Winless-arm fast path: below MIN_SAMPLE only this one de-risking move may
	// act; the pattern rules (O/A/B/C and the earned-freedom set) still wait for
	// a real sample.
	if (sample < MIN_SAMPLE && winlessBleeder) {
		propose('per_trade_lamports', Math.round(perTrade * (1 - steps.per_trade_fraction)),
			`Zero wins in ${sample} real trades (net ${(netPnl / 1e9).toFixed(3)} SOL): shrink the bet while the sample grows. Pattern rules stay quiet until ${MIN_SAMPLE} closes.`);
		notes.push('winless_below_min_sample', 'candidate_for_disable');
		return { proposals, sample, acted: proposals.length > 0, tier, notes };
	}

	// Rule O: Oracle-aware entry. If the arm's realized wins concentrate above a
	// conviction floor, tune min_oracle_score toward it. Runs FIRST so this
	// data-driven signal claims the field before Rule B's cruder stop-loss bump.
	// This is what makes the optimizer actually USE the Oracle rather than ignore it.
	const oracleTarget = bestOracleThreshold(stats.oracleBuckets);
	if (oracleTarget != null && (oracle == null || oracleTarget > oracle)) {
		propose('min_oracle_score', oracleTarget,
			`Realized wins concentrate at Oracle conviction >= ${oracleTarget} over ${sample} trades: raise the conviction floor to buy where this arm actually wins.`);
	}

	// Rule A: winners are timing out unrealized (the classic "no take-profit" leak).
	if (share(er, 'timeout', sample) >= 0.4 && avg > 5) {
		if (tp == null) {
			propose('take_profit_pct', Math.round(Math.max(avg * 1.5, best * 0.6)),
				`${Math.round(share(er, 'timeout', sample) * 100)}% of exits were timeouts while avg PnL was +${avg.toFixed(1)}%: winners expire unrealized. Set a take-profit to lock gains.`);
		} else {
			propose('take_profit_pct', Math.round(Math.max(avg * 1.2, BOUNDS.take_profit_pct.min)),
				`Winners still timing out with take-profit at ${tp}%: lower it toward the realized average (+${avg.toFixed(1)}%) so it actually triggers.`);
		}
	}

	// Rule B: losers dominated by stop-loss: entries are low quality. Tighten
	// selection (rules mode) and de-risk size.
	if (share(er, 'stop_loss', sample) >= 0.5 && winRate < 40) {
		if (mode === 'rules') {
			if (quality != null) {
				propose('min_quality_score', quality + STEP.min_quality_score,
					`${Math.round(share(er, 'stop_loss', sample) * 100)}% of exits hit the stop and win rate is ${winRate}%: raise the quality bar to be more selective.`);
			} else if (oracle != null) {
				propose('min_oracle_score', oracle + STEP.min_oracle_score,
					`Stop-loss heavy (${Math.round(share(er, 'stop_loss', sample) * 100)}%) at ${winRate}% win rate: raise the oracle-conviction floor.`);
			}
		}
		if (perTrade != null) {
			propose('per_trade_lamports', Math.round(perTrade * (1 - STEP.per_trade_fraction)),
				`Stop-loss heavy at ${winRate}% win rate: cut position size ${Math.round(STEP.per_trade_fraction * 100)}% to reduce bleed while entries improve.`);
		}
	}

	// Rule C: trailing stop behaviour. One direction fires, chosen by PnL sign.
	if (share(er, 'trailing_stop', sample) >= 0.5) {
		if (avg > 0 && best - avg >= 15 && trail != null) {
			propose('trailing_stop_pct', trail - STEP.trailing_stop_pct,
				`Trailing exits give back a lot (best +${best.toFixed(0)}% vs avg +${avg.toFixed(0)}%): tighten the trailing stop to keep more of each run.`);
		} else if (avg < 0 && trail != null) {
			propose('trailing_stop_pct', trail + STEP.trailing_stop_pct,
				`Trailing stop is shaking positions out at a loss (avg ${avg.toFixed(1)}%): loosen it to survive normal volatility.`);
		}
	}

	// Rule S: size-weighted divergence. `avgPnlPct` is an UNWEIGHTED mean of
	// percentages, but positions across an arm differ in size by up to 50x, so a
	// positive average percent alongside negative net lamports is arithmetically
	// only possible one way: the arm's LARGER bets are its worse ones. Its edge
	// does not scale, so the correct response is to shrink the bet, not to tune an
	// exit percentage. Measured on the live fleet 2026-07-27: trailing-stop exits
	// averaged +6.4% while netting -0.223 SOL, because the average trailing exit
	// was a 0.053 SOL position against a 0.016 SOL fleet average.
	//
	// This runs BEFORE Rule D and claims per_trade_lamports first: an arm losing
	// real money must never be handed a bigger position because its unweighted
	// percentage or win rate looks healthy. That is the vanity metric the fleet's
	// own postmortem named as lesson one.
	const sizeDivergence = netPnl < 0 && avg > 0 && sample >= MIN_SAMPLE && perTrade != null;
	if (sizeDivergence) {
		propose('per_trade_lamports', Math.round(perTrade * (1 - steps.per_trade_fraction)),
			`Average return is +${avg.toFixed(1)}% but the arm is down ${(netPnl / 1e9).toFixed(4)} SOL over ${sample} trades: the bigger bets are the losing ones, so the edge does not scale. Shrink position size rather than tune an exit.`);
		notes.push('size_weighted_divergence');
	}

	// Rule D: proven arm: scale size up, bounded, never past the tier's ceiling.
	// Two ways to qualify. The classic one is a high win rate, which ALSO requires
	// not losing money: a 60%-win-rate arm can still bleed if its losses are its
	// big positions, and rewarding that with more size compounds the bleed. The
	// second exists because win rate is the wrong measure for a momentum arm: one
	// that wins 36% of the time but is net profitable has a real edge and has
	// earned more size. That second path is tier-gated, so only an arm the
	// autonomy engine already judged profitable can take it.
	const provenByWinRate = winRate >= 60 && avg > 10 && netPnl >= 0;
	const provenByProfit = earned && netPnl > 0;
	if ((provenByWinRate || provenByProfit) && sample >= MIN_SAMPLE * 1.5 && perTrade != null) {
		const pct = Math.round(steps.per_trade_fraction * 75);
		propose('per_trade_lamports', Math.round(perTrade * (1 + steps.per_trade_fraction * 0.75)),
			provenByWinRate
				? `Proven arm (${winRate}% win rate, avg +${avg.toFixed(1)}% over ${sample} trades): scale size up ${pct}% within the hard cap.`
				: `Net profitable over ${sample} real trades (${(netPnl / 1e9).toFixed(4)} SOL, avg +${avg.toFixed(1)}%) despite a ${winRate}% win rate: an edge that pays does not need a high hit rate. Scale size up ${pct}% within the tier cap.`);
	}

	// Rule E: chronic loser: throttle size hard (short of auto-disable, which
	// stays a human call). A winless arm qualifies from MIN_SAMPLE up without
	// waiting for the larger sustained-underperformance sample: zero wins IS the
	// evidence, and the move is small, bounded, and reversed by Rule D on a win.
	if (((winRate < 25 && sample >= MIN_SAMPLE * 1.5) || winlessBleeder) && netPnl < 0 && perTrade != null) {
		propose('per_trade_lamports', Math.round(perTrade * (1 - steps.per_trade_fraction)),
			winlessBleeder && sample < MIN_SAMPLE * 1.5
				? `Zero wins in ${sample} real trades (net ${(netPnl / 1e9).toFixed(3)} SOL): throttle size while the record stays winless. Consider disabling this arm.`
				: `Sustained underperformance (${winRate}% win rate, net ${(netPnl / 1e9).toFixed(3)} SOL over ${sample} trades): throttle size. Consider disabling this arm.`);
		notes.push('candidate_for_disable');
	}

	// ── Earned freedom. Everything below hands room BACK to an arm that has proven
	// it makes money, instead of only ever tightening it. All of it is gated on
	// tier (trusted+) and on realized profit, all of it is bounded and reversible,
	// and every field here is one a losing arm cannot reach at all.
	const profitable = earned && netPnl > 0;

	// Rule F: a profitable judge earns a lower bar. An LLM arm in the money is
	// passing on launches it would have won; walk its confidence floor down so it
	// takes more shots. Demotion reverses this automatically on the next run.
	if (profitable && mode === 'llm' && confidence != null) {
		propose('llm_min_confidence', confidence - steps.llm_min_confidence,
			`Profitable judgment (net ${(netPnl / 1e9).toFixed(4)} SOL, avg +${avg.toFixed(1)}% over ${sample} trades): lower the confidence floor from ${confidence} so the model acts on more of what it sees. Widening exploration where the record says the judgment is sound.`);
	}

	// Rule G: a profitable arm earns a wider hunting ground. Widen the market-cap
	// band outward on both sides and, at the top tier, loosen the serial-launcher
	// cap. Only widens a band that exists: an arm with no band is already
	// unrestricted and nothing here would restrict it.
	if (profitable) {
		if (mcapMin != null) {
			propose('min_market_cap_usd', mcapMin - steps.min_market_cap_usd,
				`Profitable over ${sample} trades: lower the entry floor from $${Math.round(mcapMin).toLocaleString('en-US')} to explore earlier launches this arm currently never sees.`);
		}
		if (mcapMax != null) {
			propose('max_market_cap_usd', mcapMax + steps.max_market_cap_usd,
				`Profitable over ${sample} trades: raise the entry ceiling from $${Math.round(mcapMax).toLocaleString('en-US')} to explore larger launches this arm currently never sees.`);
		}
		if (creatorCap != null) {
			propose('max_creator_launches', creatorCap + steps.max_creator_launches,
				`Profitable over ${sample} trades: loosen the serial-launcher cap from ${creatorCap}. A prolific creator is not automatically a bad one, and this arm has earned the right to test that.`);
		}
	}

	// Rule H: a profitable arm whose winners run well past its average exit earns
	// the take-initials ladder: recover the stake at 2x, keep a moon bag, let the
	// rest ride the trailing stop. This is the one exit change that raises the
	// ceiling instead of lowering it, so it is gated on an arm having shown it
	// actually catches runners (best far above avg).
	if (profitable && best - avg >= 25) {
		if (ladder == null) {
			propose('initials_out_multiple', 2,
				`Winners run far past the average exit (best +${best.toFixed(0)}% vs avg +${avg.toFixed(1)}% over ${sample} trades) and the arm is net profitable: turn on the take-initials ladder. Recover the stake at 2x, keep the moon bag, let the remainder ride the trailing stop instead of full-exiting every winner.`);
			notes.push('ladder_enabled');
		} else {
			// Ladder already on and still leaving upside on the table: keep more of
			// each position riding after the initials come out.
			const moonbag = num(config.moonbag_min_pct);
			if (moonbag != null) {
				propose('moonbag_min_pct', moonbag + steps.moonbag_min_pct,
					`Ladder is on and winners still run well past the average exit (best +${best.toFixed(0)}% vs avg +${avg.toFixed(1)}%): raise the moon-bag floor from ${moonbag}% so more of each winner keeps riding after the stake is recovered.`);
			}
		}
	}

	return { proposals, sample, acted: proposals.length > 0, notes, tier };
}
