// Tests for the free Crypto Data API discovery layer: the catalog assembler
// (globs entry files, skips malformed, dedups), the OpenAPI 3.1 generator, and
// the GET /api/crypto index handler's HTML-vs-JSON content negotiation.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadCatalog } from '../api/_lib/crypto-catalog/index.js';
import { buildOpenApiDoc, validateOpenApiDoc } from '../api/_lib/crypto-catalog/openapi.js';
import cryptoIndex from '../api/crypto/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, '_fixtures/crypto-catalog');

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
		url: '/api/crypto',
		headers: { accept, origin: 'http://localhost:3000' },
		socket: { remoteAddress: '127.0.0.1' },
	};
}

describe('crypto-catalog assembler', () => {
	it('merges every valid entry, skips malformed, skips throwing, dedups routes', async () => {
		const entries = await loadCatalog({ dir: FIXTURES, fresh: true });
		const slugs = entries.map((e) => e.slug).sort();

		// token.js (default export), holders.js (named export), and paramstyle.js
		// (input/output aliases) survive; broken-shape.js, broken-throws.js, and
		// dup-token.js are all dropped.
		expect(slugs).toEqual(['holders', 'paramstyle', 'token']);
		expect(entries.find((e) => e.slug === 'token-dupe')).toBeUndefined();
		expect(entries.find((e) => e.slug === 'never')).toBeUndefined();
	});

	it('accepts the terse input/output aliases and a multi-verb methods array', async () => {
		const entries = await loadCatalog({ dir: FIXTURES, fresh: true });
		const p = entries.find((e) => e.slug === 'paramstyle');
		expect(p.inputSchema).toBeTruthy(); // `input` aliased into inputSchema
		expect(p.outputSchema).toBeTruthy(); // `output` aliased into outputSchema
		expect(p.methods).toEqual(['GET', 'POST']);
	});

	it('normalizes entries: method upper-cased, optional fields defaulted', async () => {
		const entries = await loadCatalog({ dir: FIXTURES, fresh: true });
		const token = entries.find((e) => e.slug === 'token');
		expect(token.method).toBe('GET'); // fixture declares lowercase "get"
		expect(token.path).toBe('/api/crypto/token');
		expect(typeof token.title).toBe('string');
		// holders declares no example → defaulted to null, never undefined.
		const holders = entries.find((e) => e.slug === 'holders');
		expect(holders.example).toBeNull();
	});

	it('returns a valid EMPTY catalog for a directory with no entries', async () => {
		const empty = mkdtempSync(join(tmpdir(), 'crypto-catalog-empty-'));
		const entries = await loadCatalog({ dir: empty, fresh: true });
		expect(entries).toEqual([]);
	});

	it('never throws on an unreadable directory', async () => {
		const missing = join(tmpdir(), 'does-not-exist-' + 'xyz');
		await expect(loadCatalog({ dir: missing, fresh: true })).resolves.toEqual([]);
	});
});

describe('crypto-catalog OpenAPI generator', () => {
	it('produces a structurally valid OpenAPI 3.1 doc from the entries', async () => {
		const entries = await loadCatalog({ dir: FIXTURES, fresh: true });
		const doc = buildOpenApiDoc(entries, { origin: 'https://three.ws', version: '1.0.0' });

		expect(validateOpenApiDoc(doc)).toEqual([]);
		expect(doc.openapi).toBe('3.1.0');
		expect(doc.info.title).toBeTruthy();
		expect(doc.info.version).toBe('1.0.0');
		expect(doc.servers[0].url).toBe('https://three.ws');

		// Each entry became a path + operation keyed by its lowercased method.
		expect(doc.paths['/api/crypto/token'].get.operationId).toBe('token');
		expect(doc.paths['/api/crypto/holders/{mint}'].get).toBeTruthy();
	});

	it('converts inputSchema into query + path parameters', async () => {
		const entries = await loadCatalog({ dir: FIXTURES, fresh: true });
		const doc = buildOpenApiDoc(entries);

		// token: object inputSchema → `address` (required query) + `chain` (query).
		const tokenParams = doc.paths['/api/crypto/token'].get.parameters;
		const address = tokenParams.find((p) => p.name === 'address');
		expect(address.in).toBe('query');
		expect(address.required).toBe(true);
		expect(tokenParams.find((p) => p.name === 'chain').required).toBe(false);

		// holders: `{mint}` becomes a required path param even from an array schema.
		const holdersParams = doc.paths['/api/crypto/holders/{mint}'].get.parameters;
		const mint = holdersParams.find((p) => p.name === 'mint');
		expect(mint.in).toBe('path');
		expect(mint.required).toBe(true);

		// paramstyle: bare param-map input → params; `{mint}` path param honored.
		const psGet = doc.paths['/api/crypto/paramstyle/{mint}'].get.parameters;
		expect(psGet.find((p) => p.name === 'mint').in).toBe('path');
		expect(psGet.find((p) => p.name === 'verbose').in).toBe('query');
	});

	it('emits one operation per verb for multi-verb entries', async () => {
		const entries = await loadCatalog({ dir: FIXTURES, fresh: true });
		const doc = buildOpenApiDoc(entries);
		const item = doc.paths['/api/crypto/paramstyle/{mint}'];
		expect(item.get).toBeTruthy();
		expect(item.post).toBeTruthy();
		expect(item.get.operationId).toBe('paramstyle_get');
		// String-valued output fields coerce to valid schema objects.
		const schema = item.get.responses['200'].content['application/json'].schema;
		expect(schema.properties.ok.description).toContain('always true');
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

describe('GET /api/crypto content negotiation', () => {
	it('returns JSON by default with the discovery envelope', async () => {
		const req = mockReq({ accept: 'application/json' });
		const res = mockRes();
		await cryptoIndex(req, res);

		expect(res.statusCode).toBe(200);
		expect(res.getHeader('content-type')).toMatch(/application\/json/);
		const body = res.json;
		expect(body.name).toBe('three.ws Crypto Data API');
		expect(body.free).toBe(true);
		expect(body.keyless).toBe(true);
		expect(Array.isArray(body.endpoints)).toBe(true);
		expect(body.docs).toBe('/docs/crypto-api');
		expect(body.openapi).toBe('/api/crypto/openapi.json');
		expect(typeof body.ts).toBe('string');
	});

	it('returns HTML when the client asks for text/html', async () => {
		const req = mockReq({ accept: 'text/html' });
		const res = mockRes();
		await cryptoIndex(req, res);

		expect(res.statusCode).toBe(200);
		expect(res.getHeader('content-type')).toMatch(/text\/html/);
		expect(res._body).toContain('<!doctype html>');
		expect(res._body).toContain('three.ws Crypto Data API');
	});
});

// The discovery contract promises the catalog lists EVERY endpoint in the
// bundle ("a new endpoint appears the moment it ships"). It only holds if each
// api/crypto/<slug>.js handler has a descriptor wired into the static barrel:
// /api/crypto/portfolio and /api/crypto/airdrops shipped live but undescribed,
// so agents reading the index or the OpenAPI doc could not see them at all.
describe('crypto-catalog covers every shipped endpoint', () => {
	const HANDLER_DIR = resolve(HERE, '../api/crypto');
	// Discovery machinery, not endpoints of their own.
	const NON_ENDPOINT = new Set(['index.js', 'openapi.js']);

	it('has a descriptor for every api/crypto handler, and no descriptor without one', async () => {
		const handlers = readdirSync(HANDLER_DIR)
			.filter((f) => f.endsWith('.js') && !NON_ENDPOINT.has(f) && !f.startsWith('_'))
			.map((f) => f.replace(/\.js$/, ''))
			.sort();

		const entries = await loadCatalog({ fresh: true });
		const slugs = entries.map((e) => e.slug).sort();

		expect(slugs).toEqual(handlers);
		for (const e of entries) {
			expect(e.path).toBe(`/api/crypto/${e.slug}`);
		}
	});

	it('surfaces every descriptor in the generated OpenAPI paths', async () => {
		const entries = await loadCatalog({ fresh: true });
		const doc = buildOpenApiDoc(entries, { origin: 'https://three.ws', version: '1.0.0' });
		for (const e of entries) {
			expect(doc.paths[e.path]).toBeTruthy();
		}
		expect(validateOpenApiDoc(doc)).toEqual([]);
	});
});
