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
