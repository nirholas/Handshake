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

/** Moon-bag floor as a fraction of the position that must ALWAYS be kept on any
 * exit that is in profit. Default 15%, clamped to [0, 0.95] so a sell can never
 * be the whole bag. */
export function moonbagFraction(n) {
	const x = pct(n);
	const frac = x == null ? 15 : x;
	return Math.max(0, Math.min(0.95, frac / 100));
}

/**
 * Is the never-full-exit rule active for this position? Default ON, fleet-wide.
 * Only an explicit `moonbag_always === false` turns it off, so every existing
 * strategy row (where the column is null) gets the rule without a backfill.
 */
export function moonbagAlways(pos) {
	return pos?.moonbag_always !== false;
}

/**
 * How much of the remaining position to sell on a terminal exit that is allowed
 * to keep a moon bag. Never returns 1: a bag always rides.
 *
 *   - House money (the stake is already recovered): the whole remainder is free,
 *     so bank the gain down to the floor and keep the floor riding.
 *   - Still carrying cost basis but exiting in profit: sell exactly enough to
 *     return the stake (entry/value), capped by the floor. This is the case the
 *     rule exists for. A trailing stop at +40% used to dump 100% of the bag for a
 *     few thousandths of a SOL; now it recovers the cost and the rest rides free.
 *
 * Pure. Exported for tests.
 *
 * @param {number} entry   cost basis of the remaining position (lamports)
 * @param {number} value   current value of the remaining position (lamports)
 * @param {number} moonbag floor as a fraction (0..0.95)
 * @param {boolean} houseMoney true once initials have been recovered
 */
export function moonbagExitFraction(entry, value, moonbag, houseMoney) {
	const cap = 1 - moonbag;
	if (!(value > 0)) return cap;
	const target = houseMoney ? cap : entry / value;
	return Math.max(0, Math.min(target, cap));
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
	const entry = Number(BigInt(pos.entry_quote_lamports || '0'));
	if (!(entry > 0)) return null;

	const mult = ladderMultiple(pos.initials_out_multiple);
	const moonbag = moonbagFraction(pos.moonbag_min_pct);
	const always = moonbagAlways(pos);
	const recovered = pos.initials_recovered === true;
	const sl = pct(pos.stop_loss_pct);
	const ts = pct(pos.trailing_stop_pct);
	const tp = pct(pos.take_profit_pct);

	// ── 1. Which reason fires. Priority is unchanged and the hard stop still wins.
	let reason = null;
	if (sl != null && value <= entry * (1 - sl / 100)) {
		reason = 'stop_loss';
	} else if (isBearishFlip(sentiment) && value < entry) {
		reason = 'signal_flip';
	} else if (ts != null && peak > entry && value <= peak * (1 - ts / 100)) {
		// `peak > entry`, not `peak > 0`: the trailing stop arms only once the
		// position has actually been green. Armed underwater it is a machine for
		// realizing small losses (measured across the fleet's first 90 real trades),
		// and the hard stop-loss above already caps the downside. decideExit has
		// always done this; the ladder path used to arm at any peak, so every
		// ladder-on strategy carried the below-breakeven trail this rules out.
		reason = 'trailing_stop';
	} else if (mult != null && !recovered && value >= entry * mult) {
		// Take-initials: the proactive first profit event, fired once.
		const sellFraction = Math.max(0, Math.min(entry / value, 1 - moonbag));
		if (sellFraction > 0) return { reason: 'take_initials', sellFraction, recoversInitials: true };
	}

	if (reason == null) {
		if (tp != null && value >= entry * (1 + tp / 100) && (recovered || mult == null)) {
			// A take-profit ceiling. With a ladder armed it only applies after the
			// initials are out, so the ceiling can never pre-empt the ladder.
			reason = 'take_profit';
		} else {
			const heldS = (now - new Date(pos.opened_at).getTime()) / 1000;
			if (pos.max_hold_seconds != null && heldS >= pos.max_hold_seconds) reason = 'timeout';
		}
	}
	if (reason == null) return null;

	// ── 2. How much to sell. The owner's rule: we never sell 100% of a position
	// that is in profit, and we never sell 100% of a position whose stake is
	// already recovered. Once the cost basis is back, the remainder is free: a bag
	// that goes to zero cost us nothing, and a bag that runs is the whole point.
	// Selling the last 15% to bank a few thousandths of a SOL trades away all of
	// that upside for a rounding error.
	if (!always) return { reason, sellFraction: 1 };

	// Kill switch and a stop-loss on money still at risk stay full exits. Before
	// the stake is recovered the position is OUR money, not house money, so
	// "hold a free bag" does not apply: there is nothing free about it yet, and
	// the hard downside cap is the one rule the ladder never overrides.
	const houseMoney = recovered;
	const inProfit = value > entry;
	if (!houseMoney && !inProfit) return { reason, sellFraction: 1 };
	if (!houseMoney && reason === 'stop_loss') return { reason, sellFraction: 1 };

	const sellFraction = moonbagExitFraction(entry, value, moonbag, houseMoney);
	if (!(sellFraction > 0)) return null; // nothing worth selling; let the bag ride
	return { reason, sellFraction, keepsMoonbag: true };
}
