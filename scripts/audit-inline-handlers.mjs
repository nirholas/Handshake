#!/usr/bin/env node
// Fails when HTML in this repo carries something the site's CSP cannot allow.
//
// server/csp-hashes.mjs replaces `script-src 'unsafe-inline'` with the hashes
// of the inline scripts in each response. Hashes cover `<script>` blocks and
// nothing else: an inline event handler attribute (`onclick="..."`) or a
// `javascript:` URL still needs `'unsafe-inline'` (or `'unsafe-hashes'`, which
// is barely better), so any that survive would silently stop working in
// production. Most of ours are built inside template literals with interpolated
// values, which no hash can cover anyway.
//
// The fix is always the same shape: bind the behaviour with addEventListener
// (or a delegated listener keyed off a data-* attribute) instead of an
// attribute, and use a <button> or a real href instead of `javascript:`. For
// broken images specifically, public/inline-behaviors.js reads declarative
// `data-fallback*` attributes and is on every page, along with `data-action`
// and `data-stop-propagation` for the click cases.
//
// JavaScript is scanned too, and that half matters more: most of this site's
// markup is built from template literals, so an `onerror=` written inside a JS
// string never appears in any .html file. Those were invisible to an HTML-only
// scan and are exactly the ones that break silently in production, because a
// dev server without the header runs them fine.
//
// Usage:
//   node scripts/audit-inline-handlers.mjs            # repo sources
//   node scripts/audit-inline-handlers.mjs --dist     # built output too

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Roots that produce HTML the site actually serves. `character-studio` and
// `chat` build through their own toolchains into dist/ and are covered by
// --dist; scanning their sources would flag framework templates that never
// reach a served document in this form.
const SOURCE_ROOTS = ['pages', 'public', 'src'];
const DIST_ROOTS = ['dist'];

const SKIP_DIRS = new Set(['node_modules', '.git', 'assets', 'locales']);

// Third-party code we vendor rather than author. Rewriting an upstream editor's
// own markup would be re-forking it; those surfaces carry their own policy.
// Written without a leading root so each entry matches both the source tree and
// its copy under dist/.
const VENDOR_PATHS = [
	'scene-studio/vendor/',
	'scene-studio/libs/',
	'chat/assets/',
	'ibm/vendor/',
	'vendor/',
];

const isVendor = (rel) => VENDOR_PATHS.some((p) => rel.includes(`/${p}`) || rel.startsWith(p));

const SCANNED_EXTENSIONS = ['.html', '.js', '.jsx', '.mjs'];

// Attribute-position `on*` handlers. Anchored on a preceding `<`-tag context by
// requiring whitespace before the name and `=` after it, which keeps prose like
// "turn onload on" out of the results.
const HANDLER_RE = /\son([a-z]{3,20})\s*=\s*(["'])/gi;
const JS_URL_RE = /\b(href|src|action|formaction)\s*=\s*(["'])\s*javascript:/gi;

// `on` prefixes that are real DOM events. A data attribute like `only="x"`
// would otherwise match the shape.
const EVENT_NAMES = new Set([
	'abort', 'animationend', 'animationiteration', 'animationstart', 'auxclick',
	'beforeinput', 'beforeunload', 'blur', 'cancel', 'canplay', 'canplaythrough',
	'change', 'click', 'close', 'contextmenu', 'copy', 'cuechange', 'cut',
	'dblclick', 'drag', 'dragend', 'dragenter', 'dragleave', 'dragover',
	'dragstart', 'drop', 'durationchange', 'emptied', 'ended', 'error', 'focus',
	'focusin', 'focusout', 'formdata', 'fullscreenchange', 'gotpointercapture',
	'hashchange', 'input', 'invalid', 'keydown', 'keypress', 'keyup', 'load',
	'loadeddata', 'loadedmetadata', 'loadstart', 'lostpointercapture', 'message',
	'mousedown', 'mouseenter', 'mouseleave', 'mousemove', 'mouseout',
	'mouseover', 'mouseup', 'offline', 'online', 'paste', 'pause', 'play',
	'playing', 'pointercancel', 'pointerdown', 'pointerenter', 'pointerleave',
	'pointermove', 'pointerout', 'pointerover', 'pointerup', 'popstate',
	'progress', 'ratechange', 'reset', 'resize', 'scroll', 'scrollend', 'seeked',
	'seeking', 'select', 'slotchange', 'stalled', 'submit', 'suspend',
	'timeupdate', 'toggle', 'touchcancel', 'touchend', 'touchmove', 'touchstart',
	'transitionend', 'volumechange', 'waiting', 'wheel',
]);

function* walk(dir) {
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		const rel = path.relative(ROOT, full).split(path.sep).join('/');
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) continue;
			if (isVendor(`${rel}/`)) continue;
			yield* walk(full);
		} else if (SCANNED_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
			if (isVendor(rel)) continue;
			yield full;
		}
	}
}

function lineOf(text, index) {
	let line = 1;
	for (let i = 0; i < index; i++) if (text[i] === '\n') line++;
	return line;
}

function scan(file) {
	const text = readFileSync(file, 'utf8');
	const rel = path.relative(ROOT, file);
	const findings = [];
	for (const m of text.matchAll(HANDLER_RE)) {
		if (!EVENT_NAMES.has(m[1].toLowerCase())) continue;
		findings.push({ file: rel, line: lineOf(text, m.index), kind: 'inline event handler', snippet: text.slice(m.index, m.index + 90).replace(/\s+/g, ' ').trim() });
	}
	for (const m of text.matchAll(JS_URL_RE)) {
		findings.push({ file: rel, line: lineOf(text, m.index), kind: 'javascript: URL', snippet: text.slice(m.index, m.index + 90).replace(/\s+/g, ' ').trim() });
	}
	return findings;
}

const roots = process.argv.includes('--dist') ? [...SOURCE_ROOTS, ...DIST_ROOTS] : SOURCE_ROOTS;

const findings = [];
let scanned = 0;
for (const root of roots) {
	const abs = path.join(ROOT, root);
	try {
		if (!statSync(abs).isDirectory()) continue;
	} catch {
		continue;
	}
	for (const file of walk(abs)) {
		scanned++;
		findings.push(...scan(file));
	}
}

if (findings.length === 0) {
	console.log(`inline-handler audit: clean (${scanned} files, roots: ${roots.join(', ')})`);
	process.exit(0);
}

console.error(`inline-handler audit: ${findings.length} CSP-blocked construct(s) in ${scanned} files\n`);
for (const f of findings) {
	console.error(`  ${f.file}:${f.line}  ${f.kind}`);
	console.error(`    ${f.snippet}`);
}
console.error('\nThe site CSP has no \'unsafe-inline\' in script-src, so these will not run.');
console.error('Bind with addEventListener (delegate off a data-* attribute for generated markup);');
console.error('replace `javascript:` links with a <button> or a real href.');
process.exit(1);
