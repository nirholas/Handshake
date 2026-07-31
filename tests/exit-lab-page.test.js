// /exit-lab page wiring.
//
// A page can be built, styled and correct and still be unreachable. These pin
// the connections that have silently broken before: the route table, the vite
// entry, the sitemap record, the nav link, and every href on the page resolving
// to something that actually exists.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');

const html = read('pages/exit-lab.html');
const js = read('src/exit-lab.js');
const css = read('src/exit-lab.css');
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
	it('serves /exit-lab from the route table', () => {
		const route = vercel.routes.find((r) => r.src === '/exit-lab/?');
		expect(route).toBeDefined();
		expect(route.dest).toBe('/exit-lab.html');
	});

	it('routes the corpus endpoint to its handler', () => {
		const route = vercel.routes.find((r) => r.src === '/api/sniper/exit-lab');
		expect(route).toBeDefined();
		expect(route.dest).toBe('/api/sniper/exit-lab.js');
	});

	it('declares the endpoint route before any broader /api/sniper pattern could swallow it', () => {
		// A catch-all placed earlier has silently shadowed documented endpoints in
		// this repo before. Order in the routes array is what decides the winner.
		const idx = vercel.routes.findIndex((r) => r.src === '/api/sniper/exit-lab');
		const shadow = vercel.routes.findIndex(
			(r, i) => i < idx && typeof r.src === 'string' && /^\/api\/sniper\/\(?\.\*|^\/api\/sniper\/\[/.test(r.src),
		);
		expect(shadow).toBe(-1);
	});

	it('is a build entry, so the static HTML is actually emitted', () => {
		expect(viteConfig).toContain("'exit-lab': resolve(__dirname, 'pages/exit-lab.html')");
	});

	it('resolves in the dev server route map', () => {
		expect(viteConfig).toContain("'/exit-lab': resolve(root, 'pages/exit-lab.html')");
		expect(viteConfig).toContain("'/exit-lab/': resolve(root, 'pages/exit-lab.html')");
	});
});

describe('discovery', () => {
	it('is declared in data/pages.json, which feeds the sitemap and llms.txt', () => {
		expect(pagePaths().has('/exit-lab')).toBe(true);
	});

	it('is linked from the site nav', () => {
		expect(navData).toContain("href: '/exit-lab'");
	});

	it('declares a canonical URL and an OG image', () => {
		expect(html).toContain('<link rel="canonical" href="https://three.ws/exit-lab" />');
		expect(html).toContain('og:image');
	});
});

describe('page structure', () => {
	it('mounts every element the hydration script writes into', () => {
		const ids = [...js.matchAll(/\$\('([a-z0-9-]+)'\)/g)].map((m) => m[1]);
		expect(ids.length).toBeGreaterThan(5);
		for (const id of new Set(ids)) {
			// Ids created by the script itself at render time are exempt.
			if (id === 'xl-retry') continue;
			expect(html, `#${id} is written to but not present in the page`).toContain(`id="${id}"`);
		}
	});

	it('loads its own stylesheet and module', () => {
		expect(html).toContain('/src/exit-lab.css');
		expect(html).toContain('/src/exit-lab.js');
	});

	it('every internal href resolves to a declared page or a docs path', () => {
		const hrefs = [...html.matchAll(/href="(\/[^"#]*)"/g), ...js.matchAll(/href="(\/[^"#$]*)"/g)]
			.map((m) => m[1])
			.filter((h) => !h.startsWith('/src/') && !h.startsWith('/api/'));
		const known = pagePaths();
		for (const href of new Set(hrefs)) {
			if (href === '/') continue;
			if (/\.(css|js|ico|svg|png|webmanifest)$/.test(href)) continue;
			const ok = known.has(href) || known.has(href.replace(/\/$/, '')) || href.startsWith('/docs/');
			expect(ok, `${href} is linked from /exit-lab but matches no route`).toBe(true);
		}
	});

	it('keeps the primary button readable against the accent token', () => {
		// --accent is #ffffff in the dark theme, so a hardcoded white foreground
		// renders an invisible CTA. This exact bug shipped on a sibling page.
		expect(css).toContain('--btn-primary-fg');
		expect(css).not.toMatch(/\.xl-btn-primary\s*\{[^}]*color:\s*#fff/i);
	});

	it('designs a loading, an empty and an error state', () => {
		expect(css).toContain('.xl-state-loading');
		expect(css).toContain('.xl-state-empty');
		expect(css).toContain('.xl-state-error');
		expect(js).toContain('xl-state-error');
		expect(js).toContain('xl-state-empty');
	});

	it('respects a reduced-motion preference', () => {
		expect(css).toContain('@media (prefers-reduced-motion: reduce)');
	});

	it('scrolls a wide table inside its own container rather than the page body', () => {
		expect(css).toMatch(/\.xl-table-scroll\s*\{[^}]*overflow-x:\s*auto/);
	});
});

describe('honesty', () => {
	it('ships no sample or seed corpus', () => {
		expect(js).not.toMatch(/const\s+(sample|demo|fake|mock)[A-Za-z]*\s*=\s*\[/i);
	});

	it('reads its corpus from the real endpoint', () => {
		expect(js).toContain('/api/sniper/exit-lab');
	});

	it('states the slippage caveat on the page rather than only in the docs', () => {
		expect(js).toMatch(/slippage/i);
	});

	it('uses no banned dash characters in user-visible copy', () => {
		for (const [name, src] of [
			['pages/exit-lab.html', html],
			['src/exit-lab.js', js],
			['src/exit-lab.css', css],
		]) {
			expect(src, `${name} contains a banned dash`).not.toMatch(/[\u2014\u2013]/);
		}
	});
});
