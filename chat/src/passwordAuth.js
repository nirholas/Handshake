// Email/password sign-in and registration against the platform's own auth API.
//
// Same-origin, cookie-session based: /api/auth/login and /api/auth/register set
// the session cookie the rest of three.ws already reads, so a chat sign-in is a
// platform sign-in. Neither endpoint takes a CSRF token (there is no session to
// bind one to yet); the CSRF-protected endpoints are the ones that run against
// an established session.

/**
 * Turn an auth-API response into a message a person can act on.
 *
 * The API answers with `{ error, error_description }`; the codes that matter to
 * these two forms get a sentence of their own so the form does not surface a
 * bare code like `tos_required`.
 *
 * @param {number} status
 * @param {{ error?: string, error_description?: string }} body
 * @returns {string}
 */
export function authErrorMessage(status, body) {
	const code = body?.error;
	if (code === 'invalid_credentials') return 'That email or password is not right.';
	if (code === 'conflict') return 'An account with that email already exists. Sign in instead.';
	if (code === 'tos_required') return 'You have to accept the Terms of Service to create an account.';
	if (code === 'validation_error' || status === 400) {
		return body?.error_description || 'Check the details you entered and try again.';
	}
	if (status === 429) return 'Too many attempts. Wait a minute and try again.';
	if (status >= 500) return 'Sign-in is unavailable right now. Try again in a moment.';
	return body?.error_description || `Sign-in failed (${status}).`;
}

async function postAuth(path, payload) {
	const res = await fetch(path, {
		method: 'POST',
		credentials: 'include',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(payload),
	});
	const body = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(authErrorMessage(res.status, body));
	return body.user || null;
}

/**
 * Sign in with an email address (or username) and password.
 * @param {{ email: string, password: string }} credentials
 * @returns {Promise<object|null>} the signed-in user
 */
export function signInWithPassword({ email, password }) {
	return postAuth('/api/auth/login', { email: email.trim(), password });
}

/**
 * Create an account. The Terms checkbox is a server-enforced clickwrap: the
 * request is refused outright without it, so it is sent explicitly rather than
 * assumed.
 *
 * @param {{ email: string, password: string, displayName?: string, tosAccepted: boolean }} details
 * @returns {Promise<object|null>} the newly created user
 */
export function registerWithPassword({ email, password, displayName, tosAccepted }) {
	const payload = { email: email.trim(), password, tosAccepted: tosAccepted === true };
	const name = displayName?.trim();
	if (name) payload.display_name = name;
	return postAuth('/api/auth/register', payload);
}
