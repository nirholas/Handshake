/**
 * Where the platform's agent-wallet funding levels come from — one definition,
 * read by both the cron that PUTS SOL IN and the cron that TAKES SOL OUT.
 *
 * These two live in different services (the sniper worker's auto-funder tops an
 * arm up from the launcher master; the economy's idle-capital reclaim sweeps
 * agent wallets back to the economy master) and for a while neither knew the
 * other's numbers. The result was a pure oscillation: the funder refilled an
 * arm to its target, the reclaim swept it back below that target minutes later,
 * the funder refilled it again. In one observed 15-minute window 0.24 SOL made
 * that round trip six times across two arms, every leg paying network fees, and
 * the arms never held a balance long enough to place a trade. It only stopped
 * when the funding master ran dry.
 *
 * The invariant that prevents it, and the reason this module exists:
 *
 *   **A reclaim floor must never sit below the funding target of the same
 *   wallet.** If it does, the two crons chase each other forever.
 *
 * This mirrors the guard the engine sweep already has (`reclaimableSol` never
 * leaves an engine under the topup's `minSol`) — the agent-wallet path simply
 * never got it, because the funder and the reclaim were written a month apart in
 * different subsystems.
 */

import { MIN_OPERATIONAL_WALLET_SOL } from './agent-trade-guards.js';

function num(name, def) {
	const raw = process.env[name];
	if (raw == null || raw === '') return def;
	const n = Number(raw);
	return Number.isFinite(n) ? n : def;
}

/**
 * Balance under which an opted-in agent wallet gets topped up.
 * Env: SNIPER_AUTO_FUND_MIN_SOL.
 */
export function autoFundMinSol() {
	return Math.max(0, num('SNIPER_AUTO_FUND_MIN_SOL', 0.02));
}

/**
 * Balance an opted-in agent wallet is topped up TO. Nothing that removes SOL
 * from such a wallet may leave it below this, or the top-up fires again.
 * Env: SNIPER_AUTO_FUND_TARGET_SOL.
 */
export function autoFundTargetSol() {
	return Math.max(autoFundMinSol(), num('SNIPER_AUTO_FUND_TARGET_SOL', 0.05));
}

/**
 * Balance at which THIS agent can no longer place its next trade: everything one
 * entry costs besides the buy itself (`MIN_OPERATIONAL_WALLET_SOL` — ATA rent,
 * fee and tip headroom, and the firewall's simulated round-trip) plus the arm's
 * own configured size. Never below the flat `SNIPER_AUTO_FUND_MIN_SOL`.
 *
 * A flat trigger was wrong in one direction only, and quietly: an arm sized at
 * 0.13 SOL/trade sitting on 0.035 SOL is above the flat 0.02 floor, so the funder
 * called it healthy and moved on, while every entry it attempted got clamped down
 * to whatever was left. Size-aware, it gets refilled to a size it can actually
 * trade. Pure.
 *
 * @param {{perTradeSol?: number}} agent
 */
export function fundTriggerSol(agent = {}) {
	const perTrade = Number(agent.perTradeSol);
	const sized = Number.isFinite(perTrade) && perTrade > 0
		? MIN_OPERATIONAL_WALLET_SOL + perTrade
		: 0;
	return Math.max(autoFundMinSol(), sized);
}

/**
 * Balance this agent is refilled TO. Keeps the same hysteresis band above the
 * trigger that the flat pair had (default 0.03 SOL), so a bigger arm does not get
 * refilled more often — just to a level it can trade from. Pure.
 *
 * @param {{perTradeSol?: number}} agent
 */
export function fundTargetSol(agent = {}) {
	const band = Math.max(0, autoFundTargetSol() - autoFundMinSol());
	return round(fundTriggerSol(agent) + band);
}

/**
 * The anti-oscillation floor for one agent wallet: the smallest balance a
 * reclaim may leave behind without handing the funder a reason to refill.
 *
 * Only applies to wallets the funder actually manages — an agent that never
 * opted into auto-funding (`auto_fund_enabled = false`) is nobody's refill
 * target, so sweeping it lower cannot oscillate. Pure.
 *
 * @param {{autoFundEnabled?: boolean, perTradeSol?: number}} agent
 * @returns {number} SOL that must remain, 0 when the funder would not refill it
 */
export function antiOscillationFloorSol(agent = {}) {
	return agent.autoFundEnabled === true ? fundTargetSol(agent) : 0;
}

function round(n) {
	return Math.round(n * 1e9) / 1e9;
}
