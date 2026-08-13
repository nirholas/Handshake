/**
 * Memory curation (P2 — Memory Studio)
 * ------------------------------------
 * The trust surface: pin to the working core, retier, adjust salience, edit,
 * merge duplicates, and forget — all owner-only, all persisted.
 *
 * POST /api/memory/curate { agentId, op, ... }
 *   op = 'pin'      { memoryId }                       → tier=working, pinned=true
 *   op = 'unpin'    { memoryId }                       → pinned=false, tier=recall
 *   op = 'tier'     { memoryId, tier }                 → working|recall|archival
 *   op = 'salience' { memoryId, salience }             → 0..1
 *   op = 'edit'     { memoryId, content?, tags? }      → re-embeds + re-mines
 *   op = 'merge'    { memoryIds:[target, ...dupes] }   → fold dupes into target
 *   op = 'forget'   { memoryId }                       → delete
 *
 * CSRF-gated.
 */

import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { sql } from '../_lib/db.js';
import { cors, json, method, readJson, wrap, error } from '../_lib/http.js';
import { requireCsrf } from '../_lib/csrf.js';
import { MEMORY_TIERS, decorateMemory } from '../_lib/memory-store.js';
import { isUuid } from '../_lib/validate.js';

// A merge folds a handful of duplicates into one target. Bounding it keeps a
// runaway caller from building a multi-megabyte `id = ANY(...)` statement.
const MERGE_MAX_IDS = 50;

async function resolveAuth(req) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id };
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) return { userId: bearer.userId };
	return null;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required');
	if (!(await requireCsrf(req, res, auth.userId))) return;

	const body = await readJson(req);
	const agentId = body.agentId || body.agent_id;
	const op = body.op;
	if (!agentId) return error(res, 400, 'validation_error', 'agentId required');
	// Every id below addresses a uuid column: reject unparseable input here rather
	// than letting Postgres raise 22P02 and turn a caller mistake into a 500.
	if (!isUuid(agentId)) return error(res, 400, 'validation_error', 'agentId must be a uuid');
	if (!op) return error(res, 400, 'validation_error', 'op required');

	const [agentRow] = await sql`
		SELECT user_id FROM agent_identities WHERE id = ${agentId} AND deleted_at IS NULL
	`;
	if (!agentRow) return error(res, 404, 'not_found', 'agent not found');
	if (agentRow.user_id !== auth.userId) return error(res, 403, 'forbidden', 'not your agent');

	const memoryId = body.memoryId;
	if (memoryId != null && !isUuid(memoryId)) return error(res, 400, 'validation_error', 'memoryId must be a uuid');

	switch (op) {
		case 'pin': {
			if (!memoryId) return error(res, 400, 'validation_error', 'memoryId required');
			return respondRow(res, await sql`
				UPDATE agent_memories SET pinned = true, tier = 'working', updated_at = now()
				WHERE id = ${memoryId} AND agent_id = ${agentId}
				RETURNING id, agent_id, type, content, tags, context, salience, tier, pinned, embedder,
				          (embedding IS NOT NULL) AS has_embedding, access_count, is_public,
				          created_at, updated_at, last_accessed_at, expires_at
			`);
		}
		case 'unpin': {
			if (!memoryId) return error(res, 400, 'validation_error', 'memoryId required');
			return respondRow(res, await sql`
				UPDATE agent_memories SET pinned = false, tier = 'recall', updated_at = now()
				WHERE id = ${memoryId} AND agent_id = ${agentId}
				RETURNING id, agent_id, type, content, tags, context, salience, tier, pinned, embedder,
				          (embedding IS NOT NULL) AS has_embedding, access_count, is_public,
				          created_at, updated_at, last_accessed_at, expires_at
			`);
		}
		case 'tier': {
			if (!memoryId) return error(res, 400, 'validation_error', 'memoryId required');
			if (!MEMORY_TIERS.includes(body.tier)) return error(res, 400, 'validation_error', 'invalid tier');
			return respondRow(res, await sql`
				UPDATE agent_memories
				SET tier = ${body.tier},
				    pinned = CASE WHEN ${body.tier} = 'working' THEN true ELSE pinned END,
				    updated_at = now()
				WHERE id = ${memoryId} AND agent_id = ${agentId}
				RETURNING id, agent_id, type, content, tags, context, salience, tier, pinned, embedder,
				          (embedding IS NOT NULL) AS has_embedding, access_count, is_public,
				          created_at, updated_at, last_accessed_at, expires_at
			`);
		}
		case 'salience': {
			if (!memoryId) return error(res, 400, 'validation_error', 'memoryId required');
			const s = Number(body.salience);
			if (!Number.isFinite(s) || s < 0 || s > 1) return error(res, 400, 'validation_error', 'salience must be 0..1');
			return respondRow(res, await sql`
				UPDATE agent_memories SET salience = ${s}, updated_at = now()
				WHERE id = ${memoryId} AND agent_id = ${agentId}
				RETURNING id, agent_id, type, content, tags, context, salience, tier, pinned, embedder,
				          (embedding IS NOT NULL) AS has_embedding, access_count, is_public,
				          created_at, updated_at, last_accessed_at, expires_at
			`);
		}
		case 'edit':
			return handleEdit(res, agentId, body);
		case 'merge':
			return handleMerge(res, agentId, body);
		case 'forget': {
			if (!memoryId) return error(res, 400, 'validation_error', 'memoryId required');
			const [row] = await sql`
				DELETE FROM agent_memories WHERE id = ${memoryId} AND agent_id = ${agentId} RETURNING id
			`;
			if (!row) return error(res, 404, 'not_found', 'memory not found');
			return json(res, 200, { ok: true, forgot: row.id });
		}
		default:
			return error(res, 400, 'validation_error', `unknown op: ${op}`);
	}
});

function respondRow(res, rows) {
	const row = rows?.[0];
	if (!row) return error(res, 404, 'not_found', 'memory not found');
	return json(res, 200, { entry: decorateMemory(row) });
}

async function handleEdit(res, agentId, body) {
	if (!body.memoryId) return error(res, 400, 'validation_error', 'memoryId required');
	const hasContent = typeof body.content === 'string';
	const hasTags = Array.isArray(body.tags);
	if (!hasContent && !hasTags) return error(res, 400, 'validation_error', 'content or tags required');

	const content = hasContent ? body.content.slice(0, 10000) : null;
	const tags = hasTags ? body.tags.map((t) => String(t).slice(0, 100)).slice(0, 30) : null;

	// Changing content invalidates the vector + extracted entities — null them so
	// the lazy read-path re-embeds and re-mines.
	const [row] = await sql`
		UPDATE agent_memories SET
			content = COALESCE(${content}, content),
			tags = COALESCE(${tags}::text[], tags),
			embedding = CASE WHEN ${content}::text IS NOT NULL AND content IS DISTINCT FROM ${content}
			                 THEN NULL ELSE embedding END,
			entities_extracted = CASE WHEN ${content}::text IS NOT NULL AND content IS DISTINCT FROM ${content}
			                 THEN false ELSE entities_extracted END,
			updated_at = now()
		WHERE id = ${body.memoryId} AND agent_id = ${agentId}
		RETURNING id, agent_id, type, content, tags, context, salience, tier, pinned, embedder,
		          (embedding IS NOT NULL) AS has_embedding, access_count, is_public,
		          created_at, updated_at, last_accessed_at, expires_at
	`;
	if (!row) return error(res, 404, 'not_found', 'memory not found');
	// Editing tags also changes the entity surface — re-mine on next graph read.
	// Stays agent-scoped like every other write here so no curation statement can
	// ever address a row outside the agent the caller was authorized for.
	if (hasTags) {
		await sql`
			UPDATE agent_memories SET entities_extracted = false
			WHERE id = ${body.memoryId} AND agent_id = ${agentId}
		`;
	}
	return json(res, 200, { entry: decorateMemory(row) });
}

async function handleMerge(res, agentId, body) {
	// Dedupe before counting: a caller that repeats the target ("merge a into a")
	// must not end up with the target listed among its own duplicates, which would
	// delete the row the merge just wrote.
	const ids = [...new Set(Array.isArray(body.memoryIds) ? body.memoryIds.filter(Boolean) : [])];
	const badId = ids.find((id) => !isUuid(id));
	if (badId) return error(res, 400, 'validation_error', 'memoryIds must be uuids');
	if (ids.length < 2) return error(res, 400, 'validation_error', 'merge needs at least 2 distinct memoryIds');
	if (ids.length > MERGE_MAX_IDS) {
		return error(res, 400, 'validation_error', `merge accepts at most ${MERGE_MAX_IDS} memoryIds`);
	}
	const [targetId, ...dupeIds] = ids;

	const rows = await sql`
		SELECT id, content, tags, salience, type FROM agent_memories
		WHERE id = ANY(${ids}::uuid[]) AND agent_id = ${agentId}
	`;
	if (rows.length < 2) return error(res, 404, 'not_found', 'memories not found');

	const byId = new Map(rows.map((r) => [r.id, r]));
	const target = byId.get(targetId);
	if (!target) return error(res, 404, 'not_found', 'target memory not found');

	// Fold: union the distinct contents (keep target first), union tags, take the
	// max salience. Reset the vector + entities so the merged memory re-indexes.
	const seenContent = new Set();
	const contents = [];
	for (const id of ids) {
		const r = byId.get(id);
		if (!r) continue;
		const c = String(r.content || '').trim();
		if (c && !seenContent.has(c)) { seenContent.add(c); contents.push(c); }
	}
	const mergedContent = contents.join('\n\n').slice(0, 10000);
	const mergedTags = [...new Set(rows.flatMap((r) => r.tags || []))].slice(0, 30);
	const mergedSalience = Math.max(...rows.map((r) => r.salience || 0));

	const presentDupes = dupeIds.filter((id) => byId.has(id));
	const [updated] = await sql`
		UPDATE agent_memories SET
			content = ${mergedContent},
			tags = ${mergedTags},
			salience = ${mergedSalience},
			embedding = NULL,
			entities_extracted = false,
			updated_at = now()
		WHERE id = ${targetId} AND agent_id = ${agentId}
		RETURNING id, agent_id, type, content, tags, context, salience, tier, pinned, embedder,
		          (embedding IS NOT NULL) AS has_embedding, access_count, is_public,
		          created_at, updated_at, last_accessed_at, expires_at
	`;
	if (presentDupes.length) {
		await sql`DELETE FROM agent_memories WHERE id = ANY(${presentDupes}::uuid[]) AND agent_id = ${agentId}`;
	}
	return json(res, 200, { entry: decorateMemory(updated), merged: presentDupes.length });
}
