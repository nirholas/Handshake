// GET /api/render/animate — an animated avatar as a single image file.
//
//   https://three.ws/api/render/animate?avatar=<id>&clip=wave
//   https://three.ws/api/render/animate?src=https://example.com/model.glb&clip=idle
//   https://three.ws/api/render/animate                      → the clip catalog
//
// The output is an animated PNG: one file, no player, no script, no WebGL. It
// plays in every current browser, in a GitHub README, in a Notion page, in a
// Discord embed and in an <img> tag, which is the whole point. Anywhere a
// still image works, an agent's avatar can now be alive instead.
//
// This is the first render surface on the platform that is genuinely animated.
// It exists because the render path stopped being headless chromium: driving a
// clip through a browser costs a paint round-trip per frame, while the software
// rasterizer in api/_lib/render-cpu.js decodes the model once and reuses it for
// the whole sequence. Twenty frames cost about as much as one chromium boot.
//
// Query parameters:
//   avatar  — avatar UUID (public avatars only), or
//   src     — any public GLB URL (SSRF-guarded, byte-capped)
//   clip    — clip name from the built-in motion library (default: idle)
//   frames  — 1..48 (default 20)
//   fps     — 1..30 (default 16)
//   size    — 64..640 square (default 320); width/height override it
//   bg      — 'transparent' or a hex colour (default: transparent)
//   focus   — full | bust | head (default: full)
//   spin    — 0..360 degrees of turntable spread across the loop (default: 0)
//   t       — seconds into the clip for the first frame (default: 0)
//
// A caller that wants one still frame should use /api/render/glb or
// /api/avatar/render; this route always returns a loop.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { cors, error, json, method, wrap, rateLimited } from '../_lib/http.js';
import { getAvatar } from '../_lib/avatars.js';
import { renderGlbToApngCpu } from '../_lib/render-cpu.js';
import { assertSafePublicUrl, SsrfBlockedError } from '../_lib/ssrf-guard.js';
import { clientIp, limits } from '../_lib/rate-limit.js';
import { safeCssColor } from '../_lib/render-safe.js';

export const maxDuration = 60;

const DEFAULT_MODEL = '/avatars/default.glb';
const CLIP_DIR = 'public/animations/clips';
const MANIFEST = 'public/animations/manifest.json';

const MIN_DIM = 64;
const MAX_DIM = 640;
const MAX_FRAMES = 48;
const MAX_GLB_BYTES = 12 * 1024 * 1024;

// One render is 20 rasterized frames. Cache hard at the edge so a README badge
// or a Discord unfurl costs the origin one render per model, not one per view.
const CACHE_OK = 'public, max-age=3600, s-maxage=604800, stale-while-revalidate=604800';
const CACHE_CATALOG = 'public, max-age=86400';

const clampInt = (raw, min, max, fallback) => {
	const n = Number.parseInt(raw, 10);
	if (!Number.isFinite(n)) return fallback;
	return Math.max(min, Math.min(max, n));
};

const clampFloat = (raw, min, max, fallback) => {
	const n = Number.parseFloat(raw);
	if (!Number.isFinite(n)) return fallback;
	return Math.max(min, Math.min(max, n));
};

let _catalog = null;

/**
 * The built-in motion library, read from the manifest that ships with the
 * frontend. Cached for the life of the container: it is a static asset baked
 * into the image, so it cannot change under a running revision.
 */
export async function clipCatalog() {
	if (_catalog) return _catalog;
	const raw = await readFile(path.resolve(process.cwd(), MANIFEST), 'utf8');
	const parsed = JSON.parse(raw);
	const list = Array.isArray(parsed) ? parsed : parsed.clips || [];
	_catalog = new Map(
		list
			.filter((clip) => typeof clip?.name === 'string' && /^[a-z0-9-]+$/i.test(clip.name))
			.map((clip) => [clip.name, { name: clip.name, label: clip.label || clip.name, duration: clip.duration || 0, loop: clip.loop !== false }]),
	);
	return _catalog;
}

/**
 * Read one clip off disk. The name is checked against the manifest rather than
 * sanitized, so a traversal attempt cannot reach a path the catalog never named.
 */
export async function loadCatalogClip(name) {
	const catalog = await clipCatalog();
	if (!catalog.has(name)) return null;
	const file = path.resolve(process.cwd(), CLIP_DIR, `${name}.json`);
	try {
		return JSON.parse(await readFile(file, 'utf8'));
	} catch {
		return null;
	}
}

/** Resolve what to animate: an avatar id, an explicit GLB URL, or the default. */
export async function resolveModel(query, origin) {
	if (query.src) {
		const safe = await assertSafePublicUrl(String(query.src));
		return { url: typeof safe?.toString === 'function' ? safe.toString() : String(query.src), label: 'model' };
	}
	const avatarId = query.avatar ? String(query.avatar) : '';
	if (avatarId) {
		const avatar = await getAvatar({ id: avatarId });
		if (!avatar) return null;
		// model_url is null for a private avatar, which is exactly the case this
		// unauthenticated route must not render.
		if (!avatar.model_url) return null;
		return { url: avatar.model_url, label: avatar.name || 'avatar', updatedAt: avatar.updated_at || null };
	}
	return { url: new URL(DEFAULT_MODEL, origin).toString(), label: 'three.ws' };
}

export default wrap(async function handler(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const url = new URL(req.url, `https://${req.headers.host || 'three.ws'}`);
	const query = Object.fromEntries(url.searchParams.entries());
	const origin = `https://${req.headers.host || 'three.ws'}`;

	// No target and no explicit clip: answer with the catalog so the surface is
	// discoverable from a browser address bar, the way /api/render/avatar-clip is.
	if (!query.avatar && !query.src && !query.clip) {
		const catalog = await clipCatalog();
		return json(
			res,
			200,
			{
				renders: 'animated PNG (APNG) — plays in any <img> tag, README or embed',
				usage: '/api/render/animate?avatar=<id>&clip=<name>',
				params: {
					avatar: 'avatar UUID (public avatars only)',
					src: 'any public GLB URL',
					clip: 'clip name from the list below',
					frames: `1..${MAX_FRAMES} (default 20)`,
					fps: '1..30 (default 16)',
					size: `${MIN_DIM}..${MAX_DIM} square (default 320)`,
					bg: "'transparent' or a hex colour",
					focus: 'full | bust | head',
					spin: '0..360 degrees of turntable across the loop',
				},
				clips: [...catalog.values()],
			},
			{ 'cache-control': CACHE_CATALOG },
		);
	}

	const rl = await limits.renderIp(clientIp(req) || 'anon');
	if (!rl.success) {
		return rateLimited(res, rl, `Too many render requests. Limit: ${rl.limit} per 10m.`);
	}

	let source;
	try {
		source = await resolveModel(query, origin);
	} catch (err) {
		if (err instanceof SsrfBlockedError) {
			return error(res, 400, 'invalid_src', err.message);
		}
		throw err;
	}
	if (!source) {
		return error(res, 404, 'not_found', 'No public avatar with that id.');
	}

	const clipName = String(query.clip || 'idle');
	const clipJson = await loadCatalogClip(clipName);
	if (!clipJson) {
		const catalog = await clipCatalog();
		return error(res, 400, 'unknown_clip', `No clip named "${clipName}".`, {
			clips: [...catalog.keys()].slice(0, 40),
		});
	}

	const size = clampInt(query.size, MIN_DIM, MAX_DIM, 320);
	const width = clampInt(query.width, MIN_DIM, MAX_DIM, size);
	const height = clampInt(query.height, MIN_DIM, MAX_DIM, size);
	const frames = clampInt(query.frames, 1, MAX_FRAMES, 20);
	const fps = clampInt(query.fps, 1, 30, 16);
	const spin = clampFloat(query.spin, 0, 360, 0);
	const startTime = clampFloat(query.t ?? query.time, 0, 600, 0);
	const focus = ['full', 'bust', 'head'].includes(query.focus) ? query.focus : 'full';

	const rawBg = query.bg ?? query.background ?? 'transparent';
	const background = rawBg === 'transparent' ? 'transparent' : safeCssColor(rawBg) || '#0a0a0a';

	let png;
	try {
		png = await renderGlbToApngCpu({
			glbUrl: source.url,
			width,
			height,
			background,
			focus,
			frames,
			fps,
			spin,
			startTime,
			clipJson,
			maxBytes: MAX_GLB_BYTES,
			// Supersampling doubles the per-frame cost. A 20-frame loop is already
			// the expensive case, so full-quality AA is reserved for small frames.
			supersample: width * height <= 320 * 320 ? 2 : 1,
		});
	} catch (err) {
		return error(res, 502, 'render_failed', `Could not animate that model: ${err?.message || err}`);
	}

	res.statusCode = 200;
	res.setHeader('content-type', 'image/apng');
	res.setHeader('content-length', String(png.length));
	res.setHeader('cache-control', CACHE_OK);
	res.setHeader('x-render-lane', 'cpu');
	res.setHeader('x-render-frames', String(frames));
	res.end(png);
});
