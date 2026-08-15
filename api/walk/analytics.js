// GET /api/walk/analytics — the per-creator embed analytics dashboard (task 40).
//
//   ?avatarId = <uuid>   (required)
//   ?from     = <ISO date>  (optional, default 30 days ago, UTC)
//   ?to       = <ISO date>  (optional, default today, UTC, inclusive)
//
// Owner-auth-gated: only the user who owns the avatar can read its analytics. A
// missing session → 401; a session that doesn't own the avatar → 403. Mirrors
// what Plausible / the Stripe dashboard offer, scoped to one walking avatar:
//   · totalSessions     — sessions counted across the window
//   · avgDurationSec     — total walk time / total sessions
//   · totalDistance      — metres walked
//   · uniqueOrigins      — distinct embed hosts the avatar walked on
//   · timeSeries[]       — per-day { date, sessions, distanceMeters, durationSec }
//   · topOrigins[]       — top 10 embed hosts by sessions
//   · events[]           — creator-defined events with count + conversion rate
//
// All figures come from the same walk_metrics / walk_events pipeline the ingest
// (POST /api/walk/metrics) writes — no sampling, no estimation.

import { cors, method, json, wrap, rateLimited, error } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { sql } from '../_lib/db.js';
import { isUuid } from '../_lib/validate.js';
import { getSessionUser, extractBearer, authenticateBearer, hasScope } from '../_lib/auth.js';

export const maxDuration = 10;

async function resolveAuth(req) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id };
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer && hasScope(bearer.scope, 'avatars:read')) return { userId: bearer.userId };
	return null;
}

// Clamp / default an ISO date param to a UTC YYYY-MM-DD string.
function normDate(value, fallback) {
	if (!value) return fallback;
	const d = new Date(value);
	if (Number.isNaN(d.getTime())) return fallback;
	return d.toISOString().slice(0, 10);
}

export default wrap(async (req, res) => {
	// Same-origin dashboard fetch; credentials carry the session cookie.
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, 'http://x');
	const avatarId = (url.searchParams.get('avatarId') || '').trim();
	if (!isUuid(avatarId)) return error(res, 400, 'bad_avatar_id', 'avatarId must be a UUID');

	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in to view analytics');

	// Ownership gate — the avatar must exist and belong to the caller.
	const [owned] = await sql`
		select id, owner_id, name, slug
		from avatars
		where id = ${avatarId} and deleted_at is null
		limit 1
	`;
	if (!owned) return error(res, 404, 'not_found', 'avatar not found');
	if (owned.owner_id !== auth.userId) {
		return error(res, 403, 'forbidden', 'you do not own this avatar');
	}

	const today = new Date().toISOString().slice(0, 10);
	const defaultFrom = (() => {
		const d = new Date();
		d.setUTCDate(d.getUTCDate() - 29); // 30-day window inclusive
		return d.toISOString().slice(0, 10);
	})();
	const from = normDate(url.searchParams.get('from'), defaultFrom);
	const to = normDate(url.searchParams.get('to'), today);
	// `to` is inclusive; aggregate with day <= to.

	// Totals across the window.
	const [totals] = await sql`
		select
			coalesce(sum(sessions), 0) as total_sessions,
			coalesce(sum(distance_meters), 0) as total_distance,
			coalesce(sum(duration_sec), 0) as total_duration,
			count(distinct embed_origin) filter (where embed_origin is not null) as unique_origins
		from walk_metrics
		where avatar_id = ${avatarId} and day >= ${from} and day <= ${to}
	`;

	const totalSessions = Number(totals?.total_sessions || 0);
	const totalDistance = Number(totals?.total_distance || 0);
	const totalDuration = Number(totals?.total_duration || 0);
	const uniqueOrigins = Number(totals?.unique_origins || 0);

	// Per-day series for the chart.
	const seriesRows = await sql`
		select
			day::text as date,
			coalesce(sum(sessions), 0) as sessions,
			coalesce(sum(distance_meters), 0) as distance_meters,
			coalesce(sum(duration_sec), 0) as duration_sec
		from walk_metrics
		where avatar_id = ${avatarId} and day >= ${from} and day <= ${to}
		group by day
		order by day asc
	`;

	// Fill missing days with zeroes so the chart x-axis is continuous.
	const byDate = new Map(
		seriesRows.map((r) => [
			r.date,
			{
				date: r.date,
				sessions: Number(r.sessions),
				distanceMeters: Math.round(Number(r.distance_meters) * 100) / 100,
				durationSec: Math.round(Number(r.duration_sec)),
			},
		]),
	);
	const timeSeries = [];
	{
		const cursor = new Date(`${from}T00:00:00Z`);
		const end = new Date(`${to}T00:00:00Z`);
		// Guard against an inverted range (from > to) producing an infinite loop.
		let guard = 0;
		while (cursor <= end && guard < 400) {
			const key = cursor.toISOString().slice(0, 10);
			timeSeries.push(
				byDate.get(key) || { date: key, sessions: 0, distanceMeters: 0, durationSec: 0 },
			);
			cursor.setUTCDate(cursor.getUTCDate() + 1);
			guard++;
		}
	}

	// Top 10 embed origins by session count.
	const originRows = await sql`
		select
			embed_origin as origin,
			coalesce(sum(sessions), 0) as sessions,
			coalesce(sum(distance_meters), 0) as distance_meters
		from walk_metrics
		where avatar_id = ${avatarId} and day >= ${from} and day <= ${to}
		  and embed_origin is not null
		group by embed_origin
		order by sessions desc, distance_meters desc
		limit 10
	`;
	const topOrigins = originRows.map((r) => ({
		origin: r.origin,
		sessions: Number(r.sessions),
		distanceMeters: Math.round(Number(r.distance_meters) * 100) / 100,
	}));

	// Creator-defined events with conversion rate vs sessions.
	const eventRows = await sql`
		select
			event_name as name,
			count(*) as count,
			coalesce(sum(value), 0) as total_value
		from walk_events
		where avatar_id = ${avatarId}
		  and created_at >= ${`${from}T00:00:00Z`}
		  and created_at < ${`${to}T00:00:00Z`}::timestamptz + interval '1 day'
		group by event_name
		order by count desc
	`;
	const events = eventRows.map((r) => {
		const count = Number(r.count);
		return {
			name: r.name,
			count,
			totalValue: Math.round(Number(r.total_value) * 100) / 100,
			conversionRate: totalSessions > 0 ? Math.round((count / totalSessions) * 10000) / 100 : 0,
		};
	});

	return json(res, 200, {
		avatar: { id: owned.id, name: owned.name, slug: owned.slug },
		range: { from, to },
		totalSessions,
		avgDurationSec: totalSessions > 0 ? Math.round(totalDuration / totalSessions) : 0,
		totalDistance: Math.round(totalDistance * 100) / 100,
		uniqueOrigins,
		timeSeries,
		topOrigins,
		events,
	});
});
