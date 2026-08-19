// `withdraw_from_vault`: take the money back. The owner needs no cooperation
// from the agent to do this, and it works whether or not a delegation is live.

import { z } from 'zod';

import { NETWORK } from '../config.js';
import { toBaseUnits, fromBaseUnits } from '../lib/solana.js';
import { withdrawInstructions } from '../lib/vault.js';
import { agentContext, describeAgent } from '../lib/agent.js';
import { ownerAction, summarize } from '../lib/execute.js';

export const def = {
	name: 'withdraw_from_vault',
	title: 'Move funds out of an agent vault back to the owner',
	annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
	description:
		'Withdraw tokens from an agent vault back to your own wallet. The vault is yours, so this always works, ' +
		'with or without a live delegation, and the agent cannot block it. Leaves the allowance untouched: lowering ' +
		'the balance already limits what the agent can spend. Requires confirm:true to broadcast.',
	inputSchema: {
		id: z.string().describe('The agent wallet.'),
		amount: z.string().optional().describe('Tokens to withdraw. Omit to withdraw the entire balance.'),
		secret: z.string().optional().describe('Owner secret key for this call only.'),
		confirm: z.boolean().optional().describe('Set true to broadcast.'),
	},
	async handler(args) {
		const ctx = await agentContext(args.id);
		const { record, connection, decimals, programId } = ctx;

		if (!ctx.vault.exists || ctx.vault.balance === 0n) {
			throw Object.assign(new Error(`the vault for "${record.id}" is empty. Nothing to withdraw.`), {
				code: 'empty_vault',
			});
		}

		const units = args.amount ? toBaseUnits(args.amount, decimals) : ctx.vault.balance;
		if (units > ctx.vault.balance) {
			throw Object.assign(
				new Error(`the vault holds ${ctx.human(ctx.vault.balance)}, less than the ${args.amount} requested`),
				{ code: 'insufficient_vault' },
			);
		}

		const instructions = withdrawInstructions({
			owner: record.owner,
			vault: record.vault,
			mint: record.mint,
			amount: units,
			decimals,
			programId,
		});

		const summary = summarize({
			action: `Withdraw ${fromBaseUnits(units, decimals)} from the "${record.id}" vault`,
			from: record.vault,
			to: record.owner,
			network: NETWORK,
			extra: {
				mint: record.mint,
				vault_balance_after: fromBaseUnits(ctx.vault.balance - units, decimals),
				allowance_remaining: ctx.human(ctx.vault.delegatedAmount),
				note: 'The allowance is unchanged. The agent can still spend up to it, limited by whatever balance remains.',
			},
		});

		const result = await ownerAction({
			connection,
			owner: record.owner,
			instructions,
			confirm: args.confirm === true,
			secret: args.secret,
			summary,
			network: NETWORK,
			note: `withdraw from "${record.id}"`,
		});

		return { ...result, agent: describeAgent(ctx) };
	},
};
