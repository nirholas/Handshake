// GET /api/objects/library: the CC0 3D object/prop library.
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
	// Open CORS: a CC0 manifest with no caller data in it, served to whoever asks.
	// The same objects already load cross-origin through /cdn/<key>, so pinning
	// the index to our own origin only broke the tray in embeds that render it.
	if (cors(req, res, { origins: '*', methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	// Cursors are validated BEFORE the manifest fetch. A request that is going to
	// 400 must not cost an R2 round trip first: the answer cannot change based on
	// what storage returns, so paying for the read is pure latency and pure spend.
	const url = new URL(req.url, 'http://x');
	const rawLimit = url.searchParams.get('limit');
	const rawOffset = url.searchParams.get('offset');
	let limit = null;
	let offset = 0;
	if (rawLimit == null) {
		if (rawOffset != null) {
			return error(res, 400, 'invalid_offset', 'offset is only meaningful with limit; pass ?limit=N too');
		}
	} else {
		const parsedLimit = parseCursor(rawLimit);
		if (!Number.isInteger(parsedLimit) || parsedLimit < 1) {
			return error(res, 400, 'invalid_limit', `limit must be a whole number from 1 to ${MAX_PAGE}`);
		}
		const parsedOffset = rawOffset == null ? 0 : parseCursor(rawOffset);
		if (!Number.isInteger(parsedOffset)) {
			return error(res, 400, 'invalid_offset', 'offset must be a whole number of 0 or more');
		}
		// Oversized limits clamp rather than fail: the documented contract is a page
		// of at most MAX_PAGE, and a caller asking for "everything" simply omits limit.
		limit = Math.min(parsedLimit, MAX_PAGE);
		offset = parsedOffset;
	}

	let objects = [];
	let generatedAt = null;
	let degraded = false;
	try {
		const buf = await getObjectBuffer(MANIFEST_KEY);
		const parsed = JSON.parse(buf.toString('utf8'));
		const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.objects) ? parsed.objects : null;
		// A manifest that parses but carries no object list is corrupt, not empty.
		// Routing it through the catch below is what keeps it out of the edge cache:
		// a published-cache "no objects" would outlive the bad upload by 5 minutes.
		if (!list) throw new Error('manifest carries no object list');
		objects = list;
		generatedAt = parsed.generated_at || null;
	} catch (err) {
		// Not uploaded yet (NoSuchKey/404) is the expected pre-launch state; anything
		// else (a storage outage, a corrupt or truncated manifest) is real and worth
		// logging and worth keeping out of the edge cache.
		const code = err?.$metadata?.httpStatusCode;
		if (err?.name !== 'NoSuchKey' && code !== 404) {
			degraded = true;
			console.error('[objects/library]', err?.message || err);
		}
	}

	const total = objects.length;
	if (limit == null) {
		res.setHeader('Cache-Control', degraded ? DEGRADED_CACHE : PUBLISHED_CACHE);
		return json(res, 200, { objects, total, generated_at: generatedAt });
	}

	const page = objects.slice(offset, offset + limit);
	const nextOffset = offset + limit < total ? offset + limit : null;
	res.setHeader('Cache-Control', degraded ? DEGRADED_CACHE : PUBLISHED_CACHE);
	return json(res, 200, { objects: page, total, offset, next_offset: nextOffset, generated_at: generatedAt });
});
