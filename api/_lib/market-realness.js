// market-realness.js — tell a real market from a painted one.
//
// The problem an operator sees instantly but a naive bot misses: a coin with a
// big opening candle that then "stairsteps" up looks like momentum, but is often
// a chart PAINTED by a handful of wallets with no real two-sided market beneath
// it. The bot buys the green; the launcher dumps the thin float on it.
//
// Grounded in the platform's own labeled outcomes (pump_coin_outcomes joined to
// the intel observation window, ~62k coins, base win rate ~12.4% where "win" =
// pumped 3x or graduated):
//
//   ≥20 unique buyers AND ≥5 unique sellers   → 52% win   (a real two-sided market)
//   ≥3 unique sellers                          → 24% win
//   no sellers at all (us=0)                   → 15% win
//   mechanically-timed trades (entropy<0.5)    → 11% win   (a metronome, not a crowd)
//
// The single strongest, simplest tell is a genuine two-sided market: many buyers
// AND real sellers. A rising price with almost no unique buyers and no sellers is
// the painted-stairstep signature, and it barely beats a coin flip.
//
// Pure function over the intel `signals` object; no I/O. Shared by the sniper's
// scoreIntel gate and the LLM judge prompt so both "see" the same market shape.

function n(v) {
	const x = Number(v);
	return Number.isFinite(x) ? x : null;
}

/**
 * Assess how real the market under a coin is from its observation-window signals.
 * @param {object} signals  pump_coin_intel signals (buy/sell counts, unique buyers/sellers, concentration, timing)
 * @returns {{
 *   realness: number,        // 0..1, higher = more like a genuine two-sided market
 *   twoSided: boolean,       // meets the data's 52%-win two-sided bar
 *   painted: boolean,        // matches the painted-stairstep signature
 *   buyers: number|null, sellers: number|null,
 *   flags: string[],         // machine reasons
 *   read: string,            // one-line human read for a prompt / log
 * }}
 */
export function assessMarketRealness(signals) {
	const s = signals || {};
	const buyers = n(s.unique_buyers);
	const sellers = n(s.unique_sellers);
	const buyCount = n(s.buy_count) ?? 0;
	const sellCount = n(s.sell_count) ?? 0;
	const conc5 = n(s.concentration_top5);
	const entropy = n(s.timing_entropy);
	const flags = [];

	// Not enough trading to judge yet — neutral, never a false "painted" verdict on
	// a coin the observation window barely saw.
	if (buyers == null || buyCount < 5) {
		return { realness: 0.5, twoSided: false, painted: false, buyers, sellers, flags: ['insufficient_trades'], read: 'too new to read a market yet' };
	}

	// The proven bars.
	const hasRealSellers = sellers != null && sellers >= 3;
	const twoSided = buyers >= 20 && sellers != null && sellers >= 5;
	const oneSided = sellers != null && sellers <= 1;          // rising with nobody selling
	const thinCrowd = buyers < 10;
	const concentrated = conc5 != null && conc5 > 0.8;
	const mechanical = entropy != null && entropy < 0.5;

	// Painted-stairstep: a one-sided, concentrated, thin-crowd rise. Any two of the
	// three structural tells (no sellers, thin crowd, whale-held) marks it painted;
	// mechanical timing reinforces but never alone convicts.
	const structural = [oneSided, thinCrowd, concentrated].filter(Boolean).length;
	const painted = structural >= 2;

	if (twoSided) flags.push('two_sided_market');
	if (hasRealSellers && !twoSided) flags.push('has_sellers');
	if (oneSided) flags.push('one_sided_no_sellers');
	if (thinCrowd) flags.push('thin_crowd');
	if (concentrated) flags.push('whale_concentrated');
	if (mechanical) flags.push('mechanical_timing');

	// Realness score: start from the crowd size, credit real sellers, debit the
	// painted tells. Calibrated so twoSided lands high (~0.8+) and a painted
	// stairstep lands low (~0.2), matching the 52% vs ~12% win split.
	let r = 0.5;
	r += Math.min(0.25, (buyers / 40) * 0.25);                 // more buyers → more real
	if (hasRealSellers) r += 0.15;
	if (twoSided) r += 0.15;
	if (oneSided) r -= 0.2;
	if (thinCrowd) r -= 0.15;
	if (concentrated) r -= 0.15;
	if (mechanical) r -= 0.08;
	const realness = Math.max(0, Math.min(1, r));

	const read = twoSided
		? `real two-sided market: ${buyers} buyers, ${sellers} sellers`
		: painted
			? `painted rise: ${buyers} buyers, ${sellers ?? 0} sellers, top5 hold ${conc5 != null ? Math.round(conc5 * 100) + '%' : '?'}${mechanical ? ', metronomic timing' : ''}`
			: `${buyers} buyers / ${sellers ?? 0} sellers, ${buyCount} buys / ${sellCount} sells`;

	return { realness: Number(realness.toFixed(3)), twoSided, painted, buyers, sellers, flags, read };
}

export default assessMarketRealness;
