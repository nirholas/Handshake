// DELETE /api/keys/:id revokes an API key.

import { sql } from '../_lib/db.js';
import { getSessionUser } from '../_lib/auth.js';
import { logAudit } from '../_lib/audit.js';
import { cors, json, method, wrap, error, rateLimited } from '../_lib/http.js';
import { requireCsrf } from '../_lib/csrf.js';
import { limits } from '../_lib/rate-limit.js';
import { isUuid } from '../_lib/validate.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'DELETE,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['DELETE'])) return;

	const user = await getSessionUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'sign in to manage API keys');

	if (!(await requireCsrf(req, res, user.id))) return;

	// Revocation is the safety valve for a leaked key, so it rides its own bucket
	// rather than the mint budget: minting keys must never be able to block
	// killing one. See limits.apiKeyRevoke.
	const rl = await limits.apiKeyRevoke(user.id);
	if (!rl.success) return rateLimited(res, rl);

	const id = req.query?.id || new URL(req.url, 'http://x').pathname.split('/').pop();
	// api_keys.id is a uuid column: handing Postgres a non-uuid path segment
	// raises 22P02 and the caller gets a 500 with a support ref for what is
	// plainly bad input. Reject it here, the way api/api-keys/[id].js does.
	if (!isUuid(id)) return error(res, 400, 'invalid_id', 'API key id must be a UUID');

	const rows = await sql`
		update api_keys set revoked_at = now()
		where id = ${id} and user_id = ${user.id} and revoked_at is null
		returning id
	`;
	if (!rows[0]) return error(res, 404, 'not_found', 'key not found or already revoked');
	logAudit({
		userId: user.id,
		action: 'revoke_api_key',
		resourceId: rows[0].id,
		meta: { via: 'session' },
		req,
	});
	return json(res, 200, { ok: true });
});
