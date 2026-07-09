// three.ws production server — Cloud Run replacement for the Vercel runtime.
// -------------------------------------------------------------------------
// Serves the ENTIRE platform from one Express process:
//
//  1. The 1,000+ route table from vercel.json (`routes`) — security headers,
//     clean-URL rewrites (/3d → /3d.html), redirects, /cdn/* → API rewrites,
//     and the 404 fallback — interpreted with Vercel's legacy-routes
//     semantics (phase-1 rules → filesystem → post-filesystem rules).
//  2. The static frontend from dist/ (Vite build output).
//  3. Every serverless handler under api/** with Vercel filesystem-routing
//     semantics, so handlers run unmodified:
//        /api/foo          → api/foo.js        (or api/foo/index.js)
//        /api/agents/abc   → api/agents/[id].js  (params merged into req.query)
//        /api/v1/x/a/b/c   → api/v1/x/[...slug].js (slug = "a/b/c")
//     Precedence per segment: exact file > exact dir > [param].js > [param]/
//     > [...catchall].js. Names starting with `_` or `.` are never routable.
//
// Request/response parity notes:
//  - req.url is the untouched original path + query (handlers parse it).
//  - req.query merges URL search params (repeated keys → array), then
//    dest-rewrite query params, then route params — later wins, as on Vercel.
//  - req.body is pre-parsed for JSON / urlencoded / text / octet-stream at
//    Vercel's 4.5 MB limit; multipart and other types stay unconsumed so
//    upload handlers can read the raw stream.
//  - SSE works: compression skips text/event-stream, and the HTTP server's
//    idle timeouts are lifted (Cloud Run enforces the real deadline).
//
// Run locally:  node server/index.mjs   (PORT defaults to 8080)

import express from 'express';
import compression from 'compression';
import { existsSync, statSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const API_ROOT = path.join(ROOT, 'api');
const DIST_ROOT = path.join(ROOT, 'dist');
const PORT = Number(process.env.PORT) || 8080;
const BODY_LIMIT = '4.5mb'; // Vercel serverless body limit

// ---------------------------------------------------------------------------
// vercel.json route table, split at the {handle: "filesystem"} marker.
// ---------------------------------------------------------------------------

const vercelConfig = JSON.parse(readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
const fsIndex = vercelConfig.routes.findIndex((r) => r.handle === 'filesystem');
const compileRoute = (r) => ({ ...r, re: new RegExp(`^${r.src}$`) });
const phase1Routes = vercelConfig.routes
	.slice(0, fsIndex === -1 ? vercelConfig.routes.length : fsIndex)
	.filter((r) => r.src)
	.map(compileRoute);
const postFsRoutes =
	fsIndex === -1
		? []
		: vercelConfig.routes
				.slice(fsIndex + 1)
				.filter((r) => r.src)
				.map(compileRoute);

// "$1"-style capture substitution used by dest and header values.
function substitute(template, match) {
	return template.replace(/\$(\d+)/g, (_, n) => match[Number(n)] ?? '');
}

const isExternalDest = (dest) => /^https?:\/\//.test(dest || '');

// Vercel `has` conditions (query/header/cookie/host presence + optional regex
// value) gate a route to only the requests it's meant for — e.g. the /app and
// /agents/:id OG rules only fire for social-preview bots. Every entry must
// match against the ORIGINAL request (url/headers), independent of any dest
// rewrite already applied earlier in the same phase-1 pass.
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

// Vercel `has[].value` patterns may carry a leading Perl-style `(?i)` inline
// case-insensitive flag, which native RegExp rejects as an invalid group —
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

// ---------------------------------------------------------------------------
// External-URL dests (reverse proxy), e.g. /ingest/* → PostHog.
// ---------------------------------------------------------------------------
// Vercel proxies any route whose dest is an absolute URL. This middleware
// replicates that, and MUST run before the body parsers so POST bodies stream
// through unconsumed. It walks the same phase-1 rules with the same first-match
// semantics: only when the first non-continue dest for a path is external does
// it proxy; otherwise it falls through untouched.

// Hop-by-hop headers (RFC 9110 §7.6.1) plus fields the proxied hop recomputes.
const PROXY_SKIP_REQ = new Set([
	'host', 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
	'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length', 'accept-encoding',
]);
const PROXY_SKIP_RES = new Set([
	'connection', 'keep-alive', 'transfer-encoding', 'content-encoding', 'content-length',
]);

async function proxyExternal(req, res, dest) {
	const headers = {};
	for (const [k, v] of Object.entries(req.headers)) {
		if (!PROXY_SKIP_REQ.has(k)) headers[k] = v;
	}
	const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
	try {
		const upstream = await fetch(dest, {
			method: req.method,
			headers,
			body: hasBody ? req : undefined,
			duplex: hasBody ? 'half' : undefined,
			redirect: 'manual',
			signal: AbortSignal.timeout(30_000),
		});
		res.status(upstream.status);
		for (const [k, v] of upstream.headers) {
			if (!PROXY_SKIP_RES.has(k)) res.setHeader(k, v);
		}
		if (upstream.body) {
			const { Readable } = await import('node:stream');
			Readable.fromWeb(upstream.body).pipe(res);
		} else {
			res.end();
		}
	} catch (err) {
		console.error(`[proxy] ${req.method} ${req.url} → ${new URL(dest).host} failed:`, err.message);
		if (!res.headersSent) {
			res.status(502).json({ error: 'bad_gateway', message: 'Upstream request failed.' });
		} else if (!res.writableEnded) {
			res.end();
		}
	}
}

// ---------------------------------------------------------------------------
// API route resolution (Vercel filesystem semantics) with caches.
// ---------------------------------------------------------------------------

/** @type {Map<string, {file: string, params: Record<string, string>} | null>} */
const routeCache = new Map();
/** @type {Map<string, Promise<any>>} */
const moduleCache = new Map();
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

function isRoutable(name) {
	return !name.startsWith('_') && !name.startsWith('.');
}

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

async function dispatchApi(req, res, pathname, extraQuery) {
	// Route-table dests may target the file directly ("/api/x402/service.js").
	const apiPath = pathname.endsWith('.js') ? pathname.slice(0, -3) : pathname;
	let segments;
	try {
		segments = apiPath.slice(5).split('/').filter(Boolean).map(decodeURIComponent);
	} catch {
		res.status(400).json({ error: 'bad_request', message: 'Malformed URL encoding.' });
		return true;
	}
	if (segments.length === 0 || segments.some((s) => !isRoutable(s) || s === '..')) return false;

	const cacheKey = segments.join('/');
	let route = routeCache.get(cacheKey);
	if (route === undefined) {
		route = resolveApi(API_ROOT, segments, {});
		routeCache.set(cacheKey, route);
	}
	if (!route) return false;

	// req.query: search params (repeated keys → array), then dest-rewrite
	// query, then route params — later wins, matching Vercel. Express 5
	// defines `query` as a prototype getter, so shadow it.
	const url = new URL(req.url, 'http://internal');
	const query = {};
	for (const key of new Set(url.searchParams.keys())) {
		const all = url.searchParams.getAll(key);
		query[key] = all.length > 1 ? all : all[0];
	}
	Object.assign(query, extraQuery, route.params);
	Object.defineProperty(req, 'query', { value: query, writable: true, configurable: true });

	try {
		let mod = moduleCache.get(route.file);
		if (!mod) {
			mod = import(pathToFileURL(route.file).href);
			moduleCache.set(route.file, mod);
		}
		const handler = (await mod).default;
		if (typeof handler !== 'function') {
			console.error(`[api] ${route.file} has no default-export handler`);
			res.status(500).json({ error: 'internal_error', message: 'Handler misconfigured.' });
			return true;
		}
		await handler(req, res);
	} catch (err) {
		console.error(`[api] ${req.method} ${pathname} failed:`, err);
		if (!res.headersSent) {
			res.status(500).json({
				error: 'internal_error',
				message: 'The request failed unexpectedly.',
			});
		} else if (!res.writableEnded) {
			res.end();
		}
	}
	return true;
}

// ---------------------------------------------------------------------------
// Static file serving from dist/ (the filesystem phase).
// ---------------------------------------------------------------------------

function resolveStatic(pathname) {
	let rel;
	try {
		rel = decodeURIComponent(pathname);
	} catch {
		return null;
	}
	const abs = path.normalize(path.join(DIST_ROOT, rel));
	if (!abs.startsWith(DIST_ROOT + path.sep) && abs !== DIST_ROOT) return null; // traversal guard
	let target = abs;
	try {
		let st = statSync(target);
		if (st.isDirectory()) {
			target = path.join(target, 'index.html');
			st = statSync(target);
		}
		return st.isFile() ? target : null;
	} catch {
		return null;
	}
}

function serveFile(req, res, file, headers, status) {
	res.set(headers);
	if (status) res.status(status);
	return new Promise((resolvePromise) => {
		res.sendFile(file, { dotfiles: 'deny' }, (err) => {
			if (err && !res.headersSent) {
				console.error(`[static] ${req.method} ${req.url} → ${file} failed:`, err.message);
				res.status(500).end();
			}
			resolvePromise();
		});
	});
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();
app.set('trust proxy', true); // Cloud Run sits behind Google front ends
app.disable('x-powered-by');

// Default filter already skips non-compressible types (text/event-stream,
// images, GLB), so SSE and binary assets pass through untouched.
app.use(compression());

// External-dest proxy — before the body parsers (see proxyExternal above).
app.use((req, res, next) => {
	const url = new URL(req.url, 'http://internal');
	const pathname = url.pathname;
	for (const route of phase1Routes) {
		const m = route.re.exec(pathname);
		if (!m) continue;
		if (!hasMatches(route, req, url)) continue;
		if (route.continue) continue;
		if (!route.dest || !isExternalDest(route.dest)) break; // a local rule wins — fall through
		const search = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
		proxyExternal(req, res, substitute(route.dest, m) + search);
		return;
	}
	next();
});

// Vercel-parity body parsing. Types not listed (multipart, image/*, …) are
// left unparsed so handlers can consume the raw request stream.
//
// `verify` stashes the exact raw bytes on req.rawBody before they're parsed —
// a handful of handlers (webhook signature verification: api/webhooks/*.js)
// need the byte-for-byte body, which a re-serialized req.body can't
// reconstruct (whitespace/key-order differ). Every other handler reads the
// body via api/_lib/http.js readJson()/readBody(), which prefers req.rawBody
// (falling back to reconstructing from req.body) instead of re-reading the
// stream — reading the stream here already fully drains it, so a second read
// downstream would hang forever waiting for 'data'/'end' events that already
// fired.
const captureRawBody = (req, _res, buf) => { req.rawBody = buf; };
app.use(express.json({ limit: BODY_LIMIT, verify: captureRawBody }));
app.use(express.urlencoded({ extended: true, limit: BODY_LIMIT, verify: captureRawBody }));
app.use(express.text({ type: 'text/*', limit: BODY_LIMIT }));
app.use(express.raw({ type: 'application/octet-stream', limit: BODY_LIMIT }));

app.use(async (req, res) => {
	const url = new URL(req.url, 'http://internal');
	let currentPath = url.pathname;
	const collected = {};
	const extraQuery = {};
	let fileStatus = null;

	// Phase 1: rules before {handle: "filesystem"}.
	for (const route of phase1Routes) {
		const m = route.re.exec(currentPath);
		if (!m) continue;
		if (!hasMatches(route, req, url)) continue;
		if (route.headers) {
			for (const [k, v] of Object.entries(route.headers)) collected[k] = substitute(v, m);
		}
		if (route.continue) continue;
		if (route.status && !route.dest) {
			res.status(route.status).set(collected).end();
			return;
		}
		if (route.dest) {
			const dest = substitute(route.dest, m);
			const qIdx = dest.indexOf('?');
			currentPath = qIdx === -1 ? dest : dest.slice(0, qIdx);
			if (qIdx !== -1) {
				for (const [k, v] of new URLSearchParams(dest.slice(qIdx + 1))) extraQuery[k] = v;
			}
			if (route.status) fileStatus = route.status;
			break; // non-continue dest ends phase-1 matching
		}
	}

	// Functions phase: anything routed under /api/ is a serverless handler.
	if (currentPath.startsWith('/api/')) {
		res.set(collected);
		if (await dispatchApi(req, res, currentPath, extraQuery)) return;
		res.status(404).json({
			error: 'not_found',
			message: `No API route matches ${currentPath}.`,
		});
		return;
	}

	// Filesystem phase (GET/HEAD only, like a static host).
	if (req.method === 'GET' || req.method === 'HEAD') {
		const file = resolveStatic(currentPath);
		if (file) {
			await serveFile(req, res, file, collected, fileStatus);
			return;
		}
	}

	// Post-filesystem rules (the 404.html fallback).
	for (const route of postFsRoutes) {
		const m = route.re.exec(currentPath);
		if (!m) continue;
		if (!hasMatches(route, req, url)) continue;
		if (route.headers) {
			for (const [k, v] of Object.entries(route.headers)) collected[k] = substitute(v, m);
		}
		if (route.dest) {
			const file = resolveStatic(substitute(route.dest, m));
			if (file) {
				await serveFile(req, res, file, collected, route.status || 404);
				return;
			}
		}
		if (route.status) {
			res.status(route.status).set(collected).end();
			return;
		}
	}

	res.status(404).set(collected).type('text/plain').send('Not found');
});

// Body-parser failures (malformed JSON, over-limit payloads) → clean 4xx.
app.use((err, req, res, next) => {
	if (res.headersSent) return next(err);
	const status = err?.status || err?.statusCode;
	if (status && status >= 400 && status < 500) {
		res.status(status).json({ error: 'bad_request', message: err.message });
		return;
	}
	console.error('[server] unexpected middleware error:', err);
	res.status(500).json({ error: 'internal_error', message: 'The request failed unexpectedly.' });
});

process.on('unhandledRejection', (reason) => {
	console.error('[server] unhandled rejection:', reason);
});

const server = app.listen(PORT, () => {
	console.log(
		`[server] three-ws listening on :${PORT} (api: ${API_ROOT}, static: ${DIST_ROOT}, routes: ${phase1Routes.length}+${postFsRoutes.length})`,
	);
});
// SSE endpoints hold connections open; keep Node's idle timeouts out of the way
// (Cloud Run enforces the real request deadline).
server.requestTimeout = 0;
server.headersTimeout = 65_000;
server.keepAliveTimeout = 620_000;

// Cloud Run sends SIGTERM before scale-down; finish in-flight work, then exit.
process.on('SIGTERM', () => {
	console.log('[server] SIGTERM received, draining…');
	server.close(() => process.exit(0));
	setTimeout(() => process.exit(0), 10_000).unref();
});
