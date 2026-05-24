/**
 * Skill royalty helpers.
 *
 * billSkillRoyalty — fire-and-forget from skill-runtime after a paid skill returns.
 * settleRoyalties  — called by the settle-royalties cron; redeems EIP-7710 delegations
 *                    and marks ledger rows settled or failed.
 */

import { encodeFunctionData, parseAbi } from 'viem';
import { sql } from './db.js';
import { env } from './env.js';
import { EVM_USDC, toUsdcAtomics } from '../payments/_config.js';

// USDC transferFrom signature — the delegation manager calls this on the
// USDC contract on behalf of the agent's wallet. The delegation grants the
// relayer permission to move USDC from the agent's wallet to the author's
// wallet, debited from the per-skill allowance scoped in the delegation.
const USDC_ABI = parseAbi([
	'function transferFrom(address from, address to, uint256 amount) returns (bool)',
]);

// ── billSkillRoyalty ──────────────────────────────────────────────────────────

/**
 * Record a royalty_ledger debit for a paid skill invocation.
 * Does NOT block the skill — call with queueMicrotask or plain fire-and-forget.
 *
 * @param {{ skillId: string, skillName: string, agentId: string, authorId: string, priceUsd: number }} opts
 */
export async function billSkillRoyalty({ skillId, skillName, agentId, authorId, priceUsd }) {
	try {
		// Verify the agent exists and get its wallet/chain info.
		const [agent] = await sql`
			SELECT id, wallet_address, chain_id
			FROM agent_identities
			WHERE id = ${agentId} AND deleted_at IS NULL
		`;
		if (!agent) {
			console.warn('[royalty] billSkillRoyalty: agent not found', { agentId, skillName });
			return;
		}

		// Check for an active delegation that covers this spend.
		const [delegation] = await sql`
			SELECT id FROM agent_delegations
			WHERE agent_id = ${agentId}
			  AND status = 'active'
			  AND expires_at > now()
			ORDER BY created_at DESC
			LIMIT 1
		`;

		if (!delegation) {
			console.warn('[royalty] insufficient_balance: no active delegation', {
				agentId,
				skillName,
				priceUsd,
			});
			return;
		}

		await sql`
			INSERT INTO royalty_ledger
				(skill_id, agent_id, author_user_id, price_usd, status)
			VALUES
				(${skillId}, ${agentId}, ${authorId}, ${priceUsd}, 'pending')
		`;
	} catch (e) {
		console.error('[royalty] billSkillRoyalty failed', e?.message);
	}
}

// ── settleRoyalties ───────────────────────────────────────────────────────────

const SETTLE_THRESHOLD_USD = 0.01;

/**
 * Settle all pending royalty_ledger rows for a given author.
 * Groups by (agent_id, chain_id), looks up delegation, redeems via the
 * /api/permissions/redeem relayer endpoint, then marks rows settled or failed.
 *
 * @param {string} authorUserId
 */
export async function settleRoyalties(authorUserId) {
	// Aggregate pending rows by agent + chain.
	const groups = await sql`
		SELECT
			rl.agent_id,
			ai.chain_id,
			ai.wallet_address,
			SUM(rl.price_usd)::float AS total_usd,
			array_agg(rl.id) AS ledger_ids
		FROM royalty_ledger rl
		JOIN agent_identities ai ON ai.id = rl.agent_id
		WHERE rl.author_user_id = ${authorUserId}
		  AND rl.status = 'pending'
		GROUP BY rl.agent_id, ai.chain_id, ai.wallet_address
		HAVING SUM(rl.price_usd) >= ${SETTLE_THRESHOLD_USD}
	`;

	for (const group of groups) {
		try {
			const txHash = await _redeemForGroup(group, authorUserId);
			await sql`
				UPDATE royalty_ledger
				SET status = 'settled', settled_at = now(), tx_hash = ${txHash}
				WHERE id = ANY(${group.ledger_ids}::uuid[])
			`;
		} catch (e) {
			console.error('[royalty] settle failed for group', {
				agentId: group.agent_id,
				authorUserId,
				error: e?.message,
			});
			await sql`
				UPDATE royalty_ledger
				SET status = 'failed'
				WHERE id = ANY(${group.ledger_ids}::uuid[])
			`;
		}
	}
}

/**
 * Settle all authors with pending balances above the threshold.
 * Called by the cron job.
 */
export async function settleAllPendingRoyalties() {
	const authors = await sql`
		SELECT DISTINCT author_user_id
		FROM royalty_ledger
		WHERE status = 'pending'
		GROUP BY author_user_id
		HAVING SUM(price_usd) >= ${SETTLE_THRESHOLD_USD}
	`;

	const results = { settled: 0, failed: 0, authors: authors.length };
	for (const { author_user_id } of authors) {
		try {
			await settleRoyalties(author_user_id);
			results.settled++;
		} catch (e) {
			results.failed++;
			console.error('[royalty] settleAllPendingRoyalties: author failed', {
				author_user_id,
				error: e?.message,
			});
		}
	}
	return results;
}

// ── internal ──────────────────────────────────────────────────────────────────

async function _redeemForGroup(group, authorUserId) {
	const { agent_id, chain_id, wallet_address, total_usd } = group;

	// USDC contract address must exist for this chain. Royalties are paid in
	// USDC; chains without a deployed USDC are not eligible.
	const usdcAddress = EVM_USDC[chain_id];
	if (!usdcAddress) {
		throw new Error(`no_usdc_for_chain: chain ${chain_id} has no USDC contract configured`);
	}

	// Find the author's wallet address to send funds to.
	const [author] = await sql`
		SELECT w.address
		FROM user_wallets w
		WHERE w.user_id = ${authorUserId}
		  AND (${chain_id}::int IS NULL OR w.chain_id = ${chain_id}::int)
		  AND w.is_primary = true
		LIMIT 1
	`;

	if (!author?.address) {
		throw new Error(`no_author_wallet: author ${authorUserId} has no primary wallet`);
	}

	// Find active delegation for this agent/chain.
	const [delegation] = await sql`
		SELECT id, delegation_json, scope
		FROM agent_delegations
		WHERE agent_id = ${agent_id}
		  AND chain_id = ${chain_id}
		  AND status = 'active'
		  AND expires_at > now()
		ORDER BY created_at DESC
		LIMIT 1
	`;

	if (!delegation) {
		throw new Error(`no_delegation: agent ${agent_id} chain ${chain_id}`);
	}

	// Encode the real USDC transferFrom call. The delegation manager is the
	// msg.sender; it calls usdc.transferFrom(agentWallet, authorWallet, amount).
	const amountAtomics = toUsdcAtomics(Number(total_usd));
	if (amountAtomics <= 0n) {
		throw new Error(`invalid_amount: group total ${total_usd} resolves to 0 atomics`);
	}
	const transferCalldata = encodeFunctionData({
		abi: USDC_ABI,
		functionName: 'transferFrom',
		args: [wallet_address, author.address, amountAtomics],
	});

	// Call the relayer endpoint to redeem the delegation.
	const cronSecret = env.CRON_SECRET;
	const issuer = env.ISSUER ?? 'http://localhost:3000';

	const resp = await fetch(`${issuer}/api/permissions/redeem`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			authorization: `Bearer ${cronSecret}`,
		},
		body: JSON.stringify({
			id: delegation.id,
			calls: [
				{
					to: usdcAddress,
					value: '0x0',
					data: transferCalldata,
				},
			],
		}),
	});

	if (!resp.ok) {
		const body = await resp.text().catch(() => '');
		throw new Error(`redeem_failed: ${resp.status} ${body}`);
	}

	const result = await resp.json();
	return result.tx_hash ?? result.txHash ?? null;
}
