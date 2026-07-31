// GET /api/avatar/render — public avatar render API.
//
// Returns a rendered PNG/JPEG/WebP of any public avatar. Designed for use in
// <img> tags, social cards, partner integrations, and game engine loaders.
//
// Query parameters:
//   avatar     (required) — avatar UUID
//   scene      — full-body | upper-body | portrait | headshot  (default: upper-body)
//   size       — square pixel dimension  (default: 512, min: 64, max: 2048)
//   width      — override width  (takes precedence over size)
//   height     — override height (takes precedence over size)
//   bg         — CSS color or 'transparent'  (default: transparent)
//   pose       — pose preset ID  (GET /api/render/avatar-clip for catalog)
//   expression — JSON-encoded ARKit-52 morph map  (e.g. {"mouthSmile":0.6})
//   format     — png | jpeg | webp  (default: png)
//   quality    — 1-100 for lossy formats  (default: 90)
//
// When an expression is requested, fresh (non-cached) responses carry
// `x-render-expression: applied | partial | none`; `partial`/`none` add
// `x-render-expression-missing` listing the morph names the model does not
// have. A model with zero morph targets renders fine but reports `none`
// instead of silently ignoring the expression.
//
// Caching:
//   First request per parameter combo renders via headless chromium + three.js
//   and caches the result in R2. Subsequent requests 302 to the CDN URL.
//   Cache is keyed on avatar_id + param hash + avatar updated_at, so updates
//   to the avatar (appearance, GLB, etc.) automatically bust the cache.
//
// The chromium + three.js pipeline and the param/cache layer live in
// api/_lib/avatar-render.js so the render_avatar_image MCP tool shares the exact
// same code path — this route is the public, unauthenticated surface on top.

import { cors, error, json, wrap, rateLimited } from '../_lib/http.js';
import { getAvatar } from '../_lib/avatars.js';
import {
	SCENE_PRESETS,
	FORMAT_TYPES,
	MIN_DIM,
	MAX_DIM,
	DEFAULT_SIZE,
	resolveRenderParams,
	renderAvatarImage,
} from '../_lib/avatar-render.js';
import { PRESETS } from '../../src/pose-presets.js';

export const maxDuration = 30;

const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX = 120;

const rateMap = new Map();
function rateCheck(ip) {
	const now = Date.now();
	if (!ip)
		return { success: true, limit: RATE_LIMIT_MAX, remaining: RATE_LIMIT_MAX, reset: now + RATE_LIMIT_WINDOW_MS };
	const arr = (rateMap.get(ip) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
	if (arr.length >= RATE_LIMIT_MAX) {
		rateMap.set(ip, arr);
		return { success: false, limit: RATE_LIMIT_MAX, remaining: 0, reset: arr[0] + RATE_LIMIT_WINDOW_MS };
	}
	arr.push(now);
	rateMap.set(ip, arr);
	if (rateMap.size > 10000) {
		for (const [k, v] of rateMap) {
			if (v.every((t) => now - t >= RATE_LIMIT_WINDOW_MS)) rateMap.delete(k);
		}
	}
	return { success: true, limit: RATE_LIMIT_MAX, remaining: RATE_LIMIT_MAX - arr.length, reset: now + RATE_LIMIT_WINDOW_MS };
}

export default wrap(async function handler(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;

	if (req.method !== 'GET') {
		res.setHeader('allow', 'GET, OPTIONS');
		return error(res, 405, 'method_not_allowed', 'Use GET');
	}

	const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress;
	const rl = rateCheck(ip);
	if (!rl.success) {
		return rateLimited(res, rl, `Limit: ${RATE_LIMIT_MAX} renders per ${RATE_LIMIT_WINDOW_MS / 60000}m`);
	}

	const url = new URL(req.url, 'http://x');
	const q = url.searchParams;

	const avatarId = q.get('avatar');
	if (!avatarId) {
		return json(res, 200, {
			endpoint: 'GET /api/avatar/render',
			description: 'Render any public three.ws avatar as an image. Use in <img> tags, social cards, game engines, or anywhere you need a profile picture.',
			parameters: {
				avatar: { required: true, type: 'uuid', description: 'Avatar ID' },
				scene: { type: 'enum', values: Object.keys(SCENE_PRESETS), default: 'upper-body', description: 'Camera framing preset' },
				size: { type: 'integer', min: MIN_DIM, max: MAX_DIM, default: DEFAULT_SIZE, description: 'Square dimension in pixels (overridden by width/height)' },
				width: { type: 'integer', min: MIN_DIM, max: MAX_DIM, description: 'Override width' },
				height: { type: 'integer', min: MIN_DIM, max: MAX_DIM, description: 'Override height' },
				bg: { type: 'string', default: 'transparent', description: 'Background color (CSS color or "transparent")' },
				pose: { type: 'string', description: 'Pose preset ID (GET /api/render/avatar-clip for catalog)' },
				expression: { type: 'json', description: 'ARKit-52 morph target map, e.g. {"mouthSmile":0.6}' },
				format: { type: 'enum', values: ['png', 'jpeg', 'webp'], default: 'png' },
				quality: { type: 'integer', min: 1, max: 100, default: 90, description: 'Quality for jpeg/webp' },
			},
			scenes: Object.fromEntries(
				Object.entries(SCENE_PRESETS).map(([k, v]) => [k, { phi: v.phi, theta: v.theta }])
			),
			poses: PRESETS.map((p) => ({ id: p.id, label: p.label, group: p.group })),
			example: '/api/avatar/render?avatar=YOUR_AVATAR_ID&scene=portrait&size=256&bg=transparent',
		}, { 'cache-control': 'public, max-age=86400' });
	}

	const avatar = await getAvatar({ id: avatarId });
	if (!avatar) {
		return error(res, 404, 'not_found', 'Avatar not found or is private');
	}
	if (!avatar.model_url) {
		return error(res, 403, 'private', 'Avatar is private — only public or unlisted avatars can be rendered');
	}

	const resolved = resolveRenderParams({
		scene: q.get('scene'),
		size: q.get('size'),
		width: q.get('width'),
		height: q.get('height'),
		bg: q.get('bg'),
		format: q.get('format'),
		quality: q.get('quality'),
		pose: q.get('pose'),
		expression: q.get('expression'),
	});
	if (resolved.error) {
		return error(res, 400, resolved.error.code, resolved.error.message);
	}
	const params = resolved.params;

	let out;
	try {
		out = await renderAvatarImage({ avatar, glbUrl: avatar.model_url, params, awaitUpload: false });
	} catch (err) {
		const status = err?.status || 502;
		return error(res, status, err?.code || 'render_failed', err?.message || 'Render failed');
	}

	if (out.cached) {
		res.statusCode = 302;
		res.setHeader('location', out.imageUrl);
		res.setHeader('cache-control', 'public, max-age=300, s-maxage=86400');
		res.setHeader('x-render-cache', 'hit');
		res.end();
		return;
	}

	const imageBuffer = out.buffer;
	res.statusCode = 200;
	res.setHeader('content-type', out.contentType);
	res.setHeader('content-length', String(imageBuffer.length));
	res.setHeader('cache-control', 'public, max-age=300, s-maxage=86400');
	res.setHeader('x-render-cache', 'miss');
	res.setHeader('x-render-scene', params.scene);
	res.setHeader('x-render-size', `${params.width}x${params.height}`);
	// An expression request against a model that lacks the morph targets used to
	// be indistinguishable from success. Report what actually landed so callers
	// can tell "applied" from "the model cannot express this".
	if (out.expressionReport) {
		const { requested, missing } = out.expressionReport;
		const state = missing.length === 0 ? 'applied' : missing.length === requested.length ? 'none' : 'partial';
		res.setHeader('x-render-expression', state);
		if (missing.length) {
			res.setHeader('x-render-expression-missing', missing.slice(0, 32).join(','));
		}
	}
	res.setHeader('access-control-expose-headers', 'x-render-cache, x-render-scene, x-render-size, x-render-expression, x-render-expression-missing');
	res.end(imageBuffer);
});
