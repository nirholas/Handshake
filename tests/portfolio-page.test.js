// /portfolio page wiring.
//
// A page can be built, styled and correct and still be unreachable. These pin
// the connections that have silently broken before: the route table, the vite
// entry, the sitemap record, the nav link, the API handler, and every href on
// the page resolving to something that actually exists. Modeled on
// tests/exit-lab-page.test.js.

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');

const html = read('pages/portfolio.html');
const js = read('src/portfolio.js');
const css = read('src/portfolio.css');
const vercel = JSON.parse(read('vercel.json'));
const viteConfig = read('vite.config.js');
const pages = JSON.parse(read('data/pages.json'));
const navData = read('public/nav-data.js');

function pagePaths() {
	const out = new Set();
	const walk = (node) => {
		if (Array.isArray(node)) return node.forEach(walk);
		if (!node || typeof node !== 'object') return;
		if (typeof node.path === 'string') out.add(node.path);
		Object.values(node).forEach(walk);
	};
	walk(pages);
	return out;
}

describe('routing', () => {
	it('serves /portfolio from the route table', () => {
		const route = vercel.routes.find((r) => r.src === '/portfolio/?');
		expect(route).toBeDefined();
		expect(route.dest).toBe('/portfolio.html');
	});

	it('declares the page route before the filesystem phase', () => {
		const pageIdx = vercel.routes.findIndex((r) => r.src === '/portfolio/?');
		const fsIdx = vercel.routes.findIndex((r) => r.handle === 'filesystem');
		expect(pageIdx).toBeGreaterThan(-1);
		expect(fsIdx).toBeGreaterThan(pageIdx);
	});

	it('has its API handler on disk where filesystem routing resolves it', () => {
		// /api/crypto/portfolio has no explicit vercel route on purpose: the
		// server's Vercel-parity filesystem routing maps it straight to this file.
		expect(existsSync(resolve(ROOT, 'api/crypto/portfolio.js'))).toBe(true);
	});

	it('is not shadowed by an explicit /api/crypto/portfolio route pointing elsewhere', () => {
		const explicit = vercel.routes.filter(
			(r) => typeof r.src === 'string' && r.src.includes('/api/crypto/portfolio'),
		);
		for (const r of explicit) expect(r.dest).toBe('/api/crypto/portfolio.js');
	});

	it('is a build entry, so the static HTML is actually emitted', () => {
		expect(viteConfig).toContain("portfolio: resolve(__dirname, 'pages/portfolio.html')");
	});

	it('resolves in the dev server route map', () => {
		expect(viteConfig).toContain("'/portfolio': resolve(root, 'pages/portfolio.html')");
		expect(viteConfig).toContain("'/portfolio/': resolve(root, 'pages/portfolio.html')");
	});
});

describe('discovery', () => {
	it('is declared in data/pages.json, which feeds the sitemap and llms.txt', () => {
		expect(pagePaths().has('/portfolio')).toBe(true);
	});

	it('ships its docs page, registered so audit:docs passes', () => {
		expect(existsSync(resolve(ROOT, 'docs/portfolio.md'))).toBe(true);
		expect(pagePaths().has('/docs/portfolio')).toBe(true);
	});

	it('is linked from the site nav', () => {
		expect(navData).toContain("href: '/portfolio'");
	});

	it('declares a canonical URL and an OG image', () => {
		expect(html).toContain('<link rel="canonical" href="https://three.ws/portfolio" />');
		expect(html).toContain('og:image');
	});
});

describe('page structure', () => {
	it('mounts every element the hydration script writes into', () => {
		const ids = [...js.matchAll(/\$\('([a-z0-9-]+)'\)/g)].map((m) => m[1]);
		expect(ids.length).toBeGreaterThan(10);
		for (const id of new Set(ids)) {
			// Dynamic summary-card ids are still static in the page markup.
			if (id.startsWith('pf-sum-')) continue;
			expect(html, `#${id} is written to but not present in the page`).toContain(`id="${id}"`);
		}
	});

	it('mounts the summary cards for every classification bucket', () => {
		for (const key of ['stable', 'major', 'other']) {
			expect(html).toContain(`id="pf-sum-${key}"`);
			expect(html).toContain(`id="pf-sum-${key}-sub"`);
		}
	});

	it('loads its own stylesheet, the shared markets layer, and its module', () => {
		expect(html).toContain('/src/coin-pages.css');
		expect(html).toContain('/src/portfolio.css');
		expect(html).toContain('/src/portfolio.js');
	});

	it('every internal href resolves to a declared page or a docs path', () => {
		const hrefs = [...html.matchAll(/href="(\/[^"#]*)"/g)]
			.map((m) => m[1])
			.filter((h) => !h.startsWith('/src/') && !h.startsWith('/api/'));
		const known = pagePaths();
		for (const href of new Set(hrefs)) {
			if (href === '/') continue;
			if (/\.(css|js|ico|svg|png|webmanifest)$/.test(href)) continue;
			const ok = known.has(href) || known.has(href.replace(/\/$/, '')) || href.startsWith('/docs/');
			expect(ok, `${href} is linked from /portfolio but matches no route`).toBe(true);
		}
	});

	it('designs a loading, an empty and an error state', () => {
		expect(html).toContain('id="pf-loading"');
		expect(html).toContain('id="pf-empty"');
		expect(html).toContain('id="pf-error"');
		expect(js).toContain("show('empty')");
		expect(js).toContain("show('error')");
		expect(js).toContain("show('loading')");
	});

	it('respects a reduced-motion preference', () => {
		expect(css).toContain('@media (prefers-reduced-motion: reduce)');
	});

	it('scrolls the holdings table inside its own container rather than the page body', () => {
		expect(css).toMatch(/\.pf-table-wrap\s*\{[^}]*overflow-x:\s*auto/);
	});

	it('uses no inline event handlers (CSP + audit:inline-handlers)', () => {
		expect(html).not.toMatch(/\son(error|click|load|mouseover)=/i);
		expect(js).not.toMatch(/\bonerror="/);
	});
});

describe('honesty', () => {
	it('ships no sample or seed portfolio', () => {
		expect(js).not.toMatch(/const\s+(sample|demo|fake|mock)[A-Za-z]*\s*=\s*\[/i);
	});

	it('reads holdings from the real endpoint', () => {
		expect(js).toContain('/api/crypto/portfolio');
	});

	it('states 24h coverage instead of implying complete data', () => {
		expect(js).toContain('coveragePct');
		expect(js).toMatch(/based on .*% of value/);
	});

	it('surfaces the stale-snapshot banner path', () => {
		expect(html).toContain('id="pf-stale"');
		expect(js).toContain('pf-stale');
	});

	it('uses no banned dash characters', () => {
		for (const [name, src] of [
			['pages/portfolio.html', html],
			['src/portfolio.js', js],
			['src/portfolio.css', css],
		]) {
			expect(src, `${name} contains a banned dash`).not.toMatch(/[\u2014\u2013]/);
		}
	});
});
