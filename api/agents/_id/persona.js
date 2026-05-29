// GET    /api/agents/:id/persona         — persona status (has_persona, tone_tags, extracted_at)
// POST   /api/agents/:id/persona/extract — extract persona from 5-question interview via Claude

import { createHash, createHmac } from 'node:crypto';
import { sql } from '../../_lib/db.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../../_lib/auth.js';
import { cors, json, method, readJson, wrap, error } from '../../_lib/http.js';
import { limits } from '../../_lib/rate-limit.js';
import { env } from '../../_lib/env.js';
import { llmComplete, LlmUnavailableError } from '../../_lib/llm.js';
import { parse } from '../../_lib/validate.js';
import { z } from 'zod';

const extractBody = z.object({
	answers: z
		.array(z.string().trim().min(5, 'Each answer must be at least 5 characters').max(1000))
		.length(5, 'Exactly 5 answers required'),
});

async function resolveAuth(req) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id };
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) return { userId: bearer.userId };
	return null;
}

export const handlePersona = wrap(async (req, res, id, action) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required');

	const [agent] =
		await sql`SELECT id, user_id FROM agent_identities WHERE id = ${id} AND deleted_at IS NULL`;
	if (!agent) return error(res, 404, 'not_found', 'agent not found');
	if (agent.user_id !== auth.userId) return error(res, 403, 'forbidden', 'not your agent');

	// ── GET — persona status ─────────────────────────────────────────────────

	if (req.method === 'GET') {
		const [row] = await sql`
			SELECT persona_prompt_hash, persona_tone_tags, persona_extracted_at
			FROM agent_identities WHERE id = ${id}
		`;
		return json(res, 200, {
			has_persona: Boolean(row?.persona_prompt_hash),
			tone_tags: row?.persona_tone_tags || [],
			extracted_at: row?.persona_extracted_at || null,
		});
	}

	// ── POST /extract ─────────────────────────────────────────────────────────

	if (req.method === 'POST' && action === 'extract') {
		const rl = await limits.personaExtract(auth.userId);
		if (!rl.success)
			return error(res, 429, 'rate_limited', 'persona extraction limit reached (5 per day)');

		const body = parse(extractBody, await readJson(req));
		const { answers } = body;

		let raw;
		try {
			({ text: raw } = await llmComplete({
				maxTokens: 1024,
				system:
					'You are a persona architect. Given a person\'s interview answers, extract their communication style, tone, and voice. Produce a concise first-person system prompt that an LLM can use to impersonate this person faithfully. Be specific. Avoid clichés.\n\n' +
					'Output ONLY a single JSON object (no markdown fences, no prose) with EXACTLY these fields:\n' +
					'{\n' +
					'  "system_prompt": string,        // 150-300 word first-person system prompt, starting with "You are ..."\n' +
					'  "tone_tags": string[],          // up to 8 single-word tone descriptors\n' +
					'  "vocabulary_samples": string[]  // up to 10 short phrases characteristic of this persona\n' +
					'}',
				user: `Interview answers:\n1. ${answers[0]}\n2. ${answers[1]}\n3. ${answers[2]}\n4. ${answers[3]}\n5. ${answers[4]}`,
			}));
		} catch (err) {
			if (err instanceof LlmUnavailableError) {
				return error(res, 503, 'llm_unavailable', 'persona extraction is not available right now');
			}
			console.error('[persona/extract] LLM error', err.status || '', err.message);
			return error(res, 502, 'upstream_error', 'persona extraction failed');
		}

		let extracted;
		try {
			const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
			extracted = JSON.parse(stripped);
		} catch {
			console.error('[persona/extract] non-JSON model output', raw.slice(0, 400));
			return error(res, 502, 'upstream_error', 'unexpected response from persona extraction');
		}

		const system_prompt = typeof extracted.system_prompt === 'string' ? extracted.system_prompt.trim() : '';
		const tone_tags = Array.isArray(extracted.tone_tags)
			? extracted.tone_tags.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim().slice(0, 40)).slice(0, 8)
			: [];
		const vocabulary_samples = Array.isArray(extracted.vocabulary_samples)
			? extracted.vocabulary_samples.filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim().slice(0, 120)).slice(0, 10)
			: [];
		if (!system_prompt) {
			return error(res, 502, 'upstream_error', 'unexpected response from persona extraction');
		}

		const hash = createHash('sha256').update(system_prompt).digest('hex');
		const sig = createHmac('sha256', env.JWT_SECRET).update(hash).digest('hex');

		const [updated] = await sql`
			UPDATE agent_identities
			SET
				persona_prompt        = ${system_prompt},
				persona_prompt_hash   = ${hash},
				persona_prompt_sig    = ${sig},
				persona_tone_tags     = ${JSON.stringify(tone_tags)}::jsonb,
				persona_extracted_at  = now(),
				updated_at            = now()
			WHERE id = ${id}
			RETURNING persona_extracted_at
		`;

		return json(res, 200, {
			system_prompt,
			tone_tags,
			vocabulary_samples,
			hash,
			extracted_at: updated.persona_extracted_at,
		});
	}

	return error(res, 404, 'not_found', 'unknown persona action');
});
