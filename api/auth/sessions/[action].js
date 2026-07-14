// Session endpoints — dispatched by req.query.action.
//   GET    /api/auth/sessions          → handleList            (action undefined)
//   DELETE /api/auth/sessions          → handleRevokeOthers    (action undefined)
//   DELETE /api/auth/sessions/<uuid>   → handleRevokeOne       (action === <uuid>)
//
// Dispatcher convention: undefined action → index (GET list / DELETE
// revoke-others-and-rotate), and any other action is treated as a session id
// for individual revoke.

import { sql } from '../../_lib/db.js';
import { getSessionUser, rotateSession, sessionCookie } from '../../_lib/auth.js';
import { cors, json, method, wrap, error, rateLimited } from '../../_lib/http.js';
import { requireCsrf } from '../../_lib/csrf.js';
import { limits, clientIp } from '../../_lib/rate-limit.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default wrap(async (req, res) => {
	// action arrives via the route table (?action=$1) when a subpath was hit.
	// Behind the Cloud Run rewrite the bare index path keeps its ORIGINAL
	// pathname on req.url (see server/index.mjs), so the URL fallback must map
	// the endpoint's own directory segment ("sessions") back to "no action";
	// otherwise GET/DELETE /api/auth/sessions dispatches to the per-id revoke
	// branch and 405s.
	let action = req.query?.action;
	if (action === undefined) {
		const last = new URL(req.url, 'http://x').pathname.split('/').filter(Boolean).pop();
		action = last === 'sessions' ? undefined : last;
	}

	if (action === undefined || action === '' || action === null) {
		return handleIndex(req, res);
	}

	return handleRevokeOne(req, res, action);
});

// ── Index: list (GET) and revoke-others (DELETE) ──────────────────────────

async function handleIndex(req, res) {
	if (cors(req, res, { methods: 'GET,DELETE,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'DELETE'])) return;

	const user = await getSessionUser(req);
	if (!user) return error(res, 401, 'unauthenticated', 'not signed in');

	const ip = clientIp(req);
	const rl = await limits.authIp(ip);
	if (!rl.success) return rateLimited(res, rl);

	if (req.method === 'GET') {
		const rows = await sql`
			select id, user_agent, ip, created_at, last_seen_at, expires_at
			from sessions
			where user_id = ${user.id}
			  and revoked_at is null
			  and expires_at > now()
			order by last_seen_at desc nulls last
		`;
		const sessions = rows.map((s) => ({
			id: s.id,
			user_agent: s.user_agent,
			ip: s.ip,
			created_at: s.created_at,
			last_seen_at: s.last_seen_at,
			expires_at: s.expires_at,
			is_current: s.id === user.sid,
		}));
		return json(res, 200, { sessions });
	}

	// DELETE — revoke all other sessions, then rotate the current one so the user
	// stays signed in on this device with a fresh cookie ("log out everywhere else").
	if (!(await requireCsrf(req, res, user.id))) return;

	const ua = req.headers['user-agent'] || null;
	const result = await sql`
		update sessions
		set revoked_at = now()
		where user_id = ${user.id}
		  and revoked_at is null
		  and id != ${user.sid}
	`;

	// Rotate the current session so any stolen copy of this cookie is invalidated.
	const newToken = await rotateSession({
		currentSid: user.sid,
		userId: user.id,
		userAgent: ua,
		ip,
	});
	const existing = res.getHeader('set-cookie') || [];
	const arr = Array.isArray(existing) ? existing : [existing];
	res.setHeader('set-cookie', [...arr, sessionCookie(newToken)]);

	return json(res, 200, { revoked: result.count });
}

// ── Revoke one session by id ──────────────────────────────────────────────

async function handleRevokeOne(req, res, sessionIdFromAction) {
	if (cors(req, res, { methods: 'DELETE,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['DELETE'])) return;

	const user = await getSessionUser(req);
	if (!user) return error(res, 401, 'unauthenticated', 'not signed in');
	if (!(await requireCsrf(req, res, user.id))) return;

	const sessionId = req.query.id || sessionIdFromAction || req.url.split('/').pop();
	if (!UUID_REGEX.test(sessionId))
		return error(res, 400, 'invalid_id', 'session id must be a valid UUID');

	const rows = await sql`
		select id from sessions
		where id = ${sessionId} and user_id = ${user.id}
		limit 1
	`;

	if (!rows[0]) return error(res, 404, 'not_found', 'session not found');

	if (sessionId === user.sid)
		return error(
			res,
			409,
			'cannot_revoke_current',
			'use POST /api/auth/logout to end the current session',
		);

	await sql`update sessions set revoked_at = now() where id = ${sessionId}`;
	return json(res, 200, { revoked: 1 });
}
