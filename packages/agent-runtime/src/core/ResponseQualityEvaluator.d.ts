/**
 * ResponseQualityEvaluator - Post-response quality evaluation for agent outputs.
 *
 * After the agent produces a response, this evaluator checks for common
 * quality issues and flags responses that may need improvement. This enables
 * a "think twice" pattern where the agent can self-correct before sending.
 *
 * Checks performed:
 * 1. Completeness - Did the agent actually answer the question?
 * 2. Hallucination signals - Does the response contain known hallucination patterns?
 * 3. Safety - Does the response contain unsafe content?
 * 4. Formatting - Is the response well-structured?
 * 5. Language consistency - Does the response match the query language?
 */
export interface QualityIssue {
    /** Category of the issue */
    category: 'completeness' | 'hallucination' | 'formatting' | 'language' | 'safety';
    /** Detailed description */
    description: string;
    /** Severity: warning = could be better, error = should be regenerated */
    severity: 'warning' | 'error';
}
export interface QualityEvaluation {
    /** List of detected issues */
    issues: QualityIssue[];
    /** Whether the response passed quality checks */
    passed: boolean;
    /** Structured prompt to inject for self-correction if needed */
    selfCorrectionPrompt?: string;
}
export declare class ResponseQualityEvaluator {
    /**
     * Evaluate a response against the original query.
     *
     * @param query - The user's original query
     * @param response - The agent's generated response
     * @param toolResults - Optional tool results that were used
     * @returns Quality evaluation with issues and optional correction prompt
     */
    evaluate(query: string, response: string, toolResults?: Array<{
        content: string;
        success: boolean;
    }>): QualityEvaluation;
    /**
     * Check if the response actually addresses the user's query.
     */
    private checkCompleteness;
    /**
     * Check for common hallucination signals in the response.
     */
    private checkHallucinationSignals;
    /**
     * Check response formatting quality.
     */
    private checkFormatting;
    /**
     * Check that response language roughly matches query language.
     */
    private checkLanguageConsistency;
    /**
     * Generate a self-correction prompt from detected issues.
     */
    private generateCorrectionPrompt;
}
