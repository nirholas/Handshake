// One way to photograph a live three.js scene: render it into an offscreen
// target and read the pixels back.
//
// The obvious approach (`renderer.domElement.toDataURL()`) returns a BLACK
// frame on every browser unless the context was created with
// `preserveDrawingBuffer: true`, because the drawing buffer is cleared the
// moment the compositor takes the frame. Flipping that flag on permanently
// costs a full extra buffer copy on EVERY frame for the sake of the rare
// screenshot, so /play does not: it renders one extra frame into a
// WebGLRenderTarget on demand instead. Cost when nobody is taking a photo:
// exactly zero.
//
// Side benefits of reading a render target rather than the canvas: the capture
// is independent of what the compositor happens to be showing this instant, DOM
// chrome (HUD, chat, name tags) is never in the shot because it was never in
// the GL frame, and the caller picks the resolution.
//
// Callers: src/game/photo-mode.js (the share card) and
// src/game/coincommunities.js (`_captureBuildShot`, the build thumbnail).

import { WebGLRenderTarget, Vector2, SRGBColorSpace } from 'three';
import { log } from '../shared/log.js';

const _size = new Vector2();

/**
 * Render one frame of `scene`/`camera` offscreen and return it as a 2D canvas.
 *
 * @param {import('three').WebGLRenderer} renderer
 * @param {import('three').Scene} scene
 * @param {import('three').Camera} camera
 * @param {{ maxWidth?: number, samples?: number }} [opts]
 *   maxWidth downscales the target so a 5K display does not produce a 40 MB
 *   PNG; the aspect ratio always matches the live view.
 * @returns {{ canvas: HTMLCanvasElement, width: number, height: number } | null}
 *   null when the scene cannot be photographed (no renderer, zero-size canvas,
 *   lost context). Callers treat null as "tell the player to try again".
 */
export function captureSceneCanvas(renderer, scene, camera, { maxWidth = 2560, samples = 4 } = {}) {
	if (!renderer || !scene || !camera) return null;

	// The drawing buffer, not the CSS box: on a retina display those differ by
	// the pixel ratio and the buffer is the true render resolution.
	renderer.getDrawingBufferSize(_size);
	if (!(_size.x >= 1) || !(_size.y >= 1)) return null;

	const scale = Math.min(1, maxWidth / _size.x);
	const w = Math.max(1, Math.round(_size.x * scale));
	const h = Math.max(1, Math.round(_size.y * scale));

	let target = null;
	const previous = renderer.getRenderTarget();
	try {
		target = new WebGLRenderTarget(w, h, { samples });
		target.texture.colorSpace = SRGBColorSpace;
		renderer.setRenderTarget(target);
		renderer.render(scene, camera);

		const pixels = new Uint8Array(w * h * 4);
		renderer.readRenderTargetPixels(target, 0, 0, w, h, pixels);

		const canvas = document.createElement('canvas');
		canvas.width = w;
		canvas.height = h;
		const ctx = canvas.getContext('2d');
		const image = ctx.createImageData(w, h);
		// WebGL's origin is bottom-left and a canvas's is top-left: copy the rows
		// back to front so the photo is not upside down.
		const stride = w * 4;
		for (let y = 0; y < h; y++) {
			const src = (h - 1 - y) * stride;
			image.data.set(pixels.subarray(src, src + stride), y * stride);
		}
		ctx.putImageData(image, 0, 0);
		return { canvas, width: w, height: h };
	} catch (err) {
		log.warn('[scene-capture] capture failed:', err?.message);
		return null;
	} finally {
		renderer.setRenderTarget(previous);
		target?.dispose();
	}
}
