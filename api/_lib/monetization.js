// Monetization helpers — revenue recording and balance queries.
//
// Used by x402 intent consumption, skill purchase confirmation, and any
// code path that needs to attribute revenue to an agent owner.

import { sql } from './db.js';
import { calculateFee } from './fee.js';

/**
 * Record an immutable revenue event for a consumed skill payment.
 *
 * @param {object} opts
 * @param {string} opts.agentId       - UUID of the agent that earned revenue
 * @param {string} opts.skillName     - skill identifier (e.g. "answer-question")
 * @param {string} opts.callerAddress - payer wallet address (nullable)
 * @param {number|bigint} opts.amountUsdc - gross amount in atomic units (USDC 6 decimals)
 * @param {string} opts.network       - chain name ("solana", "base", etc.)
 * @param {string} opts.txHash        - on-chain transaction hash/signature
 * @param {string} [opts.currencyMint] - token mint/contract address
 * @param {string} [opts.intentId]    - payment intent ID if applicable
 * @returns {Promise<object>} the inserted revenue event row
 */
export async function recordRevenueEvent({
	agentId,
	skillName,
	callerAddress = null,
	amountUsdc,
	network,
	txHash = null,
	currencyMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
	intentId = null,
}) {
	const grossAmount = Number(amountUsdc);
	if (!Number.isFinite(grossAmount) || grossAmount <= 0) {
		throw Object.assign(new Error('amountUsdc must be a positive number'), { status: 400 });
	}
	if (!agentId) {
		throw Object.assign(new Error('agentId is required'), { status: 400 });
	}
	if (!skillName) {
		throw Object.assign(new Error('skillName is required'), { status: 400 });
	}

	const { fee, net } = calculateFee(grossAmount);

	const [row] = await sql`
		INSERT INTO agent_revenue_events
			(agent_id, intent_id, skill, gross_amount, fee_amount, net_amount,
			 currency_mint, chain, payer_address)
		VALUES
			(${agentId}, ${intentId ?? txHash ?? 'direct'}, ${skillName}, ${grossAmount},
			 ${fee}, ${net}, ${currencyMint}, ${network}, ${callerAddress})
		RETURNING id, agent_id, skill, gross_amount, fee_amount, net_amount,
		          currency_mint, chain, payer_address, created_at
	`;

	return row;
}

/**
 * Calculate the available (withdrawable) balance for a user.
 *
 * available = sum(net_amount from revenue_events) - sum(amount from pending/processing/completed withdrawals)
 *
 * @param {string} userId
 * @param {string} [currencyMint] - filter to a specific currency (default: all)
 * @returns {Promise<{earned: number, withdrawn: number, pending: number, available: number}>}
 */
export async function getAvailableBalance(userId, currencyMint = null) {
	const [result] = currencyMint
		? await sql`
			SELECT
				COALESCE(SUM(re.net_amount), 0)::bigint AS earned
			FROM agent_revenue_events re
			JOIN agent_identities ai ON ai.id = re.agent_id
			WHERE ai.user_id = ${userId}
			  AND re.currency_mint = ${currencyMint}
		`
		: await sql`
			SELECT
				COALESCE(SUM(re.net_amount), 0)::bigint AS earned
			FROM agent_revenue_events re
			JOIN agent_identities ai ON ai.id = re.agent_id
			WHERE ai.user_id = ${userId}
		`;

	const [wResult] = currencyMint
		? await sql`
			SELECT
				COALESCE(SUM(CASE WHEN status IN ('pending', 'processing') THEN amount ELSE 0 END), 0)::bigint AS pending,
				COALESCE(SUM(CASE WHEN status = 'completed' THEN amount ELSE 0 END), 0)::bigint AS withdrawn
			FROM agent_withdrawals
			WHERE user_id = ${userId}
			  AND currency_mint = ${currencyMint}
		`
		: await sql`
			SELECT
				COALESCE(SUM(CASE WHEN status IN ('pending', 'processing') THEN amount ELSE 0 END), 0)::bigint AS pending,
				COALESCE(SUM(CASE WHEN status = 'completed' THEN amount ELSE 0 END), 0)::bigint AS withdrawn
			FROM agent_withdrawals
			WHERE user_id = ${userId}
		`;

	const earned = Number(result.earned);
	const pending = Number(wResult.pending);
	const withdrawn = Number(wResult.withdrawn);
	const available = earned - pending - withdrawn;

	return { earned, withdrawn, pending, available: Math.max(0, available) };
}
