// Vercel legacy-routes + filesystem-routing resolution, extracted from
// server/index.mjs so exactly one implementation exists.
// -------------------------------------------------------------------------
// server/index.mjs imports these to serve production traffic. Audit scripts
// (scripts/audit-cron-liveness.mjs, scripts/verify-routes.mjs) import the same
// functions so they test the production resolver rather than a re-implementation
// that can drift away from it. A copy that drifts is worse than no check: it
// reports green on a path production 404s.
//
// Semantics implemented here:
//   - `routes` is split at the {handle: "filesystem"} marker into a phase-1 list
//     (rules that run before the static filesystem) and a post-filesystem list.
//   - "$1"-style capture substitution in `dest` and header values.
//   - `has` conditions (query / header / cookie / host presence + optional
//     regex value), including Perl-style `(?i)` inline flags.
//   - api/** filesystem routing: exact file > exact dir > [param].js >
//     [param]/ > [...catchall].js, with `_`/`.` names never routable.

import { existsSync, statSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Route table
// ---------------------------------------------------------------------------

const compileRoute = (r) => ({ ...r, re: new RegExp(`^${r.src}$`) });

/**
 * Read vercel.json and split its `routes` at the {handle:"filesystem"} marker.
 * @param {string} configPath absolute path to vercel.json
 * @returns {{config: any, phase1Routes: any[], postFsRoutes: any[]}}
 */
export function loadRouteTable(configPath) {
	const config = JSON.parse(readFileSync(configPath, 'utf8'));
	const routes = Array.isArray(config.routes) ? config.routes : [];
	const fsIndex = routes.findIndex((r) => r.handle === 'filesystem');
	const phase1Routes = routes
		.slice(0, fsIndex === -1 ? routes.length : fsIndex)
		.filter((r) => r.src)
		.map(compileRoute);
	const postFsRoutes =
		fsIndex === -1 ? [] : routes.slice(fsIndex + 1).filter((r) => r.src).map(compileRoute);
	return { config, phase1Routes, postFsRoutes };
}

/** "$1"-style capture substitution used by dest and header values. */
export function substitute(template, match) {
	return template.replace(/\$(\d+)/g, (_, n) => match[Number(n)] ?? '');
}

export const isExternalDest = (dest) => /^https?:\/\//.test(dest || '');

// Vercel `has[].value` patterns may carry a leading Perl-style `(?i)` inline
// case-insensitive flag, which native RegExp rejects as an invalid group, 
// strip it and apply the `i` flag instead. Compiled patterns are cached since
// the same route's has[] is re-evaluated on every matching request.
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

/**
 * Vercel `has` conditions gate a route to only the requests it's meant for.
 * Every entry must match against the ORIGINAL request (url/headers),
 * independent of any dest rewrite already applied earlier in the same pass.
 */
export function hasMatches(route, req, url) {
	if (!route.has) return true;
	for (const cond of route.has) {
		let val;
		if (cond.type === 'query') val = url.searchParams.get(cond.key);
		else if (cond.type === 'header') val = req.headers[cond.key.toLowerCase()];
		else if (cond.type === 'cookie') {
			const raw = req.headers.cookie || '';
			const m = raw.match(new RegExp(`(?:^|;\\s*)${cond.key}=([^;]*)`));
			val = m ? decodeURIComponent(m[1]) : undefined;
		} else if (cond.type === 'host') val = req.headers.host;
		else continue;
		if (val == null) return false;
		if (cond.value !== undefined && !compileHasValue(cond.value).test(val)) return false;
	}
	return true;
}

/**
 * Walk the phase-1 rules for one request, exactly as the server does.
 * Returns the path the functions/filesystem phase will see, the collected
 * headers, any query params the winning dest carried, and the status a
 * dest-with-status rewrite pinned.
 *
 * @param {any[]} phase1Routes compiled phase-1 routes
 * @param {{headers?: Record<string,any>}} req request-like object
 * @param {URL} url the request URL
 * @returns {{path: string, headers: Record<string,string>, extraQuery: Record<string,string>,
 *            status: number|null, terminal: 'status'|'external'|null, external: string|null,
 *            matched: any|null}}
 */
export function resolvePhase1(phase1Routes, req, url) {
	let currentPath = url.pathname;
	const headers = {};
	const extraQuery = {};
	let status = null;
	let matched = null;
	for (const route of phase1Routes) {
		const m = route.re.exec(currentPath);
		if (!m) continue;
		if (!hasMatches(route, req, url)) continue;
		if (route.headers) {
			for (const [k, v] of Object.entries(route.headers)) headers[k] = substitute(v, m);
		}
		if (route.continue) continue;
		if (route.status && !route.dest) {
			return { path: currentPath, headers, extraQuery, status: route.status, terminal: 'status', external: null, matched: route };
		}
		if (route.dest) {
			const dest = substitute(route.dest, m);
			matched = route;
			if (isExternalDest(dest)) {
				return { path: currentPath, headers, extraQuery, status: null, terminal: 'external', external: dest, matched: route };
			}
			const qIdx = dest.indexOf('?');
			currentPath = qIdx === -1 ? dest : dest.slice(0, qIdx);
			if (qIdx !== -1) {
				for (const [k, v] of new URLSearchParams(dest.slice(qIdx + 1))) extraQuery[k] = v;
			}
			if (route.status) status = route.status;
			break; // non-continue dest ends phase-1 matching
		}
	}
	return { path: currentPath, headers, extraQuery, status, terminal: null, external: null, matched };
}

// ---------------------------------------------------------------------------
// api/** filesystem routing
// ---------------------------------------------------------------------------

/** @type {Map<string, import('node:fs').Dirent[]>} */
const dirCache = new Map();

function listDir(dir) {
	let entries = dirCache.get(dir);
	if (!entries) {
		entries = readdirSync(dir, { withFileTypes: true });
		dirCache.set(dir, entries);
	}
	return entries;
}

export function isRoutable(name) {
	return !name.startsWith('_') && !name.startsWith('.');
}

/**
 * Resolve api path segments to a handler file, Vercel-style.
 * Precedence: exact file > exact dir > [param].js > [param]/ > [...catchall].js.
 */
export function resolveApi(dir, segments, params) {
	if (segments.length === 0) {
		const index = path.join(dir, 'index.js');
		return existsSync(index) ? { file: index, params } : null;
	}
	const [head, ...rest] = segments;

	if (rest.length === 0) {
		const exact = path.join(dir, `${head}.js`);
		if (existsSync(exact)) return { file: exact, params };
	}

	const exactDir = path.join(dir, head);
	if (existsSync(exactDir) && statSync(exactDir).isDirectory()) {
		const hit = resolveApi(exactDir, rest, params);
		if (hit) return hit;
	}

	const entries = listDir(dir);

	if (rest.length === 0) {
		for (const e of entries) {
			if (!e.isFile() || !isRoutable(e.name)) continue;
			if (e.name.startsWith('[') && e.name.endsWith('].js') && !e.name.startsWith('[...')) {
				const name = e.name.slice(1, -4);
				return { file: path.join(dir, e.name), params: { ...params, [name]: head } };
			}
		}
	}

	for (const e of entries) {
		if (!e.isDirectory() || !isRoutable(e.name)) continue;
		if (e.name.startsWith('[') && e.name.endsWith(']') && !e.name.startsWith('[...')) {
			const name = e.name.slice(1, -1);
			const hit = resolveApi(path.join(dir, e.name), rest, { ...params, [name]: head });
			if (hit) return hit;
		}
	}

	for (const e of entries) {
		if (!e.isFile()) continue;
		if (e.name.startsWith('[...') && e.name.endsWith('].js')) {
			const name = e.name.slice(4, -4);
			return {
				file: path.join(dir, e.name),
				params: { ...params, [name]: [head, ...rest].join('/') },
			};
		}
	}

	return null;
}

/**
 * Split an /api/… pathname into routable segments, applying the same
 * rejection rules the dispatcher uses (empty, `_`/`.`-prefixed, traversal, and
 * separators smuggled in via %2f/%5c).
 * @returns {string[] | null} null when the path is not dispatchable at all.
 */
export function apiSegments(pathname) {
	const apiPath = pathname.endsWith('.js') ? pathname.slice(0, -3) : pathname;
	let segments;
	try {
		segments = apiPath.slice(5).split('/').filter(Boolean).map(decodeURIComponent);
	} catch {
		return null;
	}
	if (
		segments.length === 0 ||
		segments.some((s) => !isRoutable(s) || s === '..' || s.includes('/') || s.includes('\\'))
	)
		return null;
	return segments;
}

/**
 * Resolve an /api/… pathname to its handler file under `apiRoot`, or null.
 * Mirrors dispatchApi()'s resolution half, containment guard included.
 */
export function resolveApiHandler(apiRoot, pathname) {
	const segments = apiSegments(pathname);
	if (!segments) return null;
	const route = resolveApi(apiRoot, segments, {});
	if (!route) return null;
	if (!route.file.startsWith(apiRoot + path.sep)) return null;
	return route;
}
