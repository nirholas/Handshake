/**
 * Fund-moving tool registry + the domain-guard contract.
 *
 * The upstream runtime hardwired these registries to its own tool catalog and
 * shipped a concrete EVM DeFi guard. Here the registries are seeded with the
 * three.ws tool surface (Solana first) and the guard is only a contract: any
 * object implementing {@link DeFiGuard} can occupy the `defi_guard` layer of
 * the GuardChain, so the platform can wire its own trade/risk analysis without
 * this package knowing about chains at all.
 *
 * Both Sets are intentionally mutable: a host installing a new fund-moving
 * tool registers it at boot via {@link registerMutatingApi} /
 * {@link registerFundMovingTool}. An unregistered fund-moving tool is not
 * "unguarded by design", it is a blind spot, and GuardChain reports it as one.
 */
/**
 * API names that mutate on-chain state. Checked against the `apiName` of a
 * tool call. Generic action names cover manifest-style tools; the exact names
 * cover the three.ws chat tool registry.
 */
export declare const MUTATING_APIS: Set<string>;
/**
 * Tool identifiers whose calls a wired domain guard should analyze. In the
 * three.ws chat registry tools are flat, so the identifier equals the API
 * name; manifest-style hosts register their package identifiers instead.
 */
export declare const DEFI_TOOL_IDENTIFIERS: Set<string>;
/** Register an additional mutating API name at host boot. */
export declare function registerMutatingApi(apiName: string): void;
/** Register an additional fund-moving tool identifier at host boot. */
export declare function registerFundMovingTool(identifier: string): void;
/** Audit standing of a protocol, as resolved by the host's registry. */
export type AuditStatus = 'audited' | 'unaudited' | 'unknown';
/** One position in the agent's portfolio, supplied by the host for risk context. */
export interface PortfolioPosition {
    /** Token symbol. */
    token: string;
    /** USD value of the position. */
    valueUsd: number;
    /** Chain the position is on (e.g. `solana`, `base`). */
    chain: string;
    /** Protocol where it is deployed; omit for plain wallet holdings. */
    protocol?: string;
    type: 'wallet' | 'lending_supply' | 'lending_borrow' | 'lp' | 'staking' | 'vault' | 'farm';
    /** For lending: health factor (1.0 = liquidation threshold). */
    healthFactor?: number;
    /** For lending: liquidation threshold as a ratio (e.g. 0.825 for 82.5%). */
    liquidationThreshold?: number;
    /** For LP positions: pair legs and entry-vs-current price ratio. */
    lpTokens?: {
        tokenA: string;
        tokenB: string;
        priceRatioEntry: number;
        priceRatioCurrent: number;
    };
    /** Annualized yield. */
    apy?: number;
    protocolTvl?: number;
    isAudited?: boolean;
    protocolAgeDays?: number;
    /** Outstanding token approvals, from on-chain scanning. */
    approvals?: TokenApproval[];
}
/** One outstanding token approval. */
export interface TokenApproval {
    token: string;
    spender: string;
    /** Approved amount; string for uint256-scale values. */
    amount?: string | number;
    unlimited?: boolean;
}
/** Per-user transaction caps resolved server-side by the host. */
export interface UserSwapCaps {
    /** Maximum USD value per single transaction. */
    perTxUsdCap: number;
    /** Maximum cumulative USD in any rolling 24-hour window. */
    perDayUsdCap: number;
    /** Maximum cumulative USD in any rolling 7-day window. */
    perWeekUsdCap: number;
    /** Whether all swaps must use a private mempool / protected route. */
    privateMempoolRequired?: boolean;
}
/** Confirmed swap volume windows resolved from execution receipts. */
export interface UserSwapVolume {
    last24hUsd: number;
    last7dUsd: number;
}
/** The verdict a domain guard returns for one analyzed call. */
export interface GuardAnalysis {
    /** Whether this was a registered tool that got analyzed. */
    isDeFi: boolean;
    /** Whether the API is a mutating (on-chain) operation. */
    isMutating: boolean;
    /** Risk analysis payload, in whatever shape the host's analyzer produces. */
    riskReport?: Record<string, unknown>;
    /** MEV / sandwich-exposure payload, host-defined shape. */
    mevAssessment?: Record<string, unknown>;
    decision: 'allow' | 'require_approval' | 'block';
    /** Human-readable reason for the decision. */
    reason: string;
    warnings: string[];
    /** Recommended parameter adjustments (e.g. lower slippage). */
    parameterAdjustments?: Record<string, unknown>;
    analyzedAt: number;
    /** Remaining daily volume allocation in USD, when rate-limited. */
    remainingDailyVolumeUsd?: number;
    protocolStatus?: AuditStatus;
    /**
     * Structured cap-breach code when a block came from a per-user cap:
     * `CAP_PER_TX` single tx over the per-tx cap, `CAP_DAILY` would exceed the
     * 24-hour window, `CAP_WEEKLY` would exceed the 7-day window.
     */
    capCode?: 'CAP_PER_TX' | 'CAP_DAILY' | 'CAP_WEEKLY';
}
/** A domain guard's full return value. */
export interface GuardResult {
    analysis: GuardAnalysis;
    /** MEV-protected argument adjustments to apply before execution. */
    modifiedArguments?: Record<string, unknown>;
}
/** The request a domain guard analyzes. */
export interface GuardAnalyzeRequest {
    apiName: string;
    arguments: Record<string, unknown>;
    chainId?: number;
    identifier: string;
    portfolioPositions?: PortfolioPosition[];
    protocol?: string;
    userId?: string;
    userSwapCaps?: UserSwapCaps;
    userSwapVolume?: UserSwapVolume;
    userTier?: string;
    valueUsd?: number;
}
/**
 * The domain-guard contract for the GuardChain's `defi_guard` layer. three.ws
 * wires its own implementation (Solana trade limits, pump.fun heuristics);
 * any object with these three methods qualifies.
 */
export interface DeFiGuard {
    /** Whether calls to this tool identifier should be analyzed at all. */
    isDeFiTool(identifier: string): boolean;
    /** Whether this API name mutates on-chain state. */
    isMutatingApi(apiName: string): boolean;
    analyze(request: GuardAnalyzeRequest): Promise<GuardResult> | GuardResult;
}
/** One step of a multi-step execution plan. */
export interface PlanStep {
    id: string;
    /** The action this step performs (e.g. `swap`, `bridge`, `approve`). */
    action: string;
    /** Which tool to invoke. */
    toolIdentifier: string;
    apiName: string;
    args: Record<string, unknown>;
    /** Steps that must complete before this one, by id. */
    dependsOn: string[];
    description: string;
    /** Estimated gas cost in USD (0 for read-only). */
    estimatedGasUsd: number;
    riskLevel: 'low' | 'medium' | 'high' | 'critical';
    requiresApproval: boolean;
    /** Rollback action if this step fails. */
    rollbackAction?: {
        toolIdentifier: string;
        apiName: string;
        args: Record<string, unknown>;
        description: string;
    };
    /** Whether this is a simulation / read-only step. */
    isSimulation: boolean;
}
/** A parsed multi-step execution plan, produced by a host-side planner. */
export interface DeFiPlan {
    id: string;
    /** Original user intent, verbatim. */
    originalIntent: string;
    /** Parsed intent category, host-defined. */
    category: string;
    /** Ordered steps, respecting the dependency graph. */
    steps: PlanStep[];
    riskLevel: 'low' | 'medium' | 'high' | 'critical';
    totalEstimatedGasUsd: number;
    /** Whether the plan requires any wallet interaction. */
    requiresWallet: boolean;
    chains: string[];
    tokens: string[];
    /** How well the planner understood the intent (0-1). */
    confidence: number;
    warnings: string[];
    createdAt: string;
}
