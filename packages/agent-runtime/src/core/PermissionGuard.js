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
export class PermissionGuard {
    checkPermission;
    constructor(checkPermission) {
        this.checkPermission = checkPermission;
    }
    /**
     * Returns a new InstructionExecutor that intercepts `call_tool`
     * instructions and gates them through the permission check.
     */
    wrap(innerExecutor) {
        return async (instruction, state, context) => {
            // Only guard call_tool instructions
            if (instruction.type !== 'call_tool') {
                return innerExecutor(instruction, state, context);
            }
            const payload = instruction.payload;
            const toolCalling = payload?.toolCalling;
            if (!toolCalling) {
                return innerExecutor(instruction, state, context);
            }
            const toolName = toolCalling.apiName;
            const toolId = toolCalling.id;
            // Parse args for the permission check
            let parsedArgs;
            try {
                parsedArgs = JSON.parse(toolCalling.arguments);
            }
            catch {
                parsedArgs = {};
            }
            // Run permission check
            // agentId may live in state.metadata (set by the server-side executor)
            const agentId = state.metadata?.agentId ?? 'unknown';
            const result = await this.checkPermission({
                agentId,
                args: parsedArgs,
                toolName,
            });
            // ── FORBIDDEN ──────────────────────────────────────────
            if (!result.allowed && result.level === 'forbidden') {
                const newState = structuredClone(state);
                newState.lastModified = new Date().toISOString();
                newState.messages.push({
                    content: JSON.stringify({
                        error: 'Permission denied',
                        level: 'forbidden',
                        reason: result.reason ?? 'This action is forbidden by your permission settings.',
                    }),
                    role: 'tool',
                    tool_call_id: toolId,
                });
                const events = [
                    {
                        id: toolId,
                        result: { blocked: true, reason: result.reason },
                        type: 'tool_result',
                    },
                ];
                return { events, newState };
            }
            // ── APPROVAL_REQUIRED ──────────────────────────────────
            if (!result.allowed && result.level === 'approval-required') {
                const newState = structuredClone(state);
                newState.lastModified = new Date().toISOString();
                newState.status = 'waiting_for_human';
                newState.messages.push({
                    content: JSON.stringify({
                        error: 'Awaiting approval',
                        level: 'approval-required',
                        pendingApprovalId: result.pendingApprovalId,
                        reason: result.reason ?? 'This action requires human approval.',
                    }),
                    role: 'tool',
                    tool_call_id: toolId,
                });
                const events = [
                    {
                        id: toolId,
                        pendingApprovalId: result.pendingApprovalId,
                        reason: result.reason,
                        type: 'permission_pending',
                    },
                ];
                return { events, newState };
            }
            // ── NOTIFY_AND_PROCEED / AUTONOMOUS ────────────────────
            const executorResult = await innerExecutor(instruction, state, context);
            // For NOTIFY_AND_PROCEED, append a notification event
            if (result.level === 'notify-and-proceed') {
                executorResult.events.push({
                    id: toolId,
                    reason: result.reason ?? 'Action executed - user will be notified.',
                    type: 'permission_notify',
                });
            }
            return executorResult;
        };
    }
}
