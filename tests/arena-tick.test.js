// The Arena's autonomous keeper (api/cron/arena-tick.js) and the public-list
// hygiene rule next to it.
//
// Why this suite exists: /arena shipped as a page that could only ever show what
// a human had created by hand, so production ran for weeks with exactly one row
// in it: a "test" bracket with zero entrants, past its window, never finalized,
// while the homepage's primary CTA pointed holders straight at it. Two things had
// to become true and stay true: a sprint gets scheduled and staffed with real
// public agents on its own, and a finished bracket nobody entered never renders.

import { describe, it, expect } from 'vitest';
import { houseWindow, houseName, isHouseRow, rosterFrom } from '../api/cron/arena-tick.js';
import { visibleTournaments } from '../api/tournaments/index.js';

describe('houseWindow', () => {
	it('covers the whole UTC day the clock lands in', () => {
		const w = houseWindow(Date.parse('2026-08-14T17:42:11.000Z'));
		expect(w.day).toBe('2026-08-14');
		expect(w.starts_at).toBe('2026-08-14T00:00:00.000Z');
		expect(w.ends_at).toBe('2026-08-15T00:00:00.000Z');
	});

	it('does not slide with local time or across a month boundary', () => {
		const w = houseWindow(Date.parse('2026-08-31T23:59:59.000Z'));
		expect(w.day).toBe('2026-08-31');
		expect(w.ends_at).toBe('2026-09-01T00:00:00.000Z');
	});

	it('is stable for every instant inside the same day', () => {
		const a = houseWindow(Date.parse('2026-08-14T00:00:00.000Z'));
		const b = houseWindow(Date.parse('2026-08-14T23:59:59.999Z'));
		expect(a).toEqual(b);
		expect(houseName(a.day)).toBe('Daily Sprint 2026-08-14');
	});
});

describe('isHouseRow', () => {
	const row = { name: 'Daily Sprint 2026-08-14', entry_rules: { house: true, house_day: '2026-08-14' } };

	it('matches on the entry_rules tag, per day', () => {
		expect(isHouseRow(row, '2026-08-14')).toBe(true);
		expect(isHouseRow(row, '2026-08-15')).toBe(false);
		expect(isHouseRow(row)).toBe(true);
	});

	it('never matches a user tournament that merely copied the name', () => {
		expect(isHouseRow({ name: 'Daily Sprint 2026-08-14', entry_rules: {} }, '2026-08-14')).toBe(false);
		expect(isHouseRow({ name: 'Daily Sprint 2026-08-14' }, '2026-08-14')).toBe(false);
	});
});

describe('rosterFrom', () => {
	it('takes agents that closed a trade or are still holding one', () => {
		const roster = rosterFrom([
			{ agent_id: 'a', closed: 12, open_positions: 0 },
			{ agent_id: 'b', closed: 0, open_positions: 3 },
			{ agent_id: 'c', closed: 0, open_positions: 0 },
			{ closed: 9, open_positions: 1 },
		]);
		expect(roster.map((r) => r.agent_id)).toEqual(['a', 'b']);
	});

	it('tolerates a leaderboard outage returning nothing', () => {
		expect(rosterFrom(null)).toEqual([]);
		expect(rosterFrom([])).toEqual([]);
	});
});

describe('visibleTournaments', () => {
	it('hides a finished bracket nobody entered', () => {
		const rows = [
			{ id: 'dead', phase: 'finished', entrant_count: 0 },
			{ id: 'real', phase: 'finished', entrant_count: 4 },
		];
		expect(visibleTournaments(rows).map((r) => r.id)).toEqual(['real']);
	});

	it('keeps live and upcoming brackets that are still joinable at zero entrants', () => {
		const rows = [
			{ id: 'live', phase: 'live', entrant_count: 0 },
			{ id: 'next', phase: 'upcoming', entrant_count: 0 },
		];
		expect(visibleTournaments(rows).map((r) => r.id)).toEqual(['live', 'next']);
	});
});
