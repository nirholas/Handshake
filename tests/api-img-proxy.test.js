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
//
// Plus `?fallback=none`, the opt-out the DeFi logo tables use: 204 No Content
// instead of the placeholder, so a retired upstream icon logs nothing.

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

// `?fallback=none` is what the DeFi tables (/fees, /defi, /dex-volumes,
// /chain/:id, /protocol/:slug, /exchange/:id) ask for: they already draw a
// neutral disc for a logo-less row, so a withdrawn upstream icon should arrive
// empty rather than as token-art. 204 keeps the browser console silent (a 404
// logs a failed resource on every table paint) while still firing `error` on
// the <img>, which is what swaps in the disc.
describe('api/img ?fallback=none', () => {
	beforeEach(() => {
		safeFetchJson.mockReset();
		fetchModel.mockReset();
	});

	it('answers 204 with no body when every source fails', async () => {
		fetchModel.mockRejectedValue(new Error('404 from the icon CDN'));

		const res = mockRes();
		await handler(mockReq('?url=https%3A%2F%2Ficons.example%2Fgone.png&fallback=none'), res);

		expect(res.statusCode).toBe(204);
		expect(res.body).toBeUndefined();
		expect(res.headers['content-type']).toBeUndefined();
		expect(res.headers['access-control-allow-origin']).toBe('*');
	});

	it('still serves the real image when the upstream resolves', async () => {
		fetchModel.mockResolvedValue({
			bytes: new Uint8Array([9, 9]),
			url: 'https://icons.example/live.png',
			contentType: 'image/png',
			filename: 'live.png',
		});

		const res = mockRes();
		await handler(mockReq('?url=https%3A%2F%2Ficons.example%2Flive.png&fallback=none'), res);

		expect(res.statusCode).toBe(200);
		expect(res.headers['content-type']).toBe('image/png');
		expect([...res.body]).toEqual([9, 9]);
	});

	it('keeps the placeholder for every other caller', async () => {
		fetchModel.mockRejectedValue(new Error('gone'));

		const res = mockRes();
		await handler(mockReq('?url=https%3A%2F%2Fcdn.example%2Fart.png&seed=THREE'), res);

		expect(res.statusCode).toBe(200);
		expect(res.headers['content-type']).toMatch(/image\/svg\+xml/);
		expect(String(res.body)).toContain('<svg');
	});
});

// Serve `doc` as a JSON response and `art` as image bytes, keyed by URL, so a
// single mock can satisfy both hops of the follow.
function mockUpstream({ jsonAt = {}, imageAt = {} } = {}) {
	fetchModel.mockImplementation(async (url) => {
		if (url in jsonAt) {
			return {
				bytes: new TextEncoder().encode(JSON.stringify(jsonAt[url])),
				url,
				contentType: 'application/json; charset=utf-8',
				filename: 'token.json',
			};
		}
		if (url in imageAt) {
			return { bytes: imageAt[url], url, contentType: 'image/png', filename: 'art.png' };
		}
		throw new Error(`upstream 404 ${url}`);
	});
}

describe('api/img ?url= metadata follow', () => {
	const DOC = 'https://meta.example/token.json';
	const ART = 'https://cdn.example/art.png';

	it('follows a JSON document at ?url= to its .image and proxies the artwork', async () => {
		mockUpstream({ jsonAt: { [DOC]: { name: 'VOID', image: ART } }, imageAt: { [ART]: new Uint8Array([7, 8, 9]) } });

		const res = mockRes();
		await handler(mockReq(`?url=${encodeURIComponent(DOC)}&seed=VOID`), res);

		expect(fetchModel).toHaveBeenCalledWith(DOC, expect.any(Object));
		expect(fetchModel).toHaveBeenCalledWith(ART, expect.any(Object));
		expect(res.statusCode).toBe(200);
		expect(res.headers['content-type']).toBe('image/png');
		expect([...res.body]).toEqual([7, 8, 9]);
	});

	it('follows only one hop — a document naming another document yields the placeholder', async () => {
		const DOC2 = 'https://meta.example/nested.json';
		mockUpstream({ jsonAt: { [DOC]: { image: DOC2 }, [DOC2]: { image: ART } }, imageAt: { [ART]: new Uint8Array([1]) } });

		const res = mockRes();
		await handler(mockReq(`?url=${encodeURIComponent(DOC)}&seed=DEEP`), res);

		expect(fetchModel).toHaveBeenCalledWith(DOC2, expect.any(Object));
		expect(fetchModel).not.toHaveBeenCalledWith(ART, expect.any(Object));
		expect(res.headers['content-type']).toMatch(/image\/svg\+xml/);
		expect(String(res.body)).toContain('<svg');
	});

	it('rejects a data: image inside a followed document', async () => {
		mockUpstream({ jsonAt: { [DOC]: { image: 'data:image/svg+xml,<svg onload=alert(1)>' } } });

		const res = mockRes();
		await handler(mockReq(`?url=${encodeURIComponent(DOC)}&seed=EVIL`), res);

		expect(fetchModel).toHaveBeenCalledTimes(1); // the doc only — never the data: URI
		expect(res.headers['content-type']).toMatch(/image\/svg\+xml/);
		expect(String(res.body)).toContain('<svg');
	});

	it('serves a direct image at ?url= without taking the JSON path', async () => {
		mockUpstream({ imageAt: { [ART]: new Uint8Array([4, 2]) } });

		const res = mockRes();
		await handler(mockReq(`?url=${encodeURIComponent(ART)}&seed=ART`), res);

		expect(fetchModel).toHaveBeenCalledTimes(1);
		expect(res.headers['content-type']).toBe('image/png');
		expect([...res.body]).toEqual([4, 2]);
	});

	it('does not treat a JSON body as artwork on the ?meta= path', async () => {
		safeFetchJson.mockResolvedValue({ ok: true, data: { image: DOC } });
		mockUpstream({ jsonAt: { [DOC]: { image: ART } }, imageAt: { [ART]: new Uint8Array([5]) } });

		const res = mockRes();
		await handler(mockReq(`?meta=${encodeURIComponent(DOC)}&seed=META`), res);

		expect(fetchModel).not.toHaveBeenCalledWith(ART, expect.any(Object));
		expect(res.headers['content-type']).toMatch(/image\/svg\+xml/);
	});

	it('races every IPFS gateway for a metadata CID and follows the winner', async () => {
		const CID = 'bafkreitest';
		const art = 'https://ipfs.io/ipfs/bafkreiart';
		fetchModel.mockImplementation(async (url) => {
			if (url.endsWith(`/ipfs/${CID}`)) {
				return { bytes: new TextEncoder().encode(JSON.stringify({ image: art })), url, contentType: 'application/json', filename: 'x' };
			}
			if (url.includes('bafkreiart')) {
				return { bytes: new Uint8Array([3]), url, contentType: 'image/webp', filename: 'a' };
			}
			throw new Error('nope');
		});

		const res = mockRes();
		await handler(mockReq(`?url=${encodeURIComponent(`https://ipfs.io/ipfs/${CID}`)}&seed=CID`), res);

		// Every gateway in the fallback list is attempted for the document.
		const tried = fetchModel.mock.calls.map((c) => c[0]).filter((u) => u.endsWith(`/ipfs/${CID}`));
		expect(tried.length).toBeGreaterThan(1);
		expect(res.headers['content-type']).toBe('image/webp');
		expect([...res.body]).toEqual([3]);
	});
});
