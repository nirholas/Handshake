// api/cron/leaderboard-rollup.js: the daily top-10 badge sweep.
//
// The cron walks five metric rankings and awards each top-10 finisher a
// point-in-time badge. The load-bearing behaviors pinned here:
//   - auth + method gating (it is a cron, not a public read),
//   - every metric's top-10 user gets exactly one unlockBadge call, and the
//     response counts only NEWLY awarded badges (idempotent re-runs award 0),
//   - one metric's query failing must not sink the sweep: the other metrics
//     still run and the failed one reports checked: 0.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const sqlMock = vi.fn(async () => []);
const unlockBadge = vi.fn(async () => true);

vi.mock('../../api/_lib/db.js', () => ({
	sql: sqlMock,
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
	isStoragePressured: async () => ({ pressured: false }),
}));
vi.mock('../../api/_lib/streaks.js', () => ({
	unlockBadge,
	BADGES: { TOP10: (metric) => `top10_${metric}` },
}));
vi.mock('../../api/_lib/env.js', () => ({ env: {} }));
vi.mock('../../api/_lib/sentry.js', () => ({ captureException: vi.fn() }));
vi.mock('../../api/_lib/alerts.js', () => ({ sendOpsAlert: vi.fn() }));
vi.mock('../../api/_lib/zauth.js', () => ({ instrument: () => false, drain: vi.fn() }));

const { default: handler } = await import('../../api/cron/leaderboard-rollup.js');

const METRICS = ['creations', 'remixes_received', 'launches', 'followers', 'walk_distance'];

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
	const req = { method, url: '/api/cron/leaderboard-rollup', headers: { authorization: auth } };
	return handler(req, res).then(() => res);
}

beforeEach(() => {
	process.env.CRON_SECRET = 'test-cron-secret';
	sqlMock.mockReset();
	sqlMock.mockResolvedValue([]);
	unlockBadge.mockReset();
	unlockBadge.mockResolvedValue(true);
});
afterEach(() => {
	delete process.env.CRON_SECRET;
	vi.restoreAllMocks();
});

describe('GET /api/cron/leaderboard-rollup', () => {
	it('rejects a method it does not serve', async () => {
		expect((await call('POST')).statusCode).toBe(405);
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('rejects a bad cron secret', async () => {
		expect((await call('GET', 'Bearer wrong')).statusCode).toBe(401);
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('awards a badge per top-10 user per metric and reports the counts', async () => {
		for (const _ of METRICS) sqlMock.mockResolvedValueOnce([{ user_id: 'u1' }, { user_id: 'u2' }]);
		const res = await call();
		expect(res.statusCode).toBe(200);
		for (const metric of METRICS) {
			expect(res.body.awarded[metric]).toEqual({ checked: 2, newlyAwarded: 2 });
		}
		expect(unlockBadge).toHaveBeenCalledTimes(METRICS.length * 2);
		expect(unlockBadge).toHaveBeenCalledWith('u1', 'top10_creations', { metric: 'creations' });
		expect(unlockBadge).toHaveBeenCalledWith('u2', 'top10_walk_distance', { metric: 'walk_distance' });
	});

	it('an idempotent re-run (badge already held) counts zero new awards', async () => {
		sqlMock.mockResolvedValueOnce([{ user_id: 'u1' }]);
		unlockBadge.mockResolvedValue(false);
		const res = await call();
		expect(res.statusCode).toBe(200);
		expect(res.body.awarded.creations).toEqual({ checked: 1, newlyAwarded: 0 });
	});

	it('one failing metric degrades to checked: 0 without sinking the sweep', async () => {
		sqlMock.mockRejectedValueOnce(new Error('relation does not exist'));
		const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const res = await call();
		expect(res.statusCode).toBe(200);
		expect(res.body.awarded.creations).toEqual({ checked: 0, newlyAwarded: 0 });
		// The remaining four metrics still ran.
		for (const metric of METRICS.slice(1)) {
			expect(res.body.awarded[metric]).toEqual({ checked: 0, newlyAwarded: 0 });
		}
		expect(errSpy).toHaveBeenCalled();
		errSpy.mockRestore();
	});
});
