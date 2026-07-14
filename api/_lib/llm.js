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

const GROQ_MODEL = 'llama-3.3-70b-versatile';
// Second Groq rung on a different model: Groq free-tier quotas are PER MODEL,
// so when the 70B lane is exhausted the instant lane usually still has budget.
// Smaller model, so it sits at the END of the free section — every 70B-class
// provider gets tried before the chain steps down in capability.
const GROQ_INSTANT_MODEL = 'llama-3.1-8b-instant';
// Same Llama 3.3 70B on Cerebras' free tier (cloud.cerebras.ai) — optional
// rung, active when CEREBRAS_API_KEY is configured.
const CEREBRAS_MODEL = 'llama-3.3-70b';
const OPENROUTER_MODEL = 'meta-llama/llama-3.3-70b-instruct';
// Gemini Flash-Lite: the AI Studio free tier (GEMINI_API_KEY) and the Vertex
// lane (GCP service account, billed to platform credits) run the same model.
const GEMINI_MODEL = 'gemini-2.5-flash-lite';
const VERTEX_GEMINI_MODEL = 'google/gemini-2.5-flash-lite';
// Same Llama 3.3 70B family on NVIDIA NIM (build.nvidia.com) — one free nvapi
// key, OpenAI-compatible, so the chain degrades across providers without
// changing model behavior.
const NVIDIA_MODEL = 'meta/llama-3.3-70b-instruct';
// Compact, reasoning-tuned Nemotron a caller can opt into when it wants the
// NVIDIA-native model to lead (see `preferNvidia`/`nvidiaModel` below). Fast
// enough for a single prompt-refine turn; the rest of the free chain still
// backs it up if the NIM lane is down.
const NVIDIA_NEMOTRON_MODEL = 'nvidia/nvidia-nemotron-nano-9b-v2';
// OVH AI Endpoints anonymous tier: no key, no account, no signup — Llama 3.3
// 70B served free by OVHcloud's officially documented trial lane (not a ToS
// workaround). The tradeoff for needing zero setup is a tight 2 req/min per
// model per IP quota, so it rides at the back of the 70B-class group rather
// than leading. https://help.ovhcloud.com/csm/en-public-cloud-ai-endpoints-capabilities
const OVH_MODEL = 'Meta-Llama-3_3-70B-Instruct';
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
function nvidiaLaneTimeoutMs() {
	return Math.max(2_000, Number(process.env.NVIDIA_LANE_TIMEOUT_MS) || 6_000);
}
const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';
// Paid last-resort tail (see policy above). Mini keeps the backstop cheap; the
// repo-wide OpenAI default (api/_lib/chat-models.js) uses the same model.
const OPENAI_MODEL = 'gpt-5.6-luna';

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
export async function checkUserLlmSpendCap(userId, { anthropicKey } = {}) {
	if (!userId) return { exceeded: false };
	if (anthropicKey) return { exceeded: false }; // BYOK — not our billing
	if (!env.ANTHROPIC_API_KEY && !env.OPENAI_API_KEY) return { exceeded: false }; // no paid keys at all
	const cap = dailyCapMicroUsd();
	try {
		const [row] = await sql`
			SELECT COALESCE(SUM(cost_micro_usd), 0)::bigint AS spent
			FROM usage_events
			WHERE user_id = ${userId}
				AND kind = 'llm'
				AND provider NOT LIKE 'groq%'
				AND provider NOT LIKE 'openrouter%'
				AND provider NOT IN ('nvidia', 'cerebras', 'gemini', 'ovh', 'pollinations')
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
			system,
			messages: [{ role: 'user', content: user }],
		}),
		extractText: (r) => r.content?.[0]?.text || '',
		extractUsage: (r) => ({ input: r.usage?.input_tokens ?? 0, output: r.usage?.output_tokens ?? 0 }),
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
				system,
				messages: [{ role: 'user', content: user }],
			}),
		extractText: (r) => r.content?.[0]?.text || '',
		extractUsage: (r) => ({ input: r.usage?.input_tokens ?? 0, output: r.usage?.output_tokens ?? 0 }),
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
			max_tokens: maxTokens,
			messages: [
				...(system ? [{ role: 'system', content: system }] : []),
				{ role: 'user', content: user },
			],
		}),
		extractText: (r) => r.choices?.[0]?.message?.content || '',
		extractUsage: (r) => ({ input: r.usage?.prompt_tokens ?? 0, output: r.usage?.completion_tokens ?? 0 }),
	};
}

function openaiCompatProvider({ name, key = null, url, model, extraHeaders = {}, timeoutMs = null }) {
	return {
		name,
		model,
		url,
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

// Build the ordered provider chain for a request: free platform providers
// first (Groq → OpenRouter keys → NVIDIA NIM), paid providers only at the
// edges. A caller-supplied BYOK `anthropicKey` leads the chain — that's the
// caller's explicit model choice on the caller's own billing — and still
// degrades to the free chain on failure. The server ANTHROPIC_API_KEY and
// OPENAI_API_KEY are appended LAST, automatically, as backstops after every
// free provider: the prod paid keys are routinely invalid or out of quota, so
// platform spend never leads and nothing depends on it — but when a key does
// work, a request that exhausted the free tier still succeeds.
export function providerChain({ anthropicKey, anthropicModel, preferNvidia = false, nvidiaModel = null } = {}) {
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
			// When a caller opts to LEAD with NVIDIA it wants that model to produce
			// the result, so give the lane a longer leash than the fallback rung —
			// but still bounded so a NIM queue stall can't hang the whole request.
			timeoutMs: Math.max(nvidiaLaneTimeoutMs(), 15_000),
		}));
	}
	if (anthropicKey) chain.push(anthropicProvider(anthropicKey, anthropicModel));
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
	// One provider entry per OpenRouter key: when the primary account runs out
	// of credits (402) or hits a rate limit, the next key takes over. Fallback
	// keys are typically unfunded free-tier accounts, so they get the model's
	// :free variant — the paid model would 402 on them unconditionally. The
	// primary key ALSO gets a :free rung right behind its paid rung: an
	// out-of-credits primary account (the July 2026 prod state) can still serve
	// the :free variant, so exhausted credits cost one fast 402, not the lane.
	const openrouterKeys = [...new Set([env.OPENROUTER_API_KEY, ...env.OPENROUTER_FALLBACK_KEYS].filter(Boolean))];
	openrouterKeys.forEach((key, i) => {
		chain.push(openaiCompatProvider({
			name: i === 0 ? 'openrouter' : `openrouter#${i + 1}`,
			key,
			url: 'https://openrouter.ai/api/v1/chat/completions',
			model: i === 0 ? OPENROUTER_MODEL : `${OPENROUTER_MODEL}:free`,
			extraHeaders: { 'HTTP-Referer': 'https://three.ws', 'X-Title': 'three.ws' },
		}));
		if (i === 0) {
			chain.push(openaiCompatProvider({
				name: 'openrouter:free',
				key,
				url: 'https://openrouter.ai/api/v1/chat/completions',
				model: `${OPENROUTER_MODEL}:free`,
				extraHeaders: { 'HTTP-Referer': 'https://three.ws', 'X-Title': 'three.ws' },
			}));
		}
	});
	if (env.NVIDIA_API_KEY) {
		chain.push(openaiCompatProvider({
			name: 'nvidia',
			key: env.NVIDIA_API_KEY,
			url: 'https://integrate.api.nvidia.com/v1/chat/completions',
			model: NVIDIA_MODEL,
			// NIM free tier queues under load (observed hanging 25s on a 900-token
			// prompt while every other free lane failed fast); cap it tight so the
			// chain reaches the reliable Vertex anchor in seconds instead of blocking.
			timeoutMs: nvidiaLaneTimeoutMs(),
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
	if (env.OPENAI_API_KEY) {
		chain.push(openaiCompatProvider({
			name: 'openai',
			key: env.OPENAI_API_KEY,
			url: 'https://api.openai.com/v1/chat/completions',
			model: OPENAI_MODEL,
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
// Returns { text, provider, model, usage:{input,output}, raw }.
// Throws LlmUnavailableError when no provider is configured, or the last
// upstream error (with .status = 502) when every provider failed.
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
export async function llmComplete({ system, user, maxTokens = 1024, anthropicKey = null, anthropicModel = null, preferNvidia = false, nvidiaModel = null, timeoutMs = 30_000, track = null }) {
	const chain = providerChain({ anthropicKey, anthropicModel, preferNvidia, nvidiaModel });
	if (!chain.length) throw new LlmUnavailableError();

	// Per-user daily spend cap on platform-paid keys. Only runs when a userId is
	// known and there are paid keys configured — free-only installs skip the check.
	if (track?.userId) {
		const cap = await checkUserLlmSpendCap(track.userId, { anthropicKey });
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
	const perProviderMs = Math.max(4_000, Number(process.env.LLM_PER_PROVIDER_TIMEOUT_MS) || 12_000);
	const deadline = Date.now() + timeoutMs;
	let lastErr;
	for (const p of chain) {
		const remaining = deadline - Date.now();
		// Out of overall budget — stop rather than start an attempt we can't finish.
		if (remaining <= 500) break;
		// A provider may declare its own tighter cap (e.g. a known-slow queue lane).
		const providerCap = p.timeoutMs ? Math.min(perProviderMs, p.timeoutMs) : perProviderMs;
		const attemptMs = Math.min(providerCap, remaining);
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
			continue;
		}
		if (!upstream.ok) {
			const body = await upstream.text().catch(() => '');
			lastErr = Object.assign(new Error(`${p.name} ${upstream.status}: ${body.slice(0, 200)}`), { status: 502, code: 'upstream_error' });
			continue;
		}
		const data = await upstream.json();
		const usage = p.extractUsage(data);
		recordLlmSpend(p, usage, Date.now() - startedAt, track);
		return {
			text: (p.extractText(data) || '').trim(),
			provider: p.name,
			model: p.model,
			usage,
			raw: data,
		};
	}
	throw lastErr || new LlmUnavailableError();
}

// Fire-and-forget spend ledger write for one completion. Attribution comes from
// the caller's optional `track`; the cost is derived from the provider/model
// (free providers price to 0). Never throws — recordEvent swallows its own
// errors and the cost math is total.
function recordLlmSpend(provider, usage, latencyMs, track) {
	const input = usage?.input ?? 0;
	const output = usage?.output ?? 0;
	recordEvent({
		kind: 'llm',
		provider: provider.name,
		model: provider.model,
		inputTokens: input,
		outputTokens: output,
		costMicroUsd: costMicroUsd({ provider: provider.name, model: provider.model, input, output }),
		latencyMs,
		userId: track?.userId ?? null,
		agentId: track?.agentId ?? null,
		avatarId: track?.avatarId ?? null,
		clientId: track?.clientId ?? null,
		apiKeyId: track?.apiKeyId ?? null,
		tool: track?.tool ?? null,
	});
}
