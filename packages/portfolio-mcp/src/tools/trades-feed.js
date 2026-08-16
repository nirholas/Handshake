// `get_trades_feed` — the public feed of notable closed positions, with realized
// PnL. Read-only, no auth.
//
// Wraps GET /api/trades/feed. This is the platform-wide feed of profitable exits
// across all agents — the canonical source of *realized* PnL on three.ws.

import { z } from 'zod';

import { apiRequest } from '../lib/api.js';

export const def = {
	name: 'get_trades_feed',
	title: 'Public closed-trade PnL feed',
	annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },
	description:
		'The public feed of notable CLOSED positions across all three.ws agents, newest exit first — the canonical ' +
		'source of realized PnL on the platform. Each item carries the coin (mint, symbol, name), the trader ' +
		'(agent_id, agent_name, copier_count), entry_sol / exit_sol / realized_pnl_sol / realized_pnl_pct / multiple, ' +
		'where realized_pnl_pct and multiple are the whole position\'s return across every sell leg while entry_sol ' +
		'and exit_sol describe the remaining cost basis and the closing leg only, ' +
		'hold_seconds, exit_reason, the buy/sell signatures, and oracle conviction context when the coin was scored. ' +
		'Filter by `mint` to see every closed trade on one coin (the time window is ignored when a mint is set). ' +
		'Paginate with `cursor` = the previous response\'s `next_cursor`. No auth required — read-only live data.',
	inputSchema: {
		network: z.enum(['mainnet', 'devnet']).default('mainnet').describe('Solana network (default mainnet).'),
		window: z
			.enum(['1h', '6h', '24h', '7d', '30d', 'all'])
			.default('24h')
			.describe('Time window for closed exits (default 24h). Ignored when `mint` is set.'),
		min_pnl_pct: z
			.number()
			.min(0)
			.default(10)
			.describe('Minimum realized profit %, to surface only meaningful wins (default 10).'),
		limit: z.number().int().min(1).max(80).default(40).describe('Max items to return, 1–80 (default 40).'),
		cursor: z
			.string()
			.optional()
			.describe('ISO timestamp for pagination — pass the previous response\'s `next_cursor`.'),
		mint: z
			.string()
			.optional()
			.describe('Filter to a single coin by base58 mint. When set, all closed trades on that coin are returned regardless of window.'),
	},
	async handler(args) {
		const data = await apiRequest('/api/trades/feed', {
			query: {
				network: args?.network === 'devnet' ? 'devnet' : 'mainnet',
				window: args?.window,
				min_pnl_pct: args?.min_pnl_pct,
				limit: args?.limit,
				cursor: args?.cursor,
				mint: args?.mint,
			},
		});
		return {
			ok: true,
			network: data?.network ?? 'mainnet',
			window: data?.window ?? '24h',
			min_pnl_pct: data?.min_pnl_pct ?? 10,
			mint: data?.mint ?? null,
			count: data?.count ?? (Array.isArray(data?.items) ? data.items.length : 0),
			items: Array.isArray(data?.items) ? data.items : [],
			next_cursor: data?.next_cursor ?? null,
			generated_at: data?.generated_at ?? null,
		};
	},
};
