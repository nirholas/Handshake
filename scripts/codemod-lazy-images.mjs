#!/usr/bin/env node
/**
 * codemod-lazy-images.mjs — add `loading="lazy" decoding="async"` to the
 * JS-rendered <img> tags that lack them.
 *
 * Scope: src/ only. These are remote thumbnail / avatar / coin images injected
 * into lists, grids, modals and sidebars — off-fold content that should defer
 * its network fetch and decode off the main thread. Static-HTML <img> tags are
 * deliberately NOT touched: those are mostly above-the-fold logos/wordmarks
 * (the LCP image) where lazy-loading would HURT perceived load.
 *
 * Idempotent: skips any tag that already declares `loading=`. Prints every edit.
 *
 *   node scripts/codemod-lazy-images.mjs           # apply
 *   node scripts/codemod-lazy-images.mjs --dry-run # preview only
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { commentRanges, isInsideComment } from './lib/js-comment-ranges.mjs';

const dryRun = process.argv.includes('--dry-run');
const files = execSync('grep -rlE "<img\\b" src/', { encoding: 'utf8' })
	.trim()
	.split('\n')
	.filter(Boolean);

let totalEdits = 0;
const touched = [];

for (const file of files) {
	const src = readFileSync(file, 'utf8');
	let edits = 0;
	// Match a REAL <img tag: `<img` + whitespace + an attribute name (a letter).
	// Matches inside comments are left alone: prose that quotes a tag, such as
	// an XSS note about `<img onerror=…>`, renders nothing, and rewriting it
	// would corrupt the explanation. Skip any tag that already declares
	// loading=. We insert the two attributes immediately after `<img`,
	// preserving the original whitespace and all existing attributes verbatim.
	const comments = commentRanges(src);
	const out = src.replace(/<img(?![^>]*\bloading=)(\s+[a-zA-Z])/g, (m, next, offset) => {
		if (isInsideComment(comments, offset)) return m;
		edits++;
		return `<img loading="lazy" decoding="async"${next}`;
	});
	if (edits > 0) {
		totalEdits += edits;
		touched.push(`${edits.toString().padStart(3)}  ${file}`);
		if (!dryRun) writeFileSync(file, out);
	}
}

console.log(touched.sort((a, b) => parseInt(b) - parseInt(a)).join('\n'));
console.log(`\n${dryRun ? '[dry-run] would add' : 'added'} loading="lazy" decoding="async" to ${totalEdits} <img> tag(s) across ${touched.length} file(s)`);
