// Creator streak state machine (src/daily/creator-streak.js).
// The contract: consecutive UTC days extend the streak, a gap resets it, acting
// twice in one day never double-counts, `best` only ever grows, milestones fire
// exactly once at the right lengths, and a stale streak reads as lapsed. Pure —
// clock + storage injected.

import { describe, expect, it } from 'vitest';

import {
	daysBetween, emptyStreak, loadStreak, milestoneFor, recordDay,
	saveStreak, streakStatus,
} from '../src/daily/creator-streak.js';

describe('daysBetween', () => {
	it('counts whole UTC days', () => {
		expect(daysBetween('2026-07-17', '2026-07-18')).toBe(1);
		expect(daysBetween('2026-07-17', '2026-07-17')).toBe(0);
		expect(daysBetween('2026-07-18', '2026-07-17')).toBe(-1);
		expect(daysBetween('2026-07-01', '2026-08-01')).toBe(31);
	});
	it('returns null for bad keys', () => {
		expect(daysBetween('nope', '2026-07-18')).toBe(null);
	});
});

describe('recordDay', () => {
	it('starts a streak at 1 on the first ever action', () => {
		const { state, changed } = recordDay(emptyStreak(), '2026-07-17');
		expect(state).toMatchObject({ current: 1, best: 1, lastDay: '2026-07-17', total: 1 });
		expect(changed).toBe(true);
	});

	it('extends on a consecutive day', () => {
		let s = recordDay(emptyStreak(), '2026-07-17').state;
		s = recordDay(s, '2026-07-18').state;
		s = recordDay(s, '2026-07-19').state;
		expect(s.current).toBe(3);
		expect(s.best).toBe(3);
		expect(s.total).toBe(3);
	});

	it('does not double-count a second action the same day', () => {
		let s = recordDay(emptyStreak(), '2026-07-17').state;
		const again = recordDay(s, '2026-07-17');
		expect(again.changed).toBe(false);
		expect(again.state.current).toBe(1);
		expect(again.state.total).toBe(1);
		expect(again.milestone).toBe(null);
	});

	it('resets to 1 after a gap but keeps best', () => {
		let s = emptyStreak();
		for (const d of ['2026-07-17', '2026-07-18', '2026-07-19']) s = recordDay(s, d).state;
		expect(s.current).toBe(3);
		s = recordDay(s, '2026-07-25').state; // 6-day gap
		expect(s.current).toBe(1);
		expect(s.best).toBe(3); // best survives the break
		expect(s.total).toBe(4);
	});

	it('fires a milestone exactly when a threshold is reached, once', () => {
		let s = emptyStreak();
		const hits = [];
		const days = Array.from({ length: 8 }, (_, i) => `2026-07-${String(17 + i).padStart(2, '0')}`);
		for (const d of days) {
			const r = recordDay(s, d); s = r.state;
			if (r.milestone) hits.push({ day: d, m: r.milestone });
		}
		expect(hits.map((h) => h.m)).toEqual([3, 7]); // day 3 and day 7 of the run
	});

	it('never corrupts on clock skew (a day before lastDay)', () => {
		let s = recordDay(emptyStreak(), '2026-07-18').state;
		const r = recordDay(s, '2026-07-17'); // "yesterday" arrives after "today"
		expect(r.state.current).toBeGreaterThanOrEqual(1);
		expect(Number.isFinite(r.state.current)).toBe(true);
	});

	it('ignores a malformed day key', () => {
		const r = recordDay(emptyStreak(), 'garbage');
		expect(r.changed).toBe(false);
		expect(r.state.current).toBe(0);
	});
});

describe('milestoneFor', () => {
	it('recognizes the celebration lengths only', () => {
		for (const m of [3, 7, 14, 30, 50, 100, 365]) expect(milestoneFor(m)).toBe(m);
		for (const n of [1, 2, 4, 8, 29, 31]) expect(milestoneFor(n)).toBe(null);
	});
});

describe('streakStatus', () => {
	const built = (() => {
		let s = emptyStreak();
		for (const d of ['2026-07-17', '2026-07-18', '2026-07-19']) s = recordDay(s, d).state;
		return s;
	})();

	it('reads active the same day', () => {
		expect(streakStatus(built, '2026-07-19')).toMatchObject({ current: 3, actedToday: true, atRisk: false });
	});
	it('reads at-risk the next day (act to keep it)', () => {
		expect(streakStatus(built, '2026-07-20')).toMatchObject({ current: 3, actedToday: false, atRisk: true });
	});
	it('reads lapsed after two idle days (current shown as 0, best kept)', () => {
		expect(streakStatus(built, '2026-07-22')).toMatchObject({ current: 0, best: 3, atRisk: false });
	});
	it('handles a never-started streak', () => {
		expect(streakStatus(emptyStreak(), '2026-07-19')).toMatchObject({ current: 0, atRisk: false });
	});
});

describe('storage round-trip', () => {
	function memStorage() {
		const map = new Map();
		return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, v) };
	}
	it('persists and reloads a streak; bad data degrades to empty', () => {
		const store = memStorage();
		const s = recordDay(emptyStreak(), '2026-07-17').state;
		saveStreak(s, store);
		expect(loadStreak(store)).toEqual(s);
		store.setItem('twx_daily_streak_v1', '{bad json');
		expect(loadStreak(store)).toEqual(emptyStreak());
	});
});
