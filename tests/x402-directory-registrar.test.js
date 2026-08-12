// Unit tests for api/cron/x402-directory-registrar.js → registrarWindow.
//
// The registrar re-upserts one WINDOW of the live paid catalog per hour under
// a cursor derived from the hour number, so the rotation survives cold starts
// and skipped ticks with no state of its own. These pin the rotation contract:
//   - hour N always maps to the same window (deterministic, stateless);
//   - consecutive hours walk the whole catalog without repeats until wrap;
//   - the window never exceeds the 402index rate-limit size;
//   - an empty catalog stays total (no modulo-by-zero NaN).

import { describe, it, expect } from 'vitest';
import { registrarWindow } from '../api/cron/x402-directory-registrar.js';

const HOUR_MS = 3_600_000;

function fakeCatalog(n) {
	return Array.from({ length: n }, (_, i) => ({ slug: `svc-${i}` }));
}

describe('registrarWindow', () => {
	it('maps the same hour to the same window deterministically', () => {
		const catalog = fakeCatalog(75);
		const t = 1_800_000 * HOUR_MS;
		const a = registrarWindow(catalog, t);
		const b = registrarWindow(catalog, t + 30 * 60 * 1000); // same hour
		expect(a.cursor).toBe(b.cursor);
		expect(a.batch.map((e) => e.slug)).toEqual(b.batch.map((e) => e.slug));
	});

	it('walks the whole catalog over consecutive hours without overlap', () => {
		const catalog = fakeCatalog(24); // 3 exact windows of 8
		const t0 = 1_800_000 * HOUR_MS;
		const seen = [];
		const windows = [];
		for (let h = 0; h < 3; h++) {
			const w = registrarWindow(catalog, t0 + h * HOUR_MS);
			windows.push(w.cursor);
			seen.push(...w.batch.map((e) => e.slug));
		}
		expect(windows).toEqual([0, 1, 2]);
		expect(new Set(seen).size).toBe(24); // full catalog, no repeats
	});

	it('wraps back to window 0 after the last window', () => {
		const catalog = fakeCatalog(24);
		const t0 = 1_800_000 * HOUR_MS;
		const last = registrarWindow(catalog, t0 + 2 * HOUR_MS);
		const wrapped = registrarWindow(catalog, t0 + 3 * HOUR_MS);
		expect(last.cursor).toBe(2);
		expect(wrapped.cursor).toBe(0);
	});

	it('keeps every batch at or under the rate-limit window size', () => {
		const catalog = fakeCatalog(75); // 10 windows, last one partial
		const t0 = 1_800_000 * HOUR_MS;
		for (let h = 0; h < 10; h++) {
			const w = registrarWindow(catalog, t0 + h * HOUR_MS);
			expect(w.batch.length).toBeGreaterThan(0);
			expect(w.batch.length).toBeLessThanOrEqual(8);
		}
		// 75 entries / 8 per window = 10 windows; the last carries the remainder.
		const last = registrarWindow(catalog, t0 + 9 * HOUR_MS);
		expect(last.windows).toBe(10);
		expect(last.batch.length).toBe(75 - 9 * 8);
	});

	it('stays total on an empty catalog (no NaN cursor, empty batch)', () => {
		const w = registrarWindow([], 1_800_000 * HOUR_MS);
		expect(w.windows).toBe(1);
		expect(w.cursor).toBe(0);
		expect(w.batch).toEqual([]);
	});

	it('honors a custom window size', () => {
		const catalog = fakeCatalog(10);
		const w = registrarWindow(catalog, 1_800_000 * HOUR_MS, 5);
		expect(w.windows).toBe(2);
		expect(w.batch.length).toBe(5);
	});
});
