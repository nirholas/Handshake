// api/cron/irl-reap.js — IRL placement reaper.
//
// Regression: the reaper DELETEs from irl_pins and irl_pin_reports, both of
// which are created LAZILY by their write endpoints (pins.js / report.js). On a
// fresh deployment — or before the first pin is placed / first report filed —
// the table doesn't exist, so the unguarded DELETE threw `relation does not
// exist` and the hourly cron 500'd. The reaper must probe with to_regclass and
// treat a missing table as "nothing to reap".

import { describe, it, expect, beforeEach, vi } from 'vitest';

const sqlMock = vi.fn();
vi.mock('../../api/_lib/db.js', () => ({ sql: sqlMock, isDbUnavailableError: () => false, isDbCapacityError: () => false }));
vi.mock('../../api/_lib/env.js', () => ({ env: {} }));
vi.mock('../../api/_lib/sentry.js', () => ({ captureException: vi.fn() }));
vi.mock('../../api/_lib/alerts.js', () => ({ sendOpsAlert: vi.fn() }));
vi.mock('../../api/_lib/zauth.js', () => ({ instrument: () => false, drain: vi.fn() }));

const { sendOpsAlert } = await import('../../api/_lib/alerts.js');
const {
	default: handler,
	isReapSpike,
	reapTotal,
	REAP_SPIKE_THRESHOLD,
} = await import('../../api/cron/irl-reap.js');

process.env.CRON_SECRET = 'test-cron-secret';

function makeReqRes() {
	const req = {
		method: 'GET',
		url: '/api/cron/irl-reap',
		headers: { authorization: 'Bearer test-cron-secret' },
	};
	const res = {
		statusCode: 0,
		body: null,
		headers: {},
		setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
		end(b) { this.body = b ? JSON.parse(b) : null; },
		get headersSent() { return this.body !== null; },
		get writableEnded() { return this.body !== null; },
	};
	return { req, res };
}

describe('reapTotal / isReapSpike (pure)', () => {
	it('sums the three sweep counts, treating missing fields as 0', () => {
		expect(reapTotal({ pins: 2, reports: 1, interactions: 3 })).toBe(6);
		expect(reapTotal({ pins: 5 })).toBe(5);
		expect(reapTotal({})).toBe(0);
		expect(reapTotal(null)).toBe(0);
		expect(reapTotal(undefined)).toBe(0);
	});

	it('is not a spike at steady-state volume', () => {
		expect(isReapSpike({ pins: 3, reports: 1, interactions: 12 })).toBe(false);
		expect(isReapSpike({})).toBe(false);
	});

	it('trips exactly at the threshold and above', () => {
		expect(isReapSpike({ pins: REAP_SPIKE_THRESHOLD })).toBe(true);
		expect(isReapSpike({ pins: REAP_SPIKE_THRESHOLD - 1 })).toBe(false);
		expect(isReapSpike({ pins: REAP_SPIKE_THRESHOLD + 500 })).toBe(true);
	});

	it('honors a custom threshold so callers can tune sensitivity', () => {
		expect(isReapSpike({ pins: 10 }, 10)).toBe(true);
		expect(isReapSpike({ pins: 9 }, 10)).toBe(false);
	});
});

describe('irl-reap cron', () => {
	beforeEach(() => {
		sqlMock.mockReset();
		sendOpsAlert.mockClear();
	});

	it('returns 200 (not 500) when no table exists yet — nothing to reap', async () => {
		// to_regclass probe → all NULL. No DELETE should ever be issued.
		sqlMock.mockResolvedValueOnce([{ pins: null, reports: null, interactions: null }]);

		const { req, res } = makeReqRes();
		await handler(req, res);

		expect(res.statusCode).toBe(200);
		expect(res.body).toMatchObject({ ok: true, reapedPins: 0, reapedReports: 0, reapedInteractions: 0 });
		// Exactly one query ran: the existence probe. No DELETE against a
		// non-existent relation (which is what 500'd in production).
		expect(sqlMock).toHaveBeenCalledTimes(1);
	});

	it('reaps pins, reports, and interactions (orphan + age-out) when all exist', async () => {
		sqlMock
			.mockResolvedValueOnce([{ pins: 'irl_pins', reports: 'irl_pin_reports', interactions: 'irl_interactions' }]) // probe
			.mockResolvedValueOnce([{ id: 'p1' }, { id: 'p2' }])  // pins delete
			.mockResolvedValueOnce([{ id: 'r1' }])                // reports delete
			.mockResolvedValueOnce([{ id: 'ix-orphan' }])         // interactions orphan delete
			.mockResolvedValueOnce([{ id: 'ix-aged' }, { id: 'ix-aged2' }]); // interactions age-out delete

		const { req, res } = makeReqRes();
		await handler(req, res);

		expect(res.statusCode).toBe(200);
		// reapedInteractions sums the orphan sweep (1) and the age-out sweep (2).
		expect(res.body).toMatchObject({ ok: true, reapedPins: 2, reapedReports: 1, reapedInteractions: 3 });
		expect(sqlMock).toHaveBeenCalledTimes(5);
	});

	it('reaps an interaction orphaned by a removed pin (existence-guarded orphan sweep)', async () => {
		sqlMock
			.mockResolvedValueOnce([{ pins: 'irl_pins', reports: null, interactions: 'irl_interactions' }]) // probe
			.mockResolvedValueOnce([])                    // pins delete — none expired
			.mockResolvedValueOnce([{ id: 'ix-orphan' }]) // interactions orphan delete — one orphan
			.mockResolvedValueOnce([]);                   // interactions age-out delete — none stale

		const { req, res } = makeReqRes();
		await handler(req, res);

		expect(res.statusCode).toBe(200);
		expect(res.body).toMatchObject({ ok: true, reapedInteractions: 1 });
		// The orphan delete is the NOT EXISTS form (guarded), not the unconditional purge.
		const orphanCall = sqlMock.mock.calls.find(([s]) => {
			const q = Array.isArray(s) ? s.join(' ') : String(s);
			return /DELETE FROM irl_interactions ix/i.test(q) && /NOT EXISTS/i.test(q);
		});
		expect(orphanCall).toBeTruthy();
	});

	it('re-run after a clean sweep deletes nothing new (idempotent)', async () => {
		sqlMock
			.mockResolvedValueOnce([{ pins: 'irl_pins', reports: 'irl_pin_reports', interactions: 'irl_interactions' }]) // probe
			.mockResolvedValueOnce([])  // pins delete
			.mockResolvedValueOnce([])  // reports delete
			.mockResolvedValueOnce([])  // interactions orphan delete
			.mockResolvedValueOnce([]); // interactions age-out delete

		const { req, res } = makeReqRes();
		await handler(req, res);

		expect(res.statusCode).toBe(200);
		expect(res.body).toMatchObject({ ok: true, reapedPins: 0, reapedReports: 0, reapedInteractions: 0 });
	});

	it('purges all reports + interactions when the pins table is gone (everything is an orphan)', async () => {
		sqlMock
			.mockResolvedValueOnce([{ pins: null, reports: 'irl_pin_reports', interactions: 'irl_interactions' }]) // probe
			.mockResolvedValueOnce([{ id: 'r1' }, { id: 'r2' }]) // unconditional reports delete
			.mockResolvedValueOnce([{ id: 'ix1' }])              // unconditional interactions delete
			.mockResolvedValueOnce([]);                          // interactions age-out delete

		const { req, res } = makeReqRes();
		await handler(req, res);

		expect(res.statusCode).toBe(200);
		expect(res.body).toMatchObject({ ok: true, reapedPins: 0, reapedReports: 2, reapedInteractions: 1 });
	});

	it('fires an ops alert when one run deletes an anomalous number of rows', async () => {
		const aged = Array.from({ length: REAP_SPIKE_THRESHOLD + 1 }, (_, i) => ({ id: `ix${i}` }));
		sqlMock
			.mockResolvedValueOnce([{ pins: 'irl_pins', reports: 'irl_pin_reports', interactions: 'irl_interactions' }]) // probe
			.mockResolvedValueOnce([])    // pins delete
			.mockResolvedValueOnce([])    // reports delete
			.mockResolvedValueOnce([])    // interactions orphan delete
			.mockResolvedValueOnce(aged); // interactions age-out delete — anomalous volume

		const { req, res } = makeReqRes();
		await handler(req, res);

		expect(res.statusCode).toBe(200);
		expect(sendOpsAlert).toHaveBeenCalledTimes(1);
		expect(sendOpsAlert.mock.calls[0][0]).toBe('IRL reaper spike');
	});

	it('does NOT alert on a normal-volume sweep', async () => {
		sqlMock
			.mockResolvedValueOnce([{ pins: 'irl_pins', reports: 'irl_pin_reports', interactions: 'irl_interactions' }]) // probe
			.mockResolvedValueOnce([{ id: 'p1' }]) // pins delete
			.mockResolvedValueOnce([])             // reports delete
			.mockResolvedValueOnce([])             // interactions orphan delete
			.mockResolvedValueOnce([{ id: 'ix1' }]); // interactions age-out delete

		const { req, res } = makeReqRes();
		await handler(req, res);

		expect(res.statusCode).toBe(200);
		expect(sendOpsAlert).not.toHaveBeenCalled();
	});

	it('ages out irl_events past 90 days when the table exists (undated when absent)', async () => {
		sqlMock
			.mockResolvedValueOnce([{ pins: 'irl_pins', reports: 'irl_pin_reports', interactions: 'irl_interactions', worldlines: null, proofs: null, events: 'irl_events' }]) // probe
			.mockResolvedValueOnce([]) // pins delete
			.mockResolvedValueOnce([]) // reports delete
			.mockResolvedValueOnce([]) // interactions orphan delete
			.mockResolvedValueOnce([]) // interactions age-out delete
			.mockResolvedValueOnce([{ id: 1 }, { id: 2 }]); // events age-out delete

		const { req, res } = makeReqRes();
		await handler(req, res);

		expect(res.statusCode).toBe(200);
		expect(res.body).toMatchObject({ ok: true, reapedEvents: 2 });
		const eventsCall = sqlMock.mock.calls.find(([s]) => {
			const q = Array.isArray(s) ? s.join(' ') : String(s);
			return /DELETE FROM irl_events/i.test(q) && /90 days/i.test(q);
		});
		expect(eventsCall).toBeTruthy();
	});

	it('skips the events sweep entirely when irl_events does not exist yet', async () => {
		sqlMock
			.mockResolvedValueOnce([{ pins: 'irl_pins', reports: 'irl_pin_reports', interactions: 'irl_interactions', worldlines: null, proofs: null, events: null }]) // probe
			.mockResolvedValueOnce([]) // pins delete
			.mockResolvedValueOnce([]) // reports delete
			.mockResolvedValueOnce([]) // interactions orphan delete
			.mockResolvedValueOnce([]); // interactions age-out delete

		const { req, res } = makeReqRes();
		await handler(req, res);

		expect(res.statusCode).toBe(200);
		expect(res.body).toMatchObject({ ok: true, reapedEvents: 0 });
		expect(sqlMock).toHaveBeenCalledTimes(5); // no extra DELETE issued against a missing relation
	});

	it('rejects an unauthenticated request with 401', async () => {
		const { req, res } = makeReqRes();
		req.headers.authorization = 'Bearer wrong';
		await handler(req, res);
		expect(res.statusCode).toBe(401);
		expect(sqlMock).not.toHaveBeenCalled();
	});
});
