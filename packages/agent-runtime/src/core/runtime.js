/**
 * Simplified Agent Runtime - The "Engine" that executes instructions from an "Agent" (Brain).
 * Now includes built-in call_llm support and allows full executor customization.
 */
export class AgentRuntime {
    agent;
    config;
    executors;
    operationId;
    getOperation;
    constructor(agent, config = {}) {
        this.agent = agent;
        this.config = config;
        this.operationId = config.operationId;
        this.getOperation = config.getOperation;
        // Build executors with priority: agent.executors > config.executors > built-in
        this.executors = {
            call_llm: this.createCallLLMExecutor(),
            call_tool: this.createCallToolExecutor(),
            finish: this.createFinishExecutor(),
            request_human_approve: this.createHumanApproveExecutor(),
            request_human_prompt: this.createHumanPromptExecutor(),
            request_human_select: this.createHumanSelectExecutor(),
            // Config executors override built-in
            ...config.executors,
            // Agent provided executors have highest priority
            ...agent.executors,
        };
    }
    /**
     * Get operation context (sessionId, topicId, etc.)
     * Returns the business context captured by the operation
     */
    getContext() {
        if (!this.operationId || !this.getOperation) {
            return undefined;
        }
        return this.getOperation(this.operationId).context;
    }
    /**
     * Get operation abort controller
     * Returns the AbortController for cancellation
     */
    getAbortController() {
        if (!this.operationId || !this.getOperation) {
            return undefined;
        }
        return this.getOperation(this.operationId).abortController;
    }
    /**
     * Executes a single step of the Plan -> Execute loop.
     * @param state - Current agent state
     * @param context - Runtime context for this step (required for proper phase detection)
     */
    async step(state, context) {
        try {
            // Increment step count and check limits
            const newState = structuredClone(state);
            newState.stepCount += 1;
            newState.lastModified = new Date().toISOString();
            // Check maximum steps limit
            if (newState.maxSteps && newState.stepCount > newState.maxSteps) {
                // Finish execution when maxSteps is exceeded
                newState.status = 'done';
                const finishEvent = {
                    finalState: newState,
                    reason: 'max_steps_exceeded',
                    reasonDetail: `Maximum steps exceeded: ${newState.maxSteps}`,
                    type: 'done',
                };
                return {
                    events: [finishEvent],
                    newState,
                    nextContext: undefined, // No next context when done
                };
            }
            // Use provided context or create initial context
            const runtimeContext = context || this.createInitialContext(newState);
            // Get instructions from agent runner and normalize to array
            let rawInstructions;
            // Handle human approved tool calls
            if (runtimeContext.phase === 'human_approved_tool') {
                const approvedPayload = runtimeContext.payload;
                const toolCalling = approvedPayload.approvedToolCall;
                rawInstructions = {
                    payload: {
                        parentMessageId: approvedPayload.parentMessageId,
                        skipCreateToolMessage: approvedPayload.skipCreateToolMessage,
                        toolCalling,
                    },
                    type: 'call_tool',
                };
            }
            else {
                // Standard flow: Plan -> Execute
                rawInstructions = await this.agent.runner(runtimeContext, newState);
            }
            // Normalize to array
            const instructions = Array.isArray(rawInstructions) ? rawInstructions : [rawInstructions];
            // Convert old format to new format
            const normalizedInstructions = instructions.map((instruction) => {
                if (instruction.type === 'call_tools_batch' && // Check if payload is array of ToolsCalling (old format)
                    Array.isArray(instruction.payload)) {
                    const toolsCalling = instruction.payload.map((tc) => ({
                        apiName: tc.function.name,
                        arguments: tc.function.arguments,
                        id: tc.id,
                        identifier: tc.function.name,
                        type: 'default',
                    }));
                    return {
                        payload: {
                            parentMessageId: '',
                            toolsCalling,
                        },
                        type: 'call_tools_batch',
                    };
                }
                return instruction;
            });
            // Execute all instructions sequentially
            let currentState = newState;
            const allEvents = [];
            let finalNextContext = undefined;
            for (const instruction of normalizedInstructions) {
                let result;
                // Special handling for batch tool execution
                if (instruction.type === 'call_tools_batch') {
                    // Check if custom executor is provided (e.g., server-side with DB access)
                    const customExecutor = this.executors['call_tools_batch'];
                    if (customExecutor) {
                        result = await customExecutor(instruction, currentState, runtimeContext);
                    }
                    else {
                        // Fallback to built-in executeToolsBatch
                        result = await this.executeToolsBatch(instruction, currentState, runtimeContext);
                    }
                }
                else {
                    const executor = this.executors[instruction.type];
                    if (!executor) {
                        throw new Error(`No executor found for instruction type: ${instruction.type}`);
                    }
                    // Pass runtimeContext to executor so it can access stepContext
                    result = await executor(instruction, currentState, runtimeContext);
                }
                // Accumulate events
                allEvents.push(...result.events);
                // Update state
                currentState = result.newState;
                // Keep the last nextContext
                if (result.nextContext) {
                    finalNextContext = result.nextContext;
                }
                // Stop execution if blocked
                if (currentState.status === 'waiting_for_human' || currentState.status === 'interrupted') {
                    break;
                }
            }
            // Ensure stepCount and lastModified are preserved
            currentState.stepCount = newState.stepCount;
            currentState.lastModified = newState.lastModified;
            return {
                events: allEvents,
                newState: currentState,
                nextContext: finalNextContext,
            };
        }
        catch (error) {
            const errorState = structuredClone(state);
            errorState.stepCount += 1;
            errorState.lastModified = new Date().toISOString();
            return this.createErrorResult(errorState, error);
        }
    }
    /**
     * Convenience method for approving and executing a tool call
     */
    async approveToolCall(state, approvedToolCall) {
        const context = {
            operationId: this.operationId,
            payload: { approvedToolCall },
            phase: 'human_approved_tool',
            session: this.createSessionContext(state),
        };
        return this.step(state, context);
    }
    /**
     * Interrupt the current execution
     * @param state - Current agent state
     * @param reason - Reason for interruption
     * @param canResume - Whether the interruption can be resumed later
     * @param metadata - Additional metadata about the interruption
     */
    interrupt(state, reason, canResume = true, metadata) {
        const newState = structuredClone(state);
        const interruptedAt = new Date().toISOString();
        newState.status = 'interrupted';
        newState.lastModified = interruptedAt;
        newState.interruption = {
            canResume,
            interruptedAt,
            // Store the current step for potential resumption
            interruptedInstruction: undefined,
            reason, // Could be enhanced to store current instruction
        };
        const interruptEvent = {
            canResume,
            interruptedAt,
            metadata,
            reason,
            type: 'interrupted',
        };
        return {
            events: [interruptEvent],
            newState,
        };
    }
    /**
     * Resume execution from an interrupted state
     * @param state - Interrupted agent state
     * @param reason - Reason for resumption
     * @param context - Optional context to resume with
     */
    async resume(state, reason = 'User resumed execution', context) {
        if (state.status !== 'interrupted') {
            throw new Error('Cannot resume: state is not interrupted');
        }
        if (state.interruption && !state.interruption.canResume) {
            throw new Error('Cannot resume: interruption is not resumable');
        }
        const newState = structuredClone(state);
        const resumedAt = new Date().toISOString();
        const resumedFromStep = state.stepCount;
        // Clear interruption context and set status back to running
        newState.status = 'running';
        newState.lastModified = resumedAt;
        newState.interruption = undefined;
        const resumeEvent = {
            reason,
            resumedAt,
            resumedFromStep,
            type: 'resumed',
        };
        // If context is provided, continue with that context
        if (context) {
            const result = await this.step(newState, context);
            return {
                events: [resumeEvent, ...result.events],
                newState: result.newState,
                nextContext: result.nextContext,
            };
        }
        // Otherwise, just return the resumed state
        const initialContext = this.createInitialContext(newState);
        return {
            events: [resumeEvent],
            newState,
            nextContext: initialContext,
        };
    }
    /**
     * Create default usage statistics structure
     * @returns Default Usage object with all counters set to 0
     */
    static createDefaultUsage() {
        return {
            humanInteraction: {
                approvalRequests: 0,
                promptRequests: 0,
                selectRequests: 0,
                totalWaitingTimeMs: 0,
            },
            llm: {
                apiCalls: 0,
                processingTimeMs: 0,
                tokens: { input: 0, output: 0, total: 0 },
            },
            tools: {
                byTool: [],
                totalCalls: 0,
                totalTimeMs: 0,
            },
        };
    }
    /**
     * Create default cost structure
     * @returns Default Cost object with all costs set to 0
     */
    static createDefaultCost() {
        const now = new Date().toISOString();
        return {
            calculatedAt: now,
            currency: 'USD',
            llm: {
                byModel: [],
                currency: 'USD',
                total: 0,
            },
            tools: {
                byTool: [],
                currency: 'USD',
                total: 0,
            },
            total: 0,
        };
    }
    /**
     * Create a new agent state with flexible initialization
     * @param partialState - Partial state to override defaults
     * @returns Complete AgentState with defaults filled in
     */
    static createInitialState(partialState) {
        const now = new Date().toISOString();
        return {
            cost: AgentRuntime.createDefaultCost(),
            // Default values
            createdAt: now,
            lastModified: now,
            messages: [],
            status: 'idle',
            stepCount: 0,
            toolManifestMap: {},
            usage: AgentRuntime.createDefaultUsage(),
            // User provided values override defaults
            ...(partialState || { operationId: '' }),
        };
    }
    // ============ Executor Factory Methods ============
    /** Create call_llm executor with streaming support */
    createCallLLMExecutor() {
        return async (instruction, state) => {
            const { payload } = instruction;
            const newState = structuredClone(state);
            const events = [];
            newState.status = 'running';
            newState.lastModified = new Date().toISOString();
            events.push({ payload, type: 'llm_start' });
            // Use Agent's modelRuntime first, fallback to config
            const modelRuntime = this.agent.modelRuntime;
            if (!modelRuntime) {
                throw new Error('Model Runtime is required for call_llm instruction. Provide it via Agent.modelRuntime or RuntimeConfig.modelRuntime');
            }
            let assistantContent = '';
            let toolCalls = [];
            try {
                // Stream LLM response
                for await (const chunk of modelRuntime(payload)) {
                    // Emit individual stream events for each chunk
                    events.push({ chunk, type: 'llm_stream' });
                    // Accumulate content and tool calls from chunks
                    if (chunk.content) {
                        assistantContent += chunk.content;
                    }
                    if (chunk.tool_calls) {
                        toolCalls = chunk.tool_calls;
                    }
                }
                events.push({
                    result: { content: assistantContent, tool_calls: toolCalls },
                    type: 'llm_result',
                });
                // Update usage and cost if agent provides calculation methods
                if (this.agent.calculateUsage) {
                    newState.usage = this.agent.calculateUsage('llm', { content: assistantContent, tool_calls: toolCalls }, newState.usage);
                }
                if (this.agent.calculateCost) {
                    newState.cost = this.agent.calculateCost({
                        costLimit: newState.costLimit,
                        previousCost: newState.cost,
                        usage: newState.usage,
                    });
                }
                // Check cost limits
                if (newState.costLimit && newState.cost.total > newState.costLimit.maxTotalCost) {
                    return this.handleCostLimitExceeded(newState);
                }
                // Provide next context based on LLM result
                const nextContext = {
                    operationId: this.operationId,
                    payload: {
                        hasToolCalls: toolCalls.length > 0,
                        result: { content: assistantContent, tool_calls: toolCalls },
                        toolCalls,
                    },
                    phase: 'llm_result',
                    session: this.createSessionContext(newState),
                };
                return { events, newState, nextContext };
            }
            catch (error) {
                return this.createErrorResult(state, error);
            }
        };
    }
    /** Create call_tool executor */
    createCallToolExecutor() {
        return async (instruction, state) => {
            const { payload } = instruction;
            const newState = structuredClone(state);
            const events = [];
            newState.lastModified = new Date().toISOString();
            newState.status = 'running';
            const tools = this.agent.tools || {};
            const toolCall = payload.toolCalling;
            // Support both ToolsCalling (OpenAI format) and CallingToolPayload formats
            const toolName = toolCall.apiName;
            const toolArgs = toolCall.arguments;
            const toolId = toolCall.id;
            const handler = tools[toolName];
            if (!handler)
                throw new Error(`Tool not found: ${toolName}`);
            let args;
            try {
                args = JSON.parse(toolArgs);
            }
            catch (parseError) {
                throw new Error(`Failed to parse arguments for tool "${toolName}" (call ${toolId}): ${parseError}`);
            }
            const result = await handler(args);
            const MAX_TOOL_OUTPUT_SIZE = 500_000; // 500KB
            let serialized = JSON.stringify(result);
            if (serialized.length > MAX_TOOL_OUTPUT_SIZE) {
                serialized = JSON.stringify({
                    __truncated: true,
                    error: `Tool output exceeded ${MAX_TOOL_OUTPUT_SIZE / 1000}KB limit. Output was truncated.`,
                    summary: serialized.slice(0, 2000) + '...',
                });
            }
            newState.messages.push({
                content: serialized,
                role: 'tool',
                tool_call_id: toolId,
            });
            events.push({ id: toolId, result, type: 'tool_result' });
            // Update usage and cost if agent provides calculation methods
            if (this.agent.calculateUsage) {
                newState.usage = this.agent.calculateUsage('tool', { executionTime: 0, result, toolCall }, // Could track actual execution time
                newState.usage);
            }
            if (this.agent.calculateCost) {
                newState.cost = this.agent.calculateCost({
                    costLimit: newState.costLimit,
                    previousCost: newState.cost,
                    usage: newState.usage,
                });
            }
            // Check cost limits
            if (newState.costLimit && newState.cost.total > newState.costLimit.maxTotalCost) {
                return this.handleCostLimitExceeded(newState);
            }
            // Provide next context for tool result
            const nextContext = {
                operationId: this.operationId,
                payload: {
                    result,
                    toolCall,
                    toolCallId: toolCall.id,
                },
                phase: 'tool_result',
                session: this.createSessionContext(newState),
            };
            return { events, newState, nextContext };
        };
    }
    /** Create human approve executor */
    createHumanApproveExecutor() {
        return async (instruction, state) => {
            const { pendingToolsCalling } = instruction;
            const newState = structuredClone(state);
            newState.lastModified = new Date().toISOString();
            newState.status = 'waiting_for_human';
            newState.pendingToolsCalling = pendingToolsCalling;
            const events = [
                {
                    operationId: newState.operationId,
                    pendingToolsCalling,
                    type: 'human_approve_required',
                },
            ];
            return { events, newState };
        };
    }
    /** Create human prompt executor */
    createHumanPromptExecutor() {
        return async (instruction, state) => {
            const { metadata, prompt } = instruction;
            const newState = structuredClone(state);
            newState.lastModified = new Date().toISOString();
            newState.status = 'waiting_for_human';
            newState.pendingHumanPrompt = { metadata, prompt };
            const events = [
                {
                    metadata,
                    operationId: newState.operationId,
                    prompt,
                    type: 'human_prompt_required',
                },
            ];
            return { events, newState };
        };
    }
    /** Create human select executor */
    createHumanSelectExecutor() {
        return async (instruction, state) => {
            const { metadata, multi, options, prompt } = instruction;
            const newState = structuredClone(state);
            newState.lastModified = new Date().toISOString();
            newState.status = 'waiting_for_human';
            newState.pendingHumanSelect = { metadata, multi, options, prompt };
            const events = [
                {
                    metadata,
                    multi,
                    operationId: newState.operationId,
                    options,
                    prompt,
                    type: 'human_select_required',
                },
            ];
            return { events, newState };
        };
    }
    /** Create finish executor */
    createFinishExecutor() {
        return async (instruction, state) => {
            const { reason, reasonDetail } = instruction;
            const newState = structuredClone(state);
            newState.lastModified = new Date().toISOString();
            newState.status = 'done';
            const events = [
                {
                    finalState: newState,
                    reason,
                    reasonDetail,
                    type: 'done',
                },
            ];
            return { events, newState };
        };
    }
    // ============ Helper Methods ============
    /**
     * Execute multiple tool calls concurrently
     */
    async executeToolsBatch(instruction, baseState, context) {
        const { payload } = instruction;
        // Execute all tools concurrently based on the same state
        const results = await Promise.all(instruction.payload.toolsCalling.map((toolCalling) => this.executors.call_tool({
            payload: { parentMessageId: payload.parentMessageId, toolCalling },
            type: 'call_tool',
        }, structuredClone(baseState), // Each tool starts from the same base state
        context)));
        const lastParentMessageId = results.at(-1).nextContext?.payload
            ?.parentMessageId;
        // Merge results
        return this.mergeToolResults(results, baseState, lastParentMessageId);
    }
    /**
     * Merge multiple tool execution results
     */
    mergeToolResults(results, baseState, lastParentMessageId) {
        const newState = structuredClone(baseState);
        const allEvents = [];
        // Merge all tool messages in order
        // Get the set of tool_call_ids that already exist in baseState to avoid duplicates
        const existingToolCallIds = new Set(baseState.messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id));
        for (const result of results) {
            // Extract only NEW tool role messages (not already in baseState)
            const toolMessages = result.newState.messages.filter((m) => m.role === 'tool' && !existingToolCallIds.has(m.tool_call_id));
            newState.messages.push(...toolMessages);
            // Merge events
            allEvents.push(...result.events);
            // Merge usage statistics (if available)
            if (result.newState.usage && newState.usage) {
                newState.usage.tools.totalCalls += result.newState.usage.tools.totalCalls;
                newState.usage.tools.totalTimeMs += result.newState.usage.tools.totalTimeMs;
                // Merge per-tool statistics (now using array)
                result.newState.usage.tools.byTool.forEach((toolStats) => {
                    const existingTool = newState.usage.tools.byTool.find((t) => t.name === toolStats.name);
                    if (existingTool) {
                        existingTool.calls += toolStats.calls;
                        existingTool.totalTimeMs += toolStats.totalTimeMs;
                        existingTool.errors += toolStats.errors || 0;
                    }
                    else {
                        newState.usage.tools.byTool.push({ ...toolStats });
                    }
                });
            }
            // Merge cost statistics (if available)
            if (result.newState.cost && newState.cost) {
                newState.cost.tools.total += result.newState.cost.tools.total;
                newState.cost.total += result.newState.cost.tools.total;
                // Merge per-tool cost statistics (now using array)
                result.newState.cost.tools.byTool.forEach((toolCost) => {
                    const existingToolCost = newState.cost.tools.byTool.find((t) => t.name === toolCost.name);
                    if (existingToolCost) {
                        existingToolCost.calls += toolCost.calls;
                        existingToolCost.totalCost += toolCost.totalCost;
                    }
                    else {
                        newState.cost.tools.byTool.push({ ...toolCost });
                    }
                });
            }
        }
        newState.lastModified = new Date().toISOString();
        return {
            events: allEvents,
            newState,
            nextContext: {
                operationId: this.operationId,
                payload: {
                    parentMessageId: lastParentMessageId,
                    toolCount: results.length,
                    toolResults: results.map((r) => r.nextContext?.payload),
                },
                phase: 'tools_batch_result',
                session: this.createSessionContext(newState),
            },
        };
    }
    /**
     * Handle cost limit exceeded scenario
     */
    handleCostLimitExceeded(state) {
        const newState = structuredClone(state);
        const costLimit = newState.costLimit;
        switch (costLimit.onExceeded) {
            case 'stop': {
                newState.status = 'done';
                const finishEvent = {
                    finalState: newState,
                    reason: 'cost_limit_exceeded',
                    reasonDetail: `Cost limit exceeded: ${newState.cost.total} ${newState.cost.currency} > ${costLimit.maxTotalCost} ${costLimit.currency}`,
                    type: 'done',
                };
                return {
                    events: [finishEvent],
                    newState,
                    nextContext: undefined,
                };
            }
            case 'interrupt': {
                return {
                    ...this.interrupt(newState, `Cost limit exceeded: ${newState.cost.total} ${newState.cost.currency}`, true, {
                        costExceeded: true,
                        currentCost: newState.cost.total,
                        limitCost: costLimit.maxTotalCost,
                    }),
                    nextContext: undefined,
                };
            }
            default: {
                // Continue execution but emit warning event
                const warningEvent = {
                    error: new Error(`Warning: Cost limit exceeded: ${newState.cost.total} ${newState.cost.currency}`),
                    type: 'error',
                };
                return {
                    events: [warningEvent],
                    newState,
                    nextContext: {
                        operationId: this.operationId,
                        payload: { error: warningEvent.error, isCostWarning: true },
                        phase: 'error',
                        session: this.createSessionContext(newState),
                    },
                };
            }
        }
    }
    /**
     * Create session context metadata - reusable helper
     * Note: Uses sessionId in context for backwards compatibility with AgentRuntimeContext
     */
    createSessionContext(state) {
        return {
            messageCount: state.messages.length,
            sessionId: state.operationId,
            status: state.status,
            stepCount: state.stepCount,
        };
    }
    /**
     * Create initial context for the first step (fallback for backward compatibility)
     */
    createInitialContext(state) {
        const lastMessage = state.messages.at(-1);
        if (lastMessage?.role === 'user') {
            return {
                operationId: this.operationId,
                payload: {
                    isFirstMessage: state.messages.length === 1,
                    message: lastMessage,
                },
                phase: 'user_input',
                session: this.createSessionContext(state),
            };
        }
        return {
            operationId: this.operationId,
            payload: undefined,
            phase: 'init',
            session: this.createSessionContext(state),
        };
    }
    /** Create error state and events */
    createErrorResult(state, error) {
        const errorState = structuredClone(state);
        errorState.status = 'error';
        errorState.error = error;
        errorState.lastModified = new Date().toISOString();
        const errorEvent = { error, type: 'error' };
        return {
            events: [errorEvent],
            newState: errorState,
        };
    }
}
