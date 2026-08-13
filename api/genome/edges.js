// GET /api/genome/edges — every breeding descent edge (parent → child), for the
// galaxy star-map to draw lineage lines between agent nodes. Public-safe: ids +
// pedigree tier only, no secret. Bounded; newest first.

import { cors, json, method, wrap } from '../_lib/http.js';
import { sql } from '../_lib/db.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const url = new URL(req.url, 'http://x');
	const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 2000, 1), 5000);

	// Inner-joined to the three live agents so a deleted node never leaves a lineage
	// line hanging off the star map to a star that is no longer drawn.
	const rows = await sql`
		select b.parent_a_agent_id, b.parent_b_agent_id, b.child_agent_id, b.generation, b.pedigree_tier
		from genome_breedings b
		join agent_identities pa on pa.id = b.parent_a_agent_id and pa.deleted_at is null
		join agent_identities pb on pb.id = b.parent_b_agent_id and pb.deleted_at is null
		join agent_identities c  on c.id  = b.child_agent_id    and c.deleted_at  is null
		where b.status = 'born'
		order by b.created_at desc
		limit ${limit}
	`;
	const edges = rows.map((r) => ({
		a: r.parent_a_agent_id,
		b: r.parent_b_agent_id,
		child: r.child_agent_id,
		generation: r.generation,
		tier: r.pedigree_tier,
	}));
	return json(res, 200, { edges }, { 'cache-control': 'public, s-maxage=60' });
});
