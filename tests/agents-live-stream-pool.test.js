/**
 * /agents-live wall: the SSE pool sizing and the shared activity row mapper.
 *
 * The wall used to open one EventSource per card. A browser allows 6 concurrent
 * connections per origin over HTTP/1.1 and an SSE stream never gives its slot
 * back, so on a 48-card roster the first six connected and the other 42 sat on
 * "Connecting" forever while the page's own fetches queued behind them. Two
 * pieces of that fix are pure and pinned here:
 *
 *   streamPoolSize(): the pool ceiling must come from the origin's real
 *   transport, and must stay under the HTTP/1.1 socket budget (leaving room for
 *   the page's own requests) whenever the transport is not multiplexed.
 *
 *   rowToEntry(): the batched wall endpoint and the per-agent SSE stream both
 *   turn `agent_actions` rows into card lines. They share one mapper precisely
 *   so a batched row and a streamed row can never render differently.
 */

import { describe, it, expect } from 'vitest';
import { streamPoolSize } from '../src/shared/stream-pool.js';
import { rowToEntry } from '../api/_lib/agent-activity.js';

// Chrome's per-origin socket limit for HTTP/1.1. An SSE stream holds its socket
// for the life of the stream, so the pool has to stay strictly below this or the
// page starves its own roster/balances fetches.
const HTTP1_SOCKET_LIMIT = 6;

describe('streamPoolSize', () => {
	it('stays under the HTTP/1.1 socket budget on a non-multiplexed origin', () => {
		expect(streamPoolSize('http/1.1')).toBeLessThan(HTTP1_SOCKET_LIMIT);
		expect(streamPoolSize('http/1.0')).toBeLessThan(HTTP1_SOCKET_LIMIT);
	});

	it('allows a wider pool on a multiplexed transport', () => {
		expect(streamPoolSize('h2')).toBeGreaterThan(streamPoolSize('http/1.1'));
		expect(streamPoolSize('h3')).toBe(streamPoolSize('h2'));
		expect(streamPoolSize('h3-29')).toBe(streamPoolSize('h2'));
		expect(streamPoolSize('HTTP/2')).toBe(streamPoolSize('h2'));
	});

	it('falls back to the conservative pool when the transport is unknown', () => {
		// performance.getEntriesByType('navigation') reports '' from a cache hit and
		// on browsers that withhold it; guessing h2 there would starve the page.
		for (const unknown of ['', null, undefined, 'spdy/3.1']) {
			expect(streamPoolSize(unknown)).toBeLessThan(HTTP1_SOCKET_LIMIT);
		}
	});

	it('never returns a pool that cannot hold a single stream', () => {
		for (const p of ['', 'http/1.1', 'h2', 'h3']) expect(streamPoolSize(p)).toBeGreaterThan(0);
	});
});

describe('rowToEntry', () => {
	const created = new Date('2026-08-16T12:00:00.000Z');

	it('prefers the holder-readable summary over the raw type', () => {
		const e = rowToEntry({ type: 'pumpfun.launch', payload: { summary: 'Launched $THREE' }, created_at: created });
		expect(e).toEqual({ ts: created.getTime(), activity: 'Launched $THREE', type: 'pumpfun.launch' });
	});

	it('falls back through detail and title before settling on the type', () => {
		expect(rowToEntry({ type: 'a', payload: { detail: 'd' }, created_at: created }).activity).toBe('d');
		expect(rowToEntry({ type: 'a', payload: { title: 't' }, created_at: created }).activity).toBe('t');
		expect(rowToEntry({ type: 'load-end', payload: {}, created_at: created }).activity).toBe('load-end');
		expect(rowToEntry({ payload: null, created_at: created }).activity).toBe('action');
	});

	it('carries the market-maker sidecar so a backfill can drive the floor badge', () => {
		const e = rowToEntry({
			type: 'mm_defend',
			payload: { summary: 'defended', floorSol: 0.5, priceSol: 0.51, sizeSol: 2, sideBuy: true, simulate: true },
			created_at: created,
		});
		expect(e.mm).toEqual({
			type: 'mm_defend',
			floorSol: 0.5,
			priceSol: 0.51,
			sizeSol: 2,
			sideBuy: true,
			simulate: true,
			signature: null,
			mint: null,
		});
	});

	it('omits the sidecar for a non-market-maker row and for an mm row with no prices', () => {
		expect(rowToEntry({ type: 'speak', payload: { floorSol: 1 }, created_at: created }).mm).toBeUndefined();
		expect(rowToEntry({ type: 'mm_tick', payload: { summary: 'x' }, created_at: created }).mm).toBeUndefined();
	});

	it('tolerates a row with no timestamp rather than emitting NaN', () => {
		expect(Number.isFinite(rowToEntry({ type: 'speak', payload: {} }).ts)).toBe(true);
	});
});
