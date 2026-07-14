// Pure pinch-to-resize math (src/ar/pinch-scale.js).
//
// The contract these tests pin is the WebXR resize gesture: a two-finger pinch
// during placement must scale the agent by the ratio of finger spread, compose
// across consecutive pinches (never snap back to 1), clamp to the same band the
// server enforces, and reject palm noise inside the dead zone. clampPinScale is
// the read half — every viewer renders a persisted anchor_scale through it, so
// legacy pins (NULL column) and garbage must map to natural size, not NaN.
// Pure math, no DOM / Three.js — mirrors tests/irl-floor-anchor.test.js.

import { describe, it, expect } from 'vitest';

import {
	clampPinScale, createPinchState, pinchEnd, pinchMove, pinchStart,
	PINCH_DEADZONE_PX, PINCH_SCALE_MAX, PINCH_SCALE_MIN,
} from '../src/ar/pinch-scale.js';

describe('pinchStart', () => {
	it('engages on a real finger spread and captures the base scale', () => {
		const p = createPinchState();
		expect(pinchStart(p, 120, 1.5)).toBe(true);
		expect(p.active).toBe(true);
		expect(p.baseScale).toBe(1.5);
	});

	it('rejects spreads inside the dead zone (palm noise)', () => {
		const p = createPinchState();
		expect(pinchStart(p, PINCH_DEADZONE_PX - 1, 1)).toBe(false);
		expect(p.active).toBe(false);
	});

	it('treats a missing/invalid base scale as natural size', () => {
		const p = createPinchState();
		pinchStart(p, 100, NaN);
		expect(p.baseScale).toBe(1);
		const q = createPinchState();
		pinchStart(q, 100, 0);
		expect(q.baseScale).toBe(1);
	});
});

describe('pinchMove', () => {
	it('scales by the ratio of finger spread', () => {
		const p = createPinchState();
		pinchStart(p, 100, 1);
		expect(pinchMove(p, 200)).toBeCloseTo(2);
		expect(pinchMove(p, 50)).toBeCloseTo(0.5);
	});

	it('composes with the scale the content already had', () => {
		const p = createPinchState();
		pinchStart(p, 100, 2);       // agent already pinched to 2x earlier
		expect(pinchMove(p, 150)).toBeCloseTo(3);
	});

	it('clamps to the shared band', () => {
		const p = createPinchState();
		pinchStart(p, 100, 1);
		expect(pinchMove(p, 10000)).toBe(PINCH_SCALE_MAX);
		expect(pinchMove(p, 1)).toBe(PINCH_SCALE_MIN);
	});

	it('returns null when not engaged or on degenerate distances', () => {
		const p = createPinchState();
		expect(pinchMove(p, 200)).toBe(null);       // never started
		pinchStart(p, 100, 1);
		expect(pinchMove(p, NaN)).toBe(null);
		expect(pinchMove(p, 0)).toBe(null);
	});
});

describe('pinchEnd', () => {
	it('returns the final scale exactly once', () => {
		const p = createPinchState();
		pinchStart(p, 100, 1);
		pinchMove(p, 300);
		expect(pinchEnd(p)).toBeCloseTo(3);
		expect(p.active).toBe(false);
		expect(pinchEnd(p)).toBe(null);              // a plain tap after — nothing to save
	});

	it('a second pinch composes from where the first ended', () => {
		const p = createPinchState();
		pinchStart(p, 100, 1);
		pinchMove(p, 200);
		const first = pinchEnd(p);                   // 2x
		pinchStart(p, 100, first);
		pinchMove(p, 150);
		expect(pinchEnd(p)).toBeCloseTo(3);          // 2x · 1.5 — no snap back to 1
	});
});

describe('clampPinScale (render read path)', () => {
	it('maps a legacy/absent column to natural size', () => {
		expect(clampPinScale(null)).toBe(1);
		expect(clampPinScale(undefined)).toBe(1);
	});

	it('maps garbage to natural size, never NaN', () => {
		expect(clampPinScale('huge')).toBe(1);
		expect(clampPinScale(NaN)).toBe(1);
		expect(clampPinScale(-2)).toBe(1);
		expect(clampPinScale(0)).toBe(1);
	});

	it('passes valid scales through, clamped to the shared band', () => {
		expect(clampPinScale(0.5)).toBe(0.5);
		expect(clampPinScale(2)).toBe(2);
		expect(clampPinScale('1.75')).toBe(1.75);    // numeric string from JSON is fine
		expect(clampPinScale(100)).toBe(PINCH_SCALE_MAX);
		expect(clampPinScale(0.01)).toBe(PINCH_SCALE_MIN);
	});

	it('agrees with the gesture clamp band', () => {
		expect(PINCH_SCALE_MIN).toBeLessThan(1);
		expect(PINCH_SCALE_MAX).toBeGreaterThan(1);
	});
});
