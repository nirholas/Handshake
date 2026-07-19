import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const p = (...parts) => resolve(repoRoot, ...parts);

describe('discover page — cross-links and new features', () => {
	const discoverHtml = readFileSync(p('public/discover/index.html'), 'utf8');
	const discoverJs = readFileSync(p('public/discover/discover.js'), 'utf8');

	it('/discover has OG and Twitter card meta tags', () => {
		expect(discoverHtml).toContain('property="og:title"');
		expect(discoverHtml).toContain('property="og:image"');
		expect(discoverHtml).toContain('name="twitter:card"');
		// Shared links unfurl with the page's own dynamic social card
		// (/api/page-og), not the single static /og-image.png fallback.
		expect(discoverHtml).toContain('https://three.ws/api/page-og');
	});

	it('/discover has a hidden "View my agents" chip linking to /my-agents', () => {
		expect(discoverHtml).toContain('data-role="my-agents-chip"');
		expect(discoverHtml).toContain('href="/my-agents"');
		expect(discoverHtml).toMatch(/data-role="my-agents-chip"[^>]*hidden/s);
	});

	it('/discover JS reveals chip on successful auth probe', () => {
		expect(discoverJs).toContain('/api/auth/me');
		expect(discoverJs).toContain('els.myAgentsChip.hidden = false');
	});

	it('/discover JS syncs filters to URL params', () => {
		expect(discoverJs).toContain('syncUrl');
		expect(discoverJs).toContain('history.replaceState');
	});

	it('/discover JS hydrates filter state from URL on load', () => {
		// Controls are driven by the shared list-controls toolkit; URL hydration
		// runs through hydrateFromUrl(params) (q / only3d / x402 / source / sort)
		// plus the page-specific chain read. The behaviour contract — deep links
		// and back/forward restore every filter — is preserved.
		expect(discoverJs).toContain('new URLSearchParams(location.search)');
		expect(discoverJs).toContain("params.get('q')");
		expect(discoverJs).toContain("initialParams.get('chain')");
		expect(discoverJs).toContain("params.get('only3d')");
	});

	it('/discover JS has a clear-all-filters function', () => {
		expect(discoverJs).toContain('clearAllFilters');
		expect(discoverJs).toContain('data-role="clear-filters"');
	});

	it('/discover renders a search input with a clear control via the shared toolkit', () => {
		// The search box + its clear button are now produced by the shared
		// list-controls toolkit (mounted into [data-role="list-controls"]), which
		// renders a data-lc="search" input and a data-lc="search-clear" button.
		expect(discoverHtml).toContain('data-role="list-controls"');
		expect(discoverJs).toContain('createListControls');
		expect(discoverJs).toContain("searchLabel: 'Search agents'");
	});

	it('/discover JS stats are only set on first page (not on paginated loads)', () => {
		expect(discoverJs).toContain('isFirstPage');
		expect(discoverJs).toContain('if (isFirstPage && data.totals)');
	});
});

describe('my-agents page — cross-links and empty states', () => {
	const myAgentsHtml = readFileSync(p('public/my-agents/index.html'), 'utf8');
	const myAgentsJs = readFileSync(p('public/my-agents/my-agents.js'), 'utf8');

	it('/my-agents nav includes Discover and My Agents links', () => {
		expect(myAgentsHtml).toContain('href="/discover"');
		expect(myAgentsHtml).toContain('href="/my-agents"');
	});

	it('/my-agents nav marks My Agents as current page', () => {
		expect(myAgentsHtml).toContain('aria-current="page"');
	});

	it('/my-agents is noindex (personal page, not for search)', () => {
		expect(myAgentsHtml).toContain('content="noindex"');
	});

	it('/my-agents empty state for no wallets shows secondary link to /discover', () => {
		expect(myAgentsJs).toContain('Or browse community agents');
		expect(myAgentsJs).toContain("href: '/discover'");
	});

	it('/my-agents empty state for no agents found shows link to /discover', () => {
		// Text updated; look for any link back to /discover in the empty state.
		expect(myAgentsJs).toMatch(/browse\s+community|community\s+agents|\/discover/i);
	});

	it('/my-agents showState supports a secondary link', () => {
		expect(myAgentsJs).toContain('secondary = null');
		expect(myAgentsJs).toContain('my-agents-secondary');
	});
});

describe('discover/my-agents rename — static page contents', () => {
	it('/discover serves the community ERC-8004 directory page', () => {
		const path = p('public/discover/index.html');
		expect(existsSync(path)).toBe(true);
		const html = readFileSync(path, 'utf8');
		// The title tag may carry attributes (the i18n pass adds data-i18n).
		expect(html).toMatch(/<title[^>]*>Discover · three\.ws<\/title>/);
		expect(html).toContain('ERC-8004 Agent Directory');
	});

	it('/my-agents serves the personal On-chain Agents page', () => {
		const path = p('public/my-agents/index.html');
		expect(existsSync(path)).toBe(true);
		const html = readFileSync(path, 'utf8');
		// The title tag may carry attributes (the i18n pass adds data-i18n).
		expect(html).toMatch(/<title[^>]*>My Agents · three\.ws<\/title>/);
		// Page heading uses "My Agents" (renamed from "On-chain Agents").
		expect(html).toMatch(/My Agents|On-chain Agents/);
	});

	it('/discover no longer shows the previous personal "On-chain Agents" content', () => {
		const html = readFileSync(p('public/discover/index.html'), 'utf8');
		expect(html).not.toContain('On-chain Agents');
	});

	it('/explore directory has been removed (moved to /discover)', () => {
		expect(existsSync(p('public/explore'))).toBe(false);
	});
});

describe('discover/my-agents rename — vercel.json routing', () => {
	const vercel = JSON.parse(readFileSync(p('vercel.json'), 'utf8'));
	const routes = vercel.routes || [];

	it('redirects /explore → /discover with status 301', () => {
		const r = routes.find((x) => x.src === '/explore');
		expect(r).toBeTruthy();
		expect(r.status).toBe(301);
		expect(r.headers?.Location).toBe('/discover');
	});

	it('redirects /explore/ → /discover with status 301', () => {
		const r = routes.find((x) => x.src === '/explore/');
		expect(r).toBeTruthy();
		expect(r.status).toBe(301);
		expect(r.headers?.Location).toBe('/discover');
	});

	it('serves /discover from public/discover/index.html', () => {
		const r = routes.find((x) => x.src === '/discover');
		expect(r?.dest).toBe('/discover/index.html');
	});

	it('serves /my-agents from public/my-agents/index.html', () => {
		const r = routes.find((x) => x.src === '/my-agents');
		expect(r?.dest).toBe('/my-agents/index.html');
	});

	it('does not redirect /discover → /my-agents (would shadow the page)', () => {
		const bad = routes.find(
			(x) => x.src === '/discover' && x.headers?.Location === '/my-agents',
		);
		expect(bad).toBeFalsy();
	});

	it('places /explore redirects after /discover and /my-agents rewrites', () => {
		const idx = (src) => routes.findIndex((x) => x.src === src);
		expect(idx('/explore')).toBeGreaterThan(idx('/discover'));
		expect(idx('/explore')).toBeGreaterThan(idx('/my-agents'));
	});

	// Vercel evaluates `routes` top-to-bottom; a permissive earlier rule (e.g. a
	// catch-all `(.*)`) would prevent /discover and /my-agents from ever being
	// reached. Lock this in so a future re-order can't silently shadow them.
	// A `continue: true` catch-all (e.g. the global security-headers route) is
	// exempt — it only attaches headers and falls through, so it shadows nothing.
	it('no terminating catch-all rule sits before /discover or /my-agents rewrites', () => {
		const idx = (src) => routes.findIndex((x) => x.src === src);
		const discoverAt = idx('/discover');
		const myAgentsAt = idx('/my-agents');
		const earliestProtected = Math.min(discoverAt, myAgentsAt);
		const catchAllBefore = routes
			.slice(0, earliestProtected)
			.some((r) => (r.src === '/(.*)' || r.src === '(.*)') && !r.continue);
		expect(catchAllBefore).toBe(false);
	});
});
