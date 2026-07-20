// agent-sniper — position lifecycle loop.
//
// Every cfg.pollMs: re-quote each open position's current SOL value, update the
// high-water mark, and exit on stop-loss / trailing-stop / take-profit / timeout
// (in that priority order). Pricing is authoritative on-chain (quoteForSell), so
// it needs no per-mint trade feed.

import { PublicKey } from '@solana/web3.js';
import { decideLadderedExit } from './exit-logic.js';
import { executeSell } from './executor.js';

async function tickPosition(cfg, pos, ports) {
	const { solana, hooks, log } = ports;
	const screen = (text, kind) => { try { hooks.onScreen?.({ text, kind }); } catch { /* best-effort */ } };

	if (pos.kill_switch) {
		await executeSell({ cfg, position: pos, reason: 'kill_switch', ports });
		return;
	}

	const mintPk = new PublicKey(pos.mint);
	const baseAmount = BigInt(pos.base_amount);
	const slippagePct = (pos.slippage_bps ?? 500) / 100;

	// Re-quote the bag. This number decides whether the position exits, so an
	// unusable quote must NOT be read as a valuation. The bundled adapter throws
	// on a missing or non-positive quote, but a custom SolanaClient may not, so
	// the sweep re-checks independently: a zero here would compute as -100% P&L
	// and stop-loss a perfectly healthy position on the very next tick. A real
	// collapse still exits, because a real collapse still returns a real number.
	let value;
	try {
		const quote = await solana.quoteForSell({ mint: mintPk, baseAmount, slippagePct });
		const out = quote?.expectedQuoteOut == null ? null : Number(quote.expectedQuoteOut.toString());
		if (out == null || !Number.isFinite(out) || out <= 0) {
			log.warn('position re-quote returned no usable value, holding', {
				mint: pos.mint,
				expected_quote_out: String(quote?.expectedQuoteOut),
			});
			return; // hold, do not value the bag at zero
		}
		value = out;
	} catch (err) {
		log.warn('position re-quote failed', { mint: pos.mint, err: err?.message });
		return; // transient — try again next sweep
	}

	const prevPeak = Number(pos.peak_value_lamports || pos.entry_quote_lamports || 0);
	const peak = Math.max(prevPeak, value);
	await ports.store.updatePosition(pos.id, { last_value_lamports: Math.round(value), peak_value_lamports: Math.round(peak) });

	const entry = Number(pos.entry_quote_lamports || 0);
	const pnlPct = entry > 0 ? ((value - entry) / entry) * 100 : 0;
	const sym = (pos.symbol || pos.mint.slice(0, 6)).toUpperCase();
	screen(`$${sym}: ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}% P&L — monitoring`, 'trade');

	let sentiment = null;
	if (cfg.exitOnBearish && value < entry && hooks.readSentiment) {
		try {
			const s = await hooks.readSentiment(pos.mint, cfg.network);
			if (s) sentiment = { ...s, minConfidence: cfg.exitBearishMinConfidence };
		} catch { /* sentiment offline — fall back to stop/trailing/TP */ }
	}

	const exit = decideLadderedExit(pos, value, peak, Date.now(), sentiment);
	if (exit) {
		await executeSell({
			cfg, position: pos, reason: exit.reason, ports,
			fraction: exit.sellFraction, recoversInitials: exit.recoversInitials === true,
		});
	}
}

/** Run one sweep over all open positions. An error on one never aborts the rest. */
export async function runPositionSweep(cfg, ports) {
	let positions;
	try {
		positions = await ports.store.getOpenPositions(cfg.network);
	} catch (err) {
		ports.log.error('open-position query failed', { err: err?.message });
		return;
	}
	for (const pos of positions) {
		try {
			await tickPosition(cfg, pos, ports);
		} catch (err) {
			ports.log.error('position tick failed', { mint: pos.mint, err: err?.message });
		}
	}
}
