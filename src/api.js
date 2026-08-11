// Shared HTTP client for the three.ws frontend.
//
// Single source of truth for:
//   • CSRF token issuance (single-use, server-burned)
//   • session-cookie mutation gating (PUT/POST/PATCH/DELETE auto-carry x-csrf-token)
//   • transient 5xx retry on safe methods
//   • 401 → /login?next=… redirect
//
// Every page that talks to /api MUST import apiFetch from here. The ESLint
// rule no-restricted-syntax in .eslintrc blocks raw `fetch(`${API_BASE}…`)` to
// prevent the kind of drift that left agent-edit.js without CSRF and silently
// 403'ing every save until a user complained.

import { trackError, track, ANALYTICS_EVENTS } from './analytics.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const TRANSIENT_STATUSES = new Set([502, 503, 504]);

// Reduce an API path to a low-cardinality route for analytics: drop the query
// string (may carry tokens) and collapse UUIDs / long ids to ':id' so the
// reliability view groups by endpoint, not by individual resource.
function routeOf(path) {
	let p = String(path || '');
	const q = p.indexOf('?');
	if (q >= 0) p = p.slice(0, q);
	return p
		.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id')
		.replace(/\/\d{4,}(?=\/|$)/g, '/:id');
}

// Known session state for this tab: null = unknown, true/false = resolved.
// A CSRF token is bound to the session cookie (api/_lib/auth.js), so for a
// signed-out visitor the server has nothing to bind it to and answers 401.
// Asking anyway printed a red 401 in the console of every anonymous visitor on
// a public page that POSTs a read (the live agent wall's batch balance
// hydration, for one). Pages that already resolved the answer tell us via
// noteSession(); the token endpoint itself also teaches us.
let _sessionKnown = null;

/**
 * Record whether this visitor has a session, so anonymous public reads can skip
 * a CSRF pre-flight that could only 401. Pass the resolved answer from
 * /api/auth/me, which returns 200 with `{ user: null }` when signed out.
 *
 * Only `allowAnonymous` requests act on a `false` here, so a genuine mutation
 * always still fetches its token and can never be weakened by a stale reading.
 *
 * @param {boolean} hasSession
 */
export function noteSession(hasSession) {
	_sessionKnown = !!hasSession;
}

// Fetch a fresh single-use CSRF token for every mutation. Tokens are burned
// on first use (api/_lib/csrf.js), so caching is unsafe when concurrent
// mutations share the module — two callers that read the same cached token
// race: the first succeeds, the second gets 403 csrf_invalid.
async function freshCsrfToken() {
	const r = await fetch('/api/csrf-token', { credentials: 'include' });
	if (r.status === 401) { _sessionKnown = false; return null; }
	if (!r.ok) return null;
	_sessionKnown = true;
	const j = await r.json().catch(() => null);
	return j?.data?.token || null;
}

// Exposed for the rare caller that can't go through apiFetch — e.g. an XHR
// upload that needs upload-progress events. Hand it the token, attach the
// x-csrf-token header yourself, and the server will accept it. Token is
// single-use, so don't reuse the returned string for a second request.
export async function consumeCsrfToken() {
	return freshCsrfToken();
}

function redirectToLogin() {
	if (typeof location === 'undefined') return;
	if (/^\/login(\/|$|\?)/.test(location.pathname)) return;
	const next = location.pathname + location.search + location.hash;
	location.href = '/login?next=' + encodeURIComponent(next);
}

// Drop-in fetch replacement. Pass allowAnonymous:true on endpoints where a
// 401 is a legitimate answer the caller wants to inspect itself (e.g.
// /api/auth/me on first paint).
export async function apiFetch(path, options = {}) {
	const { allowAnonymous = false, ...init } = options;
	const method = (init.method || 'GET').toUpperCase();
	const canRetry = SAFE_METHODS.has(method);

	const headers = new Headers(init.headers || {});
	const hasBearer = (headers.get('authorization') || '').startsWith('Bearer ');
	// A known-anonymous caller on an endpoint that accepts anonymous reads has no
	// session for a token to bind to; skipping the pre-flight keeps a public page
	// console clean. Anything that is not `allowAnonymous` still asks, always.
	const skipCsrf = allowAnonymous && _sessionKnown === false;
	if (!SAFE_METHODS.has(method) && !hasBearer && !skipCsrf) {
		const token = await freshCsrfToken();
		if (token) headers.set('x-csrf-token', token);
	}

	const doFetch = () =>
		fetch(path, {
			credentials: 'include',
			...init,
			headers,
		});

	let res;
	let lastErr;
	const maxAttempts = canRetry ? 3 : 1;
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		if (attempt > 0) {
			await new Promise((r) => setTimeout(r, 400 * attempt * attempt));
		}
		try {
			res = await doFetch();
		} catch (networkErr) {
			lastErr = networkErr;
			res = undefined;
			continue;
		}
		if (canRetry && TRANSIENT_STATUSES.has(res.status)) continue;
		break;
	}
	if (!res) {
		// Reliability boundary: the request never got a response (offline / DNS /
		// CORS) even after retries. Fire once per call, never per attempt.
		trackError('api.network', lastErr, { endpoint: routeOf(path), method });
		throw lastErr;
	}

	// Reliability boundary: a server error that survived the retry budget. 4xx is
	// left out — those are usually expected client/validation outcomes, not
	// reliability failures — except 401 which the redirect path below owns.
	if (res.status >= 500) {
		track(ANALYTICS_EVENTS.ERROR_OCCURRED, {
			context: 'api.server_error',
			message: `${method} ${routeOf(path)} → ${res.status}`,
			status: res.status,
			endpoint: routeOf(path),
			method,
		});
	}

	if (res.status === 401 && !allowAnonymous) {
		redirectToLogin();
		const err = new Error('session expired');
		err.status = 401;
		err.redirected = true;
		throw err;
	}
	return res;
}
