// GET /api/news/feed
// ---------------------------------------------------------------------------
// Live aggregated crypto news across the native source registry
// (api/_lib/news-sources.js — 38 first-party publisher feeds). Powers
// /markets/news, the /markets hub strip, and anything else that wants a real
// cross-source headline feed.
//
// Query params:
//   category  one of NEWS_CATEGORIES (default: all)
//   source    a single source_key (overrides category)
//   q         case-insensitive full-text filter (title/description/tickers)
//   limit     1–50 (default 30)
//   offset    pagination offset
//   meta=1    include the source registry + category list in the response
//
// Aggregation results are cached per source for 5 minutes inside
// api/_lib/news.js, so this endpoint is cheap under load; CDN caches 120s.

import { cors, json, method, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { getNews } from '../_lib/news.js';
import { NEWS_SOURCES, NEWS_CATEGORIES } from '../_lib/news-sources.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.marketFeedIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const params = new URL(req.url, 'http://x').searchParams;
	const category = (params.get('category') || '').trim().toLowerCase() || undefined;
	const source = (params.get('source') || '').trim().toLowerCase() || undefined;
	const q = (params.get('q') || '').trim().slice(0, 80) || undefined;
	const limit = Math.min(Math.max(1, parseInt(params.get('limit') || '30', 10) || 30), 50);
	const offset = Math.max(0, parseInt(params.get('offset') || '0', 10) || 0);

	if (category && category !== 'all' && !NEWS_CATEGORIES.includes(category)) {
		return json(res, 400, {
			error: 'bad_category',
			message: `unknown category "${category}"`,
			categories: NEWS_CATEGORIES,
		});
	}
	if (source && !NEWS_SOURCES[source]) {
		return json(res, 400, { error: 'bad_source', message: `unknown source "${source}"` });
	}

	const result = await getNews({ category, source, q, limit, offset });

	const body = {
		articles: result.articles,
		total: result.total,
		limit,
		offset,
		sources_ok: result.sources_ok,
		sources_total: result.sources_total,
		fetched_at: new Date().toISOString(),
	};
	if (params.get('meta') === '1') {
		body.categories = NEWS_CATEGORIES;
		body.sources = Object.entries(NEWS_SOURCES).map(([key, s]) => ({
			key,
			name: s.name,
			category: s.category,
		}));
	}
	return json(res, 200, body, {
		'cache-control': 'public, max-age=60, s-maxage=120, stale-while-revalidate=600',
	});
});
