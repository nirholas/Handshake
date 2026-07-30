// Verifies the navigation-aware 5xx branch in wrap() (api/_lib/http.js): a real
// browser navigation that hits an uncaught server error is redirected to the
// branded /500 page carrying its support ref + the original (redacted) path,
// while a programmatic API / agent call keeps receiving the JSON error envelope.
// This is what makes the human error UX beautiful without changing the contract
// every x402 / agent client depends on.

import { describe, it, expect } from 'vitest';
import { wrap } from '../../api/_lib/http.js';

function mockReq({ method = 'GET', url = '/api/thing?x=1', headers = {} } = {}) {
	return { method, url, headers };
}

function mockRes() {
	return {
		statusCode: 200,
		headers: {},
		body: null,
		headersSent: false,
		writableEnded: false,
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = String(v);
		},
		end(payload) {
			this.writableEnded = true;
			this.body = payload ?? null;
		},
	};
}

const boom = wrap(async () => {
	throw new Error('kaboom: https://mainnet.helius-rpc.com/?api-key=sk_live_LEAK');
});

describe('wrap() 5xx navigation routing', () => {
	it('redirects a top-level browser navigation to /500 with a ref and the from path', async () => {
		const req = mockReq({
			url: '/agent/abc?lat=37.77&token=secret',
			headers: { 'sec-fetch-mode': 'navigate', accept: 'text/html' },
		});
		const res = mockRes();
		await boom(req, res);

		expect(res.statusCode).toBe(303);
		const loc = res.headers['location'];
		expect(loc).toMatch(/^\/500\.html\?/);

		const q = new URLSearchParams(loc.slice('/500.html?'.length));
		// A correlation ref is present and looks like our 16-hex id.
		expect(q.get('ref')).toMatch(/^[0-9a-f]{16}$/);
		// `from` round-trips the original path so "Try again" retries it…
		const from = q.get('from');
		expect(from).toContain('/agent/abc');
		// …but the geo + token are redacted out of it (it lands in the address bar).
		expect(from).not.toContain('37.77');
		expect(from).not.toContain('secret');
		expect(from).toContain('REDACTED');

		// Never leak the upstream API key, not even into the redirect URL.
		expect(loc).not.toContain('sk_live_LEAK');
	});

	it('returns the JSON envelope (not a redirect) for a programmatic API call', async () => {
		// No Sec-Fetch-Mode: navigate → treated as an API / agent caller.
		const req = mockReq({ headers: { accept: 'application/json' } });
		const res = mockRes();
		await boom(req, res);

		expect(res.statusCode).toBe(500);
		expect(res.headers['location']).toBeUndefined();
		const body = JSON.parse(res.body);
		expect(body.error).toBe('internal_error');
		expect(body.ref).toMatch(/^[0-9a-f]{16}$/);
		expect(body.error_description).toContain(body.ref);
		// The sanitized envelope never carries the raw upstream message / key.
		expect(res.body).not.toContain('sk_live_LEAK');
	});

	it('treats a fetch() request (sec-fetch-mode: cors) as an API call', async () => {
		const req = mockReq({ headers: { 'sec-fetch-mode': 'cors', accept: 'text/html' } });
		const res = mockRes();
		await boom(req, res);
		// Even though Accept prefers HTML, an explicit non-navigate mode wins.
		expect(res.statusCode).toBe(500);
		expect(res.headers['location']).toBeUndefined();
	});
});

// A 5xx has two very different sources, and they need opposite handling: an error
// the endpoint author wrote (`503 upstream_unavailable`) is contract a caller must
// be able to react to, while an error that merely bubbled up carries internal
// detail (SQLSTATE, ECONNREFUSED, a keyed RPC URL) and must stay redacted. The
// `expose` marker is the only thing that separates them.
describe('wrap() 5xx code exposure', () => {
	it('hands back a deliberate contract code and message', async () => {
		const handler = wrap(async () => {
			throw Object.assign(new Error('pump.fun data source is temporarily unreachable'), {
				status: 503,
				code: 'upstream_unavailable',
				expose: true,
			});
		});
		const req = mockReq({ headers: { accept: 'application/json' } });
		const res = mockRes();
		await handler(req, res);

		expect(res.statusCode).toBe(503);
		const body = JSON.parse(res.body);
		expect(body.error).toBe('upstream_unavailable');
		expect(body.error_description).toContain('temporarily unreachable');
		expect(body.ref).toMatch(/^[0-9a-f]{16}$/);
	});

	it('still redacts a 5xx code that was never marked as contract', async () => {
		const handler = wrap(async () => {
			// Shaped like a Postgres failure: the code names the storage engine's fault
			// and the message carries the credentialed host.
			throw Object.assign(new Error('relation "users" does not exist at db://user:pw@host'), {
				status: 500,
				code: '42P01',
			});
		});
		const req = mockReq({ headers: { accept: 'application/json' } });
		const res = mockRes();
		await handler(req, res);

		expect(res.statusCode).toBe(500);
		const body = JSON.parse(res.body);
		expect(body.error).toBe('internal_error');
		expect(res.body).not.toContain('42P01');
		expect(res.body).not.toContain('user:pw@host');
	});
});
