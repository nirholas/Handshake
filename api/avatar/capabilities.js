// GET /api/avatar/capabilities — what a 3D avatar can actually do, before you render it.
//
// Every other avatar API in this stack answers "here is a picture". This one
// answers "here is what this model will and will not honor, and why". It reads
// the glTF JSON chunk of a GLB (a ranged read of the head of the file, never the
// mesh binary) and reports:
//
//   • which ARKit-52 morph targets are present, so an `expression` request can
//     be built from shapes that exist instead of shapes that were hoped for
//   • whether the skeleton maps onto the canonical humanoid bone set the
//     pre-baked clip library addresses, so `pose` and animation are knowable
//     up front rather than discovered as a T-pose
//   • geometry weight (triangles, textures, extensions) for budget decisions
//   • a plain-language verdict per capability that names the fix when the
//     answer is no
//
// Query parameters (exactly one of avatar/url is required):
//   avatar — three.ws avatar UUID (public or unlisted)
//   url    — any publicly reachable .glb URL, SSRF-guarded and range-capped
//
// Called with neither, it returns its own schema, so the endpoint is
// self-documenting from a browser address bar.
//
// The capability mapping is the same code the renderer and the retargeter run
// (src/runtime/arkit52.js, src/glb-canonicalize.js, src/animation-retarget.js),
// so this is a report of what will happen, not an estimate of it. Drives the
// /render-lab composer, which disables controls a model cannot honor.

import { cors, error, json, wrap, rateLimited } from '../_lib/http.js';
import { getAvatar } from '../_lib/avatars.js';
import { inspectGlbCapabilities } from '../_lib/avatar-capabilities.js';
import { ARKIT_52, ARKIT_VISEMES } from '../../src/runtime/arkit52.js';
import { CANONICAL_BONES } from '../../src/glb-canonicalize.js';

export const maxDuration = 20;

const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX = 120;
const rateMap = new Map();

// Inspection is deterministic for a given (model, version) pair, and the
// composer re-asks on every avatar switch. Cache the answer in-process so a
// browsing session costs one ranged read per avatar, not one per interaction.
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 500;
const cache = new Map();

function rateCheck(ip) {
	const now = Date.now();
	if (!ip) return { success: true, limit: RATE_LIMIT_MAX, remaining: RATE_LIMIT_MAX, reset: now + RATE_LIMIT_WINDOW_MS };
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

function cacheGet(key) {
	const hit = cache.get(key);
	if (!hit) return null;
	if (Date.now() - hit.at > CACHE_TTL_MS) {
		cache.delete(key);
		return null;
	}
	return hit.value;
}

function cacheSet(key, value) {
	if (cache.size >= CACHE_MAX) {
		const oldest = cache.keys().next().value;
		if (oldest !== undefined) cache.delete(oldest);
	}
	cache.set(key, { at: Date.now(), value });
}

function schema() {
	return {
		endpoint: 'GET /api/avatar/capabilities',
		description:
			'Report what a GLB avatar can actually do (expressions, poses, lipsync) before you render it. Reads only the glTF JSON chunk, so it is fast even on large models.',
		parameters: {
			avatar: { type: 'uuid', description: 'three.ws avatar ID (public or unlisted)' },
			url: { type: 'url', description: 'Any publicly reachable .glb URL. One of avatar or url is required.' },
		},
		returns: {
			rig: 'Detected authoring pipeline, bone count, canonical-skeleton coverage, baked clip names',
			morphs: 'ARKit-52 shapes present and missing, viseme set, non-ARKit custom shapes',
			geometry: 'Triangles, vertices, meshes, materials, textures, glTF extensions in use',
			can: 'Per-capability verdict (pose, expression, lipsync) with a plain-language reason',
		},
		reference: {
			arkit52: ARKIT_52,
			visemes: ARKIT_VISEMES,
			canonicalBones: CANONICAL_BONES,
		},
		examples: [
			'/api/avatar/capabilities?avatar=13f259c7-7024-4d68-b1f0-dbbf52c06209',
			'/api/avatar/capabilities?url=https://three.ws/avatars/selfie-girl.glb',
		],
		playground: 'https://three.ws/render-lab',
	};
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
		return rateLimited(res, rl, `Limit: ${RATE_LIMIT_MAX} inspections per ${RATE_LIMIT_WINDOW_MS / 60000}m`);
	}

	const q = new URL(req.url, 'http://x').searchParams;
	const avatarId = q.get('avatar');
	const rawUrl = q.get('url');

	if (!avatarId && !rawUrl) {
		return json(res, 200, schema(), { 'cache-control': 'public, max-age=86400' });
	}

	let source;
	let cacheKey;
	let subject = null;

	if (avatarId) {
		const avatar = await getAvatar({ id: avatarId });
		if (!avatar) return error(res, 404, 'not_found', 'Avatar not found or is private');
		if (!avatar.model_url) {
			return error(res, 403, 'private', 'Avatar is private: only public or unlisted avatars can be inspected');
		}
		source = avatar.model_url;
		// updated_at in the key means an edited avatar re-inspects instead of
		// serving a stale verdict about the model it used to be.
		cacheKey = `a:${avatar.id}:${avatar.updated_at || ''}`;
		subject = { kind: 'avatar', id: avatar.id, name: avatar.name || null, slug: avatar.slug || null };
	} else {
		if (!/^https?:\/\//i.test(rawUrl)) {
			return error(res, 400, 'invalid_url', 'url must be an absolute http(s) URL to a .glb file');
		}
		source = rawUrl;
		cacheKey = `u:${rawUrl}`;
		subject = { kind: 'url', url: rawUrl };
	}

	const cached = cacheGet(cacheKey);
	if (cached) {
		res.setHeader('x-capabilities-cache', 'hit');
		return json(res, 200, { ...cached, subject }, { 'cache-control': 'public, max-age=300, s-maxage=3600' });
	}

	let report;
	try {
		report = await inspectGlbCapabilities(source, { untrusted: Boolean(rawUrl) });
	} catch (err) {
		// A caller-supplied URL failing is a fact about their input, not a fault
		// on this side, so it comes back as a 400 they can act on.
		const isCallerUrl = Boolean(rawUrl);
		return error(
			res,
			isCallerUrl ? 400 : 502,
			'fetch_failed',
			`Could not read the model: ${err?.message || 'unknown error'}`,
		);
	}

	if (!report) {
		return error(res, 422, 'not_a_glb', 'That file is not a parseable binary glTF 2.0 (.glb). Only GLB is supported; .gltf + external buffers is not.');
	}

	cacheSet(cacheKey, report);
	res.setHeader('x-capabilities-cache', 'miss');
	return json(res, 200, { ...report, subject }, { 'cache-control': 'public, max-age=300, s-maxage=3600' });
});
