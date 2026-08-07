import type { InstructionExecutor } from '../types/index.js';
/**
 * Permission check result returned by the guard callback.
 */
export interface PermissionCheckResult {
    /** Whether the action is allowed to proceed */
    allowed: boolean;
    /** Human-readable reason */
    reason?: string;
    /** Permission level that was applied */
    level?: string;
    /** If a pending-approval audit entry was created, its ID */
    pendingApprovalId?: string;
}
/**
 * Callback type that the consumer provides to perform
 * the actual permission check against their database / service layer.
 *
 * The runtime package itself is database-agnostic; the check is injected.
 */
export type PermissionCheckFn = (params: {
    /** Parsed tool arguments */
    args: unknown;
    /** The agent ID (from state) */
    agentId: string;
    /** Tool name being called */
    toolName: string;
}) => Promise<PermissionCheckResult>;
/**
 * PermissionGuard - wraps a standard `call_tool` InstructionExecutor
 * with a permission check that runs **before** the tool handler is invoked.
 *
 * Usage:
 * ```ts
 * const guard = new PermissionGuard(myPermissionCheckFn);
 * const runtime = new AgentRuntime(agent, {
 *   executors: {
 *     call_tool: guard.wrap(defaultCallToolExecutor),
 *   },
 * });
 * ```
 *
 * Behaviour per permission level:
 * - FORBIDDEN          → tool is not executed; an error tool message is pushed
 * - APPROVAL_REQUIRED  → tool is not executed; a `permission_pending` event is emitted
 * - NOTIFY_AND_PROCEED → tool executes; a `permission_notify` event is emitted
 * - AUTONOMOUS         → tool executes normally
 */
export declare class PermissionGuard {
    private checkPermission;
    constructor(checkPermission: PermissionCheckFn);
    /**
     * Returns a new InstructionExecutor that intercepts `call_tool`
     * instructions and gates them through the permission check.
     */
    wrap(innerExecutor: InstructionExecutor): InstructionExecutor;
}
