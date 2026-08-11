/**
 * Queue-position math for the on-demand caster handoff (api/agent/watch-status.js).
 *
 * The live wall and watch panel show "warming up" vs "queued · #N in line" based
 * on an agent's reverse-rank in the `screen:wanted` set relative to the pool's
 * MAX_BROWSERS. The wall's honesty depends on this one formula:
 *
 *   ranks 0..MAX-1  → warming  (within casting capacity)
 *   rank  >= MAX    → queued, position = rank - MAX + 1  (1-based, behind the pool)
 *
 * If this drifts, viewers are told "#0 in line" or a warming agent is shown as
 * queued — so it's pinned here.
 */

import { describe, it, expect } from 'vitest';
import { classifyRank, POOL_MAX } from '../api/agent/watch-status.js';

describe('classifyRank — caster handoff state from wanted-set rank', () => {
	const MAX = 6;

	it('classifies ranks within pool capacity as warming', () => {
		for (let rank = 0; rank < MAX; rank++) {
			expect(classifyRank(rank, MAX)).toEqual({ state: 'warming' });
		}
	});

	it('classifies the first over-capacity rank as queued #1', () => {
		expect(classifyRank(MAX, MAX)).toEqual({ state: 'queued', position: 1 });
	});

	it('computes 1-based queue position as rank - MAX + 1', () => {
		expect(classifyRank(MAX + 1, MAX)).toEqual({ state: 'queued', position: 2 });
		expect(classifyRank(MAX + 4, MAX)).toEqual({ state: 'queued', position: 5 });
		expect(classifyRank(47, MAX)).toEqual({ state: 'queued', position: 42 });
	});

	it('never reports a queue position below 1', () => {
		for (let rank = MAX; rank < MAX + 20; rank++) {
			const r = classifyRank(rank, MAX);
			expect(r.state).toBe('queued');
			expect(r.position).toBeGreaterThanOrEqual(1);
		}
	});

	it('treats an absent / out-of-set agent as the activity baseline', () => {
		expect(classifyRank(null, MAX)).toEqual({ state: 'activity' });
		expect(classifyRank(undefined, MAX)).toEqual({ state: 'activity' });
		expect(classifyRank(-1, MAX)).toEqual({ state: 'activity' });
	});

	it('honors a pool size of 1 (degenerate single-slot pool)', () => {
		expect(classifyRank(0, 1)).toEqual({ state: 'warming' });
		expect(classifyRank(1, 1)).toEqual({ state: 'queued', position: 1 });
	});

	it('falls back to the activity view when no caster pool is alive', () => {
		// warming/queued promise a real browser is coming. With no pool polling
		// watch-wanted nothing can keep that promise, so every rank reads activity
		// rather than spinning "warming up" at the viewer forever.
		for (const rank of [0, MAX - 1, MAX, MAX + 9]) {
			expect(classifyRank(rank, MAX, { poolAlive: false })).toEqual({ state: 'activity' });
		}
		// An explicitly live pool keeps the normal handoff.
		expect(classifyRank(0, MAX, { poolAlive: true })).toEqual({ state: 'warming' });
		expect(classifyRank(MAX, MAX, { poolAlive: true })).toEqual({ state: 'queued', position: 1 });
	});

	it('defaults to the documented POOL_MAX when no max is passed', () => {
		expect(POOL_MAX).toBeGreaterThanOrEqual(1);
		// At rank = POOL_MAX the agent is exactly one slot over capacity → queued #1.
		expect(classifyRank(POOL_MAX)).toEqual({ state: 'queued', position: 1 });
		expect(classifyRank(POOL_MAX - 1)).toEqual({ state: 'warming' });
	});
});
