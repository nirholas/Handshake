// GET  /api/monetization/withdrawals?agent_id=X     — list withdrawal history
// POST /api/monetization/withdrawals                — request a withdrawal
//
// Body (POST): { agent_id, amount_usdc? }
//   amount_usdc = null → withdraw all available balance

import { z } from 'zod';
import { sql } from '../_lib/db.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { cors, json, method, wrap, error, readJson } from '../_lib/http.js';
import { parse, isValidSolanaAddress, isValidEvmAddress } from '../_lib/validate.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { requireCsrf } from '../_lib/csrf.js';
import { getAvailableBalance } from '../_lib/monetization.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MIN_WITHDRAWAL_USDC = 1; // 1 USDC minimum
const MIN_WITHDRAWAL_ATOMIC = MIN_WITHDRAWAL_USDC * 1_000_000;

const postBody = z.object({
	agent_id: z.string().uuid(),
	amount_usdc: z.number().positive().nullable().optional(),
});

async function resolveUser(req) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id, source: 'session' };
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) return { userId: bearer.userId, source: 'bearer' };
	return null;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	const auth = await resolveUser(req);
	if (!auth) return error(res, 401, 'unauthorized', 'Sign in required');
	const { userId } = auth;

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	if (req.method === 'GET') {
		const params = new URL(req.url, 'http://x').searchParams;
		const agentId = params.get('agent_id') || null;
		const statusFilter = params.get('status') || null;
		const limit = Math.min(100, Math.max(1, parseInt(params.get('limit') || '20', 10)));
		const offset = Math.max(0, parseInt(params.get('offset') || '0', 10));

		if (agentId && !UUID_RE.test(agentId)) {
			return error(res, 400, 'validation_error', 'agent_id must be a UUID');
		}

		// Verify agent ownership if specified
		if (agentId) {
			const [agent] = await sql`
				SELECT id, user_id FROM agent_identities
				WHERE id = ${agentId} AND deleted_at IS NULL
			`;
			if (!agent) return error(res, 404, 'not_found', 'Agent not found');
			if (agent.user_id !== userId) return error(res, 403, 'forbidden', 'You don\'t own this agent');
		}

		// Build withdrawal list query based on filters
		let withdrawals;
		if (agentId && statusFilter) {
			withdrawals = await sql`
				SELECT id, agent_id, amount, currency_mint, chain, to_address,
				       status, tx_signature, error_message, created_at, updated_at
				FROM agent_withdrawals
				WHERE user_id = ${userId} AND agent_id = ${agentId} AND status = ${statusFilter}
				ORDER BY created_at DESC
				LIMIT ${limit}::int OFFSET ${offset}::int
			`;
		} else if (agentId) {
			withdrawals = await sql`
				SELECT id, agent_id, amount, currency_mint, chain, to_address,
				       status, tx_signature, error_message, created_at, updated_at
				FROM agent_withdrawals
				WHERE user_id = ${userId} AND agent_id = ${agentId}
				ORDER BY created_at DESC
				LIMIT ${limit}::int OFFSET ${offset}::int
			`;
		} else if (statusFilter) {
			withdrawals = await sql`
				SELECT id, agent_id, amount, currency_mint, chain, to_address,
				       status, tx_signature, error_message, created_at, updated_at
				FROM agent_withdrawals
				WHERE user_id = ${userId} AND status = ${statusFilter}
				ORDER BY created_at DESC
				LIMIT ${limit}::int OFFSET ${offset}::int
			`;
		} else {
			withdrawals = await sql`
				SELECT id, agent_id, amount, currency_mint, chain, to_address,
				       status, tx_signature, error_message, created_at, updated_at
				FROM agent_withdrawals
				WHERE user_id = ${userId}
				ORDER BY created_at DESC
				LIMIT ${limit}::int OFFSET ${offset}::int
			`;
		}

		// Get available balance for context
		const balance = await getAvailableBalance(userId);

		return json(res, 200, {
			withdrawals: withdrawals.map(formatWithdrawal),
			balance: {
				earned_usdc: balance.earned / 1_000_000,
				withdrawn_usdc: balance.withdrawn / 1_000_000,
				pending_usdc: balance.pending / 1_000_000,
				available_usdc: balance.available / 1_000_000,
			},
		});
	}

	// POST — request a withdrawal
	const csrfOk = await requireCsrf(req, res, userId);
	if (!csrfOk) return;

	const rlUser = await limits.withdrawalPerUser(userId);
	if (!rlUser.success) return error(res, 429, 'rate_limited', 'too many withdrawal requests');

	const body = parse(postBody, await readJson(req));
	const { agent_id, amount_usdc } = body;

	// Verify agent ownership
	const [agent] = await sql`
		SELECT id, user_id FROM agent_identities
		WHERE id = ${agent_id} AND deleted_at IS NULL
	`;
	if (!agent) return error(res, 404, 'not_found', 'Agent not found');
	if (agent.user_id !== userId) return error(res, 403, 'forbidden', 'You don\'t own this agent');

	// Resolve payout wallet
	const [wallet] = await sql`
		SELECT address, chain, preferred_network
		FROM agent_payout_wallets
		WHERE user_id = ${userId} AND (agent_id = ${agent_id} OR agent_id IS NULL)
		ORDER BY
			CASE WHEN agent_id = ${agent_id} THEN 0 ELSE 1 END,
			is_default DESC,
			created_at DESC
		LIMIT 1
	`;
	if (!wallet) {
		return error(res, 422, 'no_payout_wallet', 'Configure a payout wallet before requesting a withdrawal');
	}

	// Determine currency mint based on chain
	const currencyMint = wallet.chain === 'solana'
		? 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
		: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

	// Calculate available balance
	const balance = await getAvailableBalance(userId, currencyMint);

	// Determine withdrawal amount
	let amountAtomic;
	if (amount_usdc === null || amount_usdc === undefined) {
		// Withdraw all available
		amountAtomic = balance.available;
	} else {
		amountAtomic = Math.round(amount_usdc * 1_000_000);
	}

	if (amountAtomic < MIN_WITHDRAWAL_ATOMIC) {
		return error(res, 422, 'below_minimum', `Minimum withdrawal is ${MIN_WITHDRAWAL_USDC} USDC`);
	}

	if (amountAtomic > balance.available) {
		return error(res, 422, 'insufficient_balance', `Insufficient balance for withdrawal. Available: ${(balance.available / 1_000_000).toFixed(6)} USDC`);
	}

	const [withdrawal] = await sql`
		INSERT INTO agent_withdrawals
			(user_id, agent_id, amount, currency_mint, chain, to_address, status)
		VALUES
			(${userId}, ${agent_id}, ${amountAtomic}, ${currencyMint}, ${wallet.chain}, ${wallet.address}, 'pending')
		RETURNING id, agent_id, amount, currency_mint, chain, to_address, status, tx_signature, created_at, updated_at
	`;

	return json(res, 201, {
		withdrawal: formatWithdrawal(withdrawal),
		balance: {
			earned_usdc: balance.earned / 1_000_000,
			withdrawn_usdc: balance.withdrawn / 1_000_000,
			pending_usdc: (balance.pending + amountAtomic) / 1_000_000,
			available_usdc: (balance.available - amountAtomic) / 1_000_000,
		},
	});
});

function formatWithdrawal(w) {
	return {
		id: w.id,
		agent_id: w.agent_id,
		amount_usdc: Number(w.amount) / 1_000_000,
		amount_atomic: Number(w.amount),
		currency_mint: w.currency_mint,
		chain: w.chain,
		destination_address: w.to_address,
		status: w.status,
		tx_hash: w.tx_signature ?? null,
		error: w.error_message ?? null,
		requested_at: w.created_at,
		processed_at: w.updated_at !== w.created_at ? w.updated_at : null,
	};
}
