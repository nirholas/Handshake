// `approve_agent_allowance`: change the on-chain ceiling.
//
// SPL approve REPLACES the previous delegation rather than adding to it, so the
// number passed here becomes the agent's entire remaining allowance. That is
// also how you top an agent back up after it has spent down to zero.

import { z } from 'zod';

import { NETWORK } from '../config.js';
import { toBaseUnits, fromBaseUnits } from '../lib/solana.js';
import { approveInstruction } from '../lib/vault.js';
import { agentContext, describeAgent } from '../lib/agent.js';
import { ownerAction, summarize } from '../lib/execute.js';

export const def = {
	name: 'approve_agent_allowance',
	title: "Set the agent's on-chain spending ceiling",
	annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
	description:
		'Set how much the agent may spend from the vault, enforced by the SPL Token program. This REPLACES the ' +
		'existing allowance, it does not add to it: passing "50" leaves the agent with exactly 50 regardless of what ' +
		'it had before. Use it to raise, lower, or refill an allowance. Requires confirm:true to broadcast.',
	inputSchema: {
		id: z.string().describe('The agent wallet.'),
		allowance: z.string().describe('The new total allowance in whole tokens. "0" is equivalent to a revoke.'),
		secret: z.string().optional().describe('Owner secret key for this call only.'),
		confirm: z.boolean().optional().describe('Set true to broadcast.'),
	},
	async handler(args) {
		const ctx = await agentContext(args.id);
		const { record, connection, decimals, programId } = ctx;

		if (!ctx.vault.exists) {
			throw Object.assign(new Error(`the vault for "${record.id}" does not exist yet. Run create_agent_wallet.`), {
				code: 'no_vault',
			});
		}

		const units = toBaseUnits(args.allowance, decimals);
		const instructions = [
			approveInstruction({
				vault: record.vault,
				mint: record.mint,
				delegate: record.agent_pubkey,
				owner: record.owner,
				allowance: units,
				decimals,
				programId,
			}),
		];

		const summary = summarize({
			action: `Set the "${record.id}" allowance to ${fromBaseUnits(units, decimals)}`,
			network: NETWORK,
			extra: {
				agent_address: record.agent_pubkey,
				vault: record.vault,
				mint: record.mint,
				previous_allowance: ctx.human(ctx.vault.delegatedAmount),
				new_allowance: fromBaseUnits(units, decimals),
				vault_balance: ctx.human(ctx.vault.balance),
				note: 'Approve replaces the previous allowance rather than adding to it.',
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
			note: `approve allowance for "${record.id}"`,
		});

		return { ...result, agent: describeAgent(ctx) };
	},
};
