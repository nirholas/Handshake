/**
 * /api/x402/pump-agent-audit: LIST-mode summary shape.
 *
 * The list response carries both an ordering (`launches`, re-ranked when
 * sort=liquidity) and a headline (`newest_mint` / `newest_name` /
 * `newest_symbol`). Those are two different questions, and the summary used to
 * answer the second by reading index 0 of the already-liquidity-sorted array,
 * so under sort=liquidity it reported the deepest-liquidity launch as the
 * newest one. It only ever looked correct when the two happened to be the same
 * coin, which is exactly what a live spot-check sees most of the time.
 *
 * Mints below are synthetic; nothing here touches pump.fun or the DB.
 */

import { describe, it, expect } from 'vitest';

import { summarizeLaunches } from '../../api/x402/pump-agent-audit.js';

// Newest-first, the order the live feed hands back. The newest launch has the
// SHALLOWEST liquidity on purpose, so a summary that reads the sorted array
// cannot accidentally be right.
const FEED = [
	{ mint: 'THREEsynthetic1111111111111111111111111newA', name: 'Alpha', symbol: 'ALPHA', created_at: 3_000, liquidity_sol: 1.5 },
	{ mint: 'THREEsynthetic1111111111111111111111111midB', name: 'Bravo', symbol: 'BRAVO', created_at: 2_000, liquidity_sol: 30 },
	{ mint: 'THREEsynthetic1111111111111111111111111oldC', name: 'Charlie', symbol: 'CHARLIE', created_at: 1_000, liquidity_sol: 12 },
];

describe('summarizeLaunches', () => {
	it('reports the newest launch and preserves feed order under sort=newest', () => {
		const out = summarizeLaunches(FEED, 'newest');
		expect(out.sort).toBe('newest');
		expect(out.count).toBe(3);
		expect(out.newest_mint).toBe(FEED[0].mint);
		expect(out.newest_name).toBe('Alpha');
		expect(out.newest_symbol).toBe('ALPHA');
		expect(out.launches.map((l) => l.name)).toEqual(['Alpha', 'Bravo', 'Charlie']);
	});

	it('still reports the NEWEST launch when the list is re-ranked by liquidity', () => {
		const out = summarizeLaunches(FEED, 'liquidity');
		expect(out.launches.map((l) => l.name)).toEqual(['Bravo', 'Charlie', 'Alpha']);
		// The headline describes the newest coin, not the deepest-liquidity one.
		expect(out.newest_mint).toBe(FEED[0].mint);
		expect(out.newest_name).toBe('Alpha');
		expect(out.newest_symbol).toBe('ALPHA');
	});

	it('does not mutate the caller feed while re-ranking', () => {
		const before = FEED.map((l) => l.name);
		summarizeLaunches(FEED, 'liquidity');
		expect(FEED.map((l) => l.name)).toEqual(before);
	});

	it('computes average and peak initial liquidity over positive reserves only', () => {
		const out = summarizeLaunches(
			[...FEED, { mint: 'THREEsynthetic11111111111111111111111zeroD', name: 'Delta', symbol: 'DELTA', created_at: 500, liquidity_sol: 0 }],
			'newest',
		);
		expect(out.max_initial_liquidity_sol).toBe(30);
		expect(out.avg_initial_liquidity_sol).toBe(14.5);
	});

	it('degrades to nulls on an empty feed instead of NaN or undefined', () => {
		const out = summarizeLaunches([], 'newest');
		expect(out.count).toBe(0);
		expect(out.newest_mint).toBeNull();
		expect(out.newest_name).toBeNull();
		expect(out.newest_symbol).toBeNull();
		expect(out.avg_initial_liquidity_sol).toBeNull();
		expect(out.max_initial_liquidity_sol).toBeNull();
		expect(out.launches).toEqual([]);
	});

	it('defaults the reported sort to newest when none is supplied', () => {
		expect(summarizeLaunches(FEED, undefined).sort).toBe('newest');
	});
});
