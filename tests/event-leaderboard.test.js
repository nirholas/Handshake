// Event leaderboard ranking (order 04), the pure math both the in-world panel and
// api/play/event-leaderboard.js fold their rows through. Ranking is the thing a
// player will argue about, so every rule is pinned: runs first, cash as the
// tiebreak, the earlier finisher ahead on a dead heat, and your own row findable
// whether or not you made the top ten.
import { describe, it, expect } from 'vitest';
import {
	TOP_LIMIT, emptyEventRecord, applyEventRun, normalizeEventRecord,
	rankEventBoard, eventBoardView,
} from '../multiplayer/src/event-leaderboard.js';

function runner(account, { runs = 0, cash = 0, lastAt = 0, name = account } = {}) {
	return { account, name, runs, cash, lastAt, missions: {} };
}

describe('applyEventRun', () => {
	it('counts a run, adds its gold, tracks the mission and stamps the clock', () => {
		const rec = applyEventRun(emptyEventRecord('acct-1', 'Ada'), {
			missionId: 'event-plaza-catch', gold: 320, at: 1000,
		});
		expect(rec.runs).toBe(1);
		expect(rec.cash).toBe(320);
		expect(rec.lastAt).toBe(1000);
		expect(rec.missions['event-plaza-catch']).toBe(1);
	});

	it('accumulates repeat runs of the same job', () => {
		let rec = emptyEventRecord('acct-1', 'Ada');
		rec = applyEventRun(rec, { missionId: 'event-plaza-catch', gold: 320, at: 1000 });
		rec = applyEventRun(rec, { missionId: 'event-plaza-catch', gold: 320, at: 2000 });
		expect(rec.runs).toBe(2);
		expect(rec.cash).toBe(640);
		expect(rec.missions['event-plaza-catch']).toBe(2);
	});

	it('takes the newest display name and never lets the clock go backwards', () => {
		let rec = applyEventRun(emptyEventRecord('acct-1', 'Ada'), { missionId: 'm', gold: 10, at: 5000 });
		rec = applyEventRun(rec, { missionId: 'm', gold: 10, at: 100, name: 'Ada Prime' });
		expect(rec.name).toBe('Ada Prime');
		expect(rec.lastAt).toBe(5000);
	});

	it('clamps junk instead of poisoning the score with NaN or a negative', () => {
		const rec = applyEventRun(emptyEventRecord('acct-1'), { missionId: 'm', gold: -900, at: 'later' });
		expect(rec.runs).toBe(1);
		expect(rec.cash).toBe(0);
		expect(rec.lastAt).toBe(0);
	});

	// A real epoch-ms stamp is past 2^31, so a bitwise coercion anywhere on this
	// path silently zeroes it and the "earlier finisher wins" tiebreak stops
	// working. Caught in a live run where every row came back with lastAt: 0.
	it('keeps a real epoch-millisecond timestamp intact', () => {
		const now = Date.UTC(2026, 7, 8, 17, 30, 0); // ~1.786e12, well past 2^31
		const rec = applyEventRun(emptyEventRecord('acct-1'), { missionId: 'm', gold: 220, at: now });
		expect(rec.lastAt).toBe(now);
		expect(normalizeEventRecord(rec).lastAt).toBe(now);
	});
});

describe('normalizeEventRecord', () => {
	it('rebuilds a full record from a partial or legacy blob', () => {
		const rec = normalizeEventRecord({ runs: 3 }, 'acct-9');
		expect(rec).toMatchObject({ account: 'acct-9', runs: 3, cash: 0, lastAt: 0 });
		expect(rec.missions).toEqual({});
	});

	it('degrades a corrupt blob to a zeroed record rather than throwing', () => {
		const rec = normalizeEventRecord({ runs: 'many', cash: null, missions: 'nope' }, 'acct-9');
		expect(rec.runs).toBe(0);
		expect(rec.cash).toBe(0);
		expect(rec.missions).toEqual({});
	});
});

describe('rankEventBoard', () => {
	it('ranks by completions first', () => {
		const rows = rankEventBoard([runner('a', { runs: 2 }), runner('b', { runs: 5 }), runner('c', { runs: 3 })]);
		expect(rows.map((r) => r.account)).toEqual(['b', 'c', 'a']);
		expect(rows.map((r) => r.rank)).toEqual([1, 2, 3]);
	});

	it('breaks a tie on runs with total event cash', () => {
		const rows = rankEventBoard([
			runner('a', { runs: 4, cash: 800 }),
			runner('b', { runs: 4, cash: 1200 }),
		]);
		expect(rows.map((r) => r.account)).toEqual(['b', 'a']);
	});

	it('breaks a dead heat with the earlier finisher', () => {
		const rows = rankEventBoard([
			runner('late', { runs: 4, cash: 800, lastAt: 9000 }),
			runner('early', { runs: 4, cash: 800, lastAt: 1000 }),
		]);
		expect(rows.map((r) => r.account)).toEqual(['early', 'late']);
	});

	it('is total and reproducible even when every score is identical', () => {
		const tied = [runner('z', { runs: 1 }), runner('a', { runs: 1 }), runner('m', { runs: 1 })];
		expect(rankEventBoard(tied).map((r) => r.account)).toEqual(['a', 'm', 'z']);
		expect(rankEventBoard([...tied].reverse()).map((r) => r.account)).toEqual(['a', 'm', 'z']);
	});

	it('leaves out players who never finished an event job', () => {
		const rows = rankEventBoard([runner('a', { runs: 0 }), runner('b', { runs: 1 })]);
		expect(rows.map((r) => r.account)).toEqual(['b']);
	});

	it('survives an empty board', () => {
		expect(rankEventBoard([])).toEqual([]);
		expect(rankEventBoard()).toEqual([]);
	});
});

describe('eventBoardView', () => {
	const many = Array.from({ length: 25 }, (_, i) => runner(`acct-${i}`, { runs: 25 - i, cash: (25 - i) * 100 }));

	it('serves the top ten by default with totals for the whole field', () => {
		const view = eventBoardView(many, { account: 'acct-0' });
		expect(view.top).toHaveLength(TOP_LIMIT);
		expect(view.top[0].rank).toBe(1);
		expect(view.players).toBe(25);
		expect(view.totalRuns).toBe(many.reduce((n, r) => n + r.runs, 0));
	});

	it('pins your own row when you are outside the top ten', () => {
		const view = eventBoardView(many, { account: 'acct-20' });
		expect(view.you.rank).toBe(21);
		expect(view.you.inTop).toBe(false);
		expect(view.top.some((r) => r.rank === 21)).toBe(false);
	});

	it('marks your row as in-top when you made the cut', () => {
		const view = eventBoardView(many, { account: 'acct-1' });
		expect(view.you.rank).toBe(2);
		expect(view.you.inTop).toBe(true);
	});

	it('serves an anonymous read with no you row', () => {
		expect(eventBoardView(many, {}).you).toBeNull();
	});

	it('answers null for a player who has not run anything yet', () => {
		expect(eventBoardView(many, { account: 'never-played' }).you).toBeNull();
	});

	it('never leaks the account key onto the wire', () => {
		const view = eventBoardView(many, { account: 'acct-0' });
		for (const row of [...view.top, view.you]) expect(row.account).toBeUndefined();
	});

	it('names an unnamed runner rather than rendering a blank row', () => {
		const view = eventBoardView([runner('acct-x', { runs: 1, name: '' })], { account: 'acct-x' });
		expect(view.top[0].name).toBe('Anonymous');
	});

	it('honours a custom limit and clamps an absurd one', () => {
		expect(eventBoardView(many, { limit: 3 }).top).toHaveLength(3);
		expect(eventBoardView(many, { limit: 9999 }).top).toHaveLength(25);
		expect(eventBoardView(many, { limit: 0 }).top).toHaveLength(TOP_LIMIT);
	});

	it('serves the designed empty board, not an error, when nobody has played', () => {
		const view = eventBoardView([], { account: 'acct-1' });
		expect(view).toEqual({ top: [], you: null, players: 0, totalRuns: 0 });
	});
});
