// GET /api/users/me/feed — the signed-in viewer's home feed: recent public
// activity from every account they follow, newest first. This is the social-
// graph payoff — following someone means their new avatars, agents, and coin
// launches surface here.
//
// Activity is derived from the same public records the profile page already
// exposes (no separate event log to keep in sync): a new public avatar, a new
// public agent identity, and a coin launched through an agent. Items are merged,
// sorted by created_at desc, and capped.
//
//   ?limit=…   (1..50, default 30)
//
// Requires a session — the feed is inherently personal. Anonymous callers get
// 401 so the client can route them to sign-in.

import { sql } from '../../_lib/db.js';
import { cors, json, method, wrap, error, rateLimited } from '../../_lib/http.js';
import { getSessionUser } from '../../_lib/auth.js';
import { limits, clientIp } from '../../_lib/rate-limit.js';
import { publicUrl, thumbnailUrl } from '../../_lib/r2.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const viewer = await getSessionUser(req).catch(() => null);
	if (!viewer) return error(res, 401, 'unauthorized', 'sign in to view your feed');

	const rl = await limits.authedReadIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 30));
	const perKind = limit; // pull `limit` of each kind, then merge + trim to `limit`

	// Follow graph lives in user_follows. A deploy that lands before the
	// user_follows migration must degrade to an empty feed rather than 500 every
	// home feed (migrate-then-deploy; mirrors api/users/[username].js).
	const [{ following_count }] = await sql`
		select count(*)::int as following_count from user_follows where follower_id = ${viewer.id}
	`.catch(() => [{ following_count: 0 }]);

	if (following_count === 0) {
		return json(res, 200, { items: [], following_count: 0 });
	}

	const [avatarRows, agentRows, coinRows] = await Promise.all([
		sql`
			select a.id, a.name, a.thumbnail_key, a.created_at,
			       u.username, u.display_name, u.avatar_url
			from avatars a
			join user_follows f on f.following_id = a.owner_id and f.follower_id = ${viewer.id}
			join users u on u.id = a.owner_id and u.deleted_at is null and u.username is not null
			where a.visibility = 'public' and a.deleted_at is null
			order by a.created_at desc
			limit ${perKind}
		`,
		sql`
			select a.id, a.name, a.description, a.profile_image_url, a.avatar_url, a.created_at,
			       u.username, u.display_name, u.avatar_url as actor_avatar
			from agent_identities a
			join user_follows f on f.following_id = a.user_id and f.follower_id = ${viewer.id}
			join users u on u.id = a.user_id and u.deleted_at is null and u.username is not null
			where a.is_public = true and a.deleted_at is null
			order by a.created_at desc
			limit ${perKind}
		`,
		sql`
			select a.id as agent_id, a.name as agent_name, a.profile_image_url, a.avatar_url,
			       a.meta->'token' as token, a.created_at,
			       u.username, u.display_name, u.avatar_url as actor_avatar
			from agent_identities a
			join user_follows f on f.following_id = a.user_id and f.follower_id = ${viewer.id}
			join users u on u.id = a.user_id and u.deleted_at is null and u.username is not null
			where a.is_public = true and a.deleted_at is null
			  and a.meta->'token'->>'mint' is not null
			order by coalesce(a.meta->'token'->>'launched_at', a.created_at::text) desc
			limit ${perKind}
		`,
	]);

	const actor = (r, avatarKey = 'avatar_url') => ({
		username: r.username,
		display_name: r.display_name || r.username,
		avatar_url: r[avatarKey]
			? (r[avatarKey].startsWith('http') ? r[avatarKey] : publicUrl(r[avatarKey]))
			: null,
	});

	const items = [];

	for (const r of avatarRows) {
		items.push({
			kind: 'avatar',
			id: r.id,
			created_at: r.created_at,
			actor: actor(r),
			title: r.name,
			href: `/avatars/${r.id}`,
			image: thumbnailUrl(r.thumbnail_key),
		});
	}

	for (const r of agentRows) {
		items.push({
			kind: 'agent',
			id: r.id,
			created_at: r.created_at,
			actor: actor(r, 'actor_avatar'),
			title: r.name,
			subtitle: r.description || null,
			href: `/agent/${r.id}`,
			image: r.profile_image_url || r.avatar_url || null,
		});
	}

	for (const r of coinRows) {
		const t = r.token || {};
		if (!t.mint) continue;
		items.push({
			kind: 'coin',
			id: t.mint,
			created_at: t.launched_at || r.created_at,
			actor: actor(r, 'actor_avatar'),
			title: t.name || r.agent_name,
			subtitle: t.symbol ? `$${String(t.symbol).replace(/^\$/, '')}` : null,
			href: t.pumpfun_url || t.explorer_url || `/agent/${r.agent_id}`,
			external: Boolean(t.pumpfun_url || t.explorer_url),
			image: t.image || r.profile_image_url || r.avatar_url || null,
		});
	}

	items.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

	res.setHeader('Cache-Control', 'private, no-store');
	return json(res, 200, { items: items.slice(0, limit), following_count });
});
