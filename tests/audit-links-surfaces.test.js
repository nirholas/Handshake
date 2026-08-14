// Link audit: the coverage invariant behind the gate.
//
// `npm run audit:links` only proves what it walks. For a long time it walked
// pages/, public/ and src/ and nothing else, while vercel.json routed real
// requests into docs/, blog/ and chat/ too. Those trees served 200s in
// production with their links unaudited, and the audit still reported a clean
// zero, which is the worst failure a gate can have: green with the hole intact.
//
// The findings themselves are gated by `npm run audit:links` (wired into
// `npm run gate`), which reads ~2100 files and is too slow to belong in the
// unit suite. What belongs here is the cheap invariant that gate depends on:
// every top-level tree vercel.json can route an .html request into must appear
// in the script's LINK_SURFACES list, so the next content tree added at the
// repo root cannot quietly escape the audit the way docs/ and blog/ did.

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SCRIPT = join(ROOT, 'scripts', 'audit-links.mjs');

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

describe('link audit coverage', () => {
	it('walks every root tree vercel.json routes html into', () => {
		const declared = declaredSurfaces();
		const routed = routedRootTrees();
		expect(routed.length, 'vercel.json should route html into at least one root tree').toBeGreaterThan(0);
		for (const tree of routed) {
			expect(declared, `vercel.json routes /${tree}/**.html but audit-links.mjs never walks it`).toContain(tree);
		}
	});

	it('still walks the three original surfaces', () => {
		const declared = declaredSurfaces();
		for (const tree of ['pages', 'public', 'src']) expect(declared).toContain(tree);
	});

	it('is wired into the gate so a dead link fails a build, not just a manual run', () => {
		const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
		expect(pkg.scripts.gate).toContain('audit:links');
	});
});
