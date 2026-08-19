// `list_agent_wallets`: every agent this owner has on this network, with live
// balances. One RPC round per agent, so it stays honest rather than fast.

import { z } from 'zod';

import { NETWORK } from '../config.js';
import { listAgents } from '../lib/store.js';
import { agentContext, describeAgent } from '../lib/agent.js';

export const def = {
	name: 'list_agent_wallets',
	title: 'Every agent wallet on this machine',
	annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },
	description:
		'List the agent wallets configured here, each with its live vault balance, remaining on-chain allowance, and ' +
		'guardrails. Read-only.',
	inputSchema: {
		owner: z.string().optional().describe('Only agents belonging to this owner address.'),
	},
	async handler(args) {
		const records = listAgents().filter((r) => !args.owner || r.owner === args.owner);
		const agents = [];
		for (const record of records) {
			try {
				agents.push(describeAgent(await agentContext(record.id)));
			} catch (err) {
				agents.push({ id: record.id, owner: record.owner, error: err.message, code: err.code || 'unreadable' });
			}
		}
		return {
			ok: true,
			network: NETWORK,
			count: agents.length,
			agents,
			...(agents.length === 0
				? { empty: 'No agent wallets yet. Run create_agent_wallet to give an agent a spending allowance.' }
				: {}),
		};
	},
};
