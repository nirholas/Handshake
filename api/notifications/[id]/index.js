// DELETE /api/notifications/:id: permanently remove one of the caller's
// notifications from the inbox.
//
// The bell inbox dismiss action and the notifications MCP `delete_notification`
// tool both land here. Account-scoped: the row is deleted only when it belongs
// to the authenticated caller, so one user can never delete another's notice.
// Accepts a session cookie OR a bearer credential (API key / OAuth) so both the
// browser and machine clients can call it; CSRF self-exempts bearer.

import { sql } from '../../_lib/db.js';
import { getRequestUser } from '../../_lib/auth.js';
import { cors, json, method, wrap, error } from '../../_lib/http.js';
import { requireCsrf } from '../../_lib/csrf.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'DELETE,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['DELETE'])) return;

	const user = await getRequestUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	if (!(await requireCsrf(req, res, user.id))) return;

	const id = req.query?.id;
	if (!id || !UUID_RE.test(String(id))) {
		return error(res, 400, 'validation_error', 'a notification id (uuid) is required');
	}

	const [row] = await sql`
		delete from user_notifications
		where id = ${id} and user_id = ${user.id}
		returning id
	`;

	if (!row) return error(res, 404, 'not_found', 'notification not found');

	return json(res, 200, { ok: true, id: row.id, deleted: true });
});
