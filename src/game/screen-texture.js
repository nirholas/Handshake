// Screen Texture - shared quality settings for every in-world canvas screen.
//
// All the /play "physical screens" (brand jumbotron, x402 board, chart screen,
// intel kiosk, agent desks) are HTML canvases wrapped in CanvasTexture. Built
// naively they look terrible in-world for three stacked reasons:
//   1. Default anisotropy (1) mip-blurs any screen viewed at an angle, which
//      is how screens are almost always seen from the plaza.
//   2. MeshBasicMaterial participates in scene fog and ACES tone mapping by
//      default, so an "emissive" screen face gets hazed toward the fog color
//      and its whites graded down to gray.
//   3. 1:1 canvas backing resolution leaves text soft the moment the player
//      walks up close.
// This module centralizes the fixes so every screen gets them consistently.

import { CanvasTexture, SRGBColorSpace, MeshBasicMaterial } from 'three';

let _maxAniso = null;

// Highest anisotropic filtering level the GPU supports (capped at 16), probed
// once from a throwaway context so screen modules that only receive a Scene
// can still use it. Falls back to 4 when the probe fails.
export function screenAnisotropy() {
	if (_maxAniso != null) return _maxAniso;
	_maxAniso = 4;
	try {
		const probe = document.createElement('canvas');
		const gl = probe.getContext('webgl2') || probe.getContext('webgl');
		const ext = gl && (
			gl.getExtension('EXT_texture_filter_anisotropic') ||
			gl.getExtension('WEBKIT_EXT_texture_filter_anisotropic') ||
			gl.getExtension('MOZ_EXT_texture_filter_anisotropic')
		);
		if (ext) {
			const max = gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT);
			if (isFinite(max) && max > 1) _maxAniso = Math.min(16, max);
		}
		gl?.getExtension('WEBGL_lose_context')?.loseContext();
	} catch { /* keep the fallback */ }
	return _maxAniso;
}

// A canvas whose backing store is `ss` times its logical size, with the 2D
// context pre-scaled so existing draw code keeps using logical coordinates.
// Text and strokes render at the higher density and come out crisp up close.
// The scale transform survives save()/restore() pairs; callers must not use
// setTransform()/resetTransform(), which none of the screen modules do.
export function makeScreenCanvas(width, height, ss = 2) {
	const canvas = document.createElement('canvas');
	canvas.width = Math.round(width * ss);
	canvas.height = Math.round(height * ss);
	const ctx = canvas.getContext('2d');
	ctx.scale(ss, ss);
	return { canvas, ctx };
}

// CanvasTexture with the correct color space and full anisotropic filtering.
export function makeScreenTexture(canvas) {
	const tex = new CanvasTexture(canvas);
	tex.colorSpace = SRGBColorSpace;
	tex.anisotropy = screenAnisotropy();
	return tex;
}

// The face material for a lit screen: unlit, exempt from tone mapping (whites
// stay white) and from scene fog (a glowing LED wall does not haze out with
// the atmosphere the way diffuse surfaces do).
export function screenMaterial(tex, extra = {}) {
	return new MeshBasicMaterial({ map: tex, toneMapped: false, fog: false, ...extra });
}
