import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestServer } from './helpers/test-server.js';
import { isMissingShellPage } from '../server/shell-pages.mjs';

// An unknown URL must end in the designed 404 page with a real 404 status.
//
// Two classes of soft 404 have shipped here. /docs/* and /tutorials/* rewrite
// EVERY slug to a single HTML shell, so /docs/anything answered 200 with the
// shell, which then rendered one gray "Page not found." line: indexed by
// crawlers as a live page, and a dead end for the reader. The inverse also
// held: nested doc pages that exist (docs/<topic>/chapters/<n>.md) were not
// matched by the single-segment docs rule at all, so a real page 404'd.
//
// Both are decided by server/shell-pages.mjs, which resolves the markdown
// article a shell would fetch before the shell is served.

let BASE;
let server;

beforeAll(async () => {
	server = await startTestServer();
	BASE = server.base;
}, 30000);

afterAll(() => {
	server?.close();
});

const get = (path) => fetch(`${BASE}${path}`, { redirect: 'manual' });

describe('unknown routes land on the designed 404', () => {
	it('an unknown page returns 404 with the designed page, not a bare body', async () => {
		const res = await get('/definitely-not-a-real-page-xyz');
		expect(res.status).toBe(404);
		expect(res.headers.get('content-type')).toMatch(/text\/html/);
		const html = await res.text();
		// The designed page: its own title, and the ways back into the product.
		expect(html).toContain('three.ws — 404');
		expect(html).toContain('href="/"');
		expect(html).toContain('href="/sitemap"');
	});

	it('the trailing-slash variant redirects once, to the same 404', async () => {
		const res = await get('/definitely-not-a-real-page-xyz/');
		expect(res.status).toBe(301);
		expect(res.headers.get('location')).toBe('/definitely-not-a-real-page-xyz');
		const followed = await fetch(`${BASE}/definitely-not-a-real-page-xyz/`);
		expect(followed.status).toBe(404);
	});

	it('an unknown /api/ path answers JSON, never the HTML shell', async () => {
		const res = await get('/api/definitely-not-a-real-endpoint-xyz');
		expect(res.status).toBe(404);
		expect(res.headers.get('content-type')).toMatch(/application\/json/);
		const body = await res.json();
		expect(body.error).toBe('not_found');
	});
});

describe('shared-shell surfaces do not soft-404', () => {
	it('an unknown /docs/ slug returns 404, not the docs shell at 200', async () => {
		const res = await get('/docs/definitely-not-a-real-doc-xyz');
		expect(res.status).toBe(404);
		const html = await res.text();
		expect(html).toContain('three.ws — 404');
	});

	it('an unknown nested /docs/ path returns 404', async () => {
		const res = await get('/docs/definitely-not-a-real-doc-xyz/chapters/01');
		expect(res.status).toBe(404);
	});

	it('an unknown /tutorials/ slug returns 404, not the tutorial shell at 200', async () => {
		const res = await get('/tutorials/definitely-not-a-real-tutorial-xyz');
		expect(res.status).toBe(404);
		const html = await res.text();
		expect(html).toContain('three.ws — 404');
	});

	it('a real doc still serves the docs shell', async () => {
		const res = await get('/docs/start-here');
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain('docs-sidebar');
	});

	it('a real nested doc chapter serves the docs shell instead of 404ing', async () => {
		const res = await get('/docs/agent-abilities/chapters/01-the-body');
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain('docs-sidebar');
	});

	it('the docs index itself is untouched by the article check', async () => {
		const res = await get('/docs');
		expect(res.status).toBe(200);
	});

	it('a docs path that names a directory serves that directory index', async () => {
		const res = await get('/docs/nvidia-inception');
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toMatch(/text\/html/);
	});

	it('a traversal slug under the shell never escapes dist/docs', async () => {
		const res = await get('/docs/..%2f..%2fvite.config');
		expect(res.status).toBe(404);
	});
});

// The tutorial shell (dist/tutorial.html) is only present in a full build, so
// its serve path is asserted at the resolver instead of over HTTP: these are
// the decisions the server acts on, and they hold against the repo's own
// docs/tutorials sources either way.
describe('article resolution behind the shells', () => {
	const DIST = path.resolve(fileURLToPath(new URL('..', import.meta.url)), 'dist');

	it('a real tutorial resolves to its article', () => {
		expect(isMissingShellPage(DIST, '/tutorial.html', '/tutorials/text-to-3d')).toBe(false);
	});

	it('an unknown tutorial has no article', () => {
		expect(isMissingShellPage(DIST, '/tutorial.html', '/tutorials/not-a-tutorial-xyz')).toBe(true);
	});

	it('routes that are not shells are never gated', () => {
		expect(isMissingShellPage(DIST, '/docs-world.html', '/docs/world')).toBe(false);
		expect(isMissingShellPage(DIST, '/index.html', '/anything')).toBe(false);
	});

	it('the shell index itself always resolves', () => {
		expect(isMissingShellPage(DIST, '/docs/index.html', '/docs/')).toBe(false);
	});
});
