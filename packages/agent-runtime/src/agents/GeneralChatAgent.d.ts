import { Agent, AgentInstruction, AgentRuntimeContext, AgentState, GeneralAgentConfig } from '../types/index.js';
/**
 * ChatAgent - The "Brain" of the chat agent
 *
 * This agent implements a simple but powerful decision loop:
 * 1. user_input → call_llm (with optional RAG/Search preprocessing)
 * 2. llm_result → check for tool_calls and intervention requirements
 *    - Tools not requiring intervention → call_tools_batch (execute immediately)
 *    - Tools requiring intervention → request_human_approve (wait for approval)
 *    - Mixed (both types) → [call_tools_batch, request_human_approve] (execute safe ones first, then request approval)
 *    - No tool_calls → finish
 * 3. tools_batch_result → call_llm (process tool results)
 *
 */
export declare class GeneralChatAgent implements Agent {
    private config;
    private defiGuard?;
    constructor(config: GeneralAgentConfig);
    /**
     * Get intervention configuration for a specific tool call
     */
    private getToolInterventionConfig;
    /**
     * Check if tool calls need human intervention
     * Combines user's global config with tool's own config
     * Includes DeFi Guard analysis for mutating DeFi operations
     * Returns [toolsNeedingIntervention, toolsToExecute]
     */
    private checkInterventionNeeded;
    /**
     * Extract abort information from current context and state
     * Returns the necessary data to handle abort scenario
     */
    private extractAbortInfo;
    /**
     * Find existing compression summary from messages
     * Looks for MessageGroup with type 'compression' and extracts its content
     */
    private findExistingSummary;
    /**
     * Handle abort scenario - unified abort handling logic
     */
    private handleAbort;
    runner(context: AgentRuntimeContext, state: AgentState): Promise<AgentInstruction | AgentInstruction[]>;
}
