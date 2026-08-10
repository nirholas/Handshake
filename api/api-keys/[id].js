import { sql } from '../_lib/db.js';
import { getSessionUser, authenticateBearer, extractBearer, hasScope } from '../_lib/auth.js';
import { logAudit } from '../_lib/audit.js';
import { cors, json, error, wrap, method, rateLimited } from '../_lib/http.js';
import { requireCsrf } from '../_lib/csrf.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { isUuid } from '../_lib/validate.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'DELETE,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['DELETE'])) return;

	const session = await getSessionUser(req);
	const bearer = session ? null : await authenticateBearer(extractBearer(req));
	if (!session && !bearer) return error(res, 401, 'unauthorized', 'sign in required');
	if (bearer && !hasScope(bearer.scope, 'profile'))
		return error(res, 403, 'insufficient_scope', 'requires profile scope');
	const userId = session?.id ?? bearer.userId;
	if (session && !(await requireCsrf(req, res, session.id))) return;

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const { id } = req.query;
	// api_keys.id is a uuid column: a non-uuid path segment makes Postgres raise
	// 22P02 and the request lands as a 500 with a support ref. It is bad input,
	// not a server fault, so reject it here.
	if (!isUuid(id)) return error(res, 400, 'invalid_id', 'API key id must be a UUID');

	const [row] = await sql`
		update api_keys
		set revoked_at = now()
		where id = ${id} and user_id = ${userId} and revoked_at is null
		returning id
	`;

	if (!row) return error(res, 404, 'not_found', 'API key not found or already revoked');

	logAudit({
		userId,
		action: 'revoke_api_key',
		resourceId: row.id,
		meta: { via: session ? 'session' : 'bearer' },
	});
	return json(res, 200, { data: { id: row.id, revoked: true } });
});
