// `fund_agent_wallet`: move tokens into the vault and SOL to the agent for fees.
//
// The allowance is a ceiling, not a balance. An agent with a 100 allowance and
// an empty vault can spend nothing. This is what backs it.

import { z } from 'zod';
import { SystemProgram } from '@solana/web3.js';

import { NETWORK } from '../config.js';
import { connectionFor, toBaseUnits, fromBaseUnits, toPublicKey, ataFor, tokenAccount, solBalance } from '../lib/solana.js';
import { depositInstructions } from '../lib/vault.js';
import { agentContext, describeAgent } from '../lib/agent.js';
import { ownerAction, summarize } from '../lib/execute.js';

export const def = {
	name: 'fund_agent_wallet',
	title: "Top up an agent's vault, and its fee SOL",
	annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
	description:
		'Move tokens from your wallet into the agent vault, and optionally send the agent a little SOL for its own ' +
		'transaction fees. The vault stays owned by you; funding it does not raise the delegated allowance, so the ' +
		'agent still cannot spend past its ceiling. Requires confirm:true to broadcast.',
	inputSchema: {
		id: z.string().describe('The agent wallet to fund.'),
		amount: z.string().optional().describe('Tokens to move into the vault, in whole units (e.g. "50").'),
		sol: z.string().optional().describe('SOL to send the agent for transaction fees (e.g. "0.02").'),
		secret: z.string().optional().describe('Owner secret key for this call only.'),
		confirm: z.boolean().optional().describe('Set true to broadcast.'),
	},
	async handler(args) {
		const ctx = await agentContext(args.id);
		const { record, connection, decimals, programId } = ctx;
		const owner = record.owner;

		if (!args.amount && !args.sol) {
			throw Object.assign(new Error('pass `amount` (tokens for the vault), `sol` (fees for the agent), or both'), {
				code: 'validation_error',
			});
		}

		const instructions = [];
		const summaryExtra = { agent: record.id, vault: record.vault, agent_address: record.agent_pubkey };

		if (args.amount) {
			const units = toBaseUnits(args.amount, decimals);
			if (units <= 0n) throw Object.assign(new Error('amount must be greater than zero'), { code: 'bad_amount' });

			const source = ataFor(record.mint, owner, programId);
			const sourceAccount = await tokenAccount(connection, source, programId);
			if (!sourceAccount) {
				throw Object.assign(
					new Error(`your wallet has no token account for ${record.mint}. Acquire some of this token first.`),
					{ code: 'no_source_account' },
				);
			}
			if (sourceAccount.amount < units) {
				throw Object.assign(
					new Error(
						`your wallet holds ${fromBaseUnits(sourceAccount.amount, decimals)} but you are trying to move ${args.amount}.`,
					),
					{ code: 'insufficient_funds' },
				);
			}
			instructions.push(
				...depositInstructions({ owner, vault: record.vault, mint: record.mint, amount: units, decimals, programId }),
			);
			summaryExtra.tokens_to_vault = `${fromBaseUnits(units, decimals)} (${record.mint})`;
			summaryExtra.vault_balance_after = fromBaseUnits(ctx.vault.balance + units, decimals);
			summaryExtra.allowance_remaining = ctx.human(ctx.vault.delegatedAmount);
		}

		if (args.sol) {
			const lamports = toBaseUnits(args.sol, 9);
			if (lamports <= 0n) throw Object.assign(new Error('sol must be greater than zero'), { code: 'bad_amount' });
			instructions.push(
				SystemProgram.transfer({
					fromPubkey: toPublicKey(owner, 'owner'),
					toPubkey: toPublicKey(record.agent_pubkey, 'agent'),
					lamports: Number(lamports),
				}),
			);
			const current = await solBalance(connection, record.agent_pubkey);
			summaryExtra.sol_to_agent = `${args.sol} SOL (agent currently holds ${current})`;
		}

		const summary = summarize({
			action: `Fund the "${record.id}" agent wallet`,
			from: owner,
			to: record.vault,
			network: NETWORK,
			extra: summaryExtra,
		});

		const result = await ownerAction({
			connection,
			owner,
			instructions,
			confirm: args.confirm === true,
			secret: args.secret,
			summary,
			network: NETWORK,
			note: `fund agent wallet "${record.id}"`,
		});

		return { ...result, agent: describeAgent(ctx) };
	},
};
