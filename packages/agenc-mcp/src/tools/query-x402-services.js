// `query_x402_services` — browse the x402 service directory as claimable work.
// Read-only.
//
// Wraps GET /api/agenc/x402-services. The three.ws bridge maps every x402
// service in the bazaar (paid HTTP endpoints / MCP tools) to an AgenC-shaped
// task: a deterministic taskId seed, price, capability bit, and pay-to-endpoint
// reward kind — so an agent can discover paid work the same way it discovers
// on-chain tasks.

import { z } from 'zod';

import { apiRequest } from '../lib/api.js';

export const def = {
	name: 'query_x402_services',
	title: 'Query x402 services as AgenC tasks',
	annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },
	description:
		'Browse the x402 service directory (the bazaar of paid HTTP endpoints and MCP tools) projected into AgenC task shape. Each entry returns the resource URL, service/tool name, description, tags, HTTP method, a deterministic `taskIdSeed` (so re-posting maps to the same AgenC task PDA), the `price` (atomic + label, currency, network, settlement family), input/output schema hints, and `rewardKind:"x402_pay_to_endpoint"`. Filter by `type` (http endpoints or mcp tools), `network`, `maxPrice` (in the given `asset`), and `extension`. Use this to discover paid work an agent can earn by calling — the x402 complement to the on-chain task marketplace. Read-only live directory data; the feed moves between calls. Free, no key required.',
	inputSchema: {
		type: z
			.enum(['http', 'mcp'])
			.default('http')
			.describe('Which kind of x402 service to list: http endpoints or mcp tools (default http).'),
		network: z
			.string()
			.optional()
			.describe('Filter to services that settle on this network (e.g. "solana", "base").'),
		maxPrice: z
			.string()
			.optional()
			.describe('Maximum price to include, in ATOMIC units of `asset` (USDC has 6 decimals, so "10000" = 0.01 USDC). Decimals are rejected.'),
		asset: z
			.string()
			.optional()
			.describe('Currency that maxPrice is denominated in (e.g. "USDC"). Pairs with maxPrice.'),
		extension: z
			.string()
			.optional()
			.describe('Filter to services declaring this capability extension.'),
		maxItems: z
			.number()
			.int()
			.min(1)
			.max(1000)
			.default(200)
			.describe('Maximum number of services to return (1–1000, default 200).'),
	},
	async handler(args) {
		const type = args?.type === 'mcp' ? 'mcp' : 'http';
		const query = {
			type,
			network: args?.network ? String(args.network).trim() : undefined,
			maxPrice: args?.maxPrice ? String(args.maxPrice).trim() : undefined,
			asset: args?.asset ? String(args.asset).trim() : undefined,
			extension: args?.extension ? String(args.extension).trim() : undefined,
			maxItems: args?.maxItems ?? 200,
		};
		const data = await apiRequest('/api/agenc/x402-services', { query });
		return {
			ok: true,
			count: data?.count ?? (Array.isArray(data?.tasks) ? data.tasks.length : 0),
			tasks: Array.isArray(data?.tasks) ? data.tasks : [],
			sources: data?.sources ?? null,
			errors: Array.isArray(data?.errors) ? data.errors : [],
			fetchedAt: data?.fetchedAt ?? null,
		};
	},
};
