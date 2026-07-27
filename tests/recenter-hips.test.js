/**
 * recenter-hips: the "stands on its mark" regression lock.
 *
 * A source rig round-tripped through Blender or glTF-Transform can bake the
 * armature's own transform onto the Hips track. The retarget pipeline copies
 * that track verbatim onto a canonical identity-rest rig, so the offset is no
 * longer cancelled by a parent and the avatar stands permanently displaced.
 * `Offabean Dance` shipped that way on its first build: 1.45 m off its mark and
 * floating, while every healthy clip in the library begins within a few
 * centimetres of the reference rig's rest Hips.
 *
 * These tests lock the two properties that make the correction safe to apply:
 * it removes the constant offset, and it removes ONLY a constant, so authored
 * root motion and the internal pose survive untouched.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { recenterHips, OFFSET_THRESHOLD_M } from '../scripts/recenter-hips.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// The reference rig's (cz.glb) rest Hips, the mark clips are anchored to.
const REST_HIPS = [0, 0.984, 0.005];

/** Minimal AnimationClip.toJSON() shape with a Hips position track. */
function clipWithHips(frames) {
	return {
		duration: frames.length / 30,
		tracks: [
			{
				name: 'Hips.position',
				type: 'vector',
				times: frames.map((_, i) => i / 30),
				values: frames.flat(),
			},
			{
				name: 'Spine.quaternion',
				type: 'quaternion',
				times: [0],
				values: [0, 0, 0, 1],
			},
		],
	};
}

function hipsValues(clip) {
	return clip.tracks.find((t) => t.name === 'Hips.position').values;
}

describe('recenterHips', () => {
	it('anchors a displaced clip to the rig rest Hips', () => {
		const clip = clipWithHips([
			[-0.008, 1.143, -1.44],
			[0.02, 1.2, -1.5],
		]);
		const result = recenterHips(clip, REST_HIPS);

		expect(result.changed).toBe(true);
		expect(result.distance).toBeGreaterThan(1.4);

		const v = hipsValues(clip);
		expect(v[0]).toBeCloseTo(REST_HIPS[0], 6);
		expect(v[1]).toBeCloseTo(REST_HIPS[1], 6);
		expect(v[2]).toBeCloseTo(REST_HIPS[2], 6);
	});

	it('preserves authored root motion, shifting every frame by the same constant', () => {
		// A clip that walks 4m forward must still walk 4m forward.
		const clip = clipWithHips([
			[0, 1.2, -1.5],
			[0, 1.2, -0.5],
			[0, 1.2, 2.5],
		]);
		const before = [...hipsValues(clip)];
		recenterHips(clip, REST_HIPS);
		const after = hipsValues(clip);

		for (let i = 0; i + 2 < before.length; i += 3) {
			for (let k = 0; k < 3; k++) {
				const delta = before[i + k] - after[i + k];
				const firstDelta = before[k] - after[k];
				expect(delta).toBeCloseTo(firstDelta, 9);
			}
		}
		// Total travel is unchanged.
		expect(after[8] - after[2]).toBeCloseTo(before[8] - before[2], 9);
	});

	it('leaves every non-Hips track untouched', () => {
		const clip = clipWithHips([[0, 1.2, -1.5]]);
		const spineBefore = JSON.stringify(clip.tracks[1]);
		recenterHips(clip, REST_HIPS);
		expect(JSON.stringify(clip.tracks[1])).toBe(spineBefore);
	});

	it('is a no-op on a clip already on its mark', () => {
		const clip = clipWithHips([
			[0, 0.984, 0.005],
			[0.3, 1.1, 0.2],
		]);
		const before = [...hipsValues(clip)];
		const result = recenterHips(clip, REST_HIPS);

		expect(result.changed).toBe(false);
		expect(result.reason).toBe('already-centered');
		expect(hipsValues(clip)).toEqual(before);
	});

	it('is idempotent: correcting an already-corrected clip changes nothing', () => {
		const clip = clipWithHips([
			[-0.008, 1.143, -1.44],
			[0.02, 1.2, -1.5],
		]);
		recenterHips(clip, REST_HIPS);
		const once = [...hipsValues(clip)];
		const second = recenterHips(clip, REST_HIPS);

		expect(second.changed).toBe(false);
		expect(hipsValues(clip)).toEqual(once);
	});

	it('gates on the threshold rather than nudging every clip', () => {
		const justUnder = OFFSET_THRESHOLD_M * 0.9;
		const clip = clipWithHips([[0, 0.984 + justUnder, 0.005]]);
		expect(recenterHips(clip, REST_HIPS).changed).toBe(false);

		const justOver = OFFSET_THRESHOLD_M * 1.1;
		const clip2 = clipWithHips([[0, 0.984 + justOver, 0.005]]);
		expect(recenterHips(clip2, REST_HIPS).changed).toBe(true);
	});

	it('reports a reason instead of throwing on a clip with no Hips track', () => {
		const clip = { duration: 1, tracks: [{ name: 'Spine.quaternion', type: 'quaternion', times: [0], values: [0, 0, 0, 1] }] };
		const result = recenterHips(clip, REST_HIPS);
		expect(result.changed).toBe(false);
		expect(result.reason).toBe('no-hips-position');
	});

	it('reports a reason instead of throwing when the rig rest pose is unavailable', () => {
		const clip = clipWithHips([[0, 1.2, -1.5]]);
		const result = recenterHips(clip, null);
		expect(result.changed).toBe(false);
		expect(result.reason).toBe('no-rest-pose');
	});
});

describe('av-offabean-dance (the clip that motivated the correction)', () => {
	const clipPath = resolve(ROOT, 'public/animations/clips/av-offabean-dance.json');

	it('ships standing on its mark, not floating behind it', () => {
		expect(existsSync(clipPath)).toBe(true);
		const clip = JSON.parse(readFileSync(clipPath, 'utf8'));
		const v = hipsValues(clip);

		// First frame sits at the rig's rest Hips.
		expect(v[0]).toBeCloseTo(REST_HIPS[0], 2);
		expect(v[1]).toBeCloseTo(REST_HIPS[1], 2);
		expect(v[2]).toBeCloseTo(REST_HIPS[2], 2);

		// And the whole clip stays in the library's hip-height band rather than
		// collapsing to the floor (the centimetre-scale bug) or floating.
		let minY = Infinity;
		let maxY = -Infinity;
		for (let i = 1; i < v.length; i += 3) {
			minY = Math.min(minY, v[i]);
			maxY = Math.max(maxY, v[i]);
		}
		expect(minY).toBeGreaterThan(0.6);
		expect(maxY).toBeLessThan(1.6);
	});
});
