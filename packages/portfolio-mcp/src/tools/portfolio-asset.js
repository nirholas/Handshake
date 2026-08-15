// `get_portfolio_asset` — a single token's combined position across all of your
// agent wallets, plus live market data and a price chart. Account-scoped. Read-only.
//
// Wraps GET /api/portfolio/asset?chain&id&days&chain_id. Combines your holdings
// of one asset with CoinGecko market data + a price-history chart for that asset.

import { z } from 'zod';

import { apiRequest } from '../lib/api.js';

export const def = {
	name: 'get_portfolio_asset',
	title: 'My position in one token (holdings + market + chart)',
	annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },
	description:
		'Deep-dive on ONE asset across every agent wallet you own. Returns which wallets hold it, your ' +
		'`total_amount` and `total_usd`, the per-wallet `holdings`, the live `market` data (price, 24h/7d/30d ' +
		'change, market cap, volume, ATH) and a `chart` of price history over `days`. Use `id:"native"` for the ' +
		'chain’s base coin (SOL on solana, ETH on evm), otherwise the base58 SPL mint or the 0x contract address. ' +
		'Requires THREE_WS_SESSION. Read-only.',
	inputSchema: {
		chain: z.enum(['solana', 'evm']).describe('Which chain the asset lives on.'),
		id: z
			.string()
			.min(1)
			.describe('"native" for the base coin (SOL/ETH), otherwise the base58 SPL mint or 0x ERC-20 contract.'),
		days: z
			.number()
			.int()
			.min(1)
			.max(365)
			.default(30)
			.describe('Days of price history for the chart, 1–365 (default 30).'),
		chain_id: z
			.number()
			.int()
			.positive()
			.optional()
			.describe(
				'Optional EVM chain id (8453 Base, 1 Ethereum, 42161 Arbitrum, …). Pins which chain the contract ' +
					'is priced on; defaults to the chain of the wallets holding it. Ignored on solana.',
			),
	},
	async handler(args) {
		const data = await apiRequest('/api/portfolio/asset', {
			auth: true,
			query: { chain: args?.chain, id: args?.id, days: args?.days ?? 30, chain_id: args?.chain_id },
		});
		return {
			ok: true,
			chain: data?.chain ?? args?.chain,
			chain_id: data?.chain_id ?? args?.chain_id ?? null,
			id: data?.id ?? args?.id,
			is_native: data?.is_native ?? false,
			symbol: data?.symbol ?? null,
			logo: data?.logo ?? null,
			decimals: data?.decimals ?? null,
			unit_price_usd: data?.unit_price_usd ?? 0,
			total_amount: data?.total_amount ?? 0,
			total_usd: data?.total_usd ?? 0,
			holdings: Array.isArray(data?.holdings) ? data.holdings : [],
			market: data?.market ?? null,
			chart: data?.chart ?? { days: args?.days ?? 30, points: [] },
		};
	},
};
