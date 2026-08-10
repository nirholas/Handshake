// /api/agent/dreams — the review surface for an agent's reflections ("dreams").
//
// GET  /api/agent/dreams?agentId=&status=pending&limit=  (owner-only)
//      → { dreams: [...], pending, lastRun }
//      Each dream carries its cited source memories (provenance), so the UI can
//      link straight into the Mind Palace.
//
// POST /api/agent/dreams  (owner-only) { agentId, dreamId, decision, answer? }
//      decision = 'accept' → writes a real, higher-salience memory (the dream
//                            becomes part of the mind) and links it back.
//                 'reject' → stores the rejection; future reflections learn from it.
//                 'answer' → for kind='question' dreams: writes the user's answer
//                            as a real memory and resolves the dream.
//
// Real reads of agent_memories; real writes on accept/answer. No mocks.

import { sql } from '../_lib/db.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { cors, json, method, readJson, wrap, error } from '../_lib/http.js';
import { requireCsrf } from '../_lib/csrf.js';
import { isUuid } from '../_lib/validate.js';
import { decorateReflection } from '../_lib/reflection.js';

async function resolveAuth(req) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id };
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) return { userId: bearer.userId };
	return null;
}

async function requireOwnedAgent(req, res, agentId, auth) {
	// Shape-check before the query: agent_identities.id is a uuid column, so a
	// non-uuid id makes Postgres raise (22P02) and the request lands as a 500
	// plus an ops alert, when the honest answer is a 400 the caller can act on.
	if (!isUuid(agentId)) {
		error(res, 400, 'validation_error', 'valid agentId required');
		return null;
	}
	const [agent] = await sql`
		SELECT id, user_id FROM agent_identities WHERE id = ${agentId} AND deleted_at IS NULL
	`;
	if (!agent) {
		error(res, 404, 'not_found', 'agent not found');
		return null;
	}
	if (agent.user_id !== auth.userId) {
		error(res, 403, 'forbidden', 'not your agent');
		return null;
	}
	return agent;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required');

	if (req.method === 'GET') return handleList(req, res, auth);
	return handleReview(req, res, auth);
});

async function handleList(req, res, auth) {
	const url = new URL(req.url, 'http://x');
	const agentId = url.searchParams.get('agentId') || url.searchParams.get('agent_id');
	const status = url.searchParams.get('status'); // pending | accepted | rejected | (all)
	const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 200);

	const agent = await requireOwnedAgent(req, res, agentId, auth);
	if (!agent) return;

	const rows = status && ['pending', 'accepted', 'rejected'].includes(status)
		? await sql`
			SELECT * FROM agent_reflections
			WHERE agent_id = ${agentId} AND status = ${status}
			ORDER BY created_at DESC
			LIMIT ${limit}
		`
		: await sql`
			SELECT * FROM agent_reflections
			WHERE agent_id = ${agentId}
			ORDER BY created_at DESC
			LIMIT ${limit}
		`;

	// Hydrate cited source memories so the UI can show + link the evidence.
	const allIds = [...new Set(rows.flatMap((r) => r.source_memory_ids || []))];
	const memRows = allIds.length
		? await sql`
			SELECT id, type, content, salience, created_at
			FROM agent_memories
			WHERE agent_id = ${agentId} AND id = ANY(${allIds}::uuid[])
		`
		: [];
	const memById = new Map(memRows.map((m) => [m.id, {
		id: m.id, type: m.type, content: m.content, salience: m.salience,
		createdAt: m.created_at instanceof Date ? m.created_at.toISOString() : m.created_at,
	}]));

	const dreams = rows.map((r) => {
		const d = decorateReflection(r);
		// A cited memory may have since been forgotten; mark it rather than drop it.
		d.sources = (d.sourceMemoryIds || []).map((id) => memById.get(id) || { id, forgotten: true });
		return d;
	});

	const [{ pending } = { pending: 0 }] = await sql`
		SELECT COUNT(*)::int AS pending FROM agent_reflections
		WHERE agent_id = ${agentId} AND status = 'pending'
	`;
	const [lastRun] = await sql`
		SELECT trigger, status, reason, dreams_created, created_at
		FROM agent_reflection_runs
		WHERE agent_id = ${agentId}
		ORDER BY created_at DESC
		LIMIT 1
	`;

	return json(res, 200, {
		dreams,
		pending,
		lastRun: lastRun
			? {
					trigger: lastRun.trigger,
					status: lastRun.status,
					reason: lastRun.reason,
					dreamsCreated: lastRun.dreams_created,
					at: lastRun.created_at instanceof Date ? lastRun.created_at.toISOString() : lastRun.created_at,
				}
			: null,
	});
}

async function handleReview(req, res, auth) {
	if (!(await requireCsrf(req, res, auth.userId))) return;

	const body = await readJson(req);
	const agentId = body?.agentId || body?.agent_id;
	const dreamId = body?.dreamId || body?.dream_id;
	const decision = body?.decision;

	if (!isUuid(dreamId)) return error(res, 400, 'validation_error', 'valid dreamId required');
	if (!['accept', 'reject', 'answer'].includes(decision)) {
		return error(res, 400, 'validation_error', "decision must be 'accept', 'reject', or 'answer'");
	}

	const agent = await requireOwnedAgent(req, res, agentId, auth);
	if (!agent) return;

	const [dream] = await sql`
		SELECT * FROM agent_reflections WHERE id = ${dreamId} AND agent_id = ${agentId}
	`;
	if (!dream) return error(res, 404, 'not_found', 'dream not found');
	if (dream.status !== 'pending') {
		return error(res, 409, 'already_reviewed', `dream already ${dream.status}`);
	}

	if (decision === 'reject') {
		// Storing the rejection is the learning signal — the engine feeds rejected
		// statements back into future passes so the synthesis isn't re-proposed.
		const [row] = await sql`
			UPDATE agent_reflections
			SET status = 'rejected', reviewed_at = now()
			WHERE id = ${dreamId} AND agent_id = ${agentId} AND status = 'pending'
			RETURNING *
		`;
		if (!row) return error(res, 409, 'already_reviewed', 'dream already reviewed');
		return json(res, 200, { dream: decorateReflection(row) });
	}

	// accept / answer both write a real memory. For 'answer', the user's reply
	// is folded into the stored fact so the agent remembers the clarification.
	let content = dream.statement;
	let answer = null;
	if (decision === 'answer') {
		answer = typeof body.answer === 'string' ? body.answer.trim() : '';
		if (!answer) return error(res, 400, 'validation_error', 'answer required for an answer decision');
		answer = answer.slice(0, 2000);
		content = `${dream.statement} (answer: ${answer})`;
	}

	const memType = ['user', 'feedback', 'project', 'reference'].includes(dream.proposed_type)
		? dream.proposed_type
		: 'project';
	const tags = ['dream', dream.kind].filter(Boolean);
	const context = {
		source: 'reflection',
		reflection_id: dream.id,
		source_memory_ids: dream.source_memory_ids || [],
		confidence: dream.confidence,
		...(answer ? { answered: true } : {}),
		...(dream.proposed_action ? { proposed_action: dream.proposed_action } : {}),
	};

	const [memory] = await sql`
		INSERT INTO agent_memories (id, agent_id, type, content, tags, context, salience, tier, pinned)
		VALUES (
			gen_random_uuid(), ${agentId}, ${memType},
			${content.slice(0, 10000)}, ${tags}, ${JSON.stringify(context)}::jsonb,
			${dream.proposed_salience}, 'recall', false
		)
		RETURNING id, type, content, salience, created_at
	`;

	const [row] = await sql`
		UPDATE agent_reflections
		SET status = 'accepted', reviewed_at = now(),
		    accepted_memory_id = ${memory.id},
		    answer = ${answer}
		WHERE id = ${dreamId} AND agent_id = ${agentId} AND status = 'pending'
		RETURNING *
	`;
	if (!row) {
		// Lost the race — another reviewer accepted/rejected first. Roll back the
		// memory we just wrote so we don't leave an orphan.
		await sql`DELETE FROM agent_memories WHERE id = ${memory.id}`;
		return error(res, 409, 'already_reviewed', 'dream already reviewed');
	}

	return json(res, 200, {
		dream: decorateReflection(row),
		memory: {
			id: memory.id,
			type: memory.type,
			content: memory.content,
			salience: memory.salience,
			createdAt: memory.created_at instanceof Date ? memory.created_at.toISOString() : memory.created_at,
		},
		// Surface the proposed automation so the UI can hand it to Autopilot (Task 08).
		proposedAction: dream.proposed_action || null,
	});
}
