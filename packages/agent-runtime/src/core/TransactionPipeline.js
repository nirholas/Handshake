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
import { debuglog } from 'node:util';
const log = debuglog('three-ws-agent-runtime-tx-pipeline');
// ─── Default Config ──────────────────────────────────────────────────────────
const DEFAULT_CONFIG = {
    enableRollbacks: true,
    maxGasBudgetUsd: Infinity,
    maxParallelSteps: 3,
    skipFailedSimulations: false,
    stepTimeoutMs: 120_000,
    totalTimeoutMs: 600_000,
};
// ─── Pipeline ────────────────────────────────────────────────────────────────
export class TransactionPipeline {
    config;
    eventListeners = [];
    constructor(config = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
    }
    /** Subscribe to pipeline events */
    onEvent(listener) {
        this.eventListeners.push(listener);
        return () => {
            this.eventListeners = this.eventListeners.filter((l) => l !== listener);
        };
    }
    emit(event) {
        for (const listener of this.eventListeners) {
            try {
                listener(event);
            }
            catch {
                // swallow listener errors
            }
        }
    }
    /**
     * Validate a plan before execution. Returns a list of issues.
     */
    validatePlan(plan) {
        const issues = [];
        // Check for empty plans
        if (plan.steps.length === 0) {
            issues.push('Plan has no steps to execute.');
            return issues;
        }
        // Check for circular dependencies
        const visited = new Set();
        const visiting = new Set();
        const stepMap = new Map(plan.steps.map((s) => [s.id, s]));
        const hasCycle = (stepId) => {
            if (visiting.has(stepId))
                return true;
            if (visited.has(stepId))
                return false;
            visiting.add(stepId);
            const step = stepMap.get(stepId);
            if (step) {
                for (const dep of step.dependsOn) {
                    if (hasCycle(dep))
                        return true;
                }
            }
            visiting.delete(stepId);
            visited.add(stepId);
            return false;
        };
        for (const step of plan.steps) {
            if (hasCycle(step.id)) {
                issues.push(`Circular dependency detected involving step ${step.id}`);
                break;
            }
        }
        // Check for missing dependencies
        const allIds = new Set(plan.steps.map((s) => s.id));
        for (const step of plan.steps) {
            for (const dep of step.dependsOn) {
                if (!allIds.has(dep)) {
                    issues.push(`Step ${step.id} depends on non-existent step ${dep}`);
                }
            }
        }
        // Check gas budget
        if (plan.totalEstimatedGasUsd > this.config.maxGasBudgetUsd) {
            issues.push(`Estimated gas ($${plan.totalEstimatedGasUsd.toFixed(2)}) exceeds budget ($${this.config.maxGasBudgetUsd.toFixed(2)})`);
        }
        return issues;
    }
    /**
     * Get the topological execution order, resolving dependencies.
     * Returns steps grouped into parallel batches.
     */
    getExecutionOrder(plan) {
        const stepMap = new Map(plan.steps.map((s) => [s.id, s]));
        const completed = new Set();
        const batches = [];
        let remaining = [...plan.steps];
        while (remaining.length > 0) {
            // Find all steps whose dependencies are all completed
            const ready = remaining.filter((s) => s.dependsOn.every((dep) => completed.has(dep)));
            if (ready.length === 0) {
                // This should not happen if validatePlan() passed - indicates a cycle
                log('deadlock detected: %d steps remaining with unmet dependencies', remaining.length);
                break;
            }
            // Respect max parallel limit
            const batch = ready.slice(0, this.config.maxParallelSteps);
            batches.push(batch);
            for (const step of batch) {
                completed.add(step.id);
            }
            remaining = remaining.filter((s) => !completed.has(s.id));
        }
        return batches;
    }
    /**
     * Execute a DeFi plan step by step.
     *
     * @param plan - The plan to execute
     * @param executor - Tool executor function (injected by runtime)
     * @param approvalCallback - Called when a step needs human approval; returns true to proceed
     */
    async execute(plan, executor, approvalCallback) {
        const execution = {
            activeSteps: [],
            completedAt: undefined,
            id: `exec_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`,
            pendingApprovals: [],
            planId: plan.id,
            rollbacksExecuted: [],
            startedAt: new Date().toISOString(),
            status: 'executing',
            stepResults: new Map(),
            totalGasUsedUsd: 0,
        };
        // Validate first
        const issues = this.validatePlan(plan);
        if (issues.length > 0) {
            log('plan validation failed: %o', issues);
            execution.status = 'failed';
            execution.completedAt = new Date().toISOString();
            return execution;
        }
        this.emit({ data: { planId: plan.id }, timestamp: new Date().toISOString(), type: 'pipeline_started' });
        const batches = this.getExecutionOrder(plan);
        const pipelineStart = Date.now();
        for (const batch of batches) {
            // Check total timeout
            if (Date.now() - pipelineStart > this.config.totalTimeoutMs) {
                log('pipeline total timeout exceeded');
                execution.status = 'failed';
                break;
            }
            // Execute batch (parallel within batch, sequential between batches)
            const batchPromises = batch.map(async (step) => {
                return this._executeStep(step, executor, approvalCallback, execution);
            });
            const results = await Promise.allSettled(batchPromises);
            // Check for failures
            let hasFatalFailure = false;
            for (const result of results) {
                if (result.status === 'rejected') {
                    hasFatalFailure = true;
                }
                else if (result.value.status === 'failed' || result.value.status === 'timed_out') {
                    const failedStep = plan.steps.find((s) => s.id === result.value.stepId);
                    if (failedStep?.isSimulation && !this.config.skipFailedSimulations) {
                        log('simulation step %s failed - aborting pipeline', result.value.stepId);
                        this.emit({
                            data: { error: result.value.error },
                            stepId: result.value.stepId,
                            timestamp: new Date().toISOString(),
                            type: 'simulation_failed',
                        });
                        hasFatalFailure = true;
                    }
                    else if (!failedStep?.isSimulation) {
                        hasFatalFailure = true;
                    }
                }
            }
            if (hasFatalFailure) {
                execution.status = 'failed';
                // Execute rollbacks if enabled
                if (this.config.enableRollbacks) {
                    await this._executeRollbacks(plan, execution, executor);
                }
                break;
            }
            // Check gas budget
            if (execution.totalGasUsedUsd > this.config.maxGasBudgetUsd) {
                log('gas budget exceeded: $%d > $%d', execution.totalGasUsedUsd, this.config.maxGasBudgetUsd);
                this.emit({ timestamp: new Date().toISOString(), type: 'gas_budget_exceeded' });
                execution.status = 'failed';
                break;
            }
        }
        if (execution.status === 'executing') {
            execution.status = 'completed';
        }
        execution.completedAt = new Date().toISOString();
        this.emit({
            data: { gasUsed: execution.totalGasUsedUsd, status: execution.status },
            timestamp: new Date().toISOString(),
            type: execution.status === 'completed' ? 'pipeline_completed' : 'pipeline_failed',
        });
        log('pipeline %s finished: status=%s, gas=$%d', execution.id, execution.status, execution.totalGasUsedUsd);
        return execution;
    }
    /**
     * Abort a running pipeline.
     */
    abort(execution) {
        execution.status = 'aborted';
        execution.completedAt = new Date().toISOString();
        this.emit({ timestamp: new Date().toISOString(), type: 'pipeline_aborted' });
    }
    // ── Private ──────────────────────────────────────────────────────────────
    async _executeStep(step, executor, approvalCallback, execution) {
        const startTime = Date.now();
        log('executing step %s: %s', step.id, step.description);
        execution.activeSteps.push(step.id);
        this.emit({
            data: { action: step.action, description: step.description },
            stepId: step.id,
            timestamp: new Date().toISOString(),
            type: 'step_started',
        });
        // Human approval gate
        if (step.requiresApproval && approvalCallback) {
            execution.pendingApprovals.push(step.id);
            this.emit({ stepId: step.id, timestamp: new Date().toISOString(), type: 'approval_required' });
            const approved = await approvalCallback(step);
            execution.pendingApprovals = execution.pendingApprovals.filter((id) => id !== step.id);
            if (!approved) {
                const result = {
                    completedAt: new Date().toISOString(),
                    error: 'User rejected step',
                    executionTimeMs: Date.now() - startTime,
                    status: 'skipped',
                    stepId: step.id,
                };
                execution.stepResults.set(step.id, result);
                execution.activeSteps = execution.activeSteps.filter((id) => id !== step.id);
                return result;
            }
            this.emit({ stepId: step.id, timestamp: new Date().toISOString(), type: 'approval_received' });
        }
        // Pre-flight guard gate (SpendGuard envelope + firewall, etc.). A block aborts the step.
        if (this.config.preflight) {
            let preflight;
            try {
                preflight = await this.config.preflight(step);
            }
            catch (error) {
                // A guard that throws must fail closed - never let an error open the money path.
                const errorMsg = error instanceof Error ? error.message : String(error);
                log('preflight guard threw for step %s - failing closed: %s', step.id, errorMsg);
                preflight = { allowed: false, code: 'PREFLIGHT_ERROR', reason: `Pre-flight guard error: ${errorMsg}` };
            }
            if (!preflight.allowed) {
                const reason = preflight.code
                    ? `Spend guard blocked [${preflight.code}]: ${preflight.reason ?? 'blocked by pre-flight guard'}`
                    : `Spend guard blocked: ${preflight.reason ?? 'blocked by pre-flight guard'}`;
                log('step %s blocked by pre-flight guard: %s', step.id, reason);
                const result = {
                    completedAt: new Date().toISOString(),
                    error: reason,
                    executionTimeMs: Date.now() - startTime,
                    status: 'failed',
                    stepId: step.id,
                };
                execution.stepResults.set(step.id, result);
                execution.activeSteps = execution.activeSteps.filter((id) => id !== step.id);
                this.emit({
                    data: { code: preflight.code, error: reason },
                    stepId: step.id,
                    timestamp: new Date().toISOString(),
                    type: 'step_failed',
                });
                await this._notifyStepExecuted(step, result);
                return result;
            }
        }
        try {
            // Execute with timeout
            const toolResult = await this._executeWithTimeout(() => executor(step.toolIdentifier, step.apiName, step.args), step.isSimulation ? this.config.stepTimeoutMs / 2 : this.config.stepTimeoutMs);
            const gasUsed = toolResult.gasUsedUsd ?? 0;
            execution.totalGasUsedUsd += gasUsed;
            const result = {
                completedAt: new Date().toISOString(),
                data: toolResult.data,
                error: toolResult.isSuccess ? undefined : 'Tool execution returned failure',
                executionTimeMs: Date.now() - startTime,
                gasUsedUsd: gasUsed,
                status: toolResult.isSuccess
                    ? step.isSimulation
                        ? 'completed'
                        : 'completed'
                    : 'failed',
                stepId: step.id,
                txHash: toolResult.txHash,
            };
            execution.stepResults.set(step.id, result);
            if (step.isSimulation && toolResult.isSuccess) {
                this.emit({ stepId: step.id, timestamp: new Date().toISOString(), type: 'simulation_passed' });
            }
            this.emit({
                data: result,
                stepId: step.id,
                timestamp: new Date().toISOString(),
                type: toolResult.isSuccess ? 'step_completed' : 'step_failed',
            });
            await this._notifyStepExecuted(step, result);
            return result;
        }
        catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            const isTimeout = errorMsg.includes('timed out');
            const result = {
                completedAt: new Date().toISOString(),
                error: errorMsg,
                executionTimeMs: Date.now() - startTime,
                status: isTimeout ? 'timed_out' : 'failed',
                stepId: step.id,
            };
            execution.stepResults.set(step.id, result);
            this.emit({
                data: { error: errorMsg },
                stepId: step.id,
                timestamp: new Date().toISOString(),
                type: 'step_failed',
            });
            await this._notifyStepExecuted(step, result);
            return result;
        }
        finally {
            execution.activeSteps = execution.activeSteps.filter((id) => id !== step.id);
        }
    }
    /**
     * Fire the `onStepExecuted` hook, never throwing into the money path.
     * A stalled spend tracker must not block or revert a transaction that already landed.
     */
    async _notifyStepExecuted(step, result) {
        if (!this.config.onStepExecuted)
            return;
        try {
            await this.config.onStepExecuted(step, result);
        }
        catch (error) {
            log('onStepExecuted hook threw for step %s (swallowed): %o', step.id, error);
        }
    }
    async _executeRollbacks(plan, execution, executor) {
        // Find completed steps that have rollback actions, in reverse order
        const completedSteps = plan.steps
            .filter((s) => execution.stepResults.get(s.id)?.status === 'completed' &&
            s.rollbackAction &&
            !s.isSimulation)
            .reverse();
        for (const step of completedSteps) {
            if (!step.rollbackAction)
                continue;
            log('rolling back step %s: %s', step.id, step.rollbackAction.description);
            this.emit({
                data: { description: step.rollbackAction.description },
                stepId: step.id,
                timestamp: new Date().toISOString(),
                type: 'rollback_started',
            });
            try {
                await this._executeWithTimeout(() => executor(step.rollbackAction.toolIdentifier, step.rollbackAction.apiName, step.rollbackAction.args), this.config.stepTimeoutMs);
                execution.rollbacksExecuted.push(step.id);
                this.emit({ stepId: step.id, timestamp: new Date().toISOString(), type: 'rollback_completed' });
            }
            catch (error) {
                log('rollback failed for step %s: %o', step.id, error);
                // Rollback failures are logged but don't cascade
            }
        }
        if (completedSteps.length > 0) {
            execution.status = 'rolled_back';
        }
    }
    async _executeWithTimeout(fn, timeoutMs) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error(`Step execution timed out after ${timeoutMs}ms`));
            }, timeoutMs);
            fn()
                .then((result) => {
                clearTimeout(timer);
                resolve(result);
            })
                .catch((error) => {
                clearTimeout(timer);
                reject(error);
            });
        });
    }
}
