// /api/autopilot/activity — the signed receipts feed (owner-only).
//
// GET ?agentId=&limit=&cursor=  → { receipts, trust, agents }
//   Every autonomous action the agent took, newest first, each with:
//     • the signed agent_actions row (signature + signer when present)
//     • its full explanation (rationale) and outcome (created rule / tx / briefing)
//     • the source memories it was grounded in (provenance), hydrated for linking
//   Omit agentId to aggregate across all of the caller's agents.
//
// This reads the real, append-only agent_actions log — the same provenance trail
// every other surface writes to. No mocks. $THREE is the only coin referenced.

import { sql } from '../_lib/db.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { cors, json, method, wrap, error } from '../_lib/http.js';
import { computeTrust, pageLimit, parseCursor } from '../_lib/autopilot.js';
import { isUuid } from '../_lib/validate.js';

const AUTOPILOT_TYPES = ['autopilot.alert.created', 'autopilot.briefing.authored', 'autopilot.wallet.transfer'];

async function resolveAuth(req) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id };
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) return { userId: bearer.userId };
	return null;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required');

	const url = new URL(req.url, 'http://x');
	const agentId = url.searchParams.get('agentId') || url.searchParams.get('agent_id');
	if (agentId && !isUuid(agentId)) return error(res, 400, 'validation_error', 'agentId must be a uuid');
	const limit = pageLimit(url.searchParams.get('limit'));
	const parsed = parseCursor(url.searchParams.get('cursor'));
	if (!parsed.ok) return error(res, 400, 'validation_error', parsed.reason);
	const cursor = parsed.cursor;

	// Resolve the set of agents to read. A specific agent must be owned by caller;
	// otherwise aggregate across all of the caller's agents.
	let agentIds;
	if (agentId) {
		const [agent] = await sql`SELECT id, user_id FROM agent_identities WHERE id = ${agentId} AND deleted_at IS NULL`;
		if (!agent) return error(res, 404, 'not_found', 'agent not found');
		if (agent.user_id !== auth.userId) return error(res, 403, 'forbidden', 'not your agent');
		agentIds = [agentId];
	} else {
		const owned = await sql`SELECT id FROM agent_identities WHERE user_id = ${auth.userId} AND deleted_at IS NULL`;
		agentIds = owned.map((a) => a.id);
	}

	// A caller with no agents yet has nothing to read: answer before touching the log.
	if (!agentIds.length) {
		return json(res, 200, { receipts: [], next_cursor: null, agents: [], trust: null });
	}

	const agents = await sql`
		SELECT id, name, avatar_id FROM agent_identities WHERE id = ANY(${agentIds}::uuid[])
	`;
	const agentById = new Map(agents.map((a) => [a.id, { id: a.id, name: a.name, avatarId: a.avatar_id }]));

	const rows = cursor
		? await sql`
			SELECT * FROM agent_actions
			WHERE agent_id = ANY(${agentIds}::uuid[]) AND type = ANY(${AUTOPILOT_TYPES}) AND id < ${cursor}
			ORDER BY id DESC LIMIT ${limit + 1}`
		: await sql`
			SELECT * FROM agent_actions
			WHERE agent_id = ANY(${agentIds}::uuid[]) AND type = ANY(${AUTOPILOT_TYPES})
			ORDER BY id DESC LIMIT ${limit + 1}`;

	const hasMore = rows.length > limit;
	const page = hasMore ? rows.slice(0, limit) : rows;
	const nextCursor = hasMore ? String(page[page.length - 1].id) : null;

	// Hydrate the cited source memories across the page so the UI can link them.
	const memIds = [...new Set(page.flatMap((r) => (r.payload?.source_memory_ids || [])))];
	const memRows = memIds.length
		? await sql`SELECT id, agent_id, type, content, salience FROM agent_memories WHERE id = ANY(${memIds}::uuid[])`
		: [];
	const memById = new Map(memRows.map((m) => [m.id, { id: m.id, agentId: m.agent_id, type: m.type, content: m.content, salience: Number(m.salience) }]));

	const receipts = page.map((r) => {
		const p = r.payload || {};
		return {
			id: String(r.id),
			agentId: r.agent_id,
			agent: agentById.get(r.agent_id) || { id: r.agent_id, name: 'Agent' },
			type: r.type,
			kind: r.type.replace('autopilot.', '').replace('.', '_'),
			rationale: p.rationale || null,
			result: stripProvenance(p),
			proposalId: p.proposal_id || null,
			sourceReflectionId: p.source_reflection_id || null,
			sources: (p.source_memory_ids || []).map((id) => memById.get(id) || { id, forgotten: true }),
			signed: Boolean(r.signature),
			signature: r.signature || null,
			signerAddress: r.signer_address || null,
			at: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
		};
	});

	const trust = agentId ? await computeTrust({ agentId }) : null;
	return json(res, 200, { receipts, next_cursor: nextCursor, agents: [...agentById.values()], trust });
});

// The receipt's "what happened" — payload minus the provenance fields the UI
// renders separately (rationale + source ids + ids/ts).
const PROVENANCE_KEYS = new Set(['rationale', 'source_memory_ids', 'source_reflection_id', 'proposal_id', 'ts']);
function stripProvenance(payload) {
	const out = {};
	for (const [k, v] of Object.entries(payload || {})) if (!PROVENANCE_KEYS.has(k)) out[k] = v;
	return out;
}
