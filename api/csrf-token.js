// GET /api/csrf-token: issue a single-use CSRF token bound to the session user.
import { authenticateBearer, extractBearer, getSessionUser } from './_lib/auth.js';
import { cors, error, json, method, wrap } from './_lib/http.js';
import { issueCsrf } from './_lib/csrf.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const session = await getSessionUser(req);
	const bearer = session ? null : await authenticateBearer(extractBearer(req));
	const userId = session?.id || bearer?.userId;
	if (!userId) return error(res, 401, 'unauthorized', 'sign in required');

	const { token, expiresIn } = await issueCsrf(userId);
	// Return the token both at the top level AND under `data` so every client
	// accessor works regardless of the shape it expects (j.token, j.data.token,
	// or `const { token } = ...`). Mis-reading the envelope previously sent an
	// empty x-csrf-token header → 403 csrf_missing on otherwise-valid mutations.
	return json(res, 200, { token, expires_in: expiresIn, data: { token, expires_in: expiresIn } });
});
