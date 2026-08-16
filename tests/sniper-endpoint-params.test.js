// Regression cover for two sniper endpoint bugs that were invisible from the
// code and only showed up against a live server: a corpus request that silently
// shrank to one trade, and an SSE cursor that never moved.
import { describe, it, expect } from 'vitest';
import { corpusQuery } from '../api/sniper/exit-lab.js';
import { advanceCursor, microIso } from '../api/sniper/radar-stream.js';

const q = (search) => corpusQuery(new URLSearchParams(search));

describe('exit-lab corpusQuery', () => {
	// The bug: Number(null) is 0, and 0 is finite, so the "is this parseable"
	// check passed for an ABSENT limit and the clamp floored it to 1. A bare
	// GET /api/sniper/exit-lab answered with a single trade and the replay
	// console reported a fleet that had traded once.
	it('uses the full default page size when limit is absent', () => {
		expect(q('').limit).toBe(400);
		expect(q('window=30').limit).toBe(400);
	});

	it('still defaults when limit is present but unparseable', () => {
		expect(q('limit=abc').limit).toBe(400);
		expect(q('limit=').limit).toBe(400);
	});

	it('honours an explicit limit and clamps it into range', () => {
		expect(q('limit=25').limit).toBe(25);
		expect(q('limit=500').limit).toBe(500);
		expect(q('limit=99999').limit).toBe(500);
		expect(q('limit=0').limit).toBe(1);
		expect(q('limit=-5').limit).toBe(1);
		expect(q('limit=12.9').limit).toBe(12);
	});

	it('falls back to mainnet and the 90-day window on unknown values', () => {
		expect(q('network=evil&window=999')).toMatchObject({ network: 'mainnet', window: '90' });
		expect(q('')).toMatchObject({ network: 'mainnet', window: '90' });
	});

	it('accepts every documented network and window', () => {
		expect(q('network=devnet').network).toBe('devnet');
		for (const w of ['7', '30', '90', 'all']) expect(q(`window=${w}`).window).toBe(w);
	});
});

describe('radar-stream cursor', () => {
	const T0 = microIso(new Date('2026-08-16T06:00:00.000Z'));

	// Postgres renders created_at through
	// to_char(… 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), which is what the poll query
	// selects as cursor_at. Same shape, six fractional digits, always.
	const pg = (s) => s;

	it('pads a Date to the width Postgres emits', () => {
		expect(microIso(new Date('2026-08-16T06:00:00.000Z'))).toBe('2026-08-16T06:00:00.000000Z');
		expect(microIso(new Date('2026-08-16T06:00:00.007Z'))).toBe('2026-08-16T06:00:00.007000Z');
		expect(microIso(new Date('2026-08-16T06:00:00.000Z'))).toHaveLength(27);
	});

	// Bug 1: Neon returns timestamptz as a Date, and `aDate > anIsoString`
	// coerces both to numbers, making the string NaN and the comparison always
	// false. The cursor froze at connect time, so every poll re-sent the same
	// precursors and the live tape filled with duplicates.
	it('advances past a Date row, which a raw > comparison never did', () => {
		const row = new Date('2026-08-16T06:00:05.000Z');
		expect(row > T0).toBe(false); // the original expression
		expect(advanceCursor(T0, row)).toBe('2026-08-16T06:00:05.000000Z');
	});

	// Bug 2: created_at carries microseconds a JS Date cannot hold, so a cursor
	// truncated to milliseconds stayed strictly below the row it came from and
	// `created_at > cursor` matched that same row on every subsequent poll. The
	// cursor has to be the string Postgres itself rendered.
	it('advances to the full microsecond precision Postgres reports', () => {
		const cursorAt = pg('2026-08-16T06:00:05.216673Z');
		expect(advanceCursor(T0, cursorAt)).toBe(cursorAt);
		// The truncated form would have sorted BELOW the real row and re-matched it.
		expect(microIso(new Date('2026-08-16T06:00:05.216Z')) < cursorAt).toBe(true);
		// Advancing again with the same row is a no-op, so it is emitted once.
		expect(advanceCursor(cursorAt, cursorAt)).toBe(cursorAt);
	});

	it('never rewinds on an older or equal row', () => {
		expect(advanceCursor(T0, new Date('2026-08-16T05:59:00.000Z'))).toBe(T0);
		expect(advanceCursor(T0, new Date('2026-08-16T06:00:00.000Z'))).toBe(T0);
		expect(advanceCursor(pg('2026-08-16T06:00:05.216673Z'), pg('2026-08-16T06:00:05.216670Z')))
			.toBe('2026-08-16T06:00:05.216673Z');
	});

	it('ignores a missing timestamp', () => {
		expect(advanceCursor(T0, null)).toBe(T0);
		expect(advanceCursor(T0, undefined)).toBe(T0);
	});

	it('keeps the newest timestamp across a batch of rows', () => {
		const rows = [
			pg('2026-08-16T06:00:01.000100Z'),
			pg('2026-08-16T06:00:09.000002Z'),
			pg('2026-08-16T06:00:04.999999Z'),
		];
		let cursor = T0;
		for (const at of rows) cursor = advanceCursor(cursor, at);
		expect(cursor).toBe('2026-08-16T06:00:09.000002Z');
	});
});
