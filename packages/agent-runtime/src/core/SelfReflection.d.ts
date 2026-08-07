/**
 * SelfReflection - Adds self-correction and retry logic to agent tool calls.
 *
 * When a tool call fails, instead of raw-feeding the error back to the LLM,
 * this module injects structured self-correction prompts that help the LLM:
 * 1. Understand what went wrong
 * 2. Analyze the root cause
 * 3. Retry with corrected parameters or choose an alternative tool
 *
 * This dramatically improves reliability of tool-calling agents,
 * especially with complex parameter schemas.
 */
export interface ToolErrorContext {
    /** The API name that was called */
    apiName: string;
    /** The arguments that were passed (stringified JSON) */
    arguments: string;
    /** The error message or failed result */
    error: string;
    /** Number of retries already attempted for this specific call */
    retryCount: number;
    /** The tool identifier */
    toolIdentifier: string;
}
export interface SelfReflectionConfig {
    /** Maximum retries per tool call before giving up. Default: 2 */
    maxRetries?: number;
    /** Whether to suggest alternative tools on failure. Default: true */
    suggestAlternatives?: boolean;
}
/**
 * Classification of tool errors to guide the self-correction strategy
 */
export type ToolErrorCategory = 'invalid_arguments' | 'missing_required_field' | 'api_rate_limit' | 'network_error' | 'permission_denied' | 'not_found' | 'timeout' | 'unknown';
export declare class SelfReflection {
    private config;
    /** Maps tool_call_id → retry count */
    private retryTracker;
    constructor(config?: SelfReflectionConfig);
    /**
     * Classify a tool error into a category to guide the correction strategy.
     * NOTE: Order matters - more specific patterns must be checked before broad ones
     * (e.g., 'unauthorized' before 'invalid', 'expected' only with 'type' context).
     */
    classifyError(error: string): ToolErrorCategory;
    /**
     * Generate a self-correction prompt to inject as a system/tool message
     * that guides the LLM to fix its tool call.
     */
    generateCorrectionPrompt(context: ToolErrorContext): string;
    /**
     * Track a retry attempt for a specific tool call.
     * Returns true if retry is allowed, false if max retries exceeded.
     */
    trackRetry(toolCallId: string): boolean;
    /**
     * Get the current retry count for a tool call.
     */
    getRetryCount(toolCallId: string): number;
    /**
     * Check if a tool call should be retried based on the error category.
     * Some errors (like permission_denied) should never be retried.
     */
    shouldRetry(error: string): boolean;
    /**
     * Reset retry tracking (e.g., at the start of a new conversation turn)
     */
    reset(): void;
}
