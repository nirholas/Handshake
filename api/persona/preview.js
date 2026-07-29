// POST /api/persona/preview
// Replies to a user message in the voice of a supplied persona JSON.
// Runs through the shared LLM helper (api/_lib/llm.js) for Anthropic-first
// ordered failover: server Anthropic → Groq → OpenRouter, so a single upstream
// 429/5xx fails over to the next provider instead of returning a hard 502.

import { cors, json, method, readJson, wrap, error, rateLimited } from '../_lib/http.js';
import { getSessionUser, authenticateBearer, extractBearer, hasScope } from '../_lib/auth.js';
import { limits } from '../_lib/rate-limit.js';
import { llmComplete, LlmUnavailableError, promptTokens } from '../_lib/llm.js';

const MAX_MSG_CHARS = 1500;

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

	// Paid LLM completion on the server key — meter per user to bound the bill.
	const rl = await limits.personaPreviewUser(userId);
	if (!rl.success) return rateLimited(res, rl);

	const body = validateBody(await readJson(req));

	const system = buildSystemPrompt(body.persona);
	const t0 = Date.now();
	let completion;
	try {
		completion = await llmComplete({
			system,
			user: body.user_message,
			maxTokens: 220,
		});
	} catch (err) {
		if (err instanceof LlmUnavailableError) {
			return error(res, 503, 'config_missing',
				'No LLM provider configured. Set GROQ_API_KEY, OPENROUTER_API_KEY, or NVIDIA_API_KEY (free), or ANTHROPIC_API_KEY / OPENAI_API_KEY.');
		}
		console.error('[persona/preview] all providers failed', err?.status, err?.message);
		return error(res, err?.status || 502, 'upstream_error', 'Persona preview is briefly unavailable. Please try again.');
	}

	const usage = completion.usage;

	return json(res, 200, {
		reply: completion.text,
		model: completion.model,
		tokens_used: promptTokens(usage) + usage.output,
		tokens_in: promptTokens(usage),
		tokens_out: usage.output,
		latency_ms: Date.now() - t0,
	});
});

export default handler;
