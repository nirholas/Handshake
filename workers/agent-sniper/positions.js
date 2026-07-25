// agent-sniper — position lifecycle loop.
//
// Every cfg.pollMs: re-quote each open position's current SOL value off the
// bonding curve, update the high-water mark, and exit on stop-loss / trailing
// stop / take-profit / timeout (evaluated in that priority order). Pricing is
// authoritative on-chain (quoteForSell), so it needs no per-mint trade feed.

import { sql } from '../../api/_lib/db.js';
import { log } from './log.js';
import { getTradeCtx } from './trade-client.js';
import { getOpenPositions } from './strategy-store.js';
import { executeSell } from './executor.js';
import { quoteAmmSell } from './amm-exit.js';
import { decideLadderedExit, decideLiquidityDecay, moonbagAlways, moonbagFraction, updateStaleClock } from './exit-logic.js';
import { screenPush } from './screen-push.js';

async function tickPosition(cfg, pos) {
	// Kill-switch flipped while holding → exit at market now.
	if (pos.kill_switch) {
		await executeSell({ cfg, position: pos, reason: 'kill_switch' });
		return;
	}

	const baseAmount = new (await getTradeCtx(cfg.network)).BN(BigInt(pos.base_amount).toString());
	const slippagePct = (pos.slippage_bps ?? 500) / 100;
	const graduated = typeof pos.error === 'string' && pos.error.startsWith('graduated');

	const value = graduated
		? await requoteGraduated(cfg, pos, baseAmount, slippagePct)
		: await requoteCurve(cfg, pos, baseAmount, slippagePct);
	if (value == null) return; // transient quote failure — try again next sweep

	const prevPeak = Number(pos.peak_value_lamports || pos.entry_quote_lamports || 0);
	const peak = Math.max(prevPeak, value);

	// Liquidity-decay clock: a value EXACTLY unchanged between sweeps means no
	// one traded the coin at all. Underwater, that is dead liquidity, and the
	// audit showed those positions squatting on their concurrency slot until the
	// 30-minute timeout. The clock frees the slot in minutes instead.
	const prevValue = pos.last_value_lamports != null ? Number(pos.last_value_lamports) : null;
	const prevStale = pos.stale_since ? new Date(pos.stale_since).getTime() : null;
	const staleSince = updateStaleClock(prevValue, Math.round(value), Number(pos.entry_quote_lamports || 0), prevStale, Date.now());

	await sql`
		UPDATE agent_sniper_positions
		SET last_value_lamports = ${Math.round(value)}, peak_value_lamports = ${Math.round(peak)},
		    stale_since = ${staleSince != null ? new Date(staleSince).toISOString() : null},
		    last_quoted_at = now()
		WHERE id = ${pos.id}
	`;

	if (decideLiquidityDecay(staleSince, cfg.liquidityDecayS, Date.now())) {
		// Dead market: exit and free the slot. Consistency with the moon-bag rule:
		// a position still carrying its cost basis exits fully (nothing free about
		// it), but one whose initials were already recovered is house money and
		// keeps its floor riding even here: a free bag of a dead coin costs
		// nothing, and "dead for five minutes" is not "dead forever".
		const houseMoney = pos.initials_recovered === true && moonbagAlways(pos);
		log.info('liquidity decay exit', { agent: pos.agent_id, mint: pos.mint, staleForS: Math.round((Date.now() - staleSince) / 1000), houseMoney });
		await executeSell({
			cfg, position: pos, reason: 'liquidity_decay',
			fraction: houseMoney ? 1 - moonbagFraction(pos.moonbag_min_pct) : 1,
			keepsMoonbag: houseMoney,
		});
		return;
	}

	const entry = Number(pos.entry_quote_lamports || 0);
	const pnlPct = entry > 0 ? ((value - entry) / entry) * 100 : 0;
	const sym = (pos.symbol || pos.mint.slice(0, 6)).toUpperCase();
	screenPush(`$${sym}: ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}% P&L — monitoring`, 'trade');

	// Optional paid-intel exit: only read the (already-bought) x402 sentiment when
	// the operator has armed it AND the position is underwater — the one case
	// signal_flip can fire. A read failure degrades to the normal exit math.
	let sentiment = null;
	if (cfg.exitOnBearish && value < entry) {
		sentiment = await readCoinSentiment(cfg, pos.mint);
	}

	const exit = decideLadderedExit(pos, value, peak, Date.now(), sentiment);
	if (exit) {
		await executeSell({
			cfg,
			position: pos,
			reason: exit.reason,
			fraction: exit.sellFraction,
			recoversInitials: exit.recoversInitials === true,
			keepsMoonbag: exit.keepsMoonbag === true,
		});
	}
}

// Re-quote a still-on-curve position off the bonding curve. On graduation, flag
// the position once so the NEXT sweep re-quotes it off the AMM (and executeSell
// routes the exit there) — never park it. Returns null on a transient failure.
async function requoteCurve(cfg, pos, baseAmount, slippagePct) {
	const ctx = await getTradeCtx(cfg.network);
	const mintPk = new ctx.web3.PublicKey(pos.mint);
	try {
		const quote = await ctx.client.quoteForSell({ mint: mintPk, baseAmount, slippagePct });
		return Number(quote.expectedQuoteOut.toString());
	} catch (err) {
		if (err?.name === 'CoinGraduatedError') {
			await sql`
				UPDATE agent_sniper_positions
				SET error = 'graduated:awaiting_amm_exit', last_quoted_at = now()
				WHERE id = ${pos.id} AND status = 'open'
			`;
			// Flag in-memory too so a same-tick executeSell takes the AMM branch
			// directly instead of re-hitting the dead curve.
			pos.error = 'graduated:awaiting_amm_exit';
			log.info('position graduated — switching to AMM exit', { agent: pos.agent_id, mint: pos.mint });
			// Quote off the AMM on the same tick so exit triggers fire immediately.
			return await requoteGraduated(cfg, pos, baseAmount, slippagePct);
		}
		log.warn('position re-quote failed', { mint: pos.mint, err: err?.message });
		return null;
	}
}

// Re-quote a graduated position off the canonical AMM pool. Same exit math, real
// post-graduation price. Returns null on a transient failure (pool not yet
// readable, RPC hiccup) so the position holds and retries rather than mis-exiting.
async function requoteGraduated(cfg, pos, baseAmount, slippagePct) {
	try {
		const { expectedQuoteOut } = await quoteAmmSell({
			network: cfg.network, mint: pos.mint, baseAmount, slippagePct,
		});
		return Number(expectedQuoteOut);
	} catch (err) {
		log.warn('amm re-quote failed', { mint: pos.mint, code: err?.code, err: err?.message });
		return null;
	}
}

// Read the latest x402-paid sentiment for a held coin, shaped for decideExit.
// Returns null on any miss/error so the exit math falls back to stop/trailing/TP.
async function readCoinSentiment(cfg, mint) {
	try {
		const [row] = await sql`
			SELECT signal, confidence FROM sniper_coin_sentiment
			WHERE mint = ${mint} AND network = ${cfg.network}
			LIMIT 1
		`;
		if (!row) return null;
		return {
			signal: row.signal,
			confidence: row.confidence == null ? null : Number(row.confidence),
			minConfidence: cfg.exitBearishMinConfidence,
		};
	} catch (err) {
		log.warn('coin sentiment read failed', { mint, err: err?.message });
		return null;
	}
}

/** Run one sweep over all open positions. Errors on one position never abort the rest. */
export async function runPositionSweep(cfg) {
	let positions;
	try {
		positions = await getOpenPositions(cfg.network);
	} catch (err) {
		log.error('open-position query failed', { err: err?.message });
		return;
	}
	for (const pos of positions) {
		try {
			await tickPosition(cfg, pos);
		} catch (err) {
			log.error('position tick failed', { mint: pos.mint, err: err?.message });
		}
	}
}
