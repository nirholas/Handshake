// `agent_wallet_status`: everything true about an agent right now, read from
// the chain rather than from local notes.

import { z } from 'zod';

import { NETWORK } from '../config.js';
import { solBalance, accountLink, fromBaseUnits, MIN_AGENT_FEE_LAMPORTS, LAMPORTS_PER_SOL } from '../lib/solana.js';
import { agentContext, describeAgent } from '../lib/agent.js';
import { spentInWindow } from '../lib/policy.js';

export const def = {
	name: 'agent_wallet_status',
	title: 'Live status of an agent wallet',
	annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },
	description:
		'Show an agent wallet as it actually stands on-chain: vault balance, how much of the delegated allowance is ' +
		'left, what it can spend right now, its fee SOL, the guardrails in force, spend totals for the last 24 hours, ' +
		'and any warnings (revoked, expired, paused, out of fee SOL, allowance unbacked by balance). Read-only.',
	inputSchema: {
		id: z.string().describe('The agent wallet.'),
	},
	async handler(args) {
		const ctx = await agentContext(args.id);
		const described = describeAgent(ctx);
		const agentSol = await solBalance(ctx.connection, ctx.record.agent_pubkey);
		const spent7d = spentInWindow(ctx.ledger, { hours: 24 * 7 });

		const warnings = [];
		if (!ctx.vault.exists) warnings.push('The vault does not exist on-chain yet. Run create_agent_wallet.');
		if (ctx.vault.exists && !ctx.vault.delegate) warnings.push('Revoked: the agent has no on-chain spending authority.');
		if (ctx.vault.delegate && ctx.vault.delegate !== ctx.record.agent_pubkey) {
			warnings.push(`The vault is delegated to ${ctx.vault.delegate}, which is not this agent.`);
		}
		if (ctx.policy.paused) warnings.push('Paused by the owner: this server refuses every spend.');
		if (ctx.policy.expires_at && new Date(ctx.policy.expires_at) <= new Date()) {
			warnings.push(`The delegation expired at ${ctx.policy.expires_at}.`);
		}
		if (agentSol * LAMPORTS_PER_SOL < MIN_AGENT_FEE_LAMPORTS) {
			warnings.push(
				`The agent holds ${agentSol} SOL, too little to pay transaction fees. Run fund_agent_wallet with sol:"0.02".`,
			);
		}
		if (ctx.vault.exists && ctx.vault.delegatedAmount > ctx.vault.balance) {
			warnings.push(
				`The allowance (${ctx.human(ctx.vault.delegatedAmount)}) is larger than the vault balance ` +
					`(${ctx.human(ctx.vault.balance)}), so only ${ctx.human(ctx.spendable)} is actually spendable.`,
			);
		}
		if (ctx.vault.frozen) warnings.push('The vault token account is frozen by the mint authority.');

		return {
			ok: true,
			...described,
			fee_sol: agentSol,
			spent_7d: fromBaseUnits(spent7d, ctx.decimals),
			spends_recorded: ctx.ledger.length,
			links: {
				vault: accountLink(ctx.record.vault, NETWORK),
				agent: accountLink(ctx.record.agent_pubkey, NETWORK),
				owner: accountLink(ctx.record.owner, NETWORK),
			},
			warnings,
			custody:
				`The vault is owned by ${ctx.record.owner}. The agent holds a delegation capped at ` +
				`${ctx.human(ctx.vault.exists ? ctx.vault.delegatedAmount : 0n)} and can be revoked in one instruction.`,
		};
	},
};
