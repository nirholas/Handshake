/**
 * Un-driven arm relaxation: unit tests.
 *
 * Builds synthetic T-posed skeletons (bones with real local offsets) and asserts:
 *  - a rig whose arms are un-mapped gets both arms swung down;
 *  - a rig whose arms name-map is never touched (the mixer drives them);
 *  - already-hanging arms are left alone;
 *  - a legless/degenerate rig is a safe no-op.
 */

import { describe, it, expect } from 'vitest';
import { Bone, Object3D, Skeleton, SkinnedMesh, BufferGeometry, Vector3 } from 'three';
import { relaxUndrivenArms } from '../src/animation-arm-relax.js';
import { canonicalNodeMapFromObject } from '../src/animation-retarget.js';

// Build a minimal humanoid whose upper arms are horizontal (T-pose). Each arm is
// shoulder → upperArm → hand. `armName(side)` lets a test choose canonical vs
// foreign spellings so we can exercise the name-map gate.
function makeTposeRig({ leftArm, rightArm, armsDown = false } = {}) {
	const root = new Object3D();

	const hips = Object.assign(new Bone(), { name: 'Hips' });
	hips.position.set(0, 1.0, 0);

	const spine = Object.assign(new Bone(), { name: 'Spine' });
	spine.position.set(0, 0.25, 0); // local, above hips
	hips.add(spine);

	const head = Object.assign(new Bone(), { name: 'Head' });
	head.position.set(0, 0.45, 0);
	spine.add(head);

	// Legs (give the rig a lower body so the vertical mid-point sits at the torso).
	const lUpLeg = Object.assign(new Bone(), { name: 'LeftUpLeg' });
	lUpLeg.position.set(0.1, -0.05, 0);
	hips.add(lUpLeg);
	const lLeg = Object.assign(new Bone(), { name: 'LeftLeg' });
	lLeg.position.set(0, -0.45, 0); // points straight down
	lUpLeg.add(lLeg);
	const rUpLeg = Object.assign(new Bone(), { name: 'RightUpLeg' });
	rUpLeg.position.set(-0.1, -0.05, 0);
	hips.add(rUpLeg);
	const rLeg = Object.assign(new Bone(), { name: 'RightLeg' });
	rLeg.position.set(0, -0.45, 0);
	rUpLeg.add(rLeg);

	// Shoulders sit at the top of the spine, pointing slightly up-and-out.
	const lShoulder = Object.assign(new Bone(), { name: 'LeftShoulder' });
	lShoulder.position.set(0.08, 0.4, 0);
	spine.add(lShoulder);
	const lArm = Object.assign(new Bone(), { name: leftArm });
	lArm.position.set(0.12, 0.05, 0); // out + a touch up from the shoulder
	lShoulder.add(lArm);
	const lHand = Object.assign(new Bone(), { name: 'LeftHand_x' });
	// T-pose: hand straight out along +X. Down-pose: hand below the arm.
	lHand.position.copy(armsDown ? new Vector3(0.02, -0.3, 0) : new Vector3(0.3, 0, 0));
	lArm.add(lHand);

	const rShoulder = Object.assign(new Bone(), { name: 'RightShoulder' });
	rShoulder.position.set(-0.08, 0.4, 0);
	spine.add(rShoulder);
	const rArm = Object.assign(new Bone(), { name: rightArm });
	rArm.position.set(-0.12, 0.05, 0);
	rShoulder.add(rArm);
	const rHand = Object.assign(new Bone(), { name: 'RightHand_x' });
	rHand.position.copy(armsDown ? new Vector3(-0.02, -0.3, 0) : new Vector3(-0.3, 0, 0));
	rArm.add(rHand);

	const bones = [hips, spine, head, lUpLeg, lLeg, rUpLeg, rLeg, lShoulder, lArm, lHand, rShoulder, rArm, rHand];
	const mesh = new SkinnedMesh(new BufferGeometry());
	mesh.add(hips);
	mesh.bind(new Skeleton(bones));
	root.add(mesh);
	root.updateMatrixWorld(true);
	return { root, lArm, rArm, lHand, rHand };
}

// World-space direction from a bone to its (single) child bone.
function childDir(bone) {
	const child = bone.children.find((c) => c.isBone);
	const a = new Vector3(); bone.getWorldPosition(a);
	const b = new Vector3(); child.getWorldPosition(b);
	return b.sub(a).normalize();
}

describe('relaxUndrivenArms', () => {
	it('swings both arms down when the arm bones are un-mapped (foreign names)', () => {
		const { root, lArm, rArm } = makeTposeRig({ leftArm: 'arm_L_x', rightArm: 'arm_R_x' });
		const map = canonicalNodeMapFromObject(root);
		// Precondition: these foreign names did NOT canonicalize to Left/RightArm.
		expect(map.has('LeftArm')).toBe(false);
		expect(map.has('RightArm')).toBe(false);
		// Precondition: arms start horizontal.
		expect(childDir(lArm).y).toBeGreaterThan(-0.2);
		expect(childDir(rArm).y).toBeGreaterThan(-0.2);

		const n = relaxUndrivenArms(root, map);
		expect(n).toBe(2);

		// Both arms now hang: the child direction is dominated by -Y.
		expect(childDir(lArm).y).toBeLessThan(-0.7);
		expect(childDir(rArm).y).toBeLessThan(-0.7);
	});

	it('is a no-op when the arms name-map (the clip already drives them)', () => {
		const { root, lArm, rArm } = makeTposeRig({ leftArm: 'LeftArm', rightArm: 'RightArm' });
		const map = canonicalNodeMapFromObject(root);
		expect(map.get('LeftArm')).toBe('LeftArm');

		const beforeL = childDir(lArm).clone();
		const beforeR = childDir(rArm).clone();
		const n = relaxUndrivenArms(root, map);
		expect(n).toBe(0);
		// Poses untouched.
		expect(childDir(lArm).distanceTo(beforeL)).toBeLessThan(1e-6);
		expect(childDir(rArm).distanceTo(beforeR)).toBeLessThan(1e-6);
	});

	it('leaves already-hanging arms alone even when un-mapped', () => {
		const { root, lArm, rArm } = makeTposeRig({ leftArm: 'arm_L_x', rightArm: 'arm_R_x', armsDown: true });
		const map = canonicalNodeMapFromObject(root);
		const n = relaxUndrivenArms(root, map);
		expect(n).toBe(0);
		expect(childDir(lArm).y).toBeLessThan(-0.5);
		expect(childDir(rArm).y).toBeLessThan(-0.5);
	});

	it('is a safe no-op on a rig with no arm-like bones', () => {
		const root = new Object3D();
		const a = Object.assign(new Bone(), { name: 'root' });
		const b = Object.assign(new Bone(), { name: 'wheel' });
		b.position.set(0, -0.5, 0);
		a.add(b);
		const mesh = new SkinnedMesh(new BufferGeometry());
		mesh.add(a);
		mesh.bind(new Skeleton([a, b]));
		root.add(mesh);
		root.updateMatrixWorld(true);
		expect(relaxUndrivenArms(root, new Map())).toBe(0);
	});

	it('tolerates a null model', () => {
		expect(relaxUndrivenArms(null, new Map())).toBe(0);
	});
});
