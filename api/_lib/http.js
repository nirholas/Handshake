// @ts-check
// HTTP helpers for Vercel Node handlers. Keeps handlers small + consistent.

import { webcrypto } from 'node:crypto';
import { env } from './env.js';
import { captureException } from './sentry.js';
import { sendOpsAlert } from './alerts.js';
import { instrument as zauthInstrument, drain as zauthDrain } from './zauth.js';
import { isDbUnavailableError, isDbCapacityError, isStoragePressured } from './db.js';
import { redactUrlSecrets } from './scrub-secrets.js';
import { provenanceHeaders, withProvenance } from './brownout/provenance.js';
import { CHAOS_HEADER, CHAOS_STATUS_HEADER, chaosDecision, withChaos } from './brownout/chaos.js';

// Secure-by-default caching: emit `no-store` UNLESS the handler already set a
// Cache-Control header (e.g. `res.setHeader('cache-control', 'public, s-maxage=…')`
// on a public read) or passes one via `headers`. Previously this unconditionally
// forced `no-store`, silently overriding any cache header a handler set just
// before calling json()/text() — so public reads like /u/:username were never
// CDN-cacheable. Error responses must NEVER be cached, so error()/serverError()/
// validationError() pass an explicit `cache-control: no-store` in `headers`,
// which wins via the loop below regardless of what the success path set.
function applyCacheControl(res, headers) {
	const fromArg = Object.keys(headers).some((k) => k.toLowerCase() === 'cache-control');
	// `getHeader` is always present on a real Node ServerResponse; guard so a
	// minimal mock without it still gets the secure default rather than throwing.
	const alreadySet = typeof res.getHeader === 'function' && res.getHeader('cache-control');
	if (!fromArg && !alreadySet) {
		res.setHeader('cache-control', 'no-store');
	}
}

export function json(res, status, body, headers = {}) {
	// Once the response is committed (a handler already streamed/wrote a head, or
	// an error path fires after a success path), setting headers again throws
	// ERR_HTTP_HEADERS_SENT and crashes the invocation. The first response stands;
	// a second send is always a bug whose only safe outcome is a no-op. Guard here
	// so this can never escalate a benign double-send into an unhandled 500.
	if (res.headersSent || res.writableEnded) {
		if (!res.writableEnded) res.end();
		return;
	}
	res.statusCode = status;
	res.setHeader('content-type', 'application/json; charset=utf-8');
	applyCacheControl(res, headers);
	res.setHeader('x-content-type-options', 'nosniff');
	res.setHeader('x-frame-options', 'DENY');
	res.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
	for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
	res.end(JSON.stringify(body));
}

export function text(res, status, body, headers = {}) {
	res.statusCode = status;
	res.setHeader('content-type', 'text/plain; charset=utf-8');
	applyCacheControl(res, headers);
	res.setHeader('x-content-type-options', 'nosniff');
	res.setHeader('x-frame-options', 'DENY');
	res.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
	for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
	res.end(body);
}

export function redirect(res, location, status = 302) {
	res.statusCode = status;
	res.setHeader('location', location);
	res.setHeader('cache-control', 'no-store');
	res.end();
}

export function error(res, status, code, message, extra = {}) {
	// Error responses must never be cached, even on a handler that set a permissive
	// Cache-Control on its success path before hitting this error branch.
	return json(res, status, { error: code, error_description: message, ...extra }, { 'cache-control': 'no-store' });
}

// Query params that can carry a credential, a wallet secret, an email, or a
// user's real-world position. These must never reach a log line, Sentry event,
// or ops alert — all off-box sinks — so they are stripped from any request URL
// we log. Keys are compared after normalizing away case and `_`/`-` separators
// (see isSensitiveQueryKey), so `api-key`, `api_key`, and `apiKey` all collapse
// to one entry here and a new casing variant can't slip a secret through.
const SENSITIVE_QUERY_KEYS = new Set([
	// precise geolocation
	'lat', 'lng', 'latitude', 'longitude', 'll', 'coords', 'coord',
	'originlat', 'originlng', 'geo', 'location', 'position',
	// bearer / session credentials
	'token', 'devicetoken', 'accesstoken', 'refreshtoken', 'idtoken',
	'authorization', 'auth', 'bearer', 'session', 'sessionid', 'sid',
	'password', 'passwd', 'pwd', 'pin', 'otp',
	// API keys / signing secrets
	'apikey', 'key', 'accesskey', 'secret', 'clientsecret', 'signature', 'sig',
	// wallet secrets
	'privatekey', 'secretkey', 'mnemonic', 'seed', 'seedphrase', 'keypair',
	// PII
	'email',
]);

// Normalize a query key to its case/separator-insensitive form before matching,
// so `deviceToken`, `device_token`, and `device-token` are one key.
function isSensitiveQueryKey(key) {
	return SENSITIVE_QUERY_KEYS.has(key.toLowerCase().replace(/[_-]/g, ''));
}

// Reduce a request URL to a log-safe form: keep the path and any benign params,
// but redact values that reveal a location or a credential. A geolocated read
// such as /api/irl/pins?lat=…&lng=…&deviceToken=… would otherwise spill the
// caller's exact position AND their device token into console / Sentry / Telegram
// on any 5xx — so every place req.url flows to a log sink routes through here.
export function redactUrl(rawUrl) {
	const url = String(rawUrl ?? '');
	const qIdx = url.indexOf('?');
	if (qIdx < 0) return url;
	const path = url.slice(0, qIdx);
	let params;
	try {
		params = new URLSearchParams(url.slice(qIdx + 1));
	} catch {
		// Unparseable query → don't risk logging the raw (possibly sensitive) tail.
		return `${path}?REDACTED`;
	}
	let touched = false;
	for (const key of [...params.keys()]) {
		if (isSensitiveQueryKey(key)) {
			params.set(key, 'REDACTED');
			touched = true;
		}
	}
	if (!touched) return url;
	const qs = params.toString();
	return qs ? `${path}?${qs}` : path;
}

// Distinguish a real top-level browser navigation from a programmatic API / agent
// call. Browsers stamp `Sec-Fetch-Mode: navigate` ONLY on top-level navigations;
// fetch()/XHR send cors|same-origin|no-cors. Clients without Sec-Fetch headers
// fall back to an Accept that prefers HTML. Used so a human who hits a 5xx is
// sent to the branded /500 page (carrying their support ref) while every API /
// agent caller keeps receiving the JSON error envelope it expects.
export function wantsHtmlNavigation(req) {
	const m = req?.method || 'GET';
	if (m !== 'GET' && m !== 'HEAD') return false;
	const mode = req?.headers?.['sec-fetch-mode'];
	if (mode) return mode === 'navigate';
	const accept = String(req?.headers?.['accept'] || '');
	return accept.includes('text/html');
}

// Build the /500 redirect target for a browser navigation that 5xx'd: the ref so
// the page can show + copy it, and the original (redacted) path so "Try again"
// retries the request that actually failed. redactUrl() keeps geo / tokens out of
// this URL too, since it ends up in the address bar and any referrer log.
function serverErrorPageLocation(ref, req) {
	const from = redactUrl(req?.url || '/').slice(0, 512);
	// Target the static file directly (public/500.html → /500.html is always
	// served by Vercel) so the error page never depends on a rewrite rule. The
	// `/500` clean URL also works for direct links, but the redirect can't rely
	// on it being configured.
	return `/500.html?ref=${encodeURIComponent(ref)}&from=${encodeURIComponent(from)}`;
}

// Short, URL-safe correlation id for tying a sanitized 5xx response back to the
// full server-side log line. Not security-sensitive — just needs to be unique.
function correlationId() {
	const b = new Uint8Array(8);
	/** @type {Crypto} */ (globalThis.crypto || webcrypto).getRandomValues(b);
	return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

// Throttle the log line for a database-unavailable outage to one per scope per
// minute (per warm lambda instance). A missing/rotated DATABASE_URL makes every
// DB-backed read reject, so without this a single misconfiguration produced
// thousands of identical `[api] unhandled` error lines + Sentry events in a few
// minutes — drowning real faults. The outage is already surfaced once via the
// deduped `db:unavailable` ops alert; here we only need a breadcrumb, at warn.
const _dbDownLoggedAt = new Map();
function logDbUnavailableOnce(scope, msg) {
	const now = Date.now();
	const last = _dbDownLoggedAt.get(scope) || 0;
	if (now - last < 60_000) return;
	_dbDownLoggedAt.set(scope, now);
	// Bound the map so a high-cardinality scope set (many distinct URLs) can't
	// grow it unbounded across a long-lived warm instance.
	if (_dbDownLoggedAt.size > 256) _dbDownLoggedAt.clear();
	console.warn(`[api] database unavailable — degrading ${scope}: ${msg}`);
}

// Log + capture + alert a server fault under a fresh correlation id WITHOUT
// writing a response, and return the ref. The body-writing helpers below build
// on this, but it's also the seam for handlers that must answer in a non-JSON
// content type (RSS/XML, sitemap text, JSON-RPC, MCP) and so can't call
// serverError(): they catch internally, call this to land the same log line +
// Sentry event + deduped ops alert, then echo `ref` in their own envelope. That
// keeps acceptance criterion #1 — every 5xx gets a ref/capture/alert — true for
// boundaries that never reach wrap(). `context` is merged into the Sentry extra
// (callers redact URLs via redactUrl() before passing them here).
export function reportServerError(err, { code = 'internal_error', status = 500, context = {} } = {}) {
	const ref = correlationId();
	// Mask URL-embedded credentials before the message reaches ANY sink (console,
	// Sentry, ops alert). Solana web3.js and fetch put the full request URL in
	// their network errors, so an on-chain failure would otherwise print the keyed
	// RPC endpoint (HELIUS_API_KEY) into logs. Applied here, at the single shared
	// sink, so every handler is covered rather than each remembering to redact.
	const rawDetail = err?.message || String(err ?? 'unknown error');
	const detail = redactUrlSecrets(rawDetail);
	// Whether anything was actually masked. Compared against the RAW string, not
	// against err.message, so an Error with an empty message (which falls back to
	// String(err)) is not misread as "redacted" and needlessly replaced below.
	const redacted = detail !== rawDetail;
	// A DB outage is infrastructure, not a code fault: throttle the log, skip the
	// Sentry capture, and collapse to the single shared `db:unavailable` alert so a
	// missing DATABASE_URL degrades quietly instead of flooding error tracking.
	const dbFull = isDbCapacityError(err);
	if (isDbUnavailableError(err) || dbFull) {
		logDbUnavailableOnce(code, detail);
		try {
			sendOpsAlert(dbFull ? 'database at storage cap — retention needed' : 'database unavailable', `${detail}\nref ${ref}`, {
				signature: dbFull ? 'db:capacity' : 'db:unavailable',
			});
		} catch { /* alerts best-effort */ }
		return ref;
	}
	console.error(`[server-error ${ref}] ${code} (${status}): ${detail}`);
	try {
		// Capture the original Error (preserving its stack + class) only when its
		// message carried no credential; otherwise send a redacted stand-in that
		// keeps the stack but not the key.
		let captured;
		if (err instanceof Error && !redacted) {
			captured = err; // nothing was masked, so send the original untouched
		} else {
			captured = new Error(detail);
			// A stack's first line repeats the message, so redact it too rather than
			// closing the front door and leaving the stack open.
			if (err instanceof Error && err.stack) captured.stack = redactUrlSecrets(err.stack);
		}
		captureException(captured, { ref, code, status, ...context });
		// Fire-and-forget like captureException; deduped per error class+message
		// (ref excluded from the signature so each occurrence doesn't re-alert).
		sendOpsAlert(`${status} ${code}`, `${detail}\nref ${ref}`, {
			signature: `server:${code}:${status}:${detail}`,
		});
	} catch {
		/* sentry/alerts best-effort; never mask the original failure */
	}
	return ref;
}

// Emit a 5xx WITHOUT leaking internal error detail to the client. The real
// message (which may carry RPC URLs, wallet addresses, or stack-derived text)
// is logged + captured server-side under a correlation id the caller can quote
// to support; the client only sees a generic description + the ref.
export function serverError(res, status, code, err, extra = {}) {
	// Coerce a DB outage OR a storage-cap failure to 503 + Retry-After regardless of
	// the caller's status, so boundaries that catch internally (sitemap, deployments)
	// advertise "retry shortly" to clients and CDNs exactly like wrap() does, instead
	// of a hard 500.
	if (isDbUnavailableError(err) || isDbCapacityError(err)) {
		const ref = reportServerError(err, { code, status: 503 });
		if (typeof res.setHeader === 'function') res.setHeader('retry-after', '30');
		return json(res, 503, {
			error: 'service_unavailable',
			error_description: 'database temporarily unavailable, retry shortly',
			ref,
			...extra,
		}, { 'cache-control': 'no-store' });
	}
	const ref = reportServerError(err, { code, status });
	return json(res, status, {
		error: code,
		error_description: `internal error, quote ref ${ref} to support`,
		ref,
		...extra,
	}, { 'cache-control': 'no-store' });
}

// Dispatch: client-fault (4xx) keep their descriptive message; server-fault
// (5xx) are sanitized via serverError. Use this in catch blocks where the
// status is derived from `err.status` and may be either class.
export function respondError(res, status, code, err, extra = {}) {
	if (status < 500) {
		return error(res, status, code, err?.message || code, extra);
	}
	return serverError(res, status, code, err, extra);
}

// Advertise the limiter budget on the response using the conventional
// `RateLimit-*` headers (the shape GitHub/Stripe and the IETF
// draft-ietf-httpapi-ratelimit-headers converge on). `result` is the object
// returned by api/_lib/rate-limit.js limiters: { success, limit, remaining,
// reset } where `reset` is an absolute epoch-ms timestamp. Returns the
// seconds-until-reset so callers can reuse it for Retry-After.
export function setRateLimitHeaders(res, result) {
	if (!result) return 0;
	const now = Date.now();
	const resetSec = Math.max(0, Math.ceil(((result.reset ?? now) - now) / 1000));
	if (Number.isFinite(result.limit)) res.setHeader('ratelimit-limit', String(result.limit));
	if (Number.isFinite(result.remaining)) {
		res.setHeader('ratelimit-remaining', String(Math.max(0, result.remaining)));
	}
	res.setHeader('ratelimit-reset', String(resetSec));
	return resetSec;
}

// Standard 429 response. Given a limiter result, set the RateLimit-* budget
// headers plus Retry-After (RFC 9110 §10.2.3) so well-behaved clients — and the
// paying agents this platform is built for — back off by the exact window
// instead of hammering or giving up blind. `retry_after` is mirrored into the
// JSON body for clients that read the envelope rather than headers.
export function rateLimited(res, result, message = 'too many requests', extra = {}) {
	const retryAfter = Math.max(1, setRateLimitHeaders(res, result));
	res.setHeader('retry-after', String(retryAfter));
	// Surface the limiter's own `reason` (set by api/_lib/rate-limit.js) so clients
	// can tell a genuine quota hit from a degraded/unavailable limiter — e.g. a
	// Redis outage fails critical buckets closed with `rate_limiter_unavailable`,
	// which a client should present as "temporarily unavailable, retrying" rather
	// than "you've hit your limit".
	const reason = result?.reason;
	return error(res, 429, 'rate_limited', message, {
		retry_after: retryAfter,
		...(reason ? { reason } : {}),
		...extra,
	});
}

// Response shape used for zod validation errors so clients can render
// field-level feedback. Mirrors RFC 9457-style problem details (lite).
export function validationError(res, err) {
	return json(res, err.status || 400, {
		error: err.code || 'validation_error',
		error_description: err.message || 'invalid input',
		issues: err.issues || [],
	}, { 'cache-control': 'no-store' });
}

export async function readJson(req, limit = 1_000_000) {
	const ct = req.headers['content-type'] || '';
	if (!ct.includes('application/json')) {
		throw Object.assign(new Error('content-type must be application/json'), { status: 415 });
	}
	return readBody(req, limit).then((buf) => {
		try {
			return JSON.parse(buf.toString('utf8'));
		} catch {
			throw Object.assign(new Error('invalid JSON'), { status: 400 });
		}
	});
}

export async function readForm(req, limit = 1_000_000) {
	const buf = await readBody(req, limit);
	return Object.fromEntries(new URLSearchParams(buf.toString('utf8')));
}

export function readBody(req, limit) {
	// The Cloud Run server (server/index.mjs) pre-parses JSON / urlencoded / text /
	// octet-stream bodies through Express body-parser middleware ahead of every
	// handler, fully draining the raw request stream in the process, and stores the
	// result on req.body. If we then attach 'data'/'end' listeners to that same
	// (already-ended) stream below, they never fire — the promise hangs forever.
	// This was a live production incident: every JSON POST handler using readJson
	// (MCP tools/call, /api/forge, etc.) deadlocked with zero response. When
	// req.body is already populated, reconstruct the equivalent raw bytes from it
	// instead of touching the stream. Vercel serverless, local dev, and mcp-server
	// never set req.body ahead of time, so the raw-stream path below is unchanged
	// there — this only short-circuits when a prior middleware already consumed
	// the stream for us.
	if (Buffer.isBuffer(req.rawBody)) {
		// express.json()/urlencoded()'s `verify` hook (server/index.mjs) captured the
		// exact bytes pre-parse — prefer this over req.body so anything depending on
		// byte-for-byte fidelity (HMAC signature checks) still works.
		if (req.rawBody.length > limit) {
			return Promise.reject(Object.assign(new Error('payload too large'), { status: 413 }));
		}
		return Promise.resolve(req.rawBody);
	}
	if (req.body !== undefined) {
		const ct = req.headers['content-type'] || '';
		let buf;
		if (Buffer.isBuffer(req.body)) buf = req.body;
		else if (typeof req.body === 'string') buf = Buffer.from(req.body, 'utf8');
		else if (ct.includes('application/x-www-form-urlencoded')) {
			buf = Buffer.from(new URLSearchParams(req.body).toString(), 'utf8');
		} else buf = Buffer.from(JSON.stringify(req.body ?? {}), 'utf8');
		if (buf.length > limit) {
			return Promise.reject(Object.assign(new Error('payload too large'), { status: 413 }));
		}
		return Promise.resolve(buf);
	}
	// Neither req.rawBody nor req.body was populated by a prior middleware. If the
	// stream was already *consumed* by someone who then threw the bytes away (a
	// body-parser that drained it without capturing rawBody/body, a proxy layer in
	// some deployment), attaching 'data'/'end' listeners now is too late: those
	// events already fired and Node's Readable never re-emits 'end' for a listener
	// added after the stream closed. Resolving empty here (rather than hanging
	// forever on events that can never fire) turns a silent request timeout into a
	// normal "empty/invalid body" response the caller can see and retry.
	//
	// The signal for that is `readableEnded`, NOT `req.complete`. They mean
	// different things and conflating them broke every raw-body upload in
	// production: `req.complete` goes true once Node has *received* the whole
	// message off the socket, whether or not anyone read it, and Cloud Run's
	// frontend buffers the entire request before invoking the container. So a
	// perfectly readable, fully-buffered body arrived with complete === true and
	// was discarded unread, which is why POST /api/3d/inspect answered `empty_body`
	// to a real GLB upload. `readableEnded` only goes true after 'end' has actually
	// been emitted to a consumer, which is precisely the drained-stream case.
	// A destroyed stream can never emit 'end' either, so it short-circuits too.
	if (req.readableEnded || req.destroyed) return Promise.resolve(Buffer.alloc(0));
	return new Promise((resolve, reject) => {
		const chunks = [];
		let total = 0;
		let settled = false;
		// Defense in depth for the same hazard when the stream looks readable at
		// the time we start listening but never delivers 'data'/'end' for some
		// other reason (a stalled proxy, a client that never sends the promised
		// body). Without this, such a request pins a Cloud Run concurrency slot
		// for the full request timeout instead of failing fast with a diagnosable
		// error.
		const timeoutMs = Number(process.env.READ_BODY_TIMEOUT_MS) || 15_000;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			reject(Object.assign(new Error('timed out reading request body'), { status: 408 }));
		}, timeoutMs);
		if (typeof timer.unref === 'function') timer.unref();
		const finish = (fn, arg) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			fn(arg);
		};
		req.on('data', (c) => {
			total += c.length;
			if (total > limit) {
				// Stop consuming, but leave the socket alive: destroying it here
				// resets the connection before the handler can write its 413, so
				// the caller sees an opaque "connection closed" instead of the
				// error that tells them their upload was too big. Unpipe + pause
				// is what raw-body does for the same reason; Node tears the
				// connection down after the response, once there is one to send.
				req.unpipe?.();
				req.pause?.();
				finish(reject, Object.assign(new Error('payload too large'), { status: 413 }));
				return;
			}
			chunks.push(c);
		});
		req.on('end', () => finish(resolve, Buffer.concat(chunks)));
		req.on('error', (err) => finish(reject, err));
	});
}

// ibm.com and any subdomain (any depth), https only. Used by the default
// allowlist so the IBM partnership embeds reach the shared three.ws APIs.
const IBM_ORIGIN = /^https:\/\/([a-z0-9-]+\.)*ibm\.com$/i;

// IBM publishes the partnership page through its Seismic CMS (live.ibm.com /
// ibm.seismic.com), and Seismic *executes* embedded HTML from its content
// gateway origin — e.g. https://gateway-prod-ibm-us-east-otter.seismic.com —
// NOT from *.ibm.com. So the real embedding origin for the IBM x402 demo is a
// *.seismic.com host, and IBM_ORIGIN alone never matches it. Allow Seismic-served
// origins (any depth) over https too, so the free Forge (/api/forge), the Solana
// RPC proxy (/api/solana-rpc) and other default-allowlist endpoints work when the
// page runs inside Seismic. Anchored to the exact host so look-alikes like
// seismic.com.evil.example can't match.
const SEISMIC_ORIGIN = /^https:\/\/([a-z0-9-]+\.)*seismic\.com$/i;

// Add fields to the response's `Vary` header without dropping what is already
// there. `res.setHeader('vary', …)` REPLACES, so a handler that varies on Cookie
// would otherwise erase the `vary: origin` cors() just set (and vice versa), and
// a shared cache would then serve one origin's CORS headers to another. Use this
// on any public-cacheable read whose body changes with a request header.
export function varyOn(res, ...fields) {
	const current = String(res.getHeader?.('vary') || '')
		.split(',')
		.map((f) => f.trim())
		.filter(Boolean);
	const seen = new Set(current.map((f) => f.toLowerCase()));
	for (const field of fields) {
		if (!seen.has(field.toLowerCase())) {
			seen.add(field.toLowerCase());
			current.push(field);
		}
	}
	res.setHeader('vary', current.join(', '));
}

export function cors(
	req,
	res,
	{ origins = null, methods = 'GET,POST,OPTIONS', credentials = false } = {},
) {
	const origin = req.headers.origin;
	if (origins === '*') {
		res.setHeader('access-control-allow-origin', '*');
	} else if (origin && isAllowedOrigin(origin, origins)) {
		res.setHeader('access-control-allow-origin', origin);
		res.setHeader('vary', 'origin');
		if (credentials) res.setHeader('access-control-allow-credentials', 'true');
	}
	res.setHeader('access-control-allow-methods', methods);
	res.setHeader(
		'access-control-allow-headers',
		'authorization, content-type, mcp-session-id, mcp-protocol-version, x-payment, payment-signature, idempotency-key, x-irl-device, x-irl-fix, x-forge-client, x-agent-id, x-forge-seed',
	);
	// x402: clients (drop-in modal, x402-fetch) must read these to drive the
	// 402-pay-retry flow and surface settlement receipts. Without `expose`,
	// cross-origin readers only see CORS-safelisted response headers.
	res.setHeader(
		'access-control-expose-headers',
		'PAYMENT-REQUIRED, PAYMENT-RESPONSE, x-payment-response, x-payment-network, x-payment-tx, link',
	);
	res.setHeader('access-control-max-age', '86400');
	if (req.method === 'OPTIONS') {
		res.statusCode = 204;
		res.end();
		return true;
	}
	return false;
}

function isAllowedOrigin(origin, allowed) {
	if (!allowed) {
		if (origin === env.APP_ORIGIN) return true;
		if (origin === 'https://x402scan.com') return true;
		if (origin === 'https://agentic.market') return true;
		if (origin === 'https://www.agentic.market') return true;
		// IBM partnership: allow ibm.com and every subdomain (any depth) over
		// https, so the partnership page's embeds and the shared three.ws APIs
		// (forge, etc.) work when served from *.ibm.com. Anchored to the exact
		// host so look-alikes like ibm.com.evil.example or notibm.com don't match.
		if (IBM_ORIGIN.test(origin)) return true;
		// …and from the Seismic CMS gateway IBM actually embeds it through.
		if (SEISMIC_ORIGIN.test(origin)) return true;
		if (
			process.env.NODE_ENV !== 'production' &&
			/^https?:\/\/localhost(:\d+)?$/.test(origin)
		) {
			return true;
		}
		return false;
	}
	return allowed.some((pat) => (typeof pat === 'string' ? origin === pat : pat.test(origin)));
}

// Attach the request's data provenance to the response, and honour a chaos
// directive if this request carries a valid one.
//
// This sits in wrap() because wrap() is the one seam every handler already goes
// through: putting it here means a new endpoint reports its provenance without
// its author doing anything, which is the only way a guarantee like this stays
// true across hundreds of handlers. Headers are written just before the body
// goes out; a response already streaming keeps whatever it had, since headers
// cannot be added after the fact and a throw here must never cost a caller a
// working answer.
function attachProvenance(res) {
	try {
		if (res.headersSent || typeof res.setHeader !== 'function') return;
		const headers = provenanceHeaders();
		if (!headers) return;
		res.setHeader('x-brownout', headers.summary);
		if (headers.trace) res.setHeader('x-brownout-trace', headers.trace);
		// Browsers cannot read a response header unless it is exposed, and the
		// whole point of this is that a client can tell a degraded answer from a
		// live one.
		const exposed = res.getHeader('access-control-expose-headers');
		const want = headers.trace ? 'x-brownout, x-brownout-trace' : 'x-brownout';
		res.setHeader('access-control-expose-headers', exposed ? `${exposed}, ${want}` : want);
	} catch {
		/* provenance is telemetry: it never breaks a response */
	}
}

// Wrap async handlers so uncaught errors return a consistent JSON envelope.
export function wrap(handler) {
	return async (req, res, ...rest) => {
		const monitored = zauthInstrument(req, res);
		const chaos = chaosDecision(req);
		if (req?.headers?.[CHAOS_HEADER] && typeof res.setHeader === 'function') {
			// Always answer the question the caller asked, including when the answer
			// is no. A prover that believes it broke an upstream and did not would
			// record a green proof for a fallback nothing exercised, which is worse
			// than a red one.
			try {
				res.setHeader(CHAOS_STATUS_HEADER, chaos.allowed ? `applied;faults=${chaos.faults.size}` : `refused;reason=${chaos.reason}`);
			} catch { /* header write is best-effort */ }
		}
		const run = () => withProvenance(() => withChaos(chaos.faults, async () => {
		try {
			await handler(req, res, ...rest);
		} catch (err) {
			const dbDown = isDbUnavailableError(err);
			// Storage-cap failures (SQLSTATE 53100) are, like a connectivity outage, an
			// infrastructure condition rather than a code bug — reads still work, writes
			// fail until retention frees space — so they take the same graceful, throttled,
			// no-Sentry path, just with a distinct alert so ops knows to reclaim space
			// (api/cron/db-retention.js) rather than chase a phantom bug.
			const dbFull = !dbDown && isDbCapacityError(err);
			const dbDegraded = dbDown || dbFull;
			// A missing env var (api/_lib/env.js `req()`) is a deployment-configuration
			// gap, not a code bug: the endpoint is down until the operator sets the
			// secret. Surface it as 503 not_configured with a deduped alert naming the
			// exact var — instead of one generic "unhandled 5xx" + Sentry event per hit
			// (the July 2026 siwe/siws nonce incident: JWT_SECRET unset → hundreds of
			// anonymous 500s that never said which var was missing).
			const missingEnv = !dbDegraded && /^Missing required env var: /.test(err?.message || '');
			const status = dbDegraded || missingEnv ? 503 : (err.status || 500);
			if (status >= 500) {
				const ref = correlationId();
				if (dbDegraded) {
					// During a DB outage/cap EVERY endpoint that doesn't catch internally lands
					// here. A missing/rotated DATABASE_URL or a full branch would otherwise emit
					// one `[api] unhandled` error line + one Sentry event per request — thousands
					// in minutes. It's infrastructure, not a code bug: throttle the log, skip
					// the Sentry capture, and fire only the single shared deduped alert.
					logDbUnavailableOnce(`${req.method} ${redactUrl(req.url)}`, err?.message || String(err));
					sendOpsAlert(dbFull ? 'database at storage cap — retention needed' : 'database unavailable', `${err?.message || String(err)}\nref ${ref}`, {
						signature: dbFull ? 'db:capacity' : 'db:unavailable',
					});
				} else if (missingEnv) {
					// One concise line + one deduped alert per (route, var) — the fix is
					// always the same: set the named var in the deployment env.
					console.error(`[api] ${err.message} [ref ${ref}] — set it in the deployment env (${req.method} ${redactUrl(req.url)})`);
					sendOpsAlert(`endpoint not configured: ${req.method} ${redactUrl(req.url)}`, `${err.message}\nSet the var in the Vercel env and redeploy.\nref ${ref}`, {
						signature: `not-configured:${redactUrl(req.url)}:${err.message}`,
					});
				} else {
					// Redact coordinates / device tokens so a 5xx on a geolocated read never
					// spills the caller's position or credential to an off-box sink.
					console.error(`[api] unhandled [ref ${ref}]`, err);
					captureException(err, { ref, url: redactUrl(req.url), method: req.method });
					sendOpsAlert(`unhandled 5xx in ${req.method} ${redactUrl(req.url)}`, `${err?.message || String(err)}\nref ${ref}`, {
						signature: `unhandled:${redactUrl(req.url)}:${err?.message}`,
					});
				}
				// Never echo a raw upstream message in a 5xx body — Solana/web3.js
				// network errors embed the keyed RPC URL (…helius-rpc.com/?api-key=…),
				// so err.message would leak HELIUS_API_KEY to the client. Hand back a
				// sanitized envelope keyed to the same ref we just logged.
				if (!res.headersSent && !res.writableEnded) {
					if (dbDegraded) {
						// 503 with Retry-After so clients and CDNs know to back off.
						res.setHeader('retry-after', '30');
					}
					if (wantsHtmlNavigation(req)) {
						// A human navigated into this 5xx — send them to the branded
						// error page with their ref instead of a raw JSON blob. API and
						// agent callers (no `Sec-Fetch-Mode: navigate`) keep the envelope.
						redirect(res, serverErrorPageLocation(ref, req), 303);
					} else if (missingEnv) {
						// Don't name the missing var to the client — which secrets are
						// unset is operator information; the ref ties it to the log line.
						json(res, status, {
							error: 'not_configured',
							error_description: `this endpoint is not configured on this deployment — quote ref ${ref} to support`,
							ref,
						}, { 'cache-control': 'no-store' });
					} else if (!dbDegraded && err.expose && err.code) {
						// An author-written contract error: the endpoint deliberately threw
						// this status, code, and message (gateway `fail()`, or an explicit
						// `Object.assign(new Error(...), { status, code, expose: true })`).
						// These are documented parts of the endpoint's contract and are what
						// a caller needs to react correctly, so a `503 upstream_unavailable`
						// must not collapse into a generic internal_error. The `expose`
						// marker is the whole gate: an error that merely bubbled up never
						// carries it, so the redaction below still covers every leak case.
						json(res, status, {
							error: err.code,
							error_description: err.message || `error, quote ref ${ref} to support`,
							ref,
						}, { 'cache-control': 'no-store' });
					} else {
						// `err.code` is NOT safe to echo here, for the same reason the
						// message above is redacted: on a 5xx it carries internal
						// implementation detail the caller has no business seeing. A
						// Postgres failure puts the raw SQLSTATE in it (a missing table
						// answered `42P01`, naming the storage engine and the fault), and
						// a Node socket failure puts ECONNREFUSED / ENOTFOUND there,
						// mapping our internal topology. 4xx keeps its code below, where
						// it is a deliberate, documented part of each endpoint's contract.
						json(res, status, {
							error: dbDegraded ? 'service_unavailable' : 'internal_error',
							error_description: dbDegraded
								? 'database temporarily unavailable, retry shortly'
								: `internal error, quote ref ${ref} to support`,
							ref,
						}, { 'cache-control': 'no-store' });
					}
				}
			} else if (!res.headersSent && !res.writableEnded) {
				if (err.code === 'validation_error' && Array.isArray(err.issues)) {
					validationError(res, err);
				} else {
					error(res, status, err.code || 'bad_request', err.message || 'error');
				}
			}
		}
		}));
		// The provenance header has to be written while the ledger is still in
		// scope AND before the body is flushed, so the res.end path is patched for
		// the duration of the handler rather than read afterwards. Every helper in
		// this module funnels through res.end, so one seam covers json(), error()
		// and a hand-rolled stream alike.
		const originalEnd = typeof res.end === 'function' ? res.end.bind(res) : null;
		if (originalEnd) {
			res.end = (...args) => {
				attachProvenance(res);
				res.end = originalEnd;
				return originalEnd(...args);
			};
		}
		try {
			await run();
		} finally {
			if (originalEnd) res.end = originalEnd;
		}
		// Keep the lambda alive briefly so the zauth SDK's in-flight POST to
		// back.zauthx402.com can finish. Cost: ~250ms of post-response runtime
		// on monitored requests only. The user has already received the response.
		if (monitored) await zauthDrain();
	};
}

// Wrap cron handlers with DB-unavailability awareness.
//
// When the database is unreachable (wrong credentials, connection refused, etc.)
// every cron invocation would otherwise bubble a NeonDbError to wrap(), which
// logs `[api] unhandled` and fires a sendOpsAlert per invocation — turning a
// single misconfigured DATABASE_URL into a sustained ops-alert storm. wrapCron
// intercepts DB-unavailable errors before they reach wrap(), logs a single warn,
// and returns 200 { ok: false, reason: 'db_unavailable' } so Vercel doesn't
// count the cron as a hard failure. Non-DB errors re-throw to wrap() so genuine
// bugs still surface through normal alerting.
//
// `requireWriteCapacity` opts a write-heavy cron into a storage-pressure preflight:
// when the branch is at its project-size cap, running a full tick only fails per-row
// (53100) and floods the logs, so the tick is skipped with 200 { ok: true, skipped }
// and a single warn instead. The probe is a READ (works at the cap); db-retention
// then reclaims space and the next tick resumes (see isStoragePressured). This is the
// proactive complement to the reactive catch below — it stops crons that swallow
// their own write errors (the pump-intel firehose) from storming the logs at the cap.
export function wrapCron(handler, { requireWriteCapacity = false } = {}) {
	return wrap(async (req, res, ...rest) => {
		// Derive cron name from the request URL for heartbeat tracking.
		const cronName = (req.url || '').replace(/^\/api\/cron\//, '').split('?')[0] || 'unknown';
		const t0 = Date.now();
		if (requireWriteCapacity) {
			let pressure = null;
			try { pressure = await isStoragePressured(); } catch { /* a probe fault must never stall a tick */ }
			if (pressure?.pressured) {
				console.warn(`[cron] ${cronName} skipped — db at storage cap (${pressure.sizeMb}MB ≥ ${pressure.highWaterMb}MB); retention will reclaim space`);
				// Heartbeat a healthy skip so uptime monitoring reads it as up, not stalled.
				import('./cache.js').then(({ cacheSet }) => {
					cacheSet(`cron:heartbeat:${cronName}`, { ok: true, skipped: 'db_at_storage_cap', t: t0, ms: Date.now() - t0 }, 7 * 24 * 60 * 60).catch(() => {});
				}).catch(() => {});
				if (!res.headersSent && !res.writableEnded) {
					json(res, 200, { ok: true, skipped: 'db_at_storage_cap', size_mb: pressure.sizeMb, high_water_mb: pressure.highWaterMb });
				}
				return;
			}
		}
		try {
			await handler(req, res, ...rest);
			// Write heartbeat after success — fire-and-forget, never blocks.
			import('./cache.js').then(({ cacheSet }) => {
				cacheSet(`cron:heartbeat:${cronName}`, { ok: true, t: t0, ms: Date.now() - t0 }, 7 * 24 * 60 * 60).catch(() => {});
			}).catch(() => {});
		} catch (err) {
			import('./cache.js').then(({ cacheSet }) => {
				cacheSet(`cron:heartbeat:${cronName}`, { ok: false, t: t0, ms: Date.now() - t0, err: err?.message?.slice(0, 200) }, 7 * 24 * 60 * 60).catch(() => {});
			}).catch(() => {});
			if (isDbUnavailableError(err) || isDbCapacityError(err)) {
				const full = isDbCapacityError(err);
				console.warn(`[cron] db ${full ? 'at storage cap' : 'unavailable'} — skipping tick:`, err.message);
				if (!res.headersSent && !res.writableEnded) {
					json(res, 200, { ok: false, reason: full ? 'db_full' : 'db_unavailable' });
				}
				return;
			}
			throw err;
		}
	});
}

export function method(req, res, allowed) {
	const m = req.method || 'GET';
	// HEAD must be allowed wherever GET is allowed (RFC 9110 §9.3.2).
	// Treat an incoming HEAD as GET for the purposes of the allowlist check;
	// Node.js HTTP automatically strips the response body on HEAD responses.
	const effective = (m === 'HEAD' && allowed.includes('GET')) ? 'GET' : m;
	// …and normalize the request itself to GET so downstream dispatch that
	// branches on `req.method === 'GET'` (exact equality) actually runs for a
	// HEAD probe instead of falling through every branch and hanging the
	// invocation until the function's hard timeout → a 504. This is safe: Node's
	// ServerResponse captured the request method at construction (set
	// `_hasBody = false` for HEAD), so the body stays stripped no matter what we
	// set req.method to here.
	if (effective === 'GET' && m === 'HEAD') req.method = 'GET';
	if (!allowed.includes(effective)) {
		// Dedupe: a handler that already lists HEAD alongside GET would otherwise
		// advertise `Allow: GET, HEAD, HEAD`.
		const advertised = allowed.includes('GET') ? [...new Set([...allowed, 'HEAD'])] : allowed;
		res.setHeader('allow', advertised.join(', '));
		error(res, 405, 'method_not_allowed', `method ${m} not allowed`);
		return false;
	}
	return true;
}
