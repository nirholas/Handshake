// Tests for the pure camera-framing math used by TalkScene.
//
// All inputs are plain JS objects — no three.js — so vitest exercises the
// math directly. We use a synthetic "humanoid" bounding box (1.7 m tall,
// 0.4 m wide, 0.3 m deep, base on the floor) as the canonical fixture so
// expected camera positions stay easy to reason about.

import { describe, it, expect } from 'vitest';
import {
	CAMERA_PRESETS,
	PRESET_LABELS,
	computeFraming,
	nextPreset,
} from '../src/voice/camera-presets.js';

const HUMANOID = {
	min: { x: -0.2, y: 0, z: -0.15 },
	max: { x: 0.2, y: 1.7, z: 0.15 },
};

describe('camera presets — vocabulary', () => {
	it('declares full / half / headshot in display order', () => {
		expect(CAMERA_PRESETS).toEqual(['full', 'half', 'headshot']);
	});

	it('has a label for every preset', () => {
		for (const p of CAMERA_PRESETS) {
			expect(PRESET_LABELS[p]).toBeTruthy();
		}
	});
});

describe('computeFraming — defaults', () => {
	it('returns a framing object with target / position / fov for full preset', () => {
		const r = computeFraming({ box: HUMANOID, preset: 'full' });
		expect(r.target).toHaveProperty('x');
		expect(r.target).toHaveProperty('y');
		expect(r.target).toHaveProperty('z');
		expect(r.position).toHaveProperty('x');
		expect(r.position).toHaveProperty('y');
		expect(r.position).toHaveProperty('z');
		expect(r.fov).toBeGreaterThan(0);
	});

	it('camera sits in front of the avatar (positive Z) for every preset', () => {
		for (const p of CAMERA_PRESETS) {
			const r = computeFraming({ box: HUMANOID, preset: p });
			expect(r.position.z, p).toBeGreaterThan(HUMANOID.max.z);
		}
	});

	it('target is horizontally centered on the avatar', () => {
		for (const p of CAMERA_PRESETS) {
			const r = computeFraming({ box: HUMANOID, preset: p });
			expect(r.target.x, p).toBeCloseTo(0, 5);
			expect(r.target.z, p).toBeCloseTo(0, 5);
		}
	});

	it('rejects unknown presets and malformed boxes', () => {
		expect(() => computeFraming({ box: HUMANOID, preset: 'bogus' })).toThrow();
		expect(() => computeFraming({})).toThrow();
		expect(() => computeFraming({ box: { min: { x: 0, y: 0, z: 0 } } })).toThrow();
	});
});

describe('computeFraming — preset semantics', () => {
	it('half aims higher up the body than full', () => {
		const full = computeFraming({ box: HUMANOID, preset: 'full' });
		const half = computeFraming({ box: HUMANOID, preset: 'half' });
		expect(half.target.y).toBeGreaterThan(full.target.y);
	});

	it('headshot aims highest of the three', () => {
		const half = computeFraming({ box: HUMANOID, preset: 'half' });
		const head = computeFraming({ box: HUMANOID, preset: 'headshot' });
		expect(head.target.y).toBeGreaterThan(half.target.y);
		// Should be near the head — last 10% of avatar height.
		expect(head.target.y).toBeGreaterThan(HUMANOID.max.y * 0.85);
	});

	it('headshot pulls the camera closer than full', () => {
		const full = computeFraming({ box: HUMANOID, preset: 'full' });
		const head = computeFraming({ box: HUMANOID, preset: 'headshot' });
		const fullDist = full.position.z - full.target.z;
		const headDist = head.position.z - head.target.z;
		expect(headDist).toBeLessThan(fullDist);
	});

	it('tighter framing uses a tighter FOV', () => {
		const full = computeFraming({ box: HUMANOID, preset: 'full' });
		const half = computeFraming({ box: HUMANOID, preset: 'half' });
		const head = computeFraming({ box: HUMANOID, preset: 'headshot' });
		expect(half.fov).toBeLessThanOrEqual(full.fov);
		expect(head.fov).toBeLessThan(half.fov);
	});
});

describe('computeFraming — aspect ratio scaling', () => {
	it('narrower viewport pulls the camera further back', () => {
		const wide = computeFraming({ box: HUMANOID, preset: 'half', aspectRatio: 1.8 });
		const narrow = computeFraming({ box: HUMANOID, preset: 'half', aspectRatio: 0.6 });
		expect(narrow.position.z).toBeGreaterThan(wide.position.z);
	});

	it('respects the minDistance floor on a small avatar', () => {
		// 30 cm tall chibi — distanceMul*height would be tiny.
		const chibi = {
			min: { x: -0.15, y: 0, z: -0.1 },
			max: { x: 0.15, y: 0.3, z: 0.1 },
		};
		const r = computeFraming({ box: chibi, preset: 'full' });
		// Per the config, full's minDistance is 0.7 m.
		expect(r.position.z).toBeGreaterThanOrEqual(0.7);
	});
});

describe('nextPreset', () => {
	it('cycles in display order', () => {
		expect(nextPreset('full')).toBe('half');
		expect(nextPreset('half')).toBe('headshot');
		expect(nextPreset('headshot')).toBe('full');
	});

	it('returns the first preset for unknown / missing input', () => {
		expect(nextPreset()).toBe(CAMERA_PRESETS[0]);
		expect(nextPreset('garbage')).toBe(CAMERA_PRESETS[0]);
	});
});
