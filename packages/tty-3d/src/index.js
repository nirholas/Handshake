// @three-ws/tty-3d — render a rigged 3D model into a terminal, with no GPU, no
// browser and no display server.
//
// Public API:
//   loadModel(source)                 -> Model            (file path, URL, or bytes)
//   createRenderer(model, options)    -> Renderer
//   renderOnce(source, options)       -> Promise<string>  (one frame, one call)
//
// See README.md for the CLI (`npx @three-ws/tty-3d`) and the hosted stream.

import { loadModelFromBytes, loadModelFromFile, poseModel } from './model.js';
import { computeFraming, createFramebuffer, poseCenter, renderToFramebuffer } from './raster.js';
import { ColorMode, detectColorMode, framebufferToText } from './term.js';

export { loadModelFromBytes, loadModelFromFile, poseModel } from './model.js';
export { createFramebuffer, renderToFramebuffer, computeFraming, poseCenter, poseBounds } from './raster.js';
export { ColorMode, detectColorMode, framebufferToText, toAnsi256, ansi } from './term.js';

const MAX_REMOTE_BYTES = 64 * 1024 * 1024;

/** Load from a file path, an http(s) URL, or raw bytes. */
export async function loadModel(source, { fetchImpl = globalThis.fetch, signal } = {}) {
	if (source instanceof Uint8Array || source instanceof ArrayBuffer) return loadModelFromBytes(source);
	if (typeof source !== 'string') throw new TypeError('source must be a path, a URL, or bytes');

	if (/^https?:\/\//i.test(source)) {
		if (typeof fetchImpl !== 'function') throw new Error('no fetch implementation available for remote models');
		const res = await fetchImpl(source, { signal, redirect: 'follow' });
		if (!res.ok) throw new Error(`could not fetch model: ${res.status} ${res.statusText}`);
		const length = Number(res.headers?.get?.('content-length') ?? 0);
		// A terminal frame is at most a few thousand pixels, so an enormous model
		// buys nothing and a hostile one would sit in memory. Refuse early, on the
		// header, before the body is buffered.
		if (length > MAX_REMOTE_BYTES) throw new Error(`model is too large: ${length} bytes`);
		const buf = new Uint8Array(await res.arrayBuffer());
		if (buf.byteLength > MAX_REMOTE_BYTES) throw new Error(`model is too large: ${buf.byteLength} bytes`);
		return loadModelFromBytes(buf);
	}
	return loadModelFromFile(source);
}

/** Pick the animation to play: by name, by index, or the first one there is. */
export function selectAnimation(model, wanted) {
	if (wanted === false || wanted === null) return null;
	if (!model.animations.length) return null;
	if (wanted === undefined || wanted === true) return model.animations[0];
	if (typeof wanted === 'number') return model.animations[wanted] ?? model.animations[0];
	const lower = String(wanted).toLowerCase();
	return model.animations.find((a) => a.name.toLowerCase().includes(lower)) ?? model.animations[0];
}

/**
 * A renderer bound to one model and one output size.
 *
 * Framing is resolved once, at construction, from a sampled union of the clip
 * (see stableBounds). Everything after that is per-frame work on preallocated
 * buffers, so a long-running animation does not grow the heap.
 */
export function createRenderer(model, options = {}) {
	const {
		width = 96,
		height = 48,
		animation,
		mode = ColorMode.TRUECOLOR,
		background = [0.031, 0.031, 0.078],
		transparent = false,
		spin = 1,
		pitch = 0.08,
		zoom = 1,
		tint = [1, 1, 1],
	} = options;

	// The framebuffer is twice as tall as the character grid: one text row is
	// two vertical pixels via the half-block.
	const fb = createFramebuffer(Math.max(2, Math.round(width)), Math.max(2, Math.round(height)) * 2);
	const clip = selectAnimation(model, animation);
	const framing = computeFraming(model, clip);

	const state = { yaw: 0, pitch, zoom };

	return {
		model,
		animation: clip,
		framing,
		width: fb.width,
		height: fb.height / 2,
		get orbit() { return { ...state }; },

		/** Absolute camera control, for interactive use. */
		setOrbit({ yaw, pitch: p, zoom: z } = {}) {
			if (Number.isFinite(yaw)) state.yaw = yaw;
			// Clamping stops the camera from tumbling over the pole, where the
			// look-at up vector degenerates and the model flips upside down.
			if (Number.isFinite(p)) state.pitch = Math.max(-1.45, Math.min(1.45, p));
			if (Number.isFinite(z)) state.zoom = Math.max(0.25, Math.min(8, z));
			return { ...state };
		},

		/**
		 * Render the frame at `time` seconds.
		 * @returns {string} terminal-ready text, no trailing newline
		 */
		frame(time = 0) {
			poseModel(model, clip, time);
			renderToFramebuffer(fb, model, {
				yaw: state.yaw + time * spin,
				pitch: state.pitch,
				zoom: state.zoom,
				center: poseCenter(model),
				framing,
				tint,
			});
			return framebufferToText(fb, { mode, background, transparent });
		},
	};
}

/** One model, one frame, one call. */
export async function renderOnce(source, options = {}) {
	const model = await loadModel(source, options);
	return createRenderer(model, options).frame(options.time ?? 0);
}

/** Everything the CLI and the hosted stream both need to describe a model. */
export function describeModel(model) {
	return {
		triangles: model.triangleCount,
		primitives: model.primitives.length,
		nodes: model.nodes.length,
		skinned: model.skinned,
		animations: model.animations.map((a) => ({ name: a.name, duration: Number(a.duration.toFixed(3)) })),
	};
}

export { detectColorMode as detectTerminalColor };
