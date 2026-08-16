/**
 * Agent Memory Sync
 * -----------------
 * Backend sync target for agent memories.
 * LocalStorage is the primary store — this is the durable backup.
 *
 * GET    /api/agent-memory?agentId=    — fetch agent's memories (owner only)
 * POST   /api/agent-memory             — store / upsert a memory entry
 * DELETE /api/agent-memory/:id         — forget a memory
 */

import { getSessionUser, authenticateBearer, extractBearer } from './_lib/auth.js';
import { sql } from './_lib/db.js';
import { cors, json, method, readJson, wrap, error } from './_lib/http.js';
import { requireCsrf } from './_lib/csrf.js';
import { isUuid } from './_lib/validate.js';
import { decorateMemory, defaultTier, MEMORY_TIERS } from './_lib/memory-store.js';
import { signMemoryWithAgent } from './_lib/brain-sign.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,DELETE,OPTIONS', credentials: true })) return;

	const url = new URL(req.url, 'http://x');
	const pathId = url.pathname.split('/').pop(); // /api/agent-memory/:id

	// DELETE /api/agent-memory/:id
	if (req.method === 'DELETE' && pathId && pathId !== 'agent-memory') {
		return handleDelete(req, res, pathId);
	}

	if (!method(req, res, ['GET', 'POST'])) return;
	if (req.method === 'GET') return handleList(req, res);
	return handleUpsert(req, res);
});

// ── List ──────────────────────────────────────────────────────────────────

async function handleList(req, res) {
	const auth = await resolveAuth(req);
	// Public embeds boot this fetch on every page load. Returning an empty
	// list (instead of 401) for anonymous viewers keeps the console clean
	// without leaking memories — only owners ever see entries.
	if (!auth) return json(res, 200, { entries: [] });

	const url = new URL(req.url, 'http://x');
	const agentId = url.searchParams.get('agentId') || url.searchParams.get('agent_id');
	const type = url.searchParams.get('type');
	// Both are interpolated straight into SQL (`since` through a Date, `limit`
	// into LIMIT), so clamp them into ranges Postgres and Date accept. Unclamped,
	// `?since=1e18` threw a RangeError out of toISOString() and `?limit=-1` made
	// Postgres reject the LIMIT: two client typos that answered 500.
	const MAX_EPOCH_MS = 8.64e15; // the ECMAScript time-value ceiling
	const sinceRaw = Number(url.searchParams.get('since'));
	const since = Number.isFinite(sinceRaw) ? Math.min(Math.max(sinceRaw, 0), MAX_EPOCH_MS) : 0;
	const limitRaw = Number(url.searchParams.get('limit'));
	const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 500) : 200;

	if (!agentId) return error(res, 400, 'validation_error', 'agentId required');
	// agent_identities.id is a uuid column: a non-uuid agentId reaches Postgres as
	// an uncastable literal and returns as a 500 ("invalid input syntax for type
	// uuid"). That is a caller mistake, so answer it as one (same rule as
	// api/agent-actions.js).
	if (!isUuid(agentId)) return error(res, 400, 'validation_error', 'agentId must be a uuid');

	// Verify ownership
	const [agentRow] = await sql`
		SELECT user_id FROM agent_identities WHERE id = ${agentId} AND deleted_at IS NULL
	`;
	if (!agentRow) return json(res, 200, { entries: [] });
	if (agentRow.user_id !== auth.userId) return json(res, 200, { entries: [] });

	const rows = type
		? await sql`
			SELECT id, agent_id, type, content, tags, context, salience, tier, pinned, embedder,
			       (embedding IS NOT NULL) AS has_embedding, access_count, is_public,
			       content_hash, signature, signer_address, signed_at, storage_mode, ipfs_cid,
			       created_at, updated_at, last_accessed_at, expires_at
			FROM agent_memories
			WHERE agent_id = ${agentId}
			  AND type = ${type}
			  AND (expires_at IS NULL OR expires_at > now())
			  AND created_at > ${new Date(since).toISOString()}
			ORDER BY salience DESC, created_at DESC
			LIMIT ${limit}
		`
		: await sql`
			SELECT id, agent_id, type, content, tags, context, salience, tier, pinned, embedder,
			       (embedding IS NOT NULL) AS has_embedding, access_count, is_public,
			       content_hash, signature, signer_address, signed_at, storage_mode, ipfs_cid,
			       created_at, updated_at, last_accessed_at, expires_at
			FROM agent_memories
			WHERE agent_id = ${agentId}
			  AND (expires_at IS NULL OR expires_at > now())
			  AND created_at > ${new Date(since).toISOString()}
			ORDER BY salience DESC, created_at DESC
			LIMIT ${limit}
		`;

	return json(res, 200, { entries: rows.map((r) => decorateMemory(r)) });
}

// ── Upsert ────────────────────────────────────────────────────────────────

async function handleUpsert(req, res) {
	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required');
	if (!(await requireCsrf(req, res, auth.userId))) return;

	const body = await readJson(req);
	const agentId = body.agentId || body.agent_id;
	const entry = body.entry;

	if (!agentId) return error(res, 400, 'validation_error', 'agentId required');
	if (!isUuid(agentId)) return error(res, 400, 'validation_error', 'agentId must be a uuid');
	if (!entry || typeof entry !== 'object' || Array.isArray(entry))
		return error(res, 400, 'validation_error', 'entry must be an object');
	// entry.id lands in a uuid primary key. A client-generated non-uuid id used to
	// fail as a 500 instead of telling the client its id is unusable.
	if (entry.id != null && !isUuid(entry.id))
		return error(res, 400, 'validation_error', 'entry.id must be a uuid');
	const createdAt = toIso(entry.createdAt);
	const updatedAt = toIso(entry.updatedAt);
	const expiresAt = toIso(entry.expiresAt);
	if (createdAt === INVALID_DATE || updatedAt === INVALID_DATE || expiresAt === INVALID_DATE)
		return error(res, 400, 'validation_error', 'timestamps must be ISO dates or epoch milliseconds');

	// Verify ownership
	const [agentRow] = await sql`
		SELECT user_id FROM agent_identities WHERE id = ${agentId} AND deleted_at IS NULL
	`;
	if (!agentRow) return error(res, 404, 'not_found', 'agent not found');
	if (agentRow.user_id !== auth.userId) return error(res, 403, 'forbidden', 'not your agent');

	const validTypes = ['user', 'feedback', 'project', 'reference'];
	const memType = validTypes.includes(entry.type) ? entry.type : 'project';

	// salience is a numeric column and tags a text[]: a caller sending a string
	// salience or a non-array tags value made Postgres reject the INSERT. Coerce
	// both to something the column accepts rather than 500 on a sloppy client.
	const salienceRaw = Number(entry.salience);
	const salience = Number.isFinite(salienceRaw) ? Math.min(Math.max(salienceRaw, 0), 1) : 0.5;
	const tags = Array.isArray(entry.tags)
		? entry.tags.filter((t) => typeof t === 'string').slice(0, 32)
		: [];
	const pinned = entry.pinned === true;
	const tier = MEMORY_TIERS.includes(entry.tier)
		? entry.tier
		: defaultTier({ pinned, salience, type: memType });

	// Upsert by id (idempotent — local storage may resync the same entry).
	// The WHERE clause on ON CONFLICT is critical: IDs come from the client,
	// so without it, user B could write an entry with user A's memory id and
	// the conflict would overwrite A's content. Constrain updates to rows
	// belonging to the same agent (ownership already verified above).
	//
	// When an upsert changes the content, the stored vector + extracted entities
	// are stale — reset both so the lazy read-path pipeline re-embeds and
	// re-mines the row (this is what makes an edited memory re-index itself).
	const now = new Date().toISOString();
	const entryUpdatedAt = updatedAt || now;

	const [row] = entry.id
		? await sql`
			INSERT INTO agent_memories (id, agent_id, type, content, tags, context, salience, tier, pinned, created_at, expires_at, updated_at)
			VALUES (
				${entry.id},
				${agentId},
				${memType},
				${String(entry.content || '').slice(0, 10000)},
				${tags},
				${JSON.stringify(entry.context || {})}::jsonb,
				${salience},
				${tier},
				${pinned},
				${createdAt || now},
				${expiresAt},
				${entryUpdatedAt}
			)
			ON CONFLICT (id) DO UPDATE SET
				content    = EXCLUDED.content,
				salience   = EXCLUDED.salience,
				tier       = EXCLUDED.tier,
				pinned     = EXCLUDED.pinned,
				expires_at = EXCLUDED.expires_at,
				updated_at = EXCLUDED.updated_at,
				embedding  = CASE WHEN agent_memories.content IS DISTINCT FROM EXCLUDED.content
				                  THEN NULL ELSE agent_memories.embedding END,
				entities_extracted = CASE WHEN agent_memories.content IS DISTINCT FROM EXCLUDED.content
				                  THEN false ELSE agent_memories.entities_extracted END
			WHERE agent_memories.agent_id = EXCLUDED.agent_id
			RETURNING *
		`
		: await sql`
			INSERT INTO agent_memories (agent_id, type, content, tags, context, salience, tier, pinned, expires_at, updated_at)
			VALUES (
				${agentId},
				${memType},
				${String(entry.content || '').slice(0, 10000)},
				${tags},
				${JSON.stringify(entry.context || {})}::jsonb,
				${salience},
				${tier},
				${pinned},
				${expiresAt},
				${entryUpdatedAt}
			)
			RETURNING *
		`;

	// Empty row means an ID collision with a row owned by another agent was
	// suppressed by the ON CONFLICT WHERE guard. Report a conflict so the
	// client generates a new ID instead of silently losing the write.
	if (!row) return error(res, 409, 'id_conflict', 'memory id already in use');

	// Sign the committed memory with the agent's wallet (ERC-191) so its
	// authorship + integrity are publicly verifiable. Best-effort: an agent
	// without a provisioned wallet stores the memory unsigned (with its
	// content_hash) rather than failing the write — verification reports that
	// honestly. The signature must cover the *final* row (real id + created_at),
	// so we sign after the insert and fold the result into the row we return.
	let signed = { content_hash: undefined, signature: undefined, signer_address: undefined, signed_at: undefined };
	try {
		signed = await signMemoryWithAgent(row);
	} catch (err) {
		console.error('[agent-memory] signing failed', row.id, err?.message);
	}

	return json(res, 201, {
		entry: decorateMemory({
			...row,
			content_hash: signed.content_hash ?? row.content_hash,
			signature: signed.signature ?? row.signature ?? null,
			signer_address: signed.signer_address ?? row.signer_address ?? null,
			signed_at: signed.signed_at ?? row.signed_at ?? null,
		}),
	});
}

// ── Delete ────────────────────────────────────────────────────────────────

async function handleDelete(req, res, memoryId) {
	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required');
	if (!(await requireCsrf(req, res, auth.userId))) return;
	// agent_memories.id is a uuid column; a non-uuid path segment is a 404, not a
	// 500 from an uncastable literal.
	if (!isUuid(memoryId)) return error(res, 404, 'not_found', 'memory not found');

	const [row] = await sql`
		SELECT m.id, a.user_id
		FROM agent_memories m
		JOIN agent_identities a ON a.id = m.agent_id
		WHERE m.id = ${memoryId}
	`;

	if (!row) return error(res, 404, 'not_found', 'memory not found');
	if (row.user_id !== auth.userId) return error(res, 403, 'forbidden', 'not your memory');

	await sql`DELETE FROM agent_memories WHERE id = ${memoryId}`;
	return json(res, 200, { ok: true });
}

// ── Helpers ───────────────────────────────────────────────────────────────

async function resolveAuth(req) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id };
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) return { userId: bearer.userId };
	return null;
}

// Sentinel so callers can tell "the client sent a timestamp we cannot parse"
// (a 400) apart from "the client sent no timestamp" (use the server clock).
const INVALID_DATE = Symbol('invalid_date');

/**
 * Normalize a client timestamp to an ISO string for a timestamptz column.
 * Accepts an ISO string or epoch milliseconds; anything else is rejected rather
 * than thrown, because `new Date('nope').toISOString()` is a RangeError and a
 * client typo must never surface as a 500.
 * @param {unknown} value
 * @returns {string|null|typeof INVALID_DATE}
 */
function toIso(value) {
	if (value == null || value === '') return null;
	if (typeof value !== 'string' && typeof value !== 'number') return INVALID_DATE;
	const d = new Date(value);
	return Number.isNaN(d.getTime()) ? INVALID_DATE : d.toISOString();
}
