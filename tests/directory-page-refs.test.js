// A page that routes is not a page that renders.
//
// Every public/<dir>/index.html is served at a CLEAN URL by a vercel.json route
// written `"/<dir>/?"`, which matches both `/<dir>` and `/<dir>/`. That single
// regex is the trap: on the slash-less URL the browser's base directory is the
// SITE ROOT, so a relative reference points somewhere the file isn't.
//
//   /spatial-mcp   + './spatial-renderer.js'  → GET /spatial-renderer.js  → 404
//   /agent-edit    + './edit.js'              → GET /edit.js              → 404
//   /cz            + './cz.css'               → GET /cz.css               → 404
//
// All three shipped that way. tests/pages-routes.test.js already proves a page is
// routed and built, and it passed for every one of them, because the route was
// never the problem: the page answered 200 and then loaded nothing. /spatial-mcp
// rendered two empty frames for its entire life. This test closes that gap
// statically, over every directory-served page, in milliseconds and with no
// browser (tests/e2e/spatial-mcp-render.spec.js covers the runtime half).
//
// Two rules, and the second one is why "just use an absolute path" is not the
// whole answer:
//
//   A. No relative src/href in the markup. Use '/<dir>/file.js'.
//   B. An INLINE module script must not import a file that lives inside public/.
//      Relative fails per rule A, and absolute fails in Vite dev, which refuses
//      it outright: "Cannot import non-asset file /spatial-mcp/spatial-renderer.js
//      which is inside /public. JS/CSS files inside /public are copied as-is on
//      build and can only be referenced via <script src>." Both doors are shut,
//      so the fix is a sibling module: <script type="module" src="/<dir>/x.js">.
//      A module's own relative imports resolve against the MODULE's URL, which
//      always carries the directory, so they are correct on either URL form.
//
// Imports that resolve OUTSIDE public/ (the common `/src/…` pattern on Vite-input
// pages) are fine and deliberately not flagged: Vite transforms and bundles those.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');

/** Directory-served pages: public/<dir>/index.html. */
const pages = readdirSync(PUBLIC, { withFileTypes: true })
	.filter((d) => d.isDirectory() && existsSync(path.join(PUBLIC, d.name, 'index.html')))
	.map((dir) => ({ dir, file: path.join(PUBLIC, dir.name, 'index.html') }))
	.map(({ dir, file }) => ({ name: dir.name, rel: `public/${dir.name}/index.html`, html: readFileSync(file, 'utf8') }));

/**
 * A reference is relative when it has no scheme, no protocol-relative prefix and
 * no leading slash. Fragments and bare queries stay on the current document, so
 * they are unaffected by the base directory.
 */
const isRelativeRef = (value) => !!value && !/^([a-z][a-z0-9+.-]*:|\/\/|\/|#|\?)/i.test(value.trim());

/** Strip inline <script> and <style> BODIES, keeping their open tags so a real
 *  `src`/`href` attribute is still checked. Without this, URLs built inside
 *  JavaScript template literals (`${origin}/x.js`) read as page markup. */
function markupOnly(html) {
	return html
		.replace(/(<script\b[^>]*>)[\s\S]*?(<\/script>)/gi, '$1$2')
		.replace(/(<style\b[^>]*>)[\s\S]*?(<\/style>)/gi, '$1$2');
}

/** Every src/href on an element that fetches a subresource. */
function subresourceRefs(html) {
	const refs = [];
	const pattern = /<(script|link|img|source|iframe)\b[^>]*?\b(src|href)\s*=\s*["']([^"']+)["']/gi;
	for (const m of markupOnly(html).matchAll(pattern)) {
		refs.push({ tag: m[1].toLowerCase(), attr: m[2].toLowerCase(), value: m[3] });
	}
	return refs;
}

/** Import specifiers inside inline <script type="module"> bodies. */
function inlineModuleImports(html) {
	const specifiers = [];
	for (const block of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
		const [, attrs = '', body = ''] = block;
		if (!/type\s*=\s*["']module["']/i.test(attrs)) continue;
		if (/\bsrc\s*=/i.test(attrs)) continue; // external module: has no inline body
		const patterns = [
			/\bimport\s+[^;'"]*?\bfrom\s*["']([^"']+)["']/g, // import x from '…'
			/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g, //        import('…')
			/\bimport\s*["']([^"']+)["']/g, //                  import '…'
		];
		for (const pattern of patterns) for (const m of body.matchAll(pattern)) specifiers.push(m[1]);
	}
	return specifiers;
}

/** Resolve an import specifier to a repo path, or null when it is not local. */
function resolveLocal(specifier, pageDir) {
	if (/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(specifier)) return null; // bare/CDN/npm
	if (specifier.startsWith('/')) return path.join(ROOT, 'public', specifier.slice(1));
	if (specifier.startsWith('.')) return path.resolve(PUBLIC, pageDir, specifier);
	return null; // bare package specifier
}

describe('directory-served public pages', () => {
	it('has pages to check', () => {
		expect(pages.length).toBeGreaterThan(10);
	});

	describe.each(pages)('$rel', ({ name, html }) => {
		// Rule A — a relative subresource ref breaks on the slash-less clean URL.
		it('references every subresource absolutely', () => {
			const relative = subresourceRefs(html)
				.filter((r) => isRelativeRef(r.value))
				.map((r) => `<${r.tag} ${r.attr}="${r.value}"> → use "/${name}/${r.value.replace(/^\.\//, '')}"`);
			expect(relative).toEqual([]);
		});

		// Rule B — an inline module cannot import a file inside public/ by either
		// form, so it must be a sibling module referenced with <script src>.
		it('never inline-imports a module from inside public/', () => {
			const offenders = inlineModuleImports(html)
				.map((specifier) => ({ specifier, target: resolveLocal(specifier, name) }))
				.filter(({ target }) => target && target.startsWith(PUBLIC + path.sep) && existsSync(target))
				.map(({ specifier }) => `import '${specifier}' → move this script to /${name}/<file>.js and load it with <script type="module" src>`);
			expect(offenders).toEqual([]);
		});
	});
});
