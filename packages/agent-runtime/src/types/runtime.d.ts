import type { AgentEvent } from './event.js';
import { AgentInstruction, AgentRuntimeContext } from './instruction.js';
import { AgentState } from './state.js';
export type InstructionExecutor = (instruction: AgentInstruction, state: AgentState, 
/**
 * Runtime context for this step
 * Contains stepContext with dynamic state like GTD todos
 */
context?: AgentRuntimeContext) => Promise<{
    events: AgentEvent[];
    newState: AgentState;
    /** Next context to pass to Agent runner (if execution should continue) */
    nextContext?: AgentRuntimeContext;
}>;
/** The structured 402 payment requirements returned by an x402-gated server */
export interface X402PaymentRequirements {
    accepts: Array<{
        asset: string;
        description: string;
        maxAmountRequired: string;
        network: string;
        payTo: string;
        resource: string;
        scheme: string;
    }>;
    x402Version: number;
}
/** Result returned by the onX402Required hook */
export type X402HookResult = {
    action: 'pay';
} | {
    action: 'queue';
    reason: string;
} | {
    action: 'reject';
    reason: string;
};
/**
 * Hook invoked whenever an agent tool makes an HTTP request that returns 402.
 *
 * The hook must decide one of three actions:
 *
 * - `{ action: 'pay' }` - wallet has sufficient balance and the amount is within
 *   the agent's autonomy budget → proceed with automatic payment.
 *
 * - `{ action: 'queue', reason }` - the payment would exceed the autonomy limit
 *   → push to DecisionQueue for user approval before settling.
 *
 * - `{ action: 'reject', reason }` - balance insufficient or policy blocks payment
 *   → surface a clear error to the agent without crashing.
 */
export type X402Hook = (params: {
    /** Agent identifier making the request */
    agentId: string;
    /** How much USDC was already spent this hour */
    amountSpentThisHourUsdc: number;
    /** Current USDC balance of the agent wallet (live, from Base RPC) */
    currentBalanceUsdc: number;
    /** Full URL that returned 402 */
    url: string;
    /** Structured payment requirements from X-PAYMENT-REQUIRED header */
    requirements: X402PaymentRequirements;
}) => Promise<X402HookResult>;
export interface RuntimeConfig {
    /** Custom executors for specific instruction types */
    executors?: Partial<Record<AgentInstruction['type'], InstructionExecutor>>;
    /** Function to get operation context and abort controller */
    getOperation?: (operationId: string) => {
        abortController: AbortController;
        context: Record<string, any>;
    };
    /** Operation ID for tracking this runtime instance */
    operationId?: string;
    /**
     * Hook called when an agent HTTP request returns 402 Payment Required.
     *
     * Use this to enforce autonomy budgets and route over-limit payments to
     * the DecisionQueue for user approval.
     *
     * If not provided, x402 payments are always attempted automatically
     * (subject to balance checks in the API route).
     */
    onX402Required?: X402Hook;
}
