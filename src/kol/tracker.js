// KOL Tracker — the wallet-centric leaderboard behind /tracker and
// GET /api/kol/tracker, combining independently-sourced, real signals per
// tracked wallet:
//   - the tracked-wallet universe itself: the live kolscan.io board for the
//     requested window (real Solana traders ranked by realized SOL profit, via
//     leaderboard.js) merged with admin-curated entries from wallet-store.js
//     (R2 imports; the bundled wallets.json is a merge target, not a data source)
//   - trades + FIFO P&L/win-rate/volume, from wallet-pnl.js (real on-chain trades
//     via whatever _fetchTrades source is configured — no synthetic numbers)
//   - X follower count, from x-profile.js (real X API, only for wallets an admin
//     has explicitly attached a verified handle to — see import-gmgn's xHandle map)
//
// Precedence per wallet: our own on-chain FIFO P&L wins when we have trades for
// it; otherwise the live kolscan figure for that window; otherwise whatever the
// curated record carries. Whichever one is used is named in `pnlSource`, so the
// page never renders a number whose provenance it can't state.
//
// A wallet with no xHandle attached still ranks — it just renders with no
// follower count, never a fabricated one. If every source is unreachable the
// tracker returns an empty array and the page renders its empty state; it never
// falls back to placeholder rows.

import { loadWallets } from './wallet-store.js';
import { getWalletPnl } from './wallet-pnl.js';
import { fetchXProfile } from './x-profile.js';
import { getLeaderboard } from './leaderboard.js';

async function rowFor(entry, window) {
	const pnl = await getWalletPnl({ wallet: entry.wallet, window }).catch(() => null);
	const hasLiveTrades = !!pnl && pnl.trades > 0;

	const profile = entry.xHandle ? await fetchXProfile(entry.xHandle).catch(() => null) : null;

	// Fallback chain below on-chain: the live board for this window, then the
	// curated record. `source` names whichever one supplied the numbers.
	const fallbackPnl = entry.livePnlUsd ?? entry.pnlUsd ?? null;
	const fallbackWinRate = entry.livePnlUsd != null ? (entry.liveWinRate ?? null) : (entry.winRate ?? null);
	const fallbackTrades = entry.livePnlUsd != null ? (entry.liveTrades ?? null) : null;
	const fallbackSource = entry.livePnlUsd != null ? 'kolscan' : entry.source || 'imported';

	return {
		wallet: entry.wallet,
		label: entry.label ?? null,
		xHandle: entry.xHandle ?? null,
		avatarUrl: profile?.avatarUrl ?? null,
		verified: profile?.verified ?? false,
		followerCount: profile?.followerCount ?? null,
		pnlUsd: hasLiveTrades ? pnl.realizedUsd : fallbackPnl,
		volumeUsd: hasLiveTrades ? pnl.volumeUsd : null,
		winRate: hasLiveTrades ? pnl.winRate : fallbackWinRate,
		trades: hasLiveTrades ? pnl.trades : fallbackTrades,
		pnlSource: hasLiveTrades ? 'onchain' : fallbackPnl != null ? fallbackSource : null,
		window,
	};
}

// Live board rows carry the numbers; curated records carry the identity (label,
// xHandle). Merge them by address so a curated wallet that also ranks live gets
// both, and neither list can drop the other's wallets.
function mergeUniverse(liveRows, curated) {
	const byWallet = new Map();

	for (const row of liveRows) {
		byWallet.set(row.wallet, {
			wallet: row.wallet,
			livePnlUsd: row.pnlUsd,
			liveWinRate: Number.isFinite(row.winRate) ? row.winRate : null,
			liveTrades: Number.isFinite(row.trades) ? row.trades : null,
		});
	}

	for (const entry of curated) {
		if (!entry || typeof entry.wallet !== 'string') continue;
		byWallet.set(entry.wallet, { ...byWallet.get(entry.wallet), ...entry });
	}

	return [...byWallet.values()];
}

/**
 * @param {object} opts
 * @param {'24h'|'7d'|'30d'} [opts.window]
 * @param {number} [opts.limit]
 * @param {(opts: object) => Promise<Array>} [opts.fetchBoard]
 *   Live wallet-universe source override (tests inject a fixture). Defaults to
 *   the kolscan-backed leaderboard.
 * @returns {Promise<Array>} rows sorted by pnlUsd desc (nulls last)
 */
export async function getKolTracker({ window = '7d', limit = 100, fetchBoard = getLeaderboard } = {}) {
	const cap = Math.max(1, Math.min(Number(limit) || 100, 100));

	const [liveRows, curated] = await Promise.all([
		fetchBoard({ window, limit: cap }).catch(() => []),
		loadWallets().catch(() => []),
	]);

	const universe = mergeUniverse(Array.isArray(liveRows) ? liveRows : [], curated);
	if (!universe.length) return [];

	const rows = await Promise.all(universe.slice(0, cap).map((entry) => rowFor(entry, window)));
	rows.sort((a, b) => {
		if (a.pnlUsd == null && b.pnlUsd == null) return 0;
		if (a.pnlUsd == null) return 1;
		if (b.pnlUsd == null) return -1;
		return b.pnlUsd - a.pnlUsd;
	});
	return rows.slice(0, cap);
}
