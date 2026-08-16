// /api/sdp/* : the same-origin proxy in front of the Solana Developer Platform.
//
// The SDP key grants org-level control over custodial wallets, SPL issuance and
// payments, so the properties pinned here are the ones that keep that key from
// becoming an open capability:
//   1. only the upstream's real route surface forwards; everything else 404s
//      before a request leaves the box (no open proxy, no traversal).
//   2. every key-bearing route requires an authenticated admin, and a mutating
//      one additionally requires a same-origin request.
//   3. the unauthenticated public surface (health/openapi/llms.txt) stays open.
//   4. the caller's own Authorization header is never relayed upstream.
//   5. the request body reaches upstream even when the client sends it chunked
//      with no Content-Length, and an upstream markup body is never replayed as
//      markup from our origin.
//
// sdpRequest is mocked, so no network and no SDP key are involved.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const sdpRequest = vi.fn();
const requireAdmin = vi.fn();

vi.mock('../api/_lib/sdp.js', async (importOriginal) => {
	const actual = await importOriginal();
	return { ...actual, sdpRequest: (...args) => sdpRequest(...args) };
});

vi.mock('../api/_lib/admin.js', () => ({
	requireAdmin: (...args) => requireAdmin(...args),
}));

vi.mock('../api/_lib/rate-limit.js', async (importOriginal) => {
	const actual = await importOriginal();
	return {
		...actual,
		clientIp: () => '203.0.113.7',
		limits: { ...actual.limits, sdpIp: async () => ({ success: true }) },
	};
});

const handler = (await import('../api/sdp/[...path].js')).default;

function makeRes() {
	return {
		statusCode: 200,
		headers: {},
		body: null,
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = v;
		},
		getHeader(k) {
			return this.headers[k.toLowerCase()];
		},
		removeHeader(k) {
			delete this.headers[k.toLowerCase()];
		},
		writeHead(code) {
			this.statusCode = code;
			return this;
		},
		end(payload) {
			if (payload !== undefined && this.body === null) this.body = payload;
			this.finished = true;
			return this;
		},
	};
}

async function call(path, { method = 'GET', headers = {}, query = {}, body } = {}) {
	const res = makeRes();
	const req = {
		method,
		url: `/api/sdp/${path}`,
		headers: { host: 'three.ws', ...headers },
		query: { path: path.split('/'), ...query },
	};
	if (body !== undefined) req.body = body;
	await handler(req, res);
	let parsed = res.body;
	if (typeof parsed === 'string') {
		try {
			parsed = JSON.parse(parsed);
		} catch {
			/* a text relay body stays a string */
		}
	}
	return { status: res.statusCode, body: parsed, raw: res.body, headers: res.headers };
}

beforeEach(() => {
	sdpRequest.mockReset();
	requireAdmin.mockReset();
	requireAdmin.mockResolvedValue({ id: 'u_admin' });
	sdpRequest.mockResolvedValue({
		status: 200,
		contentType: 'application/json; charset=utf-8',
		traceId: 'req_test',
		body: { ok: true },
	});
	process.env.APP_ORIGIN = 'https://three.ws';
});

describe('route allowlist', () => {
	it('404s an unknown route without calling upstream', async () => {
		const r = await call('not-a-real-route');
		expect(r.status).toBe(404);
		expect(r.body.error).toBe('not_found');
		expect(sdpRequest).not.toHaveBeenCalled();
	});

	it('404s a traversal attempt, including a double-encoded one', async () => {
		for (const p of ['v1/../../etc/passwd', 'v1/%2e%2e%2fetc']) {
			const r = await call(p);
			expect(r.status).toBe(404);
		}
		expect(sdpRequest).not.toHaveBeenCalled();
	});

	it('caps the echoed path so an oversized probe cannot be reflected wholesale', async () => {
		const r = await call(`bogus${'a'.repeat(500)}`);
		expect(r.status).toBe(404);
		expect(r.body.error_description.length).toBeLessThan(200);
	});
});

describe('authorization', () => {
	it('requires an admin on a key-bearing route', async () => {
		requireAdmin.mockImplementation(async (_req, res) => {
			res.statusCode = 401;
			res.end(JSON.stringify({ error: 'unauthorized' }));
			return null;
		});
		const r = await call('v1/wallets');
		expect(r.status).toBe(401);
		expect(sdpRequest).not.toHaveBeenCalled();
	});

	it('blocks a mutating call that did not originate from our own origin', async () => {
		const r = await call('v1/issuance/tokens', {
			method: 'POST',
			headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
			body: { name: 'x' },
		});
		expect(r.status).toBe(403);
		expect(sdpRequest).not.toHaveBeenCalled();
	});

	it('allows a mutating call from our own origin', async () => {
		const r = await call('v1/issuance/tokens', {
			method: 'POST',
			headers: { origin: 'https://three.ws', 'content-type': 'application/json' },
			body: { name: 'x' },
		});
		expect(r.status).toBe(200);
		expect(sdpRequest).toHaveBeenCalledTimes(1);
	});

	it('leaves the public health and doc surfaces unauthenticated', async () => {
		for (const p of ['health', 'health/ready', 'openapi.json', 'llms.txt']) {
			sdpRequest.mockClear();
			const r = await call(p);
			expect(r.status).toBe(200);
			expect(sdpRequest).toHaveBeenCalledTimes(1);
		}
		expect(requireAdmin).not.toHaveBeenCalled();
	});
});

describe('forwarding', () => {
	it('never relays the caller Authorization header, and relays idempotency-key', async () => {
		await call('v1/wallets', {
			method: 'POST',
			headers: {
				origin: 'https://three.ws',
				authorization: 'Bearer attacker-supplied',
				'idempotency-key': 'idem-1',
				'content-type': 'application/json',
			},
			body: { label: 'w' },
		});
		const opts = sdpRequest.mock.calls[0][1];
		expect(opts.headers.authorization).toBeUndefined();
		expect(opts.headers['idempotency-key']).toBe('idem-1');
	});

	it('forwards the caller query string but never the catch-all path param', async () => {
		await call('v1/wallets', { query: { limit: '25', cursor: 'abc' } });
		const opts = sdpRequest.mock.calls[0][1];
		expect(opts.query).toEqual({ limit: '25', cursor: 'abc' });
		expect(opts.query.path).toBeUndefined();
	});

	it('forwards a chunked body that carries no content-length', async () => {
		await call('v1/wallets', {
			method: 'POST',
			headers: {
				origin: 'https://three.ws',
				'content-type': 'application/json',
				'transfer-encoding': 'chunked',
			},
			body: { label: 'streamed' },
		});
		expect(sdpRequest.mock.calls[0][1].body).toEqual({ label: 'streamed' });
	});

	it('sends no body when the request genuinely has none', async () => {
		await call('v1/payments/transfers', {
			method: 'POST',
			headers: { origin: 'https://three.ws' },
		});
		expect(sdpRequest.mock.calls[0][1].body).toBeUndefined();
	});
});

describe('response relay', () => {
	it('relays the upstream status, envelope and trace id verbatim', async () => {
		sdpRequest.mockResolvedValue({
			status: 422,
			contentType: 'application/json',
			traceId: 'req_abc',
			body: { error: { code: 'invalid_request', message: 'bad mint' } },
		});
		const r = await call('v1/issuance/tokens', {
			method: 'POST',
			headers: { origin: 'https://three.ws', 'content-type': 'application/json' },
			body: { name: 'x' },
		});
		expect(r.status).toBe(422);
		expect(r.body.error.code).toBe('invalid_request');
		expect(r.headers['x-sdp-trace-id']).toBe('req_abc');
	});

	it('relays a text body with its own content type and no caching', async () => {
		sdpRequest.mockResolvedValue({
			status: 200,
			contentType: 'text/plain; charset=utf-8',
			traceId: null,
			body: '# Solana Developer Platform API',
		});
		const r = await call('llms.txt');
		expect(r.raw).toBe('# Solana Developer Platform API');
		expect(r.headers['content-type']).toBe('text/plain; charset=utf-8');
		expect(r.headers['cache-control']).toBe('no-store');
	});

	it('downgrades a markup body so it cannot execute under our own CSP', async () => {
		sdpRequest.mockResolvedValue({
			status: 400,
			contentType: 'text/html; charset=utf-8',
			traceId: null,
			body: '<script>alert(1)</script>',
		});
		const r = await call('llms.txt');
		expect(r.status).toBe(400);
		expect(r.headers['content-type']).toBe('text/plain; charset=utf-8');
	});
});
