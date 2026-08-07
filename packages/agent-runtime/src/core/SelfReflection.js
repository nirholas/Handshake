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
const DEFAULT_CONFIG = {
    maxRetries: 2,
    suggestAlternatives: true,
};
export class SelfReflection {
    config;
    /** Maps tool_call_id → retry count */
    retryTracker = new Map();
    constructor(config) {
        this.config = { ...DEFAULT_CONFIG, ...config };
    }
    /**
     * Classify a tool error into a category to guide the correction strategy.
     * NOTE: Order matters - more specific patterns must be checked before broad ones
     * (e.g., 'unauthorized' before 'invalid', 'expected' only with 'type' context).
     */
    classifyError(error) {
        const lower = error.toLowerCase();
        // Check specific categories FIRST (before broad patterns like 'invalid')
        if (lower.includes('permission') ||
            lower.includes('forbidden') ||
            lower.includes('403') ||
            lower.includes('unauthorized') ||
            lower.includes('401')) {
            return 'permission_denied';
        }
        if (lower.includes('rate limit') ||
            lower.includes('429') ||
            lower.includes('too many requests')) {
            return 'api_rate_limit';
        }
        if (lower.includes('network') ||
            lower.includes('econnrefused') ||
            lower.includes('fetch failed') ||
            lower.includes('dns')) {
            return 'network_error';
        }
        if (lower.includes('not found') || lower.includes('404') || lower.includes('no results')) {
            return 'not_found';
        }
        if (lower.includes('timeout') || lower.includes('timed out') || lower.includes('deadline')) {
            return 'timeout';
        }
        if (lower.includes('required') ||
            lower.includes('missing') ||
            lower.includes('undefined')) {
            return 'missing_required_field';
        }
        // Broad patterns checked LAST
        if (lower.includes('validation') ||
            lower.includes('schema') ||
            lower.includes('type error') ||
            lower.includes('invalid argument') ||
            lower.includes('invalid param') ||
            lower.includes('invalid value')) {
            return 'invalid_arguments';
        }
        return 'unknown';
    }
    /**
     * Generate a self-correction prompt to inject as a system/tool message
     * that guides the LLM to fix its tool call.
     */
    generateCorrectionPrompt(context) {
        const category = this.classifyError(context.error);
        const retryCount = context.retryCount;
        const isLastRetry = retryCount >= this.config.maxRetries - 1;
        let prompt = `<tool_error_analysis>
Tool: ${context.toolIdentifier}/${context.apiName}
Error: ${context.error}
Category: ${category}
Attempt: ${retryCount + 1}/${this.config.maxRetries}
Arguments used: ${context.arguments}
`;
        switch (category) {
            case 'invalid_arguments': {
                prompt += `
Action required: The arguments you provided are invalid. Please:
1. Review the tool's parameter schema carefully
2. Check the data types (string vs number, array vs object)
3. Ensure enum values match exactly
4. Retry with corrected arguments
`;
                break;
            }
            case 'missing_required_field': {
                prompt += `
Action required: A required field is missing. Please:
1. Check which required parameters the tool expects
2. Add the missing field(s) with appropriate values
3. Retry with complete arguments
`;
                break;
            }
            case 'api_rate_limit': {
                prompt += `
Action required: The API is rate-limited. Please:
1. Do NOT retry this exact call immediately
2. If possible, use a different data source or tool
3. Inform the user about the rate limit and suggest waiting
`;
                break;
            }
            case 'network_error': {
                prompt += `
Action required: A network error occurred. This is typically transient. Please:
1. Retry the same call once
2. If it fails again, inform the user about connectivity issues
`;
                break;
            }
            case 'permission_denied': {
                prompt += `
Action required: Permission was denied. Please:
1. Do NOT retry with the same parameters
2. Inform the user that this action requires additional permissions
3. Suggest alternative approaches that don't require elevated access
`;
                break;
            }
            case 'not_found': {
                prompt += `
Action required: The requested resource was not found. Please:
1. Verify the identifier/address/name you searched for
2. Try with corrected or alternative search terms
3. If the resource genuinely doesn't exist, inform the user
`;
                break;
            }
            case 'timeout': {
                prompt += `
Action required: The operation timed out. Please:
1. Retry once with a simpler query if possible
2. If it fails again, inform the user about the timeout
`;
                break;
            }
            default: {
                prompt += `
Action required: An unexpected error occurred. Please:
1. Analyze the error message for clues
2. Try with modified arguments or a different approach
3. If unsure, inform the user about the error
`;
            }
        }
        if (isLastRetry && this.config.suggestAlternatives) {
            prompt += `
⚠️ This is your last retry attempt. If this doesn't work:
- Try using a different tool that can accomplish the same goal
- Or inform the user clearly about what went wrong and suggest alternatives
`;
        }
        prompt += `</tool_error_analysis>`;
        return prompt;
    }
    /**
     * Track a retry attempt for a specific tool call.
     * Returns true if retry is allowed, false if max retries exceeded.
     */
    trackRetry(toolCallId) {
        const current = this.retryTracker.get(toolCallId) ?? 0;
        if (current >= this.config.maxRetries) {
            return false;
        }
        this.retryTracker.set(toolCallId, current + 1);
        return true;
    }
    /**
     * Get the current retry count for a tool call.
     */
    getRetryCount(toolCallId) {
        return this.retryTracker.get(toolCallId) ?? 0;
    }
    /**
     * Check if a tool call should be retried based on the error category.
     * Some errors (like permission_denied) should never be retried.
     */
    shouldRetry(error) {
        const category = this.classifyError(error);
        // These error categories should NOT be retried
        const nonRetryable = ['permission_denied', 'api_rate_limit'];
        return !nonRetryable.includes(category);
    }
    /**
     * Reset retry tracking (e.g., at the start of a new conversation turn)
     */
    reset() {
        this.retryTracker.clear();
    }
}
