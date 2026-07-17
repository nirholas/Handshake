// Creator streak — the anonymous-first "come back tomorrow" mechanic for Daily
// Forge. The logged-in retention system (api/_lib/streaks.js) needs an account;
// the majority of forgers are anonymous, so this covers them with a pure,
// localStorage-backed streak keyed to the browser. No login, no network.
//
// All logic here is a pure state machine over { current, best, lastDay, total }
// and a UTC day key — storage and the clock are injected by the caller, so it
// unit-tests exactly and can never drift on a timezone or a double-count.

/** Days between two UTC 'YYYY-MM-DD' keys (b - a), or null if either is unusable. */
export function daysBetween(a, b) {
	const ta = Date.parse(`${a}T00:00:00Z`);
	const tb = Date.parse(`${b}T00:00:00Z`);
	if (Number.isNaN(ta) || Number.isNaN(tb)) return null;
	return Math.round((tb - ta) / 86_400_000);
}

/** A fresh streak state (never created yet). */
export function emptyStreak() {
	return { current: 0, best: 0, lastDay: '', total: 0 };
}

/**
 * Advance a streak for a qualifying action (a finished forge) on `today`.
 * Idempotent per day: acting five times today only counts once. A one-day gap
 * (yesterday → today) extends the streak; a longer gap resets it to 1.
 *
 * @param {{current:number,best:number,lastDay:string,total:number}} prev
 * @param {string} today  UTC 'YYYY-MM-DD'.
 * @returns {{ state: object, changed: boolean, milestone: number|null }}
 *   changed: whether today added a new active day; milestone: a streak length
 *   just reached that's worth celebrating (3/7/14/30/50/100/365), else null.
 */
export function recordDay(prev, today) {
	const state = { ...emptyStreak(), ...(prev || {}) };
	if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) {
		return { state, changed: false, milestone: null };
	}
	if (state.lastDay === today) {
		// Already counted today — no change, no re-celebration.
		return { state, changed: false, milestone: null };
	}
	const gap = state.lastDay ? daysBetween(state.lastDay, today) : null;
	if (gap === 1) {
		state.current += 1; // consecutive day
	} else if (gap != null && gap <= 0) {
		// Clock skew / a day key "before" lastDay — count the action but don't
		// corrupt the streak (treat as same-period, no increment beyond floor 1).
		state.current = Math.max(state.current, 1);
	} else {
		state.current = 1; // first ever, or a broken streak restarts
	}
	state.lastDay = today;
	state.total += 1;
	state.best = Math.max(state.best, state.current);
	return { state, changed: true, milestone: milestoneFor(state.current) };
}

const MILESTONES = [3, 7, 14, 30, 50, 100, 365];

/** The milestone exactly reached at a given streak length, or null. */
export function milestoneFor(current) {
	return MILESTONES.includes(current) ? current : null;
}

/**
 * The live streak "status" for display, given the last stored state and today.
 * A streak stays "active" through today; if the user hasn't acted today it's
 * "at risk" (act today to keep it) until the day after lastDay, then "broken"
 * (the displayed current resets to 0 for a stale streak).
 *
 * @param {object} state
 * @param {string} today  UTC 'YYYY-MM-DD'.
 * @returns {{ current:number, best:number, total:number, actedToday:boolean, atRisk:boolean }}
 */
export function streakStatus(state, today) {
	const s = { ...emptyStreak(), ...(state || {}) };
	if (!s.lastDay) return { current: 0, best: s.best, total: s.total, actedToday: false, atRisk: false };
	const gap = daysBetween(s.lastDay, today);
	if (gap === 0) return { current: s.current, best: s.best, total: s.total, actedToday: true, atRisk: false };
	if (gap === 1) return { current: s.current, best: s.best, total: s.total, actedToday: false, atRisk: true };
	// Two or more days since the last action → the streak has lapsed.
	return { current: 0, best: s.best, total: s.total, actedToday: false, atRisk: false };
}

// ── Storage (browser) ─────────────────────────────────────────────────────────
const KEY = 'twx_daily_streak_v1';

/** Read the stored streak (safe: bad/absent data → empty). */
export function loadStreak(storage = safeStorage()) {
	if (!storage) return emptyStreak();
	try {
		const raw = storage.getItem(KEY);
		if (!raw) return emptyStreak();
		const v = JSON.parse(raw);
		return {
			current: Number(v.current) || 0,
			best: Number(v.best) || 0,
			lastDay: typeof v.lastDay === 'string' ? v.lastDay : '',
			total: Number(v.total) || 0,
		};
	} catch {
		return emptyStreak();
	}
}

export function saveStreak(state, storage = safeStorage()) {
	if (!storage) return;
	try { storage.setItem(KEY, JSON.stringify(state)); } catch { /* private mode */ }
}

function safeStorage() {
	try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
}
