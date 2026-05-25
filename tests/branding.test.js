/**
 * Branding lock — fails if forbidden partner brand names appear in
 * user-facing surfaces of the three.ws codebase.
 *
 * Scope and exemptions are documented inline below and in
 * ./branding-allowlist.json.  This test deliberately uses only `node:fs`
 * and `node:path` so it adds no new dependencies.
 */

import { describe, test, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const ALLOWLIST_PATH = join(REPO_ROOT, 'tests', 'branding-allowlist.json');

/** @type {Array<{ pattern: string, file: string, reason: string }>} */
const allowlist = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8'));

// ── Forbidden strings ───────────────────────────────────────────────────────
//
// Each entry: { id, regex, label }
//   - id     — stable identifier used by allowlist + test naming
//   - regex  — case-insensitive matcher
//   - label  — human-readable brand
//
// "RPM" is special-cased below (only flagged near avatar/selfie).
const FORBIDDEN = [
	{ id: 'avaturn', regex: /avaturn/i, label: 'Avaturn' },
	{
		id: 'character-studio',
		regex: /character\s*studio/i,
		label: 'Character Studio',
	},
	{
		id: 'ready-player-me',
		regex: /ready\s*player\s*me|readyplayer\.me/i,
		label: 'Ready Player Me',
	},
];

// ── Path scoping ────────────────────────────────────────────────────────────

const SKIP_DIR_NAMES = new Set([
	'node_modules',
	'dist',
	'dist-lib',
	'tests',
	'migrations',
	'.git',
]);

/**
 * Return true if a repo-relative path should be excluded entirely
 * regardless of which scope it would otherwise match.
 */
function isHardSkipped(relPath) {
	const parts = relPath.split(sep);
	for (const part of parts) {
		if (SKIP_DIR_NAMES.has(part)) return true;
	}
	// avatar-sdk has its own dist subtree to skip.
	if (relPath.startsWith(`avatar-sdk${sep}dist${sep}`)) return true;
	return false;
}

/**
 * Walk a directory recursively, yielding absolute file paths that pass
 * the optional `match` predicate and are not hard-skipped.
 */
function* walk(absDir, match) {
	if (!existsSync(absDir)) return;
	let entries;
	try {
		entries = readdirSync(absDir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const ent of entries) {
		const abs = join(absDir, ent.name);
		const rel = relative(REPO_ROOT, abs);
		if (isHardSkipped(rel)) continue;
		if (ent.isDirectory()) {
			yield* walk(abs, match);
		} else if (ent.isFile()) {
			if (!match || match(abs, rel)) yield abs;
		}
	}
}

/**
 * Collect all in-scope files for the branding scan.
 * Scope (per spec):
 *   - pages/**\/*.html  (bundled top-level pages, formerly at repo root)
 *   - public/**\/*.html
 *   - docs/**\/*.md
 *   - public/docs/**\/*.md
 *   - avatar-sdk/README.md
 *   - avatar-sdk/types/**\/*.d.ts
 *   - src/**\/*.js   (JSDoc on exported symbols only — handled specially)
 *   - README.md, publish/README.md
 */
function collectScopedFiles() {
	const files = [];

	// 1. pages/**/*.html — bundled top-level pages
	for (const abs of walk(
		join(REPO_ROOT, 'pages'),
		(_a, rel) => rel.endsWith('.html'),
	)) {
		files.push({ abs, kind: 'html' });
	}

	// 2. public/**/*.html
	for (const abs of walk(
		join(REPO_ROOT, 'public'),
		(_a, rel) => rel.endsWith('.html'),
	)) {
		files.push({ abs, kind: 'html' });
	}

	// 3. docs/**/*.md
	for (const abs of walk(
		join(REPO_ROOT, 'docs'),
		(_a, rel) => rel.endsWith('.md'),
	)) {
		files.push({ abs, kind: 'md' });
	}

	// 4. public/docs/**/*.md
	for (const abs of walk(
		join(REPO_ROOT, 'public', 'docs'),
		(_a, rel) => rel.endsWith('.md'),
	)) {
		files.push({ abs, kind: 'md' });
	}

	// 5. avatar-sdk/README.md
	const sdkReadme = join(REPO_ROOT, 'avatar-sdk', 'README.md');
	if (existsSync(sdkReadme)) files.push({ abs: sdkReadme, kind: 'md' });

	// 6. avatar-sdk/types/**/*.d.ts
	for (const abs of walk(
		join(REPO_ROOT, 'avatar-sdk', 'types'),
		(_a, rel) => rel.endsWith('.d.ts'),
	)) {
		files.push({ abs, kind: 'dts' });
	}

	// 7. src/**/*.js  (JSDoc on exports — scanned via separate path)
	for (const abs of walk(
		join(REPO_ROOT, 'src'),
		(_a, rel) => rel.endsWith('.js'),
	)) {
		files.push({ abs, kind: 'src-js' });
	}

	// 8. Top-level READMEs
	for (const rel of ['README.md', join('publish', 'README.md')]) {
		const abs = join(REPO_ROOT, rel);
		if (existsSync(abs)) files.push({ abs, kind: 'readme' });
	}

	return files;
}

// ── Special-case helpers ────────────────────────────────────────────────────

/**
 * Extract the line ranges inside a JS source that belong to a JSDoc block
 * immediately followed by an `export class|function|const` (or `export
 * default class|function`) declaration.
 *
 * "Immediately followed" means: between the JSDoc's closing `*\/` and the
 * `export` keyword there is ONLY whitespace — no line comments, no other
 * code.  We scan structurally (not with one greedy regex) to avoid the
 * non-greedy backtracking trap where a single JSDoc could be paired with
 * a far-away export, swallowing intermediate code.
 *
 * Returns an array of { startLine, endLine } 1-based inclusive ranges
 * covering only the JSDoc bodies themselves.
 */
function findExportedJSDocRanges(source) {
	const ranges = [];
	const openRe = /\/\*\*/g;
	let om;
	while ((om = openRe.exec(source)) !== null) {
		const openIdx = om.index;
		const closeIdx = source.indexOf('*/', openIdx + 3);
		if (closeIdx === -1) break;
		const afterClose = closeIdx + 2;
		// Inspect whitespace-only run after the closing */.
		let i = afterClose;
		while (i < source.length && /\s/.test(source[i])) i++;
		const tail = source.slice(i, i + 80);
		if (
			/^export\s+(?:default\s+)?(?:async\s+)?(?:class|function|const|let|var)\b/.test(
				tail,
			)
		) {
			const startLine = source.slice(0, openIdx).split('\n').length;
			const endLine =
				source.slice(0, afterClose).split('\n').length;
			ranges.push({ startLine, endLine });
		}
		// Continue scanning *after* this JSDoc's close so we don't overlap.
		openRe.lastIndex = afterClose;
	}
	return ranges;
}

/**
 * For src/**\/*.js — return only the lines that live inside a JSDoc block
 * directly preceding an exported symbol.  Returns an array of
 * { lineNo, text } pairs.
 */
function getExportedJSDocLines(absPath) {
	const source = readFileSync(absPath, 'utf8');
	const lines = source.split('\n');
	const ranges = findExportedJSDocRanges(source);
	const out = [];
	for (const { startLine, endLine } of ranges) {
		for (let n = startLine; n <= endLine; n++) {
			out.push({ lineNo: n, text: lines[n - 1] ?? '' });
		}
	}
	return out;
}

/**
 * publish/README.md has a long "Roadmap → Phase 0..4" section that captures
 * historical platform context.  Per spec we skip lines inside that block.
 * Range = from the line that starts with "## Roadmap" up to (but not
 * including) the next top-level "## " heading.
 */
function isInPublishRoadmap(relPath, lineNo, allLines) {
	if (relPath !== join('publish', 'README.md')) return false;
	let start = -1;
	let end = allLines.length;
	for (let i = 0; i < allLines.length; i++) {
		const ln = allLines[i];
		if (start === -1 && /^##\s+Roadmap\b/i.test(ln)) {
			start = i + 1; // 1-based
			continue;
		}
		if (start !== -1 && i + 1 > start && /^##\s+/.test(ln)) {
			end = i; // 1-based exclusive
			break;
		}
	}
	if (start === -1) return false;
	return lineNo >= start && lineNo < end;
}

/**
 * Detect fenced code blocks (``` ... ```) in a markdown source.  Returns
 * a Set of 1-based line numbers that sit inside a fence.
 */
function fencedCodeLines(text) {
	const inside = new Set();
	const lines = text.split('\n');
	let open = false;
	for (let i = 0; i < lines.length; i++) {
		if (/^```/.test(lines[i].trim())) {
			open = !open;
			continue; // the fence line itself is not "inside"
		}
		if (open) inside.add(i + 1);
	}
	return inside;
}

// ── Allowlist matching ──────────────────────────────────────────────────────

/**
 * Return true if a hit is excused by an allowlist entry.  An entry
 * matches when:
 *   - entry.file is "*" OR is a suffix of the repo-relative path, AND
 *   - the offending line contains entry.pattern as a literal substring
 *     (case-sensitive — the patterns in the allowlist are literal code).
 *
 * Pattern matching is intentionally substring-based: the allowlist holds
 * literal code fragments like `source: 'avaturn'` or `from '@avaturn/sdk'`.
 */
function isAllowed(relPath, lineText) {
	for (const entry of allowlist) {
		const fileMatches =
			entry.file === '*' ||
			relPath === entry.file ||
			relPath.endsWith(entry.file);
		if (!fileMatches) continue;
		if (lineText.includes(entry.pattern)) return true;
	}
	return false;
}

// ── Core scanner ────────────────────────────────────────────────────────────

/**
 * Returns all hits across the in-scope files for a given forbidden
 * pattern.  RPM gets special handling via the optional `extraGate`.
 */
function scanForPattern(forbidden, files, extraGate) {
	const hits = [];
	for (const f of files) {
		const relPath = relative(REPO_ROOT, f.abs);
		const text = readFileSync(f.abs, 'utf8');
		const allLines = text.split('\n');

		// For src JS files, restrict to JSDoc-on-exports lines.
		let candidateLines;
		if (f.kind === 'src-js') {
			candidateLines = getExportedJSDocLines(f.abs);
		} else {
			candidateLines = allLines.map((text, i) => ({
				lineNo: i + 1,
				text,
			}));
		}

		// Pre-compute fenced code line set for md/readme files so the
		// extraGate can use it.
		const fenced =
			f.kind === 'md' || f.kind === 'readme'
				? fencedCodeLines(text)
				: null;

		for (const { lineNo, text: line } of candidateLines) {
			if (!forbidden.regex.test(line)) continue;

			// publish/README.md roadmap-block exemption.
			if (
				f.kind === 'readme' &&
				isInPublishRoadmap(relPath, lineNo, allLines)
			) {
				continue;
			}

			// Optional gate (used by RPM heuristic).
			if (extraGate && !extraGate({ relPath, line, fenced, lineNo })) {
				continue;
			}

			if (isAllowed(relPath, line)) continue;

			hits.push({ file: relPath, line: lineNo, text: line.trim() });
		}
	}
	return hits;
}

// ── Test cases ──────────────────────────────────────────────────────────────

describe('three.ws branding lock', () => {
	const files = collectScopedFiles();

	// The scanner walks every user-facing file end-to-end for each brand. On a
	// large monorepo (hundreds of HTML/JS/MD files in scope) that comfortably
	// exceeds the default 20s vitest timeout — bump per-test to 5 minutes so
	// CI doesn't false-fail on perfectly clean trees.
	const SCAN_TIMEOUT_MS = 5 * 60 * 1000;

	for (const forbidden of FORBIDDEN) {
		test(`no "${forbidden.label}" in user-facing files`, () => {
			const hits = scanForPattern(forbidden, files);
			if (hits.length > 0) {
				const formatted = hits
					.map(
						(h) =>
							`  ${h.file}:${h.line}\n    ${h.text}`,
					)
					.join('\n');
				throw new Error(
					`Forbidden brand "${forbidden.label}" found in ${hits.length} user-facing location(s):\n${formatted}\n\nReplace with three.ws-branded language, or add a documented exemption to tests/branding-allowlist.json.`,
				);
			}
			expect(hits).toEqual([]);
		}, SCAN_TIMEOUT_MS);
	}

	test('no "RPM" referring to Ready Player Me (heuristic: near avatar/selfie)', () => {
		const RPM_LINE = /\bRPM\b/;
		const NEARBY = /avatar|selfie/i;
		const hits = [];
		for (const f of files) {
			const relPath = relative(REPO_ROOT, f.abs);
			const text = readFileSync(f.abs, 'utf8');
			const allLines = text.split('\n');

			const candidateLines =
				f.kind === 'src-js'
					? getExportedJSDocLines(f.abs)
					: allLines.map((t, i) => ({ lineNo: i + 1, text: t }));

			for (const { lineNo, text: line } of candidateLines) {
				if (!RPM_LINE.test(line)) continue;
				// Window: the line itself plus the two surrounding lines.
				const ctxStart = Math.max(0, lineNo - 2);
				const ctxEnd = Math.min(allLines.length, lineNo + 1);
				const ctx = allLines.slice(ctxStart, ctxEnd).join(' ');
				if (!NEARBY.test(ctx)) continue;
				if (
					f.kind === 'readme' &&
					isInPublishRoadmap(relPath, lineNo, allLines)
				)
					continue;
				if (isAllowed(relPath, line)) continue;
				hits.push({ file: relPath, line: lineNo, text: line.trim() });
			}
		}
		if (hits.length > 0) {
			const formatted = hits
				.map((h) => `  ${h.file}:${h.line}\n    ${h.text}`)
				.join('\n');
			throw new Error(
				`Found "RPM" near avatar/selfie context in ${hits.length} location(s) — assume Ready Player Me:\n${formatted}`,
			);
		}
		expect(hits).toEqual([]);
	}, SCAN_TIMEOUT_MS);
});
