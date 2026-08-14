// The Arena's share card (api/arena-og.js).
//
// Why these particular guards: an OG card is rendered once, cached at the edge
// for hours, and then reproduced on someone else's timeline where nobody can
// refresh it. Three failure modes are unrecoverable once that has happened, so
// each gets a test:
//
//   1. Text that overflows the 1200px canvas. SVG does not wrap or clip by
//      default, so an over-long title silently runs off the card.
//   2. A number that lies. A negative day has to read negative, and a pool of
//      zero has to read as no pool rather than as "0 $THREE at stake".
//   3. A state stamp that contradicts the board, e.g. an ended bracket still
//      stamped LIVE.

import { describe, it, expect } from 'vitest';
import { titleSize, fmtSol, windowLabel, stateStamp, poolToThree, fmtThree } from '../api/arena-og.js';

describe('titleSize', () => {
	it('keeps short names large and steps long ones down', () => {
		expect(titleSize('Daily Sprint')).toBe(58);
		expect(titleSize('Daily Arena, Aug 14')).toBe(48);
		expect(titleSize('Weekend Snipe-Off Championship')).toBe(40);
		expect(titleSize('Friday Night Snipe-Off Invitational')).toBe(34);
		expect(titleSize('x'.repeat(60))).toBe(34);
	});

	it('never returns a size that would overflow the 1056px text column', () => {
		// Titles are truncated to 44 chars before rendering; at roughly 0.62em per
		// glyph the widest survivor has to stay inside the card's 72..1128 gutters.
		for (const len of [1, 18, 19, 26, 27, 34, 35, 44]) {
			const size = titleSize('x'.repeat(len));
			expect(Math.min(len, 44) * size * 0.62).toBeLessThan(1056);
		}
	});

	it('treats a missing name as the shortest case rather than throwing', () => {
		expect(titleSize(null)).toBe(58);
		expect(titleSize(undefined)).toBe(58);
	});
});

describe('fmtSol', () => {
	it('signs a winning day and a losing one', () => {
		expect(fmtSol(0.215)).toBe('+0.215 SOL');
		expect(fmtSol(-0.051)).toBe('-0.051 SOL');
	});

	it('uses three decimals under 1 SOL and two above, so small edges stay visible', () => {
		expect(fmtSol(0.004)).toBe('+0.004 SOL');
		expect(fmtSol(12.5)).toBe('+12.50 SOL');
	});

	it('renders a flat board as zero without a sign', () => {
		expect(fmtSol(0)).toBe('0.00 SOL');
	});

	it('says n/a rather than NaN when there is no number', () => {
		expect(fmtSol(null)).toBe('n/a');
		expect(fmtSol(undefined)).toBe('n/a');
		expect(fmtSol('nonsense')).toBe('n/a');
	});
});

describe('windowLabel', () => {
	const t = { starts_at: '2026-08-14T00:00:00.000Z', ends_at: '2026-08-15T00:00:00.000Z' };
	const at = (iso) => Date.parse(iso);

	it('counts down while live', () => {
		expect(windowLabel(t, 'live', at('2026-08-14T06:30:00.000Z'))).toBe('Closes in 17h 30m');
	});

	it('counts up to the open while upcoming', () => {
		expect(windowLabel(t, 'upcoming', at('2026-08-13T22:00:00.000Z'))).toBe('Opens in 2h 0m');
	});

	it('reports a closed window in the past tense', () => {
		expect(windowLabel(t, 'closed', at('2026-08-15T03:00:00.000Z'))).toBe('Window closed 3h 0m ago');
	});

	it('never renders a negative countdown when a tick lands past the bell', () => {
		expect(windowLabel(t, 'live', at('2026-08-15T00:05:00.000Z'))).toBe('Closes in 0m');
	});
});

describe('stateStamp', () => {
	it('stamps each lifecycle phase distinctly', () => {
		expect(stateStamp('live').label).toBe('LIVE · MAINNET ON-CHAIN');
		expect(stateStamp('upcoming').label).toBe('ENTRIES OPEN');
		expect(stateStamp('cancelled').label).toBe('CANCELLED');
	});

	it('never stamps an ended or settled board as live', () => {
		for (const s of ['ended', 'closed', 'settled']) {
			expect(stateStamp(s).label).toBe('FINAL STANDINGS');
		}
	});
});

describe('poolToThree', () => {
	it('converts atomics at the token decimals', () => {
		expect(poolToThree('1000000', 6)).toBe(1);
		expect(poolToThree('2500000', 6)).toBe(2.5);
		expect(poolToThree(1_000_000_000n * 10n ** 6n, 6)).toBe(1_000_000_000);
	});

	it('reads an absent pool as zero so the card says bragging rights', () => {
		expect(poolToThree(0, 6)).toBe(0);
		expect(poolToThree(null, 6)).toBe(0);
		expect(poolToThree('not-a-number', 6)).toBe(0);
	});
});

describe('fmtThree', () => {
	it('abbreviates the way the rest of the Arena does', () => {
		expect(fmtThree(1_500_000)).toBe('1.50M');
		expect(fmtThree(2500)).toBe('2.5K');
		expect(fmtThree(42)).toBe('42');
	});
});
