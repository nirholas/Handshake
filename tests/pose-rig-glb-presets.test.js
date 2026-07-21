/**
 * Preset application across rig backends (src/pose-rig.js).
 *
 * The pose presets are authored as mannequin-local Euler rotations where rest
 * is identity (arms at the sides). Applying those raw local quaternions to a
 * loaded GLB avatar REPLACED each bone's bind rotation and garbled every
 * preset (arms-up read as a T-pose, salute pointed sideways, hands-on-hips
 * threw the arms in the air). The fix expresses a preset as world-frame
 * rotation deltas composed down the mannequin hierarchy and replays them on
 * top of the target rig's captured rest pose — the same world-delta
 * convention animation-retarget.js uses for clips.
 *
 * These tests pin:
 *   1. Mannequin equivalence — the world-delta path reproduces the preset's
 *      local Eulers exactly on the mannequin (identity rest), for every preset.
 *   2. GLB correctness — on a rig with non-identity bind rotations, each posed
 *      bone's world rotation is delta · restWorld (bind preserved, not wiped).
 *   3. FK slider semantics on GLB — an untouched bone reads 0°/0°/0° (not its
 *      raw bind angles) and zeroing a bone restores rest instead of erasing it.
 *   4. localTargetsForPose — returns targets for exactly the posed bones and
 *      leaves the rig's live transforms untouched (agent-screen tween path).
 */

import { Bone, Euler, Group, Object3D, Quaternion, Vector3 } from 'three';
import { describe, it, expect } from 'vitest';
import { MannequinRig, makeGltfRig, poseFromMannequinPreset } from '../src/pose-rig.js';
import { PRESETS, getPresetById } from '../src/pose-presets.js';

const MANNEQUIN_TO_CANONICAL = {
	pelvis: 'Hips', spine: 'Spine', chest: 'Spine2', neck: 'Neck', head: 'Head',
	shoulderL: 'LeftArm', elbowL: 'LeftForeArm', wristL: 'LeftHand',
	shoulderR: 'RightArm', elbowR: 'RightForeArm', wristR: 'RightHand',
	hipL: 'LeftUpLeg', kneeL: 'LeftLeg', ankleL: 'LeftFoot',
	hipR: 'RightUpLeg', kneeR: 'RightLeg', ankleR: 'RightFoot',
};

function quatFromEuler(rot) {
	return new Quaternion().setFromEuler(new Euler(rot.x || 0, rot.y || 0, rot.z || 0, 'XYZ'));
}

// A miniature humanoid GLB scene whose bones carry non-identity bind
// rotations, like a real exported avatar (a Mixamo-style rig binds the right
// shoulder near 94° pitch / 90° roll — the values the studio's sliders showed
// raw before the fix).
function makeBoundScene() {
	const scene = new Group();
	const mk = (name, rot, parent) => {
		const b = new Bone();
		b.name = name;
		b.quaternion.setFromEuler(new Euler(rot.x || 0, rot.y || 0, rot.z || 0, 'XYZ'));
		b.position.set(0, 0.2, 0);
		parent.add(b);
		return b;
	};
	const armature = new Object3D();
	armature.name = 'Armature';
	armature.quaternion.setFromEuler(new Euler(Math.PI / 2, 0, 0)); // FBX-style +90°X
	scene.add(armature);
	const hips = mk('Hips', { x: -Math.PI / 2 }, armature);
	const spine = mk('Spine', { x: 0.05 }, hips);
	const spine2 = mk('Spine2', { x: -0.05 }, spine);
	const rShoulder = mk('RightShoulder', { x: 1.64, z: 1.57 }, spine2);
	const rArm = mk('RightArm', { z: -0.3 }, rShoulder);
	const rForeArm = mk('RightForeArm', { z: -0.1 }, rArm);
	mk('RightHand', {}, rForeArm);
	const lShoulder = mk('LeftShoulder', { x: 1.64, z: -1.57 }, spine2);
	const lArm = mk('LeftArm', { z: 0.3 }, lShoulder);
	const lForeArm = mk('LeftForeArm', { z: 0.1 }, lArm);
	mk('LeftHand', {}, lForeArm);
	return scene;
}

function worldQuat(node) {
	node.updateWorldMatrix(true, false);
	return node.getWorldQuaternion(new Quaternion());
}

// A positional T-pose rig: arms extend along ±X (like a Mixamo bind), legs
// straight down, spine up. Presets are authored against an arms-at-sides
// stance, so this rig exercises the reference-stance alignment: a preset that
// keeps the arms down must bring a T-bound arm DOWN, not leave it horizontal.
function makeTPoseScene() {
	const scene = new Group();
	const mk = (name, pos, parent) => {
		const b = new Bone();
		b.name = name;
		b.position.set(...pos);
		parent.add(b);
		return b;
	};
	const hips = mk('Hips', [0, 1, 0], scene);
	const spine = mk('Spine', [0, 0.15, 0], hips);
	const spine2 = mk('Spine2', [0, 0.25, 0], spine);
	const neck = mk('Neck', [0, 0.15, 0], spine2);
	mk('Head', [0, 0.12, 0], neck);
	for (const [side, sign] of [['Left', 1], ['Right', -1]]) {
		const sh = mk(`${side}Shoulder`, [sign * 0.08, 0.12, 0], spine2);
		const arm = mk(`${side}Arm`, [sign * 0.12, 0, 0], sh);
		const fore = mk(`${side}ForeArm`, [sign * 0.28, 0, 0], arm);
		mk(`${side}Hand`, [sign * 0.26, 0, 0], fore);
		const up = mk(`${side}UpLeg`, [sign * 0.1, -0.05, 0], hips);
		const leg = mk(`${side}Leg`, [0, -0.45, 0], up);
		const foot = mk(`${side}Foot`, [0, -0.45, 0], leg);
		mk(`${side}ToeBase`, [0, -0.06, 0.14], foot);
	}
	return scene;
}

// World-space direction from a bone to its child bone (the limb direction).
function limbDir(rig, from, to) {
	rig.root.updateMatrixWorld(true);
	const a = rig.getNode(from).getWorldPosition(new Vector3());
	const b = rig.getNode(to).getWorldPosition(new Vector3());
	return b.sub(a).normalize();
}

describe('poseFromMannequinPreset world deltas', () => {
	it('emits a world delta for every posed joint, composed down the chain', () => {
		const pose = poseFromMannequinPreset(getPresetById('hands-up').pose);
		expect(pose.worldDeltas.RightArm).toBeDefined();
		expect(pose.worldDeltas.RightForeArm).toBeDefined();
		// Forearm delta = shoulder delta · elbow local.
		const s = new Quaternion(...pose.worldDeltas.RightArm);
		const e = quatFromEuler({ x: -0.10 });
		const expected = s.clone().multiply(e);
		const got = new Quaternion(...pose.worldDeltas.RightForeArm);
		expect(got.angleTo(expected)).toBeLessThan(1e-6);
	});
});

describe('presets on the mannequin (regression)', () => {
	it('the world-delta path reproduces every preset joint local exactly', () => {
		const rig = new MannequinRig();
		for (const preset of PRESETS) {
			rig.applyPose(poseFromMannequinPreset(preset.pose));
			for (const [joint, rot] of Object.entries(preset.pose)) {
				if (joint === 'rootPosition') continue;
				const canonical = MANNEQUIN_TO_CANONICAL[joint];
				const node = rig.getNode(canonical);
				expect(node, `${preset.id}.${joint}`).toBeTruthy();
				const angle = node.quaternion.angleTo(quatFromEuler(rot));
				expect(angle, `${preset.id}.${joint}`).toBeLessThan(1e-6);
			}
		}
	});
});

describe('presets on a T-pose-bound GLB rig (reference-stance alignment)', () => {
	it('T-pose preset keeps a T-bound arm horizontal', () => {
		const rig = makeGltfRig(makeTPoseScene());
		expect(rig).toBeTruthy();
		rig.applyPose(poseFromMannequinPreset(getPresetById('tpose').pose));
		const dir = limbDir(rig, 'RightArm', 'RightForeArm');
		expect(dir.dot(new Vector3(-1, 0, 0))).toBeGreaterThan(0.99);
	});

	it('arms-up preset raises a T-bound arm near vertical', () => {
		const rig = makeGltfRig(makeTPoseScene());
		rig.applyPose(poseFromMannequinPreset(getPresetById('hands-up').pose));
		for (const side of ['Left', 'Right']) {
			const dir = limbDir(rig, `${side}Arm`, `${side}ForeArm`);
			// z = ±PI·0.92 from hanging ⇒ 14.4° short of straight up, tilted out.
			expect(dir.y, side).toBeGreaterThan(0.9);
		}
	});

	it('salute preset drops the non-saluting arm to the side (not left at T)', () => {
		const rig = makeGltfRig(makeTPoseScene());
		rig.applyPose(poseFromMannequinPreset(getPresetById('salute').pose));
		const dir = limbDir(rig, 'LeftArm', 'LeftForeArm');
		// shoulderL z = 0.09 ⇒ hanging nearly straight down.
		expect(dir.y).toBeLessThan(-0.95);
	});

	it('relaxed stand brings both T-bound arms down with a soft elbow bend', () => {
		const rig = makeGltfRig(makeTPoseScene());
		rig.applyPose(poseFromMannequinPreset(getPresetById('relaxed').pose));
		for (const side of ['Left', 'Right']) {
			expect(limbDir(rig, `${side}Arm`, `${side}ForeArm`).y, side).toBeLessThan(-0.9);
			expect(limbDir(rig, `${side}ForeArm`, `${side}Hand`).y, side).toBeLessThan(-0.85);
		}
	});

	it('legs already bound straight stay put under standing presets', () => {
		const rig = makeGltfRig(makeTPoseScene());
		rig.applyPose(poseFromMannequinPreset(getPresetById('hands-up').pose));
		expect(limbDir(rig, 'LeftUpLeg', 'LeftLeg').y).toBeLessThan(-0.99);
	});

	it('resetPose restores the bind pose after a preset (no skinned mesh needed)', () => {
		const rig = makeGltfRig(makeBoundScene());
		const bind = {};
		for (const { key, node } of rig.getBones()) bind[key] = node.quaternion.clone();
		rig.applyPose(poseFromMannequinPreset(getPresetById('salute').pose));
		rig.resetPose();
		for (const { key, node } of rig.getBones()) {
			expect(node.quaternion.angleTo(bind[key]), key).toBeLessThan(1e-6);
		}
	});

	it('applying one preset after another never compounds (applyPose resets first)', () => {
		const rig = makeGltfRig(makeBoundScene());
		rig.applyPose(poseFromMannequinPreset(getPresetById('hands-on-hips').pose));
		const once = worldQuat(rig.getNode('RightArm'));
		rig.applyPose(poseFromMannequinPreset(getPresetById('salute').pose));
		rig.applyPose(poseFromMannequinPreset(getPresetById('hands-on-hips').pose));
		expect(worldQuat(rig.getNode('RightArm')).angleTo(once)).toBeLessThan(1e-6);
	});
});

describe('GLB FK slider semantics (delta from rest)', () => {
	it('an untouched bone reads 0/0/0 even with a large bind rotation', () => {
		const rig = makeGltfRig(makeBoundScene());
		const e = rig.getBoneEuler('RightShoulder');
		expect(Math.abs(e.x)).toBeLessThan(1e-6);
		expect(Math.abs(e.y)).toBeLessThan(1e-6);
		expect(Math.abs(e.z)).toBeLessThan(1e-6);
	});

	it('setBoneEuler(0,0,0) restores rest instead of erasing the bind rotation', () => {
		const rig = makeGltfRig(makeBoundScene());
		const node = rig.getNode('RightArm');
		const bind = node.quaternion.clone();
		rig.setBoneEuler('RightArm', { x: 0.5, y: -0.2, z: 0.8 });
		expect(node.quaternion.angleTo(bind)).toBeGreaterThan(0.1);
		rig.setBoneEuler('RightArm', { x: 0, y: 0, z: 0 });
		expect(node.quaternion.angleTo(bind)).toBeLessThan(1e-6);
	});

	it('get/setBoneEuler round-trip through the world-delta frame', () => {
		const rig = makeGltfRig(makeBoundScene());
		rig.setBoneEuler('LeftForeArm', { x: -1.2, y: 0.3, z: 0.1 });
		const e = rig.getBoneEuler('LeftForeArm');
		expect(e.x).toBeCloseTo(-1.2, 5);
		expect(e.y).toBeCloseTo(0.3, 5);
		expect(e.z).toBeCloseTo(0.1, 5);
	});
});

describe('localTargetsForPose', () => {
	it('returns targets only for posed bones and leaves the rig unposed', () => {
		const rig = makeGltfRig(makeBoundScene());
		const before = {};
		for (const { key, node } of rig.getBones()) before[key] = node.quaternion.clone();
		const pose = poseFromMannequinPreset(getPresetById('wave').pose);
		const targets = rig.localTargetsForPose(pose);
		// wave poses LeftArm, RightArm, RightForeArm, RightHand and Head; this
		// test rig has no Head bone, so it must be skipped, not invented.
		expect(new Set(targets.keys())).toEqual(
			new Set(['LeftArm', 'RightArm', 'RightForeArm', 'RightHand']),
		);
		for (const { key, node } of rig.getBones()) {
			expect(node.quaternion.angleTo(before[key]), key).toBeLessThan(1e-6);
		}
		// And the targets match what applyPose would produce.
		rig.applyPose(pose);
		for (const [key, to] of targets) {
			expect(rig.getNode(key).quaternion.angleTo(to), key).toBeLessThan(1e-6);
		}
	});
});
