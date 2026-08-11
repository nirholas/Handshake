/**
 * Selfie refinement — unit tests for the deterministic helpers.
 *
 * The DOM/MediaPipe wrappers (segmentation, detection, canvas compositing) are
 * exercised in the browser; these tests pin the pure math that decides whether
 * a photo is usable and how the subject gets framed — the logic that turns the
 * "whole photo on a card" input into a clean, centred subject.
 */

import { describe, it, expect } from 'vitest';
import {
	laplacianVariance,
	flatnessScore,
	meanSaturation,
	assessPhotoQuality,
	computeSubjectFrame,
	maskBoundingBox,
	smoothstep,
} from '../src/selfie-refine.js';

// Build a w×h grey buffer from a (x,y)=>value fn.
function grey(w, h, fn) {
	const a = new Uint8Array(w * h);
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) a[y * w + x] = fn(x, y) | 0;
	return a;
}
// Build a w×h RGBA buffer from a (x,y)=>[r,g,b,a] fn.
function rgba(w, h, fn) {
	const a = new Uint8ClampedArray(w * h * 4);
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			const [r, g, b, al = 255] = fn(x, y);
			const i = (y * w + x) * 4;
			a[i] = r; a[i + 1] = g; a[i + 2] = b; a[i + 3] = al;
		}
	return a;
}

describe('laplacianVariance', () => {
	it('is ~0 for a flat image', () => {
		expect(laplacianVariance(grey(16, 16, () => 128), 16, 16)).toBe(0);
	});

	it('is higher for an edged image than a flat one', () => {
		const flat = laplacianVariance(grey(16, 16, () => 128), 16, 16);
		const edged = laplacianVariance(grey(16, 16, (x) => (x < 8 ? 0 : 255)), 16, 16);
		expect(edged).toBeGreaterThan(flat);
	});

	it('returns 0 on degenerate sizes', () => {
		expect(laplacianVariance(grey(2, 2, () => 50), 2, 2)).toBe(0);
	});
});

describe('flatnessScore', () => {
	it('is 1 for a perfectly flat image', () => {
		expect(flatnessScore(grey(12, 12, () => 90), 12, 12)).toBe(1);
	});

	it('is low for a high-frequency checkerboard', () => {
		const checker = grey(12, 12, (x, y) => ((x + y) % 2 ? 255 : 0));
		expect(flatnessScore(checker, 12, 12)).toBeLessThan(0.1);
	});
});

describe('meanSaturation', () => {
	it('is 0 for greyscale', () => {
		expect(meanSaturation(rgba(8, 8, () => [120, 120, 120]), 8, 8, 1)).toBe(0);
	});

	it('is ~1 for fully saturated red', () => {
		expect(meanSaturation(rgba(8, 8, () => [255, 0, 0]), 8, 8, 1)).toBeCloseTo(1, 5);
	});
});

describe('assessPhotoQuality', () => {
	const sharpClearFace = {
		width: 1000, height: 1000,
		faceCount: 1,
		faceBox: { x: 350, y: 300, w: 300, h: 300 },
		sharpness: 500, flatness: 0.2, saturation: 0.2,
	};

	it('blocks when there is no face', () => {
		const r = assessPhotoQuality({ ...sharpClearFace, faceCount: 0, faceBox: null });
		expect(r.verdict).toBe('block');
		expect(r.primary).toBe('no-face');
	});

	it('passes a sharp, well-framed real photo', () => {
		const r = assessPhotoQuality(sharpClearFace);
		expect(r.verdict).toBe('good');
		expect(r.issues).toEqual([]);
	});

	it('warns "blurry" on a soft photo', () => {
		const r = assessPhotoQuality({ ...sharpClearFace, sharpness: 10 });
		expect(r.verdict).toBe('warn');
		expect(r.primary).toBe('blurry');
	});

	it('flags a flat, saturated illustration', () => {
		const r = assessPhotoQuality({ ...sharpClearFace, flatness: 0.85, saturation: 0.6 });
		expect(r.issues).toContain('illustration');
		expect(r.primary).toBe('illustration'); // illustration outranks other warnings
	});

	it('does NOT flag a plain-background photo as an illustration (flat but desaturated)', () => {
		const r = assessPhotoQuality({ ...sharpClearFace, flatness: 0.85, saturation: 0.1 });
		expect(r.issues).not.toContain('illustration');
	});

	it('warns "far" when the face is small in frame', () => {
		const r = assessPhotoQuality({ ...sharpClearFace, faceBox: { x: 470, y: 470, w: 90, h: 90 } });
		expect(r.issues).toContain('far');
	});

	it('warns "dark" when the measured face luma is below the lighting gate', () => {
		const r = assessPhotoQuality({ ...sharpClearFace, luma: 25 });
		expect(r.verdict).toBe('warn');
		expect(r.primary).toBe('dark');
	});

	it('warns "bright" when the measured face luma is blown out', () => {
		const r = assessPhotoQuality({ ...sharpClearFace, luma: 240 });
		expect(r.issues).toContain('bright');
	});

	it('does not judge lighting when luma was not measured', () => {
		const r = assessPhotoQuality(sharpClearFace);
		expect(r.issues).not.toContain('dark');
		expect(r.issues).not.toContain('bright');
	});
});

describe('computeSubjectFrame', () => {
	it('returns a centred square within bounds for a centred face', () => {
		const f = computeSubjectFrame({ x: 400, y: 300, w: 200, h: 200 }, 1000, 1000);
		expect(f.w).toBe(f.h);
		expect(f.x).toBeGreaterThanOrEqual(0);
		expect(f.y).toBeGreaterThanOrEqual(0);
		expect(f.x + f.w).toBeLessThanOrEqual(1000);
		expect(f.y + f.h).toBeLessThanOrEqual(1000);
		// Horizontally centred on the face centre (500).
		expect(f.x + f.w / 2).toBeCloseTo(500, 0);
	});

	it('clamps a square against the right edge without overflow', () => {
		const f = computeSubjectFrame({ x: 900, y: 300, w: 200, h: 200 }, 1000, 1000);
		expect(f.x + f.w).toBeLessThanOrEqual(1000);
		expect(f.w).toBe(f.h);
	});

	it('fits the largest square inside a small image', () => {
		const f = computeSubjectFrame({ x: 150, y: 80, w: 120, h: 120 }, 400, 300);
		expect(f.w).toBe(f.h);
		expect(f.w).toBeLessThanOrEqual(300);
		expect(f.x + f.w).toBeLessThanOrEqual(400);
		expect(f.y + f.h).toBeLessThanOrEqual(300);
	});

	it('widens to include a broad subject (shoulders)', () => {
		const narrow = computeSubjectFrame({ x: 450, y: 300, w: 100, h: 100 }, 2000, 2000);
		const wide = computeSubjectFrame({ x: 450, y: 300, w: 100, h: 100 }, 2000, 2000, {
			subjectBox: { x: 200, y: 250, w: 1000, h: 1200 },
		});
		expect(wide.w).toBeGreaterThan(narrow.w);
	});
});

describe('maskBoundingBox', () => {
	it('scales the foreground box into image space', () => {
		// 4×4 mask, a 2×2 foreground block at (1,1)-(2,2); image is 8×8 (scale 2).
		const mask = new Float32Array(16);
		for (const [x, y] of [[1, 1], [2, 1], [1, 2], [2, 2]]) mask[y * 4 + x] = 1;
		const box = maskBoundingBox(mask, 4, 4, 8, 8, 0.5);
		expect(box).toEqual({ x: 2, y: 2, w: 4, h: 4 });
	});

	it('returns null when nothing crosses the threshold', () => {
		expect(maskBoundingBox(new Float32Array(16), 4, 4, 8, 8, 0.5)).toBeNull();
	});
});

describe('smoothstep', () => {
	it('clamps below/above the edges', () => {
		expect(smoothstep(0, 1, -2)).toBe(0);
		expect(smoothstep(0, 1, 5)).toBe(1);
	});
	it('is 0.5 at the midpoint and monotonic', () => {
		expect(smoothstep(0, 1, 0.5)).toBeCloseTo(0.5, 5);
		expect(smoothstep(0, 1, 0.25)).toBeLessThan(smoothstep(0, 1, 0.75));
	});
	it('degenerates to a step when edges are equal', () => {
		expect(smoothstep(0.5, 0.5, 0.4)).toBe(0);
		expect(smoothstep(0.5, 0.5, 0.6)).toBe(1);
	});
});
