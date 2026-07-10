// GET /api/walk/leaderboard — the public walk leaderboard (task 39).
//
//   ?period = daily | weekly | all-time   (default weekly)
//   ?metric = distance | sites | time      (default distance)
//   ?limit  = 1..100                        (default 50)
//   ?offset = 0..                           (page offset)
//   ?anonId = <stable anon id>              (to pin an anonymous walker's row)
//
// Ranks walkers (signed-in users AND anonymous walkers) by one of three metrics
// aggregated over the chosen window from the walk_metrics rollup:
//   · distance — total metres walked
//   · sites    — distinct embed origins + extension hostnames the avatar walked on
//   · time     — total seconds spent walking
//
// Each row carries `deltaFromYesterday`: the same metric earned today minus the
// metric earned the prior UTC day, so the board shows momentum, not just totals.
// The requesting walker's own row is always returned (pinned), even when it falls
// outside the requested page — resolved from the session/bearer or the anonId.

import { cors, method, json, wrap, rateLimited, error } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { sql } from '../_lib/db.js';
import { getSessionUser, extractBearer, authenticateBearer } from '../_lib/auth.js';
import { thumbnailUrl } from '../_lib/r2.js';

export const maxDuration = 10;

const PERIODS = new Set(['daily', 'weekly', 'all-time']);
const METRICS = new Set(['distance', 'sites', 'time']);

// SQL expression that produces the ranked metric value for a set of summed
// columns. `sites` is a COUNT(DISTINCT …) so it can't be summed like the others —
// handled with its own aggregate in the query builders below.
function metricLabel(metric) {
	return metric === 'sites' ? 'sites' : metric === 'time' ? 'time' : 'distance';
}

// Window lower bound (inclusive UTC date) for a period. all-time → null (no bound).
function periodStartDate(period) {
	if (period === 'all-time') return null;
	const now = new Date();
	const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
	if (period === 'weekly') d.setUTCDate(d.getUTCDate() - 6); // today + previous 6 days
	return d.toISOString().slice(0, 10);
}

async function resolveWalker(req, anonIdParam) {
	try {
		const bearer = extractBearer(req);
		const user = bearer ? await authenticateBearer(bearer) : await getSessionUser(req);
		const userId = user?.userId || user?.id || user?.sub || null;
		if (userId) return { userId, anonId: null };
	} catch {
		/* fall through to anon */
	}
	return { userId: null, anonId: anonIdParam || null };
}

// Build the metric aggregate fragment for the SELECT and ORDER BY.
function aggExpr(metric) {
	if (metric === 'distance') return sql`coalesce(sum(distance_meters), 0)`;
	if (metric === 'time') return sql`coalesce(sum(duration_sec), 0)`;
	// sites: distinct of embed_origin OR site_hostname, whichever is present.
	return sql`count(distinct coalesce(embed_origin, site_hostname)) filter (where coalesce(embed_origin, site_hostname) is not null)`;
}

// Per-walker aggregation over an optional [start, end) day window, returning a
// keyed map of { '<u|a>:<id>': value }. Used both for the ranked board and for
// the today/yesterday delta passes.
async function aggregateByWalker(metric, startDay, endDayExclusive) {
	const value = aggExpr(metric);
	let where = sql`where (user_id is not null or anon_id is not null)`;
	if (startDay) where = sql`${where} and day >= ${startDay}`;
	if (endDayExclusive) where = sql`${where} and day < ${endDayExclusive}`;
	const rows = await sql`
		select
			user_id,
			anon_id,
			${value} as value
		from walk_metrics
		${where}
		group by user_id, anon_id
		having ${value} > 0
	`;
	const map = new Map();
	for (const r of rows) {
		const key = r.user_id ? `u:${r.user_id}` : `a:${r.anon_id}`;
		map.set(key, { userId: r.user_id, anonId: r.anon_id, value: Number(r.value) });
	}
	return map;
}

// Short, stable, privacy-preserving handle for an anonymous walker.
function anonHandle(anonId) {
	const tail = String(anonId || '').replace(/[^a-zA-Z0-9]/g, '').slice(-4) || '0000';
	return `walker-${tail}`;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { origins: '*', methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, 'http://x');
	const period = url.searchParams.get('period') || 'weekly';
	const metric = url.searchParams.get('metric') || 'distance';
	if (!PERIODS.has(period)) return error(res, 400, 'bad_period', 'period must be daily, weekly or all-time');
	if (!METRICS.has(metric)) return error(res, 400, 'bad_metric', 'metric must be distance, sites or time');

	const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 100);
	const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);

	const startDay = periodStartDate(period);
	const today = new Date().toISOString().slice(0, 10);
	const yesterday = (() => {
		const d = new Date();
		d.setUTCDate(d.getUTCDate() - 1);
		return d.toISOString().slice(0, 10);
	})();

	// Full ranking for the window, plus today/yesterday slices for the delta.
	const [windowMap, todayMap, yesterdayMap] = await Promise.all([
		aggregateByWalker(metric, startDay, null),
		aggregateByWalker(metric, today, null),
		aggregateByWalker(metric, yesterday, today),
	]);

	// Sort all walkers descending by the window metric, break ties by key for
	// determinism, then assign dense ranks.
	const ranked = [...windowMap.values()].sort((a, b) => {
		if (b.value !== a.value) return b.value - a.value;
		const ka = a.userId ? `u:${a.userId}` : `a:${a.anonId}`;
		const kb = b.userId ? `u:${b.userId}` : `a:${b.anonId}`;
		return ka < kb ? -1 : ka > kb ? 1 : 0;
	});
	const total = ranked.length;

	const rankByKey = new Map();
	ranked.forEach((w, i) => {
		const key = w.userId ? `u:${w.userId}` : `a:${w.anonId}`;
		rankByKey.set(key, i + 1);
	});

	const page = ranked.slice(offset, offset + limit);

	// Resolve profile fields (handle + avatar thumb) for the signed-in users on
	// this page plus the requesting walker, in one query.
	const walker = await resolveWalker(req, url.searchParams.get('anonId'));
	const userIdsNeeded = new Set(page.filter((w) => w.userId).map((w) => w.userId));
	if (walker.userId) userIdsNeeded.add(walker.userId);

	const profiles = new Map();
	const idList = [...userIdsNeeded];
	if (idList.length) {
		const rows = await sql`
			select u.id, u.username, u.display_name,
			       (select thumbnail_key from avatars
			          where owner_id = u.id and deleted_at is null and thumbnail_key is not null
			          order by created_at desc limit 1) as thumbnail_key,
			       (select id from avatars
			          where owner_id = u.id and deleted_at is null
			          order by created_at desc limit 1) as avatar_id
			from users u
			where u.id = any(${idList}) and u.deleted_at is null
		`;
		for (const r of rows) profiles.set(r.id, r);
	}

	function metricNow(key) {
		return todayMap.get(key)?.value || 0;
	}
	function metricPrev(key) {
		return yesterdayMap.get(key)?.value || 0;
	}

	function toRow(w, rank) {
		const key = w.userId ? `u:${w.userId}` : `a:${w.anonId}`;
		const prof = w.userId ? profiles.get(w.userId) : null;
		const handle = prof
			? prof.username
				? `@${prof.username}`
				: prof.display_name || 'three.ws walker'
			: anonHandle(w.anonId);
		return {
			rank,
			key,
			userId: w.userId || null,
			anonId: w.userId ? null : w.anonId,
			username: prof?.username || null,
			handle,
			profileUrl: prof?.username ? `/u/${prof.username}` : null,
			avatarId: prof?.avatar_id || null,
			avatar: thumbnailUrl(prof?.thumbnail_key),
			value: Math.round(w.value * 100) / 100,
			deltaFromYesterday: Math.round((metricNow(key) - metricPrev(key)) * 100) / 100,
		};
	}

	const rows = page.map((w) => toRow(w, rankByKey.get(w.userId ? `u:${w.userId}` : `a:${w.anonId}`)));

	// The requester's own pinned row (even if off-page).
	let me = null;
	const meKey = walker.userId ? `u:${walker.userId}` : walker.anonId ? `a:${walker.anonId}` : null;
	if (meKey && rankByKey.has(meKey)) {
		const w = windowMap.get(meKey);
		me = toRow(w, rankByKey.get(meKey));
		me.onPage = rows.some((r) => r.key === meKey);
	} else if (meKey) {
		// Walker has an identity but no qualifying metrics in this window yet.
		me = {
			rank: null,
			key: meKey,
			userId: walker.userId,
			anonId: walker.userId ? null : walker.anonId,
			handle: walker.userId
				? profiles.get(walker.userId)?.username
					? `@${profiles.get(walker.userId).username}`
					: profiles.get(walker.userId)?.display_name || 'you'
				: anonHandle(walker.anonId),
			value: 0,
			deltaFromYesterday: 0,
			onPage: false,
			unranked: true,
		};
	}

	// Public read — let the CDN cache it briefly; the board updates on a cadence.
	res.setHeader('cache-control', 'public, max-age=15, s-maxage=30, stale-while-revalidate=60');

	return json(res, 200, {
		period,
		metric: metricLabel(metric),
		total,
		limit,
		offset,
		hasMore: offset + limit < total,
		rows,
		me,
	});
});
