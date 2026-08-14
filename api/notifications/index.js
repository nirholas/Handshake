// GET /api/notifications — list recent notifications for the authenticated user.

import { sql } from '../_lib/db.js';
import { getRequestUser } from '../_lib/auth.js';
import { cors, json, method, wrap, error, rateLimited } from '../_lib/http.js';
import { limits } from '../_lib/rate-limit.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const user = await getRequestUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.notificationsRead(user.id);
	if (!rl.success) return rateLimited(res, rl);

	const params = new URL(req.url, 'http://x').searchParams;
	// A non-numeric ?limit parses to NaN, and NaN survives both clamps — it then
	// reached Postgres as `limit NaN` and 500'd the whole list. Fall back to the
	// default instead, so a junk value degrades to the normal page.
	const limitRaw = Number.parseInt(params.get('limit') || '20', 10);
	const limit = Number.isFinite(limitRaw) ? Math.min(50, Math.max(1, limitRaw)) : 20;
	// Optional type filter (e.g. ?type=pump_alert). Validated against a strict
	// shape so the parameter can't smuggle anything unexpected into the query.
	const typeRaw = (params.get('type') || '').trim();
	const type = /^[a-z0-9_]{1,40}$/.test(typeRaw) ? typeRaw : null;
	// Optional cursor for "load more" on the full notification-center page
	// (pages/notifications.html): pass the last row's created_at to page past it.
	// The bell dropdown never sends this — it only ever wants the latest page.
	const beforeRaw = params.get('before');
	const before = beforeRaw && !Number.isNaN(Date.parse(beforeRaw)) ? new Date(beforeRaw) : null;

	const notifications = type && before
		? await sql`
			select id, type, payload, read_at, created_at
			from user_notifications
			where user_id = ${user.id} and type = ${type} and created_at < ${before}
			order by created_at desc
			limit ${limit}
		`
		: type
		? await sql`
			select id, type, payload, read_at, created_at
			from user_notifications
			where user_id = ${user.id} and type = ${type}
			order by created_at desc
			limit ${limit}
		`
		: before
		? await sql`
			select id, type, payload, read_at, created_at
			from user_notifications
			where user_id = ${user.id} and created_at < ${before}
			order by created_at desc
			limit ${limit}
		`
		: await sql`
			select id, type, payload, read_at, created_at
			from user_notifications
			where user_id = ${user.id}
			order by created_at desc
			limit ${limit}
		`;

	const [{ unread_count }] = await sql`
		select count(*)::int as unread_count
		from user_notifications
		where user_id = ${user.id} and read_at is null
	`;

	return json(res, 200, {
		notifications: notifications.map((n) => ({
			id: n.id,
			type: n.type,
			payload: n.payload,
			read_at: n.read_at ?? null,
			created_at: n.created_at,
		})),
		unread_count,
		has_more: notifications.length === limit,
	});
});
