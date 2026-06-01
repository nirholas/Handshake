// GET /api/notifications — list recent notifications for the authenticated user.

import { sql } from '../_lib/db.js';
import { getSessionUser } from '../_lib/auth.js';
import { cors, json, method, wrap, error } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const user = await getSessionUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const params = new URL(req.url, 'http://x').searchParams;
	const limit = Math.min(50, Math.max(1, parseInt(params.get('limit') || '20', 10)));
	// Optional type filter (e.g. ?type=pump_alert). Validated against a strict
	// shape so the parameter can't smuggle anything unexpected into the query.
	const typeRaw = (params.get('type') || '').trim();
	const type = /^[a-z0-9_]{1,40}$/.test(typeRaw) ? typeRaw : null;

	const notifications = type
		? await sql`
			select id, type, payload, read_at, created_at
			from user_notifications
			where user_id = ${user.id} and type = ${type}
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
	});
});
