// GET /api/news/rss — RSS 2.0 syndication of the live aggregated crypto-news
// feed (same engine as /api/news/feed). Lets readers, bots, and downstream
// aggregators subscribe to three.ws crypto news directly.
//
//   ?category=defi   any canonical category (default: all)
//   ?limit=50        1–100 items
//
// Linked as <link rel="alternate"> from /markets/news. CDN-cached 300s.

import { cors, method, text, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { getNews } from '../_lib/news.js';
import { NEWS_CATEGORIES } from '../_lib/news-sources.js';

const xml = (s) =>
	String(s || '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.marketFeedIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const params = new URL(req.url, 'http://x').searchParams;
	const category = (params.get('category') || '').trim().toLowerCase() || undefined;
	const limit = Math.min(Math.max(1, parseInt(params.get('limit') || '50', 10) || 50), 100);
	if (category && category !== 'all' && !NEWS_CATEGORIES.includes(category)) {
		return error(res, 400, 'bad_category', `unknown category "${category}"`);
	}

	const { articles } = await getNews({ category, limit });
	const feedUrl = `https://three.ws/api/news/rss${category ? `?category=${category}` : ''}`;
	const pageUrl = `https://three.ws/markets/news${category ? `?category=${category}` : ''}`;
	const title = `three.ws Crypto News${category ? ` — ${category}` : ''}`;

	const items = articles
		.map((a) => {
			const reader = `https://three.ws/markets/news/article?${new URLSearchParams({ url: a.link, title: a.title, source: a.source })}`;
			return `		<item>
			<title>${xml(a.title)}</title>
			<link>${xml(a.link)}</link>
			<guid isPermaLink="false">${xml(a.id)}</guid>
			${a.description ? `<description>${xml(a.description)}</description>` : ''}
			${a.pub_date ? `<pubDate>${new Date(a.pub_date).toUTCString()}</pubDate>` : ''}
			<source url="${xml(reader)}">${xml(a.source)}</source>
			${a.image ? `<enclosure url="${xml(a.image)}" type="image/jpeg" />` : ''}
		</item>`;
		})
		.join('\n');

	const body = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
	<channel>
		<title>${xml(title)}</title>
		<link>${xml(pageUrl)}</link>
		<atom:link href="${xml(feedUrl)}" rel="self" type="application/rss+xml" />
		<description>Live crypto news aggregated by three.ws from 38 publisher feeds${category ? ` — ${category} category` : ''}.</description>
		<language>en</language>
		<lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
		<ttl>5</ttl>
${items}
	</channel>
</rss>
`;
	return text(res, 200, body, {
		'content-type': 'application/rss+xml; charset=utf-8',
		'cache-control': 'public, max-age=120, s-maxage=300, stale-while-revalidate=900',
	});
});
