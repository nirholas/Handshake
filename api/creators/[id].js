/**
 * GET /api/creators/:id
 *
 * Public creator profile keyed by user UUID. Returns the creator's display
 * info plus their published marketplace agents and public avatars. Used by
 * the marketplace creator-profile modal — clickable author names route here.
 *
 * Cached for a minute so popular creators don't hammer the DB on every modal
 * open.
 */

import { sql } from '../_lib/db.js';
import { cors, error, json, method, wrap, rateLimited } from '../_lib/http.js';
import { publicUrl, thumbnailUrl } from '../_lib/r2.js';
import { clientIp, limits } from '../_lib/rate-limit.js';
import { isUuid } from '../_lib/validate.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const id = String(req.query?.id || '').trim();
	if (!isUuid(id)) return error(res, 404, 'not_found', 'creator not found');

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const [user] = await sql`
		SELECT id, display_name, username, avatar_url, created_at
		FROM users
		WHERE id = ${id} AND deleted_at IS NULL
		LIMIT 1
	`;
	if (!user) return error(res, 404, 'not_found', 'creator not found');

	const [agentRows, avatarRows, counts] = await Promise.all([
		sql`
			SELECT ai.id, ai.name, ai.description, ai.category, ai.tags, ai.avatar_id,
			       ai.forks_count, ai.views_count, ai.published_at, ai.created_at, ai.skills,
			       av.thumbnail_key,
			       ai.meta->'onchain' AS onchain,
			       EXISTS (
			         SELECT 1 FROM agent_skill_prices asp
			         WHERE asp.agent_id = ai.id AND asp.is_active = true
			       ) AS has_paid_skills
			FROM agent_identities ai
			LEFT JOIN avatars av ON av.id = ai.avatar_id AND av.deleted_at IS NULL
			WHERE ai.user_id = ${user.id}
			  AND ai.is_published = true
			  AND ai.deleted_at IS NULL
			ORDER BY ai.published_at DESC NULLS LAST
			LIMIT 24
		`,
		sql`
			SELECT id, slug, name, description, storage_key, thumbnail_key, tags, created_at
			FROM avatars
			WHERE owner_id = ${user.id}
			  AND visibility = 'public'
			  AND deleted_at IS NULL
			ORDER BY created_at DESC
			LIMIT 24
		`,
		sql`
			SELECT
				(SELECT count(*)::int FROM agent_identities WHERE user_id = ${user.id} AND is_published = true AND deleted_at IS NULL) AS agents_total,
				(SELECT count(*)::int FROM avatars WHERE owner_id = ${user.id} AND visibility = 'public' AND deleted_at IS NULL) AS avatars_total,
				(SELECT coalesce(sum(forks_count), 0)::int FROM agent_identities WHERE user_id = ${user.id} AND is_published = true AND deleted_at IS NULL) AS forks_total,
				(SELECT coalesce(sum(views_count), 0)::int FROM agent_identities WHERE user_id = ${user.id} AND is_published = true AND deleted_at IS NULL) AS views_total
		`,
	]);

	const agents = agentRows.map((a) => ({
		id: a.id,
		name: a.name,
		description: a.description,
		category: a.category,
		tags: a.tags || [],
		thumbnail_url: thumbnailUrl(a.thumbnail_key),
		skills: a.skills || [],
		forks_count: a.forks_count || 0,
		views_count: a.views_count || 0,
		published_at: a.published_at,
		has_paid_skills: a.has_paid_skills || false,
		// Public on-chain block so the creator modal shows the same deployed badge.
		onchain: a.onchain || null,
	}));

	const avatars = avatarRows.map((a) => ({
		id: a.id,
		slug: a.slug,
		name: a.name,
		description: a.description,
		thumbnail_url: thumbnailUrl(a.thumbnail_key),
		glb_url: a.storage_key ? publicUrl(a.storage_key) : null,
		tags: a.tags || [],
		created_at: a.created_at,
	}));

	const totals = counts[0] || {};

	res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
	return json(res, 200, {
		data: {
			creator: {
				id: user.id,
				display_name: user.display_name || user.username || 'Anonymous',
				username: user.username || null,
				avatar_url: user.avatar_url || null,
				profile_url: user.username ? `/@${user.username}` : `/creators/${user.id}`,
				joined: user.created_at,
				totals: {
					agents: totals.agents_total || 0,
					avatars: totals.avatars_total || 0,
					forks: totals.forks_total || 0,
					views: totals.views_total || 0,
				},
			},
			agents,
			avatars,
		},
	});
});
