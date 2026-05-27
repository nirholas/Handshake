// POST /api/chat — AI-powered chat for the three.ws viewer agent.
//
// Body: { message, context, history, agentId?, provider?, model? }
// Response: SSE stream { type: 'chunk' | 'done' | 'error' }.
//
// Provider routing (in order):
//   1. Body.provider when present and the matching key is configured.
//   2. ANTHROPIC_API_KEY → Anthropic (default).
//   3. OPENROUTER_API_KEY → OpenRouter free tier.
//   4. GROQ_API_KEY → Groq.
//   5. OPENAI_API_KEY → OpenAI.
// Anthropic and the OpenAI-compatible providers (OpenRouter / Groq / OpenAI)
// use different request shapes, tool-call wire formats, and SSE event names —
// this file translates both directions so the client only sees the same
// { chunk → done } event stream regardless of upstream.

import { getSessionUser, authenticateBearer, extractBearer } from './_lib/auth.js';
import { cors, json, method, readJson, wrap, error } from './_lib/http.js';
import { parse } from './_lib/validate.js';
import { recordEvent } from './_lib/usage.js';
import { captureException } from './_lib/sentry.js';
import { sql } from './_lib/db.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import { loadUserProviderKeys } from './_lib/provider-keys.js';
import { z } from 'zod';

// Providers anonymous (unauthenticated) callers may use. Groq's free tier is
// the only one we expose without sign-in — paid keys stay gated behind auth.
const ANON_PROVIDERS = new Set(['groq']);

export const maxDuration = 60;

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-6';
const DEFAULT_OPENROUTER_MODEL = 'meta-llama/llama-3.3-70b-instruct:free';
const DEFAULT_GROQ_MODEL = 'llama-3.3-70b-versatile';
const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';
const DEFAULT_MAX_TOKENS = 1024;
const HARD_MAX_TOKENS = 4096;

const PROVIDERS = {
	anthropic: {
		envKey: 'ANTHROPIC_API_KEY',
		defaultModel: DEFAULT_ANTHROPIC_MODEL,
		url: ANTHROPIC_URL,
		style: 'anthropic',
	},
	openrouter: {
		envKey: 'OPENROUTER_API_KEY',
		defaultModel: DEFAULT_OPENROUTER_MODEL,
		url: 'https://openrouter.ai/api/v1/chat/completions',
		style: 'openai',
		extraHeaders: { 'HTTP-Referer': 'https://three.ws', 'X-Title': 'three.ws agent' },
	},
	groq: {
		envKey: 'GROQ_API_KEY',
		defaultModel: DEFAULT_GROQ_MODEL,
		url: 'https://api.groq.com/openai/v1/chat/completions',
		style: 'openai',
	},
	openai: {
		envKey: 'OPENAI_API_KEY',
		defaultModel: DEFAULT_OPENAI_MODEL,
		url: 'https://api.openai.com/v1/chat/completions',
		style: 'openai',
	},
};

const contextSchema = z
	.object({
		modelName: z.string().max(200).optional(),
		vertices: z.number().int().nonnegative().optional(),
		triangles: z.number().int().nonnegative().optional(),
		materials: z.number().int().nonnegative().optional(),
		animations: z.number().int().nonnegative().optional(),
		validationErrors: z.number().int().nonnegative().optional(),
		validationWarnings: z.number().int().nonnegative().optional(),
		currentEnvironment: z.string().max(80).optional(),
		wireframe: z.boolean().optional(),
		skeleton: z.boolean().optional(),
		grid: z.boolean().optional(),
		autoRotate: z.boolean().optional(),
		transparentBg: z.boolean().optional(),
		bgColor: z.string().max(20).optional(),
	})
	.partial()
	.default({});

const chatBody = z.object({
	message: z.string().trim().min(1).max(4000),
	context: contextSchema,
	system_prompt: z.string().trim().min(1).max(2000).optional(),
	agentId: z.string().uuid().optional(),
	provider: z.enum(['anthropic', 'openrouter', 'groq', 'openai']).optional(),
	model: z.string().min(1).max(120).optional(),
	history: z
		.array(
			z.object({
				role: z.enum(['user', 'assistant']),
				content: z.string().min(1).max(4000),
			}),
		)
		.max(20)
		.default([]),
});

// Tool definitions in Anthropic shape; converted to OpenAI shape on demand.
const ACTION_TOOLS = [
	{
		name: 'setWireframe',
		description: 'Toggle wireframe mode on the currently loaded model.',
		input_schema: {
			type: 'object',
			properties: { value: { type: 'boolean' } },
			required: ['value'],
		},
	},
	{
		name: 'setSkeleton',
		description: 'Toggle the skeleton helper visualization for rigged models.',
		input_schema: {
			type: 'object',
			properties: { value: { type: 'boolean' } },
			required: ['value'],
		},
	},
	{
		name: 'setGrid',
		description: 'Toggle the reference grid and axes helper.',
		input_schema: {
			type: 'object',
			properties: { value: { type: 'boolean' } },
			required: ['value'],
		},
	},
	{
		name: 'setAutoRotate',
		description: 'Toggle auto-rotation of the camera around the model.',
		input_schema: {
			type: 'object',
			properties: { value: { type: 'boolean' } },
			required: ['value'],
		},
	},
	{
		name: 'setBgColor',
		description: 'Set the viewer background color. Accepts a CSS hex like "#001133".',
		input_schema: {
			type: 'object',
			properties: { value: { type: 'string', pattern: '^#[0-9a-fA-F]{3,8}$' } },
			required: ['value'],
		},
	},
	{
		name: 'setTransparentBg',
		description: 'Toggle transparent background (for compositing screenshots).',
		input_schema: {
			type: 'object',
			properties: { value: { type: 'boolean' } },
			required: ['value'],
		},
	},
	{
		name: 'setEnvironment',
		description:
			'Change the HDRI lighting environment. Known names: "None", "Neutral", "Venice Sunset", "Footprint Court (HDR Labs)".',
		input_schema: {
			type: 'object',
			properties: { value: { type: 'string' } },
			required: ['value'],
		},
	},
	{
		name: 'takeScreenshot',
		description: 'Capture a PNG screenshot of the current viewport.',
		input_schema: { type: 'object', properties: {} },
	},
	{
		name: 'loadModel',
		description: 'Load a glTF or GLB model by URL.',
		input_schema: {
			type: 'object',
			properties: { url: { type: 'string', format: 'uri' } },
			required: ['url'],
		},
	},
	{
		name: 'runValidation',
		description:
			'Run glTF validation on the currently loaded model and report errors/warnings.',
		input_schema: { type: 'object', properties: {} },
	},
	{
		name: 'showMaterialEditor',
		description: 'Open the material editor panel in the viewer UI.',
		input_schema: { type: 'object', properties: {} },
	},
	{
		name: 'setCameraTarget',
		description: 'Set the camera target to a specific named bone on the currently loaded model.',
		input_schema: {
			type: 'object',
			properties: {
				boneName: {
					type: 'string',
					description: 'The name of the bone to target, e.g. "head", "leftHand"',
				},
			},
			required: ['boneName'],
		},
	},
	{
		name: 'getPumpFunTrades',
		description: 'Get the latest trades from pump.fun and show them in the 3D scene.',
		input_schema: { type: 'object', properties: {} },
	},
];

const ACTION_NAMES = new Set(ACTION_TOOLS.map((t) => t.name));

const OPENAI_TOOLS = ACTION_TOOLS.map((t) => ({
	type: 'function',
	function: {
		name: t.name,
		description: t.description,
		parameters: t.input_schema,
	},
}));

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const auth = await resolveAuth(req);
	const body = parse(chatBody, await readJson(req));

	// Anonymous callers are restricted to Groq's free tier (no other provider
	// keys are exposed without auth). Force-pin the provider and rate-limit by
	// IP so abuse can't burn the host's quota.
	let anonymous = false;
	if (!auth) {
		const ip = clientIp(req);
		const rl = await limits.chatIp(ip);
		if (!rl.success) {
			return error(res, 429, 'rate_limited', 'too many anonymous chat requests, try again shortly');
		}
		if (!process.env.GROQ_API_KEY) {
			return error(res, 401, 'unauthorized', 'sign in to chat with the agent');
		}
		if (body.provider && !ANON_PROVIDERS.has(body.provider)) {
			return error(res, 401, 'unauthorized', 'sign in to use this model');
		}
		body.provider = 'groq';
		anonymous = true;
	}

	let userProviderKeys = {};
	if (auth?.userId) {
		const [urow] = await sql`SELECT provider_keys FROM users WHERE id = ${auth.userId}`;
		userProviderKeys = await loadUserProviderKeys(urow?.provider_keys);
	}

	let route = pickProvider(body.provider, body.model, userProviderKeys);
	if (!route) {
		return error(res, 503, 'chat_unavailable', 'no chat provider is configured');
	}
	if (anonymous && route.name !== 'groq') {
		return error(res, 401, 'unauthorized', 'sign in to chat with the agent');
	}

	const maxTokens = clampInt(
		parseInt(process.env.CHAT_MAX_TOKENS || '', 10) || DEFAULT_MAX_TOKENS,
		128,
		HARD_MAX_TOKENS,
	);

	let personaPrompt = null;
	if (body.agentId) {
		const [agentRow] = await sql`
			SELECT persona_prompt FROM agent_identities
			WHERE id = ${body.agentId} AND deleted_at IS NULL LIMIT 1
		`;
		if (agentRow?.persona_prompt) personaPrompt = agentRow.persona_prompt;
	}
	if (!personaPrompt && body.system_prompt) personaPrompt = body.system_prompt;

	const systemPrompt = buildSystemPrompt(body.context, personaPrompt);
	const history = body.history.map((m) => ({ role: m.role, content: m.content }));
	history.push({ role: 'user', content: body.message });

	const started = Date.now();
	// Provider/model failover chain. The first entry is the picked route; if it
	// returns 429 (rate-limit) or 5xx (provider down) we cycle through a
	// pre-built fallback list before surfacing an error.
	const fallbackRoutes = buildFallbackChain(route, userProviderKeys);

	let upstream;
	let routeIdx = 0;
	while (true) {
		try {
			upstream = await fetch(route.url, {
				method: 'POST',
				headers: route.headers,
				body: JSON.stringify(route.buildPayload({ systemPrompt, history, maxTokens })),
			});
		} catch (err) {
			captureException(err, { route: 'chat', stage: 'fetch', provider: route.name });
			console.error(`[chat:${route.name}] upstream fetch failed:`, err.message);
			// Network blip — try next route if available.
			routeIdx++;
			if (routeIdx < fallbackRoutes.length) {
				route = fallbackRoutes[routeIdx];
				continue;
			}
			return error(res, 502, 'upstream_unavailable', 'chat backend unreachable');
		}

		// Fall over on rate-limit (429) and transient gateway errors (502/503/504).
		// Don't re-fetch on 4xx other than 429 — those are caller mistakes that
		// the next provider would also reject.
		if ((upstream.status === 429 || upstream.status >= 500) && routeIdx + 1 < fallbackRoutes.length) {
			const text = await upstream.text().catch(() => '');
			console.warn(`[chat:${route.name}] ${upstream.status} — falling over to ${fallbackRoutes[routeIdx + 1].name}/${fallbackRoutes[routeIdx + 1].model}: ${text.slice(0, 120)}`);
			routeIdx++;
			route = fallbackRoutes[routeIdx];
			continue;
		}
		break;
	}

	if (!upstream.ok) {
		const text = await upstream.text().catch(() => '');
		captureException(new Error(`${route.name} upstream ${upstream.status}`), {
			route: 'chat',
			provider: route.name,
			status: upstream.status,
			body: text.slice(0, 400),
		});
		// Always log — diagnosing prod 502s without provider context is hopeless.
		console.error(`[chat:${route.name}]`, upstream.status, text.slice(0, 400));
		// Surface the upstream reason in the response body. Strip any API-key
		// fragments out of defence; the body is generally short JSON like
		// {"error":{"type":"invalid_request_error","message":"..."}}.
		let upstreamMessage = '';
		try {
			const parsed = JSON.parse(text);
			upstreamMessage = parsed?.error?.message || parsed?.message || '';
		} catch {
			upstreamMessage = text.slice(0, 200);
		}
		return error(
			res,
			502,
			'upstream_error',
			`${route.name} returned ${upstream.status}${upstreamMessage ? `: ${upstreamMessage}` : ''}`,
		);
	}

	res.writeHead(200, {
		'Content-Type': 'text/event-stream; charset=utf-8',
		'Cache-Control': 'no-cache, no-transform',
		'X-Accel-Buffering': 'no',
	});

	function sendSSE(obj) {
		res.write(`data: ${JSON.stringify(obj)}\n\n`);
	}

	const result =
		route.style === 'anthropic'
			? await streamAnthropic(upstream, sendSSE)
			: await streamOpenAI(upstream, sendSSE);

	if (result.error) {
		captureException(result.error, { route: 'chat', stage: 'stream', provider: route.name });
		sendSSE({ type: 'error', code: 'stream_error', message: 'stream interrupted' });
		res.end();
		return;
	}

	sendSSE({
		type: 'done',
		reply: result.reply.trim(),
		actions: result.actions,
		model: route.model,
		provider: route.name,
	});
	res.end();

	const latencyMs = Date.now() - started;
	recordEvent({
		userId: auth?.userId ?? null,
		apiKeyId: auth?.apiKeyId,
		clientId: auth?.clientId,
		kind: 'chat',
		tool: route.model,
		latencyMs,
		meta: {
			provider: route.name,
			input_tokens: result.inputTokens,
			output_tokens: result.outputTokens,
			actions: result.actions.map((a) => a.type),
			has_context: Boolean(body.context?.modelName),
			anonymous,
		},
	});
});

// ── Provider selection ───────────────────────────────────────────────────────

function pickProvider(requested, model, userKeys = {}) {
	const order = requested
		? [requested, ...Object.keys(PROVIDERS).filter((p) => p !== requested)]
		: ['anthropic', 'openrouter', 'groq', 'openai'];

	for (const name of order) {
		const cfg = PROVIDERS[name];
		const apiKey = userKeys[name] || process.env[cfg.envKey];
		if (!apiKey) continue;
		const chosenModel = (requested === name && model) || process.env.CHAT_MODEL || cfg.defaultModel;
		return makeRoute(name, cfg, apiKey, chosenModel);
	}
	return null;
}

// Build an ordered failover list starting with the primary route. Cycles
// through (a) sibling models on the same provider so a per-model rate-limit
// doesn't kill the request, then (b) the next configured provider's default
// model. Stops as soon as a provider has no API key. The primary is always
// position 0 so the happy path is one entry.
//
// Why per-provider sibling models: OpenRouter's `:free` tier rate-limits per
// model. Falling over from llama-3.3-70b:free → mistral-7b:free recovers
// from a single upstream burst without paying. Last resort is paid Anthropic
// so the user still gets a response.
const FALLBACK_SIBLINGS = {
	openrouter: [
		'meta-llama/llama-3.3-70b-instruct:free',
		'mistralai/mistral-7b-instruct:free',
	],
	groq: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
	anthropic: ['claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
	openai: ['gpt-4o-mini'],
};

function buildFallbackChain(primary, userKeys = {}) {
	const chain = [primary];
	const seen = new Set([`${primary.name}:${primary.model}`]);

	// Sibling models on the same provider
	const siblings = FALLBACK_SIBLINGS[primary.name] || [];
	for (const m of siblings) {
		const key = `${primary.name}:${m}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const cfg = PROVIDERS[primary.name];
		const apiKey = userKeys[primary.name] || process.env[cfg.envKey];
		if (!apiKey) continue;
		chain.push(makeRoute(primary.name, cfg, apiKey, m));
	}

	// Other providers, in declared order, picking the configured default model
	for (const name of Object.keys(PROVIDERS)) {
		if (name === primary.name) continue;
		const cfg = PROVIDERS[name];
		const apiKey = userKeys[name] || process.env[cfg.envKey];
		if (!apiKey) continue;
		const key = `${name}:${cfg.defaultModel}`;
		if (seen.has(key)) continue;
		seen.add(key);
		chain.push(makeRoute(name, cfg, apiKey, cfg.defaultModel));
	}

	return chain;
}

function makeRoute(name, cfg, apiKey, model) {
	if (cfg.style === 'anthropic') {
		return {
			name,
			model,
			url: cfg.url,
			style: 'anthropic',
			headers: {
				'x-api-key': apiKey,
				'anthropic-version': '2023-06-01',
				'content-type': 'application/json',
			},
			buildPayload: ({ systemPrompt, history, maxTokens }) => ({
				model,
				max_tokens: maxTokens,
				system: systemPrompt,
				messages: history,
				tools: ACTION_TOOLS,
				stream: true,
			}),
		};
	}
	return {
		name,
		model,
		url: cfg.url,
		style: 'openai',
		headers: {
			Authorization: `Bearer ${apiKey}`,
			'Content-Type': 'application/json',
			...(cfg.extraHeaders || {}),
		},
		buildPayload: ({ systemPrompt, history, maxTokens }) => ({
			model,
			max_tokens: maxTokens,
			messages: [{ role: 'system', content: systemPrompt }, ...history],
			tools: OPENAI_TOOLS,
			tool_choice: 'auto',
			stream: true,
		}),
	};
}

// ── Stream readers ───────────────────────────────────────────────────────────

async function streamAnthropic(upstream, sendSSE) {
	const reader = upstream.body.getReader();
	const decoder = new TextDecoder();
	let buf = '';
	let reply = '';
	const actions = [];
	const blocks = {};
	let inputTokens = 0;
	let outputTokens = 0;

	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			buf += decoder.decode(value, { stream: true });
			const lines = buf.split('\n');
			buf = lines.pop();
			for (const line of lines) {
				if (!line.startsWith('data: ')) continue;
				const raw = line.slice(6).trim();
				if (!raw) continue;
				let evt;
				try {
					evt = JSON.parse(raw);
				} catch {
					continue;
				}
				if (evt.type === 'message_start') {
					inputTokens = evt.message?.usage?.input_tokens ?? 0;
				} else if (evt.type === 'content_block_start') {
					const cb = evt.content_block;
					blocks[evt.index] = { type: cb.type, name: cb.name, partialJson: '' };
				} else if (evt.type === 'content_block_delta') {
					const block = blocks[evt.index];
					if (!block) continue;
					if (evt.delta.type === 'text_delta') {
						reply += evt.delta.text;
						sendSSE({ type: 'chunk', text: evt.delta.text });
					} else if (evt.delta.type === 'input_json_delta') {
						block.partialJson += evt.delta.partial_json;
					}
				} else if (evt.type === 'content_block_stop') {
					const block = blocks[evt.index];
					if (block?.type === 'tool_use') {
						const action = parseToolJson(block.name, block.partialJson);
						if (action) actions.push(action);
					}
				} else if (evt.type === 'message_delta') {
					outputTokens = evt.usage?.output_tokens ?? outputTokens;
				}
			}
		}
	} catch (err) {
		return { error: err, reply, actions, inputTokens, outputTokens };
	}

	return { reply, actions, inputTokens, outputTokens };
}

async function streamOpenAI(upstream, sendSSE) {
	const reader = upstream.body.getReader();
	const decoder = new TextDecoder();
	let buf = '';
	let reply = '';
	const actions = [];
	// OpenAI streams tool calls as deltas keyed by index. Accumulate name + arguments per index.
	const toolBuf = {};
	let inputTokens = 0;
	let outputTokens = 0;

	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			buf += decoder.decode(value, { stream: true });
			const lines = buf.split('\n');
			buf = lines.pop();
			for (const line of lines) {
				if (!line.startsWith('data: ')) continue;
				const raw = line.slice(6).trim();
				if (!raw || raw === '[DONE]') continue;
				let evt;
				try {
					evt = JSON.parse(raw);
				} catch {
					continue;
				}
				const choice = evt.choices?.[0];
				const delta = choice?.delta;
				if (delta?.content) {
					reply += delta.content;
					sendSSE({ type: 'chunk', text: delta.content });
				}
				if (Array.isArray(delta?.tool_calls)) {
					for (const tc of delta.tool_calls) {
						const idx = tc.index ?? 0;
						const slot = (toolBuf[idx] ||= { name: '', args: '' });
						if (tc.function?.name) slot.name += tc.function.name;
						if (tc.function?.arguments) slot.args += tc.function.arguments;
					}
				}
				if (evt.usage) {
					inputTokens = evt.usage.prompt_tokens ?? inputTokens;
					outputTokens = evt.usage.completion_tokens ?? outputTokens;
				}
			}
		}
	} catch (err) {
		return { error: err, reply, actions, inputTokens, outputTokens };
	}

	for (const slot of Object.values(toolBuf)) {
		const action = parseToolJson(slot.name, slot.args);
		if (action) actions.push(action);
	}

	return { reply, actions, inputTokens, outputTokens };
}

function parseToolJson(name, jsonText) {
	if (!name || !ACTION_NAMES.has(name)) return null;
	const text = jsonText && jsonText.trim() ? jsonText : '{}';
	try {
		const input = JSON.parse(text);
		return { type: name, ...input };
	} catch {
		return null;
	}
}

// ── System prompt + auth + helpers ───────────────────────────────────────────

function buildSystemPrompt(ctx = {}, personaPrompt = null) {
	const loaded = ctx.modelName
		? `A model named "${ctx.modelName}" is loaded. Stats: ${fmt(ctx.vertices)} vertices, ${fmt(ctx.triangles)} triangles, ${fmt(ctx.materials)} materials, ${ctx.animations ?? 0} animations.`
		: 'No model is currently loaded in the viewer.';
	const validation =
		ctx.validationErrors != null
			? `Validation has been run: ${ctx.validationErrors} errors, ${ctx.validationWarnings ?? 0} warnings.`
			: 'glTF validation has not been run yet for this model.';
	const settings = `Viewer settings — wireframe:${fmtBool(ctx.wireframe)}, skeleton:${fmtBool(ctx.skeleton)}, grid:${fmtBool(ctx.grid)}, autoRotate:${fmtBool(ctx.autoRotate)}, transparentBg:${fmtBool(ctx.transparentBg)}, bgColor:${ctx.bgColor || '?'}, environment:${ctx.currentEnvironment || '?'}.`;

	const lines = [];
	if (personaPrompt) lines.push(personaPrompt, '');
	lines.push(
		'You are the three.ws — an embodied AI assistant embedded inside a browser-native glTF/GLB viewer at three.ws.',
		'Your job is to help the user inspect, understand, and modify the 3D scene. You have deep glTF 2.0, PBR materials, and three.js expertise.',
		'You can also show the latest trades from pump.fun by calling the getPumpFunTrades tool.',
		'When the user asks you to change the viewer ("enable wireframe", "make the background dark blue", "turn on auto rotate", "load this model"), CALL the matching tool — do not just describe what would happen. Examples: user "wireframe on" → call setWireframe({value:true}). user "rotate it" → call setAutoRotate({value:true}). user "dark blue bg" → call setBgColor({value:"#0a1f44"}).',
		'When asked about the loaded model, use the context below as ground truth. Do not invent stats.',
		'Keep replies tight: 1–3 sentences. Plain text, no markdown headers, no emoji.',
		'',
		loaded,
		validation,
		settings,
	);
	return lines.join('\n');
}

async function resolveAuth(req) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id, source: 'session' };
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) return bearer;
	return null;
}

function fmt(n) {
	return typeof n === 'number' ? n.toLocaleString('en-US') : '?';
}
function fmtBool(v) {
	return typeof v === 'boolean' ? (v ? 'on' : 'off') : '?';
}
function clampInt(n, min, max) {
	return Math.min(max, Math.max(min, n));
}
