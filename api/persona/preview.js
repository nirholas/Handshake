// POST /api/persona/preview
// Replies to a user message in the voice of a supplied persona JSON.
// Prefers Anthropic direct, falls back to OpenRouter then Groq.

import { cors, json, method, readJson, wrap, error } from '../_lib/http.js';
import { getSessionUser, authenticateBearer, extractBearer, hasScope } from '../_lib/auth.js';
import { env } from '../_lib/env.js';

const MAX_MSG_CHARS = 1500;

function resolveProvider() {
	if (env.ANTHROPIC_API_KEY) {
		return {
			name: 'anthropic',
			model: 'claude-haiku-4-5-20251001',
			url: 'https://api.anthropic.com/v1/messages',
			headers: {
				'content-type': 'application/json',
				'x-api-key': env.ANTHROPIC_API_KEY,
				'anthropic-version': '2023-06-01',
			},
			buildBody: (system, userMessage, maxTokens) => ({
				model: 'claude-haiku-4-5-20251001',
				max_tokens: maxTokens,
				system,
				messages: [{ role: 'user', content: userMessage }],
			}),
			extractText: (r) => (r.content?.[0]?.text || '').trim(),
			extractUsage: (r) => ({ input: r.usage?.input_tokens ?? 0, output: r.usage?.output_tokens ?? 0 }),
		};
	}
	if (env.OPENROUTER_API_KEY) {
		return {
			name: 'openrouter',
			model: 'anthropic/claude-3.5-haiku',
			url: 'https://openrouter.ai/api/v1/chat/completions',
			headers: {
				'content-type': 'application/json',
				'authorization': `Bearer ${env.OPENROUTER_API_KEY}`,
				'HTTP-Referer': 'https://three.ws',
				'X-Title': 'three.ws persona',
			},
			buildBody: (system, userMessage, maxTokens) => ({
				model: 'anthropic/claude-3.5-haiku',
				max_tokens: maxTokens,
				messages: [{ role: 'system', content: system }, { role: 'user', content: userMessage }],
			}),
			extractText: (r) => (r.choices?.[0]?.message?.content || '').trim(),
			extractUsage: (r) => ({ input: r.usage?.prompt_tokens ?? 0, output: r.usage?.completion_tokens ?? 0 }),
		};
	}
	if (env.GROQ_API_KEY) {
		return {
			name: 'groq',
			model: 'llama-3.3-70b-versatile',
			url: 'https://api.groq.com/openai/v1/chat/completions',
			headers: {
				'content-type': 'application/json',
				'authorization': `Bearer ${env.GROQ_API_KEY}`,
			},
			buildBody: (system, userMessage, maxTokens) => ({
				model: 'llama-3.3-70b-versatile',
				max_tokens: maxTokens,
				messages: [{ role: 'system', content: system }, { role: 'user', content: userMessage }],
			}),
			extractText: (r) => (r.choices?.[0]?.message?.content || '').trim(),
			extractUsage: (r) => ({ input: r.usage?.prompt_tokens ?? 0, output: r.usage?.completion_tokens ?? 0 }),
		};
	}
	return null;
}

async function resolveUser(req) {
	const session = await getSessionUser(req);
	if (session) return session.id;
	const bearer = await authenticateBearer(extractBearer(req), { audience: undefined });
	if (!bearer) return null;
	if (!hasScope(bearer.scope, 'avatars:read') && !hasScope(bearer.scope, 'avatars:write')) {
		return null;
	}
	return bearer.userId;
}

function validateBody(input) {
	if (!input || typeof input !== 'object') {
		throw Object.assign(new Error('body must be an object'), { status: 400 });
	}
	const { persona, user_message } = input;
	if (!persona || typeof persona !== 'object') {
		throw Object.assign(new Error('persona must be an object'), { status: 400 });
	}
	if (typeof user_message !== 'string' || !user_message.trim()) {
		throw Object.assign(new Error('user_message required'), { status: 400 });
	}
	return {
		persona,
		user_message: user_message.trim().slice(0, MAX_MSG_CHARS),
	};
}

function buildSystemPrompt(persona) {
	// Compact, deterministic system prompt. We pin the JSON inline so the model
	// has every persona field visible and can reference vocabulary / dont_say.
	return `You are an agent speaking on behalf of a person whose persona is described by the following JSON profile. Embody this voice — tone, vocabulary, communication style — in every reply.

PERSONA:
${JSON.stringify(persona, null, 2)}

Rules:
- Reply in 1-2 sentences. Never more.
- Stay in the persona's voice. Borrow from "vocabulary" when natural.
- Match "communication_style" (terse | detailed | playful | analytical | warm).
- Never use any phrase listed in "dont_say".
- Do not break character. Do not mention that you are an AI, agent, or assistant. Do not mention the persona JSON.
- Do not preface with greetings or sign-offs unless directly asked.`;
}

const handler = wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const userId = await resolveUser(req);
	if (!userId) {
		return error(res, 401, 'unauthorized', 'sign in or provide a valid bearer token');
	}

	const body = validateBody(await readJson(req));

	const provider = resolveProvider();
	if (!provider) {
		return error(res, 503, 'config_missing',
			'No LLM provider configured. Set OPENROUTER_API_KEY, GROQ_API_KEY, or ANTHROPIC_API_KEY.');
	}

	const system = buildSystemPrompt(body.persona);
	const t0 = Date.now();
	const llmRes = await fetch(provider.url, {
		method: 'POST',
		headers: provider.headers,
		body: JSON.stringify(provider.buildBody(system, body.user_message, 220)),
	});

	if (!llmRes.ok) {
		const detail = await llmRes.text();
		console.error(`[persona/preview] ${provider.name} error`, llmRes.status, detail);
		return error(res, 502, 'upstream_error', `${provider.name} API ${llmRes.status}`);
	}

	const result = await llmRes.json();
	const reply = provider.extractText(result);
	const usage = provider.extractUsage(result);

	return json(res, 200, {
		reply,
		model: provider.model,
		tokens_used: usage.input + usage.output,
		tokens_in: usage.input,
		tokens_out: usage.output,
		latency_ms: Date.now() - t0,
	});
});

export default handler;
