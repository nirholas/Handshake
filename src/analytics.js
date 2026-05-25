// Tiny PostHog identity helper.
//
// The snippet injected by vite.config.js auto-captures pageviews, clicks and
// session replays anonymously. Without `posthog.identify()`, every visit is a
// fresh "person" keyed by session ID — funnels, cohorts and retention all
// break. Call identifyUser() once after auth resolves, resetIdentity() on
// sign-out.
//
// All calls are no-ops when window.posthog isn't loaded (embed pages,
// blocked by adblock, ad-blocker test) so callers can fire-and-forget.

function ph() {
	if (typeof window === 'undefined') return null;
	const p = window.posthog;
	if (!p || typeof p.identify !== 'function') return null;
	return p;
}

let _lastDistinctId = null;

/**
 * Tie subsequent events to a stable user.
 * @param {{ id: string, username?: string, email?: string, display_name?: string, created_at?: string }} user
 */
export function identifyUser(user) {
	if (!user?.id) return;
	const p = ph();
	if (!p) return;
	// Avoid re-identifying on every getMe() call (most pages call it on load).
	if (_lastDistinctId === user.id) return;
	_lastDistinctId = user.id;
	try {
		p.identify(String(user.id), {
			username: user.username || undefined,
			email: user.email || undefined,
			name: user.display_name || user.username || undefined,
			created_at: user.created_at || undefined,
		});
	} catch {
		/* swallow — analytics must never break the app */
	}
}

/** Wipe the cookie-stored distinct_id so the next visit isn't tied to the user. */
export function resetIdentity() {
	_lastDistinctId = null;
	const p = ph();
	if (!p) return;
	try {
		p.reset();
	} catch {
		/* swallow */
	}
}

/**
 * Capture a custom event. Use sparingly — most behavior is already auto-captured.
 * Reserve for product-meaningful actions (e.g. "widget_published", "knowledge_uploaded").
 * @param {string} event
 * @param {Record<string, any>} [props]
 */
export function track(event, props = {}) {
	const p = ph();
	if (!p) return;
	try {
		p.capture(event, props);
	} catch {
		/* swallow */
	}
}
