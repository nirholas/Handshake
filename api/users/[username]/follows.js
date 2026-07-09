// GET /api/users/:username/follows?type=followers|following — the list behind
// the follower / following counts on a profile.
//
//   ?type=followers → users who follow :username   (default)
//   ?type=following → users :username follows
//   ?limit=…&offset=…  (limit 1..100, default 50)
//
// Each row carries `is_following`: whether the signed-in viewer already follows
// that user, so the list can render an accurate Follow / Following button per
// row without an N+1 of follow-state probes. Anonymous viewers get all false.

import { sql } from '../../_lib/db.js';
import { cors, json, method, wrap, error, rateLimited } from '../../_lib/http.js';
import { getSessionUser } from '../../_lib/auth.js';
import { limits, clientIp } from '../../_lib/rate-limit.js';
import { publicUrl } from '../../_lib/r2.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const username = (req.query.username || '').toLowerCase().trim();
	if (!username || !/^[a-z0-9_-]{3,30}$/.test(username)) {
		return error(res, 400, 'validation_error', 'invalid username');
	}
	const type = req.query.type === 'following' ? 'following' : 'followers';
	const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
	const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);

	const rl = await limits.authedReadIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const [target] = await sql`
		select id from users where lower(username) = ${username} and deleted_at is null limit 1
	`;
	if (!target) return error(res, 404, 'not_found', 'user not found');

	const viewer = await getSessionUser(req).catch(() => null);
	const viewerId = viewer?.id ?? null;

	// followers: rows where following_id = target, list the followers (f.follower_id).
	// following: rows where follower_id = target, list the followees (f.following_id).
	const rows = type === 'followers'
		? await sql`
			select u.id, u.username, u.display_name, u.avatar_url, u.bio, f.created_at,
			       exists(
			         select 1 from user_follows v
			         where v.follower_id = ${viewerId} and v.following_id = u.id
			       ) as is_following
			from user_follows f
			join users u on u.id = f.follower_id and u.deleted_at is null
			where f.following_id = ${target.id}
			order by f.created_at desc
			limit ${limit} offset ${offset}
		`
		: await sql`
			select u.id, u.username, u.display_name, u.avatar_url, u.bio, f.created_at,
			       exists(
			         select 1 from user_follows v
			         where v.follower_id = ${viewerId} and v.following_id = u.id
			       ) as is_following
			from user_follows f
			join users u on u.id = f.following_id and u.deleted_at is null
			where f.follower_id = ${target.id}
			order by f.created_at desc
			limit ${limit} offset ${offset}
		`;

	const users = rows
		.filter((u) => u.username) // a profile is only reachable by username
		.map((u) => ({
			username: u.username,
			display_name: u.display_name || u.username,
			avatar_url: u.avatar_url ? (u.avatar_url.startsWith('http') ? u.avatar_url : publicUrl(u.avatar_url)) : null,
			bio: u.bio || null,
			followed_at: u.created_at,
			is_following: viewerId ? Boolean(u.is_following) : false,
			is_self: viewerId === u.id,
		}));

	return json(res, 200, {
		type,
		users,
		has_more: rows.length === limit,
		next_offset: offset + rows.length,
	});
});
