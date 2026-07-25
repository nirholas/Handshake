// Offline mirror of server/index.mjs's request resolution, for build-time checks.
//
// Why this exists: a page can ship to production completely unreachable and
// nothing catches it. `resolveStatic()` in server/index.mjs deliberately has no
// `.html` extension fallback — it serves an exact path or a directory's
// index.html, nothing else — so a page built to `dist/<slug>.html` is a hard
// 404 at `/<slug>` unless vercel.json carries a rewrite for it. That has now
// shipped twice in three days: `/timeline` (fixed by 5688277bd, "page shipped
// without a route entry") and `/tracker` (added to data/pages.json 2026-07-23,
// 404 in production until a route landed two days later). Both were advertised
// in the sitemap and llms.txt the whole time.
//
// This module resolves a pathname the way the running server would, against a
// built dist/, so scripts/check-pages.mjs can fail the build instead of letting
// the sitemap advertise a 404. It intentionally duplicates a small amount of
// server logic rather than importing server/index.mjs, which starts listening
// on import and cannot be loaded as a library. Keep the two in sync: the pieces
// mirrored here are the route-table split, substitute(), hasMatches() and
// resolveStatic().

import { readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';

const compileRoute = (r) => ({ ...r, re: new RegExp(`^${r.src}$`) });

/** Split vercel.json's route table at the {handle:"filesystem"} marker. */
export function loadRouteTable(rootDir) {
	const config = JSON.parse(readFileSync(path.join(rootDir, 'vercel.json'), 'utf8'));
	const fsIndex = config.routes.findIndex((r) => r.handle === 'filesystem');
	const end = fsIndex === -1 ? config.routes.length : fsIndex;
	return {
		phase1: config.routes.slice(0, end).filter((r) => r.src).map(compileRoute),
		postFs:
			fsIndex === -1
				? []
				: config.routes.slice(fsIndex + 1).filter((r) => r.src).map(compileRoute),
	};
}

function substitute(template, match) {
	return template.replace(/\$(\d+)/g, (_, n) => match[Number(n)] ?? '');
}

const isExternalDest = (dest) => /^https?:\/\//.test(dest || '');

const hasValueCache = new Map();
function compileHasValue(value) {
	let re = hasValueCache.get(value);
	if (!re) {
		const caseInsensitive = value.startsWith('(?i)');
		re = new RegExp(caseInsensitive ? value.slice(4) : value, caseInsensitive ? 'i' : undefined);
		hasValueCache.set(value, re);
	}
	return re;
}

// Evaluated against a bare anonymous GET: no cookies, no query string, no
// crawler user-agent. That is deliberately the weakest possible request, so
// `has`-gated rules (the OG-preview rewrites that only fire for social bots,
// the authed-shell rules that need a session cookie) correctly do NOT match.
// A page that only resolves for a logged-in user or a scraper is still a 404
// for the visitor arriving from the sitemap, which is the case we're policing.
function hasMatches(route, host) {
	if (!route.has) return true;
	for (const cond of route.has) {
		let val;
		if (cond.type === 'host') val = host;
		else if (cond.type === 'query' || cond.type === 'header' || cond.type === 'cookie') val = undefined;
		else continue;
		if (val == null) return false;
		if (cond.value !== undefined && !compileHasValue(cond.value).test(val)) return false;
	}
	return true;
}

/** Mirror of server/index.mjs resolveStatic(): exact file, or directory/index.html. */
export function resolveStatic(distRoot, pathname) {
	let rel;
	try {
		rel = decodeURIComponent(pathname);
	} catch {
		return null;
	}
	const abs = path.normalize(path.join(distRoot, rel));
	if (!abs.startsWith(distRoot + path.sep) && abs !== distRoot) return null; // traversal guard
	try {
		let st = statSync(abs);
		let target = abs;
		if (st.isDirectory()) {
			target = path.join(abs, 'index.html');
			st = statSync(target);
		}
		return st.isFile() ? target : null;
	} catch {
		return null;
	}
}

/**
 * Resolve a pathname the way the server would for an anonymous GET.
 *
 * @returns {{outcome: 'redirect'|'external'|'api'|'static'|'notfound', status?: number, target?: string}}
 *   `notfound` means the request fell through to the 404 fallback — the page is
 *   unreachable in this build.
 */
export function resolveRequest(pathname, table, distRoot, { host = 'three.ws' } = {}) {
	let currentPath = pathname;

	for (const route of table.phase1) {
		const m = route.re.exec(currentPath);
		if (!m) continue;
		if (!hasMatches(route, host)) continue;
		if (route.continue) continue;
		if (route.status && !route.dest) return { outcome: 'redirect', status: route.status };
		if (route.dest) {
			const dest = substitute(route.dest, m);
			if (isExternalDest(dest)) return { outcome: 'external', target: dest };
			const qIdx = dest.indexOf('?');
			const next = qIdx === -1 ? dest : dest.slice(0, qIdx);
			// An identity passthrough (`/(.*)` → `/$1`) is not progress; treating it
			// as a rewrite would end phase-1 matching one rule early.
			if (next === currentPath) continue;
			currentPath = next;
			if (route.status && route.status >= 300 && route.status < 400) {
				return { outcome: 'redirect', status: route.status, target: currentPath };
			}
			break;
		}
	}

	if (currentPath.startsWith('/api/')) return { outcome: 'api', target: currentPath };

	const file = resolveStatic(distRoot, currentPath);
	if (file) return { outcome: 'static', target: file };

	return { outcome: 'notfound', target: currentPath };
}

/** Every `path` declared anywhere in data/pages.json, deduped, in document order. */
export function collectDeclaredPaths(rootDir) {
	const pagesFile = path.join(rootDir, 'data', 'pages.json');
	if (!existsSync(pagesFile)) return [];
	const doc = JSON.parse(readFileSync(pagesFile, 'utf8'));
	const found = [];
	(function walk(node) {
		if (Array.isArray(node)) return node.forEach(walk);
		if (node && typeof node === 'object') {
			if (typeof node.path === 'string' && node.path.startsWith('/')) found.push(node.path);
			for (const v of Object.values(node)) walk(v);
		}
	})(doc);
	return [...new Set(found)];
}
