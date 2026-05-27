// POST /api/persona/extract
// Synthesizes a structured persona JSON from a short onboarding interview.
// Prefers Anthropic direct, falls back to OpenRouter then Groq so the
// feature works regardless of which API keys are configured.

import { cors, json, method, readJson, wrap, error } from '../_lib/http.js';
import { getSessionUser, authenticateBearer, extractBearer, hasScope } from '../_lib/auth.js';

const MAX_ANSWERS = 12;
const MAX_QA_CHARS = 1200;

function resolveProvider() {
	const anthropicKey = process.env.ANTHROPIC_API_KEY;
	if (anthropicKey) {
		return {
			name: 'anthropic',
			model: 'claude-haiku-4-5-20251001',
			url: 'https://api.anthropic.com/v1/messages',
			headers: {
				'content-type': 'application/json',
				'x-api-key': anthropicKey,
				'anthropic-version': '2023-06-01',
			},
			buildBody: (system, userMessage) => ({
				model: 'claude-haiku-4-5-20251001',
				max_tokens: 800,
				system,
				messages: [{ role: 'user', content: userMessage }],
			}),
			extractText: (r) => r.content?.[0]?.text || '',
			extractUsage: (r) => ({
				input: r.usage?.input_tokens ?? 0,
				output: r.usage?.output_tokens ?? 0,
			}),
		};
	}
	const orKey = process.env.OPENROUTER_API_KEY;
	if (orKey) {
		return {
			name: 'openrouter',
			model: 'anthropic/claude-3.5-haiku',
			url: 'https://openrouter.ai/api/v1/chat/completions',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${orKey}`,
				'HTTP-Referer': 'https://three.ws',
				'X-Title': 'three.ws persona',
			},
			buildBody: (system, userMessage) => ({
				model: 'anthropic/claude-3.5-haiku',
				max_tokens: 800,
				messages: [
					{ role: 'system', content: system },
					{ role: 'user', content: userMessage },
				],
			}),
			extractText: (r) => r.choices?.[0]?.message?.content || '',
			extractUsage: (r) => ({
				input: r.usage?.prompt_tokens ?? 0,
				output: r.usage?.completion_tokens ?? 0,
			}),
		};
	}
	const groqKey = process.env.GROQ_API_KEY;
	if (groqKey) {
		return {
			name: 'groq',
			model: 'llama-3.3-70b-versatile',
			url: 'https://api.groq.com/openai/v1/chat/completions',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${groqKey}`,
			},
			buildBody: (system, userMessage) => ({
				model: 'llama-3.3-70b-versatile',
				max_tokens: 800,
				messages: [
					{ role: 'system', content: system },
					{ role: 'user', content: userMessage },
				],
			}),
			extractText: (r) => r.choices?.[0]?.message?.content || '',
			extractUsage: (r) => ({
				input: r.usage?.prompt_tokens ?? 0,
				output: r.usage?.completion_tokens ?? 0,
			}),
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

const MAX_FREEFORM_CHARS = 8000;

function validateInput(input) {
	if (!input || typeof input !== 'object') {
		throw Object.assign(new Error('body must be an object'), { status: 400 });
	}

	if (typeof input.freeform === 'string' && input.freeform.trim()) {
		return { mode: 'freeform', text: input.freeform.trim().slice(0, MAX_FREEFORM_CHARS) };
	}

	const list = input.answers;
	if (!Array.isArray(list) || list.length === 0) {
		throw Object.assign(new Error('provide answers array or freeform text'), { status: 400 });
	}
	if (list.length > MAX_ANSWERS) {
		throw Object.assign(new Error(`max ${MAX_ANSWERS} answers`), { status: 400 });
	}
	const cleaned = [];
	for (const row of list) {
		if (!row || typeof row !== 'object') {
			throw Object.assign(new Error('each answer must be an object'), { status: 400 });
		}
		const q = typeof row.question === 'string' ? row.question.trim() : '';
		const a = typeof row.answer === 'string' ? row.answer.trim() : '';
		if (!q || !a) {
			throw Object.assign(new Error('each answer needs question + answer'), { status: 400 });
		}
		cleaned.push({
			question: q.slice(0, MAX_QA_CHARS),
			answer: a.slice(0, MAX_QA_CHARS),
		});
	}
	return { mode: 'interview', answers: cleaned };
}

const SYSTEM_PROMPT = `You are a persona-extraction analyst. You read a short interview between an onboarding system and a person, and you synthesize a compact persona profile that can later be used to shape an AI agent's voice on behalf of that person.

Return ONLY a single JSON object (no markdown fences, no prose) with EXACTLY these fields:

{
  "tone": string  // one-line summary of how this person sounds, 8-20 words
  "vocabulary": string[]  // 5-10 distinctive words or short phrases the user actually gravitates to, drawn from their answers when possible
  "interests": string[]  // 3-5 concrete topics/domains
  "communication_style": "terse" | "detailed" | "playful" | "analytical" | "warm"
  "dont_say": string[]  // 1-3 phrases the agent should avoid (things the user explicitly dislikes, or that would clash with their voice)
  "sample_greeting": string  // one greeting (1-2 sentences) the agent would open with, written entirely in this persona's voice
}

Rules:
- "communication_style" MUST be exactly one of the five listed strings.
- Prefer evidence from the user's actual words over generic guesses.
- If the interview is sparse, infer conservatively rather than fabricate.
- No trailing commas. No comments. No markdown. JUST the JSON object.`;

const handler = wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const userId = await resolveUser(req);
	if (!userId) {
		return error(res, 401, 'unauthorized', 'Sign in to build your persona.');
	}

	const body = await readJson(req);
	const input = validateInput(body);

	const provider = resolveProvider();
	if (!provider) {
		return error(
			res,
			503,
			'config_missing',
			'Persona extraction is not available right now. Please try again later.',
		);
	}

	let userMessage;
	if (input.mode === 'freeform') {
		userMessage = `Analyze the following text and synthesize a persona JSON that captures the voice, personality, and communication patterns present in it.\n\n---\n${input.text}\n---`;
	} else {
		const interview = input.answers
			.map((row, i) => `Q${i + 1}: ${row.question}\nA${i + 1}: ${row.answer}`)
			.join('\n\n');
		userMessage = `Here is the onboarding interview. Synthesize the persona JSON.\n\n${interview}`;
	}

	const t0 = Date.now();
	const llmRes = await fetch(provider.url, {
		method: 'POST',
		headers: provider.headers,
		body: JSON.stringify(provider.buildBody(SYSTEM_PROMPT, userMessage)),
	});

	if (!llmRes.ok) {
		const detail = await llmRes.text();
		console.error(`[persona/extract] ${provider.name} error`, llmRes.status, detail);
		return error(res, 502, 'upstream_error', `${provider.name} API ${llmRes.status}`);
	}

	const result = await llmRes.json();
	const raw = provider.extractText(result);
	let persona;
	try {
		const stripped = raw
			.trim()
			.replace(/^```(?:json)?\s*/i, '')
			.replace(/\s*```$/i, '')
			.trim();
		persona = JSON.parse(stripped);
	} catch (err) {
		console.error('[persona/extract] parse error', err, raw.slice(0, 500));
		return error(res, 502, 'parse_error', 'model returned non-JSON');
	}

	const allowedStyles = ['terse', 'detailed', 'playful', 'analytical', 'warm'];
	const normalized = {
		tone: typeof persona.tone === 'string' ? persona.tone.trim().slice(0, 240) : '',
		vocabulary: Array.isArray(persona.vocabulary)
			? persona.vocabulary
					.filter((x) => typeof x === 'string' && x.trim())
					.map((x) => x.trim().slice(0, 80))
					.slice(0, 10)
			: [],
		interests: Array.isArray(persona.interests)
			? persona.interests
					.filter((x) => typeof x === 'string' && x.trim())
					.map((x) => x.trim().slice(0, 80))
					.slice(0, 5)
			: [],
		communication_style: allowedStyles.includes(persona.communication_style)
			? persona.communication_style
			: 'detailed',
		dont_say: Array.isArray(persona.dont_say)
			? persona.dont_say
					.filter((x) => typeof x === 'string' && x.trim())
					.map((x) => x.trim().slice(0, 120))
					.slice(0, 3)
			: [],
		sample_greeting:
			typeof persona.sample_greeting === 'string'
				? persona.sample_greeting.trim().slice(0, 400)
				: '',
	};

	const usage = provider.extractUsage(result);

	return json(res, 200, {
		persona: normalized,
		model: provider.model,
		tokens_used: usage.input + usage.output,
		tokens_in: usage.input,
		tokens_out: usage.output,
		latency_ms: Date.now() - t0,
	});
});

export default handler;
