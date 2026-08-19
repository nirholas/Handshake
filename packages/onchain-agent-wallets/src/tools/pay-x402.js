// `pay_x402`: the agent buys something.
//
// Probe the resource unpaid, show the price, run the guardrails, top the agent
// up for exactly that price out of the owner's vault, pay, and return the
// content. The owner's ceiling is enforced by the token program the whole way
// through, and the agent is left holding nothing afterwards.

import { z } from 'zod';

import { NETWORK, REQUIRE_CONFIRM } from '../config.js';
import {
	solBalance,
	ataFor,
	tokenAccount,
	fromBaseUnits,
	LAMPORTS_PER_SOL,
	MIN_AGENT_FEE_LAMPORTS,
} from '../lib/solana.js';
import { delegatedTransferInstructions } from '../lib/vault.js';
import { agentContext, authorizeSpend, assertDelegated, logSpend } from '../lib/agent.js';
import { agentAction, summarize } from '../lib/execute.js';
import { probeResource, selectRequirement, requiredUnits, payAndFetch, readBody } from '../lib/x402.js';

export const def = {
	name: 'pay_x402',
	title: 'Let the agent pay for an x402 API out of its allowance',
	annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
	description:
		'Call an HTTP endpoint that charges with x402, paying from the agent allowance on Solana. The price is read ' +
		'from the unpaid 402 response first, so the guardrails (per-transaction cap, daily cap, host allowlist, ' +
		'expiry, pause) see the real amount before anything moves. The agent is topped up for exactly that amount ' +
		'from the vault, pays, and is left empty. If the endpoint is not charging, the content comes back with no ' +
		'payment at all. Requires confirm:true when the price is above the confirm threshold or confirmation is on.',
	inputSchema: {
		id: z.string().describe('The agent wallet paying.'),
		url: z.string().url().describe('The resource to call.'),
		method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional().describe('HTTP method. Default GET.'),
		headers: z.record(z.string()).optional().describe('Extra request headers.'),
		body: z.string().optional().describe('Request body, for POST/PUT/PATCH.'),
		max_price: z.string().optional().describe('Refuse if the resource asks for more than this, in whole tokens. A ceiling for this call only.'),
		confirm: z.boolean().optional().describe('Set true to authorize payment.'),
	},
	async handler(args) {
		const ctx = await agentContext(args.id);
		const { record, connection, decimals, programId } = ctx;
		const method = args.method || 'GET';
		const host = new URL(args.url).hostname;

		const probe = await probeResource({ url: args.url, method, headers: args.headers, body: args.body });
		if (probe.status !== 402) {
			const content = await readBody(probe.response);
			return {
				ok: probe.response.ok,
				action: 'fetched_free',
				status: probe.status,
				url: args.url,
				paid: '0',
				message: 'The resource did not ask for payment. Nothing was spent.',
				...content,
			};
		}

		assertDelegated(ctx);

		const requirement = selectRequirement({ accepts: probe.accepts, mint: record.mint, network: NETWORK });
		const amount = requiredUnits(requirement);
		const price = fromBaseUnits(amount, decimals);

		if (args.max_price !== undefined) {
			const ceiling = ctx.units(args.max_price);
			if (amount > ceiling) {
				throw Object.assign(
					new Error(`the resource asks ${price} but max_price for this call is ${args.max_price}. Not paying.`),
					{ code: 'over_max_price' },
				);
			}
		}

		const decision = authorizeSpend(ctx, {
			amount,
			host,
			confirm: args.confirm === true,
			kind: 'x402',
			resource: args.url,
		});

		const summary = summarize({
			action: `"${record.id}" pays ${price} for ${args.url}`,
			amount: price,
			asset: record.mint,
			from: record.vault,
			to: requirement.payTo,
			network: NETWORK,
			extra: {
				resource: args.url,
				description: requirement.description || null,
				host,
				allowance_after: ctx.human(ctx.vault.delegatedAmount - amount),
				guardrails_passed: decision.checks.filter((c) => c.ok).map((c) => c.check),
			},
		});

		if (REQUIRE_CONFIRM && args.confirm !== true) {
			return {
				ok: false,
				action: 'confirm_required',
				summary,
				price,
				message: 'Nothing has been paid. Re-issue with confirm:true to buy this.',
			};
		}

		const agentSol = await solBalance(connection, record.agent_pubkey);
		if (agentSol * LAMPORTS_PER_SOL < MIN_AGENT_FEE_LAMPORTS) {
			throw Object.assign(
				new Error(
					`the agent holds ${agentSol} SOL, too little to sign its top-up. ` +
						'Ask the owner to run fund_agent_wallet with sol:"0.02".',
				),
				{ code: 'no_fee_sol' },
			);
		}

		// Top the agent's own account up for exactly the shortfall, pulled from
		// the owner's vault against the delegation.
		const agentAta = ataFor(record.mint, record.agent_pubkey, programId);
		const held = (await tokenAccount(connection, agentAta, programId))?.amount ?? 0n;
		let pullSignature = null;
		if (held < amount) {
			const shortfall = amount - held;
			const { instructions } = delegatedTransferInstructions({
				vault: record.vault,
				mint: record.mint,
				recipientOwner: record.agent_pubkey,
				agent: record.agent_pubkey,
				amount: shortfall,
				decimals,
				programId,
			});
			const pull = await agentAction({ connection, keypair: ctx.keypair(), instructions, network: NETWORK });
			pullSignature = pull.signature;
		}

		let paid;
		try {
			paid = await payAndFetch({
				url: args.url,
				method,
				headers: args.headers,
				body: args.body,
				secretKey: ctx.keypair().secretKey,
				network: NETWORK,
				requirement,
			});
		} catch (err) {
			logSpend(ctx, {
				kind: 'x402',
				allowed: true,
				settled: false,
				amount: price,
				base_units: String(amount),
				resource: args.url,
				host,
				recipient: requirement.payTo,
				pull_signature: pullSignature,
				error: err.message,
			});
			throw Object.assign(
				new Error(
					`the payment did not settle: ${err.message}. ` +
						(pullSignature
							? `${price} was moved into the agent's account (${agentAta.toBase58()}) and is still there; ` +
								'the next call to this tool will reuse it, or revoke_agent_wallet with withdraw:true recovers the vault.'
							: 'Nothing left the vault.'),
				),
				{ code: 'settlement_failed', pull_signature: pullSignature },
			);
		}

		const content = await readBody(paid.response);
		const entry = logSpend(ctx, {
			kind: 'x402',
			settled: true,
			amount: price,
			base_units: String(amount),
			resource: args.url,
			host,
			recipient: requirement.payTo,
			signature: paid.settlement?.transaction || paid.settlement?.txHash || null,
			pull_signature: pullSignature,
			status: paid.response.status,
		});

		return {
			ok: paid.response.ok,
			action: 'paid',
			status: paid.response.status,
			url: args.url,
			paid: price,
			asset: record.mint,
			paid_to: requirement.payTo,
			settlement: paid.settlement,
			vault_pull_signature: pullSignature,
			allowance_remaining: ctx.human(ctx.vault.delegatedAmount - amount),
			spent_24h: ctx.human(ctx.spentToday + amount),
			logged_at: entry.at,
			...content,
		};
	},
};
