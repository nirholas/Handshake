// GET /api/objects/library — the CC0 3D object/prop library.
//
// Free, commercial-OK 3D props (Poly Haven and other CC0 sources) staged as
// web GLB on the R2 CDN. Mirrors api/avatars/library.js exactly: the GLBs are
// too large for the deploy bundle, so this endpoint proxies a small manifest
// object with an edge cache. Every entry carries an absolute CDN `url` (GLB) and
// `thumb` (PNG) the browser loads directly.
//
// Returns { objects: [], total: 0 } until the manifest is uploaded, so consumers
// feature-detect by emptiness. Pagination via ?limit=N (1..1000) + ?offset=M.

import { cors, error, json, method, wrap } from '../_lib/http.js';
import { getObjectBuffer } from '../_lib/r2.js';

const MANIFEST_KEY = 'objects/library/manifest.json';
const MAX_PAGE = 1000;

const PUBLISHED_CACHE = 'public, s-maxage=300, stale-while-revalidate=3600';
// A storage outage degrades to an empty library so the gallery hides the section
// rather than erroring, but that emptiness must NOT be cached: a 300s edge entry
// (plus an hour of stale-while-revalidate) would keep serving "no objects" long
// after R2 recovered. The not-yet-uploaded case is a real steady state and keeps
// the normal cache.
const DEGRADED_CACHE = 'no-store';

// Strict cursor parsing. `Number(raw) || 0` silently turns `?limit=abc` into a
// one-item page and `?limit=2.7` into a fractional `next_offset` the caller then
// feeds back in, so a client-side bug reads as working pagination. Whole decimal
// digits only; anything else is the caller's error and gets a 400.
function parseCursor(raw) {
	if (raw == null) return null;
	const trimmed = raw.trim();
	if (!/^\d+$/.test(trimmed)) return NaN;
	return Number(trimmed);
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	let objects = [];
	let generatedAt = null;
	let degraded = false;
	try {
		const buf = await getObjectBuffer(MANIFEST_KEY);
		const parsed = JSON.parse(buf.toString('utf8'));
		objects = Array.isArray(parsed) ? parsed : Array.isArray(parsed.objects) ? parsed.objects : [];
		generatedAt = parsed.generated_at || null;
	} catch (err) {
		// Not uploaded yet (NoSuchKey/404) is the expected pre-launch state; anything
		// else is a real storage error worth logging and worth keeping out of the
		// edge cache.
		const code = err?.$metadata?.httpStatusCode;
		if (err?.name !== 'NoSuchKey' && code !== 404) {
			degraded = true;
			console.error('[objects/library]', err?.message || err);
		}
	}

	const total = objects.length;
	const url = new URL(req.url, 'http://x');

	const rawLimit = url.searchParams.get('limit');
	const rawOffset = url.searchParams.get('offset');
	if (rawLimit == null) {
		if (rawOffset != null) {
			return error(res, 400, 'invalid_offset', 'offset is only meaningful with limit; pass ?limit=N too');
		}
		res.setHeader('Cache-Control', degraded ? DEGRADED_CACHE : PUBLISHED_CACHE);
		return json(res, 200, { objects, total, generated_at: generatedAt });
	}

	const parsedLimit = parseCursor(rawLimit);
	if (!Number.isInteger(parsedLimit) || parsedLimit < 1) {
		return error(res, 400, 'invalid_limit', `limit must be a whole number from 1 to ${MAX_PAGE}`);
	}
	const offset = rawOffset == null ? 0 : parseCursor(rawOffset);
	if (!Number.isInteger(offset)) {
		return error(res, 400, 'invalid_offset', 'offset must be a whole number of 0 or more');
	}

	// Oversized limits clamp rather than fail: the documented contract is a page
	// of at most MAX_PAGE, and a caller asking for "everything" simply omits limit.
	const limit = Math.min(parsedLimit, MAX_PAGE);
	const page = objects.slice(offset, offset + limit);
	const nextOffset = offset + limit < total ? offset + limit : null;
	res.setHeader('Cache-Control', degraded ? DEGRADED_CACHE : PUBLISHED_CACHE);
	return json(res, 200, { objects: page, total, offset, next_offset: nextOffset, generated_at: generatedAt });
});
