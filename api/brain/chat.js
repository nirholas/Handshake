// POST /api/brain/chat — Multi-LLM provider proxy for the /brain page.
//
// Body: { provider, messages, system?, maxTokens? }
// Response: SSE stream:
//   event: meta    → { provider, label, network, model }
//   event: first   → { firstTokenMs }   (time to first token)
//   (data-only)    → JSON-encoded text chunk
//   event: done    → { elapsedMs, firstTokenMs, usage }
//   event: error   → { message, elapsedMs }

import { streamText } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createQwen } from 'qwen-ai-provider';
import { env } from '../_lib/env.js';
import { cors, method, readJson, error, wrap } from '../_lib/http.js';

export const maxDuration = 60;

const PROVIDERS = {
	'claude-opus-4-7': {
		label: 'Claude Opus 4.7',
		network: 'Anthropic',
		tier: 'flagship',
		description: 'Most capable. Extended thinking, complex reasoning.',
		build: () => {
			const key = env.ANTHROPIC_API_KEY;
			if (!key) return null;
			return createAnthropic({ apiKey: key })('claude-opus-4-7');
		},
	},
	'claude-sonnet-4-6': {
		label: 'Claude Sonnet 4.6',
		network: 'Anthropic',
		tier: 'balanced',
		description: 'Balanced speed and intelligence. Best for most tasks.',
		build: () => {
			const key = env.ANTHROPIC_API_KEY;
			if (!key) return null;
			return createAnthropic({ apiKey: key })('claude-sonnet-4-6');
		},
	},
	'claude-haiku-4-5': {
		label: 'Claude Haiku 4.5',
		network: 'Anthropic',
		tier: 'fast',
		description: 'Fastest Claude. Low latency, high throughput.',
		build: () => {
			const key = env.ANTHROPIC_API_KEY;
			if (!key) return null;
			return createAnthropic({ apiKey: key })('claude-haiku-4-5-20251001');
		},
	},
	'gpt-4o': {
		label: 'GPT-4o',
		network: 'OpenAI',
		tier: 'flagship',
		description: 'OpenAI flagship. Strong multimodal reasoning.',
		build: () => {
			const key = env.OPENAI_API_KEY;
			if (!key) return null;
			return createOpenAI({ apiKey: key })('gpt-4o');
		},
	},
	'gpt-4o-mini': {
		label: 'GPT-4o-mini',
		network: 'OpenAI',
		tier: 'fast',
		description: 'Fast, affordable GPT. Great for simple tasks.',
		build: () => {
			const key = env.OPENAI_API_KEY;
			if (!key) return null;
			return createOpenAI({ apiKey: key })('gpt-4o-mini');
		},
	},
	'groq-llama': {
		label: 'Llama 3.3 70B',
		network: 'Groq',
		tier: 'fast',
		description: 'Open-weight model on Groq. Extremely fast inference.',
		build: () => {
			const key = env.GROQ_API_KEY;
			if (!key) return null;
			return createOpenAI({
				apiKey: key,
				baseURL: 'https://api.groq.com/openai/v1',
			})('llama-3.3-70b-versatile');
		},
	},
	'qwen-plus': {
		label: 'Qwen Plus',
		network: 'Alibaba DashScope',
		tier: 'balanced',
		description: 'Qwen Plus on Alibaba DashScope. Strong multilingual.',
		build: () => {
			if (env.DASHSCOPE_API_KEY) {
				return createQwen({ apiKey: env.DASHSCOPE_API_KEY })('qwen-plus');
			}
			if (env.OPENROUTER_API_KEY) {
				return openrouter()('qwen/qwen-2.5-72b-instruct');
			}
			return null;
		},
	},
	'modelscope-qwen': {
		label: 'Qwen3-Coder-480B',
		network: 'ModelScope',
		tier: 'flagship',
		description: 'Largest Qwen coder model. Exceptional at code generation.',
		build: () => {
			if (env.MODELSCOPE_API_KEY) {
				return createOpenAI({
					apiKey: env.MODELSCOPE_API_KEY,
					baseURL: 'https://api-inference.modelscope.cn/v1',
				})('Qwen/Qwen3-Coder-480B-A35B-Instruct');
			}
			if (env.OPENROUTER_API_KEY) {
				return openrouter()('qwen/qwen3-coder');
			}
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
	if (input.length === 0 || input.length > 60) {
		throw Object.assign(new Error('messages length out of range'), { status: 400 });
	}
	const out = [];
	for (const m of input) {
		if (!m || typeof m !== 'object') throw Object.assign(new Error('bad message'), { status: 400 });
		const role = m.role;
		const content = typeof m.content === 'string' ? m.content.slice(0, 8000) : '';
		if (!['user', 'assistant'].includes(role)) {
			throw Object.assign(new Error('role must be user|assistant'), { status: 400 });
		}
		if (!content.trim()) throw Object.assign(new Error('empty content'), { status: 400 });
		out.push({ role, content });
	}
	return out;
}

export default wrap(async function handler(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS' })) return;
	if (method(req, res, ['POST'])) return;

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
			`${spec.network} key not configured on this deployment`);
	}

	let messages;
	try {
		messages = validateMessages(body.messages);
	} catch (e) {
		return error(res, e.status || 400, 'bad_request', e.message);
	}

	const system = typeof body.system === 'string' ? body.system.slice(0, 4000) : undefined;
	const maxTokens = Math.min(Math.max(Number(body.maxTokens) || 1024, 32), 4096);

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
		res.write(`event: error\ndata: ${JSON.stringify({
			message: err?.message || 'upstream error',
			elapsedMs,
		})}\n\n`);
		res.end();
	}
});
