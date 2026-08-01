/**
 * Exit Lab: counterfactual replay of REAL closed positions under a different
 * exit policy.
 *
 * What this is, and why it is not the backtester
 * ----------------------------------------------
 * `api/_lib/strategy-backtest.js` answers "would this strategy have entered
 * profitably?" by replaying hypothetical entries over captured launch intel. It
 * models exits with `decideExit`, the single-shot decider, and it never sees a
 * position the fleet actually opened.
 *
 * This module answers the opposite, and much sharper, question: **the fleet
 * already spent this SOL. Were the exits right?** It takes positions that were
 * genuinely entered and closed on-chain and re-runs each one through
 * `decideLadderedExit` (the SAME function the live position loop calls) with a
 * different set of exit parameters, mirroring the live partial-sell bookkeeping
 * leg for leg. Nothing here is synthesized: every input is a recorded price
 * point from a position that cost real money.
 *
 * The price path we actually have
 * -------------------------------
 * A closed position records three honest points and a duration:
 *
 *   entry_quote_lamports  the SOL spent (cost basis)
 *   peak_value_lamports   the high-water mark of the bag's quoted SOL value
 *   last_value_lamports   the bag's quoted value at the moment the exit fired
 *   opened_at → closed_at how long it was held
 *
 * The replay walks 1x → peak → terminal. That is a real path, not a synthetic
 * one, but it is truncated at the point the actual policy sold. So:
 *
 *   - A counterfactual that exits EARLIER than the live policy did is fully
 *     determined by the recorded path. Those results are exact.
 *   - A counterfactual that would have HELD LONGER runs out of observations at
 *     the terminal price. Its result is a LOWER BOUND, never an upper one.
 *
 * `replayFleet` reports how many trades fall in each bucket so a reader can
 * weigh the answer instead of trusting a single number. Overstating a
 * counterfactual is the whole failure mode of a tool like this, and the bound
 * direction is stated rather than buried.
 *
 * Which positions are replayable
 * ------------------------------
 * A position whose initials were already taken has had its `entry_quote_lamports`
 * scaled down and its `peak_value_lamports` reset to the remaining bag (see the
 * partial-sell branch in workers/agent-sniper/executor.js). Its recorded points
 * are therefore bag-relative and the original price path cannot be recovered.
 * Those positions are EXCLUDED with a stated reason rather than replayed against
 * numbers that no longer mean what they look like.
 *
 * Pure: no I/O, no clock, no Node built-ins. Imported by both the API handler
 * and the browser console at /exit-lab, so the two can never disagree about what
 * a parameter set is worth.
 */

import { decideLadderedExit, moonbagFraction, ladderMultiple, pct } from '../../workers/agent-sniper/exit-logic.js';

export const LAMPORTS_PER_SOL = 1_000_000_000;

/** The live fleet defaults, as shipped in the strategy schema. */
export const DEFAULT_PARAMS = Object.freeze({
	stopLossPct: 35,
	trailingStopPct: 25,
	takeProfitPct: null,
	initialsOutMultiple: 2,
	moonbagMinPct: 15,
});

/**
 * The tunable surface, as data. The console builds its controls from this and
 * the sweep builds its grid from it, so a new knob is added in exactly one place.
 *
 * `nullable: true` means "off" is a legal value and is expressed as null, not 0
 * (see the `pct` contract in exit-logic.js: 0 would fire immediately).
 */
export const PARAM_SPECS = Object.freeze([
	{
		key: 'stopLossPct',
		label: 'Hard stop-loss',
		unit: '%',
		min: 5,
		max: 90,
		step: 5,
		nullable: true,
		help: 'Sell everything once the position is this far below cost. It outranks every other rule, so it is the one number that caps a loss. Off means a losing bag rides to the timeout.',
	},
	{
		key: 'trailingStopPct',
		label: 'Trailing stop',
		unit: '%',
		min: 5,
		max: 90,
		step: 5,
		nullable: true,
		help: 'Sell after the price falls this far from its high-water mark. It only arms once the position has been green, so it protects a gain and never converts a dip into a locked loss.',
	},
	{
		key: 'takeProfitPct',
		label: 'Take-profit ceiling',
		unit: '%',
		min: 25,
		max: 1000,
		step: 25,
		nullable: true,
		help: 'A hard ceiling that closes the remainder once the position is this far up. With the ladder armed it only applies after the initials are already out, so it can never pre-empt the ladder.',
	},
	{
		key: 'initialsOutMultiple',
		label: 'Take initials at',
		unit: 'x',
		min: 1.25,
		max: 10,
		step: 0.25,
		nullable: true,
		help: 'The multiple at which the stake comes back off the table. At 2x that is a half sell; at 5x a fifth. Fires once per position. Off means no ladder and the classic all-or-nothing exit.',
	},
	{
		key: 'moonbagMinPct',
		label: 'Moon-bag floor',
		unit: '%',
		min: 0,
		max: 90,
		step: 5,
		nullable: false,
		help: 'The share of the bag that always keeps riding on a profitable exit. This is why a winner is never fully sold: once the cost is recovered the remainder is free, and a free bag that runs is the whole point.',
	},
]);

const REASONS = Object.freeze([
	'take_initials',
	'take_profit',
	'trailing_stop',
	'stop_loss',
	'timeout',
]);

/** Every exit reason the replay can emit, for stable chart ordering. */
export function exitReasons() {
	return REASONS.slice();
}

function num(v) {
	if (v == null || v === '') return null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}

/**
 * Normalize a raw payload into the parameter shape the replay consumes.
 * Out-of-range values are clamped to the spec rather than rejected, so a URL a
 * user hand-edited degrades to the nearest legal policy instead of a stack trace.
 */
export function normalizeParams(raw) {
	const src = raw && typeof raw === 'object' ? raw : {};
	const out = {};
	for (const spec of PARAM_SPECS) {
		const v = num(src[spec.key]);
		if (v == null) {
			out[spec.key] = spec.nullable ? null : DEFAULT_PARAMS[spec.key];
			continue;
		}
		out[spec.key] = Math.min(spec.max, Math.max(spec.min, v));
	}
	return out;
}

/** True when two parameter sets describe the same policy. */
export function sameParams(a, b) {
	const x = normalizeParams(a);
	const y = normalizeParams(b);
	return PARAM_SPECS.every((s) => x[s.key] === y[s.key]);
}

/**
 * Build the position-like object `decideLadderedExit` reads. The field names are
 * the live column names on purpose: this is fed to production code unchanged.
 */
function posLike(params, entryRemaining, recovered) {
	return {
		entry_quote_lamports: String(Math.max(0, Math.round(entryRemaining))),
		stop_loss_pct: params.stopLossPct,
		trailing_stop_pct: params.trailingStopPct,
		take_profit_pct: params.takeProfitPct,
		initials_out_multiple: params.initialsOutMultiple,
		moonbag_min_pct: params.moonbagMinPct,
		initials_recovered: recovered,
		moonbag_always: true,
		max_hold_seconds: null,
		opened_at: 0,
	};
}

// A replay can never produce more legs than this. The ladder fires once and the
// terminal exit closes the walk, so 6 is already generous; the cap exists so a
// pathological parameter set cannot spin.
const MAX_LEGS = 6;

/**
 * Replay one real closed position under an alternative exit policy.
 *
 * @param {{entryLamports: number, peakLamports: number, terminalLamports: number,
 *          holdSeconds?: number, actualPnlLamports?: number|null,
 *          mint?: string, symbol?: string}} trade
 * @param {object} params exit policy (see PARAM_SPECS)
 * @returns {{ok: boolean, skip?: string, legs: Array, realizedLamports: number,
 *            openValueLamports: number, totalLamports: number,
 *            pnlLamports: number, pnlPct: number, exitReason: string|null,
 *            keptMoonbag: boolean, bounded: boolean}}
 *   `bounded` is true when the counterfactual was still holding at the end of the
 *   recorded path, i.e. the result is a lower bound on what it could have made.
 */
export function replayPosition(trade, params) {
	const p = normalizeParams(params);
	const entry0 = num(trade?.entryLamports);
	const peakAbs = num(trade?.peakLamports);
	const termAbs = num(trade?.terminalLamports);
	if (!(entry0 > 0)) return skipped('no_entry_basis');
	if (peakAbs == null || termAbs == null) return skipped('no_price_path');

	// The peak is a high-water mark, so it can never be below the terminal price
	// or below cost. A row that says otherwise was written by a sweep that raced
	// the exit; clamp rather than replay a path that never existed.
	const peakMult = Math.max(1, peakAbs / entry0, termAbs / entry0);
	const termMult = Math.max(0, termAbs / entry0);

	const moonbag = moonbagFraction(p.moonbagMinPct);
	const ladder = ladderMultiple(p.initialsOutMultiple);
	const tp = pct(p.takeProfitPct);
	const sl = pct(p.stopLossPct);
	const ts = pct(p.trailingStopPct);

	let bag = 1; // fraction of the originally-bought tokens still held
	let entryRemaining = entry0; // our money still at risk
	let peakRef = entry0; // high-water of the CURRENT bag's value (live semantics)
	let recovered = false;
	let realized = 0;
	let m = 1; // current price multiple relative to the original entry
	const legs = [];

	const valueAt = (mult) => entry0 * mult * bag;

	// Book one sell leg, mirroring the live partial-sell bookkeeping exactly
	// (executor.js: scale the basis by the sold fraction, reset the high-water to
	// the remaining bag, flag initials recovered).
	const sell = (mult, reason, fraction, recoversInitials) => {
		const f = Math.max(0, Math.min(1, fraction));
		if (!(f > 0)) return false;
		const value = valueAt(mult);
		const proceeds = value * f;
		const soldBasis = entryRemaining * f;
		realized += proceeds;
		entryRemaining -= soldBasis;
		bag *= 1 - f;
		if (recoversInitials) recovered = true;
		peakRef = valueAt(mult);
		legs.push({
			atMultiple: round(mult, 4),
			reason,
			sellFraction: round(f, 4),
			proceedsLamports: Math.round(proceeds),
			pnlLamports: Math.round(proceeds - soldBasis),
		});
		return bag <= 1e-9;
	};

	// ── Rising phase: 1x up to the recorded peak. Only take-initials and the
	// take-profit ceiling can fire while price climbs; both are monotone in
	// price, so the next event is whichever triggers at the lower multiple.
	for (let i = 0; i < MAX_LEGS; i += 1) {
		if (bag <= 1e-9) break;
		const candidates = [];
		if (ladder != null && !recovered) candidates.push(triggerMult(entryRemaining * ladder, entry0, bag));
		if (tp != null && (recovered || ladder == null)) {
			candidates.push(triggerMult(entryRemaining * (1 + tp / 100), entry0, bag));
		}
		const next = candidates.filter((c) => c != null && c > m + 1e-12 && c <= peakMult).sort((a, b) => a - b)[0];
		if (next == null) break;
		const decision = decideLadderedExit(posLike(p, entryRemaining, recovered), valueAt(next), Math.max(peakRef, valueAt(next)), 0, null);
		if (!decision) break;
		m = next;
		if (sell(m, decision.reason, decision.sellFraction, decision.recoversInitials === true)) break;
	}

	// The bag rode to the peak; that is its high-water mark for the descent.
	if (bag > 1e-9) {
		peakRef = Math.max(peakRef, valueAt(peakMult));
		m = peakMult;
	}

	// ── Falling phase: peak down to the terminal price. Whichever protective
	// trigger sits HIGHEST is the one hit first on the way down.
	let exitReason = null;
	let keptMoonbag = false;
	let bounded = false;
	if (bag > 1e-9) {
		const down = [];
		if (sl != null) down.push(triggerMult(entryRemaining * (1 - sl / 100), entry0, bag));
		if (ts != null && peakRef > entryRemaining) down.push(triggerMult(peakRef * (1 - ts / 100), entry0, bag));
		const hit = down.filter((c) => c != null && c <= peakMult + 1e-12 && c >= termMult - 1e-12).sort((a, b) => b - a)[0];
		const at = hit == null ? termMult : hit;
		const decision = decideLadderedExit(posLike(p, entryRemaining, recovered), valueAt(at), peakRef, 0, null);
		if (decision) {
			exitReason = decision.reason;
			m = at;
			const emptied = sell(at, decision.reason, decision.sellFraction, decision.recoversInitials === true);
			keptMoonbag = !emptied && bag > 1e-9;
		} else {
			// Nothing fired anywhere on the recorded path: this policy was still
			// holding when the observations ran out.
			exitReason = 'timeout';
			bounded = true;
			m = termMult;
		}
	}

	// Whatever still rides is valued at the last price we actually observed.
	const openValue = bag > 1e-9 ? entry0 * termMult * bag : 0;
	if (bag > 1e-9) bounded = true;

	const total = realized + openValue;
	return {
		ok: true,
		legs,
		realizedLamports: Math.round(realized),
		openValueLamports: Math.round(openValue),
		totalLamports: Math.round(total),
		pnlLamports: Math.round(total - entry0),
		pnlPct: round(((total - entry0) / entry0) * 100, 2),
		exitReason: exitReason ?? (legs.length ? legs[legs.length - 1].reason : null),
		keptMoonbag,
		bounded,
		peakMultiple: round(peakMult, 3),
		terminalMultiple: round(termMult, 3),
	};
}

/** The price multiple at which a bag of `bag` size is worth `targetValue`. */
function triggerMult(targetValue, entry0, bag) {
	if (!(bag > 0) || !(entry0 > 0)) return null;
	const m = targetValue / (entry0 * bag);
	return Number.isFinite(m) ? Math.max(0, m) : null;
}

function skipped(reason) {
	return {
		ok: false,
		skip: reason,
		legs: [],
		realizedLamports: 0,
		openValueLamports: 0,
		totalLamports: 0,
		pnlLamports: 0,
		pnlPct: 0,
		exitReason: null,
		keptMoonbag: false,
		bounded: false,
	};
}

function round(n, places) {
	const f = 10 ** places;
	return Math.round(n * f) / f;
}

/**
 * Replay a whole corpus and aggregate it.
 *
 * @param {Array<object>} trades replayable trades from /api/sniper/exit-lab
 * @param {object} params exit policy
 * @returns {object} aggregate metrics plus the per-trade rows
 */
export function replayFleet(trades, params) {
	const rows = [];
	let staked = 0;
	let total = 0;
	let wins = 0;
	let losses = 0;
	let boundedCount = 0;
	let ridingCount = 0;
	let skipped = 0;
	const byReason = Object.create(null);
	for (const r of REASONS) byReason[r] = { trades: 0, pnlLamports: 0 };

	const list = Array.isArray(trades) ? trades : [];
	for (const t of list) {
		const res = replayPosition(t, params);
		if (!res.ok) {
			skipped += 1;
			continue;
		}
		const entry = Number(t.entryLamports);
		staked += entry;
		total += res.totalLamports;
		if (res.pnlLamports > 0) wins += 1;
		else if (res.pnlLamports < 0) losses += 1;
		if (res.bounded) boundedCount += 1;
		if (res.keptMoonbag) ridingCount += 1;
		if (res.exitReason && byReason[res.exitReason]) {
			byReason[res.exitReason].trades += 1;
			byReason[res.exitReason].pnlLamports += res.pnlLamports;
		}
		rows.push({
			mint: t.mint,
			symbol: t.symbol,
			agentName: t.agentName,
			agentId: t.agentId,
			entryLamports: entry,
			peakMultiple: res.peakMultiple,
			terminalMultiple: res.terminalMultiple,
			actualPnlLamports: t.actualPnlLamports ?? null,
			actualReason: t.actualReason ?? null,
			pnlLamports: res.pnlLamports,
			pnlPct: res.pnlPct,
			exitReason: res.exitReason,
			keptMoonbag: res.keptMoonbag,
			bounded: res.bounded,
			legs: res.legs,
		});
	}

	const counted = rows.length;
	const pnl = total - staked;
	// Equity curve in trade order, for the drawdown read and the sparkline.
	let equity = 0;
	let peak = 0;
	let maxDrawdown = 0;
	const curve = [];
	for (const row of rows) {
		equity += row.pnlLamports;
		curve.push(Math.round(equity));
		if (equity > peak) peak = equity;
		const drop = peak - equity;
		if (drop > maxDrawdown) maxDrawdown = drop;
	}

	// The actual policy's result over the SAME corpus, so the delta is apples to
	// apples. A row whose realized P&L was never booked (an unreconcilable exit)
	// is left out of the actual total rather than counted as zero.
	let actualPnl = 0;
	let actualKnown = 0;
	for (const row of rows) {
		if (row.actualPnlLamports == null) continue;
		actualPnl += Number(row.actualPnlLamports);
		actualKnown += 1;
	}

	return {
		trades: counted,
		skipped,
		wins,
		losses,
		winRate: counted ? round((wins / counted) * 100, 1) : 0,
		stakedLamports: Math.round(staked),
		pnlLamports: Math.round(pnl),
		roiPct: staked > 0 ? round((pnl / staked) * 100, 2) : 0,
		maxDrawdownLamports: Math.round(maxDrawdown),
		boundedTrades: boundedCount,
		ridingTrades: ridingCount,
		byReason,
		curve,
		actual: {
			pnlLamports: Math.round(actualPnl),
			knownTrades: actualKnown,
			roiPct: staked > 0 ? round((actualPnl / staked) * 100, 2) : 0,
		},
		deltaLamports: Math.round(pnl - actualPnl),
		rows,
	};
}

/**
 * Search the parameter space for the policy that would have done best over the
 * recorded corpus, and return the ranked leaders.
 *
 * This is a full grid, not a heuristic: the space is small enough to enumerate
 * exactly, and an exact answer over 200 real trades beats a clever answer nobody
 * can reproduce. The caller supplies the axes, so the console can sweep two
 * knobs finely or all five coarsely without a second implementation.
 *
 * A grid result is an in-sample optimum over the trades that happened. That is
 * a real finding about the fleet's past, not a promise about its future, and
 * `overfitRisk` flags the case where the corpus is too thin to lean on.
 *
 * @param {Array<object>} trades
 * @param {Record<string, Array<number|null>>} axes parameter key → values to try
 * @param {{limit?: number, baseline?: object}} [opts]
 * @returns {{combos: number, leaders: Array, baseline: object, overfitRisk: boolean}}
 */
export function sweepParams(trades, axes, { limit = 8, baseline = DEFAULT_PARAMS } = {}) {
	const keys = Object.keys(axes || {}).filter((k) => PARAM_SPECS.some((s) => s.key === k));
	const grids = keys.map((k) => (Array.isArray(axes[k]) && axes[k].length ? axes[k] : [DEFAULT_PARAMS[k]]));
	const combos = grids.reduce((acc, g) => acc * g.length, 1);

	const base = replayFleet(trades, baseline);
	const results = [];
	const idx = new Array(keys.length).fill(0);
	for (let n = 0; n < combos; n += 1) {
		const params = { ...normalizeParams(baseline) };
		for (let k = 0; k < keys.length; k += 1) params[keys[k]] = grids[k][idx[k]];
		const r = replayFleet(trades, params);
		results.push({
			params,
			pnlLamports: r.pnlLamports,
			roiPct: r.roiPct,
			winRate: r.winRate,
			maxDrawdownLamports: r.maxDrawdownLamports,
			boundedTrades: r.boundedTrades,
			deltaLamports: r.pnlLamports - base.actual.pnlLamports,
		});
		// odometer increment
		for (let k = keys.length - 1; k >= 0; k -= 1) {
			idx[k] += 1;
			if (idx[k] < grids[k].length) break;
			idx[k] = 0;
		}
	}

	results.sort((a, b) => b.pnlLamports - a.pnlLamports || a.maxDrawdownLamports - b.maxDrawdownLamports);
	return {
		combos,
		leaders: results.slice(0, Math.max(1, limit)),
		baseline: {
			params: normalizeParams(baseline),
			pnlLamports: base.pnlLamports,
			roiPct: base.roiPct,
			winRate: base.winRate,
			maxDrawdownLamports: base.maxDrawdownLamports,
		},
		actual: base.actual,
		// Under ~30 closed trades a grid this size will find a flattering corner
		// of noise. Say so rather than let a leader row read as a recommendation.
		overfitRisk: base.trades < 30,
	};
}

/** SOL from lamports, for display. */
export function toSol(lamports) {
	const n = Number(lamports);
	return Number.isFinite(n) ? n / LAMPORTS_PER_SOL : 0;
}
