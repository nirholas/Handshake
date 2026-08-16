// GET /rss/announcements.xml: RSS 2.0 feed of three.ws news/announcements.
// Default source: data/rss/items.json (curated, hand-edited).
// Mirror modes: ?source=trythreews | ?source=nichxbt | ?source=archive  (X scrape).

import { cors, method, error, reportServerError, redactUrl } from '../_lib/http.js';
import { loadCuratedItems, loadAnnouncementItems, buildRssXml } from '../_lib/rss-feed.js';

const ARCHIVE_SOURCES = new Set(['archive', 'trythreews', 'nichxbt']);
const VALID_SOURCES = ['curated', ...ARCHIVE_SOURCES];

export default async function handler(req, res) {
	if (cors(req, res, { origins: '*', methods: 'GET,OPTIONS', credentials: false })) return;
	if (!method(req, res, ['GET'])) return;

	const url = new URL(req.url, 'https://three.ws');
	const sourceParam = (url.searchParams.get('source') || 'curated').toLowerCase();

	// A misspelled source used to fall through to the curated feed, so a reader
	// subscribed to ?source=trythreewz silently received a different feed and had
	// no way to notice. Say so instead, echoing back only enough of what they
	// sent to recognize the typo.
	if (!VALID_SOURCES.includes(sourceParam)) {
		const echoed = sourceParam.slice(0, 40);
		error(res, 400, 'unknown_source', `unknown source "${echoed}"; expected one of: ${VALID_SOURCES.join(', ')}`);
		return;
	}

	try {
		let items;
		let source;
		if (ARCHIVE_SOURCES.has(sourceParam)) {
			source = sourceParam === 'archive' ? 'all' : sourceParam;
			items = await loadAnnouncementItems({ source });
		} else {
			source = 'curated';
			items = await loadCuratedItems();
		}
		const selfUrl = source === 'curated'
			? 'https://three.ws/rss/announcements.xml'
			: `https://three.ws/rss/announcements.xml?source=${sourceParam}`;
		const xml = buildRssXml({ items, selfUrl, source });
		res.statusCode = 200;
		res.setHeader('content-type', 'application/rss+xml; charset=utf-8');
		res.setHeader('cache-control', 'public, max-age=600, s-maxage=600, stale-while-revalidate=86400');
		res.end(xml);
	} catch (err) {
		const ref = reportServerError(err, { code: 'rss_feed_failed', context: { url: redactUrl(req.url) } });
		res.statusCode = 500;
		res.setHeader('content-type', 'text/plain; charset=utf-8');
		res.setHeader('cache-control', 'no-store');
		res.end(`feed unavailable. Quote ref ${ref} to support.`);
	}
}
