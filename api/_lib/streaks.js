/**
 * Cross-surface streaks + badges — the retention layer for the unified
 * leaderboard (prompt 06 of the user-value pack).
 *
 * A "qualifying action" is any of:
 *   · a session login/refresh          (api/_lib/auth.js createSession)
 *   · a finished forge model            (api/_lib/forge-store.js materializeCreation)
 *   · a saved world                     (api/_lib/diorama-store.js saveDiorama)
 *   · a /walk activity batch            (api/walk/metrics.js, signed-in walkers only)
 *
 * Each of those call sites calls recordDailyActivity(userId) after its own
 * write succeeds. The upsert here is idempotent per UTC day — calling it
 * five times in one day (five creations, a login, a walk) only ever counts
 * once toward the streak, so instrumenting multiple call sites is safe and
 * cannot inflate a streak beyond one increment per real day.
 *
 * Badges are earned records, not computed-on-the-fly trophies: once unlocked
 * a row in user_badges never disappears, even if the underlying stat that
 * earned it later changes (e.g. a creation is later deleted).
 */

import { sql, isDbUnavailableError } from './db.js';

export const BADGES = Object.freeze({
	FIRST_CREATION: 'first_creation',
	FIRST_REMIX_RECEIVED: 'first_remix_received',
	STREAK_7: 'streak_7',
	TOP10: (metric) => `top10_${metric}`,
});

export const BADGE_META = {
	first_creation: {
		label: 'First Creation',
		description: 'Forged your first 3D model or built your first world.',
		icon: '✨',
	},
	first_remix_received: {
		label: 'Remixed',
		description: 'Another creator built on top of one of your creations.',
		icon: '🔀',
	},
	streak_7: {
		label: '7-Day Streak',
		description: 'Showed up on three.ws seven days running.',
		icon: '🔥',
	},
};

function top10Meta(metric) {
	const labels = {
		creations: 'Creations',
		remixes_received: 'Remixes Received',
		launches: 'Launches',
		followers: 'Followers',
		walk_distance: 'Walk Distance',
	};
	return {
		label: `Top 10 · ${labels[metric] || metric}`,
		description: `Ranked in the top 10 platform-wide for ${labels[metric] || metric}.`,
		icon: '🏆',
	};
}

/** Static or computed metadata for a badge code — used to render it anywhere. */
export function badgeMeta(code) {
	if (BADGE_META[code]) return BADGE_META[code];
	const m = /^top10_(.+)$/.exec(code);
	if (m) return top10Meta(m[1]);
	return { label: code, description: '', icon: '★' };
}

/**
 * Award a badge once. Idempotent (unique on user_id+code) — safe to call
 * every time the qualifying condition is checked, not just on the crossing.
 * @returns {Promise<boolean>} true if this call newly unlocked it.
 */
export async function unlockBadge(userId, code, context = null) {
	if (!userId || !code) return false;
	try {
		const rows = await sql`
			insert into user_badges (user_id, code, context)
			values (${userId}, ${code}, ${context ? JSON.stringify(context) : null}::jsonb)
			on conflict (user_id, code) do nothing
			returning id
		`;
		return rows.length > 0;
	} catch (err) {
		if (isDbUnavailableError(err)) console.warn('[streaks] unlockBadge skipped (db unavailable):', err?.message);
		else console.error('[streaks] unlockBadge failed:', err?.message);
		return false;
	}
}

/** All badges a user has earned, newest first. */
export async function listBadges(userId) {
	if (!userId) return [];
	try {
		const rows = await sql`
			select code, context, unlocked_at
			from user_badges
			where user_id = ${userId}
			order by unlocked_at desc
		`;
		return rows.map((r) => ({ code: r.code, context: r.context ?? null, unlockedAt: r.unlocked_at, ...badgeMeta(r.code) }));
	} catch (err) {
		if (isDbUnavailableError(err)) console.warn('[streaks] listBadges skipped (db unavailable):', err?.message);
		else console.error('[streaks] listBadges failed:', err?.message);
		return [];
	}
}

function todayUTC() {
	return new Date().toISOString().slice(0, 10);
}

/**
 * Record today as an active day for a user and roll the streak forward.
 * Same-day repeats are a no-op (idempotent). A gap of 1+ missed UTC days
 * resets current_streak to 1. Awards the streak_7 badge on crossing.
 *
 * @returns {Promise<{currentStreak:number, longestStreak:number, lastActiveDay:string}|null>}
 */
export async function recordDailyActivity(userId) {
	if (!userId) return null;
	const today = todayUTC();
	try {
		const [row] = await sql`
			insert into user_streaks (user_id, current_streak, longest_streak, last_active_day)
			values (${userId}, 1, 1, ${today})
			on conflict (user_id) do update set
				current_streak = case
					when user_streaks.last_active_day = ${today}::date then user_streaks.current_streak
					when user_streaks.last_active_day = ${today}::date - 1 then user_streaks.current_streak + 1
					else 1
				end,
				longest_streak = greatest(
					user_streaks.longest_streak,
					case
						when user_streaks.last_active_day = ${today}::date then user_streaks.current_streak
						when user_streaks.last_active_day = ${today}::date - 1 then user_streaks.current_streak + 1
						else 1
					end
				),
				last_active_day = ${today}::date,
				updated_at = now()
			returning current_streak, longest_streak, last_active_day
		`;
		if (!row) return null;
		if (row.current_streak >= 7) await unlockBadge(userId, BADGES.STREAK_7);
		return {
			currentStreak: row.current_streak,
			longestStreak: row.longest_streak,
			lastActiveDay: row.last_active_day,
		};
	} catch (err) {
		if (isDbUnavailableError(err)) console.warn('[streaks] recordDailyActivity skipped (db unavailable):', err?.message);
		else console.error('[streaks] recordDailyActivity failed:', err?.message);
		return null;
	}
}

/**
 * Award the "first creation" badge the moment a user's combined forge-model +
 * world count reaches 1. Reads forge_creations/dioramas directly (not through
 * forge-store.js/diorama-store.js) so this module has no dependency on either
 * store — both of them depend on streaks.js, not the other way around.
 */
export async function maybeAwardFirstCreation(userId) {
	if (!userId) return false;
	try {
		const [row] = await sql`
			select
				(select count(*)::int from forge_creations where user_id = ${userId} and status = 'done' and glb_url is not null)
				+ (select count(*)::int from dioramas where user_id = ${userId}) as total
		`;
		if ((row?.total ?? 0) >= 1) return await unlockBadge(userId, BADGES.FIRST_CREATION);
		return false;
	} catch (err) {
		if (isDbUnavailableError(err)) console.warn('[streaks] maybeAwardFirstCreation skipped (db unavailable):', err?.message);
		else console.error('[streaks] maybeAwardFirstCreation failed:', err?.message);
		return false;
	}
}

/** Read a user's current streak without recording activity. */
export async function getStreak(userId) {
	if (!userId) return null;
	try {
		const [row] = await sql`
			select current_streak, longest_streak, last_active_day
			from user_streaks
			where user_id = ${userId}
		`;
		if (!row) return { currentStreak: 0, longestStreak: 0, lastActiveDay: null };
		// A streak "expires" the moment two UTC days have passed with no activity —
		// reflect that on read even before the next recordDailyActivity() rolls it
		// over, so a stale streak never displays as still-alive.
		const today = todayUTC();
		const last = row.last_active_day ? String(row.last_active_day) : null;
		const isBroken = last && last !== today && new Date(today) - new Date(last) > 86400000;
		return {
			currentStreak: isBroken ? 0 : row.current_streak,
			longestStreak: row.longest_streak,
			lastActiveDay: last,
		};
	} catch (err) {
		if (isDbUnavailableError(err)) console.warn('[streaks] getStreak skipped (db unavailable):', err?.message);
		else console.error('[streaks] getStreak failed:', err?.message);
		return null;
	}
}
