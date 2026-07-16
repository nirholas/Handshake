/**
 * No-crypto auth for the email+password path.
 *
 * All calls mint the same session cookie that the rest of the platform
 * consumes — same createSession() / __Host-sid flow as SIWE/SIWS.
 *
 * Primary consumers:
 *   - login.html (already wired — uses /api/auth/login directly)
 *   - C04 onboarding wizard (import signInWithEmail / registerWithEmail)
 *   - Any surface that needs to auth a no-crypto user programmatically
 */

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Sign in with email (or username) and password.
 * Returns the user object on success; throws with a human-readable message on failure.
 *
 * @param {string} emailOrUsername
 * @param {string} password
 * @returns {Promise<{ user: object }>}
 */
export async function signInWithEmail(emailOrUsername, password) {
	const res = await fetch('/api/auth/login', {
		method: 'POST',
		credentials: 'include',
		headers: { 'content-type': 'application/json' },
		// tosAccepted: every surface that mounts this sign-in shows the
		// "By signing in you agree…" notice, so each sign-in re-affirms the
		// current Terms and the server re-stamps the accepted version.
		body: JSON.stringify({ email: emailOrUsername, password, tosAccepted: true }),
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) {
		if (res.status === 429) throw new Error('Too many attempts. Try again in a moment.');
		throw new Error(data.error_description || data.error || 'Email or password is incorrect.');
	}
	_persistAuthHint(data.user);
	return data;
}

/**
 * Register a new account with email and password (no wallet needed).
 * Creates a session immediately — the user is signed in on success.
 *
 * Clickwrap contract: the server rejects registration without tosAccepted,
 * so every surface that calls this MUST display the Terms of Service and
 * Privacy Policy agreement (checkbox or "By creating an account you agree…"
 * notice adjacent to the submit control) and pass `tosAccepted: true` only
 * after showing it.
 *
 * @param {string} email
 * @param {string} password
 * @param {{ displayName?: string, referralCode?: string, tosAccepted?: boolean }} [opts]
 * @returns {Promise<{ user: object }>}
 */
export async function registerWithEmail(email, password, opts = {}) {
	const res = await fetch('/api/auth/register', {
		method: 'POST',
		credentials: 'include',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			email,
			password,
			tosAccepted: opts.tosAccepted === true,
			...(opts.displayName ? { display_name: opts.displayName } : {}),
			...(opts.referralCode ? { referralCode: opts.referralCode } : {}),
		}),
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) {
		if (res.status === 409) throw new Error('An account with that email already exists.');
		if (res.status === 429) throw new Error('Too many sign-up attempts. Try again later.');
		throw new Error(data.error_description || data.error || 'Registration failed.');
	}
	_persistAuthHint(data.user);
	return data;
}

/**
 * Resolve the signed-in user from the current session cookie.
 * Returns null when unauthenticated (no cookie or expired session).
 *
 * @returns {Promise<object|null>}
 */
export async function getCurrentUser() {
	try {
		const res = await fetch('/api/auth/me', { credentials: 'include' });
		if (!res.ok) return null;
		const { user } = await res.json();
		return user ?? null;
	} catch {
		return null;
	}
}

/**
 * Sign out — destroys the server session and clears the session cookie.
 *
 * @returns {Promise<void>}
 */
export async function signOut() {
	await fetch('/api/auth/logout', {
		method: 'POST',
		credentials: 'include',
	}).catch(() => {});
	try { localStorage.removeItem('3dagent:auth-hint'); } catch { /* ignore */ }
}

/**
 * Route the current page to the sign-in page, preserving the current URL as
 * the post-auth redirect target. Call this when a gated action requires auth.
 */
export function requireAuth() {
	try { sessionStorage.setItem('login_redirect', location.href); } catch { /* ignore */ }
	location.href = '/login';
}

// ─── Internal ────────────────────────────────────────────────────────────────

function _persistAuthHint(user) {
	if (!user) return;
	try {
		localStorage.setItem('3dagent:auth-hint', JSON.stringify({
			authed: true,
			name: user.display_name || '',
			ts: Date.now(),
		}));
	} catch { /* ignore */ }
}
