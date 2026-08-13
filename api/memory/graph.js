/**
 * Memory knowledge graph (P2 — Memory Studio)
 * -------------------------------------------
 * The Zep/Graphiti-style temporal knowledge graph: entities (mints, tickers,
 * wallets, people, strategies, topics) the agent's memories mention, plus
 * co-occurrence edges. Lazily mines any not-yet-processed memories on read.
 *
 * GET /api/memory/graph?agentId=                 — full graph (nodes + edges)
 * GET /api/memory/graph?agentId=&entityId=       — memories mentioning one entity
 *
 * Owner-only. Anonymous → empty graph.
 */

import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { sql } from '../_lib/db.js';
import { cors, json, method, wrap, error } from '../_lib/http.js';
import { buildGraph, memoriesForEntity } from '../_lib/memory-store.js';
import { isUuid } from '../_lib/validate.js';

async function resolveAuth(req) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id };
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) return { userId: bearer.userId };
	return null;
}

const EMPTY_GRAPH = { nodes: [], edges: [], stats: { entities: 0, edges: 0 } };

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const url = new URL(req.url, 'http://x');
	const agentId = url.searchParams.get('agentId') || url.searchParams.get('agent_id');
	const entityId = url.searchParams.get('entityId');
	if (!agentId) return error(res, 400, 'validation_error', 'agentId required');
	// Both ids address uuid columns: reject unparseable input here rather than
	// letting Postgres raise 22P02 and turn a caller mistake into a 500.
	if (!isUuid(agentId)) return error(res, 400, 'validation_error', 'agentId must be a uuid');
	if (entityId && !isUuid(entityId)) return error(res, 400, 'validation_error', 'entityId must be a uuid');

	const auth = await resolveAuth(req);
	if (!auth) return json(res, 200, EMPTY_GRAPH);

	const [row] = await sql`
		SELECT user_id FROM agent_identities WHERE id = ${agentId} AND deleted_at IS NULL
	`;
	if (!row || row.user_id !== auth.userId) return json(res, 200, EMPTY_GRAPH);

	if (entityId) {
		const memories = await memoriesForEntity(agentId, entityId);
		return json(res, 200, { memories });
	}

	const graph = await buildGraph(agentId);
	return json(res, 200, graph);
});
