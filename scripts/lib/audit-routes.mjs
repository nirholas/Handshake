/**
 * audit-routes.mjs: the one route list every browser sweep works from.
 *
 * page-audit (console/network/layout findings) and page-snapshot (the visual
 * record) both have to answer the same question: what pages does this site
 * have? They answered it separately, which meant the authenticated route list
 * existed only inside page-audit, and the visual sweep could never see a
 * dashboard page. This module is that answer, once.
 *
 * Sources, in order of authority:
 *   1. data/pages.json: the manifest that also drives /sitemap, llms.txt and
 *      the changelog. Every public, user-discoverable page.
 *   2. AUTHED_ROUTES  : signed-in pages the manifest intentionally omits
 *      (dashboard sub-pages that are not marketing surfaces).
 *   3. seedDynamicRoutes(): parameterised routes filled with REAL ids read
 *      from the live API at run time, never placeholders.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// Machine-readable endpoints (.xml/.txt/.json/...) have no DOM to audit.
export const isHtmlRoute = (path) => !/\.[a-z0-9]+$/i.test(path) || /\.html$/i.test(path);

/**
 * Pages from data/pages.json.
 *
 * @param {object} [opts]
 * @param {'public'|'authed'|'all'} [opts.access] which pages to include; the
 *   manifest flags a signed-in page with `auth` (true or "required").
 * @returns {{path:string,title:string,section:string,auth:string|boolean|null}[]}
 */
export function manifestPages({ access = 'public' } = {}) {
	const pages = JSON.parse(readFileSync(resolve(ROOT, 'data/pages.json'), 'utf8'));
	const out = [];
	const seen = new Set();
	for (const s of pages.sections || []) {
		// `machine` section = non-HTML endpoints (.xml/.txt/.json/.well-known);
		// no DOM, no console. Not part of a browser sweep.
		if (s.id === 'machine') continue;
		for (const p of s.pages || []) {
			const path = p.path;
			if (!path || !path.startsWith('/') || /[:*]/.test(path)) continue;
			if (!isHtmlRoute(path)) continue;
			if (path.startsWith('/.well-known')) continue;
			if (seen.has(path)) continue;
			const authed = Boolean(p.auth);
			if (access === 'public' && authed) continue;
			if (access === 'authed' && !authed) continue;
			seen.add(path);
			out.push({ path, title: p.title || path, section: s.title || s.id, auth: p.auth || null });
		}
	}
	return out;
}

/** Just the paths, for callers that do not need the metadata. */
export function manifestRoutes(opts) {
	return manifestPages(opts).map((p) => p.path);
}

// Authenticated surfaces the public manifest omits: dashboard sub-pages and
// account routes that are product, not marketing, so they never belonged in
// the public page index. A sweep with a session replays these too.
//
// The dashboard's own route table in vercel.json is the source of truth for
// which of them exist, because a hand-kept copy goes stale silently. By
// 2026-09-04 ten of the eighteen hardcoded entries had become 301 stubs
// pointing at consolidated pages (the sweep was auditing empty redirects) and
// twenty-one live dashboard pages had never been audited under a session at
// all. Reading the table means a page added or consolidated there is picked
// up by the next sweep with no second edit.
const AUTHED_PREFIX = /^\/dashboard\//;

// Account surfaces that live outside the dashboard route block.
const STANDALONE_AUTHED_ROUTES = ['/profile', '/settings', '/my-agents'];

/** Concrete (non-pattern, non-redirect) dashboard pages from the route table. */
function dashboardRoutes() {
	const config = JSON.parse(readFileSync(resolve(ROOT, 'vercel.json'), 'utf8'));
	const out = [];
	for (const route of config.routes || []) {
		const src = route.src;
		if (typeof src !== 'string' || !AUTHED_PREFIX.test(src)) continue;
		// A redirect stub has no page of its own; its destination is audited instead.
		if (route.status || route.headers?.Location || !route.dest) continue;
		const path = src.replace(/\/\?$/, '').replace(/(.)\/$/, '$1');
		// Capture groups and character classes are patterns, not addressable routes.
		if (/[()[\]*+|^$\\?]/.test(path)) continue;
		if (!isHtmlRoute(path)) continue;
		out.push(path);
	}
	return out;
}

export const AUTHED_ROUTES = [...new Set([...dashboardRoutes(), ...STANDALONE_AUTHED_ROUTES])].sort();

/**
 * Parameterised routes filled with real ids from the live API.
 * @param {import('playwright').BrowserContext} ctx a context whose `request`
 *   can reach `baseUrl` (it carries the session when there is one).
 */
export async function seedDynamicRoutes(ctx, baseUrl) {
	const routes = [];
	try {
		const res = await ctx.request.get(`${baseUrl}/api/explore?limit=5`, { timeout: 15000 });
		if (res.ok()) {
			const body = await res.json();
			const items = body.items || body.agents || [];
			const onchain = items.find((i) => i.agentId && i.chainId);
			if (onchain) {
				routes.push(`/a/${onchain.chainId}/${onchain.agentId}`);
				routes.push(`/agent/${onchain.chainId}:${onchain.agentId}`);
			}
		}
	} catch {
		/* live API unreachable: dynamic routes simply skipped */
	}
	return routes;
}

/** '/' → 'home', '/docs/api' → 'docs-api'. Filesystem-safe, stable across runs. */
export function slugFor(path) {
	if (path === '/') return 'home';
	return path.replace(/^\//, '').replace(/\/$/, '').replace(/[^a-zA-Z0-9._-]+/g, '-') || 'home';
}
