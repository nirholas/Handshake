import type { InstructionExecutor } from '../types/index.js';
/**
 * Result of a capability token check.
 */
export interface CapabilityCheckResult {
    /** Whether the action is allowed */
    allowed: boolean;
    /** Human-readable reason if denied */
    reason?: string;
    /** The token ID that was validated (if any) */
    tokenId?: string;
}
/**
 * Callback type that the consumer provides to validate
 * a capability token for a given tool call.
 *
 * The runtime package is database-agnostic; the actual token lookup
 * and validation is injected by the server layer.
 */
export type CapabilityCheckFn = (params: {
    /** The agent ID (from state) */
    agentId: string;
    /** Parsed tool arguments */
    args: unknown;
    /** Tool name being called */
    toolName: string;
}) => Promise<CapabilityCheckResult>;
/**
 * CapabilityGuard - wraps a standard `call_tool` InstructionExecutor
 * with a capability token check that runs **before** the tool handler.
 *
 * This is designed to compose with `PermissionGuard`:
 *
 * ```ts
 * const capGuard = new CapabilityGuard(myCapabilityCheckFn);
 * const permGuard = new PermissionGuard(myPermissionCheckFn);
 *
 * // Chain: capability check → permission check → actual tool
 * const executor = capGuard.wrap(permGuard.wrap(defaultCallToolExecutor));
 * ```
 *
 * If no valid capability token covers the requested tool, the action is
 * blocked with an error message pushed to the conversation.
 */
export declare class CapabilityGuard {
    private checkCapability;
    constructor(checkCapability: CapabilityCheckFn);
    /**
     * Returns a new InstructionExecutor that intercepts `call_tool`
     * instructions and gates them through the capability token check.
     */
    wrap(innerExecutor: InstructionExecutor): InstructionExecutor;
}
