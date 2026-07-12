// GET /api/users/me/feed — the platform activity feed: reverse-chronological
// creation events (avatars, agents, coin launches, forged 3D models, saved
// worlds) plus follow activity, merged from the same public records every
// profile page already exposes (no separate event log to keep in sync).
//
//   ?scope=following  (default) — only accounts the signed-in viewer follows.
//                                  Requires a session; anonymous callers get 401
//                                  so the client can route to sign-in.
//   ?scope=all                  — platform-wide recent activity. No session
//                                  required — this is what /community and a
//                                  first-time visitor's feed use.
//   ?limit=…    (1..50, default 30)
//   ?before=<iso timestamp>     — cursor for the next page (pass the last
//                                  item's created_at back for infinite scroll)
//
// Every item: { kind, id, created_at, actor{username,display_name,avatar_url},
//               title, subtitle?, href, image?, external?, isRemix? } and, for
// kind:'follow' only, a `target` shaped like `actor`. `actor.username` is null
// for an anonymous creation (forge_creations/dioramas made while signed out) —
// the client renders those without a profile link rather than inventing one.

import { sql } from '../../_lib/db.js';
import { cors, json, method, wrap, error, rateLimited } from '../../_lib/http.js';
import { getSessionUser } from '../../_lib/auth.js';
import { limits, clientIp } from '../../_lib/rate-limit.js';
import { publicUrl, thumbnailUrl } from '../../_lib/r2.js';
import { listRecentCreations } from '../../_lib/forge-store.js';
import { listDioramas } from '../../_lib/diorama-store.js';

const SITE = 'https://three.ws';

function actorFrom(r, { username = 'username', displayName = 'display_name', avatar = 'avatar_url' } = {}) {
	const u = r[username];
	if (!u) return { username: null, display_name: 'A three.ws creator', avatar_url: null };
	const a = r[avatar];
	return {
		username: u,
		display_name: r[displayName] || u,
		avatar_url: a ? (a.startsWith('http') ? a : publicUrl(a)) : null,
	};
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const url = new URL(req.url, 'http://x');
	const scope = url.searchParams.get('scope') === 'all' ? 'all' : 'following';
	const limit = Math.min(50, Math.max(1, parseInt(url.searchParams.get('limit'), 10) || 30));
	const before = (url.searchParams.get('before') || '').trim() || undefined;
	const perKind = limit;
	const followPerKind = Math.max(3, Math.ceil(limit / 4));

	const rl = await limits.authedReadIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const viewer = await getSessionUser(req).catch(() => null);
	if (scope === 'following' && !viewer) {
		return error(res, 401, 'unauthorized', 'sign in to view your feed');
	}

	if (scope === 'following') {
		const [{ following_count }] = await sql`
			select count(*)::int as following_count from user_follows where follower_id = ${viewer.id}
		`.catch(() => [{ following_count: 0 }]);

		if (following_count === 0) {
			return json(res, 200, { items: [], following_count: 0, scope, next: null });
		}

		const [avatarRows, agentRows, coinRows, modelRows, worldRows, followRows] = await Promise.all([
			sql`
				select a.id, a.name, a.thumbnail_key, a.created_at,
				       u.username, u.display_name, u.avatar_url
				from avatars a
				join user_follows f on f.following_id = a.owner_id and f.follower_id = ${viewer.id}
				join users u on u.id = a.owner_id and u.deleted_at is null and u.username is not null
				where a.visibility = 'public' and a.deleted_at is null
				  ${before ? sql`and a.created_at < ${before}` : sql``}
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
				  ${before ? sql`and a.created_at < ${before}` : sql``}
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
				  ${before ? sql`and a.created_at < ${before}` : sql``}
				order by coalesce(a.meta->'token'->>'launched_at', a.created_at::text) desc
				limit ${perKind}
			`,
			sql`
				select fc.id, fc.prompt, fc.glb_url, fc.preview_image_url, fc.model_category,
				       fc.parent_creation_id, fc.created_at,
				       u.username, u.display_name, u.avatar_url
				from forge_creations fc
				join user_follows f on f.following_id = fc.user_id and f.follower_id = ${viewer.id}
				join users u on u.id = fc.user_id and u.deleted_at is null and u.username is not null
				where fc.status = 'done' and fc.glb_url is not null
				  and (fc.outcome is null or fc.outcome != 'rejected')
				  ${before ? sql`and fc.created_at < ${before}` : sql``}
				order by fc.created_at desc
				limit ${perKind}
			`,
			sql`
				select d.id, d.title, d.mood, d.created_at,
				       d.doc->'objects' as objects,
				       u.username, u.display_name, u.avatar_url
				from dioramas d
				join user_follows f on f.following_id = d.user_id and f.follower_id = ${viewer.id}
				join users u on u.id = d.user_id and u.deleted_at is null and u.username is not null
				where d.user_id is not null
				  ${before ? sql`and d.created_at < ${before}` : sql``}
				order by d.created_at desc
				limit ${perKind}
			`,
			sql`
				select f.created_at,
				       uf.username as follower_username, uf.display_name as follower_display, uf.avatar_url as follower_avatar,
				       ut.username as target_username, ut.display_name as target_display, ut.avatar_url as target_avatar
				from user_follows f
				join user_follows vf on vf.following_id = f.follower_id and vf.follower_id = ${viewer.id}
				join users uf on uf.id = f.follower_id and uf.deleted_at is null and uf.username is not null
				join users ut on ut.id = f.following_id and ut.deleted_at is null and ut.username is not null
				where f.follower_id != ${viewer.id}
				  ${before ? sql`and f.created_at < ${before}` : sql``}
				order by f.created_at desc
				limit ${followPerKind}
			`.catch(() => []),
		]);

		const items = mergeItems({ avatarRows, agentRows, coinRows, modelRows, worldRows, followRows });
		items.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
		const page = items.slice(0, limit);

		res.setHeader('Cache-Control', 'private, no-store');
		return json(res, 200, {
			items: page,
			following_count,
			scope,
			next: page.length === limit ? page[page.length - 1].created_at : null,
		});
	}

	// scope === 'all': platform-wide recent activity, no follow graph, no auth.
	const [avatarRows, agentRows, coinRows, modelRows, worldRows, followRows] = await Promise.all([
		sql`
			select a.id, a.name, a.thumbnail_key, a.created_at,
			       u.username, u.display_name, u.avatar_url
			from avatars a
			join users u on u.id = a.owner_id and u.deleted_at is null and u.username is not null
			where a.visibility = 'public' and a.deleted_at is null
			  ${before ? sql`and a.created_at < ${before}` : sql``}
			order by a.created_at desc
			limit ${perKind}
		`,
		sql`
			select a.id, a.name, a.description, a.profile_image_url, a.avatar_url, a.created_at,
			       u.username, u.display_name, u.avatar_url as actor_avatar
			from agent_identities a
			join users u on u.id = a.user_id and u.deleted_at is null and u.username is not null
			where a.is_public = true and a.deleted_at is null
			  ${before ? sql`and a.created_at < ${before}` : sql``}
			order by a.created_at desc
			limit ${perKind}
		`,
		sql`
			select a.id as agent_id, a.name as agent_name, a.profile_image_url, a.avatar_url,
			       a.meta->'token' as token, a.created_at,
			       u.username, u.display_name, u.avatar_url as actor_avatar
			from agent_identities a
			join users u on u.id = a.user_id and u.deleted_at is null and u.username is not null
			where a.is_public = true and a.deleted_at is null
			  and a.meta->'token'->>'mint' is not null
			  ${before ? sql`and a.created_at < ${before}` : sql``}
			order by coalesce(a.meta->'token'->>'launched_at', a.created_at::text) desc
			limit ${perKind}
		`,
		listRecentCreations({ limit: perKind, before }),
		listDioramas({ scope: 'recent', limit: perKind, before }),
		sql`
			select f.created_at,
			       uf.username as follower_username, uf.display_name as follower_display, uf.avatar_url as follower_avatar,
			       ut.username as target_username, ut.display_name as target_display, ut.avatar_url as target_avatar
			from user_follows f
			join users uf on uf.id = f.follower_id and uf.deleted_at is null and uf.username is not null
			join users ut on ut.id = f.following_id and ut.deleted_at is null and ut.username is not null
			  ${before ? sql`and f.created_at < ${before}` : sql``}
			order by f.created_at desc
			limit ${followPerKind}
		`.catch(() => []),
	]);

	const items = mergeItems({
		avatarRows,
		agentRows,
		coinRows,
		modelRows: modelRows.map((m) => ({
			id: m.id,
			created_at: m.createdAt,
			glb_url: m.glbUrl,
			preview_image_url: m.previewImageUrl,
			model_category: m.category,
			isRemix: m.isRemix,
			username: m.username,
			display_name: m.displayName,
			avatar_url: m.avatarUrl,
		})),
		worldRows: worldRows.map((w) => ({
			id: w.id,
			created_at: w.createdAt,
			title: w.title,
			mood: w.mood,
			objects: w.thumbnailGlb ? [{ glbUrl: w.thumbnailGlb }] : [],
			username: w.creatorUsername,
			display_name: w.creatorDisplayName || w.creatorUsername,
			avatar_url: w.creatorAvatarUrl,
		})),
		followRows,
	});
	items.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
	const page = items.slice(0, limit);

	res.setHeader('Cache-Control', 'public, s-maxage=15, stale-while-revalidate=60');
	return json(res, 200, {
		items: page,
		scope,
		next: page.length === limit ? page[page.length - 1].created_at : null,
	});
});

function mergeItems({ avatarRows, agentRows, coinRows, modelRows, worldRows, followRows }) {
	const items = [];

	for (const r of avatarRows) {
		items.push({
			kind: 'avatar',
			id: r.id,
			created_at: r.created_at,
			actor: actorFrom(r),
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
			actor: actorFrom(r, { avatar: 'actor_avatar' }),
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
			actor: actorFrom(r, { avatar: 'actor_avatar' }),
			title: t.name || r.agent_name,
			subtitle: t.symbol ? `$${String(t.symbol).replace(/^\$/, '')}` : null,
			href: t.pumpfun_url || t.explorer_url || `/agent/${r.agent_id}`,
			external: Boolean(t.pumpfun_url || t.explorer_url),
			image: t.image || r.profile_image_url || r.avatar_url || null,
		});
	}

	for (const r of modelRows) {
		items.push({
			kind: 'model',
			id: r.id,
			created_at: r.created_at,
			actor: actorFrom(r),
			title: r.prompt,
			subtitle: r.model_category && r.model_category !== 'other' ? r.model_category : null,
			href: `${SITE}/viewer?src=${encodeURIComponent(r.glb_url)}`,
			image: r.preview_image_url || null,
			isRemix: Boolean(r.parent_creation_id ?? r.isRemix),
		});
	}

	for (const r of worldRows) {
		const objects = Array.isArray(r.objects) ? r.objects : [];
		items.push({
			kind: 'world',
			id: r.id,
			created_at: r.created_at,
			actor: actorFrom(r),
			title: r.title,
			subtitle: r.mood || null,
			href: `${SITE}/diorama?id=${r.id}`,
			image: objects.find((o) => o && o.glbUrl)?.glbUrl || null,
		});
	}

	for (const r of followRows) {
		items.push({
			kind: 'follow',
			id: `${r.follower_username}-${r.target_username}-${new Date(r.created_at).getTime()}`,
			created_at: r.created_at,
			actor: actorFrom(r, { username: 'follower_username', displayName: 'follower_display', avatar: 'follower_avatar' }),
			target: actorFrom(r, { username: 'target_username', displayName: 'target_display', avatar: 'target_avatar' }),
			title: r.target_display || r.target_username,
			href: `/u/${r.target_username}`,
			image: r.target_avatar ? (r.target_avatar.startsWith('http') ? r.target_avatar : publicUrl(r.target_avatar)) : null,
		});
	}

	return items;
}
