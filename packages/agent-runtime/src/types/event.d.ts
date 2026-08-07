import { ChatToolPayload } from './vendor.js';
import type { AgentState, ToolsCalling } from './state.js';
export interface AgentEventInit {
    type: 'init';
}
export interface AgentEventLlmStart {
    type: 'llm_start';
    payload: unknown;
}
export interface AgentEventLlmStream {
    type: 'llm_stream';
    chunk: unknown;
}
export interface AgentEventLlmResult {
    type: 'llm_result';
    result: unknown;
}
export interface AgentEventToolPending {
    type: 'tool_pending';
    toolCalls: ToolsCalling[];
}
export interface AgentEventToolResult {
    type: 'tool_result';
    id: string;
    result: any;
}
export interface AgentEventHumanApproveRequired {
    type: 'human_approve_required';
    pendingToolsCalling: ChatToolPayload[];
    operationId: string;
}
export interface AgentEventHumanPromptRequired {
    type: 'human_prompt_required';
    metadata?: Record<string, unknown>;
    prompt: string;
    operationId: string;
}
export interface AgentEventHumanSelectRequired {
    type: 'human_select_required';
    metadata?: Record<string, unknown>;
    multi?: boolean;
    options: {
        label: string;
        value: string;
    }[];
    prompt?: string;
    operationId: string;
}
/**
 * Standardized finish reasons
 */
export type FinishReason = 'completed' | 'user_requested' | 'user_aborted' | 'max_steps_exceeded' | 'cost_limit_exceeded' | 'timeout' | 'agent_decision' | 'error_recovery' | 'system_shutdown';
export interface AgentEventDone {
    type: 'done';
    finalState: AgentState;
    reason: FinishReason;
    reasonDetail?: string;
}
export interface AgentEventError {
    type: 'error';
    error: any;
}
export interface AgentEventInterrupted {
    type: 'interrupted';
    reason: string;
    interruptedAt: string;
    interruptedInstruction?: any;
    canResume: boolean;
    metadata?: Record<string, unknown>;
}
export interface AgentEventResumed {
    type: 'resumed';
    reason: string;
    resumedAt: string;
    resumedFromStep: number;
    metadata?: Record<string, unknown>;
}
export interface AgentEventCompressionComplete {
    type: 'compression_complete';
    groupId: string;
    parentMessageId?: string;
}
export interface AgentEventCompressionError {
    type: 'compression_error';
    error: unknown;
}
/**
 * Events emitted by the AgentRuntime during execution
 */
export type AgentEvent = AgentEventInit | AgentEventLlmStart | AgentEventLlmStream | AgentEventLlmResult | AgentEventToolPending | AgentEventToolResult | AgentEventDone | AgentEventError | AgentEventHumanApproveRequired | AgentEventHumanPromptRequired | AgentEventHumanSelectRequired | AgentEventInterrupted | AgentEventResumed | AgentEventCompressionComplete | AgentEventCompressionError;
