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
// attribute, and use a <button> or a real href instead of `javascript:`.
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
const SOURCE_ROOTS = ['pages', 'public'];
const DIST_ROOTS = ['dist'];

const SKIP_DIRS = new Set(['node_modules', '.git', 'assets', 'locales']);

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
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) continue;
			yield* walk(full);
		} else if (entry.name.endsWith('.html')) {
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
	console.log(`inline-handler audit: clean (${scanned} HTML files, roots: ${roots.join(', ')})`);
	process.exit(0);
}

console.error(`inline-handler audit: ${findings.length} CSP-blocked construct(s) in ${scanned} HTML files\n`);
for (const f of findings) {
	console.error(`  ${f.file}:${f.line}  ${f.kind}`);
	console.error(`    ${f.snippet}`);
}
console.error('\nThe site CSP has no \'unsafe-inline\' in script-src, so these will not run.');
console.error('Bind with addEventListener (delegate off a data-* attribute for generated markup);');
console.error('replace `javascript:` links with a <button> or a real href.');
process.exit(1);
