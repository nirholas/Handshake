// GET /api/avatars/popular-searches: popular gallery search suggestions.
//
// Public, no auth. Powers the "popular searches" suggestion chips on the public
// avatar gallery. The data is produced by the Avatar Search Index Warmup
// autonomous x402 pipeline (api/_lib/x402/pipelines/avatar-search-warmup.js),
// which pays per call to /api/mcp (search_public_avatars) for ~20 common queries
// and upserts each query's ranked, thumbnail-resolved slice into
// avatar_search_warm_cache. We rank by how much public inventory each query
// surfaces so the chips always point at queries that return real results.
//
// ?with_thumbnails=true also returns the cached top-result slice per query so the
// gallery can paint instant results for a chip before the live search returns.
//
// Empty/cold-start safe: before the warmup has run (or if the table is absent)
// this returns a small static seed list so the gallery always has chips to show.

import { cors, json, method, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { getPopularSearches } from '../_lib/avatar-search-warm.js';

// Shown until the warmup has populated the cache. Mirrors the warmup's query set
// so the gallery's first paint matches what the loop will rank shortly after.
const SEED_QUERIES = ['human', 'robot', 'anime', 'warrior', 'dragon', 'knight', 'cyberpunk', 'animal'];

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, 'http://x');
	const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 12, 1), 50);
	const withThumbnails = url.searchParams.get('with_thumbnails') === 'true';

	const warmed = await getPopularSearches({ limit, withThumbnails });

	if (warmed.length > 0) {
		res.setHeader('cache-control', 'public, max-age=120, s-maxage=600, stale-while-revalidate=1800');
		return json(res, 200, {
			source: 'warm_cache',
			searches: warmed.map((w) => ({
				query: w.query,
				result_count: w.result_count,
				sample_thumbnail: w.sample_thumbnail,
				thumbnails: w.thumbnails,
				warmed_at: w.warmed_at,
				...(withThumbnails ? { top_results: w.top_results } : {}),
			})),
		});
	}

	// Cold start: the warmup has not populated the cache yet. Serve a static
	// seed list (no thumbnails available until the pipeline resolves them) so the
	// gallery still renders suggestion chips, with a short TTL so the warmed data
	// takes over as soon as it lands.
	res.setHeader('cache-control', 'public, max-age=30, s-maxage=60');
	return json(res, 200, {
		source: 'seed',
		searches: SEED_QUERIES.slice(0, limit).map((query) => ({
			query,
			result_count: null,
			sample_thumbnail: null,
			thumbnails: [],
		})),
	});
});
