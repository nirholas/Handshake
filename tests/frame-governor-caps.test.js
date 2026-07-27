// Frame governor pacing (src/shared/frame-governor.js) at the caps the 3D
// surfaces actually use. /walk joined /play and /club on this module, and its
// loop now self-schedules and returns early on a throttled frame, so the cap
// arithmetic is what decides whether the world runs at 60 or 30fps.

import { describe, it, expect } from 'vitest';
import {
	createFrameGovernor, FPS_ACTIVE, FPS_IDLE, FPS_SAVER,
} from '../src/shared/frame-governor.js';

// Drive a governor across `ms` of wall time at a given panel refresh rate and
// count how many frames it lets through.
function run(governor, { ms, hz, fpsCap }) {
	const step = 1000 / hz;
	let ran = 0;
	for (let t = 0; t <= ms; t += step) if (governor.shouldRun(t, fpsCap)) ran++;
	return ran;
}

describe('frame governor caps', () => {
	it('passes every frame on a 60Hz panel at the active cap', () => {
		const g = createFrameGovernor();
		const ran = run(g, { ms: 1000, hz: 60, fpsCap: FPS_ACTIVE });
		// 60Hz into a 60fps cap: no frame should be dropped (the 0.5ms slack
		// exists precisely so timer jitter never eats one).
		expect(ran).toBeGreaterThanOrEqual(60);
	});

	it('halves a 120Hz panel to the active cap instead of rendering twice over', () => {
		const g = createFrameGovernor();
		const ran = run(g, { ms: 1000, hz: 120, fpsCap: FPS_ACTIVE });
		expect(ran).toBeGreaterThanOrEqual(58);
		expect(ran).toBeLessThanOrEqual(63);
	});

	it('holds ~30fps at the idle and saver caps on a 144Hz panel', () => {
		for (const cap of [FPS_IDLE, FPS_SAVER]) {
			const g = createFrameGovernor();
			const ran = run(g, { ms: 1000, hz: 144, fpsCap: cap });
			expect(ran).toBeGreaterThanOrEqual(28);
			expect(ran).toBeLessThanOrEqual(33);
		}
	});

	it('does not quantize a 144Hz panel down to ~48fps at the 60 cap', () => {
		// A naive `last = now` drops to every third 144Hz frame (48fps). The
		// remainder-carry is what keeps the average honest.
		const g = createFrameGovernor();
		const ran = run(g, { ms: 1000, hz: 144, fpsCap: FPS_ACTIVE });
		expect(ran).toBeGreaterThan(52);
	});

	it('never bursts a backlog of instant frames after a long stall', () => {
		const g = createFrameGovernor();
		expect(g.shouldRun(0, FPS_ACTIVE)).toBe(true);
		// Hidden tab / breakpoint: 10 seconds pass between callbacks.
		expect(g.shouldRun(10_000, FPS_ACTIVE)).toBe(true);
		// The very next callback 1ms later must still be throttled.
		expect(g.shouldRun(10_001, FPS_ACTIVE)).toBe(false);
	});

	it('treats a non-positive cap as "run nothing" and survives a bad timestamp', () => {
		const g = createFrameGovernor();
		expect(g.shouldRun(16, 0)).toBe(false);
		expect(g.shouldRun(16, NaN)).toBe(false);
		expect(g.shouldRun(NaN, FPS_ACTIVE)).toBe(true); // no timestamp: don't stall the loop
	});
});
