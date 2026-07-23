// agent-sniper — pure exit decision. No I/O, no time source of its own.
//
// The single source of truth for "should this position exit, and why". The live
// position loop (positions.js) calls it every tick with a freshly re-quoted SOL
// value + high-water mark; the historical backtester (api/_lib/strategy-backtest.js)
// calls it at the recorded peak and terminal price points so a projected strategy
// is evaluated with the EXACT stop-loss / trailing-stop / take-profit / timeout
// priority that governs real money. Keeping it here means the two can never drift.

/** Coerce to a finite number, or null. A null/blank input is "disabled" (null) —
 * NOT 0. (Number(null) === 0, so a missing take-profit / trailing-stop would
 * otherwise fire immediately; the schema documents null as "no TP / no trailing
 * stop", and this is the single source of truth that honors that.) */
export function pct(n) {
	if (n == null || n === '') return null;
	const x = Number(n);
	return Number.isFinite(x) ? x : null;
}

/**
 * Decide the exit reason for a position, or null to hold. Evaluated in priority
 * order: stop-loss → signal-flip → trailing-stop → take-profit → timeout.
 *
 * The hard stop-loss always wins. signal_flip is an EARLY warning that cuts a
 * losing position before it reaches the stop, driven by the per-coin x402
 * sentiment the worker already pays for — so it only fires while the position is
 * underwater and never overrides a take-profit. It is inert unless the caller
 * passes a `sentiment` (the live loop does so only when SNIPER_EXIT_ON_BEARISH
 * is set); the backtester omits it, so replays are byte-for-byte unchanged.
 *
 * @param {object} pos   position-like: { entry_quote_lamports, stop_loss_pct,
 *                        trailing_stop_pct, take_profit_pct, max_hold_seconds, opened_at }
 * @param {number} value current SOL value of the position (lamports)
 * @param {number} peak  high-water mark of `value` since entry (lamports)
 * @param {number} [now] epoch ms for the timeout clock (defaults to Date.now()).
 *                        Pass an explicit clock from a replay to keep it pure.
 * @param {{ signal?: string, confidence?: number, minConfidence?: number }|null} [sentiment]
 *                        live x402 sentiment read; null/omitted disables signal_flip.
 * @returns {'stop_loss'|'signal_flip'|'trailing_stop'|'take_profit'|'timeout'|null}
 */
export function decideExit(pos, value, peak, now = Date.now(), sentiment = null) {
	const entry = BigInt(pos.entry_quote_lamports || '0');
	if (entry <= 0n) return null;
	const ev = Number(entry);
	const sl = pct(pos.stop_loss_pct);
	const ts = pct(pos.trailing_stop_pct);
	const tp = pct(pos.take_profit_pct);

	if (sl != null && value <= ev * (1 - sl / 100)) return 'stop_loss';
	if (isBearishFlip(sentiment) && value < ev) return 'signal_flip';
	// The trailing stop arms only once the position has been green (peak above
	// entry). Armed underwater it is a machine for realizing small losses: across
	// the fleet's first 90 real trades, every below-breakeven trail converted a
	// recoverable dip into a locked loss while protecting nothing (the hard
	// stop-loss above still caps the downside). Measured 2026-07-23.
	if (ts != null && peak > ev && value <= peak * (1 - ts / 100)) return 'trailing_stop';
	if (tp != null && value >= ev * (1 + tp / 100)) return 'take_profit';

	const heldS = (now - new Date(pos.opened_at).getTime()) / 1000;
	if (pos.max_hold_seconds != null && heldS >= pos.max_hold_seconds) return 'timeout';
	return null;
}

/** A confident bearish sentiment read. minConfidence defaults to 0.7. */
function isBearishFlip(sentiment) {
	if (!sentiment || sentiment.signal !== 'bearish') return false;
	const conf = Number(sentiment.confidence);
	const floor = Number(sentiment.minConfidence);
	return Number.isFinite(conf) && conf >= (Number.isFinite(floor) ? floor : 0.7);
}

/** The take-initials multiple (× entry) or null when the ladder is off. Must be
 * > 1 to make sense (you can't recover initials below cost). */
export function ladderMultiple(n) {
	const x = pct(n);
	return x != null && x > 1 ? x : null;
}

/** Moon-bag floor as a fraction of the position that must ALWAYS be kept on the
 * take-initials event. Default 15%, clamped to [0, 0.95] so a sell can never be
 * the whole bag. */
export function moonbagFraction(n) {
	const x = pct(n);
	const frac = x == null ? 15 : x;
	return Math.max(0, Math.min(0.95, frac / 100));
}

/**
 * Laddered exit decision: the reason AND what fraction of the CURRENT remaining
 * position to sell. This is the live-trading source of truth (positions.js);
 * `decideExit` above stays the single-shot decider the backtester replays.
 *
 * The ladder is OPT-IN: with no `initials_out_multiple` set it is byte-for-byte
 * the classic full-exit behavior (sellFraction 1 on any decideExit reason), so
 * existing strategies are unchanged. When set, it encodes the owner's rule:
 *
 *   - Protective exits are always FULL exits of whatever remains, and the hard
 *     stop-loss still wins: stop_loss → signal_flip → trailing_stop.
 *   - The FIRST time the position reaches `initials_out_multiple`× entry (e.g.
 *     2×), sell exactly enough to return the initial cost basis (fraction =
 *     entry/value), but NEVER more than 1 − moonbag floor — so a moon bag always
 *     rides. At 2× that is a 0.5 sell (keep half); at 5× a 0.2 sell (keep 80%).
 *   - After initials are recovered, the moon bag runs, protected by the trailing
 *     stop; an optional classic `take_profit_pct` acts as a ceiling that exits
 *     the remainder. Timeout exits the remainder.
 *
 * It NEVER returns a full take-PROFIT exit before initials are recovered — that
 * is the "sold too much too soon" mistake the rule exists to prevent.
 *
 * @param {object} pos position-like; adds `initials_out_multiple`,
 *                      `moonbag_min_pct`, and the `initials_recovered` state flag
 *                      to the fields `decideExit` reads.
 * @param {number} value current SOL value of the remaining position (lamports)
 * @param {number} peak  high-water mark of `value` since entry (lamports)
 * @param {number} [now] epoch ms for the timeout clock
 * @param {object|null} [sentiment] live x402 sentiment; null disables signal_flip
 * @returns {{ reason: string, sellFraction: number, recoversInitials?: boolean }|null}
 */
export function decideLadderedExit(pos, value, peak, now = Date.now(), sentiment = null) {
	const mult = ladderMultiple(pos.initials_out_multiple);
	if (mult == null) {
		// Ladder off → classic single-shot full exit (unchanged behavior).
		const reason = decideExit(pos, value, peak, now, sentiment);
		return reason ? { reason, sellFraction: 1 } : null;
	}

	const entry = Number(BigInt(pos.entry_quote_lamports || '0'));
	if (!(entry > 0)) return null;
	const sl = pct(pos.stop_loss_pct);
	const ts = pct(pos.trailing_stop_pct);
	const tp = pct(pos.take_profit_pct);
	const moonbag = moonbagFraction(pos.moonbag_min_pct);
	const recovered = pos.initials_recovered === true;

	// Protective exits — full exit of the remainder; stop-loss wins on conflict.
	if (sl != null && value <= entry * (1 - sl / 100)) return { reason: 'stop_loss', sellFraction: 1 };
	if (isBearishFlip(sentiment) && value < entry) return { reason: 'signal_flip', sellFraction: 1 };
	if (ts != null && peak > 0 && value <= peak * (1 - ts / 100)) return { reason: 'trailing_stop', sellFraction: 1 };

	// Take-initials — the first profit event, once, before initials are recovered.
	if (!recovered && value >= entry * mult) {
		const recoverFraction = entry / value; // f·value = cost basis
		const sellFraction = Math.max(0, Math.min(recoverFraction, 1 - moonbag));
		if (sellFraction > 0) return { reason: 'take_initials', sellFraction, recoversInitials: true };
	}

	// Moon-bag ceiling — optional classic take-profit, only AFTER initials are out.
	if (recovered && tp != null && value >= entry * (1 + tp / 100)) return { reason: 'take_profit', sellFraction: 1 };

	// Timeout — full exit of the remainder.
	const heldS = (now - new Date(pos.opened_at).getTime()) / 1000;
	if (pos.max_hold_seconds != null && heldS >= pos.max_hold_seconds) return { reason: 'timeout', sellFraction: 1 };
	return null;
}
