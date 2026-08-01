#!/usr/bin/env node
// Guarantee the Atlas command palette on EVERY built HTML page.
// ============================================================
// Atlas (public/atlas.js) is a global shortcut: Cmd+K has to open it on
// whichever page the visitor happens to be on, or it is not a global shortcut,
// it is a feature of one page. There are 250+ standalone HTML entry points in
// this repo written across several generations of the codebase, with no shared
// layout to hang it off.
//
// vite.config.js carries a `three-ws-atlas` transformIndexHtml plugin that adds
// the tag during dev and build. This script is the belt to that suspenders, for
// the exact reason documented in inject-tour-boot.mjs: that hook has historically
// missed roughly half the built pages depending on plugin ordering, and a
// keyboard shortcut that works on a coin flip is worse than one that does not
// exist. Running as a separate post-build pass over dist/ makes coverage a fact
// we can assert instead of a hope. Idempotent; a second run is a no-op.
//
// Surfaces that must NOT get it:
//   embeds/widgets  render inside third-party pages, and stealing Cmd+K
//                    from someone else's site is hostile. atlas.js also refuses
//                    to run in a frame at runtime, so this is defense in depth.
//   fragments       are nav.html / footer.html, fetched and assigned via
//                    innerHTML. A script tag injected into a fragment is
//                    interleaved with Vite's own tags and renders as visible
//                    text inside the nav.

import { readdirSync, statSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';

const EXCLUDED = new Set([
	'widget.html',
	'embed.html',
	'avatar-embed.html',
	'agent-embed.html',
	'a-embed.html',
	'agent-token-page.html',
	'nav.html',
	'footer.html',
]);

export const ATLAS_TAG = '<script type="module" src="/atlas.js"></script>';
// Presence of the src is the marker: it survives attribute reordering by any
// later minifier, which matching the whole tag would not.
const MARKER = 'src="/atlas.js"';

export function shouldInject(filename) {
	return !EXCLUDED.has(basename(filename));
}

export function injectInto(html) {
	if (html.includes(MARKER)) return html;
	if (html.includes('</body>')) return html.replace('</body>', `${ATLAS_TAG}</body>`);
	if (html.includes('</head>')) return html.replace('</head>', `${ATLAS_TAG}</head>`);
	return html + ATLAS_TAG;
}

function walk(dir, out = []) {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		const st = statSync(p);
		if (st.isDirectory()) walk(p, out);
		else if (name.endsWith('.html')) out.push(p);
	}
	return out;
}

function main() {
	const distDir = process.argv[2] || 'dist';
	if (!existsSync(distDir)) {
		console.error(`[atlas-inject] dist directory not found: ${distDir}`);
		process.exit(2);
	}

	let injected = 0;
	let already = 0;
	let skipped = 0;

	for (const file of walk(distDir)) {
		if (!shouldInject(file)) {
			skipped++;
			continue;
		}
		const html = readFileSync(file, 'utf8');
		if (html.includes(MARKER)) {
			already++;
			continue;
		}
		writeFileSync(file, injectInto(html));
		injected++;
	}

	const covered = injected + already;
	console.log(
		`[atlas-inject] palette on ${covered}/${covered + skipped} pages ` +
			`(${injected} injected, ${already} already had it, ${skipped} embed/fragment surfaces skipped)`,
	);

	// A build that covers nothing means the walk found no pages, which is a
	// broken build rather than a clean no-op. Fail loudly.
	if (covered === 0) {
		console.error('[atlas-inject] no pages were covered, which cannot be right');
		process.exit(1);
	}
}

// Importable for tests; only walks dist when run directly.
if (process.argv[1] && process.argv[1].endsWith('inject-atlas.mjs')) main();
