// Every static page we advertise must actually be built and routed.
//
// data/pages.json is the source of truth for the sitemap, llms.txt, features.json
// and the changelog: a path listed there is published to search engines and to
// agents. Twice now a page has landed with a pages.json entry, an HTML source
// file and a changelog line, but no wiring to serve it (/timeline, /tracker), so
// the advertised URL 404'd in production while every index claimed it existed.
//
// A static page needs both halves to reach a visitor:
//   1. a Vite rollup input in vite.config.js, or its HTML never lands in dist/
//   2. a vercel.json route rewriting the clean URL to that HTML file
//
// Only paths backed by a pages/<name>.html source are checked. Most declared
// paths (docs/*, tutorials/*, .well-known/*) are rendered at request time by
// api/** handlers, so a blanket "every path needs a route" sweep would
// false-flag them: the same reasoning as scripts/check-dist.mjs.

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

const pagesConfig = JSON.parse(read('data/pages.json'));
const vercelConfig = JSON.parse(read('vercel.json'));
const viteConfigSource = read('vite.config.js');

const declaredPaths = pagesConfig.sections.flatMap((section) =>
	(section.pages || []).map((page) => page.path),
);

// Declared paths whose HTML is authored under pages/: i.e. pure static build
// output, the class of page this guard covers.
const staticPages = declaredPaths
	.map((pagePath) => ({ pagePath, source: `pages${pagePath.replace(/\/$/, '')}.html` }))
	.filter(({ source }) => existsSync(path.join(ROOT, source)));

// Rewrites only: routes carrying a status are redirects or the 404 fallback
// (which rewrites to /404.html and would otherwise "serve" every path).
const rewrites = vercelConfig.routes.filter(
	(route) => typeof route.src === 'string' && route.dest && !route.status,
);

// The dest need not be the page's own filename: /ar renders ar-forge.html and
// /events/<slug> uses a captured dest: so the rule is that some rewrite claims
// the path and lands on an HTML document, not on the identity catch-all.
const hasRoute = (pagePath) =>
	rewrites.some((route) => route.dest.endsWith('.html') && new RegExp(`^${route.src}$`).test(pagePath));

// A page reaches dist/ either as a rollup input or through one of the verbatim
// copy plugins (pages/ibm/*). Both name the source file in vite.config.js; a
// page it never mentions cannot be built at all.
const isBuilt = (source) => viteConfigSource.includes(source);

describe('data/pages.json static page wiring', () => {
	it('finds the static pages to check', () => {
		expect(staticPages.length).toBeGreaterThan(50);
	});

	it('routes every advertised static page to its HTML', () => {
		const unrouted = staticPages.filter(({ pagePath }) => !hasRoute(pagePath));
		expect(
			unrouted.map((p) => p.pagePath),
			'advertised in data/pages.json with no vercel.json route to their HTML',
		).toEqual([]);
	});

	it('builds every advertised static page into dist/', () => {
		const unbuilt = staticPages.filter(({ source }) => !isBuilt(source));
		expect(
			unbuilt.map((p) => p.pagePath),
			'advertised in data/pages.json but never emitted into dist/ (missing vite.config.js rollup input)',
		).toEqual([]);
	});

	it('declares each path exactly once', () => {
		const seen = new Set();
		const dupes = declaredPaths.filter((p) => (seen.has(p) ? true : (seen.add(p), false)));
		expect(dupes).toEqual([]);
	});
});
