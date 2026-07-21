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
// Design: rules are ordered by priority; the first rule to claim a field wins,
// so proposals never conflict. Each rule cites the evidence that triggered it.

// Minimum closed real trades before the optimizer will act on an arm. Below
// this the sample is noise and every rule no-ops.
export const MIN_SAMPLE = 8;

// Hard ranges per field. A proposal is clamped into [min,max]; null means the
// field may be left unset (only take_profit_pct supports "unset → set").
export const BOUNDS = {
	take_profit_pct: { min: 15, max: 300 },
	trailing_stop_pct: { min: 8, max: 50 },
	stop_loss_pct: { min: 10, max: 50 },
	max_hold_seconds: { min: 120, max: 7200 },
	min_quality_score: { min: 0, max: 100 },
	min_oracle_score: { min: 0, max: 100 },
	// per_trade_lamports floor keeps a de-risked arm from rounding to dust; the
	// ceiling is a hard absolute cap (0.2 SOL) the optimizer will never exceed
	// regardless of how well an arm is doing. Real scaling past this is a human
	// budget decision, by design.
	per_trade_lamports: { min: 2_000_000, max: 200_000_000 },
};

// Max change a single run may make to each field. Small steps → the loop
// converges gradually and every move stays observable.
export const STEP = {
	take_profit_pct: 15,
	trailing_stop_pct: 5,
	stop_loss_pct: 5,
	max_hold_seconds: 300,
	min_quality_score: 5,
	min_oracle_score: 5,
	per_trade_fraction: 0.2, // ≤20% size change per run
};

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const num = (v) => (v == null ? null : Number(v));

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
 * @returns {{ proposals: Array<{field,from,to,reason}>, sample:number, acted:boolean, notes:string[] }}
 */
export function proposeAdjustments(stats, config) {
	const proposals = [];
	const claimed = new Set();
	const notes = [];
	const sample = Number(stats?.closed) || 0;
	const mode = (config?.decision_mode || 'rules');

	if (sample < MIN_SAMPLE) {
		return { proposals, sample, acted: false, notes: [`sample ${sample} < ${MIN_SAMPLE}, no action`] };
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

	const propose = (field, to, reason) => {
		if (claimed.has(field)) return;
		const b = BOUNDS[field];
		if (!b) return;
		const from = num(config[field]);
		let target;
		if (field === 'per_trade_lamports') {
			target = to; // already computed absolute
		} else {
			const step = STEP[field];
			target = boundedToward(from, to, step, b);
		}
		target = clamp(target, b.min, b.max);
		if (field === 'max_hold_seconds' || field === 'per_trade_lamports') target = Math.round(target);
		if (from != null && target === from) return; // no-op
		if (from == null && field !== 'take_profit_pct') return; // only TP supports unset→set
		claimed.add(field);
		proposals.push({ field, from, to: target, reason });
	};

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

	// Rule D: proven arm: scale size up, bounded, never past the hard ceiling.
	if (winRate >= 60 && avg > 10 && sample >= MIN_SAMPLE * 1.5 && perTrade != null) {
		propose('per_trade_lamports', Math.round(perTrade * (1 + STEP.per_trade_fraction * 0.75)),
			`Proven arm (${winRate}% win rate, avg +${avg.toFixed(1)}% over ${sample} trades): scale size up ${Math.round(STEP.per_trade_fraction * 75)}% within the hard cap.`);
	}

	// Rule E: chronic loser: throttle size hard (short of auto-disable, which
	// stays a human call).
	if (winRate < 25 && netPnl < 0 && sample >= MIN_SAMPLE * 1.5 && perTrade != null) {
		propose('per_trade_lamports', Math.round(perTrade * (1 - STEP.per_trade_fraction)),
			`Sustained underperformance (${winRate}% win rate, net ${(netPnl / 1e9).toFixed(3)} SOL over ${sample} trades): throttle size. Consider disabling this arm.`);
		notes.push('candidate_for_disable');
	}

	return { proposals, sample, acted: proposals.length > 0, notes };
}
