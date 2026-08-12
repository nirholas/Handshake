// api/cron/oracle-calibrate.js: conviction-band calibration rollup.
//
// Pins the math that drives the sniper optimizer's Rule O: a band's correction
// factor is observed win rate / predicted rate, computed ONLY once the band has
// MIN_BAND_SAMPLE real closed trades, and clamped to [0.7, 1.3] so a thin or
// extreme sample can never swing entries wildly. Also pins the wrapped 5xx when
// the join query itself fails.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const sqlMock = vi.fn(async () => []);

vi.mock('../../api/_lib/db.js', () => ({
	sql: sqlMock,
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
	isStoragePressured: async () => ({ pressured: false }),
}));
vi.mock('../../api/_lib/env.js', () => ({ env: {} }));
vi.mock('../../api/_lib/sentry.js', () => ({ captureException: vi.fn() }));
vi.mock('../../api/_lib/alerts.js', () => ({ sendOpsAlert: vi.fn() }));
vi.mock('../../api/_lib/zauth.js', () => ({ instrument: () => false, drain: vi.fn() }));

const { default: handler } = await import('../../api/cron/oracle-calibrate.js');

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
	const req = { method, url: '/api/cron/oracle-calibrate', headers: { authorization: auth } };
	return handler(req, res).then(() => res);
}

beforeEach(() => {
	process.env.CRON_SECRET = 'test-cron-secret';
	sqlMock.mockReset();
	sqlMock.mockResolvedValue([]);
});
afterEach(() => {
	delete process.env.CRON_SECRET;
	vi.restoreAllMocks();
});

describe('GET/POST /api/cron/oracle-calibrate', () => {
	it('rejects a method it does not serve', async () => {
		expect((await call('DELETE')).statusCode).toBe(405);
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('rejects a bad cron secret', async () => {
		expect((await call('GET', 'Bearer wrong')).statusCode).toBe(401);
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('empty fleet history yields five zero-sample bands at the no-op factor', async () => {
		const res = await call();
		expect(res.statusCode).toBe(200);
		expect(res.body.traded_scored_mints).toBe(0);
		expect(res.body.bands).toHaveLength(5);
		for (const band of res.body.bands) {
			expect(band).toEqual({ band: band.band, samples: 0, observed_rate: null, correction_factor: 1 });
		}
		// 1 select + 5 upserts (one per band).
		expect(sqlMock).toHaveBeenCalledTimes(6);
	});

	it('a confident winning band computes factor = observed / predicted', async () => {
		// Five closed winning trades scored 90: predicted 0.9, observed 1.0.
		sqlMock.mockResolvedValueOnce(
			Array.from({ length: 5 }, () => ({ score: 90, win: 1, pnl_pct: 10 })),
		);
		const res = await call();
		const band = res.body.bands.find((b) => b.band === '85-100');
		expect(band.samples).toBe(5);
		expect(band.observed_rate).toBe(1);
		expect(band.correction_factor).toBeCloseTo(1 / 0.9, 2);
	});

	it('clamps the factor at 0.7 for a band that always loses', async () => {
		sqlMock.mockResolvedValueOnce(
			Array.from({ length: 5 }, () => ({ score: 90, win: 0, pnl_pct: -20 })),
		);
		const res = await call();
		const band = res.body.bands.find((b) => b.band === '85-100');
		expect(band.observed_rate).toBe(0);
		expect(band.correction_factor).toBe(0.7);
	});

	it('a thin band stays at the no-op factor regardless of outcomes', async () => {
		sqlMock.mockResolvedValueOnce([{ score: 90, win: 1, pnl_pct: 50 }]);
		const res = await call();
		const band = res.body.bands.find((b) => b.band === '85-100');
		expect(band.samples).toBe(1);
		expect(band.correction_factor).toBe(1);
	});

	it('a failed join query surfaces as a JSON 500, not a stack trace', async () => {
		sqlMock.mockRejectedValueOnce(new Error('relation agent_sniper_positions does not exist'));
		const res = await call();
		expect(res.statusCode).toBe(500);
		expect(res.body.error).toBe('internal_error');
		expect(JSON.stringify(res.body)).not.toContain('agent_sniper_positions');
	});
});
