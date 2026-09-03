/**
 * Copy-trading anti-gaming layer — who may be copied, and when copying stops.
 *
 * Copy-trading dies the moment a track record can be faked or a follower can be
 * strapped to a runaway leader. Three defenses live here, all of them enforced
 * before money is committed and all of them derived from real, closed, on-chain
 * round-trips (agent_sniper_positions) — never from a self-reported number:
 *
 *   1. SELF-COPY (wash trading). A user subscribing to an agent they own pays a
 *      performance fee to themselves, inflates that leader's public copier count,
 *      and inflates the "earned X for being copied" social-proof figure. Blocked
 *      at subscribe time and skipped again in the fanout, so a row that predates
 *      this rule cannot keep firing.
 *   2. SYBIL BAR on copyable status. A brand-new agent with no history could be
 *      followed the minute it was created. A leader now needs a real record —
 *      closed round-trips, elapsed time, and capital actually deployed — before
 *      anyone can attach money to it, so dust-trading a curve into existence
 *      buys nothing.
 *   3. DRAWDOWN CIRCUIT BREAKER. A copier sets the peak-to-trough loss they are
 *      willing to ride. When the leader's realized equity curve breaches it the
 *      subscription auto-pauses with a recorded reason, instead of mirroring a
 *      leader into the ground. The copier resumes it deliberately or not at all.
 *
 * Drawdown is expressed as a share of capital actually deployed
 * (max peak-to-trough loss / gross entry), the same definition
 * api/_lib/meta-allocator.js ranks on and api/_lib/mirror-stats.js reports, so
 * the number a copier sets a breaker against is the number on the Trader Card.
 */

import { sql } from './db.js';

const LAMPORTS = 1e9;
const lamToSol = (l) => (l == null ? 0 : Number(BigInt(Math.trunc(Number(l)))) / LAMPORTS);
const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const round2 = (x) => Math.round(x * 100) / 100;
const round4 = (x) => Math.round(x * 1e4) / 1e4;

/**
 * Machine reason recorded on copy_subscriptions.paused_reason when the drawdown
 * breaker trips. The resume path in api/copy/subscriptions.js keys off it to
 * refuse a resume that would just re-pause on the next tick.
 */
export const BREAKER_REASON = 'leader_drawdown_breach';

/**
 * The bar an agent must clear before a copier may attach money to it.
 *
 * Deliberately modest: this is a floor against a zero-history sybil, not a
 * curation filter. A real trader clears it inside a normal week of trading.
 * Every threshold is measured on CLOSED round-trips, so open positions and
 * paper mode contribute nothing.
 */
export const LEADER_ELIGIBILITY = {
	/** Closed round-trips (a buy AND its exit) on the network being copied. */
	minSettled: 5,
	/** Hours between the leader's first and most recent close. Blocks a burst of dust trades minted in one minute. */
	minSpanHours: 24,
	/** Gross SOL actually deployed across those closes. Blocks a curve built out of 0.0001 SOL trades. */
	minDeployedSol: 0.1,
};

/** Human labels for each unmet criterion, for the UI and the API error body. */
const CRITERION_LABELS = {
	settled: (need, have) => `${have} of ${need} closed round-trips`,
	span_hours: (need, have) => `${have}h of ${need}h of trading history`,
	deployed_sol: (need, have) => `${have} of ${need} SOL deployed`,
};

/**
 * Decide whether a leader's record clears the copyable bar. PURE.
 *
 * @param {object} record  { settled, span_hours, deployed_sol } — real closed-trade stats.
 * @param {object} [bar]   override thresholds (tests, future per-tier bars).
 * @returns {{ eligible:boolean, unmet:Array<{criterion:string,need:number,have:number,label:string}>, met:object }}
 */
export function evaluateLeaderEligibility(record = {}, bar = LEADER_ELIGIBILITY) {
	const have = {
		settled: Math.floor(n(record.settled)),
		span_hours: round2(n(record.span_hours)),
		deployed_sol: round4(n(record.deployed_sol)),
	};
	const need = {
		settled: bar.minSettled,
		span_hours: bar.minSpanHours,
		deployed_sol: bar.minDeployedSol,
	};

	const unmet = [];
	for (const criterion of ['settled', 'span_hours', 'deployed_sol']) {
		if (have[criterion] < need[criterion]) {
			unmet.push({
				criterion,
				need: need[criterion],
				have: have[criterion],
				label: CRITERION_LABELS[criterion](need[criterion], have[criterion]),
			});
		}
	}
	return { eligible: unmet.length === 0, unmet, met: have };
}

/**
 * Decide whether a leader's realized drawdown has breached a copier's tolerance. PURE.
 *
 * A null tolerance means the copier opted out of the breaker; a null drawdown
 * means the leader has no measurable curve yet (no deployed capital), and an
 * unmeasurable leader is never auto-paused — the eligibility bar is what keeps
 * a history-less leader from being copied in the first place.
 *
 * @returns {{ breached:boolean, drawdown_pct:number|null, limit_pct:number|null, detail?:string }}
 */
export function evaluateDrawdownBreaker(sub = {}, leaderDrawdownPct = null) {
	const limit = sub.max_drawdown_pct == null ? null : n(sub.max_drawdown_pct);
	if (limit == null || limit <= 0) return { breached: false, drawdown_pct: leaderDrawdownPct, limit_pct: null };
	if (leaderDrawdownPct == null) return { breached: false, drawdown_pct: null, limit_pct: limit };

	const dd = n(leaderDrawdownPct);
	if (dd < limit) return { breached: false, drawdown_pct: round2(dd), limit_pct: limit };
	return {
		breached: true,
		drawdown_pct: round2(dd),
		limit_pct: limit,
		detail: `Leader drawdown ${round2(dd)}% reached your ${limit}% limit — copying paused.`,
	};
}

/**
 * Real closed-trade profile for one leader on one network: the numbers both the
 * eligibility bar and the drawdown breaker are judged on.
 *
 * Returns zeros (never nulls dressed as numbers) for a leader with no closes, and
 * `max_drawdown_pct: null` when no capital was deployed, because a drawdown share
 * of zero deployed capital is undefined rather than 0%.
 */
export async function leaderCopyProfile(agentId, network = 'mainnet') {
	const rows = await sql`
		select realized_pnl_lamports, entry_quote_lamports, closed_at
		from agent_sniper_positions
		where agent_id = ${agentId} and network = ${network}
		  and status = 'closed' and closed_at is not null
		order by closed_at asc
	`.catch(() => []);

	return summarizeCopyProfile(rows);
}

/**
 * Fold closed round-trips into the copy profile. PURE — exported so the equity
 * curve walk is testable without a database.
 *
 * @param {Array<{realized_pnl_lamports:*, entry_quote_lamports:*, closed_at:*}>} rows
 *        closed round-trips, oldest first.
 */
export function summarizeCopyProfile(rows = []) {
	let equity = 0;
	let peak = 0;
	let maxDrawdownSol = 0;
	let deployedSol = 0;
	let first = null;
	let last = null;

	for (const r of rows) {
		deployedSol += lamToSol(r.entry_quote_lamports);
		equity += lamToSol(r.realized_pnl_lamports);
		if (equity > peak) peak = equity;
		const dd = peak - equity;
		if (dd > maxDrawdownSol) maxDrawdownSol = dd;

		const at = r.closed_at ? new Date(r.closed_at).getTime() : NaN;
		if (Number.isFinite(at)) {
			if (first == null || at < first) first = at;
			if (last == null || at > last) last = at;
		}
	}

	const spanHours = first != null && last != null ? (last - first) / 3_600_000 : 0;
	const maxDrawdownPct = deployedSol > 0 ? clamp((maxDrawdownSol / deployedSol) * 100, 0, 100) : null;

	return {
		settled: rows.length,
		deployed_sol: round4(deployedSol),
		span_hours: round2(spanHours),
		realized_pnl_sol: round4(equity),
		max_drawdown_sol: round4(maxDrawdownSol),
		max_drawdown_pct: maxDrawdownPct == null ? null : round2(maxDrawdownPct),
		first_closed_at: first == null ? null : new Date(first).toISOString(),
		last_closed_at: last == null ? null : new Date(last).toISOString(),
	};
}

/**
 * Batch the drawdown percentage for a set of leaders in one query — the fanout
 * cron checks every leader it is about to mirror, and a leader with a thousand
 * copiers must not cost a thousand round-trips.
 *
 * @returns {Promise<Map<string, number|null>>} agent id → drawdown %, or null when unmeasurable.
 */
export async function leaderDrawdownPcts(agentIds, network = 'mainnet') {
	const out = new Map();
	if (!Array.isArray(agentIds) || agentIds.length === 0) return out;

	const rows = await sql`
		with closed as (
			select agent_id, closed_at, entry_quote_lamports,
			       sum(realized_pnl_lamports) over (
			           partition by agent_id order by closed_at
			           rows between unbounded preceding and current row) as cum_pnl
			from agent_sniper_positions
			where agent_id = any(${agentIds}) and network = ${network}
			  and status = 'closed' and closed_at is not null
		),
		curve as (
			select agent_id, cum_pnl, entry_quote_lamports,
			       max(cum_pnl) over (
			           partition by agent_id order by closed_at
			           rows between unbounded preceding and current row) as peak
			from closed
		)
		select agent_id,
		       max(peak - cum_pnl)::text as max_dd_lamports,
		       coalesce(sum(entry_quote_lamports), 0)::text as entry_lamports
		from curve group by agent_id
	`.catch(() => []);

	for (const r of rows) {
		const deployed = lamToSol(r.entry_lamports);
		const dd = lamToSol(r.max_dd_lamports);
		out.set(r.agent_id, deployed > 0 ? round2(clamp((dd / deployed) * 100, 0, 100)) : null);
	}
	return out;
}
