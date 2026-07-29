/**
 * Pure helpers for /fits (the public cosmetics economy page).
 *
 * DOM-free and network-free so the money formatting, rarity ordering, and the
 * derived headline numbers are unit-testable. Every input here comes from
 * /api/cosmetics/leaderboard or /api/cosmetics/earnings, which read the settled
 * -sale ledger; nothing is estimated.
 */

export const RARITY_LABEL = {
	common: 'Common',
	rare: 'Rare',
	epic: 'Epic',
	legendary: 'Legendary',
};

// Ascending scarcity. Used to break ties when two fits have the same owner
// count, so a legendary never sorts below a rare with equal scarcity.
const RARITY_ORDER = ['common', 'rare', 'epic', 'legendary'];

/** @param {string|null|undefined} rarity */
export function rarityRank(rarity) {
	const i = RARITY_ORDER.indexOf(String(rarity || '').toLowerCase());
	return i === -1 ? 0 : i;
}

/**
 * USDC display. The ledger reports decimal USDC (not atomics), and cosmetic
 * prices run to fractions of a cent, so keep precision below a cent instead of
 * collapsing every micro-sale to $0.00.
 * @param {number|string|null|undefined} usdc
 */
export function fmtUsdc(usdc) {
	const n = Number(usdc);
	if (!Number.isFinite(n)) return '$0.00';
	if (n === 0) return '$0.00';
	if (Math.abs(n) < 0.01) return `$${n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`;
	if (Math.abs(n) >= 1000) return `$${Math.round(n).toLocaleString('en-US')}`;
	return `$${n.toFixed(2)}`;
}

/** @param {number|string|null|undefined} n */
export function fmtCount(n) {
	const v = Number(n);
	if (!Number.isFinite(v)) return '0';
	return v.toLocaleString('en-US');
}

/** @param {string} addr */
export function shortWallet(addr) {
	const s = String(addr || '');
	if (s.length <= 12) return s;
	return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

/**
 * Collector accounts are a mix of real wallets and guest session handles
 * (`g_*` / `guest-*`). A guest handle is not an address, so truncating it in
 * the middle produces noise; label it plainly instead.
 * @param {string} account
 */
export function displayAccount(account) {
	const s = String(account || '');
	if (/^(g_|guest-)/.test(s)) return 'Guest';
	return shortWallet(s);
}

/**
 * Fits ranked by scarcity: fewest owners first, then by rarity tier.
 * @param {Array<{owners?: number, rarity?: string}>} fits
 */
export function rankFits(fits) {
	return [...(fits || [])].sort((a, b) => {
		const oa = Number(a.owners) || 0;
		const ob = Number(b.owners) || 0;
		if (oa !== ob) return oa - ob;
		return rarityRank(b.rarity) - rarityRank(a.rarity);
	});
}

/**
 * The headline numbers, derived from the board rather than fetched separately
 * so they can never disagree with the rows rendered underneath them.
 *
 * `grossUsdc` sums the recent-sales window the API returns, so it is labelled
 * as that window in the UI and never presented as an all-time total.
 *
 * @param {{rarestFits?: Array, topCollectors?: Array, topCreators?: Array, recent?: Array}} board
 */
export function summarizeBoard(board) {
	const fits = board?.rarestFits || [];
	const collectors = board?.topCollectors || [];
	const creators = board?.topCreators || [];
	const recent = board?.recent || [];

	let grossUsdc = 0;
	for (const sale of recent) {
		const n = Number(sale?.priceUsdc);
		if (Number.isFinite(n)) grossUsdc += n;
	}
	let creatorEarnedUsdc = 0;
	let creatorSales = 0;
	for (const c of creators) {
		const n = Number(c?.earnedUsdc);
		if (Number.isFinite(n)) creatorEarnedUsdc += n;
		const s = Number(c?.sales);
		if (Number.isFinite(s)) creatorSales += s;
	}
	const rarest = rankFits(fits)[0] || null;

	return {
		fitsTracked: fits.length,
		collectors: collectors.length,
		creators: creators.length,
		creatorSales,
		creatorEarnedUsdc,
		recentGrossUsdc: grossUsdc,
		recentSales: recent.length,
		rarest,
	};
}

/** True when the board carries nothing worth rendering. */
export function boardIsEmpty(board) {
	if (!board) return true;
	return (
		!(board.rarestFits || []).length &&
		!(board.topCollectors || []).length &&
		!(board.topCreators || []).length &&
		!(board.recent || []).length
	);
}

/**
 * Deep link to the coin world a fit belongs to. Returns null when the sale
 * carries no mint, so callers render plain text instead of a dead link.
 * @param {string|null|undefined} mint
 */
export function coinWorldUrl(mint) {
	const m = String(mint || '').trim();
	if (!m) return null;
	return `/play?coin=${encodeURIComponent(m)}`;
}

/** @param {string|null|undefined} wallet */
export function solscanAccountUrl(wallet) {
	const w = String(wallet || '').trim();
	if (!w) return null;
	return `https://solscan.io/account/${encodeURIComponent(w)}`;
}

/**
 * Basic Solana address shape check, mirroring `isWallet` on the server so the
 * creator lookup rejects obvious typos before spending a request.
 * @param {string} value
 */
export function looksLikeWallet(value) {
	return /^[A-HJ-NP-Za-km-z1-9]{32,44}$/.test(String(value || '').trim());
}
