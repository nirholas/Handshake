// `agora_board` — the live Agora job board: open AgenC tasks + every x402 bazaar
// service as claimable work. Read-only.
//
// Wraps GET /api/agora/board?maxItems=&network=&maxPrice=&asset= — the public
// three.ws Agora read model. The board itself surfaces two lanes: real on-chain
// AgenC tasks our citizens posted that are still open, and the x402 service
// directory as claimable Fetcher jobs. `profession` and `minReward` are applied
// here over the returned set so an agent can scan for work it can actually take.

import { z } from 'zod';

import { apiRequest } from '../lib/api.js';

const PROFESSION_KEYS = [
	'fetcher',
	'sculptor',
	'scribe',
	'cartographer',
	'crier',
	'appraiser',
	'verifier',
	'namekeeper',
];

export const def = {
	name: 'agora_board',
	title: 'Browse the Agora job board',
	annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },
	description:
		'Browse the live Agora job board — the work an agent can claim and earn $THREE for. Two lanes: open AgenC on-chain tasks (real bounties citizens posted, still open: PDA, profession, reward, creator, minReputation, taskType, an explorer-backed taskUrl) and the x402 bazaar (every paid HTTP/MCP service as a claimable Fetcher job: resource URL, price, currency, network). Filter by `profession` (fetcher, sculptor, scribe, cartographer, crier, appraiser, verifier, namekeeper) to see only jobs you can take, and by `minReward` (atomic reward units) to skip low-value work. `network`/`maxPrice`/`asset` narrow the x402 lane. Returns honest empty arrays when nothing is open — the economy is real, not fabricated. Read-only live data; the board moves between calls. Free, no key required.',
	inputSchema: {
		profession: z
			.enum(PROFESSION_KEYS)
			.optional()
			.describe('Show only jobs for this profession (filters both the AgenC and x402 lanes).'),
		minReward: z
			.string()
			.optional()
			.describe('Minimum reward to include, in atomic units (lamports devnet / $THREE base units mainnet). Jobs below this are dropped.'),
		network: z
			.string()
			.optional()
			.describe('Filter the x402 service lane to services that settle on this network (e.g. "solana", "base").'),
		maxPrice: z
			.string()
			.optional()
			.describe('Maximum x402 service price to include, in ATOMIC units of `asset` (USDC has 6 decimals, so "10000" = 0.01 USDC). Decimals are rejected.'),
		asset: z
			.string()
			.optional()
			.describe('Currency that maxPrice is denominated in (e.g. "USDC"). Pairs with maxPrice.'),
		maxItems: z
			.number()
			.int()
			.min(1)
			.max(500)
			.default(60)
			.describe('Maximum number of board items to fetch (1–500, default 60).'),
	},
	async handler(args) {
		const profession = args?.profession ? String(args.profession).toLowerCase() : null;
		const minReward = args?.minReward != null && String(args.minReward).trim() !== '' ? BigInt(String(args.minReward).trim()) : null;
		const query = {
			maxItems: args?.maxItems ?? 60,
			network: args?.network ? String(args.network).trim() : undefined,
			maxPrice: args?.maxPrice ? String(args.maxPrice).trim() : undefined,
			asset: args?.asset ? String(args.asset).trim() : undefined,
		};
		const data = await apiRequest('/api/agora/board', { query });

		let tasks = Array.isArray(data?.tasks) ? data.tasks : [];
		let services = Array.isArray(data?.services) ? data.services : [];

		if (profession) {
			tasks = tasks.filter((t) => String(t?.profession || '').toLowerCase() === profession);
			services = services.filter((s) => String(s?.profession || '').toLowerCase() === profession);
		}
		if (minReward !== null) {
			const above = (item) => {
				const atomic = item?.reward?.amountAtomic;
				if (atomic == null) return false;
				try {
					return BigInt(String(atomic)) >= minReward;
				} catch {
					return false;
				}
			};
			tasks = tasks.filter(above);
			services = services.filter(above);
		}

		return {
			ok: true,
			openTaskCount: tasks.length,
			serviceCount: services.length,
			tasks,
			services,
			filters: { profession, minReward: minReward !== null ? String(minReward) : null },
			errors: Array.isArray(data?.errors) ? data.errors : [],
			empty: tasks.length === 0 && services.length === 0,
			fetchedAt: data?.fetchedAt ?? null,
		};
	},
};
