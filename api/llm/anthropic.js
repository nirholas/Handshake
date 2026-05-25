// We-pay LLM proxy. The browser always sends an Anthropic-shape body
// ({ system, messages, tools, model, ... }) regardless of the upstream
// model — this file inspects `model` and either forwards to Anthropic
// unchanged, or translates request/response to/from the OpenAI shape
// used by Groq and OpenRouter. Embed-policy origin / quota / rate-limit
// checks run identically for every route.
//
// Why "everything as Anthropic-shape": the browser-side AnthropicProvider
// (src/runtime/providers.js) parses Anthropic SSE events directly. Hiding
// the upstream difference here means free-tier Groq/OpenRouter models work
// in every avatar embed without changing a line of client code.

import { z } from 'zod';
import { Redis } from '@upstash/redis';
import { env } from '../_lib/env.js';
import { cors, error, method, wrap, readJson, json } from '../_lib/http.js';
import { parse } from '../_lib/validate.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { recordEvent, logger } from '../_lib/usage.js';
import { readEmbedPolicy } from '../_lib/embed-policy.js';

const log = logger('llm.anthropic');

// ── Redis client (for monthly quota counters) ────────────────────────────────

let _redis = null;
function getRedis() {
	if (!_redis && env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
		_redis = new Redis({
			url: env.UPSTASH_REDIS_REST_URL,
			token: env.UPSTASH_REDIS_REST_TOKEN,
		});
	}
	return _redis;
}

// ── Model → upstream routing ─────────────────────────────────────────────────
//
// Adding a model: append it here. `kind` decides how the request body and
// response stream are shaped. Groq/OpenRouter both speak OpenAI's wire
// format so they share the 'openai' branch; only the upstream URL and the
// env var differ.

const MODELS = {
	// Anthropic (paid — host's key)
	'claude-opus-4-7':            { kind: 'anthropic', envKey: 'ANTHROPIC_API_KEY' },
	'claude-opus-4-6':            { kind: 'anthropic', envKey: 'ANTHROPIC_API_KEY' },
	'claude-sonnet-4-6':          { kind: 'anthropic', envKey: 'ANTHROPIC_API_KEY' },
	'claude-haiku-4-5-20251001':  { kind: 'anthropic', envKey: 'ANTHROPIC_API_KEY' },

	// OpenRouter free tier (no per-token cost; daily rate cap shared across host).
	// All three are tool-call capable in OpenRouter's catalog.
	'meta-llama/llama-3.3-70b-instruct:free':       { kind: 'openai', provider: 'openrouter', envKey: 'OPENROUTER_API_KEY' },
	'meta-llama/llama-3.1-8b-instruct:free':        { kind: 'openai', provider: 'openrouter', envKey: 'OPENROUTER_API_KEY' },
	'openai/gpt-oss-120b:free':                     { kind: 'openai', provider: 'openrouter', envKey: 'OPENROUTER_API_KEY' },
	'nousresearch/hermes-3-llama-3.1-405b:free':    { kind: 'openai', provider: 'openrouter', envKey: 'OPENROUTER_API_KEY' },

	// Groq free tier (sub-second latency; per-IP+per-key minute caps).
	'llama-3.3-70b-versatile':    { kind: 'openai', provider: 'groq', envKey: 'GROQ_API_KEY' },
	'llama-3.1-8b-instant':       { kind: 'openai', provider: 'groq', envKey: 'GROQ_API_KEY' },
};

const UPSTREAM_URL = {
	anthropic:  'https://api.anthropic.com/v1/messages',
	openrouter: 'https://openrouter.ai/api/v1/chat/completions',
	groq:       'https://api.groq.com/openai/v1/chat/completions',
};

const FIRST_PARTY = ['three.ws', 'localhost'];

const DEFAULT_MONTHLY_TOKEN_BUDGET = 1_000_000;
const CENTS_PER_1K_TOKENS = 1.5;

function tokenBudgetFromPolicy(policy) {
	const cents = policy?.brain?.cost_limit_cents;
	if (typeof cents === 'number' && cents > 0) {
		return Math.floor((cents / CENTS_PER_1K_TOKENS) * 1000);
	}
	return DEFAULT_MONTHLY_TOKEN_BUDGET;
}

function monthKey() {
	const now = new Date();
	return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

function originAllowed(originHeader, policy) {
	if (!originHeader) return true;
	let host;
	try {
		host = new URL(originHeader).hostname.toLowerCase();
	} catch {
		return false;
	}
	if (FIRST_PARTY.some((fp) => host === fp || host.endsWith('.' + fp))) return true;
	const hosts = policy?.origins?.hosts ?? [];
	const mode = policy?.origins?.mode ?? 'allowlist';
	const matches = hosts.some((h) => {
		const lower = h.toLowerCase();
		if (lower.startsWith('*.')) return host.endsWith(lower.slice(1)) && host !== lower.slice(2);
		return host === lower;
	});
	return mode === 'allowlist' ? matches : !matches;
}

function buildCorsAllowlist(policy) {
	const out = new Set();
	if (env.APP_ORIGIN) out.add(env.APP_ORIGIN);
	try {
		if (env.ISSUER) out.add(env.ISSUER);
	} catch {
		// ISSUER derives from APP_ORIGIN; ignore if unset.
	}
	const hosts = policy?.origins?.hosts ?? [];
	for (const h of hosts) {
		const lower = String(h).toLowerCase();
		if (lower.startsWith('*.')) {
			const base = lower.slice(2).replace(/[.+?^${}()|[\]\\]/g, '\\$&');
			out.add(new RegExp(`^https?://([a-z0-9-]+\\.)+${base}$`));
		} else {
			out.add(`https://${lower}`);
			out.add(`http://${lower}`);
		}
	}
	if (process.env.NODE_ENV !== 'production') {
		out.add(/^https?:\/\/localhost(:\d+)?$/);
	}
	return Array.from(out);
}

async function incrementMonthlyQuota(agentId) {
	const r = getRedis();
	if (!r) return 0;
	const key = `llm:quota:${agentId}:${monthKey()}`;
	const count = await r.incr(key);
	if (count === 1) await r.expire(key, 40 * 24 * 3600);
	return count;
}

async function getMonthlyTokens(agentId) {
	const r = getRedis();
	if (!r) return 0;
	const key = `llm:tokens:${agentId}:${monthKey()}`;
	const v = await r.get(key);
	return typeof v === 'number' ? v : parseInt(v || '0', 10) || 0;
}

async function addMonthlyTokens(agentId, delta) {
	const r = getRedis();
	if (!r || !delta) return 0;
	const key = `llm:tokens:${agentId}:${monthKey()}`;
	const total = await r.incrby(key, delta);
	if (total === delta) await r.expire(key, 40 * 24 * 3600);
	return total;
}

// ── Request schema ────────────────────────────────────────────────────────────

const messageContentSchema = z.union([z.string(), z.array(z.any())]);

const bodySchema = z.object({
	system: z.string().max(64_000).optional(),
	messages: z
		.array(
			z.object({
				role: z.enum(['user', 'assistant']),
				content: messageContentSchema,
			}),
		)
		.min(1)
		.max(200),
	tools: z.array(z.any()).max(64).optional(),
	model: z.string().max(100).optional(),
	max_tokens: z.number().int().positive().max(16_000).optional(),
	temperature: z.number().min(0).max(2).optional(),
	thinking: z.any().optional(),
	stream: z.boolean().optional(),
});

// ── Handler ───────────────────────────────────────────────────────────────────

export default wrap(async (req, res) => {
	const url = new URL(req.url, 'http://x');
	const agentId = url.searchParams.get('agent');

	let policy = null;
	if (agentId) policy = await readEmbedPolicy(agentId);

	const corsOrigins = buildCorsAllowlist(policy);
	if (cors(req, res, { origins: corsOrigins, methods: 'POST,OPTIONS' })) return;
	if (!method(req, res, ['POST'])) return;

	if (!agentId) return error(res, 400, 'validation_error', 'agent query param required');
	if (!policy) return error(res, 404, 'not_found', 'agent not found');

	if (policy.brain?.mode !== 'we-pay') {
		return error(
			res,
			402,
			'payment_required',
			`brain.mode is "${policy.brain?.mode ?? 'unset'}"; caller must supply its own key or proxy`,
		);
	}

	if (policy.surfaces?.script === false) {
		return error(res, 403, 'embed_denied_surface', 'script surface disabled for this agent');
	}

	const originHeader = req.headers.origin || req.headers.referer || '';
	if (!originAllowed(originHeader, policy)) {
		return error(res, 403, 'embed_denied_origin', "origin not permitted by this agent's embed policy");
	}

	const ipRl = await limits.embedLlmIp(clientIp(req));
	if (!ipRl.success) return error(res, 429, 'rate_limited', 'too many requests from this IP');

	const perMin = policy.brain?.rate_limit_per_min;
	if (perMin && perMin > 0) {
		const agentRl = await limits.embedLlmAgent(agentId, perMin);
		if (!agentRl.success) return error(res, 429, 'rate_limited', 'agent rate limit exceeded');
	}

	const quota = policy.brain?.monthly_quota;
	if (typeof quota === 'number' && quota !== null) {
		const used = await incrementMonthlyQuota(agentId);
		if (used > quota) {
			return error(res, 429, 'quota_exceeded', `monthly quota of ${quota} calls reached`);
		}
	}

	const tokenBudget = tokenBudgetFromPolicy(policy);
	const tokensUsedSoFar = await getMonthlyTokens(agentId);
	if (tokensUsedSoFar >= tokenBudget) {
		return error(res, 429, 'quota_exceeded', `monthly token budget of ${tokenBudget} reached`);
	}

	const rawBody = await readJson(req);
	const body = parse(bodySchema, rawBody);
	const requestedModel = body.model || policy.brain?.model || 'meta-llama/llama-3.3-70b-instruct:free';

	// Ordered fallback chain for 429 / 5xx from OpenRouter free tier:
	//   1. Requested model (e.g. llama-3.3-70b:free)
	//   2. meta-llama/llama-3.1-8b-instruct:free  (smaller free model)
	//   3. claude-haiku-4-5-20251001              (paid Anthropic — last resort)
	const modelFallbacks = [
		requestedModel,
		...([
			'meta-llama/llama-3.1-8b-instruct:free',
			'claude-haiku-4-5-20251001',
		].filter((m) => m !== requestedModel)),
	];

	const isStreaming = body.stream === true;
	const t0 = Date.now();

	let upstream;
	let usedModel = requestedModel;
	let usedRoute = null;

	for (let attempt = 0; attempt < modelFallbacks.length; attempt++) {
		usedModel = modelFallbacks[attempt];
		const route = MODELS[usedModel];
		if (!route) {
			if (attempt === 0) {
				return error(res, 400, 'validation_error', `model "${usedModel}" not in allowlist`);
			}
			continue;
		}

		const apiKey = process.env[route.envKey];
		if (!apiKey) {
			if (attempt === 0) {
				return error(res, 503, 'provider_unavailable', `${route.envKey} not configured on host`);
			}
			continue;
		}

		usedRoute = route;
		const upstreamUrl = route.kind === 'anthropic' ? UPSTREAM_URL.anthropic : UPSTREAM_URL[route.provider];
		const upstreamHeaders =
			route.kind === 'anthropic'
				? {
						'content-type': 'application/json',
						'anthropic-version': '2023-06-01',
						'x-api-key': apiKey,
				  }
				: {
						'content-type': 'application/json',
						authorization: `Bearer ${apiKey}`,
						...(route.provider === 'openrouter'
							? { 'HTTP-Referer': 'https://three.ws', 'X-Title': 'three.ws agent' }
							: {}),
				  };
		const upstreamBody =
			route.kind === 'anthropic'
				? JSON.stringify({ ...body, model: usedModel })
				: JSON.stringify(anthropicBodyToOpenAI({ ...body, model: usedModel }));

		upstream = await fetch(upstreamUrl, {
			method: 'POST',
			headers: upstreamHeaders,
			body: upstreamBody,
		});

		if (upstream.status === 429 || upstream.status >= 500) {
			const errText = await upstream.text().catch(() => '');
			const provider = route.provider || 'anthropic';
			log.warn('upstream_rate_limited', {
				agentId,
				model: usedModel,
				provider,
				status: upstream.status,
				attempt,
				body: errText.slice(0, 400),
			});
			if (attempt + 1 < modelFallbacks.length) {
				console.warn(
					`[llm/anthropic] ${provider}/${usedModel} returned ${upstream.status} — ` +
					`falling back to ${modelFallbacks[attempt + 1]}`,
				);
				continue;
			}
			// All fallbacks exhausted — surface error.
			log.error('upstream_error', {
				agentId,
				model: usedModel,
				kind: route.kind,
				provider,
				status: upstream.status,
				body: errText.slice(0, 2000),
			});
			return json(res, 502, { error: 'upstream_error', status: upstream.status });
		}

		if (upstream.status >= 400) {
			const errText = await upstream.text().catch(() => '');
			log.error('upstream_error', {
				agentId,
				model: usedModel,
				kind: route.kind,
				provider: route.provider || 'anthropic',
				status: upstream.status,
				body: errText.slice(0, 2000),
			});
			return json(res, 502, { error: 'upstream_error', status: upstream.status });
		}

		// Success — log the model used if it differed from the requested one.
		if (usedModel !== requestedModel) {
			console.info(
				`[llm/anthropic] agentId=${agentId} used fallback model ${usedModel} ` +
				`(requested: ${requestedModel})`,
			);
		}
		break;
	}

	if (!usedRoute || !upstream) {
		return json(res, 503, { error: 'provider_unavailable', message: 'no configured fallback model is available' });
	}

	const route = usedRoute;

	// ── Streaming path ────────────────────────────────────────────────────────
	if (isStreaming) {
		res.statusCode = 200;
		res.setHeader('content-type', 'text/event-stream');
		res.setHeader('cache-control', 'no-cache');
		res.setHeader('x-accel-buffering', 'no');

		let inputTokens = 0;
		let outputTokens = 0;

		if (route.kind === 'anthropic') {
			// Pass upstream Anthropic SSE through verbatim; sniff usage events
			// for token accounting.
			const reader = upstream.body.getReader();
			const decoder = new TextDecoder();
			let sseBuffer = '';
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					res.write(value);
					sseBuffer += decoder.decode(value, { stream: true });
					const lines = sseBuffer.split('\n');
					sseBuffer = lines.pop();
					for (const line of lines) {
						if (!line.startsWith('data: ')) continue;
						try {
							const ev = JSON.parse(line.slice(6));
							if (ev.type === 'message_start') inputTokens = ev.message?.usage?.input_tokens ?? 0;
							if (ev.type === 'message_delta') outputTokens = ev.usage?.output_tokens ?? 0;
						} catch {
							// not every data line is JSON (e.g. [DONE]) — skip
						}
					}
				}
			} finally {
				res.end();
			}
		} else {
			// OpenAI-shape upstream → translate to Anthropic SSE shape on the fly.
			const usage = await pipeOpenAIAsAnthropic(upstream, res, { model: usedModel });
			inputTokens = usage.inputTokens;
			outputTokens = usage.outputTokens;
		}

		const latencyMs = Date.now() - t0;
		if (inputTokens || outputTokens) {
			try {
				await addMonthlyTokens(agentId, inputTokens + outputTokens);
			} catch (err) {
				log.warn('token_counter_write_failed', { agentId, msg: err?.message });
			}
		}
		recordEvent({
			kind: 'llm',
			tool: route.kind === 'anthropic' ? 'anthropic.messages' : `${route.provider}.chat`,
			agentId,
			bytes: 0,
			latencyMs,
			status: 'ok',
			meta: { model: usedModel, requested_model: requestedModel, input_tokens: inputTokens, output_tokens: outputTokens, upstream_status: upstream.status },
		});
		return;
	}

	// ── Non-streaming path ────────────────────────────────────────────────────
	const upstreamText = await upstream.text();
	const latencyMs = Date.now() - t0;

	let upstreamJson = null;
	try {
		upstreamJson = JSON.parse(upstreamText);
	} catch {
		// Non-JSON body — leave as opaque pass-through.
	}

	let inputTokens = 0;
	let outputTokens = 0;
	let outBody = upstreamText;
	let outContentType = upstream.headers.get('content-type') || 'application/json';

	if (route.kind === 'anthropic') {
		inputTokens = upstreamJson?.usage?.input_tokens ?? 0;
		outputTokens = upstreamJson?.usage?.output_tokens ?? 0;
	} else if (upstreamJson) {
		inputTokens = upstreamJson?.usage?.prompt_tokens ?? 0;
		outputTokens = upstreamJson?.usage?.completion_tokens ?? 0;
		const translated = openAIResponseToAnthropic(upstreamJson, { model: usedModel });
		outBody = JSON.stringify(translated);
		outContentType = 'application/json';
	}

	if (inputTokens || outputTokens) {
		try {
			await addMonthlyTokens(agentId, inputTokens + outputTokens);
		} catch (err) {
			log.warn('token_counter_write_failed', { agentId, msg: err?.message });
		}
	}

	recordEvent({
		kind: 'llm',
		tool: route.kind === 'anthropic' ? 'anthropic.messages' : `${route.provider}.chat`,
		agentId,
		bytes: upstreamText.length,
		latencyMs,
		status: 'ok',
		meta: { model: usedModel, requested_model: requestedModel, input_tokens: inputTokens, output_tokens: outputTokens, upstream_status: upstream.status },
	});

	res.statusCode = 200;
	res.setHeader('content-type', outContentType);
	return res.end(outBody);
});

// ── Shape translation: Anthropic ⇄ OpenAI ────────────────────────────────────

function anthropicBodyToOpenAI(body) {
	const messages = [];
	if (body.system) messages.push({ role: 'system', content: body.system });

	for (const m of body.messages) {
		if (typeof m.content === 'string') {
			messages.push({ role: m.role, content: m.content });
			continue;
		}
		if (!Array.isArray(m.content)) continue;

		if (m.role === 'user') {
			const textParts = [];
			for (const block of m.content) {
				if (block?.type === 'text' && typeof block.text === 'string') {
					textParts.push(block.text);
				} else if (block?.type === 'tool_result') {
					messages.push({
						role: 'tool',
						tool_call_id: block.tool_use_id,
						content:
							typeof block.content === 'string'
								? block.content
								: JSON.stringify(block.content ?? ''),
					});
				}
			}
			if (textParts.length) messages.push({ role: 'user', content: textParts.join('\n') });
		} else if (m.role === 'assistant') {
			const textParts = [];
			const toolCalls = [];
			for (const block of m.content) {
				if (block?.type === 'text' && typeof block.text === 'string') {
					textParts.push(block.text);
				} else if (block?.type === 'tool_use') {
					toolCalls.push({
						id: block.id,
						type: 'function',
						function: {
							name: block.name,
							arguments: JSON.stringify(block.input ?? {}),
						},
					});
				}
			}
			const msg = { role: 'assistant', content: textParts.join('\n') || null };
			if (toolCalls.length) msg.tool_calls = toolCalls;
			messages.push(msg);
		}
	}

	const out = {
		model: body.model,
		max_tokens: body.max_tokens ?? 4096,
		messages,
		stream: !!body.stream,
	};
	if (typeof body.temperature === 'number') out.temperature = body.temperature;

	if (Array.isArray(body.tools) && body.tools.length) {
		out.tools = body.tools.map((t) => ({
			type: 'function',
			function: {
				name: t.name,
				description: t.description,
				parameters: t.input_schema,
			},
		}));
		out.tool_choice = 'auto';
	}
	return out;
}

function openAIResponseToAnthropic(resp, { model }) {
	const choice = resp?.choices?.[0];
	const msg = choice?.message || {};
	const content = [];
	if (typeof msg.content === 'string' && msg.content.length) {
		content.push({ type: 'text', text: msg.content });
	}
	for (const tc of msg.tool_calls || []) {
		let input = {};
		try {
			input = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {};
		} catch {
			input = {};
		}
		content.push({ type: 'tool_use', id: tc.id, name: tc.function?.name, input });
	}
	return {
		id: resp.id || `msg_${Date.now()}`,
		type: 'message',
		role: 'assistant',
		model,
		content,
		stop_reason: choice?.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn',
		stop_sequence: null,
		usage: {
			input_tokens: resp?.usage?.prompt_tokens ?? 0,
			output_tokens: resp?.usage?.completion_tokens ?? 0,
		},
	};
}

// Stream an OpenAI-shape SSE upstream into the client as Anthropic-shape SSE.
// Returns { inputTokens, outputTokens } extracted from the final usage event.
async function pipeOpenAIAsAnthropic(upstream, res, { model }) {
	const reader = upstream.body.getReader();
	const decoder = new TextDecoder();
	let buf = '';

	let inputTokens = 0;
	let outputTokens = 0;

	const messageId = `msg_${Date.now()}`;
	let messageStartSent = false;
	let textBlockOpen = false;
	let textIndex = 0;
	// Map OpenAI tool-call index → { anthropicIndex, started, finished, name, id, argsBuf }
	const toolBlocks = new Map();
	let nextBlockIndex = 1; // index 0 reserved for the text block
	let stopReason = 'end_turn';

	function write(obj, eventName) {
		const evt = eventName ? `event: ${eventName}\n` : '';
		res.write(`${evt}data: ${JSON.stringify(obj)}\n\n`);
	}

	function ensureMessageStart() {
		if (messageStartSent) return;
		messageStartSent = true;
		write(
			{
				type: 'message_start',
				message: {
					id: messageId,
					type: 'message',
					role: 'assistant',
					content: [],
					model,
					stop_reason: null,
					stop_sequence: null,
					usage: { input_tokens: 0, output_tokens: 0 },
				},
			},
			'message_start',
		);
	}

	function ensureTextBlockStart() {
		ensureMessageStart();
		if (textBlockOpen) return;
		textBlockOpen = true;
		textIndex = 0;
		write(
			{
				type: 'content_block_start',
				index: textIndex,
				content_block: { type: 'text', text: '' },
			},
			'content_block_start',
		);
	}

	function closeTextBlockIfOpen() {
		if (!textBlockOpen) return;
		write({ type: 'content_block_stop', index: textIndex }, 'content_block_stop');
		textBlockOpen = false;
	}

	function startToolBlock(slot, openAIToolCall) {
		ensureMessageStart();
		closeTextBlockIfOpen();
		slot.anthropicIndex = nextBlockIndex++;
		slot.started = true;
		slot.id = openAIToolCall.id || `tool_${slot.anthropicIndex}`;
		slot.name = openAIToolCall.function?.name || slot.name || '';
		write(
			{
				type: 'content_block_start',
				index: slot.anthropicIndex,
				content_block: { type: 'tool_use', id: slot.id, name: slot.name, input: {} },
			},
			'content_block_start',
		);
	}

	function finishToolBlocks() {
		for (const slot of toolBlocks.values()) {
			if (slot.started && !slot.finished) {
				write({ type: 'content_block_stop', index: slot.anthropicIndex }, 'content_block_stop');
				slot.finished = true;
			}
		}
	}

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buf += decoder.decode(value, { stream: true });
			const lines = buf.split('\n');
			buf = lines.pop();
			for (const rawLine of lines) {
				const line = rawLine.trim();
				if (!line.startsWith('data:')) continue;
				const payload = line.slice(5).trim();
				if (!payload || payload === '[DONE]') continue;
				let ev;
				try {
					ev = JSON.parse(payload);
				} catch {
					continue;
				}

				if (ev.usage) {
					inputTokens = ev.usage.prompt_tokens ?? inputTokens;
					outputTokens = ev.usage.completion_tokens ?? outputTokens;
				}

				const choice = ev.choices?.[0];
				const delta = choice?.delta;

				if (delta?.content) {
					ensureTextBlockStart();
					write(
						{
							type: 'content_block_delta',
							index: textIndex,
							delta: { type: 'text_delta', text: delta.content },
						},
						'content_block_delta',
					);
				}

				if (Array.isArray(delta?.tool_calls)) {
					for (const tc of delta.tool_calls) {
						const idx = tc.index ?? 0;
						let slot = toolBlocks.get(idx);
						if (!slot) {
							slot = { started: false, finished: false, name: '', id: null, argsBuf: '' };
							toolBlocks.set(idx, slot);
						}
						if (!slot.started && (tc.id || tc.function?.name)) {
							startToolBlock(slot, tc);
						} else if (tc.function?.name && !slot.started) {
							slot.name += tc.function.name;
						}
						if (tc.function?.arguments) {
							slot.argsBuf += tc.function.arguments;
							if (slot.started) {
								write(
									{
										type: 'content_block_delta',
										index: slot.anthropicIndex,
										delta: { type: 'input_json_delta', partial_json: tc.function.arguments },
									},
									'content_block_delta',
								);
							}
						}
					}
				}

				if (choice?.finish_reason) {
					stopReason = choice.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn';
				}
			}
		}
	} finally {
		closeTextBlockIfOpen();
		finishToolBlocks();
		if (messageStartSent) {
			write(
				{
					type: 'message_delta',
					delta: { stop_reason: stopReason, stop_sequence: null },
					usage: { output_tokens: outputTokens },
				},
				'message_delta',
			);
			write({ type: 'message_stop' }, 'message_stop');
		}
		res.end();
	}

	return { inputTokens, outputTokens };
}
