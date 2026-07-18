// Pure math + policy parsing for the programmatic $THREE buyback.
//
// Deliberately free of DB / RPC / web3 imports so it can be unit-tested in
// isolation and reused without dragging in the Solana stack. All money math is
// BigInt-on-atomics; only display conversions return Number.

export const USDC_DECIMALS = 6;
export const USDC_ATOMICS = 10n ** BigInt(USDC_DECIMALS);

/** Parse a positive-USD env value, falling back when unset/invalid. */
export function envUsd(raw, fallback) {
	if (raw === undefined || String(raw).trim() === '') return fallback;
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Parse a slippage-bps env value (0 < bps ≤ 5000), else fallback. */
export function envSlippageBps(raw, fallback = 300) {
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 && n <= 5000 ? Math.round(n) : fallback;
}

/** Parse a commitment-bps env value in [0, 10000], else fallback. */
export function envBps(raw, fallback) {
	if (raw === undefined || String(raw).trim() === '') return fallback;
	const n = Number(raw);
	return Number.isFinite(n) && n >= 0 && n <= 10_000 ? Math.round(n) : fallback;
}

/** Whole USD → USDC atomics (6dp), floored. */
export function usdToUsdcAtomics(usd) {
	return BigInt(Math.floor(Number(usd) * Number(USDC_ATOMICS)));
}

/** USDC atomics (6dp) → whole USD. */
export function usdcAtomicsToUsd(atomics) {
	return Number(BigInt(atomics)) / Number(USDC_ATOMICS);
}

/** Token atomics → whole tokens at the given decimals. */
export function atomicsToTokens(atomics, decimals) {
	return Number(BigInt(atomics)) / 10 ** Number(decimals);
}

/**
 * Decide how much USDC to deploy this run: spend up to the per-run cap, bounded
 * by the wallet's live balance, and only if it clears the minimum (so a run never
 * pays more in fees than it buys). Pure — the single source of sizing truth.
 *
 * @param {bigint|string|number} walletUsdcAtomics live USDC balance (atomics)
 * @param {{ maxUsd: number, minUsd: number }} caps
 * @returns {{ spendAtomics: bigint, reason: 'ok'|'empty'|'below_threshold' }}
 */
export function computeSpend(walletUsdcAtomics, { maxUsd, minUsd }) {
	const wallet = BigInt(walletUsdcAtomics);
	const cap = usdToUsdcAtomics(maxUsd);
	const min = usdToUsdcAtomics(minUsd);
	const spend = wallet > cap ? cap : wallet;
	if (spend < min) {
		return { spendAtomics: 0n, reason: wallet === 0n ? 'empty' : 'below_threshold' };
	}
	return { spendAtomics: spend, reason: 'ok' };
}

/**
 * Would reserving `needAtomics` on top of `spentAtomics` cross `capAtomics`? Pure,
 * BigInt-exact — the single sizing rule the $THREE micro-buy daily cap is checked
 * against (Redis fast path and DB fallback both defer to it), so the "never spend
 * past the ceiling" guarantee lives in one tested place. A zero/negative need never
 * exceeds; a zero cap always does (except a zero need).
 * @param {bigint|string|number} spentAtomics already reserved today
 * @param {bigint|string|number} needAtomics this reservation
 * @param {bigint|string|number} capAtomics the daily ceiling
 * @returns {boolean}
 */
export function wouldExceedCap(spentAtomics, needAtomics, capAtomics) {
	return BigInt(spentAtomics) + BigInt(needAtomics) > BigInt(capAtomics);
}

/** Share of revenue already deployed to buybacks, clamped to [0,100]. */
export function deployedPct(deployedUsd, revenueUsd) {
	if (!(revenueUsd > 0)) return 0;
	return Math.min(100, (deployedUsd / revenueUsd) * 100);
}

/**
 * USD the protocol has *committed* to convert into $THREE buybacks: the published
 * commitment (commitBps) applied to lifetime revenue. This is the promise — the
 * dollar target that on-chain buys are measured against — not what's been deployed.
 */
export function committedUsd(revenueUsd, commitBps) {
	const rev = Number(revenueUsd);
	const bps = Number(commitBps);
	if (!(rev > 0) || !(bps > 0)) return 0;
	return rev * (bps / 10_000);
}

/**
 * Share of the *commitment* actually deployed on-chain, clamped to [0,100]. 100%
 * means every committed dollar of revenue has already been converted to buy
 * pressure; this is the honest "are we keeping the promise" figure, distinct from
 * deployedPct (share of *all* revenue).
 */
export function commitmentProgressPct(deployedUsd, committedUsdTarget) {
	if (!(committedUsdTarget > 0)) return 0;
	return Math.min(100, (Number(deployedUsd) / Number(committedUsdTarget)) * 100);
}
