#!/usr/bin/env node
/**
 * Route-documentation guard.
 *
 * Cross-checks the human-facing page routes declared in vercel.json against
 * data/pages.json (the single source of truth that drives /sitemap, llms.txt,
 * features.json, and the changelog). Flags public pages that ship without a
 * manifest entry so docs can't silently drift behind the product.
 *
 * Usage:
 *   node scripts/audit-page-index.mjs          # advisory — lists gaps, exit 0
 *   node scripts/audit-page-index.mjs --strict # CI mode — exit 1 if gaps exist
 *
 * Intentionally conservative: only simple, static, GET-able page routes are
 * checked. Dynamic routes (with regex captures), API endpoints, well-known
 * files, embeds, assets, and auth-gated utility pages are excluded — they
 * aren't "features" users discover via the sitemap.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vercel = JSON.parse(readFileSync(resolve(root, 'vercel.json'), 'utf8'));
const pages = JSON.parse(readFileSync(resolve(root, 'data/pages.json'), 'utf8'));

const strict = process.argv.includes('--strict');

// Paths that are real pages but intentionally NOT in the public feature index
// (auth-only utilities, legal stubs handled elsewhere, redirects, etc.).
const IGNORE = new Set([
	'/reset-password', // transactional, reached only via emailed link
	'/logout',
	'/verify-email',
	'/oauth/consent',
	'/oauth/authorize',
	'/changelog', // meta-page about the index itself
	'/news', // long-tail, generated dynamically by build-news.mjs
	'/home-v2', // A/B alias of /
	'/app-demo', // demo alias of /app
	'/app-next', // internal next-gen build of /app
	'/creating', // transient post-create loading state
	'/widget', // embed surface, not a discovery page
	'/agent/index.html', // internal SPA shell
	'/avatar-studio', // editor shell reached from /create + /app, not a landing
	'/create-review', // mid-flow step of /create
	'/deploy', // post-create deploy step, reached in-flow
	'/demos', // internal demo index
	'/x402', // authenticated x402 checkout, not a discovery page
	'/cz', // internal alias
	'/app-classic', // legacy build of /app, superseded by the current viewer
	'/create/studio', // editor shell reached in-flow from /create, not a landing
	'/next/index.html', // internal next-gen SPA shell
	'/aws', // AWS Marketplace entitlement landing, reached via marketplace redirect
	'/paywall', // transactional gate, reached in-flow when access is required
]);

// Whole prefixes that are internal/auth-gated/embed and never belong in the
// public discovery index.
const IGNORE_PREFIXES = [
	'/dashboard/', // authenticated sub-pages
	'/dashboard-classic/', // legacy authenticated dashboard, superseded by /dashboard
	'/aws-marketplace/', // AWS Marketplace post-subscribe transactional pages
	'/demo/', // demos
	'/lobehub/', // partner embed iframes
];

// A route is an auditable "page" when:
//   - src is a plain path (no regex metacharacters / captures)
//   - dest ends in .html
//   - it's not an API, asset, embed, or well-known route
function isAuditablePageRoute(r) {
	if (!r.src || !r.dest) return false;
	if (!/\.html$/.test(r.dest)) return false;
	if (/[()\[\]+*?\\]|\$\d/.test(r.src)) return false; // dynamic/capture routes
	if (r.src.includes('/api/')) return false;
	if (/\/\.well-known/.test(r.src)) return false;
	if (/embed/i.test(r.src) || /embed/i.test(r.dest)) return false;
	if (/\.(js|css|svg|png|json|xml|txt|ico)$/.test(r.src)) return false;
	return true;
}

const normalize = (p) => (p !== '/' && p.endsWith('/') ? p.slice(0, -1) : p);

const documented = new Set();
for (const s of pages.sections || []) {
	for (const p of s.pages || []) documented.add(normalize(p.path));
}

const routePaths = new Set();
for (const r of vercel.routes || []) {
	if (isAuditablePageRoute(r)) routePaths.add(normalize(r.src));
}

const ignored = (p) => IGNORE.has(p) || IGNORE_PREFIXES.some((pre) => p.startsWith(pre));
const missing = [...routePaths].filter((p) => !documented.has(p) && !ignored(p)).sort();

// Also surface manifest entries whose `added` date is missing — every NEW page
// should carry one so the changelog stays meaningful. (Advisory only.)
const undatedRecent = [];
for (const s of pages.sections || []) {
	for (const p of s.pages || []) {
		if (!p.added && !IGNORE.has(normalize(p.path)) && s.id !== 'news') {
			undatedRecent.push(normalize(p.path));
		}
	}
}

console.log(`Route audit: ${routePaths.size} auditable page routes, ${documented.size} documented in pages.json.`);

if (missing.length) {
	console.log(`\n⚠ ${missing.length} public page route(s) NOT in data/pages.json:`);
	for (const p of missing) console.log(`   ${p}`);
	console.log('\n→ Add each to data/pages.json (path, title, description, added: YYYY-MM-DD).');
} else {
	console.log('✓ Every auditable page route is documented.');
}

if (undatedRecent.length && !strict) {
	console.log(`\nℹ ${undatedRecent.length} manifest page(s) have no \`added\` date (omitted from /changelog). Fine for legacy pages; add dates as you touch them.`);
}

if (strict && missing.length) {
	console.error(`\n✗ strict mode: ${missing.length} undocumented route(s). Failing.`);
	process.exit(1);
}
process.exit(0);
