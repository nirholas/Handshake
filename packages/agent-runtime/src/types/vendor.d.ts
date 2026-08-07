/**
 * Host-app types the runtime consumes.
 *
 * Inlined from the host chat platform's shared type package so this package
 * stands alone: the runtime needs the shapes, not the host. Zod schemas were
 * deliberately left behind; every consumer here treats these as compile-time
 * contracts only.
 */
/** How a tool's result is rendered by the host UI. */
export type ToolRenderType = 'default' | 'markdown' | 'standalone' | 'builtin' | 'mcp';
/** Where a tool comes from. */
export type ToolSource = 'builtin' | 'plugin' | 'mcp' | 'skill';
/** Human-approval state attached to a tool call by the host. */
export interface ToolIntervention {
    rejectedReason?: string;
    status?: 'pending' | 'approved' | 'rejected' | 'aborted' | 'none';
}
/** One tool invocation as the runtime sees it. */
export interface ChatToolPayload {
    apiName: string;
    /** JSON-encoded arguments, exactly as produced by the model. */
    arguments: string;
    id: string;
    identifier: string;
    intervention?: ToolIntervention;
    result_msg_id?: string;
    source?: ToolSource;
    thoughtSignature?: string;
    type: ToolRenderType;
}
/** The function portion of an OpenAI-format tool call. */
export interface ToolFunction {
    /** JSON-encoded arguments; may be invalid JSON, validate before use. */
    arguments: string;
    name: string;
}
/** OpenAI-format tool call as returned by a model. */
export interface MessageToolCall {
    function: ToolFunction;
    id: string;
    thoughtSignature?: string;
    type: 'function' | string;
}
/** Token usage breakdown reported by a model call. */
export interface ModelTokensUsage {
    inputCachedTokens?: number;
    inputCacheMissTokens?: number;
    inputWriteCacheTokens?: number;
    inputTextTokens?: number;
    inputImageTokens?: number;
    inputAudioTokens?: number;
    inputCitationTokens?: number;
    outputTextTokens?: number;
    outputImageTokens?: number;
    outputAudioTokens?: number;
    outputReasoningTokens?: number;
    acceptedPredictionTokens?: number;
    rejectedPredictionTokens?: number;
    totalInputTokens?: number;
    totalOutputTokens?: number;
    totalTokens?: number;
    /** @deprecated Use totalInputTokens instead */
    inputTokens?: number;
    /** @deprecated Use totalOutputTokens instead */
    outputTokens?: number;
    /** @deprecated Use outputReasoningTokens instead */
    reasoningTokens?: number;
    /** @deprecated Use outputImageTokens instead */
    imageTokens?: number;
    /** @deprecated Use inputCachedTokens instead */
    cachedTokens?: number;
}
/** Usage plus the dollar cost derived from it. */
export interface ModelUsage extends ModelTokensUsage {
    /** Dollars. */
    cost?: number;
}
/**
 * Human intervention policy for a tool API.
 * - `never`: auto-execute
 * - `required`: needs approval, bypassable by the user's auto-run mode
 * - `always`: needs approval, never bypassable
 */
export type HumanInterventionPolicy = 'never' | 'required' | 'always';
/**
 * Argument matcher for parameter-level rules. A plain string matches by
 * substring/wildcard; the object form selects an explicit strategy.
 */
export type ArgumentMatcher = string | {
    pattern: string;
    type: 'exact' | 'prefix' | 'wildcard' | 'regex';
};
/** One parameter-level intervention rule. */
export interface HumanInterventionRule {
    /** Per-argument matchers; the rule applies when every matcher matches. */
    match?: Record<string, ArgumentMatcher>;
    policy: HumanInterventionPolicy;
}
/** Either a uniform policy or an ordered rule list. */
export type HumanInterventionConfig = HumanInterventionPolicy | HumanInterventionRule[];
/** The user's global approval configuration for a session. */
export interface UserInterventionConfig {
    /** Pre-approved tools in `identifier/apiName` form (allow-list mode). */
    allowList?: string[];
    /**
     * - `auto-run`: approve everything
     * - `allow-list`: approve only listed tools
     * - `manual`: follow each tool's own config (default)
     * - `headless`: fully automated; blacklisted tools are skipped, not blocked
     */
    approvalMode: 'auto-run' | 'allow-list' | 'manual' | 'headless';
}
/** A rule that force-blocks dangerous operations regardless of user settings. */
export interface SecurityBlacklistRule {
    /** Why this rule exists; surfaced in error messages. */
    description: string;
    match: Record<string, ArgumentMatcher>;
}
export type SecurityBlacklistConfig = SecurityBlacklistRule[];
/** Parameters for `InterventionChecker.shouldIntervene`. */
export interface ShouldInterveneParams {
    config: HumanInterventionConfig | undefined;
    /** Tool keys the user already confirmed (for remember-my-choice flows). */
    confirmedHistory?: string[];
    /** Blacklist rules checked first; they override every other setting. */
    securityBlacklist?: SecurityBlacklistConfig;
    toolArgs?: Record<string, any>;
    /** `identifier/apiName` or `identifier/apiName#argsHash`. */
    toolKey?: string;
}
/** Status of a step-context todo item. */
export type StepContextTodoStatus = 'todo' | 'processing' | 'completed';
export interface StepContextTodoItem {
    status: StepContextTodoStatus;
    text: string;
}
export interface StepContextTodos {
    items: StepContextTodoItem[];
    updatedAt: string;
}
/** Latest page-editor XML, refreshed each step. */
export interface StepPageEditorContext {
    xml: string;
}
/** Page-editor context captured once at operation start. */
export interface InitialPageEditorContext {
    markdown: string;
    metadata: {
        charCount?: number;
        lineCount?: number;
        title: string;
    };
    xml: string;
}
/**
 * Dynamic per-step context, computed by the runtime at the start of each step
 * and injected into executors. Executors read from it and return new state via
 * their result, never by mutating it.
 */
export interface RuntimeStepContext {
    stepPageEditor?: StepPageEditorContext;
    todos?: StepContextTodos;
}
/** Context captured at operation initialization; constant for the whole run. */
export interface RuntimeInitialContext {
    pageEditor?: InitialPageEditorContext;
}
