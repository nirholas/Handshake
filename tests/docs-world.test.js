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

/**
 * The rule that rewrites every /docs/<slug> to the SPA shell. Its regex has
 * been re-spelled more than once (the slug class widened when nested docs
 * landed), so match it by what it does, not by one exact string: a rule that
 * sends a plain slug to the shell.
 */
function findDocsCatchAll(routes) {
	return routes.findIndex(
		(r) =>
			r.dest === '/docs/index.html' &&
			typeof r.src === 'string' &&
			r.src.startsWith('/docs/(') &&
			new RegExp('^' + r.src + '$').test('/docs/start-here'),
	);
}

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
				// A doc reaches /docs/<slug>.md from either source root: docs/ is
				// copied into dist by copy-static-docs, and public/docs/ is served
				// verbatim. Accepting only the first would fail a page that ships.
				const file = resolve(root, 'docs', link.path + '.md');
				const publicFile = resolve(root, 'public/docs', link.path + '.md');
				expect(
					existsSync(file) || existsSync(publicFile),
					`neither docs/${link.path}.md nor public/docs/${link.path}.md exists (from "${section.title}")`,
				).toBe(true);
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
		const catchAllIdx = findDocsCatchAll(routes);
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

	it('serves the manifest as a file instead of swallowing it into the SPA', () => {
		// Both surfaces fetch /docs/nav.json, so if the SPA catch-all captured it
		// the request would answer with docs/index.html and BOTH the classic
		// sidebar and the whole 3D world would fail at once. The dot exclusion in
		// the catch-all is what prevents that, so assert the behaviour, not the
		// spelling: the catch-all must not match, and a later static rule must.
		const routes = JSON.parse(readFileSync(resolve(root, 'vercel.json'), 'utf8')).routes;
		const catchAllIdx = findDocsCatchAll(routes);
		expect(catchAllIdx, 'no /docs/<slug> catch-all route').toBeGreaterThanOrEqual(0);
		expect(new RegExp('^' + routes[catchAllIdx].src + '$').test('/docs/nav.json')).toBe(false);

		const staticIdx = routes.findIndex(
			(r, i) => i > catchAllIdx && new RegExp('^' + r.src + '$').test('/docs/nav.json'),
		);
		expect(staticIdx, 'no route serves /docs/nav.json').toBeGreaterThan(catchAllIdx);
		expect(routes[staticIdx].dest).toContain('/docs/');
	});

	it('ships the manifest to dist, outside every private docs directory', () => {
		// copy-static-docs mirrors docs/ into dist/docs but drops PRIVATE_DOCS.
		// nav.json sits at the docs root, so it ships; this pins that it never
		// moves under one of those directories.
		expect(existsSync(resolve(root, 'docs/nav.json'))).toBe(true);
		for (const dir of PRIVATE_DOCS) {
			expect(existsSync(resolve(root, 'docs', dir, 'nav.json'))).toBe(false);
		}
	});
});

describe('designed states, not blank ones', () => {
	const spa = readFileSync(resolve(root, 'docs/index.html'), 'utf8');
	const main = readFileSync(resolve(root, 'src/docs-world/main.js'), 'utf8');
	const reader = readFileSync(resolve(root, 'src/docs-world/reader.js'), 'utf8');

	it('the classic sidebar explains a failed manifest instead of rendering empty', () => {
		// The manifest is a network fetch with a real failure mode, and an empty
		// sidebar reads as "this product has no docs" rather than "one request
		// failed". The failure must be named and recoverable.
		expect(spa).toContain('navError');
		expect(spa).toContain('Contents unavailable');
		expect(spa).toMatch(/retry\.addEventListener\('click'/);
		expect(spa).toContain('.sidebar-empty');
	});

	it('a search matching nothing says so and offers a way back', () => {
		expect(spa).toContain('No matches');
		expect(spa).toContain('Clear search');
	});

	it('an unknown deep-link slug does not open the reader on a missing doc', () => {
		// /docs/world#<stale-slug> used to open the reader on a doc that does not
		// exist, so entering the world greeted the visitor with a load error.
		expect(reader).toContain('hasPath(path)');
		expect(main).toContain('if (!overlays.hasPath(slug)) return;');
	});

	it('the world doc is reachable from the docs entry point', () => {
		const startHere = readFileSync(resolve(root, 'docs/start-here.md'), 'utf8');
		expect(startHere).toContain('](./docs-world.md)');
	});

	it('offers retry for recoverable boot failures but not for a GPU-less device', () => {
		// A dropped /docs/nav.json fetch, an exhausted WebGL context budget, and an
		// unexpected boot throw are all cleared by a reload, so each must hand the
		// visitor that action. isWebGLAvailable() failing is NOT: reloading cannot
		// grow the device a GPU, and a button that reproduces the same dead end
		// reads as a broken product rather than an honest limitation.
		const shell = readFileSync(resolve(root, 'pages/docs-world.html'), 'utf8');
		expect(shell).toContain('id="dw-fallback-retry"');

		// Three recoverable branches: manifest fetch, renderer construction, and
		// the boot catch-all. Each passes an options object, and every such call
		// opts into retry.
		// Lookbehind skips the `function showFallback({...})` declaration, which
		// otherwise counts as a fourth "call".
		const withOptions = (main.match(/(?<!function )showFallback\(\{/g) || []).length;
		const withRetry = (main.match(/retry: true/g) || []).length;
		expect(withOptions).toBe(3);
		expect(withRetry).toBe(withOptions);

		// The WebGL preflight branch calls showFallback with no argument, so it
		// defaults to retry:false.
		expect(main).toMatch(/if \(!isWebGLAvailable\(\)\) \{\s*showFallback\(\);/);
		expect(main).toContain('retry = false');
	});

	it('reveals the fallback before focusing it, so the retry is keyboard-reachable', () => {
		// focus() on a still-hidden element is a no-op, which would strand the
		// keyboard on <body> with the only recovery action unreachable.
		const revealIdx = main.indexOf("$('dw-fallback').hidden = false;");
		const focusIdx = main.indexOf('retryBtn.focus(');
		expect(revealIdx).toBeGreaterThan(-1);
		expect(focusIdx).toBeGreaterThan(revealIdx);
	});
});
