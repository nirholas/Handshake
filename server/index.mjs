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
//  - req.url is the original path + query, EXCEPT behind a dest rewrite that
//    carries query captures ("/oracle/coin/x" → "/api/oracle-share?mint=$1"):
//    there req.url becomes the rewritten path + merged query, as on Vercel,
//    because handlers parse their params from req.url.
//  - req.query merges URL search params (repeated keys → array), then
//    dest-rewrite query params, then route params — later wins, as on Vercel.
//  - req.body is pre-parsed for JSON / urlencoded / text / octet-stream at
//    an 8 MB limit (Cloud Run's ceiling is 32 MB); multipart and other types
//    stay unconsumed so upload handlers can read the raw stream.
//  - SSE works: compression skips text/event-stream, and the HTTP server's
//    idle timeouts are lifted (Cloud Run enforces the real deadline).
//
// Run locally:  node server/index.mjs   (PORT defaults to 8080)

import express from 'express';
import compression from 'compression';
import { statSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { isSsrRoute, renderSsrPage } from './ssr-pages.mjs';
import { hasSeoRoute, renderSeoHead } from './seo-head.mjs';
import { isMissingShellPage } from './shell-pages.mjs';
import { hardenHeaderBag } from './csp-hashes.mjs';
import { cronEdgeAuth } from './cron-edge-auth.mjs';
// Route resolution lives in its own module so the audit scripts
// (scripts/audit-cron-liveness.mjs) exercise the SAME resolver production runs,
// instead of a copy that can silently drift from it.
import {
	loadRouteTable,
	substitute,
	isExternalDest,
	hasMatches,
	isRoutable,
	resolveApi,
} from './route-resolve.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const API_ROOT = path.join(ROOT, 'api');
const DIST_ROOT = path.join(ROOT, 'dist');
const PORT = Number(process.env.PORT) || 8080;
// 8 MB fits the 6 M-char base64 token image build-metadata's schema accepts
// (base64 inflates raw bytes by 4/3, so the old Vercel-era 4.5 MB limit
// rejected images the schema allowed). Cloud Run's own ceiling is 32 MB.
const BODY_LIMIT = '8mb';

// ---------------------------------------------------------------------------
// vercel.json route table, split at the {handle: "filesystem"} marker.
// ---------------------------------------------------------------------------

const { config: vercelConfig, phase1Routes, postFsRoutes } = loadRouteTable(
	path.join(ROOT, 'vercel.json'),
);

// ---------------------------------------------------------------------------
// External-URL dests (reverse proxy), e.g. /ingest/* → PostHog.
// ---------------------------------------------------------------------------
// Vercel proxies any route whose dest is an absolute URL. This middleware
// replicates that, and MUST run before the body parsers so POST bodies stream
// through unconsumed. It walks the same phase-1 rules with the same first-match
// semantics: only when the first non-continue dest for a path is external does
// it proxy; otherwise it falls through untouched.

// Hop-by-hop headers (RFC 9110 §7.6.1) plus fields the proxied hop recomputes,
// plus `authorization` — this app's bearer/session credential must never leak to
// an external analytics upstream (PostHog). Node lowercases header keys.
const PROXY_SKIP_REQ = new Set([
	'host', 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
	'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length', 'accept-encoding',
	'authorization',
]);
const PROXY_SKIP_RES = new Set([
	'connection', 'keep-alive', 'transfer-encoding', 'content-encoding', 'content-length',
]);

async function proxyExternal(req, res, dest) {
	const headers = {};
	for (const [k, v] of Object.entries(req.headers)) {
		if (!PROXY_SKIP_REQ.has(k)) headers[k] = v;
	}
	// Forward only PostHog's own cookies to the analytics upstream; the app's
	// session (`__Host-sid`) and CSRF cookies must never reach an external host.
	const safeCookie = (req.headers.cookie || '')
		.split(';').map((c) => c.trim()).filter(Boolean)
		.filter((c) => c.startsWith('ph_') || /^__ph/i.test(c))
		.join('; ');
	if (safeCookie) headers.cookie = safeCookie;
	else delete headers.cookie;
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
			const { pipeline } = await import('node:stream/promises');
			// `.pipe()` does not propagate source errors — an upstream reset
			// mid-body would emit an unhandled 'error' and crash the instance.
			// `pipeline` forwards errors and tears both sides down cleanly.
			await pipeline(Readable.fromWeb(upstream.body), res);
		} else {
			res.end();
		}
	} catch (err) {
		// Client aborts and mid-stream upstream resets land here once the body
		// has begun streaming; the status/headers are already sent, so just end
		// the response. Only a pre-stream failure can still emit a 502.
		if (!res.headersSent) {
			console.error(`[proxy] ${req.method} ${req.url} → ${new URL(dest).host} failed:`, err.message);
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
	// Reject empty, non-routable ("_"/"."-prefixed), and traversal segments.
	// decodeURIComponent runs per-segment, so a legit segment can never hold a
	// raw "/" or "\" — an embedded separator means an encoded "%2f"/"%5c" was
	// used to smuggle a compound path past the split. Rejecting it here (and the
	// containment check below) stops "%2f..%2f..%2fvite.config" from escaping
	// API_ROOT to import() an arbitrary server-side .js.
	if (
		segments.length === 0 ||
		segments.some(
			(s) => !isRoutable(s) || s === '..' || s.includes('/') || s.includes('\\'),
		)
	)
		return false;

	const cacheKey = segments.join('/');
	let route = routeCache.get(cacheKey);
	if (route === undefined) {
		route = resolveApi(API_ROOT, segments, {});
		// Defense in depth: never route to a file that resolved outside API_ROOT.
		if (route && !route.file.startsWith(API_ROOT + path.sep)) route = null;
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

// Static HTML gets its CSP tightened to the inline scripts it actually
// contains (see server/csp-hashes.mjs). In production dist/ is immutable for
// the lifetime of a deploy, so each file is read and hashed at most once; the
// response itself still streams from res.sendFile.
//
// The cache is keyed by the file's size and mtime rather than its path alone,
// because "immutable" is only true of the container. Run this server against a
// working tree and a rebuild rewrites dist/ underneath it: sendFile then
// streams the new bytes while the header still carries the old file's hashes,
// and every inline script on that page is blocked. That is a page-blanking
// failure produced entirely by a stale cache, and one statSync per HTML
// response is a cheap way to never see it again.
const staticCspCache = new Map();

function cspForStaticHtml(file) {
	let stamp = '';
	try {
		const st = statSync(file);
		stamp = `${st.size}:${st.mtimeMs}`;
	} catch {
		// Unreadable stat: fall through to a read, which reports its own failure.
	}
	const hit = staticCspCache.get(file);
	if (hit && hit.stamp === stamp) return hit.html;
	let html = null;
	try {
		html = readFileSync(file, 'utf8');
	} catch (err) {
		console.error(`[csp] could not read ${file} for hashing:`, err.message);
	}
	staticCspCache.set(file, { stamp, html });
	return html;
}

function serveFile(req, res, file, headers, status) {
	if (file.endsWith('.html')) {
		const html = cspForStaticHtml(file);
		if (html !== null) hardenHeaderBag(headers, html);
	}
	res.set(headers);
	if (status) res.status(status);
	// Android Digital Asset Links (and the other RFC 8615 discovery files) are
	// re-fetched by Google and by devices on a schedule; a day-long edge TTL
	// means a rotated release key stays unverified for up to 24 hours after a
	// deploy. Google's own guidance caps the TTL at an hour.
	if (file.includes(`${path.sep}.well-known${path.sep}`) && !res.get('cache-control')) {
		res.set('cache-control', 'public, max-age=3600');
	}
	// RFC 8615 discovery files (agent-card.json, ai-plugin.json, security.txt)
	// live under the `.well-known` dot-directory, which Express's dotfiles guard
	// would reject as Forbidden — allow exactly that directory and keep every
	// other dot-segment denied. resolveStatic() already confined `file` to
	// DIST_ROOT, so this loosens nothing else.
	const dotfiles = file.includes(`${path.sep}.well-known${path.sep}`) ? 'allow' : 'deny';
	return new Promise((resolvePromise) => {
		res.sendFile(file, { dotfiles }, (err) => {
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

// Second lock on /api/cron/*, ahead of the route table so no rewritten dest can
// carry an unauthenticated caller past it. Every handler there still runs its
// own requireCron; this exists so that ONE handler forgetting the line is not
// the same thing as publishing a money-moving sweep to the internet. It accepts
// the CRON_SECRET the handlers already validate and, when
// CRON_OIDC_AUDIENCE + CRON_OIDC_SERVICE_ACCOUNT are set, a Cloud Scheduler
// OIDC token. See server/cron-edge-auth.mjs.
app.use(cronEdgeAuth());

app.use(async (req, res) => {
	const url = new URL(req.url, 'http://internal');
	let currentPath = url.pathname;
	const collected = {};
	const extraQuery = {};
	let fileStatus = null;

	// The route table serves /x and /x/ identically via duplicated entries, so
	// every page exists at two URLs and crawlers see duplicate content held
	// together only by canonical tags. Collapse the slash variant permanently.
	// API paths keep their exact form and the root is already bare.
	if (
		(req.method === 'GET' || req.method === 'HEAD') &&
		currentPath.length > 1 &&
		currentPath.endsWith('/') &&
		!currentPath.startsWith('/api/')
	) {
		const bare = currentPath.replace(/\/+$/, '') || '/';
		res.redirect(301, bare + url.search);
		return;
	}

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

	// CORS preflight for the static media routes. Those rules advertise
	// `access-control-allow-methods: GET, HEAD, OPTIONS`, but the filesystem
	// phase below only serves GET/HEAD, so an OPTIONS request fell through to
	// the 404 and every cross-origin fetch carrying a non-safelisted header
	// (a GLTFLoader with setRequestHeader, a fetch with an auth or tracing
	// header) was blocked by the browser even though the GET itself is
	// world-open. Answer the preflight from the headers the route already
	// collected. /api/ paths are excluded: their handlers own their own CORS.
	if (
		req.method === 'OPTIONS' &&
		!currentPath.startsWith('/api/') &&
		collected['access-control-allow-methods']
	) {
		const requested = req.headers['access-control-request-headers'];
		res
			.status(204)
			.set(collected)
			.set({
				'access-control-allow-headers': requested || '*',
				'access-control-max-age': '86400',
				// The route's own long cache-control belongs to the asset, not to
				// this negotiation: a shared cache holding one preflight would
				// answer it for a different requested-header set.
				'cache-control': 'no-store',
				vary: 'Origin, Access-Control-Request-Headers',
			})
			.end();
		return;
	}

	// Functions phase: anything routed under /api/ is a serverless handler.
	if (currentPath.startsWith('/api/')) {
		// Vercel parity: a handler behind a dest rewrite sees the dest's query
		// params on req.url (many handlers — api/oracle-share.js,
		// api/agent-share.js — parse new URL(req.url) rather than req.query), but
		// keeps the ORIGINAL request pathname. Using the dest path here breaks
		// every handler behind a "[param].js"-style dest that routes by path
		// segment: /api/marketplace/categories → dest
		// /api/marketplace/[action]?action=categories made api/marketplace/[action].js
		// parse the literal segment "[action]" as its action and 404
		// (/marketplace, /skills, /economy all lost their category/theme/list
		// calls). Merge the dest query onto the original pathname instead —
		// both handler styles read what they expect.
		if (Object.keys(extraQuery).length > 0) {
			const merged = new URLSearchParams(url.search);
			for (const [k, v] of Object.entries(extraQuery)) merged.set(k, v);
			req.url = `${url.pathname}?${merged.toString()}`;
		}
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
		// /docs/* and /tutorials/* rewrite every slug to one shell, so a typo used
		// to answer 200 with an empty shell instead of a 404. When the article the
		// shell would fetch does not exist, this is not a page: serve whatever the
		// raw path names on disk (/docs/<dir>/index.html), and otherwise skip the
		// filesystem phase so the request lands on the designed 404 below.
		const shellMiss = isMissingShellPage(DIST_ROOT, currentPath, url.pathname);
		const file = shellMiss ? resolveStatic(url.pathname) : resolveStatic(currentPath);
		if (file) {
			// A few directory pages render their whole body from client JS, which
			// leaves crawlers and no-JS visitors an empty shell. For those routes we
			// inject the page's own first view before sending it. Any failure inside
			// falls through to the untouched file, so this can never break a page.
			if (req.method === 'GET' && isSsrRoute(currentPath) && !url.search) {
				try {
					const shell = readFileSync(file, 'utf8');
					const html = await renderSsrPage(currentPath, shell, `http://127.0.0.1:${PORT}`);
					if (html) {
						// Hash the body we are actually sending, not the shell on disk:
						// the injected block carries its own JSON-LD.
						res.set(hardenHeaderBag(collected, html));
						if (fileStatus) res.status(fileStatus);
						res.set('content-type', 'text/html; charset=utf-8');
						// Same freshness the static shell gets from the CDN, but the
						// injected block is only as fresh as its own cache TTL.
						res.set('cache-control', 'public, max-age=60, s-maxage=300');
						res.send(html);
						return;
					}
				} catch (err) {
					console.error(`[ssr] ${currentPath} fell back to the static shell:`, err.message);
				}
			}
			// Shared-shell routes (/docs/*, /tutorials/*) all resolve to one HTML
			// file whose static head names the shell's own route. Rewrite the head
			// for the page actually requested so each route presents its own
			// canonical, title, social card and JSON-LD. Uses the ORIGINAL request
			// path: currentPath is already the dest rewrite (/docs/index.html).
			if (req.method === 'GET' && file.endsWith('.html') && hasSeoRoute(url.pathname)) {
				const html = renderSeoHead(url.pathname, file);
				if (html) {
					// The rewritten head swaps in this route's own JSON-LD block, so
					// the policy has to describe the rewritten bytes.
					res.set(hardenHeaderBag(collected, html));
					if (fileStatus) res.status(fileStatus);
					res.set('content-type', 'text/html; charset=utf-8');
					res.set('cache-control', 'public, max-age=60, s-maxage=300');
					res.send(html);
					return;
				}
			}
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
		// body-parser tags over-limit payloads with type 'entity.too.large'.
		// Surface a specific code + human message so client error paths (which
		// read error/error_description) say something actionable.
		if (err?.type === 'entity.too.large' || status === 413) {
			// Quote BODY_LIMIT rather than a literal: this said "under 4 MB" long
			// after the cap moved to 8 MB, so a caller inside the real limit was
			// told to shrink a payload that was already small enough.
			res.status(413).json({
				error: 'payload_too_large',
				error_description: `Request body is too large. Keep it under ${BODY_LIMIT.toUpperCase().replace('MB', ' MB')}.`,
				message: err.message,
			});
			return;
		}
		// Same reason as the 413 branch above: client error paths read
		// error/error_description, so a body-parser rejection that carried only
		// `message` rendered as an empty reason next to every handler-emitted
		// 4xx on the same endpoint.
		res.status(status).json({
			error: 'bad_request',
			error_description: err.message,
			message: err.message,
		});
		return;
	}
	console.error('[server] unexpected middleware error:', err);
	res.status(500).json({ error: 'internal_error', message: 'The request failed unexpectedly.' });
});

process.on('unhandledRejection', (reason) => {
	console.error('[server] unhandled rejection:', reason);
});

// Last-resort backstop: a stray synchronous throw or an un-listened stream
// 'error' (e.g. an upstream socket reset outside the proxy's own await path)
// must not terminate the container — it would drop every other in-flight
// request. Log and keep serving; Cloud Run recycles unhealthy instances.
process.on('uncaughtException', (err) => {
	console.error('[server] uncaught exception:', err);
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
