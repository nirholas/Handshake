// api/cron/launcher-tick.js: the thin cron wrapper over the launcher engine.
//
// The handler is deliberately small (method gate, cron auth, one engine call),
// which makes its contract easy to regress silently: a dropped auth check or a
// method the engine never expected would slip through unnoticed. These tests
// pin the gate behavior plus the pass-through of the engine's tick result, and
// the wrapped 5xx when the engine throws (the response must stay a JSON error,
// never a stack trace).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const runLauncherTick = vi.fn();

vi.mock('../../api/_lib/db.js', () => ({
	sql: vi.fn(),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
	isStoragePressured: async () => ({ pressured: false }),
}));
vi.mock('../../api/_lib/launcher-engine.js', () => ({ runLauncherTick }));
vi.mock('../../api/_lib/env.js', () => ({ env: {} }));
vi.mock('../../api/_lib/sentry.js', () => ({ captureException: vi.fn() }));
vi.mock('../../api/_lib/alerts.js', () => ({ sendOpsAlert: vi.fn() }));
vi.mock('../../api/_lib/zauth.js', () => ({ instrument: () => false, drain: vi.fn() }));

const { default: handler } = await import('../../api/cron/launcher-tick.js');

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
	const req = { method, url: '/api/cron/launcher-tick', headers: { authorization: auth } };
	return handler(req, res).then(() => res);
}

beforeEach(() => {
	process.env.CRON_SECRET = 'test-cron-secret';
	runLauncherTick.mockReset();
});
afterEach(() => {
	delete process.env.CRON_SECRET;
	vi.restoreAllMocks();
});

describe('GET/POST /api/cron/launcher-tick', () => {
	it('rejects a method it does not serve', async () => {
		expect((await call('DELETE')).statusCode).toBe(405);
		expect(runLauncherTick).not.toHaveBeenCalled();
	});

	it('rejects a bad cron secret', async () => {
		expect((await call('GET', 'Bearer wrong')).statusCode).toBe(401);
		expect(runLauncherTick).not.toHaveBeenCalled();
	});

	it('passes the engine tick result through as the 200 body', async () => {
		const tick = { ok: true, scopes: 1, results: [{ ok: true, scope: 'global', skipped: 'cadence gate' }] };
		runLauncherTick.mockResolvedValue(tick);
		const res = await call('POST');
		expect(res.statusCode).toBe(200);
		expect(res.body).toEqual(tick);
		expect(runLauncherTick).toHaveBeenCalledTimes(1);
	});

	it('a throwing engine surfaces as a JSON 500, not a stack trace', async () => {
		runLauncherTick.mockRejectedValue(new Error('boom: /workspaces/secret/path'));
		const res = await call();
		expect(res.statusCode).toBe(500);
		expect(res.body.error).toBe('internal_error');
		// The internal message (which can carry file paths) must not leak.
		expect(JSON.stringify(res.body)).not.toContain('boom');
	});
});
