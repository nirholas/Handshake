// Coverage for api/img.js — the same-origin image proxy used by the live
// pump.fun feeds (/pump-live, /pump-visualizer, /oracle, /radar). We verify the
// metadata resolution mode added for token launch art:
//
//   1. ?seed=<x> alone yields the on-brand SVG placeholder (no upstream call).
//   2. ?meta=<json-uri> resolves the document's `.image` server-side and proxies
//      the real artwork bytes back.
//   3. A metadata `image` that is a data: URI is rejected → placeholder (we never
//      serve attacker-supplied inline content from our own origin).
//   4. A metadata fetch failure falls through to the placeholder, never an error.
//   5. No url/meta/seed at all is a 400.
//
// …and the `?url=` metadata follow: upstream feeds store the token's image URI
// and its metadata URI in one column, so a `?url=` may address either. When it
// resolves to a JSON document we follow its `.image` exactly one hop:
//
//   6. ?url=<json-uri> → follows `.image` → proxies the real artwork.
//   7. The follow is one hop only — a doc naming another doc terminates.
//   8. A data: image in a followed doc is rejected → placeholder.
//   9. ?url=<image> is served directly, unchanged (no JSON path taken).
//  10. The `?meta=` path does not accept JSON for the artwork itself.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: { imgProxyIp: vi.fn(async () => ({ success: true })) },
	clientIp: vi.fn(() => '127.0.0.1'),
}));

const safeFetchJson = vi.fn();
vi.mock('../api/_lib/ssrf.js', () => ({ safeFetchJson: (...a) => safeFetchJson(...a) }));

const fetchModel = vi.fn();
vi.mock('../api/_lib/fetch-model.js', () => ({ fetchModel: (...a) => fetchModel(...a) }));

const { default: handler } = await import('../api/img.js');

function mockReq(search = '') {
	return { method: 'GET', headers: { host: 'localhost' }, url: `/api/img${search}` };
}

function mockRes() {
	return {
		statusCode: 200,
		headers: {},
		body: undefined,
		ended: false,
		setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
		getHeader(k) { return this.headers[k.toLowerCase()]; },
		end(b) { this.body = b; this.ended = true; },
	};
}

beforeEach(() => {
	safeFetchJson.mockReset();
	fetchModel.mockReset();
});

describe('api/img metadata resolution', () => {
	it('serves the branded SVG placeholder for a seed-only request', async () => {
		const res = mockRes();
		await handler(mockReq('?seed=THREE'), res);
		expect(res.statusCode).toBe(200);
		expect(res.headers['content-type']).toMatch(/image\/svg\+xml/);
		expect(String(res.body)).toContain('<svg');
		expect(safeFetchJson).not.toHaveBeenCalled();
		expect(fetchModel).not.toHaveBeenCalled();
	});

	it('resolves .image from token metadata and proxies the real artwork', async () => {
		safeFetchJson.mockResolvedValue({
			ok: true,
			data: { name: 'VOID', image: 'https://cdn.example/art.png' },
		});
		fetchModel.mockResolvedValue({
			bytes: new Uint8Array([1, 2, 3]),
			url: 'https://cdn.example/art.png',
			contentType: 'image/png',
			filename: 'art.png',
		});

		const res = mockRes();
		await handler(mockReq('?meta=https%3A%2F%2Fmeta.example%2Ftoken.json&seed=VOID'), res);

		expect(safeFetchJson).toHaveBeenCalledWith(
			'https://meta.example/token.json',
			expect.any(Object),
		);
		expect(fetchModel).toHaveBeenCalledWith(
			'https://cdn.example/art.png',
			expect.any(Object),
		);
		expect(res.statusCode).toBe(200);
		expect(res.headers['content-type']).toBe('image/png');
		expect(Buffer.isBuffer(res.body)).toBe(true);
		expect([...res.body]).toEqual([1, 2, 3]);
	});

	it('rejects a data: image in metadata and falls back to the placeholder', async () => {
		safeFetchJson.mockResolvedValue({
			ok: true,
			data: { image: 'data:image/svg+xml,<svg onload=alert(1)>' },
		});

		const res = mockRes();
		await handler(mockReq('?meta=https%3A%2F%2Fmeta.example%2Fevil.json&seed=EVIL'), res);

		expect(fetchModel).not.toHaveBeenCalled();
		expect(res.statusCode).toBe(200);
		expect(res.headers['content-type']).toMatch(/image\/svg\+xml/);
		expect(String(res.body)).toContain('<svg');
	});

	it('falls back to the placeholder when the metadata fetch fails', async () => {
		safeFetchJson.mockRejectedValue(new Error('ssrf refused'));

		const res = mockRes();
		await handler(mockReq('?meta=https%3A%2F%2Fmeta.example%2Fdown.json&seed=DOWN'), res);

		expect(res.statusCode).toBe(200);
		expect(res.headers['content-type']).toMatch(/image\/svg\+xml/);
		expect(fetchModel).not.toHaveBeenCalled();
	});

	it('400s when no url, meta, or seed is supplied', async () => {
		const res = mockRes();
		await handler(mockReq(''), res);
		expect(res.statusCode).toBe(400);
	});
});
