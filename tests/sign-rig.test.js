/**
 * Sign-rig kinematics — unit tests.
 *
 * These guard the bug that made the signing avatar unusable: the arm was posed
 * with rotations authored against a skeleton convention the reference rig does
 * not use, which swung the signing hand BEHIND the body. The fix was to solve
 * the arm against the rig's measured bind pose, so the assertions here are
 * about where the hand physically ends up, in model space:
 *
 *   forward is +Z (the direction the avatar faces), up is +Y, and the right
 *   side of the body is −X.
 */

import { describe, expect, it } from 'vitest';

import {
	ANCHORS,
	Pose,
	boneAxis,
	boneLength,
	orientQuat,
	palmAxis,
	qRotate,
	restPalmWorld,
	restRadialWorld,
	signPoint,
	solveArm,
	vDot,
	vLen,
	vNorm,
	vSub,
} from '../src/sign-rig.js';

const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

describe('measured rig frames', () => {
	it('measures bone axes from the rig instead of assuming them', () => {
		// cz.glb (Avaturn/Mixamo convention) aims bones down local +Y. The point
		// is that this is READ, not hardcoded — so assert it matches the rig.
		for (const bone of ['RightArm', 'RightForeArm', 'LeftArm', 'RightHandIndex1']) {
			const axis = boneAxis(bone);
			expect(vLen(axis)).toBeCloseTo(1, 6);
			expect(axis[1]).toBeGreaterThan(0.9);
		}
	});

	it('finds each arm segment’s real length', () => {
		expect(boneLength('RightArm')).toBeGreaterThan(0.15);
		expect(boneLength('RightArm')).toBeCloseTo(boneLength('LeftArm'), 3);
		expect(boneLength('RightForeArm')).toBeCloseTo(boneLength('LeftForeArm'), 3);
	});

	it('derives palms-down, thumbs-forward hand frames on both hands', () => {
		for (const side of ['Left', 'Right']) {
			// Palm faces the floor at rest…
			expect(restPalmWorld(side)[1]).toBeLessThan(-0.9);
			// …and the thumb side of the hand points where the body faces.
			expect(restRadialWorld(side)[2]).toBeGreaterThan(0.9);
		}
	});

	it('places anatomical anchors where they belong on the body', () => {
		expect(ANCHORS.forehead[1]).toBeGreaterThan(ANCHORS.chin[1]);
		expect(ANCHORS.chin[1]).toBeGreaterThan(ANCHORS.sternum[1]);
		expect(ANCHORS.sternum[1]).toBeGreaterThan(ANCHORS.belly[1]);
		// The sternum is upper chest: above the shoulder line is wrong, mid-belly
		// is wrong; it sits between the chest bone and the neck.
		expect(ANCHORS.sternum[1]).toBeLessThan(ANCHORS.shoulder.Right[1]);
		expect(ANCHORS.sternum[1]).toBeGreaterThan(ANCHORS.belly[1] + 0.1);
		expect(ANCHORS.shoulder.Right[0]).toBeLessThan(0); // right side is −X
		expect(ANCHORS.shoulder.Left[0]).toBeGreaterThan(0);
	});

	it('offsets sign points outward per hand', () => {
		const right = signPoint('sternum', { out: 0.2, side: 'Right' });
		const left = signPoint('sternum', { out: 0.2, side: 'Left' });
		expect(right[0]).toBeCloseTo(-0.2, 6);
		expect(left[0]).toBeCloseTo(0.2, 6);
	});
});

describe('orientQuat', () => {
	it('carries the local frame exactly onto the world frame', () => {
		const q = orientQuat([0, 1, 0], [0, 0, 1], [1, 0, 0], [0, 1, 0]);
		const axis = qRotate(q, [0, 1, 0]);
		expect(axis[0]).toBeCloseTo(1, 6);
		expect(near(vLen(axis), 1)).toBe(true);
		const ref = qRotate(q, [0, 0, 1]);
		expect(ref[1]).toBeCloseTo(1, 6);
	});

	it('still resolves when the reference is parallel to the axis', () => {
		const q = orientQuat([0, 1, 0], [0, 1, 0], [0, 0, 1], [0, 0, 1]);
		expect(qRotate(q, [0, 1, 0])[2]).toBeCloseTo(1, 6);
	});
});

describe('solveArm', () => {
	const spellingTarget = signPoint('chin', { out: 0.24, up: -0.03, forward: 0.21, side: 'Right' });

	it('puts the wrist exactly on a reachable target', () => {
		const pose = new Pose();
		solveArm(pose, 'Right', { wrist: spellingTarget, fingers: [0, 1, 0], palm: [0, 0, 1] });
		expect(vLen(vSub(pose.worldPos('RightHand'), spellingTarget))).toBeLessThan(1e-3);
	});

	it('keeps the signing hand IN FRONT of the body, never behind it', () => {
		// The regression this whole module exists for: the old pose put the hand
		// at negative Z, i.e. behind the avatar's back.
		const pose = new Pose();
		solveArm(pose, 'Right', { wrist: spellingTarget, fingers: [0, 1, 0], palm: [0, 0, 1] });
		for (const bone of ['RightForeArm', 'RightHand', 'RightHandMiddle3']) {
			expect(pose.worldPos(bone)[2], bone).toBeGreaterThan(0);
		}
	});

	it('aims the fingers and palm where asked', () => {
		const pose = new Pose();
		solveArm(pose, 'Right', { wrist: spellingTarget, fingers: [0, 1, 0], palm: [0, 0, 1] });
		const fingers = pose.worldDir('RightHand');
		expect(fingers[1]).toBeGreaterThan(0.98); // straight up
		const palm = vNorm(qRotate(pose.worldQuat('RightHand'), palmAxis('RightHand')));
		expect(palm[2]).toBeGreaterThan(0.98); // toward the reader
	});

	it('drops the elbow below the wrist and outside the torso', () => {
		const pose = new Pose();
		solveArm(pose, 'Right', { wrist: spellingTarget, fingers: [0, 1, 0], palm: [0, 0, 1] });
		const elbow = pose.worldPos('RightForeArm');
		const wrist = pose.worldPos('RightHand');
		const shoulder = pose.worldPos('RightArm');
		expect(elbow[1]).toBeLessThan(wrist[1]);
		expect(elbow[1]).toBeLessThan(shoulder[1]);
		// Elbow stays on the signing side of the body, not tucked across it.
		expect(elbow[0]).toBeLessThan(0);
	});

	it('preserves the rig’s own bone lengths (no stretching to reach)', () => {
		const pose = new Pose();
		solveArm(pose, 'Right', { wrist: spellingTarget, fingers: [0, 1, 0], palm: [0, 0, 1] });
		const upper = vLen(vSub(pose.worldPos('RightForeArm'), pose.worldPos('RightArm')));
		const lower = vLen(vSub(pose.worldPos('RightHand'), pose.worldPos('RightForeArm')));
		expect(upper).toBeCloseTo(boneLength('RightArm'), 5);
		expect(lower).toBeCloseTo(boneLength('RightForeArm'), 5);
	});

	it('clamps an out-of-reach target instead of tearing the arm apart', () => {
		const pose = new Pose();
		const far = [-3, 1.5, 3];
		solveArm(pose, 'Right', { wrist: far, fingers: [0, 1, 0], palm: [0, 0, 1] });
		const reach = vLen(vSub(pose.worldPos('RightHand'), pose.worldPos('RightArm')));
		expect(reach).toBeLessThanOrEqual(boneLength('RightArm') + boneLength('RightForeArm'));
		// Still pointing AT the target, just short of it.
		const dir = vNorm(vSub(pose.worldPos('RightHand'), pose.worldPos('RightArm')));
		expect(vDot(dir, vNorm(vSub(far, pose.worldPos('RightArm'))))).toBeGreaterThan(0.99);
	});

	it('mirrors: the same body-relative target reaches the same place on either hand', () => {
		const rightTarget = signPoint('sternum', { out: 0.18, up: 0, forward: 0.25, side: 'Right' });
		const leftTarget = signPoint('sternum', { out: 0.18, up: 0, forward: 0.25, side: 'Left' });
		const pose = new Pose();
		solveArm(pose, 'Right', { wrist: rightTarget, fingers: [0, 1, 0], palm: [0, 0, 1] });
		solveArm(pose, 'Left', { wrist: leftTarget, fingers: [0, 1, 0], palm: [0, 0, 1] });
		const r = pose.worldPos('RightHand');
		const l = pose.worldPos('LeftHand');
		expect(r[0]).toBeCloseTo(-l[0], 3);
		expect(r[1]).toBeCloseTo(l[1], 3);
		expect(r[2]).toBeCloseTo(l[2], 3);
	});
});

describe('Pose', () => {
	it('round-trips a world rotation through the local it stores', () => {
		const pose = new Pose();
		const q = orientQuat(boneAxis('RightArm'), [1, 0, 0], [0, -1, 0], [0, 0, 1]);
		pose.setWorldQuat('RightArm', q);
		const back = pose.worldQuat('RightArm');
		for (let i = 0; i < 4; i++) expect(Math.abs(back[i])).toBeCloseTo(Math.abs(q[i]), 6);
	});

	it('moves child bones when a parent rotates (real forward kinematics)', () => {
		const pose = new Pose();
		const before = pose.worldPos('RightHand');
		pose.aim('RightArm', [0, 1, 0]);
		const after = pose.worldPos('RightHand');
		expect(vLen(vSub(before, after))).toBeGreaterThan(0.3);
	});

	it('clones without aliasing', () => {
		const a = new Pose();
		a.aim('RightArm', [0, 1, 0]);
		const b = a.clone();
		b.aim('RightArm', [0, -1, 0]);
		expect(a.worldDir('RightArm')[1]).toBeGreaterThan(0.9);
		expect(b.worldDir('RightArm')[1]).toBeLessThan(-0.9);
	});
});
