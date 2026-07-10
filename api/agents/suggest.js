// GET /api/agents/suggest?q=<query>[&limit=<n>]
// Public autocomplete for @-mention surfaces. Returns ranked agents matching q.

import { sql } from '../_lib/db.js';
import { thumbnailUrl } from '../_lib/r2.js';
import { cors, json, method, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';

const Q_RE = /[^a-zA-Z0-9_-]/g;

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.agentSuggest(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, 'http://x');
	const raw = (url.searchParams.get('q') || '').trim();
	const q = raw.replace(Q_RE, '').slice(0, 32);

	if (!q) return json(res, 200, { agents: [] }, { 'cache-control': 'public, max-age=60' });

	const limitParam = parseInt(url.searchParams.get('limit') || '8', 10);
	const lim = Math.min(20, Math.max(1, Number.isFinite(limitParam) ? limitParam : 8));

	// Rank: 0 = exact, 1 = name prefix, 2 = ILIKE fuzzy.
	// No slug column exists; name is used for both name and slug ranking tiers.
	// No private/hidden columns exist; deleted_at IS NULL is the only exclusion.
	const rows = await sql`
		SELECT
			ai.id,
			ai.name,
			ai.chain_id,
			ai.erc8004_agent_id,
			av.thumbnail_key,
			CASE
				WHEN lower(ai.name) = lower(${q})             THEN 0
				WHEN lower(ai.name) LIKE lower(${q}) || '%'   THEN 1
				ELSE                                               2
			END AS rank
		FROM agent_identities ai
		LEFT JOIN avatars av ON av.id = ai.avatar_id AND av.deleted_at IS NULL
		WHERE ai.deleted_at IS NULL
		  AND lower(ai.name) LIKE '%' || lower(${q}) || '%'
		ORDER BY rank, ai.name
		LIMIT ${lim}
	`;

	const agents = rows.map((r) => ({
		id: r.id,
		name: r.name,
		slug: r.name.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
		thumbnailUrl: thumbnailUrl(r.thumbnail_key),
		...(r.chain_id != null ? { chainId: r.chain_id } : {}),
		onChain: r.erc8004_agent_id != null,
	}));

	return json(res, 200, { agents }, { 'cache-control': 'public, max-age=60' });
});
