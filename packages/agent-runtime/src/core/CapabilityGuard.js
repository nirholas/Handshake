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
export class CapabilityGuard {
    checkCapability;
    constructor(checkCapability) {
        this.checkCapability = checkCapability;
    }
    /**
     * Returns a new InstructionExecutor that intercepts `call_tool`
     * instructions and gates them through the capability token check.
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
            // Parse args
            let parsedArgs;
            try {
                parsedArgs = JSON.parse(toolCalling.arguments);
            }
            catch {
                parsedArgs = {};
            }
            const agentId = state.metadata?.agentId ?? 'unknown';
            // Run capability check
            const result = await this.checkCapability({
                agentId,
                args: parsedArgs,
                toolName,
            });
            if (!result.allowed) {
                const newState = structuredClone(state);
                newState.lastModified = new Date().toISOString();
                newState.messages.push({
                    content: JSON.stringify({
                        error: 'Capability denied',
                        reason: result.reason ?? 'No valid capability token for this action.',
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
            // Capability check passed - proceed to inner executor
            return innerExecutor(instruction, state, context);
        };
    }
}
