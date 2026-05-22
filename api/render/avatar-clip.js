// POST /api/render/avatar-clip — public renderer for posed + camera-orbited
// avatar PNGs. Wraps renderClip from _lib/render-clip.js.
//
// Body (JSON):
//   {
//     glbUrl: "https://...",                     // required
//     width: 1024, height: 1024,                 // default 1024, max 2048
//     background: "#0a0a0a" | "transparent",
//     posePresetId: "wave" | "tpose" | ...,      // see GET /api/render/poses
//     cameraOrbit: { theta: 0, phi: 80, radius: null },  // degrees + meters
//     expression: { jawOpen: 0.4, mouthSmileLeft: 0.6, ... }   // ARKit-52 morphs
//   }

import { cors, error, json, method, readJson, wrap } from '../_lib/http.js';
import { renderClip } from '../_lib/render-clip.js';
import { PRESETS } from '../../src/pose-presets.js';

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
		return { ok: true, size: null };
	}
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

	if (method(req, res, ['POST'])) return;

	const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress;
	if (!rateCheck(ip)) {
		return error(res, 429, 'rate_limited', `Too many render requests. Limit: ${RATE_LIMIT_MAX} per ${RATE_LIMIT_WINDOW_MS / 60000}m.`);
	}

	let body;
	try {
		body = await readJson(req, 20_000);
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
			theta: Number(body.cameraOrbit.theta) || 0,
			phi: Number.isFinite(Number(body.cameraOrbit.phi)) ? Number(body.cameraOrbit.phi) : 80,
			radius: Number.isFinite(Number(body.cameraOrbit.radius)) ? Number(body.cameraOrbit.radius) : null,
		}
		: null;

	const expression = body.expression && typeof body.expression === 'object' ? body.expression : null;

	const pre = await preflightSize(glbUrl);
	if (!pre.ok) {
		return error(res, 413, pre.code, `GLB is ${pre.size} bytes; limit is ${pre.limit}`, { size: pre.size, limit: pre.limit });
	}

	let result;
	try {
		result = await renderClip({ glbUrl, width, height, background, posePresetId, cameraOrbit, expression });
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
