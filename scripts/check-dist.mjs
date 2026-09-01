#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const required = [
	'dist/agent-3d/latest/agent-3d.js',
	'dist/agent-3d/latest/agent-3d.umd.cjs',
	'dist/agent-3d/versions.json',
	// The one runtime fetch behind /timeline (copied by vite.config.js's
	// copy-timeline-data hook). It was missing from every production build
	// until 2026-09-01, which left the page on its error state.
	'dist/data/timeline.json',
];

let ok = true;
for (const rel of required) {
	if (!existsSync(resolve(root, rel))) {
		console.error(`[check-dist] MISSING: ${rel}`);
		ok = false;
	}
}

if (ok) {
	const versions = JSON.parse(readFileSync(resolve(root, 'dist/agent-3d/versions.json'), 'utf8'));
	const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
	if (versions.latest !== pkg.version) {
		console.error(
			`[check-dist] versions.json "latest" is "${versions.latest}" but package.json is "${pkg.version}"`,
		);
		ok = false;
	}
}

// dist-lib mirror checks
const distLibChecks = [
	{ rel: 'dist/dist-lib/agent-3d.js', min: 1_000_000 },
	{ rel: 'dist/dist-lib/agent-3d.umd.cjs', min: 100_000 },
];
for (const { rel, min } of distLibChecks) {
	const p = resolve(root, rel);
	if (!existsSync(p)) {
		console.error(`[check-dist] MISSING: ${rel}`);
		ok = false;
	} else {
		const size = statSync(p).size;
		if (size < min) {
			console.error(`[check-dist] TOO SMALL: ${rel} (${size} bytes, expected >= ${min})`);
			ok = false;
		}
	}
}

// Known high-traffic static pages, checked directly against server/index.mjs's
// resolveStatic() resolution (directory → index.html fallback). A deploy with
// `npm run build` skipped (or run from a stale checkout) ships an incomplete
// dist/ with no error — that's exactly how /dashboard and /pump-dashboard
// 404'd in production on 2026-07-08 while check:dist reported green, because
// this check only ever looked at the agent-3d embed bundle. This list stays as
// a fast, dependency-free tripwire for "was `npm run build` skipped entirely".
//
// The full sweep of data/pages.json now lives in scripts/check-pages.mjs, which
// runs straight after this one in `build:gcp`. The reason it wasn't done here
// is that a naive "every registered path must have a dist/ file" check
// false-flags the ~200 entries served by api/** handlers at request time
// (docs/*, tutorials/*, .well-known/*). check-pages.mjs resolves each path
// through the real vercel.json route table instead, so it can tell a
// server-rendered page from an unreachable one and needs no allowlist.
const criticalStaticPages = ['/', '/dashboard', '/pump-dashboard', '/dashboard-next', '/create', '/discover', '/chat'];

function resolvesToFile(pagePath) {
	// vercel.json rewrites "/" -> "/home.html" (server/index.mjs's phase1Routes,
	// exact literal src, no /? suffix) rather than serving dist/index.html.
	const candidates =
		pagePath === '/'
			? ['home.html']
			: [pagePath, `${pagePath}/index.html`, `${pagePath}.html`];
	for (const rel of candidates) {
		const abs = resolve(root, 'dist', rel.replace(/^\//, ''));
		try {
			const st = statSync(abs);
			if (st.isFile()) return true;
			if (st.isDirectory() && existsSync(resolve(abs, 'index.html'))) return true;
		} catch {
			// try next candidate
		}
	}
	return false;
}

const missingPages = criticalStaticPages.filter((p) => !resolvesToFile(p));
if (missingPages.length) {
	console.error(`[check-dist] ${missingPages.length} critical static page(s) missing from dist/ (did \`npm run build\` run?):`);
	for (const p of missingPages) console.error(`[check-dist]   MISSING PAGE: ${p}`);
	ok = false;
}

if (!ok) process.exit(1);
console.log('[check-dist] dist-lib mirror OK');
console.log(`[check-dist] all ${criticalStaticPages.length} critical static pages present`);
console.log('[check-dist] OK — dist/agent-3d/latest/ ready for deploy');
