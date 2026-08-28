// Privy CAPTCHA discovery, and the sign-in messages that depend on it.
//
// Privy rejects passwordless/init and siwe/init with HTTP 401
// `invalid_credentials` when the app has a CAPTCHA enabled and the request
// carries no token. That message reads as "your email or wallet is wrong", so
// people went and reset a password that was never the problem.
//
// The trigger was a probe that could not tell two answers apart. Reading the
// app config told us whether a CAPTCHA is required; when that read FAILED it
// returned the same `null` as "this app has no CAPTCHA", so the login flow
// proceeded without a token it may well have needed, straight into the opaque
// 401. Three outcomes now stay three outcomes, and the unknown one is reported
// as itself.
//
// Lives apart from src/privy-login.js because that module runs a top-level
// await and touches the DOM on import, which makes it untestable; this half is
// pure and is covered by tests/privy-captcha.test.js.

/** The app config could not be read, so the CAPTCHA requirement is unknown. */
export const CAPTCHA_UNAVAILABLE = Symbol('captcha_unavailable');

/** Shown when we cannot tell whether a CAPTCHA is needed. */
export const CAPTCHA_UNKNOWN_MESSAGE =
	'We could not reach the sign-in service to check whether this step needs a CAPTCHA. Check your connection and try again.';

const DEFAULT_TIMEOUT_MS = 6000;

/**
 * Read a Privy app's CAPTCHA configuration.
 *
 * @param {string} id  Privy app id.
 * @param {object} [opts]
 * @param {typeof fetch} [opts.fetchImpl]  Injectable for tests.
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{siteKey: string, apiUrl: string}|null|symbol>}
 *   The Turnstile config, `null` when the app needs no CAPTCHA, or
 *   CAPTCHA_UNAVAILABLE when the config could not be read.
 */
export async function fetchCaptchaConfig(id, { fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
	const doFetch = fetchImpl || globalThis.fetch;
	try {
		// This gates the login form, so an unbounded call stalls sign-in on a slow
		// network instead of resolving to a state the caller can act on.
		const r = await doFetch(`https://auth.privy.io/api/v1/apps/${id}`, {
			headers: { 'privy-app-id': id },
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!r.ok) return CAPTCHA_UNAVAILABLE;
		const cfg = await r.json();
		if (!cfg?.captcha_enabled || !cfg.captcha_site_key) return null;
		// Only Turnstile is wired up here; another provider is not a failure, it
		// just means this code path has no token to offer.
		if (cfg.enabled_captcha_provider && cfg.enabled_captcha_provider !== 'turnstile') return null;
		return {
			// Privy prefixes Turnstile site keys with "t:".
			siteKey: String(cfg.captcha_site_key).replace(/^t:/, ''),
			// Apps with a custom auth domain serve every auth endpoint from it.
			apiUrl: cfg.custom_api_url || 'https://auth.privy.io',
		};
	} catch {
		return CAPTCHA_UNAVAILABLE;
	}
}

/**
 * A resolver that reads the config once at page load and retries ONCE at the
 * moment of use.
 *
 * The page-load probe can lose a race with a flaky network, and without the
 * retry that single failure would block sign-in for the whole page view. A
 * button press is a fresh chance, so take it before giving up. A successful
 * answer is cached: the requirement does not change between two clicks.
 *
 * @param {string} id
 * @param {object} [opts]  Passed through to fetchCaptchaConfig.
 * @returns {() => Promise<{siteKey: string, apiUrl: string}|null|symbol>}
 */
export function makeCaptchaResolver(id, opts) {
	let pending = fetchCaptchaConfig(id, opts);
	return async () => {
		const first = await pending;
		if (first !== CAPTCHA_UNAVAILABLE) return first;
		pending = fetchCaptchaConfig(id, opts);
		return pending;
	};
}

/**
 * What a resolved config means for this sign-in attempt.
 *
 * @param {{siteKey: string}|null|symbol} config
 * @returns {'none'|'required'|'unknown'}
 */
export function captchaRequirement(config) {
	if (config === CAPTCHA_UNAVAILABLE) return 'unknown';
	return config?.siteKey ? 'required' : 'none';
}

/**
 * Turn an SDK or network failure into a sentence a person can act on.
 *
 * @param {unknown} err
 * @param {string} fallback  Used when the error says nothing useful.
 * @returns {string}
 */
export function signInMessage(err, fallback) {
	const raw = err?.message || '';
	if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
		return 'The sign-in service did not respond in time. Check your connection and try again.';
	}
	if (/invalid_credentials/i.test(raw)) {
		return 'The sign-in service rejected this attempt. This usually means its human-verification check did not go through, so try again.';
	}
	return raw || fallback;
}
