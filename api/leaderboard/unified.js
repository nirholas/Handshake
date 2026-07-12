// GET /api/leaderboard/unified — the cross-surface leaderboard (prompt 06 of
// the user-value pack).
//
//   ?metric = creations | remixes_received | launches | followers | walk_distance
//             (default creations)
//   ?limit  = 1..100   (default 50)
//   ?offset = 0..
//
// Five real, queried rankings — every column here is a COUNT/SUM over an
// existing table, never a synthetic score:
//   · creations         — finished forge models (forge_creations, status=done)
//                          + saved worlds (dioramas), per signed-in creator.
//   · remixes_received   — count of OTHER creators' forge_creations rows whose
//                          parent_creation_id points at one of this user's
//                          finished creations (a real derivative count, not a
//                          view/like count).
//   · launches          — pump.fun coins minted from this user's agents
//                          (agent_identities.meta->'token'->>'mint').
//   · followers          — user_follows platform-wide follower count.
//   · walk_distance      — total metres walked while signed in (walk_metrics,
//                          all-time, signed-in walkers only — the anonymous
//                          half of walking already has its own board at
//                          /walk-leaderboard).
//
// Two metrics considered and REJECTED for lacking real data (see prompt
// report): "royalties earned" (forge_creations.remix_settlement_ref is a
// single JSONB column overwritten on every settlement, not an append-only
// ledger, so a cumulative sum across multiple remixes of the same source is
// not reliably computable without a schema change) and "/play activity" (no
// per-human-user session/quest-completion table exists — /play's own tables
// track wallet auth and agent-level Agora activity, not human play sessions).
//
// Every row is a real signed-in user (anonymous activity has no cross-surface
// identity to rank). The requester's own row is always resolved and pinned,
// even off-page, mirroring /api/walk/leaderboard's "you're #142" pattern.

import { cors, method, json, wrap, rateLimited, error } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { sql } from '../_lib/db.js';
import { getSessionUser, extractBearer, authenticateBearer } from '../_lib/auth.js';
import { thumbnailUrl } from '../_lib/r2.js';

export const maxDuration = 10;

const METRICS = new Set(['creations', 'remixes_received', 'launches', 'followers', 'walk_distance']);

const METRIC_LABEL = {
	creations: 'Creations',
	remixes_received: 'Remixes Received',
	launches: 'Launches',
	followers: 'Followers',
	walk_distance: 'Walk Distance',
};

// Per-metric ranking query — returns { user_id, value } rows, unsorted (the
// caller sorts once after merging in profile data isn't needed for sorting).
async function rankingRows(metric) {
	if (metric === 'creations') {
		return sql`
			with per_user as (
				select user_id, count(*) as n
				from forge_creations
				where user_id is not null and status = 'done' and glb_url is not null
				group by user_id
				union all
				select user_id, count(*) as n
				from dioramas
				where user_id is not null
				group by user_id
			)
			select user_id, sum(n)::bigint as value
			from per_user
			group by user_id
		`;
	}
	if (metric === 'remixes_received') {
		return sql`
			with mine as (
				select id, user_id
				from forge_creations
				where user_id is not null and status = 'done'
			),
			children as (
				select parent_creation_id, count(*) as n
				from forge_creations
				where parent_creation_id is not null
				group by parent_creation_id
			)
			select m.user_id, sum(c.n)::bigint as value
			from mine m
			join children c on c.parent_creation_id = m.id
			group by m.user_id
		`;
	}
	if (metric === 'launches') {
		return sql`
			select user_id, count(*)::bigint as value
			from agent_identities
			where user_id is not null
			  and is_public = true
			  and deleted_at is null
			  and meta->'token'->>'mint' is not null
			group by user_id
		`;
	}
	if (metric === 'followers') {
		return sql`
			select following_id as user_id, count(*)::bigint as value
			from user_follows
			group by following_id
		`;
	}
	// walk_distance
	return sql`
		select user_id, sum(distance_meters)::float8 as value
		from walk_metrics
		where user_id is not null
		group by user_id
		having sum(distance_meters) > 0
	`;
}

async function resolveViewerId(req) {
	try {
		const bearer = extractBearer(req);
		const user = bearer ? await authenticateBearer(bearer) : await getSessionUser(req);
		return user?.userId || user?.id || user?.sub || null;
	} catch {
		return null;
	}
}

export default wrap(async (req, res) => {
	if (cors(req, res, { origins: '*', methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, 'http://x');
	const metric = url.searchParams.get('metric') || 'creations';
	if (!METRICS.has(metric)) {
		return error(res, 400, 'bad_metric', 'metric must be one of: ' + [...METRICS].join(', '));
	}
	const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 100);
	const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);

	const rows = await rankingRows(metric);

	const ranked = rows
		.map((r) => ({ userId: r.user_id, value: Number(r.value) || 0 }))
		.filter((r) => r.value > 0)
		.sort((a, b) => (b.value !== a.value ? b.value - a.value : a.userId < b.userId ? -1 : 1));

	const total = ranked.length;
	const rankByUser = new Map();
	ranked.forEach((r, i) => rankByUser.set(r.userId, i + 1));

	const page = ranked.slice(offset, offset + limit);

	const viewerId = await resolveViewerId(req);
	const idsNeeded = new Set(page.map((r) => r.userId));
	if (viewerId) idsNeeded.add(viewerId);

	const profiles = new Map();
	const idList = [...idsNeeded];
	if (idList.length) {
		const profRows = await sql`
			select u.id, u.username, u.display_name,
			       (select thumbnail_key from avatars
			          where owner_id = u.id and deleted_at is null and thumbnail_key is not null
			          order by created_at desc limit 1) as thumbnail_key
			from users u
			where u.id = any(${idList}) and u.deleted_at is null
		`;
		for (const p of profRows) profiles.set(p.id, p);
	}

	function toRow(r) {
		const prof = profiles.get(r.userId);
		const handle = prof?.username ? `@${prof.username}` : prof?.display_name || 'three.ws creator';
		return {
			rank: rankByUser.get(r.userId),
			userId: r.userId,
			username: prof?.username || null,
			handle,
			profileUrl: prof?.username ? `/u/${prof.username}` : null,
			avatar: thumbnailUrl(prof?.thumbnail_key),
			value: metric === 'walk_distance' ? Math.round(r.value * 100) / 100 : Math.round(r.value),
		};
	}

	const pageRows = page.map(toRow);

	let me = null;
	if (viewerId) {
		if (rankByUser.has(viewerId)) {
			const entry = ranked.find((r) => r.userId === viewerId);
			me = toRow(entry);
			me.onPage = pageRows.some((r) => r.userId === viewerId);
		} else {
			const prof = profiles.get(viewerId);
			me = {
				rank: null,
				userId: viewerId,
				username: prof?.username || null,
				handle: prof?.username ? `@${prof.username}` : prof?.display_name || 'you',
				profileUrl: prof?.username ? `/u/${prof.username}` : null,
				avatar: thumbnailUrl(prof?.thumbnail_key),
				value: 0,
				onPage: false,
				unranked: true,
			};
		}
	}

	res.setHeader('cache-control', 'public, max-age=15, s-maxage=30, stale-while-revalidate=60');

	return json(res, 200, {
		metric,
		metricLabel: METRIC_LABEL[metric],
		total,
		limit,
		offset,
		hasMore: offset + limit < total,
		rows: pageRows,
		me,
	});
});
