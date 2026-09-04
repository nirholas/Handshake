// Canonical server-side text completion + the platform's LLM provider policy.
//
// Policy (do not re-implement per endpoint — that is how this drifted before):
//
//   • FREE PROVIDERS FIRST, ALWAYS. Groq, Cerebras, OpenRouter (paid model,
//     then the :free variant on the same key), Gemini AI Studio, and NVIDIA
//     NIM are platform-funded free tiers — the server holds those keys and
//     callers use them at zero marginal cost. OVH AI Endpoints and Pollinations
//     need no key at all (anonymous/keyless tiers) and are always in the chain,
//     so llmConfigured() is never false even with zero env vars set. They form
//     the default chain, tried in order, 70B-class models before any capability
//     step-down, and every flow must survive on them alone: the paid keys in
//     prod are routinely invalid or out of quota, so a chain that depends on
//     them fails.
//
//   • THE FREE TIER KEEPS GROWING. SambaNova, Mistral (Experiment tier),
//     Z.AI GLM Flash, Cloudflare Workers AI, and SiliconFlow are optional
//     keyed rungs (each skipped when its env var is unset), and LLM7.io is a
//     second keyless anonymous rung alongside OVH and Pollinations. Every new
//     free provider is an independent quota pool, so adding one raises the
//     ceiling of traffic the platform serves at zero marginal cost.
//
//   • VERTEX GEMINI IS THE RELIABILITY ANCHOR. When GOOGLE_CLOUD_PROJECT is
//     set (every Cloud Run deploy), Gemini Flash-Lite on Vertex — service
//     account auth, GCP-credit billing, no third-party quota — sits between
//     the free tiers and the paid tail, so exhausting every free quota at
//     once still cannot produce an error.
//
//   • Paid server keys are the LAST-RESORT tier, automatically. When
//     ANTHROPIC_API_KEY or OPENAI_API_KEY is configured, those providers are
//     appended to the tail of EVERY chain so a request that exhausted the
//     free providers still succeeds instead of erroring. They never lead, and
//     no flow hard-fails when they are absent or out of quota.
//
//   • BYOK is the one exception to free-first: a caller-supplied
//     `anthropicKey` (e.g. an agent owner's own key) leads the chain — that's
//     the caller's explicit model choice on the caller's own billing — still
//     degrading to the free chain on failure.
//
// Consolidated from the multi-provider fallback that already lived in
// api/persona/extract.js and api/persona/preview.js.

import { env } from './env.js';
import { recordEvent } from './usage.js';
import { costMicroUsd } from './llm-pricing.js';
import { sql } from './db.js';
import {
	vertexClaudeEnabled,
	vertexClaudePrimary,
	vertexMessagesUrl,
	vertexRequestHeaders,
	toVertexBody,
} from './vertex-claude.js';
import { vertexGeminiBudget } from './vertex-gemini.js';
import { DEFAULT_FREE_MODEL, promptCacheMinChars, isPaidModel } from './chat-models.js';

// Llama 3.x left Groq's catalog in 2026-08 (404 on every call); qwen3.8-27b is
// the fastest non-reasoning model there and returns clean content.
const GROQ_MODEL = 'qwen/qwen3.8-27b';
// Second Groq rung on a different model: Groq free-tier quotas are PER MODEL,
// so when the 70B lane is exhausted the instant lane usually still has budget.
// Smaller model, so it sits at the END of the free section — every 70B-class
// provider gets tried before the chain steps down in capability.
const GROQ_INSTANT_MODEL = 'openai/gpt-oss-20b';
// Third Groq rung, on a third independent per-model token pool. Groq meters
// tokens PER MODEL at 8,000 tokens/minute, which is roughly three fact-check
// stance calls before the rung 429s for the rest of the minute: that ceiling,
// not any outage, is why a burst of real work fell straight past a healthy Groq
// and down a chain whose next five rungs were dead. Each model id is a separate
// 8k bucket, so pooling three of them triples the burst Groq absorbs before the
// chain steps outside it. 120B rides directly behind the primary rung because
// it is the larger model; the 20B instant lane stays at the back of the free
// section, where a step DOWN in capability belongs.
//
// Measured 2026-09-04 off x-ratelimit-limit-tokens. groq/compound-mini
// advertises 70,000 instead and looks like the obvious pick, but it is an
// agentic model that internally routes to llama-3.3-70b-versatile, whose
// 100,000 tokens/DAY org cap was already 99.9% spent: it 429s in production
// while reporting a nearly-full per-minute budget. Do not add it on the
// strength of that header.
const GROQ_LARGE_MODEL = 'openai/gpt-oss-120b';
// Same Llama 3.3 70B on Cerebras' free tier (cloud.cerebras.ai) — optional
// rung, active when CEREBRAS_API_KEY is configured.
const CEREBRAS_MODEL = 'llama-3.3-70b';
// The FULL free model id, not a base id we append ':free' to. Appending assumes
// every paid model has a free twin, and that assumption is what broke this lane:
// meta-llama/llama-3.3-70b-instruct still exists, but its ':free' variant was
// retired, so the composed id 404'd on every call while the base id looked fine.
// Keep this in step with DEFAULT_FREE_MODEL in _lib/chat-models.js.
const OPENROUTER_FREE_MODEL = DEFAULT_FREE_MODEL;
// Gemini Flash-Lite on the AI Studio FREE tier (GEMINI_API_KEY): an external
// free quota, so it stays on the cheapest model.
const GEMINI_MODEL = 'gemini-2.5-flash-lite';
// The Vertex lane is different: it bills to the platform's own GCP credits
// (standing owner-approved spend, 2026-07-16), so it runs full Flash — a
// strict quality upgrade over Flash-Lite on the chain's most reliable rung —
// and stays env-tunable (e.g. google/gemini-2.5-pro for a quality-over-latency
// deployment) without a code change.
const VERTEX_GEMINI_MODEL = process.env.VERTEX_GEMINI_MODEL || 'google/gemini-2.5-flash';
// Same Llama 3.3 70B family on NVIDIA NIM (build.nvidia.com) — one free nvapi
// key, OpenAI-compatible, so the chain degrades across providers without
// changing model behavior.
// meta/llama-3.x on NIM reached end of life 2026-08-26 (HTTP 410). The
// nemotron-3 family is what serves now; it is a reasoning family, so the
// provider entries below disable thinking to keep content clean.
const NVIDIA_MODEL = 'nvidia/nemotron-3-super-120b-a12b';
// Compact, reasoning-tuned Nemotron a caller can opt into when it wants the
// NVIDIA-native model to lead (see `preferNvidia`/`nvidiaModel` below). Fast
// enough for a single prompt-refine turn; the rest of the free chain still
// backs it up if the NIM lane is down.
const NVIDIA_NEMOTRON_MODEL = 'nvidia/nemotron-3-nano-30b-a3b';
// nemotron-3 puts its reasoning in a separate field only when thinking is off;
// with it on, the chain of thought leaks into `content` (verified 2026-08-27).
const NVIDIA_NO_THINK = Object.freeze({ chat_template_kwargs: { enable_thinking: false } });
// OVH AI Endpoints anonymous tier: no key, no account, no signup — Llama 3.3
// 70B served free by OVHcloud's officially documented trial lane (not a ToS
// workaround). The tradeoff for needing zero setup is a tight 2 req/min per
// model per IP quota, so it rides at the back of the 70B-class group rather
// than leading. https://help.ovhcloud.com/csm/en-public-cloud-ai-endpoints-capabilities
const OVH_MODEL = 'Meta-Llama-3_3-70B-Instruct';
// SambaNova Cloud free tier (cloud.sambanova.ai): the same Llama 3.3 70B on
// yet another independent free quota pool (about 20 req/min and 200K
// tokens/day per model, no card required). Model id verified live against
// GET https://api.sambanova.ai/v1/models on 2026-08-05.
const SAMBANOVA_MODEL = 'Meta-Llama-3.3-70B-Instruct';
// Mistral's Experiment tier (console.mistral.ai): a genuinely large free
// quota (about 1B tokens/month at 1 req/sec) in exchange for opting the
// account into data training, which is fine for this chain: it carries
// platform utility traffic, not user secrets. The -latest alias tracks
// Mistral's current small release without a code change.
const MISTRAL_MODEL = 'mistral-small-latest';
// Z.AI (Zhipu) Flash lane (docs.z.ai): glm-4.7-flash is one of the
// permanently free, rate-limited Flash models on the OpenAI-compatible
// endpoint at api.z.ai. Strong coding/chat quality for a free lane.
const ZAI_MODEL = 'glm-4.7-flash';
// Cloudflare Workers AI: 10,000 free neurons/day on the account-scoped
// OpenAI-compatible endpoint. Needs BOTH CLOUDFLARE_ACCOUNT_ID and
// CLOUDFLARE_AI_API_TOKEN (the URL embeds the account id). The fp8-fast
// build keeps this rung in the 70B class.
const CLOUDFLARE_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
// SiliconFlow international (siliconflow.com): free-tier Qwen3 8B. A
// capability step-down, so it rides with the small-model group at the end
// of the free section; enable_thinking:false (extraBody below) keeps Qwen3's
// reasoning mode off so message.content carries the actual answer.
const SILICONFLOW_MODEL = 'Qwen/Qwen3-8B';
// LLM7.io (api.llm7.io): community-run gateway, about 30 req/min per IP. Free
// catalog probed live 2026-08-05; gemini-3.1-flash-lite returned real content
// there, while the gpt-oss route spends its token budget on reasoning and can
// hand back an empty content field, so it is deliberately not used. Added as a
// KEYLESS rung; llm7.io has since retired its anonymous tier and answers every
// unauthenticated request with 401 invalid_api_key (measured 2026-09-02), so
// the rung is now gated on LLM7_API_KEY and skipped without one.
const LLM7_MODEL = 'gemini-3.1-flash-lite';
// Pollinations' keyless anonymous tier: also no key, routes to a hosted
// gpt-oss-20b. Smaller than the 70B rungs above it, so it sits in the
// capability-step-down group alongside Groq's instant lane — an always-on
// fallback that needs nothing configured. https://github.com/pollinations/pollinations/blob/master/APIDOCS.md
const POLLINATIONS_MODEL = 'openai-fast';
// The NVIDIA free NIM lane sits behind a shared queue that, under load, holds a
// request far longer than a fallback rung should block the chain (observed live
// 2026-07-12: 25s hang on a 900-token compose prompt while groq/openrouter
// 402/429'd in <0.5s). As a fallback it gets a tight per-lane cap so the chain
// fails over to the reliable Vertex anchor in seconds. Read per-call (not a
// load-time const) so it's tunable via env without a redeploy; floored so a bad
// value can't disable the guard.
// Per-provider wall clock for one rung of the chain. Shared so a rung that wants
// "the same budget as everyone else" cannot drift from the number llmComplete
// actually enforces.
function perProviderTimeoutMs() {
	return Math.max(4_000, Number(process.env.LLM_PER_PROVIDER_TIMEOUT_MS) || 12_000);
}

// NIM's free tier queues under load, so this rung once carried a 6s cap to reach
// the credits-funded Vertex anchor below it "in seconds instead of blocking".
// That trade only pays while Vertex answers, and Vertex has been denying every
// call project-wide on a billing hold since 2026-08-27, so the cap was cutting a
// HEALTHY rung off in front of an unreachable one. Measured on 2026-09-04, NIM
// answers a full-size fact-check stance prompt (5.4KB in, 1024 tok out) in
// 1.8s-10.5s: the 6s cap discarded half of those. It now defaults to the same
// per-provider budget every other rung gets, and stays env-tunable for an
// operator who has a faster anchor underneath it.
function nvidiaLaneTimeoutMs() {
	return Math.max(2_000, Number(process.env.NVIDIA_LANE_TIMEOUT_MS) || perProviderTimeoutMs());
}
const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';
// Paid last-resort tail (see policy above). Mini keeps the backstop cheap; the
// repo-wide OpenAI default (api/_lib/chat-models.js) uses the same model.
const OPENAI_MODEL = 'gpt-5.4-nano';
// xAI Grok, OpenAI-compatible (api.x.ai). Paid, so it rides in the paid tail
// when the server GROK_API_KEY is set; a caller-supplied BYOK `grokKey` leads
// the chain instead (the caller's explicit model choice on their own billing).
// The budget 4.1-fast tier keeps the server backstop cheap; BYOK callers get
// the flagship via `grokModel`.
const GROK_URL = 'https://api.x.ai/v1/chat/completions';
const GROK_MODEL = 'grok-4.1-fast';
const GROK_BYOK_MODEL = 'grok-4.5';

// Per-user daily LLM spend cap, in micro-USD. Callers on the host's paid keys
// (ANTHROPIC_API_KEY / OPENAI_API_KEY) are metered; BYOK callers and free-tier
// providers (Groq/OpenRouter/NVIDIA) are exempt — cost to platform is $0.
// Default: $1.00/user/day. Override with LLM_USER_DAILY_CAP_USD env var.
function dailyCapMicroUsd() {
	const v = parseFloat(env.LLM_USER_DAILY_CAP_USD);
	return Number.isFinite(v) && v > 0 ? Math.round(v * 1_000_000) : 1_000_000;
}

// Check whether userId has exceeded the daily LLM spend cap. Only applies when
// the current request could route to paid server keys (ANTHROPIC or OPENAI
// configured). BYOK requests bill the caller's own key so the platform cap
// doesn't apply. Returns { exceeded: true, spentMicroUsd, capMicroUsd } when
// blocked, or { exceeded: false } when allowed. Never throws — fails open so a
// DB hiccup never silently denies a user.
export async function checkUserLlmSpendCap(userId, { anthropicKey, grokKey } = {}) {
	if (!userId) return { exceeded: false };
	if (anthropicKey || grokKey) return { exceeded: false }; // BYOK — not our billing
	if (!env.ANTHROPIC_API_KEY && !env.OPENAI_API_KEY && !env.GROK_API_KEY) return { exceeded: false }; // no paid keys at all
	const cap = dailyCapMicroUsd();
	try {
		// The cap meters ONLY genuinely-metered third-party paid keys (Anthropic /
		// OpenAI / Grok). Every zero-marginal-cost free lane is excluded, and so are
		// the two Vertex rungs: they bill the platform's own GCP credits (standing
		// owner-approved spend), and the owner directive is to never downgrade or
		// deny a user to save credits. Counting Vertex here would let credit-billed
		// spend push a user over the cap and lock them out of even the free chain —
		// exactly the wrong outcome. Vertex spend stays visible on the admin
		// dashboard (it is still priced and recorded); it just doesn't gate users.
		const [row] = await sql`
			SELECT COALESCE(SUM(cost_micro_usd), 0)::bigint AS spent
			FROM usage_events
			WHERE user_id = ${userId}
				AND kind = 'llm'
				AND provider NOT LIKE 'groq%'
				-- OpenRouter is only free on its ':free' routes. A paid vendor mirror
				-- on the platform key is real spend and counts against the cap.
				AND NOT (provider LIKE 'openrouter%' AND (model IS NULL OR model LIKE '%:free'))
				AND provider NOT LIKE 'vertex%'
				AND provider NOT IN ('nvidia', 'cerebras', 'gemini', 'ovh', 'pollinations', 'sambanova', 'mistral', 'zai', 'cloudflare', 'siliconflow', 'llm7')
				AND created_at > NOW() - INTERVAL '24 hours'
		`;
		const spent = Number(row?.spent ?? 0);
		if (spent >= cap) return { exceeded: true, spentMicroUsd: spent, capMicroUsd: cap };
		return { exceeded: false, spentMicroUsd: spent, capMicroUsd: cap };
	} catch (err) {
		console.warn('[llm] spend-cap check failed, allowing:', err?.message);
		return { exceeded: false };
	}
}

// Thrown when no provider is available at all. In practice this should never
// fire — the OVH and Pollinations keyless lanes are unconditional — but the
// class stays as a defensive fallback in case those calls are ever removed.
// Carries an HTTP status so handlers can surface it as 503.
export class LlmUnavailableError extends Error {
	constructor(message = 'No LLM provider available. Configure GROQ_API_KEY, OPENROUTER_API_KEY, or NVIDIA_API_KEY (free), or ANTHROPIC_API_KEY / OPENAI_API_KEY (paid backstop), or supply a BYOK Anthropic key.') {
		super(message);
		this.name = 'LlmUnavailableError';
		this.code = 'llm_unavailable';
		this.status = 503;
	}
}

// The Claude 5 family (Opus 5, Sonnet 5, Fable 5) thinks by default, so the
// first content block is often a `thinking` block whose text is empty — pick
// the first `text` block instead of blindly reading content[0].
function anthropicText(r) {
	const blocks = r.content;
	if (!Array.isArray(blocks)) return '';
	return blocks.find((b) => b?.type === 'text')?.text || '';
}

// Agent surfaces resend the same large system prompt every turn, and a cached
// read bills at ~0.1x input price — so a system prompt long enough to qualify
// gets a cache breakpoint. The qualifying length is per-model and varies 8x
// across the catalog (see promptCacheMinChars), so it is looked up rather than
// hardcoded: too low wastes a marker, too high forfeits real savings.
function anthropicSystemField(system, modelId) {
	if (typeof system === 'string' && system.length >= promptCacheMinChars(modelId)) {
		return [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
	}
	return system;
}

/**
 * Total prompt tokens for one completion, from an `llmComplete().usage`.
 *
 * Anthropic splits a cached prompt across three counters: `input` holds only
 * the UNCACHED remainder, with the rest on `cacheWrite`/`cacheRead`. Reading
 * `usage.input` alone therefore understates a cached prompt by most of its
 * size — silently, and in the flattering direction. Every caller reporting
 * "how many input tokens did that use" must go through this.
 *
 * Providers with no cache concept report 0 for both, so this is exact for
 * every lane, not just Anthropic.
 */
export function promptTokens(usage) {
	if (!usage) return 0;
	return (usage.input ?? 0) + (usage.cacheWrite ?? 0) + (usage.cacheRead ?? 0);
}

// Anthropic reports `input_tokens` as the UNCACHED remainder once caching is in
// play, with cache hits/writes on their own counters. Surfacing all three keeps
// spend metering honest (see recordLlmSpend / costMicroUsd).
function anthropicUsage(r) {
	return {
		input: r.usage?.input_tokens ?? 0,
		output: r.usage?.output_tokens ?? 0,
		cacheWrite: r.usage?.cache_creation_input_tokens ?? 0,
		cacheRead: r.usage?.cache_read_input_tokens ?? 0,
	};
}

function anthropicProvider(key, model) {
	const m = model || ANTHROPIC_MODEL;
	return {
		name: 'anthropic',
		model: m,
		url: 'https://api.anthropic.com/v1/messages',
		headers: {
			'content-type': 'application/json',
			'x-api-key': key,
			'anthropic-version': '2023-06-01',
		},
		buildBody: (system, user, maxTokens) => ({
			model: m,
			max_tokens: maxTokens,
			system: anthropicSystemField(system, m),
			messages: [{ role: 'user', content: user }],
		}),
		extractText: anthropicText,
		extractUsage: anthropicUsage,
	};
}

// Vertex-served Claude, same Anthropic Messages shape as anthropicProvider but
// billed to GCP credits. Headers carry a GCP OAuth bearer token resolved per
// request (getHeaders is async — the completion loop awaits it), the model id
// lives in the URL, and the body gains `anthropic_version`. A token-exchange or
// upstream failure falls through the chain exactly like any other provider.
function vertexAnthropicProvider(model) {
	const m = model || ANTHROPIC_MODEL;
	return {
		name: 'vertex-anthropic',
		model: m,
		url: vertexMessagesUrl(m, { stream: false }),
		getHeaders: vertexRequestHeaders,
		buildBody: (system, user, maxTokens) =>
			toVertexBody({
				model: m,
				max_tokens: maxTokens,
				system: anthropicSystemField(system, m),
				messages: [{ role: 'user', content: user }],
			}),
		extractText: anthropicText,
		extractUsage: anthropicUsage,
	};
}

// Gemini on Vertex AI through its OpenAI-compatible endpoint, authenticated
// with the GCP service account (no API key) and billed to platform credits.
// Unlike Vertex Claude this needs no Model Garden acceptance — Gemini is
// first-party on Vertex, so any deployment with GOOGLE_CLOUD_PROJECT and
// aiplatform access (the Cloud Run SA already drives the image lane) can use
// it. That makes this the chain's most reliable rung: it survives every
// third-party free-tier quota reset cycle. Token-exchange failures throw in
// getHeaders and fall through the chain like any other provider error.
function vertexGeminiProvider() {
	const project = process.env.GOOGLE_CLOUD_PROJECT;
	const location = process.env.GOOGLE_CLOUD_LOCATION_GEMINI || 'global';
	const host =
		location === 'global' ? 'aiplatform.googleapis.com' : `${location}-aiplatform.googleapis.com`;
	return {
		name: 'vertex-gemini',
		model: VERTEX_GEMINI_MODEL,
		url: `https://${host}/v1beta1/projects/${project}/locations/${location}/endpoints/openapi/chat/completions`,
		getHeaders: vertexRequestHeaders,
		buildBody: (system, user, maxTokens) => ({
			model: VERTEX_GEMINI_MODEL,
			// Gemini reasons by default and bills those tokens against max_tokens
			// without returning them, so an uncompensated budget comes back
			// truncated. vertexGeminiBudget caps the reasoning and funds it on top.
			...vertexGeminiBudget(maxTokens),
			messages: [
				...(system ? [{ role: 'system', content: system }] : []),
				{ role: 'user', content: user },
			],
		}),
		extractText: (r) => r.choices?.[0]?.message?.content || '',
		extractUsage: (r) => ({ input: r.usage?.prompt_tokens ?? 0, output: r.usage?.completion_tokens ?? 0 }),
	};
}

function openaiCompatProvider({ name, key = null, url, model, extraHeaders = {}, extraBody = null, extractCostUsd = null, timeoutMs = null }) {
	return {
		name,
		model,
		url,
		// Optional reader for the provider's own charge for the call, in USD.
		// Authoritative when present (see llm-pricing.costMicroUsd), a metered
		// lane that reports its cost must never be priced from a table guess.
		...(extractCostUsd ? { extractCostUsd } : {}),
		// Optional per-provider timeout cap, tighter than the chain-wide one. For a
		// lane that is known to QUEUE rather than fail fast (NVIDIA's free NIM sits
		// behind a shared queue and was observed hanging 25s on a 900-token prompt
		// while every other free lane 402/429'd in <0.5s), so the chain shouldn't
		// spend the general per-provider budget waiting on it before reaching a
		// reliable rung. Null = use the caller's general cap.
		...(timeoutMs ? { timeoutMs } : {}),
		// `key` is optional — the truly keyless free lanes (OVH anonymous tier,
		// Pollinations) reject requests that carry a bogus Authorization header, so
		// omit it entirely rather than sending "Bearer null".
		headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}), ...extraHeaders },
		buildBody: (system, user, maxTokens) => ({
			model,
			max_tokens: maxTokens,
			...(extraBody || {}),
			messages: [
				// A system message with `content: undefined` is rejected outright by
				// Groq ("'content' is missing", HTTP 400) — this was a live bug: every
				// llmComplete() caller that omits `system` (e.g. the fact-checker's
				// generateSearchQueries/analyzeResults) 400'd on the Groq lane instead
				// of falling through cleanly. Only emit the system message when one was
				// actually supplied.
				...(system ? [{ role: 'system', content: system }] : []),
				{ role: 'user', content: user },
			],
		}),
		extractText: (r) => r.choices?.[0]?.message?.content || '',
		extractUsage: (r) => ({ input: r.usage?.prompt_tokens ?? 0, output: r.usage?.completion_tokens ?? 0 }),
	};
}

// One OpenRouter rung. Every OpenRouter request opts into usage accounting
// (`usage: { include: true }`), so the response carries `usage.cost` in USD:
// the exact amount the account was charged. That number is what the spend
// ledger records. Without it OpenRouter traffic was priced from a table that
// had no entry for a namespaced id, which resolved to $0 and hid a real $30
// burn on the platform key until the balance was gone (llm-pricing.js).
function openrouterProvider({ name, key, model }) {
	return openaiCompatProvider({
		name,
		key,
		url: 'https://openrouter.ai/api/v1/chat/completions',
		model,
		extraHeaders: { 'HTTP-Referer': 'https://three.ws', 'X-Title': 'three.ws' },
		extraBody: { usage: { include: true } },
		extractCostUsd: (r) => (Number.isFinite(r?.usage?.cost) ? r.usage.cost : null),
	});
}

// Paid Claude through OpenRouter's vendor mirror, for the surfaces that reach
// Anthropic ONLY via api.anthropic.com (this module and api/chat.js) and so get
// no Claude at all while ANTHROPIC_API_KEY is absent. /brain already has this
// path; these do not.
//
// It is OFF by default and stays that way until the owner turns it on, because
// it is real money on the platform key for ordinary agent traffic: the mirror
// bills the underlying model's list price (Sonnet 5 at $3/$15 per 1M tokens is
// roughly $0.006 on a 1k-in/300-out turn, i.e. ~$6 per thousand such turns),
// and the same key's $30 balance is already spent. Enable with
// OPENROUTER_CLAUDE_MIRROR_MODEL=<openrouter model id>, e.g.
// `anthropic/claude-sonnet-5`. The model must be registered `paid: true` in
// MODEL_CATALOG (isPaidModel) so it is metered rather than priced free and can
// never be handed to anonymous traffic; an unregistered id is ignored.
export const OPENROUTER_CLAUDE_MIRROR_ENV = 'OPENROUTER_CLAUDE_MIRROR_MODEL';
function openrouterClaudeMirror(key) {
	const model = process.env[OPENROUTER_CLAUDE_MIRROR_ENV];
	if (!key || !model) return null;
	if (!isPaidModel(model)) {
		console.warn(`[llm] ${OPENROUTER_CLAUDE_MIRROR_ENV}=${model} is not a metered paid model in MODEL_CATALOG; mirror disabled`);
		return null;
	}
	return openrouterProvider({ name: 'openrouter:claude-mirror', key, model });
}

// Build the ordered provider chain for a request: free platform providers
// first (Groq → OpenRouter keys → NVIDIA NIM), paid providers only at the
// edges. A caller-supplied BYOK `anthropicKey` leads the chain — that's the
// caller's explicit model choice on the caller's own billing — and still
// degrades to the free chain on failure. The server ANTHROPIC_API_KEY and
// OPENAI_API_KEY are appended LAST, automatically, as backstops after every
// free provider: the prod paid keys are routinely invalid or out of quota, so
// platform spend never leads and nothing depends on it — but when a key does
// work, a request that exhausted the free tier still succeeds.
export function providerChain({ anthropicKey, anthropicModel, grokKey = null, grokModel = null, preferNvidia = false, nvidiaModel = null } = {}) {
	const chain = [];
	// Opt-in: lead with the NVIDIA NIM lane on a chosen Nemotron model. Used by
	// features that want the NVIDIA-native model to actually produce the result
	// (not just sit at the tail of the free chain). The remaining free providers
	// are still appended below as fallback, so the feature degrades gracefully
	// when the NIM lane is unreachable. NVIDIA is free, so this respects the
	// free-first policy — it just reorders which free provider leads.
	if (preferNvidia && env.NVIDIA_API_KEY) {
		chain.push(openaiCompatProvider({
			name: 'nvidia',
			key: env.NVIDIA_API_KEY,
			url: 'https://integrate.api.nvidia.com/v1/chat/completions',
			model: nvidiaModel || NVIDIA_NEMOTRON_MODEL,
			extraBody: NVIDIA_NO_THINK,
			// When a caller opts to LEAD with NVIDIA it wants that model to produce
			// the result, so give the lane a longer leash than the fallback rung —
			// but still bounded so a NIM queue stall can't hang the whole request.
			timeoutMs: Math.max(nvidiaLaneTimeoutMs(), 15_000),
		}));
	}
	if (anthropicKey) chain.push(anthropicProvider(anthropicKey, anthropicModel));
	// BYOK Grok leads for the same reason a BYOK Anthropic key does: the caller
	// chose the model and pays for it. Flagship by default; still degrades to
	// the free chain below when x.ai errors.
	if (grokKey) {
		chain.push(openaiCompatProvider({
			name: 'grok',
			key: grokKey,
			url: GROK_URL,
			model: grokModel || GROK_BYOK_MODEL,
		}));
	}
	// VERTEX_CLAUDE_PRIMARY: real Claude on GCP credits leads the chain, before
	// the free lanes — the platform's default brain becomes Vertex Claude. It
	// still sits behind a caller BYOK key (the caller's explicit billing choice)
	// and degrades to the free chain below on any Vertex failure. Model follows
	// the call site's Anthropic intent (anthropicModel), else the utility default.
	if (vertexClaudePrimary()) chain.push(vertexAnthropicProvider(anthropicModel));
	if (env.GROQ_API_KEY) {
		chain.push(openaiCompatProvider({
			name: 'groq',
			key: env.GROQ_API_KEY,
			url: 'https://api.groq.com/openai/v1/chat/completions',
			model: GROQ_MODEL,
		}));
		// Same key, separate per-model token bucket. See GROQ_LARGE_MODEL.
		chain.push(openaiCompatProvider({
			name: 'groq#120b',
			key: env.GROQ_API_KEY,
			url: 'https://api.groq.com/openai/v1/chat/completions',
			model: GROQ_LARGE_MODEL,
		}));
	}
	// Same 70B family on Cerebras' free tier — a distinct quota pool from Groq,
	// so one provider's daily cap doesn't take the whole 70B class down.
	if (env.CEREBRAS_API_KEY) {
		chain.push(openaiCompatProvider({
			name: 'cerebras',
			key: env.CEREBRAS_API_KEY,
			url: 'https://api.cerebras.ai/v1/chat/completions',
			model: CEREBRAS_MODEL,
		}));
	}
	// One provider entry per OpenRouter key, ALWAYS on the model's :free variant.
	// The platform host key must never be charged for a paid OpenRouter model: the
	// funded reliability lane is the GCP-credits Vertex anchor below (vertexGemini),
	// not paid OpenRouter. The primary key used to lead with the PAID model, so once
	// the account carried ANY balance (e.g. credits bought to raise free-tier limits)
	// every call that fell past a throttled Groq (constant in prod) was billed to
	// the paid tier, ahead of the free NVIDIA/OVH/Vertex rungs right below it. That
	// silently burned the balance, and llm-pricing metered openrouter at $0, so it
	// was invisible (both halves are fixed: these rungs are :free-only, and every
	// OpenRouter call now records the cost the account was actually charged).
	// :free-only keeps the balance serving only its intended purpose
	// (higher free-tier limits); an exhausted :free rung fails over to the next key,
	// then to the free/credits lanes below.
	const openrouterKeys = [...new Set([env.OPENROUTER_API_KEY, ...env.OPENROUTER_FALLBACK_KEYS].filter(Boolean))];
	openrouterKeys.forEach((key, i) => {
		chain.push(openrouterProvider({
			name: i === 0 ? 'openrouter' : `openrouter#${i + 1}`,
			key,
			model: OPENROUTER_FREE_MODEL,
		}));
	});
	if (env.NVIDIA_API_KEY) {
		chain.push(openaiCompatProvider({
			name: 'nvidia',
			key: env.NVIDIA_API_KEY,
			url: 'https://integrate.api.nvidia.com/v1/chat/completions',
			model: NVIDIA_MODEL,
			extraBody: NVIDIA_NO_THINK,
			// NIM free tier queues under load (observed hanging 25s on a 900-token
			// prompt while every other free lane failed fast), so the lane stays
			// bounded. See nvidiaLaneTimeoutMs for why that bound is no longer a
			// hardcoded 6s.
			timeoutMs: nvidiaLaneTimeoutMs(),
		}));
	}
	// SambaNova's free tier: the same Llama 3.3 70B on a fourth independent
	// quota pool, so a day that exhausts Groq, Cerebras, and NVIDIA at once
	// still has a 70B-class free rung with budget left.
	if (env.SAMBANOVA_API_KEY) {
		chain.push(openaiCompatProvider({
			name: 'sambanova',
			key: env.SAMBANOVA_API_KEY,
			url: 'https://api.sambanova.ai/v1/chat/completions',
			model: SAMBANOVA_MODEL,
		}));
	}
	// Mistral's Experiment tier: the largest free quota in the chain (about 1B
	// tokens/month). Mistral Small is not a 70B model, but its quality sits
	// with this group rather than the step-down group below.
	if (env.MISTRAL_API_KEY) {
		chain.push(openaiCompatProvider({
			name: 'mistral',
			key: env.MISTRAL_API_KEY,
			url: 'https://api.mistral.ai/v1/chat/completions',
			model: MISTRAL_MODEL,
		}));
	}
	// Z.AI's permanently free GLM Flash lane: another independent quota pool
	// with quality comparable to the rungs above it.
	if (env.ZAI_API_KEY) {
		chain.push(openaiCompatProvider({
			name: 'zai',
			key: env.ZAI_API_KEY,
			url: 'https://api.z.ai/api/paas/v4/chat/completions',
			model: ZAI_MODEL,
		}));
	}
	// Cloudflare Workers AI free tier: 70B-class Llama at the edge, gated on
	// both halves of the credential because the URL embeds the account id.
	if (env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_AI_API_TOKEN) {
		chain.push(openaiCompatProvider({
			name: 'cloudflare',
			key: env.CLOUDFLARE_AI_API_TOKEN,
			url: `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai/v1/chat/completions`,
			model: CLOUDFLARE_MODEL,
		}));
	}
	// OVH AI Endpoints anonymous tier — no key required, always available.
	// Last of the 70B-class free rungs because its per-model anonymous quota
	// (2 req/min/IP) is the tightest in the chain; everything with a real key
	// gets tried first.
	chain.push(openaiCompatProvider({
		name: 'ovh',
		url: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions',
		model: OVH_MODEL,
	}));
	// Gemini Flash-Lite, twice: the AI Studio free tier when a key is
	// configured, then the Vertex lane on the GCP service account (billed to
	// platform credits — effectively free while the credit grant runs, and the
	// only rung with no third-party quota to exhaust). Both sit after the
	// 70B-class free rungs and before the capability step-down below.
	if (env.GEMINI_API_KEY) {
		chain.push(openaiCompatProvider({
			name: 'gemini',
			key: env.GEMINI_API_KEY,
			url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
			model: GEMINI_MODEL,
		}));
	}
	if (process.env.GOOGLE_CLOUD_PROJECT) {
		chain.push(vertexGeminiProvider());
	}
	// Pollinations keyless anonymous tier — no key required, always available.
	// Smaller model than the 70B rungs above, so it sits in the
	// capability-step-down group rather than leading.
	chain.push(openaiCompatProvider({
		name: 'pollinations',
		url: 'https://text.pollinations.ai/openai',
		model: POLLINATIONS_MODEL,
	}));
	// LLM7.io: sits with the step-down group (flash-lite class) right after
	// Pollinations. Skipped without a key, because an unauthenticated call here
	// is now a guaranteed 401: leaving it in the chain unconditionally spends a
	// round trip per exhaustion for an answer that cannot arrive.
	if (env.LLM7_API_KEY) {
		chain.push(openaiCompatProvider({
			name: 'llm7',
			key: env.LLM7_API_KEY,
			url: 'https://api.llm7.io/v1/chat/completions',
			model: LLM7_MODEL,
		}));
	}
	// SiliconFlow free tier: keyed 8B step-down on its own quota pool.
	// enable_thinking:false forces Qwen3 out of reasoning mode so the answer
	// lands in message.content instead of a reasoning field.
	if (env.SILICONFLOW_API_KEY) {
		chain.push(openaiCompatProvider({
			name: 'siliconflow',
			key: env.SILICONFLOW_API_KEY,
			url: 'https://api.siliconflow.com/v1/chat/completions',
			model: SILICONFLOW_MODEL,
			extraBody: { enable_thinking: false },
		}));
	}
	// Last free rung: Groq's instant lane. Smaller model (a capability
	// step-down), but its per-model quota is separate from the 70B lane and it
	// still beats erroring out or landing on a dead paid key.
	if (env.GROQ_API_KEY) {
		chain.push(openaiCompatProvider({
			name: 'groq#instant',
			key: env.GROQ_API_KEY,
			url: 'https://api.groq.com/openai/v1/chat/completions',
			model: GROQ_INSTANT_MODEL,
		}));
	}
	// VERTEX_CLAUDE_ENABLED (without PRIMARY): Vertex Claude is a paid-tier
	// backstop, tried ahead of first-party Anthropic — GCP credits before a paid
	// Anthropic key. Skipped when it already leads (primary) so it's not added
	// twice, and when a BYOK key leads (the caller chose their own billing).
	if (!anthropicKey && vertexClaudeEnabled() && !vertexClaudePrimary()) {
		chain.push(vertexAnthropicProvider(anthropicModel));
	}
	// Paid backstops — always appended, never leading. Server Anthropic is
	// skipped when a BYOK key already leads the chain (the caller chose their
	// own Claude billing; the platform doesn't re-buy the same model for them).
	if (!anthropicKey && env.ANTHROPIC_API_KEY) {
		chain.push(anthropicProvider(env.ANTHROPIC_API_KEY, anthropicModel));
	}
	// Optional paid Claude mirror on the OpenRouter platform key. OFF unless
	// OPENROUTER_CLAUDE_MIRROR_MODEL is set (see openrouterClaudeMirror). It sits
	// in the paid tail, never among the free rungs, and only when no other Claude
	// transport is already in the chain: a BYOK key, the server key, or Vertex.
	if (!anthropicKey && !env.ANTHROPIC_API_KEY && !vertexClaudeEnabled()) {
		const claudeMirror = openrouterClaudeMirror(openrouterKeys[0]);
		if (claudeMirror) chain.push(claudeMirror);
	}
	if (env.OPENAI_API_KEY) {
		chain.push(openaiCompatProvider({
			name: 'openai',
			key: env.OPENAI_API_KEY,
			url: 'https://api.openai.com/v1/chat/completions',
			model: OPENAI_MODEL,
		}));
	}
	// Server Grok is a paid backstop like OpenAI above; skipped when a BYOK
	// grokKey already leads (the caller chose their own xAI billing).
	if (!grokKey && env.GROK_API_KEY) {
		chain.push(openaiCompatProvider({
			name: 'grok',
			key: env.GROK_API_KEY,
			url: GROK_URL,
			model: grokModel || GROK_MODEL,
		}));
	}
	return chain;
}

// True when at least one provider can serve a completion for the given options.
// Use to gate a feature without making the doomed upstream call.
export function llmConfigured(opts = {}) {
	return providerChain(opts).length > 0;
}

// Run a single-shot system+user completion against the first available
// provider, falling over to the next on transport or non-2xx errors.
//
// `timeoutMs` bounds each provider attempt (the next provider is tried if one
// times out), so a hung upstream can't stall a serverless function or agent
// tick indefinitely.
//
// Returns { text, provider, model, usage:{input,output}, raw }. A provider that
// answers HTTP 200 with an unparseable body or no usable text is failed over
// like any other error; if EVERY provider only yields empty text, the first
// such empty-but-valid result is returned rather than throwing.
// Throws LlmUnavailableError when no provider is configured, or the last
// upstream error (with .status = 502) when every provider failed outright.
// Throws an error with .status = 429 and .code = 'daily_spend_cap_exceeded'
// when the caller's userId has consumed their daily LLM budget on paid keys.
//
// `track` is optional attribution for the spend ledger. When supplied, every
// successful completion records a kind:'llm' usage event carrying the provider,
// model, token counts, and computed cost (micro-USD) — this is what makes
// platform LLM spend visible on the admin dashboard. The fields it accepts —
// { userId, agentId, avatarId, clientId, apiKeyId, tool } — are all optional;
// pass whatever the call site knows. Recording is fire-and-forget (see
// recordEvent), so it never delays or fails the completion.
export async function llmComplete({ system, user, maxTokens = 1024, anthropicKey = null, anthropicModel = null, grokKey = null, grokModel = null, preferNvidia = false, nvidiaModel = null, timeoutMs = 30_000, track = null }) {
	const chain = providerChain({ anthropicKey, anthropicModel, grokKey, grokModel, preferNvidia, nvidiaModel });
	if (!chain.length) throw new LlmUnavailableError();

	// Per-user daily spend cap on platform-paid keys. Only runs when a userId is
	// known and there are paid keys configured — free-only installs skip the check.
	if (track?.userId) {
		const cap = await checkUserLlmSpendCap(track.userId, { anthropicKey, grokKey });
		if (cap.exceeded) {
			const usd = (cap.capMicroUsd / 1_000_000).toFixed(2);
			throw Object.assign(
				new Error(`Daily LLM spend cap of $${usd} reached. Resets in under 24 hours.`),
				{ status: 429, code: 'daily_spend_cap_exceeded' },
			);
		}
	}

	// `timeoutMs` is the OVERALL budget for the whole chain, not a per-provider
	// allowance. Applying it per fetch let a single hung lane consume the entire
	// budget: a healthy free provider that stops responding (observed live on the
	// diorama composer — one lane hung ~30s while the Vertex anchor sat two rungs
	// later, ready to answer in ~1s) turned a request that SHOULD fail over in a
	// second into a 32s wait. Cap each attempt so a stall fails over fast, and
	// stop trying once the shared budget is spent. Most non-answers here are fast
	// (429/402 in <1s); the cap only bites a genuine stall. Env-tunable; floored so
	// a fat-fingered value can't strangle a legitimately-slow completion.
	const perProviderMs = perProviderTimeoutMs();
	// Floor for the fair-share cap below: below this even a healthy lane cannot
	// finish, so slicing thinner would just fail every rung instead of some.
	const MIN_ATTEMPT_MS = 4_000;
	const deadline = Date.now() + timeoutMs;
	let lastErr;
	// A 200 with no usable text (content filter, malformed shape, a lane that
	// returns an empty completion under load) is not a real answer — the chain
	// keeps trying so a healthy provider behind it can respond. But if EVERY
	// provider only produces empty, returning that empty 200 still beats throwing:
	// the caller asked for a completion and got a valid-if-empty one. Hold the
	// first such result as the last-resort return value.
	let lastEmpty = null;
	// One record per provider the chain actually touched: { provider, ms, error }
	// (plus `skipped` for rungs the budget never reached). Without this an
	// exhausted chain only ever reported `lastErr` — the LAST provider's message —
	// so a chain that died because a slow lead rung ate the whole budget was
	// indistinguishable from one that died on the tail rung's own fault. That is
	// how a starved chain got filed as an OpenAI billing problem: OpenAI sits last
	// and its 429 was the only error anyone ever saw. Attached to the thrown error
	// as `.attempts` and summarised in one warn line below.
	const attempts = [];
	// Hosts that stalled (hit the attempt cap mid-request or mid-body-read) this
	// call. Several rungs can share one upstream — the chain holds three
	// OpenRouter entries, one per configured key — and a stall is a property of
	// the HOST, not of the key: when openrouter.ai accepts the POST, returns 200
	// headers and then never finishes the body, every key behind it does the same.
	// Retrying the siblings burned the 12s cap once per key and spent the whole
	// 30s chain budget before the healthy free lanes were ever reached, which is
	// what made the paid fact-check 502 (observed live 2026-07-29:
	// openrouter x3 = 36s of a 30s budget, then every remaining rung reported
	// budget_exhausted). Skip the siblings instead — cheap, and the next distinct
	// host still gets its full shot. HTTP failures (402/429) are key-scoped and
	// deliberately do NOT mark the host: another key on the same host may be fine.
	const stalledHosts = new Set();
	const hostOf = (url) => { try { return new URL(url).host; } catch { return url; } };
	const isStall = (e) => e?.name === 'TimeoutError' || e?.name === 'AbortError' || /abort|timed? ?out/i.test(e?.message || '');
	for (const p of chain) {
		const remaining = deadline - Date.now();
		// Out of overall budget — stop rather than start an attempt we can't finish.
		if (remaining <= 500) {
			attempts.push({ provider: p.name, skipped: 'budget_exhausted' });
			continue;
		}
		if (stalledHosts.has(hostOf(p.url))) {
			attempts.push({ provider: p.name, skipped: 'host_stalled' });
			continue;
		}
		// A provider may declare its own tighter cap (e.g. a known-slow queue lane).
		const providerCap = p.timeoutMs ? Math.min(perProviderMs, p.timeoutMs) : perProviderMs;
		// Never hand ONE rung the whole remaining budget while other rungs — and
		// in particular the Vertex credits anchor, which sits behind the free
		// tiers — still wait behind it. A caller working to a tight stage budget
		// (the fact-check pipeline carves ~15s for stance extraction) otherwise
		// spends all of it on the first slow free lane and never reaches the rung
		// that would have answered. Reserve two thirds for whatever follows while
		// more than one rung remains; the LAST rung is free to use everything
		// left, so a genuinely slow single-provider completion is never strangled.
		const rungsLeft = chain.length - chain.indexOf(p);
		const fairShare = rungsLeft > 1 ? Math.max(MIN_ATTEMPT_MS, remaining / 3) : remaining;
		// Integer milliseconds: AbortSignal.timeout rejects a fractional delay with
		// ERR_OUT_OF_RANGE, and `remaining / 3` is fractional most of the time.
		const attemptMs = Math.floor(Math.min(providerCap, remaining, fairShare));
		const startedAt = Date.now();
		let upstream;
		try {
			// Vertex resolves a fresh (cached) GCP OAuth token per request via an
			// async getHeaders; every other provider carries static headers. A
			// token-exchange failure throws here and is caught below → next provider.
			const headers = p.getHeaders ? await p.getHeaders() : p.headers;
			upstream = await fetch(p.url, {
				method: 'POST',
				headers,
				body: JSON.stringify(p.buildBody(system, user, maxTokens)),
				signal: AbortSignal.timeout(attemptMs),
			});
		} catch (e) {
			lastErr = Object.assign(new Error(`${p.name} unreachable: ${e.message}`), { status: 502, code: 'upstream_unreachable' });
			if (isStall(e)) stalledHosts.add(hostOf(p.url));
			attempts.push({ provider: p.name, ms: Date.now() - startedAt, error: `unreachable: ${e.message}` });
			continue;
		}
		if (!upstream.ok) {
			const body = await upstream.text().catch(() => '');
			lastErr = Object.assign(new Error(`${p.name} ${upstream.status}: ${body.slice(0, 200)}`), { status: 502, code: 'upstream_error' });
			attempts.push({ provider: p.name, ms: Date.now() - startedAt, error: `http ${upstream.status}` });
			continue;
		}
		// Parse the body defensively: a provider can return HTTP 200 with a
		// non-JSON payload (an edge/proxy HTML error page, a truncated stream, an
		// empty body). Left unguarded this threw out of llmComplete entirely,
		// killing the request even though a healthy provider sat next in the
		// chain. Treat a parse failure as a provider error and fail over.
		let data;
		try {
			data = await upstream.json();
		} catch (e) {
			lastErr = Object.assign(new Error(`${p.name} returned an unparseable 200 body: ${e.message}`), { status: 502, code: 'upstream_bad_body' });
			if (isStall(e)) stalledHosts.add(hostOf(p.url));
			attempts.push({ provider: p.name, ms: Date.now() - startedAt, error: `unparseable 200 body: ${e.message}` });
			continue;
		}
		const usage = p.extractUsage(data);
		// A provider that reports what it charged (OpenRouter's `usage.cost`) is
		// the authoritative meter for that call; carried alongside the token counts.
		if (p.extractCostUsd) usage.costUsd = p.extractCostUsd(data);
		const text = (p.extractText(data) || '').trim();
		if (!text) {
			// 200 but no usable content — fail over, keeping the result as the
			// last-resort return value if nothing better comes along.
			if (!lastEmpty) lastEmpty = { text: '', provider: p.name, model: p.model, usage, raw: data };
			lastErr = Object.assign(new Error(`${p.name} returned an empty completion`), { status: 502, code: 'empty_completion' });
			attempts.push({ provider: p.name, ms: Date.now() - startedAt, error: 'empty completion' });
			continue;
		}
		recordLlmSpend(p, usage, Date.now() - startedAt, track);
		return {
			text,
			provider: p.name,
			model: p.model,
			usage,
			raw: data,
		};
	}
	// Nothing produced usable text. Prefer an empty-but-valid 200 over throwing;
	// only throw when no provider even returned a parseable success.
	if (lastEmpty) {
		recordLlmSpend({ name: lastEmpty.provider, model: lastEmpty.model }, lastEmpty.usage, 0, track);
		return lastEmpty;
	}
	if (attempts.length) {
		console.warn('[llm] chain exhausted: ' + attempts.map((a) => a.skipped ? `${a.provider}=${a.skipped}` : `${a.provider}=${a.error} (${a.ms}ms)`).join(' | '));
	}
	throw Object.assign(lastErr || new LlmUnavailableError(), { attempts });
}

// Fire-and-forget spend ledger write for one completion. Attribution comes from
// the caller's optional `track`; the cost is the provider's own reported charge
// when it gives one, else the list-price table (free lanes price to 0). Never
// throws: recordEvent swallows its own errors.
//
// An UNKNOWN cost (null) is recorded as null and logged, never coerced to 0: a
// spending lane that reports $0 is indistinguishable from a free one on the
// dashboard, which is exactly how the OpenRouter credit burn stayed invisible.
function recordLlmSpend(provider, usage, latencyMs, track) {
	const input = usage?.input ?? 0;
	const output = usage?.output ?? 0;
	// Prompt-cache tokens are reported separately from `input` (which is the
	// uncached remainder), so they are added to inputTokens for the "how big was
	// the prompt" view and priced at their own rates by costMicroUsd.
	const cacheWrite = usage?.cacheWrite ?? 0;
	const cacheRead = usage?.cacheRead ?? 0;
	const cost = costMicroUsd({
		provider: provider.name,
		model: provider.model,
		input,
		output,
		cacheWrite,
		cacheRead,
		reportedCostUsd: usage?.costUsd ?? null,
	});
	if (cost === null && (input || output)) {
		console.warn(`[llm] unpriced spending lane ${provider.name}/${provider.model}, recording cost as unknown; add it to llm-pricing.js`);
	}
	recordEvent({
		kind: 'llm',
		provider: provider.name,
		model: provider.model,
		inputTokens: input + cacheWrite + cacheRead,
		outputTokens: output,
		costMicroUsd: cost,
		latencyMs,
		userId: track?.userId ?? null,
		agentId: track?.agentId ?? null,
		avatarId: track?.avatarId ?? null,
		clientId: track?.clientId ?? null,
		apiKeyId: track?.apiKeyId ?? null,
		tool: track?.tool ?? null,
	});
}
