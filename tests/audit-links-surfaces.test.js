// Link audit: the gate itself, plus the coverage invariant behind it.
//
// `npm run audit:links` only proves what it walks. For a long time it walked
// pages/, public/ and src/ and nothing else, while vercel.json routed real
// requests into docs/, blog/ and chat/ too. Those trees served 200s in
// production with their dead links unaudited, and the audit still reported a
// clean zero, which is the worst possible failure for a gate: green with the
// hole intact.
//
// So two things are pinned here:
//
//   1. The gate result. No broken internal link, no stub href, no dangling
//      route, anywhere the audit walks.
//   2. The walk itself. Every top-level tree vercel.json can route an .html
//      request into must appear in the script's LINK_SURFACES list, so the
//      next content tree added at the repo root cannot quietly escape the
//      audit the way docs/ and blog/ did.

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SCRIPT = join(ROOT, 'scripts', 'audit-links.mjs');

const report = JSON.parse(
	execFileSync('node', [SCRIPT, '--json'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }),
);

// The trees the script declares it walks, read from its source so the test
// tracks the real list rather than a copy that can drift out of step.
function declaredSurfaces() {
	const src = readFileSync(SCRIPT, 'utf8');
	const m = src.match(/const LINK_SURFACES = \[([^\]]*)\]/);
	expect(m, 'audit-links.mjs must declare LINK_SURFACES').not.toBeNull();
	return m[1].match(/'([^']+)'/g).map((s) => s.slice(1, -1));
}

// Top-level directories vercel.json serves .html out of, excluding the ones
// that live under pages/ or public/ (those are covered by definition).
function routedRootTrees() {
	const vercel = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8'));
	const trees = new Set();
	for (const r of vercel.routes || []) {
		if (!r.dest) continue;
		const dest = r.dest.split('?')[0];
		if (!dest.endsWith('.html') || dest.includes('$')) continue;
		const rel = dest.replace(/^\/+/, '');
		if (existsSync(join(ROOT, 'pages', rel)) || existsSync(join(ROOT, 'public', rel))) continue;
		if (existsSync(join(ROOT, rel))) trees.add(rel.split('/')[0]);
	}
	return [...trees];
}

describe('link audit', () => {
	it('finds no broken internal links', () => {
		expect(report.brokenInternal).toEqual([]);
	});

	it('finds no stub hrefs', () => {
		expect(report.stubs).toEqual([]);
	});

	it('finds no dangling routes', () => {
		expect(report.danglingRoutes).toEqual([]);
	});

	it('walks every root tree vercel.json routes html into', () => {
		const declared = declaredSurfaces();
		for (const tree of routedRootTrees()) {
			expect(declared, `vercel.json routes /${tree}/**.html but audit-links.mjs never walks it`).toContain(tree);
		}
	});

	it('scans more than the three original surfaces', () => {
		// A guard against the walk silently collapsing back: docs/ and blog/ alone
		// are ~46 files, so a regression to pages+public+src shows up as a drop.
		expect(report.scannedFiles).toBeGreaterThan(2028);
	});
});
