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

// A shared shell that carries a member route's canonical exempts exactly that
// one route from the rewrite, because rewriteHead reads a matching canonical as
// "this page authored its own meta". The result is invisible from every other
// route in the section: /cookbook/text-to-3d-cli shipped the generic recipe
// shell title and description for months while its four sibling recipes were
// stamped correctly. scripts/inject-seo-meta.mjs refuses to write a member
// route's meta onto a shared shell, but that guard landed after the stamp did
// and never removes an existing one, so the invariant is pinned here instead.
describe('shared shells never exempt one of their own routes', () => {
	const vercel = JSON.parse(readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));

	// The router rule inject-seo-meta.mjs resolves against: GET routes whose
	// dest lands on a static .html file, with $1-style captures expanded.
	const router = (vercel.routes || [])
		.filter((r) => r && typeof r.src === 'string' && typeof r.dest === 'string')
		.filter((r) => !r.methods || r.methods.includes('GET'))
		.map((r) => {
			const dest = r.dest.split('?')[0];
			try {
				return { re: new RegExp(r.src.startsWith('^') ? r.src : `^${r.src}$`), dest };
			} catch {
				return null;
			}
		})
		.filter(Boolean);

	function resolveShell(routePath) {
		for (const { re, dest } of router) {
			const m = re.exec(routePath);
			if (!m) continue;
			const expanded = dest.replace(/\$(\d)/g, (_, i) => m[Number(i)] ?? '');
			if (!expanded.endsWith('.html')) continue;
			const rel = expanded.replace(/^\//, '');
			for (const base of ['pages', 'public', '.']) {
				const file = path.join(ROOT, base, rel);
				try {
					return { file, html: readFileSync(file, 'utf8') };
				} catch {
					continue;
				}
			}
		}
		return null;
	}

	const routesByShell = new Map();
	for (const section of pagesJson.sections || []) {
		for (const page of section.pages || []) {
			if (!page.path || page.path.startsWith('http')) continue;
			if (page.indexable === false || page.auth === 'required') continue;
			const shell = resolveShell(page.path);
			if (!shell) continue;
			if (!routesByShell.has(shell.file)) routesByShell.set(shell.file, { html: shell.html, paths: [] });
			routesByShell.get(shell.file).paths.push(page.path);
		}
	}

	it('finds the known shared shells', () => {
		const shared = [...routesByShell.values()].filter((s) => s.paths.length > 1);
		expect(shared.length).toBeGreaterThan(0);
	});

	// A "member shell" serves only descendants of some parent path and never the
	// parent itself: pages/recipe.html answers the four /cookbook/<slug> recipes
	// but not /cookbook, which has its own file. Every route it serves is a peer,
	// so it has no route of its own to author a head for, and claiming one is
	// always the bug. Shells that do own a route are excluded by construction:
	// docs/index.html serves /docs alongside /docs/*, and pages/forge.html serves
	// /forge next to /image-to-3d and /forge-max, which share no parent at all.
	function memberShellParent(paths) {
		const parents = new Set(paths.map((p) => p.slice(0, p.lastIndexOf('/')) || '/'));
		if (parents.size !== 1) return null;
		const parent = [...parents][0];
		// Sharing the site root is not a family: pages/forge.html answers /forge,
		// /image-to-3d and /forge-max, three unrelated top-level products, and the
		// head it ships is genuinely /forge's.
		if (parent === '/') return null;
		return paths.includes(parent) ? null : parent;
	}

	it('rewrites every catalogued route a member shell serves', () => {
		const exempt = [];
		for (const [file, { html, paths }] of routesByShell) {
			if (paths.length < 2 || !memberShellParent(paths)) continue;
			for (const p of paths) {
				if (rewriteHead(p, html) === null) exempt.push(`${path.relative(ROOT, file)} exempts ${p}`);
			}
		}
		expect(exempt).toEqual([]);
	});
});
