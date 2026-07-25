// Sign-rig — forward/inverse kinematics for the canonical skeleton, in plain JS.
//
// Signing is a spatial language: a sign is "flat hand, palm out, at the chin,
// moving down-forward" — a LOCATION and an ORIENTATION, never a list of joint
// angles. Authoring it as raw quaternions per bone is how the first pass of this
// feature ended up with the signing arm pointing behind the avatar: it assumed
// the reference rig aimed its bones down local +X from a T-pose, when cz.glb
// (like every Mixamo/Avaturn/VRM humanoid) aims them down local +Y through a
// shoulder whose own rest rotation is ~120° off identity.
//
// So this module reads the reference skeleton instead of assuming it. Everything
// below is derived at load time from the generated bind-pose data
// (src/animation-canonical-rest.js — rotations, positions, and parent chain of
// public/avatars/cz.glb):
//
//   • each bone's axis (the local direction that points at its child),
//   • each hand's palm normal and radial (thumb-side) direction,
//   • bone lengths, so a two-bone IK solver can put the wrist at a POINT.
//
// A `Pose` is a mutable FK container: set a bone's world orientation and it
// stores the local rotation that produces it, given whatever its parents are
// currently doing. `solveArm` places a wrist at a world-space target with a
// natural elbow, then orients the hand by (fingers direction, palm direction).
// The output is the same absolute-local-rotation form the clip library stores,
// so it retargets onto any rigged avatar through src/animation-retarget.js.
//
// Pure module: no three.js, no DOM — it runs in the browser, in Node, and in
// vitest identically.

import {
	CANONICAL_PARENT,
	CANONICAL_REST,
	CANONICAL_REST_POSITION,
	CANONICAL_REST_WORLD,
} from './animation-canonical-rest.js';

// ── vector + quaternion helpers ([x, y, z, w], matching three.js) ───────────

export const IDENTITY = Object.freeze([0, 0, 0, 1]);

export const v3 = (x, y, z) => [x, y, z];

export function vAdd(a, b) {
	return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function vSub(a, b) {
	return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function vScale(a, k) {
	return [a[0] * k, a[1] * k, a[2] * k];
}

export function vDot(a, b) {
	return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function vCross(a, b) {
	return [
		a[1] * b[2] - a[2] * b[1],
		a[2] * b[0] - a[0] * b[2],
		a[0] * b[1] - a[1] * b[0],
	];
}

export function vLen(a) {
	return Math.hypot(a[0], a[1], a[2]);
}

export function vNorm(a) {
	const n = vLen(a);
	return n < 1e-9 ? [0, 0, 0] : [a[0] / n, a[1] / n, a[2] / n];
}

export function vLerp(a, b, t) {
	return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Component of `a` perpendicular to unit vector `axis`. */
export function vReject(a, axis) {
	const d = vDot(a, axis);
	return [a[0] - axis[0] * d, a[1] - axis[1] * d, a[2] - axis[2] * d];
}

export function qMul(a, b) {
	const [ax, ay, az, aw] = a;
	const [bx, by, bz, bw] = b;
	return [
		aw * bx + ax * bw + ay * bz - az * by,
		aw * by - ax * bz + ay * bw + az * bx,
		aw * bz + ax * by - ay * bx + az * bw,
		aw * bw - ax * bx - ay * by - az * bz,
	];
}

export function qConj(q) {
	return [-q[0], -q[1], -q[2], q[3]];
}

export function qNorm(q) {
	const n = Math.hypot(q[0], q[1], q[2], q[3]);
	return n < 1e-9 ? [...IDENTITY] : [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

export function qAxisAngle(axis, deg) {
	const [x, y, z] = vNorm(axis);
	const half = (deg * Math.PI) / 360;
	const s = Math.sin(half);
	return [x * s, y * s, z * s, Math.cos(half)];
}

/** Rotate vector `v` by quaternion `q`. */
export function qRotate(q, v) {
	const [x, y, z, w] = q;
	// t = 2 * (q.xyz × v);  v' = v + w*t + q.xyz × t
	const tx = 2 * (y * v[2] - z * v[1]);
	const ty = 2 * (z * v[0] - x * v[2]);
	const tz = 2 * (x * v[1] - y * v[0]);
	return [
		v[0] + w * tx + y * tz - z * ty,
		v[1] + w * ty + z * tx - x * tz,
		v[2] + w * tz + x * ty - y * tx,
	];
}

/** Shortest rotation carrying unit vector `from` onto unit vector `to`. */
export function qBetween(from, to) {
	const f = vNorm(from);
	const t = vNorm(to);
	const d = vDot(f, t);
	if (d > 1 - 1e-9) return [...IDENTITY];
	if (d < -1 + 1e-9) {
		let axis = vCross(f, [1, 0, 0]);
		if (vLen(axis) < 1e-6) axis = vCross(f, [0, 1, 0]);
		const [x, y, z] = vNorm(axis);
		return [x, y, z, 0];
	}
	const axis = vCross(f, t);
	return qNorm([axis[0], axis[1], axis[2], 1 + d]);
}

export function qSlerp(a, b, t) {
	let [bx, by, bz, bw] = b;
	let cos = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
	if (cos < 0) {
		cos = -cos;
		bx = -bx;
		by = -by;
		bz = -bz;
		bw = -bw;
	}
	if (cos > 0.9995) return qNorm([
		a[0] + (bx - a[0]) * t,
		a[1] + (by - a[1]) * t,
		a[2] + (bz - a[2]) * t,
		a[3] + (bw - a[3]) * t,
	]);
	const theta = Math.acos(cos);
	const sin = Math.sin(theta);
	const wa = Math.sin((1 - t) * theta) / sin;
	const wb = Math.sin(t * theta) / sin;
	return qNorm([a[0] * wa + bx * wb, a[1] * wa + by * wb, a[2] * wa + bz * wb, a[3] * wa + bw * wb]);
}

// Quaternion from an orthonormal 3×3 basis given as its column vectors.
function qFromBasis(x, y, z) {
	const m00 = x[0], m10 = x[1], m20 = x[2];
	const m01 = y[0], m11 = y[1], m21 = y[2];
	const m02 = z[0], m12 = z[1], m22 = z[2];
	const trace = m00 + m11 + m22;
	if (trace > 0) {
		const s = 0.5 / Math.sqrt(trace + 1);
		return qNorm([(m21 - m12) * s, (m02 - m20) * s, (m10 - m01) * s, 0.25 / s]);
	}
	if (m00 > m11 && m00 > m22) {
		const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
		return qNorm([0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s]);
	}
	if (m11 > m22) {
		const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
		return qNorm([(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s]);
	}
	const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
	return qNorm([(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s]);
}

// Orthonormal basis from a primary direction and a secondary reference. The
// primary is preserved exactly; the reference only resolves the roll.
function basisFrom(primary, reference) {
	const a = vNorm(primary);
	let b = vReject(reference, a);
	if (vLen(b) < 1e-6) {
		// Reference parallel to the primary: pick any perpendicular so the frame
		// stays well-defined (the caller's roll is undefined anyway).
		b = vReject(Math.abs(a[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0], a);
	}
	b = vNorm(b);
	return [a, b, vCross(a, b)];
}

/**
 * The rotation that carries the local frame (`axisLocal`, `refLocal`) onto the
 * world frame (`axisWorld`, `refWorld`). `axisLocal → axisWorld` is exact; the
 * reference pair only fixes the twist about it.
 */
export function orientQuat(axisLocal, refLocal, axisWorld, refWorld) {
	const [la, lb, lc] = basisFrom(axisLocal, refLocal);
	const [wa, wb, wc] = basisFrom(axisWorld, refWorld);
	// Q = W · Lᵀ, expressed as two basis quaternions: Q = qW · qL⁻¹.
	const qL = qFromBasis(la, lb, lc);
	const qW = qFromBasis(wa, wb, wc);
	return qNorm(qMul(qW, qConj(qL)));
}

// ── the reference skeleton, read from the generated bind pose ───────────────

/** Nearest canonical ancestor of `bone`, or null at the root. */
export const parentOf = (bone) => CANONICAL_PARENT[bone] ?? null;

/** Local rest (bind) rotation of `bone` on the reference rig. */
export const restLocal = (bone) => CANONICAL_REST[bone] ?? [...IDENTITY];

/** World (model-space) rest rotation of `bone` on the reference rig. */
export const restWorld = (bone) => CANONICAL_REST_WORLD[bone] ?? [...IDENTITY];

/** World (model-space) rest position of `bone`, in metres. */
export const restPos = (bone) => CANONICAL_REST_POSITION[bone] ?? [0, 0, 0];

/** True when the reference rig carries this canonical bone. */
export const hasBone = (bone) => Object.hasOwn(CANONICAL_REST, bone);

const CHILDREN = (() => {
	const map = new Map();
	for (const [bone, parent] of Object.entries(CANONICAL_PARENT)) {
		if (!parent) continue;
		if (!map.has(parent)) map.set(parent, []);
		map.get(parent).push(bone);
	}
	return map;
})();

// Bones with several canonical children need the one that defines the segment's
// direction: the hand points down the middle finger, the hips up the spine.
const PREFERRED_CHILD = {
	Hips: 'Spine',
	LeftHand: 'LeftHandMiddle1',
	RightHand: 'RightHandMiddle1',
};

function segmentChild(bone) {
	if (PREFERRED_CHILD[bone] && hasBone(PREFERRED_CHILD[bone])) return PREFERRED_CHILD[bone];
	return (CHILDREN.get(bone) || [])[0] ?? null;
}

/** World direction `bone` points at rest (toward its child, or along its own segment for a tip). */
export function restDirWorld(bone) {
	const child = segmentChild(bone);
	if (child) return vNorm(vSub(restPos(child), restPos(bone)));
	const parent = parentOf(bone);
	if (parent) return vNorm(vSub(restPos(bone), restPos(parent)));
	return [0, 1, 0];
}

const _axisCache = new Map();

/**
 * The bone's own axis: the LOCAL direction that points at its child. ~[0,1,0]
 * on most canonical humanoid rigs, but measured rather than assumed.
 * @param {string} bone
 * @returns {number[]}
 */
export function boneAxis(bone) {
	if (!_axisCache.has(bone)) {
		_axisCache.set(bone, vNorm(qRotate(qConj(restWorld(bone)), restDirWorld(bone))));
	}
	return _axisCache.get(bone);
}

/** Length of the segment from `bone` to its next canonical joint, in metres. */
export function boneLength(bone) {
	const child = segmentChild(bone);
	return child ? vLen(vSub(restPos(child), restPos(bone))) : 0;
}

// Per-hand anatomy, measured from the bind pose rather than assumed:
//   radial — from the pinky knuckle toward the index knuckle, i.e. the thumb
//            side of the hand (forward, +Z, on this palms-down T-pose rig),
//   palm   — normal to the hand plane, flipped to the side the thumb tip sits
//            on, which is the palm side for any relaxed humanoid hand.
// Both are stored in WORLD terms; per-bone locals come from each bone's own
// rest rotation, so the finger joints inherit the frame without mirror hacks.
function handFrame(side) {
	const hand = `${side}Hand`;
	const axis = restDirWorld(hand);
	let radial = vNorm(vReject(vSub(restPos(`${side}HandIndex1`), restPos(`${side}HandPinky1`)), axis));
	if (vLen(radial) < 1e-6) radial = vNorm(vReject([0, 0, 1], axis));
	let palm = vNorm(vCross(radial, axis));
	const thumbTip = vSub(restPos(`${side}HandThumb3`), restPos(hand));
	if (vDot(palm, thumbTip) < 0) palm = vScale(palm, -1);
	return { axis, radial, palm };
}

const HAND_FRAME = { Left: handFrame('Left'), Right: handFrame('Right') };

/** World direction the `side` palm faces at rest (down, on this rig). */
export const restPalmWorld = (side) => HAND_FRAME[side].palm;

/** World direction from the pinky toward the thumb side of the `side` hand at rest. */
export const restRadialWorld = (side) => HAND_FRAME[side].radial;

const sideOf = (bone) => (bone.startsWith('Left') ? 'Left' : 'Right');

/** LOCAL direction in which `bone`'s palm side faces (hand + finger bones). */
export function palmAxis(bone) {
	return vNorm(qRotate(qConj(restWorld(bone)), HAND_FRAME[sideOf(bone)].palm));
}

/** LOCAL direction toward the thumb side of the hand (hand + finger bones). */
export function radialAxis(bone) {
	return vNorm(qRotate(qConj(restWorld(bone)), HAND_FRAME[sideOf(bone)].radial));
}

/**
 * LOCAL flexion axis of a finger/thumb joint: rotating about it by a POSITIVE
 * angle curls the bone toward the palm. Derived per bone, so it is correct on
 * both hands with no mirroring by hand.
 */
export function curlAxis(bone) {
	return vNorm(vCross(boneAxis(bone), palmAxis(bone)));
}

/**
 * LOCAL abduction axis of a finger joint: a POSITIVE angle splays the finger
 * toward the thumb side, a negative one toward the pinky.
 */
export function splayAxis(bone) {
	return vNorm(vCross(boneAxis(bone), radialAxis(bone)));
}

/**
 * LOCAL adduction axis of a thumb joint: a POSITIVE angle swings the thumb in
 * toward the fingers (across the palm), a negative one out away from them.
 */
export function adductAxis(bone) {
	const handDir = restDirWorld(`${sideOf(bone)}Hand`);
	return vNorm(vCross(boneAxis(bone), qRotate(qConj(restWorld(bone)), handDir)));
}

/** The five digits, and every finger bone of one hand in track order. */
export const FINGERS = Object.freeze(['Index', 'Middle', 'Ring', 'Pinky']);
export const FINGER_JOINTS = Object.freeze([1, 2, 3]);

export function fingerBones(side) {
	return [...FINGERS, 'Thumb'].flatMap((f) => FINGER_JOINTS.map((j) => `${side}Hand${f}${j}`));
}

// ── touchable parts of a hand ──────────────────────────────────────────────
//
// Signs are described by CONTACT ("two fingers stand on the flat palm", "the
// fingertips touch the forehead"), not by where the wrist happens to be. Solving
// that needs the geometry of the posed hand: where its fingertips are, where its
// palm faces. Reading it off the skeleton is what makes contact survive a
// different avatar — hand size and finger length change, and the contact still
// lands, where a hardcoded wrist position would drift off the palm.

// Skin sits outside the bone: contact points on a surface are offset off the
// bone plane by roughly half a hand's thickness so two hands meet instead of
// interpenetrating. Scaled from the rig's own hand length, not a magic number.
const SURFACE = 0.14; // fraction of hand length

/** Length past the last knuckle to the fingertip, estimated from the rig. */
function tipExtension(side, finger) {
	return boneLength(`${side}Hand${finger}2`) * 0.85;
}

/** World position of a fingertip under `pose` (past the final joint). */
export function fingerTip(pose, side, finger) {
	const distal = `${side}Hand${finger}3`;
	return vAdd(pose.worldPos(distal), vScale(pose.worldDir(distal), tipExtension(side, finger)));
}

const mean = (points) => vScale(points.reduce(vAdd, [0, 0, 0]), 1 / points.length);

/**
 * World position of a named part of a posed hand.
 *
 * `palm`/`back` are surface points, offset off the bone plane so a hand resting
 * on the palm sits ON it. `fingertips` is the pad of the index and middle
 * fingers, which is what most contacting signs actually use.
 *
 * @param {Pose} pose
 * @param {'Left'|'Right'} side
 * @param {'wrist'|'palm'|'back'|'fingertips'|'indextip'|'middletip'|'thumbtip'|'knuckles'|'fingers'|'edge'} part
 * @returns {number[]}
 */
export function handPoint(pose, side, part = 'fingertips') {
	const hand = `${side}Hand`;
	const q = pose.worldQuat(hand);
	const normal = vNorm(qRotate(q, palmAxis(hand)));
	const radial = vNorm(qRotate(q, radialAxis(hand)));
	const thickness = boneLength(hand) * SURFACE;
	const knuckles = () => FINGERS.map((f) => pose.worldPos(`${side}Hand${f}1`));
	switch (part) {
		case 'wrist':
			return pose.worldPos(hand);
		case 'palm':
			return vAdd(mean([pose.worldPos(hand), ...knuckles()]), vScale(normal, thickness));
		case 'back':
			return vAdd(mean([pose.worldPos(hand), ...knuckles()]), vScale(normal, -thickness));
		case 'knuckles':
			return vAdd(mean(knuckles()), vScale(normal, thickness));
		case 'fingers':
			return vAdd(
				mean([pose.worldPos(`${side}HandIndex2`), pose.worldPos(`${side}HandMiddle2`)]),
				vScale(normal, thickness),
			);
		case 'edge':
			return vAdd(pose.worldPos(`${side}HandPinky1`), vScale(radial, -thickness));
		case 'indextip':
			return fingerTip(pose, side, 'Index');
		case 'middletip':
			return fingerTip(pose, side, 'Middle');
		case 'thumbtip':
			return fingerTip(pose, side, 'Thumb');
		case 'fingertips':
			return mean([fingerTip(pose, side, 'Index'), fingerTip(pose, side, 'Middle')]);
		default:
			throw new Error(`unknown hand part "${part}"`);
	}
}

/**
 * The offset from the wrist to one of its own parts, expressed in the HAND's
 * local frame — so it depends only on the handshape, not on where the arm is.
 * That is what lets the solver work backwards: given where a fingertip must
 * END UP and which way the hand faces, this says where the wrist has to go.
 *
 * @param {Pose} pose  supplies this hand's finger rotations
 * @param {'Left'|'Right'} side
 * @param {string} part
 * @returns {number[]}
 */
export function handPartOffset(pose, side, part = 'fingertips') {
	// Measure on a scratch pose whose arm is at rest, so the answer is purely the
	// hand's own shape.
	const scratch = new Pose();
	for (const bone of fingerBones(side)) scratch.setLocal(bone, pose.getLocal(bone));
	const hand = `${side}Hand`;
	const point = handPoint(scratch, side, part);
	return qRotate(qConj(scratch.worldQuat(hand)), vSub(point, scratch.worldPos(hand)));
}

// Anchors ride a bone, so a turned head carries the chin with it. Anything not
// listed is fixed in model space.
const ANCHOR_BONE = {
	forehead: 'Head',
	nose: 'Head',
	chin: 'Head',
	mouth: 'Head',
	head: 'Head',
	neck: 'Neck',
	sternum: 'Spine2',
	chest: 'Spine2',
	belly: 'Spine1',
	shoulder: 'Spine2',
	hip: 'Hips',
};

/**
 * An anchor's position under a POSE rather than at rest: the rest point is
 * carried by whichever bone owns it, so a sign that touches the chin still
 * touches the chin when the head has turned.
 *
 * @param {Pose} pose
 * @param {string} name  ANCHORS key
 * @param {{ out?: number, up?: number, forward?: number, side?: 'Left'|'Right' }} [offset]
 * @returns {number[]}
 */
export function anchorPoint(pose, name, offset = {}) {
	const rest = signPoint(name, offset);
	const bone = ANCHOR_BONE[name];
	if (!bone || !hasBone(bone)) return rest;
	const local = qRotate(qConj(restWorld(bone)), vSub(rest, restPos(bone)));
	return vAdd(pose.worldPos(bone), qRotate(pose.worldQuat(bone), local));
}

// ── the signing body: anchors and workspace ────────────────────────────────

/**
 * Anatomical anchor points in model space, measured off the reference rig, so a
 * sign can be authored as "at the chin" or "centre chest" instead of as an
 * arbitrary XYZ. Signs are written against these and stay anatomically placed.
 */
export const ANCHORS = (() => {
	const head = restPos('Head');
	const neck = restPos('Neck');
	const chest = restPos('Spine2');
	const hips = restPos('Hips');
	const shoulderR = restPos('RightArm');
	const shoulderL = restPos('LeftArm');
	// At a palms-down rest the hand's radial (thumb) side points where the body
	// faces, so the rig gives us "forward" without a hardcoded axis.
	const forward = restRadialWorld('Right');
	const up = [0, 1, 0];
	const chinY = neck[1] + (head[1] - neck[1]) * 0.55;
	return Object.freeze({
		forward,
		up,
		/** Model-space width between the shoulders — the unit signs scale by. */
		shoulderSpan: vLen(vSub(shoulderL, shoulderR)),
		head,
		neck,
		chest,
		hips,
		/** Side-aware anchors: `signPoint('shoulder', { side })` picks the right one. */
		shoulder: { Left: shoulderL, Right: shoulderR },
		hip: {
			Left: [Math.abs(shoulderL[0]) * 0.55, hips[1], hips[2]],
			Right: [-Math.abs(shoulderR[0]) * 0.55, hips[1], hips[2]],
		},
		forehead: [0, head[1] + 0.07, head[2]],
		chin: [0, chinY, head[2] + 0.03],
		mouth: [0, chinY + 0.04, head[2] + 0.04],
		nose: [0, head[1] + 0.02, head[2] + 0.05],
		/**
		 * Upper chest, where most two-handed signs live. Measured up from the
		 * chest bone toward the neck rather than from the bone itself, which sits
		 * at mid-torso — anchoring signs there hangs them at belly height.
		 */
		sternum: [0, chest[1] + (neck[1] - chest[1]) * 0.6, chest[2] + 0.02],
		/** Mid torso — the low end of neutral signing space. */
		belly: [0, (chest[1] + hips[1]) / 2, chest[2]],
	});
})();

/**
 * A point in signing space: an anchor (or explicit point) plus an offset in
 * body-relative axes — out (toward the signer's dominant side), up, and forward
 * (toward the receiver). Offsets are in metres on the reference rig.
 *
 * @param {number[]|string} anchor  ANCHORS key or an explicit [x,y,z]
 * @param {{ out?: number, up?: number, forward?: number, side?: 'Left'|'Right' }} [offset]
 * @returns {number[]} model-space point
 */
export function signPoint(anchor, offset = {}) {
	const side = offset.side ?? 'Right';
	let base = Array.isArray(anchor) ? anchor : ANCHORS[anchor];
	// Side-aware anchors (shoulder, hip) resolve against the acting hand.
	if (base && !Array.isArray(base)) base = base[side];
	if (!base) throw new Error(`unknown sign anchor "${anchor}"`);
	const outSign = side === 'Right' ? -1 : 1; // the right hand's "out" is −X
	return [
		base[0] + outSign * (offset.out ?? 0),
		base[1] + (offset.up ?? 0),
		base[2] + (offset.forward ?? 0),
	];
}

// ── the pose container ─────────────────────────────────────────────────────

/**
 * A skeleton pose: per-bone LOCAL rotations (absolute, replacing the rest
 * rotation exactly like an AnimationClip track does), with forward kinematics
 * so a caller can ask where a bone ENDED UP and aim bones at world targets.
 */
export class Pose {
	/** @param {Pose|null} [from] copy-construct from another pose */
	constructor(from = null) {
		/** @type {Map<string, number[]>} */
		this.local = new Map(from ? from.local : []);
		this._worldQ = new Map();
		this._worldP = new Map();
	}

	clone() {
		return new Pose(this);
	}

	_invalidate() {
		this._worldQ.clear();
		this._worldP.clear();
	}

	/** Local rotation of `bone` — posed if set, otherwise the rig's rest. */
	getLocal(bone) {
		return this.local.get(bone) ?? restLocal(bone);
	}

	/** Set `bone`'s local rotation directly. */
	setLocal(bone, q) {
		this.local.set(bone, qNorm(q));
		this._invalidate();
		return this;
	}

	/** Rotate `bone` by `deg` about a LOCAL axis, on top of its current rotation. */
	rotateLocal(bone, axis, deg) {
		return this.setLocal(bone, qMul(this.getLocal(bone), qAxisAngle(axis, deg)));
	}

	/** World (model-space) rotation of `bone` under this pose. */
	worldQuat(bone) {
		let q = this._worldQ.get(bone);
		if (q) return q;
		const parent = parentOf(bone);
		q = parent ? qMul(this.worldQuat(parent), this.getLocal(bone)) : this.getLocal(bone);
		this._worldQ.set(bone, q);
		return q;
	}

	/** World (model-space) position of `bone` under this pose. */
	worldPos(bone) {
		let p = this._worldP.get(bone);
		if (p) return p;
		const parent = parentOf(bone);
		if (!parent) {
			p = restPos(bone);
		} else {
			// The bone's fixed offset from its parent, carried by the parent's
			// posed rotation — the rig's own bone lengths, never rescaled.
			const offsetLocal = qRotate(qConj(restWorld(parent)), vSub(restPos(bone), restPos(parent)));
			p = vAdd(this.worldPos(parent), qRotate(this.worldQuat(parent), offsetLocal));
		}
		this._worldP.set(bone, p);
		return p;
	}

	/** World direction `bone` points under this pose (toward its child). */
	worldDir(bone) {
		return vNorm(qRotate(this.worldQuat(bone), boneAxis(bone)));
	}

	/** Set `bone`'s WORLD rotation, storing the local that produces it here. */
	setWorldQuat(bone, qWorld) {
		const parent = parentOf(bone);
		const local = parent ? qMul(qConj(this.worldQuat(parent)), qWorld) : qWorld;
		return this.setLocal(bone, local);
	}

	/**
	 * Aim `bone` down `dirWorld`, using `refWorld` to resolve the twist about it.
	 * `refLocal` defaults to the bone's palm axis (hands/fingers) so callers can
	 * say "point the fingers here, face the palm there".
	 */
	aim(bone, dirWorld, refWorld = null, refLocal = null) {
		const axisLocal = boneAxis(bone);
		if (!refWorld) {
			// No roll requested: rotate the bone's current orientation the short way.
			const current = this.worldDir(bone);
			return this.setWorldQuat(bone, qMul(qBetween(current, dirWorld), this.worldQuat(bone)));
		}
		const rl = refLocal ?? palmAxis(bone);
		return this.setWorldQuat(bone, orientQuat(axisLocal, rl, dirWorld, refWorld));
	}

	/** Plain `{bone: [x,y,z,w]}` of every posed bone — the clip track payload. */
	locals() {
		return Object.fromEntries(this.local);
	}
}

// ── two-bone arm IK ────────────────────────────────────────────────────────

/**
 * Place a `side` wrist at a world-space point with a natural elbow, then orient
 * the hand.
 *
 * The elbow lands on the circle of valid solutions, pushed toward `pole` — a
 * world direction meaning "the elbow points that way". The default drops it
 * down, back, and slightly out, which is where a signer's elbow actually sits;
 * signs never lift the elbow to shoulder height unless the sign says so.
 *
 * Roll is anatomical, not arbitrary: the upper arm twists so the elbow flexes in
 * the plane the pole defines, and the forearm carries the pronation the palm
 * direction implies — so the wrist itself only ever holds the small residual,
 * which is what stops the "broken wrist" look.
 *
 * @param {Pose} pose        mutated in place
 * @param {'Left'|'Right'} side
 * @param {{
 *   wrist: number[],
 *   fingers?: number[],
 *   palm?: number[],
 *   pole?: number[],
 *   reach?: number,
 * }} spec  `wrist` is the world target for the wrist joint; `fingers`/`palm` are
 *   world directions for the hand; `reach` (0–1) caps how straight the arm may
 *   lock (0.98 default leaves a soft elbow).
 * @returns {Pose} the same pose
 */
export function solveArm(pose, side, spec) {
	const upper = `${side}Arm`;
	const lower = `${side}ForeArm`;
	const hand = `${side}Hand`;

	const shoulder = pose.worldPos(upper);
	const lu = boneLength(upper);
	const ll = boneLength(lower);
	const reach = spec.reach ?? 0.985;

	let toTarget = vSub(spec.wrist, shoulder);
	let dist = vLen(toTarget);
	const maxReach = (lu + ll) * reach;
	const minReach = Math.abs(lu - ll) + 1e-3;
	if (dist < 1e-6) {
		toTarget = [0, -1, 0];
		dist = minReach;
	}
	dist = Math.min(maxReach, Math.max(minReach, dist));
	const toDir = vNorm(toTarget);

	// Elbow direction: default down/back/outward from the shoulder.
	const outSign = side === 'Right' ? -1 : 1;
	const pole = spec.pole ?? [outSign * 0.42, -1, -0.30];
	let polePerp = vReject(pole, toDir);
	if (vLen(polePerp) < 1e-6) polePerp = vReject([0, -1, 0], toDir);
	polePerp = vNorm(polePerp);

	// Law of cosines: how far along the shoulder→target line the elbow sits.
	const cosShoulder = Math.min(1, Math.max(-1, (lu * lu + dist * dist - ll * ll) / (2 * lu * dist)));
	const sinShoulder = Math.sqrt(Math.max(0, 1 - cosShoulder * cosShoulder));
	const elbow = vAdd(shoulder, vAdd(vScale(toDir, lu * cosShoulder), vScale(polePerp, lu * sinShoulder)));

	const upperDir = vNorm(vSub(elbow, shoulder));
	const wristPoint = vAdd(shoulder, vScale(toDir, dist));
	const lowerDir = vNorm(vSub(wristPoint, elbow));

	// The direction the forearm swings toward as the elbow closes — the anterior
	// side of the arm. Falls back to the pole when the arm is nearly straight.
	let flexDir = vReject(lowerDir, upperDir);
	if (vLen(flexDir) < 1e-4) flexDir = vScale(polePerp, -1);
	flexDir = vNorm(flexDir);

	// On this rest pose (T-pose, palms down) elbow flexion carries the hand
	// toward the hand's radial side, so that rest direction is the upper arm's
	// flexion reference. Measured, not assumed.
	const radialWorld = restRadialWorld(side);
	const upperRefLocal = vNorm(qRotate(qConj(restWorld(upper)), radialWorld));
	pose.setWorldQuat(upper, orientQuat(boneAxis(upper), upperRefLocal, upperDir, flexDir));

	// The forearm carries pronation: aim its palm side where the hand's palm is
	// going, so the wrist holds only the residual.
	const palmTarget = spec.palm ? vNorm(spec.palm) : null;
	const lowerRefLocal = vNorm(qRotate(qConj(restWorld(lower)), restPalmWorld(side)));
	const lowerRefWorld = palmTarget ?? flexDir;
	pose.setWorldQuat(lower, orientQuat(boneAxis(lower), lowerRefLocal, lowerDir, lowerRefWorld));

	// Hand: fingers down `fingers`, palm facing `palm`. Default carries the
	// forearm's own direction through, i.e. a straight wrist.
	const fingersDir = spec.fingers ? vNorm(spec.fingers) : lowerDir;
	if (palmTarget) {
		pose.setWorldQuat(hand, orientQuat(boneAxis(hand), palmAxis(hand), fingersDir, palmTarget));
	} else {
		pose.aim(hand, fingersDir);
	}
	return pose;
}

/**
 * Where the wrist actually landed for a solved arm — the reachability check the
 * tests assert against, since IK clamps targets outside the arm's range.
 * @param {Pose} pose
 * @param {'Left'|'Right'} side
 * @returns {number[]}
 */
export function wristPosition(pose, side) {
	return pose.worldPos(`${side}Hand`);
}
