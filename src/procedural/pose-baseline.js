// Baseline recovery for post-animation layers.
//
// A procedural layer adds an offset to a bone the mixer just posed. When a
// clip tracks that bone, the mixer rewrites it every frame and the offset can
// simply be re-added. But when nothing rewrites the bone (no clip playing, or
// a clip that doesn't track this joint), re-adding would compound frame over
// frame and spin the joint. These baselines make a layer idempotent: before
// computing, compare the bone's current value against what the layer wrote
// last frame. Identical means nobody else touched it, so restore the
// pre-offset base; different means the mixer (or another system) owns the
// pose, so adopt the current value as the new base.

import { Quaternion, Vector3 } from 'three';

const EPS = 1e-9;

function quatEquals(a, b) {
	return (
		Math.abs(a.x - b.x) < EPS &&
		Math.abs(a.y - b.y) < EPS &&
		Math.abs(a.z - b.z) < EPS &&
		Math.abs(a.w - b.w) < EPS
	);
}

function vecEquals(a, b) {
	return Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS && Math.abs(a.z - b.z) < EPS;
}

export class QuaternionBaseline {
	constructor() {
		this._base = new Quaternion();
		this._written = new Quaternion();
		this._has = false;
	}

	/** Restore the pre-offset rotation if our last write survived untouched, then snapshot the base. */
	begin(bone) {
		if (this._has && quatEquals(bone.quaternion, this._written)) {
			bone.quaternion.copy(this._base);
		}
		this._base.copy(bone.quaternion);
	}

	/** Record what this layer left in the bone so next frame can recognize it. */
	end(bone) {
		this._written.copy(bone.quaternion);
		this._has = true;
	}
}

export class PositionBaseline {
	constructor() {
		this._base = new Vector3();
		this._written = new Vector3();
		this._has = false;
	}

	begin(bone) {
		if (this._has && vecEquals(bone.position, this._written)) {
			bone.position.copy(this._base);
		}
		this._base.copy(bone.position);
	}

	end(bone) {
		this._written.copy(bone.position);
		this._has = true;
	}
}
