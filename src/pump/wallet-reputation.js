/**
 * pump/wallet-reputation.js
 * -------------------------
 * Pure scoring for the Smart Money Radar. No I/O — the rollup cron feeds in a
 * coin's verdict (graduated vs dud) plus each wallet's footprint on that coin,
 * and these functions produce (a) the per-coin attribution deltas folded into a
 * wallet's running record and (b) the 0..100 reputation + label derived from
 * that record. Pure so every number is unit-tested and identical everywhere.
 *
 * Outcome is deliberately first-party and unambiguous:
 *   'graduated' — the coin reached Raydium (pumpfun_graduations). A real win.
 *   'dud'       — old enough to judge and it never graduated. Effectively dead.
 * No external price oracle, no guesswork.
 */

// How soon after a coin's first-seen a buy counts as "early" (seconds).
export const EARLY_WINDOW_SEC = 180;
// A wallet that sells at least this share of what it bought, inside the window,
// is "dumping" — toxic to anyone copy-following it.
const DUMP_FRACTION = 0.5;
// Coins a wallet must have a verdict on before its score is trusted past 'fresh'.
const MIN_JUDGED = 4;

function num(v) {
	const n = Number(v);
	return Number.isFinite(n) ? n : 0;
}
function clamp(n, lo, hi) {
	return Math.max(lo, Math.min(hi, n));
}
function pct(part, whole) {
	if (!(whole > 0)) return 0;
	return Math.round((part / whole) * 1000) / 10;
}

/**
 * Per-coin, per-wallet attribution. Returns the deltas to add to the wallet's
 * running record. A wallet only earns a verdict on coins it actually BOUGHT.
 *
 * @param {object} o
 * @param {'graduated'|'dud'} o.outcome
 * @param {{buy_lamports:number, sell_lamports:number, first_seen_ts:number, is_creator:boolean}} o.wallet
 * @param {number} o.coinFirstSeenTs  unix seconds the coin was first observed
 * @param {number} [o.earlyWindowSec=EARLY_WINDOW_SEC]
 * @returns {object} delta counters (all numbers; booleans as 0/1)
 */
export function attributeCoin({ outcome, wallet, coinFirstSeenTs, earlyWindowSec = EARLY_WINDOW_SEC }) {
	const buy = num(wallet?.buy_lamports);
	const sell = num(wallet?.sell_lamports);
	const isCreator = !!wallet?.is_creator;
	const graduated = outcome === 'graduated';

	const delta = {
		coins_traded: 0,
		early_entries: 0,
		wins: 0,
		early_wins: 0,
		duds: 0,
		dumps: 0,
		creator_count: isCreator ? 1 : 0,
		creator_wins: isCreator && graduated ? 1 : 0,
		buy_volume_lamports: buy,
	};

	if (buy <= 0) return delta; // never bought → no trading verdict (creator counts still apply)

	const early = num(wallet?.first_seen_ts) - num(coinFirstSeenTs) <= earlyWindowSec;
	delta.coins_traded = 1;
	if (early) delta.early_entries = 1;
	if (graduated) {
		delta.wins = 1;
		if (early) delta.early_wins = 1;
	} else {
		delta.duds = 1;
	}
	if (sell >= buy * DUMP_FRACTION) delta.dumps = 1;
	return delta;
}

/**
 * Derive the 0..100 reputation + label from a wallet's accumulated counters.
 * Transparent so a strategy author can reason about why a wallet ranks where it
 * does. Sample size gates confidence — one lucky win is not "smart money".
 *
 * @param {object} c  accumulated counters (the wallet_reputation row)
 * @returns {{win_rate, early_win_rate, dump_rate, smart_money_score, label}}
 */
export function computeReputation(c) {
	const wins = num(c?.wins);
	const duds = num(c?.duds);
	const judged = wins + duds;
	const early_entries = num(c?.early_entries);
	const early_wins = num(c?.early_wins);
	const dumps = num(c?.dumps);
	const creator_count = num(c?.creator_count);
	const creator_wins = num(c?.creator_wins);
	const coins_traded = num(c?.coins_traded);

	const win_rate = pct(wins, judged);
	const early_win_rate = pct(early_wins, early_entries);
	const dump_rate = pct(dumps, judged);

	// Confidence ramps to full at MIN_JUDGED*3 judged coins.
	const confidence = clamp(judged / (MIN_JUDGED * 3), 0, 1);

	// Hit rate is the backbone; reward demonstrated EARLY skill (catching winners
	// before the crowd), penalise dumping on followers.
	const earlyBonus = clamp((early_win_rate - win_rate) * 0.4, 0, 20);
	const dumpPenalty = dump_rate * 0.4;
	const raw = clamp(win_rate + earlyBonus - dumpPenalty, 0, 100);
	const smart_money_score = Math.round(raw * confidence * 10) / 10;

	const label = classify({
		judged,
		coins_traded,
		win_rate,
		early_entries,
		dump_rate,
		creator_count,
		creator_wins,
		smart_money_score,
	});

	return { win_rate, early_win_rate, dump_rate, smart_money_score, label };
}

function classify(s) {
	// Serial creator whose coins never graduate — the most important wallet to
	// flag for anyone following buys.
	if (s.creator_count >= 3 && s.creator_wins === 0 && s.coins_traded >= 3) return 'rugger';
	if (s.judged < MIN_JUDGED) return 'fresh';
	if (s.dump_rate >= 60) return 'dumper';
	if (s.smart_money_score >= 70) return 'smart_money';
	// Sustained hit rate far above the market. The base good rate on pump.fun is
	// ~12%, so 35%+ over 8+ judged coins is a ~3x edge held across a real sample.
	// The old rule demanded score >= 70 (~70% win rate), which only 214 wallets
	// platform-wide ever reached, starving the Oracle's pedigree pillar of its
	// input. Validated 2026-08-09 on holdout outcomes: coins with 3+ such wallets
	// buying early were good 95% of the time vs 11% baseline.
	if (s.judged >= 8 && s.win_rate >= 35) return 'smart_money';
	// Buys early into lots of coins but rarely picks a winner: spray-and-pray.
	if (s.early_entries >= 5 && s.win_rate < 25) return 'sniper';
	return 'neutral';
}
