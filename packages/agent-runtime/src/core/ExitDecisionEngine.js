// ExitDecisionEngine - pure exit decision. No I/O, no time source of its own.
//
// The single source of truth for "should this position exit, and why", evaluated
// in strict priority order: stop-loss → signal-flip → trailing-stop → take-profit
// → timeout. The hard stop-loss always wins; `signal_flip` is an early cut that
// only fires while underwater. Because the clock is always passed in (never read
// from wall time here), the exact same function governs live evaluation and
// historical backtests - the two can never drift.
//
// Ported near-verbatim from three.ws `workers/agent-sniper/exit-logic.js`.
// Solana lamports → EVM wei: entry/value/peak are `bigint`. Ratio comparisons run
// in float64 (see types/exit.ts for why that is precision-safe).
/**
 * Coerce to a finite number, or `null`. A `null`/blank input is "disabled"
 * (`null`) - NOT `0`. (`Number(null) === 0`, so a missing take-profit / trailing
 * stop would otherwise fire immediately; `null` documents "no TP / no trailing
 * stop", and this is the single source of truth that honors it.)
 */
export function pct(n) {
    if (n == null)
        return null;
    const x = Number(n);
    return Number.isFinite(x) ? x : null;
}
/** A confident bearish sentiment read. `minConfidence` defaults to 0.7. */
function isBearishFlip(sentiment) {
    if (!sentiment || sentiment.signal !== 'bearish')
        return false;
    const conf = Number(sentiment.confidence);
    const floor = Number(sentiment.minConfidence);
    return Number.isFinite(conf) && conf >= (Number.isFinite(floor) ? floor : 0.7);
}
/**
 * Decide the exit reason for a position, or `null` to hold. Evaluated in priority
 * order: stop-loss → signal-flip → trailing-stop → take-profit → timeout.
 *
 * The hard stop-loss always wins. `signal_flip` is an EARLY warning that cuts a
 * losing position before it reaches the stop; it only fires while the position is
 * underwater and never overrides a take-profit. It is inert unless the caller
 * passes a `sentiment`, so replays that omit it are byte-for-byte unchanged.
 *
 * @param pos       position to evaluate
 * @param value     current value of the position (wei)
 * @param peak      high-water mark of `value` since entry (wei)
 * @param now       epoch ms for the timeout clock - always injected, never wall time
 * @param sentiment live sentiment read; `null`/omitted disables signal_flip
 */
export function decideExit(pos, value, peak, now, sentiment = null) {
    const entry = pos.entryQuoteWei ?? 0n;
    if (entry <= 0n)
        return null;
    const ev = Number(entry);
    const v = Number(value);
    const pk = Number(peak);
    const sl = pct(pos.stopLossPct);
    const ts = pct(pos.trailingStopPct);
    const tp = pct(pos.takeProfitPct);
    if (sl != null && v <= ev * (1 - sl / 100))
        return 'stop_loss';
    if (isBearishFlip(sentiment) && v < ev)
        return 'signal_flip';
    // Trailing stop arms only once the peak has been ABOVE entry, so a coin that
    // never moves up can't trail-stop on entry noise.
    if (ts != null && pk > ev && v <= pk * (1 - ts / 100))
        return 'trailing_stop';
    if (tp != null && v >= ev * (1 + tp / 100))
        return 'take_profit';
    const heldS = (now - pos.openedAt) / 1000;
    if (pos.maxHoldSeconds != null && heldS >= pos.maxHoldSeconds)
        return 'timeout';
    return null;
}
/** The take-initials multiple (× entry) or `null` when the ladder is off. Must be
 * > 1 to make sense - you can't recover initials below cost. */
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
 * position to sell. This is the live-trading source of truth; `decideExit` above
 * stays the single-shot decider a backtester replays.
 *
 * The ladder is OPT-IN: with no `initialsOutMultiple` set it is byte-for-byte the
 * classic full-exit behavior (sellFraction 1 on any `decideExit` reason), so
 * existing strategies are unchanged. When set, it encodes the owner's rule:
 *
 *   - Protective exits are always FULL exits of whatever remains, and the hard
 *     stop-loss still wins: stop_loss → signal_flip → trailing_stop.
 *   - The FIRST time the position reaches `initialsOutMultiple`× entry (e.g. 2×),
 *     sell exactly enough to return the initial cost basis (fraction =
 *     entry/value), but NEVER more than 1 − moonbag floor - so a moon bag always
 *     rides. At 2× that is a 0.5 sell (keep half); at 5× a 0.2 sell (keep 80%).
 *   - After initials are recovered, the moon bag runs, protected by the trailing
 *     stop; an optional classic `takeProfitPct` acts as a ceiling that exits the
 *     remainder. Timeout exits the remainder.
 *
 * It NEVER returns a full take-PROFIT exit before initials are recovered - that
 * is the "sold too much too soon" mistake the rule exists to prevent.
 */
export function decideLadderedExit(pos, value, peak, now, sentiment = null) {
    const mult = ladderMultiple(pos.initialsOutMultiple);
    if (mult == null) {
        // Ladder off → classic single-shot full exit (unchanged behavior).
        const reason = decideExit(pos, value, peak, now, sentiment);
        return reason ? { reason, sellFraction: 1 } : null;
    }
    const entry = pos.entryQuoteWei ?? 0n;
    if (entry <= 0n)
        return null;
    const ev = Number(entry);
    const v = Number(value);
    const pk = Number(peak);
    const sl = pct(pos.stopLossPct);
    const ts = pct(pos.trailingStopPct);
    const tp = pct(pos.takeProfitPct);
    const moonbag = moonbagFraction(pos.moonbagMinPct);
    const recovered = pos.initialsRecovered === true;
    // Protective exits - full exit of the remainder; stop-loss wins on conflict.
    if (sl != null && v <= ev * (1 - sl / 100))
        return { reason: 'stop_loss', sellFraction: 1 };
    if (isBearishFlip(sentiment) && v < ev)
        return { reason: 'signal_flip', sellFraction: 1 };
    // Trailing stop arms only once the peak has been ABOVE entry (see decideExit).
    if (ts != null && pk > ev && v <= pk * (1 - ts / 100))
        return { reason: 'trailing_stop', sellFraction: 1 };
    // Take-initials - the first profit event, once, before initials are recovered.
    if (!recovered && v >= ev * mult) {
        const recoverFraction = ev / v; // f·value = cost basis
        const sellFraction = Math.max(0, Math.min(recoverFraction, 1 - moonbag));
        if (sellFraction > 0)
            return { reason: 'take_initials', sellFraction, recoversInitials: true };
    }
    // Moon-bag ceiling - optional classic take-profit, only AFTER initials are out.
    if (recovered && tp != null && v >= ev * (1 + tp / 100))
        return { reason: 'take_profit', sellFraction: 1 };
    // Timeout - full exit of the remainder.
    const heldS = (now - pos.openedAt) / 1000;
    if (pos.maxHoldSeconds != null && heldS >= pos.maxHoldSeconds)
        return { reason: 'timeout', sellFraction: 1 };
    return null;
}
