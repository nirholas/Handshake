import { ModelUsage } from '../types/vendor.js';
import { Cost, Usage } from '../types/usage.js';
/**
 * UsageCounter - Pure accumulator for usage and cost tracking
 * Focuses only on usage/cost calculations without managing state
 */
export declare class UsageCounter {
    /**
     * Create default usage statistics
     */
    private static createDefaultUsage;
    /**
     * Create default cost statistics
     */
    private static createDefaultCost;
    /**
     * Merge two ModelUsage objects by accumulating token counts
     * @param previous - Previous usage statistics
     * @param current - Current usage statistics to add
     * @returns Merged usage statistics
     */
    private static mergeModelUsage;
    /**
     * Accumulate LLM usage and cost for a specific model
     * @param params - Accumulation parameters
     * @param params.usage - Current usage statistics (optional, will be created if not provided)
     * @param params.cost - Current cost statistics (optional, will be created if not provided)
     * @param params.provider - Provider name (e.g., "openai")
     * @param params.model - Model name (e.g., "gpt-4")
     * @param params.modelUsage - ModelUsage from model-runtime
     * @returns Updated usage and cost
     */
    static accumulateLLM(params: {
        cost?: Cost;
        model: string;
        modelUsage: ModelUsage;
        provider: string;
        usage?: Usage;
    }): {
        cost?: Cost;
        usage: Usage;
    };
    /**
     * Accumulate tool usage and cost
     * @param params - Accumulation parameters
     * @param params.usage - Current usage statistics (optional, will be created if not provided)
     * @param params.cost - Current cost statistics (optional, will be created if not provided)
     * @param params.toolName - Tool identifier
     * @param params.executionTime - Execution time in milliseconds
     * @param params.success - Whether the execution was successful
     * @param params.toolCost - Optional cost for this tool call
     * @returns Updated usage and cost
     */
    static accumulateTool(params: {
        cost?: Cost;
        executionTime: number;
        success: boolean;
        toolCost?: number;
        toolName: string;
        usage?: Usage;
    }): {
        cost?: Cost;
        usage: Usage;
    };
}
