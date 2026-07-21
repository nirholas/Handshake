// market-realness.js — tell a real market from a painted one, calibrated to the
// platform's OWN labeled outcomes, not to intuition.
//
// The problem an operator sees instantly but a naive bot misses: a coin with a
// big opening candle that then "stairsteps" up looks like momentum, but is often
// a chart PAINTED by a handful of wallets. The bot buys the green; the launcher
// dumps the thin float on it.
//
// We derived the actual tell from pump_coin_intel joined to pump_coin_outcomes
// over the ACTIVE cohort (coins with a real formed market at entry,
// unique_buyers >= 10 — the only coins a momentum bot would ever consider).
// scripts/rug-signature.mjs reproduces this. Buying blind in that cohort wins
// 31%. The features that actually separate a winner from a rug, with their
// measured single-gate lift:
//
//   concentration_top10 < 0.90   -> 72% win   (2.30x)   whale-held float is the strongest tell
//   unique_buyers      >= 30     -> 68% win   (2.16x)   a real crowd, not a few wallets
//   snipe_ratio        < 0.50    -> 45% win   (1.44x)   NOT front-loaded into the opening candle
//   bundle_score       < 0.25    -> 43% win   (1.38x)   not a coordinated launch
//   unique_sellers     >= 5      -> 32% win   (1.03x)   near-useless: a two-sided market barely helps
//
// Combined (buyers>=30 AND snipe<0.5 AND conc<0.9) -> 75% win, 2.4x lift, still
// keeps 13% of the active flow. So the honeypot signature the owner described is,
// precisely: a FRONT-LOADED opening candle (high snipe_ratio) on a WHALE-HELD
// float (high concentration) with a THIN real crowd (few unique buyers). Seller
// presence, which earlier hand-tuned versions leaned on, is not the tell.
//
// Pure function over the intel `signals` object; no I/O. Shared by the sniper's
// scoreIntel gate and the LLM judge prompt so both "see" the same market shape.

function n(v) {
	const x = Number(v);
	return Number.isFinite(x) ? x : null;
}

// Thresholds are the winner/rug medians from the active-cohort analysis, chosen
// where the two distributions cross. Tightening these trades coverage for win
// rate; they are the measured crossover, not round numbers.
const T = {
	crowdReal: 30,        // unique_buyers at/above this looks like a real crowd (winner median 34)
	crowdThin: 20,        // below this the "crowd" is suspiciously small (rug median 15)
	snipeHot: 0.6,        // snipe_ratio at/above this is a front-loaded opening candle (rug median 0.74)
	concWhale: 0.95,      // top-10 hold at/above this is a whale-held float (rug median 1.00)
	bundleHot: 0.3,       // bundle_score at/above this is a coordinated launch (rug median 0.31)
};

/**
 * Assess how real the market under a coin is from its observation-window signals.
 * @param {object} signals  pump_coin_intel signals (buyers, snipe_ratio, concentration_top10, bundle_score, ...)
 * @returns {{
 *   realness: number,        // 0..1, higher = more like a genuine coin, lower = more like a painted rug
 *   twoSided: boolean,       // has a real two-sided market (kept for the require_two_sided_market gate)
 *   painted: boolean,        // matches the data-derived honeypot signature
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
	// concentration_top10 is the proven column; fall back to top5 if only that is present.
	const conc = n(s.concentration_top10) ?? n(s.concentration_top5);
	const snipe = n(s.snipe_ratio);
	const bundle = n(s.bundle_score);
	const flags = [];

	// Not enough trading to judge yet — neutral, never a false "painted" verdict on
	// a coin the observation window barely saw.
	if (buyers == null || buyCount < 5) {
		return { realness: 0.5, twoSided: false, painted: false, buyers, sellers, flags: ['insufficient_trades'], read: 'too new to read a market yet' };
	}

	// The proven structural tells of a painted honeypot.
	const frontLoaded = snipe != null && snipe >= T.snipeHot;     // opening-candle spike, then nothing
	const whaleHeld = conc != null && conc >= T.concWhale;        // ~all of the float in ~10 wallets
	const thinCrowd = buyers < T.crowdThin;                       // no real buyer base under the rise
	const bundled = bundle != null && bundle >= T.bundleHot;      // coordinated launch wallets
	const realCrowd = buyers >= T.crowdReal;
	// two-sided is a weak signal (1.03x) — kept only for the explicit strategy gate.
	const twoSided = buyers >= 20 && sellers != null && sellers >= 5;

	// Painted-stairstep: any two of the three PROVEN structural tells. Bundling
	// reinforces but, like the old mechanical-timing tell, never convicts alone.
	const structural = [frontLoaded, whaleHeld, thinCrowd].filter(Boolean).length;
	const painted = structural >= 2;

	if (frontLoaded) flags.push('front_loaded_candle');
	if (whaleHeld) flags.push('whale_held_float');
	if (thinCrowd) flags.push('thin_crowd');
	if (bundled) flags.push('coordinated_launch');
	if (realCrowd) flags.push('real_crowd');
	if (twoSided) flags.push('two_sided_market');

	// Realness score: center at 0.5, move by the PROVEN features weighted by their
	// measured lift. Calibrated so a winner-median coin (buyers 34, snipe 0.47,
	// conc 0.90, bundle 0.19) lands ~0.56 (above center, "real market") and a
	// rug-median coin (buyers 15, snipe 0.74, conc 1.00, bundle 0.31) floors at
	// 0.0 ("painted rise"), matching the 75% vs 31% active-cohort win split.
	let r = 0.5;
	// crowd size: strongest continuous signal, moved around the 30-buyer crossover.
	if (buyers != null) r += Math.max(-0.22, Math.min(0.22, (buyers - T.crowdReal) / 60));
	// front-loading: penalize an opening-candle-heavy tape above the 0.5 crossover.
	if (snipe != null) r -= Math.max(0, Math.min(0.22, (snipe - 0.5) * 0.6));
	// whale concentration: penalize a float held by a handful of wallets.
	if (conc != null) r -= Math.max(0, Math.min(0.2, (conc - 0.85) * 1.2));
	// coordinated launch: smaller debit.
	if (bundle != null) r -= Math.max(0, Math.min(0.12, (bundle - 0.2) * 0.4));
	// tiny credit for a genuine two-sided market (weak but real).
	if (twoSided) r += 0.05;
	const realness = Math.max(0, Math.min(1, r));

	const pct = (x) => (x != null ? Math.round(x * 100) + '%' : '?');
	const read = painted
		? `painted rise: ${buyers} buyers, snipe ${pct(snipe)}, top10 hold ${pct(conc)}${bundled ? ', bundled' : ''}`
		: realCrowd && !frontLoaded && !whaleHeld
			? `real market: ${buyers} buyers, snipe ${pct(snipe)}, top10 hold ${pct(conc)}`
			: `${buyers} buyers / ${sellers ?? 0} sellers, snipe ${pct(snipe)}, top10 ${pct(conc)}`;

	return { realness: Number(realness.toFixed(3)), twoSided, painted, buyers, sellers, flags, read };
}

export default assessMarketRealness;
