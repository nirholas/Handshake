import { DEFAULT_SECURITY_BLACKLIST, InterventionChecker } from '../core/index.js';
import { shouldCompress } from '../utils/tokenCounter.js';
/**
 * ChatAgent - The "Brain" of the chat agent
 *
 * This agent implements a simple but powerful decision loop:
 * 1. user_input → call_llm (with optional RAG/Search preprocessing)
 * 2. llm_result → check for tool_calls and intervention requirements
 *    - Tools not requiring intervention → call_tools_batch (execute immediately)
 *    - Tools requiring intervention → request_human_approve (wait for approval)
 *    - Mixed (both types) → [call_tools_batch, request_human_approve] (execute safe ones first, then request approval)
 *    - No tool_calls → finish
 * 3. tools_batch_result → call_llm (process tool results)
 *
 */
export class GeneralChatAgent {
    config;
    defiGuard;
    constructor(config) {
        this.config = config;
        this.defiGuard = config.domainGuard;
    }
    /**
     * Get intervention configuration for a specific tool call
     */
    getToolInterventionConfig(toolCalling, state) {
        const { identifier, apiName } = toolCalling;
        const manifest = state.toolManifestMap[identifier];
        if (!manifest)
            return undefined;
        // Find the specific API in the manifest
        const api = manifest.api?.find((a) => a.name === apiName);
        // API-level config takes precedence over tool-level config
        return api?.humanIntervention ?? manifest.humanIntervention;
    }
    /**
     * Check if tool calls need human intervention
     * Combines user's global config with tool's own config
     * Includes DeFi Guard analysis for mutating DeFi operations
     * Returns [toolsNeedingIntervention, toolsToExecute]
     */
    async checkInterventionNeeded(toolsCalling, state) {
        const toolsNeedingIntervention = [];
        const toolsToExecute = [];
        // Get security blacklist (use default if not provided)
        const securityBlacklist = state.securityBlacklist ?? DEFAULT_SECURITY_BLACKLIST;
        // Get user config (default to 'manual' mode)
        const userConfig = state.userInterventionConfig || { approvalMode: 'manual' };
        const { approvalMode, allowList = [] } = userConfig;
        for (const toolCalling of toolsCalling) {
            const { identifier, apiName } = toolCalling;
            const toolKey = `${identifier}/${apiName}`;
            // Parse arguments for intervention checking
            let toolArgs = {};
            try {
                toolArgs = JSON.parse(toolCalling.arguments || '{}');
            }
            catch {
                // Invalid JSON, treat as empty args
            }
            // Priority 0: CRITICAL - Check security blacklist FIRST
            const securityCheck = InterventionChecker.checkSecurityBlacklist(securityBlacklist, toolArgs);
            // Priority 0.5: Headless mode - fully automated for async tasks
            // In headless mode: blacklisted tools are blocked with error feedback, all other tools execute directly
            if (approvalMode === 'headless') {
                if (securityCheck.blocked) {
                    // Return an explicit error so the LLM knows the tool was blocked
                    state.messages.push({
                        content: JSON.stringify({
                            blocked: true,
                            error: `Tool "${toolCalling.apiName}" was blocked by security policy: ${securityCheck.reason || 'Matches security blacklist'}. This tool cannot be executed in headless mode.`,
                        }),
                        role: 'tool',
                        tool_call_id: toolCalling.id,
                    });
                    continue;
                }
                // All other tools execute directly
                toolsToExecute.push(toolCalling);
                continue;
            }
            // For non-headless modes: security blacklist requires intervention
            if (securityCheck.blocked) {
                toolsNeedingIntervention.push(toolCalling);
                continue;
            }
            // Priority 0.9: DeFi Guard - intercept mutating DeFi operations
            if (this.defiGuard?.isDeFiTool(identifier) && this.defiGuard.isMutatingApi(apiName)) {
                const guardResult = await this.defiGuard.analyze({
                    apiName,
                    arguments: toolArgs,
                    identifier,
                    portfolioPositions: state.portfolioPositions,
                });
                // Guard analysis is also performed server-side by ToolExecutionService;
                // no need to attach the result to the tool calling object here.
                if (guardResult.analysis.decision === 'block') {
                    // Blocked: inject error message so LLM knows
                    state.messages.push({
                        content: JSON.stringify({
                            blocked: true,
                            error: `DeFi Guard blocked this operation: ${guardResult.analysis.reason}`,
                            warnings: guardResult.analysis.warnings,
                        }),
                        role: 'tool',
                        tool_call_id: toolCalling.id,
                    });
                    continue;
                }
                if (guardResult.analysis.decision === 'require_approval') {
                    toolsNeedingIntervention.push(toolCalling);
                    continue;
                }
                // 'allow' - fall through to subsequent priority checks
            }
            // Priority 1: Check 'always' policy - overrides auto-run mode
            // Some sensitive operations (e.g., installPlugin) must always require user confirmation
            const config = this.getToolInterventionConfig(toolCalling, state);
            const hasAlwaysPolicy = config === 'always' ||
                (Array.isArray(config) &&
                    config.some((rule) => {
                        // Check if the 'always' rule matches current tool args
                        if (rule.policy !== 'always')
                            return false;
                        // If rule has match criteria, check if it matches
                        if (rule.match) {
                            return Object.entries(rule.match).every(([paramName, matcher]) => {
                                const paramValue = toolArgs[paramName];
                                if (paramValue === undefined)
                                    return false;
                                // Simple string comparison for basic matching
                                if (typeof matcher === 'string') {
                                    return String(paramValue).includes(matcher) || matcher.includes('*');
                                }
                                return true;
                            });
                        }
                        // No match criteria means it's a default 'always' rule
                        return true;
                    }));
            if (hasAlwaysPolicy) {
                toolsNeedingIntervention.push(toolCalling);
                continue;
            }
            // Priority 2: User config is 'auto-run', all tools execute directly
            if (approvalMode === 'auto-run') {
                toolsToExecute.push(toolCalling);
                continue;
            }
            // Priority 3: User config is 'allow-list', check if tool is in whitelist
            if (approvalMode === 'allow-list') {
                if (allowList.includes(toolKey)) {
                    toolsToExecute.push(toolCalling);
                }
                else {
                    toolsNeedingIntervention.push(toolCalling);
                }
                continue;
            }
            // Priority 4: User config is 'manual' (default), use tool's own config
            // Note: config is already retrieved above for 'always' policy check
            const policy = InterventionChecker.shouldIntervene({
                config,
                securityBlacklist,
                toolArgs,
            });
            if (policy === 'never') {
                toolsToExecute.push(toolCalling);
            }
            else {
                // 'required' or undefined requires intervention
                toolsNeedingIntervention.push(toolCalling);
            }
        }
        return [toolsNeedingIntervention, toolsToExecute];
    }
    /**
     * Extract abort information from current context and state
     * Returns the necessary data to handle abort scenario
     */
    extractAbortInfo(context, state) {
        let hasToolsCalling = false;
        let toolsCalling = [];
        let parentMessageId = '';
        // Extract abort info based on current phase
        switch (context.phase) {
            case 'llm_result': {
                const payload = context.payload;
                hasToolsCalling = payload.hasToolsCalling || false;
                toolsCalling = payload.toolsCalling || [];
                parentMessageId = payload.parentMessageId;
                break;
            }
            case 'human_abort': {
                // When user cancels during LLM streaming, we enter human_abort phase
                // The payload contains tool calls info if LLM had started returning them
                const payload = context.payload;
                hasToolsCalling = payload.hasToolsCalling || false;
                toolsCalling = payload.toolsCalling || [];
                parentMessageId = payload.parentMessageId;
                break;
            }
            case 'tool_result':
            case 'tools_batch_result': {
                const payload = context.payload;
                parentMessageId = payload.parentMessageId;
                // Check if there are pending tool messages
                const pendingToolMessages = state.messages.filter((m) => m.role === 'tool' && m.pluginIntervention?.status === 'pending');
                if (pendingToolMessages.length > 0) {
                    hasToolsCalling = true;
                    toolsCalling = pendingToolMessages.map((m) => m.plugin).filter(Boolean);
                }
                break;
            }
        }
        return { hasToolsCalling, parentMessageId, toolsCalling };
    }
    /**
     * Find existing compression summary from messages
     * Looks for MessageGroup with type 'compression' and extracts its content
     */
    findExistingSummary(messages) {
        // Look for compression group summary in messages
        // The summary is typically stored as a system message with compression metadata
        // or as a MessageGroup content field
        for (const msg of messages) {
            if (msg.role === 'system' && msg.metadata?.compressionSummary) {
                return msg.content;
            }
            // Check for MessageGroup type compression
            if (msg.messageGroupType === 'compression' && msg.content) {
                return msg.content;
            }
        }
        return undefined;
    }
    /**
     * Handle abort scenario - unified abort handling logic
     */
    handleAbort(context, state) {
        const { hasToolsCalling, parentMessageId, toolsCalling } = this.extractAbortInfo(context, state);
        // If there are pending tool calls, resolve them
        if (hasToolsCalling && toolsCalling.length > 0) {
            return {
                payload: { parentMessageId, toolsCalling },
                type: 'resolve_aborted_tools',
            };
        }
        // No tools to resolve, directly finish
        return {
            reason: 'user_requested',
            reasonDetail: 'Operation cancelled by user',
            type: 'finish',
        };
    }
    async runner(context, state) {
        // Unified abort check: if operation is interrupted, handle abort scenario
        // This check is placed before phase handling to ensure consistent abort behavior
        if (state.status === 'interrupted') {
            return this.handleAbort(context, state);
        }
        switch (context.phase) {
            case 'init':
            case 'user_input': {
                // Check if context compression is enabled and needed before calling LLM
                const compressionEnabled = this.config.compressionConfig?.enabled ?? true; // Default to enabled
                if (compressionEnabled) {
                    const compressionCheck = shouldCompress(state.messages, {
                        maxWindowToken: this.config.compressionConfig?.maxWindowToken,
                    });
                    if (compressionCheck.needsCompression) {
                        // Context exceeds threshold, compress ALL messages into a single summary
                        return {
                            payload: {
                                currentTokenCount: compressionCheck.currentTokenCount,
                                existingSummary: this.findExistingSummary(state.messages),
                                messages: state.messages,
                            },
                            type: 'compress_context',
                        };
                    }
                }
                // User input received, call LLM to generate response
                // At this point, messages may have been preprocessed with RAG/Search
                return {
                    payload: {
                        ...context.payload,
                        messages: state.messages,
                    },
                    type: 'call_llm',
                };
            }
            case 'llm_result': {
                // LLM response received, check if it contains tool calls
                const { hasToolsCalling, toolsCalling, parentMessageId } = context.payload;
                if (hasToolsCalling && toolsCalling && toolsCalling.length > 0) {
                    // Check which tools need human intervention (includes DeFi Guard analysis)
                    const [toolsNeedingIntervention, toolsToExecute] = await this.checkInterventionNeeded(toolsCalling, state);
                    const instructions = [];
                    // Execute tools that don't need intervention first
                    // These will run immediately before any approval requests
                    if (toolsToExecute.length > 0) {
                        if (toolsToExecute.length > 1) {
                            instructions.push({
                                payload: {
                                    parentMessageId,
                                    toolsCalling: toolsToExecute,
                                },
                                type: 'call_tools_batch',
                            });
                        }
                        else {
                            instructions.push({
                                payload: {
                                    parentMessageId,
                                    toolCalling: toolsToExecute[0],
                                },
                                type: 'call_tool',
                            });
                        }
                    }
                    // Request approval for tools that need intervention
                    // Runtime will execute this after safe tools and pause with status='waiting_for_human'
                    if (toolsNeedingIntervention.length > 0) {
                        instructions.push({
                            pendingToolsCalling: toolsNeedingIntervention,
                            reason: 'human_intervention_required',
                            type: 'request_human_approve',
                        });
                    }
                    return instructions;
                }
                // No tool calls, conversation is complete
                return {
                    reason: 'completed',
                    reasonDetail: 'LLM response completed without tool calls',
                    type: 'finish',
                };
            }
            case 'tool_result': {
                const { data, parentMessageId, stop } = context.payload;
                // Check if this is a GTD async task request (only execTask/execTasks are passed here with stop=true)
                if (stop && data?.state) {
                    const stateType = data.state.type;
                    // GTD async task (single)
                    if (stateType === 'execTask') {
                        const { parentMessageId: execParentId, task } = data.state;
                        return {
                            payload: { parentMessageId: execParentId, task },
                            type: 'exec_task',
                        };
                    }
                    // GTD async tasks (multiple)
                    if (stateType === 'execTasks') {
                        const { parentMessageId: execParentId, tasks } = data.state;
                        return {
                            payload: { parentMessageId: execParentId, tasks },
                            type: 'exec_tasks',
                        };
                    }
                    // GTD client-side async task (single, desktop only)
                    if (stateType === 'execClientTask') {
                        const { parentMessageId: execParentId, task } = data.state;
                        return {
                            payload: { parentMessageId: execParentId, task },
                            type: 'exec_client_task',
                        };
                    }
                    // GTD client-side async tasks (multiple, desktop only)
                    if (stateType === 'execClientTasks') {
                        const { parentMessageId: execParentId, tasks } = data.state;
                        return {
                            payload: { parentMessageId: execParentId, tasks },
                            type: 'exec_client_tasks',
                        };
                    }
                }
                // Check if there are still pending tool messages waiting for approval
                const pendingToolMessages = state.messages.filter((m) => m.role === 'tool' && m.pluginIntervention?.status === 'pending');
                // If there are pending tools, wait for human approval
                if (pendingToolMessages.length > 0) {
                    const pendingTools = pendingToolMessages.map((m) => m.plugin).filter(Boolean);
                    return {
                        pendingToolsCalling: pendingTools,
                        reason: 'Some tools still pending approval',
                        skipCreateToolMessage: true,
                        type: 'request_human_approve',
                    };
                }
                // No pending tools, continue to call LLM with tool results
                return {
                    payload: {
                        messages: state.messages,
                        model: this.config.modelRuntimeConfig?.model,
                        parentMessageId,
                        provider: this.config.modelRuntimeConfig?.provider,
                        tools: state.tools,
                    },
                    type: 'call_llm',
                };
            }
            case 'tools_batch_result': {
                const { parentMessageId } = context.payload;
                // Check if there are still pending tool messages waiting for approval
                const pendingToolMessages = state.messages.filter((m) => m.role === 'tool' && m.pluginIntervention?.status === 'pending');
                // If there are pending tools, wait for human approval
                if (pendingToolMessages.length > 0) {
                    const pendingTools = pendingToolMessages.map((m) => m.plugin).filter(Boolean);
                    return {
                        pendingToolsCalling: pendingTools,
                        reason: 'Some tools still pending approval',
                        skipCreateToolMessage: true,
                        type: 'request_human_approve',
                    };
                }
                // No pending tools, continue to call LLM with tool results
                return {
                    payload: {
                        messages: state.messages,
                        model: this.config.modelRuntimeConfig?.model,
                        parentMessageId,
                        provider: this.config.modelRuntimeConfig?.provider,
                        tools: state.tools,
                    },
                    type: 'call_llm',
                };
            }
            case 'task_result': {
                // Single async task completed, continue to call LLM with result
                const { parentMessageId } = context.payload;
                // Continue to call LLM with updated messages (task message is already in state)
                return {
                    payload: {
                        messages: state.messages,
                        model: this.config.modelRuntimeConfig?.model,
                        parentMessageId,
                        provider: this.config.modelRuntimeConfig?.provider,
                        tools: state.tools,
                    },
                    type: 'call_llm',
                };
            }
            case 'tasks_batch_result': {
                // Async tasks batch completed, continue to call LLM with results
                const { parentMessageId } = context.payload;
                // Inject a virtual user message to force the model to summarize or continue
                // This fixes an issue where some models (e.g., Kimi K2) return empty content
                // when the last message is a task result, thinking the task is already done
                const messagesWithPrompt = [
                    ...state.messages,
                    {
                        content: 'All tasks above have been completed. Please summarize the results or continue with your response following user query language.',
                        role: 'user',
                    },
                ];
                // Continue to call LLM with updated messages (task messages are already in state)
                return {
                    payload: {
                        messages: messagesWithPrompt,
                        model: this.config.modelRuntimeConfig?.model,
                        parentMessageId,
                        provider: this.config.modelRuntimeConfig?.provider,
                        tools: state.tools,
                    },
                    type: 'call_llm',
                };
            }
            case 'compression_result': {
                // Context compression completed, continue to call LLM
                const compressionPayload = context.payload;
                // If compression was skipped (no messages to compress), just call LLM
                // Otherwise, messages have been updated with compressed content
                // Pass parentMessageId and createAssistantMessage=true to force new message creation
                return {
                    payload: {
                        // Force create new assistant message after compression
                        createAssistantMessage: true,
                        messages: compressionPayload.compressedMessages,
                        model: this.config.modelRuntimeConfig?.model,
                        parentMessageId: compressionPayload.parentMessageId,
                        provider: this.config.modelRuntimeConfig?.provider,
                        tools: state.tools,
                    },
                    type: 'call_llm',
                };
            }
            case 'human_abort': {
                // User aborted the operation
                const { hasToolsCalling, parentMessageId, toolsCalling, reason } = context.payload;
                // If there are pending tool calls, resolve them
                if (hasToolsCalling && toolsCalling && toolsCalling.length > 0) {
                    return {
                        payload: { parentMessageId, toolsCalling },
                        type: 'resolve_aborted_tools',
                    };
                }
                // No tools to resolve, directly finish
                return { reason: 'user_requested', reasonDetail: reason, type: 'finish' };
            }
            case 'error': {
                // Error occurred, finish execution
                const { error } = context.payload;
                return {
                    reason: 'error_recovery',
                    reasonDetail: error?.message || 'Unknown error occurred',
                    type: 'finish',
                };
            }
            default: {
                // Unknown phase, finish execution
                return {
                    reason: 'agent_decision',
                    reasonDetail: `Unknown phase: ${context.phase}`,
                    type: 'finish',
                };
            }
        }
    }
}
