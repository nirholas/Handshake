// Procedural foot planting: on uneven terrain the locomotion code can only put
// the rig's ORIGIN on the ground, so on any slope one foot floats and the
// other clips through. This layer reads where the ground actually is under
// each foot, drops the pelvis just enough that the downhill leg can reach, and
// bends each leg with two-bone IK so both feet land on their own patch of
// ground. The animation's own foot lift is preserved: each foot is moved by
// the terrain's height DIFFERENCE under it, so a mid-swing foot keeps its
// swing clearance and a planted foot sits flush.
//
// Post-animation layer, same contract as LookAtController: call update(dt)
// every frame AFTER mixer.update() and after the caller has positioned the rig
// on the ground at its origin. Adds a damped offset on top of the mixer pose;
// never accumulates. Rig-agnostic through canonicalNodeMapFromObject; a rig
// missing a full hip-knee-ankle chain reports enabled=false and no-ops.

import { Quaternion, Vector3 } from 'three';
import { canonicalNodeMapFromObject } from '../animation-retarget.js';
import { solveTwoBoneIK } from './two-bone-ik.js';
import { PositionBaseline, QuaternionBaseline } from './pose-baseline.js';

const LEGS = [
	{ side: 'left', up: 'LeftUpLeg', mid: 'LeftLeg', foot: 'LeftFoot' },
	{ side: 'right', up: 'RightUpLeg', mid: 'RightLeg', foot: 'RightFoot' },
];

const _rigPos = new Vector3();
const _footPos = new Vector3();
const _kneePos = new Vector3();
const _target = new Vector3();
const _pole = new Vector3();
const _forward = new Vector3();
const _modelQ = new Quaternion();
const _footWorldQ = new Quaternion();
const _parentQ = new Quaternion();
const _parentScale = new Vector3();

export class FootPlantController {
	/**
	 * @param {import('three').Object3D} model a loaded humanoid avatar
	 * @param {(x: number, z: number) => number} getGroundY world-space terrain
	 *   height sampler (same shape as the walk world's terrain.heightAt)
	 * @param {object} [opts]
	 * @param {Map<string,string>} [opts.canonicalToNode] reuse an existing canonical bone map
	 * @param {number} [opts.maxDrop] max pelvis drop in world metres (default 0.35)
	 * @param {number} [opts.maxLift] max per-foot raise in world metres (default 0.6)
	 * @param {number} [opts.damping] offset smoothing rate, 1/s (default 12)
	 */
	constructor(model, getGroundY, opts = {}) {
		this.model = model || null;
		this.getGroundY = typeof getGroundY === 'function' ? getGroundY : null;
		this.maxDrop = opts.maxDrop ?? 0.35;
		this.maxLift = opts.maxLift ?? 0.6;
		this.damping = opts.damping ?? 12;

		this._pelvisOffset = 0;

		/** @type {import('three').Object3D|null} */
		this.hips = null;
		/** @type {Array<{up: import('three').Object3D, mid: import('three').Object3D, foot: import('three').Object3D, offset: number}>} */
		this._legs = [];

		if (model && this.getGroundY) {
			const map = opts.canonicalToNode || canonicalNodeMapFromObject(model);
			const resolve = (canonical) => {
				const name = map.get(canonical);
				return name ? model.getObjectByName(name) : null;
			};
			this.hips = resolve('Hips');
			for (const leg of LEGS) {
				const up = resolve(leg.up);
				const mid = resolve(leg.mid);
				const foot = resolve(leg.foot);
				if (up && mid && foot) {
					this._legs.push({
						up,
						mid,
						foot,
						offset: 0,
						delta: 0,
						upBase: new QuaternionBaseline(),
						midBase: new QuaternionBaseline(),
						footBase: new QuaternionBaseline(),
					});
				}
			}
			this._hipsBase = new PositionBaseline();
		}
	}

	/** @returns {boolean} whether this rig exposes hips plus at least one full leg chain */
	get enabled() {
		return !!this.hips && this._legs.length > 0;
	}

	/**
	 * Apply the planting layer for this frame. Call AFTER mixer.update() and
	 * after the rig has been positioned on the terrain at its origin.
	 * @param {number} dt seconds since last frame
	 */
	update(dt) {
		if (!this.enabled || !this.model) return;
		dt = Math.max(0, Math.min(dt || 0, 0.1));
		const damp = 1 - Math.exp(-this.damping * dt);

		// Recover pre-offset baselines first (see pose-baseline.js), so terrain
		// measurement and the re-applied offsets start from the clean animated
		// pose even when no clip rewrote these bones since our last write.
		this._hipsBase.begin(this.hips);
		for (const leg of this._legs) {
			leg.upBase.begin(leg.up);
			leg.midBase.begin(leg.mid);
			leg.footBase.begin(leg.foot);
		}

		// Ground under the rig origin: the height the locomotion code already
		// stands the whole model on. Everything below works in deltas from it.
		this.model.getWorldPosition(_rigPos);
		const rootGround = this.getGroundY(_rigPos.x, _rigPos.z);
		if (!Number.isFinite(rootGround)) {
			this._endBaselines();
			return;
		}

		// Terrain delta under each foot, from the animated (pre-IK) pose.
		this.hips.updateWorldMatrix(true, true);
		let minDelta = 0;
		for (const leg of this._legs) {
			leg.foot.getWorldPosition(_footPos);
			const g = this.getGroundY(_footPos.x, _footPos.z);
			leg.delta = Number.isFinite(g) ? g - rootGround : 0;
			if (leg.delta < minDelta) minDelta = leg.delta;
		}

		// Pelvis: sink by the lowest downhill delta (never rise) so the low-side
		// leg can reach its ground without hyper-extending.
		const pelvisGoal = Math.max(-this.maxDrop, minDelta);
		this._pelvisOffset += (pelvisGoal - this._pelvisOffset) * damp;
		if (Math.abs(this._pelvisOffset) > 1e-4) {
			// Hips translate in their parent's local units; convert the world
			// offset through the parent's world scale (a cm-scale armature needs
			// ~100x the local value for the same world drop).
			const parent = this.hips.parent;
			let scaleY = 1;
			if (parent) {
				parent.getWorldScale(_parentScale);
				if (_parentScale.y > 1e-6) scaleY = _parentScale.y;
			}
			this.hips.position.y += this._pelvisOffset / scaleY;
			this.hips.updateWorldMatrix(false, true);
		}

		// Per-leg: raise each foot back onto its own terrain patch. After the
		// pelvis sank by _pelvisOffset every foot moved down with it, so the
		// required world-space correction is (terrain delta - pelvis offset),
		// which is >= 0 by construction.
		this.model.getWorldQuaternion(_modelQ);
		_forward.set(0, 0, 1).applyQuaternion(_modelQ);
		for (const leg of this._legs) {
			const goal = Math.max(0, Math.min(this.maxLift, leg.delta - this._pelvisOffset));
			leg.offset += (goal - leg.offset) * damp;
			if (leg.offset < 1e-4) continue;

			leg.foot.getWorldPosition(_footPos);
			leg.foot.getWorldQuaternion(_footWorldQ);
			_target.copy(_footPos);
			_target.y += leg.offset;
			// Knee pole: ahead of the knee along the model's facing, so the bend
			// stays anatomical on every rig.
			leg.mid.getWorldPosition(_kneePos);
			_pole.copy(_kneePos).addScaledVector(_forward, 1);

			solveTwoBoneIK(leg.up, leg.mid, leg.foot, _target, { pole: _pole });

			// The hip/knee rotations tilted the ankle with them; restore the foot's
			// animated world orientation so toes keep pointing where the clip aimed.
			const parent = leg.foot.parent;
			if (parent) {
				parent.getWorldQuaternion(_parentQ);
				leg.foot.quaternion.copy(_parentQ.invert().multiply(_footWorldQ));
				leg.foot.updateWorldMatrix(false, true);
			}
		}

		this._endBaselines();
	}

	/** @private Record what this layer wrote so next frame's begin() can recognize it. */
	_endBaselines() {
		this._hipsBase.end(this.hips);
		for (const leg of this._legs) {
			leg.upBase.end(leg.up);
			leg.midBase.end(leg.mid);
			leg.footBase.end(leg.foot);
		}
	}
}
