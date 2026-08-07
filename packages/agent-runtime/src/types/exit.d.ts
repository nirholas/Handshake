/** Why a position closed, in the engine's fixed priority order. `take_initials`
 * is the laddered partial-exit reason (only `decideLadderedExit` returns it). */
export type ExitReason = 'stop_loss' | 'signal_flip' | 'trailing_stop' | 'take_profit' | 'take_initials' | 'timeout';
/**
 * An external sentiment read that can trigger an early `signal_flip` exit. The
 * hook shape is portable; the *source* is three.ws's own intel (news-sentinel /
 * risk intel), not three.ws x402. Pass `null`/omit to disable signal_flip so a
 * replay is byte-for-byte deterministic.
 */
export interface ExitSentiment {
    /** Confidence of the read in [0, 1]. */
    confidence?: number | null;
    /** Confidence floor the read must clear to act on. Defaults to 0.7. */
    minConfidence?: number;
    /** Directional signal. Only `'bearish'` can trigger an exit. */
    signal?: string;
}
/**
 * The minimal position shape the exit engine needs. All percentages are plain
 * numbers (e.g. `15` = 15%); `null`/`undefined` means **disabled**, not `0` -
 * the null guard is load-bearing (`Number(null) === 0` would fire a missing
 * take-profit immediately). Ladder fields are optional; when
 * `initialsOutMultiple` is unset the laddered decider is byte-for-byte the
 * classic full-exit behavior.
 */
export interface ExitEvaluablePosition {
    /** Entry cost basis in the quote asset's smallest unit (wei on EVM). */
    entryQuoteWei: bigint;
    /** Whether the initial cost basis has already been banked (ladder state). */
    initialsRecovered?: boolean;
    /** Take-initials multiple (× entry) that arms the first partial exit; must be > 1. */
    initialsOutMultiple?: number | null;
    /** Max time to hold, in seconds, before a `timeout` exit. */
    maxHoldSeconds?: number | null;
    /** Moon-bag floor as a percent that must always ride past the take-initials event. Default 15. */
    moonbagMinPct?: number | null;
    /** Epoch milliseconds the position was opened; used with the injected clock for timeout. */
    openedAt: number;
    /** Hard stop-loss as a percent below entry. Always wins on conflict. */
    stopLossPct?: number | null;
    /** Take-profit as a percent above entry. */
    takeProfitPct?: number | null;
    /** Trailing stop as a percent drawdown from the high-water mark. */
    trailingStopPct?: number | null;
}
/** A laddered exit: the reason and what fraction of the CURRENT remaining
 * position to sell (0-1). `recoversInitials` marks the one-time take-initials
 * event so the caller can flip `initialsRecovered`. */
export interface LadderedExitDecision {
    reason: ExitReason;
    /** True only on the take-initials event that banks the cost basis. */
    recoversInitials?: boolean;
    /** Fraction of the remaining position to sell, in (0, 1]. */
    sellFraction: number;
}
/**
 * One recorded observation of an open position's value. `value`/`quote` are the
 * position's current worth in the entry quote asset's wei; `at` is the epoch-ms
 * clock injected as `now` when this point is evaluated. `sentiment` is optional
 * and only matters for the `signal_flip` hook.
 */
export interface PricePoint {
    /** Epoch ms of the observation - injected as the engine's `now`. */
    at: number;
    /** Position value at this point, in entry-quote wei. */
    value: bigint;
    /** Optional sentiment read for the `signal_flip` early cut. */
    sentiment?: ExitSentiment | null;
}
/** A partial (laddered) sale recorded during a backtest replay. */
export interface BacktestLadderEvent {
    /** Epoch ms the partial fired. */
    at: number;
    /** Why it fired - `take_initials` for the moon-bag bank. */
    reason: ExitReason;
    /** Fraction of the ORIGINAL position sold at this event, in (0, 1). */
    fractionOfOriginal: number;
    /** Position value the partial executed at, in wei. */
    value: bigint;
}
/**
 * Outcome of replaying a strategy over `PricePoint[]`. A `null` `exitReason`
 * means the position was still open at the final point (moon bag riding); its
 * P&L is then marked to the last observed value.
 */
export interface BacktestResult {
    /** Terminal exit reason, or `null` if still open at the end of the series. */
    exitReason: ExitReason | null;
    /** Value the terminal exit resolved at (wei), or `null` if still open. */
    exitValue: bigint | null;
    /** Seconds held from entry to the terminal exit (or to the last point if open). */
    holdSeconds: number;
    /** Net P&L as a percentage of entry, blending realized partials + open moon bag. */
    pnlPct: number;
    /** Partial (laddered) sales in the order they fired. */
    ladder: BacktestLadderEvent[];
}
