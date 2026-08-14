// Unit tests for api/cron/x402-directory-registrar.js → registrarWindow.
//
// The registrar re-upserts one WINDOW of the live paid catalog per hour under
// a cursor derived from the hour number, so the rotation survives cold starts
// and skipped ticks with no state of its own. These pin the rotation contract:
//   - hour N always maps to the same window (deterministic, stateless);
//   - consecutive hours walk the whole catalog without repeats until wrap;
//   - the window never exceeds the 402index rate-limit size;
//   - an empty catalog stays total (no modulo-by-zero NaN).

import { describe, it, expect, afterEach, vi } from 'vitest';
import { registrarWindow, probeDeployed } from '../api/cron/x402-directory-registrar.js';

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

// The probe decides whether an entry is worth one of 402index's 10
// registrations/hour. It used to demand a bare 402, which permanently and
// silently excluded every endpoint that paywalls behind a parameter: three.ws's
// /api/x402/vanity-premium answers 200 to a parameterless GET (the free
// inventory browse) and 402 only to ?address=<in-stock base58>. The registrar
// cannot synthesize a valid paid request for an arbitrary endpoint, so there was
// no tick on which such an entry could ever have been listed. These pin the
// corrected contract: only a 404, a 5xx, or an unreachable origin means "not
// deployed".
describe('probeDeployed', () => {
	const entry = { slug: 'demo', endpoint: 'https://three.ws/api/x402/demo', method: 'GET' };

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	function stubStatus(status) {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => ({ status })),
		);
	}

	it('accepts a bare 402 (single-mode paid endpoint)', async () => {
		stubStatus(402);
		expect(await probeDeployed(entry)).toEqual({ live: true, status: 402 });
	});

	it('accepts a 200 browse response (paywall behind a query parameter)', async () => {
		stubStatus(200);
		expect(await probeDeployed(entry)).toEqual({ live: true, status: 200 });
	});

	it.each([401, 403, 405, 429])('accepts %i as proof the route is deployed', async (status) => {
		stubStatus(status);
		expect(await probeDeployed(entry)).toEqual({ live: true, status });
	});

	it('rejects a 404 as not deployed', async () => {
		stubStatus(404);
		expect(await probeDeployed(entry)).toEqual({ live: false, status: 404, reason: 'origin_404' });
	});

	it.each([500, 502, 503])('rejects %i as not deployed', async (status) => {
		stubStatus(status);
		expect(await probeDeployed(entry)).toEqual({ live: false, status, reason: `origin_${status}` });
	});

	it('rejects an unreachable origin', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new Error('connect ECONNREFUSED');
			}),
		);
		expect(await probeDeployed(entry)).toEqual({ live: false, reason: 'origin_unreachable' });
	});

	it('sends a JSON body on a POST entry and none on a GET entry', async () => {
		const spy = vi.fn(async () => ({ status: 402 }));
		vi.stubGlobal('fetch', spy);
		await probeDeployed({ ...entry, method: 'POST' });
		expect(spy.mock.calls[0][1].body).toBe('{}');
		expect(spy.mock.calls[0][1].headers['content-type']).toBe('application/json');
		await probeDeployed(entry);
		expect(spy.mock.calls[1][1].body).toBeUndefined();
	});
});
