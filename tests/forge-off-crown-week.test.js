// resolveWeekStart: which Monday the Forge-Off crowning applies to.
//
// This is the input guard on an IRREVERSIBLE write. A crowning is permanent by
// design (forge_board_winners has ON CONFLICT (week_start) DO NOTHING, so the
// first crowning for a week wins forever), and `?week=` is the owner's backfill
// override. Before 2026-08-10 an unparseable date silently fell through to the
// default week, so `?week=2026-13-99` did not error: it permanently crowned the
// CURRENT week instead of the one the owner typed, with no way to undo it.
// Unparseable input must therefore be rejected, never guessed.

import { describe, it, expect } from 'vitest';
import { resolveWeekStart } from '../api/cron/forge-off-crown.js';

const key = (d) => d.toISOString().slice(0, 10);

describe('resolveWeekStart', () => {
	it('defaults to the Monday of the week that just completed', () => {
		const resolved = resolveWeekStart(null);
		expect(resolved).toBeInstanceOf(Date);
		// Always a Monday (UTC day 1), and strictly in the past.
		expect(resolved.getUTCDay()).toBe(1);
		expect(resolved.getTime()).toBeLessThan(Date.now());
	});

	it('accepts an explicit Monday and returns exactly that week', () => {
		expect(key(resolveWeekStart('2026-07-27'))).toBe('2026-07-27');
	});

	it('snaps a mid-week backfill date to its own week Monday', () => {
		// Thu 2026-07-30 and Sun 2026-08-02 both belong to the 2026-07-27 week.
		expect(key(resolveWeekStart('2026-07-30'))).toBe('2026-07-27');
		expect(key(resolveWeekStart('2026-08-02'))).toBe('2026-07-27');
	});

	it('rejects an unparseable week instead of crowning the default one', () => {
		// The whole point: each of these used to resolve to the default week and
		// perform a permanent write against it.
		expect(resolveWeekStart('2026-13-99')).toBeNull();
		expect(resolveWeekStart('not-a-date')).toBeNull();
		expect(resolveWeekStart('2026-07')).toBeNull();
		expect(resolveWeekStart('last monday please')).toBeNull();
		expect(resolveWeekStart("2026-08-03'; DROP TABLE forge_board_winners;--")).toBeNull();
	});

	it('treats an empty week param as absent, not as invalid', () => {
		// `?week=` with no value is the same as omitting it; the cron's own
		// schedule hits this path, and it must not start 400ing.
		expect(resolveWeekStart('')).toBeInstanceOf(Date);
		expect(resolveWeekStart(undefined)).toBeInstanceOf(Date);
	});
});
