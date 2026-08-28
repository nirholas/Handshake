// DELETE /api/companion/contacts/:id → forget a contact. Messages already
// stored keep their text; they simply stop being attributed to that person.

import { getRequestUser } from '../../_lib/auth.js';
import { cors, json, method, wrap, error, rateLimited } from '../../_lib/http.js';
import { requireCsrf } from '../../_lib/csrf.js';
import { limits } from '../../_lib/rate-limit.js';
import { deleteContact } from '../../_lib/companion/store.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'DELETE,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['DELETE'])) return;

	const user = await getRequestUser(req, res);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');
	if (!(await requireCsrf(req, res, user.id))) return;

	const rl = await limits.companionWrite(user.id);
	if (!rl.success) return rateLimited(res, rl);

	const id = String(req.query?.id || '').trim();
	if (!/^[0-9a-f-]{36}$/i.test(id)) return error(res, 400, 'validation_error', 'invalid contact id');

	const removed = await deleteContact(user.id, id);
	if (!removed) return error(res, 404, 'not_found', 'no such contact');
	return json(res, 200, { deleted: true });
});
