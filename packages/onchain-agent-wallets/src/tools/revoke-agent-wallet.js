// `revoke_agent_wallet`: the kill switch.
//
// One owner-signed instruction sets the vault's delegated amount to zero. From
// that block on, every agent-signed transfer fails inside the token program,
// whatever this server, the agent, or its model believes. Optionally sweeps the
// vault balance back to the owner in the same transaction.

import { z } from 'zod';

import { NETWORK } from '../config.js';
import { toBaseUnits, fromBaseUnits } from '../lib/solana.js';
import { revokeInstruction, withdrawInstructions } from '../lib/vault.js';
import { agentContext, describeAgent } from '../lib/agent.js';
import { ownerAction, summarize } from '../lib/execute.js';
import { updateState } from '../lib/store.js';

export const def = {
	name: 'revoke_agent_wallet',
	title: "Revoke the agent's spending authority on-chain",
	annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
	description:
		"Cancel the agent's delegation on-chain. After this the SPL Token program refuses every transfer the agent " +
		'signs, permanently, until you approve a new allowance. Pass withdraw:true to also sweep the vault balance ' +
		'back to your wallet in the same transaction. For an instant free stop that needs no transaction and no SOL, ' +
		'use set_guardrails with paused:true instead: that blocks this server, while revoke blocks the chain itself. ' +
		'Requires confirm:true to broadcast.',
	inputSchema: {
		id: z.string().describe('The agent wallet to revoke.'),
		withdraw: z.boolean().optional().describe('Also move the vault balance back to your wallet. Default false.'),
		amount: z.string().optional().describe('Withdraw only this much instead of the whole balance.'),
		secret: z.string().optional().describe('Owner secret key for this call only.'),
		confirm: z.boolean().optional().describe('Set true to broadcast.'),
	},
	async handler(args) {
		const ctx = await agentContext(args.id);
		const { record, connection, decimals, programId } = ctx;

		if (!ctx.vault.exists) {
			throw Object.assign(new Error(`the vault for "${record.id}" does not exist on ${NETWORK}.`), { code: 'no_vault' });
		}

		const instructions = [];
		if (ctx.vault.delegate) {
			instructions.push(revokeInstruction({ vault: record.vault, owner: record.owner, programId }));
		}

		let withdrawUnits = 0n;
		if (args.withdraw || args.amount) {
			withdrawUnits = args.amount ? toBaseUnits(args.amount, decimals) : ctx.vault.balance;
			if (withdrawUnits > ctx.vault.balance) {
				throw Object.assign(
					new Error(`the vault holds ${ctx.human(ctx.vault.balance)}, less than the ${args.amount} requested`),
					{ code: 'insufficient_vault' },
				);
			}
			if (withdrawUnits > 0n) {
				instructions.push(
					...withdrawInstructions({
						owner: record.owner,
						vault: record.vault,
						mint: record.mint,
						amount: withdrawUnits,
						decimals,
						programId,
					}),
				);
			}
		}

		if (instructions.length === 0) {
			return {
				ok: true,
				action: 'noop',
				message: `"${record.id}" is already revoked and its vault is empty. Nothing to do.`,
				agent: describeAgent(ctx),
			};
		}

		const summary = summarize({
			action: `Revoke "${record.id}"${withdrawUnits > 0n ? ` and withdraw ${fromBaseUnits(withdrawUnits, decimals)}` : ''}`,
			network: NETWORK,
			extra: {
				agent_address: record.agent_pubkey,
				vault: record.vault,
				allowance_being_cancelled: ctx.human(ctx.vault.delegatedAmount),
				withdrawing: withdrawUnits > 0n ? `${fromBaseUnits(withdrawUnits, decimals)} back to ${record.owner}` : 'nothing',
				after: 'The agent can sign nothing against this vault until you approve a new allowance.',
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
			note: `revoke agent wallet "${record.id}"`,
		});

		if (result.action === 'sent') {
			updateState((state) => {
				if (state.agents[record.id]) state.agents[record.id].revoked_at = new Date().toISOString();
			});
		}

		return { ...result, agent: describeAgent(await agentContext(args.id)) };
	},
};
