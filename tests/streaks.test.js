/**
 * api/_lib/streaks.js — cross-surface streak + badge logic (prompt 06 of the
 * user-value pack).
 *
 * The upsert SQL that rolls a streak forward, the read-side decay check that
 * shows a streak as broken before the next write happens, and badge idempotency
 * are all exercised here against a mocked `sql` — matching this repo's
 * forge-store test convention (tests/forge-store-materialize.test.js).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let lastQuery = '';
const sqlMock = vi.fn(async (strings, ...values) => {
	lastQuery = strings.join(' ');
	return sqlMock.__nextResult ?? [];
});

vi.mock('../api/_lib/db.js', () => ({
	sql: (...args) => sqlMock(...args),
	isDbUnavailableError: () => false,
}));

const { recordDailyActivity, getStreak, unlockBadge, listBadges, maybeAwardFirstCreation, BADGES, badgeMeta } =
	await import('../api/_lib/streaks.js');

beforeEach(() => {
	sqlMock.mockClear();
	sqlMock.__nextResult = [];
});

describe('recordDailyActivity', () => {
	it('returns null without touching the db when userId is missing', async () => {
		const out = await recordDailyActivity(null);
		expect(out).toBeNull();
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('upserts into user_streaks and returns the rolled-forward streak', async () => {
		sqlMock.__nextResult = [{ current_streak: 3, longest_streak: 5, last_active_day: '2026-07-12' }];
		const out = await recordDailyActivity('user-1');
		expect(lastQuery).toContain('insert into user_streaks');
		expect(lastQuery).toContain('on conflict');
		expect(out).toEqual({ currentStreak: 3, longestStreak: 5, lastActiveDay: '2026-07-12' });
	});

	it('unlocks the streak_7 badge once current_streak crosses 7', async () => {
		sqlMock.__nextResult = [{ current_streak: 7, longest_streak: 7, last_active_day: '2026-07-12' }];
		await recordDailyActivity('user-1');
		// recordDailyActivity → unlockBadge → a second sql() call for the insert.
		const calls = sqlMock.mock.calls.map((c) => c[0].join(' '));
		expect(calls.some((q) => q.includes('insert into user_badges'))).toBe(true);
	});

	it('does not unlock streak_7 below the threshold', async () => {
		sqlMock.__nextResult = [{ current_streak: 6, longest_streak: 6, last_active_day: '2026-07-12' }];
		await recordDailyActivity('user-1');
		const calls = sqlMock.mock.calls.map((c) => c[0].join(' '));
		expect(calls.some((q) => q.includes('insert into user_badges'))).toBe(false);
	});

	it('fails soft (returns null) on a db error rather than throwing', async () => {
		sqlMock.mockImplementationOnce(async () => {
			throw new Error('connection reset');
		});
		const out = await recordDailyActivity('user-1');
		expect(out).toBeNull();
	});
});

describe('getStreak', () => {
	it('returns zeros for a user with no streak row', async () => {
		sqlMock.__nextResult = [];
		const out = await getStreak('user-1');
		expect(out).toEqual({ currentStreak: 0, longestStreak: 0, lastActiveDay: null });
	});

	it('reports the live streak when last_active_day is today or yesterday', async () => {
		const today = new Date().toISOString().slice(0, 10);
		sqlMock.__nextResult = [{ current_streak: 4, longest_streak: 9, last_active_day: today }];
		const out = await getStreak('user-1');
		expect(out.currentStreak).toBe(4);
	});

	it('shows a streak as broken (0) once 2+ UTC days have passed with no activity', async () => {
		const threeDaysAgo = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
		sqlMock.__nextResult = [{ current_streak: 12, longest_streak: 12, last_active_day: threeDaysAgo }];
		const out = await getStreak('user-1');
		expect(out.currentStreak).toBe(0);
		expect(out.longestStreak).toBe(12); // longest is a durable record, never reset
	});
});

describe('unlockBadge / listBadges', () => {
	it('unlockBadge is a no-op without a userId or code', async () => {
		expect(await unlockBadge(null, 'x')).toBe(false);
		expect(await unlockBadge('user-1', null)).toBe(false);
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('returns true only when the insert actually landed a new row (ON CONFLICT DO NOTHING)', async () => {
		sqlMock.__nextResult = [{ id: '1' }];
		expect(await unlockBadge('user-1', BADGES.STREAK_7)).toBe(true);
		sqlMock.__nextResult = [];
		expect(await unlockBadge('user-1', BADGES.STREAK_7)).toBe(false);
	});

	it('listBadges shapes rows with display metadata', async () => {
		sqlMock.__nextResult = [{ code: 'first_creation', context: null, unlocked_at: '2026-07-12T00:00:00Z' }];
		const out = await listBadges('user-1');
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({ code: 'first_creation', label: 'First Creation' });
	});
});

describe('badgeMeta', () => {
	it('resolves a dynamic top10_<metric> badge to a labeled description', () => {
		const meta = badgeMeta('top10_walk_distance');
		expect(meta.label).toContain('Walk Distance');
		expect(meta.icon).toBe('🏆');
	});

	it('falls back to the raw code for an unknown badge', () => {
		expect(badgeMeta('mystery_code').label).toBe('mystery_code');
	});
});

describe('maybeAwardFirstCreation', () => {
	it('does not award the badge when the user has zero creations', async () => {
		sqlMock.__nextResult = [{ total: 0 }];
		expect(await maybeAwardFirstCreation('user-1')).toBe(false);
	});

	it('awards the badge once total creations reaches 1', async () => {
		sqlMock.mockImplementation(async (strings) => {
			const text = strings.join(' ');
			if (text.includes('select')) return [{ total: 1 }];
			return [{ id: '1' }]; // the badge insert
		});
		expect(await maybeAwardFirstCreation('user-1')).toBe(true);
	});
});
