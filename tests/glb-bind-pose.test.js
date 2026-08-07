/**
 * Bind-pose neutralisation before export: unit tests.
 *
 * Builds a skinned humanoid whose bind pose is a symmetric A-pose, poses it away
 * from that bind the way a playing idle clip would, and asserts:
 *  - posing to bind restores the exact bind transforms (this is the regression
 *    guard: exported rest pose must equal the pose the mesh was skinned against);
 *  - the restored pose is symmetric, which a frozen animation frame is not;
 *  - a skeleton shared by several primitives is posed once, not once per mesh;
 *  - capture/restore round-trips so the live scene survives an export;
 *  - malformed and skeleton-free graphs are safe no-ops.
 */

import { describe, it, expect } from 'vitest';
import { Bone, Object3D, Skeleton, SkinnedMesh, BufferGeometry, Matrix4 } from 'three';
import {
	poseSkeletonsToBind,
	captureBoneTransforms,
	restoreBoneTransforms,
} from '../src/glb-bind-pose.js';

// Symmetric A-pose humanoid: hips → (spine → each arm) + each leg. Mirrors the
// shape of the real parametric base, where left/right offsets are exact mirrors.
function makeRig() {
	const root = new Object3D();

	const hips = Object.assign(new Bone(), { name: 'Hips' });
	hips.position.set(0, 0.92, 0);
	root.add(hips);

	const spine = Object.assign(new Bone(), { name: 'Spine' });
	spine.position.set(0, 0.11, 0);
	hips.add(spine);

	const bones = [hips, spine];
	for (const side of ['Left', 'Right']) {
		const dir = side === 'Left' ? 1 : -1;

		const arm = Object.assign(new Bone(), { name: `${side}Arm` });
		arm.position.set(dir * 0.17, 0.29, 0);
		spine.add(arm);

		const hand = Object.assign(new Bone(), { name: `${side}Hand` });
		// Down-and-out: the A-pose the base body is authored in.
		hand.position.set(dir * 0.21, -0.35, 0);
		arm.add(hand);

		const leg = Object.assign(new Bone(), { name: `${side}UpLeg` });
		leg.position.set(dir * 0.11, -0.05, 0);
		hips.add(leg);

		const foot = Object.assign(new Bone(), { name: `${side}Foot` });
		foot.position.set(dir * 0.09, -0.8, 0);
		leg.add(foot);

		bones.push(arm, hand, leg, foot);
	}

	root.updateMatrixWorld(true);
	// Bind the skeleton while the rig sits in that A-pose, so the inverse bind
	// matrices describe exactly this stance.
	const boneInverses = bones.map((b) => new Matrix4().copy(b.matrixWorld).invert());
	const skeleton = new Skeleton(bones, boneInverses);

	return { root, hips, skeleton, bones };
}

function skinnedMesh(skeleton, root) {
	const mesh = new SkinnedMesh(new BufferGeometry());
	root.add(mesh);
	mesh.bind(skeleton, new Matrix4());
	return mesh;
}

// World-space distance between two bones, which is what the pose actually looks
// like and is invariant to where the rig sits in the scene.
function dist(root, a, b) {
	root.updateMatrixWorld(true);
	return a.getWorldPosition(new (a.position.constructor)()).distanceTo(
		b.getWorldPosition(new (b.position.constructor)()),
	);
}

const byName = (bones, name) => bones.find((b) => b.name === name);

describe('poseSkeletonsToBind', () => {
	it('restores the exact bind pose after an animation-style pose', () => {
		const { root, skeleton, bones } = makeRig();
		skinnedMesh(skeleton, root);

		const bindLocals = bones.map((b) => b.position.toArray().concat(b.quaternion.toArray()));

		// Pose it away from bind the way a mid-idle frame does: arms swung in,
		// asymmetrically, plus a hip weight shift.
		byName(bones, 'LeftArm').rotation.z = 0.7;
		byName(bones, 'RightArm').rotation.z = -0.45;
		byName(bones, 'Hips').position.x = 0.04;
		root.updateMatrixWorld(true);

		expect(poseSkeletonsToBind(root)).toBe(1);

		bones.forEach((b, i) => {
			const now = b.position.toArray().concat(b.quaternion.toArray());
			now.forEach((v, k) => expect(v).toBeCloseTo(bindLocals[i][k], 6));
		});
	});

	it('leaves the rig symmetric, unlike the frozen frame it replaces', () => {
		const { root, skeleton, bones } = makeRig();
		skinnedMesh(skeleton, root);
		const hips = byName(bones, 'Hips');
		const lh = byName(bones, 'LeftHand');
		const rh = byName(bones, 'RightHand');

		byName(bones, 'LeftArm').rotation.z = 0.7;
		byName(bones, 'RightArm').rotation.z = -0.45;
		root.updateMatrixWorld(true);
		const posedAsymmetry = Math.abs(dist(root, hips, lh) - dist(root, hips, rh));
		expect(posedAsymmetry).toBeGreaterThan(0.01);

		poseSkeletonsToBind(root);
		expect(Math.abs(dist(root, hips, lh) - dist(root, hips, rh))).toBeCloseTo(0, 6);
	});

	it('poses a shared skeleton once, not once per primitive', () => {
		const { root, skeleton } = makeRig();
		// The real base body carries body + eyes + teeth + tongue on one skeleton.
		skinnedMesh(skeleton, root);
		skinnedMesh(skeleton, root);
		skinnedMesh(skeleton, root);

		expect(poseSkeletonsToBind(root)).toBe(1);
	});

	it('is a no-op on a graph with no skinned meshes', () => {
		const root = new Object3D();
		root.add(new Object3D());
		expect(poseSkeletonsToBind(root)).toBe(0);
	});

	it('skips a skeleton whose inverse-bind count does not match its bones', () => {
		const { root, skeleton, bones } = makeRig();
		skinnedMesh(skeleton, root);
		skeleton.boneInverses.pop();

		const before = bones.map((b) => b.position.toArray());
		expect(poseSkeletonsToBind(root)).toBe(0);
		bones.forEach((b, i) => expect(b.position.toArray()).toEqual(before[i]));
	});

	it('tolerates a null root', () => {
		expect(poseSkeletonsToBind(null)).toBe(0);
	});
});

describe('captureBoneTransforms / restoreBoneTransforms', () => {
	it('round-trips the live pose so the scene survives an export', () => {
		const { root, skeleton, bones } = makeRig();
		skinnedMesh(skeleton, root);

		byName(bones, 'LeftArm').rotation.z = 0.7;
		byName(bones, 'Hips').position.x = 0.04;
		root.updateMatrixWorld(true);
		const posed = bones.map((b) => b.position.toArray().concat(b.quaternion.toArray()));

		const saved = captureBoneTransforms(root);
		expect(saved).toHaveLength(bones.length);

		poseSkeletonsToBind(root);
		expect(restoreBoneTransforms(saved, root)).toBe(bones.length);

		bones.forEach((b, i) => {
			const now = b.position.toArray().concat(b.quaternion.toArray());
			now.forEach((v, k) => expect(v).toBeCloseTo(posed[i][k], 6));
		});
	});

	it('tolerates empty and malformed input', () => {
		expect(captureBoneTransforms(null)).toEqual([]);
		expect(restoreBoneTransforms(null)).toBe(0);
		expect(restoreBoneTransforms([null])).toBe(1);
	});
});
