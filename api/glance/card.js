/**
 * GET /api/glance/card
 * --------------------
 * One agent, in whatever shape the surface asking for it can render.
 *
 *   ?agent=<uuid>                       required
 *   &format=json | svg | png | adaptive default json
 *   &size=small | medium | large        svg and png, default medium
 *   &theme=auto | light | dark          svg and png, default auto (png: dark)
 *   &scale=1 | 2 | 3                    png only, pixel density, default 2
 *
 *   json      the glance card model. What the Windows 11 widgets board binds
 *             to its Adaptive Card template, and what <agent-glance> renders.
 *   svg       a self-contained card image for a README, a Slack unfurl, an
 *             <img>, or any widget host that only takes a picture.
 *   png       the same card as a bitmap, for hosts that cannot draw SVG:
 *             Android RemoteViews, WidgetKit, chat clients that unfurl only
 *             raster images.
 *   adaptive  a fully bound Adaptive Card, for hosts that render one without
 *             doing their own templating.
 *
 * Public, cacheable, side-effect free: an agent profile is already public
 * (api/agent-og.js serves the same agent to any crawler), so a card of it is
 * too. Private avatars never leak: the thumbnail is only attached when the
 * avatar is public or unlisted, otherwise the card falls back to the generated
 * monogram. Nothing here needs a session, which is what lets a widget board
 * poll it from an OS process with no cookies.
 *
 * A missing agent answers with a real card that says so (and a 404 status),
 * never a broken image in someone's home screen slot.
 */

import { loadGlanceCard, glanceEtag, noticeCard } from '../_lib/glance-card.js';
import { renderGlanceSvg, GLANCE_SIZES } from '../_lib/glance-svg.js';
import { glancePng, pngOptions } from '../_lib/glance-png.js';
import { adaptiveCardFor } from '../_lib/glance-adaptive.js';
import { cors, json, error, wrap, method, varyOn } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { isUuid } from '../_lib/validate.js';

// Widget boards poll on their own schedule (Windows every ~15 min, a page
// every few minutes). The card is cheap and non-critical, so let the CDN
// answer most of it and keep serving a slightly stale card while revalidating
// rather than showing an empty slot.
const CACHE = 'public, max-age=60, s-maxage=120, stale-while-revalidate=600';
const CACHE_MISS = 'public, max-age=30, s-maxage=60';

const FORMATS = new Set(['json', 'svg', 'png', 'adaptive']);
const THEMES = new Set(['auto', 'light', 'dark']);

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.widgetRead(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many card reads');

	const url = new URL(req.url, 'http://x');
	const agentId = url.searchParams.get('agent') || url.searchParams.get('id') || '';
	const format = FORMATS.has(url.searchParams.get('format'))
		? url.searchParams.get('format')
		: 'json';
	const size = GLANCE_SIZES[url.searchParams.get('size')] ? url.searchParams.get('size') : 'medium';
	const theme = THEMES.has(url.searchParams.get('theme')) ? url.searchParams.get('theme') : 'auto';

	// The theme and size live in the query string, so the CDN keys on them
	// already; Vary keeps a shared cache from handing an SVG to a JSON caller.
	varyOn(res, 'accept');

	if (!isUuid(agentId)) return notFound(res, format, size, theme, 'That agent id is not valid.');

	const card = await loadGlanceCard(agentId);
	if (!card) return notFound(res, format, size, theme, 'This agent is not on three.ws.');

	const etag = await glanceEtag(card);
	res.setHeader('etag', etag);
	res.setHeader('cache-control', card.cache === 'hit' ? CACHE : CACHE_MISS);
	if (req.headers['if-none-match'] === etag) {
		res.statusCode = 304;
		return res.end();
	}

	if (format === 'svg') {
		res.statusCode = 200;
		res.setHeader('content-type', 'image/svg+xml; charset=utf-8');
		return res.end(renderGlanceSvg(card, { size, theme }));
	}
	if (format === 'png') return sendPng(res, 200, card, url.searchParams);
	if (format === 'adaptive') return json(res, 200, adaptiveCardFor(card));
	return json(res, 200, card);
});

/**
 * The not-found state is designed, not blank: an SVG caller gets a card that
 * explains itself in the slot it was placed in, a JSON caller gets a 404 body
 * it can branch on.
 */
function notFound(res, format, size, theme, message) {
	if (format !== 'svg' && format !== 'png') return error(res, 404, 'not_found', message);
	const placeholder = noticeCard({
		name: 'Agent not found',
		description: message,
		headline: message,
		url: 'https://three.ws/agents',
	});
	if (format === 'png') return sendPng(res, 404, placeholder, new URLSearchParams({ size, theme }));
	res.statusCode = 404;
	res.setHeader('content-type', 'image/svg+xml; charset=utf-8');
	res.setHeader('cache-control', 'public, max-age=60');
	return res.end(renderGlanceSvg(placeholder, { size, theme }));
}

async function sendPng(res, status, card, params) {
	const { png, width, height, cache } = await glancePng(card, pngOptions(params));
	res.statusCode = status;
	res.setHeader('content-type', 'image/png');
	res.setHeader('content-length', String(png.length));
	res.setHeader('x-glance-width', String(width));
	res.setHeader('x-glance-height', String(height));
	res.setHeader('x-glance-cache', cache);
	if (status !== 200) res.setHeader('cache-control', 'public, max-age=60');
	return res.end(png);
}
