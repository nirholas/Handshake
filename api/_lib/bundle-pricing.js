/**
 * Bundle pricing math, as pure functions.
 *
 * "What should I charge for this bundle?" is the question that stops a seller
 * from ever publishing one. The usual answer is a percentage off the sum of the
 * parts, which is a guess dressed as advice. A better answer is already sitting
 * in the agent's own ledger: some buyers bought two or three of these skills
 * separately, and what they actually paid is real evidence of what the
 * combination is worth to the population that would buy it.
 *
 * These functions take that history and a candidate price and answer two things
 * a seller can act on: what the bundle would have collected from the same people,
 * and how many of them would have come out ahead. Kept separate from the handler
 * so the arithmetic is testable without a database, which matters because the
 * evidence path cannot be exercised against production yet: the marketplace has
 * no multi-skill basket at all, precisely because bundles were unreachable.
 *
 * Amounts are ATOMIC integers throughout (the currency's smallest unit). Mixing
 * atomic and whole-token numbers is the classic way to publish a price 10^6 off,
 * so nothing here ever divides by decimals; formatting is the caller's job.
 *
 * Every amount is carried as a BigInt, and every amount that leaves this module
 * leaves as a decimal string. A 9-decimal mint puts real balances past
 * Number.MAX_SAFE_INTEGER (9007199254740991 atomic units is about 9,007,199
 * whole tokens), and the sums here are larger than the individual amounts. Doing
 * the arithmetic in Number and stringifying the result afterwards looks safe and
 * is not: the rounding has already happened by then. The database agrees, which
 * is why api/agents/[id]/bundles.js casts every SUM to ::text.
 */

/** Discount below this reads as a rounding artifact rather than an offer. */
export const MIN_MEANINGFUL_DISCOUNT_PERCENT = 1;

/**
 * Fallback discount when there is no history to learn from, as an exact ratio.
 * The float below is derived from these two so the two spellings cannot drift.
 */
export const DEFAULT_DISCOUNT_NUMERATOR = 8n;
export const DEFAULT_DISCOUNT_DENOMINATOR = 10n;

/** Fallback discount when there is no history to learn from. */
export const DEFAULT_DISCOUNT = Number(DEFAULT_DISCOUNT_NUMERATOR) / Number(DEFAULT_DISCOUNT_DENOMINATOR);

/**
 * Coerce one atomic amount to a BigInt.
 *
 * Accepts a BigInt, a decimal string, or a Number that is an exact integer. A
 * Number past Number.MAX_SAFE_INTEGER THROWS rather than converting, because by
 * the time such a value reaches here it has already been rounded and no
 * downstream string can recover the lost digits. Callers reading money out of
 * the database pass the ::text column, not Number(column).
 *
 * @param {bigint|number|string} v
 * @returns {bigint}
 */
export function toAtomic(v) {
	if (typeof v === 'bigint') return v;
	if (typeof v === 'number') {
		if (!Number.isSafeInteger(v))
			throw new TypeError(`atomic amount ${v} is not an exact integer; pass a string or a BigInt`);
		return BigInt(v);
	}
	if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return BigInt(v.trim());
	throw new TypeError(`atomic amount ${JSON.stringify(v)} is not an integer`);
}

/** Half-up division that stays exact: no float ever touches the amount. */
function divRoundHalfUp(numerator, denominator) {
	return (numerator + denominator / 2n) / denominator;
}

/**
 * Median of an integer list, rounded to an integer so it stays a spendable price.
 * @param {(bigint|number|string)[]} sorted ascending
 * @returns {bigint|null} null for an empty list
 */
export function median(sorted) {
	const n = sorted.length;
	if (!n) return null;
	if (n % 2) return toAtomic(sorted[(n - 1) / 2]);
	return divRoundHalfUp(toAtomic(sorted[n / 2 - 1]) + toAtomic(sorted[n / 2]), 2n);
}

/**
 * A percentage to one decimal place, computed without floats.
 *
 * The obvious `Number(part) / Number(total)` reintroduces exactly the precision
 * loss the rest of this module exists to avoid, so the ratio is scaled to tenths
 * of a percent in BigInt and only then converted. Sign is carried separately so
 * a price above the sum of the parts rounds the same way a discount does.
 */
function percentToOneDecimal(part, total) {
	if (total === 0n) return 0;
	const negative = part < 0n !== total < 0n;
	const abs = (v) => (v < 0n ? -v : v);
	const tenths = divRoundHalfUp(abs(part) * 1000n, abs(total));
	const value = Number(tenths) / 10;
	return negative ? -value : value;
}

/**
 * Backtest one candidate price against the real baskets.
 *
 * @param {bigint|number|string} price          candidate bundle price, atomic
 * @param {bigint|number|string} sumOfParts     list price of every bundled skill added up, atomic
 * @param {(bigint|number|string)[]} basketTotals what each multi-skill buyer actually paid, atomic
 * @returns {{price:string, discount_atomic:string, discount_percent:number,
 *   backtest_revenue_atomic:string, revenue_delta_atomic:string, buyers_better_off:number}}
 */
export function simulatePrice(price, sumOfParts, basketTotals) {
	const p = toAtomic(price);
	const sum = toAtomic(sumOfParts);
	const totals = basketTotals.map(toAtomic);
	const historicalRevenue = totals.reduce((acc, n) => acc + n, 0n);
	const bundleRevenue = p * BigInt(totals.length);
	return {
		// Every atomic amount leaves as a string, matching the columns the handler
		// returns alongside them (list_amount, gross_atomic, revenue_atomic). A
		// client that needs arithmetic uses BigInt, as pages/bundles.html does.
		price: String(p),
		discount_atomic: String(sum - p),
		// One decimal place: a seller reads "17.5% off", not "17.4832%".
		discount_percent: percentToOneDecimal(sum - p, sum),
		backtest_revenue_atomic: String(bundleRevenue),
		revenue_delta_atomic: String(bundleRevenue - historicalRevenue),
		// Buyers who spent MORE than this price buying the skills piecemeal: the
		// ones the bundle would have won on value, and the likeliest converts.
		buyers_better_off: totals.filter((total) => total > p).length,
	};
}

/**
 * Suggest a price, and say what the suggestion is based on.
 *
 * With real multi-skill history, anchor on the median basket: a price that
 * population has already demonstrated it will pay. Without it there is nothing to
 * learn from, so fall back to a flat discount off list and label the basis
 * `discount_off_list`, so a seller with no sales is never shown a default dressed
 * up as a finding.
 *
 * The median is capped at the sum of the parts. A bundle costing more than buying
 * the same skills one at a time is not a bundle.
 *
 * @param {bigint|number|string} sumOfParts     atomic
 * @param {(bigint|number|string)[]} basketTotals atomic, any order
 * @returns {{price:bigint, basis:'median_basket'|'discount_off_list', median_basket:bigint|null}}
 */
export function suggestPrice(sumOfParts, basketTotals) {
	const sum = toAtomic(sumOfParts);
	// Sorted with a comparator that returns a Number, because Array#sort demands
	// one; the compared values stay BigInt, so no amount is ever narrowed.
	const sorted = basketTotals.map(toAtomic).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
	const medianBasket = median(sorted);
	if (medianBasket !== null) {
		return {
			price: medianBasket < sum ? medianBasket : sum,
			basis: 'median_basket',
			median_basket: medianBasket,
		};
	}
	// Never suggest 0: a free bundle is a giveaway, not a price.
	const discounted = divRoundHalfUp(sum * DEFAULT_DISCOUNT_NUMERATOR, DEFAULT_DISCOUNT_DENOMINATOR);
	return {
		price: discounted < 1n ? 1n : discounted,
		basis: 'discount_off_list',
		median_basket: null,
	};
}
