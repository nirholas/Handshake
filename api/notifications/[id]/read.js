// POST /api/notifications/:id/read — mark a single notification as read.

import { sql } from '../../_lib/db.js';
import { getRequestUser } from '../../_lib/auth.js';
import { cors, json, method, wrap, error } from '../../_lib/http.js';
import { requireCsrf } from '../../_lib/csrf.js';

// Matches the sibling DELETE handler: `user_notifications.id` is a uuid column,
// so a non-uuid id is a client mistake to reject at the boundary, not a query to
// send. Without this the cast failed inside Postgres and the caller got a 500.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const user = await getRequestUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	if (!(await requireCsrf(req, res, user.id))) return;

	const id = req.query?.id;
	if (!id || !UUID_RE.test(String(id))) {
		return error(res, 400, 'validation_error', 'a notification id (uuid) is required');
	}

	const [row] = await sql`
		update user_notifications
		set read_at = coalesce(read_at, now())
		where id = ${id} and user_id = ${user.id}
		returning id, read_at
	`;

	if (!row) return error(res, 404, 'not_found', 'notification not found');

	return json(res, 200, { id: row.id, read_at: row.read_at });
});
