// Privacy is a property of what we RECORD, not of what we delete later.
//
// A session recorder that captures everything and scrubs afterwards has already
// put the secret in memory, in a buffer, and one bug away from a network call.
// This module is applied at capture time, before a value is ever held: typed
// characters are counted, never kept; URLs are stripped of their credentials
// before the path is stored; text is scanned for the shapes that secrets take.
//
// The rules are conservative on purpose. A redaction that fires on something
// harmless costs a maintainer one word of context. A redaction that fails to
// fire puts a live token in a bug report.

const SECRET_PATTERNS = [
	[/\b[A-Za-z0-9._-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[email]'],
	[/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[api-key]'],
	[/\b(?:xox[baprs]|ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_-]{16,}\b/g, '[token]'],
	[/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[jwt]'],
	[/\b(?:[0-9]{4}[ -]?){3}[0-9]{3,4}\b/g, '[card]'],
	[/\b[13][a-km-zA-HJ-NP-Z1-9]{25,34}\b/g, '[address]'],
	[/\b0x[a-fA-F0-9]{40}\b/g, '[address]'],
	// A long unbroken base58/base64 run is a key, a signature, or a mint. None
	// of them belong in a bug report, and none of them help a maintainer.
	[/\b[1-9A-HJ-NP-Za-km-z]{40,}\b/g, '[key]'],
];

// Query and hash parameters that carry credentials. Their presence is worth
// recording (the bug may BE the token); the value never is.
const SENSITIVE_PARAMS =
	/^(?:token|access_token|refresh_token|id_token|api_key|apikey|key|secret|password|passwd|pwd|auth|authorization|session|sid|code|state|signature|sig|otp|pin|email|phone)$/i;

// Includes the standard autocomplete tokens (`one-time-code`, `cc-number`,
// `current-password`) because that attribute is the most reliable declaration a
// page ever makes about what a field holds.
const SENSITIVE_FIELD =
	/(?:pass|pwd|secret|token|otp|one-time|verification|pin\b|cvv|cvc|cc-|ssn|social|card|iban|routing|seed|mnemonic|private|key|auth|email|phone|birthday|dob)/i;

/** Replace anything shaped like a secret. Never throws; returns a string. */
export function redactText(value, { max = 400 } = {}) {
	let text = String(value ?? '');
	if (!text) return '';
	for (const [pattern, replacement] of SECRET_PATTERNS) {
		text = text.replace(pattern, replacement);
	}
	text = text.replace(/\s+/g, ' ').trim();
	return text.length > max ? `${text.slice(0, max)}...` : text;
}

/**
 * A URL reduced to what a maintainer needs: origin-relative path, the NAMES of
 * the query parameters, and redacted values only for parameters that are
 * plainly not credentials. Userinfo and the hash go entirely.
 */
export function redactUrl(value, { origin = null } = {}) {
	const raw = String(value ?? '');
	if (!raw) return '';
	let url;
	try {
		url = new URL(raw, origin || 'http://local.invalid');
	} catch {
		return redactText(raw, { max: 120 });
	}
	const params = [];
	for (const [key] of url.searchParams) {
		if (SENSITIVE_PARAMS.test(key)) {
			params.push(`${key}=[redacted]`);
		} else {
			const value_ = url.searchParams.get(key) || '';
			params.push(`${key}=${redactText(value_, { max: 40 })}`);
		}
	}
	const sameOrigin = origin && url.origin === origin;
	const base = sameOrigin || url.origin === 'http://local.invalid' ? url.pathname : `${url.origin}${url.pathname}`;
	return params.length ? `${base}?${params.join('&')}` : base;
}

/**
 * Whether a field's CONTENT must never be observed at all: password inputs,
 * anything inside an opted-out subtree, and anything whose name, id, label, or
 * autocomplete hint says it holds something personal.
 */
export function isSensitiveField(el) {
	if (!el || el.nodeType !== 1) return true;
	const tag = el.tagName;
	if (tag === 'INPUT') {
		const type = (el.getAttribute('type') || 'text').toLowerCase();
		// The type attribute is a declaration about the content, so it is trusted
		// ahead of any name-based guessing below.
		if (['password', 'hidden', 'email', 'tel', 'date'].includes(type)) return true;
	}
	if (el.closest?.('[data-witness="off"], [data-witness-private]')) return true;
	const hints = [
		el.getAttribute?.('name'),
		el.getAttribute?.('id'),
		el.getAttribute?.('autocomplete'),
		el.getAttribute?.('aria-label'),
		el.getAttribute?.('placeholder'),
	]
		.filter(Boolean)
		.join(' ');
	// A placeholder that is itself an example email or phone number says what
	// the field holds more clearly than its name ever does.
	if (/\S+@\S+\.\S+/.test(hints) || /\+?\d[\d\s().-]{7,}/.test(hints)) return true;
	return SENSITIVE_FIELD.test(hints);
}

/** True when this element sits inside a subtree the page asked us not to watch. */
export function isOptedOut(el) {
	return !!el?.closest?.('[data-witness="off"]');
}

/**
 * What we keep about something a person typed: that they typed, roughly how
 * much, and whether it looked like an email or a number. Never the characters.
 */
export function summarizeInput(el, value) {
	if (isSensitiveField(el)) return { length: null, shape: 'private' };
	const text = String(value ?? '');
	if (!text) return { length: 0, shape: 'empty' };
	let shape = 'text';
	if (/^\d+$/.test(text)) shape = 'digits';
	else if (/^\S+@\S+$/.test(text)) shape = 'email';
	else if (/^https?:\/\//i.test(text)) shape = 'url';
	else if (text.length > 120) shape = 'paragraph';
	return { length: text.length, shape };
}
