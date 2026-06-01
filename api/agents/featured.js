// GET /api/agents/featured
// -------------------------
// Public, read-only. Picks ONE real agent to feature on the pump dashboard,
// chosen deterministically from real data — never a hardcoded id or sample:
//   1. The public, non-deleted agent with the highest aggregate
//      agent_revenue_events.net_amount over the last 30 days.
//   2. If no revenue events fall in that window, the most-recently-created
//      public, non-deleted agent.
// Both rules collapse into a single ORDER BY (net_total DESC, created_at DESC)
// so a zero-revenue platform still surfaces the newest agent.
//
// Returns { data: { id, slug, display_name, bio, avatar_url, detail_url } }
// or 404 when there are zero eligible agents.

import { sql } from '../_lib/db.js';
import { cors, json, method, wrap, error } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { publicUrl } from '../_lib/r2.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const [row] = await sql`
		WITH revenue AS (
			SELECT re.agent_id, SUM(re.net_amount)::bigint AS net_total
			FROM agent_revenue_events re
			WHERE re.created_at > now() - interval '30 days'
			GROUP BY re.agent_id
		)
		SELECT
			i.id,
			i.name,
			i.description,
			i.avatar_url,
			i.profile_image_url,
			i.home_url,
			a.thumbnail_key AS avatar_thumbnail_key,
			a.storage_key   AS avatar_storage_key,
			a.visibility    AS avatar_visibility,
			COALESCE(r.net_total, 0)::bigint AS net_total
		FROM agent_identities i
		LEFT JOIN revenue r ON r.agent_id = i.id
		LEFT JOIN avatars a ON a.id = i.avatar_id AND a.deleted_at IS NULL
		WHERE i.deleted_at IS NULL
		  AND i.is_public = true
		ORDER BY net_total DESC, i.created_at DESC
		LIMIT 1
	`;

	if (!row) return error(res, 404, 'no_agents', 'No agents available yet');

	// Prefer an explicitly-set avatar/profile image, then the linked avatar's
	// public thumbnail. Never substitute a stock placeholder — the client renders
	// initials when avatar_url is null.
	const avatarPublic =
		row.avatar_visibility === 'public' || row.avatar_visibility === 'unlisted';
	const avatar_url =
		row.avatar_url ||
		row.profile_image_url ||
		(row.avatar_thumbnail_key ? publicUrl(row.avatar_thumbnail_key) : null) ||
		(row.avatar_storage_key && avatarPublic ? publicUrl(row.avatar_storage_key) : null) ||
		null;

	return json(
		res,
		200,
		{
			data: {
				id: row.id,
				slug: row.id,
				display_name: row.name,
				bio: row.description || null,
				avatar_url,
				detail_url: row.home_url || `/agent/${row.id}`,
				net_30d: Number(row.net_total),
			},
		},
		{ 'cache-control': 'public, max-age=30, s-maxage=60' },
	);
});
