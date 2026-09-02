#!/usr/bin/env node
/**
 * Routing & 404 verifier for vercel.json.
 *
 * The site routes through the legacy Vercel `routes` array (first match wins,
 * a `{ "handle": "filesystem" }` boundary, then a `/(.*)` → `/404.html` status
 * 404 catch-all). This script proves three things without needing a deploy:
 *
 *   1. COVERAGE   — every catalog page in data/pages.json is reachable by its
 *                   canonical (extensionless, no-trailing-slash) pretty URL, and
 *                   every page also resolves with a trailing slash.
 *   2. 404 STATUS — unknown paths land on the designed /404.html with a real 404
 *                   (not a silent dead-end, not a 200).
 *   3. NO SHADOWS — every literal page route actually serves its own destination
 *                   (no earlier broad pattern swallows it).
 *
 * It does this two ways:
 *   • STATIC (default), the shared legacy-routes matcher in
 *     scripts/lib/vercel-routes.mjs (one offline model of what server/index.mjs
 *     does at runtime, also used by scripts/audit-route-shadowing.mjs), run
 *     against a model of the built `dist/` file set (rollup HTML inputs from
 *     vite.config.js + auto-discovered dashboard-next + verbatim public/ ,
 *     docs/ , blog/ , ibm/ copies). Deterministic, offline, CI-safe.
 *   • LIVE (--base=<url>) — real HTTP requests against a running preview / prod
 *     (`vercel dev`, `vercel build` preview, or https://three.ws), asserting the
 *     status code and, for redirects, the Location.
 *
 * Usage:
 *   node scripts/verify-routes.mjs            # static, advisory (exit 0, lists issues)
 *   node scripts/verify-routes.mjs --strict   # static, CI mode (exit 1 on any failure)
 *   node scripts/verify-routes.mjs --base=https://three.ws            # live sample
 *   node scripts/verify-routes.mjs --base=http://localhost:3000 --all # live, every route
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRouteTable, resolveRequest } from './lib/vercel-routes.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const strict = argv.includes('--strict');
const all = argv.includes('--all');
const baseArg = argv.find((a) => a.startsWith('--base='));
const BASE = baseArg ? baseArg.slice('--base='.length).replace(/\/$/, '') : null;

const vercel = JSON.parse(readFileSync(resolve(ROOT, 'vercel.json'), 'utf8'));
const pages = JSON.parse(readFileSync(resolve(ROOT, 'data/pages.json'), 'utf8'));
const routes = vercel.routes || [];

// ───────────────────────── model the built dist/ file set ─────────────────────────
function walk(dir, base = dir, exts = null) {
	const out = [];
	let entries;
	try {
		entries = readdirSync(dir);
	} catch {
		return out;
	}
	for (const e of entries) {
		const full = resolve(dir, e);
		let st;
		try {
			st = statSync(full);
		} catch {
			continue;
		}
		if (st.isDirectory()) out.push(...walk(full, base, exts));
		else if (!exts || exts.some((x) => e.endsWith(x))) out.push(full.slice(base.length + 1));
	}
	return out;
}

// Which pages/*.html actually reach dist: rollup inputs + dashboard-next glob + ibm copy.
const viteSrc = readFileSync(resolve(ROOT, 'vite.config.js'), 'utf8');
const viteInputs = new Set();
// Whitespace-tolerant on purpose: a formatter wrapping one long entry across
// lines used to drop it from this set, which reads downstream as a real 404 for
// a page the build actually emits (/events/build-3d-agents-live, 2026-09-02).
for (const m of viteSrc.matchAll(/resolve\(\s*__dirname,\s*['"]([^'"]+\.html)['"]\s*,?\s*\)/g))
	viteInputs.add(m[1]);

const served = new Set(); // dist-relative file paths that will exist on disk
for (const f of walk(resolve(ROOT, 'pages'), resolve(ROOT, 'pages'), ['.html'])) {
	if (viteInputs.has('pages/' + f) || f.startsWith('dashboard-next/') || f.startsWith('ibm/')) served.add(f);
}
for (const f of walk(resolve(ROOT, 'public'))) served.add(f); // public/ copied verbatim (all files)
for (const f of walk(resolve(ROOT, 'docs'))) served.add('docs/' + f);
for (const f of walk(resolve(ROOT, 'blog'))) served.add('blog/' + f);
// The chat sub-app's build output (public/chat/index.html and assets) is a
// gitignored `build:chat` artifact, so walking public/ misses it in any
// workspace that hasn't built chat. Model it from its source of truth: the
// chat workspace builds chat/index.html into ../public/chat (chat/vite.config.js
// outDir), and build:gcp always runs build:chat before the deploy-time
// check:dist, which independently verifies dist/chat/index.html exists. So
// modeling the entry here cannot mask a production 404 from a skipped build.
{
	const chatVite = readFileSync(resolve(ROOT, 'chat/vite.config.js'), 'utf8');
	const outDir = chatVite.match(/outDir:\s*['"]([^'"]+)['"]/)?.[1];
	if (outDir === '../public/chat' && existsSync(resolve(ROOT, 'chat/index.html'))) {
		served.add('chat/index.html');
	}
}

// ───────────────────────── shared legacy-routes resolver ─────────────────────────
// The matcher itself lives in scripts/lib/vercel-routes.mjs so this script and
// scripts/audit-route-shadowing.mjs predict production from one implementation.
// What stays here is this script's own view of the world: the modeled dist/ file
// set below, and the api/ root that turns an /api/* dest into a real handler.
const table = loadRouteTable(vercel);
const { fsIndex: fsIdx, phase1Routes: mainRoutes, postFsRoutes: postRoutes } = table;
const API_ROOT = resolve(ROOT, 'api');

// Does the filesystem serve `path`? (path is dist-relative, leading slash stripped)
function fileServes(path) {
	const clean = path.replace(/^\//, '').split('?')[0];
	if (clean === '') return served.has('home.html') || served.has('index.html');
	if (served.has(clean)) return true;
	// NOTE: no bare-`.html` extension resolution here. This project pins routing
	// with a legacy `routes` array in vercel.json, which opts out of Vercel's
	// `cleanUrls` — the filesystem handler does NOT serve `splat.html` for a
	// request to `/splat`. Each flat page needs an explicit `/x → /x.html`
	// route. Modeling the extension fallback here would mask pages that are
	// missing that route (they 404 in production while the audit stays green —
	// exactly how /splat, /capture, /integrations, /partners, /agents-live
	// slipped through). Directory indexes are still served by the filesystem.
	if (served.has(clean + '/index.html')) return true;
	if (clean.endsWith('/') && served.has(clean + 'index.html')) return true;
	return false;
}

// Returns { kind: 'file'|'redirect'|'api'|'api-missing'|'external'|'notfound', status, dest, to }
// A thin adapter over the shared resolver, keeping this script's original `kind`
// vocabulary so the checks below read the same as before.
function resolvePath(pathname) {
	const r = resolveRequest(table, pathname, {
		apiRoot: API_ROOT,
		fileServes,
		// This script asks "is the page reachable at this URL", so it models the
		// trailing-slash form through the route table rather than short-circuiting
		// on the server's 301 collapse.
		collapseTrailingSlash: false,
	});
	if (r.outcome === 'handler') return { kind: 'api', status: 200, dest: r.dest };
	if (r.outcome === 'api-missing') return { kind: 'api-missing', status: 500, dest: r.dest };
	if (r.outcome === 'file') return { kind: 'file', status: r.status, dest: r.dest };
	if (r.outcome === 'redirect') return { kind: 'redirect', status: r.status, to: r.to };
	if (r.outcome === 'external') return { kind: 'external', status: 200, to: r.to };
	if (r.outcome === 'status') return { kind: 'notfound', status: r.status };
	return { kind: 'notfound', status: r.status ?? 404, dest: r.dest };
}

// ───────────────────────── checks ─────────────────────────
const norm = (p) => (p !== '/' && p.endsWith('/') ? p.slice(0, -1) : p);
const dynamic = (p) => /[:*]|\$/.test(p);
const reachable = (r) => ['file', 'redirect', 'api', 'external'].includes(r.kind);

const failures = [];
const warnings = [];

// 1. COVERAGE — canonical reachability (hard) + trailing-slash (soft)
const catalog = [];
for (const s of pages.sections || []) for (const p of s.pages || []) catalog.push(p.path);
let covered = 0;
for (const path of catalog) {
	if (dynamic(path)) continue;
	const noSlash = norm(path);
	const a = resolvePath(noSlash);
	if (!reachable(a)) {
		failures.push(`COVERAGE  ${path}  canonical → ${a.kind} (${a.status}) ${a.dest || a.to || ''}`);
		continue;
	}
	covered++;
	// A trailing slash only makes sense for "directory-like" pretty URLs — not for
	// file resources (robots.txt, openapi.json), well-known endpoints, or APIs,
	// where `…/` is never requested and would be wrong to serve.
	const isResource = /\.[a-z0-9]+$/i.test(noSlash) || noSlash.startsWith('/.well-known/') || noSlash.startsWith('/api/');
	if (isResource) continue;
	const withSlash = noSlash === '/' ? '/' : noSlash + '/';
	const b = resolvePath(withSlash);
	if (!reachable(b)) warnings.push(`TRAILSLASH ${path}/  → ${b.kind} (lands on designed 404)`);
}

// 2. 404 STATUS — known-bad paths must hit the designed 404 with status 404
const BAD = [
	'/this-page-does-not-exist',
	'/zzzz-nope',
	'/agents/____/nope',
	'/forge/not/a/real/sub/path/xyz',
	'/dashboard/zzz-not-a-tab-xyz',
	'/.well-known/not-a-real-thing-xyz',
];
for (const p of BAD) {
	const r = resolvePath(p);
	if (!(r.kind === 'notfound' && r.status === 404)) {
		failures.push(`404STATUS ${p}  → ${r.kind} (${r.status}) ${r.dest || r.to || ''} (expected 404 → /404.html)`);
	} else if (r.dest && r.dest !== '/404.html' && r.dest !== '(implicit)') {
		warnings.push(`404DEST   ${p} → ${r.dest} (expected /404.html)`);
	}
}
// And the 404 destination file must exist.
if (!served.has('404.html')) failures.push('404PAGE   dist/404.html is missing (public/404.html not built)');

// 3. NO SHADOWS — each literal HTML page route serves its own dest
let litChecked = 0;
for (const r of mainRoutes) {
	if (!r.src || r.continue || r.has || r.missing || !r.dest) continue;
	if (!/\.html$/.test(r.dest.split('?')[0])) continue;
	const lit = r.src.replace(/\\(.)/g, '$1');
	if (/[()\[\]+*?|]/.test(lit.replace(/\/\?$/, ''))) continue; // patterned src — skip
	const canonical = lit.replace(/\/\?$/, '');
	const want = r.dest.split('?')[0];
	const got = resolvePath(canonical || '/');
	litChecked++;
	if (got.kind === 'file' && '/' + got.dest.replace(/^\//, '') !== want) {
		// Only a real shadow if it serves a DIFFERENT html page than intended.
		if (got.dest.replace(/^\//, '') !== want.replace(/^\//, ''))
			failures.push(`SHADOW    ${r.src} → ${want}  but resolves to /${got.dest.replace(/^\//, '')}`);
	}
}

// ───────────────────────── live mode (optional) ─────────────────────────
async function live() {
	const targets = new Set([...BAD]);
	for (const path of catalog) if (!dynamic(path)) targets.add(norm(path));
	if (!all) {
		// sample: first ~40 catalog pages + all bad paths is plenty for a smoke pass
		const sample = [...targets].slice(0, 40 + BAD.length);
		targets.clear();
		for (const t of sample) targets.add(t);
	}
	let liveFail = 0;
	for (const path of targets) {
		const expectBad = BAD.includes(path);
		let res;
		try {
			res = await fetch(BASE + path, { redirect: 'manual', headers: { 'user-agent': 'three-ws-route-verifier' } });
		} catch (e) {
			console.log(`  ✗ ${path} — request failed: ${e.message}`);
			liveFail++;
			continue;
		}
		const st = res.status;
		const okBad = expectBad ? st === 404 : st >= 200 && st < 400;
		if (!okBad) {
			console.log(`  ✗ ${path} — HTTP ${st}${expectBad ? ' (expected 404)' : ''}`);
			liveFail++;
		} else if (process.env.VERBOSE) {
			console.log(`  ✓ ${path} — HTTP ${st}`);
		}
	}
	console.log(`\nLive check against ${BASE}: ${targets.size - liveFail}/${targets.size} OK.`);
	return liveFail;
}

// ───────────────────────── report ─────────────────────────
console.log(`Route verify — ${catalog.length} catalog pages, ${mainRoutes.length} main routes, ${postRoutes.length} post-filesystem routes.`);
console.log(`  modeled dist files: ${served.size} · canonical-covered: ${covered} · literal page routes checked for shadows: ${litChecked}`);
console.log(`  filesystem boundary (handle:filesystem) present: ${fsIdx !== -1 ? 'yes' : 'NO'}`);

if (warnings.length) {
	console.log(`\nℹ ${warnings.length} advisory note(s):`);
	for (const w of warnings.slice(0, 50)) console.log('   ' + w);
	if (warnings.length > 50) console.log(`   …and ${warnings.length - 50} more`);
}

if (failures.length) {
	console.log(`\n✗ ${failures.length} FAILURE(s):`);
	for (const f of failures) console.log('   ' + f);
} else {
	console.log('\n✓ static checks pass: every catalog page reachable, unknown paths → designed 404, no shadowed page routes.');
}

let exitCode = failures.length && strict ? 1 : 0;
if (BASE) {
	const liveFail = await live();
	if (liveFail && strict) exitCode = 1;
}
process.exit(exitCode);
