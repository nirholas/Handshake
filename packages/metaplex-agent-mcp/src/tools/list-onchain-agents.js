// `list_onchain_agents` is the live registration feed. Agents landing in the
// Metaplex Agent Registry (and, cross-chain, ERC-8004 registries), served by
// the public three.ws /api/deployments feed. Real registrations only.

import { z } from 'zod';

import { NETWORK, THREE_WS_BASE, HTTP_TIMEOUT_MS, USER_AGENT } from '../config.js';
import { agentLinks } from '../lib/solana.js';

// The feed treats Solana as a chain id: mainnet-beta 101, devnet 103.
const SOLANA_CHAIN_ID = { mainnet: 101, devnet: 103 };

export const def = {
	name: 'list_onchain_agents',
	title: 'List the latest on-chain agent registrations',
	annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },
	description:
		'The latest agents to land on-chain in the Metaplex Agent Registry, newest first, from the live three.ws ' +
		'/api/deployments feed (which also indexes registrations minted outside three.ws). Each entry carries the ' +
		'Core asset address, name, description, image, owner, 3D and x402 flags, and explorer links. Set ' +
		"all_chains:true to include EVM ERC-8004 registrations in the same stream. Read-only.",
	inputSchema: {
		limit: z.number().int().min(1).max(60).optional().describe('How many registrations to return. Default 12.'),
		network: z.enum(['mainnet', 'devnet']).optional().describe('Solana cluster. Defaults to the configured network.'),
		all_chains: z.boolean().optional().describe('Include EVM ERC-8004 registrations too. Default false (Solana only).'),
		cursor: z.string().optional().describe('Pagination cursor from a previous call.'),
	},
	async handler(args) {
		const network = args.network || NETWORK;
		const limit = args.limit || 12;
		const params = new URLSearchParams({ limit: String(limit) });
		params.set('network', network === 'devnet' ? 'testnet' : 'mainnet');
		if (!args.all_chains) params.set('chain', String(SOLANA_CHAIN_ID[network]));
		if (args.cursor) params.set('cursor', args.cursor);

		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
		let body;
		try {
			const res = await fetch(`${THREE_WS_BASE}/api/deployments?${params}`, {
				signal: ctrl.signal,
				headers: { accept: 'application/json', 'user-agent': USER_AGENT },
			});
			if (!res.ok) {
				throw Object.assign(new Error(`deployments feed returned ${res.status}`), {
					code: 'feed_error',
					status: res.status,
				});
			}
			body = await res.json();
		} finally {
			clearTimeout(timer);
		}

		const items = (body?.data?.deployments || []).map((d) => ({
			chain: d.chain,
			chain_id: d.chain_id,
			asset: d.agent_id,
			name: d.name,
			description: d.description,
			image: d.image,
			owner: d.owner,
			has_3d: d.has_3d,
			x402_support: d.x402_support,
			registered_at: d.registered_at,
			...(d.family === 'solana'
				? { links: agentLinks(d.agent_id, d.testnet ? 'devnet' : 'mainnet') }
				: { explorer: d.agent_explorer }),
		}));

		return {
			ok: true,
			network,
			count: items.length,
			agents: items,
			...(body?.data?.next_cursor ? { next_cursor: body.data.next_cursor } : {}),
			feed: `${THREE_WS_BASE}/deployments`,
		};
	},
};
