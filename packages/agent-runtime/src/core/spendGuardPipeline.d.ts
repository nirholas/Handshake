/**
 * spendGuardPipeline - glue between {@link SpendGuard} and {@link TransactionPipeline}.
 *
 * Keeps the two decoupled: the pipeline exposes generic `preflight` / `onStepExecuted` hooks,
 * and this module adapts a `SpendGuard` to them. Wire it once when constructing the pipeline:
 *
 * ```ts
 * const guard = new SpendGuard(await spendLimitModel.findByAgent(agentId));
 * const base = { agentId, userId, balanceUsd };
 * const pipeline = new TransactionPipeline({
 *   preflight: createSpendPreflight(guard, base),
 *   onStepExecuted: createSpendRecorder(guard, base),
 * });
 * ```
 *
 * Registered alongside `DeFiGuard`, this enforces the quantitative envelope (per-tx max,
 * rolling/daily caps, reserve floor) and the token/target firewall on every mutating step.
 */
import type { SpendGuard, SpendTx } from './SpendGuard.js';
import type { PlanStep } from './toolRegistry.js';
import type { PipelinePreflight, StepResult } from './TransactionPipeline.js';
/** Per-run context the pipeline can't derive from a `PlanStep` alone. */
export interface SpendContext {
    agentId: string;
    userId?: string;
    /** Current agent wallet balance (USD) - required to enforce the reserve floor. */
    balanceUsd?: number;
}
/**
 * Build a {@link SpendTx} from a plan step, or `null` if the step is not value-moving
 * (simulation / read-only / inflow actions are not spend-guarded).
 *
 * Note: a value-moving step is always resolved even when no USD amount is parseable - the
 * resulting `valueUsd: 0` passes the caps harmlessly but keeps the **firewall** in force, so a
 * deny-listed token/destination can never slip through on an unparseable amount.
 */
export declare function spendTxFromStep(step: PlanStep, ctx: SpendContext): SpendTx | null;
/**
 * Create a pipeline `preflight` that gates every value-moving step through the spend envelope.
 * Steps that move no value pass through untouched.
 */
export declare function createSpendPreflight(guard: SpendGuard, ctx: SpendContext, resolve?: (step: PlanStep, ctx: SpendContext) => SpendTx | null): PipelinePreflight;
/**
 * Create a pipeline `onStepExecuted` hook that records confirmed outflow back into the guard's
 * rolling/daily windows, so caps stay live across the steps of a multi-step plan. Only
 * successfully-completed, value-moving steps are recorded.
 */
export declare function createSpendRecorder(guard: SpendGuard, ctx: SpendContext, resolve?: (step: PlanStep, ctx: SpendContext) => SpendTx | null): (step: PlanStep, result: StepResult) => void;
