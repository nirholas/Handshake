/**
 * Frame governor — unit tests.
 *
 * The governor is the heat fix for /play and /club: it caps how often a
 * rAF-driven loop actually does sim + render work, independent of the
 * display's refresh rate. These tests drive it with synthetic timestamps
 * (no rAF, no DOM) and assert the properties the pages rely on:
 *
 *  - a 60fps cap on a 144Hz timestamp stream runs ~60 frames/sec, not 48
 *    (the remainder-carry) and never more than the cap (+jitter slack)
 *  - a true 60Hz stream under a 60fps cap never skips (the 0.5ms slack)
 *  - cap changes take effect immediately (blur → 30fps)
 *  - degenerate caps (0, NaN) refuse to run rather than running hot
 *  - power-saver persistence round-trips and survives broken storage
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
	createFrameGovernor,
	getPowerSaver,
	setPowerSaver,
	FPS_ACTIVE,
	FPS_IDLE,
	FPS_SAVER,
} from '../src/shared/frame-governor.js';

// Count how many frames the governor lets through over `seconds` of a
// synthetic display running at `hz`, with a per-frame cap of `fps`.
function runStream({ hz, fps, seconds = 2, start = 1000 }) {
	const gov = createFrameGovernor();
	const period = 1000 / hz;
	const frames = Math.round(seconds * hz);
	let ran = 0;
	for (let i = 0; i < frames; i++) {
		if (gov.shouldRun(start + i * period, fps)) ran++;
	}
	return ran / seconds; // frames per second actually run
}

describe('createFrameGovernor', () => {
	it('caps a 144Hz stream to ~60fps (remainder-carry, no 48fps quantization)', () => {
		const rate = runStream({ hz: 144, fps: 60 });
		expect(rate).toBeGreaterThanOrEqual(55);
		expect(rate).toBeLessThanOrEqual(65);
	});

	it('caps a 240Hz stream to ~60fps', () => {
		const rate = runStream({ hz: 240, fps: 60 });
		expect(rate).toBeGreaterThanOrEqual(55);
		expect(rate).toBeLessThanOrEqual(65);
	});

	it('never skips frames on a true 60Hz panel at a 60fps cap', () => {
		const rate = runStream({ hz: 60, fps: 60 });
		expect(rate).toBe(60);
	});

	it('caps a 60Hz stream to ~30fps under the idle cap', () => {
		const rate = runStream({ hz: 60, fps: 30 });
		expect(rate).toBeGreaterThanOrEqual(28);
		expect(rate).toBeLessThanOrEqual(32);
	});

	it('applies a cap change on the very next frame', () => {
		const gov = createFrameGovernor();
		// 60Hz stream, active cap: every frame runs.
		expect(gov.shouldRun(0, 60)).toBe(true);
		expect(gov.shouldRun(16.67, 60)).toBe(true);
		// Blur → 30fps cap: the frame ~16ms later must now be skipped.
		expect(gov.shouldRun(33.33, 30)).toBe(false);
		expect(gov.shouldRun(50, 30)).toBe(true);
	});

	it('runs immediately after a long stall without a catch-up burst', () => {
		const gov = createFrameGovernor();
		expect(gov.shouldRun(0, 60)).toBe(true);
		// 5s hidden-tab gap: first frame back runs...
		expect(gov.shouldRun(5000, 60)).toBe(true);
		// ...and the next display frame does NOT get a queued burst.
		expect(gov.shouldRun(5006.9, 60)).toBe(false);
	});

	it('refuses to run on degenerate caps instead of running uncapped', () => {
		const gov = createFrameGovernor();
		expect(gov.shouldRun(0, 0)).toBe(false);
		expect(gov.shouldRun(16, -30)).toBe(false);
		expect(gov.shouldRun(32, NaN)).toBe(false);
	});

	it('fails open on a non-finite timestamp (never wedges the loop shut)', () => {
		const gov = createFrameGovernor();
		expect(gov.shouldRun(NaN, 60)).toBe(true);
		expect(gov.shouldRun(undefined, 60)).toBe(true);
	});

	it('reset() lets the next frame run regardless of recency', () => {
		const gov = createFrameGovernor();
		expect(gov.shouldRun(1000, 60)).toBe(true);
		expect(gov.shouldRun(1001, 60)).toBe(false);
		gov.reset();
		expect(gov.shouldRun(1002, 60)).toBe(true);
	});
});

describe('fps constants', () => {
	it('keeps the shared vocabulary sane (active > idle/saver > 0)', () => {
		expect(FPS_ACTIVE).toBeGreaterThan(FPS_IDLE);
		expect(FPS_IDLE).toBeGreaterThan(0);
		expect(FPS_SAVER).toBeGreaterThan(0);
		expect(FPS_SAVER).toBeLessThanOrEqual(FPS_IDLE);
	});
});

describe('power-saver persistence', () => {
	beforeEach(() => {
		// vitest environment may or may not provide localStorage; give the
		// module a working in-memory one for the round-trip test.
		const store = new Map();
		globalThis.localStorage = {
			getItem: (k) => (store.has(k) ? store.get(k) : null),
			setItem: (k, v) => store.set(k, String(v)),
			removeItem: (k) => store.delete(k),
		};
	});

	it('defaults off and round-trips on/off', () => {
		expect(getPowerSaver()).toBe(false);
		setPowerSaver(true);
		expect(getPowerSaver()).toBe(true);
		setPowerSaver(false);
		expect(getPowerSaver()).toBe(false);
	});

	it('reads as off when storage throws (private mode, sandboxed iframe)', () => {
		globalThis.localStorage = {
			getItem() { throw new Error('denied'); },
			setItem() { throw new Error('denied'); },
		};
		expect(getPowerSaver()).toBe(false);
		expect(() => setPowerSaver(true)).not.toThrow();
	});
});
