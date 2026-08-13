/**
 * Working context + token budget (P2 — Memory Studio)
 * ---------------------------------------------------
 * "What's in context right now" — the working-tier + pinned memories the agent
 * always carries, with a live token-budget accounting so the owner can see (and
 * trust) exactly what shapes every reply, and whether the core has overflowed.
 *
 * GET /api/memory/context?agentId=
 *
 * Owner-only. Anonymous → empty/zeroed context.
 */

import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { sql } from '../_lib/db.js';
import { cors, json, method, wrap, error } from '../_lib/http.js';
import { computeContext, WORKING_TOKEN_BUDGET } from '../_lib/memory-store.js';
import { isUuid } from '../_lib/validate.js';

async function resolveAuth(req) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id };
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) return { userId: bearer.userId };
	return null;
}

const EMPTY = {
	entries: [],
	tokens: 0,
	budget: WORKING_TOKEN_BUDGET,
	overBudget: false,
	counts: { total: 0, working: 0, recall: 0, archival: 0, embedded: 0 },
};

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const url = new URL(req.url, 'http://x');
	const agentId = url.searchParams.get('agentId') || url.searchParams.get('agent_id');
	if (!agentId) return error(res, 400, 'validation_error', 'agentId required');
	// agent_identities.id is a uuid column: an unparseable id would otherwise reach
	// Postgres and 500 (22P02) instead of telling the caller their input is wrong.
	if (!isUuid(agentId)) return error(res, 400, 'validation_error', 'agentId must be a uuid');

	const auth = await resolveAuth(req);
	if (!auth) return json(res, 200, EMPTY);

	const [row] = await sql`
		SELECT user_id FROM agent_identities WHERE id = ${agentId} AND deleted_at IS NULL
	`;
	if (!row || row.user_id !== auth.userId) return json(res, 200, EMPTY);

	const ctx = await computeContext(agentId);
	return json(res, 200, ctx);
});
