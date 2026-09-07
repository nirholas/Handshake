// GET /cdn/<key> — first-party CDN for R2 bucket objects (avatars, thumbnails,
// forge GLBs). Routed via vercel.json: `/cdn/(.*)` → `/api/cdn-object?key=$1`.
//
// Why this exists: the bucket's public `*.r2.dev` dev domain is rate-limited by
// Cloudflare and not meant for production traffic — gallery pages loading dozens
// of thumbnails got throttled mid-burst, surfacing as `failed to load img /
// model-viewer` client errors. Streaming through the authenticated S3 endpoint
// sidesteps that limit entirely, and Vercel's CDN absorbs repeat reads via
// `s-maxage`, so each object is fetched from R2 roughly once per region per day.
//
// Exposure parity: the bucket is already fully readable through the public
// r2.dev domain, so serving the same namespace here grants read access to
// nothing new. What it DOES change is the origin the bytes arrive on: r2.dev is
// a foreign origin, three.ws is where the session cookie and the wallet live.
// So every response here is pinned to "data, never a document": the type comes
// from the server-chosen extension rather than the stored header, anything not
// safe to render inline is sent as an attachment, and `sandbox` puts whatever
// does render into an opaque origin. See `isInlineSafe` below.

import { GetObjectCommand } from '@aws-sdk/client-s3';
import { cors, error, wrap } from './_lib/http.js';
import { r2, isStorageInfrastructureError, publicUrlOrNull } from './_lib/r2.js';
import { env } from './_lib/env.js';

// Object keys are caller-controlled path input — keep them boring. UUID-based
// keys, slashes, dots-in-filenames only; no traversal, no control chars.
const KEY_RE = /^[\w!*'().@-]+(?:\/[\w!*'().@-]+)*(?:\.[\w-]+)?$/;
const MAX_KEY_LENGTH = 512;

const CONTENT_TYPES = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	webp: 'image/webp',
	gif: 'image/gif',
	svg: 'image/svg+xml',
	glb: 'model/gltf-binary',
	gltf: 'model/gltf+json',
	usdz: 'model/vnd.usdz+zip',
	bin: 'application/octet-stream',
	json: 'application/json',
	mp3: 'audio/mpeg',
	wav: 'audio/wav',
	mp4: 'video/mp4',
	webm: 'video/webm',
};

// Types a browser may render inline from the app origin. SVG is deliberately
// absent: an SVG document executes script, and one served inline from three.ws
// would run with three.ws's cookies. It still renders through <img>/<image>,
// which ignore content-disposition and never run script.
const INLINE_SAFE = new Set([
	'image/png',
	'image/jpeg',
	'image/webp',
	'image/gif',
	'image/avif',
	'model/gltf-binary',
	'model/gltf+json',
	'model/vnd.usdz+zip',
	'audio/mpeg',
	'audio/wav',
	'audio/ogg',
	'video/mp4',
	'video/webm',
	'application/json',
	'application/octet-stream',
]);

export function isInlineSafe(type) {
	return INLINE_SAFE.has(String(type).split(';')[0].trim().toLowerCase());
}

export function contentTypeFor(key, stored) {
	const ext = key.split('.').pop()?.toLowerCase();
	const byExt = CONTENT_TYPES[ext];
	// The extension wins over the stored header. Every write path picks the
	// extension server-side from an allowlisted type, whereas a stored
	// Content-Type can be copied verbatim from an upstream provider's response
	// (copyToBucket in _lib/forge-store.js). Preferring the header, as this used
	// to, let a remote `text/html` decide what three.ws serves.
	if (byExt) return byExt;
	if (stored && isInlineSafe(stored)) return stored;
	return 'application/octet-stream';
}

function cacheControlFor(key) {
	// Thumbnails are regenerated under the same key, so let browsers revalidate
	// hourly. Content keys (u/…, forge outputs) embed random segments and are
	// write-once in practice — cache long everywhere.
	return key.startsWith('thumb/')
		? 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800'
		: 'public, max-age=86400, s-maxage=2592000, stale-while-revalidate=604800';
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,HEAD,OPTIONS', origins: '*' })) return;
	if (req.method !== 'GET' && req.method !== 'HEAD') {
		res.setHeader('allow', 'GET, HEAD, OPTIONS');
		return error(res, 405, 'method_not_allowed', 'GET or HEAD only');
	}

	const raw = req.query?.key;
	const key = typeof raw === 'string' ? raw : '';
	if (!key || key.length > MAX_KEY_LENGTH || key.includes('..') || !KEY_RE.test(key)) {
		return error(res, 400, 'invalid_key', 'malformed object key');
	}

	const ifNoneMatch = req.headers['if-none-match'];
	const range = req.headers.range;

	try {
		const obj = await r2.send(
			new GetObjectCommand({
				Bucket: env.S3_BUCKET,
				Key: key,
				IfNoneMatch: ifNoneMatch,
				Range: range,
			}),
		);

		const type = contentTypeFor(key, obj.ContentType);
		res.statusCode = range && obj.ContentRange ? 206 : 200;
		res.setHeader('content-type', type);
		// A bucket object is data. `sandbox` drops anything that does reach a
		// top-level navigation into an opaque origin, so it can neither script
		// against three.ws nor read its storage; CORP stays permissive because the
		// CORS policy above is `*` and embeds depend on it.
		res.setHeader('content-security-policy', "default-src 'none'; sandbox");
		res.setHeader('cross-origin-resource-policy', 'cross-origin');
		if (!isInlineSafe(type)) res.setHeader('content-disposition', 'attachment');
		res.setHeader('cache-control', cacheControlFor(key));
		res.setHeader('accept-ranges', 'bytes');
		if (obj.ETag) res.setHeader('etag', obj.ETag);
		if (obj.ContentLength != null) res.setHeader('content-length', String(obj.ContentLength));
		if (obj.ContentRange) res.setHeader('content-range', obj.ContentRange);

		if (req.method === 'HEAD') {
			obj.Body?.destroy?.();
			return res.end();
		}

		obj.Body.pipe(res);
		obj.Body.on('error', (err) => {
			console.error('[cdn-object] stream error:', key, err?.message);
			try {
				res.destroy(err);
			} catch {}
		});
	} catch (err) {
		const status = err?.$metadata?.httpStatusCode;
		if (status === 304) {
			res.statusCode = 304;
			res.setHeader('cache-control', cacheControlFor(key));
			if (ifNoneMatch) res.setHeader('etag', ifNoneMatch);
			return res.end();
		}
		const code = err?.Code || err?.name;
		if (code === 'NoSuchKey' || code === 'NotFound' || status === 404) {
			return error(res, 404, 'not_found', 'object not found');
		}
		if (code === 'InvalidRange' || status === 416) {
			return error(res, 416, 'invalid_range', 'requested range not satisfiable');
		}
		// The signed read itself is broken: the credentials are rejected, or the
		// endpoint is unreachable, which says nothing about the object. The same
		// bytes are readable, unauthenticated, on the bucket's public domain, so
		// hand the caller there instead of 502ing every avatar, thumbnail and GLB
		// on the site. On 2026-09-07 a rejected R2 secret took the signed read
		// down and this route answered `upstream_error` for every object it
		// serves; the public domain was serving those same keys with a 200
		// throughout. Redirect, never cache: 302 + no-store, so the moment the
		// credential is healthy again traffic returns to the signed path (which
		// exists to dodge the public domain's rate limit) without a stale hop
		// pinned in anyone's cache.
		const fallback = isStorageInfrastructureError(err) ? publicUrlOrNull(key) : null;
		if (fallback) {
			console.error('[cdn-object] signed read failed, serving public bucket domain:', key, err?.message);
			res.statusCode = 302;
			res.setHeader('location', fallback);
			res.setHeader('cache-control', 'no-store');
			return res.end();
		}
		console.error('[cdn-object] r2 fetch failed:', key, err?.message);
		return error(res, 502, 'upstream_error', 'failed to fetch object');
	}
});
