// GET /api/billing/withdrawals/:id — single withdrawal details

import { sql } from '../../_lib/db.js';
import { getSessionUser } from '../../_lib/auth.js';
import { cors, json, method, wrap, error, rateLimited } from '../../_lib/http.js';
import { limits, clientIp } from '../../_lib/rate-limit.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const user = await getSessionUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.authedReadIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const id = req.query?.id;

	const [withdrawal] = await sql`
		select id, agent_id, amount, currency_mint, chain, to_address,
		       status, tx_signature, created_at, updated_at
		from agent_withdrawals
		where id = ${id} and user_id = ${user.id}
	`;

	if (!withdrawal) return error(res, 404, 'not_found', 'withdrawal not found');

	return json(res, 200, { withdrawal });
});
