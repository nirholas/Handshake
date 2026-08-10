// Tests for the free 3D API discovery layer (prompt 14): the catalog assembler
// (globs entry files, accepts both descriptor naming styles, skips malformed,
// dedups routes, never throws), the OpenAPI 3.1 generator, and the GET /api/3d
// index handler's HTML-vs-JSON content negotiation.

import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadCatalog, normalizeEntry } from '../api/_lib/3d-catalog/index.js';
import { buildOpenApiDoc, validateOpenApiDoc } from '../api/_lib/3d-catalog/openapi.js';
import threeIndex from '../api/3d/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, '_fixtures/3d-catalog');

function mockRes() {
	return {
		statusCode: 200,
		_headers: {},
		_body: '',
		setHeader(k, v) {
			this._headers[k.toLowerCase()] = v;
		},
		getHeader(k) {
			return this._headers[k.toLowerCase()];
		},
		end(b) {
			this._body = b || '';
		},
		get headersSent() {
			return false;
		},
		get writableEnded() {
			return false;
		},
		get json() {
			try {
				return JSON.parse(this._body);
			} catch {
				return null;
			}
		},
	};
}

function mockReq({ accept = 'application/json' } = {}) {
	return {
		method: 'GET',
		url: '/api/3d',
		headers: { accept, origin: 'http://localhost:3000' },
		socket: { remoteAddress: '127.0.0.1' },
	};
}

describe('3d-catalog assembler', () => {
	it('merges valid entries in BOTH naming styles, skips malformed/throwing, dedups routes', async () => {
		const entries = await loadCatalog({ dir: FIXTURES, fresh: true });
		const slugs = entries.map((e) => e.slug).sort();

		// generate.js (slug/method) + inspect.js (id/name/methods) both survive;
		// broken-shape.js, broken-throws.js are dropped, and zz-dup-inspect.js is
		// deduped away (same GET,POST /api/3d/inspect route as inspect.js).
		expect(slugs).toEqual(['generate', 'inspect']);
		expect(entries.find((e) => e.slug === 'never')).toBeUndefined();
		expect(entries.find((e) => e.slug === 'inspect-dupe')).toBeUndefined();
	});

	it('accepts the id/name/methods descriptor style without dropping it', async () => {
		const entries = await loadCatalog({ dir: FIXTURES, fresh: true });
		const inspect = entries.find((e) => e.slug === 'inspect');
		expect(inspect).toBeTruthy();
		expect(inspect.title).toBe('3D Model Inspect & Validate'); // from `name`
		expect(inspect.methods).toEqual(['GET', 'POST']);
		expect(inspect.summary).toBeTruthy(); // from `description`
	});

	it('normalizes: methods upper-cased array, optional fields defaulted (never undefined)', async () => {
		const entries = await loadCatalog({ dir: FIXTURES, fresh: true });
		const gen = entries.find((e) => e.slug === 'generate');
		expect(gen.methods).toEqual(['POST']); // fixture declares lowercase "post"
		expect(gen.path).toBe('/api/3d/generate');
		expect(gen.free).toBe(true);
		expect(gen.keyless).toBe(true);
		expect(Array.isArray(gen.tags)).toBe(true);
		expect(gen.paidTiers).toBeInstanceOf(Array);
	});

	it('normalizeEntry drops entries with no route/name/summary', () => {
		expect(normalizeEntry(null, 'x')).toBeNull();
		expect(normalizeEntry({ slug: 'a', summary: 'b' }, 'x')).toBeNull(); // no path
		expect(normalizeEntry({ path: '/x', summary: 'b' }, 'x')).toBeNull(); // no slug/id
		expect(normalizeEntry({ slug: 'a', path: '/x' }, 'x')).toBeNull(); // no summary
	});

	it('returns a valid EMPTY catalog for a directory with no entries', async () => {
		const empty = mkdtempSync(join(tmpdir(), '3d-catalog-empty-'));
		const entries = await loadCatalog({ dir: empty, fresh: true });
		expect(entries).toEqual([]);
	});

	it('never throws on an unreadable directory', async () => {
		const missing = join(tmpdir(), 'does-not-exist-3d-' + 'xyz');
		await expect(loadCatalog({ dir: missing, fresh: true })).resolves.toEqual([]);
	});
});

describe('3d-catalog OpenAPI generator', () => {
	it('produces a structurally valid OpenAPI 3.1 doc from the entries', async () => {
		const entries = await loadCatalog({ dir: FIXTURES, fresh: true });
		const doc = buildOpenApiDoc(entries, { origin: 'https://three.ws', version: '1.0.0' });

		expect(validateOpenApiDoc(doc)).toEqual([]);
		expect(doc.openapi).toBe('3.1.0');
		expect(doc.info.title).toBe('three.ws 3D API');
		expect(doc.info.version).toBe('1.0.0');
		expect(doc.servers[0].url).toBe('https://three.ws');

		// generate is POST → operation under `post`.
		expect(doc.paths['/api/3d/generate'].post.operationId).toBe('generate');
		// inspect answers GET + POST → both verbs present, distinct operationIds.
		expect(doc.paths['/api/3d/inspect'].get.operationId).toBe('inspect_get');
		expect(doc.paths['/api/3d/inspect'].post.operationId).toBe('inspect_post');
	});

	it('emits a JSON requestBody for POST and query parameters for GET', async () => {
		const entries = await loadCatalog({ dir: FIXTURES, fresh: true });
		const doc = buildOpenApiDoc(entries);

		// POST generate → requestBody from inputSchema, marked required (prompt).
		const post = doc.paths['/api/3d/generate'].post;
		expect(post.requestBody).toBeTruthy();
		expect(post.requestBody.required).toBe(true);
		expect(post.requestBody.content['application/json'].schema.properties.prompt).toBeTruthy();

		// GET inspect → `url` as a query parameter.
		const get = doc.paths['/api/3d/inspect'].get;
		const url = get.parameters.find((p) => p.name === 'url');
		expect(url.in).toBe('query');
	});

	it('validates an empty-catalog doc (no paths) as still well-formed', () => {
		const doc = buildOpenApiDoc([], { origin: 'https://three.ws' });
		expect(validateOpenApiDoc(doc)).toEqual([]);
		expect(doc.paths).toEqual({});
	});

	it('flags a malformed doc', () => {
		expect(validateOpenApiDoc({ openapi: '3.0.0' }).length).toBeGreaterThan(0);
		expect(validateOpenApiDoc(null)).toEqual(['document is not an object']);
	});
});

describe('GET /api/3d content negotiation', () => {
	it('returns JSON by default with the discovery envelope + paid ladder', async () => {
		const req = mockReq({ accept: 'application/json' });
		const res = mockRes();
		await threeIndex(req, res);

		expect(res.statusCode).toBe(200);
		expect(res.getHeader('content-type')).toMatch(/application\/json/);
		const body = res.json;
		expect(body.name).toBe('three.ws 3D API');
		expect(body.free).toBe(true);
		expect(body.keyless).toBe(true);
		expect(Array.isArray(body.endpoints)).toBe(true);
		expect(Array.isArray(body.paidTiers)).toBe(true);
		expect(body.paidTiers.map((t) => t.name)).toContain('Forge Pro');
		expect(body.paidTiers.map((t) => t.name)).toContain('Rigged Avatar');
		expect(body.docs).toBe('/docs/3d-api');
		expect(body.openapi).toBe('/api/3d/openapi.json');
		expect(typeof body.ts).toBe('string');
	});

	it('returns HTML when the client asks for text/html', async () => {
		const req = mockReq({ accept: 'text/html' });
		const res = mockRes();
		await threeIndex(req, res);

		expect(res.statusCode).toBe(200);
		expect(res.getHeader('content-type')).toMatch(/text\/html/);
		expect(res._body).toContain('<!doctype html>');
		expect(res._body).toContain('three.ws 3D API');
		expect(res._body).toContain('Paid tiers');
	});

	it('varies on Accept so the CDN cannot serve one variant to the other client', async () => {
		// The response is publicly cacheable for 5 minutes and its body depends on
		// Accept. Without Vary the edge stores whichever variant it saw first and
		// hands an HTML page to an agent that asked for JSON.
		for (const accept of ['application/json', 'text/html']) {
			const res = mockRes();
			await threeIndex(mockReq({ accept }), res);
			expect(String(res.getHeader('cache-control'))).toContain('s-maxage=300');
			expect(String(res.getHeader('vary')).toLowerCase()).toContain('accept');
		}
	});
});

describe('GET /api/3d/openapi', () => {
	it('serves a valid, CDN-cacheable OpenAPI 3.1 doc built from the live catalog', async () => {
		const openapiHandler = (await import('../api/3d/openapi.js')).default;
		const res = mockRes();
		await openapiHandler(mockReq({ accept: 'application/json' }), res);

		expect(res.statusCode).toBe(200);
		expect(res.getHeader('content-type')).toMatch(/application\/json/);
		expect(String(res.getHeader('cache-control'))).toContain('s-maxage=300');
		const doc = res.json;
		expect(doc.openapi).toBe('3.1.0');
		expect(validateOpenApiDoc(doc)).toEqual([]);
		// Every free endpoint the index advertises is callable from the spec.
		const indexRes = mockRes();
		await threeIndex(mockReq({ accept: 'application/json' }), indexRes);
		for (const ep of indexRes.json.endpoints) expect(doc.paths[ep.path]).toBeTruthy();
	});

	it('rejects a non-GET method rather than generating the doc', async () => {
		const openapiHandler = (await import('../api/3d/openapi.js')).default;
		const req = mockReq({ accept: 'application/json' });
		req.method = 'POST';
		const res = mockRes();
		await openapiHandler(req, res);
		expect(res.statusCode).toBe(405);
	});
});
