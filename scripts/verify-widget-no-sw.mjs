// Post-build verification: confirm dist/widget.html (and other embed entries)
// don't carry the VitePWA service-worker registration script. Without this
// stripping, third-party iframes that load /widget would register a SW under
// our origin and intercept requests across every other page on three.ws —
// a privacy + correctness hazard for embedders.
//
//   node scripts/verify-widget-no-sw.mjs
//
// Exits non-zero on the first leak. CI wires this after `vite build`.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DIST = join(process.cwd(), 'dist');

// Source-relative names mirrored from the strip-sw plugin in vite.config.js.
// Add new embed entries here and in the plugin's EMBED_ENTRIES Set together.
const EMBED_ENTRIES = ['widget', 'embed', 'avatar-embed', 'agent-embed', 'a-embed'];

const REGISTER_SW_RE = /id=["']vite-plugin-pwa:register-sw["']/;

// Vite emits page HTMLs under one of:
//   dist/<name>.html
//   dist/pages/<name>.html  (when source lives in /pages/)
function candidatePaths(name) {
	return [join(DIST, `${name}.html`), join(DIST, 'pages', `${name}.html`)];
}

const leaks = [];
const checked = [];
for (const entry of EMBED_ENTRIES) {
	const paths = candidatePaths(entry);
	let found = false;
	for (const p of paths) {
		if (!existsSync(p)) continue;
		found = true;
		const html = readFileSync(p, 'utf8');
		checked.push(p);
		if (REGISTER_SW_RE.test(html)) {
			leaks.push(p);
			console.error(`✗ SW registration script present in ${p}`);
		} else {
			console.log(`✓ ${p}`);
		}
	}
	if (!found) {
		console.warn(`! ${entry} not found in dist/ — skipped (may be unused or a Vercel-only static page).`);
	}
}

if (leaks.length) {
	console.error(`\n✗ ${leaks.length} embed page(s) still ship registerSW — fix the strip-sw transformIndexHtml plugin in vite.config.js.`);
	process.exit(1);
}

if (!checked.length) {
	console.error('✗ no embed pages found in dist/ — did `vite build` run?');
	process.exit(2);
}

console.log(`\n✓ ${checked.length}/${checked.length} embed page(s) have no SW registration script.`);
