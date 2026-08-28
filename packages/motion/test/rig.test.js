// The kinematics core, checked against the reference skeleton it is measured
// from. Every assertion here is an invariant a motion depends on: get any of
// them wrong and every clip the package emits is subtly broken in a way that
// only shows up as "the animation looks off" three layers downstream.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
	ANKLE_REST_HEIGHT,
	ARM_REACH,
	BODY_FORWARD,
	BODY_LEFT,
	BODY_UP,
	CANONICAL_BONES,
	LEG_LENGTH,
	SHOULDER_SPAN,
	STANDING_HIP_HEIGHT,
	boneLength,
	hasBone,
	parentOf,
	restPos,
} from '../src/rig/skeleton.js';
import { qAxisAngle, qMul, qRotate, vDot, vLen, vNorm, vSub } from '../src/rig/math.js';
import { restPose, blendPose } from '../src/rig/pose.js';
import {
	balanceError,
	centreOfMass,
	gazeDirection,
	shapeHand,
	solveArm,
	solveGaze,
	solveLeg,
	solveSpine,
	solveTurn,
} from '../src/rig/ik.js';
import { ANCHOR_NAMES, anchorPoint, bodyDirection } from '../src/rig/anchors.js';

const near = (a, b, tol, message) => assert.ok(Math.abs(a - b) <= tol, `${message ?? ''} expected ${a} within ${tol} of ${b}`);
const dist = (a, b) => vLen(vSub(a, b));

describe('the reference skeleton', () => {
	it('is a single connected tree rooted at the hips', () => {
		const roots = CANONICAL_BONES.filter((b) => parentOf(b) === null);
		assert.deepEqual(roots, ['Hips']);
		for (const bone of CANONICAL_BONES) {
			let node = bone;
			let hops = 0;
			while (parentOf(node)) {
				node = parentOf(node);
				assert.ok(++hops < 32, `${bone} does not reach the root`);
			}
			assert.equal(node, 'Hips');
		}
	});

	it('carries a full humanoid: spine, both arms, both legs, both hands', () => {
		for (const bone of ['Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head']) assert.ok(hasBone(bone), bone);
		for (const side of ['Left', 'Right']) {
			for (const part of ['Shoulder', 'Arm', 'ForeArm', 'Hand', 'UpLeg', 'Leg', 'Foot', 'ToeBase']) {
				assert.ok(hasBone(`${side}${part}`), `${side}${part}`);
			}
			for (const finger of ['Index', 'Middle', 'Ring', 'Pinky', 'Thumb']) {
				for (const joint of [1, 2, 3]) assert.ok(hasBone(`${side}Hand${finger}${joint}`));
			}
		}
	});

	it('is mirror-symmetric across the body midline', () => {
		for (const bone of CANONICAL_BONES) {
			if (!bone.startsWith('Left')) continue;
			const mirror = `Right${bone.slice(4)}`;
			assert.ok(hasBone(mirror), `${bone} has no mirror`);
			const left = restPos(bone);
			const right = restPos(mirror);
			near(vDot(left, BODY_LEFT), -vDot(right, BODY_LEFT), 0.002, `${bone} lateral`);
			near(left[1], right[1], 0.002, `${bone} height`);
		}
	});

	it('reads its own body frame off the rig rather than assuming an axis', () => {
		near(vLen(BODY_FORWARD), 1, 1e-9);
		near(vLen(BODY_LEFT), 1, 1e-9);
		near(vDot(BODY_FORWARD, BODY_LEFT), 0, 1e-6, 'forward and left are perpendicular');
		// The rig's LeftArm must be on the side the frame calls left, or every
		// motion the package emits is mirrored.
		assert.ok(vDot(restPos('LeftArm'), BODY_LEFT) > 0, 'LeftArm is on the left');
		assert.ok(vDot(restPos('RightArm'), BODY_LEFT) < 0, 'RightArm is on the right');
		// The toes must point the way the body faces.
		const toe = vSub(restPos('LeftToeBase'), restPos('LeftFoot'));
		assert.ok(vDot(toe, BODY_FORWARD) > 0, 'toes point forward');
	});

	it('has plausible human proportions', () => {
		near(STANDING_HIP_HEIGHT, 0.98, 0.15, 'hip height');
		near(SHOULDER_SPAN, 0.41, 0.1, 'shoulder span');
		assert.ok(ARM_REACH > 0.4 && ARM_REACH < 0.75, `arm reach ${ARM_REACH}`);
		assert.ok(LEG_LENGTH > 0.7 && LEG_LENGTH < 1.0, `leg length ${LEG_LENGTH}`);
		assert.ok(ANKLE_REST_HEIGHT > 0.02 && ANKLE_REST_HEIGHT < 0.2, `ankle height ${ANKLE_REST_HEIGHT}`);
		// The upper and lower segments of a limb are close to the same length,
		// which is what makes two-bone IK well-conditioned.
		near(boneLength('LeftArm') / boneLength('LeftForeArm'), 1, 0.35, 'arm segment ratio');
		near(boneLength('LeftUpLeg') / boneLength('LeftLeg'), 1, 0.35, 'leg segment ratio');
	});
});

describe('forward kinematics', () => {
	it('reproduces the bind pose exactly when nothing is posed', () => {
		const pose = restPose();
		for (const bone of CANONICAL_BONES) {
			near(dist(pose.worldPos(bone), restPos(bone)), 0, 1e-9, bone);
		}
	});

	it('carries every descendant when the root moves', () => {
		const pose = restPose();
		pose.setRootOffset([0.1, -0.25, 0.4]);
		for (const bone of CANONICAL_BONES) {
			const moved = vSub(pose.worldPos(bone), restPos(bone));
			near(moved[0], 0.1, 1e-9, bone);
			near(moved[1], -0.25, 1e-9, bone);
			near(moved[2], 0.4, 1e-9, bone);
		}
	});

	it('keeps bone lengths fixed under any rotation', () => {
		const pose = restPose();
		pose.setLocal('Spine1', qMul(pose.getLocal('Spine1'), qAxisAngle([1, 0, 0], 35)));
		pose.setLocal('LeftArm', qMul(pose.getLocal('LeftArm'), qAxisAngle([0, 0, 1], -55)));
		for (const bone of CANONICAL_BONES) {
			const parent = parentOf(bone);
			if (!parent) continue;
			near(
				dist(pose.worldPos(bone), pose.worldPos(parent)),
				dist(restPos(bone), restPos(parent)),
				1e-9,
				`${parent} to ${bone}`,
			);
		}
	});

	it('blends two poses without leaving the unit quaternion', () => {
		const a = restPose();
		const b = restPose();
		b.setLocal('Head', qAxisAngle([0, 1, 0], 60));
		b.setRootOffset([0, -0.2, 0]);
		for (const t of [0, 0.25, 0.5, 0.75, 1]) {
			const mid = blendPose(a, b, t);
			near(vLen([...mid.getLocal('Head')].slice(0, 3).concat(0)) ** 2 + mid.getLocal('Head')[3] ** 2, 1, 1e-9);
			near(mid.rootOffset[1], -0.2 * t, 1e-9);
		}
	});
});

describe('limb IK', () => {
	it('puts a wrist exactly on a reachable target', () => {
		const pose = restPose();
		for (const target of [[-0.15, 1.35, 0.3], [-0.3, 1.7, 0.1], [-0.2, 1.1, -0.15]]) {
			solveArm(pose, 'Right', { wrist: target });
			near(dist(pose.worldPos('RightHand'), target), 0, 1e-6, `target ${target}`);
		}
	});

	it('reproduces the rest leg when asked for the rest ankle', () => {
		const pose = restPose();
		for (const side of ['Left', 'Right']) {
			solveLeg(pose, side, { ankle: restPos(`${side}Foot`) });
			near(dist(pose.worldPos(`${side}Foot`), restPos(`${side}Foot`)), 0, 2e-3, `${side} ankle`);
			near(dist(pose.worldPos(`${side}ToeBase`), restPos(`${side}ToeBase`)), 0, 2e-3, `${side} toe`);
		}
	});

	it('keeps the feet planted while the hips drop, which is what a crouch is', () => {
		const pose = restPose();
		const ankles = { Left: restPos('LeftFoot'), Right: restPos('RightFoot') };
		pose.setRootOffset([0, -0.32, 0]);
		for (const side of ['Left', 'Right']) solveLeg(pose, side, { ankle: ankles[side] });
		for (const side of ['Left', 'Right']) {
			near(dist(pose.worldPos(`${side}Foot`), ankles[side]), 0, 1e-6, `${side} stayed planted`);
		}
		// The knee has to travel forward, or the leg folded the wrong way.
		const kneeTravel = vDot(vSub(pose.worldPos('LeftLeg'), restPos('LeftLeg')), BODY_FORWARD);
		assert.ok(kneeTravel > 0.05, `knee went forward by ${kneeTravel}`);
	});

	it('bends the elbow toward the pole it is given', () => {
		const target = [-0.2, 1.3, 0.28];
		const out = restPose();
		solveArm(out, 'Right', { wrist: target, pole: [-1, -0.2, -0.2] });
		const back = restPose();
		solveArm(back, 'Right', { wrist: target, pole: [0.2, -0.4, -1] });
		const elbowOut = vDot(out.worldPos('RightForeArm'), BODY_LEFT);
		const elbowBack = vDot(back.worldPos('RightForeArm'), BODY_LEFT);
		assert.ok(elbowOut < elbowBack, 'the outward pole puts the elbow further right');
	});

	it('clamps an unreachable target instead of stretching the arm', () => {
		const pose = restPose();
		solveArm(pose, 'Right', { wrist: [-3, 1.5, 3] });
		const reach = dist(pose.worldPos('RightHand'), pose.worldPos('RightArm'));
		assert.ok(reach <= ARM_REACH + 1e-6, `wrist stayed inside reach: ${reach}`);
	});

	it('lets the clavicle extend a long reach', () => {
		const far = [0.1, 0.55, 0.35];
		const assisted = restPose();
		solveArm(assisted, 'Left', { wrist: far });
		const bolted = restPose();
		solveArm(bolted, 'Left', { wrist: far, clavicle: false });
		assert.ok(
			dist(assisted.worldPos('LeftHand'), far) < dist(bolted.worldPos('LeftHand'), far),
			'the shoulder girdle got the hand closer',
		);
	});
});

describe('spine, gaze, and hands', () => {
	it('shares a lean along the chain instead of hinging at one joint', () => {
		const pose = restPose();
		solveSpine(pose, { lean: 40 });
		const moved = ['Hips', 'Spine', 'Spine1', 'Spine2']
			.filter((b) => pose.local.has(b))
			.map((b) => vDot(vSub(pose.worldPos(b === 'Hips' ? 'Spine' : b), restPos(b === 'Hips' ? 'Spine' : b)), BODY_FORWARD));
		assert.equal(moved.length, 4);
		// The chest travels further than the waist: a spine, not a hinge.
		assert.ok(vDot(vSub(pose.worldPos('Head'), restPos('Head')), BODY_FORWARD) > 0.2, 'the head went forward');
	});

	it('turns the whole body from the root, feet included', () => {
		const pose = restPose();
		solveTurn(pose, 90);
		const left = vSub(pose.worldPos('LeftFoot'), pose.worldPos('Hips'));
		// A quarter turn to the body's left swings the left foot toward where the
		// body was facing.
		assert.ok(vDot(vNorm(left), BODY_FORWARD) > 0.8, 'the stance turned with the body');
	});

	it('looks where it is told, and cannot look further than a neck allows', () => {
		const pose = restPose();
		solveGaze(pose, { yaw: 40 });
		assert.ok(vDot(gazeDirection(pose), BODY_LEFT) > 0.5, 'looked left');
		const level = restPose();
		solveGaze(level, { pitch: 30 });
		assert.ok(vDot(gazeDirection(level), BODY_UP) > 0.3, 'looked up');
	});

	it('curls a fist and leaves a pointing finger straight', () => {
		const fist = restPose();
		shapeHand(fist, 'Right', { curl: 1, thumb: 0.85 });
		const open = restPose();
		const tip = (pose) => dist(pose.worldPos('RightHandIndex3'), pose.worldPos('RightHand'));
		assert.ok(tip(fist) < tip(open) * 0.8, 'a fist brings the fingertip in');

		const pointing = restPose();
		shapeHand(pointing, 'Right', { curl: 0.9, thumb: 0.6 });
		shapeHand(pointing, 'Right', { curl: 0, thumb: 0.6, only: ['Index'] });
		assert.ok(tip(pointing) > tip(fist), 'the index came back out');
		assert.ok(
			dist(pointing.worldPos('RightHandPinky3'), pointing.worldPos('RightHand'))
			< dist(open.worldPos('RightHandPinky3'), open.worldPos('RightHand')) * 0.9,
			'the other fingers stayed curled',
		);
	});
});

describe('balance and anchors', () => {
	it('finds a centre of mass inside the body', () => {
		const com = centreOfMass(restPose());
		assert.ok(com[1] > 0.7 && com[1] < 1.3, `centre of mass at ${com[1]}m`);
		near(com[0], 0, 0.02, 'centred laterally');
	});

	it('calls a standing body balanced and a leaning one not', () => {
		assert.ok(balanceError(restPose()) < 0.02, 'standing is balanced');
		const leaning = restPose();
		solveSpine(leaning, { lean: 55 });
		assert.ok(balanceError(leaning) > 0.08, 'a deep unsupported lean is not');
	});

	it('places every anchor somewhere on the body', () => {
		const pose = restPose();
		for (const name of ANCHOR_NAMES) {
			for (const side of ['Left', 'Right']) {
				const point = anchorPoint(pose, name, { side });
				assert.ok(point.every(Number.isFinite), `${name} ${side} is finite`);
				assert.ok(point[1] >= -0.05 && point[1] <= 2.1, `${name} ${side} is at a plausible height`);
				assert.ok(Math.abs(vDot(point, BODY_LEFT)) < 0.8, `${name} ${side} is not off the side of the body`);
			}
		}
	});

	it('keeps every hand anchor inside the arm that has to reach it', () => {
		// The three exceptions are reach-down targets, used with a crouch or a
		// seat: a standing wrist genuinely cannot get to the floor.
		const groundLevel = new Set(['floor', 'knee', 'hips']);
		const pose = restPose();
		for (const name of ANCHOR_NAMES) {
			if (groundLevel.has(name)) continue;
			for (const side of ['Left', 'Right']) {
				const reach = dist(anchorPoint(pose, name, { side }), pose.worldPos(`${side}Arm`));
				assert.ok(reach <= ARM_REACH * 0.99, `${name} ${side} is ${reach.toFixed(3)}m away, reach is ${ARM_REACH.toFixed(3)}m`);
			}
		}
	});

	it('carries an anchor with the bone that owns it', () => {
		const still = restPose();
		const turned = restPose();
		solveGaze(turned, { yaw: 55 });
		const stillChin = anchorPoint(still, 'chin');
		const turnedChin = anchorPoint(turned, 'chin');
		assert.ok(dist(stillChin, turnedChin) > 0.03, 'the chin followed the head');
		// The hips did not move, so a hip anchor must not either.
		near(dist(anchorPoint(still, 'hip'), anchorPoint(turned, 'hip')), 0, 1e-9, 'the hip stayed put');
	});

	it('mirrors a body-relative direction per acting hand', () => {
		const pose = restPose();
		const leftOut = bodyDirection(pose, 'out', 'Left');
		const rightOut = bodyDirection(pose, 'out', 'Right');
		assert.ok(vDot(leftOut, rightOut) < -0.9, '"out" points opposite ways for the two hands');
		// An absolute direction does not mirror.
		near(vDot(bodyDirection(pose, 'up', 'Left'), bodyDirection(pose, 'up', 'Right')), 1, 1e-9);
	});
});
