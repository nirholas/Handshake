// Smoke + Resend-probe tests for /api/healthz. The handler dispatches its
// Resend check against the real API in production; here we stub fetch and
// assert the dispatch logic. No network calls leave the test.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../api/_lib/zauth.js', () => ({ instrument: () => {}, drain: async () => {} }));
vi.mock('../../api/_lib/sentry.js', () => ({ captureException: () => {} }));
// Keep the suite hermetic: with no DB, probeMonitor falls back to the
// serverless-liveness signal (running: true) and the x402 sub-probes degrade
// gracefully. Without this mock the build would query the production DB, where
// a stale bot_heartbeat row flips monitor.running to false and fails the smoke
// test non-deterministically.
vi.mock('../../api/_lib/db.js', () => ({
	sql: () => { throw new Error('no database in test'); },
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

import healthz, { _resetResendCache, _resetMonitorCache, _resetX402Cache } from '../../api/healthz.js';

function makeReq({ method = 'GET' } = {}) { return { url: '/api/healthz', method, headers: {} }; }
function makeRes() {
	return {
		statusCode: 200,
		_h: {},
		setHeader(k, v) { this._h[k.toLowerCase()] = v; },
		getHeader(k) { return this._h[k.toLowerCase()]; },
		end(body) { this._body = body; },
	};
}

async function callHealthz() {
	const res = makeRes();
	await healthz(makeReq(), res);
	return { res, body: JSON.parse(res._body) };
}

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_KEY = process.env.RESEND_API_KEY;

beforeEach(() => {
	_resetResendCache();
	_resetMonitorCache();
	_resetX402Cache();
	delete process.env.RESEND_API_KEY;
});

afterEach(() => {
	globalThis.fetch = ORIGINAL_FETCH;
	if (ORIGINAL_KEY === undefined) delete process.env.RESEND_API_KEY;
	else process.env.RESEND_API_KEY = ORIGINAL_KEY;
});

describe('GET /api/healthz', () => {
	it('returns 200 with status=ok and uptime fields', async () => {
		const { res, body } = await callHealthz();
		expect(res.statusCode).toBe(200);
		expect(body.status).toBe('ok');
		expect(body.service).toBe('3d-agent');
		expect(typeof body.uptime).toBe('number');
		expect(typeof body.uptimeMs).toBe('number');
		expect(body.monitor.running).toBe(true);
	});

	// Ops alerts always persist to the dashboard (ops_alerts / /admin/ops); the
	// dashboard is the primary sink and is never a no-op. Telegram is an optional
	// extra push. healthz reports the dashboard as primary and telegram_push as
	// enabled/disabled — a disabled push is expected, not a fault.
	describe('ops alert channel', () => {
		const SAVED = [process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_ALERTS_CHAT_ID];
		afterEach(() => {
			for (const [k, v] of [['TELEGRAM_BOT_TOKEN', SAVED[0]], ['TELEGRAM_ALERTS_CHAT_ID', SAVED[1]]]) {
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
		});

		it('always reports the dashboard as the primary sink', async () => {
			delete process.env.TELEGRAM_BOT_TOKEN;
			delete process.env.TELEGRAM_ALERTS_CHAT_ID;
			const { body } = await callHealthz();
			expect(body.alerts.primary).toBe('dashboard');
			expect(body.alerts.dashboard).toBe('/admin/ops');
			// No "silent no-op" framing — alerts persist regardless of Telegram.
			expect(body.alerts.warning).toBeUndefined();
		});

		it('reports telegram_push disabled when the channel is unwired or half-set', async () => {
			delete process.env.TELEGRAM_BOT_TOKEN;
			delete process.env.TELEGRAM_ALERTS_CHAT_ID;
			expect((await callHealthz()).body.alerts.telegram_push).toBe('disabled');

			process.env.TELEGRAM_BOT_TOKEN = 'bot-token';
			delete process.env.TELEGRAM_ALERTS_CHAT_ID;
			expect((await callHealthz()).body.alerts.telegram_push).toBe('disabled');
		});

		it('reports telegram_push enabled once both vars are set', async () => {
			process.env.TELEGRAM_BOT_TOKEN = 'bot-token';
			process.env.TELEGRAM_ALERTS_CHAT_ID = '-1001234567890';
			const { body } = await callHealthz();
			expect(body.alerts.telegram_push).toBe('enabled');
		});
	});

	it('rejects non-GET methods', async () => {
		const res = makeRes();
		await healthz(makeReq({ method: 'POST' }), res);
		expect(res.statusCode).toBe(405);
	});

	it('cache-control allows brief edge caching', async () => {
		const { res } = await callHealthz();
		expect(res.getHeader('cache-control')).toMatch(/max-age=/);
	});
});

describe('GET /api/healthz — resend probe', () => {
	it('reports "missing" when RESEND_API_KEY is unset', async () => {
		globalThis.fetch = vi.fn(); // must not be called
		const { body } = await callHealthz();
		expect(body.resend).toBe('missing');
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it('reports "configured" when Resend returns 200', async () => {
		process.env.RESEND_API_KEY = 're_test_key';
		globalThis.fetch = vi.fn(async () => ({
			ok: true,
			status: 200,
			text: async () => '',
		}));
		const { body } = await callHealthz();
		expect(body.resend).toBe('configured');
		expect(globalThis.fetch).toHaveBeenCalledOnce();
		const [url, opts] = globalThis.fetch.mock.calls[0];
		expect(url).toBe('https://api.resend.com/domains');
		expect(opts.headers.Authorization).toBe('Bearer re_test_key');
	});

	it('reports "configured" on 401 with restricted_api_key body (send-only key)', async () => {
		process.env.RESEND_API_KEY = 're_restricted_key';
		globalThis.fetch = vi.fn(async () => ({
			ok: false,
			status: 401,
			text: async () => '{"name":"restricted_api_key","message":"send only"}',
		}));
		const { body } = await callHealthz();
		expect(body.resend).toBe('configured');
	});

	it('reports "key_invalid" on 401 without restricted_api_key body', async () => {
		process.env.RESEND_API_KEY = 're_bad_key';
		globalThis.fetch = vi.fn(async () => ({
			ok: false,
			status: 401,
			text: async () => '{"name":"invalid_api_key","message":"nope"}',
		}));
		const { body } = await callHealthz();
		expect(body.resend).toBe('key_invalid');
	});

	it('reports "key_invalid" on a 500 from Resend', async () => {
		process.env.RESEND_API_KEY = 're_test_key';
		globalThis.fetch = vi.fn(async () => ({
			ok: false,
			status: 500,
			text: async () => 'server error',
		}));
		const { body } = await callHealthz();
		expect(body.resend).toBe('key_invalid');
	});

	it('reports "key_invalid" when the fetch rejects (timeout / network error)', async () => {
		process.env.RESEND_API_KEY = 're_test_key';
		globalThis.fetch = vi.fn(async () => {
			throw new Error('timeout');
		});
		const { body } = await callHealthz();
		expect(body.resend).toBe('key_invalid');
	});

	it('caches the probe result for 5 minutes (no second fetch within the window)', async () => {
		process.env.RESEND_API_KEY = 're_test_key';
		globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, text: async () => '' }));
		const first = await callHealthz();
		const second = await callHealthz();
		expect(first.body.resend).toBe('configured');
		expect(second.body.resend).toBe('configured');
		expect(globalThis.fetch).toHaveBeenCalledOnce();
	});
});
