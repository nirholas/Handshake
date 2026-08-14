// POST /api/persona/preview
// Replies to a user message in the voice of a supplied persona JSON.
// Runs through the shared LLM helper (api/_lib/llm.js), which owns the ordered
// failover chain (free lanes first, the GCP-credits Vertex anchor behind them,
// the paid server keys last), so a single upstream 429/5xx falls through to the
// next provider instead of returning a hard 502. Do not restate the provider
// order here: providerChain() in api/_lib/llm.js is the only source of truth
// for it, and a copy of the list in this comment goes stale silently.

import { cors, json, method, readJson, wrap, error, rateLimited } from '../_lib/http.js';
import { getSessionUser, authenticateBearer, extractBearer, hasScope } from '../_lib/auth.js';
import { limits } from '../_lib/rate-limit.js';
import { llmComplete, LlmUnavailableError, promptTokens } from '../_lib/llm.js';

const MAX_MSG_CHARS = 1500;
// The persona is pinned into the system prompt verbatim, so its serialized size
// is prompt size. Without a bound, a caller could post a megabyte-scale object
// (readJson's own limit) and turn one metered request into an arbitrarily
// expensive completion, which is exactly what the per-user limiter below exists
// to prevent. A persona from /api/persona/extract serializes to well under 1 KB.
const MAX_PERSONA_CHARS = 8000;

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
	if (!persona || typeof persona !== 'object' || Array.isArray(persona)) {
		throw Object.assign(new Error('persona must be an object'), { status: 400 });
	}
	if (typeof user_message !== 'string' || !user_message.trim()) {
		throw Object.assign(new Error('user_message required'), { status: 400 });
	}
	const personaJson = JSON.stringify(persona, null, 2);
	if (personaJson.length > MAX_PERSONA_CHARS) {
		throw Object.assign(
			new Error(`persona is too large (max ${MAX_PERSONA_CHARS} characters serialized)`),
			{ status: 400 },
		);
	}
	return {
		personaJson,
		user_message: user_message.trim().slice(0, MAX_MSG_CHARS),
	};
}

function buildSystemPrompt(personaJson) {
	// Compact, deterministic system prompt. We pin the JSON inline so the model
	// has every persona field visible and can reference vocabulary / dont_say.
	return `You are an agent speaking on behalf of a person whose persona is described by the following JSON profile. Embody this voice (tone, vocabulary, communication style) in every reply.

PERSONA:
${personaJson}

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

	// Validate before metering: a rejected body never reaches a provider, so it
	// should not consume the caller's completion budget.
	const body = validateBody(await readJson(req));

	// Metered LLM completion, so meter per user too and keep the bill bounded.
	const rl = await limits.personaPreviewUser(userId);
	if (!rl.success) return rateLimited(res, rl);

	const system = buildSystemPrompt(body.personaJson);
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
			// The caller cannot act on which server-side key is missing, and naming
			// the env vars in a public response advertises our provider inventory.
			// The operator sees the real cause in the log line below.
			console.error('[persona/preview] no LLM provider configured');
			return error(res, 503, 'config_missing',
				'Persona preview is not available right now. Please try again later.');
		}
		console.error('[persona/preview] all providers failed', err?.status, err?.message);
		return error(res, err?.status || 502, 'upstream_error', 'Persona preview is briefly unavailable. Please try again.');
	}

	// llmComplete prefers an empty-but-valid completion over throwing when every
	// provider answered 200 with no content. A blank reply is not a preview, so
	// report it as retryable instead of shipping an empty bubble to the client.
	if (!completion.text) {
		console.error('[persona/preview] every provider returned an empty completion');
		return error(res, 502, 'upstream_error', 'The model returned an empty reply. Please try again.');
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
