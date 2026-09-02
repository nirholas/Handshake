// GET /api/animations/library — the full Mixamo-sourced motion library.
//
// The bulk library (2,800+ clips baked by scripts/mixamo-all.mjs, growing as the
// generative text→motion seeding lands) is far too large for the deploy bundle
// (~3 GB of clip JSON), so the baked clips live on the R2 CDN and this endpoint
// proxies the library manifest object with an edge cache. Each manifest entry
// carries an absolute CDN `url` the browser fetches directly (R2 CORS allows GET
// from web origins — scripts/set-r2-cors.mjs).
//
// Returns { clips: [], total: 0 } until the library has been uploaded, so
// consumers (the /animations gallery, embed viewer, pose studio deep-links)
// feature-detect by emptiness rather than special-casing errors.
//
// Pagination (opt-in, backward compatible): the manifest is a stable ordered
// array, so a caller can page it with ?limit= (1..1000) and ?offset= to keep any
// single response bounded as the catalog grows past thousands of clips. With no
// ?limit the full array is returned exactly as before, so existing consumers
// (embed viewer, pose deep-link lookup, the older gallery build) are unchanged.
// Paged responses add `offset` + `next_offset` (null on the last page); `total`
// is always the full catalog size regardless of paging.
//
// TWO MANIFESTS, ONE CATALOG. The Mixamo bake and the generative text-to-motion
// seeder each own their own manifest object and never write the other's:
//
//   animations/library/manifest.json            scripts/mixamo-all.mjs
//   animations/library/generated/manifest.json  scripts/gcp/seed-motion.mjs
//
// They are kept apart because each publisher REBUILDS its manifest from the set
// it staged. Sharing one object would mean whichever ran last silently deleted
// the other's clips from the library, and the deletion would look exactly like a
// successful publish. Reading both here costs one extra cached object fetch and
// makes that class of accident impossible.
//
// Order is curated-then-generated and never interleaved, so every offset a
// caller already holds keeps pointing at the same clip when the generated set
// grows.

import { cors, json, method, wrap } from '../_lib/http.js';
import { getObjectBuffer } from '../_lib/r2.js';

const MANIFEST_KEY = 'animations/library/manifest.json';
const GENERATED_MANIFEST_KEY = 'animations/library/generated/manifest.json';
const MAX_PAGE = 1000;

/**
 * Read one manifest object. A missing object is the expected state for the
 * generated catalog before its first publish (and for the whole library before
 * launch), so it degrades to an empty list; anything else is logged and also
 * degrades, because a partial library beats a 5xx on a browse page.
 *
 * @param {string} key
 * @returns {Promise<{ clips: any[], generatedAt: string | null }>}
 */
async function readManifest(key) {
	try {
		const buf = await getObjectBuffer(key);
		const parsed = JSON.parse(buf.toString('utf8'));
		const clips = Array.isArray(parsed)
			? parsed
			: Array.isArray(parsed.clips)
				? parsed.clips
				: [];
		return { clips, generatedAt: parsed.generated_at || null };
	} catch (err) {
		const code = err?.$metadata?.httpStatusCode;
		if (err?.name !== 'NoSuchKey' && code !== 404) {
			console.error('[animations/library]', key, err?.message || err);
		}
		return { clips: [], generatedAt: null };
	}
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const [curated, generated] = await Promise.all([
		readManifest(MANIFEST_KEY),
		readManifest(GENERATED_MANIFEST_KEY),
	]);
	// A name collision would give the pose deep-link two clips to resolve, so
	// the curated catalog wins and the duplicate is dropped rather than served
	// twice. The seeder namespaces its clips `gen-`, so this never fires in
	// practice; it exists so a hand-published clip cannot shadow a preset.
	const curatedNames = new Set(curated.clips.map((c) => c?.name));
	const clips = curated.clips.concat(
		generated.clips.filter((c) => c?.name && !curatedNames.has(c.name)),
	);
	const generatedAt = curated.generatedAt;

	const total = clips.length;
	res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=3600');

	const url = new URL(req.url, 'http://x');
	const rawLimit = url.searchParams.get('limit');
	if (rawLimit == null) {
		// Legacy full-catalog response — unchanged contract.
		return json(res, 200, { clips, total, generated_at: generatedAt });
	}

	const limit = Math.min(Math.max(Number(rawLimit) || 0, 1), MAX_PAGE);
	const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);
	const page = clips.slice(offset, offset + limit);
	const nextOffset = offset + limit < total ? offset + limit : null;
	return json(res, 200, {
		clips: page,
		total,
		offset,
		next_offset: nextOffset,
		generated_at: generatedAt,
	});
});
