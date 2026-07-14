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
import { DEFAULT_FREE_MODEL } from '../_lib/chat-models.js';
import { createReasoningStripper } from '../_lib/strip-reasoning.js';
import {
	vertexClaudeEnabled,
	vertexClaudeConfigured,
	vertexAnthropicMessages,
} from '../_lib/vertex-claude.js';

// Providers an anonymous (signed-out) caller may use: only the genuinely free
// tiers — the OpenRouter-routed open-weight default and the free NVIDIA NIM
// models. Every paid first-party model (Claude, GPT-4o, o3, DashScope, DeepSeek)
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
		description: "OpenAI's open-weight 120B. Fast, capable, free tier. Platform default.",
		// OpenRouter-only — no first-party key for the free tier.
		openrouterModel: 'openai/gpt-oss-120b:free',
	},
	'claude-fable-5': {
		label: 'Claude Fable 5',
		network: 'Anthropic',
		tier: 'flagship',
		maxOutput: 16384,
		description: 'Mythos-class flagship. State-of-the-art software engineering, knowledge work, vision, and science.',
		// First-party Anthropic only — not yet mirrored on OpenRouter, so there is
		// no openrouterModel fallback route (shows unavailable without the host key).
		native: () => (env.ANTHROPIC_API_KEY ? createAnthropic({ apiKey: env.ANTHROPIC_API_KEY })('claude-fable-5') : null),
	},
	'claude-mythos-5': {
		label: 'Claude Mythos 5',
		network: 'Anthropic',
		tier: 'flagship',
		maxOutput: 16384,
		description: 'Mythos-class flagship — same capabilities as Fable 5. Restricted-access; first-party Anthropic key only.',
		// First-party Anthropic only — no OpenRouter mirror, so there is no
		// openrouterModel fallback route (shows unavailable without the host key).
		native: () => (env.ANTHROPIC_API_KEY ? createAnthropic({ apiKey: env.ANTHROPIC_API_KEY })('claude-mythos-5') : null),
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
	'o3-mini': {
		label: 'o3-mini',
		network: 'OpenAI',
		tier: 'reasoning',
		maxOutput: 16384,
		description: 'Reasoning-optimized. Fast chain-of-thought.',
		native: () => (env.OPENAI_API_KEY ? createOpenAI({ apiKey: env.OPENAI_API_KEY }).chat('o3-mini') : null),
		openrouterModel: 'openai/o3-mini',
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
	if (spec.watsonx) return watsonxConfig().configured ? { kind: 'watsonx' } : null;
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

// A distinct fallback exists only when the primary ran on a native provider key
// AND an OpenRouter key is configured — then OpenRouter routes around a native
// outage (quota exhausted, out of credits, rate-limited). When the primary was
// already OpenRouter the free-tier safety net (freeFallbackChain) is the next stop.
function buildFallback(spec, primary) {
	if (primary?.via !== 'native' || !spec.openrouterModel || !openrouterKeys().length) return null;
	return openrouter()(spec.openrouterModel);
}

// The last line of defense: free providers the platform can always fall back to
// when the requested model's primary AND mirror routes both fail before any
// token streamed. Free-first platform policy (api/_lib/llm.js): the user gets
// an answer from an open-weight model rather than an error event. Skips routes
// that already failed as the primary (same key + model would fail identically).
function freeFallbackChain(providerKey, spec, primary) {
	const chain = [];
	if (env.GROQ_API_KEY && providerKey !== 'groq-llama') {
		chain.push({
			label: 'groq/llama-3.3-70b-versatile',
			model: createOpenAI({ apiKey: env.GROQ_API_KEY, baseURL: 'https://api.groq.com/openai/v1' }).chat('llama-3.3-70b-versatile'),
		});
	}
	openrouterKeys().forEach((key, i) => {
		// The primary already burned this exact key+model pair — don't repeat it.
		if (i === 0 && primary?.via === 'openrouter' && spec.openrouterModel === DEFAULT_FREE_MODEL) return;
		chain.push({
			label: `openrouter${i > 0 ? `#${i + 1}` : ''}/${DEFAULT_FREE_MODEL}`,
			model: openrouter(key)(DEFAULT_FREE_MODEL),
		});
	});
	if (env.NVIDIA_API_KEY && !providerKey.startsWith('nvidia-')) {
		chain.push({ label: 'nvidia/llama-3.3-70b-instruct', model: nvidia('meta/llama-3.3-70b-instruct') });
	}
	return chain;
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

function openrouter(key = openrouterKeys()[0]) {
	const provider = createOpenAI({
		apiKey: key,
		baseURL: 'https://openrouter.ai/api/v1',
		headers: { 'HTTP-Referer': 'https://three.ws', 'X-Title': 'three.ws brain' },
	});
	// OpenRouter (like every OpenAI-*compatible* backend) implements the Chat
	// Completions API, NOT OpenAI's newer Responses API. The AI SDK's callable
	// default `provider(id)` builds a Responses-API model, which OpenRouter
	// rejects ("Invalid Responses API request" / "unsupported content types").
	// Force the chat-completions surface so every routed model actually answers.
	return (modelId) => provider.chat(modelId);
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

	const upstream = await fetch(url, {
		method: 'POST',
		headers,
		body: JSON.stringify(body),
	});
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
};

export function resolveBrain(providerKey) {
	const spec = PROVIDERS[PROVIDER_ALIASES[providerKey] || providerKey];
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
export async function streamBrain(res, { plan, providerKey, messages, system, maxTokens }) {
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
		if (streamErr && firstTokenMs === null) throw streamErr;

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
	};

	// Ordered attempt list: the requested route first, its OpenRouter mirror
	// second, then the free-tier safety net (Groq → OpenRouter :free across every
	// key → NVIDIA NIM). Any attempt that fails BEFORE the first token — auth
	// failure on a dead server key, quota exhaustion, rate limit, hang, 5xx —
	// hands off to the next route, so a single bad provider never surfaces as an
	// error event while any free provider can still answer. Once partial output
	// has streamed we are committed to that attempt.
	try {
		const attempts =
			primary.kind === 'watsonx'
				? [{ label: 'watsonx', watsonx: true }]
				: primary.kind === 'vertex'
					? [{ label: 'vertex', vertex: true, model: primary.model }]
					: [{ label: 'primary', model: primary.model }];
		if (fallbackModel) attempts.push({ label: 'openrouter-mirror', model: fallbackModel });
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
			try {
				// watsonx.ai isn't an AI SDK model — stream it through the shared
				// client, emitting the same first/chunk/done event protocol. It only
				// throws before writing tokens, so falling through is safe.
				if (attempt.watsonx) await streamWatsonx(res, { messages, system, maxTokens, t0 });
				else if (attempt.vertex)
					await streamVertex(res, { messages, system, maxTokens, t0, model: attempt.model });
				else await streamOnce(maxTokens, attempt.model);
				return;
			} catch (err) {
				lastErr = err;
				// OpenRouter free tier: "requires more credits, or fewer max_tokens.
				// You requested up to 1024 tokens, but can only afford 788." Retry this
				// route once at the affordable ceiling before moving on.
				const affordable = attempt.model ? affordableBudget(err) : null;
				if (affordable && firstTokenMs === null && !res.writableEnded) {
					try {
						await streamOnce(affordable, attempt.model);
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
					message: err?.message || 'upstream error',
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

	const providerKey = String(body.provider || 'gpt-oss-120b');
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

	const plan = resolveBrain(providerKey);
	if (!plan.ok) {
		return error(res, plan.status, plan.code, plan.message,
			plan.available ? { available: plan.available } : undefined);
	}

	let messages;
	try {
		messages = validateMessages(body.messages);
	} catch (e) {
		return error(res, e.status || 400, 'bad_request', e.message);
	}

	const system = typeof body.system === 'string' ? body.system.slice(0, 8000) : undefined;
	const maxTokens = Math.min(Math.max(Number(body.maxTokens) || 4096, 64), plan.spec.maxOutput);

	await streamBrain(res, { plan, providerKey, messages, system, maxTokens });
});

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
