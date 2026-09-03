/**
 * Leader track records — REAL, on-chain-derived stats only.
 *
 * The trust surface of copy-trading: before you let your agent mirror a leader,
 * you see that leader's honest numbers — realized P&L, win rate, drawdown,
 * volume — every one computed from real persisted fills, never inflated, never
 * backfilled, losers included.
 *
 * Two real sources, both confirmed chain data:
 *   • agent_sniper_positions (closed) — entry/exit lamports + realized P&L per
 *     round-trip. This is where win rate / P&L / drawdown come from.
 *   • agent_custody_events (category 'trade', confirmed) — every discretionary
 *     buy/sell the leader signed, for trade count + SOL/USD volume.
 *
 * A leader with zero history returns total === 0 (an honest "no track record
 * yet"), never a fabricated number.
 */

import { sql } from './db.js';

const lamToSol = (l) => (l == null ? 0 : Number(BigInt(l)) / 1e9);

/**
 * Compute a leader agent's real track record on a network.
 * @returns {Promise<object>} honest summary (all numbers from real fills).
 */
export async function leaderTrackRecord(agentId, network = 'mainnet') {
	const [closed, activity, followers] = await Promise.all([
		sql`
			select realized_pnl_lamports, realized_pnl_pct, entry_quote_lamports,
			       exit_quote_lamports, closed_at
			from agent_sniper_positions
			where agent_id = ${agentId} and network = ${network} and status = 'closed'
			order by closed_at asc
		`.catch(() => []),
		sql`
			select
				count(*)::int as trades,
				count(*) filter (where status = 'confirmed')::int as confirmed,
				coalesce(sum(amount_lamports) filter (where asset = 'SOL'), 0)::text as buy_lamports,
				coalesce(sum(usd) filter (where usd is not null), 0)::float8 as usd_volume,
				max(created_at) as last_trade_at
			from agent_custody_events
			where agent_id = ${agentId} and network = ${network}
			  and category = 'trade' and status in ('confirmed', 'ok')
		`.catch(() => [{}]),
		// Self-follows are excluded: an owner pointing their own agents at this one
		// is legitimate, but it must not inflate the public follower count that the
		// leaderboard score and the Trader Card both read as social proof.
		sql`
			select count(*)::int as total,
			       count(*) filter (where f.enabled = true)::int as active
			from agent_mirror_follows f
			join agent_identities la on la.id = f.leader_agent_id and la.user_id <> f.owner_user_id
			where f.leader_agent_id = ${agentId} and f.network = ${network}
		`.catch(() => [{ total: 0, active: 0 }]),
	]);

	// Realized stats from closed round-trips (the honest P&L surface).
	let wins = 0;
	let losses = 0;
	let pnlSol = 0;
	let grossEntrySol = 0;
	let best = null;
	let worst = null;
	// Max drawdown over the cumulative realized-P&L equity curve (peak-to-trough).
	let equity = 0;
	let peak = 0;
	let maxDrawdownSol = 0;
	for (const p of closed) {
		const pnl = lamToSol(p.realized_pnl_lamports);
		pnlSol += pnl;
		grossEntrySol += lamToSol(p.entry_quote_lamports);
		if (pnl > 0) wins++; else if (pnl < 0) losses++;
		const pct = p.realized_pnl_pct != null ? Number(p.realized_pnl_pct) : null;
		if (pct != null) {
			if (best == null || pct > best) best = pct;
			if (worst == null || pct < worst) worst = pct;
		}
		equity += pnl;
		if (equity > peak) peak = equity;
		const dd = peak - equity;
		if (dd > maxDrawdownSol) maxDrawdownSol = dd;
	}
	const settled = wins + losses;
	const a = activity[0] || {};
	const f = followers[0] || { total: 0, active: 0 };

	const tradeCount = Number(a.trades || 0);
	const buyVolumeSol = lamToSol(a.buy_lamports || 0);
	const roiPct = grossEntrySol > 0 ? (pnlSol / grossEntrySol) * 100 : null;

	return {
		network,
		// "Does this leader have anything to show?" — total spans both real sources.
		total: closed.length + tradeCount,
		closed_positions: closed.length,
		discretionary_trades: tradeCount,
		realized: {
			pnl_sol: round4(pnlSol),
			roi_pct: roiPct == null ? null : round2(roiPct),
			win_rate: settled > 0 ? round2((wins / settled) * 100) : null,
			wins,
			losses,
			settled,
			best_pct: best == null ? null : round2(best),
			worst_pct: worst == null ? null : round2(worst),
			max_drawdown_sol: round4(maxDrawdownSol),
		},
		volume: {
			buy_sol: round4(buyVolumeSol),
			usd: a.usd_volume != null ? round2(Number(a.usd_volume)) : 0,
		},
		followers: { total: Number(f.total || 0), active: Number(f.active || 0) },
		last_trade_at: a.last_trade_at || (closed.length ? closed[closed.length - 1].closed_at : null),
	};
}

/** Batch follower/following counts for a set of agents (for cards/leaderboards). */
export async function followCounts(agentIds, network = 'mainnet') {
	if (!Array.isArray(agentIds) || agentIds.length === 0) return new Map();
	const rows = await sql`
		select f.leader_agent_id as id, count(*)::int as followers,
		       count(*) filter (where f.enabled = true)::int as active_followers
		from agent_mirror_follows f
		join agent_identities la on la.id = f.leader_agent_id and la.user_id <> f.owner_user_id
		where f.leader_agent_id = any(${agentIds}) and f.network = ${network}
		group by f.leader_agent_id
	`.catch(() => []);
	const m = new Map();
	for (const r of rows) m.set(r.id, { followers: Number(r.followers), active: Number(r.active_followers) });
	return m;
}

function round2(x) { return Math.round(x * 100) / 100; }
function round4(x) { return Math.round(x * 1e4) / 1e4; }
