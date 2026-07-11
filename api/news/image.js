// GET /api/news/image?url=<article link>
// ---------------------------------------------------------------------------
// Preview-image resolver for articles whose publisher feed ships no image
// (~20% of the live feed: Seeking Alpha, AMBCrypto, CNBC, Al Jazeera, and
// others publish text-only RSS). The card renders its fallback tile
// immediately, points an <img> here, and this endpoint:
//
//   1. Verifies the URL is a real article currently in the aggregator cache —
//      this is NOT an open resolver; a link we never served 404s without a
//      single upstream byte being fetched.
//   2. If the cached article already carries an image (a later feed refresh
//      picked one up), 302s straight to the same-origin proxy.
//   3. Otherwise fetches the article page itself (SSRF-hardened fetcher:
//      scheme allowlist, DNS + private-IP blocklist, byte cap, timeout),
//      extracts its og:image / twitter:image, and 302s to /api/img — which
//      serves the bytes same-origin, immune to hotlink-referrer blocks.
//   4. If the page has no usable preview image, answers 404 (negatively
//      cached) and the card keeps its designed fallback tile.
//
// Both outcomes are cached: in-process per article link, and at the CDN via
// cache-control on the redirect/404 — one resolution per article, ever.

import { wrap, cors, method, json, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { findArticle, extractOgImage } from '../_lib/news.js';
import { fetchModel } from '../_lib/fetch-model.js';

const PAGE_TIMEOUT_MS = 6_000;
const PAGE_MAX_BYTES = 768 * 1024; // og tags live in <head>; cap the download hard
const CACHE_TTL_MS = 24 * 3600_000;
const CACHE_MAX = 3000;

const _resolved = new Map(); // article link → { image: string|null, expiresAt }

function remember(link, image) {
	_resolved.set(link, { image, expiresAt: Date.now() + CACHE_TTL_MS });
	if (_resolved.size > CACHE_MAX) _resolved.delete(_resolved.keys().next().value);
	return image;
}

async function resolvePreviewImage(article) {
	const hit = _resolved.get(article.link);
	if (hit && hit.expiresAt > Date.now()) return hit.image;
	try {
		const page = await fetchModel(article.link, {
			maxBytes: PAGE_MAX_BYTES,
			timeoutMs: PAGE_TIMEOUT_MS,
			headers: {
				// Same polite, identifying UA the aggregator uses for the feeds —
				// it clears more publisher WAFs than a tool UA does.
				'user-agent': 'Mozilla/5.0 (compatible; three.ws-news/1.0; +https://three.ws)',
				accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
			},
		});
		const ct = page?.contentType || '';
		if (!ct.includes('html')) return remember(article.link, null);
		return remember(article.link, extractOgImage(new TextDecoder().decode(page.bytes)));
	} catch {
		// Publisher blocked or timed out — negative-cache so the next card render
		// doesn't re-pay the fetch; the feed refresh may still deliver an image.
		return remember(article.link, null);
	}
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.imgProxyIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl, 'too many image requests');

	const link = (new URL(req.url, 'http://x').searchParams.get('url') || '').trim();
	if (!link) return error(res, 400, 'missing_url', 'url is required');

	// Only articles the aggregator actually served are resolvable — anything
	// else is a probe, not a news card. The 404s are deliberately cacheable
	// (json(), not error()) so an imageless article costs one resolution, not
	// one per render.
	const article = await findArticle({ link });
	if (!article) {
		return json(
			res, 404,
			{ error: 'unknown_article', error_description: 'not a current article from the news feed' },
			{ 'cache-control': 'public, max-age=300, s-maxage=600' },
		);
	}

	const image = article.image || (await resolvePreviewImage(article));
	if (!image) {
		return json(
			res, 404,
			{ error: 'no_preview_image', error_description: 'the publisher page carries no preview image' },
			{ 'cache-control': 'public, max-age=1800, s-maxage=3600' },
		);
	}

	res.statusCode = 302;
	res.setHeader('location', `/api/img?url=${encodeURIComponent(image)}&seed=${encodeURIComponent(article.source || 'news')}`);
	res.setHeader('cache-control', 'public, max-age=3600, s-maxage=86400');
	res.end();
});
