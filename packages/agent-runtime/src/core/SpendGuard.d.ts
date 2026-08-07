/**
 * SpendGuard - Per-Agent Spend Envelope + Token/Target Firewall + Custody Reconciliation
 *
 * The quantitative money-safety layer that `PermissionGuard`, `CapabilityGuard`, and
 * `DeFiGuard` do not encode. Where `DeFiGuard` scores *risk* and enforces *per-user tier*
 * limits, `SpendGuard` enforces a hard **per-agent spend envelope**:
 *
 *  1. **Per-tx maximum** - a single outflow may never exceed `perTxMaxUsd`.
 *  2. **Rolling / daily caps** - cumulative outflow over a rolling window (default 24h) may
 *     never exceed `rollingMaxUsd` / `dailyMaxUsd`. This is a true sliding window, not a
 *     calendar-day bucket.
 *  3. **Reserve floor** - a transaction may not drain the agent wallet below `reserveFloorUsd`.
 *  4. **Token/target firewall** - an allow/deny layer keyed by token *and* destination, with a
 *     strict mode that blocks anything not on the allowlist.
 *  5. **Custody reconciliation** - sums the *actual* on-chain outflow (independently observed)
 *     against the outflow the agent *recorded* in the Task 03 tamper-evident ledger; if the
 *     chain moved more than the ledger recorded, that is a breach (key-compromise signal) and
 *     the guard **latches shut** for that agent until explicitly reset.
 *
 * Ported from three.ws `economy-master.js` (reserve/per-run/per-target guards + registry
 * allowlist). The Solana multi-wallet funding topology is intentionally NOT ported - only the
 * guard envelope. Custody here is EVM (Plutus ERC-4337).
 *
 * ── Design contract ──
 * - **Pure & deterministic.** `check()` has no side effects and, for a fixed clock, always
 *   returns the same decision for the same inputs (runtime rule #4). Spend is only mutated by
 *   the explicit `recordSpend()` call, made *after* a transaction actually lands.
 * - **DB-agnostic.** Per-agent config is resolved server-side (from `agent_spend_limits`) and
 *   passed in; the ledger totals for reconciliation are injected via a `SpendLedgerReader`.
 *   The runtime package never imports the database, exactly like `PermissionGuard`.
 */
/** Allow/deny firewall keyed by token symbol/address and destination address. */
export interface FirewallConfig {
    /**
     * When true, a transaction is blocked unless its token is on `allowTokens`
     * (if that list is non-empty) AND its destination is on `allowDestinations`
     * (if that list is non-empty). Deny lists always take precedence.
     */
    strictMode?: boolean;
    /** Tokens explicitly permitted (only enforced in strict mode). */
    allowTokens?: string[];
    /** Tokens always blocked, regardless of mode. */
    denyTokens?: string[];
    /** Destination addresses explicitly permitted (only enforced in strict mode). */
    allowDestinations?: string[];
    /** Destination addresses always blocked, regardless of mode. */
    denyDestinations?: string[];
}
/** Per-agent spend envelope. Every field is optional - an unset limit is not enforced. */
export interface SpendLimitConfig {
    /** Maximum USD value of any single transaction. */
    perTxMaxUsd?: number;
    /** Maximum cumulative USD over a rolling 24-hour window. */
    dailyMaxUsd?: number;
    /** Custom rolling window in milliseconds (defaults to 24h when `rollingMaxUsd` is set). */
    rollingWindowMs?: number;
    /** Maximum cumulative USD over the custom rolling window. */
    rollingMaxUsd?: number;
    /** Minimum wallet balance (USD) that must remain after a transaction. */
    reserveFloorUsd?: number;
    /** Token/destination allow-deny firewall. */
    firewall?: FirewallConfig;
    /**
     * Fractional tolerance for ledger reconciliation. On-chain outflow is only treated as a
     * breach when it exceeds `ledgerRecordedUsd * (1 + breachTolerance)`. Default 0.
     */
    breachTolerance?: number;
}
/** A single outflow being evaluated. */
export interface SpendTx {
    /** Agent initiating the outflow (spend is tracked per agent). */
    agentId: string;
    /** Owning user - for logging / multi-tenant scoping. */
    userId?: string;
    /** Token symbol or contract address moving out. */
    token?: string;
    /** Destination address. */
    destination?: string;
    /** USD value of the outflow. */
    valueUsd: number;
    /** Current agent wallet balance in USD (required to enforce the reserve floor). */
    balanceUsd?: number;
}
/** Deterministic reason code for a block decision. */
export type SpendBlockCode = 'CAP_PER_TX' | 'CAP_ROLLING' | 'CAP_DAILY' | 'RESERVE_FLOOR' | 'FIREWALL_DENY_TOKEN' | 'FIREWALL_DENY_DEST' | 'FIREWALL_NOT_ALLOWED' | 'BREACH';
/** Result of a spend check. */
export interface SpendCheckResult {
    /** Whether the transaction is allowed to proceed. */
    allowed: boolean;
    /** Structured block code (present iff `!allowed`). */
    code?: SpendBlockCode;
    /** Human-readable, deterministic reason. */
    reason: string;
    /** Remaining allowance under the rolling cap after this tx (if a rolling cap is configured). */
    remainingRollingUsd?: number;
    /** Remaining allowance under the daily cap after this tx (if a daily cap is configured). */
    remainingDailyUsd?: number;
}
/** Recorded vs. actually-observed outflow for a reconciliation window. */
export interface SpendReconciliation {
    /** Outflow the agent recorded in the tamper-evident ledger (Task 03). */
    ledgerRecordedUsd: number;
    /** Outflow independently observed on-chain for the same window. */
    onChainOutflowUsd: number;
}
/**
 * Injected reader that returns reconciliation figures for an agent. Provided by the server
 * layer (backed by the Task 03 `agentActionLedger` + an on-chain scan). Keeping it injected
 * means SpendGuard has no hard dependency on Task 03 - it works the moment a reader is wired.
 */
export type SpendLedgerReader = (params: {
    agentId: string;
    userId?: string;
}) => Promise<SpendReconciliation>;
/** Result of a reconciliation pass. */
export interface ReconcileResult {
    /** Whether a breach was detected (on-chain outflow exceeded recorded outflow). */
    breach: boolean;
    /** The excess USD that was moved on-chain but never recorded. */
    unrecordedUsd: number;
    reason: string;
}
export declare class SpendGuard {
    private readonly config;
    private readonly denyTokens;
    private readonly allowTokens;
    private readonly denyDests;
    private readonly allowDests;
    private readonly now;
    /** Per-agent rolling spend log (agentId → entries). */
    private readonly spendLog;
    /** Per-agent breach latch. Once set, every check for that agent is blocked. */
    private readonly tripped;
    /**
     * @param config Per-agent spend envelope, resolved server-side from `agent_spend_limits`.
     * @param opts.now Injectable clock (defaults to `Date.now`) - keeps rolling-window tests
     *   deterministic without touching real time.
     */
    constructor(config?: SpendLimitConfig, opts?: {
        now?: () => number;
    });
    /**
     * Evaluate a single outflow against the full envelope. Pure - no state mutation.
     *
     * Order is fixed (hardest / most-specific block first) so the returned code is deterministic:
     * breach latch → firewall deny → firewall strict allowlist → per-tx cap → reserve floor →
     * rolling cap → daily cap.
     */
    check(tx: SpendTx): SpendCheckResult;
    /**
     * Record an outflow that actually landed. Call this AFTER a transaction succeeds so the
     * rolling/daily windows stay live within a multi-step plan. Never call it for a blocked or
     * failed transaction.
     */
    recordSpend(agentId: string, valueUsd: number, ts?: number): void;
    /**
     * Seed the rolling window from a persisted total (e.g. confirmed outflow summed from the
     * ledger) so the in-memory tracker survives a cold start. Recorded as a single entry at the
     * current time; only raises the tracked total, never lowers it.
     */
    syncSpendFromLedger(agentId: string, confirmedRollingUsd: number, windowMs?: number): void;
    /** Cumulative recorded spend for an agent over the last `windowMs`. */
    windowSpend(agentId: string, windowMs: number): number;
    /** Remaining allowance under the daily cap for an agent (Infinity if uncapped). */
    remainingDaily(agentId: string): number;
    /**
     * Compare recorded vs. observed outflow. If the chain moved more than the ledger recorded
     * (beyond `breachTolerance`), the agent is **latched shut**: every subsequent `check()`
     * returns a `BREACH` block until `reset(agentId)` is called. This is the key-compromise
     * signal from the source `economy-reconcile` cron.
     */
    reconcile(agentId: string, figures: SpendReconciliation): ReconcileResult;
    /** Reconcile using an injected ledger reader (e.g. wired to the Task 03 ledger). */
    reconcileFromLedger(agentId: string, reader: SpendLedgerReader, userId?: string): Promise<ReconcileResult>;
    /** Whether an agent is currently latched shut by a breach. */
    isTripped(agentId: string): boolean;
    /** Clear the breach latch and spend window for an agent (or all agents if omitted). */
    reset(agentId?: string): void;
    private prune;
}
