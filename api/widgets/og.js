/**
 * Widget OG image endpoint
 * ------------------------
 * GET /api/widgets/:id/og
 *
 * Returns a 1200x630 SVG card (Slack/Discord/X all render image/svg+xml in
 * OG previews, so we avoid pulling in canvas/sharp on the serverless side).
 * If the widget's avatar has a thumbnail, we 302 to that PNG for a richer
 * preview. Falls back to a server-rendered SVG card on miss.
 */

import { sql } from '../_lib/db.js';
import { getAvatar } from '../_lib/avatars.js';
import { cors, wrap } from '../_lib/http.js';
import { isDemoWidgetId, getDemoWidget } from './_demo-fixtures.js';

const CACHE_CARD = 'public, max-age=3600, s-maxage=86400';
const CACHE_REDIR = 'public, max-age=3600';

const TYPE_LABEL = {
	turntable: 'Turntable Showcase',
	'animation-gallery': 'Animation Gallery',
	'talking-agent': 'Talking Agent',
	passport: 'ERC-8004 Passport',
	'hotspot-tour': 'Hotspot Tour',
};

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;

	const url = new URL(req.url, 'http://x');
	const widgetId = url.searchParams.get('id');

	if (!widgetId) return sendNotFound(res);

	const widget = await loadWidget(widgetId);
	if (!widget) return sendNotFound(res);

	if (widget.is_public === false) {
		sendCardSvg(res, 200, CACHE_CARD, {
			name: 'Private widget',
			type: 'three.ws',
		});
		return;
	}

	if (widget.avatar_id) {
		const avatar = await getAvatar({ id: widget.avatar_id });
		if (avatar?.thumbnail_url) {
			res.statusCode = 302;
			res.setHeader('location', avatar.thumbnail_url);
			res.setHeader('cache-control', CACHE_REDIR);
			res.end();
			return;
		}
	}

	sendCardSvg(res, 200, CACHE_CARD, {
		name: widget.name || 'Widget',
		type: TYPE_LABEL[widget.type] || 'Widget',
	});
});

async function loadWidget(id) {
	// The demo widgets are served by /w/:id and the oEmbed route from baked-in
	// fixtures rather than the DB, so resolve them here too. Without this every
	// demo widget's og:image (which /w/:id points at) answers 404 and social
	// previews render the not-found card instead of the widget.
	if (isDemoWidgetId(id)) {
		const demo = getDemoWidget(id);
		if (!demo) return null;
		return { id: demo.id, name: demo.name, type: demo.type, avatar_id: null, is_public: true };
	}
	try {
		const [row] = await sql`
			select id, name, type, avatar_id, is_public
			from widgets
			where id = ${id} and deleted_at is null
			limit 1
		`;
		return row || null;
	} catch (err) {
		// A crawler must never see a 500 here: an unrenderable og:image poisons
		// the preview for every share of the link. Treat a missing table as
		// not-found so the card still renders; anything else is a real fault.
		if (/relation .* does not exist/i.test(err?.message || '')) return null;
		throw err;
	}
}

function sendNotFound(res) {
	sendCardSvg(res, 404, 'public, max-age=60', {
		name: 'Widget not found',
		type: 'three.ws',
	});
}

function sendCardSvg(res, status, cacheControl, { name, type }) {
	res.statusCode = status;
	res.setHeader('content-type', 'image/svg+xml; charset=utf-8');
	res.setHeader('cache-control', cacheControl);
	res.end(renderCardSvg({ name, type }));
}

function renderCardSvg({ name, type }) {
	const safeName = escapeXml(truncate(name, 60));
	const safeType = escapeXml(truncate(type, 40));
	return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-label="${safeName}">
	<rect width="1200" height="630" fill="#0b0d10"/>
	<rect x="80" y="80" width="180" height="36" rx="18" fill="rgba(139,92,246,0.18)" stroke="rgba(139,92,246,0.6)" stroke-width="1"/>
	<text x="170" y="104" fill="#c4b5fd" font-family="Inter, -apple-system, system-ui, sans-serif" font-size="16" font-weight="500" letter-spacing="2" text-anchor="middle">${safeType.toUpperCase()}</text>
	<text x="80" y="320" fill="#e5e5e5" font-family="Inter, -apple-system, system-ui, sans-serif" font-size="76" font-weight="300" letter-spacing="-2">${safeName}</text>
	<text x="80" y="380" fill="rgba(229,229,229,0.55)" font-family="Inter, -apple-system, system-ui, sans-serif" font-size="24" font-weight="400">Embeddable 3D, no code.</text>
	<text x="80" y="570" fill="rgba(229,229,229,0.3)" font-family="Inter, -apple-system, system-ui, sans-serif" font-size="20" font-weight="400" letter-spacing="4">three.ws</text>
</svg>`;
}

function truncate(s, n) {
	s = String(s || '');
	return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

function escapeXml(s) {
	return String(s)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}
