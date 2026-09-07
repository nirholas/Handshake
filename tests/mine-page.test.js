import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const p = (...parts) => resolve(repoRoot, ...parts);
const read = (...parts) => readFileSync(p(...parts), 'utf8');

const html = read('pages/mine.html');
const js = read('src/mine.js');
const css = read('src/mine.css');

describe('/mine page shell', () => {
	it('loads its own module, stylesheet, nav and footer', () => {
		expect(html).toContain('/src/mine.js');
		expect(html).toContain('/src/mine.css');
		expect(html).toContain('id="nav-container"');
		expect(html).toContain('id="footer-container"');
	});

	it('is a personal page: canonical /mine and noindex', () => {
		expect(html).toContain('https://three.ws/mine');
		expect(html).toMatch(/name="robots" content="noindex/);
	});

	it('ships the type filters, the search box and the grid the module fills', () => {
		for (const filter of ['all', 'agent', 'avatar', 'model']) {
			expect(html).toContain(`data-filter="${filter}"`);
		}
		expect(html).toContain('id="mn-search-input"');
		expect(html).toContain('id="mn-grid"');
	});

	it('tells a signed-out visitor why the page is partial, with a way in', () => {
		expect(html).toContain('id="mn-anon-note"');
		expect(html).toContain('/login?next=%2Fmine');
	});
});

describe('/mine data sources', () => {
	it('reads every real creation feed and never invents items', () => {
		expect(js).toContain('/api/auth/me');
		expect(js).toContain('/api/agents');
		expect(js).toContain('/api/avatars/mine');
		expect(js).toContain('/api/forge-gallery');
		expect(js).toContain('/creations?limit=');
		expect(js).not.toMatch(/const sample[A-Z]/);
	});

	it('scopes the anonymous forge feed to this browser and never to the shared bucket', () => {
		// hashClient() maps a missing id to the shared 'anon' key, which would
		// show one visitor another visitor's models. No id means no request.
		expect(js).toContain("localStorage.getItem('forge:cid')");
		expect(js).toContain("'x-forge-client'");
		expect(js).toMatch(/if \(cid\) \{/);
	});

	it('distinguishes an empty account from an unreachable API', () => {
		expect(js).toContain('result.failures === result.sources');
		expect(js).toContain('Could not reach your creations');
	});

	it('bounds live WebGL contexts so a big library cannot exhaust the browser', () => {
		expect(js).toContain('MAX_LIVE_VIEWERS');
		expect(js).toContain('disposeViewer');
	});

	it('designs the loading, empty and error states rather than blanking the grid', () => {
		expect(js).toContain('skeletons(');
		expect(js).toContain('emptyStateHTML');
		expect(js).toContain('errorStateHTML');
		expect(css).toContain('.mn-skel');
	});
});

describe('/mine is reachable', () => {
	const vercel = JSON.parse(read('vercel.json'));
	const routeFor = (src) => vercel.routes.find((r) => r.src === src);

	it('routes /mine and /my-creations to the page', () => {
		expect(routeFor('/mine/?')?.dest).toBe('/mine.html');
		expect(routeFor('/my-creations/?')?.dest).toBe('/mine.html');
	});

	it('is a build input and a dev-server route', () => {
		const vite = read('vite.config.js');
		expect(vite).toContain("mine: resolve(__dirname, 'pages/mine.html')");
		expect(vite).toContain("'/mine': resolve(root, 'pages/mine.html')");
	});

	it('is documented in the page index that feeds the sitemap and changelog', () => {
		const pages = JSON.parse(read('data/pages.json'));
		const entry = pages.sections.flatMap((s) => s.pages || []).find((x) => x.path === '/mine');
		expect(entry).toBeTruthy();
		expect(entry.title).toBe('My Creations');
	});
});

describe('the way back to your work is one click from anywhere', () => {
	it('sits in the desktop nav for signed-in visitors', () => {
		const nav = read('public/nav.html');
		expect(nav).toMatch(/href="\/mine"[^>]*id="home-nav-mine"/);
		expect(nav).toMatch(/id="home-nav-mine"[^>]*data-auth="in"/);
		// Authored hidden so the signed-out (and fetch-failed) default is safe.
		expect(nav).toMatch(/id="home-nav-mine"[^>]*hidden/);
		expect(nav).toContain('My creations');
	});

	it('sits in the mobile drawer and the Build menu', () => {
		expect(read('public/nav.js')).toContain('id="home-nav-drawer-mine"');
		const navData = read('public/nav-data.js');
		expect(navData).toContain("href: '/mine'");
		expect(navData).toContain("title: 'My Creations'");
	});

	it('is cross-linked from every surface where someone makes something', () => {
		expect(read('pages/create.html')).toContain('href="/mine"');
		expect(read('pages/create-agent.html')).toContain('href="/mine"');
		expect(read('pages/forge.html')).toContain('href="/mine"');
		expect(read('public/my-agents/index.html')).toContain('href="/mine"');
		expect(read('src/dashboard-next/nav.js')).toContain("path: '/mine'");
	});
});
