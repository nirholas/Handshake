// KOL Tracker — the wallet-centric leaderboard behind /tracker and
// GET /api/kol/tracker, combining three independently-sourced, real signals per
// tracked wallet:
//   - trades + FIFO P&L/win-rate/volume, from wallet-pnl.js (real on-chain trades
//     via whatever _fetchTrades source is configured — no synthetic numbers)
//   - X follower count, from x-profile.js (real X API, only for wallets an admin
//     has explicitly attached a verified handle to — see import-gmgn's xHandle map)
//   - the tracked-wallet list itself, from wallet-store.js (bundled seed +
//     admin-curated R2 imports)
//
// A wallet with no xHandle attached still ranks — it just renders with no
// follower count, never a fabricated one. Same for P&L: if no trade source is
// configured (PUMPFUN_BOT_URL unset), realizedUsd/winRate/trades/volumeUsd fall
// back to whatever the wallet's own record carries (e.g. a gmgn import's
// pnlUsd/winRate), which is honestly labeled as `pnlSource`.

import { loadWallets } from './wallet-store.js';
import { getWalletPnl } from './wallet-pnl.js';
import { fetchXProfile } from './x-profile.js';

async function rowFor(entry, window) {
	const pnl = await getWalletPnl({ wallet: entry.wallet, window }).catch(() => null);
	const hasLiveTrades = !!pnl && pnl.trades > 0;

	const profile = entry.xHandle ? await fetchXProfile(entry.xHandle).catch(() => null) : null;

	return {
		wallet: entry.wallet,
		label: entry.label ?? null,
		xHandle: entry.xHandle ?? null,
		avatarUrl: profile?.avatarUrl ?? null,
		verified: profile?.verified ?? false,
		followerCount: profile?.followerCount ?? null,
		pnlUsd: hasLiveTrades ? pnl.realizedUsd : (entry.pnlUsd ?? null),
		volumeUsd: hasLiveTrades ? pnl.volumeUsd : null,
		winRate: hasLiveTrades ? pnl.winRate : (entry.winRate ?? null),
		trades: hasLiveTrades ? pnl.trades : null,
		pnlSource: hasLiveTrades ? 'onchain' : entry.pnlUsd != null ? entry.source || 'imported' : null,
		window,
	};
}

/**
 * @param {{ window?: '24h'|'7d'|'30d', limit?: number }} opts
 * @returns {Promise<Array>} rows sorted by pnlUsd desc (nulls last)
 */
export async function getKolTracker({ window = '7d', limit = 100 } = {}) {
	const wallets = await loadWallets();
	const top = wallets.slice(0, Math.max(1, Math.min(limit, wallets.length || limit)));
	const rows = await Promise.all(top.map((entry) => rowFor(entry, window)));
	rows.sort((a, b) => {
		if (a.pnlUsd == null && b.pnlUsd == null) return 0;
		if (a.pnlUsd == null) return 1;
		if (b.pnlUsd == null) return -1;
		return b.pnlUsd - a.pnlUsd;
	});
	return rows.slice(0, limit);
}
