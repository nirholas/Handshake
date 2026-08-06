#!/usr/bin/env node
// Guarantee the declarative inline-behaviour handlers on EVERY built HTML page.
// ===========================================================================
// public/inline-behaviors.js turns `data-fallback*`, `data-action` and
// `data-stop-propagation` attributes into behaviour. It exists because the site
// CSP allows inline <script> by hash and nothing else, which means the
// `onerror="..."` and `onclick="..."` attributes that used to do these jobs no
// longer run.
//
// Coverage has to be total, and for a reason the Atlas injector does not
// share: a page that renders an avatar grid from a template literal carries no
// hint that it needs this file, and the failure is invisible until a remote
// image 404s in front of a real visitor. So every page gets it, including the
// embed surfaces Atlas deliberately skips: an embedded avatar with a broken
// image is exactly the case this handles, and unlike stealing Cmd+K from a
// third-party page, a delegated error listener scoped to our own <img> tags
// takes nothing from the host.
//
// Only nav.html / footer.html are excluded. Those are fragments fetched and
// assigned through innerHTML, where a <script> tag does not execute and can
// render as visible text inside the nav.
//
// vite.config.js carries the matching `three-ws-inline-behaviors` transformIndexHtml
// plugin so dev servers behave the same. This post-build pass over dist/ is the
// belt to that suspenders, for the reason documented in inject-atlas.mjs: that
// hook has historically missed pages depending on plugin ordering. Idempotent;
// a second run is a no-op.

import { readdirSync, statSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';

const EXCLUDED = new Set(['nav.html', 'footer.html']);

export const INLINE_BEHAVIORS_TAG = '<script src="/inline-behaviors.js" defer></script>';
// Presence of the src is the marker: it survives attribute reordering by a
// later minifier, which matching the whole tag would not.
const MARKER = 'src="/inline-behaviors.js"';

export function shouldInject(filename) {
	return !EXCLUDED.has(basename(filename));
}

export function injectInto(html) {
	if (html.includes(MARKER)) return html;
	if (html.includes('</head>')) return html.replace('</head>', `${INLINE_BEHAVIORS_TAG}</head>`);
	if (html.includes('</body>')) return html.replace('</body>', `${INLINE_BEHAVIORS_TAG}</body>`);
	return html + INLINE_BEHAVIORS_TAG;
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
		console.error(`[inline-behaviors-inject] dist directory not found: ${distDir}`);
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
		`[inline-behaviors-inject] handler on ${covered}/${covered + skipped} pages ` +
			`(${injected} injected, ${already} already had it, ${skipped} fragment surfaces skipped)`,
	);

	if (covered === 0) {
		console.error('[inline-behaviors-inject] no pages were covered, which cannot be right');
		process.exit(1);
	}
}

// Importable for tests; only walks dist when run directly.
if (process.argv[1] && process.argv[1].endsWith('inject-inline-behaviors.mjs')) main();
