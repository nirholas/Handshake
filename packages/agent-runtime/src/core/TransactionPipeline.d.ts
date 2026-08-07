/**
 * TransactionPipeline - Orchestrates multi-step DeFi transaction execution with
 * dependency resolution, rollback on failure, gas estimation, and human approval gates.
 *
 * This is the "execution engine" that takes a `DeFiPlan` from the `DeFiIntentEngine`
 * and executes each step in topological order, handling:
 *
 * 1. **Dependency resolution**: Steps only execute when all `dependsOn` steps are complete
 * 2. **Parallel execution**: Independent steps (no shared dependencies) run concurrently
 * 3. **Rollback on failure**: If a step fails, its `rollbackAction` (and cascading dependents) are rolled back
 * 4. **Gas estimation**: Pre-execution gas check to prevent wasted transactions
 * 5. **Human approval gates**: Steps with `requiresApproval: true` pause for user confirmation
 * 6. **Simulation preflight**: Simulation steps run first and abort the plan if they detect issues
 * 7. **Timeout management**: Each step has a configurable timeout with grace period
 * 8. **Event emission**: Every state transition emits events for UI updates
 *
 * The pipeline is non-custodial - it produces unsigned transaction instructions
 * that the wallet-connected frontend must sign and broadcast.
 *
 * Credits: Inspired by Gelato Relay, Safe{Wallet} transaction batching, and
 * LI.FI multi-hop bridge patterns. Built for three.ws as open-source innovation.
 */
import type { DeFiPlan, PlanStep } from './toolRegistry.js';
/** Execution status for a single step */
export type StepStatus = 'pending' | 'waiting_approval' | 'executing' | 'simulating' | 'completed' | 'failed' | 'rolled_back' | 'skipped' | 'timed_out';
/** Result of a single step execution */
export interface StepResult {
    stepId: string;
    status: StepStatus;
    /** Data returned from the tool execution */
    data?: unknown;
    /** Error message if failed */
    error?: string;
    /** Gas actually consumed (USD) */
    gasUsedUsd?: number;
    /** Transaction hash if on-chain */
    txHash?: string;
    /** Execution time in milliseconds */
    executionTimeMs: number;
    /** Timestamp */
    completedAt: string;
}
/** Overall pipeline execution state */
export type PipelineStatus = 'idle' | 'executing' | 'paused_for_approval' | 'completed' | 'failed' | 'rolled_back' | 'aborted';
/** Complete pipeline execution record */
export interface PipelineExecution {
    /** Pipeline ID */
    id: string;
    /** Reference to the plan being executed */
    planId: string;
    /** Current pipeline status */
    status: PipelineStatus;
    /** Results per step */
    stepResults: Map<string, StepResult>;
    /** Steps currently waiting for approval */
    pendingApprovals: string[];
    /** Steps currently executing */
    activeSteps: string[];
    /** Total gas consumed so far (USD) */
    totalGasUsedUsd: number;
    /** Pipeline start time */
    startedAt: string;
    /** Pipeline completion time */
    completedAt?: string;
    /** Rollback steps executed */
    rollbacksExecuted: string[];
}
/** Configuration for the pipeline */
export interface PipelineConfig {
    /** Maximum time per step in ms (default: 120_000 = 2 minutes) */
    stepTimeoutMs: number;
    /** Maximum total pipeline time in ms (default: 600_000 = 10 minutes) */
    totalTimeoutMs: number;
    /** Whether to auto-skip simulation failures (default: false - abort on sim failure) */
    skipFailedSimulations: boolean;
    /** Maximum gas budget in USD (default: Infinity) */
    maxGasBudgetUsd: number;
    /** Whether to execute rollbacks on failure (default: true) */
    enableRollbacks: boolean;
    /** Maximum parallel step executions (default: 3) */
    maxParallelSteps: number;
    /**
     * Optional pre-flight guard run before each step executes (after the approval gate).
     * Use it to register the per-agent `SpendGuard` envelope + firewall alongside `DeFiGuard`.
     * When absent, every step passes pre-flight (no behaviour change).
     */
    preflight?: PipelinePreflight;
    /**
     * Optional hook invoked after every step result is finalised (success or failure). Used to
     * feed confirmed outflow back into a spend tracker via `SpendGuard.recordSpend`. Never
     * throws into the money path - errors are swallowed and logged.
     */
    onStepExecuted?: (step: PlanStep, result: StepResult) => void | Promise<void>;
}
/** Event types emitted by the pipeline */
export type PipelineEventType = 'pipeline_started' | 'step_started' | 'step_completed' | 'step_failed' | 'approval_required' | 'approval_received' | 'simulation_passed' | 'simulation_failed' | 'rollback_started' | 'rollback_completed' | 'pipeline_completed' | 'pipeline_failed' | 'pipeline_aborted' | 'gas_budget_exceeded';
export interface PipelineEvent {
    type: PipelineEventType;
    stepId?: string;
    data?: unknown;
    timestamp: string;
}
/** Tool executor function signature (injected by the runtime) */
export type ToolExecutor = (toolIdentifier: string, apiName: string, args: Record<string, unknown>) => Promise<{
    data: unknown;
    isSuccess: boolean;
    txHash?: string;
    gasUsedUsd?: number;
}>;
/** Result of a pre-flight guard check on a single step. */
export interface PreflightResult {
    /** Whether the step is cleared to execute. */
    allowed: boolean;
    /** Deterministic reason (surfaced when blocked). */
    reason?: string;
    /** Structured block code (e.g. a `SpendGuard` `SpendBlockCode`). */
    code?: string;
}
/**
 * Pre-flight guard invoked immediately before a step executes (after any approval gate).
 * A blocked result aborts the step - and, like any fatal step failure, triggers rollback of
 * already-completed steps. Register `SpendGuard` (and any other quantitative guard) here to
 * run alongside `DeFiGuard`'s risk analysis. Returning `{ allowed: true }` is a pass-through.
 */
export type PipelinePreflight = (step: PlanStep) => Promise<PreflightResult> | PreflightResult;
export declare class TransactionPipeline {
    private config;
    private eventListeners;
    constructor(config?: Partial<PipelineConfig>);
    /** Subscribe to pipeline events */
    onEvent(listener: (event: PipelineEvent) => void): () => void;
    private emit;
    /**
     * Validate a plan before execution. Returns a list of issues.
     */
    validatePlan(plan: DeFiPlan): string[];
    /**
     * Get the topological execution order, resolving dependencies.
     * Returns steps grouped into parallel batches.
     */
    getExecutionOrder(plan: DeFiPlan): PlanStep[][];
    /**
     * Execute a DeFi plan step by step.
     *
     * @param plan - The plan to execute
     * @param executor - Tool executor function (injected by runtime)
     * @param approvalCallback - Called when a step needs human approval; returns true to proceed
     */
    execute(plan: DeFiPlan, executor: ToolExecutor, approvalCallback?: (step: PlanStep) => Promise<boolean>): Promise<PipelineExecution>;
    /**
     * Abort a running pipeline.
     */
    abort(execution: PipelineExecution): void;
    private _executeStep;
    /**
     * Fire the `onStepExecuted` hook, never throwing into the money path.
     * A stalled spend tracker must not block or revert a transaction that already landed.
     */
    private _notifyStepExecuted;
    private _executeRollbacks;
    private _executeWithTimeout;
}
