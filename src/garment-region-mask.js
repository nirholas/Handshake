// Body-region occlusion mask — client sampler.
//
// scripts/build-body-region-mask.mjs bakes parametric-base.regions.png: a
// grayscale map in body-UV space where each pixel carries a REGION_MASK_VALUES
// code. This module turns that map plus a set of occluded regions into the
// RGBA pixels for a THREE alphaMap (green channel is what three.js samples),
// giving pixel-exact skin cut-outs under worn garments instead of the
// triangle-level bone-cull fallback.
//
// Pure data module — no three.js, no DOM in the transform itself — so the
// decode logic is unit-testable in Node. Only loadRegionMask touches browser
// APIs (Image + canvas).

import { BODY_REGIONS, REGION_MASK_VALUES } from './garment-taxonomy.js';

const CODE_STEP = 24; // spacing chosen in REGION_MASK_VALUES

/** Region name for a mask pixel code, tolerant of ±11 resample error. 0/none → null. */
export function decodeRegionCode(code) {
	if (!code) return null;
	const idx = Math.round(code / CODE_STEP) - 1;
	if (idx < 0 || idx >= BODY_REGIONS.length) return null;
	const region = BODY_REGIONS[idx];
	return Math.abs(REGION_MASK_VALUES[region] - code) <= CODE_STEP / 2 ? region : null;
}

/**
 * Build RGBA pixels for an alphaMap that hides `regions`.
 * Green channel (three.js's alphaMap source) is 0 where the pixel's region is
 * occluded, 255 elsewhere — including unassigned pixels, which must stay
 * visible (they are UV gutter, not skin).
 *
 * @param {Uint8Array|Uint8ClampedArray} mask  single-channel region codes
 * @param {string[]} regions                   regions to hide
 * @returns {Uint8Array} RGBA, mask.length * 4
 */
export function maskToAlphaRGBA(mask, regions) {
	const hide = new Set(regions);
	// Precompute code → visible for all 256 values; the hot loop is then a
	// single table lookup per pixel.
	const visible = new Uint8Array(256).fill(255);
	for (let code = 1; code < 256; code++) {
		const region = decodeRegionCode(code);
		if (region && hide.has(region)) visible[code] = 0;
	}
	const out = new Uint8Array(mask.length * 4);
	for (let i = 0; i < mask.length; i++) {
		const a = visible[mask[i]];
		out[i * 4] = a;
		out[i * 4 + 1] = a; // green — the channel three.js reads
		out[i * 4 + 2] = a;
		out[i * 4 + 3] = 255;
	}
	return out;
}

// One decode per URL per session.
const _maskCache = new Map();

/**
 * Fetch + decode a region-mask PNG into { data, width, height } (single
 * channel — red of the decoded image, which for a grayscale PNG is the code).
 * Browser-only (Image + canvas); callers in Node use the PNG via sharp.
 */
export function loadRegionMask(url) {
	if (_maskCache.has(url)) return _maskCache.get(url);
	const p = (async () => {
		const res = await fetch(url);
		if (!res.ok) throw new Error(`region mask fetch failed: ${res.status}`);
		const bitmap = await createImageBitmap(await res.blob());
		const canvas = typeof OffscreenCanvas !== 'undefined'
			? new OffscreenCanvas(bitmap.width, bitmap.height)
			: Object.assign(document.createElement('canvas'), { width: bitmap.width, height: bitmap.height });
		const ctx = canvas.getContext('2d', { willReadFrequently: true });
		ctx.drawImage(bitmap, 0, 0);
		const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
		const mask = new Uint8Array(bitmap.width * bitmap.height);
		for (let i = 0; i < mask.length; i++) mask[i] = data[i * 4]; // red = gray code
		return { data: mask, width: bitmap.width, height: bitmap.height };
	})();
	p.catch(() => _maskCache.delete(url));
	_maskCache.set(url, p);
	return p;
}
