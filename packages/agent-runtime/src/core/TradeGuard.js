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
import { DEFI_TOOL_IDENTIFIERS, MUTATING_APIS } from './toolRegistry.js';
/** Default per-transaction USD caps by subscription tier. */
export const DEFAULT_TIER_TX_CAPS_USD = {
    enterprise: Number.POSITIVE_INFINITY,
    free: 10_000,
    basic: 25_000,
    pro: 100_000,
};
/** Default USD notional above which an allowed call still needs approval. */
export const DEFAULT_AUTO_EXECUTE_CEILING_USD = 10_000;
/** Default maximum slippage percentage before the clamp fires. */
export const DEFAULT_MAX_SLIPPAGE_PCT = 1;
/** Default notional below which the slippage clamp does not bother firing. */
export const DEFAULT_MEV_NOTIONAL_THRESHOLD_USD = 10_000;
const SLIPPAGE_PCT_KEYS = ['slippage'];
const SLIPPAGE_BPS_KEYS = ['slippageBps', 'slippage_bps'];
const usd = (value) => value === Number.POSITIVE_INFINITY ? 'unlimited' : `$${value.toLocaleString('en-US')}`;
export class TradeGuard {
    tierCaps;
    autoExecuteCeilingUsd;
    maxSlippagePct;
    mevNotionalThresholdUsd;
    protocolRegistry;
    extraIdentifiers;
    now;
    constructor(config = {}) {
        this.tierCaps = { ...DEFAULT_TIER_TX_CAPS_USD, ...config.tierTxCapsUsd };
        this.autoExecuteCeilingUsd = config.autoExecuteCeilingUsd ?? DEFAULT_AUTO_EXECUTE_CEILING_USD;
        this.maxSlippagePct = config.maxSlippagePct ?? DEFAULT_MAX_SLIPPAGE_PCT;
        this.mevNotionalThresholdUsd =
            config.mevNotionalThresholdUsd ?? DEFAULT_MEV_NOTIONAL_THRESHOLD_USD;
        this.protocolRegistry = { ...config.protocolRegistry };
        this.extraIdentifiers = new Set(config.extraToolIdentifiers ?? []);
        this.now = config.now ?? (() => Date.now());
    }
    isDeFiTool(identifier) {
        return DEFI_TOOL_IDENTIFIERS.has(identifier) || this.extraIdentifiers.has(identifier);
    }
    isMutatingApi(apiName) {
        return MUTATING_APIS.has(apiName);
    }
    analyze(request) {
        const isDeFi = this.isDeFiTool(request.identifier);
        const isMutating = this.isMutatingApi(request.apiName);
        const value = request.valueUsd ?? 0;
        const warnings = [];
        const protocolStatus = request.protocol
            ? (this.protocolRegistry[request.protocol.toLowerCase()] ?? 'unaudited')
            : undefined;
        const base = {
            analyzedAt: this.now(),
            decision: 'allow',
            isDeFi,
            isMutating,
            protocolStatus,
            reason: '',
            warnings,
        };
        if (!isMutating) {
            return {
                analysis: {
                    ...base,
                    reason: `\`${request.apiName}\` is read-only; no trade policy applies.`,
                },
            };
        }
        // 1. Per-transaction cap: explicit user caps beat the tier default.
        const tier = request.userTier ?? 'free';
        const tierCap = this.tierCaps[tier] ?? this.tierCaps.free;
        const perTxCap = request.userSwapCaps?.perTxUsdCap ?? tierCap;
        if (value > perTxCap) {
            return {
                analysis: {
                    ...base,
                    capCode: 'CAP_PER_TX',
                    decision: 'block',
                    reason: `Trade of ${usd(value)} exceeds the ${request.userSwapCaps ? 'per-user' : `\`${tier}\` tier`} per-transaction cap of ${usd(perTxCap)}.`,
                },
            };
        }
        // 2. Rolling windows, when per-user caps and confirmed volume are supplied.
        if (request.userSwapCaps && request.userSwapVolume) {
            const { perDayUsdCap, perWeekUsdCap } = request.userSwapCaps;
            const { last24hUsd, last7dUsd } = request.userSwapVolume;
            if (last24hUsd + value > perDayUsdCap) {
                return {
                    analysis: {
                        ...base,
                        capCode: 'CAP_DAILY',
                        decision: 'block',
                        reason: `Trade of ${usd(value)} would exceed the rolling 24-hour cap of ${usd(perDayUsdCap)} (${usd(last24hUsd)} already confirmed).`,
                        remainingDailyVolumeUsd: Math.max(0, perDayUsdCap - last24hUsd),
                    },
                };
            }
            if (last7dUsd + value > perWeekUsdCap) {
                return {
                    analysis: {
                        ...base,
                        capCode: 'CAP_WEEKLY',
                        decision: 'block',
                        reason: `Trade of ${usd(value)} would exceed the rolling 7-day cap of ${usd(perWeekUsdCap)} (${usd(last7dUsd)} already confirmed).`,
                    },
                };
            }
            base.remainingDailyVolumeUsd = Math.max(0, perDayUsdCap - last24hUsd - value);
        }
        // 3. Slippage clamp on large notionals.
        let modifiedArguments;
        const parameterAdjustments = {};
        if (value >= this.mevNotionalThresholdUsd) {
            for (const key of SLIPPAGE_PCT_KEYS) {
                const raw = request.arguments?.[key];
                if (typeof raw === 'number' && raw > this.maxSlippagePct) {
                    modifiedArguments = { ...request.arguments, ...modifiedArguments, [key]: this.maxSlippagePct };
                    parameterAdjustments[key] = { from: raw, to: this.maxSlippagePct };
                    warnings.push(`Slippage reduced to ${this.maxSlippagePct}% for MEV protection (was ${raw}%).`);
                }
            }
            const maxBps = this.maxSlippagePct * 100;
            for (const key of SLIPPAGE_BPS_KEYS) {
                const raw = request.arguments?.[key];
                if (typeof raw === 'number' && raw > maxBps) {
                    modifiedArguments = { ...request.arguments, ...modifiedArguments, [key]: maxBps };
                    parameterAdjustments[key] = { from: raw, to: maxBps };
                    warnings.push(`Slippage reduced to ${maxBps} bps for MEV protection (was ${raw} bps).`);
                }
            }
        }
        if (Object.keys(parameterAdjustments).length > 0) {
            base.parameterAdjustments = parameterAdjustments;
        }
        // 4. Auto-execute ceiling: allowed, but a human signs off.
        if (value > this.autoExecuteCeilingUsd) {
            return {
                analysis: {
                    ...base,
                    decision: 'require_approval',
                    reason: `Trade of ${usd(value)} exceeds the auto-execute ceiling of ${usd(this.autoExecuteCeilingUsd)}; human approval required.`,
                },
                modifiedArguments,
            };
        }
        return {
            analysis: {
                ...base,
                reason: value > 0
                    ? `Trade of ${usd(value)} is within the ${usd(perTxCap)} per-transaction cap.`
                    : 'No USD notional resolved; dollar caps compared against $0.',
            },
            modifiedArguments,
        };
    }
}
