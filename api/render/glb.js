// POST /api/render/glb — public renderer that takes an arbitrary GLB URL
// and returns a PNG. Same headless chromium pipeline used by the OG-card
// path, exposed as a content-typed PNG response.
//
// Body (JSON):
//   {
//     glbUrl: "https://example.com/model.glb",   // required, http(s)
//     width: 1024,                               // default 1024, max 2048
//     height: 1024,                              // default 1024, max 2048
//     background: "#0a0a0a" | "transparent"      // default #0a0a0a
//   }
//
// GET /api/render/glb?glbUrl=…&width=…&height=…&background=… — the same
// render addressable by URL, for consumers that can only follow a link:
// og:image / twitter:image unfurls (the AR launch page points its share
// card here), <img> tags, markdown embeds. Identical validation, limits,
// and rate budget as POST; responses CDN-cache for a day, so social
// crawlers hit chromium once per model, not once per share.
//
// Response: image/png bytes on success; JSON error otherwise.
//
// Safety:
//   - Only http(s) URLs accepted (no file://, data://, internal IPs).
//   - `background` must parse as a CSS color. It is interpolated into the
//     render page, and that page has container network egress, so markup in
//     this field would be script execution with an internal-network view.
//   - GLB HEAD-fetched first to enforce a 10 MB cap before chromium boots.
//   - Distributed IP rate limit (60 renders / 10 min / IP, shared with
//     /api/render/avatar-clip) to keep chromium costs bounded under abuse.

import { cors, error, method, readJson, wrap, rateLimited } from '../_lib/http.js';
import { renderGlbToPng } from '../_lib/render-glb.js';
import { assertSafePublicUrl, SsrfBlockedError } from '../_lib/ssrf-guard.js';
import { clientIp, limits } from '../_lib/rate-limit.js';
import { safeCssColor } from '../_lib/render-safe.js';

export const maxDuration = 30;

const MAX_DIM = 2048;
const MIN_DIM = 64;
const MAX_GLB_BYTES = 10 * 1024 * 1024;

export default wrap(async function handler(req, res) {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS' })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	// Shared across both public renderers and distributed (see limits.renderIp):
	// they share one chromium, so they share one budget.
	const rl = await limits.renderIp(clientIp(req) || 'anon');
	if (!rl.success) {
		return rateLimited(res, rl, `Too many render requests. Limit: ${rl.limit} per 10m.`);
	}

	// GET carries the same fields as query params; POST keeps the JSON body.
	let body;
	if (req.method === 'GET') {
		const q = new URL(req.url, 'http://x').searchParams;
		body = {
			glbUrl: q.get('glbUrl') || q.get('src') || '',
			width: q.get('width'),
			height: q.get('height'),
			background: q.get('background') || undefined,
		};
	} else {
		try {
			body = await readJson(req, 5000);
		} catch (e) {
			return error(res, e.status || 400, 'bad_request', e.message);
		}
	}

	const glbUrl = typeof body.glbUrl === 'string' ? body.glbUrl.trim() : '';
	if (!glbUrl) return error(res, 400, 'bad_request', 'glbUrl is required');
	// Fast, cheap rejection before booting chromium. The authoritative SSRF
	// boundary is renderGlbToPng → fetchModel, which pins DNS per hop and
	// re-validates every redirect; this pre-check just avoids the chromium spin-up
	// for an obviously-private host. allowHttp mirrors the renderer's fetcher.
	try {
		await assertSafePublicUrl(glbUrl, { allowHttp: true });
	} catch (e) {
		if (e instanceof SsrfBlockedError) return error(res, 400, 'bad_request', 'glbUrl must be a public http(s) URL');
		throw e;
	}

	const width = Math.max(MIN_DIM, Math.min(MAX_DIM, Number(body.width) || 1024));
	const height = Math.max(MIN_DIM, Math.min(MAX_DIM, Number(body.height) || 1024));
	// The color is interpolated into the render page, so it is validated here
	// rather than escaped downstream: a caller who wants a color gets one, and a
	// caller who wants markup gets a 400 they can act on.
	let background = '#0a0a0a';
	if (body.background === 'transparent') {
		background = 'transparent';
	} else if (body.background !== undefined && body.background !== null && body.background !== '') {
		background = safeCssColor(body.background);
		if (!background) {
			return error(res, 400, 'bad_request', 'background must be "transparent" or a CSS color (hex, rgb()/rgba(), hsl()/hsla(), or a named color)');
		}
	}

	let png;
	try {
		png = await renderGlbToPng({ glbUrl, width, height, background, maxBytes: MAX_GLB_BYTES });
	} catch (err) {
		const status = err?.status || 502;
		return error(res, status, err?.code || 'render_failed', err?.message || 'render failed');
	}

	res.statusCode = 200;
	res.setHeader('content-type', 'image/png');
	res.setHeader('content-length', String(png.length));
	res.setHeader('cache-control', 'public, max-age=600, s-maxage=86400');
	res.setHeader('x-render-width', String(width));
	res.setHeader('x-render-height', String(height));
	res.setHeader('x-render-background', background);
	res.end(png);
});
