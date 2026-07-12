// GET /api/cron/leaderboard-rollup — daily top-10 badge sweep for the
// cross-surface leaderboard (prompt 06 of the user-value pack).
//
// The leaderboard itself (GET /api/leaderboard/unified) is read live — none of
// its five metrics need a rollup table, the underlying queries are cheap
// aggregates the same way /api/walk/leaderboard's all-time window already is.
// The ONE thing that genuinely needs a daily cadence is the "top10_<metric>"
// badge: a placement earned today shouldn't quietly stop being true if the
// user's rank slips tomorrow, so it has to be captured at a point in time
// rather than recomputed live. This cron is that point in time — once daily,
// walk the top 10 of each metric and award the badge to whoever is there right
// now. Idempotent (user_badges is unique on user_id+code), so a user who holds
// top-10 for a week earns the badge once, on day one.

import { error, json, method, wrapCron } from '../_lib/http.js';
import { env } from '../_lib/env.js';
import { constantTimeEquals } from '../_lib/crypto.js';
import { sql } from '../_lib/db.js';
import { unlockBadge, BADGES } from '../_lib/streaks.js';

const METRICS = ['creations', 'remixes_received', 'launches', 'followers', 'walk_distance'];

function requireCron(req, res) {
	const secret = process.env.CRON_SECRET || env.CRON_SECRET;
	if (!secret) {
		error(res, 503, 'not_configured', 'CRON_SECRET unset');
		return false;
	}
	const auth = req.headers['authorization'] || '';
	const presented = auth.startsWith('Bearer ') ? auth.slice(7) : '';
	if (!constantTimeEquals(presented, secret)) {
		error(res, 401, 'unauthorized', 'invalid cron secret');
		return false;
	}
	return true;
}

async function top10UserIds(metric) {
	if (metric === 'creations') {
		const rows = await sql`
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
			having sum(n) > 0
			order by value desc
			limit 10
		`;
		return rows.map((r) => r.user_id);
	}
	if (metric === 'remixes_received') {
		const rows = await sql`
			with mine as (
				select id, user_id from forge_creations where user_id is not null and status = 'done'
			),
			children as (
				select parent_creation_id, count(*) as n from forge_creations
				where parent_creation_id is not null group by parent_creation_id
			)
			select m.user_id, sum(c.n)::bigint as value
			from mine m join children c on c.parent_creation_id = m.id
			group by m.user_id
			order by value desc
			limit 10
		`;
		return rows.map((r) => r.user_id);
	}
	if (metric === 'launches') {
		const rows = await sql`
			select user_id, count(*)::bigint as value
			from agent_identities
			where user_id is not null and is_public = true and deleted_at is null
			  and meta->'token'->>'mint' is not null
			group by user_id
			order by value desc
			limit 10
		`;
		return rows.map((r) => r.user_id);
	}
	if (metric === 'followers') {
		const rows = await sql`
			select following_id as user_id, count(*)::bigint as value
			from user_follows
			group by following_id
			order by value desc
			limit 10
		`;
		return rows.map((r) => r.user_id);
	}
	// walk_distance
	const rows = await sql`
		select user_id, sum(distance_meters)::float8 as value
		from walk_metrics
		where user_id is not null
		group by user_id
		having sum(distance_meters) > 0
		order by value desc
		limit 10
	`;
	return rows.map((r) => r.user_id);
}

export default wrapCron(async (req, res) => {
	if (!method(req, res, ['GET'])) return;
	if (!requireCron(req, res)) return;

	const awarded = {};
	for (const metric of METRICS) {
		const userIds = await top10UserIds(metric).catch((err) => {
			console.error(`[leaderboard-rollup] ${metric} ranking failed:`, err?.message);
			return [];
		});
		let count = 0;
		for (const userId of userIds) {
			const newlyAwarded = await unlockBadge(userId, BADGES.TOP10(metric), { metric });
			if (newlyAwarded) count += 1;
		}
		awarded[metric] = { checked: userIds.length, newlyAwarded: count };
	}

	return json(res, 200, { ok: true, awarded, ranAt: new Date().toISOString() });
});
