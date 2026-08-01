// Shared Vercel legacy-routes matcher: the single offline model of what
// server/index.mjs does at runtime.
//
// server/index.mjs is production: it reads vercel.json's `routes` array on boot,
// splits it at the {handle:"filesystem"} marker, walks phase 1 with first-match
// semantics, then serves either an api/** handler (Vercel filesystem semantics)
// or a static file, falling back to the post-filesystem rules. Two audits need
// to predict that offline (scripts/verify-routes.mjs for catalog pages,
// scripts/audit-route-shadowing.mjs for api/** handlers). Both import this
// module so there is exactly one matcher to keep in sync with the server.
//
// Kept deliberately parallel to server/index.mjs; when the server's routing
// changes, change it here in the same commit.

import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Route table (server/index.mjs: "vercel.json route table, split at the marker")
// ---------------------------------------------------------------------------

/**
 * Split a vercel.json `routes` array into the two phases the server uses.
 * Each compiled rule keeps its original index so audits can name the offender.
 */
export function loadRouteTable(vercelConfig) {
	const routes = vercelConfig.routes || [];
	const fsIndex = routes.findIndex((r) => r.handle === 'filesystem');
	const compile = (r, index) => {
		let re = null;
		try {
			re = new RegExp(`^${r.src}$`);
		} catch {
			re = null;
		}
		return { ...r, index, re };
	};
	const slice = (from, to) =>
		routes
			.slice(from, to)
			.map((r, i) => compile(r, from + i))
			.filter((r) => r.src && r.re);
	return {
		routes,
		fsIndex,
		phase1Routes: slice(0, fsIndex === -1 ? routes.length : fsIndex),
		postFsRoutes: fsIndex === -1 ? [] : slice(fsIndex + 1, routes.length),
	};
}

/** "$1"-style capture substitution used by dest and header values. */
export function substitute(template, match) {
	return String(template).replace(/\$(\d+)/g, (_, n) => match?.[Number(n)] ?? '');
}

export const isExternalDest = (dest) => /^https?:\/\//.test(dest || '');

// `has[].value` patterns may carry a leading Perl-style `(?i)` inline flag,
// which native RegExp rejects as an invalid group.
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
 * Vercel `has` conditions gate a rule to the requests carrying the query param,
 * header, cookie or host it names. A plain request satisfies none of them, so
 * modeling a default GET means those rules are skipped, which is exactly what
 * production does for that same request.
 */
export function hasMatches(route, req, url) {
	if (!route.has) return true;
	for (const cond of route.has) {
		let val;
		if (cond.type === 'query') val = url.searchParams.get(cond.key);
		else if (cond.type === 'header') val = req.headers?.[cond.key.toLowerCase()];
		else if (cond.type === 'cookie') {
			const raw = req.headers?.cookie || '';
			const m = raw.match(new RegExp(`(?:^|;\\s*)${cond.key}=([^;]*)`));
			val = m ? decodeURIComponent(m[1]) : undefined;
		} else if (cond.type === 'host') val = req.headers?.host;
		else continue;
		if (val == null) return false;
		if (cond.value !== undefined && !compileHasValue(cond.value).test(val)) return false;
	}
	return true;
}

// ---------------------------------------------------------------------------
// api/** filesystem resolution (server/index.mjs: resolveApi + dispatchApi)
// ---------------------------------------------------------------------------

const dirCache = new Map();
function listDir(dir) {
	let entries = dirCache.get(dir);
	if (!entries) {
		entries = readdirSync(dir, { withFileTypes: true });
		dirCache.set(dir, entries);
	}
	return entries;
}

/** Names starting with `_` or `.` are never routable. */
export const isRoutable = (name) => !name.startsWith('_') && !name.startsWith('.');

/**
 * Precedence per segment: exact file > exact dir > [param].js > [param]/ >
 * [...catchall].js.
 */
export function resolveApi(dir, segments, params = {}) {
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
 * Resolve an `/api/...` pathname to the handler file that would run, applying
 * the same segment sanitising the server does (a `.js` suffix on a dest is
 * stripped; `_`/`.`-prefixed, empty, `..` and separator-smuggling segments are
 * rejected outright).
 */
export function resolveApiPath(apiRoot, pathname) {
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
	const hit = resolveApi(apiRoot, segments, {});
	if (hit && !hit.file.startsWith(apiRoot + path.sep)) return null;
	return hit;
}

// ---------------------------------------------------------------------------
// Phase 1 walk (server/index.mjs: the external-dest proxy + the phase-1 loop)
// ---------------------------------------------------------------------------

/**
 * Walk the pre-filesystem rules with first-match semantics.
 *
 * `continue` rules only layer headers on. The first non-continue rule decides:
 * an absolute dest proxies the request out, a `status` without a `dest` ends it
 * (that is how every redirect in this table is expressed: status + a Location
 * header), and a `dest` rewrites the path and ends the phase. A non-continue
 * rule with neither keeps the walk going.
 *
 * @returns {{outcome:'proxy'|'status'|'rewrite'|'passthrough', path:string,
 *   headers:Record<string,string>, extraQuery:Record<string,string>,
 *   status:number|null, rule:object|null}}
 */
export function walkPhase1(phase1Routes, pathname, req, url) {
	const headers = {};
	const extraQuery = {};
	for (const route of phase1Routes) {
		const m = route.re.exec(pathname);
		if (!m) continue;
		if (!hasMatches(route, req, url)) continue;
		if (route.headers) {
			for (const [k, v] of Object.entries(route.headers)) headers[k] = substitute(v, m);
		}
		if (route.continue) continue;
		if (route.dest && isExternalDest(route.dest)) {
			return {
				outcome: 'proxy',
				path: substitute(route.dest, m),
				headers,
				extraQuery,
				status: route.status ?? null,
				rule: route,
			};
		}
		if (route.status && !route.dest) {
			return { outcome: 'status', path: pathname, headers, extraQuery, status: route.status, rule: route };
		}
		if (route.dest) {
			const dest = substitute(route.dest, m);
			const qIdx = dest.indexOf('?');
			if (qIdx !== -1) {
				for (const [k, v] of new URLSearchParams(dest.slice(qIdx + 1))) extraQuery[k] = v;
			}
			return {
				outcome: 'rewrite',
				path: qIdx === -1 ? dest : dest.slice(0, qIdx),
				headers,
				extraQuery,
				status: route.status ?? null,
				rule: route,
			};
		}
	}
	return { outcome: 'passthrough', path: pathname, headers, extraQuery, status: null, rule: null };
}

// ---------------------------------------------------------------------------
// Full request resolution
// ---------------------------------------------------------------------------

/**
 * Predict what production serves for a request.
 *
 * @param {object} table         loadRouteTable() result
 * @param {string} pathname      request path (no query)
 * @param {object} [opts]
 * @param {string} [opts.apiRoot]     absolute path to api/ (enables handler resolution)
 * @param {(p:string)=>boolean} [opts.fileServes]  does the static filesystem serve this path?
 * @param {string} [opts.method]      default 'GET'
 * @param {object} [opts.headers]     request headers (drives `has` host/header rules)
 * @param {string} [opts.search]      raw query string, e.g. '?id=1'
 * @returns {{outcome:string, status?:number, file?:string, dest?:string,
 *   to?:string, rule?:object|null, headers?:object}}
 *   outcome: 'handler' | 'api-missing' | 'file' | 'redirect' | 'status' |
 *            'external' | 'notfound'
 */
export function resolveRequest(table, pathname, opts = {}) {
	const {
		apiRoot = null,
		fileServes = () => false,
		method = 'GET',
		headers: reqHeaders = { host: 'three.ws' },
		search = '',
		collapseTrailingSlash = true,
	} = opts;
	const url = new URL(pathname + search, 'http://internal');
	const req = { method, headers: reqHeaders, url: pathname + search };

	// The trailing-slash collapse runs ahead of the route table for page URLs.
	if (
		collapseTrailingSlash &&
		(method === 'GET' || method === 'HEAD') &&
		pathname.length > 1 &&
		pathname.endsWith('/') &&
		!pathname.startsWith('/api/')
	) {
		return { outcome: 'redirect', status: 301, to: pathname.replace(/\/+$/, '') || '/' };
	}

	const phase1 = walkPhase1(table.phase1Routes, url.pathname, req, url);
	if (phase1.outcome === 'proxy')
		return { outcome: 'external', status: 200, to: phase1.path, rule: phase1.rule };
	if (phase1.outcome === 'status') {
		const location = phase1.rule?.headers?.Location || phase1.rule?.headers?.location;
		if (location)
			return {
				outcome: 'redirect',
				status: phase1.status,
				to: substitute(location, phase1.rule.re.exec(url.pathname)),
				rule: phase1.rule,
			};
		return { outcome: 'status', status: phase1.status, rule: phase1.rule };
	}

	const currentPath = phase1.path;

	if (currentPath.startsWith('/api/')) {
		if (!apiRoot) return { outcome: 'handler', dest: currentPath, rule: phase1.rule };
		const hit = resolveApiPath(apiRoot, currentPath);
		if (hit)
			return { outcome: 'handler', file: hit.file, dest: currentPath, rule: phase1.rule, params: hit.params };
		return { outcome: 'api-missing', status: 404, dest: currentPath, rule: phase1.rule };
	}

	if (method === 'GET' || method === 'HEAD') {
		if (fileServes(currentPath))
			return { outcome: 'file', status: phase1.status || 200, dest: currentPath, rule: phase1.rule };
	}

	for (const route of table.postFsRoutes) {
		const m = route.re.exec(currentPath);
		if (!m) continue;
		if (!hasMatches(route, req, url)) continue;
		if (route.dest) {
			const dest = substitute(route.dest, m);
			if (fileServes(dest))
				return { outcome: 'notfound', status: route.status || 404, dest, rule: route };
		}
		if (route.status) return { outcome: 'notfound', status: route.status, dest: route.dest, rule: route };
	}

	return { outcome: 'notfound', status: 404, dest: '(implicit)' };
}
