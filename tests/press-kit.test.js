/**
 * /press is a page whose entire job is handing files to strangers, so the thing
 * that breaks it is not a rendering bug: it is a download button pointing at a
 * file that moved, or a size printed next to a link that no longer matches the
 * bytes behind it. Those fail silently in a browser and embarrassingly in front
 * of a journalist, so they are asserted here.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');
const PAGE = join(ROOT, 'pages/press/index.html');
const html = readFileSync(PAGE, 'utf8');

/** Every same-origin asset reference on the page: src="/…" and href="/…" to a file. */
function assetRefs() {
	const refs = new Set();
	for (const m of html.matchAll(/(?:src|href)="(\/[^"#?]+\.[a-z0-9]+)"/gi)) refs.add(m[1]);
	return [...refs];
}

/** Static files ship from public/; app modules like /i18n.js are bundled out of src/. */
function resolves(ref) {
	const rel = ref.slice(1);
	return existsSync(join(PUBLIC, rel)) || existsSync(join(ROOT, 'src', rel));
}

describe('/press asset references', () => {
	it('resolves every file the page links or embeds', () => {
		const missing = assetRefs().filter((ref) => !resolves(ref));
		expect(missing, `unresolved: ${missing.join(', ')}`).toEqual([]);
	});

	it('offers every rendered brand asset for download', () => {
		const expected = [
			'three-ws-mark.png',
			'three-ws-lockup-on-dark.png',
			'three-ws-lockup-on-light.png',
			'three-ws-stacked-on-dark.png',
			'three-ws-stacked-on-light.png',
		];
		for (const file of expected) {
			expect(existsSync(join(PUBLIC, 'brand', file)), `public/brand/${file} not rendered`).toBe(true);
			expect(html, `${file} is rendered but not offered on /press`).toContain(`/brand/${file}`);
		}
	});

	it('keeps the OpenAI announcement graphics wired', () => {
		for (const file of ['social-card-announcement.png', 'social-card-studio.png']) {
			expect(existsSync(join(PUBLIC, 'partners/openai', file))).toBe(true);
			expect(html).toContain(`/partners/openai/${file}`);
		}
	});
});

describe('press kit archive', () => {
	const zipPath = join(PUBLIC, 'brand/three-ws-press-kit.zip');

	it('exists and carries the marks, the OpenAI graphics, and the usage rules', async () => {
		expect(existsSync(zipPath)).toBe(true);
		const zip = await JSZip.loadAsync(readFileSync(zipPath));
		const names = Object.keys(zip.files);
		expect(names).toContain('README.txt');
		expect(names.some((n) => n.startsWith('marks/'))).toBe(true);
		expect(names.some((n) => n.startsWith('openai/'))).toBe(true);

		const readme = await zip.file('README.txt').async('string');
		// The rules have to travel with the files; a bare folder of PNGs is how a
		// mark ends up recoloured in someone else's deck.
		expect(readme).toMatch(/Using the marks/);
		expect(readme).toMatch(/partnerships@three\.ws/);
	});

	it('quotes its real size on the page', () => {
		const quoted = html.match(/<span data-zip-size>([\d.]+) MB<\/span>/);
		expect(quoted, 'the zip size span is missing from /press').not.toBeNull();
		const actual = statSync(zipPath).size / 1024 / 1024;
		// render-brand-assets.mjs writes this back on every build; a drift bigger
		// than a rounding step means someone edited an asset without re-running it.
		expect(Math.abs(Number(quoted[1]) - actual)).toBeLessThan(0.1);
	});
});
