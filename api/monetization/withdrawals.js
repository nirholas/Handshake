// GET  /api/monetization/withdrawals?agent_id=X     — list withdrawal history
// POST /api/monetization/withdrawals                — request a withdrawal
//
// Body (POST): { agent_id, amount_usdc?, network? }
//   amount_usdc = null  withdraw all available balance
//   network             'solana' (default) | 'base' | 'evm'; picks which saved
//                       payout wallet, and therefore which balance, is drawn on

import { z } from 'zod';
import { sql } from '../_lib/db.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { cors, json, method, wrap, error, readJson, rateLimited } from '../_lib/http.js';
import { parse, isUuid } from '../_lib/validate.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { parseLimit, parseOffset } from '../_lib/http-params.js';
import { requireCsrf } from '../_lib/csrf.js';
import { getAvailableBalance } from '../_lib/monetization.js';

const MIN_WITHDRAWAL_USDC = 1; // 1 USDC minimum
const MIN_WITHDRAWAL_ATOMIC = MIN_WITHDRAWAL_USDC * 1_000_000;

// The lifecycle the payout cron (api/cron/[name].js) actually writes. Anything
// else in `?status=` is a caller typo, and answering it with an empty page
// reads as "you have no withdrawals" instead of "that filter is not a status".
const WITHDRAWAL_STATUSES = ['pending', 'processing', 'completed', 'failed'];

const postBody = z.object({
	agent_id: z.string().uuid(),
	amount_usdc: z.number().finite().positive().nullable().optional(),
	// Which payout rail to draw on. Omitted means "use the saved preference",
	// which falls back to Solana, the home chain.
	network: z.enum(['solana', 'base', 'evm']).optional(),
});

// `base` and `evm` are the same rail: rows written by wallet.js carry chain
// 'base', while older rows carry 'evm'.
const NETWORK_CHAINS = {
	solana: ['solana'],
	base: ['base', 'evm'],
	evm: ['base', 'evm'],
};

/**
 * Choose the payout wallet a withdrawal should land on.
 * An explicit `network` is honored exactly (no silent cross-chain fallback, so a
 * caller asking for Base never gets paid on Solana). Otherwise the stored
 * preference wins, then Solana, then whatever the user has configured.
 *
 * @param {Array<{address: string, chain: string, preferred_network: string|null}>} wallets
 *        Candidates, already ordered agent-specific first.
 * @param {string|undefined} network
 * @returns {{address: string, chain: string, preferred_network: string|null}|undefined}
 */
function pickPayoutWallet(wallets, network) {
	const on = (net) => wallets.find((w) => (NETWORK_CHAINS[net] ?? []).includes(w.chain));
	if (network) return on(network);
	return on(wallets[0].preferred_network ?? 'solana') ?? on('solana') ?? wallets[0];
}

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
	if (!rl.success) return rateLimited(res, rl);

	if (req.method === 'GET') {
		const params = new URL(req.url, 'http://x').searchParams;
		const agentId = params.get('agent_id') || null;
		const statusFilter = params.get('status') || null;
		// clampInt-backed so `?limit=abc` falls back to the default page instead of
		// binding NaN, which reaches Postgres as NULL and silently removes the LIMIT.
		const limit = parseLimit(params, { fallback: 20, max: 100 });
		const offset = parseOffset(params);

		if (agentId && !isUuid(agentId)) {
			return error(res, 400, 'validation_error', 'agent_id must be a UUID');
		}

		if (statusFilter && !WITHDRAWAL_STATUSES.includes(statusFilter)) {
			return error(res, 400, 'validation_error', `status must be one of: ${WITHDRAWAL_STATUSES.join(', ')}`);
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
	if (!rlUser.success) return rateLimited(res, rlUser, 'too many withdrawal requests');

	const body = parse(postBody, await readJson(req));
	const { agent_id, amount_usdc, network } = body;

	// Verify agent ownership
	const [agent] = await sql`
		SELECT id, user_id FROM agent_identities
		WHERE id = ${agent_id} AND deleted_at IS NULL
	`;
	if (!agent) return error(res, 404, 'not_found', 'Agent not found');
	if (agent.user_id !== userId) return error(res, 403, 'forbidden', 'You don\'t own this agent');

	// Resolve payout wallet. Agent-specific rows outrank the user-level fallback.
	const wallets = await sql`
		SELECT address, chain, preferred_network
		FROM agent_payout_wallets
		WHERE user_id = ${userId} AND (agent_id = ${agent_id} OR agent_id IS NULL)
		ORDER BY
			CASE WHEN agent_id = ${agent_id} THEN 0 ELSE 1 END,
			is_default DESC,
			created_at DESC
	`;
	if (!wallets.length) {
		return error(res, 422, 'no_payout_wallet', 'Configure a payout wallet before requesting a withdrawal');
	}

	// The chain decides the currency, and the currency decides which balance is
	// withdrawable, so picking the wrong wallet strands real earnings. Taking the
	// most recently saved row did exactly that: a user who added an EVM address
	// after their Solana one could no longer withdraw Solana revenue, because the
	// balance was then read in Base USDC and came back as zero.
	const wallet = pickPayoutWallet(wallets, network);
	if (!wallet) {
		return error(res, 422, 'no_payout_wallet', `No payout wallet configured for ${network}`);
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

	// Reserve the withdrawal atomically. The available-balance check above is a
	// fast/UX pre-check only — on its own it's a TOCTOU hole: N concurrent
	// requests all read the same `available` and all insert, over-withdrawing
	// past the real balance (the per-user rate limit admits several before any
	// pending row is committed, so it can't guarantee integrity).
	//
	// pg_advisory_xact_lock serializes concurrent requests for the same
	// (user, mint); the conditional INSERT…SELECT then re-derives available
	// (earned − pending/processing/completed, mirroring getAvailableBalance)
	// inside the locked transaction and refuses to insert when the amount
	// exceeds it. Matches api/billing/withdrawals/index.js.
	const lockKey = `withdrawal:${userId}:${currencyMint}`;
	const [, inserted] = await sql.transaction([
		sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`,
		sql`
			INSERT INTO agent_withdrawals
				(user_id, agent_id, amount, currency_mint, chain, to_address, status)
			SELECT ${userId}, ${agent_id}, ${amountAtomic}, ${currencyMint}, ${wallet.chain}, ${wallet.address}, 'pending'
			WHERE ${amountAtomic} <= (
				(
					SELECT COALESCE(SUM(re.net_amount), 0)::bigint
					FROM agent_revenue_events re
					JOIN agent_identities ai ON ai.id = re.agent_id
					WHERE ai.user_id = ${userId}
					  AND re.currency_mint = ${currencyMint}
				) - (
					SELECT COALESCE(SUM(w2.amount), 0)::bigint
					FROM agent_withdrawals w2
					WHERE w2.user_id = ${userId}
					  AND w2.currency_mint = ${currencyMint}
					  AND w2.status IN ('pending', 'processing', 'completed')
				)
			)
			RETURNING id, agent_id, amount, currency_mint, chain, to_address, status, tx_signature, created_at, updated_at
		`,
	]);

	const withdrawal = inserted?.[0];
	if (!withdrawal) {
		return error(res, 422, 'insufficient_balance', `Insufficient balance for withdrawal. Available: ${(balance.available / 1_000_000).toFixed(6)} USDC`);
	}

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
