// Tests for POST /api/club/presence: the in-memory viewer counter behind the
// /club room liveliness number. The rate limiter is mocked so the handler runs
// in pure-unit mode; module-level session state persists across tests in this
// file, so count assertions are relative deltas rather than absolutes.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Readable } from 'node:stream';

const rlState = { success: true };
const ipState = { ip: '10.0.0.1' };
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: { clubPresenceIp: vi.fn(async () => rlState) },
	clientIp: vi.fn(() => ipState.ip),
}));

const { default: handler } = await import('../../api/club/presence.js');

function makeReq({ method = 'POST', body = null, headers = {} } = {}) {
	const chunks = body === null ? [] : [JSON.stringify(body)];
	const r = Readable.from(chunks);
	r.method = method;
	r.url = '/api/club/presence';
	r.headers = { host: 'localhost', 'content-type': 'application/json', ...headers };
	return r;
}

function makeRes() {
	return {
		statusCode: 200,
		headers: {},
		body: '',
		writableEnded: false,
		writeHead(status, headers = {}) {
			this.statusCode = status;
			for (const [k, v] of Object.entries(headers)) {
				this.headers[k.toLowerCase()] = v;
			}
		},
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = v;
		},
		write(chunk) {
			this.body += chunk;
		},
		end(chunk) {
			if (chunk !== undefined) this.body += chunk;
			this.writableEnded = true;
		},
		on() {},
	};
}

async function invoke(opts = {}) {
	const req = makeReq(opts);
	const res = makeRes();
	await handler(req, res);
	let payload = null;
	if (res.body) {
		try { payload = JSON.parse(res.body); } catch { payload = res.body; }
	}
	return { res, status: res.statusCode, body: payload };
}

beforeEach(() => {
	rlState.success = true;
	// Each test gets its own address so earlier tests' sessions never eat into
	// the per-IP cap this file's last test exercises.
	ipState.ip = `10.0.0.${Math.floor(Math.random() * 250) + 1}`;
});

describe('POST /api/club/presence', () => {
	it('counts a new session and reports it as counted', async () => {
		const before = await invoke({ body: { session: 'presence-test-base' } });
		expect(before.status).toBe(200);
		const { status, body } = await invoke({ body: { session: 'presence-test-main' } });
		expect(status).toBe(200);
		expect(body.count).toBe(before.body.count + 1);
		expect(body.counted).toBe(true);
	});

	it('renews an existing session without growing the count', async () => {
		const first = await invoke({ body: { session: 'presence-test-renew' } });
		const second = await invoke({ body: { session: 'presence-test-renew' } });
		expect(second.status).toBe(200);
		expect(second.body.count).toBe(first.body.count);
		expect(second.body.counted).toBe(true);
	});

	it('rejects a missing session id with a 400 JSON error', async () => {
		const { status, body } = await invoke({ body: {} });
		expect(status).toBe(400);
		expect(body.error).toBe('validation_error');
	});

	it('rejects a non-string session id with a 400 JSON error', async () => {
		const { status, body } = await invoke({ body: { session: 42 } });
		expect(status).toBe(400);
		expect(body.error).toBe('validation_error');
	});

	it('rejects the wrong method with a 405 JSON error', async () => {
		const { status, body } = await invoke({ method: 'GET' });
		expect(status).toBe(405);
		expect(body.error).toBe('method_not_allowed');
	});

	it('answers 429 with retry-after when the limiter blocks the IP', async () => {
		rlState.success = false;
		// The limiter result carries an absolute epoch-ms reset; Retry-After is
		// derived from it (api/_lib/http.js setRateLimitHeaders).
		rlState.reset = Date.now() + 30_000;
		const { res, status, body } = await invoke({ body: { session: 'presence-test-rl' } });
		expect(status).toBe(429);
		expect(body.error).toBe('rate_limited');
		expect(res.headers['retry-after']).toBe('30');
	});

	it('caps one address at 12 slots and reports the overflow as not counted', async () => {
		// Fresh address for this test: the cap counts every live session the IP
		// holds, including any this file added earlier.
		ipState.ip = '10.77.77.77';
		for (let i = 0; i < 12; i++) {
			const r = await invoke({ body: { session: `presence-test-cap-${i}` } });
			expect(r.body.counted).toBe(true);
		}
		const overflow = await invoke({ body: { session: 'presence-test-cap-12' } });
		expect(overflow.status).toBe(200);
		expect(overflow.body.counted).toBe(false);
	});
});
