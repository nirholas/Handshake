// agent-sniper — strategy + position reads (cached strategy list, position counts).

import { sql } from '../../api/_lib/db.js';
import { log } from './log.js';

let _strategies = [];
let _loadedAt = 0;

function envPositiveNum(name) {
	const raw = process.env[name];
	if (raw == null || raw === '') return null;
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * The daily realized-loss cap (lamports) that actually applies to a strategy,
 * combining the fleet-wide env floor with any per-strategy column by taking the
 * TIGHTER (smaller) of the two — the same "safety band" shape as the market-cap
 * floor/ceil. `SNIPER_MAX_DAILY_LOSS_SOL` set on the worker protects EVERY agent
 * at once (including ones whose strategy predates the per-strategy column), which
 * is the immediately-deployable lever. Returns null when neither is set (no cap).
 *
 * @param {{ daily_loss_limit_lamports?: string|number|null }} strat
 * @returns {bigint|null}
 */
export function effectiveDailyLossLimitLamports(strat) {
	const envSol = envPositiveNum('SNIPER_MAX_DAILY_LOSS_SOL');
	const envLamports = envSol == null ? null : BigInt(Math.round(envSol * 1e9));
	const raw = strat?.daily_loss_limit_lamports;
	const stratLamports = raw == null || raw === '' ? null : BigInt(raw);
	if (envLamports == null) return stratLamports;
	if (stratLamports == null) return envLamports;
	return envLamports < stratLamports ? envLamports : stratLamports;
}

/**
 * Active strategies for the worker's network: enabled, not killed, with a real
 * budget and a positive stop-loss. The stop-loss filter is the runtime half of
 * the mandatory-SL guarantee (the DB constraint is the other half) — a strategy
 * that somehow has a null/zero SL is dropped here rather than trusted.
 */
export async function refreshStrategies(network, maxAgeMs, agentIds = null) {
	if (Date.now() - _loadedAt < maxAgeMs && _strategies.length) return _strategies;
	// Optional agent-scoping: when an allowlist is supplied the worker acts ONLY on
	// those agents' strategies. This is the guard that lets a worker run against the
	// shared prod DB without touching every other armed agent's strategy — the
	// entanglement that otherwise makes an experiment spend on, and trade for, coins
	// it never provisioned.
	const scope = Array.isArray(agentIds) && agentIds.length ? sql`AND agent_id = ANY(${agentIds})` : sql``;
	const rows = await sql`
		SELECT * FROM agent_sniper_strategies
		WHERE network = ${network}
		  AND enabled = true
		  AND kill_switch = false
		  AND daily_budget_lamports > 0
		  AND per_trade_lamports > 0
		  AND stop_loss_pct > 0
		  ${scope}
	`;
	_strategies = rows;
	_loadedAt = Date.now();
	return _strategies;
}

export function cachedStrategies() {
	return _strategies;
}

/** Count an agent's positions that still hold (or are mid-open) on this network. */
export async function countOpenPositions(agentId, network) {
	const [r] = await sql`
		SELECT count(*)::int AS n FROM agent_sniper_positions
		WHERE agent_id = ${agentId} AND network = ${network}
		  AND status IN ('opening','open','closing')
	`;
	return r?.n ?? 0;
}

/** Lamports committed by an agent today (UTC) — the daily-budget denominator. */
export async function getDailySpend(agentId, network) {
	const [r] = await sql`
		SELECT coalesce(sum(entry_quote_lamports), 0)::text AS spent
		FROM agent_sniper_positions
		WHERE agent_id = ${agentId} AND network = ${network}
		  AND opened_at >= date_trunc('day', now())
		  AND status <> 'failed'
	`;
	return BigInt(r?.spent ?? '0');
}

/**
 * Net realized P&L (lamports, SIGNED) for an agent over the trailing window —
 * the denominator of the realized-loss circuit breaker. Negative = the agent is
 * net down. Only positions the agent has actually exited count (realized, not
 * mark-to-market), matching how the daily budget counts only committed spend.
 *
 * @param {string} agentId
 * @param {string} network
 * @param {number} sinceHours  trailing window (default 24h)
 * @returns {Promise<bigint>} signed net realized lamports
 */
export async function getRealizedNetLamports(agentId, network, sinceHours = 24) {
	const [r] = await sql`
		SELECT coalesce(sum(realized_pnl_lamports), 0)::text AS net
		FROM agent_sniper_positions
		WHERE agent_id = ${agentId} AND network = ${network}
		  AND realized_pnl_lamports IS NOT NULL
		  AND coalesce(closed_at, opened_at) >= now() - (${sinceHours} || ' hours')::interval
	`;
	return BigInt(r?.net ?? '0');
}

// A sell marks its position 'closing' before broadcasting and clears the mark
// when it settles, so 'closing' is a lock held for seconds. A row still holding
// it much later can only be an abandoned attempt (worker restart or crash
// mid-sell). Because 'closing' rows are invisible to the sweep below but still
// counted by countOpenPositions(), an abandoned one silently costs its arm a
// concurrency slot forever — one sat that way for 34 hours in production.
const CLOSING_LOCK_STALE_MS = 10 * 60 * 1000;

/**
 * Open positions across all agents — the position-loop work set.
 *
 * Graduated positions (error LIKE 'graduated%') are INCLUDED: the sweep
 * re-quotes them off the AMM pool and exits them there, so they no longer park
 * indefinitely. The sweep reads `error` to pick the venue (AMM vs curve).
 *
 * Abandoned 'closing' locks are released back to 'open' first (see above), so a
 * crash mid-sell costs one sweep of delay instead of the slot. This is safe
 * under the worker's single-instance assumption: a genuinely in-flight sell
 * finishes in seconds, far inside the stale window.
 */
export async function getOpenPositions(network) {
	await sql`
		UPDATE agent_sniper_positions
		SET status = 'open'
		WHERE network = ${network}
		  AND status = 'closing'
		  AND coalesce(last_quoted_at, opened_at) < now() - (${CLOSING_LOCK_STALE_MS} || ' milliseconds')::interval
	`;
	return sql`
		SELECT p.*, s.take_profit_pct, s.stop_loss_pct, s.trailing_stop_pct,
		       s.max_hold_seconds, s.slippage_bps, s.user_id AS strat_user_id,
		       s.kill_switch, s.telegram_chat_id,
		       -- Exit-ladder + moon-bag policy. These live on the STRATEGY row, and
		       -- decideLadderedExit reads them off the position object it is handed.
		       -- Omitting them here silently disabled the take-initials ladder for
		       -- every position ever opened: pos.initials_out_multiple came back
		       -- undefined, ladderMultiple() read that as "ladder off", and the loop
		       -- fell through to a classic full exit no matter what the strategy said.
		       s.initials_out_multiple, s.moonbag_min_pct, s.moonbag_always
		FROM agent_sniper_positions p
		JOIN agent_sniper_strategies s ON s.id = p.strategy_id
		WHERE p.network = ${network}
		  AND p.status = 'open'
		ORDER BY p.opened_at ASC
		LIMIT 200
	`;
}

export function logStrategyLoad(network) {
	log.info('strategies refreshed', { network, count: _strategies.length });
}
