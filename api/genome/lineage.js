// GET /api/genome/lineage?agentId=<id>           — the verifiable family tree.
// GET /api/genome/lineage?agentId=<id>&verify=1   — re-derive + confirm the genome.
//
// Lineage shows on all three nodes of a breed (both parents + child), mirroring
// fork. The verify path re-derives the child genome from the recorded seed + the
// parent-genome snapshots captured at breed time and confirms it matches the stored
// hash — so a forged "child" (one whose genome wasn't actually derived from its
// claimed parents) is detectable by anyone. Public-safe: no secret is exposed.

import { cors, json, method, wrap, error } from '../_lib/http.js';
import { isUuid } from '../_lib/validate.js';
import { sql } from '../_lib/db.js';
import { verifyGenome, pedigreeScore, normalizeGenome } from '../_lib/genome.js';
import { publicGenome } from '../_lib/genome-agent.js';

const MAX_ANCESTOR_DEPTH = 8;

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const url = new URL(req.url, 'http://x');
	const agentId = String(url.searchParams.get('agentId') || '').trim();
	if (!isUuid(agentId)) return error(res, 400, 'validation_error', 'agentId is required');

	const node = await loadNode(agentId);
	if (!node) return error(res, 404, 'not_found', 'agent not found');

	if (isTruthy(url.searchParams.get('verify'))) {
		return json(res, 200, await verifyNode(agentId), { 'cache-control': 'public, s-maxage=30' });
	}

	// Parents (if this agent was bred).
	const [birth] = await sql`
		select b.parent_a_agent_id, b.parent_b_agent_id, b.seed, b.genome_hash, b.generation,
		       b.pedigree_tier, b.created_at
		from genome_breedings b
		where b.child_agent_id = ${agentId} and b.status = 'born'
		order by b.created_at asc limit 1
	`;
	// Children (every breed this agent was a parent of).
	const childRows = await sql`
		select b.child_agent_id, b.generation, b.pedigree_tier, b.created_at,
		       case when b.parent_a_agent_id = ${agentId} then b.parent_b_agent_id else b.parent_a_agent_id end as co_parent
		from genome_breedings b
		where (b.parent_a_agent_id = ${agentId} or b.parent_b_agent_id = ${agentId})
		  and b.status = 'born' and b.child_agent_id is not null
		order by b.created_at desc limit 100
	`;

	// One lookup for the parents plus every child and co-parent. Loading them one
	// id at a time issued up to 202 round trips for a well-bred agent.
	const nodes = await loadNodes([
		birth?.parent_a_agent_id,
		birth?.parent_b_agent_id,
		...childRows.flatMap((r) => [r.child_agent_id, r.co_parent]),
	]);
	const parents = birth ? [nodes.get(birth.parent_a_agent_id), nodes.get(birth.parent_b_agent_id)] : [];
	const children = childRows.map((r) => ({
		...nodes.get(r.child_agent_id),
		co_parent: nodes.get(r.co_parent) || null,
		bred_at: r.created_at,
	}));

	// Ancestors — walk up the pedigree (bounded), so a profile can render depth.
	const ancestors = await walkAncestors(agentId);

	return json(
		res,
		200,
		{
			agent: node,
			generation: node.generation,
			pedigree: node.pedigree,
			parents: parents.filter(Boolean),
			children: children.filter((c) => c && c.id),
			ancestors,
			bred: !!birth,
			seed: birth?.seed || null,
			genome_hash: birth?.genome_hash || null,
		},
		{ 'cache-control': 'public, s-maxage=30' },
	);
});

// Re-derive the child genome from recorded inputs and confirm it matches.
async function verifyNode(agentId) {
	const [row] = await sql`
		select i.id, i.name, i.meta, b.seed, b.genome_hash
		from agent_identities i
		left join genome_breedings b on b.child_agent_id = i.id and b.status = 'born'
		where i.id = ${agentId} and i.deleted_at is null
		limit 1
	`;
	if (!row) return { verifiable: false, reason: 'not_found' };
	const bred = row.meta?.bred_from;
	const childGenome = row.meta?.genome;
	if (!bred || !childGenome) return { verifiable: false, reason: 'not_a_bred_agent' };

	const parentA = bred.parent_a?.genome;
	const parentB = bred.parent_b?.genome;
	const seed = bred.seed || row.seed;
	if (!parentA || !parentB || !seed) return { verifiable: false, reason: 'missing_recorded_inputs' };

	const result = verifyGenome(normalizeGenome(childGenome), { parentA, parentB, seed });
	return {
		verifiable: true,
		valid: result.valid,
		reason: result.reason || null,
		genome_hash: result.hash || childGenome.genome_hash || null,
		recorded_hash: row.genome_hash || childGenome.genome_hash || null,
		parents: [
			{ id: bred.parent_a?.agent_id, name: bred.parent_a?.name },
			{ id: bred.parent_b?.agent_id, name: bred.parent_b?.name },
		],
		seed,
	};
}

async function walkAncestors(agentId) {
	const out = [];
	const seen = new Set([agentId]);
	let frontier = [agentId];
	for (let depth = 1; depth <= MAX_ANCESTOR_DEPTH && frontier.length; depth++) {
		const rows = await sql`
			select child_agent_id, parent_a_agent_id, parent_b_agent_id
			from genome_breedings
			where child_agent_id = any(${frontier}) and status = 'born'
		`;
		const next = [];
		const owner = new Map();
		for (const r of rows) {
			for (const pid of [r.parent_a_agent_id, r.parent_b_agent_id]) {
				if (pid && !seen.has(pid)) {
					seen.add(pid);
					next.push(pid);
					owner.set(pid, r.child_agent_id);
				}
			}
		}
		// One lookup per generation rather than one per ancestor: a full 8-deep
		// pedigree fans out to 255 forebears.
		const nodes = await loadNodes(next);
		for (const pid of next) {
			const n = nodes.get(pid);
			if (n) out.push({ ...n, depth, of: owner.get(pid) });
		}
		frontier = next;
	}
	return out;
}

// One node of the tree — public-safe. Private agents reveal only that they exist.
async function loadNode(agentId) {
	if (!agentId) return null;
	return (await loadNodes([agentId])).get(agentId) || null;
}

// Batch form of loadNode: ids in, Map(id → node) out. Missing/deleted ids are
// simply absent from the map.
async function loadNodes(agentIds) {
	const ids = [...new Set(agentIds.filter(Boolean))];
	if (!ids.length) return new Map();
	const rows = await sql`
		select i.id, i.name, i.is_public, i.user_id, i.avatar_id, i.meta,
		       a.thumbnail_key as avatar_thumbnail_key
		from agent_identities i
		left join avatars a on a.id = i.avatar_id and a.deleted_at is null
		where i.id = any(${ids}) and i.deleted_at is null
	`;
	const out = new Map();
	for (const r of rows) {
		const genome = r.meta?.genome ? normalizeGenome(r.meta.genome) : null;
		const pedigree = genome ? pedigreeScore(genome) : { tier: 'common', generation: 0, score: 0 };
		out.set(r.id, {
			id: r.id,
			name: r.is_public ? r.name : 'Private agent',
			is_public: !!r.is_public,
			avatar_id: r.avatar_id,
			generation: genome?.generation ?? 0,
			pedigree,
			bred: !!r.meta?.bred_from,
		});
	}
	return out;
}

// `?verify=1` verifies; `?verify=0` and `?verify=false` do not. Any non-empty
// value used to pass, so a client sending an explicit "off" got verification.
function isTruthy(raw) {
	if (raw === null) return false;
	const v = String(raw).trim().toLowerCase();
	return v !== '' && v !== '0' && v !== 'false' && v !== 'no';
}
