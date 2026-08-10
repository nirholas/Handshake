// api/cron/mirror-fanout.js: the custodial copy-trade fanout.
//
// The handler answers with whatever counters the sweep accumulated, and an idle
// run used to accumulate none: the early `return` on an empty candidate set
// fired before `stats.edges` was ever assigned, so the response was a bare
// {ok:true}. That is indistinguishable from a run that never reached the query,
// which matters because this cron is the only thing standing between a leader's
// trade and a follower's mirror of it. An idle run now says so: {edges: 0}.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const sqlMock = vi.fn(async () => []);
const syncFollow = vi.fn();

vi.mock('../../api/_lib/db.js', () => ({
	sql: sqlMock,
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
	isStoragePressured: async () => ({ pressured: false }),
}));
vi.mock('../../api/_lib/agent-mirror.js', () => ({ syncFollow }));
vi.mock('../../api/_lib/env.js', () => ({ env: {} }));
vi.mock('../../api/_lib/sentry.js', () => ({ captureException: vi.fn() }));
vi.mock('../../api/_lib/alerts.js', () => ({ sendOpsAlert: vi.fn() }));
vi.mock('../../api/_lib/zauth.js', () => ({ instrument: () => false, drain: vi.fn() }));

const { default: handler } = await import('../../api/cron/mirror-fanout.js');

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
	const req = { method, url: '/api/cron/mirror-fanout', headers: { authorization: auth } };
	return handler(req, res).then(() => res);
}

beforeEach(() => {
	process.env.CRON_SECRET = 'test-cron-secret';
	sqlMock.mockReset();
	sqlMock.mockResolvedValue([]);
	syncFollow.mockReset();
});
afterEach(() => {
	delete process.env.CRON_SECRET;
	vi.restoreAllMocks();
});

describe('GET/POST /api/cron/mirror-fanout', () => {
	it('rejects a method it does not serve', async () => {
		expect((await call('DELETE')).statusCode).toBe(405);
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('rejects a bad cron secret', async () => {
		expect((await call('GET', 'Bearer wrong')).statusCode).toBe(401);
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('an idle run reports edges: 0 rather than a bare ok', async () => {
		const res = await call();
		expect(res.statusCode).toBe(200);
		expect(res.body).toEqual({ ok: true, edges: 0 });
		expect(syncFollow).not.toHaveBeenCalled();
	});

	it('counts edges across both networks and rolls up per-fill statuses', async () => {
		sqlMock.mockResolvedValue([{ id: 'f1', follower_agent_id: 'a', leader_agent_id: 'b', leader_name: 'Leader' }]);
		syncFollow.mockResolvedValue({ results: [{ status: 'filled' }, { status: 'skipped' }] });
		const res = await call();
		expect(res.body.edges).toBe(2); // one candidate on each of mainnet + devnet
		expect(res.body.filled).toBe(2);
		expect(res.body.skipped).toBe(2);
		expect(syncFollow).toHaveBeenCalledTimes(2);
	});

	it('a failing edge is counted, never fatal to the sweep', async () => {
		sqlMock.mockResolvedValue([{ id: 'f1' }]);
		syncFollow.mockRejectedValue(new Error('custody refused'));
		const res = await call();
		expect(res.statusCode).toBe(200);
		expect(res.body.error).toBe(2);
		expect(res.body.last_error).toContain('custody refused');
	});
});
