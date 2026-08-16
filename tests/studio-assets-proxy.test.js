// GET /api/studio-assets/<path>: the same-origin mirror of the loot-assets
// trait library the avatar studio loads from.
//
// Two properties earn a test here. First, the responses are `public,
// s-maxage=86400`, so the body must be a pure function of the path: if any
// request header could steer it, one poisoned request feeds every studio user
// for a day. Second, the handler serves attacker-reachable paths under our own
// origin, so the whitelist, the redirect pin, and the content-type gate are all
// load-bearing and every rejection must be a designed status rather than a
// throw.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const handler = (await import('../api/studio-assets/[...path].js')).default;

function mockReq(pathParts, { method = 'GET', headers = {} } = {}) {
	return {
		method,
		url: `/api/studio-assets/${Array.isArray(pathParts) ? pathParts.join('/') : pathParts}`,
		headers,
		query: { path: pathParts },
	};
}

function mockRes() {
	return {
		statusCode: 200,
		headers: {},
		body: undefined,
		ended: false,
		headersSent: false,
		writableEnded: false,
		setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
		getHeader(k) { return this.headers[k.toLowerCase()]; },
		removeHeader(k) { delete this.headers[k.toLowerCase()]; },
		end(b) { this.body = b; this.ended = true; this.writableEnded = true; },
	};
}

function upstreamResponse({ status = 200, body = '', type = 'application/json', headers = {}, url = 'https://m3-org.github.io/loot-assets/anata/female/manifest.json' } = {}) {
	const bag = new Map(
		Object.entries({ 'content-type': type, ...headers }).map(([k, v]) => [k.toLowerCase(), v]),
	);
	return {
		ok: status >= 200 && status < 300,
		status,
		url,
		headers: { get: (k) => (bag.has(k.toLowerCase()) ? bag.get(k.toLowerCase()) : null) },
		text: async () => body,
		arrayBuffer: async () => new Uint8Array(Buffer.from(body)).buffer,
	};
}

const MANIFEST = JSON.stringify({
	assetsLocation: 'https://m3-org.github.io/loot-assets/',
	traitsDirectory: '/anata/female/',
	animationPath: ['https://m3-org.github.io/loot-assets/animations/2_Idle.fbx'],
});

let fetchMock;

beforeEach(() => {
	fetchMock = vi.fn();
	vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('studio-assets mirror: success path', () => {
	it('serves a rewritten manifest that points every upstream URL back through the proxy', async () => {
		fetchMock.mockResolvedValue(upstreamResponse({ body: MANIFEST }));
		const res = mockRes();
		await handler(mockReq(['anata', 'female', 'manifest.json']), res);

		expect(fetchMock).toHaveBeenCalledWith(
			'https://m3-org.github.io/loot-assets/anata/female/manifest.json',
			expect.objectContaining({ method: 'GET', redirect: 'follow' }),
		);
		expect(res.statusCode).toBe(200);
		expect(res.headers['content-type']).toBe('application/json');
		expect(res.headers['access-control-allow-origin']).toBe('*');
		expect(res.headers['cache-control']).toContain('s-maxage=86400');

		const out = JSON.parse(res.body);
		expect(out.assetsLocation).toBe('/api/studio-assets/');
		expect(out.animationPath[0]).toBe('/api/studio-assets/animations/2_Idle.fbx');
		expect(res.body).not.toContain('m3-org.github.io');
	});

	it('streams a binary trait through untouched', async () => {
		fetchMock.mockResolvedValue(
			upstreamResponse({ body: 'GLB-BYTES', type: 'model/gltf-binary', url: 'https://m3-org.github.io/loot-assets/anata/female/hair.vrm' }),
		);
		const res = mockRes();
		await handler(mockReq(['anata', 'female', 'hair.vrm']), res);

		expect(res.statusCode).toBe(200);
		expect(res.headers['content-type']).toBe('model/gltf-binary');
		expect(Buffer.isBuffer(res.body)).toBe(true);
		expect(res.body.toString()).toBe('GLB-BYTES');
	});

	it('produces a byte-identical body no matter what host headers the caller sends', async () => {
		fetchMock.mockResolvedValue(upstreamResponse({ body: MANIFEST }));
		const honest = mockRes();
		await handler(mockReq(['anata', 'female', 'manifest.json']), honest);

		fetchMock.mockResolvedValue(upstreamResponse({ body: MANIFEST }));
		const spoofed = mockRes();
		await handler(
			mockReq(['anata', 'female', 'manifest.json'], {
				headers: { host: 'evil.example', 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'http' },
			}),
			spoofed,
		);

		expect(spoofed.body).toBe(honest.body);
		expect(spoofed.body).not.toContain('evil.example');
	});
});

describe('studio-assets mirror: rejected requests', () => {
	it('404s a path outside the mirrored trait library instead of proxying it', async () => {
		const res = mockRes();
		await handler(mockReq(['etc', 'passwd']), res);

		expect(res.statusCode).toBe(404);
		expect(JSON.parse(res.body).error).toBe('not_found');
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('404s a double-encoded traversal that survives one decode pass', async () => {
		const res = mockRes();
		await handler(mockReq(['anata', '%2e%2e%2f%2e%2e%2fetc', 'passwd']), res);

		expect(res.statusCode).toBe(404);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('404s a path carrying a query or fragment that would truncate the upstream URL', async () => {
		for (const hostile of ['anata/female?x=1', 'anata/female#frag', 'anata\\..\\etc']) {
			const res = mockRes();
			await handler(mockReq(hostile), res);
			expect(res.statusCode).toBe(404);
		}
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('405s a write method', async () => {
		const res = mockRes();
		await handler(mockReq(['anata', 'female', 'manifest.json'], { method: 'POST' }), res);

		expect(res.statusCode).toBe(405);
		expect(JSON.parse(res.body).error).toBe('method_not_allowed');
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe('studio-assets mirror: upstream failures', () => {
	it('answers 404 when the mirror does not have the asset', async () => {
		fetchMock.mockResolvedValue(upstreamResponse({ status: 404, body: 'nope' }));
		const res = mockRes();
		await handler(mockReq(['anata', 'female', 'missing.json']), res);

		expect(res.statusCode).toBe(404);
		expect(JSON.parse(res.body).error).toBe('not_found');
	});

	it('answers 502 rather than blaming three.ws for a mirror 500', async () => {
		fetchMock.mockResolvedValue(upstreamResponse({ status: 500, body: 'boom' }));
		const res = mockRes();
		await handler(mockReq(['anata', 'female', 'manifest.json']), res);

		expect(res.statusCode).toBe(502);
		expect(JSON.parse(res.body).error).toBe('upstream_error');
	});

	it('answers 502 when the mirror is unreachable', async () => {
		fetchMock.mockRejectedValue(new Error('ETIMEDOUT'));
		const res = mockRes();
		await handler(mockReq(['anata', 'female', 'manifest.json']), res);

		expect(res.statusCode).toBe(502);
		expect(JSON.parse(res.body).error).toBe('upstream_unreachable');
	});

	it('refuses to serve bytes a redirect fetched from off the asset library', async () => {
		fetchMock.mockResolvedValue(
			upstreamResponse({ body: 'pwned', url: 'https://evil.example/payload' }),
		);
		const res = mockRes();
		await handler(mockReq(['anata', 'female', 'manifest.json']), res);

		expect(res.statusCode).toBe(502);
		expect(res.body).not.toContain('pwned');
	});

	it('refuses to serve an HTML document under the three.ws origin', async () => {
		fetchMock.mockResolvedValue(
			upstreamResponse({ body: '<script>alert(1)</script>', type: 'text/html; charset=utf-8' }),
		);
		const res = mockRes();
		await handler(mockReq(['anata', 'female', 'manifest.json']), res);

		expect(res.statusCode).toBe(502);
		expect(res.body).not.toContain('<script>');
	});
});

describe('studio-assets mirror: HEAD', () => {
	it('omits the compressed upstream length instead of understating the body', async () => {
		fetchMock.mockResolvedValue(
			upstreamResponse({ body: MANIFEST, headers: { 'content-length': '2445', 'content-encoding': 'gzip' } }),
		);
		const res = mockRes();
		await handler(mockReq(['anata', 'female', 'manifest.json'], { method: 'HEAD' }), res);

		expect(res.statusCode).toBe(200);
		expect(res.headers['content-length']).toBeUndefined();
		expect(res.body).toBeUndefined();
	});

	it('forwards the length of an uncompressed binary asset', async () => {
		fetchMock.mockResolvedValue(
			upstreamResponse({ body: '', type: 'model/gltf-binary', headers: { 'content-length': '81920' } }),
		);
		const res = mockRes();
		await handler(mockReq(['anata', 'female', 'hair.vrm'], { method: 'HEAD' }), res);

		expect(res.statusCode).toBe(200);
		expect(res.headers['content-length']).toBe('81920');
	});
});
