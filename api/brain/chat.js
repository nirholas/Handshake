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
import { cors, method, readJson, error, wrap } from '../_lib/http.js';

export const maxDuration = 120;

const PROVIDERS = {
	'claude-opus-4-7': {
		label: 'Claude Opus 4.7',
		network: 'Anthropic',
		tier: 'flagship',
		maxOutput: 16384,
		description: 'Most capable. Extended thinking, complex reasoning.',
		build: () => {
			if (env.ANTHROPIC_API_KEY) return createAnthropic({ apiKey: env.ANTHROPIC_API_KEY })('claude-opus-4-7');
			if (env.OPENROUTER_API_KEY) return openrouter()('anthropic/claude-opus-4');
			return null;
		},
	},
	'claude-sonnet-4-6': {
		label: 'Claude Sonnet 4.6',
		network: 'Anthropic',
		tier: 'balanced',
		maxOutput: 16384,
		description: 'Balanced speed and intelligence. Best for most tasks.',
		build: () => {
			if (env.ANTHROPIC_API_KEY) return createAnthropic({ apiKey: env.ANTHROPIC_API_KEY })('claude-sonnet-4-6');
			if (env.OPENROUTER_API_KEY) return openrouter()('anthropic/claude-sonnet-4');
			return null;
		},
	},
	'claude-haiku-4-5': {
		label: 'Claude Haiku 4.5',
		network: 'Anthropic',
		tier: 'fast',
		maxOutput: 8192,
		description: 'Fastest Claude. Low latency, high throughput.',
		build: () => {
			if (env.ANTHROPIC_API_KEY) return createAnthropic({ apiKey: env.ANTHROPIC_API_KEY })('claude-haiku-4-5-20251001');
			if (env.OPENROUTER_API_KEY) return openrouter()('anthropic/claude-3.5-haiku');
			return null;
		},
	},
	'gpt-4o': {
		label: 'GPT-4o',
		network: 'OpenAI',
		tier: 'flagship',
		maxOutput: 16384,
		description: 'OpenAI flagship. Strong multimodal reasoning.',
		build: () => {
			if (env.OPENAI_API_KEY) return createOpenAI({ apiKey: env.OPENAI_API_KEY })('gpt-4o');
			if (env.OPENROUTER_API_KEY) return openrouter()('openai/gpt-4o');
			return null;
		},
	},
	'gpt-4o-mini': {
		label: 'GPT-4o-mini',
		network: 'OpenAI',
		tier: 'fast',
		maxOutput: 16384,
		description: 'Fast, affordable GPT. Great for simple tasks.',
		build: () => {
			if (env.OPENAI_API_KEY) return createOpenAI({ apiKey: env.OPENAI_API_KEY })('gpt-4o-mini');
			if (env.OPENROUTER_API_KEY) return openrouter()('openai/gpt-4o-mini');
			return null;
		},
	},
	'o3-mini': {
		label: 'o3-mini',
		network: 'OpenAI',
		tier: 'reasoning',
		maxOutput: 16384,
		description: 'Reasoning-optimized. Fast chain-of-thought.',
		build: () => {
			if (env.OPENAI_API_KEY) return createOpenAI({ apiKey: env.OPENAI_API_KEY })('o3-mini');
			if (env.OPENROUTER_API_KEY) return openrouter()('openai/o3-mini');
			return null;
		},
	},
	'groq-llama': {
		label: 'Llama 3.3 70B',
		network: 'Groq',
		tier: 'fast',
		maxOutput: 8192,
		description: 'Open-weight on Groq. Extremely fast inference.',
		build: () => {
			if (env.GROQ_API_KEY) {
				return createOpenAI({
					apiKey: env.GROQ_API_KEY,
					baseURL: 'https://api.groq.com/openai/v1',
				})('llama-3.3-70b-versatile');
			}
			if (env.OPENROUTER_API_KEY) return openrouter()('meta-llama/llama-3.3-70b-instruct');
			return null;
		},
	},
	'qwen-plus': {
		label: 'Qwen Plus',
		network: 'DashScope',
		tier: 'balanced',
		maxOutput: 8192,
		description: 'Qwen Plus on DashScope. Strong multilingual.',
		build: () => {
			if (env.DASHSCOPE_API_KEY) return createQwen({ apiKey: env.DASHSCOPE_API_KEY })('qwen-plus');
			if (env.OPENROUTER_API_KEY) return openrouter()('qwen/qwen-2.5-72b-instruct');
			return null;
		},
	},
	'modelscope-qwen': {
		label: 'Qwen3-Coder 480B',
		network: 'ModelScope',
		tier: 'flagship',
		maxOutput: 16384,
		description: 'Largest Qwen coder. Exceptional code generation.',
		build: () => {
			if (env.MODELSCOPE_API_KEY) {
				return createOpenAI({
					apiKey: env.MODELSCOPE_API_KEY,
					baseURL: 'https://api-inference.modelscope.cn/v1',
				})('Qwen/Qwen3-Coder-480B-A35B-Instruct');
			}
			if (env.OPENROUTER_API_KEY) return openrouter()('qwen/qwen3-coder');
			return null;
		},
	},
	'deepseek-r1': {
		label: 'DeepSeek R1',
		network: 'DeepSeek',
		tier: 'reasoning',
		maxOutput: 8192,
		description: 'Open reasoning model. Strong at math and code.',
		build: () => {
			if (env.DEEPSEEK_API_KEY) {
				return createOpenAI({
					apiKey: env.DEEPSEEK_API_KEY,
					baseURL: 'https://api.deepseek.com/v1',
				})('deepseek-reasoner');
			}
			if (env.OPENROUTER_API_KEY) return openrouter()('deepseek/deepseek-r1');
			return null;
		},
	},
};

function openrouter() {
	return createOpenAI({
		apiKey: env.OPENROUTER_API_KEY,
		baseURL: 'https://openrouter.ai/api/v1',
		headers: { 'HTTP-Referer': 'https://three.ws', 'X-Title': 'three.ws brain' },
	});
}

function validateMessages(input) {
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

function getAvailableProviders() {
	return Object.entries(PROVIDERS).map(([key, spec]) => {
		const available = Boolean(spec.build());
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

	let body;
	try {
		body = await readJson(req, 200_000);
	} catch (e) {
		return error(res, e.status || 400, 'bad_request', e.message);
	}

	const providerKey = String(body.provider || 'claude-sonnet-4-6');
	const spec = PROVIDERS[providerKey];
	if (!spec) {
		return error(res, 400, 'unknown_provider', `unknown provider: ${providerKey}`, {
			available: Object.keys(PROVIDERS),
		});
	}

	const model = spec.build();
	if (!model) {
		return error(res, 503, 'provider_not_configured',
			`No API key for ${spec.label}. Add your own key in Account → AI Provider Keys to unlock this model.`);
	}

	let messages;
	try {
		messages = validateMessages(body.messages);
	} catch (e) {
		return error(res, e.status || 400, 'bad_request', e.message);
	}

	const system = typeof body.system === 'string' ? body.system.slice(0, 8000) : undefined;
	const maxTokens = Math.min(Math.max(Number(body.maxTokens) || 4096, 64), spec.maxOutput);

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

	let firstTokenMs = null;

	try {
		const result = streamText({
			model,
			system,
			messages,
			maxOutputTokens: maxTokens,
		});

		for await (const delta of result.textStream) {
			if (firstTokenMs === null) {
				firstTokenMs = Date.now() - t0;
				res.write(`event: first\ndata: ${JSON.stringify({ firstTokenMs })}\n\n`);
			}
			res.write(`data: ${JSON.stringify(delta)}\n\n`);
		}

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
	} catch (err) {
		const elapsedMs = Date.now() - t0;
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
});
