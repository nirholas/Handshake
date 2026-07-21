// agent-sniper — graduation_ride entry (the BOOST-window arm).
//
// pump.fun BOOST mode (live 2026-07-21): every non-Mayhem coin that migrates
// gets ~17.6 SOL of dead-liquidity buybacks TWAP'd over the 5 minutes after
// migration, with the bought tokens burned. That is a guaranteed, publicly-known
// buyer for exactly 5 minutes. This trigger trades it: buy on the pump AMM the
// moment the migration lands, ride the TWAP, and let the strategy's timed exit
// (max_hold_seconds, set inside the window) sell into that buy pressure.
//
// Entry flow (driven by the PumpPortal migration event in index.js):
//   1. gate the event per-strategy (SOL pair only, freshness cap) — pure, tested
//   2. wait for the new AMM pool to be readable (migration tx just landed)
//   3. executeBuy with venue:'amm' — every chokepoint guard still applies
//      (Mayhem gate, firewall, budgets, concurrency, headroom, spend policy).
//      Mayhem coins never get BOOST, so the existing exclusion is also the
//      strategy-correct filter here.
//
// Exits are DELIBERATELY not special-cased: the pure exit engine already covers
// the play. max_hold_seconds (e.g. 240s) IS the BOOST-window sell; stop-loss /
// trailing-stop stay the protective rails. Zero drift risk with the backtester.

import { log } from './log.js';
import { executeBuy } from './executor.js';
import { isGraduated } from './amm-exit.js';

// The BOOST TWAP runs 5 minutes from migration. Past this age the edge is gone —
// never chase a stale event (feed reconnect replays, enrichment lag).
export const BOOST_WINDOW_MS = 5 * 60_000;
// Entering with less than this much window left cannot complete the ride
// (buy lands ~seconds in, the timed exit needs room before the TWAP ends).
const MIN_WINDOW_LEFT_MS = 3 * 60_000;

/**
 * Pure per-strategy gate for a migration event. Returns { pass, reason }.
 *
 * @param {object} ev    normalized graduation event ({ mint, quote_symbol, timestamp } at minimum)
 * @param {object} strat strategy row
 * @param {number} [now] epoch ms (injectable for tests)
 */
export function graduationRideGate(ev, strat, now = Date.now()) {
	if ((strat.trigger || 'new_mint') !== 'graduation_ride') return { pass: false, reason: 'not_graduation_ride' };
	if (!ev?.mint) return { pass: false, reason: 'no_mint' };
	// The AMM entry/exit math is lamports-denominated; USDC/OTHER-quoted pools
	// are refused downstream (amm_quote_not_sol) — skip them before spending a
	// buy-queue slot. A missing quote classification on a SOL-era event defaults
	// to SOL upstream, so this only rejects explicit non-SOL pairs.
	if (ev.quote_symbol && ev.quote_symbol !== 'SOL') return { pass: false, reason: 'quote_not_sol' };
	// Freshness: the event timestamp is seconds. No timestamp → treat as fresh
	// (the live WS path stamps it at receipt).
	const evMs = Number.isFinite(ev.timestamp) ? ev.timestamp * 1000 : now;
	const age = Math.max(0, now - evMs);
	if (age > BOOST_WINDOW_MS - MIN_WINDOW_LEFT_MS) return { pass: false, reason: 'boost_window_stale' };
	return { pass: true };
}

// Wait until the just-created AMM pool is readable. The migration tx creates the
// pool, but the RPC the worker reads from may lag the PumpPortal event by a few
// slots. Bounded, short: the whole point of the arm is entering early in the
// window. Returns true when the pool resolved, false when it never appeared.
async function waitForPool(network, mint, { attempts = 5, delayMs = 2_000 } = {}) {
	for (let i = 0; i < attempts; i++) {
		try {
			if (await isGraduated({ network, mint })) return true;
		} catch (err) {
			// Transient RPC failure — retry on the same schedule.
			log.warn('boost-ride pool probe failed', { mint, attempt: i + 1, err: err?.message });
		}
		if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
	}
	return false;
}

/**
 * Execute one graduation_ride entry: wait for the pool, then buy on the AMM via
 * the shared chokepoint. Intended to run inside the worker's bounded buy queue.
 *
 * @param {object} p { cfg, strat, ev, throttle }
 */
export async function executeBoostRideBuy({ cfg, strat, ev, throttle }) {
	const ready = await waitForPool(cfg.network, ev.mint);
	if (!ready) {
		log.warn('boost-ride skip — amm pool never resolved', { agent: strat.agent_id, mint: ev.mint });
		return { status: 'skipped', reason: 'pool_not_ready' };
	}
	return executeBuy({
		cfg, strat, throttle,
		mint: {
			mint: ev.mint, symbol: ev.symbol || null, name: ev.name || null,
			market_cap_usd: ev.market_cap_usd ?? null,
			entry_trigger: 'graduation_ride', trigger_ref: ev.signature || ev.tx_signature || null,
			venue: 'amm',
		},
	});
}
