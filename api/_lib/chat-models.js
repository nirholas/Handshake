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
	'claude-opus-5':              { provider: 'anthropic', tools: true },
	'claude-sonnet-5':            { provider: 'anthropic', tools: true },
	'claude-opus-4-8':            { provider: 'anthropic', tools: true },
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
	//
	// OpenRouter retires `:free` endpoints with no notice, and a retired id is
	// indistinguishable from a typo at call time ("This model is unavailable for
	// free"). On 2026-07-27 every id this block previously listed was gone at
	// once — meta-llama/llama-3.3-70b-instruct:free,
	// nousresearch/hermes-3-llama-3.1-405b:free and openai/gpt-oss-120b:free —
	// which silently took the whole OpenRouter free lane out of the ladder.
	//
	// The ids below were verified live, but treat them as perishable: the
	// anonymous /chat lane no longer depends on any of them, because
	// _lib/openrouter-free.js resolves models from OpenRouter's live list at
	// request time. When one of these starts failing, check that module's live
	// list first rather than assuming a provider outage.
	'openai/gpt-oss-20b:free':                    { provider: 'openrouter', tools: true },
	'nvidia/nemotron-3-super-120b-a12b:free':     { provider: 'openrouter', tools: true },
	'google/gemma-4-31b-it:free':                 { provider: 'openrouter', tools: true },
	'inclusionai/ling-3.0-flash:free':            { provider: 'openrouter', tools: true },

	// ── OpenRouter paid (BYOK, ~$0.05/$0.10 per 1M tok) — IBM Granite lane ─────
	// Cheap, tool-capable Granite 4.1 for the "embed a Granite agent" surface.
	// `paid: true` is load-bearing: unlike every other openrouter entry (which is
	// a free `:free` model), this one draws real spend on the funded key, so it is
	// gated to authenticated callers (isPaidModel → chat.js anon reject) and metered
	// in llm-pricing.js. It is never in an auto-built fallback chain (OPENROUTER_SIBLINGS
	// is free-only), so it is reached only when a signed-in caller names it explicitly.
	'ibm-granite/granite-4.1-8b': { provider: 'openrouter', tools: true, paid: true },

	// ── NVIDIA NIM free tier — one nvapi key, OpenAI-compatible ───────────────
	'meta/llama-3.3-70b-instruct':               { provider: 'nvidia', tools: true },
	'nvidia/llama-3.3-nemotron-super-49b-v1.5':  { provider: 'nvidia', tools: true },

	// ── xAI Grok (paid; host or BYOK key) — OpenAI-compatible at api.x.ai ─────
	'grok-4.5':                   { provider: 'grok', tools: true },
	'grok-4.3':                   { provider: 'grok', tools: true },
	'grok-4.1-fast':              { provider: 'grok', tools: true },

	// ── OpenAI (paid) — see operational note above; ranked last ───────────────
	'gpt-5.6-sol':                { provider: 'openai', tools: true },
	'gpt-5.6-terra':              { provider: 'openai', tools: true },
	'gpt-5.6-luna':               { provider: 'openai', tools: true },
	'gpt-5.5':                    { provider: 'openai', tools: true },
	'gpt-5.5-pro':                { provider: 'openai', tools: true },
	'gpt-5.4':                    { provider: 'openai', tools: true },
	'gpt-5.4-pro':                { provider: 'openai', tools: true },
	'gpt-5.4-mini':               { provider: 'openai', tools: true },
	'gpt-5.4-nano':               { provider: 'openai', tools: true },
	'gpt-5.3-codex':              { provider: 'openai', tools: true },
	'o3':                         { provider: 'openai', tools: true },
	'o3-pro':                     { provider: 'openai', tools: true },
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
	'claude-opus-5',
	'claude-sonnet-5',
	'claude-opus-4-8',
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
 * Whether a model is a paid/BYOK lane that draws real spend on the platform key.
 * These are gated to authenticated callers (never exposed to anon free-tier
 * traffic) and are metered in llm-pricing.js rather than priced to zero.
 */
export function isPaidModel(modelId) {
	return MODEL_CATALOG[modelId]?.paid === true;
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
 * Default OpenRouter free model: tool-capable GPT-OSS 20B, the surviving member
 * of the GPT-OSS family after the 120B free endpoint was retired. Used as the
 * platform default wherever a free OpenRouter model is requested.
 *
 * (Previously Llama 3.3 70B, which OpenRouter retired along with every other id
 * this file used to name — see the free-tier block above.)
 */
export const DEFAULT_FREE_MODEL = 'openai/gpt-oss-20b:free';

/** Default per-provider model when the caller doesn't name one. */
export const PROVIDER_MODEL_DEFAULTS = {
	anthropic: 'claude-sonnet-5',
	openrouter: DEFAULT_FREE_MODEL,
	groq: 'llama-3.3-70b-versatile',
	nvidia: 'meta/llama-3.3-70b-instruct',
	openai: 'gpt-5.4-nano',
	grok: 'grok-4.5',
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
 *   6. grok       — paid backstop (xAI); usually reached only via an explicit
 *                   provider/model request or a BYOK key.
 * Providers without a configured key are skipped, so the effective ladder is
 * short in the common case. A provider in a health cooldown (see
 * api/_lib/provider-health.js) is also skipped for the cooldown window.
 */
export const DEFAULT_PROVIDER_ORDER = ['groq', 'openrouter', 'nvidia', 'anthropic', 'openai', 'grok'];

/**
 * OpenRouter sibling models for per-model rate-limit failover. OpenRouter's
 * `:free` tier rate-limits per model, so a burst on the primary free model
 * degrades to a sibling free model before the chain moves to the next provider.
 * All entries are tool-capable and non-gated (dead/gated routes removed).
 */
export const OPENROUTER_SIBLINGS = [
	DEFAULT_FREE_MODEL,
	'nvidia/nemotron-3-super-120b-a12b:free',
	'google/gemma-4-31b-it:free',
	'inclusionai/ling-3.0-flash:free',
];

/**
 * Providers an anonymous (unauthenticated) caller may use. The first three are
 * third-party free tiers; when all of them are rate-limited an anon request
 * would otherwise 503, so `vertex-gemini` (the credits-funded Vertex anchor,
 * effectively free to the user and the only rung with no third-party quota to
 * exhaust) is included as the last-resort anchor. Its rung carries its own
 * fixed model, so it is never auto-selected as an initial route — it is only
 * reached via failover once the free tiers are exhausted.
 */
export const ANON_PROVIDER_LIST = ['groq', 'openrouter', 'nvidia', 'vertex-gemini'];

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
