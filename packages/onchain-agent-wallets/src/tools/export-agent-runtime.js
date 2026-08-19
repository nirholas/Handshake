// `export_agent_runtime`: hand the agent everything it needs to run somewhere
// else, and nothing it does not.
//
// By default the export is safe to paste anywhere: addresses, limits, and the
// MCP client config, with no key material. Ask for the key explicitly and you
// get it, with the blast radius spelled out.

import { z } from 'zod';

import { NETWORK, STATE_DIR } from '../config.js';
import { accountLink } from '../lib/solana.js';
import { agentContext, describeAgent } from '../lib/agent.js';

export const def = {
	name: 'export_agent_runtime',
	title: 'Export an agent wallet as a runnable MCP config',
	annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
	description:
		'Produce the config that puts this agent wallet in front of a model: an mcp.json block, the equivalent ' +
		'claude mcp add command, the agent identity card (payment address, vault, token, limits), and the x402 ' +
		'details a counterparty needs to bill it. By default no key material is included, so the output is safe to ' +
		'paste into a repo or a ticket. Pass include_secret:true only when moving the agent to another machine.',
	inputSchema: {
		id: z.string().describe('The agent wallet to export.'),
		include_secret: z
			.boolean()
			.optional()
			.describe("Include the agent's secret key. Anyone holding it can spend up to the allowance. Default false."),
	},
	async handler(args) {
		const ctx = await agentContext(args.id);
		const described = describeAgent(ctx);
		const { record } = ctx;

		const env = {
			OAW_NETWORK: NETWORK,
			OAW_STATE_DIR: STATE_DIR,
		};
		if (args.include_secret === true) env.OAW_AGENT_SECRET = record.agent_secret;

		const mcpConfig = {
			mcpServers: {
				'onchain-agent-wallets': {
					command: 'npx',
					args: ['-y', '@three-ws/onchain-agent-wallets'],
					env,
				},
			},
		};

		const cliArgs = Object.entries(env)
			.map(([k, v]) => `-e ${k}=${v}`)
			.join(' ');

		return {
			ok: true,
			agent: described,
			identity_card: {
				agent: record.id,
				pay_to: record.agent_pubkey,
				accepts: record.mint,
				network: `solana:${NETWORK}`,
				x402: true,
				vault: record.vault,
				vault_link: accountLink(record.vault, NETWORK),
				spending_limit: described.allowance_remaining,
				custody: 'The owner holds the funds. This agent spends against a revocable on-chain delegation.',
				onchain_identity: record.deployment?.asset || null,
			},
			mcp_json: mcpConfig,
			claude_code: `claude mcp add onchain-agent-wallets ${cliArgs} -- npx -y @three-ws/onchain-agent-wallets`,
			secret_included: args.include_secret === true,
			...(args.include_secret === true
				? {
						warning:
							'This output contains the agent secret key. Anyone holding it can spend up to the remaining ' +
							`allowance (${described.allowance_remaining}). It cannot touch the rest of the owner's funds, and ` +
							'revoke_agent_wallet cancels it instantly.',
					}
				: {
						note: 'No key material included. The agent can only spend from the machine that holds its keypair.',
					}),
		};
	},
};
