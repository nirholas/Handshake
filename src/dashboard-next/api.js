// dashboard-next — minimal JSON fetch helper.
//
// Wraps fetch with credentials, JSON encode/decode, CSRF token, and a typed
// error class so page modules can `try { ... } catch (err) { if (err.code === 'unauthorized') ... }`.
//
// Stays small on purpose. The page modules import this for their CRUD calls.

// Fetch a fresh single-use CSRF token for every mutation. The server burns the
// token on first use (api/_lib/csrf.js) and returns it as { data: { token } },
// so we must read j.data.token and must NOT cache it — a cached token yields
// csrf_invalid on the second mutation, and reading the wrong field yields
// csrf_missing because no header gets attached at all.
async function getCsrf() {
	try {
		const r = await fetch('/api/csrf-token', { credentials: 'include' });
		if (!r.ok) return null;
		const j = await r.json().catch(() => null);
		return j?.data?.token || null;
	} catch {
		return null;
	}
}

export class ApiError extends Error {
	constructor(status, code, message, body) {
		super(message || code || `HTTP ${status}`);
		this.name = 'ApiError';
		this.status = status;
		this.code = code;
		this.body = body;
	}
}

export async function api(method, path, body) {
	const headers = { accept: 'application/json' };
	let payload;
	if (body !== undefined) {
		headers['content-type'] = 'application/json';
		payload = JSON.stringify(body);
	}
	if (method !== 'GET' && method !== 'HEAD') {
		const csrf = await getCsrf();
		if (csrf) headers['x-csrf-token'] = csrf;
	}
	const res = await fetch(path, {
		method,
		headers,
		body: payload,
		credentials: 'include',
	});
	const text = await res.text();
	let data = null;
	if (text) {
		try { data = JSON.parse(text); }
		catch { data = text; }
	}
	if (!res.ok) {
		const code = (data && typeof data === 'object' && data.error) || `http_${res.status}`;
		const message = (data && typeof data === 'object' && (data.error_description || data.message)) || res.statusText;
		throw new ApiError(res.status, code, message, data);
	}
	return data;
}

export const get  = (path)        => api('GET',    path);
export const post = (path, body)  => api('POST',   path, body);
export const put  = (path, body)  => api('PUT',    path, body);
export const del  = (path)        => api('DELETE', path);
export const patch = (path, body) => api('PATCH',  path, body);

// ── User session ───────────────────────────────────────────────────────────

let mePromise = null;
export function getMe() {
	if (!mePromise) {
		mePromise = get('/api/auth/me')
			.then((data) => {
				// /api/auth/me returns { user } — unwrap so callers receive the
				// user record directly, or null when there's no live session.
				if (data && typeof data === 'object' && 'user' in data) return data.user;
				return data || null;
			})
			.catch((err) => {
				if (err.status === 401) return null;
				throw err;
			});
	}
	return mePromise;
}

/** Redirect to /login if the user isn't signed in. Returns the user record.
 *  When the session is missing this kicks off navigation to /login and then
 *  returns a never-resolving promise — callers `await` it and naturally halt
 *  while the browser unloads, instead of throwing an uncaught "redirecting"
 *  error that pollutes the console and Sentry. */
export async function requireUser() {
	const me = await getMe();
	if (me) return me;
	const ret = encodeURIComponent(location.pathname + location.search);
	location.href = `/login?return=${ret}`;
	return new Promise(() => {});
}

// ── Small UI helpers used across pages ────────────────────────────────────

/** Display name → 1-2 letter avatar initials. */
export function initialsOf(user) {
	if (!user) return '?';
	const src = user.display_name || user.handle || user.email || '?';
	const parts = String(src).split(/\s+|@/).filter(Boolean);
	const first = parts[0]?.[0] || '?';
	const second = parts[1]?.[0] || '';
	return (first + second).toUpperCase().slice(0, 2);
}

/** Format an atomics (6-decimal USDC) integer as "$1,234.56". */
export function formatUsdc(atomics) {
	const n = Number(atomics) / 1_000_000;
	if (!Number.isFinite(n)) return '$0.00';
	return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

/** Relative time formatter — "3m ago", "2d ago", etc. */
export function relTime(iso) {
	const t = new Date(iso).getTime();
	if (!Number.isFinite(t)) return '';
	const diff = Date.now() - t;
	const s = Math.round(diff / 1000);
	if (s < 60)     return `${s}s ago`;
	const m = Math.round(s / 60);
	if (m < 60)     return `${m}m ago`;
	const h = Math.round(m / 60);
	if (h < 48)     return `${h}h ago`;
	const d = Math.round(h / 24);
	if (d < 14)     return `${d}d ago`;
	return new Date(iso).toLocaleDateString();
}

/** Escape arbitrary text for safe innerHTML insertion. */
export function esc(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) => ({
		'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
	})[c]);
}
