/**
 * Agent Action Log
 * ----------------
 * Append-only history of every agent action.
 * Actions can optionally be signed with ERC-191 for on-chain verifiability.
 * Once written, actions are never deleted — this is the agent's provenance trail.
 *
 * GET  /api/agent-actions?agent_id=&limit=&cursor=
 * POST /api/agent-actions
 */

import { getSessionUser, authenticateBearer, extractBearer } from './_lib/auth.js';
import { sql } from './_lib/db.js';
import { isUuid } from './_lib/validate.js';
import { cors, json, method, readJson, wrap, error, rateLimited } from './_lib/http.js';
import { requireCsrf } from './_lib/csrf.js';
import { limits } from './_lib/rate-limit.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	if (req.method === 'GET') return handleList(req, res);
	return handleAppend(req, res);
});

// ── List ──────────────────────────────────────────────────────────────────

async function handleList(req, res) {
	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required');

	const url = new URL(req.url, 'http://x');
	const agentId = url.searchParams.get('agent_id');
	const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 200);
	const cursorRaw = url.searchParams.get('cursor');
	if (cursorRaw != null && !/^\d+$/.test(cursorRaw))
		return error(res, 400, 'validation_error', 'cursor must be a numeric id');
	const cursor = cursorRaw || null; // bigserial id cursor

	if (!agentId) return error(res, 400, 'validation_error', 'agent_id is required');
	// agent_identities.id is a uuid column, so a non-uuid agent_id reaches Postgres
	// as an uncastable literal and comes back as a 500 ("invalid input syntax for
	// type uuid"). That is a caller mistake, not a server fault: answer it as one.
	if (!isUuid(agentId))
		return error(res, 400, 'validation_error', 'agent_id must be a uuid');

	// Verify caller owns this agent
	const [agentRow] = await sql`
		SELECT user_id FROM agent_identities
		WHERE id = ${agentId} AND deleted_at IS NULL
	`;
	if (!agentRow) return error(res, 404, 'not_found', 'agent not found');
	if (agentRow.user_id !== auth.userId) return error(res, 403, 'forbidden', 'not your agent');

	const rows = cursor
		? await sql`
			SELECT * FROM agent_actions
			WHERE agent_id = ${agentId} AND id < ${cursor}
			ORDER BY id DESC
			LIMIT ${limit + 1}
		`
		: await sql`
			SELECT * FROM agent_actions
			WHERE agent_id = ${agentId}
			ORDER BY id DESC
			LIMIT ${limit + 1}
		`;

	const hasMore = rows.length > limit;
	const actions = hasMore ? rows.slice(0, limit) : rows;
	const nextCursor = hasMore ? String(actions[actions.length - 1].id) : null;

	return json(res, 200, { actions: actions.map(decorate), next_cursor: nextCursor });
}

// ── Append ────────────────────────────────────────────────────────────────

async function handleAppend(req, res) {
	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required');
	// Cookie sessions need a CSRF token; bearer callers are exempt inside requireCsrf.
	if (!(await requireCsrf(req, res, auth.userId))) return;

	const rl = await limits.agentActionAppend(auth.userId);
	if (!rl.success) return rateLimited(res, rl, 'too many actions, slow down');

	const body = await readJson(req, 32_000);

	if (!body.agent_id) return error(res, 400, 'validation_error', 'agent_id required');
	if (!isUuid(body.agent_id))
		return error(res, 400, 'validation_error', 'agent_id must be a uuid');
	if (!body.type) return error(res, 400, 'validation_error', 'type required');

	// Verify ownership
	const [agentRow] = await sql`
		SELECT user_id FROM agent_identities
		WHERE id = ${body.agent_id} AND deleted_at IS NULL
	`;
	if (!agentRow) return error(res, 404, 'not_found', 'agent not found');
	if (agentRow.user_id !== auth.userId) return error(res, 403, 'forbidden', 'not your agent');

	const [action] = await sql`
		INSERT INTO agent_actions (agent_id, type, payload, source_skill, signature, signer_address)
		VALUES (
			${body.agent_id},
			${String(body.type).slice(0, 64)},
			${JSON.stringify(body.payload || {})}::jsonb,
			${body.source_skill || null},
			${body.signature || null},
			${body.signer_address || null}
		)
		RETURNING *
	`;

	return json(res, 201, { action: decorate(action) });
}

// ── Helpers ───────────────────────────────────────────────────────────────

async function resolveAuth(req) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id };
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) return { userId: bearer.userId };
	return null;
}

function decorate(row) {
	return {
		id: String(row.id),
		agent_id: row.agent_id,
		type: row.type,
		payload: row.payload,
		source_skill: row.source_skill,
		signature: row.signature,
		signer_address: row.signer_address,
		created_at: row.created_at,
	};
}
