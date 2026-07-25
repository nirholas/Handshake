import { describe, it, expect } from 'vitest';
import { decideLadderedExit, moonbagAlways, moonbagExitFraction, moonbagFraction, ladderMultiple } from '../workers/agent-sniper/exit-logic.js';
import { mayhemVerdict } from '../workers/agent-sniper/mayhem-gate.js';

// The owner's rule, pinned in math:
//  - buy, and when up ~2x sell enough to recover the INITIAL cost basis;
//  - NEVER cut 100% of a position that is in profit: a moon bag always rides,
//    on every terminal reason (trailing stop, take-profit, timeout), whether or
//    not the take-initials ladder ever fired;
//  - once the stake is home the remainder is FREE, so a bag that goes to zero
//    costs nothing and a bag that runs is the entire upside. Selling the last
//    slice to bank a rounding error trades that away;
//  - a loss exit on money still at risk is still a FULL exit, and the hard
//    stop-loss still wins. Nothing is free until the stake is back.

const ENTRY = 1_000_000_000; // 1 SOL cost basis (lamports)
const base = (over = {}) => ({
	entry_quote_lamports: String(ENTRY),
	stop_loss_pct: 30,
	trailing_stop_pct: 20,
	take_profit_pct: null,
	max_hold_seconds: null,
	opened_at: new Date('2026-07-03T00:00:00Z').toISOString(),
	initials_out_multiple: 2,
	moonbag_min_pct: 15,
	initials_recovered: false,
	...over,
});
const NOW = new Date('2026-07-03T00:10:00Z').getTime();

describe('ladder helpers', () => {
	it('ladderMultiple requires > 1, else null (ladder off)', () => {
		expect(ladderMultiple(2)).toBe(2);
		expect(ladderMultiple(1)).toBe(null);
		expect(ladderMultiple(null)).toBe(null);
		expect(ladderMultiple('')).toBe(null);
	});
	it('moonbagFraction defaults 15% and clamps to [0, 0.95]', () => {
		expect(moonbagFraction(null)).toBeCloseTo(0.15);
		expect(moonbagFraction(15)).toBeCloseTo(0.15);
		expect(moonbagFraction(200)).toBe(0.95);
		expect(moonbagFraction(-5)).toBe(0);
	});
});

describe('take-initials ladder', () => {
	it('does NOT take profit before the initials band (holds under 2x)', () => {
		expect(decideLadderedExit(base(), 1.8 * ENTRY, 1.8 * ENTRY, NOW)).toBe(null);
	});

	it('at 2x sells exactly the cost basis back (half) and keeps a moon bag', () => {
		const d = decideLadderedExit(base(), 2 * ENTRY, 2 * ENTRY, NOW);
		expect(d.reason).toBe('take_initials');
		expect(d.recoversInitials).toBe(true);
		expect(d.sellFraction).toBeCloseTo(0.5); // entry/value = 1/2
		expect(d.sellFraction).toBeLessThan(1); // NEVER a full exit on the way up
	});

	it('at 5x sells only ~20% (keeps 80% moon bag)', () => {
		const d = decideLadderedExit(base(), 5 * ENTRY, 5 * ENTRY, NOW);
		expect(d.reason).toBe('take_initials');
		expect(d.sellFraction).toBeCloseTo(0.2);
	});

	it('never sells into the moon-bag floor even at a huge multiple', () => {
		// A 1.05x band with a 90% moonbag: recover-fraction would be ~0.95, but the
		// floor caps the sell at 1 - 0.90 = 0.10.
		const d = decideLadderedExit(base({ initials_out_multiple: 1.05, moonbag_min_pct: 90 }), 1.05 * ENTRY, 1.05 * ENTRY, NOW);
		expect(d.reason).toBe('take_initials');
		expect(d.sellFraction).toBeCloseTo(0.1);
	});

	it('fires the ladder only once (recovered → no second take-initials)', () => {
		const d = decideLadderedExit(base({ initials_recovered: true }), 3 * ENTRY, 3 * ENTRY, NOW);
		expect(d).toBe(null); // moon bag rides; no take_profit set, trailing not hit
	});
});

describe('a loss exit is still a FULL exit and stop-loss wins', () => {
	it('stop-loss fires a full exit before initials', () => {
		// Money still at risk: nothing here is free, so the hard downside cap stands.
		const d = decideLadderedExit(base(), 0.6 * ENTRY, 1 * ENTRY, NOW);
		expect(d.reason).toBe('stop_loss');
		expect(d.sellFraction).toBe(1);
		expect(d.keepsMoonbag).toBeFalsy();
	});

	it('stop-loss beats a simultaneous initials band (stop-loss precedence)', () => {
		// Contrived: value both ≤ stop and ≥ 2x is impossible; assert stop wins when
		// price collapsed below stop even though initials were configured.
		const d = decideLadderedExit(base(), 0.5 * ENTRY, 2.5 * ENTRY, NOW);
		expect(d.reason).toBe('stop_loss');
		expect(d.sellFraction).toBe(1);
	});

	it('a timeout underwater with no initials recovered exits fully', () => {
		const d = decideLadderedExit(
			base({ max_hold_seconds: 60 }),
			0.8 * ENTRY, 0.9 * ENTRY,
			new Date('2026-07-03T02:00:00Z').getTime(),
		);
		expect(d.reason).toBe('timeout');
		expect(d.sellFraction).toBe(1);
	});

	it('a bearish signal flip underwater exits fully', () => {
		const d = decideLadderedExit(base(), 0.9 * ENTRY, 1 * ENTRY, NOW, { signal: 'bearish', confidence: 0.9 });
		expect(d.reason).toBe('signal_flip');
		expect(d.sellFraction).toBe(1);
	});
});

describe('the owner rule: never sell 100% of a position in profit', () => {
	it('keeps a moon bag when the trailing stop fires on house money', () => {
		// Initials already recovered: the whole remainder is free. Bank the gain down
		// to the floor, never to zero.
		const d = decideLadderedExit(base({ initials_recovered: true }), 3.1 * ENTRY, 4 * ENTRY, NOW);
		expect(d.reason).toBe('trailing_stop');
		expect(d.sellFraction).toBeCloseTo(0.85);
		expect(d.sellFraction).toBeLessThan(1);
		expect(d.keepsMoonbag).toBe(true);
	});

	it('keeps a moon bag on a timeout in profit', () => {
		const d = decideLadderedExit(
			base({ initials_recovered: true, max_hold_seconds: 60 }),
			1.5 * ENTRY, 1.6 * ENTRY,
			new Date('2026-07-03T02:00:00Z').getTime(),
		);
		expect(d.reason).toBe('timeout');
		expect(d.sellFraction).toBeCloseTo(0.85);
		expect(d.keepsMoonbag).toBe(true);
	});

	it('recovers the stake instead of dumping 100% for a rounding error', () => {
		// THE case the rule exists for. Ladder never fired (the 2x band was never
		// reached), trailing stop trips at +40%. The old behavior sold the entire bag
		// to bank a few thousandths of a SOL. Now it sells exactly the cost basis and
		// the rest rides free.
		const d = decideLadderedExit(base(), 1.4 * ENTRY, 1.8 * ENTRY, NOW);
		expect(d.reason).toBe('trailing_stop');
		expect(d.sellFraction).toBeCloseTo(1 / 1.4); // entry/value: the stake, exactly
		expect(d.sellFraction).toBeLessThan(1);
		expect(d.keepsMoonbag).toBe(true);
	});

	it('applies with the ladder switched off, because this is fleet policy', () => {
		const d = decideLadderedExit(
			base({ initials_out_multiple: null, take_profit_pct: 80 }),
			2 * ENTRY, 2 * ENTRY, NOW,
		);
		expect(d.reason).toBe('take_profit');
		expect(d.sellFraction).toBeCloseTo(0.5); // recovers the stake, keeps half free
		expect(d.keepsMoonbag).toBe(true);
	});

	it('keeps a bag even when a stop-loss hits AFTER initials came back', () => {
		// A stop on house money is a stop on free shares. There is nothing to protect
		// (the stake is already home), so the bag rides rather than being dumped.
		const d = decideLadderedExit(base({ initials_recovered: true }), 0.6 * ENTRY, 2 * ENTRY, NOW);
		expect(d.reason).toBe('stop_loss');
		expect(d.sellFraction).toBeCloseTo(0.85);
		expect(d.keepsMoonbag).toBe(true);
	});

	it('never returns a full exit on any profitable reason', () => {
		const cases = [
			['trailing_stop', base({ initials_recovered: true }), 3.1 * ENTRY, 4 * ENTRY, NOW],
			['take_profit', base({ initials_recovered: true, take_profit_pct: 50 }), 2 * ENTRY, 2 * ENTRY, NOW],
			['timeout', base({ initials_recovered: true, max_hold_seconds: 1 }), 5 * ENTRY, 5 * ENTRY, new Date('2026-07-03T02:00:00Z').getTime()],
		];
		for (const [expected, pos, value, peak, now] of cases) {
			const d = decideLadderedExit(pos, value, peak, now);
			expect(d.reason, expected).toBe(expected);
			expect(d.sellFraction, `${expected} must never be a full exit`).toBeLessThan(1);
		}
	});

	it('honours an explicit opt-out for a strategy that must fully exit', () => {
		const d = decideLadderedExit(
			base({ initials_recovered: true, moonbag_always: false }),
			3.1 * ENTRY, 4 * ENTRY, NOW,
		);
		expect(d.reason).toBe('trailing_stop');
		expect(d.sellFraction).toBe(1);
		expect(d.keepsMoonbag).toBeFalsy();
	});

	it('is on by default for every existing strategy row (null = on)', () => {
		expect(moonbagAlways({})).toBe(true);
		expect(moonbagAlways({ moonbag_always: null })).toBe(true);
		expect(moonbagAlways({ moonbag_always: undefined })).toBe(true);
		expect(moonbagAlways({ moonbag_always: false })).toBe(false);
	});
});

describe('moonbagExitFraction', () => {
	it('sells exactly the stake back when cost basis is still carried', () => {
		expect(moonbagExitFraction(100, 200, 0.15, false)).toBeCloseTo(0.5);
		expect(moonbagExitFraction(100, 400, 0.15, false)).toBeCloseTo(0.25);
	});

	it('banks down to the floor once the money is free', () => {
		expect(moonbagExitFraction(100, 200, 0.15, true)).toBeCloseTo(0.85);
		expect(moonbagExitFraction(100, 10_000, 0.15, true)).toBeCloseTo(0.85);
	});

	it('never sells the whole bag, whatever the inputs', () => {
		for (const houseMoney of [true, false]) {
			for (const [entry, value] of [[100, 100], [100, 1], [100, 1e12], [0, 100]]) {
				const f = moonbagExitFraction(entry, value, 0.15, houseMoney);
				expect(f).toBeLessThanOrEqual(0.85);
				expect(f).toBeGreaterThanOrEqual(0);
			}
		}
	});

	it('respects a custom floor', () => {
		expect(moonbagExitFraction(100, 500, 0.5, true)).toBeCloseTo(0.5);
		expect(moonbagExitFraction(100, 500, 0.9, true)).toBeCloseTo(0.1);
	});
});

describe('the trailing stop arms only once the position has been green', () => {
	it('does not trail a position whose peak never cleared entry', () => {
		// A below-breakeven trail converts a recoverable dip into a locked loss while
		// protecting nothing: the hard stop-loss already caps the downside. decideExit
		// has always guarded this; the ladder path used to arm at any peak.
		const d = decideLadderedExit(base(), 0.75 * ENTRY, 0.95 * ENTRY, NOW);
		expect(d).toBe(null);
	});

	it('trails normally once the peak cleared entry', () => {
		const d = decideLadderedExit(base(), 1.2 * ENTRY, 1.6 * ENTRY, NOW);
		expect(d.reason).toBe('trailing_stop');
	});
});

describe('mayhem verdict (owner rule)', () => {
	it('excludes a mayhem mint', () => {
		expect(mayhemVerdict(true)).toEqual({ pass: false, reason: 'mayhem_excluded' });
	});
	it('allows a regular mint', () => {
		expect(mayhemVerdict(false)).toEqual({ pass: true });
	});
	it('allows on unknown by default, skips on strict', () => {
		expect(mayhemVerdict(null).pass).toBe(true);
		expect(mayhemVerdict(null, { strict: true })).toEqual({ pass: false, reason: 'mayhem_unknown', unknown: true });
	});
});
