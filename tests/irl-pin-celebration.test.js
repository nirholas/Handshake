/**
 * Pin-success "lock-in" celebration ripple timing: unit tests.
 *
 * Covers the pure frame math irl.js drives the ground-ring meshes with: the
 * pre-delay gate, the eased expansion, the opacity fade to zero, and monotonic
 * growth. The scene meshes themselves live in irl.js next to attachPinRing.
 */

import { describe, it, expect } from 'vitest';
import { celebrationRingFrame, CELEBRATION_DURATION } from '../src/irl/pin-celebration.js';

describe('celebrationRingFrame', () => {
	it('is invisible before its delay elapses', () => {
		expect(celebrationRingFrame(0, 0).visible).toBe(false);
		expect(celebrationRingFrame(0.1, 0.18).visible).toBe(false);
		expect(celebrationRingFrame(0.18, 0.18).visible).toBe(false);
	});

	it('becomes visible after the delay and expands from the start scale', () => {
		const f = celebrationRingFrame(0.3, 0.18);
		expect(f.visible).toBe(true);
		expect(f.scale).toBeGreaterThan(0.15);
	});

	it('fades opacity to zero and reaches full scale at the end', () => {
		const end = celebrationRingFrame(1, 0);
		expect(end.opacity).toBeCloseTo(0, 5);
		expect(end.scale).toBeGreaterThan(2);
	});

	it('opacity peaks early and only decreases over the ring life', () => {
		const a = celebrationRingFrame(0.1, 0);
		const b = celebrationRingFrame(0.5, 0);
		const c = celebrationRingFrame(0.9, 0);
		expect(a.opacity).toBeGreaterThan(b.opacity);
		expect(b.opacity).toBeGreaterThan(c.opacity);
	});

	it('scale grows monotonically across the ring life', () => {
		let last = -Infinity;
		for (let t = 0.05; t <= 1; t += 0.05) {
			const s = celebrationRingFrame(t, 0).scale;
			expect(s).toBeGreaterThanOrEqual(last);
			last = s;
		}
	});

	it('clamps past t=1 instead of overshooting', () => {
		const over = celebrationRingFrame(1.5, 0);
		expect(over.opacity).toBeCloseTo(0, 5);
		expect(over.scale).toBeLessThanOrEqual(0.15 + 2.1 + 1e-9);
	});

	it('exposes a sane duration constant', () => {
		expect(CELEBRATION_DURATION).toBeGreaterThan(0);
		expect(CELEBRATION_DURATION).toBeLessThan(3);
	});
});
