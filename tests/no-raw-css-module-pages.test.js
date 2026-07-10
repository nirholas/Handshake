// A page must never ship a raw `/src/*.js` module whose graph imports a `.css` file.
//
// `import './ui-juice.css'` is a Vite-only construct: the bundler extracts it into a
// <link>. When a page is NOT registered as a Vite rollup input, its HTML is copied
// verbatim and the browser fetches `/src/entry.js` unbundled. The browser then tries
// to load the CSS as a module script, the server answers `text/css`, and strict MIME
// checking rejects it:
//
//   Failed to load module script: Expected a JavaScript-or-Wasm module script but the
//   server responded with a MIME type of "text/css".
//
// That aborts the entry module, so nothing on the page renders. `/characters` and
// `/character/:id` shipped that way in production — both rendered an empty grid.
// The fix is to register the page in vite.config.js `rollupOptions.input` (plus the
// `promote-bundled-public-html` pair), exactly as `login`/`register` already are.
//
// This test walks the source pages rather than `dist/`, so it fails fast in CI on a
// plain `npm test` without requiring a build first.

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';

const root = resolve(__dirname, '..');

function htmlFiles(dir, out = []) {
	if (!existsSync(dir)) return out;
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (name === 'node_modules') continue;
		const st = statSync(p);
		if (st.isDirectory()) htmlFiles(p, out);
		else if (name.endsWith('.html')) out.push(p);
	}
	return out;
}

// Follow relative .js imports from an entry and report any .css import in the graph.
function cssInGraph(entryRel, seen = new Set()) {
	const abs = resolve(root, entryRel.replace(/^\//, ''));
	if (seen.has(abs) || !existsSync(abs)) return [];
	seen.add(abs);
	const src = readFileSync(abs, 'utf8');
	const found = [];
	for (const m of src.matchAll(/import\s+["']([^"']+\.css)["']/g)) found.push(`${entryRel} → ${m[1]}`);
	for (const m of src.matchAll(/from\s+["'](\.\/[^"']+\.js)["']/g)) {
		found.push(...cssInGraph(join(dirname(entryRel), m[1]), seen));
	}
	return found;
}

// Pages registered here are bundled by Vite, so a CSS import in their graph is fine.
function bundledInputs() {
	const cfg = readFileSync(resolve(root, 'vite.config.js'), 'utf8');
	const inputs = new Set();
	for (const m of cfg.matchAll(/resolve\(__dirname,\s*'((?:public|pages)\/[^']+\.html)'\)/g)) inputs.add(m[1]);
	return inputs;
}

describe('no page ships a raw /src module that imports CSS', () => {
	it('every public/ page with a CSS-importing entry is a Vite rollup input', () => {
		const bundled = bundledInputs();
		const offenders = [];

		for (const file of htmlFiles(resolve(root, 'public'))) {
			const rel = file.slice(root.length + 1);
			const html = readFileSync(file, 'utf8');
			for (const m of html.matchAll(/<script[^>]*type="module"[^>]*src="(\/src\/[^"]+)"/g)) {
				const css = cssInGraph(m[1]);
				if (css.length && !bundled.has(rel)) {
					offenders.push(`${rel} loads ${m[1]} which imports CSS (${css[0]}) but is not a Vite input`);
				}
			}
		}

		expect(
			offenders,
			`Register these in vite.config.js rollupOptions.input + the promote-bundled-public-html pairs:\n${offenders.join('\n')}`,
		).toEqual([]);
	});

	it('characters + character stay registered (they regressed once)', () => {
		const bundled = bundledInputs();
		expect(bundled.has('public/characters.html')).toBe(true);
		expect(bundled.has('public/character.html')).toBe(true);
	});

	it('a bundled page is promoted out of dist/public/ into its serving path', () => {
		const cfg = readFileSync(resolve(root, 'vite.config.js'), 'utf8');
		expect(cfg).toContain("['dist/public/characters.html', 'dist/characters.html']");
		expect(cfg).toContain("['dist/public/character.html', 'dist/character.html']");
	});
});
