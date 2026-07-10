// GET /api/coin/news?q=<coin name>&limit=8
// ---------------------------------------------------------------------------
// Related-news rail for the /coin/:id page, served by the native three.ws
// aggregator (api/_lib/news.js — 37 publisher feeds with per-source caching
// and serve-stale-on-error). Previously proxied the cryptocurrency.cv
// deployment; that instance was retired, so the aggregation now runs here.
// Real articles from real publisher feeds, never fabricated.

import { cors, json, method, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { searchNews } from '../_lib/news.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const params = new URL(req.url, 'http://x').searchParams;
	const q = (params.get('q') || '').trim().slice(0, 64);
	if (!q) return error(res, 400, 'bad_query', 'q is required');
	const limit = Math.min(Math.max(1, parseInt(params.get('limit') || '8', 10) || 8), 20);

	const result = await searchNews(q, limit);
	if (!result.sources_ok) {
		return error(res, 502, 'upstream_error', 'related news is unavailable right now');
	}

	// Response shape kept stable for src/coin-page.js (published_at naming).
	const articles = result.articles.map((a) => ({
		title: a.title,
		link: a.link,
		description: a.description,
		image: a.image,
		source: a.source,
		published_at: a.pub_date,
	}));
	return json(res, 200, { articles, source: 'three.ws' }, {
		'cache-control': 'public, max-age=120, s-maxage=300, stale-while-revalidate=900',
	});
});
