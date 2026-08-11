// Persona — the agent's mind, as editable structure.
//
// GET    /api/agents/:id/persona          — full persona for the owner: traits,
//                                            tone tags, vocabulary, base, the
//                                            compiled prompt, and current version.
// POST   /api/agents/:id/persona/extract  — (re)run the 5-question interview via
//                                            Claude; seeds the base persona + tone.
// POST   /api/agents/:id/persona/save      — save edited traits/tone/vocabulary;
//                                            compiles + signs persona_prompt and
//                                            writes a real agent_versions entry.
// GET    /api/agents/:id/persona/versions — persona version history (for diff).
// POST   /api/agents/:id/persona/restore  — restore a prior version as a new save.

import { createHash, createHmac } from 'node:crypto';
import { sql } from '../../_lib/db.js';
import { getSessionUser, authenticateBearer, extractBearer, isSameSiteOrigin } from '../../_lib/auth.js';
import { cors, json, method, readJson, wrap, error, rateLimited } from '../../_lib/http.js';
import { limits } from '../../_lib/rate-limit.js';
import { env } from '../../_lib/env.js';
import {
	extractPersonaFromInterview,
	PersonaExtractionError,
} from '../../_lib/persona-interview-extract.js';
import { parse } from '../../_lib/validate.js';
import { z } from 'zod';
import {
	compilePersona,
	clampTraits,
	sanitizeToneTags,
	sanitizeVocabulary,
	PERSONA_TRAIT_KEYS,
} from '../../../src/agents/persona-compile.js';
import {
	INTERVIEW_QUESTIONS,
	normalizeInterview,
	interviewTranscript,
	MAX_INTERVIEW_ANSWERS,
} from '../../../src/agents/persona-interview.js';

// Two accepted answer shapes, one interview. The structured form
// ([{ id?, question?, answer }]) is what the create-agent wizard and the current
// Brain Studio modal send: 5 to 8 questions, any of them skippable. The legacy
// form (five bare strings, positionally mapped onto the canonical questions) is
// still accepted so an older client or an SDK caller keeps working.
const extractBody = z.object({
	answers: z
		.union([
			z.array(z.string().max(1000)).min(1).max(MAX_INTERVIEW_ANSWERS),
			z
				.array(
					z.object({
						id: z.string().max(40).optional(),
						question: z.string().max(240).optional(),
						answer: z.string().max(1000),
					}),
				)
				.min(1)
				.max(MAX_INTERVIEW_ANSWERS),
		])
		.transform((rows) =>
			normalizeInterview(
				rows.map((row, i) =>
					typeof row === 'string'
						? { id: INTERVIEW_QUESTIONS[i]?.id, question: INTERVIEW_QUESTIONS[i]?.prompt, answer: row }
						: row,
				),
			),
		)
		.refine((rows) => rows.length > 0, 'Answer at least one interview question'),
});

const traitsSchema = z.record(z.string(), z.number()).default({});

const saveBody = z.object({
	traits: traitsSchema,
	tone_tags: z.array(z.string()).max(24).default([]),
	vocabulary: z.array(z.string()).max(24).default([]),
	base: z.string().max(4000).optional(),
	changelog: z.string().trim().max(280).optional(),
	// Interview provenance. The create-agent wizard runs the interview before the
	// agent exists (POST /api/persona/interview) and hands the answers over on the
	// first save, so the agent records WHICH questions produced its voice — that is
	// what `persona.interview` on the public manifest reports.
	interview: z
		.array(
			z.object({
				id: z.string().max(40).optional(),
				question: z.string().max(240).optional(),
				answer: z.string().max(1000),
			}),
		)
		.max(MAX_INTERVIEW_ANSWERS)
		.optional(),
});

const restoreBody = z.object({ version: z.number().int().positive() });

async function resolveAuth(req) {
	const session = await getSessionUser(req);
	if (session) {
		// CSRF defense-in-depth for the cookie path: persona writes rewrite the
		// agent's compiled prompt (prompt-injection persistence), so a
		// cross-site POST riding the session cookie must never reach them.
		// Reads stay open; bearer callers are exempt.
		const isRead = ['GET', 'HEAD', 'OPTIONS'].includes(String(req.method || '').toUpperCase());
		if (!isRead && !isSameSiteOrigin(req)) {
			throw Object.assign(new Error('cross-site request blocked'), { status: 403, code: 'forbidden' });
		}
		return { userId: session.id };
	}
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) return { userId: bearer.userId };
	return null;
}

// Sign a compiled persona prompt so chat.js / portability can verify provenance.
function signPrompt(systemPrompt) {
	const hash = createHash('sha256').update(systemPrompt).digest('hex');
	const sig = createHmac('sha256', env.JWT_SECRET).update(hash).digest('hex');
	return { hash, sig };
}

// Read the structured persona state stored on the agent. persona_traits holds
// { values: {key:0..1}, vocabulary: [...], base: "...", interview: {...} }.
function readStructured(agent) {
	const raw = agent.persona_traits && typeof agent.persona_traits === 'object' ? agent.persona_traits : {};
	return {
		values: clampTraits(raw.values || {}),
		vocabulary: sanitizeVocabulary(raw.vocabulary || []),
		base: typeof raw.base === 'string' ? raw.base : '',
		interview: raw.interview && typeof raw.interview === 'object' ? raw.interview : null,
	};
}

// The interview provenance block stored inside persona_traits: which questions
// were answered, when, and where the interview ran. The answers themselves are
// kept so the owner can reopen and edit them; the public manifest exposes only
// the counts (see api/agents/_id/_sub.js handleManifest).
function interviewRecord(answers, source) {
	return {
		source,
		question_ids: answers.map((row) => row.id),
		questions_answered: answers.length,
		questions_total: INTERVIEW_QUESTIONS.length,
		answers,
		at: new Date().toISOString(),
	};
}

export const handlePersona = wrap(async (req, res, id, action) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required');

	const [agent] = await sql`
		SELECT id, user_id, name, description, system_prompt, greeting, category, tags,
		       capabilities, persona_prompt, persona_prompt_hash, persona_tone_tags,
		       persona_traits, persona_extracted_at, persona_updated_at
		FROM agent_identities WHERE id = ${id} AND deleted_at IS NULL
	`;
	if (!agent) return error(res, 404, 'not_found', 'agent not found');
	if (agent.user_id !== auth.userId) return error(res, 403, 'forbidden', 'not your agent');

	// ── GET — full persona for the owner ─────────────────────────────────────
	if (req.method === 'GET' && !action) {
		const structured = readStructured(agent);
		const [{ latest }] = await sql`
			SELECT COALESCE(MAX(version), 0) AS latest FROM agent_versions WHERE agent_id = ${id}
		`;
		return json(res, 200, {
			has_persona: Boolean(agent.persona_prompt_hash),
			name: agent.name,
			description: agent.description || '',
			traits: structured.values,
			tone_tags: agent.persona_tone_tags || [],
			vocabulary: structured.vocabulary,
			base: structured.base,
			interview: structured.interview,
			persona_prompt: agent.persona_prompt || '',
			extracted_at: agent.persona_extracted_at || null,
			updated_at: agent.persona_updated_at || null,
			latest_version: latest,
		});
	}

	// ── GET /versions — persona version history ──────────────────────────────
	if (req.method === 'GET' && action === 'versions') {
		const rows = await sql`
			SELECT version, kind, changelog, persona_prompt, persona_tone_tags, persona_traits,
			       created_at
			FROM agent_versions
			WHERE agent_id = ${id} AND kind = 'persona'
			ORDER BY version DESC
			LIMIT 50
		`;
		return json(res, 200, {
			versions: rows.map((r) => ({
				version: r.version,
				kind: r.kind,
				changelog: r.changelog,
				persona_prompt: r.persona_prompt || '',
				tone_tags: r.persona_tone_tags || [],
				traits: (r.persona_traits && r.persona_traits.values) || {},
				vocabulary: (r.persona_traits && r.persona_traits.vocabulary) || [],
				base: (r.persona_traits && r.persona_traits.base) || '',
				created_at: r.created_at,
			})),
		});
	}

	// ── POST /extract — the 5-question interview ─────────────────────────────
	if (req.method === 'POST' && action === 'extract') {
		const rl = await limits.personaExtract(auth.userId);
		if (!rl.success) return rateLimited(res, rl, 'persona extraction limit reached (5 per day)');

		const body = parse(extractBody, await readJson(req));
		const answers = body.answers;

		let extracted;
		try {
			extracted = await extractPersonaFromInterview({
				name: agent.name,
				description: agent.description,
				greeting: agent.greeting,
				answers,
				userId: auth.userId,
				tool: 'persona_extract_rerun',
			});
		} catch (err) {
			if (err instanceof PersonaExtractionError) {
				return error(res, err.status, err.code, err.message);
			}
			throw err;
		}

		// The interview supplies the voice; the owner's trait sliders refine it.
		// A FIRST extraction has no tuned sliders to protect, so the interview's own
		// trait read is adopted. A re-run keeps whatever the owner has since dialled
		// in — re-running the interview must never silently undo their edits.
		const structured = readStructured(agent);
		const firstExtraction = !agent.persona_prompt_hash;
		const traits = firstExtraction ? extracted.traits : structured.values;
		const base = extracted.base;
		const tone_tags = extracted.toneTags;
		const vocabulary_samples = extracted.vocabulary;

		const compiled = compilePersona({
			name: agent.name,
			description: agent.description,
			base,
			traits,
			toneTags: tone_tags,
			vocabulary: vocabulary_samples,
		});
		const { hash, sig } = signPrompt(compiled);
		const personaTraits = {
			values: traits,
			vocabulary: vocabulary_samples,
			base,
			interview: interviewRecord(answers, 'brain-studio'),
		};

		const [updated] = await sql`
			UPDATE agent_identities
			SET persona_prompt       = ${compiled},
			    persona_prompt_hash  = ${hash},
			    persona_prompt_sig   = ${sig},
			    persona_tone_tags    = ${JSON.stringify(tone_tags)}::jsonb,
			    persona_traits       = ${JSON.stringify(personaTraits)}::jsonb,
			    persona_extracted_at = now(),
			    persona_updated_at   = now(),
			    updated_at           = now()
			WHERE id = ${id}
			RETURNING persona_extracted_at
		`;

		const manifest = await publishAgentManifestSafely(id, { reason: 'persona_extract' });

		return json(res, 200, {
			system_prompt: compiled,
			base,
			traits,
			tone_tags,
			vocabulary: vocabulary_samples,
			questions_answered: answers.length,
			hash,
			extracted_at: updated.persona_extracted_at,
			manifest,
		});
	}

	// ── POST /save — persist edited traits + create a real version ───────────
	if (req.method === 'POST' && action === 'save') {
		const rl = await limits.widgetWrite(auth.userId);
		if (!rl.success) return rateLimited(res, rl, 'too many persona saves, slow down');

		const body = parse(saveBody, await readJson(req));
		const prev = readStructured(agent);
		const traits = clampTraits(body.traits);
		const toneTags = sanitizeToneTags(body.tone_tags);
		const vocabulary = sanitizeVocabulary(body.vocabulary);
		const base = body.base != null ? String(body.base).trim() : prev.base;

		// A save that carries interview answers is the wizard handing over an
		// interview that ran before the agent existed. Record it as provenance and
		// stamp persona_extracted_at, so the agent reports an interviewed persona
		// exactly like a Brain Studio re-run does.
		const interviewAnswers = body.interview ? normalizeInterview(body.interview) : [];
		const interview = interviewAnswers.length
			? interviewRecord(interviewAnswers, 'create-wizard')
			: prev.interview;

		const compiled = compilePersona({
			name: agent.name,
			description: agent.description,
			base,
			traits,
			toneTags,
			vocabulary,
		});
		const { hash, sig } = signPrompt(compiled);
		const personaTraits = { values: traits, vocabulary, base, ...(interview ? { interview } : {}) };
		const changelog = body.changelog || 'Persona updated';

		const [{ next_version }] = await sql`
			SELECT COALESCE(MAX(version), 0) + 1 AS next_version
			FROM agent_versions WHERE agent_id = ${id}
		`;

		const [updatedRows] = await sql.transaction([
			sql`
				UPDATE agent_identities
				SET persona_prompt      = ${compiled},
				    persona_prompt_hash = ${hash},
				    persona_prompt_sig  = ${sig},
				    persona_tone_tags   = ${JSON.stringify(toneTags)}::jsonb,
				    persona_traits      = ${JSON.stringify(personaTraits)}::jsonb,
				    persona_extracted_at = CASE WHEN ${interviewAnswers.length > 0} THEN now() ELSE persona_extracted_at END,
				    persona_updated_at  = now(),
				    updated_at          = now()
				WHERE id = ${id}
				RETURNING persona_updated_at
			`,
			sql`
				INSERT INTO agent_versions (
					agent_id, version, kind, system_prompt, greeting, category, tags,
					capabilities, changelog, created_by,
					persona_prompt, persona_tone_tags, persona_traits
				)
				VALUES (
					${id}, ${next_version}, 'persona', ${agent.system_prompt}, ${agent.greeting},
					${agent.category}, ${agent.tags || []},
					${JSON.stringify(agent.capabilities || {})}::jsonb, ${changelog}, ${auth.userId},
					${compiled}, ${JSON.stringify(toneTags)}::jsonb, ${JSON.stringify(personaTraits)}::jsonb
				)
			`,
		]);

		// The prompt that just landed is the agent's behavior, so pin the proof of
		// it now. Best-effort by design: the save above is already committed and a
		// pinning hiccup reports itself in `manifest.reason` rather than failing.
		const manifest = await publishAgentManifestSafely(id, { reason: 'persona_save' });

		return json(res, 200, {
			version: next_version,
			persona_prompt: compiled,
			traits,
			tone_tags: toneTags,
			vocabulary,
			base,
			hash,
			changelog,
			updated_at: updatedRows[0]?.persona_updated_at || null,
			manifest,
		});
	}

	// ── POST /restore — re-save a prior version as the live persona ──────────
	if (req.method === 'POST' && action === 'restore') {
		const rl = await limits.widgetWrite(auth.userId);
		if (!rl.success) return rateLimited(res, rl, 'too many persona saves, slow down');

		const body = parse(restoreBody, await readJson(req));
		const [snap] = await sql`
			SELECT version, persona_tone_tags, persona_traits
			FROM agent_versions
			WHERE agent_id = ${id} AND version = ${body.version} AND kind = 'persona'
			LIMIT 1
		`;
		if (!snap) return error(res, 404, 'not_found', 'persona version not found');

		const snapTraits = snap.persona_traits && typeof snap.persona_traits === 'object' ? snap.persona_traits : {};
		const traits = clampTraits(snapTraits.values || {});
		const toneTags = sanitizeToneTags(snap.persona_tone_tags || []);
		const vocabulary = sanitizeVocabulary(snapTraits.vocabulary || []);
		const base = typeof snapTraits.base === 'string' ? snapTraits.base : '';

		const compiled = compilePersona({
			name: agent.name,
			description: agent.description,
			base,
			traits,
			toneTags,
			vocabulary,
		});
		const { hash, sig } = signPrompt(compiled);
		const personaTraits = { values: traits, vocabulary, base };
		const changelog = `Restored persona from v${snap.version}`;

		const [{ next_version }] = await sql`
			SELECT COALESCE(MAX(version), 0) + 1 AS next_version
			FROM agent_versions WHERE agent_id = ${id}
		`;

		await sql.transaction([
			sql`
				UPDATE agent_identities
				SET persona_prompt      = ${compiled},
				    persona_prompt_hash = ${hash},
				    persona_prompt_sig  = ${sig},
				    persona_tone_tags   = ${JSON.stringify(toneTags)}::jsonb,
				    persona_traits      = ${JSON.stringify(personaTraits)}::jsonb,
				    persona_updated_at  = now(),
				    updated_at          = now()
				WHERE id = ${id}
			`,
			sql`
				INSERT INTO agent_versions (
					agent_id, version, kind, system_prompt, greeting, category, tags,
					capabilities, changelog, created_by,
					persona_prompt, persona_tone_tags, persona_traits
				)
				VALUES (
					${id}, ${next_version}, 'persona', ${agent.system_prompt}, ${agent.greeting},
					${agent.category}, ${agent.tags || []},
					${JSON.stringify(agent.capabilities || {})}::jsonb, ${changelog}, ${auth.userId},
					${compiled}, ${JSON.stringify(toneTags)}::jsonb, ${JSON.stringify(personaTraits)}::jsonb
				)
			`,
		]);

		const manifest = await publishAgentManifestSafely(id, { reason: 'persona_restore' });

		return json(res, 200, {
			version: next_version,
			restored_from: snap.version,
			persona_prompt: compiled,
			traits,
			tone_tags: toneTags,
			vocabulary,
			base,
			hash,
			changelog,
			manifest,
		});
	}

	return error(res, 404, 'not_found', 'unknown persona action');
});
