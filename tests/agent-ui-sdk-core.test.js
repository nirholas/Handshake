// Core-path coverage for @three-ws/agent-ui (agent-ui-sdk/). The full handle
// (createAgentUI) needs WebGL and a hosted GLB, so it is exercised by the
// browser demos; here we prove the deterministic core the whole overlay is
// built on: the export surface the README documents, the RAF tween engine every
// behavior runs through, and the non-repeating random picker.
import { describe, it, expect } from 'vitest';

import * as api from '../agent-ui-sdk/src/index.js';

// The README's documented standalone-function list. If a documented export ever
// goes missing, the public API silently regresses for every consumer, so pin it.
const DOCUMENTED = [
	'createAgentUI',
	'createRenderer',
	'loadAvatar',
	'createAnimator',
	'lockRootMotion',
	'worldOfElement',
	'moveTo',
	'lookAtScreenX',
	'faceFront',
	'walkTo',
	'standOn',
	'fallOnto',
	'runOff',
	'interceptNavigation',
	'createRandomPicker',
	'caretScreenX',
	'startCaretTracking',
	'dust',
	'impactPulse',
	'proximityShadow',
	'scan',
];

describe('@three-ws/agent-ui export surface', () => {
	it('exports every function the README documents', () => {
		for (const name of DOCUMENTED) {
			expect(typeof api[name], name).toBe('function');
		}
	});

	it('exports createAgentUI as the headline entry', () => {
		expect(typeof api.createAgentUI).toBe('function');
	});
});

describe('createRandomPicker', () => {
	it('returns null for an empty pool and the only item for a singleton', () => {
		expect(api.createRandomPicker([])()).toBeNull();
		expect(api.createRandomPicker(['only'])()).toBe('only');
	});

	it('never repeats the same pick twice in a row', () => {
		const pick = api.createRandomPicker(['nod', 'shrug', 'wave']);
		let prev = pick();
		for (let i = 0; i < 50; i++) {
			const next = pick();
			expect(['nod', 'shrug', 'wave']).toContain(next);
			expect(next).not.toBe(prev);
			prev = next;
		}
	});
});

// The tween engine drives every movement/FX behavior, so its easing and
// completion semantics are the real core path. requestAnimationFrame and
// performance.now are stubbed per-test with a controllable clock.
describe('tween engine', () => {
	it('runs to completion, easing each frame, and resolves', async () => {
		const { tween, smoothstep, easeInQuad, easeOutCubic } = await import('../agent-ui-sdk/src/tween.js');

		// Easing identities the behaviors rely on.
		expect(smoothstep(0)).toBe(0);
		expect(smoothstep(1)).toBe(1);
		expect(easeInQuad(0)).toBe(0);
		expect(easeOutCubic(1)).toBe(1);
		expect(easeOutCubic(0)).toBe(0);

		// Drive RAF manually over a 100ms tween.
		const callbacks = [];
		let clock = 0;
		const raf = globalThis.requestAnimationFrame;
		const perf = globalThis.performance;
		globalThis.requestAnimationFrame = (cb) => { callbacks.push(cb); return callbacks.length; };
		globalThis.performance = { now: () => clock };

		const frames = [];
		let completed = false;
		const p = tween({
			duration: 100,
			onUpdate: (e) => frames.push(e),
			onComplete: () => { completed = true; },
		});
		// First frame fires synchronously at t=0.
		expect(frames.length).toBe(1);

		clock = 50; callbacks.shift()(50); // t=0.5
		clock = 100; callbacks.shift()(100); // t=1 -> completes
		await p;

		expect(completed).toBe(true);
		expect(frames[0]).toBe(0);
		expect(frames[frames.length - 1]).toBe(1);
		// Smoothstep midpoint eases to exactly 0.5.
		expect(frames[1]).toBeCloseTo(0.5, 5);

		globalThis.requestAnimationFrame = raf;
		globalThis.performance = perf;
	});

	it('cancel() stops the tween and never resolves late', async () => {
		const { tweenProp } = await import('../agent-ui-sdk/src/tween.js');

		const callbacks = [];
		let clock = 0;
		const raf = globalThis.requestAnimationFrame;
		const caf = globalThis.cancelAnimationFrame;
		const perf = globalThis.performance;
		globalThis.requestAnimationFrame = (cb) => { callbacks.push(cb); return callbacks.length; };
		globalThis.cancelAnimationFrame = () => {};
		globalThis.performance = { now: () => clock };

		const obj = { x: 0 };
		const p = tweenProp(obj, 'x', 10, { duration: 100 });
		p.cancel();
		clock = 100;
		// No queued frame should advance the value after cancel.
		while (callbacks.length) callbacks.shift()(100);

		expect(obj.x).toBe(0);

		globalThis.requestAnimationFrame = raf;
		globalThis.cancelAnimationFrame = caf;
		globalThis.performance = perf;
	});
});
