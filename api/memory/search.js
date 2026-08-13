/**
 * Memory semantic search (P2 — Memory Studio)
 * -------------------------------------------
 * The mem0 search() surface over the tiered store. Embeds the query in each
 * stored vector space and returns ranked memories with real cosine scores; falls
 * back to substring + salience when no embedding provider is configured.
 *
 * GET  /api/memory/search?agentId=&q=&topK=&minScore=&tier=working,recall  — recall
 *      (used by the Brain Memory node; cookie auth, no CSRF, side effects are
 *       only the agent-owner's own access counters)
 * POST /api/memory/search { agentId, query, topK, minScore, tiers, type }   — studio
 *
 * Owner-only. Anonymous GET returns an empty result set (keeps embed consoles clean).
 */

import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { sql } from '../_lib/db.js';
import { cors, json, method, readJson, wrap, error } from '../_lib/http.js';
import { requireCsrf } from '../_lib/csrf.js';
import { searchMemories, MEMORY_TIERS, MEMORY_TYPES } from '../_lib/memory-store.js';
import { isUuid } from '../_lib/validate.js';

async function resolveAuth(req) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id };
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) return { userId: bearer.userId };
	return null;
}

async function ownsAgent(agentId, userId) {
	if (!agentId || !userId) return false;
	const [row] = await sql`
		SELECT user_id FROM agent_identities WHERE id = ${agentId} AND deleted_at IS NULL
	`;
	return !!row && row.user_id === userId;
}

// Accepts a comma-separated string or an array. Returns { tiers, invalid }: an
// unknown tier is reported so the caller can 400, because silently dropping it
// would filter the search down to nothing and read as "no memories".
function parseTiers(raw) {
	if (!raw) return { tiers: null, invalid: [] };
	const list = (Array.isArray(raw) ? raw : String(raw).split(','))
		.map((s) => String(s).trim())
		.filter(Boolean);
	const invalid = list.filter((t) => !MEMORY_TIERS.includes(t));
	return { tiers: list.length ? list : null, invalid };
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	const auth = await resolveAuth(req);

	if (req.method === 'GET') {
		const url = new URL(req.url, 'http://x');
		const agentId = url.searchParams.get('agentId') || url.searchParams.get('agent_id');
		const query = url.searchParams.get('q') || url.searchParams.get('query') || '';
		if (!agentId) return error(res, 400, 'validation_error', 'agentId required');
		// agent_identities.id is a uuid column: reject unparseable input here rather
		// than letting Postgres raise 22P02 and turn a caller mistake into a 500.
		if (!isUuid(agentId)) return error(res, 400, 'validation_error', 'agentId must be a uuid');
		const { tiers, invalid } = parseTiers(url.searchParams.get('tier'));
		if (invalid.length) return error(res, 400, 'validation_error', `unknown tier: ${invalid.join(', ')}`);
		const type = url.searchParams.get('type') || undefined;
		if (type && !MEMORY_TYPES.includes(type)) return error(res, 400, 'validation_error', `unknown type: ${type}`);
		// Anonymous / non-owner → empty (no leak, no console noise on public embeds).
		if (!auth || !(await ownsAgent(agentId, auth.userId))) return json(res, 200, { results: [] });

		const out = await searchMemories(agentId, query, {
			topK: clampInt(url.searchParams.get('topK'), 8, 1, 50),
			minScore: clampFloat(url.searchParams.get('minScore'), 0.25, 0, 1),
			tiers,
			type,
		});
		return json(res, 200, out);
	}

	// POST — studio search (CSRF-gated).
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required');
	if (!(await requireCsrf(req, res, auth.userId))) return;

	const body = await readJson(req);
	const agentId = body.agentId || body.agent_id;
	if (!agentId) return error(res, 400, 'validation_error', 'agentId required');
	if (!isUuid(agentId)) return error(res, 400, 'validation_error', 'agentId must be a uuid');
	const { tiers, invalid } = parseTiers(body.tiers);
	if (invalid.length) return error(res, 400, 'validation_error', `unknown tier: ${invalid.join(', ')}`);
	const type = body.type || undefined;
	if (type && !MEMORY_TYPES.includes(type)) return error(res, 400, 'validation_error', `unknown type: ${type}`);
	if (!(await ownsAgent(agentId, auth.userId))) return error(res, 403, 'forbidden', 'not your agent');

	const out = await searchMemories(agentId, String(body.query || ''), {
		topK: clampInt(body.topK, 8, 1, 50),
		minScore: clampFloat(body.minScore, 0.25, 0, 1),
		tiers,
		type,
	});
	return json(res, 200, out);
});

function clampInt(v, dflt, min, max) {
	const n = Number(v);
	if (!Number.isFinite(n)) return dflt;
	return Math.min(max, Math.max(min, Math.round(n)));
}
function clampFloat(v, dflt, min, max) {
	const n = Number(v);
	if (!Number.isFinite(n)) return dflt;
	return Math.min(max, Math.max(min, n));
}
