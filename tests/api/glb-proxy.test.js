// Tests for the CORS-open GLB proxy. The proxy exists so <model-viewer> and
// other browser loaders can fetch generated models from ANY origin (Jupyter,
// Colab, partner embeds), which the object store's origin allowlist blocks.
// Network-free: the SSRF fetcher is mocked; what's under test is validation,
// status mapping, and the CORS/caching contract.

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createServer } from 'node:http';

const GLB_BYTES = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 1, 0, 0, 0]);

vi.mock('../../api/_lib/fetch-model.js', () => ({
	fetchModel: vi.fn(async (url) => {
		if (url.includes('169.254.')) {
			throw Object.assign(new Error('private address'), { code: 'private_address' });
		}
		if (url.startsWith('file:')) {
			throw Object.assign(new Error('scheme not allowed'), { code: 'scheme_not_allowed' });
		}
		if (url.includes('huge')) {
			throw Object.assign(new Error('too large'), { code: 'file_too_large' });
		}
		if (url.includes('down')) {
			throw Object.assign(new Error('upstream returned 503'), { code: 'upstream_error' });
		}
		return { bytes: GLB_BYTES };
	}),
}));

let server;
let base;

beforeAll(async () => {
	const { default: handler } = await import('../../api/glb.js');
	server = createServer((req, res) => handler(req, res));
	await new Promise((r) => server.listen(0, '127.0.0.1', r));
	base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => server?.close());

const src = (u) => `${base}/api/glb?src=${encodeURIComponent(u)}`;

describe('/api/glb proxy', () => {
	it('serves GLB bytes with open CORS and immutable caching', async () => {
		const r = await fetch(src('https://example.com/model.glb'), {
			headers: { origin: 'http://localhost:8888' },
		});
		expect(r.status).toBe(200);
		expect(r.headers.get('access-control-allow-origin')).toBe('*');
		expect(r.headers.get('content-type')).toBe('model/gltf-binary');
		expect(r.headers.get('cache-control')).toContain('immutable');
		expect(new Uint8Array(await r.arrayBuffer())).toEqual(GLB_BYTES);
	});

	it('rejects missing and non-http sources as 400', async () => {
		expect((await fetch(`${base}/api/glb`)).status).toBe(400);
		expect((await fetch(src('file:///etc/passwd'))).status).toBe(400);
	});

	it('maps SSRF blocks to 400, size cap to 413, upstream failure to 502', async () => {
		expect((await fetch(src('http://169.254.169.254/x.glb'))).status).toBe(400);
		expect((await fetch(src('https://example.com/huge.glb'))).status).toBe(413);
		expect((await fetch(src('https://example.com/down.glb'))).status).toBe(502);
	});

	it('answers preflight with open CORS', async () => {
		const r = await fetch(`${base}/api/glb`, {
			method: 'OPTIONS',
			headers: { origin: 'https://anything.example' },
		});
		expect(r.headers.get('access-control-allow-origin')).toBe('*');
	});
});
