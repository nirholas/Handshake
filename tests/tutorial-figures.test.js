/**
 * Tutorial figures - the contract between the markdown, the capture pipeline
 * and the viewer.
 *
 * Figures are authored as ordinary markdown images with a `figure:` scheme
 * inside docs/tutorials/*.md and docs/cookbook/*.md. scripts/capture-tutorial-media.mjs
 * turns each one into real media (a Chromium screenshot of the deployed page, a
 * render from our own /api/render/glb, or an interactive model), and
 * public/tutorial-figures.js mounts them at read time.
 *
 * Three ways that contract silently breaks, all caught here:
 *   1. A directive is malformed, so the capture skips it and the reader gets a
 *      fallback card forever.
 *   2. A figure is captured, committed, then its markdown is edited away. The
 *      asset lingers and the manifest points at a figure nobody references.
 *   3. The manifest points at a file that is not in the tree, so production
 *      serves a 404 into a page that looked fine locally.
 *
 * These are file-system assertions on purpose. No browser, no network: this has
 * to be cheap enough to sit in `npm run test:gate`.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST_PATH = resolve(ROOT, 'public/tutorial-media.json');

// Kept in step with KINDS in scripts/capture-tutorial-media.mjs.
const KINDS = new Set(['page', 'glb', 'live', 'img']);
const FIGURE_RE = /!\[([^\]]*)\]\((figure:[^)\s]+)\)/g;

const COLLECTIONS = [
	{ name: 'tutorials', dir: resolve(ROOT, 'docs/tutorials') },
	{ name: 'cookbook', dir: resolve(ROOT, 'docs/cookbook') },
];

/** Every figure directive authored across every markdown collection. */
function collectDirectives() {
	const found = [];
	for (const collection of COLLECTIONS) {
		if (!existsSync(collection.dir)) continue;
		for (const file of readdirSync(collection.dir).filter((f) => f.endsWith('.md'))) {
			const md = readFileSync(resolve(collection.dir, file), 'utf8');
			for (const [, alt, raw] of md.matchAll(FIGURE_RE)) {
				found.push({ where: `${collection.name}/${file}`, alt, raw });
			}
		}
	}
	return found;
}

function parseDirective(raw) {
	const body = raw.slice('figure:'.length);
	const colon = body.indexOf(':');
	if (colon === -1) return null;
	const kind = body.slice(0, colon);
	const rest = body.slice(colon + 1);
	const q = rest.indexOf('?');
	return { kind, target: q === -1 ? rest : rest.slice(0, q) };
}

const directives = collectDirectives();
const manifest = existsSync(MANIFEST_PATH)
	? JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
	: null;

describe('figure directives in tutorial and cookbook markdown', () => {
	it('finds figures to check (the whole feature is gone if this hits zero)', () => {
		expect(directives.length).toBeGreaterThan(0);
	});

	it('every directive names a supported kind and a site-absolute target', () => {
		const bad = [];
		for (const d of directives) {
			const parsed = parseDirective(d.raw);
			if (!parsed) bad.push(`${d.where}: ${d.raw} has no kind`);
			else if (!KINDS.has(parsed.kind)) bad.push(`${d.where}: unknown kind "${parsed.kind}" in ${d.raw}`);
			else if (!parsed.target.startsWith('/')) bad.push(`${d.where}: target must start with / in ${d.raw}`);
		}
		expect(bad).toEqual([]);
	});

	it('every directive carries alt text, which becomes both the caption and the a11y label', () => {
		const missing = directives.filter((d) => !d.alt.trim()).map((d) => `${d.where}: ${d.raw}`);
		expect(missing).toEqual([]);
	});

	it('alt text is a real sentence, not a filename or a bare word', () => {
		const weak = directives
			.filter((d) => d.alt.trim().length < 25 || /^[\w-]+\.(png|jpe?g|webp|glb)$/i.test(d.alt.trim()))
			.map((d) => `${d.where}: "${d.alt}"`);
		expect(weak).toEqual([]);
	});
});

describe('captured media manifest', () => {
	it('exists, so the viewer never falls back for every figure at once', () => {
		expect(manifest, 'public/tutorial-media.json is missing. Run `npm run tutorials:media`.').not.toBeNull();
	});

	it('was captured against the public site, not somebody\'s laptop', () => {
		// A manifest captured from localhost records localhost `source` links,
		// which ship as dead click-throughs.
		expect(manifest.base).toMatch(/^https:\/\//);
	});

	it('holds a record for every non-live directive', () => {
		const missing = [];
		for (const d of directives) {
			const parsed = parseDirective(d.raw);
			if (!parsed || parsed.kind === 'live') continue;
			if (!manifest.figures[d.raw]) missing.push(`${d.where}: ${d.raw}`);
		}
		expect(missing, 'Run `npm run tutorials:media` to capture these.').toEqual([]);
	});

	it('points only at files that are actually in the tree', () => {
		const dead = [];
		for (const [raw, rec] of Object.entries(manifest.figures)) {
			if (!rec.src) continue;
			if (!existsSync(resolve(ROOT, 'public', rec.src.replace(/^\//, '')))) dead.push(`${raw} -> ${rec.src}`);
		}
		expect(dead, 'The manifest references media that is not committed; production would 404.').toEqual([]);
	});

	it('carries no record for a directive no markdown references any more', () => {
		const authored = new Set(directives.map((d) => d.raw));
		const orphans = Object.keys(manifest.figures).filter((raw) => !authored.has(raw));
		expect(orphans, 'Stale manifest entries. A full `npm run tutorials:media` prunes them.').toEqual([]);
	});

	it('records intrinsic dimensions and a placeholder on every image, so nothing shifts on load', () => {
		const bad = [];
		for (const [raw, rec] of Object.entries(manifest.figures)) {
			if (!rec.src) continue;
			if (!(rec.width > 0) || !(rec.height > 0)) bad.push(`${raw}: missing width/height`);
			if (!String(rec.placeholder || '').startsWith('data:image/')) bad.push(`${raw}: missing inline placeholder`);
		}
		expect(bad).toEqual([]);
	});
});
