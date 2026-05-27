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

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const TRANSIENT_STATUSES = new Set([502, 503, 504]);

// Fetch a fresh single-use CSRF token for every mutation. Tokens are burned
// on first use (api/_lib/csrf.js), so caching is unsafe when concurrent
// mutations share the module — two callers that read the same cached token
// race: the first succeeds, the second gets 403 csrf_invalid.
async function freshCsrfToken() {
	const r = await fetch('/api/csrf-token', { credentials: 'include' });
	if (!r.ok) return null;
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
	if (!SAFE_METHODS.has(method) && !hasBearer) {
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
	if (!res) throw lastErr;

	if (res.status === 401 && !allowAnonymous) {
		redirectToLogin();
		const err = new Error('session expired');
		err.status = 401;
		err.redirected = true;
		throw err;
	}
	return res;
}
