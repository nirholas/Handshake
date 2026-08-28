// A skeleton pose: per-bone LOCAL rotations plus a root translation, with
// forward kinematics so a caller can ask where a bone ended up and aim bones at
// world targets.
//
// Local rotations are ABSOLUTE, replacing the bind rotation exactly the way an
// AnimationClip quaternion track does, which is what lets a solved pose be
// written straight into a clip with no further conversion.
//
// The root translation is the piece a signing rig never needed and a walking,
// crouching, sitting body cannot do without: the hips move in world space, and
// every descendant follows, so lowering the hips over planted feet bends the
// knees through the leg IK instead of sinking the mesh through the floor.

import {
	IDENTITY,
	orientQuat,
	qAxisAngle,
	qBetween,
	qConj,
	qMul,
	qNorm,
	qRotate,
	qSlerp,
	vAdd,
	vNorm,
	vSub,
} from './math.js';
import {
	boneAxis,
	palmAxis,
	parentOf,
	restLocal,
	restPos,
	restWorld,
} from './skeleton.js';

export class Pose {
	/** @param {Pose|null} [from] copy-construct from another pose */
	constructor(from = null) {
		/** @type {Map<string, number[]>} local rotation per posed bone */
		this.local = new Map(from ? from.local : []);
		/** @type {Map<string, number>} blendshape weights, 0-1 by name */
		this.face = new Map(from ? from.face : []);
		/** @type {number[]} world translation applied to the root bone, in metres */
		this.rootOffset = from ? [...from.rootOffset] : [0, 0, 0];
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

	/** Local rotation of `bone`: posed if set, otherwise the rig's rest. */
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

	/** Move the root (and therefore the whole body) to this world offset. */
	setRootOffset(offset) {
		this.rootOffset = [offset[0], offset[1], offset[2]];
		this._invalidate();
		return this;
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
			p = vAdd(restPos(bone), this.rootOffset);
		} else {
			// The bone's fixed offset from its parent, carried by the parent's posed
			// rotation. The rig's own bone lengths, never rescaled.
			const offsetLocal = qRotate(qConj(restWorld(parent)), vSub(restPos(bone), restPos(parent)));
			p = vAdd(this.worldPos(parent), qRotate(this.worldQuat(parent), offsetLocal));
		}
		this._worldP.set(bone, p);
		return p;
	}

	/** World direction `bone` points under this pose, toward its segment child. */
	worldDir(bone) {
		return vNorm(qRotate(this.worldQuat(bone), boneAxis(bone)));
	}

	/** Set `bone`'s WORLD rotation, storing the local that produces it. */
	setWorldQuat(bone, qWorld) {
		const parent = parentOf(bone);
		const local = parent ? qMul(qConj(this.worldQuat(parent)), qWorld) : qWorld;
		return this.setLocal(bone, local);
	}

	/**
	 * Aim `bone` down `dirWorld`. With no `refWorld` the bone takes the shortest
	 * path from where it is, which preserves whatever twist it already carries;
	 * with one, the reference resolves the roll about the aim.
	 */
	aim(bone, dirWorld, refWorld = null, refLocal = null) {
		if (!refWorld) {
			const current = this.worldDir(bone);
			return this.setWorldQuat(bone, qMul(qBetween(current, dirWorld), this.worldQuat(bone)));
		}
		return this.setWorldQuat(
			bone,
			orientQuat(boneAxis(bone), refLocal ?? palmAxis(bone), dirWorld, refWorld),
		);
	}

	/** Set blendshape weights by name, merged with whatever is already set. */
	setFace(weights) {
		for (const [shape, value] of Object.entries(weights ?? {})) {
			this.face.set(shape, Math.min(1, Math.max(0, value)));
		}
		return this;
	}

	/** Weight of one blendshape under this pose, 0 when unset. */
	getFace(shape) {
		return this.face.get(shape) ?? 0;
	}

	/** Plain `{bone: [x,y,z,w]}` of every posed bone: the clip track payload. */
	locals() {
		return Object.fromEntries(this.local);
	}

	/** True when nothing has been posed and the body is exactly at bind. */
	get isRest() {
		return this.local.size === 0 && this.face.size === 0
			&& this.rootOffset[0] === 0 && this.rootOffset[1] === 0 && this.rootOffset[2] === 0;
	}
}

/** A fresh pose at the rig's bind position: the neutral every beat starts from. */
export function restPose() {
	return new Pose();
}

/** Per-bone slerp, per-shape lerp, and root lerp between two poses. */
export function blendPose(a, b, t) {
	const out = new Pose(a);
	const bones = new Set([...a.local.keys(), ...b.local.keys()]);
	for (const bone of bones) out.setLocal(bone, qSlerp(a.getLocal(bone), b.getLocal(bone), t));
	const shapes = new Set([...a.face.keys(), ...b.face.keys()]);
	for (const shape of shapes) {
		out.face.set(shape, a.getFace(shape) + (b.getFace(shape) - a.getFace(shape)) * t);
	}
	out.setRootOffset([
		a.rootOffset[0] + (b.rootOffset[0] - a.rootOffset[0]) * t,
		a.rootOffset[1] + (b.rootOffset[1] - a.rootOffset[1]) * t,
		a.rootOffset[2] + (b.rootOffset[2] - a.rootOffset[2]) * t,
	]);
	return out;
}

export { IDENTITY };
