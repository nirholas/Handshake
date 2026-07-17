#!/usr/bin/env node
// i18n-annotate — automatically annotate static HTML copy for translation.
//
// The i18n pipeline (docs/i18n.md) derives its source catalog from `data-i18n*`
// attributes in the markup. Hand-adding those to 200+ pages is the bottleneck
// that kept only the home hero translated. This tool closes that gap: it finds
// user-visible static copy, injects the right annotation attribute with a
// stable, human-readable key, and (optionally) wires the runtime script +
// <lang-switcher> into the page — so `npm run i18n:extract && npm run
// i18n:translate` then localize the whole page across every committed locale.
//
// Design guarantees that make auto-annotating hand-authored HTML safe:
//   • Surgical, byte-precise edits. We parse to LOCATE elements (node-html-parser
//     exposes source `.range` offsets), then splice ` data-i18n="…"` into the
//     original string. Untouched bytes are preserved exactly — no whole-file
//     reserialization, so diffs are minimal and reviewable.
//   • Idempotent. An element that already carries a data-i18n* attribute is left
//     alone, so re-runs only pick up newly-added copy.
//   • Conservative. Only leaf copy elements with real letters are touched;
//     script/style/svg/pre/code/template/textarea, dynamic `{{…}}`/`${…}` copy,
//     [translate="no"]/[data-no-i18n] opt-outs, and anything nested inside an
//     element we already annotated are all skipped.
//
// Usage:
//   node scripts/i18n-annotate.mjs --pages="pages/home.html"        # dry-run, one file
//   node scripts/i18n-annotate.mjs --pages="pages/home.html" --apply
//   node scripts/i18n-annotate.mjs --pages="pages/{about,pricing}.html" --apply
//   node scripts/i18n-annotate.mjs --apply                          # every htmlExtract entry
//   node scripts/i18n-annotate.mjs --pages="pages/home.html" --diff # show a unified-ish preview
//
// Flags: --apply (write; default is dry-run), --diff (print sample edits),
//        --wire (also inject /i18n.js + <lang-switcher> if missing; implied by
//        --apply unless --no-wire), --limit=N (cap files), --max=N (cap edits/file).

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, relative, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { glob } from 'glob';
import { parse } from 'node-html-parser';
import { ROOT, loadConfig } from './lib/i18n-shared.mjs';

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n) => {
	const hit = args.find((a) => a.startsWith(`--${n}=`));
	return hit ? hit.split('=').slice(1).join('=') : undefined;
};

const collapse = (s) => (s || '').replace(/\s+/g, ' ').trim();

// Tags whose text is user-visible copy worth translating. Block-level containers
// (div/section/ul/…) are deliberately absent: we annotate their leaf children,
// never the container, so one key never swallows a whole subtree.
const COPY_TAGS = new Set([
	'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
	'p', 'li', 'a', 'button', 'label', 'summary', 'figcaption', 'blockquote',
	'th', 'td', 'dt', 'dd', 'caption', 'legend', 'option', 'span', 'strong',
	'em', 'small', 'b', 'i', 'q', 'cite', 'mark',
]);

// Inline formatting tags allowed *inside* a translated element — the value is
// stored as innerHTML (data-i18n-html) so the markup round-trips. A child tag
// outside this set means the element is a layout container, not a copy leaf.
const INLINE_TAGS = new Set([
	'strong', 'em', 'b', 'i', 'span', 'br', 'a', 'small', 'sub', 'sup', 'code',
	'u', 'mark', 'abbr', 'q', 'cite', 'time', 'wbr', 'kbd', 'samp', 'bdi', 'bdo',
]);

// Never descend into these — their text is code, not copy.
const OPAQUE_ANCESTORS = new Set([
	'script', 'style', 'svg', 'pre', 'code', 'textarea', 'template', 'noscript', 'math',
]);

const hasLetter = (s) => /\p{L}/u.test(s);
const isDynamic = (s) => /\{\{|\}\}|\$\{|<%|%>|::before|::after/.test(s);

// Attributes that carry visible copy and should be translated in place.
const COPY_ATTRS = ['aria-label', 'placeholder', 'title', 'alt'];

function slugify(text, max = 44) {
	const base = collapse(text)
		.toLowerCase()
		.replace(/<[^>]+>/g, ' ')
		.replace(/&[a-z]+;/g, ' ')
		.replace(/[^a-z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '');
	const words = base.split('_').filter(Boolean).slice(0, 7).join('_');
	return (words || 'text').slice(0, max).replace(/_+$/g, '');
}

function pageKey(file) {
	return basename(file)
		.replace(/\.html?$/i, '')
		.replace(/[^a-z0-9]+/gi, '_')
		.replace(/^_+|_+$/g, '')
		.toLowerCase() || 'page';
}

// Find the index just before the `>` (or `/>`) that closes the opening tag that
// starts at `start` (`html[start]` is `<`). Quote-aware so a `>` inside an
// attribute value never ends the tag early.
function openTagInsertPos(html, start) {
	let i = start + 1;
	let quote = null;
	for (; i < html.length; i++) {
		const c = html[i];
		if (quote) {
			if (c === quote) quote = null;
			continue;
		}
		if (c === '"' || c === "'") quote = c;
		else if (c === '>') {
			// Self-closing `/>`: insert before the slash.
			return html[i - 1] === '/' ? i - 1 : i;
		}
	}
	return -1;
}

// Is `el` itself, or any ancestor, opaque (script/style/svg/…) or opted out via
// translate="no" / data-no-i18n? Walks from the element upward so a leaf that
// carries the opt-out is skipped too, not just its descendants.
function inSkippedSubtree(el) {
	for (let p = el; p && p.rawTagName !== undefined; p = p.parentNode) {
		const tag = (p.rawTagName || '').toLowerCase();
		if (OPAQUE_ANCESTORS.has(tag)) return true;
		if (p.getAttribute && (p.getAttribute('translate') === 'no' || p.hasAttribute?.('data-no-i18n')))
			return true;
	}
	return false;
}

function alreadyAnnotated(el) {
	return (
		el.hasAttribute('data-i18n') ||
		el.hasAttribute('data-i18n-html') ||
		el.hasAttribute('data-i18n-attr')
	);
}

// True when a descendant already carries an annotation — that descendant is the
// translation unit, so wrapping it here would double-annotate and capture the
// child's data-i18n* attribute into this element's innerHTML.
function wrapsAnnotated(el) {
	return Boolean(
		el.querySelector('[data-i18n], [data-i18n-html], [data-i18n-attr]'),
	);
}

// Classify a copy element: 'text' (pure text), 'html' (text + inline markup),
// or null (layout container / not a leaf / not worth translating).
function classify(el) {
	if (wrapsAnnotated(el)) return null; // a descendant is already the translation unit
	const childEls = el.childNodes.filter((n) => n.nodeType === 1);
	for (const c of childEls) {
		const tag = (c.rawTagName || '').toLowerCase();
		if (!INLINE_TAGS.has(tag)) return null; // block child → container, skip
	}
	const text = collapse(el.text);
	if (!text || !hasLetter(text)) return null;
	if (isDynamic(el.innerHTML)) return null;
	if (text.length > 600) return null; // paragraph-sized cap; giant blobs are usually generated
	return childEls.length ? 'html' : 'text';
}

// Build the ordered list of surgical edits for one document. Pure: returns
// { edits, keys } without touching the filesystem, so it is unit-testable.
export function planAnnotations(html, file, { seenKeys = new Set() } = {}) {
	const root = parse(html, {
		comment: false,
		blockTextElements: { script: false, style: false, noscript: false, pre: false, code: false, textarea: false },
	});
	const pk = pageKey(file);
	const edits = []; // { pos, insert }
	const keys = new Map(); // key → source value (for reporting)
	const localKeys = new Set(seenKeys);
	const annotatedRanges = []; // [start,end] of elements we chose, to skip descendants

	const uniqueKey = (slug) => {
		let key = `${pk}.${slug}`;
		let n = 2;
		while (localKeys.has(key)) key = `${pk}.${slug}_${n++}`;
		localKeys.add(key);
		return key;
	};

	const isInsideChosen = (r) =>
		r && annotatedRanges.some(([s, e]) => r[0] >= s && r[1] <= e);

	// Document order matters: a container leaf (e.g. <li>) is visited before its
	// inline children (<strong>), so choosing the outer element first lets the
	// containment check skip the inner one.
	const all = root.querySelectorAll('*');

	// --- head copy: <title>, meta description / og / twitter -----------------
	for (const el of all) {
		const tag = (el.rawTagName || '').toLowerCase();
		if (tag === 'title' && !alreadyAnnotated(el)) {
			const v = collapse(el.text);
			if (v && hasLetter(v) && !isDynamic(v)) {
				const key = uniqueKey('meta_title');
				const pos = openTagInsertPos(html, el.range[0]);
				if (pos !== -1) {
					edits.push({ pos, insert: ` data-i18n="${key}"`, key, value: v });
					keys.set(key, v);
				}
			}
		}
		if (tag === 'meta') {
			const name = (el.getAttribute('name') || el.getAttribute('property') || '').toLowerCase();
			const content = el.getAttribute('content');
			const TRANSLATABLE_META = new Set([
				'description', 'og:title', 'og:description', 'twitter:title', 'twitter:description',
			]);
			if (TRANSLATABLE_META.has(name) && content && hasLetter(content) && !isDynamic(content) && !alreadyAnnotated(el)) {
				const key = uniqueKey(`meta_${name.replace(/[^a-z0-9]+/g, '_')}`);
				const pos = openTagInsertPos(html, el.range[0]);
				if (pos !== -1) {
					edits.push({ pos, insert: ` data-i18n-attr="content:${key}"`, key, value: collapse(content) });
					keys.set(key, collapse(content));
				}
			}
		}
	}

	// --- body copy -----------------------------------------------------------
	for (const el of all) {
		const tag = (el.rawTagName || '').toLowerCase();
		if (!COPY_TAGS.has(tag)) continue;
		if (alreadyAnnotated(el)) {
			annotatedRanges.push(el.range); // treat pre-annotated as chosen so we skip its children
			continue;
		}
		if (inSkippedSubtree(el)) continue;
		if (isInsideChosen(el.range)) continue;

		const kind = classify(el);

		// Even when the text itself isn't translatable, the element may carry a
		// translatable copy attribute (aria-label on an icon button, etc.).
		const attrPairs = [];
		for (const a of COPY_ATTRS) {
			const val = el.getAttribute(a);
			if (val && hasLetter(val) && !isDynamic(val) && collapse(val).length <= 300) {
				attrPairs.push([a, collapse(val)]);
			}
		}

		if (!kind && !attrPairs.length) continue;

		const parts = [];
		if (kind) {
			const value = kind === 'html' ? collapse(el.innerHTML) : collapse(el.text);
			const key = uniqueKey(slugify(el.text));
			parts.push(kind === 'html' ? `data-i18n-html="${key}"` : `data-i18n="${key}"`);
			keys.set(key, value);
		}
		if (attrPairs.length) {
			const spec = attrPairs
				.map(([a, v]) => {
					const key = uniqueKey(`${slugify(v, 28)}_${a.replace(/[^a-z0-9]+/g, '')}`);
					keys.set(key, v);
					return `${a}:${key}`;
				})
				.join(';');
			parts.push(`data-i18n-attr="${spec}"`);
		}

		const pos = openTagInsertPos(html, el.range[0]);
		if (pos === -1) continue;
		edits.push({ pos, insert: ' ' + parts.join(' '), keys: [...keys.keys()] });
		annotatedRanges.push(el.range);
	}

	return { edits, keys };
}

// Apply edits to the original string, last position first so earlier offsets
// stay valid.
export function applyEdits(html, edits) {
	const sorted = [...edits].sort((a, b) => b.pos - a.pos);
	let out = html;
	for (const e of sorted) out = out.slice(0, e.pos) + e.insert + out.slice(e.pos);
	return out;
}

// Ensure the runtime script + a language switcher are present so the annotated
// copy actually swaps. Both inserts are idempotent and string-surgical.
function wireRuntime(html) {
	let out = html;
	let changed = false;
	if (!/\/i18n\.js|\/src\/i18n\.js/.test(out) && /<\/body>/i.test(out)) {
		out = out.replace(
			/<\/body>/i,
			'\t<!-- Runtime i18n: detects locale, swaps annotated copy, mounts <lang-switcher>. -->\n\t<script type="module" src="/i18n.js"></script>\n</body>',
		);
		changed = true;
	}
	return { html: out, changed };
}

async function main() {
	const cfg = loadConfig();
	const patterns = opt('pages')
		? [opt('pages')]
		: cfg.htmlExtract?.entry || ['pages/**/*.html', 'public/**/*.html'];
	const ignore = cfg.htmlExtract?.exclude || [];
	let files = (await glob(patterns, { cwd: ROOT, ignore, absolute: true, nodir: true })).sort();
	const limit = Number(opt('limit') || 0);
	if (limit > 0) files = files.slice(0, limit);

	const APPLY = flag('apply');
	const DIFF = flag('diff');
	const WIRE = flag('wire') || (APPLY && !flag('no-wire'));
	const maxPerFile = Number(opt('max') || 0);

	let totalEdits = 0;
	let filesChanged = 0;
	const globalKeys = new Set();

	for (const file of files) {
		const rel = relative(ROOT, file);
		let html;
		try {
			html = readFileSync(file, 'utf8');
		} catch (err) {
			console.warn(`! ${rel}: ${err.message}`);
			continue;
		}
		let { edits, keys } = planAnnotations(html, file, { seenKeys: globalKeys });
		if (maxPerFile > 0) edits = edits.slice(0, maxPerFile);
		for (const k of keys.keys()) globalKeys.add(k);

		if (!edits.length) {
			console.log(`• ${rel}: nothing to annotate`);
			continue;
		}

		totalEdits += edits.length;
		filesChanged++;
		console.log(`${APPLY ? '✎' : '○'} ${rel}: ${edits.length} annotation(s)`);
		if (DIFF || !APPLY) {
			for (const [key, val] of [...keys].slice(0, 8)) {
				console.log(`    ${key}  ←  ${JSON.stringify(val.slice(0, 72))}`);
			}
			if (keys.size > 8) console.log(`    … +${keys.size - 8} more`);
		}

		if (APPLY) {
			let out = applyEdits(html, edits);
			if (WIRE) {
				const wired = wireRuntime(out);
				out = wired.html;
				if (wired.changed) console.log(`    + wired /i18n.js runtime`);
			}
			writeFileSync(file, out);
		}
	}

	console.log(
		`\ni18n-annotate: ${totalEdits} annotation(s) across ${filesChanged} file(s)` +
			(APPLY ? ' (written)' : ' (dry-run — pass --apply to write)'),
	);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((err) => {
		console.error(err);
		process.exit(1);
	});
}
