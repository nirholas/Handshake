/**
 * POST /api/payments/intent
 * Creates an agent_payment_intents record for a skill purchase and returns
 * the payment details the frontend needs to build the Solana Pay transaction.
 *
 * This is the agent_payment_intents–based flow (distinct from the
 * skill_purchases Solana Pay reference flow at /api/marketplace/purchase).
 */
import { z } from 'zod';

import { sql } from '../_lib/db.js';
import { getSessionUser } from '../_lib/auth.js';
import { cors, json, method, readJson, wrap, error, rateLimited } from '../_lib/http.js';
import { clientIp, limits } from '../_lib/rate-limit.js';
import { parse } from '../_lib/validate.js';
import { nanoid } from 'nanoid';

const INTENT_TTL_MINUTES = 15;

// agent_id has to be uuid-shaped before it reaches Postgres: an unvalidated
// value went straight into a uuid-typed parameter, so "not-a-uuid" (or any
// non-string JSON value) raised SQLSTATE 22P02 and surfaced as a 500 plus an
// ops alert, when it is plain caller error and belongs in a 400.
const bodySchema = z.object({
	agent_id: z.string().uuid(),
	skill:    z.string().trim().min(1).max(200),
});

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const user = await getSessionUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	// readJson answers 415 on a wrong content-type and 400 on unparseable JSON,
	// and parse() answers 400 with the offending field, all through wrap().
	const { agent_id, skill } = parse(bodySchema, await readJson(req));

	// Fetch active skill price
	const [price] = await sql`
		SELECT amount, currency_mint, chain
		FROM agent_skill_prices
		WHERE agent_id = ${agent_id} AND skill = ${skill} AND is_active = true
		LIMIT 1
	`;
	if (!price) return error(res, 404, 'not_found', 'skill is not for sale');

	// Resolve creator payout wallet (agent-specific first, then user default)
	const [payout] = await sql`
		SELECT pw.address
		FROM agent_identities a
		JOIN agent_payout_wallets pw
		  ON pw.user_id = a.user_id
		 AND pw.chain = ${price.chain}
		 AND (pw.agent_id = a.id OR pw.is_default = true)
		WHERE a.id = ${agent_id} AND a.deleted_at IS NULL
		ORDER BY (pw.agent_id IS NOT NULL) DESC, pw.is_default DESC, pw.created_at ASC
		LIMIT 1
	`;

	// Fall back to agent meta.solana_address for legacy agents without payout wallet rows
	let recipient_address = payout?.address;
	if (!recipient_address) {
		const [agentRow] = await sql`SELECT meta FROM agent_identities WHERE id = ${agent_id}`;
		recipient_address = agentRow?.meta?.solana_address ?? null;
	}
	if (!recipient_address) {
		return error(res, 412, 'creator_wallet_missing', 'agent owner has not configured a payout wallet');
	}

	const memo       = nanoid(16);
	const intent_id  = `pi_${nanoid()}`;
	const now        = new Date();
	const expires_at = new Date(now.getTime() + INTENT_TTL_MINUTES * 60 * 1000);

	await sql`
		INSERT INTO agent_payment_intents
			(id, payer_user_id, agent_id, currency_mint, amount, memo,
			 start_time, end_time, status, cluster, payload, expires_at)
		VALUES
			(${intent_id}, ${user.id}, ${agent_id}, ${price.currency_mint},
			 ${String(price.amount)}, ${memo},
			 ${now}, ${expires_at}, 'pending', 'mainnet',
			 ${JSON.stringify({ skill, recipient_address })}, ${expires_at})
	`;

	return json(res, 201, {
		intent_id,
		recipient_address,
		amount:        String(price.amount),
		currency_mint: price.currency_mint,
		chain:         price.chain,
		memo,
		expires_at:    expires_at.toISOString(),
	});
});
