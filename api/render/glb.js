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
// Response: image/png bytes on success; JSON error otherwise.
//
// Safety:
//   - Only http(s) URLs accepted (no file://, data://, internal IPs).
//   - GLB HEAD-fetched first to enforce a 10 MB cap before chromium boots.
//   - In-memory IP rate limit (60 renders / 10 min / IP) to keep chromium
//     warm-up costs bounded under abuse.

import { cors, error, method, readJson, wrap } from '../_lib/http.js';
import { renderGlbToPng } from '../_lib/render-glb.js';

export const maxDuration = 30;

const MAX_DIM = 2048;
const MIN_DIM = 64;
const MAX_GLB_BYTES = 10 * 1024 * 1024;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX = 60;

const rateMap = new Map();
function rateCheck(ip) {
	if (!ip) return true;
	const now = Date.now();
	const arr = (rateMap.get(ip) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
	if (arr.length >= RATE_LIMIT_MAX) {
		rateMap.set(ip, arr);
		return false;
	}
	arr.push(now);
	rateMap.set(ip, arr);
	return true;
}

function isPublicHttpUrl(u) {
	try {
		const url = new URL(u);
		if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
		const host = url.hostname;
		// Block localhost and link-local — chromium running on Vercel could
		// otherwise be coerced into hitting internal services.
		if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0') return false;
		if (host.startsWith('169.254.') || host.startsWith('10.') || host.startsWith('192.168.')) return false;
		if (host.endsWith('.internal') || host.endsWith('.local')) return false;
		return true;
	} catch {
		return false;
	}
}

async function preflightSize(url) {
	try {
		const r = await fetch(url, { method: 'HEAD' });
		const lenHeader = r.headers.get('content-length');
		if (!lenHeader) return { ok: true, size: null };
		const size = Number(lenHeader);
		if (Number.isFinite(size) && size > MAX_GLB_BYTES) {
			return { ok: false, code: 'glb_too_large', size, limit: MAX_GLB_BYTES };
		}
		return { ok: true, size };
	} catch {
		// Origins that don't support HEAD will still be filtered by chromium's
		// 15s render budget. Don't fail closed on a HEAD timeout.
		return { ok: true, size: null };
	}
}

export default wrap(async function handler(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS' })) return;
	if (!method(req, res, ['POST'])) return;

	const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress;
	if (!rateCheck(ip)) {
		return error(res, 429, 'rate_limited', `Too many render requests. Limit: ${RATE_LIMIT_MAX} per ${RATE_LIMIT_WINDOW_MS / 60000}m.`);
	}

	let body;
	try {
		body = await readJson(req, 5000);
	} catch (e) {
		return error(res, e.status || 400, 'bad_request', e.message);
	}

	const glbUrl = typeof body.glbUrl === 'string' ? body.glbUrl.trim() : '';
	if (!glbUrl) return error(res, 400, 'bad_request', 'glbUrl is required');
	if (!isPublicHttpUrl(glbUrl)) {
		return error(res, 400, 'bad_request', 'glbUrl must be a public http(s) URL');
	}

	const width = Math.max(MIN_DIM, Math.min(MAX_DIM, Number(body.width) || 1024));
	const height = Math.max(MIN_DIM, Math.min(MAX_DIM, Number(body.height) || 1024));
	const background = body.background === 'transparent' ? 'transparent' : (typeof body.background === 'string' && body.background ? body.background : '#0a0a0a');

	const pre = await preflightSize(glbUrl);
	if (!pre.ok) {
		return error(res, 413, pre.code, `GLB is ${pre.size} bytes; limit is ${pre.limit}`, { size: pre.size, limit: pre.limit });
	}

	let png;
	try {
		png = await renderGlbToPng({ glbUrl, width, height, background });
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
