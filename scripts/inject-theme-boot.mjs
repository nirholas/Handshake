#!/usr/bin/env node
/* Insert the no-flash theme boot script as the FIRST thing inside <head> of
 * every real HTML page, so <html data-theme> is set before the browser paints
 * the first frame. Without this, a user who has chosen the light theme would
 * see a flash of the dark brand default while CSS/JS load.
 *
 * The script reads the shared preference (localStorage 'twx_theme', the same
 * key the dashboard Appearance setting and the nav toggle use), resolves 'auto'
 * against the OS scheme, and defaults to the brand dark when unset. The full
 * runtime (toggle wiring, persistence, cross-tab sync) lives in
 * public/theme-switcher.js. This is only the pre-paint apply.
 *
 * Skips embed/widget/badge/artifact/kiosk contexts (they render inside hosts
 * that own their own theming) and any document without a viewport meta.
 *
 * Idempotent: re-running does nothing if the boot script is already present.
 * Run with --write to apply; without it, reports what would change.
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOTS = [
	new URL('../pages/', import.meta.url).pathname,
	new URL('../public/', import.meta.url).pathname,
];

const MARKER = 'three.ws theme boot';
const BOOT =
	`<script>/* ${MARKER}: no-flash; runtime in /theme-switcher.js */` +
	`(function(){try{var m=localStorage.getItem('twx_theme');` +
	`var l=m==='auto'?(window.matchMedia&&window.matchMedia('(prefers-color-scheme: light)').matches):m==='light';` +
	`document.documentElement.setAttribute('data-theme',l?'light':'dark');}` +
	`catch(e){document.documentElement.setAttribute('data-theme','dark');}})();</script>`;

const SKIP_PATTERNS = [/embed/i, /widget/i, /badge/i, /artifact/i, /-kiosk/i];

function shouldSkip(filename) {
	return SKIP_PATTERNS.some((re) => re.test(filename));
}

function injectBoot(html) {
	if (html.includes(MARKER)) return { html, changed: false };
	// Insert immediately after the opening <head> tag so it runs before any
	// stylesheet in the head is applied to the first paint.
	const headOpen = html.match(/<head\b[^>]*>/i);
	if (!headOpen) return { html, changed: false };
	const at = headOpen.index + headOpen[0].length;
	const lineStart = html.lastIndexOf('\n', headOpen.index) + 1;
	const indent = html.slice(lineStart, headOpen.index).match(/^[\t ]*/)[0] + '\t';
	const insertion = `\n${indent}${BOOT}`;
	return { html: html.slice(0, at) + insertion + html.slice(at), changed: true };
}

const write = process.argv.includes('--write');
const stats = { changed: 0, alreadyHas: 0, skipped: 0, noViewport: 0 };

for (const dir of ROOTS) {
	let files;
	try {
		files = readdirSync(dir).filter((f) => f.endsWith('.html'));
	} catch {
		continue;
	}
	for (const file of files) {
		if (shouldSkip(file)) {
			stats.skipped += 1;
			continue;
		}
		const path = join(dir, file);
		const orig = readFileSync(path, 'utf8');
		if (!/<meta[^>]+name=["']viewport["']/i.test(orig)) {
			stats.noViewport += 1;
			continue;
		}
		const { html, changed } = injectBoot(orig);
		if (!changed) {
			stats.alreadyHas += 1;
			continue;
		}
		if (write) writeFileSync(path, html);
		stats.changed += 1;
		console.log(`  ${write ? '+' : '~'} ${file}`);
	}
}

console.log(
	`\ntheme boot: ${stats.changed} ${write ? 'updated' : 'would update'}, ` +
		`${stats.alreadyHas} already had it, ${stats.skipped} skipped (embed/widget), ` +
		`${stats.noViewport} no viewport`,
);
