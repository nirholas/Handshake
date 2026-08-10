import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The handler reads the real release manifest that `npm run publish:lib` writes,
// so the tests drive the real file rather than a mocked fs: they stash whatever
// the worktree already had, write the case under test, and restore on the way out.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = resolve(ROOT, 'dist/agent-3d/versions.json');

const REAL_MANIFEST = {
	latest: '1.5.2',
	channels: {
		'1.5.2': { integrity: { 'agent-3d.js': 'sha384-1YhqeXz6Um0NP1Re61RbrrE8i0RF9my8Sb+SOiN3X/OWqvkat1dSsPA/JFKv64kR' }, immutable: true },
		'1.5': { tracks: '>=1.5.0 <1.6.0' },
		1: { tracks: '>=1.0.0 <2.0.0' },
		latest: { tracks: '*' },
	},
	publishedAt: '2026-08-10T16:20:09.870Z',
};

let original = null;

function writeManifest(body) {
	mkdirSync(dirname(MANIFEST), { recursive: true });
	writeFileSync(MANIFEST, typeof body === 'string' ? body : JSON.stringify(body, null, '\t') + '\n');
}

beforeAll(() => {
	original = existsSync(MANIFEST) ? readFileSync(MANIFEST, 'utf8') : null;
});

afterAll(() => {
	if (original === null) rmSync(MANIFEST, { force: true });
	else writeManifest(original);
});

beforeEach(() => {
	writeManifest(REAL_MANIFEST);
});

const { default: handler } = await import('../api/agent-3d/versions.js');

function mkReq({ method = 'GET', headers = {} } = {}) {
	return { method, url: '/api/agent-3d/versions', headers, socket: { remoteAddress: '127.0.0.1' } };
}

function mkRes() {
	return {
		statusCode: 200,
		headers: {},
		body: undefined,
		writableEnded: false,
		headersSent: false,
		getHeader(k) {
			return this.headers[k.toLowerCase()];
		},
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = v;
		},
		end(b) {
			this.body = b;
			this.writableEnded = true;
		},
	};
}

const parse = (res) => (res.body ? JSON.parse(res.body) : undefined);

async function call(reqInit) {
	const req = mkReq(reqInit);
	const res = mkRes();
	await handler(req, res);
	return res;
}

describe('GET /api/agent-3d/versions', () => {
	it('serves the release manifest with public cache headers and an ETag', async () => {
		const res = await call();
		expect(res.statusCode).toBe(200);
		expect(parse(res)).toEqual(REAL_MANIFEST);
		expect(res.headers['content-type']).toMatch(/application\/json/);
		expect(res.headers['cache-control']).toBe('public, max-age=60, s-maxage=60, stale-while-revalidate=300');
		expect(res.headers['access-control-allow-origin']).toBe('*');
		expect(res.headers.etag).toMatch(/^"[\w-]{27}"$/);
	});

	it('answers HEAD like GET', async () => {
		const res = await call({ method: 'HEAD' });
		expect(res.statusCode).toBe(200);
		expect(res.headers.etag).toBeTruthy();
	});

	it('answers a matching conditional request with a bodyless 304', async () => {
		const first = await call();
		const res = await call({ headers: { 'if-none-match': first.headers.etag } });
		expect(res.statusCode).toBe(304);
		expect(res.body).toBeUndefined();
		expect(res.headers.etag).toBe(first.headers.etag);
	});

	it('honours weak validators, tag lists, and the * validator', async () => {
		const { etag } = await call().then((r) => r.headers);
		for (const header of [`W/${etag}`, `"nomatch", ${etag}`, '*']) {
			expect((await call({ headers: { 'if-none-match': header } })).statusCode).toBe(304);
		}
		expect((await call({ headers: { 'if-none-match': '"nomatch"' } })).statusCode).toBe(200);
	});

	it('re-reads the manifest after a rebuild rewrites it, and re-derives the ETag', async () => {
		const before = await call();
		writeManifest({ ...REAL_MANIFEST, latest: '1.6.0' });
		const after = await call();
		expect(parse(after).latest).toBe('1.6.0');
		expect(after.headers.etag).not.toBe(before.headers.etag);
		// A validator held from before the rebuild must not win, or an embedder would
		// stay pinned to a superseded release.
		const stale = await call({ headers: { 'if-none-match': before.headers.etag } });
		expect(stale.statusCode).toBe(200);
	});

	it('rejects writes with 405 and advertises the readable methods', async () => {
		const res = await call({ method: 'POST' });
		expect(res.statusCode).toBe(405);
		expect(parse(res).error).toBe('method_not_allowed');
		expect(res.headers.allow).toBe('GET, HEAD');
	});

	it('short-circuits a CORS preflight with 204', async () => {
		const res = await call({ method: 'OPTIONS', headers: { origin: 'https://example.com' } });
		expect(res.statusCode).toBe(204);
		expect(res.headers['access-control-allow-methods']).toBe('GET,HEAD,OPTIONS');
	});

	it('returns an uncacheable 503 naming the build step when the manifest is missing', async () => {
		rmSync(MANIFEST, { force: true });
		const res = await call();
		expect(res.statusCode).toBe(503);
		expect(parse(res).error).toBe('versions_unavailable');
		expect(parse(res).error_description).toContain('publish:lib');
		expect(parse(res).error_description).toContain('missing');
		expect(res.headers['cache-control']).toBe('no-store');
	});

	it('distinguishes a corrupt manifest from a missing one', async () => {
		writeManifest('{ not json');
		const res = await call();
		expect(res.statusCode).toBe(503);
		expect(parse(res).error).toBe('versions_unavailable');
		expect(parse(res).error_description).toContain('not valid JSON');
	});
});
