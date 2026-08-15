// @ts-check
// Back-an-Agent Vaults — the canonical share-accounting + safety math.
//
// PURE by construction: every function here is a deterministic BigInt computation
// with no DB, network, clock, or randomness. That's deliberate — this is the code
// that decides how many shares a deposit mints, what a redemption pays, what
// performance fee the owner earns, and whether the drawdown circuit breaker trips.
// It must be auditable and unit-testable in isolation (see tests/vault-accounting),
// and identical wherever it runs (server settlement + client preview).
//
// Units
//   • All money is USDC atomic units (6 decimals): 1 USDC = 1_000_000n atomics.
//   • Shares are unitless BigInt. The FIRST deposit into an empty vault mints
//     shares 1:1 with the USDC atomics deposited, so the initial share price is
//     exactly 1.000000 USDC. Every later deposit/redemption is priced against the
//     live NAV (vault USDC balance + mark-to-market value of open positions).
//   • Share price is reported scaled by 1e6 (`*_e6`) so a price of 1.5 USDC/share
//     is the integer 1_500_000 — exact, no float.
//
// Invariants the tests pin down
//   • A redemption never pays out more than the vault's pro-rata NAV (floor div).
//   • The sum of all backers' redemptions at a fixed NAV never exceeds NAV (no
//     dust overdraw) — the vault can never be drained below what it holds.
//   • The performance fee is charged ONLY on a backer's realized gain above their
//     own cost basis — never on principal, never on a loss, never cross-subsidized.

export const SHARE_PRICE_SCALE = 1_000_000n; // 1e6 — share price fixed-point scale
export const USDC_DECIMALS = 6;
export const USDC_ATOMICS = 1_000_000n;
export const BPS = 10_000n;

// The negotiable vault terms and their hard bounds. One definition, shared by the
// open route and the owner's terms PATCH, so the two can never drift apart on
// what a legal performance fee or drawdown limit is.
export const TERM_BOUNDS = {
	performanceFeeBps: { min: 0, max: 5000, def: 1000 },
	maxDrawdownBps: { min: 100, max: 9000, def: 2500 },
};

/**
 * Clamp a caller-supplied basis-points term into its bound. Returns null when the
 * value is not a real number, so a PATCH can reject "abc" at the boundary instead
 * of writing a NaN into an integer column.
 */
export function clampTermBps(value, bound) {
	const n = Math.round(Number(value));
	if (!Number.isFinite(n)) return null;
	return Math.max(bound.min, Math.min(bound.max, n));
}

/** Coerce a value (BigInt | number | numeric-string | null) to BigInt atomics. */
export function toBig(v) {
	if (typeof v === 'bigint') return v;
	if (v == null) return 0n;
	if (typeof v === 'number') {
		if (!Number.isFinite(v)) return 0n;
		return BigInt(Math.trunc(v));
	}
	const s = String(v).trim();
	if (!s) return 0n;
	// numeric(40,0) columns come back as plain integer strings; tolerate a stray
	// decimal tail by truncating it (never round up into funds that aren't there).
	const dot = s.indexOf('.');
	return BigInt(dot >= 0 ? s.slice(0, dot) : s);
}

/**
 * Boundary parse for a caller-supplied share/token amount. `toBig` is the
 * INTERNAL coercion and trusts its input (a numeric column, a computed value);
 * handing it a caller's "abc" throws a SyntaxError that surfaces as a 500. This
 * is the guard that belongs at the HTTP edge: it returns a non-negative BigInt
 * for anything genuinely numeric, and null for anything else so the handler can
 * answer 400 instead.
 */
export function parseAmountInput(value) {
	if (typeof value === 'bigint') return value >= 0n ? value : null;
	if (typeof value === 'number') {
		if (!Number.isFinite(value) || value < 0) return null;
		return BigInt(Math.trunc(value));
	}
	if (typeof value !== 'string') return null;
	const s = value.trim();
	if (!/^\d+(\.\d+)?$/.test(s)) return null;
	return toBig(s);
}

/** Float USDC → 6-decimal atomics (BigInt, floored, never negative). */
export function usdcToAtomics(usdc) {
	const n = Number(usdc);
	if (!Number.isFinite(n) || n <= 0) return 0n;
	return BigInt(Math.floor(n * Number(USDC_ATOMICS)));
}

/** Atomics → float USDC (for display only — never feed back into accounting). */
export function atomicsToUsdc(atomics) {
	return Number(toBig(atomics)) / Number(USDC_ATOMICS);
}

/**
 * Share price scaled by 1e6. An empty vault (no shares) is 1.000000 by definition,
 * so the first deposit always mints at par. With shares outstanding the price is
 * NAV per share: a vault that doubled shows 2_000_000.
 */
export function sharePriceE6(navAtomics, totalShares) {
	const nav = toBig(navAtomics);
	const shares = toBig(totalShares);
	if (shares <= 0n) return SHARE_PRICE_SCALE;
	return (nav * SHARE_PRICE_SCALE) / shares;
}

/**
 * Shares minted for a deposit of `depositAtomics` against the NAV measured BEFORE
 * the deposit lands. Floors so the vault never over-issues shares against the
 * capital actually received. A first deposit (or a wiped-out vault with no
 * recoverable NAV) mints 1:1 at par.
 */
export function sharesForDeposit(depositAtomics, navBeforeAtomics, totalShares) {
	const deposit = toBig(depositAtomics);
	const navBefore = toBig(navBeforeAtomics);
	const shares = toBig(totalShares);
	if (deposit <= 0n) return 0n;
	if (shares <= 0n || navBefore <= 0n) return deposit; // par: 1 share = 1 atomic
	return (deposit * shares) / navBefore;
}

/**
 * Gross USDC value of redeeming `shares` out of a vault holding `navAtomics`
 * across `totalShares`. Floors — the pro-rata claim, never a cent more than held.
 */
export function payoutForShares(shares, navAtomics, totalShares) {
	const s = toBig(shares);
	const nav = toBig(navAtomics);
	const total = toBig(totalShares);
	if (s <= 0n || total <= 0n || nav <= 0n) return 0n;
	if (s >= total) return nav; // last holder out takes the remainder exactly (no dust left behind)
	return (s * nav) / total;
}

/**
 * Crystallize a redemption: gross pro-rata payout, the cost basis attributable to
 * the redeemed shares, the realized gain, the owner's performance fee (only on a
 * positive gain), and the backer's net payout. All exact BigInt, floored.
 *
 * @param {object} a
 * @param {bigint|string|number} a.shares           shares being redeemed
 * @param {bigint|string|number} a.backerShares     backer's total shares before this redemption
 * @param {bigint|string|number} a.costBasisAtomics backer's principal still at risk
 * @param {bigint|string|number} a.navAtomics       live vault NAV
 * @param {bigint|string|number} a.totalShares      vault total shares before this redemption
 * @param {number}               a.feeBps           performance fee in basis points
 */
export function settleRedemption({ shares, backerShares, costBasisAtomics, navAtomics, totalShares, feeBps }) {
	const s = toBig(shares);
	const bShares = toBig(backerShares);
	const basis = toBig(costBasisAtomics);
	const fee_bps = BigInt(Math.max(0, Math.min(5000, Math.round(Number(feeBps) || 0))));

	const grossPayout = payoutForShares(s, navAtomics, totalShares);
	// Cost basis attributable to exactly the redeemed slice of the backer's holding.
	const costPortion = bShares > 0n ? (basis * s) / bShares : 0n;
	const gain = grossPayout - costPortion; // signed
	const fee = gain > 0n ? (gain * fee_bps) / BPS : 0n;
	const netPayout = grossPayout - fee;
	return {
		grossPayout,
		costPortion,
		gain,
		fee,
		netPayout,
		// Remaining basis after this redemption (clamped at 0).
		remainingBasis: basis > costPortion ? basis - costPortion : 0n,
	};
}

/**
 * Largest whole number of shares redeemable RIGHT NOW given only `freeAtomics`
 * of liquid USDC on hand (the rest of NAV is in open positions). Used for honest
 * partial redemptions: we never quote an instant number we can't actually pay.
 * Returns the share count whose gross payout is ≤ freeAtomics, capped at the
 * backer's holding.
 */
export function sharesRedeemableNow({ requestedShares, navAtomics, totalShares, freeAtomics }) {
	const want = toBig(requestedShares);
	const nav = toBig(navAtomics);
	const total = toBig(totalShares);
	const free = toBig(freeAtomics);
	if (want <= 0n || total <= 0n || nav <= 0n || free <= 0n) return 0n;
	// payout(shares) = shares * nav / total ≤ free  →  shares ≤ free * total / nav
	const cap = (free * total) / nav;
	const redeemable = cap < want ? cap : want;
	return redeemable < 0n ? 0n : redeemable;
}

/**
 * Drawdown from the high-water peak, in basis points (floored). 0 when at/above
 * peak. A 25% drop from peak returns 2500.
 */
export function drawdownBps(peakNavAtomics, currentNavAtomics) {
	const peak = toBig(peakNavAtomics);
	const cur = toBig(currentNavAtomics);
	if (peak <= 0n || cur >= peak) return 0;
	const drop = ((peak - cur) * BPS) / peak;
	return Number(drop);
}

/**
 * The drawdown circuit breaker. True when the vault has fallen `maxDrawdownBps` or
 * more from its high-water peak — at which point trading must halt and remaining
 * capital be protected.
 */
export function isDrawdownBreached(peakNavAtomics, currentNavAtomics, maxDrawdownBps) {
	const max = Math.max(0, Math.round(Number(maxDrawdownBps) || 0));
	if (max <= 0) return false;
	return drawdownBps(peakNavAtomics, currentNavAtomics) >= max;
}

/** Per-backer cap check: would this deposit push the backer over their cap? */
export function depositExceedsCap(currentContribAtomics, depositAtomics, capAtomics) {
	if (capAtomics == null) return false;
	const cap = toBig(capAtomics);
	if (cap <= 0n) return false;
	return toBig(currentContribAtomics) + toBig(depositAtomics) > cap;
}

/** Per-trade size check: is this buy larger than the vault's per-trade ceiling? */
export function tradeExceedsPerTrade(amountAtomics, maxPerTradeAtomics) {
	const cap = toBig(maxPerTradeAtomics);
	if (cap <= 0n) return false;
	return toBig(amountAtomics) > cap;
}

/** Rolling daily-budget check: would this buy push 24h spend over the budget? */
export function tradeExceedsDailyBudget(spentAtomics, amountAtomics, dailyBudgetAtomics) {
	const budget = toBig(dailyBudgetAtomics);
	if (budget <= 0n) return false;
	return toBig(spentAtomics) + toBig(amountAtomics) > budget;
}

/**
 * Roll the high-water peak forward. The peak only ever rises (it's the reference
 * the drawdown breaker measures against), so a new NAV that exceeds it becomes the
 * new peak; otherwise the peak is unchanged.
 */
export function nextPeak(peakNavAtomics, currentNavAtomics) {
	const peak = toBig(peakNavAtomics);
	const cur = toBig(currentNavAtomics);
	return cur > peak ? cur : peak;
}

/**
 * Simple, holdings-derived ROI in basis points for display: how the current share
 * price compares to par (1.0). +50% shows 5000, −20% shows −2000.
 */
export function roiBps(navAtomics, totalShares) {
	const total = toBig(totalShares);
	if (total <= 0n) return 0;
	const priceE6 = sharePriceE6(navAtomics, total);
	return Number(((priceE6 - SHARE_PRICE_SCALE) * BPS) / SHARE_PRICE_SCALE);
}
