// GET /api/showcase — public directory of ERC-8004 agents with 3D avatars.
//
// Reads from `erc8004_agents_index` (populated by api/cron/erc8004-crawl.js).
// Keyset pagination on (sort_ts, chain_id, agent_id), stable under concurrent
// inserts and backed by the `erc8004_agents_has3d_time` index. `sort_ts` is
// `registered_at` with NULL folded to -infinity, and the cursor carries it as
// Postgres text: two details that keep the key TOTAL. A NULL registered_at
// (a third of the crawled index) would otherwise make the row-comparison NULL
// and drop that agent from every page after the first, and a cursor rendered
// through a JS Date would truncate the stored microseconds, which repeats or
// skips rows on the boundary depending on the sort direction.

import { sql } from './_lib/db.js';
import { cors, error, json, method, wrap, rateLimited } from './_lib/http.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import { CHAIN_BY_ID, tokenExplorerUrl, addressExplorerUrl } from './_lib/erc8004-chains.js';

const MAX_LIMIT = 60;
const DEFAULT_LIMIT = 24;

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, 'http://x');
	const params = parseParams(url.searchParams);
	if (params.error) return error(res, 400, 'validation_error', params.error);

	const { chainIds, sort, limit, cursor } = params;
	const decoded = cursor ? decodeCursor(cursor) : null;
	if (cursor && !decoded) return error(res, 400, 'validation_error', 'invalid cursor');

	const cursorAt = decoded?.sortTs || null;
	const cursorChain = decoded?.chainId ?? null;
	const cursorAgent = decoded?.agentId || null;

	const rows =
		sort === 'newest'
			? await sql`
				SELECT chain_id, agent_id, owner, registry, agent_uri,
				       name, description, image, glb_url, services, x402_support,
				       registered_block, registered_tx, registered_at,
				       COALESCE(registered_at, '-infinity'::timestamptz)::text AS sort_ts
				FROM erc8004_agents_index
				WHERE active = true
				  AND has_3d = true
				  AND chain_id = ANY(${chainIds}::int[])
				  AND (
				    ${cursorAt}::timestamptz IS NULL
				    OR (COALESCE(registered_at, '-infinity'::timestamptz), chain_id, agent_id) <
				       (${cursorAt}::timestamptz, ${cursorChain}::int, ${cursorAgent}::text)
				  )
				ORDER BY COALESCE(registered_at, '-infinity'::timestamptz) DESC, chain_id DESC, agent_id DESC
				LIMIT ${limit + 1}
			`
			: await sql`
				SELECT chain_id, agent_id, owner, registry, agent_uri,
				       name, description, image, glb_url, services, x402_support,
				       registered_block, registered_tx, registered_at,
				       COALESCE(registered_at, '-infinity'::timestamptz)::text AS sort_ts
				FROM erc8004_agents_index
				WHERE active = true
				  AND has_3d = true
				  AND chain_id = ANY(${chainIds}::int[])
				  AND (
				    ${cursorAt}::timestamptz IS NULL
				    OR (COALESCE(registered_at, '-infinity'::timestamptz), chain_id, agent_id) >
				       (${cursorAt}::timestamptz, ${cursorChain}::int, ${cursorAgent}::text)
				  )
				ORDER BY COALESCE(registered_at, '-infinity'::timestamptz) ASC, chain_id ASC, agent_id ASC
				LIMIT ${limit + 1}
			`;

	const hasMore = rows.length > limit;
	const pageRows = hasMore ? rows.slice(0, limit) : rows;
	const nextCursor = hasMore ? encodeCursor(pageRows[pageRows.length - 1]) : null;
	const agents = pageRows.map(shapeAgent);

	// Filtered total, for the "N agents" headline. Cached at the edge so hot
	// pages don't re-count.
	const [{ count }] = await sql`
		SELECT COUNT(*)::int AS count
		FROM erc8004_agents_index
		WHERE active = true
		  AND has_3d = true
		  AND chain_id = ANY(${chainIds}::int[])
	`;

	res.setHeader('cache-control', 'public, max-age=60, s-maxage=60, stale-while-revalidate=300');
	return json(res, 200, { agents, total: count, next_cursor: nextCursor });
});

// ─── Params ──────────────────────────────────────────────────────────────────

function parseParams(sp) {
	const net = (sp.get('net') || 'mainnet').toLowerCase();
	if (!['mainnet', 'testnet', 'all'].includes(net)) {
		return { error: 'net must be mainnet | testnet | all' };
	}

	const sort = (sp.get('sort') || 'newest').toLowerCase();
	if (!['newest', 'oldest'].includes(sort)) {
		return { error: 'sort must be newest | oldest' };
	}

	// LIMIT is a bigint to Postgres: floor before it gets there, or a fractional
	// ?limit=1.5 becomes `LIMIT 2.5` and fails the query with 22P02.
	let limit = Math.floor(Number(sp.get('limit')));
	if (!Number.isFinite(limit) || limit < 1) limit = DEFAULT_LIMIT;
	if (limit > MAX_LIMIT) limit = MAX_LIMIT;

	const chainParam = sp.get('chain') || '';
	const explicitChains = [];
	if (chainParam) {
		for (const p of chainParam
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean)) {
			const n = Number(p);
			if (!Number.isInteger(n) || !CHAIN_BY_ID[n]) {
				return { error: `unknown chain: ${p}` };
			}
			explicitChains.push(n);
		}
	}

	const candidates = explicitChains.length
		? explicitChains
		: Object.values(CHAIN_BY_ID)
				.filter((c) => (net === 'all' ? true : net === 'mainnet' ? !c.testnet : c.testnet))
				.map((c) => c.id);

	const cursor = sp.get('cursor') || '';
	return { chainIds: candidates, sort, limit, cursor };
}

// ─── Shape & cursor ──────────────────────────────────────────────────────────

function shapeAgent(row) {
	const chainMeta = CHAIN_BY_ID[row.chain_id];
	return {
		chainId: row.chain_id,
		chainName: chainMeta?.name || `Chain ${row.chain_id}`,
		chainTestnet: !!chainMeta?.testnet,
		agentId: row.agent_id,
		owner: row.owner,
		registry: row.registry,
		agentURI: row.agent_uri,
		name: row.name,
		description: row.description,
		image: row.image,
		glbUrl: row.glb_url,
		services: Array.isArray(row.services) ? row.services : [],
		x402Support: !!row.x402_support,
		registeredBlock: row.registered_block ? Number(row.registered_block) : null,
		registeredTx: row.registered_tx,
		registeredAt: row.registered_at ? new Date(row.registered_at).toISOString() : null,
		viewerUrl: `/a/${row.chain_id}/${row.agent_id}`,
		tokenExplorerUrl: tokenExplorerUrl(row.chain_id, row.agent_id),
		ownerExplorerUrl: row.owner ? addressExplorerUrl(row.chain_id, row.owner) : null,
	};
}

// The cursor carries `sort_ts` verbatim as Postgres rendered it, so it round-trips
// at full microsecond precision and survives a NULL registered_at (`-infinity`).
function encodeCursor(row) {
	const payload = `${row.sort_ts}|${row.chain_id}|${row.agent_id}`;
	return Buffer.from(payload, 'utf8').toString('base64url');
}

function decodeCursor(cursor) {
	try {
		const payload = Buffer.from(cursor, 'base64url').toString('utf8');
		const [sortTs, chainIdStr, agentId] = payload.split('|');
		const chainId = Number(chainIdStr);
		if (!sortTs || !Number.isInteger(chainId) || !agentId) return null;
		return { sortTs, chainId, agentId };
	} catch {
		return null;
	}
}
