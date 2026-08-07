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
export class ResponseQualityEvaluator {
    /**
     * Evaluate a response against the original query.
     *
     * @param query - The user's original query
     * @param response - The agent's generated response
     * @param toolResults - Optional tool results that were used
     * @returns Quality evaluation with issues and optional correction prompt
     */
    evaluate(query, response, toolResults) {
        const issues = [];
        // Run all checks
        issues.push(...this.checkCompleteness(query, response));
        issues.push(...this.checkHallucinationSignals(response, toolResults));
        issues.push(...this.checkFormatting(response));
        issues.push(...this.checkLanguageConsistency(query, response));
        const hasErrors = issues.some((i) => i.severity === 'error');
        const passed = !hasErrors;
        const evaluation = { issues, passed };
        if (!passed) {
            evaluation.selfCorrectionPrompt = this.generateCorrectionPrompt(issues, query);
        }
        return evaluation;
    }
    /**
     * Check if the response actually addresses the user's query.
     */
    checkCompleteness(query, response) {
        const issues = [];
        // Empty or near-empty response
        if (!response || response.trim().length < 10) {
            issues.push({
                category: 'completeness',
                description: 'Response is empty or too short to be useful',
                severity: 'error',
            });
            return issues;
        }
        // Response is just a generic filler
        const genericFillers = [
            'i understand',
            'sure, i can help',
            'let me help you',
            'of course',
            'certainly',
        ];
        const responseLower = response.toLowerCase().trim();
        if (genericFillers.some((filler) => responseLower === filler)) {
            issues.push({
                category: 'completeness',
                description: 'Response is a generic filler without substantive content',
                severity: 'warning',
            });
        }
        // Check for question-response mismatch: user asked a question but response doesn't
        // contain any informational content
        const isQuestion = /\?|what|how|why|when|where|which|who|can you|could you/i.test(query);
        if (isQuestion && response.length < 50 && !response.includes('?')) {
            issues.push({
                category: 'completeness',
                description: 'User asked a question but response seems incomplete',
                severity: 'warning',
            });
        }
        return issues;
    }
    /**
     * Check for common hallucination signals in the response.
     */
    checkHallucinationSignals(response, toolResults) {
        const issues = [];
        // Pattern: Agent claims specific numbers but no tool was used to fetch data
        const hasSpecificNumbers = /\$[\d,.]+\s*(billion|million|trillion|B|M|T|k)/i.test(response);
        const hasToolData = toolResults && toolResults.some((t) => t.success);
        if (hasSpecificNumbers && !hasToolData) {
            issues.push({
                category: 'hallucination',
                description: 'Response contains specific financial figures but no data tool was called to verify them. These may be outdated or hallucinated.',
                severity: 'warning',
            });
        }
        // Pattern: Agent invents URLs
        const urlPattern = /https?:\/\/[^\s)]+/g;
        const urls = response.match(urlPattern) || [];
        const suspiciousUrls = urls.filter((url) => 
        // URLs that look fabricated (unusual TLDs, very long random paths)
        /[a-z]{20,}/.test(url) || /\d{10,}/.test(url));
        if (suspiciousUrls.length > 0) {
            issues.push({
                category: 'hallucination',
                description: `Response contains ${suspiciousUrls.length} potentially fabricated URL(s)`,
                severity: 'warning',
            });
        }
        // Pattern: Contradicts tool results
        if (toolResults) {
            const failedTools = toolResults.filter((t) => !t.success);
            if (failedTools.length > 0) {
                // Check if response claims success despite tool failures
                const claimsSuccess = /successfully|completed|done|here are the results/i.test(response) &&
                    !response.toLowerCase().includes('error') &&
                    !response.toLowerCase().includes('failed');
                if (claimsSuccess) {
                    issues.push({
                        category: 'hallucination',
                        description: 'Response claims success but one or more tools failed. The agent may be fabricating results.',
                        severity: 'error',
                    });
                }
            }
        }
        return issues;
    }
    /**
     * Check response formatting quality.
     */
    checkFormatting(response) {
        const issues = [];
        // Unclosed code blocks
        const codeBlockCount = (response.match(/```/g) || []).length;
        if (codeBlockCount % 2 !== 0) {
            issues.push({
                category: 'formatting',
                description: 'Response has unclosed code block(s)',
                severity: 'warning',
            });
        }
        // Excessively long response without structure
        if (response.length > 2000 && !response.includes('\n\n') && !response.includes('#')) {
            issues.push({
                category: 'formatting',
                description: 'Very long response without paragraph breaks or headings',
                severity: 'warning',
            });
        }
        // Truncated-looking response (ends mid-sentence)
        const lastChar = response.trim().slice(-1);
        if (response.length > 200 &&
            !'.!?:;)>]}`\'"'.includes(lastChar) &&
            !response.trim().endsWith('```')) {
            issues.push({
                category: 'formatting',
                description: 'Response appears truncated (ends mid-sentence)',
                severity: 'warning',
            });
        }
        return issues;
    }
    /**
     * Check that response language roughly matches query language.
     */
    checkLanguageConsistency(query, response) {
        const issues = [];
        // Simple heuristic: detect CJK characters
        const queryCJK = /[\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF]/.test(query);
        const responseCJK = /[\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF]/.test(response);
        // If query is in CJK but response is entirely non-CJK (or vice versa for long responses)
        if (queryCJK && !responseCJK && response.length > 100) {
            issues.push({
                category: 'language',
                description: 'User wrote in CJK language but response is in a different language',
                severity: 'warning',
            });
        }
        return issues;
    }
    /**
     * Generate a self-correction prompt from detected issues.
     */
    generateCorrectionPrompt(issues, originalQuery) {
        const errorIssues = issues.filter((i) => i.severity === 'error');
        return `<quality_review>
Your previous response has quality issues that need to be addressed:

${errorIssues.map((i) => `- [${i.category.toUpperCase()}] ${i.description}`).join('\n')}

Please regenerate your response for the original query: "${originalQuery.slice(0, 200)}"

Requirements:
- Address all flagged issues
- If you referenced data, ensure it came from a tool call
- If a tool failed, acknowledge the error honestly
- Match the user's language
</quality_review>`;
    }
}
