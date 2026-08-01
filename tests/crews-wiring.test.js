import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// The crews backend shipped complete and stayed invisible for weeks because
// nothing routed to it. These assertions pin every hop a visitor takes from a
// URL to the rendered page, so the same gap cannot reopen quietly.

const root = resolve(import.meta.dirname, '..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');

describe('crews wiring', () => {
	it('routes /crews and /crews/<TAG> to the page', () => {
		const routes = JSON.parse(read('vercel.json')).routes;
		const dests = routes.filter((r) => /^\/crews/.test(r.src || '')).map((r) => r.dest);
		expect(dests).toContain('/crews.html');
		const tagRoute = routes.find((r) => r.src === '/crews/([A-Za-z0-9]{2,6})/?');
		expect(tagRoute?.dest).toBe('/crews.html');
	});

	it('builds the page: it is a vite rollup input', () => {
		expect(read('vite.config.js')).toContain("crews: resolve(__dirname, 'pages/crews.html')");
	});

	it('declares the page so the sitemap, llms.txt and changelog pick it up', () => {
		const pages = JSON.parse(read('data/pages.json'));
		const entry = pages.sections.flatMap((s) => s.pages).find((p) => p.path === '/crews');
		expect(entry).toBeTruthy();
		expect(entry.title).toBeTruthy();
		expect(entry.description.length).toBeGreaterThan(40);
		expect(entry.added).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});

	it('is reachable from the site navigation', () => {
		expect(read('public/nav-data.js')).toContain("href: '/crews'");
	});

	it('loads its module, styles and the 3D component', () => {
		const html = read('pages/crews.html');
		expect(html).toContain('/src/crews-page.js');
		expect(html).toContain('/src/crews.css');
		expect(html).toContain('agent-3d');
		// Every element the page module reaches for by id must exist somewhere: in
		// the static markup, or in the markup the module itself renders. An id in
		// neither place is a whole state that silently no-ops.
		const js = read('src/crews-page.js');
		const ids = [...js.matchAll(/\$\('([a-z0-9-]+)'\)/g)].map((m) => m[1]);
		expect(ids.length).toBeGreaterThan(10);
		for (const id of new Set(ids)) {
			const inPage = html.includes(`id="${id}"`);
			const rendered = js.includes(`id="${id}"`);
			expect(inPage || rendered, `#${id} is read by crews-page.js but nothing ever creates it`).toBe(true);
		}
	});

	it('links the in-world friends drawer to the HQ', () => {
		expect(read('src/game/coincommunities.js')).toContain("crew.href = '/crews'");
	});

	it('ships every endpoint the page calls', () => {
		const js = read('src/crews-page.js');
		for (const path of ['/api/crews', '/api/crews/directory', '/api/crews/search']) {
			expect(js).toContain(path);
		}
		expect(() => read('api/crews/index.js')).not.toThrow();
		expect(() => read('api/crews/directory.js')).not.toThrow();
		expect(() => read('api/crews/search.js')).not.toThrow();
		expect(() => read('api/crews/[tag].js')).not.toThrow();
	});

	it('never emits a private avatar through a roster', () => {
		const store = read('api/_lib/crews-store.js');
		expect(store).toContain("a.visibility in ('public', 'unlisted')");
		expect(store).toMatch(/readable && r\.storage_key \? publicUrl/);
		expect(store).toMatch(/readable && r\.thumbnail_key \? thumbnailUrl/);
	});
});
