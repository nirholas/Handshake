/**
 * GET /api/glance/card
 * --------------------
 * One agent, in whatever shape the surface asking for it can render.
 *
 *   ?agent=<uuid>                       required
 *   &format=json | svg | adaptive       default json
 *   &size=small | medium | large        svg only, default medium
 *   &theme=auto | light | dark          svg only, default auto
 *
 *   json      the glance card model. What the Windows 11 widgets board binds
 *             to its Adaptive Card template, and what <agent-glance> renders.
 *   svg       a self-contained card image for a README, a Slack unfurl, an
 *             <img>, or any widget host that only takes a picture.
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

import { loadGlanceCard, glanceEtag } from '../_lib/glance-card.js';
import { renderGlanceSvg, GLANCE_SIZES } from '../_lib/glance-svg.js';
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

const FORMATS = new Set(['json', 'svg', 'adaptive']);
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
	if (format === 'adaptive') return json(res, 200, adaptiveCardFor(card));
	return json(res, 200, card);
});

/**
 * The not-found state is designed, not blank: an SVG caller gets a card that
 * explains itself in the slot it was placed in, a JSON caller gets a 404 body
 * it can branch on.
 */
function notFound(res, format, size, theme, message) {
	if (format !== 'svg') return error(res, 404, 'not_found', message);
	const placeholder = {
		id: 'missing',
		name: 'Agent not found',
		description: message,
		headline: message,
		url: 'https://three.ws/agents',
		image: null,
		monogram: '3',
		accent: { from: '#64748b', to: '#334155', hue: 215 },
		status: 'new',
		metric: { label: 'Moves today', value: 0 },
		stats: [
			{ label: 'This week', value: 0 },
			{ label: 'All time', value: 0 },
			{ label: 'Skills', value: 0 },
		],
		lastAction: null,
	};
	res.statusCode = 404;
	res.setHeader('content-type', 'image/svg+xml; charset=utf-8');
	res.setHeader('cache-control', 'public, max-age=60');
	return res.end(renderGlanceSvg(placeholder, { size, theme }));
}
