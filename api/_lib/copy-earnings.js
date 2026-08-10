/**
 * Copy-trading performance-fee accounting.
 *
 * The fee a leader earns is charged on a COPIER'S REALIZED PROFIT ONLY, with a
 * high-water mark so the same gains are never billed twice. This module holds the
 * pure HWM math (tested) and the real attribution over the copier's acted copies.
 *
 * Profit basis (transparent, stated up-front to the copier when they subscribe):
 * for each leader position the copier ACTED on (entered a copy of) that has since
 * CLOSED, the copy's realized profit is the copier's committed size scaled by the
 * leader's realized return — planned_sol × (leader_realized_pnl_pct / 100). It is
 * the copier's copy, at the copier's size, at the leader's return. Losers count
 * (they lower the cumulative), so the HWM only ever bills genuinely new profit.
 *
 * The fee itself settles in $THREE via the shared token rails under the
 * `copy_performance_fee` split policy (leader 80% / treasury 15% / holders 5%).
 */

import { sql } from './db.js';

const round6 = (x) => Math.round(x * 1e6) / 1e6;
const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * High-water-mark performance fee. PURE.
 *
 * @param {object} p
 * @param {number} p.realizedProfitSol  cumulative realized copy profit to date (signed SOL).
 * @param {number} p.highWaterMarkSol   the cumulative profit peak already billed.
 * @param {number} p.feeBps             leader's fee in basis points (e.g. 1000 = 10%).
 * @returns {{ fee_sol:number, billable_profit_sol:number, new_high_water_mark_sol:number }}
 */
export function computePerfFee({ realizedProfitSol, highWaterMarkSol = 0, feeBps = 1000 }) {
	const cumulative = n(realizedProfitSol);
	const hwm = n(highWaterMarkSol);
	const billable = Math.max(0, cumulative - hwm);
	const fee = billable * (n(feeBps) / 10_000);
	return {
		fee_sol: round6(fee),
		billable_profit_sol: round6(billable),
		// HWM only ratchets up when there's new billable profit; a drawdown never
		// lowers it (otherwise a recovery would be billed twice).
		new_high_water_mark_sol: round6(Math.max(hwm, cumulative)),
	};
}

/**
 * Cumulative realized copy profit for one subscription, from the copier's acted
 * buys whose leader position has closed. Returns { profit_sol, closed_copies }.
 */
export async function cumulativeCopyProfit(subscriptionId) {
	const [row] = await sql`
		select
			coalesce(sum(e.planned_sol * (p.realized_pnl_pct / 100.0)), 0) as profit_sol,
			count(*) as closed_copies
		from copy_executions e
		join agent_sniper_positions p on p.id = e.leader_position_id
		where e.subscription_id = ${subscriptionId}
		  and e.direction = 'buy' and e.status = 'acted'
		  and p.status = 'closed' and p.realized_pnl_pct is not null
	`;
	return { profit_sol: round6(n(row?.profit_sol)), closed_copies: Number(row?.closed_copies) || 0 };
}

/**
 * What a single subscription currently OWES (accrued, uncharged) — the perf fee
 * on cumulative realized profit above the subscription's high-water mark.
 */
export async function subscriptionOwed(sub) {
	const { profit_sol, closed_copies } = await cumulativeCopyProfit(sub.id);
	const fee = computePerfFee({
		realizedProfitSol: profit_sol,
		highWaterMarkSol: n(sub.high_water_mark_sol),
		feeBps: n(sub.perf_fee_bps) || 1000,
	});
	return {
		subscription_id: sub.id,
		cumulative_profit_sol: profit_sol,
		closed_copies,
		...fee,
	};
}

/**
 * A leader's accrued copy earnings, aggregated across their active copiers. Public
 * aggregate (no per-copier identity) — the social-proof "this trader has earned X
 * for being copied" figure. Best-effort: degrades to zeros if copy tables are
 * absent (not yet migrated).
 *
 * @returns {Promise<{ copiers:number, accrued_fee_sol:number, copier_profit_sol:number }>}
 */
export async function accruedLeaderEarnings(leaderAgentId, network) {
	let subs;
	try {
		subs = await sql`
			select id, high_water_mark_sol, perf_fee_bps
			from copy_subscriptions
			where leader_agent_id = ${leaderAgentId} and network = ${network} and status = 'active'
		`;
	} catch {
		return { copiers: 0, accrued_fee_sol: 0, copier_profit_sol: 0 };
	}
	let accruedFee = 0, profit = 0;
	for (const sub of subs) {
		const owed = await subscriptionOwed(sub);
		accruedFee += owed.fee_sol;
		profit += Math.max(0, owed.cumulative_profit_sol);
	}
	return {
		copiers: subs.length,
		accrued_fee_sol: round6(accruedFee),
		copier_profit_sol: round6(profit),
	};
}
