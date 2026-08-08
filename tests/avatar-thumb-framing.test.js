// src/game/avatar-thumb.js: the lobby's avatar portrait renderer.
//
// The invariant under test:
//
//   The renderer returns a portrait or it returns null. It never returns a
//   blank one.
//
// This matters because of what the caller does with a result. `_renderChipPreview`
// in coincommunities-ui.js clears the chip (`chip.textContent = ''`) before
// appending the portrait, so a data URL of a fully transparent PNG does not
// degrade to "no portrait": it wipes out the emoji or API thumbnail that was
// standing in, and the avatar chip renders as an empty box. That is the blank
// preset chip reported on the lobby.
//
// `canFrame` is the guard for the way that actually happens: a GLB whose bounds
// cannot be measured. Framing off unmeasurable bounds puts the rig at a NaN
// position, and the snapshot comes back fully transparent.

import { describe, it, expect } from 'vitest';
import { Box3, Vector3 } from 'three';
import { canFrame } from '../src/game/avatar-thumb.js';

describe('canFrame', () => {
	it('accepts a normally measured avatar', () => {
		const box = new Box3(new Vector3(-0.4, 0, -0.3), new Vector3(0.4, 1.75, 0.3));
		expect(canFrame(box)).toBe(true);
	});

	it('accepts a flat or zero-extent box that still has a real position', () => {
		// A single-plane prop measures zero-thickness on one axis. It is degenerate
		// but finite, so the camera can still frame it, Box3.isEmpty() agrees.
		const box = new Box3(new Vector3(-0.5, 0, 0), new Vector3(0.5, 1.7, 0));
		expect(canFrame(box)).toBe(true);
	});

	it('rejects the empty box a GLB with no renderable geometry produces', () => {
		// This is what `new Box3().setFromObject(model)` returns for a scene with no
		// meshes: the initialized min/max are never contracted, so min stays
		// +Infinity and max stays -Infinity.
		const box = new Box3();
		expect(box.isEmpty()).toBe(true);
		expect(canFrame(box)).toBe(false);
	});

	it('rejects NaN bounds, which Box3.isEmpty() reports as a valid box', () => {
		// The regression this test exists for. Every comparison against NaN is false,
		// so isEmpty() answers false and a NaN box reads as perfectly good. Checking
		// isEmpty() alone let this straight through to the camera.
		const box = new Box3(new Vector3(NaN, NaN, NaN), new Vector3(NaN, NaN, NaN));
		expect(box.isEmpty()).toBe(false);
		expect(canFrame(box)).toBe(false);
	});

	it('rejects a box with a single non-finite component', () => {
		const box = new Box3(new Vector3(-0.4, 0, -0.3), new Vector3(0.4, Infinity, 0.3));
		expect(canFrame(box)).toBe(false);
	});

	it('rejects a missing box rather than throwing', () => {
		expect(canFrame(null)).toBe(false);
		expect(canFrame(undefined)).toBe(false);
	});
});
