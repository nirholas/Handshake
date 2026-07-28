// Procedural look-at: the avatar's chest, neck, and head turn toward a world
// point on top of whatever clip the mixer is playing, so a companion tracks
// your cursor and a stage avatar watches a speaker instead of staring through
// them. Runs as a post-animation layer: call update(dt) every frame AFTER
// mixer.update(), and it adds a clamped, damped rotation offset to the bones
// the mixer just posed. It never accumulates (the mixer rewrites bone locals
// each tick), so it composes cleanly with idle sway, walk cycles, and
// gestures.
//
// Rig-agnostic by the same doctrine as the clip library: joints are resolved
// through canonicalNodeMapFromObject (src/animation-retarget.js), so any
// humanoid the retargeter can drive, this can too. A rig with no mappable Head
// simply reports enabled=false and update() is a no-op.

import { Euler, Quaternion, Vector3 } from 'three';
import { canonicalNodeMapFromObject } from '../animation-retarget.js';
import { QuaternionBaseline } from './pose-baseline.js';

const DEG = Math.PI / 180;

// How the total look rotation is distributed up the chain, torso to head.
// Missing joints (a rig without a Spine2, say) forfeit their share to the
// joints that exist, renormalized in the constructor.
const CHAIN = [
	{ canonical: ['Spine2', 'Spine1', 'Spine'], share: 0.15 },
	{ canonical: ['Neck'], share: 0.3 },
	{ canonical: ['Head'], share: 0.55 },
];

// Beyond this yaw the target is effectively behind the avatar; instead of
// pinning the head at the clamp (which reads as strained), the controller
// fades the whole layer out and lets the base animation own the pose.
const BEHIND_YAW = 120 * DEG;

const _headPos = new Vector3();
const _dir = new Vector3();
const _modelQ = new Quaternion();
const _modelQInv = new Quaternion();
const _parentQ = new Quaternion();
const _parentQInv = new Quaternion();
const _delta = new Quaternion();
const _world = new Quaternion();
const _local = new Quaternion();
const _euler = new Euler();

export class LookAtController {
	/**
	 * @param {import('three').Object3D} model a loaded avatar (any humanoid rig)
	 * @param {object} [opts]
	 * @param {Map<string,string>} [opts.canonicalToNode] reuse an existing
	 *   canonical bone map (e.g. AnimationManager's) instead of re-traversing
	 * @param {number} [opts.maxYaw] horizontal clamp, radians (default 65deg)
	 * @param {number} [opts.maxPitchUp] upward clamp, radians (default 30deg)
	 * @param {number} [opts.maxPitchDown] downward clamp, radians (default 35deg)
	 * @param {number} [opts.damping] rotation smoothing rate, 1/s (default 10;
	 *   higher snaps faster)
	 * @param {number} [opts.fadeRate] layer weight fade in/out rate, 1/s (default 5)
	 */
	constructor(model, opts = {}) {
		this.model = model || null;
		this.maxYaw = opts.maxYaw ?? 65 * DEG;
		this.maxPitchUp = opts.maxPitchUp ?? 30 * DEG;
		this.maxPitchDown = opts.maxPitchDown ?? 35 * DEG;
		this.damping = opts.damping ?? 10;
		this.fadeRate = opts.fadeRate ?? 5;

		/** @type {import('three').Vector3|null} world-space point to look at */
		this.target = null;
		this._weight = 0;
		this._yaw = 0;
		this._pitch = 0;

		/** @type {Array<{node: import('three').Object3D, share: number}>} */
		this._joints = [];
		if (model) {
			const map = opts.canonicalToNode || canonicalNodeMapFromObject(model);
			let total = 0;
			for (const { canonical, share } of CHAIN) {
				for (const name of canonical) {
					const nodeName = map.get(name);
					const node = nodeName ? model.getObjectByName(nodeName) : null;
					if (node) {
						this._joints.push({ node, share, baseline: new QuaternionBaseline() });
						total += share;
						break;
					}
				}
			}
			// A chain without a head cannot "look"; disable rather than nod a torso.
			if (!this._joints.some((j) => j.node.name === map.get('Head'))) {
				this._joints = [];
				total = 0;
			}
			for (const j of this._joints) j.share /= total || 1;
		}
	}

	/** @returns {boolean} whether this rig exposes a usable look chain */
	get enabled() {
		return this._joints.length > 0;
	}

	/**
	 * Aim at a world-space point, or pass null to fade back to the base
	 * animation. The vector is copied; callers may reuse theirs.
	 * @param {import('three').Vector3|null} worldPoint
	 */
	setTarget(worldPoint) {
		if (!worldPoint) {
			this.target = null;
			return;
		}
		if (!this.target) this.target = new Vector3();
		this.target.copy(worldPoint);
	}

	/**
	 * Apply the look layer for this frame. Call AFTER mixer.update(dt).
	 * @param {number} dt seconds since last frame
	 */
	update(dt) {
		if (!this.enabled || !this.model) return;
		dt = Math.max(0, Math.min(dt || 0, 0.1));
		const damp = 1 - Math.exp(-this.damping * dt);
		const fade = 1 - Math.exp(-this.fadeRate * dt);

		// Recover each joint's pre-offset base first, so both the aim measurement
		// and the re-applied offset start from the clean animated pose even when
		// no clip rewrote the bone since our last write.
		for (const { node, baseline } of this._joints) baseline.begin(node);

		let goalWeight = 0;
		let goalYaw = this._yaw;
		let goalPitch = this._pitch;

		if (this.target) {
			// Head position and model orientation from the pose the mixer just set.
			const head = this._joints[this._joints.length - 1].node;
			head.getWorldPosition(_headPos);
			this.model.getWorldQuaternion(_modelQ);
			_modelQInv.copy(_modelQ).invert();
			_dir.copy(this.target).sub(_headPos);
			if (_dir.lengthSq() > 1e-8) {
				_dir.applyQuaternion(_modelQInv).normalize();
				// Model space, +Z forward (the glTF-facing convention every rig in
				// the retarget pipeline is normalized to).
				const rawYaw = Math.atan2(_dir.x, _dir.z);
				const rawPitch = Math.asin(Math.max(-1, Math.min(1, _dir.y)));
				if (Math.abs(rawYaw) < BEHIND_YAW) {
					goalWeight = 1;
					goalYaw = Math.max(-this.maxYaw, Math.min(this.maxYaw, rawYaw));
					goalPitch = Math.max(-this.maxPitchDown, Math.min(this.maxPitchUp, rawPitch));
				}
			}
		}

		this._weight += (goalWeight - this._weight) * fade;
		this._yaw += (goalYaw - this._yaw) * damp;
		this._pitch += (goalPitch - this._pitch) * damp;
		if (this._weight < 1e-3) {
			for (const { node, baseline } of this._joints) baseline.end(node);
			return;
		}

		const yaw = this._yaw * this._weight;
		const pitch = this._pitch * this._weight;
		this.model.getWorldQuaternion(_modelQ);
		_modelQInv.copy(_modelQ).invert();

		for (const { node, share, baseline } of this._joints) {
			// Positive pitch (look up) tilts the +Z forward axis upward, which is a
			// negative rotation about model X.
			_euler.set(-pitch * share, yaw * share, 0, 'YXZ');
			_delta.setFromEuler(_euler);
			// The delta lives in model space; conjugate it into world space, then
			// into the bone's parent frame, so it composes as a world rotation of
			// the joint regardless of the rig's rest orientation quirks.
			_world.copy(_modelQ).multiply(_delta).multiply(_modelQInv);
			const parent = node.parent;
			if (parent) {
				parent.getWorldQuaternion(_parentQ);
				_parentQInv.copy(_parentQ).invert();
				_local.copy(_parentQInv).multiply(_world).multiply(_parentQ);
				node.quaternion.premultiply(_local);
			} else {
				node.quaternion.premultiply(_world);
			}
			baseline.end(node);
		}
	}
}
