// The generated-motion gate (api/_lib/motion-quality.js) is the only thing
// standing between a diffusion sampler and the public animation library, so
// every rule it enforces is pinned here. Clips are built programmatically
// rather than committed as fixtures: a rule is only meaningful if the test can
// state exactly which property of the motion trips it.

import { describe, it, expect } from 'vitest';
import {
	MOTION_BOUNDS,
	MOTION_GATE_RULES,
	REQUIRED_BONES,
	explainMotionGate,
	gateMotionClip,
	measureClip,
	readClip,
} from '../api/_lib/motion-quality.js';

const FPS = 30;

/** Rotation about X by `deg`, as a unit [x,y,z,w] quaternion. */
function quatX(deg) {
	const h = ((deg * Math.PI) / 180) / 2;
	return [Math.sin(h), 0, 0, Math.cos(h)];
}

/**
 * Build a well-formed clip whose driven bones sweep smoothly through `sweepDeg`
 * over `seconds`. The default is a clip the gate accepts, so each test below
 * changes exactly one thing.
 */
function makeClip({
	seconds = 4,
	sweepDeg = 24,
	bones = REQUIRED_BONES,
	rootPath = null,
	loopClosed = true,
	name = 'gen-test',
} = {}) {
	const frames = Math.round(seconds * FPS) + 1;
	const times = Array.from({ length: frames }, (_, i) => i / FPS);
	const tracks = [];
	for (const bone of bones) {
		const values = [];
		for (let i = 0; i < frames; i++) {
			// A full sine cycle returns to the start, so the loop seam closes; a
			// half cycle leaves it open.
			const phase = (i / (frames - 1)) * (loopClosed ? 2 : 1) * Math.PI;
			values.push(...quatX(Math.sin(phase) * sweepDeg));
		}
		tracks.push({ name: `${bone}.quaternion`, type: 'quaternion', times, values });
	}
	if (rootPath) {
		const values = [];
		for (let i = 0; i < frames; i++) values.push(...rootPath(i / (frames - 1), i));
		tracks.push({ name: 'Hips.position', type: 'vector', times, values });
	}
	return { name, duration: (frames - 1) / FPS, tracks, uuid: 'test', blendMode: 2500 };
}

describe('a well-formed generated clip', () => {
	it('passes every rule', () => {
		const verdict = gateMotionClip(makeClip(), { loop: true, requestedDuration: 4 });
		expect(verdict.reasons).toEqual([]);
		expect(verdict.pass).toBe(true);
		expect(verdict.gateVersion).toBeGreaterThan(0);
	});

	it('reports the measurements the decision was made on', () => {
		const m = measureClip(readClip(makeClip()));
		expect(m.frames).toBe(121);
		expect(m.fps).toBeCloseTo(30, 5);
		expect(m.rotationTracks).toBe(REQUIRED_BONES.length);
		expect(m.missingBones).toEqual([]);
		expect(m.nonFinite).toBe(0);
	});
});

describe('structural rejects', () => {
	it('refuses a response that is not a clip at all', () => {
		const verdict = gateMotionClip({ hello: 'world' });
		expect(verdict.pass).toBe(false);
		expect(verdict.reasons).toEqual(['unreadable_clip']);
		expect(verdict.detail).toMatch(/no tracks/);
	});

	it('refuses a track whose values do not match its key count', () => {
		const clip = makeClip();
		clip.tracks[0].values = clip.tracks[0].values.slice(0, 7);
		const verdict = gateMotionClip(clip);
		expect(verdict.reasons).toEqual(['unreadable_clip']);
		expect(verdict.detail).toMatch(/values for/);
	});

	it('rejects NaN keyframes rather than shipping a pose that cannot be evaluated', () => {
		const clip = makeClip();
		clip.tracks[2].values[12] = Number.NaN;
		expect(gateMotionClip(clip).reasons).toContain('non_finite_keyframes');
	});

	it('rejects keyframe times that do not advance', () => {
		const clip = makeClip();
		for (const t of clip.tracks) t.times[5] = t.times[4];
		expect(gateMotionClip(clip).reasons).toContain('times_not_increasing');
	});

	it('rejects rotation keys that are not unit quaternions', () => {
		const clip = makeClip();
		for (let i = 0; i < 4; i++) clip.tracks[0].values[i] *= 1.4;
		expect(gateMotionClip(clip).reasons).toContain('quaternions_not_normalized');
	});

	it('rejects a clip that leaves a required humanoid bone undriven', () => {
		const clip = makeClip({ bones: REQUIRED_BONES.filter((b) => b !== 'LeftFoot') });
		expect(gateMotionClip(clip).reasons).toContain('missing_required_bones');
	});

	it('rejects clips shorter or longer than the library takes', () => {
		expect(gateMotionClip(makeClip({ seconds: 0.4 })).reasons).toContain('duration_too_short');
		expect(gateMotionClip(makeClip({ seconds: 20 })).reasons).toContain('duration_too_long');
	});

	it('rejects a clip whose length does not match what was asked for', () => {
		const verdict = gateMotionClip(makeClip({ seconds: 9 }), { requestedDuration: 4 });
		expect(verdict.reasons).toContain('duration_off_request');
	});
});

describe('motion content rejects', () => {
	it('rejects a clip that is effectively a frozen bind pose', () => {
		const verdict = gateMotionClip(makeClip({ sweepDeg: 0.05 }));
		expect(verdict.reasons).toContain('motion_too_still');
	});

	it('rejects a single-frame pose discontinuity, the tear the sampler actually produces', () => {
		// This is the real failure mode observed on the live lane: one frame where
		// the pose flips by 180 degrees while its neighbours are smooth.
		const clip = makeClip();
		const track = clip.tracks[4];
		const flipped = quatX(180);
		for (let i = 0; i < 4; i++) track.values[20 * 4 + i] = flipped[i];
		const verdict = gateMotionClip(clip);
		expect(verdict.reasons).toContain('frame_discontinuity');
		expect(verdict.metrics.maxFrameStepDeg).toBeGreaterThan(MOTION_BOUNDS.maxFrameAngularStepDeg);
	});

	it('rejects an open loop seam only when the clip is meant to loop', () => {
		const open = makeClip({ loopClosed: false, sweepDeg: 40 });
		expect(gateMotionClip(open, { loop: true }).reasons).toContain('loop_seam_open');
		expect(gateMotionClip(open, { loop: false }).reasons).not.toContain('loop_seam_open');
	});

	it('rejects a root that travels faster than a body can move', () => {
		const clip = makeClip({ rootPath: (_t, i) => [i * 0.5, 0.98, 0] });
		expect(gateMotionClip(clip).reasons).toContain('root_velocity_implausible');
	});
});

describe('foot slide, measured by forward kinematics', () => {
	it('accepts a clip that stands still', () => {
		const verdict = gateMotionClip(makeClip({ sweepDeg: 12 }), {});
		expect(verdict.reasons).not.toContain('foot_slide');
		expect(verdict.metrics.footSlideRatio).toBeLessThan(MOTION_BOUNDS.maxFootSlideRatio);
	});

	it('rejects a character whose planted feet are dragged across the floor', () => {
		// The legs barely move while the root translates a full body length: the
		// definition of skating. The feet follow the hips because forward
		// kinematics puts them there, which is the whole point of measuring
		// rather than trusting the prompt.
		const clip = makeClip({
			sweepDeg: 10,
			rootPath: (t) => [t * 1.2, 0.98, 0],
		});
		const verdict = gateMotionClip(clip);
		expect(verdict.reasons).toContain('foot_slide');
		expect(verdict.metrics.footSlideMetres).toBeGreaterThan(0.4);
	});

	it('rejects a character sunk through the ground plane', () => {
		const clip = makeClip({ sweepDeg: 12, rootPath: () => [0, 0.3, 0] });
		expect(gateMotionClip(clip).reasons).toContain('ground_penetration');
	});
});

describe('explanations', () => {
	it('names every reason the gate can produce', () => {
		const clip = makeClip({ seconds: 0.4, sweepDeg: 0.01 });
		const { reasons } = gateMotionClip(clip);
		expect(reasons.length).toBeGreaterThan(0);
		for (const reason of reasons) expect(MOTION_GATE_RULES[reason]).toBeTruthy();
		expect(explainMotionGate(reasons).every((s) => typeof s === 'string' && s.length > 10)).toBe(true);
	});
});
