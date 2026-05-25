import { describe, it, expect } from 'vitest';
import {
	sumDaily,
	formatCount,
	formatDuration,
	weightedAvgSessionSeconds,
} from './widgets-helpers.js';

describe('sumDaily', () => {
	it('returns 0 for non-arrays', () => {
		expect(sumDaily(null)).toBe(0);
		expect(sumDaily(undefined)).toBe(0);
		expect(sumDaily({})).toBe(0);
	});

	it('sums numeric `count` fields, coercing strings and missing values', () => {
		expect(sumDaily([{ count: 1 }, { count: 2 }, { count: 4 }])).toBe(7);
		expect(sumDaily([{ count: '3' }, { count: null }, { day: 'x' }])).toBe(3);
		expect(sumDaily([])).toBe(0);
	});
});

describe('formatCount', () => {
	it('renders dash for non-finite values', () => {
		expect(formatCount(NaN)).toBe('—');
		expect(formatCount(undefined)).toBe('—');
	});

	it('renders raw integer below 1k', () => {
		expect(formatCount(0)).toBe('0');
		expect(formatCount(7)).toBe('7');
		expect(formatCount(999)).toBe('999');
	});

	it('renders comma-grouped integers between 1k and 10k', () => {
		expect(formatCount(1000)).toBe('1,000');
		expect(formatCount(9999)).toBe('9,999');
	});

	it('compacts values at or above 10k', () => {
		expect(formatCount(10000)).toBe('10.0k');
		expect(formatCount(12345)).toBe('12.3k');
		expect(formatCount(1_500_000)).toBe('1500.0k');
	});
});

describe('formatDuration', () => {
	it('clamps negatives and non-numbers to 0s', () => {
		expect(formatDuration(-5)).toBe('0s');
		expect(formatDuration(NaN)).toBe('0s');
		expect(formatDuration(undefined)).toBe('0s');
	});

	it('renders sub-minute durations as seconds', () => {
		expect(formatDuration(0)).toBe('0s');
		expect(formatDuration(42)).toBe('42s');
		expect(formatDuration(59.4)).toBe('59s');
	});

	it('renders minute durations with optional trailing seconds', () => {
		expect(formatDuration(60)).toBe('1m');
		expect(formatDuration(95)).toBe('1m 35s');
		expect(formatDuration(3599)).toBe('59m 59s');
	});

	it('renders hour durations with optional trailing minutes', () => {
		expect(formatDuration(3600)).toBe('1h');
		expect(formatDuration(3720)).toBe('1h 2m');
		expect(formatDuration(7260)).toBe('2h 1m');
	});
});

describe('weightedAvgSessionSeconds', () => {
	it('returns null when no widget has threads in the window', () => {
		expect(weightedAvgSessionSeconds([])).toBeNull();
		expect(weightedAvgSessionSeconds([{ sessions_7d: null }])).toBeNull();
		expect(weightedAvgSessionSeconds([
			{ sessions_7d: { thread_count: 0, avg_seconds: 999, total_messages: 0 } },
		])).toBeNull();
	});

	it('weights average duration by thread count, not widget count', () => {
		const stats = [
			{ sessions_7d: { thread_count: 1, avg_seconds: 100 } },
			{ sessions_7d: { thread_count: 3, avg_seconds: 20 } },
		];
		// (100*1 + 20*3) / (1+3) = 160/4 = 40
		expect(weightedAvgSessionSeconds(stats)).toBe(40);
	});

	it('ignores widgets that have no sessions block (non-talking-agent)', () => {
		const stats = [
			{ sessions_7d: null },
			{ /* no sessions_7d at all */ },
			{ sessions_7d: { thread_count: 2, avg_seconds: 30 } },
		];
		expect(weightedAvgSessionSeconds(stats)).toBe(30);
	});
});
