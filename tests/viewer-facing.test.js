/**
 * Viewer facing detection: which way does the avatar look?
 *
 * The camera seat used to be hardcoded to +Z and called "front-on", which only
 * held for rigs authored facing +Z. These tests pin the geometry that replaced
 * it, including the one case that must never regress: a model with no readable
 * rig still gets the legacy +Z seat.
 */

import { describe, it, expect } from 'vitest';
import {
	yawFromRightSpan,
	forwardFromYaw,
	horizontalExtentAt,
	estimateFacingYaw,
} from '../src/viewer/facing.js';

/** Minimal stand-in for a THREE.Bone: only name + world translation are read. */
function bone(name, x, z) {
	const elements = new Array(16).fill(0);
	elements[12] = x;
	elements[14] = z;
	return { isBone: true, name, matrixWorld: { elements } };
}

/** Minimal stand-in for an Object3D root that owns the bones. */
function model(...bones) {
	return { traverse(fn) { fn(this); bones.forEach(fn); } };
}

describe('yawFromRightSpan', () => {
	it('reads +Z facing when the right side sits on -X (the legacy assumption)', () => {
		expect(yawFromRightSpan(-1, 0)).toBeCloseTo(0, 12);
	});

	it('reads -Z facing when the right side sits on +X', () => {
		expect(Math.abs(yawFromRightSpan(1, 0))).toBeCloseTo(Math.PI, 12);
	});

	it('reads +X facing when the right side sits on +Z', () => {
		expect(yawFromRightSpan(0, 1)).toBeCloseTo(Math.PI / 2, 12);
	});

	it('rejects a span shorter than the floor, so a collapsed rig cannot spin the camera', () => {
		expect(yawFromRightSpan(0.001, 0.001, 0.05)).toBeNull();
	});

	it('rejects non-finite input rather than producing NaN yaw', () => {
		expect(yawFromRightSpan(Number.NaN, 0)).toBeNull();
		expect(yawFromRightSpan(0, Number.POSITIVE_INFINITY)).toBeNull();
	});
});

describe('forwardFromYaw', () => {
	it('maps yaw 0 to +Z, the seat every existing embed already had', () => {
		const f = forwardFromYaw(0);
		expect(f.x).toBeCloseTo(0, 12);
		expect(f.z).toBeCloseTo(1, 12);
	});

	it('maps a quarter turn to +X', () => {
		const f = forwardFromYaw(Math.PI / 2);
		expect(f.x).toBeCloseTo(1, 12);
		expect(f.z).toBeCloseTo(0, 12);
	});

	it('stays a unit vector at an arbitrary angle', () => {
		const f = forwardFromYaw(1.2345);
		expect(Math.hypot(f.x, f.z)).toBeCloseTo(1, 12);
	});
});

describe('horizontalExtentAt', () => {
	it('is the box width at yaw 0, so full-body framing is unchanged', () => {
		expect(horizontalExtentAt(0.9, 0.3, 0)).toBeCloseTo(0.9, 12);
	});

	it('is the box depth when the camera looks along X', () => {
		expect(horizontalExtentAt(0.9, 0.3, Math.PI / 2)).toBeCloseTo(0.3, 12);
	});

	it('blends the two axes at an oblique angle', () => {
		const e = horizontalExtentAt(0.9, 0.3, Math.PI / 4);
		expect(e).toBeCloseTo(Math.SQRT1_2 * (0.9 + 0.3), 12);
		expect(e).toBeGreaterThan(0.3);
		expect(e).toBeLessThan(0.9 + 0.3);
	});
});

describe('estimateFacingYaw', () => {
	it('prefers shoulders and reads a -Z facing rig', () => {
		const yaw = estimateFacingYaw(model(
			bone('mixamorigLeftShoulder', -0.18, 0),
			bone('mixamorigRightShoulder', 0.18, 0),
		), 1.8);
		expect(Math.abs(yaw)).toBeCloseTo(Math.PI, 6);
	});

	it('canonicalizes vendor bone names before matching', () => {
		const yaw = estimateFacingYaw(model(
			bone('J_Bip_L_UpperArm', 0, -0.2),
			bone('J_Bip_R_UpperArm', 0, 0.2),
		), 1.8);
		expect(yaw).toBeCloseTo(Math.PI / 2, 6);
	});

	it('falls back to the legs when the rig has no arms', () => {
		const yaw = estimateFacingYaw(model(
			bone('LeftUpLeg', -0.1, 0),
			bone('RightUpLeg', 0.1, 0),
		), 1.8);
		expect(Math.abs(yaw)).toBeCloseTo(Math.PI, 6);
	});

	it('returns null for a prop with no bones, leaving the camera on +Z', () => {
		expect(estimateFacingYaw(model(), 1.8)).toBeNull();
	});

	it('returns null when the left and right bones sit on top of each other', () => {
		expect(estimateFacingYaw(model(
			bone('LeftShoulder', 0, 0),
			bone('RightShoulder', 0.0001, 0),
		), 1.8)).toBeNull();
	});

	it('tolerates a root that is not a scene graph', () => {
		expect(estimateFacingYaw(null, 1.8)).toBeNull();
		expect(estimateFacingYaw({}, 1.8)).toBeNull();
	});
});
