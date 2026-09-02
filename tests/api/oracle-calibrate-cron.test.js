// api/cron/oracle-calibrate.js: conviction-band calibration rollup.
//
// Pins the math that drives the sniper optimizer's Rule O: a band's correction
// factor is observed win rate / the probability the band's score actually claims
// (probabilityFromScore, NOT score/100), computed ONLY once the band has
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
const { probabilityFromScore } = await import('../../api/_lib/oracle/conviction.js');

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
		// Five closed trades scored 90, three of them winners: observed 0.6. The
		// prediction is what the score CLAIMS, not the score over 100: a 90 claims
		// P=0.607, so the factor is 0.6/0.607, comfortably inside the clamp. Four
		// winners would read 0.8/0.607 = 1.32 and hit the ceiling instead, which is
		// the next test's job, not this one's.
		sqlMock.mockResolvedValueOnce(
			Array.from({ length: 5 }, (_, i) => ({ score: 90, win: i < 3 ? 1 : 0, pnl_pct: 10 })),
		);
		const res = await call();
		const band = res.body.bands.find((b) => b.band === '85-100');
		expect(band.samples).toBe(5);
		expect(band.observed_rate).toBe(0.6);
		expect(band.correction_factor).toBeCloseTo(0.6 / probabilityFromScore(90), 3);
		// Untouched by either end of the [0.7, 1.3] clamp, so the assertion above
		// is measuring the ratio and not the ceiling.
		expect(band.correction_factor).toBeLessThan(1.3);
		expect(band.correction_factor).toBeGreaterThan(0.7);
	});

	it('clamps the factor at 1.3 for a band that always wins', async () => {
		// Observed 1.0 against a claimed 0.679 is a 1.47 correction; the ceiling is
		// what stops one lucky band from swinging every entry threshold.
		sqlMock.mockResolvedValueOnce(
			Array.from({ length: 5 }, () => ({ score: 90, win: 1, pnl_pct: 10 })),
		);
		const res = await call();
		const band = res.body.bands.find((b) => b.band === '85-100');
		expect(band.observed_rate).toBe(1);
		expect(band.correction_factor).toBe(1.3);
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
