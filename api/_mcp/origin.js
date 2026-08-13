// Resolve the public site origin for building absolute URLs in MCP tool output.
//
// Prefers explicit env (stable across preview deploys); falls back to the
// request Host header, then VERCEL_URL. Shared by every tool that emits links
// (animation catalogue fetches, embed snippets) so origin resolution lives in
// exactly one place.
// Loopback hosts are the only ones served over plain http; everything else is
// https. Anchored on the whole header value (with its optional port) because an
// unanchored alternation matched the loopback literal ANYWHERE in the host, so
// remote names like "evil-127.0.0.1.example.com" and "localhost.evil.com" got
// http:// links built for them.
const LOOPBACK_HOST = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i;

export function resolveOrigin(req) {
	const env =
		process.env.APP_ORIGIN || process.env.PUBLIC_ORIGIN || process.env.PUBLIC_APP_ORIGIN;
	if (env) return env.replace(/\/$/, '');
	const host = req?.headers?.host;
	if (host) return `${LOOPBACK_HOST.test(host) ? 'http' : 'https'}://${host}`;
	if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
	throw new Error('cannot resolve site origin');
}
