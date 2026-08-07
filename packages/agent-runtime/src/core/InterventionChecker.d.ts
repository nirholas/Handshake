import type { HumanInterventionPolicy, SecurityBlacklistRule, ShouldInterveneParams } from '../types/vendor.js';
/**
 * Result of security blacklist check
 */
export interface SecurityCheckResult {
    /**
     * Whether the operation is blocked by security rules
     */
    blocked: boolean;
    /**
     * Reason for blocking (if blocked)
     */
    reason?: string;
}
/**
 * Intervention Checker
 * Determines whether a tool call requires human intervention
 */
export declare class InterventionChecker {
    /**
     * Check if tool call is blocked by security blacklist
     * This check runs BEFORE all other intervention checks
     *
     * @param securityBlacklist - Security blacklist rules
     * @param toolArgs - Tool call arguments
     * @returns Security check result
     */
    static checkSecurityBlacklist(securityBlacklist?: SecurityBlacklistRule[], toolArgs?: Record<string, any>): SecurityCheckResult;
    /**
     * Check if a tool call requires intervention
     *
     * @param params - Parameters object containing config, toolArgs, confirmedHistory, and toolKey
     * @returns Policy to apply
     */
    static shouldIntervene(params: ShouldInterveneParams): HumanInterventionPolicy;
    /**
     * Check if tool arguments match a security blacklist rule
     *
     * @param rule - Security rule to check
     * @param toolArgs - Tool call arguments
     * @returns true if matches (should be blocked)
     */
    private static matchesSecurityRule;
    /**
     * Check if tool arguments match a rule
     *
     * @param rule - Rule to check
     * @param toolArgs - Tool call arguments
     * @returns true if matches
     */
    private static matchesRule;
    /**
     * Check if a parameter value matches the matcher
     *
     * @param matcher - Argument matcher
     * @param value - Parameter value
     * @returns true if matches
     */
    private static matchesArgument;
    /**
     * Match wildcard pattern (supports * wildcard)
     *
     * @param pattern - Pattern with wildcards
     * @param value - Value to match
     * @returns true if matches
     */
    private static matchPattern;
    /**
     * Generate tool key from identifier and API name
     *
     * @param identifier - Tool identifier
     * @param apiName - API name
     * @param argsHash - Optional hash of arguments
     * @returns Tool key in format "identifier/apiName" or "identifier/apiName#hash"
     */
    static generateToolKey(identifier: string, apiName: string, argsHash?: string): string;
    /**
     * Generate simple hash of arguments for tool tracking
     *
     * @param args - Tool call arguments
     * @returns Hash string
     */
    static hashArguments(args: Record<string, any>): string;
}
