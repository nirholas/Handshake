/**
 * GuardChain - unified, composable evaluation of every three.ws enforcement layer.
 *
 * The runtime ships six independent guards, but each is invoked from a different
 * place, in a different order, with different inputs:
 *
 * | Guard                | Invoked from                          | Gates            |
 * |----------------------|---------------------------------------|------------------|
 * | InterventionChecker  | `GeneralChatAgent.runner()`           | human approval   |
 * | DeFiGuard            | `ToolExecutionService.executeTool()`   | risk + MEV       |
 * | CapabilityGuard      | executor decorator (`call_tool` only) | capability token |
 * | PermissionGuard      | executor decorator (`call_tool` only) | agent permission |
 * | SpendGuard           | `TransactionPipeline` preflight        | spend envelope   |
 * | X402Hook             | the x402 payment path                  | autonomy budget  |
 *
 * Nothing composes them, so no single caller can answer the two questions that
 * matter before money moves:
 *
 *   1. **Which layer would stop this call, and why?**
 *   2. **Which layers would silently _not_ evaluate it at all?**
 *
 * Question 2 is the important one. A guard that never runs looks exactly like a
 * guard that passed - `DeFiGuard` on a tool identifier that was never registered
 * returns `allow`; the dollar caps on a call whose `valueUsd` was never resolved
 * compare against `0` and pass; the executor-decorator guards are skipped
 * entirely for tools dispatched in a batch. Every one of those reads as "green".
 *
 * `GuardChain` runs all six in a deterministic order over one request, returns a
 * per-layer trace, and - the novel part - derives a set of {@link GuardBlindSpot}
 * findings describing the enforcement that *should* have applied but didn't,
 * together with a {@link GuardChainVerdict.coverageScore} quantifying the gap.
 *
 * It is pure and I/O-free. Every external dependency (capability lookup,
 * permission lookup, clocks) is injected, so the same code path serves live
 * preflight, the simulator UI, and tests.
 *
 * @example
 * ```ts
 * const chain = new GuardChain({
 *   defiGuard: new DeFiGuard(),
 *   spendGuard: new SpendGuard({ perTxMaxUsd: 5_000 }),
 * });
 *
 * const verdict = await chain.evaluate({
 *   apiName: 'executeSwap',
 *   arguments: { amount: '2.5', chainId: 1, fromToken: 'ETH', toToken: 'USDC' },
 *   identifier: 'solana_swap',
 *   valueUsd: 18_400,
 * });
 *
 * verdict.decision;       // 'require_approval'
 * verdict.blockedBy;      // undefined
 * verdict.coverageScore;  // 100
 * ```
 */
import type { HumanInterventionConfig, SecurityBlacklistRule } from '../types/vendor.js';
import type { CapabilityCheckFn } from './CapabilityGuard.js';
import { type DeFiGuard, type UserSwapCaps, type UserSwapVolume } from './toolRegistry.js';
import type { PermissionCheckFn } from './PermissionGuard.js';
import type { PortfolioPosition } from './toolRegistry.js';
import type { SpendGuard } from './SpendGuard.js';
import type { X402Hook, X402PaymentRequirements } from '../types/runtime.js';
/** The six enforcement layers, in the order `GuardChain` evaluates them. */
export type GuardLayerId = 'security_blacklist' | 'intervention' | 'capability' | 'permission' | 'defi_guard' | 'spend_guard' | 'x402';
/**
 * Outcome of a single layer.
 *
 * `skipped` is deliberately distinct from `pass`: it means the layer did not
 * evaluate this call at all. Collapsing the two is precisely the failure mode
 * this module exists to surface.
 */
export type GuardLayerStatus = 'pass' | 'warn' | 'approval_required' | 'block' | 'skipped' | 'error';
/** Result of one layer's evaluation. */
export interface GuardLayerResult {
    /** Structured reason code, where the layer produces one. */
    code?: string;
    /** Layer-specific payload (risk report, MEV assessment, remaining allowance…). */
    detail?: Record<string, unknown>;
    /** Wall-clock milliseconds this layer took. */
    elapsedMs: number;
    /** Human-readable layer name, safe to render directly. */
    label: string;
    layer: GuardLayerId;
    /** Deterministic, human-readable explanation of the status. */
    reason: string;
    status: GuardLayerStatus;
}
/** Structural enforcement gaps derived from the request shape. */
export type BlindSpotCode = 
/** A DeFi-registered mutating call arrived without an authoritative USD value. */
'VALUE_UNRESOLVED'
/** The API mutates on-chain state but the tool identifier is not registered with DeFiGuard. */
 | 'TOOL_UNREGISTERED'
/** Dispatched via `call_tools_batch`, which bypasses the executor-decorator guards. */
 | 'BATCH_BYPASS'
/** A value-moving call with no spend envelope configured. */
 | 'SPEND_UNSCOPED'
/** The target protocol is absent from the audit registry, so it reads as unaudited. */
 | 'PROTOCOL_UNVERIFIED'
/** No capability-token checker was wired into this evaluation. */
 | 'CAPABILITY_UNWIRED'
/** No permission checker was wired into this evaluation. */
 | 'PERMISSION_UNWIRED'
/** A read-only call that DeFiGuard skipped by configuration. */
 | 'READONLY_UNANALYZED';
/** One derived enforcement gap. */
export interface GuardBlindSpot {
    code: BlindSpotCode;
    /** What is actually not being checked, in concrete terms. */
    detail: string;
    /** The layer whose coverage is degraded. */
    layer: GuardLayerId;
    /** The specific action that closes the gap. */
    remediation: string;
    severity: 'info' | 'warning' | 'critical';
    title: string;
}
/** The composed result of a full chain evaluation. */
export interface GuardChainVerdict {
    /** Enforcement gaps derived from the request shape, ordered critical-first. */
    blindSpots: GuardBlindSpot[];
    /** The first layer that returned `block`, if any. */
    blockedBy?: GuardLayerId;
    /** Structured code from the deciding layer. */
    code?: string;
    /**
     * Percentage (0-100) of the enforcement weight that *should* apply to this
     * request and actually evaluated it. A verdict of `allow` at 45% coverage is
     * a materially weaker statement than the same verdict at 100%.
     */
    coverageScore: number;
    /** Strongest outcome across all layers. */
    decision: 'allow' | 'require_approval' | 'block';
    evaluatedAt: number;
    /** Per-layer trace, in evaluation order. */
    layers: GuardLayerResult[];
    /** MEV-protected argument adjustments proposed by DeFiGuard. */
    modifiedArguments?: Record<string, unknown>;
    /** Human-readable explanation attributable to the deciding layer. */
    reason: string;
    totalElapsedMs: number;
    /** Non-blocking advisories aggregated from every layer. */
    warnings: string[];
}
/** x402 payment context, supplied only when the call is a paid HTTP request. */
export interface GuardChainX402Input {
    /** USDC already spent by this agent in the current hour. */
    amountSpentThisHourUsdc: number;
    /** Live USDC balance of the agent wallet. */
    currentBalanceUsdc: number;
    /** Structured payment requirements from the `X-PAYMENT-REQUIRED` header. */
    requirements: X402PaymentRequirements;
    /** The URL that returned 402. */
    url: string;
}
/** One tool call to evaluate against the full enforcement surface. */
export interface GuardChainRequest {
    /** Agent initiating the call - spend is tracked per agent. */
    agentId?: string;
    /** Tools pre-approved under `allow-list` mode, formatted `identifier/apiName`. */
    allowList?: string[];
    /** Tool API being invoked, e.g. `executeSwap`. */
    apiName: string;
    /** Global approval mode in force for the session. */
    approvalMode?: 'auto-run' | 'allow-list' | 'manual' | 'headless';
    /** Parsed tool arguments. */
    arguments?: Record<string, unknown>;
    /** Agent wallet balance in USD - required to enforce the reserve floor. */
    balanceUsd?: number;
    chainId?: number;
    /** Tool keys the user already confirmed this session. */
    confirmedHistory?: string[];
    /** Destination address, for the spend firewall. */
    destination?: string;
    /**
     * How the call would be dispatched. `batch` (`call_tools_batch`) bypasses the
     * capability and permission executor decorators, which only intercept
     * `call_tool`.
     * @default 'single'
     */
    executionPath?: 'single' | 'batch';
    /** Tool identifier, e.g. `solana_swap`. */
    identifier: string;
    /** Manifest-level or user-override intervention config. */
    interventionConfig?: HumanInterventionConfig;
    /** Portfolio context enabling the risk dimensions. */
    portfolioPositions?: PortfolioPosition[];
    /** Target protocol, checked against the audit registry. */
    protocol?: string;
    /** Blacklist rules; omit to use the runtime default blacklist. */
    securityBlacklist?: SecurityBlacklistRule[];
    /** Token symbol or address moving out, for the spend firewall. */
    token?: string;
    userId?: string;
    /** Per-user caps resolved server-side from `userSwapLimits`. */
    userSwapCaps?: UserSwapCaps;
    /** Confirmed swap volume windows resolved from `executionReceipts`. */
    userSwapVolume?: UserSwapVolume;
    /** Subscription tier driving the tier limits. */
    userTier?: string;
    /**
     * Authoritative USD value, resolved by the caller. Without it the dollar caps
     * compare against zero and pass - see {@link BlindSpotCode.VALUE_UNRESOLVED}.
     */
    valueUsd?: number;
    /** Payment context when the call goes through the x402 path. */
    x402?: GuardChainX402Input;
}
/** Injected dependencies. Every guard is optional; an absent guard is reported. */
export interface GuardChainOptions {
    /** Capability-token validator, normally backed by `capabilityToken` records. */
    checkCapability?: CapabilityCheckFn;
    /** Permission resolver, normally backed by `agentPermission` records. */
    checkPermission?: PermissionCheckFn;
    /** Monotonic millisecond source used for per-layer timing. Injectable for tests. */
    clock?: () => number;
    defiGuard?: DeFiGuard;
    /** Wall-clock source for `evaluatedAt`. Injectable for tests. */
    now?: () => number;
    spendGuard?: SpendGuard;
    x402Hook?: X402Hook;
}
export declare class GuardChain {
    private readonly clock;
    private readonly now;
    private readonly opts;
    constructor(options?: GuardChainOptions);
    /**
     * Run every applicable layer over a single tool call.
     *
     * Layers always run to completion - the chain does not short-circuit on the
     * first block. A partial trace would defeat the purpose: the operator needs to
     * know that a call blocked by the spend envelope *also* carried critical MEV
     * exposure, and that the permission layer never ran at all.
     */
    evaluate(request: GuardChainRequest): Promise<GuardChainVerdict>;
    private runSecurityBlacklist;
    private runIntervention;
    private runCapability;
    private runPermission;
    private runDeFiGuard;
    private runSpendGuard;
    private runX402;
    /**
     * Select the layer that determines the verdict: the highest-severity status,
     * with earlier layers winning ties so the reported reason matches the layer
     * that would actually fire first at runtime.
     */
    private pickDecidingLayer;
    /**
     * Coverage is measured against the layers that *should* apply to this request,
     * not against all seven. Charging a read-only call for skipping the spend
     * envelope would make the number meaningless.
     */
    private computeCoverage;
    /**
     * Derive the enforcement gaps this request would hit. These are structural -
     * they describe checks that did not happen, which no individual guard reports
     * because from its own perspective nothing went wrong.
     */
    private deriveBlindSpots;
}
/** One tool identifier's standing in the enforcement registry. */
export interface GuardCoverageEntry {
    /** Mutating APIs this identifier is known to expose, if any were supplied. */
    apis: string[];
    identifier: string;
    /** Whether DeFiGuard would analyze calls to this identifier. */
    registered: boolean;
}
/** Registry-wide coverage snapshot. */
export interface GuardCoverageReport {
    /** Percentage of supplied identifiers that are registered. */
    coveragePercent: number;
    /** Mutating API names the guard recognises. */
    mutatingApis: string[];
    /** Identifiers DeFiGuard is configured to analyze. */
    registered: GuardCoverageEntry[];
    /** Identifiers supplied by the caller that are absent from the registry. */
    unregistered: GuardCoverageEntry[];
}
/**
 * Compare a set of live tool identifiers against the DeFi enforcement registry.
 *
 * Pass the identifiers actually installed in a deployment to find fund-moving
 * tools that no guard would ever see. With no argument it reports the registry
 * itself.
 */
export declare function analyzeGuardCoverage(installedIdentifiers?: string[]): GuardCoverageReport;
/** Human-readable label for a layer id, for callers rendering a trace. */
export declare function guardLayerLabel(layer: GuardLayerId): string;
/** Relative enforcement weight of a layer, exposed for callers scoring coverage. */
export declare function guardLayerWeight(layer: GuardLayerId): number;
/** The layers `GuardChain` evaluates, in order. */
export declare const GUARD_LAYER_ORDER: GuardLayerId[];
