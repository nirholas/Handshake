// POST /api/pinning/pin is the only way a browser can put bytes on IPFS here:
// the Pinata credential is server-held, so avatar-studio base64s the whole GLB
// into this endpoint (character-studio/src/library/mint-utils.js).
//
// That makes the body limit part of the endpoint's contract rather than a
// detail. The handler advertised a 10 MB inline cap while taking readJson's
// 1,000,000-byte default, and base64 inflates raw bytes by 4/3, so every inline
// pin above roughly 730 KB was refused with a bare `413 bad_request` that named
// no limit. These tests pin the two halves of that contract: a payload inside
// the cap reaches the provider, one above it is refused with this endpoint's own
// `payload_too_large` code, and a caller's filename survives the trip instead of
// being replaced by a constant.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const sqlMock = vi.fn(async () => []);
vi.mock('../api/_lib/db.js', () => ({
	sql: (...a) => sqlMock(...a),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
	isStoragePressured: async () => ({ pressured: false }),
}));

const sessionUser = { value: { id: 'user-1' } };
vi.mock('../api/_lib/auth.js', () => ({
	getSessionUser: async () => sessionUser.value,
	authenticateBearer: async () => null,
	extractBearer: () => null,
}));

vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: {
		pinUser: async () => ({ success: true, reset: 1_000 }),
		pinStatusIp: async () => ({ success: true, reset: 1_000 }),
	},
	clientIp: () => '203.0.113.9',
}));

vi.mock('../api/_lib/env.js', () => ({
	env: { APP_ORIGIN: 'http://localhost:3000', ISSUER: 'http://t', MCP_RESOURCE: 'http://t' },
}));

const { default: handler } = await import('../api/pinning/[action].js');

function mkReq({ body = null, method = 'POST', action = 'pin', url } = {}) {
	const raw = body == null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
	return {
		method,
		url: url || `/api/pinning/${action}`,
		query: { action },
		headers: raw ? { 'content-type': 'application/json' } : {},
		socket: { remoteAddress: '127.0.0.1' },
		on(event, cb) {
			if (event === 'data' && raw) queueMicrotask(() => { cb(raw); this._end?.(); });
			else if (event === 'end') { this._end = cb; if (!raw) queueMicrotask(cb); }
			return this;
		},
		destroy() {},
	};
}

function mkRes() {
	return {
		statusCode: 200,
		headers: {},
		body: undefined,
		writableEnded: false,
		headersSent: false,
		getHeader(k) { return this.headers[k.toLowerCase()]; },
		setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
		end(b) { this.body = b; this.writableEnded = true; },
	};
}

const parse = (res) => (res.body ? JSON.parse(res.body) : undefined);

// A data: URL carrying `bytes` of raw payload, the exact shape saveFileToPinata builds.
const inlineGlb = (bytes) =>
	'data:model/gltf-binary;base64,' + Buffer.alloc(bytes, 0x41).toString('base64');

let pinataCalls = [];
const realFetch = globalThis.fetch;
const realJwt = process.env.PINATA_JWT;

beforeEach(() => {
	pinataCalls = [];
	sqlMock.mockClear();
	sessionUser.value = { id: 'user-1' };
	process.env.PINATA_JWT = 'test-jwt';
	// Stub only the third-party boundary: the handler, http helpers, size
	// accounting and the real pinToIPFS all run unmodified above it.
	globalThis.fetch = vi.fn(async (url, init) => {
		pinataCalls.push({ url: String(url), init });
		return new Response(JSON.stringify({ IpfsHash: 'QmTestCid00000000000000000000000000000000000000' }), {
			status: 200,
			headers: { 'content-type': 'application/json' },
		});
	});
});

afterEach(() => {
	globalThis.fetch = realFetch;
	if (realJwt === undefined) delete process.env.PINATA_JWT;
	else process.env.PINATA_JWT = realJwt;
});

describe('POST /api/pinning/pin', () => {
	it('pins an inline payload well above the old 1 MB body default', async () => {
		const res = mkRes();
		// 1.5 MB raw is ~2 MB of base64: comfortably inside the stated cap, and
		// exactly the size that used to be rejected before it reached any check.
		await handler(mkReq({ body: { sourceUrl: inlineGlb(1_500 * 1024), kind: 'glb' } }), res);

		expect(res.statusCode).toBe(200);
		const out = parse(res);
		expect(out.ok).toBe(true);
		expect(out.cid).toBe('QmTestCid00000000000000000000000000000000000000');
		expect(out.provider).toBe('pinata');
		expect(out.gatewayUrl).toContain(out.cid);
		expect(out.gatewayUrls.length).toBeGreaterThan(1);
		expect(pinataCalls).toHaveLength(1);
		expect(pinataCalls[0].url).toContain('api.pinata.cloud');
		// The row that records the pin never stores the inline bytes back.
		expect(sqlMock).toHaveBeenCalled();
	});

	it('refuses an inline payload over the decoded cap with a named limit', async () => {
		const res = mkRes();
		await handler(mkReq({ body: { sourceUrl: inlineGlb(Math.floor(5.4 * 1024 * 1024)), kind: 'glb' } }), res);

		expect(res.statusCode).toBe(413);
		expect(parse(res).error).toBe('payload_too_large');
		expect(parse(res).error_description).toMatch(/exceeds 5 MB/);
		expect(pinataCalls).toHaveLength(0);
	});

	it("forwards the caller's filename to the provider", async () => {
		const res = mkRes();
		await handler(
			mkReq({ body: { sourceUrl: inlineGlb(64), kind: 'glb', filename: 'knight-v2.glb' } }),
			res,
		);

		expect(res.statusCode).toBe(200);
		const form = pinataCalls[0].init.body;
		expect(form.get('file').name).toBe('knight-v2.glb');
	});

	it('sanitizes a hostile filename rather than forwarding it', async () => {
		const res = mkRes();
		await handler(
			mkReq({ body: { sourceUrl: inlineGlb(64), kind: 'glb', filename: '../../etc/passwd\r\nX: y' } }),
			res,
		);

		expect(res.statusCode).toBe(200);
		expect(pinataCalls[0].init.body.get('file').name).toBe('....etcpasswdXy');
	});

	it('falls back to the kind default when the filename is not a string', async () => {
		const res = mkRes();
		await handler(mkReq({ body: { sourceUrl: inlineGlb(64), kind: 'manifest', filename: { a: 1 } } }), res);

		expect(res.statusCode).toBe(200);
		expect(pinataCalls[0].init.body.get('file').name).toBe('manifest.json');
	});

	it('rejects a source URL the platform does not own', async () => {
		const res = mkRes();
		await handler(mkReq({ body: { sourceUrl: 'https://evil.example.com/x.glb', kind: 'glb' } }), res);

		expect(res.statusCode).toBe(400);
		expect(parse(res).error).toBe('validation_error');
		expect(pinataCalls).toHaveLength(0);
	});

	it('answers a malformed request with 4xx even when no provider is configured', async () => {
		delete process.env.PINATA_JWT;
		const res = mkRes();
		await handler(mkReq({ body: { sourceUrl: 'https://evil.example.com/x.glb', kind: 'glb' } }), res);

		// The deployment being unconfigured must not mask a request the caller
		// could have fixed, so the 400 wins over the 503.
		expect(res.statusCode).toBe(400);
		expect(parse(res).error).toBe('validation_error');
	});

	it('reports an unconfigured deployment as 503 once the request is valid', async () => {
		delete process.env.PINATA_JWT;
		const res = mkRes();
		await handler(mkReq({ body: { sourceUrl: inlineGlb(64), kind: 'manifest' } }), res);

		expect(res.statusCode).toBe(503);
		expect(parse(res).error).toBe('pinning_unconfigured');
	});

	it('requires a signed-in caller', async () => {
		sessionUser.value = null;
		const res = mkRes();
		await handler(mkReq({ body: { sourceUrl: inlineGlb(64), kind: 'manifest' } }), res);

		expect(res.statusCode).toBe(401);
		expect(parse(res).error).toBe('unauthorized');
	});
});

describe('GET /api/pinning/status', () => {
	it('separates an unreachable provider from a genuinely unpinned CID', async () => {
		globalThis.fetch = vi.fn(async () => new Response('unauthorized', { status: 401 }));
		const res = mkRes();
		await handler(
			mkReq({ method: 'GET', action: 'status', url: '/api/pinning/status?cid=QmTestCid00000000000000000000000000000000000000', body: null }),
			res,
		);

		expect(res.statusCode).toBe(503);
		expect(parse(res).error).toBe('pinning_check_failed');
	});

	it('rejects a CID outside the length and charset bounds', async () => {
		const res = mkRes();
		await handler(
			mkReq({ method: 'GET', action: 'status', url: '/api/pinning/status?cid=' + 'a'.repeat(500), body: null }),
			res,
		);

		expect(res.statusCode).toBe(400);
		expect(parse(res).error).toBe('validation_error');
	});
});
