// Canonical chat model + provider routing — the single source of truth shared
// by every LLM chat backend (api/chat.js, api/widgets, api/brain, ...).
//
// Two design rules drive this file:
//
//   1. FREE PROVIDERS FIRST, ALWAYS. The platform holds three free-tier keys —
//      Groq (fastest, first-attempt-reliable), OpenRouter (:free models), and
//      NVIDIA NIM (one nvapi key, 100+ hosted models) — and the ladder leads
//      with them in that order. Paid providers (Anthropic, OpenAI) are
//      LAST-RESORT backstops only: the prod paid keys are routinely invalid
//      (Anthropic 401) or out of quota (OpenAI), so any ordering that leads
//      with them burns a doomed attempt on every request. With three
//      independent free lanes, a request should never surface a provider
//      error to the user.
//
//   2. CAPABILITY-AWARE ROUTING. Every model is annotated with what it can do
//      ({ tools, moderationGated }). The router consults MODEL_CATALOG and
//      skips models a request can't use (e.g. a tool-required request never
//      selects a non-tool model) instead of round-tripping to the provider to
//      discover the limitation at call time.
//
// Permanently-broken routes have been removed from the catalog rather than
// carried as dead weight (they would never succeed):
//   - mistralai/mistral-7b-instruct:free → OpenRouter 404 "No endpoints found"
//   - meta-llama/llama-3.2-3b-instruct:free → no tool-capable endpoint
//
// Operational note (ops must act): the OpenAI account is over quota and the
// prod Anthropic key 401s. Both are intentionally ranked at the very END of
// the ladder — dead final tiers that only burn an attempt after every free
// lane is exhausted. Fix the keys or remove them to drop them entirely.

/**
 * Capability metadata per chat model id — the routing brain. Only models
 * listed here are auto-selectable; the router uses these flags to avoid
 * calling a model a request can't use.
 *
 *   provider        — which upstream serves this model id
 *   tools           — exposes a tool/function-calling endpoint
 *   moderationGated — upstream intermittently refuses without a moderation /
 *                     data policy (OpenRouter 403 "requires moderation"). Such
 *                     models are excluded from auto-built fallback chains but
 *                     remain usable when a caller names them explicitly.
 */
export const MODEL_CATALOG = {
	// ── Anthropic (paid; host or BYOK key) — most reliable when keyed ──────────
	'claude-fable-5':             { provider: 'anthropic', tools: true },
	// Mythos 5 shares Fable 5's underlying capabilities but is a restricted-access
	// model — it is never auto-selected into a fallback chain, only used when a
	// caller names it explicitly (modeled with the same `moderationGated` gate).
	'claude-mythos-5':            { provider: 'anthropic', tools: true, moderationGated: true },
	'claude-opus-4-7':            { provider: 'anthropic', tools: true },
	'claude-opus-4-6':            { provider: 'anthropic', tools: true },
	'claude-sonnet-4-6':          { provider: 'anthropic', tools: true },
	'claude-haiku-4-5-20251001':  { provider: 'anthropic', tools: true },

	// ── Groq free tier — fast (sub-second) and first-attempt-reliable ─────────
	'llama-3.3-70b-versatile':    { provider: 'groq', tools: true },
	'llama-3.1-8b-instant':       { provider: 'groq', tools: true },

	// ── OpenRouter free tier — rate-limited per model; tool support varies ────
	'meta-llama/llama-3.3-70b-instruct:free':     { provider: 'openrouter', tools: true },
	'nousresearch/hermes-3-llama-3.1-405b:free':  { provider: 'openrouter', tools: true },
	// GPT-OSS 120B is the historical platform default, but its free OpenRouter
	// endpoint is intermittently moderation-gated (403 "requires moderation on
	// OpenInference"). Kept usable for explicit callers (e.g. the /chat app), but
	// never auto-selected for the primary path or auto-built fallback chains.
	//
	// T4.2 (anon moderation pre-filter) evaluated re-promoting this route and
	// DECLINED: OpenRouter's "requires moderation" gate is an account-level
	// policy toggle on OpenRouter's side — it is NOT satisfied by us pre-moderating
	// upstream of the call (the gate fires before our verdict is ever relevant).
	// Our NemoGuard pre-filter therefore does not unlock this endpoint; it stays
	// demoted until the OpenRouter account's data/moderation setting is verified.
	// (tasks/nvidia-nim/probes/moderation.md)
	'openai/gpt-oss-120b:free':   { provider: 'openrouter', tools: true, moderationGated: true },

	// ── NVIDIA NIM free tier — one nvapi key, OpenAI-compatible ───────────────
	'meta/llama-3.3-70b-instruct':               { provider: 'nvidia', tools: true },
	'nvidia/llama-3.3-nemotron-super-49b-v1.5':  { provider: 'nvidia', tools: true },

	// ── OpenAI (paid) — see operational note above; ranked last ───────────────
	'gpt-5.6-sol':                { provider: 'openai', tools: true },
	'gpt-5.6-terra':              { provider: 'openai', tools: true },
	'gpt-5.6-luna':               { provider: 'openai', tools: true },
};

/**
 * Anthropic model ids that the Vertex Claude transport (api/_lib/vertex-claude.js)
 * can serve when VERTEX_CLAUDE_ENABLED is set. The SAME ids serve both first-party
 * Anthropic and Vertex — the transport is chosen by flag at request time, not by
 * the catalog — so these keep their `provider: 'anthropic'` entries above (tools,
 * gating, capability are identical). This list only tells the routing brain WHICH
 * Claude ids have a Vertex transport available; `vertexServesModel()` is the gate.
 * The dated Haiku id maps to Vertex's `@` form via toVertexModelId() at call time.
 */
export const VERTEX_ANTHROPIC_MODELS = [
	'claude-opus-4-7',
	'claude-sonnet-4-6',
	'claude-haiku-4-5-20251001',
];

/** Whether the Vertex Claude transport can serve a given Anthropic model id. */
export function vertexServesModel(modelId) {
	return VERTEX_ANTHROPIC_MODELS.includes(modelId);
}

/** Whether a model exposes a tool/function-calling endpoint. Unknown → false. */
export function modelSupportsTools(modelId) {
	return MODEL_CATALOG[modelId]?.tools === true;
}

/** Whether a model's upstream is moderation-gated (excluded from auto chains). */
export function isModelModerationGated(modelId) {
	return MODEL_CATALOG[modelId]?.moderationGated === true;
}

/**
 * Filter a candidate model list down to those usable for a request.
 * @param {string[]} models     candidate model ids, in priority order
 * @param {object}   opts
 * @param {boolean}  opts.requireTools  drop models with no tool endpoint
 * @param {boolean}  opts.allowGated    keep moderation-gated models (default false)
 */
export function usableModels(models, { requireTools = false, allowGated = false } = {}) {
	return models.filter((m) => {
		const meta = MODEL_CATALOG[m];
		if (!meta) return false;
		if (requireTools && !meta.tools) return false;
		if (!allowGated && meta.moderationGated) return false;
		return true;
	});
}

/**
 * Default OpenRouter free model: the reliable, tool-capable Llama 3.3 70B free
 * endpoint. (Was GPT-OSS 120B, demoted for the moderation gate above.) Used as
 * the platform default wherever a free OpenRouter model is requested.
 */
export const DEFAULT_FREE_MODEL = 'meta-llama/llama-3.3-70b-instruct:free';

/** Default per-provider model when the caller doesn't name one. */
export const PROVIDER_MODEL_DEFAULTS = {
	anthropic: 'claude-sonnet-4-6',
	openrouter: DEFAULT_FREE_MODEL,
	groq: 'llama-3.3-70b-versatile',
	nvidia: 'meta/llama-3.3-70b-instruct',
	openai: 'gpt-5.6-luna',
};

/**
 * Provider order to try when none is explicitly requested ("auto"). Free
 * providers always lead; paid keys are last-resort backstops (see design rule
 * 1 above — the prod paid keys are routinely dead, and three independent free
 * lanes must absorb everything):
 *   1. groq       — fastest free tier, answers on the first attempt. Per-minute
 *                   caps only; the primary for all traffic.
 *   2. openrouter — free :free models (reliable Llama 3.3 70B; see
 *                   DEFAULT_FREE_MODEL), multi-key rotation in llm.js.
 *   3. nvidia     — NVIDIA NIM free tier; an independent third lane on a
 *                   different account/infra than the first two.
 *   4. anthropic  — paid backstop; only reached when every free lane failed
 *                   (and currently 401s in prod — see operational note).
 *   5. openai     — paid backstop; account over quota (see operational note).
 * Providers without a configured key are skipped, so the effective ladder is
 * short in the common case. A provider in a health cooldown (see
 * api/_lib/provider-health.js) is also skipped for the cooldown window.
 */
export const DEFAULT_PROVIDER_ORDER = ['groq', 'openrouter', 'nvidia', 'anthropic', 'openai'];

/**
 * OpenRouter sibling models for per-model rate-limit failover. OpenRouter's
 * `:free` tier rate-limits per model, so a burst on the primary free model
 * degrades to a sibling free model before the chain moves to the next provider.
 * All entries are tool-capable and non-gated (dead/gated routes removed).
 */
export const OPENROUTER_SIBLINGS = [
	DEFAULT_FREE_MODEL,
	'nousresearch/hermes-3-llama-3.1-405b:free',
];

/** Providers an anonymous (unauthenticated) caller may use — free tiers only. */
export const ANON_PROVIDER_LIST = ['groq', 'openrouter', 'nvidia'];

/**
 * Bounds on the fallback chain so a single request can't churn through every
 * provider and still time out. The router stops failing over once either limit
 * is hit and returns a clean terminal error.
 *   MAX_FALLBACK_ATTEMPTS — hard cap on upstream attempts per request.
 *   TOTAL_BUDGET_MS       — wall-clock budget across all attempts (< the 60s
 *                           function limit, leaving headroom to stream a reply).
 *   PER_CALL_TIMEOUT_MS   — per-attempt abort ceiling. A single hung provider
 *                           must not consume the whole TOTAL_BUDGET_MS; we abort
 *                           the fetch at this bound (or the remaining budget,
 *                           whichever is smaller) and fail over to the next route.
 */
export const MAX_FALLBACK_ATTEMPTS = 4;
export const TOTAL_BUDGET_MS = 25_000;
export const PER_CALL_TIMEOUT_MS = 15_000;
