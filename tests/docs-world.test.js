/**
 * Docs World invariants.
 *
 * The immersive docs (/docs/world) and the classic docs SPA (/docs) share one
 * content source: docs/nav.json for the section manifest and /docs/<slug>.md
 * for the pages. These tests pin the contracts that keep the two surfaces
 * from drifting:
 *   1. nav.json is well-formed and every internal path resolves to a real
 *      markdown file that the build actually ships (never a private doc).
 *   2. The classic SPA consumes nav.json instead of carrying its own copy of
 *      the manifest, and links into the world.
 *   3. The /docs/world route is wired in vercel.json BEFORE the /docs/<slug>
 *      catch-all; ordered route tables make "present but shadowed" a real
 *      failure mode, so position is the invariant, not mere presence.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const root = resolve(__dirname, '..');
const nav = JSON.parse(readFileSync(resolve(root, 'docs/nav.json'), 'utf8'));

// Mirrors PRIVATE_DOCS in vite.config.js (copy-static-docs): these dirs never
// reach dist/docs, so a nav entry pointing into them would 404 in production.
const PRIVATE_DOCS = ['internal', 'ops', 'security'];

describe('docs/nav.json manifest', () => {
	it('has sections with titles and links', () => {
		expect(Array.isArray(nav.sections)).toBe(true);
		expect(nav.sections.length).toBeGreaterThanOrEqual(10);
		for (const section of nav.sections) {
			expect(typeof section.title).toBe('string');
			expect(section.title.length).toBeGreaterThan(0);
			expect(Array.isArray(section.links)).toBe(true);
			expect(section.links.length).toBeGreaterThan(0);
		}
	});

	it('every link is a doc path XOR an external href', () => {
		for (const section of nav.sections) {
			for (const link of section.links) {
				expect(typeof link.label).toBe('string');
				expect(Boolean(link.path) !== Boolean(link.href)).toBe(true);
			}
		}
	});

	it('every internal path resolves to a shipped markdown file', () => {
		for (const section of nav.sections) {
			for (const link of section.links) {
				if (!link.path) continue;
				const file = resolve(root, 'docs', link.path + '.md');
				expect(existsSync(file), `docs/${link.path}.md (from "${section.title}")`).toBe(true);
				// Only nested paths can land in a private DIRECTORY; a root file like
				// docs/security.md ships fine and shares a name with docs/security/.
				if (link.path.includes('/')) {
					const top = link.path.split('/')[0];
					expect(PRIVATE_DOCS.includes(top), `${link.path} is under a private docs dir`).toBe(
						false,
					);
				}
			}
		}
	});

	it('lists the docs-world doc itself', () => {
		const all = nav.sections.flatMap((s) => s.links);
		expect(all.some((l) => l.path === 'docs-world')).toBe(true);
	});
});

describe('classic docs SPA integration', () => {
	const spa = readFileSync(resolve(root, 'docs/index.html'), 'utf8');

	it('loads the shared manifest instead of an inline NAV literal', () => {
		expect(spa).toContain("fetch('/docs/nav.json')");
		expect(spa).not.toMatch(/const NAV = \[/);
	});

	it('links into the 3D world', () => {
		expect(spa).toContain('href="/docs/world"');
	});
});

describe('routing', () => {
	it('vercel.json routes /docs/world before the docs SPA catch-all', () => {
		const routes = JSON.parse(readFileSync(resolve(root, 'vercel.json'), 'utf8')).routes;
		const worldIdx = routes.findIndex((r) => r.src === '/docs/world/?');
		const catchAllIdx = routes.findIndex((r) => r.src === '/docs/([^./]+)/?');
		expect(worldIdx).toBeGreaterThanOrEqual(0);
		expect(catchAllIdx).toBeGreaterThanOrEqual(0);
		expect(worldIdx).toBeLessThan(catchAllIdx);
		expect(routes[worldIdx].dest).toBe('/docs-world.html');
	});

	it('the page shell and vite wiring exist', () => {
		expect(existsSync(resolve(root, 'pages/docs-world.html'))).toBe(true);
		const vite = readFileSync(resolve(root, 'vite.config.js'), 'utf8');
		expect(vite).toContain("'docs-world': resolve(__dirname, 'pages/docs-world.html')");
		expect(vite).toContain("'/docs/world': resolve(root, 'pages/docs-world.html')");
	});
});
