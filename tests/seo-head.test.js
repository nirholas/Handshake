// Per-route head rewriting for shared-shell pages (server/seo-head.mjs).
//
// The docs and tutorial shells serve hundreds of routes from one file, so the
// rewriter must give each catalogued route its own canonical/OG/JSON-LD while
// leaving pages that already own their meta untouched.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rewriteHead, hasSeoRoute, canonicalOf, canonicalUrlFor } from '../server/seo-head.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docsShell = readFileSync(path.join(ROOT, 'docs/index.html'), 'utf8');
const tutorialShell = readFileSync(path.join(ROOT, 'pages/tutorial.html'), 'utf8');
const pagesJson = JSON.parse(readFileSync(path.join(ROOT, 'data/pages.json'), 'utf8'));

const headOf = (html) => html.match(/<head[^>]*>[\s\S]*?<\/head>/i)[0];

describe('rewriteHead', () => {
	it('gives a /docs/* route its own canonical, title, OG and JSON-LD', () => {
		const out = rewriteHead('/docs/swarms', docsShell);
		expect(out).toBeTruthy();
		const head = headOf(out);
		expect(head).toContain('<link rel="canonical" href="https://three.ws/docs/swarms"');
		expect(head).not.toContain('href="https://three.ws/docs"');
		expect(head).toMatch(/<title>Docs · Trading swarms · three\.ws<\/title>/);
		expect(head).toContain('<meta property="og:url" content="https://three.ws/docs/swarms"');
		expect(head).toContain('p=%2Fdocs%2Fswarms');
		expect(head).toContain('BreadcrumbList');
		expect(head).toContain('"url":"https://three.ws/docs/swarms"');
		// Body untouched.
		expect(out.slice(out.indexOf('</head>'))).toBe(docsShell.slice(docsShell.indexOf('</head>')));
	});

	it('leaves the shell route itself alone (canonical already matches)', () => {
		expect(rewriteHead('/docs', docsShell)).toBeNull();
		expect(rewriteHead('/docs/', docsShell)).toBeNull();
	});

	it('normalizes trailing slashes before lookup', () => {
		const out = rewriteHead('/docs/swarms/', docsShell);
		expect(out).toBeTruthy();
		expect(headOf(out)).toContain('href="https://three.ws/docs/swarms"');
	});

	it('rewrites the tutorial shell and drops the stale JSON-LD', () => {
		const slug = pagesJson.sections
			.flatMap((s) => s.pages)
			.find((p) => /^\/tutorials\/[a-z0-9-]+$/.test(p.path) && p.path !== '/tutorials/text-to-3d');
		expect(slug).toBeTruthy();
		const out = rewriteHead(slug.path, tutorialShell);
		expect(out).toBeTruthy();
		const head = headOf(out);
		expect(head).toContain(`<link rel="canonical" href="https://three.ws${slug.path}"`);
		expect(head).not.toContain('canonical" href="https://three.ws/tutorials/text-to-3d"');
		// Any remaining head JSON-LD must not describe the shell's route.
		for (const m of head.matchAll(/<script[^>]*ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
			expect(m[1]).not.toContain('https://three.ws/tutorials/text-to-3d');
		}
		expect(head).toContain(`"url":"https://three.ws${slug.path}"`);
	});

	it('returns null for unknown and non-public paths', () => {
		expect(rewriteHead('/definitely-not-a-page-xyz', docsShell)).toBeNull();
		const gated = pagesJson.sections
			.flatMap((s) => s.pages)
			.find((p) => p.auth === 'required' || p.indexable === false);
		if (gated) expect(rewriteHead(gated.path, docsShell)).toBeNull();
	});

	it('escapes catalog copy into attribute values', () => {
		const withAmp = pagesJson.sections
			.flatMap((s) => s.pages)
			.find((p) => p.path.startsWith('/docs/') && /[&"]/.test(p.description || ''));
		if (!withAmp) return;
		const head = headOf(rewriteHead(withAmp.path, docsShell));
		const desc = head.match(/<meta name="description" content="([^"]*)"/)[1];
		expect(desc).not.toMatch(/&(?!amp;|lt;|gt;|quot;|#)/);
	});
});

describe('hasSeoRoute', () => {
	it('knows catalogued routes, with and without trailing slash', () => {
		expect(hasSeoRoute('/docs/swarms')).toBe(true);
		expect(hasSeoRoute('/docs/swarms/')).toBe(true);
		expect(hasSeoRoute('/definitely-not-a-page-xyz')).toBe(false);
	});
});

// scripts/check-pages.mjs asserts a swept page served its own canonical, using
// these two exports rather than restating the rule. A drift here would silently
// turn the production sweep back into the status-only check that let
// /docs/tokens-xyz pass while it served the generic docs shell.
describe('the canonical contract check-pages sweeps against', () => {
	it('names the page, on a fixed origin, trailing slash or not', () => {
		expect(canonicalUrlFor('/docs/swarms')).toBe('https://three.ws/docs/swarms');
		expect(canonicalUrlFor('/docs/swarms/')).toBe('https://three.ws/docs/swarms');
		expect(canonicalUrlFor('/')).toBe('https://three.ws/');
	});

	it('reads back exactly what rewriteHead wrote', () => {
		const head = headOf(rewriteHead('/docs/swarms', docsShell));
		expect(canonicalOf(head)).toBe(canonicalUrlFor('/docs/swarms'));
	});

	it('reports the shell canonical for a route the shell does not own', () => {
		// What a declared-but-undeployed page looks like in the sweep: the shell
		// answers 200 carrying its own canonical, which is not the one requested.
		expect(canonicalOf(headOf(docsShell))).not.toBe(canonicalUrlFor('/docs/swarms'));
	});

	it('returns null for a document with no canonical at all', () => {
		expect(canonicalOf('<head><title>x</title></head>')).toBeNull();
	});
});
