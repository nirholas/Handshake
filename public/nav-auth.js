// Shared auth-aware navigation CTA swapper for three.ws.
//
// Every page that renders a site header — the shared header (public/nav.html via
// nav.js) and pages that hand-roll their own nav (pages/home.html and friends) —
// must show the same thing to a signed-in visitor: not "Sign in". This module is
// the single source of truth for that behavior so the two navs can never drift
// apart again (drift is exactly what made the homepage keep showing "Sign in" to
// authenticated users while the shared nav had long since fixed it).
//
// Markup contract — tag elements with data attributes; no per-page JS required:
//
//   data-auth="out"   → visible only when SIGNED OUT  (e.g. the "Sign in" link)
//   data-auth="in"    → visible only when SIGNED IN   (e.g. a "Dashboard" link;
//                       author it with the `hidden` attribute so the signed-out
//                       default — and the no-JS / fetch-failed fallback — is the
//                       safe "Sign in" view)
//   data-auth-name    → element whose text is replaced with the display name
//                       when signed in, and restored to its authored text when
//                       signed out (e.g. the "Console →" pill)
//
// Resilience: the local sign-in hint gives an instant, flicker-free paint for
// returning users; the server session at /api/auth/me is the source of truth and
// reconciles afterwards. The request self-aborts after a timeout and any failure
// falls back to the last good paint, so a slow or down auth endpoint degrades to
// "looks signed out" at worst — it never wedges the nav or throws.

(function (global) {
	const AUTH_HINT_KEY = '3dagent:auth-hint';
	const ME_ENDPOINT = '/api/auth/me';
	const RECONCILE_TIMEOUT_MS = 6000;
	const APPLIED_FLAG = 'navAuthBound';

	function readHint() {
		try {
			const raw = localStorage.getItem(AUTH_HINT_KEY);
			return raw ? JSON.parse(raw) : null;
		} catch (_) {
			return null;
		}
	}

	function writeHint(hint) {
		try {
			if (hint) localStorage.setItem(AUTH_HINT_KEY, JSON.stringify(hint));
			else localStorage.removeItem(AUTH_HINT_KEY);
		} catch (_) {}
	}

	// Apply a signed-in / signed-out view to every tagged element under `root`.
	// Pure and synchronous: safe to call repeatedly (optimistic paint, then the
	// reconciled server truth) and trivial to unit-test in isolation.
	function applyAuthState(root, authed, name) {
		const scope = root || document;
		scope.querySelectorAll('[data-auth="out"]').forEach((el) => {
			el.hidden = authed;
		});
		scope.querySelectorAll('[data-auth="in"]').forEach((el) => {
			el.hidden = !authed;
		});
		scope.querySelectorAll('[data-auth-name]').forEach((el) => {
			if (el.dataset.authNameOriginal === undefined) {
				el.dataset.authNameOriginal = el.textContent;
			}
			if (authed && name) {
				el.textContent = name;
				// Mark the element as personalized so the i18n runtime knows not to
				// overwrite the display name with a translated label (the two systems
				// otherwise race on the same text node, whoever runs last wins).
				el.dataset.authNamed = '1';
			} else {
				el.textContent = el.dataset.authNameOriginal;
				delete el.dataset.authNamed;
			}
		});
	}

	function displayName(user, fallback) {
		return (user && (user.display_name || user.username)) || fallback || null;
	}

	// Wire a nav root: instant hint paint, then reconcile against the real session.
	// Idempotent per root so duplicate calls (nav.js + a page-level call) are free.
	function initNavAuth(root) {
		const scope = root || document;
		const marker = scope === document ? document.documentElement : scope;
		if (marker.dataset && marker.dataset[APPLIED_FLAG] === '1') return;
		if (marker.dataset) marker.dataset[APPLIED_FLAG] = '1';

		const hint = readHint();
		if (hint && hint.authed) applyAuthState(scope, true, hint.name);

		const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
		const timer = ctrl ? setTimeout(() => ctrl.abort(), RECONCILE_TIMEOUT_MS) : null;

		fetch(ME_ENDPOINT, { credentials: 'include', signal: ctrl ? ctrl.signal : undefined })
			.then((r) => (r.ok ? r.json() : null))
			.then((data) => {
				const user = data && data.user;
				if (user) {
					const name = displayName(user, hint && hint.name);
					applyAuthState(scope, true, name);
					writeHint({ authed: true, name });
				} else {
					// No live session — revert any optimistic swap and drop the stale hint.
					applyAuthState(scope, false, null);
					writeHint(null);
				}
			})
			.catch(() => {
				// Network failure or timeout: keep the last good (hint) paint rather
				// than flashing a signed-in visitor back to "Sign in".
			})
			.finally(() => {
				if (timer) clearTimeout(timer);
			});
	}

	const api = { initNavAuth, applyAuthState, readHint, writeHint, displayName };

	// Browser: expose on window so classic-script pages can call it. Node/test:
	// export the pure helpers for unit testing without a DOM bootstrap.
	if (global) global.initNavAuth = initNavAuth;
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : null);
