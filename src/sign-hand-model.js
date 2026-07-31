// The reference hand: a handshape rendered as 21 landmark points, in the exact
// layout MediaPipe's hand landmarker returns.
//
// This is the hinge of the signing loop. `src/sign-handshapes.js` compiles a
// handshape (A, B, CLAW, FLAT_O ...) into local bone rotations, and the avatar
// wears them. Here we run those SAME rotations through the SAME canonical
// skeleton (`src/sign-rig.js`) and read the joint positions back out as a point
// cloud. The result is what a camera would see if a perfectly formed hand made
// that letter.
//
// One spec, three consumers:
//   1. the 3D avatar poses its fingers from it (sign-handshapes.js),
//   2. this file draws the target as a skeleton diagram (/sign-mirror),
//   3. the grader measures a webcam hand against it (sign-grader.js).
//
// Nothing here re-describes a letter. Change a curl in HANDSHAPES and the
// diagram and the grading target move with the avatar, automatically.

import { FINGERS, Pose, boneLength, fingerTip, vAdd, vScale, vSub } from './sign-rig.js';
import { applyHandshape } from './sign-handshapes.js';

/**
 * MediaPipe hand landmark order. Index into any 21-point hand array.
 * @see https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker
 */
export const HAND_LANDMARKS = Object.freeze({
	WRIST: 0,
	THUMB_CMC: 1,
	THUMB_MCP: 2,
	THUMB_IP: 3,
	THUMB_TIP: 4,
	INDEX_MCP: 5,
	INDEX_PIP: 6,
	INDEX_DIP: 7,
	INDEX_TIP: 8,
	MIDDLE_MCP: 9,
	MIDDLE_PIP: 10,
	MIDDLE_DIP: 11,
	MIDDLE_TIP: 12,
	RING_MCP: 13,
	RING_PIP: 14,
	RING_DIP: 15,
	RING_TIP: 16,
	PINKY_MCP: 17,
	PINKY_PIP: 18,
	PINKY_DIP: 19,
	PINKY_TIP: 20,
});

/** Every digit, in landmark order, with its four point indices. */
export const HAND_DIGITS = Object.freeze([
	{ name: 'Thumb', points: [1, 2, 3, 4] },
	{ name: 'Index', points: [5, 6, 7, 8] },
	{ name: 'Middle', points: [9, 10, 11, 12] },
	{ name: 'Ring', points: [13, 14, 15, 16] },
	{ name: 'Pinky', points: [17, 18, 19, 20] },
]);

/** Bone pairs for drawing a hand skeleton. */
export const HAND_CONNECTIONS = Object.freeze([
	[0, 1], [1, 2], [2, 3], [3, 4],
	[0, 5], [5, 6], [6, 7], [7, 8],
	[5, 9], [9, 10], [10, 11], [11, 12],
	[9, 13], [13, 14], [14, 15], [15, 16],
	[13, 17], [17, 18], [18, 19], [19, 20],
	[0, 17],
]);

// The rig's finger bones are the three phalanges; the knuckle a camera sees is
// where the proximal phalanx starts, and the tip is past the distal one.
const JOINT_BONES = (side, finger) => [1, 2, 3].map((j) => `${side}Hand${finger}${j}`);

/**
 * Where the metacarpal knuckle sits for a digit. The rig starts each finger at
 * its proximal joint, which IS the knuckle a landmarker reports, so this is a
 * direct read rather than an estimate.
 */
function knucklePoint(pose, side, finger) {
	return pose.worldPos(`${side}Hand${finger}1`);
}

/**
 * The 21 landmark positions of `name` as worn by the canonical rig.
 *
 * Returned in model space (metres, the rig's own scale). Every metric the
 * grader takes is an angle or a ratio, so no alignment with the camera frame is
 * needed or wanted: the point cloud is compared by shape, not by placement.
 *
 * @param {string} name  a HANDSHAPES key: 'A'-'Z', '0'-'9', 'CLAW', 'FLAT_O', ...
 * @param {'Left'|'Right'} [side]
 * @returns {number[][]} 21 `[x, y, z]` points in MediaPipe order
 */
export function handshapeLandmarks(name, side = 'Right') {
	const pose = new Pose();
	applyHandshape(pose, name, side);
	const wrist = pose.worldPos(`${side}Hand`);
	const points = [wrist];
	for (const { name: finger } of HAND_DIGITS) {
		const [b1, b2, b3] = JOINT_BONES(side, finger);
		points.push(knucklePoint(pose, side, finger), pose.worldPos(b2), pose.worldPos(b3), fingerTip(pose, side, finger));
		// b1 is read through knucklePoint; keeping the destructure explicit
		// documents which bone each landmark comes from.
		void b1;
	}
	return points;
}

/**
 * A finger's own length under a pose, used to normalise distances so a small
 * hand and a large one grade the same.
 */
export function handScale(points) {
	const wrist = points[HAND_LANDMARKS.WRIST];
	const mid = points[HAND_LANDMARKS.MIDDLE_MCP];
	const len = Math.hypot(mid[0] - wrist[0], mid[1] - wrist[1], (mid[2] ?? 0) - (wrist[2] ?? 0));
	return len > 1e-6 ? len : 1;
}

/**
 * Flatten a 3D hand onto a 2D box for drawing, keeping the aspect ratio and
 * viewing it palm-on. Used for the target diagram beside the camera preview.
 *
 * @param {number[][]} points  21 landmarks
 * @param {{ width?: number, height?: number, padding?: number, flip?: boolean }} [opts]
 * @returns {{ x: number, y: number }[]}
 */
export function projectHand(points, opts = {}) {
	const width = opts.width ?? 220;
	const height = opts.height ?? 260;
	const padding = opts.padding ?? 18;
	// The canonical rest hand points down the model's X axis with the palm on
	// the Y axis, so an XZ view looks straight into the palm.
	const flat = points.map((p) => [p[2] ?? 0, -p[0]]);
	let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
	for (const [x, y] of flat) {
		if (x < minX) minX = x;
		if (x > maxX) maxX = x;
		if (y < minY) minY = y;
		if (y > maxY) maxY = y;
	}
	const spanX = Math.max(maxX - minX, 1e-6);
	const spanY = Math.max(maxY - minY, 1e-6);
	const scale = Math.min((width - padding * 2) / spanX, (height - padding * 2) / spanY);
	const offX = (width - spanX * scale) / 2;
	const offY = (height - spanY * scale) / 2;
	return flat.map(([x, y]) => {
		const px = (x - minX) * scale + offX;
		return { x: opts.flip ? width - px : px, y: (y - minY) * scale + offY };
	});
}

/** Fingertip world positions of a posed handshape, for callers that only need those. */
export function handshapeFingertips(name, side = 'Right') {
	const pose = new Pose();
	applyHandshape(pose, name, side);
	return Object.fromEntries([...FINGERS, 'Thumb'].map((f) => [f, fingerTip(pose, side, f)]));
}

/** Midpoint of the palm under a handshape, in the same space as the landmarks. */
export function palmCentre(points) {
	const ids = [HAND_LANDMARKS.WRIST, HAND_LANDMARKS.INDEX_MCP, HAND_LANDMARKS.PINKY_MCP];
	return vScale(ids.map((i) => points[i]).reduce(vAdd, [0, 0, 0]), 1 / ids.length);
}

/** Length of the rig's middle proximal phalanx: the unit the diagram scales by. */
export const REFERENCE_BONE = (side = 'Right') => boneLength(`${side}HandMiddle1`);

/** Vector helper re-export so page code does not reach into the rig directly. */
export { vSub };
