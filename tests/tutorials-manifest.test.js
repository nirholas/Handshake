/**
 * Tutorial library invariants.
 *
 * A tutorial is only real when three things agree: the markdown at
 * docs/tutorials/<slug>.md (the content), an entry in
 * public/tutorials-manifest.js (how anyone FINDS it), and a route that
 * renders it. The manifest is loaded as a classic script by both /tutorials
 * and /tutorials/<slug>, so a file with no entry is written, shipped, and
 * unreachable from navigation: it exists only for whoever already knows the
 * URL. That drift is invisible in review and has happened repeatedly, which is
 * why it is pinned here rather than left to a periodic sweep.
 *
 * The manifest is a browser script (an IIFE assigning window.TUTORIALS), not a
 * module, so it is evaluated in a tiny window shim instead of imported.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const root = resolve(__dirname, '..');

/** Evaluate the manifest IIFE the way a browser does and return window.TUTORIALS. */
function loadManifest() {
	const source = readFileSync(resolve(root, 'public/tutorials-manifest.js'), 'utf8');
	const win = {};
	new Function('window', source)(win);
	return win.TUTORIALS;
}

const TUTORIALS = loadManifest();
const TIERS = ['easy', 'middle', 'advanced'];

const markdownSlugs = readdirSync(resolve(root, 'docs/tutorials'))
	.filter((f) => f.endsWith('.md'))
	.map((f) => f.replace(/\.md$/, ''));

describe('tutorials manifest', () => {
	it('parses into a non-trivial list', () => {
		expect(Array.isArray(TUTORIALS)).toBe(true);
		expect(TUTORIALS.length).toBeGreaterThanOrEqual(50);
	});

	it('every entry carries the fields both templates render', () => {
		for (const t of TUTORIALS) {
			expect(typeof t.slug, JSON.stringify(t)).toBe('string');
			expect(t.slug).toMatch(/^[a-z0-9-]+$/);
			expect(TIERS, `${t.slug} tier`).toContain(t.tier);
			for (const field of ['title', 'blurb', 'builds', 'time']) {
				expect(typeof t[field], `${t.slug}.${field}`).toBe('string');
				expect(t[field].length, `${t.slug}.${field}`).toBeGreaterThan(0);
			}
			expect(typeof t.ctaPrimary?.label, `${t.slug}.ctaPrimary.label`).toBe('string');
			expect(typeof t.ctaPrimary?.href, `${t.slug}.ctaPrimary.href`).toBe('string');
		}
	});

	it('has no duplicate slugs', () => {
		const seen = new Set();
		const dupes = [];
		for (const t of TUTORIALS) {
			if (seen.has(t.slug)) dupes.push(t.slug);
			seen.add(t.slug);
		}
		// A duplicate renders the same card twice and makes the prev/next pager
		// in /tutorials/<slug> jump backwards.
		expect(dupes).toEqual([]);
	});
});

describe('manifest and markdown agree', () => {
	it('every manifest entry has the markdown its viewer fetches', () => {
		const missing = TUTORIALS.filter(
			(t) => !existsSync(resolve(root, 'docs/tutorials', `${t.slug}.md`)),
		).map((t) => t.slug);
		expect(missing, 'manifest entries with no docs/tutorials/<slug>.md').toEqual([]);
	});

	it('every tutorial markdown file is listed in the manifest', () => {
		const listed = new Set(TUTORIALS.map((t) => t.slug));
		const orphans = markdownSlugs.filter((slug) => !listed.has(slug));
		// An orphan is written, shipped, and unreachable: /tutorials never links
		// it and the pager skips it. Add a manifest entry when you add the file.
		expect(orphans, 'tutorials with no manifest entry (unreachable from /tutorials)').toEqual([]);
	});
});

describe('preview models and CTAs resolve', () => {
	it('every previewModel points at a GLB that ships', () => {
		const broken = TUTORIALS.filter((t) => t.previewModel).filter(
			(t) => !existsSync(resolve(root, 'public', t.previewModel.replace(/^\//, ''))),
		).map((t) => `${t.slug} -> ${t.previewModel}`);
		expect(broken, 'previewModel files missing from public/').toEqual([]);
	});

	it('every internal CTA href is a routable path, not a bare guess', () => {
		const routes = JSON.parse(readFileSync(resolve(root, 'vercel.json'), 'utf8')).routes;
		const pages = readFileSync(resolve(root, 'data/pages.json'), 'utf8');

		const routable = (href) => {
			const path = href.split(/[?#]/)[0].replace(/\/$/, '') || '/';
			if (pages.includes(`"${path}"`)) return true;
			// Docs pages are served by the docs SPA, not listed one by one.
			if (path.startsWith('/docs/')) {
				return existsSync(resolve(root, 'docs', `${path.slice('/docs/'.length)}.md`));
			}
			return routes.some((r) => {
				if (!r.src) return false;
				try {
					return new RegExp(`^${r.src}$`).test(path);
				} catch {
					return false;
				}
			});
		};

		const broken = TUTORIALS.map((t) => t.ctaPrimary)
			.filter((cta) => cta.href.startsWith('/'))
			.filter((cta) => !routable(cta.href))
			.map((cta) => cta.href);
		expect([...new Set(broken)], 'CTA hrefs that match no page or route').toEqual([]);
	});
});
