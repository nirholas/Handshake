// Pure helpers behind the /bnb-latency live block-race page: interval
// averaging from raw block timestamps, lane state derivation, sparkline bar
// normalization, and the honest measured-vs-measured speedup ratio. See
// the bnb-chain campaign, work order 17 (latency proof page; retired, see git history): "Pure interval-averaging +
// sparkline math in tests/ (feed block timestamps → correct rolling
// average)".

import { describe, expect, it } from 'vitest';
import {
	blockIntervals,
	rollingAverageFromTimestamps,
	laneState,
	allLanesDown,
	sparklineBars,
	speedupRatio,
} from '../src/bnb-latency-helpers.js';

describe('blockIntervals', () => {
	it('returns [] for fewer than two timestamps', () => {
		expect(blockIntervals([])).toEqual([]);
		expect(blockIntervals([1000])).toEqual([]);
	});
	it('diffs consecutive timestamps', () => {
		expect(blockIntervals([0, 450, 900, 1360])).toEqual([450, 450, 460]);
	});
});

describe('rollingAverageFromTimestamps', () => {
	it('returns null when fewer than two timestamps are given — not enough to measure', () => {
		expect(rollingAverageFromTimestamps([])).toBeNull();
		expect(rollingAverageFromTimestamps([1000])).toBeNull();
	});
	it('averages every interval by default', () => {
		// BNB-like cadence: three ~450ms ticks.
		expect(rollingAverageFromTimestamps([0, 450, 900, 1350])).toBe(450);
	});
	it('averages only the last `window` intervals when given one', () => {
		const timestamps = [0, 1000, 2000, 2450, 2900]; // slow, slow, then fast
		expect(rollingAverageFromTimestamps(timestamps, 2)).toBe(450);
		expect(rollingAverageFromTimestamps(timestamps)).toBe(725);
	});
	it('clamps an over-large window to however many intervals exist', () => {
		expect(rollingAverageFromTimestamps([0, 2000], 50)).toBe(2000);
	});
});

describe('laneState', () => {
	it('is measuring before the first fetch resolves', () => {
		expect(laneState({ hasFetchedOnce: false, ok: false })).toBe('measuring');
		expect(laneState({ hasFetchedOnce: false, ok: true })).toBe('measuring');
	});
	it('is live once a fetch resolves ok with a usable sample', () => {
		expect(laneState({ hasFetchedOnce: true, ok: true })).toBe('live');
	});
	it('is reconnecting once a fetch resolves but fails, after having fetched before', () => {
		expect(laneState({ hasFetchedOnce: true, ok: false })).toBe('reconnecting');
	});
	it('is reconnecting when ok but the sample is unusable (e.g. zero sampled blocks)', () => {
		expect(laneState({ hasFetchedOnce: true, ok: true, hasSample: false })).toBe('reconnecting');
	});
});

describe('allLanesDown', () => {
	it('is false for an empty or missing list — nothing to race yet', () => {
		expect(allLanesDown([])).toBe(false);
		expect(allLanesDown(undefined)).toBe(false);
	});
	it('is true only when every lane is down', () => {
		expect(allLanesDown([{ ok: false }, { ok: false }])).toBe(true);
	});
	it('is false when at least one lane is up', () => {
		expect(allLanesDown([{ ok: false }, { ok: true }])).toBe(false);
	});
});

describe('sparklineBars', () => {
	it('returns [] for empty input', () => {
		expect(sparklineBars([])).toEqual([]);
		expect(sparklineBars(undefined)).toEqual([]);
	});
	it('renders a flat series as even half-height bars, never dividing by zero', () => {
		expect(sparklineBars([450, 450, 450])).toEqual([50, 50, 50]);
		expect(sparklineBars([450])).toEqual([50]);
	});
	it('maps the fastest (lowest ms) value to a full-height bar and slowest to the floor', () => {
		const bars = sparklineBars([2000, 450, 1200], { floor: 8 });
		expect(bars[0]).toBe(8); // slowest (2000ms) -> floor
		expect(bars[1]).toBe(100); // fastest (450ms) -> full height
	});
	it('keeps only the last maxBars values', () => {
		const values = [100, 200, 300, 400, 500];
		expect(sparklineBars(values, { maxBars: 2 })).toHaveLength(2);
	});
});

describe('speedupRatio', () => {
	it('returns null for missing or non-positive inputs', () => {
		expect(speedupRatio(null, 2000)).toBeNull();
		expect(speedupRatio(450, null)).toBeNull();
		expect(speedupRatio(0, 2000)).toBeNull();
		expect(speedupRatio(450, -1)).toBeNull();
	});
	it('returns null when the "fast" side is not actually faster', () => {
		expect(speedupRatio(2000, 450)).toBeNull();
		expect(speedupRatio(450, 450)).toBeNull();
	});
	it('formats a real measured-vs-measured ratio to one decimal', () => {
		expect(speedupRatio(450, 2000)).toBe('4.4×');
		expect(speedupRatio(450, 12000)).toBe('26.7×');
	});
});
