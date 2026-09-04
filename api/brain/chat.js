// POST /api/brain/chat — Multi-LLM provider proxy for the /brain page.
//
// Body: { provider, messages, system?, maxTokens? }
// Response: SSE stream:
//   event: meta    → { provider, label, network, model, tier }
//   event: first   → { firstTokenMs }
//   (data-only)    → JSON-encoded text chunk
//   event: done    → { elapsedMs, firstTokenMs, usage }
//   event: error   → { message, elapsedMs }
//
// GET /api/brain/chat → returns available providers list

import { streamText } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createQwen } from 'qwen-ai-provider';
import { env } from '../_lib/env.js';
import { cors, method, readJson, error, wrap, rateLimited } from '../_lib/http.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { watsonxConfig, watsonxChatRequest } from '../_lib/watsonx.js';
import { DEFAULT_FREE_MODEL, modelThinksByDefault } from '../_lib/chat-models.js';
import { createReasoningStripper } from '../_lib/strip-reasoning.js';
import {
	vertexClaudeEnabled,
	vertexClaudeConfigured,
	vertexAnthropicMessages,
} from '../_lib/vertex-claude.js';
import {
	vertexGeminiAvailable,
	vertexGeminiModel,
	vertexGeminiOpenAIBase,
	vertexGeminiAccessToken,
	vertexGeminiBudget,
} from '../_lib/vertex-gemini.js';
import { recordEvent } from '../_lib/usage.js';
import { costMicroUsd } from '../_lib/llm-pricing.js';
import { openrouterUsageFetch } from '../_lib/openrouter-usage.js';

const WATSONX_HEADERS_TIMEOUT_MS = 45_000;

// Providers an anonymous (signed-out) caller may use: only the genuinely free
// tiers — the OpenRouter-routed open-weight default and the free NVIDIA NIM
// models. Every paid first-party model (Claude, GPT-5.x, o3, DashScope, DeepSeek)
// requires sign-in so an unauthenticated script can't drain the server's billed
// API keys. Mirrors the anon-provider gate in api/chat.js.
export const ANON_BRAIN_PROVIDERS = new Set([
	'gpt-oss-120b',
	'nvidia-nemotron-120b',
	'nvidia-nemotron-super-49b',
	'nvidia-nemotron-nano',
	'nvidia-deepseek-v4',
	'nvidia-kimi-k2',
	'nvidia-llama4-maverick',
	'nvidia-minimax-m2',
]);

export const maxDuration = 120;

// Each spec declares its *native* provider model (built from a first-party key,
// or null when that key is absent) and the OpenRouter model id that mirrors it.
// buildPrimary() prefers the native model and falls back to routing through
// OpenRouter; buildFallback() reuses the OpenRouter id to route *around* a native
// provider outage (quota/billing/rate-limit) at request time.
const PROVIDERS = {
	'gpt-oss-120b': {
		label: 'GPT-OSS 120B',
		network: 'OpenAI · OpenRouter',
		tier: 'balanced',
		maxOutput: 8192,
		description: 'Open-weight 120B from OpenAI. Fast, capable, free tier. Platform default.',
		// OpenRouter-only — no first-party key for the free tier. The 120B free
		// endpoint was retired upstream; 20B is the surviving GPT-OSS free route.
		openrouterModel: 'google/gemma-4-31b-it:free',
	},
	'claude-fable-5': {
		label: 'Claude Fable 5',
		network: 'Anthropic',
		tier: 'flagship',
		maxOutput: 16384,
		description: 'Most capable model. State-of-the-art reasoning, long-horizon agentic work, knowledge work, and vision.',
		native: () => (env.ANTHROPIC_API_KEY ? createAnthropic({ apiKey: env.ANTHROPIC_API_KEY })('claude-fable-5') : null),
		// Mirrored on OpenRouter (verified 2026-07-29, same $10/$50 per MTok as
		// first-party). Without this the roster showed the platform's most capable
		// model as permanently unavailable, since no ANTHROPIC_API_KEY is set.
		openrouterModel: 'anthropic/claude-fable-5',
	},
	// claude-mythos-5 is deliberately NOT in this menu: it is restricted-access
	// (Project Glasswing orgs only), so with any normal host key the entry would
	// render as selectable and then 404 at call time — a dead menu item. BYOK
	// callers with access can still name it through api/chat.js (it stays in
	// _lib/chat-models.js as an explicit-only gated model).
	'claude-opus-5': {
		label: 'Claude Opus 5',
		network: 'Anthropic',
		tier: 'flagship',
		maxOutput: 16384,
		description: 'Current Opus. Deep reasoning, agentic and long-horizon work; thinks by default.',
		native: () => (env.ANTHROPIC_API_KEY ? createAnthropic({ apiKey: env.ANTHROPIC_API_KEY })('claude-opus-5') : null),
		openrouterModel: 'anthropic/claude-opus-5',
	},
	'claude-sonnet-5': {
		label: 'Claude Sonnet 5',
		network: 'Anthropic',
		tier: 'balanced',
		maxOutput: 16384,
		description: 'Near-Opus quality on coding and agentic work at Sonnet cost. Best for most tasks.',
		native: () => (env.ANTHROPIC_API_KEY ? createAnthropic({ apiKey: env.ANTHROPIC_API_KEY })('claude-sonnet-5') : null),
		openrouterModel: 'anthropic/claude-sonnet-5',
	},
	'claude-opus-4-7': {
		label: 'Claude Opus 4.7',
		network: 'Anthropic',
		tier: 'flagship',
		maxOutput: 16384,
		description: 'Most capable. Extended thinking, complex reasoning.',
		native: () => (env.ANTHROPIC_API_KEY ? createAnthropic({ apiKey: env.ANTHROPIC_API_KEY })('claude-opus-4-7') : null),
		openrouterModel: 'anthropic/claude-opus-4',
	},
	'claude-sonnet-4-6': {
		label: 'Claude Sonnet 4.6',
		network: 'Anthropic',
		tier: 'balanced',
		maxOutput: 16384,
		description: 'Balanced speed and intelligence. Best for most tasks.',
		native: () => (env.ANTHROPIC_API_KEY ? createAnthropic({ apiKey: env.ANTHROPIC_API_KEY })('claude-sonnet-4-6') : null),
		openrouterModel: 'anthropic/claude-sonnet-4',
	},
	'claude-haiku-4-5': {
		label: 'Claude Haiku 4.5',
		network: 'Anthropic',
		tier: 'fast',
		maxOutput: 8192,
		description: 'Fastest Claude. Low latency, high throughput.',
		native: () => (env.ANTHROPIC_API_KEY ? createAnthropic({ apiKey: env.ANTHROPIC_API_KEY })('claude-haiku-4-5-20251001') : null),
		openrouterModel: 'anthropic/claude-haiku-4.5',
	},
	'gpt-5.6-sol': {
		label: 'GPT-5.6 Sol',
		network: 'OpenAI',
		tier: 'flagship',
		maxOutput: 16384,
		description: 'OpenAI flagship. Frontier reasoning, coding, and agentic work.',
		native: () => (env.OPENAI_API_KEY ? createOpenAI({ apiKey: env.OPENAI_API_KEY }).chat('gpt-5.6-sol') : null),
		openrouterModel: 'openai/gpt-5.6-sol',
	},
	'gpt-5.6-terra': {
		label: 'GPT-5.6 Terra',
		network: 'OpenAI',
		tier: 'balanced',
		maxOutput: 16384,
		description: 'Balanced intelligence and cost. Best for most tasks.',
		native: () => (env.OPENAI_API_KEY ? createOpenAI({ apiKey: env.OPENAI_API_KEY }).chat('gpt-5.6-terra') : null),
		openrouterModel: 'openai/gpt-5.6-terra',
	},
	'gpt-5.6-luna': {
		label: 'GPT-5.6 Luna',
		network: 'OpenAI',
		tier: 'fast',
		maxOutput: 16384,
		description: 'Fast, cost-efficient GPT. Great for simple tasks.',
		native: () => (env.OPENAI_API_KEY ? createOpenAI({ apiKey: env.OPENAI_API_KEY }).chat('gpt-5.6-luna') : null),
		openrouterModel: 'openai/gpt-5.6-luna',
	},
	'gpt-5.5': {
		label: 'GPT-5.5',
		network: 'OpenAI',
		tier: 'flagship',
		maxOutput: 16384,
		description: 'A new class of intelligence for coding and professional work.',
		native: () => (env.OPENAI_API_KEY ? createOpenAI({ apiKey: env.OPENAI_API_KEY }).chat('gpt-5.5') : null),
		openrouterModel: 'openai/gpt-5.5',
	},
	'gpt-5.5-pro': {
		label: 'GPT-5.5 Pro',
		network: 'OpenAI',
		tier: 'pro',
		maxOutput: 16384,
		description: 'Maximum-compute GPT-5.5. Smarter, more precise responses.',
		native: () => (env.OPENAI_API_KEY ? createOpenAI({ apiKey: env.OPENAI_API_KEY }).chat('gpt-5.5-pro') : null),
		openrouterModel: 'openai/gpt-5.5-pro',
	},
	'gpt-5.4': {
		label: 'GPT-5.4',
		network: 'OpenAI',
		tier: 'balanced',
		maxOutput: 16384,
		description: 'Affordable model for coding and professional work.',
		native: () => (env.OPENAI_API_KEY ? createOpenAI({ apiKey: env.OPENAI_API_KEY }).chat('gpt-5.4') : null),
		openrouterModel: 'openai/gpt-5.4',
	},
	'gpt-5.4-pro': {
		label: 'GPT-5.4 Pro',
		network: 'OpenAI',
		tier: 'pro',
		maxOutput: 16384,
		description: 'Maximum-compute GPT-5.4. Smarter, more precise responses.',
		native: () => (env.OPENAI_API_KEY ? createOpenAI({ apiKey: env.OPENAI_API_KEY }).chat('gpt-5.4-pro') : null),
		openrouterModel: 'openai/gpt-5.4-pro',
	},
	'gpt-5.4-mini': {
		label: 'GPT-5.4 mini',
		network: 'OpenAI',
		tier: 'fast',
		maxOutput: 16384,
		description: 'Strong mini model for coding, computer use, and subagents.',
		native: () => (env.OPENAI_API_KEY ? createOpenAI({ apiKey: env.OPENAI_API_KEY }).chat('gpt-5.4-mini') : null),
		openrouterModel: 'openai/gpt-5.4-mini',
	},
	'gpt-5.4-nano': {
		label: 'GPT-5.4 nano',
		network: 'OpenAI',
		tier: 'fast',
		maxOutput: 16384,
		description: 'Cheapest current GPT. Simple, high-volume tasks.',
		native: () => (env.OPENAI_API_KEY ? createOpenAI({ apiKey: env.OPENAI_API_KEY }).chat('gpt-5.4-nano') : null),
		openrouterModel: 'openai/gpt-5.4-nano',
	},
	'gpt-5.3-codex': {
		label: 'GPT-5.3 Codex',
		network: 'OpenAI',
		tier: 'coding',
		maxOutput: 16384,
		description: 'Agentic coding specialist behind Codex.',
		native: () => (env.OPENAI_API_KEY ? createOpenAI({ apiKey: env.OPENAI_API_KEY }).chat('gpt-5.3-codex') : null),
		openrouterModel: 'openai/gpt-5.3-codex',
	},
	'o3': {
		label: 'o3',
		network: 'OpenAI',
		tier: 'reasoning',
		maxOutput: 16384,
		description: 'Reasoning model for complex tasks.',
		native: () => (env.OPENAI_API_KEY ? createOpenAI({ apiKey: env.OPENAI_API_KEY }).chat('o3') : null),
		openrouterModel: 'openai/o3',
	},
	'o3-pro': {
		label: 'o3-pro',
		network: 'OpenAI',
		tier: 'reasoning',
		maxOutput: 16384,
		description: 'o3 with more compute for better responses.',
		native: () => (env.OPENAI_API_KEY ? createOpenAI({ apiKey: env.OPENAI_API_KEY }).chat('o3-pro') : null),
		openrouterModel: 'openai/o3-pro',
	},
	'grok-4.5': {
		label: 'Grok 4.5',
		network: 'xAI',
		tier: 'flagship',
		maxOutput: 16384,
		description: 'xAI flagship. Frontier reasoning with real-time X knowledge.',
		native: () =>
			env.GROK_API_KEY
				? createOpenAI({ apiKey: env.GROK_API_KEY, baseURL: 'https://api.x.ai/v1' }).chat('grok-4.5')
				: null,
		openrouterModel: 'x-ai/grok-4.5',
	},
	'grok-4.3': {
		label: 'Grok 4.3',
		network: 'xAI',
		tier: 'balanced',
		maxOutput: 16384,
		description: 'Long-context Grok (1M tokens) at a lower price than 4.5.',
		native: () =>
			env.GROK_API_KEY
				? createOpenAI({ apiKey: env.GROK_API_KEY, baseURL: 'https://api.x.ai/v1' }).chat('grok-4.3')
				: null,
		openrouterModel: 'x-ai/grok-4.3',
	},
	'grok-4.1-fast': {
		label: 'Grok 4.1 Fast',
		network: 'xAI',
		tier: 'fast',
		maxOutput: 8192,
		description: 'Budget Grok with a 2M-token context. Fast, cheap workhorse.',
		native: () =>
			env.GROK_API_KEY
				? createOpenAI({ apiKey: env.GROK_API_KEY, baseURL: 'https://api.x.ai/v1' }).chat('grok-4.1-fast')
				: null,
		// OpenRouter dropped x-ai/grok-4.1-fast from its catalog (verified
		// 2026-07-22), so this tier is native xAI only, with no mirror route.
	},
	'groq-llama': {
		label: 'Llama 3.3 70B',
		network: 'Groq',
		tier: 'fast',
		maxOutput: 8192,
		description: 'Open-weight on Groq. Extremely fast inference.',
		native: () =>
			env.GROQ_API_KEY
				? createOpenAI({ apiKey: env.GROQ_API_KEY, baseURL: 'https://api.groq.com/openai/v1' }).chat('llama-3.3-70b-versatile')
				: null,
		openrouterModel: 'meta-llama/llama-3.3-70b-instruct',
	},
	'qwen-plus': {
		label: 'Qwen Plus',
		network: 'DashScope',
		tier: 'balanced',
		maxOutput: 8192,
		description: 'Qwen Plus on DashScope. Strong multilingual.',
		native: () => (env.DASHSCOPE_API_KEY ? createQwen({ apiKey: env.DASHSCOPE_API_KEY })('qwen-plus') : null),
		openrouterModel: 'qwen/qwen-2.5-72b-instruct',
	},
	'modelscope-qwen': {
		label: 'Qwen3-Coder 480B',
		network: 'ModelScope',
		tier: 'flagship',
		maxOutput: 16384,
		description: 'Largest Qwen coder. Exceptional code generation.',
		native: () =>
			env.MODELSCOPE_API_KEY
				? createOpenAI({ apiKey: env.MODELSCOPE_API_KEY, baseURL: 'https://api-inference.modelscope.cn/v1' }).chat('Qwen/Qwen3-Coder-480B-A35B-Instruct')
				: null,
		openrouterModel: 'qwen/qwen3-coder',
	},
	'deepseek-r1': {
		label: 'DeepSeek R1',
		network: 'DeepSeek',
		tier: 'reasoning',
		maxOutput: 8192,
		description: 'Open reasoning model. Strong at math and code.',
		native: () =>
			env.DEEPSEEK_API_KEY
				? createOpenAI({ apiKey: env.DEEPSEEK_API_KEY, baseURL: 'https://api.deepseek.com/v1' }).chat('deepseek-reasoner')
				: null,
		openrouterModel: 'deepseek/deepseek-r1',
	},
	// IBM watsonx.ai Granite. watsonx is not OpenAI-compatible at the API layer
	// (IAM bearer token, project scoping, version param), so it can't be a
	// Vercel AI SDK model object. The `watsonx` flag routes it to a dedicated
	// streaming path; buildPrimary() only reports availability.
	'ibm-granite': {
		label: 'IBM Granite 3.8B',
		network: 'IBM watsonx.ai',
		tier: 'balanced',
		maxOutput: 4096,
		description: 'IBM’s open, enterprise-governed foundation model on watsonx.ai.',
		watsonx: true,
		// Same Granite family hosted on OpenRouter — the same-model backstop when
		// watsonx drops a request, and the primary lane when watsonx creds are
		// absent entirely (so Granite stays selectable without an IBM account).
		openrouterModel: 'ibm-granite/granite-4.1-8b',
	},

	// ── Google Vertex AI — first-party Claude billed to GCP credits ──────────────
	// Only present when VERTEX_CLAUDE_ENABLED (merged below), so the /brain roster
	// is byte-identical when the flag is off. The `vertex` flag names the Vertex
	// publisher model id; buildPrimary() routes it through the shared vertex-claude
	// transport (like the `watsonx` flag), so /brain can compare Vertex-served
	// Claude head-to-head with first-party Claude and every other provider.
	...(vertexClaudeEnabled()
		? {
				'vertex-claude-sonnet': {
					label: 'Claude Sonnet 4.6 · Vertex',
					network: 'Anthropic · Google Vertex',
					tier: 'balanced',
					maxOutput: 16384,
					description: 'Claude Sonnet 4.6 served from Google Vertex AI (billed to GCP credits).',
					vertex: 'claude-sonnet-4-6',
				},
				'vertex-claude-opus': {
					label: 'Claude Opus 4.7 · Vertex',
					network: 'Anthropic · Google Vertex',
					tier: 'flagship',
					maxOutput: 16384,
					description: 'Claude Opus 4.7 served from Google Vertex AI (billed to GCP credits).',
					vertex: 'claude-opus-4-7',
				},
				'vertex-claude-haiku': {
					label: 'Claude Haiku 4.5 · Vertex',
					network: 'Anthropic · Google Vertex',
					tier: 'fast',
					maxOutput: 8192,
					description: 'Claude Haiku 4.5 served from Google Vertex AI (billed to GCP credits).',
					vertex: 'claude-haiku-4-5-20251001',
				},
			}
		: {}),

	// ── NVIDIA NIM (build.nvidia.com) — free hosted inference ────────────────────
	// One free `nvapi-...` key (NVIDIA_API_KEY) unlocks all of these. NVIDIA-hosted,
	// so there is no first-party-vs-OpenRouter split: `native` is the only route and
	// the provider simply shows unavailable until the key is set. Rate-limited free
	// tier — great for experimentation, not a guaranteed-uptime production path.
	'nvidia-nemotron-120b': {
		label: 'Nemotron 3 Super 120B',
		network: 'NVIDIA NIM',
		tier: 'flagship',
		maxOutput: 16384,
		description: 'NVIDIA’s flagship Nemotron MoE. Strong agentic reasoning, free on NIM.',
		reasoningTrace: true,
		native: () => (env.NVIDIA_API_KEY ? nvidia('nvidia/nemotron-3-super-120b-a12b') : null),
	},
	'nvidia-nemotron-super-49b': {
		label: 'Llama-Nemotron Super 49B',
		network: 'NVIDIA NIM',
		tier: 'reasoning',
		maxOutput: 16384,
		description: 'Nemotron reasoning model tuned on Llama 3.3. Math, code, planning.',
		reasoningTrace: true,
		native: () => (env.NVIDIA_API_KEY ? nvidia('nvidia/llama-3.3-nemotron-super-49b-v1.5') : null),
	},
	'nvidia-nemotron-nano': {
		label: 'Nemotron Nano 9B',
		network: 'NVIDIA NIM',
		tier: 'balanced',
		maxOutput: 8192,
		description: 'Compact Nemotron with built-in reasoning. Strong quality per token.',
		reasoningTrace: true,
		native: () => (env.NVIDIA_API_KEY ? nvidia('nvidia/nvidia-nemotron-nano-9b-v2') : null),
	},
	'nvidia-deepseek-v4': {
		label: 'DeepSeek V4 Pro',
		network: 'NVIDIA NIM',
		tier: 'reasoning',
		maxOutput: 16384,
		description: 'DeepSeek V4 Pro hosted on NVIDIA NIM. Deep reasoning, free tier.',
		reasoningTrace: true,
		native: () => (env.NVIDIA_API_KEY ? nvidia('deepseek-ai/deepseek-v4-pro') : null),
	},
	'nvidia-kimi-k2': {
		label: 'Kimi K2.6',
		network: 'NVIDIA NIM',
		tier: 'flagship',
		maxOutput: 16384,
		description: 'Moonshot Kimi K2.6 on NIM. Long-context agentic model, free tier.',
		native: () => (env.NVIDIA_API_KEY ? nvidia('moonshotai/kimi-k2.6') : null),
	},
	'nvidia-llama4-maverick': {
		label: 'Llama 4 Maverick',
		network: 'NVIDIA NIM',
		tier: 'balanced',
		maxOutput: 8192,
		description: 'Meta Llama 4 Maverick (128-expert MoE) on NIM. Fast, multimodal-capable.',
		native: () => (env.NVIDIA_API_KEY ? nvidia('meta/llama-4-maverick-17b-128e-instruct') : null),
	},
	'nvidia-minimax-m2': {
		label: 'MiniMax M2.7',
		network: 'NVIDIA NIM',
		tier: 'balanced',
		maxOutput: 8192,
		description: 'MiniMax M2.7 on NIM. Strong general reasoning and chat, free tier.',
		native: () => (env.NVIDIA_API_KEY ? nvidia('minimaxai/minimax-m2.7') : null),
	},
};

// Every configured OpenRouter key, primary first. Fallback keys are typically
// unfunded free-tier accounts (see env.OPENROUTER_FALLBACK_KEYS) — they can't
// serve paid mirrors, but they keep every :free route alive when the primary
// account is out of credits or rate-limited.
function openrouterKeys() {
	return [...new Set([env.OPENROUTER_API_KEY, ...env.OPENROUTER_FALLBACK_KEYS].filter(Boolean))];
}

// Resolve the primary route for a spec: native first-party model when its key is
// present, otherwise the OpenRouter-routed equivalent, otherwise nothing. `via`
// records which path won so buildFallback() knows whether OpenRouter is a
// distinct escape hatch.
function buildPrimary(spec) {
	// watsonx leads when its creds are present; otherwise fall through so a
	// Granite spec with an openrouterModel still resolves (OpenRouter-hosted
	// Granite becomes the primary lane instead of showing unavailable).
	if (spec.watsonx && watsonxConfig().configured) return { kind: 'watsonx' };
	// Vertex-served Claude — routed through the shared vertex-claude transport
	// (not an AI SDK model object), so it reports availability here and streams
	// via streamVertex() in streamBrain(). Requires the GCP project to be set.
	if (spec.vertex) return vertexClaudeConfigured() ? { kind: 'vertex', model: spec.vertex } : null;
	const native = spec.native?.();
	if (native) return { kind: 'model', model: native, via: 'native' };
	if (spec.openrouterModel && openrouterKeys().length) {
		return { kind: 'model', model: openrouter()(spec.openrouterModel), via: 'openrouter' };
	}
	return null;
}

// The spend-ledger lane for a resolved primary route. A native route meters
// under its own network's provider (the model id comes off the AI SDK model
// object); an OpenRouter-routed one meters as openrouter on the mirror id, which
// is the lane that quietly drew real money before any of this was recorded.
function meterForPrimary(spec, primary) {
	if (primary?.via === 'openrouter') return { provider: 'openrouter', model: spec.openrouterModel };
	const provider = meterProviderForNetwork(spec.network);
	const model = primary?.model?.modelId || null;
	return provider && model ? { provider, model } : null;
}

// A distinct fallback exists only when the primary ran on a native provider key
// AND an OpenRouter key is configured — then OpenRouter routes around a native
// outage (quota exhausted, out of credits, rate-limited). When the primary was
// already OpenRouter the free-tier safety net (freeFallbackChain) is the next stop.
function buildFallback(spec, primary) {
	if (!spec.openrouterModel || !openrouterKeys().length) return null;
	// The mirror routes around a native/watsonx/vertex outage on the SAME model
	// via OpenRouter. Skip it only when the primary ALREADY ran on OpenRouter —
	// the mirror would be the identical key+model and the free-tier chain is the
	// meaningful next stop.
	if (primary?.via === 'openrouter') return null;
	return openrouter()(spec.openrouterModel);
}

// The last line of defense: free providers the platform can always fall back to
// when the requested model's primary AND mirror routes both fail before any
// token streamed. Free-first platform policy (api/_lib/llm.js): the user gets
// an answer from an open-weight model rather than an error event. Skips routes
// that already failed as the primary (same key + model would fail identically).
// Exported for the anchor regression tests (tests/api/llm-vertex-anchor-surfaces).
export function freeFallbackChain(providerKey, spec, primary) {
	const chain = [];
	if (env.GROQ_API_KEY && providerKey !== 'groq-llama') {
		chain.push({
			label: 'groq/llama-3.3-70b-versatile',
			model: createOpenAI({ apiKey: env.GROQ_API_KEY, baseURL: 'https://api.groq.com/openai/v1' }).chat('llama-3.3-70b-versatile'),
			meter: { provider: 'groq', model: 'llama-3.3-70b-versatile' },
		});
	}
	openrouterKeys().forEach((key, i) => {
		// The primary already burned this exact key+model pair — don't repeat it.
		if (i === 0 && primary?.via === 'openrouter' && spec.openrouterModel === DEFAULT_FREE_MODEL) return;
		chain.push({
			label: `openrouter${i > 0 ? `#${i + 1}` : ''}/${DEFAULT_FREE_MODEL}`,
			model: openrouter(key)(DEFAULT_FREE_MODEL),
			meter: { provider: i > 0 ? `openrouter#${i + 1}` : 'openrouter', model: DEFAULT_FREE_MODEL },
		});
	});
	if (env.NVIDIA_API_KEY && !providerKey.startsWith('nvidia-')) {
		chain.push({
			label: 'nvidia/llama-3.3-70b-instruct',
			model: nvidia('meta/llama-3.3-70b-instruct'),
			meter: { provider: 'nvidia', model: 'meta/llama-3.3-70b-instruct' },
		});
	}
	// Three more free lanes on independent quota pools (see api/_lib/llm.js for
	// each tier's limits): SambaNova (Llama 3.3 70B), Mistral (Experiment tier),
	// and Z.AI's free GLM Flash. All OpenAI-compatible Chat Completions.
	if (env.SAMBANOVA_API_KEY) {
		chain.push({
			label: 'sambanova/Meta-Llama-3.3-70B-Instruct',
			model: createOpenAI({ apiKey: env.SAMBANOVA_API_KEY, baseURL: 'https://api.sambanova.ai/v1' }).chat('Meta-Llama-3.3-70B-Instruct'),
			meter: { provider: 'sambanova', model: 'Meta-Llama-3.3-70B-Instruct' },
		});
	}
	if (env.MISTRAL_API_KEY) {
		chain.push({
			label: 'mistral/mistral-small-latest',
			model: createOpenAI({ apiKey: env.MISTRAL_API_KEY, baseURL: 'https://api.mistral.ai/v1' }).chat('mistral-small-latest'),
			meter: { provider: 'mistral', model: 'mistral-small-latest' },
		});
	}
	if (env.ZAI_API_KEY) {
		chain.push({
			label: 'zai/glm-4.7-flash',
			model: createOpenAI({ apiKey: env.ZAI_API_KEY, baseURL: 'https://api.z.ai/api/paas/v4' }).chat('glm-4.7-flash'),
			meter: { provider: 'zai', model: 'glm-4.7-flash' },
		});
	}
	// Credits-funded Vertex Gemini anchor, ALWAYS at the tail when the GCP
	// project is set (api/chat.js semantics, see api/_lib/vertex-gemini.js). No
	// key gates it and nothing may evict it: it is the rung that keeps /brain
	// streaming when groq/openrouter/nvidia all throttle at once and the paid
	// backstops are dead. The AI SDK model is built lazily in streamBrain's
	// attempt loop (vertexGemini flag) because its bearer token is minted per
	// request; a token failure falls through like any other provider error.
	if (vertexGeminiAvailable()) {
		chain.push({
			label: `vertex-gemini/${vertexGeminiModel()}`,
			vertexGemini: true,
			// Credits-billed, not free: it draws down the GCP grant, so it meters
			// at Vertex list price like every other spending lane.
			meter: { provider: 'vertex-gemini', model: vertexGeminiModel() },
		});
	}
	return chain;
}

// Splice Vertex's `extra_body` into an outgoing AI SDK request payload. The SDK
// serializes the body before its fetch hook runs, so the only place to add a
// field it does not model is here. Anything unparseable passes through untouched
// rather than breaking the request.
function withVertexExtraBody(body, extraBody) {
	if (typeof body !== 'string' || !extraBody) return body;
	try {
		const parsed = JSON.parse(body);
		if (!parsed || typeof parsed !== 'object') return body;
		return JSON.stringify({ ...parsed, extra_body: extraBody });
	} catch {
		return body;
	}
}

// NVIDIA NIM (build.nvidia.com) is OpenAI-*compatible* (Chat Completions, not the
// Responses API), so — like Groq, ModelScope and OpenRouter — we force the
// `.chat()` surface. One free `nvapi-...` key unlocks every hosted model.
function nvidia(modelId) {
	return createOpenAI({
		apiKey: env.NVIDIA_API_KEY,
		baseURL: 'https://integrate.api.nvidia.com/v1',
	}).chat(modelId);
}

// Reported OpenRouter cost per model instance, in USD. A model object is built
// per request (resolveBrain runs per call), so the WeakMap entry is per-request
// too and disappears with the model. See recordBrainSpend.
const openrouterCostByModel = new WeakMap();

/** The USD OpenRouter reported for the last call on this model, or null. */
function reportedCostFor(model) {
	const cell = model ? openrouterCostByModel.get(model) : null;
	return cell && Number.isFinite(cell.usd) ? cell.usd : null;
}

function openrouter(key = openrouterKeys()[0]) {
	// OpenRouter (like every OpenAI-*compatible* backend) implements the Chat
	// Completions API, NOT OpenAI's newer Responses API. The AI SDK's callable
	// default `provider(id)` builds a Responses-API model, which OpenRouter
	// rejects ("Invalid Responses API request" / "unsupported content types").
	// Force the chat-completions surface so every routed model actually answers.
	return (modelId) => {
		// One cost cell per model instance: the metering fetch fills it in when
		// OpenRouter reports what the call was charged (openrouter-usage.js). Paid
		// vendor mirrors run through here, so without this the spend is invisible.
		const cell = { usd: null };
		const model = createOpenAI({
			apiKey: key,
			baseURL: 'https://openrouter.ai/api/v1',
			headers: { 'HTTP-Referer': 'https://three.ws', 'X-Title': 'three.ws brain' },
			fetch: openrouterUsageFetch((usd) => {
				cell.usd = usd;
			}),
		}).chat(modelId);
		openrouterCostByModel.set(model, cell);
		return model;
	};
}

// Display network → the provider name the spend ledger meters under. Every
// PROVIDERS spec's `network` must resolve here (tests/api/brain-spend.test.js
// asserts it), because an unmapped lane would silently record no provider and
// drop out of the metering audit.
const NETWORK_METER_PROVIDER = {
	Anthropic: 'anthropic',
	'Anthropic · Google Vertex': 'vertex-anthropic',
	OpenAI: 'openai',
	'OpenAI · OpenRouter': 'openrouter',
	xAI: 'grok',
	'NVIDIA NIM': 'nvidia',
	Groq: 'groq',
	ModelScope: 'modelscope',
	DeepSeek: 'deepseek',
	DashScope: 'dashscope',
	'IBM watsonx.ai': 'watsonx',
};

/** The ledger provider name for a spec's native lane. */
export function meterProviderForNetwork(network) {
	return NETWORK_METER_PROVIDER[network] || null;
}

// Write one /brain turn to the spend ledger. Until this existed, /brain was the
// platform's largest unmetered LLM surface: it routes paid vendor mirrors
// (anthropic/claude-opus-5 at $5/$25 per MTok) on the platform OpenRouter key
// and recorded nothing at all, so the balance drained with no trace. Cost comes
// from OpenRouter's own reported charge when it gives one, else the list-price
// table; an unpriced spending lane records unknown (null) and warns rather than
// booking a fake $0. Fire-and-forget, after the response has already ended.
function recordBrainSpend({ provider, model, usage, latencyMs, userId, providerKey, laneLabel, reportedCostUsd = null }) {
	if (!provider || !model) return;
	const input = usage?.inputTokens ?? 0;
	const output = usage?.outputTokens ?? 0;
	const cost = costMicroUsd({ provider, model, input, output, reportedCostUsd });
	if (cost === null && (input || output)) {
		console.warn(`[brain:${providerKey}] unpriced spending lane ${provider}/${model}, recording cost as unknown; add it to llm-pricing.js`);
	}
	recordEvent({
		kind: 'llm',
		provider,
		model,
		tool: `brain:${providerKey}`,
		userId: userId ?? null,
		inputTokens: input,
		outputTokens: output,
		costMicroUsd: cost,
		latencyMs,
		meta: { surface: 'brain', provider_key: providerKey, lane: laneLabel, cost_reported: reportedCostUsd !== null },
	});
}

// Stream IBM Granite (watsonx.ai) to the page using the same SSE protocol as
// the AI SDK path. watsonx returns OpenAI-shaped chat completion chunks
// (choices[].delta.content) plus a usage block on the final chunk.
async function streamWatsonx(res, { messages, system, maxTokens, t0 }) {
	const cfg = watsonxConfig();
	const wxMessages = system ? [{ role: 'system', content: system }, ...messages] : messages;
	const { url, headers, body } = await watsonxChatRequest(cfg, {
		messages: wxMessages,
		maxTokens,
	});

	// Bound the wait for response HEADERS only: a streamed completion may run
	// longer than any sensible deadline, so the timer is cleared once watsonx
	// answers, and only a hung connection is cut.
	const headersCtrl = new AbortController();
	const headersTimer = setTimeout(() => headersCtrl.abort(), WATSONX_HEADERS_TIMEOUT_MS);
	let upstream;
	try {
		upstream = await fetch(url, {
			method: 'POST',
			headers,
			body: JSON.stringify(body),
			signal: headersCtrl.signal,
		});
	} catch (err) {
		throw new Error(`watsonx unreachable: ${err?.name === 'AbortError' ? `no response headers within ${WATSONX_HEADERS_TIMEOUT_MS}ms` : err?.message || 'network error'}`);
	} finally {
		clearTimeout(headersTimer);
	}
	if (!upstream.ok || !upstream.body) {
		const detail = await upstream.text().catch(() => '');
		throw new Error(`watsonx ${upstream.status}: ${detail.slice(0, 200)}`);
	}

	const reader = upstream.body.getReader();
	const decoder = new TextDecoder();
	let buf = '';
	let firstTokenMs = null;
	let usage = null;

	while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		buf += decoder.decode(value, { stream: true });
		const lines = buf.split('\n');
		buf = lines.pop();
		for (const line of lines) {
			if (!line.startsWith('data:')) continue;
			const raw = line.slice(5).trim();
			if (!raw || raw === '[DONE]') continue;
			let evt;
			try {
				evt = JSON.parse(raw);
			} catch {
				continue;
			}
			const delta = evt.choices?.[0]?.delta?.content;
			if (delta) {
				if (firstTokenMs === null) {
					firstTokenMs = Date.now() - t0;
					res.write(`event: first\ndata: ${JSON.stringify({ firstTokenMs })}\n\n`);
				}
				res.write(`data: ${JSON.stringify(delta)}\n\n`);
			}
			if (evt.usage) {
				usage = {
					inputTokens: evt.usage.prompt_tokens,
					outputTokens: evt.usage.completion_tokens,
					totalTokens: evt.usage.total_tokens,
				};
			}
		}
	}

	const elapsedMs = Date.now() - t0;
	res.write(`event: done\ndata: ${JSON.stringify({ elapsedMs, firstTokenMs, usage })}\n\n`);
	res.write('data: [DONE]\n\n');
	res.end();
	return { usage, elapsedMs };
}

// Stream Vertex-served Claude to the /brain page using the same SSE protocol as
// the AI SDK path. Vertex returns first-party Anthropic Messages SSE, so we parse
// content_block_delta text_delta events and re-emit them as brain first/chunk/done
// events. Like streamWatsonx it only throws before writing tokens (a non-ok
// upstream or connection failure), so streamBrain can fall back to the free chain.
async function streamVertex(res, { messages, system, maxTokens, t0, model }) {
	const upstream = await vertexAnthropicMessages(
		{ model, max_tokens: maxTokens, ...(system ? { system } : {}), messages },
		{ stream: true },
	);
	if (!upstream.ok || !upstream.body) {
		const detail = await upstream.text().catch(() => '');
		throw new Error(`vertex ${upstream.status}: ${detail.slice(0, 200)}`);
	}

	const reader = upstream.body.getReader();
	const decoder = new TextDecoder();
	let buf = '';
	let firstTokenMs = null;
	let inputTokens = 0;
	let outputTokens = 0;

	while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		buf += decoder.decode(value, { stream: true });
		const lines = buf.split('\n');
		buf = lines.pop();
		for (const line of lines) {
			if (!line.startsWith('data:')) continue;
			const raw = line.slice(5).trim();
			if (!raw || raw === '[DONE]') continue;
			let evt;
			try {
				evt = JSON.parse(raw);
			} catch {
				continue;
			}
			if (evt.type === 'message_start') {
				inputTokens = evt.message?.usage?.input_tokens ?? inputTokens;
			} else if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
				const text = evt.delta.text || '';
				if (text) {
					if (firstTokenMs === null) {
						firstTokenMs = Date.now() - t0;
						res.write(`event: first\ndata: ${JSON.stringify({ firstTokenMs })}\n\n`);
					}
					res.write(`data: ${JSON.stringify(text)}\n\n`);
				}
			} else if (evt.type === 'message_delta') {
				outputTokens = evt.usage?.output_tokens ?? outputTokens;
			}
		}
	}

	const elapsedMs = Date.now() - t0;
	const usage = { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
	res.write(`event: done\ndata: ${JSON.stringify({ elapsedMs, firstTokenMs, usage })}\n\n`);
	res.write('data: [DONE]\n\n');
	res.end();
	return { usage, elapsedMs };
}

export function validateMessages(input) {
	if (!Array.isArray(input)) {
		throw Object.assign(new Error('messages must be an array'), { status: 400 });
	}
	if (input.length === 0 || input.length > 100) {
		throw Object.assign(new Error('messages length out of range'), { status: 400 });
	}
	const out = [];
	for (const m of input) {
		if (!m || typeof m !== 'object') throw Object.assign(new Error('bad message'), { status: 400 });
		const role = m.role;
		const content = typeof m.content === 'string' ? m.content.slice(0, 16000) : '';
		if (!['user', 'assistant'].includes(role)) {
			throw Object.assign(new Error('role must be user|assistant'), { status: 400 });
		}
		if (!content.trim()) throw Object.assign(new Error('empty content'), { status: 400 });
		out.push({ role, content });
	}
	return out;
}

export function getAvailableProviders() {
	return Object.entries(PROVIDERS).map(([key, spec]) => {
		const available = Boolean(buildPrimary(spec));
		return {
			key,
			label: spec.label,
			network: spec.network,
			tier: spec.tier,
			maxOutput: spec.maxOutput,
			description: spec.description,
			available,
			// `available` means the deployment holds a route for the model;
			// `requiresAuth` means the caller still needs a session to use it
			// (the anon gate below). A client that cannot tell them apart offers
			// a signed-out visitor a model that can only answer 401, which is
			// exactly what the brain page used to do with its default line-up.
			requiresAuth: !ANON_BRAIN_PROVIDERS.has(key),
		};
	});
}

// Resolve a provider key into a streamable plan: the spec, its primary route
// (native key or OpenRouter mirror), and a distinct OpenRouter fallback when one
// exists. Returns { ok: false, status, code, message, available? } when the key
// is unknown or no route is configured, so every caller (the brain page handler
// and the live Q&A concierge) reports the same errors identically.
// Retired provider keys still stored in user prefs resolve to their successor
// model instead of a 400 (gpt-4o family deprecated upstream July 2026).
const PROVIDER_ALIASES = {
	'gpt-4o': 'gpt-5.6-sol',
	'gpt-4o-mini': 'gpt-5.6-luna',
	'o3-mini': 'o3',
};

/**
 * The live provider key a request should be served on: a retired key maps to its
 * successor, everything else passes through unchanged. EVERY key-keyed decision
 * (the anon-tier gate, the thinking-model token floor, the spec lookup) has to run
 * on this value, or the alias table is dead: the handler used to reject `gpt-4o`
 * with a 400 before resolveBrain() ever saw it, which is exactly the key
 * packages/brain-mcp advertises to MCP clients in its chat tool schema.
 * Exported for tests.
 */
export function canonicalProviderKey(providerKey) {
	return PROVIDER_ALIASES[providerKey] || providerKey;
}

export function resolveBrain(providerKey) {
	const spec = PROVIDERS[canonicalProviderKey(providerKey)];
	if (!spec) {
		return {
			ok: false,
			status: 400,
			code: 'unknown_provider',
			message: `unknown provider: ${providerKey}`,
			available: Object.keys(PROVIDERS),
		};
	}
	const primary = buildPrimary(spec);
	if (!primary) {
		return {
			ok: false,
			status: 503,
			code: 'provider_not_configured',
			message: `No API key for ${spec.label}. Add your own key in Account → AI Provider Keys to unlock this model.`,
		};
	}
	return { ok: true, spec, primary, fallbackModel: buildFallback(spec, primary) };
}

// Stream a brain completion to an SSE `res`: sets the event-stream headers, emits
// the `meta` event, then runs the requested route → OpenRouter mirror → free-tier
// safety-net chain, emitting `first` / chunk / `done` / `error` / `fallback`
// events. Shared by POST /api/brain/chat and POST /api/agent-ask so both inherit
// the same tuned timeout budget and never-error-while-a-free-route-can-answer
// behaviour. The caller owns auth, rate limiting, and message validation; this
// owns the transport. Resolve `plan` via resolveBrain() first.
export async function streamBrain(res, { plan, providerKey, messages, system, maxTokens, userId = null }) {
	const { spec, primary, fallbackModel } = plan;

	res.statusCode = 200;
	res.setHeader('content-type', 'text/event-stream; charset=utf-8');
	res.setHeader('cache-control', 'no-cache, no-transform');
	res.setHeader('connection', 'keep-alive');
	res.setHeader('x-accel-buffering', 'no');

	const t0 = Date.now();
	res.write(`event: meta\ndata: ${JSON.stringify({
		provider: providerKey,
		label: spec.label,
		network: spec.network,
		tier: spec.tier,
	})}\n\n`);

	// Per-attempt abort budget. A hung native provider must not silently consume
	// the whole maxDuration; cap each streamText attempt at the smaller of
	// PER_ATTEMPT_MS or the remaining wall-clock so it aborts fast and hands off
	// to the OpenRouter fallback while time remains. Mirrors the timeout-budget
	// pattern in api/chat.js. TOTAL_BUDGET_MS leaves headroom under maxDuration=120
	// so a primary-then-fallback pair both fit; PER_ATTEMPT_MS stays under the
	// ~30s hang that previously near-timed-out the function.
	const TOTAL_BUDGET_MS = 110_000;
	const PER_ATTEMPT_MS = 25_000;
	const deadline = t0 + TOTAL_BUDGET_MS;
	const attemptBudgetMs = () => Math.max(1_000, Math.min(PER_ATTEMPT_MS, deadline - Date.now()));

	let firstTokenMs = null;

	// Drains one streamText attempt to the SSE response. firstTokenMs is set on
	// the first delta; once tokens have been written we are committed and can no
	// longer transparently retry (the client already has partial output).
	const streamOnce = async (budget, model) => {
		// The SDK's default onError console.errors the entire provider error object
		// (the giant 402/429 dumps in the logs). We own error handling via the
		// retry/fallback chain below, so capture it here instead. Some providers
		// report a pre-stream failure through onError rather than by throwing from
		// textStream — surfacing the captured error keeps the chain working either way.
		let streamErr = null;
		const result = streamText({
			model,
			system,
			messages,
			maxOutputTokens: budget,
			// maxRetries: 0 — the outer retry/fallback chain owns retries. The SDK
			// default of 2 means a quota-exhausted or credits-depleted key burns
			// ~10–20s retrying before surfacing the error we already know to route around.
			maxRetries: 0,
			// Bound this attempt by the remaining wall-clock so a hung provider
			// aborts fast and the outer chain can fall back while time remains. The
			// abort surfaces as a thrown error (or via onError) handled below.
			abortSignal: AbortSignal.timeout(attemptBudgetMs()),
			onError: ({ error }) => {
				streamErr = error;
			},
		});

		// Reasoning-tuned models (Nemotron, DeepSeek) emit their chain-of-thought
		// inline in <think>…</think> before the answer. Strip it from the visible
		// stream so the chat never shows scratch work. Enabled only for specs that
		// actually emit traces (spec.reasoningTrace) — a no-op for every other model
		// — and the filter is streaming-safe, so a tag split across deltas is still
		// caught. Fallback routes are non-reasoning, so the same stripper is a no-op
		// there too.
		const stripper = spec.reasoningTrace ? createReasoningStripper() : null;
		// Emit one visible text fragment, marking first-token timing on the first
		// fragment the client actually sees (not on suppressed reasoning) — so the
		// retry/fallback chain stays free to switch routes until real output streams.
		const emit = (text) => {
			if (!text) return;
			if (firstTokenMs === null) {
				firstTokenMs = Date.now() - t0;
				res.write(`event: first\ndata: ${JSON.stringify({ firstTokenMs })}\n\n`);
			}
			res.write(`data: ${JSON.stringify(text)}\n\n`);
		};

		for await (const delta of result.textStream) {
			emit(stripper ? stripper.push(delta) : delta);
		}
		// Flush any text the filter held at the boundary (a trailing partial tag that
		// turned out to be real); an unterminated trace is dropped.
		if (stripper) emit(stripper.flush());

		// Failure before any token streamed → hand to the retry/fallback logic.
		// A failure *after* partial output isn't retryable, so we finish cleanly
		// with whatever was produced.
		//
		// A route can also end a stream having emitted NOTHING and reported no
		// error: the per-attempt abort fires before the first token on a slow free
		// route, or the upstream returns an empty completion. Silently writing
		// `done` there ends the response 200-with-no-text and skips the entire
		// fallback chain, so the caller gets a blank answer while healthy routes
		// sit unused. Zero visible output is a failed attempt: throw so the next
		// route runs, and if every route comes up empty the outer catch surfaces a
		// real `error` event instead of a fake success.
		if (firstTokenMs === null) throw streamErr || new Error('provider streamed no output');

		const usage = await result.usage.catch(() => null);
		const elapsedMs = Date.now() - t0;
		res.write(`event: done\ndata: ${JSON.stringify({
			elapsedMs,
			firstTokenMs,
			usage: usage ? {
				inputTokens: usage.inputTokens,
				outputTokens: usage.outputTokens,
				totalTokens: usage.totalTokens,
			} : null,
		})}\n\n`);
		res.write('data: [DONE]\n\n');
		res.end();
		return { usage, elapsedMs };
	};

	// Ordered attempt list: the requested route first, its OpenRouter mirror
	// second, then the free-tier safety net (Groq → OpenRouter :free across every
	// key → NVIDIA NIM). Any attempt that fails BEFORE the first token — auth
	// failure on a dead server key, quota exhaustion, rate limit, hang, 5xx —
	// hands off to the next route, so a single bad provider never surfaces as an
	// error event while any free provider can still answer. Once partial output
	// has streamed we are committed to that attempt.
	try {
		// `meter` names the lane in the spend ledger: { provider, model } as
		// llm-pricing.js understands them. Every attempt that can draw money
		// carries one, so no /brain turn lands in the ledger unattributed. The
		// watsonx lane is the one exception: IBM bills its trial entitlement
		// outside per-token pricing, so there is no honest number to record.
		const attempts =
			primary.kind === 'watsonx'
				? [{ label: 'watsonx', watsonx: true }]
				: primary.kind === 'vertex'
					? [{ label: 'vertex', vertex: true, model: primary.model, meter: { provider: 'vertex-anthropic', model: primary.model } }]
					: [{ label: 'primary', model: primary.model, meter: meterForPrimary(spec, primary) }];
		if (fallbackModel) {
			attempts.push({
				label: 'openrouter-mirror',
				model: fallbackModel,
				meter: { provider: 'openrouter', model: spec.openrouterModel },
			});
		}
		for (const f of freeFallbackChain(providerKey, spec, primary)) attempts.push(f);

		let lastErr = null;
		for (const [i, attempt] of attempts.entries()) {
			if (firstTokenMs !== null || res.writableEnded) return;
			// Leave the attempt at least a second of wall-clock to connect.
			if (i > 0 && Date.now() >= deadline - 1_000) break;
			if (i > 0) {
				console.warn(`[brain:${providerKey}] ${attempts[i - 1].label} failed (${conciseReason(lastErr)}); falling back to ${attempt.label}`);
				// Advisory for the client (current page ignores unknown events).
				res.write(`event: fallback\ndata: ${JSON.stringify({ route: attempt.label })}\n\n`);
			}
			// Record one completed attempt in the spend ledger. Runs after the
			// response has already ended, so it never adds latency to the turn.
			const meterAttempt = (outcome) => {
				if (!attempt.meter) return;
				recordBrainSpend({
					provider: attempt.meter.provider,
					model: attempt.meter.model,
					usage: outcome?.usage,
					latencyMs: outcome?.elapsedMs ?? Date.now() - t0,
					userId,
					providerKey,
					laneLabel: attempt.label,
					reportedCostUsd: reportedCostFor(attempt.model),
				});
			};
			try {
				// watsonx.ai isn't an AI SDK model — stream it through the shared
				// client, emitting the same first/chunk/done event protocol. It only
				// throws before writing tokens, so falling through is safe.
				if (attempt.watsonx) await streamWatsonx(res, { messages, system, maxTokens, t0 });
				else if (attempt.vertex)
					meterAttempt(await streamVertex(res, { messages, system, maxTokens, t0, model: attempt.model }));
				else if (attempt.vertexGemini) {
					// Credits anchor: OpenAI-compatible Vertex endpoint, bearer token
					// minted per attempt (a token-exchange failure throws here and is
					// handled like any other lane failure). Reuses streamOnce so the
					// budget/abort/onError machinery is identical to every other lane.
					// Gemini reasons by default and its reasoning tokens are billed
					// against max_tokens without being returned, so an uncompensated
					// budget streams a truncated answer. vertexGeminiBudget caps the
					// reasoning and funds it on top of the caller's budget; the SDK has
					// no field for Vertex's `extra_body`, so it rides in on a fetch that
					// splices it into the outgoing payload.
					const budget = vertexGeminiBudget(maxTokens);
					const anchorModel = createOpenAI({
						apiKey: await vertexGeminiAccessToken(),
						baseURL: vertexGeminiOpenAIBase(),
						fetch: (url, init) =>
							fetch(url, { ...init, body: withVertexExtraBody(init?.body, budget.extra_body) }),
					}).chat(vertexGeminiModel());
					meterAttempt(await streamOnce(budget.max_tokens, anchorModel));
				} else meterAttempt(await streamOnce(maxTokens, attempt.model));
				return;
			} catch (err) {
				lastErr = err;
				// OpenRouter free tier: "requires more credits, or fewer max_tokens.
				// You requested up to 1024 tokens, but can only afford 788." Retry this
				// route once at the affordable ceiling before moving on.
				const affordable = attempt.model ? affordableBudget(err) : null;
				if (affordable && firstTokenMs === null && !res.writableEnded) {
					try {
						meterAttempt(await streamOnce(affordable, attempt.model));
						return;
					} catch (err2) {
						lastErr = err2;
					}
				}
			}
		}
		throw lastErr || new Error('no provider route available');
	} catch (err) {
		const elapsedMs = Date.now() - t0;
		// The SDK no longer logs for us (onError is captured), so emit one concise
		// server line for observability — not the multi-screen error object.
		console.warn(`[brain:${providerKey}] stream failed: ${conciseReason(err)}`);
		if (!res.writableEnded) {
			try {
				res.write(`event: error\ndata: ${JSON.stringify({
					message: userFacingStreamError(err),
					reason: conciseReason(err),
					elapsedMs,
				})}\n\n`);
				res.end();
			} catch {
				// connection already closed — swallow to prevent unhandled rejection
			}
		}
	}
}

export default wrap(async function handler(req, res) {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS' })) return;

	if (req.method === 'GET') {
		const providers = getAvailableProviders();
		res.setHeader('content-type', 'application/json');
		res.setHeader('cache-control', 'public, s-maxage=60, stale-while-revalidate=120');
		res.end(JSON.stringify({ providers }));
		return;
	}

	if (!method(req, res, ['POST'])) return;

	// Auth + rate limiting. The paid flagship models run on the server's billed
	// API keys, so an unmetered, unauthenticated proxy is a direct financial-drain
	// vector. Authenticated callers get a generous per-user budget; anonymous
	// callers a tight per-IP one and access only to the free-tier providers.
	const session = await getSessionUser(req);
	const bearer = session ? null : await authenticateBearer(extractBearer(req));
	const userId = session?.id ?? bearer?.userId ?? null;
	if (userId) {
		const rl = await limits.brainChatUser(userId);
		if (!rl.success) return rateLimited(res, rl, 'too many chat requests, slow down');
	} else {
		const rl = await limits.brainChatIp(clientIp(req));
		if (!rl.success) return rateLimited(res, rl, 'too many anonymous chat requests, try again shortly');
	}

	let body;
	try {
		body = await readJson(req, 200_000);
	} catch (e) {
		return error(res, e.status || 400, 'bad_request', e.message);
	}

	// Retired keys resolve to their successor before anything else reads them, so
	// the anon-tier gate, the plan, and the output-token floor all judge the model
	// that will actually serve the turn rather than the name the caller sent.
	const providerKey = canonicalProviderKey(String(body.provider || 'gpt-oss-120b'));
	const spec = PROVIDERS[providerKey];
	if (!spec) {
		return error(res, 400, 'unknown_provider', `unknown provider: ${providerKey}`, {
			available: Object.keys(PROVIDERS),
		});
	}
	// Paid first-party models are sign-in only — anonymous callers are clamped to
	// the free tiers so they can't burn the server's billed Anthropic/OpenAI keys.
	if (!userId && !ANON_BRAIN_PROVIDERS.has(providerKey)) {
		return error(res, 401, 'unauthorized', 'sign in to use this model');
	}

	// Validate the caller's own input before resolving routes: a malformed message
	// list is the caller's 400 to fix, and reporting it as the provider's 503
	// ("add your own key") sends them after the wrong problem entirely.
	let messages;
	try {
		messages = validateMessages(body.messages);
	} catch (e) {
		return error(res, e.status || 400, 'bad_request', e.message);
	}

	const plan = resolveBrain(providerKey);
	if (!plan.ok) {
		return error(res, plan.status, plan.code, plan.message,
			plan.available ? { available: plan.available } : undefined);
	}

	const system = typeof body.system === 'string' ? body.system.slice(0, 8000) : undefined;
	const maxTokens = resolveMaxTokens(body.maxTokens, providerKey, plan.spec.maxOutput);

	await streamBrain(res, { plan, providerKey, messages, system, maxTokens, userId });
});

/**
 * Output-token budget for one /brain turn, clamped to what the model can serve.
 *
 * The historical 64-token floor assumes the whole budget becomes visible text.
 * That is false for a thinking-by-default model, where `max_tokens` covers
 * reasoning AND the reply — a caller asking for 100 tokens there gets a turn
 * spent entirely on reasoning that streams back nothing, with no error to
 * explain it. Those models get a floor with room for both. The model's own
 * `maxOutput` still caps the result, and a generous request is never lowered.
 *
 * (For the Claude entries the provider key IS the model id — see PROVIDERS.)
 * Exported for tests.
 */
export function resolveMaxTokens(requestedMaxTokens, providerKey, specMaxOutput) {
	const requested = Math.max(Number(requestedMaxTokens) || 4096, 64);
	const floor = modelThinksByDefault(providerKey) ? 4096 : 64;
	return Math.min(Math.max(requested, floor), specMaxOutput);
}

// OpenRouter (and some OpenAI-compatible backends) reject a request whose
// max_tokens exceeds the caller's remaining credit, naming the affordable
// ceiling: "...but can only afford 788." Returns that ceiling (with a safety
// margin) so we can retry within budget, or null when the error isn't this.
function affordableBudget(err) {
	const m = /can only afford (\d+)/i.exec(err?.message || '');
	return m ? Math.max(64, Math.floor(Number(m[1]) * 0.9)) : null;
}

// One-line, length-capped error summary for server logs.
function conciseReason(err) {
	const msg = (err?.message || String(err)).replace(/\s+/g, ' ').trim();
	return msg.length > 160 ? `${msg.slice(0, 157)}…` : msg;
}

/**
 * The message a visitor reads inside the model's column once every rung of the
 * fallback chain has failed. The raw error belongs to the last route tried, so
 * it surfaces words like "Forbidden" or "fetch failed" that describe a provider
 * the visitor never chose and cannot act on. Say what happened and what to do
 * instead; the precise reason still ships alongside as `reason` and is logged.
 * Exported for tests.
 */
export function userFacingStreamError(err) {
	const status = Number(err?.statusCode ?? err?.status) || 0;
	const msg = (err?.message || '').toLowerCase();

	if (status === 429 || /rate.?limit|too many requests|quota|resource[ _-]?exhausted/.test(msg)) {
		return 'Every route for this model is rate limited right now. Try again in a moment, or pick another model.';
	}
	if (status === 401 || status === 403 || /forbidden|unauthorized|permission denied|api key/.test(msg)) {
		return 'This model has no working route on this deployment right now. Pick another model while the route is restored.';
	}
	if (status === 404 || /not found|no such model|model.*(deprecated|retired)/.test(msg)) {
		return 'This model is no longer served upstream. Pick another model.';
	}
	if (/timeout|timed out|aborted|deadline/.test(msg)) {
		return 'This model took too long to answer. Try again, or pick a faster model.';
	}
	return 'This model could not answer. Try again, or pick another model.';
}
