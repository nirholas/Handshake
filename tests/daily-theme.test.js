// Daily Forge theme rotation + day counter (src/daily/daily-theme.js).
// The contract: every UTC day resolves to exactly one theme, the same for every
// device, deterministically; the day counter is stable and monotonic; and the
// rotation actually varies (it doesn't collapse to one theme or a fixed weekday
// loop). Pure — no clock, no DOM.

import { describe, expect, it } from 'vitest';

import {
	dayNumber, seedForDate, THEMES, themeForDate, utcDayKey,
} from '../src/daily/daily-theme.js';

describe('utcDayKey', () => {
	it('normalizes Date, ISO, and bare date strings to a UTC day', () => {
		expect(utcDayKey('2026-07-17')).toBe('2026-07-17');
		expect(utcDayKey(new Date('2026-07-17T23:30:00Z'))).toBe('2026-07-17');
		expect(utcDayKey('2026-07-17T05:00:00Z')).toBe('2026-07-17');
	});
	it('returns "" for unparseable input', () => {
		expect(utcDayKey('not a date')).toBe('');
		expect(utcDayKey(NaN)).toBe('');
	});
});

describe('themeForDate', () => {
	it('is deterministic — the same day always gives the same theme', () => {
		const a = themeForDate('2026-08-01');
		const b = themeForDate('2026-08-01');
		expect(a.id).toBe(b.id);
		expect(a).toMatchObject({ day: expect.any(Number), dateKey: '2026-08-01' });
	});

	it('always returns a real, complete theme from the set', () => {
		const ids = new Set(THEMES.map((t) => t.id));
		for (let i = 0; i < 120; i++) {
			const key = utcDayKey(new Date(Date.UTC(2026, 6, 17) + i * 86400000));
			const t = themeForDate(key);
			expect(ids.has(t.id)).toBe(true);
			expect(t.seeds.length).toBeGreaterThan(0);
			expect(t.title).toBeTruthy();
			expect(t.emoji).toBeTruthy();
		}
	});

	it('actually rotates — a month of days hits many distinct themes', () => {
		const seen = new Set();
		for (let i = 0; i < 30; i++) {
			const key = utcDayKey(new Date(Date.UTC(2026, 6, 17) + i * 86400000));
			seen.add(themeForDate(key).id);
		}
		expect(seen.size).toBeGreaterThanOrEqual(10);
	});

	it('does not always repeat the same theme on the same weekday', () => {
		// Same weekday, 7 days apart, several weeks — should not be a single theme.
		const mondays = [0, 7, 14, 21, 28, 35].map((d) =>
			themeForDate(utcDayKey(new Date(Date.UTC(2026, 6, 20) + d * 86400000))).id);
		expect(new Set(mondays).size).toBeGreaterThan(1);
	});
});

describe('dayNumber', () => {
	it('is 1 on launch day and increments by one per UTC day', () => {
		expect(dayNumber('2026-07-17')).toBe(1);
		expect(dayNumber('2026-07-18')).toBe(2);
		expect(dayNumber('2026-08-16')).toBe(31);
	});
	it('clamps dates before launch to 1', () => {
		expect(dayNumber('2020-01-01')).toBe(1);
	});
});

describe('seedForDate', () => {
	it('returns a deterministic seed drawn from that day’s theme', () => {
		const t = themeForDate('2026-09-09');
		const seed = seedForDate('2026-09-09');
		expect(t.seeds).toContain(seed);
		expect(seedForDate('2026-09-09')).toBe(seed); // stable
	});
});
