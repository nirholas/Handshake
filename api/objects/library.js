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

import { cors, json, method, wrap } from '../_lib/http.js';
import { getObjectBuffer } from '../_lib/r2.js';

const MANIFEST_KEY = 'objects/library/manifest.json';
const MAX_PAGE = 1000;

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	let objects = [];
	let generatedAt = null;
	try {
		const buf = await getObjectBuffer(MANIFEST_KEY);
		const parsed = JSON.parse(buf.toString('utf8'));
		objects = Array.isArray(parsed) ? parsed : Array.isArray(parsed.objects) ? parsed.objects : [];
		generatedAt = parsed.generated_at || null;
	} catch (err) {
		const code = err?.$metadata?.httpStatusCode;
		if (err?.name !== 'NoSuchKey' && code !== 404) {
			console.error('[objects/library]', err?.message || err);
		}
	}

	const total = objects.length;
	res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=3600');

	const url = new URL(req.url, 'http://x');
	const rawLimit = url.searchParams.get('limit');
	if (rawLimit == null) {
		return json(res, 200, { objects, total, generated_at: generatedAt });
	}
	const limit = Math.min(Math.max(Number(rawLimit) || 0, 1), MAX_PAGE);
	const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);
	const page = objects.slice(offset, offset + limit);
	const nextOffset = offset + limit < total ? offset + limit : null;
	return json(res, 200, { objects: page, total, offset, next_offset: nextOffset, generated_at: generatedAt });
});
