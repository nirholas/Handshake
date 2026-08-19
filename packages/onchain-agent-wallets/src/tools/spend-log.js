// `spend_log`: the audit trail. Every decision this server made, allowed and
// refused alike, with the rule that decided it.

import { z } from 'zod';

import { spendHistory } from '../lib/store.js';
import { agentContext } from '../lib/agent.js';
import { spentInWindow } from '../lib/policy.js';
import { fromBaseUnits, txLink } from '../lib/solana.js';
import { NETWORK } from '../config.js';

export const def = {
	name: 'spend_log',
	title: "An agent's spend history, including refusals",
	annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
	description:
		'The audit trail for one agent: every spend that went through and every one the guardrails refused, with the ' +
		'amount, destination, transaction signature, and the rule that decided it. Refusals are recorded on purpose, ' +
		'so you can see what an agent tried to do. Read-only.',
	inputSchema: {
		id: z.string().describe('The agent wallet.'),
		limit: z.number().int().min(1).max(500).optional().describe('How many entries to return, newest first. Default 50.'),
		since: z.string().optional().describe('ISO timestamp: only entries at or after this time.'),
		only: z.enum(['all', 'allowed', 'refused']).optional().describe('Filter by outcome. Default all.'),
	},
	async handler(args) {
		const ctx = await agentContext(args.id);
		const limit = args.limit || 50;
		let rows = spendHistory(ctx.record.id, { since: args.since });
		if (args.only === 'allowed') rows = rows.filter((r) => r.allowed);
		if (args.only === 'refused') rows = rows.filter((r) => !r.allowed);

		const recent = rows.slice(-limit).reverse().map((row) => ({
			...row,
			...(row.signature ? { link: txLink(row.signature, NETWORK) } : {}),
		}));

		const allowed = rows.filter((r) => r.allowed);
		return {
			ok: true,
			agent: ctx.record.id,
			returned: recent.length,
			total_recorded: rows.length,
			totals: {
				spent_24h: fromBaseUnits(spentInWindow(ctx.ledger, { hours: 24 }), ctx.decimals),
				spent_7d: fromBaseUnits(spentInWindow(ctx.ledger, { hours: 24 * 7 }), ctx.decimals),
				spent_all_time: fromBaseUnits(
					allowed.reduce((sum, r) => sum + BigInt(r.base_units || 0), 0n),
					ctx.decimals,
				),
				refusals: rows.length - allowed.length,
			},
			entries: recent,
		};
	},
};
