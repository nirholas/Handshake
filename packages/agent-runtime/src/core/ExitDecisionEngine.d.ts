import type { ExitEvaluablePosition, ExitReason, ExitSentiment, LadderedExitDecision } from '../types/exit.js';
/**
 * Coerce to a finite number, or `null`. A `null`/blank input is "disabled"
 * (`null`) - NOT `0`. (`Number(null) === 0`, so a missing take-profit / trailing
 * stop would otherwise fire immediately; `null` documents "no TP / no trailing
 * stop", and this is the single source of truth that honors it.)
 */
export declare function pct(n: number | null | undefined): number | null;
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
export declare function decideExit(pos: ExitEvaluablePosition, value: bigint, peak: bigint, now: number, sentiment?: ExitSentiment | null): ExitReason | null;
/** The take-initials multiple (× entry) or `null` when the ladder is off. Must be
 * > 1 to make sense - you can't recover initials below cost. */
export declare function ladderMultiple(n: number | null | undefined): number | null;
/** Moon-bag floor as a fraction of the position that must ALWAYS be kept on the
 * take-initials event. Default 15%, clamped to [0, 0.95] so a sell can never be
 * the whole bag. */
export declare function moonbagFraction(n: number | null | undefined): number;
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
export declare function decideLadderedExit(pos: ExitEvaluablePosition, value: bigint, peak: bigint, now: number, sentiment?: ExitSentiment | null): LadderedExitDecision | null;
