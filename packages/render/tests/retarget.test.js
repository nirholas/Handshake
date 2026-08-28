// Bone-name retargeting.
//
// Every avatar pipeline names humanoid bones differently, and the platform
// accepts models from all of them. These cases are the naming conventions the
// renderer has actually been handed: Mixamo, Ready Player Me, VRM/VRoid,
// Blender side suffixes, and the bare `shoulderL` rigs from older exporters.

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { normalizeBoneName, retargetClip } from '../src/retarget.js';

describe('normalizeBoneName', () => {
	it('collapses every convention onto one key', () => {
		const groups = [
			['leftforearm', ['mixamorig:LeftForeArm', 'LeftForeArm', 'mixamorig1:LeftForeArm', 'leftLowerArm', 'lLowerArm']],
			['leftarm', ['J_Bip_L_UpperArm', 'upper_arm.L', 'LeftUpperArm', 'arm_l']],
			['hips', ['mixamorig:Hips', 'Hips', 'Pelvis', 'hips']],
			['head', ['J_Bip_C_Head', 'Head', 'mixamorig:Head']],
			['rightfoot', ['RightFoot', 'foot.R', 'footR', 'R_Foot']],
			['leftshoulder', ['LeftShoulder', 'shoulderL', 'shoulder_l']],
		];
		for (const [expected, names] of groups) {
			for (const name of names) {
				expect(normalizeBoneName(name), name).toBe(expected);
			}
		}
	});

	it('does not mistake a word ending in L or R for a side marker', () => {
		expect(normalizeBoneName('Shoulder')).toBe('shoulder');
		expect(normalizeBoneName('Spine')).toBe('spine');
	});

	it('survives junk input', () => {
		expect(normalizeBoneName('')).toBe('');
		expect(normalizeBoneName(null)).toBe('');
		expect(normalizeBoneName(undefined)).toBe('');
	});
});

/** A minimal humanoid skeleton with the given bone names. */
function skeletonOf(names) {
	const bones = names.map((name) => {
		const bone = new THREE.Bone();
		bone.name = name;
		return bone;
	});
	bones[0].position.set(0, 1, 0);
	for (let i = 1; i < bones.length; i++) bones[i - 1].add(bones[i]);
	bones[0].updateMatrixWorld(true);
	return new THREE.Skeleton(bones);
}

function clipOf(names, { hipsTrack = true } = {}) {
	const tracks = names.map(
		(name) => new THREE.QuaternionKeyframeTrack(`${name}.quaternion`, [0, 1], [0, 0, 0, 1, 0, 0, 0, 1]),
	);
	if (hipsTrack) {
		tracks.unshift(new THREE.VectorKeyframeTrack('mixamorig:Hips.position', [0, 1], [0, 2, 0, 0, 2, 0]));
	}
	tracks.push(new THREE.VectorKeyframeTrack(`${names[0]}.scale`, [0, 1], [1, 1, 1, 1, 1, 1]));
	return new THREE.AnimationClip('walk', 1, tracks);
}

describe('retargetClip', () => {
	const targetNames = ['Hips', 'Spine', 'Neck', 'Head', 'LeftArm', 'RightArm', 'LeftUpLeg', 'RightUpLeg'];
	const sourceNames = [
		'mixamorig:Hips',
		'mixamorig:Spine',
		'mixamorig:Neck',
		'mixamorig:Head',
		'mixamorig:LeftArm',
		'mixamorig:RightArm',
		'mixamorig:LeftUpLeg',
		'mixamorig:RightUpLeg',
	];

	it('rebinds a Mixamo clip onto a Ready Player Me rig', () => {
		const skeleton = skeletonOf(targetNames);
		const out = retargetClip(clipOf(sourceNames), skeleton);
		expect(out).toBeTruthy();
		const names = out.tracks.map((t) => t.name);
		expect(names).toContain('LeftArm.quaternion');
		expect(names).toContain('Head.quaternion');
		// Scale tracks are authoring noise and never survive.
		expect(names.some((n) => n.endsWith('.scale'))).toBe(false);
	});

	it('rescales the root translation by the hip-height ratio', () => {
		const skeleton = skeletonOf(targetNames);
		const out = retargetClip(clipOf(sourceNames), skeleton);
		const hips = out.tracks.find((t) => t.name === 'Hips.position');
		expect(hips).toBeTruthy();
		// Source hips sit at y=2, target at y=1, so the track halves.
		expect(hips.values[1]).toBeCloseTo(1, 5);
	});

	it('refuses a clip from an unrelated rig instead of scrambling it', () => {
		const skeleton = skeletonOf(targetNames);
		const nonsense = clipOf(['Wheel', 'Axle', 'Chassis'], { hipsTrack: false });
		expect(retargetClip(nonsense, skeleton)).toBeNull();
	});

	it('keeps the clip name and duration', () => {
		const skeleton = skeletonOf(targetNames);
		const out = retargetClip(clipOf(sourceNames), skeleton);
		expect(out.name).toBe('walk');
		expect(out.duration).toBe(1);
	});
});
