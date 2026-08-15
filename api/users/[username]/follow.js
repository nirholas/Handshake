// /api/users/:username/follow — the social-graph edge for a public profile.
//
//   GET    → { following, followed_by, followers_count, following_count }
//            `following`   = does the signed-in viewer follow this user
//            `followed_by` = does this user follow the viewer back
//            Both false for anonymous viewers. Never cached (viewer-specific).
//   POST   → follow this user   (idempotent; session + CSRF required)
//   DELETE → unfollow this user (idempotent; session + CSRF required)
//
// POST/DELETE return the same envelope as GET so the client can update the
// button label and the follower count from a single round-trip.

import { sql } from '../../_lib/db.js';
import { cors, json, method, wrap, error, rateLimited } from '../../_lib/http.js';
import { getSessionUser } from '../../_lib/auth.js';
import { requireCsrf } from '../../_lib/csrf.js';
import { limits, clientIp } from '../../_lib/rate-limit.js';
import { publishUserEvent } from '../../_lib/feed.js';

// Counted over exactly the set GET /api/users/:username/follows renders: a
// live account that has claimed a username. Counting the raw edges instead
// would put a "1 follower" badge above a list that comes back empty, since a
// deleted or username-less account is not a reachable profile.
async function counts(userId) {
	const [row] = await sql`
		select
			(select count(*)::int
			   from user_follows f
			   join users u on u.id = f.follower_id
			  where f.following_id = ${userId}
			    and u.username is not null and u.deleted_at is null) as followers_count,
			(select count(*)::int
			   from user_follows f
			   join users u on u.id = f.following_id
			  where f.follower_id = ${userId}
			    and u.username is not null and u.deleted_at is null) as following_count
	`;
	return {
		followers_count: row?.followers_count ?? 0,
		following_count: row?.following_count ?? 0,
	};
}

async function edges(viewerId, targetId) {
	if (!viewerId) return { following: false, followed_by: false };
	const rows = await sql`
		select follower_id, following_id from user_follows
		where (follower_id = ${viewerId} and following_id = ${targetId})
		   or (follower_id = ${targetId} and following_id = ${viewerId})
	`;
	let following = false;
	let followed_by = false;
	for (const r of rows) {
		if (r.follower_id === viewerId) following = true;
		if (r.follower_id === targetId) followed_by = true;
	}
	return { following, followed_by };
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,DELETE,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'POST', 'DELETE'])) return;

	const username = (req.query.username || '').toLowerCase().trim();
	if (!username || !/^[a-z0-9_-]{3,30}$/.test(username)) {
		return error(res, 400, 'validation_error', 'invalid username');
	}

	// Read budget first, before any query: the GET path is public and costs three
	// statements per call, so it has to be capped like every other public read on
	// a profile (follows.js, collectibles.js, [username].js all do this). The
	// stricter write bucket still gates the mutations below.
	const readRl = await limits.authedReadIp(clientIp(req));
	if (!readRl.success) return rateLimited(res, readRl);

	const [target] = await sql`
		select id, username from users
		where lower(username) = ${username} and deleted_at is null
		limit 1
	`;
	if (!target) return error(res, 404, 'not_found', 'user not found');

	const viewer = await getSessionUser(req).catch(() => null);

	if (req.method === 'GET') {
		const [c, e] = await Promise.all([counts(target.id), edges(viewer?.id, target.id)]);
		return json(res, 200, { ...e, ...c });
	}

	// Mutations from here: require a session + CSRF.
	if (!viewer) return error(res, 401, 'unauthorized', 'sign in to follow');
	if (!(await requireCsrf(req, res, viewer.id))) return;

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	if (viewer.id === target.id) {
		return error(res, 400, 'bad_request', 'you cannot follow yourself');
	}

	if (req.method === 'POST') {
		// RETURNING yields a row only when a NEW edge was created — re-following an
		// account you already follow is a no-op and must not re-notify.
		const inserted = await sql`
			insert into user_follows (follower_id, following_id)
			values (${viewer.id}, ${target.id})
			on conflict do nothing
			returning follower_id
		`;
		if (inserted.length) {
			// Reuse the existing in-app notification system (nav bell) — fire-and-
			// forget, never blocks the response.
			publishUserEvent(target.id, {
				type: 'follow',
				actor: viewer.display_name || viewer.username || 'Someone',
				follower_username: viewer.username || null,
				link: viewer.username ? `/u/${viewer.username}` : '/feed',
			});
		}
	} else {
		await sql`
			delete from user_follows
			where follower_id = ${viewer.id} and following_id = ${target.id}
		`;
	}

	const [c, e] = await Promise.all([counts(target.id), edges(viewer.id, target.id)]);
	return json(res, 200, { ...e, ...c });
});
