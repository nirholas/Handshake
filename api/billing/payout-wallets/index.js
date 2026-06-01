import { sql } from '../../_lib/db.js';
import { getSessionUser } from '../../_lib/auth.js';
import { cors, json, method, wrap, error, readJson } from '../../_lib/http.js';
import { parse, isValidSolanaAddress, isValidEvmAddress } from '../../_lib/validate.js';
import { limits, clientIp } from '../../_lib/rate-limit.js';
import { requireCsrf } from '../../_lib/csrf.js';
import { z } from 'zod';

const postBody = z.object({
	address: z.string().trim().min(1).max(100),
	chain: z.enum(['solana', 'base', 'evm']),
	agent_id: z.string().uuid().nullable().optional(),
	is_default: z.boolean().optional().default(false),
});

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	const user = await getSessionUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	if (req.method === 'GET') {
		const wallets = await sql`
			select id, agent_id, address, chain, is_default, created_at
			from agent_payout_wallets
			where user_id = ${user.id}
			order by created_at desc
		`;
		return json(res, 200, { wallets });
	}

	// POST — CSRF on state-changing session-cookie request.
	if (!(await requireCsrf(req, res, user.id))) return;

	const body = parse(postBody, await readJson(req));
	const { address, chain, agent_id = null, is_default } = body;

	if (chain === 'solana' && !isValidSolanaAddress(address)) {
		return error(res, 400, 'validation_error', 'invalid Solana address');
	}
	if ((chain === 'base' || chain === 'evm') && !isValidEvmAddress(address)) {
		return error(res, 400, 'validation_error', 'invalid EVM address');
	}

	// Verify agent_id belongs to this user if provided
	if (agent_id) {
		const [agent] = await sql`
			select id from agent_identities
			where id = ${agent_id} and user_id = ${user.id} and deleted_at is null
		`;
		if (!agent) return error(res, 404, 'not_found', 'agent not found');
	}

	let wallet;
	if (is_default) {
		// Clear existing defaults for (user, chain) in a transaction, then insert
		const clearDefault =
			agent_id !== null
				? sql`update agent_payout_wallets set is_default = false where user_id = ${user.id} and chain = ${chain} and agent_id = ${agent_id}`
				: sql`update agent_payout_wallets set is_default = false where user_id = ${user.id} and chain = ${chain} and agent_id is null`;
		const insert = sql`
			insert into agent_payout_wallets (user_id, agent_id, address, chain, is_default)
			values (${user.id}, ${agent_id}, ${address}, ${chain}, true)
			returning id, agent_id, address, chain, is_default, created_at
		`;
		const results = await sql.transaction([clearDefault, insert]);
		[wallet] = results[1];
	} else {
		[wallet] = await sql`
			insert into agent_payout_wallets (user_id, agent_id, address, chain, is_default)
			values (${user.id}, ${agent_id}, ${address}, ${chain}, false)
			returning id, agent_id, address, chain, is_default, created_at
		`;
	}

	return json(res, 201, { wallet });
});
