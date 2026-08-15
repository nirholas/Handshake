// POST /api/render/avatar-clip — public renderer for posed + camera-orbited
// avatar PNGs. Wraps renderClip from _lib/render-clip.js.
//
// Body (JSON):
//   {
//     glbUrl: "https://...",                     // required
//     width: 1024, height: 1024,                 // default 1024, max 2048
//     background: "#0a0a0a" | "transparent",
//     posePresetId: "wave" | "tpose" | ...,      // GET this URL for the catalog
//     cameraOrbit: { theta: 0, phi: 80, radius: null },  // degrees + meters
//     expression: { jawOpen: 0.4, mouthSmileLeft: 0.6, ... }   // ARKit-52 morphs
//   }

import { cors, error, json, method, readJson, wrap, rateLimited } from '../_lib/http.js';
import { renderClip } from '../_lib/render-clip.js';
import { PRESETS } from '../../src/pose-presets.js';
import { assertSafePublicUrl, SsrfBlockedError } from '../_lib/ssrf-guard.js';
import { clientIp, limits } from '../_lib/rate-limit.js';
import { safeCssColor } from '../_lib/render-safe.js';

export const maxDuration = 30;

const MAX_DIM = 2048;
const MIN_DIM = 64;
const MAX_GLB_BYTES = 10 * 1024 * 1024;

// Number() is too permissive for orbit fields: it turns null, '', and [] into a
// finite 0, so an explicit `radius: null` (the documented auto-frame value) and
// `phi: null` would read as real angles and silently reframe the shot. Only an
// actual number or a numeric string counts; everything else falls back.
function num(v) {
	if (typeof v === 'number') return Number.isFinite(v) ? v : null;
	if (typeof v === 'string' && v.trim() !== '') {
		const n = Number(v);
		return Number.isFinite(n) ? n : null;
	}
	return null;
}

export default wrap(async function handler(req, res) {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS' })) return;

	// GET surfaces the pose catalog so callers can pick a posePresetId
	// without scraping the source. Same URL as the POST renderer.
	if (req.method === 'GET') {
		return json(res, 200, {
			poses: PRESETS.map((p) => ({ id: p.id, label: p.label, group: p.group })),
			cameraOrbit: { theta: '0..360 (degrees, yaw)', phi: '0..180 (degrees, pitch from top)', radius: 'meters or null for auto-frame' },
			background: ['transparent', '#0a0a0a', 'any CSS color'],
		}, { 'cache-control': 'public, max-age=86400' });
	}

	if (!method(req, res, ['POST'])) return;

	// Shared across both public renderers and distributed (see limits.renderIp):
	// they share one chromium, so they share one budget.
	const rl = await limits.renderIp(clientIp(req) || 'anon');
	if (!rl.success) {
		return rateLimited(res, rl, `Too many render requests. Limit: ${rl.limit} per 10m.`);
	}

	let body;
	try {
		body = await readJson(req, 20_000);
	} catch (e) {
		return error(res, e.status || 400, 'bad_request', e.message);
	}

	const glbUrl = typeof body.glbUrl === 'string' ? body.glbUrl.trim() : '';
	if (!glbUrl) return error(res, 400, 'bad_request', 'glbUrl is required');
	// Fast pre-check before booting chromium. The authoritative SSRF boundary is
	// renderClip → fetchModel (DNS-pinned per hop, redirects re-validated, capped).
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

	let posePresetId = null;
	if (body.posePresetId) {
		const found = PRESETS.find((p) => p.id === body.posePresetId);
		if (!found) {
			return error(res, 400, 'unknown_pose', `Unknown pose preset "${body.posePresetId}". GET this endpoint for the catalog.`);
		}
		posePresetId = found.id;
	}

	const cameraOrbit = body.cameraOrbit && typeof body.cameraOrbit === 'object'
		? {
			theta: num(body.cameraOrbit.theta) ?? 0,
			phi: num(body.cameraOrbit.phi) ?? 80,
			// null means "auto-frame from the bounding box", which is what the docs
			// show and what an omitted radius does. A positive number overrides it.
			radius: (num(body.cameraOrbit.radius) ?? 0) > 0 ? num(body.cameraOrbit.radius) : null,
		}
		: null;

	const expression = body.expression && typeof body.expression === 'object' ? body.expression : null;

	let result;
	try {
		result = await renderClip({ glbUrl, width, height, background, posePresetId, cameraOrbit, expression, maxBytes: MAX_GLB_BYTES });
	} catch (err) {
		const status = err?.status || 502;
		return error(res, status, err?.code || 'render_failed', err?.message || 'render failed');
	}

	res.statusCode = 200;
	res.setHeader('content-type', 'image/png');
	res.setHeader('content-length', String(result.png.length));
	res.setHeader('cache-control', 'public, max-age=300, s-maxage=86400');
	res.setHeader('x-render-width', String(width));
	res.setHeader('x-render-height', String(height));
	res.setHeader('x-render-background', background);
	if (result.pose) {
		res.setHeader('x-render-pose', result.pose.id);
		res.setHeader('x-render-pose-label', result.pose.label);
	}
	res.end(result.png);
});
