// api/cron/kol-tracker-refresh.js: the KOL Tracker cache prewarm.
//
// Two regressions this pins down:
//   1. It was the only cron in api/cron/ with NO method gate. Its own header
//      documents GET/POST, but a DELETE (or PUT, or PATCH) fell straight
//      through to the cron-secret check and, with a valid secret, ran the
//      sweep. Every neighbouring cron answers 405 first.
//   2. A window whose prewarm threw was reported as `null` inside an `ok:true`
//      body, so a tracker broken for hours looked exactly like a warm cache.
//      Failures are named now, and a run where every window failed is not ok.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const getKolTracker = vi.fn();
vi.mock('../../src/kol/tracker.js', () => ({ getKolTracker }));
vi.mock('../../api/_lib/db.js', () => ({
	sql: vi.fn(),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
	isStoragePressured: async () => ({ pressured: false }),
}));
vi.mock('../../api/_lib/env.js', () => ({ env: {} }));
vi.mock('../../api/_lib/sentry.js', () => ({ captureException: vi.fn() }));
vi.mock('../../api/_lib/alerts.js', () => ({ sendOpsAlert: vi.fn() }));
vi.mock('../../api/_lib/zauth.js', () => ({ instrument: () => false, drain: vi.fn() }));

const { default: handler } = await import('../../api/cron/kol-tracker-refresh.js');

function call(method = 'GET', auth = 'Bearer test-cron-secret') {
	const res = {
		statusCode: 0,
		body: null,
		headers: {},
		setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
		getHeader(k) { return this.headers[k.toLowerCase()]; },
		end(b) { this.body = b ? JSON.parse(b) : null; },
		get headersSent() { return this.body !== null; },
		get writableEnded() { return this.body !== null; },
	};
	const req = { method, url: '/api/cron/kol-tracker-refresh', headers: { authorization: auth } };
	return handler(req, res).then(() => res);
}

beforeEach(() => {
	process.env.CRON_SECRET = 'test-cron-secret';
	getKolTracker.mockReset();
	getKolTracker.mockResolvedValue([{ handle: 'a' }, { handle: 'b' }]);
	vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
	delete process.env.CRON_SECRET;
	vi.restoreAllMocks();
});

describe('GET/POST /api/cron/kol-tracker-refresh', () => {
	it('rejects a method it does not serve, before touching the tracker', async () => {
		const res = await call('DELETE');
		expect(res.statusCode).toBe(405);
		expect(res.body.error).toBe('method_not_allowed');
		expect(getKolTracker).not.toHaveBeenCalled();
	});

	it('serves GET and POST', async () => {
		expect((await call('GET')).statusCode).toBe(200);
		expect((await call('POST')).statusCode).toBe(200);
	});

	it('rejects a bad cron secret', async () => {
		const res = await call('GET', 'Bearer wrong');
		expect(res.statusCode).toBe(401);
		expect(getKolTracker).not.toHaveBeenCalled();
	});

	it('prewarms every window and reports the row counts', async () => {
		const res = await call();
		expect(res.statusCode).toBe(200);
		expect(res.body.ok).toBe(true);
		expect(res.body.rows).toEqual({ '24h': 2, '7d': 2, '30d': 2 });
		expect(res.body.failed).toBe(0);
		expect(res.body.failures).toBeUndefined();
		expect(getKolTracker.mock.calls.map((c) => c[0].window)).toEqual(['24h', '7d', '30d']);
	});

	it('names a failed window instead of reporting a silent null', async () => {
		getKolTracker.mockImplementation(async ({ window }) => {
			if (window === '7d') throw new Error('X API rate limit');
			return [{ handle: 'a' }];
		});
		const res = await call();
		expect(res.statusCode).toBe(200);
		expect(res.body.ok).toBe(true); // a partial prewarm is still useful
		expect(res.body.rows).toEqual({ '24h': 1, '7d': null, '30d': 1 });
		expect(res.body.failed).toBe(1);
		expect(res.body.failures['7d']).toContain('X API rate limit');
	});

	it('is not ok when every window failed', async () => {
		getKolTracker.mockRejectedValue(new Error('tracker down'));
		const res = await call();
		expect(res.statusCode).toBe(200);
		expect(res.body.ok).toBe(false);
		expect(res.body.failed).toBe(3);
	});
});
