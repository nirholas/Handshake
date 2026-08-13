// `get_wallet_portfolio` - one KOL wallet's holdings card plus its real trading
// record. Read-only.
//
// Wraps GET /api/kol/wallets?addresses=<wallet>. Two independently-sourced halves
// come back in one row: current holdings from Birdeye (server-side key) and, when
// three.ws has trade history for the wallet, realized P&L / win rate / volume
// FIFO-computed from that wallet's own on-chain trades. Any P&L field can be
// null, which means "no trade history to measure", never "flat".

import { z } from 'zod';

import { apiRequest } from '../lib/api.js';

export const def = {
	name: 'get_wallet_portfolio',
	title: 'KOL wallet portfolio + P&L',
	annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },
	description:
		"Pull one KOL trader's live portfolio card from three.ws. Returns current holdings " +
		'(total USD value, position count, and the single highest-value token the wallet ' +
		'holds) from the Birdeye proxy, plus realized P&L, win rate, trade count and volume ' +
		'over the last 30 days FIFO-computed from that wallet\'s own on-chain trades. Use this ' +
		'to size up a specific smart trader before copying or analyzing them. For ranking many ' +
		'traders at once use intel-mcp `kol_leaderboard`; this is the per-wallet deep dive. ' +
		'A null P&L field (with `pnl_source: null`) means three.ws has no trade history for ' +
		'that wallet in the window, which is an honest "unknown", NOT a flat or losing record: ' +
		'never report it as zero profit. `has_activity:false` means no holdings and no trades. ' +
		'Read-only live data.',
	inputSchema: {
		wallet: z
			.string()
			.min(1)
			.describe('The Solana wallet address of the KOL trader to pull a portfolio card for.'),
	},
	async handler(args) {
		const wallet = String(args?.wallet ?? '').trim();
		const data = await apiRequest('/api/kol/wallets', { query: { addresses: wallet } });
		// The proxy returns one row per requested address, and omits an address whose
		// upstream fetch failed rather than inventing a row for it.
		const rows = Array.isArray(data?.data) ? data.data : [];
		const row = rows.find((r) => r?.address === wallet) ?? rows[0] ?? {};

		const holdings = row.holdings ?? 0;
		const totalTrades = row.totalTrades ?? null;

		return {
			ok: true,
			wallet: row.address ?? wallet,
			has_activity: holdings > 0 || (totalTrades ?? 0) > 0,
			portfolio_value_usd: row.totalUsd ?? null,
			holdings,
			top_token: row.topToken ?? null,
			realized_pnl_usd: row.realizedPnl ?? null,
			win_rate: row.winRate ?? null,
			total_trades: totalTrades,
			volume_usd: row.volumeUsd ?? null,
			pnl_source: row.pnlSource ?? null,
			pnl_window: row.pnlWindow ?? null,
		};
	},
};
