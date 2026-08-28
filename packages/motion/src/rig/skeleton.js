// The reference skeleton, read out of the measured bind pose.
//
// Everything above this file works in anatomy ("the wrist goes at the chin",
// "the hips drop to 60% of standing height"). Everything below it works in bone
// names and quaternions. This module is the translation: it knows which bone
// carries which, how long each segment is, and which way each one points when
// the body is at rest, all measured from the data rather than assumed, so the
// same code survives a re-measured rig.

import {
	CANONICAL_PARENT,
	CANONICAL_REST,
	CANONICAL_REST_POSITION,
	CANONICAL_REST_WORLD,
} from './skeleton-data.js';
import { IDENTITY, qConj, qRotate, vCross, vLen, vNorm, vReject, vScale, vSub } from './math.js';

export { CANONICAL_PARENT, CANONICAL_REST, CANONICAL_REST_POSITION, CANONICAL_REST_WORLD };

/** Nearest canonical ancestor of `bone`, or null at the root. */
export const parentOf = (bone) => CANONICAL_PARENT[bone] ?? null;

/** Local rest (bind) rotation of `bone`. */
export const restLocal = (bone) => CANONICAL_REST[bone] ?? [...IDENTITY];

/** World (model-space) rest rotation of `bone`. */
export const restWorld = (bone) => CANONICAL_REST_WORLD[bone] ?? [...IDENTITY];

/** World (model-space) rest position of `bone`, in metres. */
export const restPos = (bone) => CANONICAL_REST_POSITION[bone] ?? [0, 0, 0];

/** True when the reference rig carries this canonical bone. */
export const hasBone = (bone) => Object.hasOwn(CANONICAL_REST, bone);

/** Every canonical bone name, sorted, for callers that need the full set. */
export const CANONICAL_BONES = Object.freeze(Object.keys(CANONICAL_REST).sort());

/** The root of the skeleton: the one bone with no canonical parent. */
export const ROOT_BONE = CANONICAL_BONES.find((b) => parentOf(b) === null) ?? 'Hips';

const CHILDREN = (() => {
	const map = new Map();
	for (const [bone, parent] of Object.entries(CANONICAL_PARENT)) {
		if (!parent) continue;
		if (!map.has(parent)) map.set(parent, []);
		map.get(parent).push(bone);
	}
	for (const list of map.values()) list.sort();
	return map;
})();

/** Canonical children of `bone`, sorted, empty at a tip. */
export const childrenOf = (bone) => CHILDREN.get(bone) ?? [];

// A bone with several children needs the one that defines its segment: the hand
// points down the middle finger, the hips up the spine, the foot at the toe.
const PREFERRED_CHILD = {
	Hips: 'Spine',
	LeftHand: 'LeftHandMiddle1',
	RightHand: 'RightHandMiddle1',
	LeftFoot: 'LeftToeBase',
	RightFoot: 'RightToeBase',
};

function segmentChild(bone) {
	if (PREFERRED_CHILD[bone] && hasBone(PREFERRED_CHILD[bone])) return PREFERRED_CHILD[bone];
	return childrenOf(bone)[0] ?? null;
}

/** World direction `bone` points at rest: toward its segment child. */
export function restDirWorld(bone) {
	const child = segmentChild(bone);
	if (child) return vNorm(vSub(restPos(child), restPos(bone)));
	const parent = parentOf(bone);
	if (parent) return vNorm(vSub(restPos(bone), restPos(parent)));
	return [0, 1, 0];
}

const _axisCache = new Map();

/**
 * The bone's own axis: the LOCAL direction pointing at its child. Close to
 * [0,1,0] on most humanoid rigs, but measured rather than assumed, because the
 * hand and foot chains on a real rig are not.
 */
export function boneAxis(bone) {
	let axis = _axisCache.get(bone);
	if (!axis) {
		axis = vNorm(qRotate(qConj(restWorld(bone)), restDirWorld(bone)));
		_axisCache.set(bone, axis);
	}
	return axis;
}

const _lengthCache = new Map();

/** Length of `bone`'s segment in metres: the distance to its segment child. */
export function boneLength(bone) {
	let len = _lengthCache.get(bone);
	if (len === undefined) {
		const child = segmentChild(bone);
		len = child ? vLen(vSub(restPos(child), restPos(bone))) : 0;
		_lengthCache.set(bone, len);
	}
	return len;
}

// ── body frame ─────────────────────────────────────────────────────────────

// At the measured rest pose the arms are out to the sides with the palms facing
// down, so the palm normal is the hand frame's axis that points at the floor,
// and the thumb side is what remains. Both are recovered from the finger bones
// rather than hardcoded, and the downward test picks the sign, so a rig
// measured facing the other way still resolves correctly.
const HAND_FRAME = (() => {
	const frame = {};
	for (const side of ['Left', 'Right']) {
		const hand = `${side}Hand`;
		const index = `${side}HandIndex1`;
		const pinky = `${side}HandPinky1`;
		const fingers = restDirWorld(hand);
		const across = hasBone(index) && hasBone(pinky)
			? vNorm(vSub(restPos(index), restPos(pinky)))
			: [0, 0, 1];
		let palm = vNorm(vCross(fingers, across));
		if (palm[1] > 0) palm = vScale(palm, -1);
		// The thumb sits on the index side of both hands, so the measured
		// index-to-pinky vector IS the thumb side once it is squared up against the
		// other two axes. Taking it from the data rather than from a cross product
		// keeps the frame correct on both hands without a handedness special case,
		// which is exactly where a sign error hides.
		const radial = vNorm(vReject(vReject(across, fingers), palm));
		frame[side] = { palm, radial, fingers };
	}
	return Object.freeze(frame);
})();

/** World palm normal of the `side` hand at rest. */
export const restPalmWorld = (side) => HAND_FRAME[side].palm;

/** World thumb-side direction of the `side` hand at rest. */
export const restRadialWorld = (side) => HAND_FRAME[side].radial;

const sideOf = (bone) => (bone.startsWith('Left') ? 'Left' : 'Right');

/** LOCAL palm normal of a hand or finger bone. */
export function palmAxis(bone) {
	const side = sideOf(bone);
	return vNorm(qRotate(qConj(restWorld(bone)), restPalmWorld(side)));
}

/** LOCAL thumb-side direction of a hand or finger bone. */
export function radialAxis(bone) {
	const side = sideOf(bone);
	return vNorm(qRotate(qConj(restWorld(bone)), restRadialWorld(side)));
}

/**
 * The body's own forward direction in model space: where the chest faces when
 * the skeleton is at rest. Read from the hand frame, so a rig measured facing
 * the other way still resolves correctly.
 */
export const BODY_FORWARD = Object.freeze(vNorm(restRadialWorld('Right')));

/** Model-space up. The rig is measured Y-up; stated once so nothing assumes it. */
export const BODY_UP = Object.freeze([0, 1, 0]);

/**
 * Model-space left. Asserted against the rig rather than assumed: LeftArm sits
 * on the +X side of the reference skeleton, and the opposite cross order would
 * silently name that side "right" and mirror every motion.
 */
export const BODY_LEFT = Object.freeze(vNorm(vCross(BODY_UP, BODY_FORWARD)));

/** Standing hip height in metres: the unit every vertical offset scales by. */
export const STANDING_HIP_HEIGHT = restPos('Hips')[1];

/** Shoulder-to-shoulder width in metres: the unit lateral offsets scale by. */
export const SHOULDER_SPAN = vLen(vSub(restPos('LeftArm'), restPos('RightArm')));

/** The floor, in model space. Every planted foot is placed relative to it. */
export const GROUND_Y = 0;

/**
 * Ankle height above the floor when the foot is flat, in metres. A planted foot
 * targets the ankle here rather than targeting the floor itself, which is what
 * keeps the sole on the ground instead of driving it through.
 */
export const ANKLE_REST_HEIGHT = restPos('LeftFoot')[1] - GROUND_Y;

/** Half the resting distance between the feet: the neutral stance width. */
export const STANCE_HALF_WIDTH = Math.abs(restPos('LeftFoot')[0]);

/** Full arm reach in metres, shoulder to wrist. */
export const ARM_REACH = boneLength('RightArm') + boneLength('RightForeArm');

/** Full leg length in metres, hip to ankle. */
export const LEG_LENGTH = boneLength('RightUpLeg') + boneLength('RightLeg');
