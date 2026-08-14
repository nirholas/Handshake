// Regression for TASK-7: when the Redis usage buffer is down, every event takes
// the direct-insert fallback. A slow/wedged Neon must NOT hold that work open for
// the 15s default DB budget (the storm of `db query exceeded 15000ms deadline`
// errors that was stalling the avatar API). The fallback runs under a short,
// bounded per-event timeout and never throws back to the (detached) caller.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Redis buffer unavailable → recordEvent must fall through to direct insert.
vi.mock('../api/_lib/redis.js', () => ({ getRedis: () => null }));

// QStash disabled so no flush-job side effects fire during the test.
vi.mock('../api/_lib/qstash.js', () => ({
	qstashEnabled: () => false,
	publishJob: vi.fn(async () => {}),
}));

// A `sql` tagged template that never settles — models a wedged Neon connection
// (the failure mode db-retry's deadline exists to abandon).
vi.mock('../api/_lib/db.js', () => ({
	sql: () => new Promise(() => {}),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

import { recordEvent } from '../api/_lib/usage.js';

describe('recordEvent direct-insert fallback (buffer down)', () => {
	beforeEach(() => vi.restoreAllMocks());
	afterEach(() => vi.restoreAllMocks());

	it('does not block the caller and bounds a wedged insert well under the 15s budget', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

		const startedAt = Date.now();
		// recordEvent is fire-and-forget: it must return synchronously (undefined),
		// never awaiting the DB write.
		const ret = recordEvent({ userId: 'u1', kind: 'avatar_fetch' });
		expect(ret).toBeUndefined();
		// The `sql` mock above never settles, so a recordEvent that awaited the
		// write could not have returned here at all. The wall-clock bound is only a
		// second smoke check on top of that, and it is set well under the 2500ms
		// fallback budget rather than at a few milliseconds: a fork descheduled by
		// its five busy peers can lose tens of milliseconds between two statements,
		// which says nothing about whether this call blocks.
		expect(Date.now() - startedAt).toBeLessThan(1_000);

		// Wait past the 2.5s fallback budget (plus retry backoff) but far under 15s.
		await new Promise((r) => setTimeout(r, 4_000));

		const elapsed = Date.now() - startedAt;
		expect(elapsed).toBeLessThan(10_000);

		// The bounded write times out and is swallowed with a deadline warning that
		// names the SHORT budget, not the 15s default.
		const msgs = warn.mock.calls.map((c) => `${c[0]} ${c[1] ?? ''}`);
		const deadlineWarn = msgs.find((m) => m.includes('[usage] write failed'));
		expect(deadlineWarn).toBeTruthy();
		expect(deadlineWarn).toContain('2500ms deadline');
		expect(deadlineWarn).not.toContain('15000ms');
	}, 15_000);
});
