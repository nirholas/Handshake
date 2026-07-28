// Analytic two-bone IK (law of cosines), the workhorse behind runtime foot
// planting and arm reach. Solves a root -> mid -> tip chain (hip -> knee ->
// ankle, shoulder -> elbow -> wrist) so the tip lands on a world-space target,
// with an optional pole target that controls which way the middle joint bends.
//
// The solver is Daniel Holden's closed-form two-joint formulation: measure the
// chain's current interior angles, compute the interior angles the target
// distance demands, and rotate the root and mid joints by the difference about
// the chain's own bend axis, then swing the whole chain so the tip direction
// lines up with the target direction. Rotation axes are computed once from the
// pre-solve pose and expressed in each joint's local frame, so both joint
// updates can be applied together without re-reading world matrices in
// between. No iteration, no convergence tuning, allocation-free per call.
//
// Why not three's CCDIKSolver: it is iterative, needs a SkinnedMesh-specific
// setup (iks[] descriptors indexed into skeleton.bones), and converges toward
// MMD-style chains. This closed-form solve is exact for the 3-joint case,
// works on any Object3D chain, and gives deterministic results the foot
// planter can damp frame-to-frame.

import { Quaternion, Vector3 } from 'three';

const EPS = 1e-6;

// Scratch registers so per-frame solves allocate nothing.
const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();
const _t = new Vector3();
const _ab = new Vector3();
const _ac = new Vector3();
const _at = new Vector3();
const _ba = new Vector3();
const _bc = new Vector3();
const _axis0 = new Vector3();
const _axis1 = new Vector3();
const _axisLocal = new Vector3();
const _q = new Quaternion();
const _worldQ = new Quaternion();
const _worldQInv = new Quaternion();
const _proj1 = new Vector3();
const _proj2 = new Vector3();
const _poleDir = new Vector3();
const _bendDir = new Vector3();

function clamp01(v, lo = -1, hi = 1) {
	return Math.max(lo, Math.min(hi, v));
}

// Interior angle at the vertex shared by two direction vectors.
function angleBetween(u, v) {
	const d = clamp01(u.dot(v) / Math.max(EPS, u.length() * v.length()));
	return Math.acos(d);
}

// Rotate `bone` by `angle` radians about the WORLD-space `axisWorld`, applied
// in the bone's own local frame (post-multiply), which is exactly how the
// closed-form solve expects its per-joint corrections to land.
function rotateAboutWorldAxis(bone, axisWorld, angle) {
	if (!Number.isFinite(angle) || Math.abs(angle) < EPS) return;
	bone.getWorldQuaternion(_worldQ);
	_worldQInv.copy(_worldQ).invert();
	_axisLocal.copy(axisWorld).applyQuaternion(_worldQInv).normalize();
	if (_axisLocal.lengthSq() < EPS) return;
	_q.setFromAxisAngle(_axisLocal, angle);
	bone.quaternion.multiply(_q);
}

/**
 * Solve a two-bone chain so `tip` reaches `target`.
 *
 * Mutates root.quaternion and mid.quaternion in place. The caller owns world
 * matrix hygiene: the chain's world matrices must be current when this is
 * called (call `root.updateWorldMatrix(true, true)` after the mixer tick), and
 * are refreshed for the chain before returning so follow-up reads see the
 * solved pose.
 *
 * @param {import('three').Object3D} root  first joint (hip / shoulder)
 * @param {import('three').Object3D} mid   second joint (knee / elbow)
 * @param {import('three').Object3D} tip   end effector (ankle / wrist)
 * @param {import('three').Vector3} target world-space target for the tip
 * @param {object} [opts]
 * @param {import('three').Vector3} [opts.pole] world-space pole target; the mid
 *   joint bends toward it (knee forward, elbow back). Also breaks the tie when
 *   the chain starts perfectly straight.
 * @param {number} [opts.softness] 0..1 fraction of full extension the chain
 *   refuses to exceed, preventing the harsh straight-leg snap at max reach.
 *   Default 0.98.
 * @returns {boolean} false when the chain is degenerate (zero-length bones);
 *   true otherwise, including out-of-reach targets (the chain extends toward
 *   the target as far as it can).
 */
export function solveTwoBoneIK(root, mid, tip, target, { pole = null, softness = 0.98 } = {}) {
	root.getWorldPosition(_a);
	mid.getWorldPosition(_b);
	tip.getWorldPosition(_c);
	_t.copy(target);

	const lab = _a.distanceTo(_b);
	const lcb = _b.distanceTo(_c);
	if (lab < EPS || lcb < EPS) return false;

	const maxReach = (lab + lcb) * clamp01(softness, 0, 1);
	const lat = Math.max(EPS, Math.min(maxReach, _a.distanceTo(_t)));

	_ab.copy(_b).sub(_a);
	_ac.copy(_c).sub(_a);
	_at.copy(_t).sub(_a);
	_ba.copy(_a).sub(_b);
	_bc.copy(_c).sub(_b);

	// Current vs required interior angles.
	const acAb0 = angleBetween(_ac, _ab);
	const baBc0 = angleBetween(_ba, _bc);
	const acAt0 = angleBetween(_ac, _at);
	const acAb1 = Math.acos(clamp01((lcb * lcb - lab * lab - lat * lat) / (-2 * lab * lat)));
	const baBc1 = Math.acos(clamp01((lat * lat - lab * lab - lcb * lcb) / (-2 * lab * lcb)));

	// Bend axis from the current pose; when the chain is perfectly straight the
	// cross product vanishes, so fall back to the pole (or any perpendicular) to
	// pick a bend plane deterministically.
	_axis0.crossVectors(_ac, _ab);
	if (_axis0.lengthSq() < EPS) {
		if (pole) {
			_poleDir.copy(pole).sub(_a);
			_axis0.crossVectors(_ac, _poleDir);
		}
		if (_axis0.lengthSq() < EPS) {
			// Chain and pole are collinear: any perpendicular works and stays stable.
			_axis0.set(1, 0, 0).cross(_ac);
			if (_axis0.lengthSq() < EPS) _axis0.set(0, 1, 0).cross(_ac);
		}
	}
	_axis0.normalize();

	// Swing axis: rotate the tip direction onto the target direction.
	_axis1.crossVectors(_ac, _at);
	const hasSwing = _axis1.lengthSq() >= EPS;
	if (hasSwing) _axis1.normalize();

	// Local-frame corrections computed from the pre-solve pose; safe to apply
	// root then mid without interleaved world-matrix refreshes.
	rotateAboutWorldAxis(root, _axis0, acAb1 - acAb0);
	rotateAboutWorldAxis(mid, _axis0, baBc1 - baBc0);
	if (hasSwing) rotateAboutWorldAxis(root, _axis1, acAt0);

	root.updateWorldMatrix(true, true);

	if (pole) {
		// Twist the solved chain about the root->target axis so the mid joint
		// points at the pole: project both the current bend direction and the
		// pole direction onto the plane perpendicular to that axis and rotate by
		// the signed angle between the projections.
		root.getWorldPosition(_a);
		mid.getWorldPosition(_b);
		_at.copy(_t).sub(_a);
		if (_at.lengthSq() >= EPS) {
			_at.normalize();
			_bendDir.copy(_b).sub(_a);
			_proj1.copy(_bendDir).addScaledVector(_at, -_bendDir.dot(_at));
			_poleDir.copy(pole).sub(_a);
			_proj2.copy(_poleDir).addScaledVector(_at, -_poleDir.dot(_at));
			if (_proj1.lengthSq() >= EPS && _proj2.lengthSq() >= EPS) {
				_proj1.normalize();
				_proj2.normalize();
				let twist = Math.acos(clamp01(_proj1.dot(_proj2)));
				_axis0.crossVectors(_proj1, _proj2);
				if (_axis0.dot(_at) < 0) twist = -twist;
				rotateAboutWorldAxis(root, _at, twist);
				root.updateWorldMatrix(true, true);
			}
		}
	}

	return true;
}
