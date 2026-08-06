// /airdrops page wiring, modeled on tests/portfolio-page.test.js.

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');

const html = read('pages/airdrops.html');
const js = read('src/airdrops.js');
const css = read('src/airdrops.css');
const vercel = JSON.parse(read('vercel.json'));
const viteConfig = read('vite.config.js');
const pages = JSON.parse(read('data/pages.json'));
const navData = read('public/nav-data.js');
const registry = JSON.parse(read('data/airdrops.json'));

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
	it('serves /airdrops from the route table before the filesystem phase', () => {
		const idx = vercel.routes.findIndex((r) => r.src === '/airdrops/?');
		const fsIdx = vercel.routes.findIndex((r) => r.handle === 'filesystem');
		expect(idx).toBeGreaterThan(-1);
		expect(vercel.routes[idx].dest).toBe('/airdrops.html');
		expect(fsIdx).toBeGreaterThan(idx);
	});

	it('has its API handler on disk where filesystem routing resolves it', () => {
		expect(existsSync(resolve(ROOT, 'api/crypto/airdrops.js'))).toBe(true);
	});

	it('is a build entry and resolves in the dev server route map', () => {
		expect(viteConfig).toContain("airdrops: resolve(__dirname, 'pages/airdrops.html')");
		expect(viteConfig).toContain("'/airdrops': resolve(root, 'pages/airdrops.html')");
		expect(viteConfig).toContain("'/airdrops/': resolve(root, 'pages/airdrops.html')");
	});
});

describe('discovery', () => {
	it('is declared in data/pages.json with its docs page', () => {
		expect(pagePaths().has('/airdrops')).toBe(true);
		expect(pagePaths().has('/docs/airdrops')).toBe(true);
		expect(existsSync(resolve(ROOT, 'docs/airdrops.md'))).toBe(true);
	});

	it('is linked from the site nav', () => {
		expect(navData).toContain("href: '/airdrops'");
	});

	it('cross-links with the portfolio page in both directions', () => {
		expect(html).toContain('href="/portfolio"');
		expect(read('pages/portfolio.html')).toContain('id="pf-airdrops-link"');
		expect(read('src/portfolio.js')).toContain('/airdrops?address=');
	});

	it('declares a canonical URL and an OG image', () => {
		expect(html).toContain('<link rel="canonical" href="https://three.ws/airdrops" />');
		expect(html).toContain('og:image');
	});
});

describe('registry integrity', () => {
	it('every entry carries the required fields', () => {
		expect(registry.airdrops.length).toBeGreaterThan(3);
		for (const e of registry.airdrops) {
			expect(e.id, 'id').toBeTruthy();
			expect(e.name, `${e.id} name`).toBeTruthy();
			expect(['solana', 'evm']).toContain(e.family);
			expect(['confirmed', 'speculation', 'upcoming']).toContain(e.status);
			expect(e.source, `${e.id} source`).toMatch(/^https:\/\//);
			expect(Array.isArray(e.criteria) && e.criteria.length > 0, `${e.id} criteria`).toBe(true);
			for (const c of e.criteria) expect(c.description, `${e.id} criterion description`).toBeTruthy();
		}
	});

	it('every check string parses against the evaluator DSL', async () => {
		const { evaluateCriterion, ACTIVITY_FIELDS } = await import('../api/_lib/airdrop-eligibility.js');
		const probe = Object.fromEntries([...ACTIVITY_FIELDS].map((f) => [f, 1]));
		for (const e of registry.airdrops) {
			for (const c of e.criteria) {
				if (!c.check) continue;
				const r = evaluateCriterion(c, probe);
				expect(r.unknown, `${e.id}: "${c.check}" does not parse or names an unknown field`).toBe(false);
			}
		}
	});

	it('leads with Solana (chain priority)', () => {
		expect(registry.airdrops[0].family).toBe('solana');
		const solanaCount = registry.airdrops.filter((e) => e.family === 'solana').length;
		expect(solanaCount).toBeGreaterThanOrEqual(registry.airdrops.length / 2);
	});

	it('is dated so staleness is visible', () => {
		expect(registry.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});
});

describe('page structure', () => {
	it('mounts every element the hydration script writes into', () => {
		const ids = [...js.matchAll(/\$\('([a-z0-9-]+)'\)/g)].map((m) => m[1]);
		expect(ids.length).toBeGreaterThan(10);
		for (const id of new Set(ids)) {
			expect(html, `#${id} is written to but not present in the page`).toContain(`id="${id}"`);
		}
	});

	it('loads its own stylesheet, the shared markets layer, and its module', () => {
		expect(html).toContain('/src/coin-pages.css');
		expect(html).toContain('/src/airdrops.css');
		expect(html).toContain('/src/airdrops.js');
	});

	it('designs directory, loading and error states', () => {
		expect(html).toContain('id="ad-directory"');
		expect(html).toContain('id="ad-loading"');
		expect(html).toContain('id="ad-error"');
		expect(js).toContain("show('error')");
		expect(js).toContain("show('loading')");
		expect(js).toContain("show('directory')");
	});

	it('respects a reduced-motion preference', () => {
		expect(css).toContain('@media (prefers-reduced-motion: reduce)');
	});

	it('uses no inline event handlers', () => {
		expect(html).not.toMatch(/\son(error|click|load|mouseover)=/i);
	});
});

describe('honesty', () => {
	it('ships no sample or seed data', () => {
		expect(js).not.toMatch(/const\s+(sample|demo|fake|mock)[A-Za-z]*\s*=\s*\[/i);
	});

	it('reads from the real endpoint', () => {
		expect(js).toContain('/api/crypto/airdrops');
	});

	it('renders unmeasured fields as such and flags capped scans', () => {
		expect(js).toContain('not measured');
		expect(js).toMatch(/capped/);
	});

	it('labels estimates as speculation, not promises', () => {
		expect(js).toMatch(/speculation, not a promise/i);
		expect(html).toMatch(/not.*financial advice|not promises/i);
	});

	it('uses no banned dash characters', () => {
		for (const [name, src] of [
			['pages/airdrops.html', html],
			['src/airdrops.js', js],
			['src/airdrops.css', css],
			['data/airdrops.json', JSON.stringify(registry)],
		]) {
			expect(src, `${name} contains a banned dash`).not.toMatch(/[\u2014\u2013]/);
		}
	});
});
