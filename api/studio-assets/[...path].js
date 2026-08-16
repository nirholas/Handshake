// GET /api/studio-assets/<path> — three.ws-origin proxy for the studio's
// VRM trait library. Mirrors the upstream loot-assets CDN under our domain
// so the studio iframe and the user's browser never hit a vendor origin.
//
// JSON manifests are rewritten on the fly so embedded `assetsLocation` and
// any absolute upstream URLs route back through this proxy. Binary assets
// (VRM, FBX, PNG, GLB, KTX2, etc.) stream through unchanged.
//
// Cache for 1 day at the edge / 7 days in the browser. The upstream content
// is immutable per path so long TTLs are safe. Because these responses ARE
// edge-cached, nothing in the body may depend on a request header: see
// rewriteJson.

import { cors, error, wrap } from '../_lib/http.js';

const UPSTREAM_BASE = 'https://m3-org.github.io/loot-assets/';
const PROXY_PREFIX = '/api/studio-assets/';

const TEXT_TYPES = new Set([
	'application/json',
	'application/manifest+json',
	'text/json',
	'text/plain',
]);

// Content types that execute in a browsing context. The upstream trait library
// serves none of them, so anything claiming one is either an upstream error
// page or a mirror we do not want to hand back under the three.ws origin,
// where it would run as same-origin script.
const ACTIVE_TYPES = new Set([
	'text/html',
	'application/xhtml+xml',
	'image/svg+xml',
	'application/xml',
	'text/xml',
]);

// Whitelist of upstream prefixes we're willing to mirror. Anything else gets
// a 404 — prevents this endpoint from being abused as an open proxy.
const ALLOWED_PREFIXES = ['anata/', '0N1/', 'tubbycats/', 'animations/', 'loot/'];

function isAllowed(path) {
	return ALLOWED_PREFIXES.some((p) => path === p.slice(0, -1) || path.startsWith(p));
}

function joinPath(parts) {
	if (Array.isArray(parts)) return parts.join('/');
	return String(parts || '');
}

// Rewrite any absolute upstream URL inside a JSON manifest to a ROOT-RELATIVE
// path under this proxy, so downstream asset resolution stays on whatever
// origin served the studio.
//
// This deliberately does not read the request's Host / X-Forwarded-Host to
// build an absolute URL. Cloud Run does not set X-Forwarded-Host, so a client
// could send its own; the rewritten manifest would then point `assetsLocation`
// at an attacker origin, and this response is `public, s-maxage=86400`, so the
// CDN would serve that poisoned manifest to every studio user for a day. A
// root-relative prefix is byte-identical for every caller, which makes the
// response safe to cache and removes the injection entirely. The studio
// concatenates `assetsLocation` with a leading-slash `traitsDirectory`
// (CharacterManifestData.getTraitsDirectory), and the resulting doubled slash
// resolves back through this same handler.
function rewriteJson(text) {
	const upstreamPattern = /https?:\/\/m3-org\.github\.io\/loot-assets\//g;
	return text.replace(upstreamPattern, PROXY_PREFIX);
}

// Upstream statuses are not ours to echo verbatim: a 3xx that `redirect:follow`
// left unresolved would carry a body it must not have, and a 5xx would blame
// three.ws for the mirror being down. Missing stays missing; everything else is
// a bad gateway.
function mapUpstreamStatus(status) {
	if (status === 404 || status === 403 || status === 410) {
		return { status: 404, code: 'not_found', message: 'asset not found in studio mirror' };
	}
	return { status: 502, code: 'upstream_error', message: `mirror returned ${status}` };
}

export default wrap(async (req, res) => {
	if (cors(req, res, { origins: '*', methods: 'GET,HEAD,OPTIONS', credentials: false })) return;
	if (req.method !== 'GET' && req.method !== 'HEAD') {
		return error(res, 405, 'method_not_allowed', `method ${req.method} not allowed`);
	}

	const rawPath = joinPath(req.query?.path);
	// Loop-decode until stable (capped) so double-encoded traversal sequences
	// (%252e%252e → %2e%2e → ..) can't slip past a single-decode '..' check.
	let path = rawPath;
	for (let i = 0; i < 3; i++) {
		let decoded;
		try {
			decoded = decodeURIComponent(path);
		} catch {
			return error(res, 404, 'not_found', 'asset not in studio mirror whitelist');
		}
		if (decoded === path) break;
		path = decoded;
	}
	path = path.replace(/^\/+/, '');

	// Anything still percent-encoded after 3 decode passes is hostile noise.
	// `?` and `#` would truncate the upstream URL we build by concatenation,
	// and a backslash is a path separator to some upstream servers.
	if (
		!path ||
		path.includes('%') ||
		path.includes('..') ||
		path.includes('?') ||
		path.includes('#') ||
		path.includes('\\') ||
		!isAllowed(path)
	) {
		return error(res, 404, 'not_found', 'asset not in studio mirror whitelist');
	}

	const upstreamUrl = UPSTREAM_BASE + path;
	let upstream;
	try {
		upstream = await fetch(upstreamUrl, { method: req.method, redirect: 'follow', signal: AbortSignal.timeout(20000) });
	} catch (err) {
		return error(res, 502, 'upstream_unreachable', `mirror fetch failed: ${err?.message}`);
	}

	// `redirect: follow` means the bytes we are about to serve under our own
	// origin may have come from wherever the mirror pointed us. Only the mirror
	// itself is trusted to fill this whitelist.
	if (upstream.url && !upstream.url.startsWith(UPSTREAM_BASE)) {
		return error(res, 502, 'upstream_error', 'mirror redirected off the asset library');
	}

	if (!upstream.ok) {
		const mapped = mapUpstreamStatus(upstream.status);
		return error(res, mapped.status, mapped.code, mapped.message);
	}

	const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
	const baseType = contentType.split(';')[0].trim().toLowerCase();
	if (ACTIVE_TYPES.has(baseType)) {
		return error(res, 502, 'upstream_error', `mirror returned an unexpected ${baseType} document`);
	}
	const isText = TEXT_TYPES.has(baseType);

	res.setHeader('content-type', contentType);
	res.setHeader(
		'cache-control',
		'public, max-age=604800, s-maxage=86400, stale-while-revalidate=86400',
	);
	res.setHeader('access-control-allow-origin', '*');

	if (req.method === 'HEAD') {
		// Only advertise a length we can stand behind. Upstream answers this
		// fetch gzipped (undici asks for it), so its content-length is the
		// COMPRESSED size while a GET here returns the decoded bytes. For a
		// trait manifest that is 2.4 KB claimed against 20 KB delivered. Text
		// bodies are rewritten on top of that, changing the length again.
		const len = upstream.headers.get('content-length');
		if (len && !isText && !upstream.headers.get('content-encoding')) {
			res.setHeader('content-length', len);
		}
		res.statusCode = 200;
		return res.end();
	}

	if (isText) {
		const text = await upstream.text();
		res.statusCode = 200;
		return res.end(rewriteJson(text));
	}

	const buf = Buffer.from(await upstream.arrayBuffer());
	res.statusCode = 200;
	res.end(buf);
});
