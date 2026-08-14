// GET /api/avatars/library — the curated Mixamo character library.
//
// 106 professionally rigged humanoid characters (Y Bot, X Bot, Warrok, Remy,
// Vanguard, zombies, knights, …) staged by scripts/fetch-mixamo-avatars.mjs →
// convert-mixamo-avatars.mjs → build-mixamo-avatar-library.mjs. Each GLB carries
// a skeleton + skin weights + textures, so it drops straight into the pose
// studio / widget studio / embed viewer and drives the whole canonical clip
// library (idle/walk/run/wave/dance…) via animation retargeting.
//
// Mirrors api/animations/library.js exactly: the GLBs (~3 GB) are far too large
// for the deploy bundle, so they live on the R2 CDN and this endpoint proxies a
// small manifest object with an edge cache. Every entry carries an absolute CDN
// `url` (GLB) and `thumb` (PNG) the browser loads directly. The canonical R2
// policy in scripts/set-r2-cors.mjs makes those reads world-open, but the LIVE
// bucket policy is still the older origin allowlist, so a GLB fetched straight
// from the CDN on a third-party origin gets no allow-origin header; measure it
// with `node scripts/set-r2-cors.mjs --probe` and route third-party embeds
// through /api/glb until it is corrected. This endpoint itself is allowlisted
// too: cors() with no `origins` answers three.ws and its partner origins only.
//
// Returns { avatars: [], total: 0 } until the manifest is uploaded, so consumers
// (the /characters gallery, the avatar picker's "Characters" tab) feature-detect
// by emptiness rather than special-casing errors.
//
// Pagination (opt-in, backward compatible): with ?limit=N (1..1000) and optional
// ?offset=M the stable ordered array is paged; the response adds `offset` +
// `next_offset` (null on the last page). `total` is always the full library size.

import { cors, json, method, wrap } from '../_lib/http.js';
import { getObjectBuffer } from '../_lib/r2.js';

const MANIFEST_KEY = 'avatars/library/manifest.json';
const MAX_PAGE = 1000;

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	let avatars = [];
	let generatedAt = null;
	try {
		const buf = await getObjectBuffer(MANIFEST_KEY);
		const parsed = JSON.parse(buf.toString('utf8'));
		avatars = Array.isArray(parsed) ? parsed : Array.isArray(parsed.avatars) ? parsed.avatars : [];
		generatedAt = parsed.generated_at || null;
	} catch (err) {
		// Not uploaded yet (NoSuchKey/404) is the expected pre-launch state;
		// anything else is a real storage error worth logging. Both degrade to an
		// empty library so the UI simply hides the section.
		const code = err?.$metadata?.httpStatusCode;
		if (err?.name !== 'NoSuchKey' && code !== 404) {
			console.error('[avatars/library]', err?.message || err);
		}
	}

	const total = avatars.length;
	res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=3600');

	const url = new URL(req.url, 'http://x');
	const rawLimit = url.searchParams.get('limit');
	if (rawLimit == null) {
		return json(res, 200, { avatars, total, generated_at: generatedAt });
	}

	const limit = Math.min(Math.max(Number(rawLimit) || 0, 1), MAX_PAGE);
	const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);
	const page = avatars.slice(offset, offset + limit);
	const nextOffset = offset + limit < total ? offset + limit : null;
	return json(res, 200, {
		avatars: page,
		total,
		offset,
		next_offset: nextOffset,
		generated_at: generatedAt,
	});
});
