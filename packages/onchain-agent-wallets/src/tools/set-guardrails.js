// `set_guardrails`: the owner's rules, enforced before this server signs
// anything. Free, instant, and needs no transaction, which is exactly why
// paused:true is the fastest way to stop an agent mid-run. The on-chain
// allowance is the backstop underneath; these are the finer rules on top.

import { z } from 'zod';

import { normalizePolicy } from '../lib/policy.js';
import { updateState } from '../lib/store.js';
import { agentContext, describeAgent } from '../lib/agent.js';

export const def = {
	name: 'set_guardrails',
	title: "Change an agent's spending rules",
	annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
	description:
		'Set the rules this server enforces before it signs a spend: per-transaction cap, rolling 24h cap, allowed ' +
		'recipients, allowed x402 hosts, an expiry, a confirm-above threshold, and a pause switch. Takes effect ' +
		'immediately, costs nothing, and needs no transaction. Only the fields you pass change; pass null to clear ' +
		'one. Empty allowlists mean unrestricted. These sit ON TOP of the on-chain allowance, which no software here ' +
		'can raise: to change that ceiling use approve_agent_allowance, and to cancel it entirely use ' +
		'revoke_agent_wallet.',
	inputSchema: {
		id: z.string().describe('The agent wallet.'),
		per_tx: z.string().nullable().optional().describe('Maximum single spend, in tokens. null clears it.'),
		daily: z.string().nullable().optional().describe('Maximum spend per rolling 24 hours. null clears it.'),
		confirm_over: z.string().nullable().optional().describe('Spends above this need an explicit human confirm:true. null clears it.'),
		allow_recipients: z.array(z.string()).nullable().optional().describe('Only these addresses may receive funds. Empty or null means unrestricted.'),
		allow_hosts: z.array(z.string()).nullable().optional().describe('Only these hosts may be paid over x402, subdomains included. Empty or null means unrestricted.'),
		expires_at: z.string().nullable().optional().describe('ISO timestamp after which every spend is refused. null clears it.'),
		paused: z.boolean().optional().describe('true stops every spend immediately. false resumes.'),
	},
	async handler(args) {
		const ctx = await agentContext(args.id);
		const patch = {};
		for (const key of ['per_tx', 'daily', 'confirm_over', 'allow_recipients', 'allow_hosts', 'expires_at', 'paused']) {
			if (key in args && args[key] !== undefined) patch[key] = args[key];
		}
		if (Object.keys(patch).length === 0) {
			throw Object.assign(new Error('pass at least one guardrail to change'), { code: 'validation_error' });
		}

		const before = ctx.policy;
		const after = normalizePolicy(patch, before);
		updateState((state) => {
			state.agents[ctx.record.id].policy = after;
		});

		const changed = Object.keys(after).filter((k) => JSON.stringify(after[k]) !== JSON.stringify(before[k]));

		return {
			ok: true,
			agent: ctx.record.id,
			changed,
			before,
			after,
			enforced_by: 'this server, before signing. The on-chain allowance is enforced by the SPL Token program.',
			live: describeAgent({ ...ctx, policy: after }),
		};
	},
};
