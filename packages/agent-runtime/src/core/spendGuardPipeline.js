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
/**
 * DeFi actions whose steps move value OUT of the agent wallet (or grant an allowance).
 * Matched against the real `DeFiAction` union - inflow/neutral actions (withdraw, unstake,
 * claim, borrow, remove_liquidity, redeem, revoke_approval, simulate) are intentionally
 * excluded so a user reclaiming their own funds never trips a spend cap. `approve` is included
 * because the firewall must gate *who* the agent grants an allowance to, even though the approve
 * itself carries no USD amount. Any NEW value-moving `DeFiAction` must be added here.
 */
const VALUE_MOVING_ACTIONS = new Set([
    'swap',
    'bridge',
    'deposit',
    'stake',
    'add_liquidity',
    'repay',
    'mint',
    'create_dca',
    'create_limit_order',
    'approve',
]);
/** Argument keys that carry the USD value of a step (widest-first). */
const VALUE_KEYS = ['valueUsd', 'amountUsd', 'value', 'amount', 'positionValue', 'totalValue'];
/** Argument keys that carry the moving token. */
const TOKEN_KEYS = ['token', 'fromToken', 'asset', 'symbol', 'tokenIn'];
/** Argument keys that carry the destination address. */
const DEST_KEYS = ['destination', 'recipient', 'to', 'toAddress', 'target', 'spender'];
function firstNumber(args, keys) {
    for (const key of keys) {
        const val = args[key];
        if (typeof val === 'number' && val > 0)
            return val;
        if (typeof val === 'string') {
            const parsed = Number.parseFloat(val.replace(/[,$]/g, ''));
            if (!Number.isNaN(parsed) && parsed > 0)
                return parsed;
        }
    }
    return 0;
}
function firstString(args, keys) {
    for (const key of keys) {
        const val = args[key];
        if (typeof val === 'string' && val.length > 0)
            return val;
    }
    return undefined;
}
/**
 * Build a {@link SpendTx} from a plan step, or `null` if the step is not value-moving
 * (simulation / read-only / inflow actions are not spend-guarded).
 *
 * Note: a value-moving step is always resolved even when no USD amount is parseable - the
 * resulting `valueUsd: 0` passes the caps harmlessly but keeps the **firewall** in force, so a
 * deny-listed token/destination can never slip through on an unparseable amount.
 */
export function spendTxFromStep(step, ctx) {
    if (step.isSimulation)
        return null;
    if (!VALUE_MOVING_ACTIONS.has(step.action))
        return null;
    return {
        agentId: ctx.agentId,
        balanceUsd: ctx.balanceUsd,
        destination: firstString(step.args, DEST_KEYS),
        token: firstString(step.args, TOKEN_KEYS),
        userId: ctx.userId,
        valueUsd: firstNumber(step.args, VALUE_KEYS),
    };
}
/**
 * Create a pipeline `preflight` that gates every value-moving step through the spend envelope.
 * Steps that move no value pass through untouched.
 */
export function createSpendPreflight(guard, ctx, resolve = spendTxFromStep) {
    return (step) => {
        const tx = resolve(step, ctx);
        if (!tx)
            return { allowed: true };
        const result = guard.check(tx);
        return { allowed: result.allowed, code: result.code, reason: result.reason };
    };
}
/**
 * Create a pipeline `onStepExecuted` hook that records confirmed outflow back into the guard's
 * rolling/daily windows, so caps stay live across the steps of a multi-step plan. Only
 * successfully-completed, value-moving steps are recorded.
 */
export function createSpendRecorder(guard, ctx, resolve = spendTxFromStep) {
    return (step, result) => {
        if (result.status !== 'completed')
            return;
        const tx = resolve(step, ctx);
        if (!tx)
            return;
        guard.recordSpend(tx.agentId, tx.valueUsd);
    };
}
