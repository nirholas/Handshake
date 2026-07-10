import { describe, it, expect } from 'vitest';
import { snapWindow, intervalSeconds, POLL_BUCKET_SECONDS } from '../api/pump/price-history.js';

// Guards the cache-miss storm behind the intermittent 502s on /terminal and
// /trades: chart clients poll with `to = now`, so an unsnapped window produced a
// unique cache key per poll, every poll hit GeckoTerminal, and its free tier
// rate-limited us into `upstream_error`.

describe('intervalSeconds', () => {
	it('maps every supported interval to its candle width', () => {
		expect(intervalSeconds('1m')).toBe(60);
		expect(intervalSeconds('5m')).toBe(300);
		expect(intervalSeconds('15m')).toBe(900);
		expect(intervalSeconds('1H')).toBe(3600);
		expect(intervalSeconds('1D')).toBe(86_400);
	});

	it('falls back to the 15m default for an unknown interval', () => {
		expect(intervalSeconds('nonsense')).toBe(900);
	});
});

describe('snapWindow', () => {
	it('collapses every poll inside one cache bucket onto one identical window', () => {
		// A chart polling every few seconds: without snapping these are 4 distinct
		// cache keys and 4 upstream calls. Anchor on a bucket start so the whole
		// spread lives inside a single bucket.
		const base = Math.floor(1783663175 / POLL_BUCKET_SECONDS) * POLL_BUCKET_SECONDS;
		const windows = [0, 3, 11, POLL_BUCKET_SECONDS - 1].map((offset) =>
			snapWindow({ interval: '5m', from: base - 43_200 + offset, to: base + offset }),
		);
		for (const w of windows) expect(w).toEqual(windows[0]);
	});

	it('keeps the live candle: `to` is never rounded back by more than one bucket', () => {
		const to = 1783663175;
		const snapped = snapWindow({ interval: '5m', from: to - 43_200, to }).to;
		expect(to - snapped).toBeLessThan(POLL_BUCKET_SECONDS);
	});

	it('lands `from` on a candle boundary and `to` on a poll bucket', () => {
		const step = intervalSeconds('15m');
		const { from, to } = snapWindow({ interval: '15m', from: 1783619975, to: 1783663175 });
		expect(from % step).toBe(0);
		expect(to % POLL_BUCKET_SECONDS).toBe(0);
	});

	it('never reaches into the future', () => {
		const to = 1783663175;
		expect(snapWindow({ interval: '1H', from: to - 86_400, to }).to).toBeLessThanOrEqual(to);
	});

	it('always covers at least the requested window start', () => {
		const from = 1783619975;
		expect(snapWindow({ interval: '1H', from, to: from + 86_400 }).from).toBeLessThanOrEqual(from);
	});

	it('keeps a full candle when the window is narrower than one candle', () => {
		const to = 1783663200; // exactly on a bucket boundary
		const { from, to: snappedTo } = snapWindow({ interval: '1H', from: to - 10, to });
		expect(snappedTo - from).toBe(intervalSeconds('1H'));
		expect(from).toBeLessThan(snappedTo);
	});

	it('produces a strictly increasing window for every supported interval', () => {
		const now = 1783663175;
		for (const iv of ['1m', '3m', '5m', '15m', '30m', '1H', '2H', '4H', '6H', '8H', '12H', '1D', '3D', '1W', '1M']) {
			const { from, to } = snapWindow({ interval: iv, from: now - 30 * 86_400, to: now });
			expect(to).toBeGreaterThan(from);
		}
	});
});
