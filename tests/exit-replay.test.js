// Exit Lab replay kernel.
//
// These pin the properties that make the tool trustworthy rather than merely
// plausible: a replay must never invent value the recorded path did not contain,
// a bounded (still-holding) result must be flagged as a lower bound, and a
// laddered policy must never sell the last of a winner.

import { describe, it, expect } from 'vitest';
import {
	replayPosition,
	replayFleet,
	sweepParams,
	normalizeParams,
	sameParams,
	exitReasons,
	toSol,
	PARAM_SPECS,
	DEFAULT_PARAMS,
	LAMPORTS_PER_SOL,
} from '../api/_lib/exit-replay.js';

const SOL = LAMPORTS_PER_SOL;

/** A position that 3x'd and came back to 1.2x. */
const winner = {
	mint: 'THREEsynthetic1111111111111111111111111111',
	symbol: 'WIN',
	entryLamports: 0.02 * SOL,
	peakLamports: 0.06 * SOL,
	terminalLamports: 0.024 * SOL,
	actualPnlLamports: 0.001 * SOL,
	actualReason: 'trailing_stop',
};

/** A position that never went green and bled out. */
const loser = {
	mint: 'THREEsynthetic2222222222222222222222222222',
	symbol: 'LOSS',
	entryLamports: 0.02 * SOL,
	peakLamports: 0.02 * SOL,
	terminalLamports: 0.01 * SOL,
	actualPnlLamports: -0.01 * SOL,
	actualReason: 'timeout',
};

describe('normalizeParams', () => {
	it('clamps an out-of-range value to the spec instead of throwing', () => {
		const p = normalizeParams({ stopLossPct: 9999, moonbagMinPct: -50 });
		const sl = PARAM_SPECS.find((s) => s.key === 'stopLossPct');
		const mb = PARAM_SPECS.find((s) => s.key === 'moonbagMinPct');
		expect(p.stopLossPct).toBe(sl.max);
		expect(p.moonbagMinPct).toBe(mb.min);
	});

	it('reads a missing nullable knob as off, not as zero', () => {
		// Number(null) === 0 and a 0% stop-loss fires immediately, so this
		// distinction is the difference between "no stop" and "sell everything".
		expect(normalizeParams({}).takeProfitPct).toBeNull();
		expect(normalizeParams({}).stopLossPct).toBeNull();
	});

	it('falls back to the live default for a non-nullable knob', () => {
		expect(normalizeParams({}).moonbagMinPct).toBe(DEFAULT_PARAMS.moonbagMinPct);
	});

	it('treats an unparseable value as absent rather than NaN', () => {
		expect(normalizeParams({ stopLossPct: 'banana' }).stopLossPct).toBeNull();
	});

	it('compares policies by value', () => {
		expect(sameParams(DEFAULT_PARAMS, { ...DEFAULT_PARAMS })).toBe(true);
		expect(sameParams(DEFAULT_PARAMS, { ...DEFAULT_PARAMS, stopLossPct: 10 })).toBe(false);
	});
});

describe('replayPosition', () => {
	it('refuses a position with no cost basis instead of returning a zero', () => {
		const r = replayPosition({ entryLamports: 0, peakLamports: 1, terminalLamports: 1 }, DEFAULT_PARAMS);
		expect(r.ok).toBe(false);
		expect(r.skip).toBe('no_entry_basis');
	});

	it('refuses a position with no recorded price path', () => {
		const r = replayPosition({ entryLamports: SOL, peakLamports: null, terminalLamports: null }, DEFAULT_PARAMS);
		expect(r.ok).toBe(false);
		expect(r.skip).toBe('no_price_path');
	});

	it('takes initials at the ladder multiple and keeps a bag riding', () => {
		const r = replayPosition(winner, { ...DEFAULT_PARAMS, initialsOutMultiple: 2, trailingStopPct: null, stopLossPct: null });
		const initials = r.legs.find((l) => l.reason === 'take_initials');
		expect(initials).toBeDefined();
		expect(initials.atMultiple).toBeCloseTo(2, 2);
		// At 2x the ladder sells exactly enough to recover the stake, capped by the
		// moon-bag floor: half the bag.
		expect(initials.sellFraction).toBeCloseTo(0.5, 2);
		expect(r.openValueLamports).toBeGreaterThan(0);
	});

	it('never sells the whole bag of a position that is in profit', () => {
		const r = replayPosition(winner, DEFAULT_PARAMS);
		const sold = r.legs.reduce((acc, l) => acc + l.sellFraction, 0);
		expect(sold).toBeLessThan(2); // two legs can never both be a full exit
		expect(r.openValueLamports).toBeGreaterThan(0);
	});

	it('exits a full loser at the hard stop and books the loss there', () => {
		const r = replayPosition(loser, { ...DEFAULT_PARAMS, stopLossPct: 35 });
		expect(r.exitReason).toBe('stop_loss');
		// A stop on money still at risk is a full exit; nothing may ride.
		expect(r.openValueLamports).toBe(0);
		expect(r.pnlLamports).toBeLessThan(0);
		// The stop fires at 35% down, so the loss is bounded there and is NOT the
		// full drop to the terminal price.
		expect(r.pnlPct).toBeCloseTo(-35, 0);
	});

	it('holds to the end of the recorded path when nothing fires, and says the result is bounded', () => {
		const r = replayPosition(loser, { stopLossPct: null, trailingStopPct: null, takeProfitPct: null, initialsOutMultiple: null, moonbagMinPct: 0 });
		expect(r.bounded).toBe(true);
		expect(r.totalLamports).toBeCloseTo(loser.terminalLamports, 0);
	});

	it('never values a bag above the last price actually observed', () => {
		const r = replayPosition(winner, DEFAULT_PARAMS);
		// Total proceeds can never exceed selling the entire bag at the peak.
		expect(r.totalLamports).toBeLessThanOrEqual(winner.peakLamports + 1);
	});

	it('clamps an incoherent row where the peak sits below the terminal price', () => {
		// A sweep that raced the exit can write a peak under the final quote. The
		// replay clamps rather than walking a path that never existed.
		const r = replayPosition(
			{ entryLamports: SOL, peakLamports: 0.5 * SOL, terminalLamports: 3 * SOL },
			DEFAULT_PARAMS,
		);
		expect(r.ok).toBe(true);
		expect(r.peakMultiple).toBeGreaterThanOrEqual(r.terminalMultiple);
	});

	it('is deterministic: the same inputs replay to the same numbers', () => {
		const a = replayPosition(winner, DEFAULT_PARAMS);
		const b = replayPosition(winner, DEFAULT_PARAMS);
		expect(a).toEqual(b);
	});

	it('takes no clock from the environment', () => {
		// max_hold_seconds is deliberately not part of the replay: the recorded
		// path already ends where the real position ended, so a timeout clock would
		// double-count the hold. A policy therefore cannot depend on Date.now().
		const before = replayPosition(winner, DEFAULT_PARAMS);
		const spy = Date.now;
		Date.now = () => 0;
		const after = replayPosition(winner, DEFAULT_PARAMS);
		Date.now = spy;
		expect(after).toEqual(before);
	});
});

describe('replayFleet', () => {
	const corpus = [winner, loser];

	it('aggregates only replayable rows and counts the rest as skipped', () => {
		const r = replayFleet([...corpus, { entryLamports: 0 }], DEFAULT_PARAMS);
		expect(r.trades).toBe(2);
		expect(r.skipped).toBe(1);
	});

	it('reports the actual booked result over the same corpus for comparison', () => {
		const r = replayFleet(corpus, DEFAULT_PARAMS);
		expect(r.actual.knownTrades).toBe(2);
		expect(r.actual.pnlLamports).toBe(winner.actualPnlLamports + loser.actualPnlLamports);
	});

	it('leaves a position with no booked P&L out of the actual total rather than counting it as zero', () => {
		const unknown = { ...winner, mint: 'THREEsynthetic3333333333333333333333333333', actualPnlLamports: null };
		const r = replayFleet([unknown], DEFAULT_PARAMS);
		expect(r.trades).toBe(1);
		expect(r.actual.knownTrades).toBe(0);
		expect(r.actual.pnlLamports).toBe(0);
	});

	it('builds a cumulative curve with one point per trade', () => {
		const r = replayFleet(corpus, DEFAULT_PARAMS);
		expect(r.curve).toHaveLength(2);
		expect(r.curve[1]).toBe(r.pnlLamports);
	});

	it('reports a non-negative drawdown', () => {
		const r = replayFleet(corpus, DEFAULT_PARAMS);
		expect(r.maxDrawdownLamports).toBeGreaterThanOrEqual(0);
	});

	it('attributes every counted trade to a known exit reason', () => {
		const r = replayFleet(corpus, DEFAULT_PARAMS);
		const attributed = Object.values(r.byReason).reduce((acc, v) => acc + v.trades, 0);
		expect(attributed).toBe(r.trades);
		for (const key of Object.keys(r.byReason)) expect(exitReasons()).toContain(key);
	});

	it('returns an honest zero on an empty corpus instead of throwing', () => {
		const r = replayFleet([], DEFAULT_PARAMS);
		expect(r.trades).toBe(0);
		expect(r.pnlLamports).toBe(0);
		expect(r.winRate).toBe(0);
		expect(r.rows).toEqual([]);
	});

	it('tolerates a non-array corpus', () => {
		expect(replayFleet(null, DEFAULT_PARAMS).trades).toBe(0);
	});

	it('a tighter stop can only reduce the loss on a pure loser', () => {
		const wide = replayFleet([loser], { ...DEFAULT_PARAMS, stopLossPct: 70 });
		const tight = replayFleet([loser], { ...DEFAULT_PARAMS, stopLossPct: 15 });
		expect(tight.pnlLamports).toBeGreaterThan(wide.pnlLamports);
	});
});

describe('sweepParams', () => {
	const corpus = [winner, loser];

	it('enumerates the full grid exactly', () => {
		const s = sweepParams(corpus, { stopLossPct: [10, 20, 30], trailingStopPct: [10, 25] }, { limit: 99 });
		expect(s.combos).toBe(6);
		expect(s.leaders).toHaveLength(6);
	});

	it('ranks leaders by profit, best first', () => {
		const s = sweepParams(corpus, { stopLossPct: [10, 20, 30, 50, 70] }, { limit: 5 });
		const pnls = s.leaders.map((l) => l.pnlLamports);
		expect([...pnls].sort((a, b) => b - a)).toEqual(pnls);
	});

	it('flags overfit risk on a corpus too thin to lean on', () => {
		expect(sweepParams(corpus, { stopLossPct: [10, 20] }).overfitRisk).toBe(true);
	});

	it('does not flag overfit risk once the corpus is deep enough', () => {
		const deep = Array.from({ length: 40 }, (_, i) => ({ ...winner, mint: `mint${i}` }));
		expect(sweepParams(deep, { stopLossPct: [10, 20] }).overfitRisk).toBe(false);
	});

	it('ignores an axis that is not a real parameter', () => {
		const s = sweepParams(corpus, { notAKnob: [1, 2, 3] }, { limit: 5 });
		expect(s.combos).toBe(1);
	});

	it('reports the baseline alongside the leaders so a win is measurable', () => {
		const s = sweepParams(corpus, { stopLossPct: [10, 20] });
		expect(s.baseline.params).toEqual(normalizeParams(DEFAULT_PARAMS));
		expect(typeof s.baseline.pnlLamports).toBe('number');
	});
});

describe('PARAM_SPECS', () => {
	it('gives every knob a range, a step and a plain-language explanation', () => {
		for (const spec of PARAM_SPECS) {
			expect(spec.min).toBeLessThan(spec.max);
			expect(spec.step).toBeGreaterThan(0);
			expect(spec.help.length).toBeGreaterThan(40);
			expect(spec.help).not.toMatch(/—|–/); // the repo's dash ban applies to UI copy
		}
	});

	it('has a live default inside its own declared range for every knob', () => {
		for (const spec of PARAM_SPECS) {
			const v = DEFAULT_PARAMS[spec.key];
			if (v == null) {
				expect(spec.nullable).toBe(true);
				continue;
			}
			expect(v).toBeGreaterThanOrEqual(spec.min);
			expect(v).toBeLessThanOrEqual(spec.max);
		}
	});
});

describe('toSol', () => {
	it('converts lamports and degrades a bad input to zero rather than NaN', () => {
		expect(toSol(SOL)).toBe(1);
		expect(toSol('nope')).toBe(0);
	});
});
