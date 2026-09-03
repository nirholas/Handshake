// /sniper/experiments page wiring.
//
// A scoreboard can be correct and still be unusable. These pin the failures this
// page actually shipped with: a second, stale copy of its own stylesheet injected
// at runtime that overrode the token-based one (hardcoded #4ade80 on a white
// light-theme background, ~1.7:1), a blank void instead of a loading state while
// the RPC balance reads land, an error card with nothing to click, and a window
// switch that could paint an out-of-order response.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');

const html = read('pages/sniper-experiments.html');
const js = read('src/sniper-experiments.js');
const css = read('src/sniper-experiments.css');
const vercel = JSON.parse(read('vercel.json'));
const viteConfig = read('vite.config.js');
const pages = JSON.parse(read('data/pages.json'));

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
	it('serves /sniper/experiments from the route table', () => {
		const route = vercel.routes.find((r) => r.src === '/sniper/experiments/?');
		expect(route).toBeDefined();
		expect(route.dest).toBe('/sniper-experiments.html');
	});

	it('routes the scoreboard endpoint to its handler', () => {
		const route = vercel.routes.find((r) => r.src === '/api/sniper/experiments');
		expect(route).toBeDefined();
		expect(route.dest).toBe('/api/sniper/experiments.js');
	});

	it('is a build entry and resolves in the dev server route map', () => {
		expect(viteConfig).toContain("'sniper-experiments': resolve(__dirname, 'pages/sniper-experiments.html')");
		expect(viteConfig).toContain("'/sniper/experiments': resolve(root, 'pages/sniper-experiments.html')");
	});

	it('is declared in data/pages.json, which feeds the sitemap and llms.txt', () => {
		expect(pagePaths().has('/sniper/experiments')).toBe(true);
	});
});

describe('head', () => {
	it('carries a specific title, description and canonical URL', () => {
		expect(html).toMatch(/<title[^>]*>Sniper Experiments · three\.ws<\/title>/);
		const desc = html.match(/name="description"\s+content="([^"]+)"/s)?.[1] || '';
		expect(desc.length).toBeGreaterThan(80);
		expect(desc).toMatch(/LLM/);
		expect(html).toContain('<link rel="canonical" href="https://three.ws/sniper/experiments" />');
	});
});

describe('page structure', () => {
	it('mounts every element the hydration script writes into', () => {
		const ids = [...js.matchAll(/\$\('([a-z0-9-]+)'\)/g)].map((m) => m[1]);
		expect(ids.length).toBeGreaterThan(4);
		for (const id of new Set(ids)) {
			expect(html, `#${id} is written to but not present in the page`).toContain(`id="${id}"`);
		}
	});

	it('loads its own stylesheet and module', () => {
		expect(html).toContain('/src/sniper-experiments.css');
		expect(html).toContain('/src/sniper-experiments.js');
	});

	it('has exactly one h1', () => {
		expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
	});

	it('every internal href resolves to a declared page or a served route', () => {
		// `src` entries are regexes, and several real routes are alternations
		// (`/(oracle/arm|arm)/?`), so a string compare misses them. Match the way
		// server/index.mjs does: anchor the pattern and test the path against it.
		const patterns = vercel.routes
			.filter((r) => typeof r.src === 'string' && typeof r.dest === 'string')
			.map((r) => new RegExp(`^${r.src}$`));
		const served = (href) => patterns.some((re) => re.test(href));
		const hrefs = [...html.matchAll(/href="(\/[^"#]*)"/g), ...js.matchAll(/href="(\/[^"#$`]*)"/g)]
			.map((m) => m[1])
			.filter((h) => !h.startsWith('/src/') && !h.startsWith('/api/'));
		const known = pagePaths();
		for (const href of new Set(hrefs)) {
			if (href === '/') continue;
			if (/\.(css|js|ico|svg|png|webmanifest)$/.test(href)) continue;
			const ok = known.has(href) || served(href) || href.startsWith('/docs/');
			expect(ok, `${href} is linked from /sniper/experiments but matches no route`).toBe(true);
		}
	});
});

describe('styling has one source of truth', () => {
	// The page shipped with a second copy of its own rules built as a template
	// literal and appended to <head> at runtime. Being last, it won every tie and
	// silently reverted the stylesheet: profit figures rendered #4ade80 on the
	// light theme's white background at roughly 1.7:1.
	it('never injects a stylesheet at runtime', () => {
		expect(js).not.toContain('createElement(\'style\')');
		expect(js).not.toMatch(/\.xp-[a-z-]+\s*\{[^}]*:/);
	});

	it('takes every colour from the theme tokens, not a hardcoded hex', () => {
		expect(css).not.toMatch(/color:\s*#[0-9a-f]{3,8}\b/i);
		expect(css).toContain('color: var(--cv-green)');
		expect(css).toContain('color: var(--cv-red)');
	});

	it('does not promise interactions the board does not have', () => {
		// .cv-table is built for sortable, row-clickable market tables. Nothing on
		// this board sorts and no row navigates.
		expect(css).toMatch(/\.xp-table th,\s*\n?\.xp-table tbody tr \{ cursor: default; \}/);
	});
});

describe('every state is designed', () => {
	it('paints a shape-matched skeleton before the first response', () => {
		expect(js).toContain('function renderSkeleton()');
		expect(js).toContain('cv-skel');
		// Runs at bootstrap, not only on a later refresh.
		expect(js).toMatch(/renderControls\(\);\s*\nrenderSkeleton\(\);\s*\nrefresh\(\);/);
		expect(css).toContain('.xp-skel-line');
	});

	it('gives the error state a real retry control and a human cause', () => {
		expect(js).toContain('function renderError(');
		expect(js).toContain('data-retry');
		expect(js).toContain("querySelector('[data-retry]').addEventListener('click', refresh)");
		expect(js).toContain('function describeFailure(');
	});

	it('keeps a working board on a failed refresh instead of blanking it', () => {
		expect(js).toContain('function renderStaleNotice(');
		expect(js).toMatch(/if \(hasData\) renderStaleNotice\(err\);\s*\n\s*else renderError\(err\);/);
		expect(html).toContain('id="xp-alert"');
	});

	it('states the empty case for both the board and the judgment ledger', () => {
		expect(js).toContain('No strategies armed on this network yet');
		expect(js).toContain('No LLM verdicts in this window');
	});

	it('announces refreshes and load state to assistive tech', () => {
		expect(html).toContain('aria-busy="true"');
		expect(html).toMatch(/id="xp-updated"[^>]*aria-live="polite"/);
		expect(js).toContain("setAttribute('aria-busy'");
	});
});

describe('polling correctness', () => {
	it('discards an out-of-order response so a window switch cannot be overwritten', () => {
		expect(js).toContain('let reqSeq = 0');
		expect(js).toContain('const seq = ++reqSeq');
		expect(js.match(/if \(seq !== reqSeq\) return;/g)?.length).toBeGreaterThanOrEqual(2);
	});
});
