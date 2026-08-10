import { sql } from '../../_lib/db.js';
import { getSessionUser } from '../../_lib/auth.js';
import { cors, json, method, wrap, error, rateLimited } from '../../_lib/http.js';
import { requireCsrf } from '../../_lib/csrf.js';
import { limits, clientIp } from '../../_lib/rate-limit.js';
import { isUuid } from '../../_lib/validate.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'DELETE,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['DELETE'])) return;

	const user = await getSessionUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	if (!(await requireCsrf(req, res, user.id))) return;

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const { id } = req.query;
	// `agent_payout_wallets.id` is a uuid column: a non-uuid path segment makes
	// Postgres raise 22P02, which the wrap() boundary reports as a 500.
	if (!isUuid(id)) return error(res, 400, 'validation_error', 'wallet id must be a UUID');

	const [deleted] = await sql`
		delete from agent_payout_wallets
		where id = ${id} and user_id = ${user.id}
		returning id
	`;

	if (!deleted) return error(res, 404, 'not_found', 'wallet not found');

	return json(res, 200, { id: deleted.id });
});
