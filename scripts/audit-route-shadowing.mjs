#!/usr/bin/env node
// Audit: which api/** handlers are routed but can never execute?
//
// A handler is "shadowed" when the production router, walking vercel.json's
// `routes` table in order, sends the handler's own canonical URL somewhere else:
// to a different handler, to a static page, to an external proxy, or to a bare
// status. The handler file exists, it looks routed, and it never runs.
//
// This script replicates server/index.mjs's matching algorithm exactly:
//   1. Split `routes` at the {handle:"filesystem"} marker into phase 1 / post-fs.
//   2. Phase 1, in order: `continue` rules only collect headers; the first
//      non-continue rule with a `dest` rewrites the path and ENDS phase 1; a
//      non-continue rule with `status` and no `dest` ends the request outright.
//      `has` conditions gate a rule to requests carrying the query/header/cookie
//      /host it names, so a plain request skips those rules entirely.
//   3. If the rewritten path is still under /api/, it is dispatched with Vercel
//      filesystem semantics: exact file > exact dir > [param].js > [param]/ >
//      [...catchall].js, with `_`- and `.`-prefixed names never routable.
//
// Dynamic handlers are probed with several concrete segment values, because a
// route-table regex may accept one shape of id and reject another. A handler is
// only reported as fully shadowed when EVERY probe value is diverted; when some
// values reach it and others do not, it is reported as partially shadowed.
//
// Usage:
//   node scripts/audit-route-shadowing.mjs            # human-readable report
//   node scripts/audit-route-shadowing.mjs --json     # machine-readable
//   node scripts/audit-route-shadowing.mjs --all      # include partial hits
//
// Exit code 1 when at least one fully shadowed handler is found.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const API_ROOT = path.join(ROOT, 'api');

// ---------------------------------------------------------------------------
// Route table (mirrors server/index.mjs lines 55-113)
// ---------------------------------------------------------------------------

const vercelConfig = JSON.parse(readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
const fsIndex = vercelConfig.routes.findIndex((r) => r.handle === 'filesystem');
const compileRoute = (r, index) => ({ ...r, index, re: new RegExp(`^${r.src}$`) });
const phase1Routes = vercelConfig.routes
	.slice(0, fsIndex === -1 ? vercelConfig.routes.length : fsIndex)
	.map((r, index) => ({ r, index }))
	.filter(({ r }) => r.src)
	.map(({ r, index }) => compileRoute(r, index));

const substitute = (template, match) =>
	template.replace(/\$(\d+)/g, (_, n) => match[Number(n)] ?? '');

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

// A plain request carries no extra query, no auth header and no cookie, so any
// `has`-gated rule is skipped, exactly as it is in production for that request.
function hasMatches(route, req, url) {
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

// ---------------------------------------------------------------------------
// Filesystem resolution (mirrors server/index.mjs lines 197-261)
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

const isRoutable = (name) => !name.startsWith('_') && !name.startsWith('.');

function resolveApi(dir, segments, params) {
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

function dispatchTarget(pathname) {
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
	const route = resolveApi(API_ROOT, segments, {});
	if (route && !route.file.startsWith(API_ROOT + path.sep)) return null;
	return route;
}

// ---------------------------------------------------------------------------
// Full request resolution (mirrors the express handler, lines 429-501)
// ---------------------------------------------------------------------------

/**
 * Resolve a request path the way production does.
 * @returns {{outcome: string, file?: string, dest?: string, rule?: object}}
 *   outcome: 'handler' | 'no-handler' | 'static' | 'status' | 'external' | 'redirect'
 */
function resolveRequest(pathname, { method = 'GET', headers = { host: 'three.ws' } } = {}) {
	const url = new URL(pathname, 'http://internal');
	const req = { method, headers, url: pathname };
	let currentPath = url.pathname;
	let matchedRule = null;

	// The external-dest proxy middleware walks phase 1 with the same first-match
	// semantics and hijacks the request when the winning dest is absolute.
	for (const route of phase1Routes) {
		const m = route.re.exec(currentPath);
		if (!m) continue;
		if (!hasMatches(route, req, url)) continue;
		if (route.continue) continue;
		if (!route.dest || !isExternalDest(route.dest)) break;
		return { outcome: 'external', dest: substitute(route.dest, m), rule: route };
	}

	// Trailing-slash collapse (non-/api only).
	if (
		(method === 'GET' || method === 'HEAD') &&
		currentPath.length > 1 &&
		currentPath.endsWith('/') &&
		!currentPath.startsWith('/api/')
	) {
		return { outcome: 'redirect', dest: currentPath.replace(/\/+$/, '') || '/' };
	}

	for (const route of phase1Routes) {
		const m = route.re.exec(currentPath);
		if (!m) continue;
		if (!hasMatches(route, req, url)) continue;
		if (route.continue) continue;
		if (route.status && !route.dest) {
			return { outcome: 'status', status: route.status, rule: route };
		}
		if (route.dest) {
			const dest = substitute(route.dest, m);
			const qIdx = dest.indexOf('?');
			currentPath = qIdx === -1 ? dest : dest.slice(0, qIdx);
			matchedRule = route;
			break;
		}
	}

	if (currentPath.startsWith('/api/')) {
		const hit = dispatchTarget(currentPath);
		if (hit) return { outcome: 'handler', file: hit.file, dest: currentPath, rule: matchedRule };
		return { outcome: 'no-handler', dest: currentPath, rule: matchedRule };
	}
	return { outcome: 'static', dest: currentPath, rule: matchedRule };
}

// ---------------------------------------------------------------------------
// Handler enumeration
// ---------------------------------------------------------------------------

// Probe values for a [param] segment. A route-table regex may accept one shape
// and reject another (`([a-z0-9-]+)` vs `(\d+)` vs a base58 mint), so every
// dynamic handler is tested against all of them.
const PROBE_VALUES = ['probehandler1', '1234567890', 'Probe-Test_9', 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump'];

function collectHandlers(dir, urlSegments, out) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (!isRoutable(entry.name)) continue;
		const abs = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			collectHandlers(abs, [...urlSegments, entry.name], out);
			continue;
		}
		if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
		const base = entry.name.slice(0, -3);
		if (base === 'index') out.push({ file: abs, segments: [...urlSegments] });
		else out.push({ file: abs, segments: [...urlSegments, base] });
	}
	return out;
}

// Turn a handler's path segments into concrete request paths, one per probe
// value (static handlers yield exactly one path).
function candidatePaths(segments) {
	const dynamic = segments.some((s) => s.startsWith('['));
	const probes = dynamic ? PROBE_VALUES : [PROBE_VALUES[0]];
	return probes.map((probe) => {
		const parts = [];
		for (const s of segments) {
			if (s.startsWith('[...') && s.endsWith(']')) parts.push(probe, 'sub');
			else if (s.startsWith('[') && s.endsWith(']')) parts.push(probe);
			else parts.push(s);
		}
		return { probe, path: `/api/${parts.join('/')}` };
	});
}

function describe(result) {
	switch (result.outcome) {
		case 'handler':
			return `handler ${path.relative(ROOT, result.file)}`;
		case 'no-handler':
			return `404 (rewritten to ${result.dest}, no handler)`;
		case 'static':
			return `static/page ${result.dest}`;
		case 'status':
			return `status ${result.status}`;
		case 'external':
			return `external proxy ${result.dest}`;
		case 'redirect':
			return `redirect ${result.dest}`;
		default:
			return result.outcome;
	}
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const handlers = collectHandlers(API_ROOT, [], []);
const full = [];
const partial = [];

for (const h of handlers) {
	const rel = path.relative(ROOT, h.file);
	const probes = candidatePaths(h.segments).map((c) => {
		const result = resolveRequest(c.path);
		const reached = result.outcome === 'handler' && result.file === h.file;
		return { ...c, result, reached };
	});
	const reachedCount = probes.filter((p) => p.reached).length;
	if (reachedCount === probes.length) continue;
	const rule = probes.find((p) => !p.reached)?.result.rule;
	const record = {
		handler: rel,
		canonical: probes[0].path,
		reachedWith: probes.filter((p) => p.reached).map((p) => p.path),
		divertedTo: probes
			.filter((p) => !p.reached)
			.map((p) => ({ path: p.path, to: describe(p.result), outcome: p.result.outcome })),
		rule: rule ? { index: rule.index, src: rule.src, dest: rule.dest ?? null } : null,
	};
	if (reachedCount === 0) full.push(record);
	else partial.push(record);
}

const asJson = process.argv.includes('--json');
const showAll = process.argv.includes('--all');

if (asJson) {
	console.log(JSON.stringify({ scanned: handlers.length, full, partial }, null, 2));
} else {
	console.log(`Scanned ${handlers.length} routable handlers under api/.\n`);
	console.log(`Fully shadowed (no request shape reaches them): ${full.length}`);
	for (const r of full) {
		console.log(`\n  ${r.handler}`);
		for (const d of r.divertedTo) console.log(`    ${d.path}  ->  ${d.to}`);
		if (r.rule) console.log(`    rule #${r.rule.index}: ${r.rule.src}  ->  ${r.rule.dest}`);
	}
	console.log(`\nPartially shadowed (some id shapes diverted): ${partial.length}`);
	if (showAll) {
		for (const r of partial) {
			console.log(`\n  ${r.handler}`);
			for (const d of r.divertedTo) console.log(`    ${d.path}  ->  ${d.to}`);
			if (r.rule) console.log(`    rule #${r.rule.index}: ${r.rule.src}  ->  ${r.rule.dest}`);
		}
	} else if (partial.length) {
		console.log('  (re-run with --all to list them)');
	}
}

process.exit(full.length > 0 ? 1 : 0);
