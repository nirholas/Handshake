// The pages under public/ are served verbatim: no bundler rewrites them, so a
// bare `import('https://esm.sh/...')` in one is a single point of failure the
// user meets at the worst possible moment. On /pay it stalled a payment at
// "sign the transaction in Phantom" with nothing on screen; on the portfolio
// dashboards it left an empty chart well and a blank QR canvas. One CDN
// outage, one corporate proxy or one ad blocker was enough.
//
// /load-module.js already races the same package version across esm.sh,
// jsdelivr and unpkg and rejects with a typed error naming every host. This
// pins that every public page uses it, because the next page added here will
// otherwise copy the pattern that failed.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = join(ROOT, 'public');

function walk(dir, out = []) {
	for (const entry of readdirSync(dir)) {
		// public/chat is a build output copied in by `npm run build:chat`; it is
		// not hand-written source and is not ours to hold to this rule.
		if (entry === 'chat' || entry === 'node_modules') continue;
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) walk(full, out);
		else if (/\.html$/.test(entry)) out.push(full);
	}
	return out;
}

// The three hosts /load-module.js knows how to mirror between.
const MIRRORABLE = /^https:\/\/(?:esm\.sh|cdn\.jsdelivr\.net|unpkg\.com)\//;

// Comments quote the very pattern they warn against, so strip them before
// scanning; otherwise the explanation of the fix reads as the defect.
function withoutComments(src) {
	return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
}

/** Every mirrorable CDN URL a page hands to the loader (directly or via a wrapper). */
function loaderCdnTargets(src) {
	const out = [];
	const re = /\b(?:loadModule|loadCdnModule)\s*\(\s*['"`]([^'"`]+)['"`]/g;
	for (const m of withoutComments(src).matchAll(re)) {
		if (MIRRORABLE.test(m[1])) out.push(m[1]);
	}
	return out;
}

/** Every string literal a page passes straight to `import()` from a CDN host. */
function cdnImportTargets(src) {
	const out = [];
	const re = /\bimport\s*\(\s*['"`]([^'"`]+)['"`]/g;
	for (const m of withoutComments(src).matchAll(re)) {
		if (MIRRORABLE.test(m[1])) out.push(m[1]);
	}
	return out;
}

describe('public pages load third-party modules through /load-module.js', () => {
	const pages = walk(PUBLIC_DIR);

	it('finds the public pages to check', () => {
		expect(pages.length).toBeGreaterThan(10);
	});

	it('has no bare CDN dynamic import left in any page', () => {
		const offenders = [];
		for (const file of pages) {
			const targets = cdnImportTargets(readFileSync(file, 'utf8'));
			if (targets.length) offenders.push(`${relative(ROOT, file)}: ${targets.join(', ')}`);
		}
		expect(offenders).toEqual([]);
	});

	it('keeps the loader wired into every page the audit fixed', () => {
		// The sweep above also passes if a feature is simply deleted. These are
		// the pages that used to import a CDN host directly; each must still
		// reach it, through the loader, by ABSOLUTE path (they live at several
		// depths, and a relative path breaks the moment a page moves).
		const fixed = [
			'public/pay/index.html',
			'public/dashboard/portfolio.html',
			'public/dashboard/portfolio-asset.html',
			'public/dashboard/agent-pumpfun.html',
			'public/dashboard/sns.html',
			'public/agent-passport.html',
			'public/ar-forge.html',
		];
		for (const rel of fixed) {
			const src = withoutComments(readFileSync(join(ROOT, rel), 'utf8'));
			expect(/['"]\/load-module\.js['"]/.test(src), `${rel} must import '/load-module.js'`).toBe(true);
			expect(/\b(?:loadModule|loadCdnModule)\s*\(/.test(src), `${rel} must call the loader`).toBe(true);
			expect(MIRRORABLE.test(''), 'MIRRORABLE guards a full URL, not a bare host').toBe(false);
		}
	});

	it('the loader those pages import is actually served at that path', () => {
		// public/ is Vite's publicDir, copied to the site root, so /load-module.js
		// is public/load-module.js. If this file ever moves, every page above 404s
		// at exactly the moment it needs a fallback.
		expect(() => statSync(join(PUBLIC_DIR, 'load-module.js'))).not.toThrow();
		const loader = readFileSync(join(PUBLIC_DIR, 'load-module.js'), 'utf8');
		expect(loader).toContain('export function loadModule');
	});
});
