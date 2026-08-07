/**
 * TradeGuard - the default, chain-agnostic domain guard for the GuardChain's
 * `defi_guard` layer.
 *
 * Where {@link SpendGuard} enforces a per-agent spend envelope, TradeGuard
 * enforces per-user trade policy on fund-moving tool calls:
 *
 * 1. **Tier per-transaction caps** - a call whose USD notional exceeds the
 *    user's tier cap is blocked outright (`CAP_PER_TX`).
 * 2. **Per-user caps** - explicit {@link UserSwapCaps} override the tier cap
 *    and add rolling 24-hour / 7-day windows (`CAP_DAILY` / `CAP_WEEKLY`)
 *    evaluated against {@link UserSwapVolume} resolved from receipts.
 * 3. **Auto-execute ceiling** - an allowed call above the ceiling is
 *    downgraded to `require_approval`, so large trades always see a human.
 * 4. **Slippage clamp** - a mutating call carrying a slippage parameter above
 *    the configured maximum on a large notional gets the parameter clamped via
 *    `modifiedArguments`, with a warning attached (cheap MEV protection).
 * 5. **Protocol audit lookup** - the target protocol is resolved against the
 *    configured registry; anything absent reads as `unaudited`, which the
 *    GuardChain surfaces as a `PROTOCOL_UNVERIFIED` blind spot.
 *
 * All checks are pure and deterministic given the request; every external fact
 * (tier, caps, volume, notional) is resolved by the caller and passed in.
 * Dollar caps compare against 0 when no `valueUsd` is supplied - by design the
 * guard never prices token amounts itself, and the GuardChain reports the
 * missing notional as a `VALUE_UNRESOLVED` blind spot instead.
 */
import type { AuditStatus, DeFiGuard, GuardAnalyzeRequest, GuardResult } from './toolRegistry.js';
/** Default per-transaction USD caps by subscription tier. */
export declare const DEFAULT_TIER_TX_CAPS_USD: Record<string, number>;
/** Default USD notional above which an allowed call still needs approval. */
export declare const DEFAULT_AUTO_EXECUTE_CEILING_USD = 10000;
/** Default maximum slippage percentage before the clamp fires. */
export declare const DEFAULT_MAX_SLIPPAGE_PCT = 1;
/** Default notional below which the slippage clamp does not bother firing. */
export declare const DEFAULT_MEV_NOTIONAL_THRESHOLD_USD = 10000;
export interface TradeGuardConfig {
    /** Per-tier per-transaction caps in USD. Missing tiers fall back to `free`. */
    tierTxCapsUsd?: Record<string, number>;
    /** USD notional above which allowed calls are downgraded to approval. */
    autoExecuteCeilingUsd?: number;
    /** Maximum slippage percentage before the clamp fires. */
    maxSlippagePct?: number;
    /** Minimum USD notional for the slippage clamp to apply. */
    mevNotionalThresholdUsd?: number;
    /** Audit registry, keyed by lower-case protocol name. */
    protocolRegistry?: Record<string, AuditStatus>;
    /** Extra tool identifiers to analyze beyond the shared registry. */
    extraToolIdentifiers?: string[];
    /** Wall-clock source, injectable for tests. */
    now?: () => number;
}
export declare class TradeGuard implements DeFiGuard {
    private readonly tierCaps;
    private readonly autoExecuteCeilingUsd;
    private readonly maxSlippagePct;
    private readonly mevNotionalThresholdUsd;
    private readonly protocolRegistry;
    private readonly extraIdentifiers;
    private readonly now;
    constructor(config?: TradeGuardConfig);
    isDeFiTool(identifier: string): boolean;
    isMutatingApi(apiName: string): boolean;
    analyze(request: GuardAnalyzeRequest): GuardResult;
}
