/**
 * oEmbed endpoint for widget URLs
 * -------------------------------
 * GET /api/widgets/oembed?url=<widget-url>[&format=json|xml]
 *
 * Implements https://oembed.com with type=rich. Accepts canonical widget URLs
 * (https://host/w/<id>) and the legacy SPA hash form (https://host/app#widget=<id>).
 * The html payload is a sandboxed iframe so consumers (WordPress, Ghost, Notion,
 * Discord, Slack) can render the widget inline.
 */

import { sql } from '../_lib/db.js';
import { env } from '../_lib/env.js';
import { cors, wrap, error } from '../_lib/http.js';
import { isDemoWidgetId, getDemoWidget } from './_demo-fixtures.js';

const DEFAULT_W = 600;
const DEFAULT_H = 600;
const THUMB_W = 1200;
const THUMB_H = 630;

const TYPE_DIMENSIONS = {
	turntable: { width: 600, height: 600 },
	'animation-gallery': { width: 720, height: 720 },
	'talking-agent': { width: 420, height: 600 },
	passport: { width: 480, height: 560 },
	'hotspot-tour': { width: 800, height: 600 },
};

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;

	const url = new URL(req.url, 'http://x');
	const target = url.searchParams.get('url');
	const format = (url.searchParams.get('format') || 'json').toLowerCase();
	const maxW = parseInt(url.searchParams.get('maxwidth') || '0', 10) || null;
	const maxH = parseInt(url.searchParams.get('maxheight') || '0', 10) || null;

	if (!target) return error(res, 400, 'invalid_request', 'url parameter required');

	const widgetId = extractWidgetId(target);
	if (!widgetId) return error(res, 404, 'not_found', 'url is not a recognised widget url');

	const widget = await loadWidget(widgetId);
	if (!widget) return error(res, 404, 'not_found', 'widget not found');

	const origin = env.APP_ORIGIN;
	const embedUrl = `${origin}/widget#widget=${widget.id}&kiosk=true`;
	const pageUrl = `${origin}/w/${widget.id}`;
	const thumbUrl = `${origin}/api/widgets/${widget.id}/og`;
	const title = widget.name || 'Widget';

	const dims = TYPE_DIMENSIONS[widget.type] || { width: DEFAULT_W, height: DEFAULT_H };
	const width = clamp(maxW || dims.width, 240, 1600);
	const height = clamp(maxH || dims.height, 240, 1600);

	const iframe = `<iframe src="${escapeAttr(embedUrl)}" width="${width}" height="${height}" style="border:0;border-radius:12px;max-width:100%" allow="autoplay; xr-spatial-tracking; clipboard-write" sandbox="allow-scripts allow-same-origin allow-popups allow-forms" loading="lazy"></iframe>`;

	const payload = {
		type: 'rich',
		version: '1.0',
		provider_name: 'three.ws',
		provider_url: origin,
		title,
		author_name: title,
		author_url: pageUrl,
		html: iframe,
		width,
		height,
		thumbnail_url: thumbUrl,
		thumbnail_width: THUMB_W,
		thumbnail_height: THUMB_H,
		cache_age: 900,
	};

	res.setHeader('cache-control', 'public, max-age=900');

	if (format === 'xml') {
		res.statusCode = 200;
		res.setHeader('content-type', 'text/xml; charset=utf-8');
		res.end(toXml(payload));
		return;
	}

	res.statusCode = 200;
	res.setHeader('content-type', 'application/json+oembed; charset=utf-8');
	res.end(JSON.stringify(payload));
});

async function loadWidget(id) {
	if (isDemoWidgetId(id)) {
		const demo = getDemoWidget(id);
		if (!demo) return null;
		return { id: demo.id, name: demo.name, type: demo.type, avatar_id: null };
	}
	try {
		const [row] = await sql`
			select id, name, type, avatar_id
			from widgets
			where id = ${id} and is_public = true and deleted_at is null
			limit 1
		`;
		return row || null;
	} catch (err) {
		if (/relation .* does not exist/i.test(err?.message || '')) return null;
		throw err;
	}
}

function extractWidgetId(target) {
	let parsed;
	try {
		parsed = new URL(target);
	} catch {
		return null;
	}

	const originStr = `${parsed.protocol}//${parsed.host}`;
	const okOrigin =
		originStr === env.APP_ORIGIN ||
		/^https?:\/\/localhost(:\d+)?$/.test(originStr) ||
		/^https?:\/\/3d\.irish$/.test(originStr);
	if (!okOrigin) return null;

	const pathMatch = parsed.pathname.match(/^\/w\/([A-Za-z0-9_-]+)\/?$/);
	if (pathMatch) return pathMatch[1];

	// Accept legacy /#widget=<id>, the /app#widget=<id> SPA form, and the
	// current /widget#widget=<id> slim shell — embedders may have copied any
	// of them. All three resolve to the same widget id.
	if (
		parsed.hash &&
		(parsed.pathname === '/' || parsed.pathname === '/app' || parsed.pathname === '/widget')
	) {
		const hashMatch = parsed.hash.match(/(?:^|[#&])widget=([A-Za-z0-9_-]+)/);
		if (hashMatch) return hashMatch[1];
	}
	return null;
}

function clamp(n, lo, hi) {
	return Math.max(lo, Math.min(hi, n));
}

function toXml(payload) {
	const lines = Object.entries(payload).map(([k, v]) => `  <${k}>${escapeXml(String(v))}</${k}>`);
	return `<?xml version="1.0" encoding="utf-8" standalone="yes"?>\n<oembed>\n${lines.join('\n')}\n</oembed>`;
}

function escapeXml(s) {
	return String(s)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

function escapeAttr(s) {
	return String(s)
		.replace(/&/g, '&amp;')
		.replace(/"/g, '&quot;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}
