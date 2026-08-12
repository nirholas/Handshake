// api/cron/oracle-realized-labels.js: realized-PnL ground-truth labels.
//
// The cron derives, per mint the fleet really traded, whether the net realized
// outcome was a win and upserts it for the Oracle learner. Pinned here:
//   - auth + method gating,
//   - the win/loss rollup counts rows by their realized_win flag,
//   - a failed upsert surfaces as a wrapped JSON 500, never a stack trace.

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

const { default: handler } = await import('../../api/cron/oracle-realized-labels.js');

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
	const req = { method, url: '/api/cron/oracle-realized-labels', headers: { authorization: auth } };
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

describe('GET/POST /api/cron/oracle-realized-labels', () => {
	it('rejects a method it does not serve', async () => {
		expect((await call('DELETE')).statusCode).toBe(405);
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('rejects a bad cron secret', async () => {
		expect((await call('GET', 'Bearer wrong')).statusCode).toBe(401);
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('no closed trades labels nothing', async () => {
		const res = await call();
		expect(res.statusCode).toBe(200);
		expect(res.body).toEqual({ ok: true, labeled: 0, wins: 0, losses: 0 });
	});

	it('rolls up labeled mints into wins and losses by the realized flag', async () => {
		sqlMock.mockResolvedValueOnce([
			{ mint: 'a', realized_win: 1 },
			{ mint: 'b', realized_win: 0 },
			{ mint: 'c', realized_win: 1 },
		]);
		const res = await call('POST');
		expect(res.statusCode).toBe(200);
		expect(res.body).toEqual({ ok: true, labeled: 3, wins: 2, losses: 1 });
	});

	it('a failed upsert surfaces as a JSON 500, not a stack trace', async () => {
		sqlMock.mockRejectedValueOnce(new Error('relation oracle_realized_outcomes does not exist'));
		const res = await call();
		expect(res.statusCode).toBe(500);
		expect(res.body.error).toBe('internal_error');
		expect(JSON.stringify(res.body)).not.toContain('oracle_realized_outcomes');
	});
});
