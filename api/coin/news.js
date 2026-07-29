// GET /api/coin/news?q=<coin name>&limit=8
// ---------------------------------------------------------------------------
// Related-news rail for the /coin/:id page, served by the native three.ws
// aggregator (api/_lib/news.js — the full publisher registry, with per-source
// caching and serve-stale-on-error). Real articles from real publisher feeds,
// never fabricated.

import { cors, json, method, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { searchNews } from '../_lib/news.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.marketDataIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const params = new URL(req.url, 'http://x').searchParams;
	const q = (params.get('q') || '').trim().slice(0, 64);
	if (!q) return error(res, 400, 'bad_query', 'q is required');
	const limit = Math.min(Math.max(1, parseInt(params.get('limit') || '8', 10) || 8), 20);

	const result = await searchNews(q, limit);
	// `sources_ok` counts publishers whose LAST refresh succeeded, which is not
	// the same question as "do we have anything to show". The aggregator also
	// serves recent-but-not-just-refreshed copies, so a rail holding eight real
	// articles could still report zero ok sources and 502 — discarding the
	// articles it was holding. Gate on the articles themselves; only a genuinely
	// empty-handed fan-out (no articles AND nothing refreshed) is an outage.
	if (!result.articles.length && !result.sources_ok) {
		return error(res, 502, 'upstream_error', 'related news is unavailable right now');
	}

	// Response shape kept stable for src/coin-page.js (published_at naming).
	// id + published_at let the client build the canonical on-site story-page
	// link (src/shared/news-links.js storyPath) instead of bouncing users to
	// the publisher.
	const articles = result.articles.map((a) => ({
		id: a.id,
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
