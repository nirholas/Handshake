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

// The audit's own classification rules. Each one below was a false positive the
// audit reported against correct code, and a false positive in a gate is not
// harmless: it trains everyone to read a red audit as noise, which is how a real
// dead link ships behind three fake ones. These pin the rules narrowly, so
// widening one into a blanket ignore fails here.
describe('link audit classification', () => {
	function source() {
		return readFileSync(SCRIPT, 'utf8');
	}

	it('exempts only build outputs that something actually writes', () => {
		const m = source().match(/const GENERATED_TARGETS = new Set\(\[([^\]]*)\]\)/);
		expect(m, 'audit-links.mjs must declare GENERATED_TARGETS').not.toBeNull();
		const targets = (m[1].match(/'([^']+)'/g) || []).map((t) => t.slice(1, -1));
		expect(targets).toContain('/build-info.json');
		// The exemption is a claim that the build emits the file. Hold it to the
		// script that makes the claim true, so a target cannot linger here after
		// whatever produced it is gone.
		const writer = readFileSync(join(ROOT, 'scripts', 'write-build-info.mjs'), 'utf8');
		expect(writer).toContain('build-info.json');
	});

	it('masks comments in the fetch scanner, like the two scanners beside it', () => {
		// A module header warning against a call pattern quotes that pattern. The
		// fetch scanner was the only extractor that never consulted the mask, so
		// src/api.js was reported as fetching the path its own comment says not to.
		const body = source().match(/fetchRe\.lastIndex = 0;[\s\S]*?\n\t\}/);
		expect(body, 'audit-links.mjs must scan fetch() calls').not.toBeNull();
		expect(body[0]).toContain('inComment(m.index)');
	});

	it('treats an empty object-literal href as absence, and a DOM assignment as a stub', () => {
		const m = source().match(/const jsNavRe = (\/.*\/[gimsuy]*);/);
		expect(m, 'audit-links.mjs must declare jsNavRe').not.toBeNull();
		const prefixOf = (code) => {
			const re = new RegExp(m[1].slice(1, m[1].lastIndexOf('/')), 'gi');
			return re.exec(code)?.[1] ?? null;
		};
		// The exemption keys off the prefix the regex captures, anchored at the
		// end, which is the whole reason it cannot swallow a DOM assignment.
		expect(source()).toMatch(/target === '' && \/href\\s\*:\$\/i\.test\(m\[1\]\)/);
		expect(prefixOf("{ href: '' }")).toMatch(/href\s*:$/);
		expect(prefixOf("el.href = ''")).not.toMatch(/href\s*:$/);
		expect(prefixOf("location.assign('')")).not.toMatch(/href\s*:$/);
	});
});
