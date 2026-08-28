// Server-side GLB rendering with no browser in the path.
// -----------------------------------------------------
// The chromium lane in ./render-glb.js works, and costs a 300 MB browser
// launch, a CDN fetch of the three.js addons, and 3-15s per cold render. This
// lane runs the @three-ws/render software rasterizer in-process instead: same
// framing, same three-light studio rig, same PNG out, in roughly 200-500 ms
// with no subprocess and no external asset fetch.
//
// It is the primary lane. Chromium stays as the failover for the handful of
// models this renderer cannot decode on its own (Draco geometry, KTX2/Basis
// textures), which it reports honestly rather than rendering wrong.
//
// The GLB still arrives through the SSRF-pinned fetchModel path, so a caller
// supplied URL gets exactly the same DNS-pinned, redirect-revalidated,
// byte-capped treatment it got before.

import { AvatarModel, renderFrame, renderFrames, encodePng, encodeApng } from '@three-ws/render';
import { fetchModel } from './fetch-model.js';

// Framing constants shared with the chromium lane so a CPU render and a
// browser render of the same avatar compose identically.
export const CAMERA_YAW_DEG = 26;
export const FRAME_MARGIN = 1.22;

const DEFAULT_MAX_GLB_BYTES = 25 * 1024 * 1024;

// A warm container renders the same avatar repeatedly (OG card, then thumbnail,
// then a clip). Parsing and texture decoding dominate the cost, so keep a few
// decoded models around. Bounded by count and by age: these hold megabytes of
// RGBA mip pyramids and must never become a leak.
const MODEL_CACHE_MAX = 4;
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
const _models = new Map();

function cacheGet(key) {
	const hit = _models.get(key);
	if (!hit) return null;
	if (Date.now() - hit.at > MODEL_CACHE_TTL_MS) {
		_models.delete(key);
		return null;
	}
	// Refresh insertion order so the LRU eviction below is actually an LRU.
	_models.delete(key);
	_models.set(key, hit);
	return hit.model;
}

function cachePut(key, model) {
	_models.set(key, { model, at: Date.now() });
	while (_models.size > MODEL_CACHE_MAX) {
		const oldest = _models.keys().next().value;
		_models.delete(oldest);
	}
}

/** Drop every cached model. Exported for tests and for memory-pressure handlers. */
export function clearModelCache() {
	_models.clear();
}

/**
 * Errors this renderer raises when a model needs a decoder it does not ship.
 * The caller uses this to decide between failing and falling back to chromium.
 */
export function isUnsupportedModelError(err) {
	return /draco|ktx2|basis|external decoder/i.test(err?.message || '');
}

function backdropToBackground(background, backdrop) {
	if (backdrop && (backdrop.inner || backdrop.outer)) {
		return { inner: backdrop.inner || backdrop.outer, outer: backdrop.outer || backdrop.inner };
	}
	if (!background || background === 'transparent') return 'transparent';
	return background;
}

async function loadCached(glbUrl, { maxBytes, animationUrl }) {
	const key = `${glbUrl}|${animationUrl || ''}`;
	const cached = cacheGet(key);
	if (cached) return cached;

	const { bytes } = await fetchModel(glbUrl, { maxBytes });
	const model = await AvatarModel.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));

	if (animationUrl) {
		const clip = await fetchModel(animationUrl, { maxBytes });
		const { loadModel } = await import('@three-ws/render');
		const source = clip.bytes.buffer.slice(clip.bytes.byteOffset, clip.bytes.byteOffset + clip.bytes.byteLength);
		const extra = await loadModel(source, { textures: false });
		model.addClips(extra.animations);
	}

	cachePut(key, model);
	return model;
}

/**
 * Render a GLB to a PNG buffer on the CPU.
 * Signature-compatible with renderGlbToPng in ./render-glb.js.
 *
 * @param {object} opts
 * @param {string} opts.glbUrl publicly reachable URL of the .glb
 * @param {number} [opts.width=1200]
 * @param {number} [opts.height=630]
 * @param {string} [opts.background='#0a0a0a'] 'transparent' or a hex colour
 * @param {{inner:string,outer:string}} [opts.backdrop] radial stage, wins over background
 * @param {'full'|'bust'|'head'} [opts.focus='full']
 * @param {string} [opts.animationUrl] GLB of clips to retarget onto the rig
 * @param {string|number} [opts.clip] clip to pose, by name or index
 * @param {number} [opts.time=0] seconds into the clip
 * @returns {Promise<Buffer>} PNG buffer
 */
export async function renderGlbToPngCpu({
	glbUrl,
	width = 1200,
	height = 630,
	background = '#0a0a0a',
	backdrop = null,
	maxBytes = DEFAULT_MAX_GLB_BYTES,
	focus = 'full',
	preset = 'studio',
	yaw = CAMERA_YAW_DEG,
	pitch = 6,
	supersample = 2,
	animationUrl = null,
	clip = null,
	time = 0,
} = {}) {
	if (!glbUrl || typeof glbUrl !== 'string') {
		throw Object.assign(new Error('glbUrl required'), { status: 400, code: 'invalid_args' });
	}
	const model = await loadCached(glbUrl, { maxBytes, animationUrl });
	if (clip !== null && clip !== undefined) {
		model.play(clip);
		model.setTime(time);
	}
	const frame = renderFrame(model, {
		width,
		height,
		supersample,
		preset,
		focus,
		yaw,
		pitch,
		margin: FRAME_MARGIN,
		background: backdropToBackground(background, backdrop),
	});
	return encodePng(frame);
}

/**
 * Render an animated clip to an APNG buffer. Chromium never offered this: a
 * frame loop through a headless browser costs a paint round-trip per frame,
 * while the CPU lane reuses one decoded model across the whole sequence.
 *
 * @returns {Promise<Buffer>} animated PNG buffer
 */
export async function renderGlbToApngCpu({
	glbUrl,
	width = 384,
	height = 384,
	background = 'transparent',
	backdrop = null,
	maxBytes = DEFAULT_MAX_GLB_BYTES,
	focus = 'full',
	preset = 'studio',
	yaw = CAMERA_YAW_DEG,
	pitch = 6,
	supersample = 2,
	animationUrl = null,
	clip = null,
	frames = 24,
	fps = 20,
	spin = 0,
} = {}) {
	if (!glbUrl || typeof glbUrl !== 'string') {
		throw Object.assign(new Error('glbUrl required'), { status: 400, code: 'invalid_args' });
	}
	const model = await loadCached(glbUrl, { maxBytes, animationUrl });
	const rendered = await renderFrames(model, {
		width,
		height,
		supersample,
		preset,
		focus,
		yaw,
		pitch,
		margin: FRAME_MARGIN,
		background: backdropToBackground(background, backdrop),
		frames,
		fps,
		spin,
		clip,
	});
	return encodeApng(rendered, { fps });
}
