import { ChatToolPayload } from '../types/vendor.js';
import { Agent, AgentEvent, AgentRuntimeContext, AgentState, Cost, RuntimeConfig, Usage } from '../types/index.js';
/**
 * Simplified Agent Runtime - The "Engine" that executes instructions from an "Agent" (Brain).
 * Now includes built-in call_llm support and allows full executor customization.
 */
export declare class AgentRuntime {
    private agent;
    private config;
    private executors;
    private operationId?;
    private getOperation?;
    constructor(agent: Agent, config?: RuntimeConfig);
    /**
     * Get operation context (sessionId, topicId, etc.)
     * Returns the business context captured by the operation
     */
    getContext(): Record<string, any>;
    /**
     * Get operation abort controller
     * Returns the AbortController for cancellation
     */
    getAbortController(): AbortController | undefined;
    /**
     * Executes a single step of the Plan -> Execute loop.
     * @param state - Current agent state
     * @param context - Runtime context for this step (required for proper phase detection)
     */
    step(state: AgentState, context?: AgentRuntimeContext): Promise<{
        events: AgentEvent[];
        newState: AgentState;
        nextContext?: AgentRuntimeContext;
    }>;
    /**
     * Convenience method for approving and executing a tool call
     */
    approveToolCall(state: AgentState, approvedToolCall: ChatToolPayload): Promise<{
        events: AgentEvent[];
        newState: AgentState;
        nextContext?: AgentRuntimeContext;
    }>;
    /**
     * Interrupt the current execution
     * @param state - Current agent state
     * @param reason - Reason for interruption
     * @param canResume - Whether the interruption can be resumed later
     * @param metadata - Additional metadata about the interruption
     */
    interrupt(state: AgentState, reason: string, canResume?: boolean, metadata?: Record<string, unknown>): {
        events: AgentEvent[];
        newState: AgentState;
    };
    /**
     * Resume execution from an interrupted state
     * @param state - Interrupted agent state
     * @param reason - Reason for resumption
     * @param context - Optional context to resume with
     */
    resume(state: AgentState, reason?: string, context?: AgentRuntimeContext): Promise<{
        events: AgentEvent[];
        newState: AgentState;
        nextContext?: AgentRuntimeContext;
    }>;
    /**
     * Create default usage statistics structure
     * @returns Default Usage object with all counters set to 0
     */
    static createDefaultUsage(): Usage;
    /**
     * Create default cost structure
     * @returns Default Cost object with all costs set to 0
     */
    static createDefaultCost(): Cost;
    /**
     * Create a new agent state with flexible initialization
     * @param partialState - Partial state to override defaults
     * @returns Complete AgentState with defaults filled in
     */
    static createInitialState(partialState?: Partial<AgentState> & {
        operationId: string;
    }): AgentState;
    /** Create call_llm executor with streaming support */
    private createCallLLMExecutor;
    /** Create call_tool executor */
    private createCallToolExecutor;
    /** Create human approve executor */
    private createHumanApproveExecutor;
    /** Create human prompt executor */
    private createHumanPromptExecutor;
    /** Create human select executor */
    private createHumanSelectExecutor;
    /** Create finish executor */
    private createFinishExecutor;
    /**
     * Execute multiple tool calls concurrently
     */
    private executeToolsBatch;
    /**
     * Merge multiple tool execution results
     */
    private mergeToolResults;
    /**
     * Handle cost limit exceeded scenario
     */
    private handleCostLimitExceeded;
    /**
     * Create session context metadata - reusable helper
     * Note: Uses sessionId in context for backwards compatibility with AgentRuntimeContext
     */
    private createSessionContext;
    /**
     * Create initial context for the first step (fallback for backward compatibility)
     */
    private createInitialContext;
    /** Create error state and events */
    private createErrorResult;
}
