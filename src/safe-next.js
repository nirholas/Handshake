// Same-origin redirect guards for navigation params (?next=, ?return=).
//
// safeNext is the strict guard for post-auth redirects: only same-origin
// relative paths survive. safeNavUrl is the looser guard for links that may
// legitimately leave the origin (e.g. the paywall return link): it allows
// absolute http(s) URLs but blocks script-capable schemes (javascript:,
// data:, vbscript:) and protocol-relative/backslash tricks.
//
// These functions are inlined into public pages that cannot import /src at
// runtime (public/login.html, public/register.html, public/wallet-login.js,
// public/wallet-connect-demo.html, public/paywall.js). The inline copies omit
// the `export` keyword but are otherwise byte-identical;
// tests/safe-next.test.js fails if any copy drifts. Update all together.

export function safeNext(raw, fallback = '/dashboard') {
	if (typeof raw !== 'string' || raw.length === 0) return fallback;
	// Require a single leading '/': '//evil.com' is protocol-relative, and a
	// backslash anywhere lets '/\evil.com' normalize to '//evil.com' in the
	// URL parser.
	if (!raw.startsWith('/') || raw.startsWith('//')) return fallback;
	if (raw.includes('\\')) return fallback;
	// Control characters can smuggle a scheme past naive prefix checks.
	// eslint-disable-next-line no-control-regex
	if (/[\u0000-\u001f]/.test(raw)) return fallback;
	return raw;
}

export function safeNavUrl(raw, fallback = '/') {
	if (typeof raw !== 'string' || raw.length === 0) return fallback;
	// eslint-disable-next-line no-control-regex
	if (raw.includes('\\') || /[\u0000-\u001f]/.test(raw)) return fallback;
	// Same-origin relative path.
	if (raw.startsWith('/') && !raw.startsWith('//')) return raw;
	// Absolute URL: http(s) only, so javascript:/data:/vbscript: can never
	// reach an href or location sink. The WHATWG parser strips leading
	// whitespace and C0 controls before scheme parsing, and lowercases the
	// scheme, so ' javascript:...' and 'JaVaScRiPt:...' both fail here.
	try {
		const u = new URL(raw);
		if (u.protocol === 'https:' || u.protocol === 'http:') return u.href;
	} catch {
		// Not a parseable absolute URL: fall through to the fallback.
	}
	return fallback;
}
