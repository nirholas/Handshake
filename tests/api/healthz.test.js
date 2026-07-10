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

	// api/_lib/alerts.js is a deliberate silent no-op without both env vars. That
	// is right for dev/tests and wrong to leave unnoticed in production, where it
	// means every 5xx report, ring-leak CRITICAL, and low-balance warning is
	// dropped with nothing to show for it. healthz must report the gate honestly.
	describe('ops alert channel', () => {
		const SAVED = [process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_ALERTS_CHAT_ID];
		afterEach(() => {
			for (const [k, v] of [['TELEGRAM_BOT_TOKEN', SAVED[0]], ['TELEGRAM_ALERTS_CHAT_ID', SAVED[1]]]) {
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
		});

		it('reports configured=false AND a warning when the channel is unwired', async () => {
			delete process.env.TELEGRAM_BOT_TOKEN;
			delete process.env.TELEGRAM_ALERTS_CHAT_ID;
			const { body } = await callHealthz();
			expect(body.alerts.configured).toBe(false);
			expect(body.alerts.warning).toMatch(/silent no-op/i);
			expect(body.alerts.requires).toEqual(['TELEGRAM_BOT_TOKEN', 'TELEGRAM_ALERTS_CHAT_ID']);
		});

		it('reports configured=false when only one of the two vars is set', async () => {
			process.env.TELEGRAM_BOT_TOKEN = 'bot-token';
			delete process.env.TELEGRAM_ALERTS_CHAT_ID;
			const { body } = await callHealthz();
			expect(body.alerts.configured).toBe(false);
		});

		it('reports configured=true with no warning once both vars are set', async () => {
			process.env.TELEGRAM_BOT_TOKEN = 'bot-token';
			process.env.TELEGRAM_ALERTS_CHAT_ID = '-1001234567890';
			const { body } = await callHealthz();
			expect(body.alerts.configured).toBe(true);
			expect(body.alerts.warning).toBeUndefined();
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
