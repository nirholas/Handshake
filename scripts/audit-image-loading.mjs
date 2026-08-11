#!/usr/bin/env node
/**
 * Image loading-attribute guard.
 *
 * Every JS-rendered <img> in src/ pulls a remote thumbnail / avatar / coin
 * image into a list, grid, modal or sidebar — off-fold content that must defer
 * its network fetch (`loading="lazy"`) and decode off the main thread
 * (`decoding="async"`). A new component that ships an <img> without these
 * silently regresses scroll performance as feeds grow. This guard keeps the
 * codebase self-defending: it reports — and in --strict mode fails the build on
 * — any src/ <img> missing `loading=`.
 *
 * Scope: src/ only. Static-HTML <img> tags are intentionally NOT covered — most
 * are above-the-fold logos/wordmarks (the LCP image) where lazy-loading hurts.
 *
 * To fix offenders in bulk: `node scripts/codemod-lazy-images.mjs`.
 *
 * Usage:
 *   node scripts/audit-image-loading.mjs           # report only (exit 0)
 *   node scripts/audit-image-loading.mjs --strict  # exit 1 if any offender
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { maskComments } from './lib/js-comment-ranges.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = resolve(root, 'src');
const strict = process.argv.includes('--strict');

// A real <img> tag: `<img` + whitespace + an attribute name. Comments are
// masked out before matching (see maskComments), so prose that quotes a tag,
// such as an XSS note about `<img onerror=…>`, is never mistaken for markup
// this codebase renders.
const REAL_IMG = /<img(?=\s+[a-zA-Z])([^>]*?)>/g;

function walk(dir) {
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...walk(p));
		else if (entry.isFile() && p.endsWith('.js')) out.push(p);
	}
	return out;
}

const offenders = [];
for (const file of walk(SRC_DIR)) {
	const src = maskComments(readFileSync(file, 'utf8'));
	let m;
	REAL_IMG.lastIndex = 0;
	while ((m = REAL_IMG.exec(src)) !== null) {
		const attrs = m[1] || '';
		if (!/\bloading=/.test(attrs)) {
			const line = src.slice(0, m.index).split('\n').length;
			offenders.push(`${relative(root, file)}:${line}`);
		}
	}
}

if (offenders.length === 0) {
	console.log('✓ image-loading guard: every src/ <img> declares loading=');
	process.exit(0);
}

console.error(`✗ image-loading guard: ${offenders.length} <img> tag(s) missing loading=`);
for (const o of offenders) console.error(`  ${o}`);
console.error('\nFix with: node scripts/codemod-lazy-images.mjs');
process.exit(strict ? 1 : 0);
