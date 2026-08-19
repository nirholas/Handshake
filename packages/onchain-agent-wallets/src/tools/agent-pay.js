// `agent_pay`: the agent moves money.
//
// The agent signs as delegate over the owner's vault, so the token program
// checks the amount against the delegated ceiling and decrements it. The agent
// pays the fee from its own SOL. Nothing here can exceed what the owner
// approved on-chain, and the guardrails narrow it further.

import { z } from 'zod';

import { NETWORK, REQUIRE_CONFIRM } from '../config.js';
import { solBalance, toPublicKey, accountLink, LAMPORTS_PER_SOL, MIN_AGENT_FEE_LAMPORTS } from '../lib/solana.js';
import { delegatedTransferInstructions } from '../lib/vault.js';
import { agentContext, authorizeSpend, assertDelegated, logSpend } from '../lib/agent.js';
import { agentAction, summarize } from '../lib/execute.js';

export const def = {
	name: 'agent_pay',
	title: 'Let the agent send tokens inside its limits',
	annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
	description:
		'Send tokens from the agent vault to a recipient, signed by the agent as the on-chain delegate. Every ' +
		'guardrail is checked first (per-transaction cap, rolling daily cap, recipient allowlist, expiry, pause) and ' +
		'the SPL Token program enforces the remaining allowance underneath. A refusal explains which rule stopped it. ' +
		'Requires confirm:true to broadcast.',
	inputSchema: {
		id: z.string().describe('The agent wallet spending the money.'),
		to: z.string().describe('Recipient wallet address. Their associated token account is created if needed.'),
		amount: z.string().describe('Amount in whole tokens (e.g. "1.25").'),
		memo: z.string().max(200).optional().describe('Note recorded in the local spend log.'),
		confirm: z.boolean().optional().describe('Set true to broadcast.'),
	},
	async handler(args) {
		const ctx = await agentContext(args.id);
		const { record, connection, decimals, programId } = ctx;
		const recipient = toPublicKey(args.to, 'to').toBase58();
		const amount = ctx.units(args.amount);

		assertDelegated(ctx);
		const decision = authorizeSpend(ctx, {
			amount,
			recipient,
			confirm: args.confirm === true,
			kind: 'transfer',
		});

		const summary = summarize({
			action: `"${record.id}" sends ${args.amount}`,
			amount: args.amount,
			asset: record.mint,
			from: record.vault,
			to: recipient,
			network: NETWORK,
			extra: {
				signed_by: `the agent (${record.agent_pubkey}) as delegate`,
				allowance_after: ctx.human(ctx.vault.delegatedAmount - amount),
				vault_balance_after: ctx.human(ctx.vault.balance - amount),
				guardrails_passed: decision.checks.filter((c) => c.ok).map((c) => c.check),
			},
		});

		if (REQUIRE_CONFIRM && args.confirm !== true) {
			return {
				ok: false,
				action: 'confirm_required',
				summary,
				message: 'Nothing has been signed or broadcast. Re-issue with confirm:true to send.',
			};
		}

		const agentSol = await solBalance(connection, record.agent_pubkey);
		if (agentSol * LAMPORTS_PER_SOL < MIN_AGENT_FEE_LAMPORTS) {
			throw Object.assign(
				new Error(
					`the agent holds ${agentSol} SOL, too little to pay the transaction fee. ` +
						'Ask the owner to run fund_agent_wallet with sol:"0.02".',
				),
				{ code: 'no_fee_sol' },
			);
		}

		const { destination, instructions } = delegatedTransferInstructions({
			vault: record.vault,
			mint: record.mint,
			recipientOwner: recipient,
			agent: record.agent_pubkey,
			amount,
			decimals,
			programId,
		});

		const sent = await agentAction({ connection, keypair: ctx.keypair(), instructions, network: NETWORK });

		const entry = logSpend(ctx, {
			kind: 'transfer',
			amount: args.amount,
			base_units: String(amount),
			recipient,
			destination_token_account: destination.toBase58(),
			memo: args.memo || null,
			signature: sent.signature,
		});

		return {
			ok: true,
			action: 'sent',
			summary,
			...sent,
			recipient,
			recipient_link: accountLink(recipient, NETWORK),
			spent: args.amount,
			allowance_remaining: ctx.human(ctx.vault.delegatedAmount - amount),
			vault_balance: ctx.human(ctx.vault.balance - amount),
			spent_24h: ctx.human(ctx.spentToday + amount),
			logged_at: entry.at,
		};
	},
};
