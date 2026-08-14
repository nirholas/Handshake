/**
 * Capture gate scoring: unit tests for the pure math behind the /create/selfie
 * viewfinder and review-still gates (src/selfie-gates.js). These pin the
 * thresholds to the reconstruction pipeline's real failure modes: the no-face
 * hard rejection, the 35-degree morph-yaw ceiling, provider blur failures,
 * and the dim/backlit lighting band the robustness benchmark models.
 */

import { describe, it, expect } from 'vitest';
import { GATES, SLOT_PRESETS, grayFaceStats, gradeFrame } from '../src/selfie-gates.js';

// Build a w*h grey buffer from a (x,y)=>value fn.
function grey(w, h, fn) {
	const a = new Float32Array(w * h);
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) a[y * w + x] = fn(x, y);
	return a;
}

describe('grayFaceStats', () => {
	it('reports the mean luma of a flat buffer exactly', () => {
		const { luma } = grayFaceStats(grey(16, 16, () => 128), 16, 16);
		expect(luma).toBe(128);
	});

	it('reports zero blur response on a flat buffer', () => {
		const { blurStddev } = grayFaceStats(grey(16, 16, () => 128), 16, 16);
		expect(blurStddev).toBe(0);
	});

	it('reports a higher blur response for detailed content than smooth content', () => {
		const detail = grayFaceStats(grey(32, 32, (x, y) => ((x + y) % 2 ? 255 : 0)), 32, 32);
		const smooth = grayFaceStats(grey(32, 32, (x) => x * 4), 32, 32);
		expect(detail.blurStddev).toBeGreaterThan(smooth.blurStddev);
	});

	it('a checkerboard face crop clears the live blur gate; a gradient does not', () => {
		const detail = grayFaceStats(grey(64, 64, (x, y) => ((x + y) % 2 ? 255 : 0)), 64, 64);
		const smooth = grayFaceStats(grey(64, 64, (x) => x * 2), 64, 64);
		expect(detail.blurStddev).toBeGreaterThan(GATES.BLUR_STDDEV_MIN);
		expect(smooth.blurStddev).toBeLessThan(GATES.BLUR_STDDEV_MIN);
	});

	it('handles degenerate sizes without NaN', () => {
		expect(grayFaceStats(grey(2, 2, () => 50), 2, 2)).toEqual({ luma: 50, blurStddev: 0, clippedFrac: 0 });
		expect(grayFaceStats([], 0, 0)).toEqual({ luma: 0, blurStddev: 0, clippedFrac: 0 });
	});
});

describe('gradeFrame', () => {
	const goodFrontal = {
		faceFound: true,
		slot: 'frontal',
		yaw: 2,
		noseX: 0.5,
		noseY: 0.5,
		blur: 20,
		luma: 120,
	};

	it('fails everything and names the face gate when no face is found', () => {
		const g = gradeFrame({ faceFound: false });
		expect(g.allPass).toBe(false);
		expect(g.faceFound).toBe(false);
		expect(g.reason).toMatch(/face/i);
	});

	it('passes a sharp, lit, centred frontal with no retake reason', () => {
		const g = gradeFrame(goodFrontal);
		expect(g.allPass).toBe(true);
		expect(g.reason).toBeNull();
	});

	it('keeps the frontal window inside the morph-safe yaw ceiling', () => {
		expect(SLOT_PRESETS.frontal.max).toBeLessThan(GATES.MORPH_YAW_MAX);
		expect(Math.abs(SLOT_PRESETS.frontal.min)).toBeLessThan(GATES.MORPH_YAW_MAX);
	});

	it('rejects a turned head on the frontal slot and says to face the camera', () => {
		const g = gradeFrame({ ...goodFrontal, yaw: 25 });
		expect(g.yawOk).toBe(false);
		expect(g.allPass).toBe(false);
		expect(g.reason).toMatch(/straight on/i);
	});

	it('rejects a frontal pose on the left slot and says to turn left', () => {
		const g = gradeFrame({ ...goodFrontal, slot: 'left', yaw: 2 });
		expect(g.yawOk).toBe(false);
		expect(g.reason).toMatch(/left/i);
	});

	it('accepts a ~45 degree turn on the left slot', () => {
		const g = gradeFrame({ ...goodFrontal, slot: 'left', yaw: 45 });
		expect(g.yawOk).toBe(true);
		expect(g.allPass).toBe(true);
	});

	it('accepts a ~-45 degree turn on the right slot', () => {
		const g = gradeFrame({ ...goodFrontal, slot: 'right', yaw: -45 });
		expect(g.yawOk).toBe(true);
	});

	it('rejects an off-centre face and says to recenter', () => {
		const g = gradeFrame({ ...goodFrontal, noseX: 0.9 });
		expect(g.centered).toBe(false);
		expect(g.reason).toMatch(/center/i);
	});

	it('rejects a blurry frame and says to hold steady', () => {
		const g = gradeFrame({ ...goodFrontal, blur: GATES.BLUR_STDDEV_MIN - 0.5 });
		expect(g.blurOk).toBe(false);
		expect(g.reason).toMatch(/steady|blurry/i);
	});

	it('rejects a dark frame and says to find light', () => {
		const g = gradeFrame({ ...goodFrontal, luma: GATES.LUMA_MIN - 5 });
		expect(g.lumaOk).toBe(false);
		expect(g.reason).toMatch(/dark|light/i);
	});

	it('rejects a blown-out frame and says to reduce glare', () => {
		const g = gradeFrame({ ...goodFrontal, luma: GATES.LUMA_MAX + 5 });
		expect(g.lumaOk).toBe(false);
		expect(g.reason).toMatch(/bright|glare/i);
	});

	it('accepts the exact luma boundaries', () => {
		expect(gradeFrame({ ...goodFrontal, luma: GATES.LUMA_MIN }).lumaOk).toBe(true);
		expect(gradeFrame({ ...goodFrontal, luma: GATES.LUMA_MAX }).lumaOk).toBe(true);
	});

	it('names the yaw fix before the blur fix when both fail', () => {
		const g = gradeFrame({ ...goodFrontal, yaw: 30, blur: 0 });
		expect(g.reason).toMatch(/straight on/i);
	});

	it('falls back to the frontal window for an unknown slot', () => {
		const g = gradeFrame({ ...goodFrontal, slot: 'profile' });
		expect(g.yawOk).toBe(true);
	});
});
