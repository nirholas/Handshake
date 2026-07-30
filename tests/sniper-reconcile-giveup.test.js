// The unreconcilable-position give-up clock.
//
// A position parks as `reconcile_pending` when its bag is provably gone from the
// wallet but the tx that emptied it cannot be found. That park was unbounded in
// production: five positions wedged at once (one for 40+ hours), each holding one
// of its arm's max_concurrent_positions slots, which is what stopped the fleet
// from taking new trades. These tests pin the bound.

import { describe, it, expect } from 'vitest';
import { shouldGiveUpReconcile, reconcileParkAnchor } from '../workers/agent-sniper/exit-logic.js';

const SIX_HOURS = 6 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 6, 27, 17, 0, 0);

describe('shouldGiveUpReconcile', () => {
	it('never fires for a position that is not parked', () => {
		expect(shouldGiveUpReconcile(null, SIX_HOURS, NOW)).toBe(false);
		expect(shouldGiveUpReconcile(undefined, SIX_HOURS, NOW)).toBe(false);
	});

	it('holds while the park is inside the window (RPC history lag is seconds to minutes)', () => {
		const oneMinuteAgo = new Date(NOW - 60_000).toISOString();
		expect(shouldGiveUpReconcile(oneMinuteAgo, SIX_HOURS, NOW)).toBe(false);

		const almost = new Date(NOW - (SIX_HOURS - 1)).toISOString();
		expect(shouldGiveUpReconcile(almost, SIX_HOURS, NOW)).toBe(false);
	});

	it('fires exactly at the boundary and beyond', () => {
		expect(shouldGiveUpReconcile(new Date(NOW - SIX_HOURS).toISOString(), SIX_HOURS, NOW)).toBe(true);

		// The real production wedge: parked 40 hours, slot held the whole time.
		const fortyHours = new Date(NOW - 40 * 60 * 60 * 1000).toISOString();
		expect(shouldGiveUpReconcile(fortyHours, SIX_HOURS, NOW)).toBe(true);
	});

	it('accepts a Date as well as an ISO string (the DB driver returns Date)', () => {
		expect(shouldGiveUpReconcile(new Date(NOW - SIX_HOURS), SIX_HOURS, NOW)).toBe(true);
		expect(shouldGiveUpReconcile(new Date(NOW - 1000), SIX_HOURS, NOW)).toBe(false);
	});

	it('treats an unparseable timestamp as "do not give up" rather than closing a live position', () => {
		expect(shouldGiveUpReconcile('not-a-date', SIX_HOURS, NOW)).toBe(false);
	});

	it('is inert when no window is configured, so a misconfig cannot mass-close positions', () => {
		const old = new Date(NOW - 40 * 60 * 60 * 1000).toISOString();
		expect(shouldGiveUpReconcile(old, 0, NOW)).toBe(false);
		expect(shouldGiveUpReconcile(old, null, NOW)).toBe(false);
	});

	it('does not fire on a future timestamp (clock skew must not close a fresh park)', () => {
		expect(shouldGiveUpReconcile(new Date(NOW + 60_000).toISOString(), SIX_HOURS, NOW)).toBe(false);
	});
});

// The anchor feeding that clock. A row parked before `reconcile_pending_since`
// existed carries the park marker with no timestamp, and a null reads as "not
// parked" above, so those rows could never be reaped. Four arms sat frozen for
// 37 to 57 hours against a 30-minute max hold because of it.
describe('reconcileParkAnchor', () => {
	const iso = (ms) => new Date(ms).toISOString();

	it('uses reconcile_pending_since whenever it is set', () => {
		const since = iso(NOW - SIX_HOURS);
		expect(reconcileParkAnchor({
			reconcile_pending_since: since,
			error: 'reconcile_pending',
			stale_since: iso(NOW - 40 * 60 * 60 * 1000),
		})).toBe(since);
	});

	it('prefers reconcile_pending_since even when the row is not marked parked', () => {
		const since = iso(NOW - 1000);
		expect(reconcileParkAnchor({ reconcile_pending_since: since, error: null })).toBe(since);
	});

	it('returns null for a position that is not parked', () => {
		expect(reconcileParkAnchor({ reconcile_pending_since: null, error: null })).toBe(null);
		expect(reconcileParkAnchor({ error: 'graduated:amm_entry', stale_since: iso(NOW) })).toBe(null);
		expect(reconcileParkAnchor({})).toBe(null);
		expect(reconcileParkAnchor(null)).toBe(null);
	});

	it('falls back to stale_since on a parked row with no park timestamp', () => {
		const stale = iso(NOW - 40 * 60 * 60 * 1000);
		expect(reconcileParkAnchor({
			reconcile_pending_since: null,
			error: 'reconcile_pending',
			stale_since: stale,
			opened_at: iso(NOW - 57 * 60 * 60 * 1000),
		})).toBe(stale);
	});

	it('falls back to opened_at when there is no stale_since either', () => {
		const opened = iso(NOW - 57 * 60 * 60 * 1000);
		expect(reconcileParkAnchor({
			reconcile_pending_since: null,
			error: 'reconcile_pending',
			stale_since: null,
			opened_at: opened,
		})).toBe(opened);
	});

	it('makes the legacy wedge reapable instead of permanent', () => {
		// The exact production shape: parked marker, no park timestamp, stale for
		// 57 hours. Before the anchor this returned null and never gave up.
		const wedged = {
			reconcile_pending_since: null,
			error: 'reconcile_pending',
			stale_since: iso(NOW - 57 * 60 * 60 * 1000),
			opened_at: iso(NOW - 57 * 60 * 60 * 1000),
		};
		expect(shouldGiveUpReconcile(wedged.reconcile_pending_since, SIX_HOURS, NOW)).toBe(false);
		expect(shouldGiveUpReconcile(reconcileParkAnchor(wedged), SIX_HOURS, NOW)).toBe(true);
	});

	it('still gives a fresh park its full window', () => {
		const justParked = {
			reconcile_pending_since: null,
			error: 'reconcile_pending',
			stale_since: iso(NOW - 60_000),
			opened_at: iso(NOW - 30 * 60 * 1000),
		};
		expect(shouldGiveUpReconcile(reconcileParkAnchor(justParked), SIX_HOURS, NOW)).toBe(false);
	});
});
