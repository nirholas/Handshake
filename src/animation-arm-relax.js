// Un-driven arm relaxation: a last-resort guard so an avatar never renders with
// its arms frozen in the authored T-pose.
//
// The canonical idle/walk clips only drive bones the retargeter could name-map
// (see animation-retarget.js). A correctly-rigged three.ws avatar (mixamorig:*
// arms from workers/rig) maps its whole arm chain, so the idle clip swings the
// arms naturally and this module never touches it. But a legacy or composite GLB,
// or an arbitrary GLB a user drops into AR, can carry arm bones under a naming
// convention the canonicalizer doesn't recognize. The retargeter then DROPS the
// arm tracks while torso + legs still map (coverage stays above the 0.5 floor), so
// the clip plays and the body idles while both arms stay stuck out sideways at the
// authored bind pose. That reads as broken, and CLAUDE.md's avatar rule is explicit:
// never a bind-pose T-pose.
//
// This finds those un-driven arms GEOMETRICALLY (no name needed) and swings each
// down to a relaxed rest. It is gated hard: it runs ONLY when neither canonical
// upper-arm bone name-mapped, so a rig whose arms the clip already drives is never
// touched. Worst case on an already-broken avatar is arms at a slightly imperfect
// angle instead of a stiff T, which is strictly better. Pure module (three only) so
// it unit-tests in Node.

import { Quaternion, Vector3 } from 'three';

// A bone counts as "arm-like" when the direction to its child bone is dominated by
// the lateral (world X) axis and is not steeply vertical, i.e. it sticks out to
// the side the way a T-posed upper arm does. A clavicle points up-and-out (larger
// |y|) and is excluded by the vertical cap, so the proximal pick lands on the upper
// arm itself.
const LATERAL_DOMINANCE = 0.6; // |dir.x| must exceed this share of the unit length
const VERTICAL_CAP = 0.38;     // |dir.y| above this reads as clavicle/spine, not arm
const ALREADY_RELAXED_Y = -0.4; // arms already hanging (dir.y below this) are left alone

const _boneWorld = new Vector3();
const _childWorld = new Vector3();
const _childDir = new Vector3();
const _target = new Vector3();
const _worldDelta = new Quaternion();
const _boneWorldQ = new Quaternion();
const _parentWorldQ = new Quaternion();

// First child of `bone` that is itself a bone (the next joint down the chain).
function firstChildBone(bone) {
	for (const c of bone.children) {
		if (c.isBone) return c;
	}
	return null;
}

/**
 * Swing un-driven arms down to a relaxed rest, in place.
 *
 * @param {import('three').Object3D} model the attached avatar root
 * @param {Map<string,string>} canonicalToNode canonical→node map from the retargeter
 * @returns {number} how many arms were relaxed (0, 1, or 2)
 */
export function relaxUndrivenArms(model, canonicalToNode) {
	if (!model) return 0;
	// Gate: if either upper arm name-mapped, the clip drives the arms, so hands off.
	// (A one-sided map is left alone too: relaxing only one arm would look worse than
	// a symmetric idle, and the asymmetric case is vanishingly rare.)
	if (canonicalToNode && (canonicalToNode.has('LeftArm') || canonicalToNode.has('RightArm'))) {
		return 0;
	}

	model.updateMatrixWorld(true);

	// Collect every bone that has a child bone, with its world position and the world
	// direction to that child. One pass; also tracks the vertical mid-point so we can
	// require arm candidates to sit in the upper body.
	const bones = [];
	let minY = Infinity, maxY = -Infinity;
	model.traverse((node) => {
		if (!node.isBone) return;
		const child = firstChildBone(node);
		if (!child) return;
		node.getWorldPosition(_boneWorld);
		child.getWorldPosition(_childWorld);
		const dir = _childWorld.clone().sub(_boneWorld);
		const len = dir.length();
		if (len < 1e-5) return;
		dir.multiplyScalar(1 / len);
		const y = _boneWorld.y;
		if (y < minY) minY = y;
		if (y > maxY) maxY = y;
		bones.push({ bone: node, worldY: y, dir });
	});
	if (bones.length === 0 || !Number.isFinite(minY) || maxY <= minY) return 0;

	const midY = (minY + maxY) / 2;

	// Arm candidates: lateral-dominant child direction, not steeply vertical, sitting
	// in the upper half of the rig. Split by which way they point (a T-pose sends the
	// two arms in opposite X directions), so we relax at most one arm per side.
	let bestPos = null; // strongest +X-pointing candidate (one arm)
	let bestNeg = null; // strongest -X-pointing candidate (the other arm)
	for (const cand of bones) {
		const { dir, worldY } = cand;
		if (worldY < midY) continue;                 // not upper body
		if (Math.abs(dir.y) > VERTICAL_CAP) continue; // clavicle / spine, not the arm
		if (dir.y < ALREADY_RELAXED_Y) continue;      // already hanging down
		if (Math.abs(dir.x) < LATERAL_DOMINANCE) continue;
		if (dir.x > 0) {
			if (!bestPos || dir.x > bestPos.dir.x) bestPos = cand;
		} else {
			if (!bestNeg || dir.x < bestNeg.dir.x) bestNeg = cand;
		}
	}

	let relaxed = 0;
	for (const cand of [bestPos, bestNeg]) {
		if (cand && relaxArm(cand.bone, cand.dir)) relaxed++;
	}
	return relaxed;
}

// Rotate one arm bone so its child direction swings from wherever it points now
// (roughly ±X in a T-pose) to a relaxed rest: mostly straight down, biased a touch
// outward on its own side and a touch forward, so the arm hangs naturally instead
// of clipping into the torso. Sets the bone's LOCAL quaternion; because the clip
// never drives this (un-mapped) bone, the mixer leaves the pose in place every frame.
function relaxArm(bone, childDir) {
	const side = childDir.x >= 0 ? 1 : -1;
	_target.set(side * 0.14, -1, 0.1).normalize();
	_childDir.copy(childDir);
	_worldDelta.setFromUnitVectors(_childDir, _target);

	bone.getWorldQuaternion(_boneWorldQ);
	if (bone.parent) bone.parent.getWorldQuaternion(_parentWorldQ);
	else _parentWorldQ.identity();

	// desiredWorld = worldDelta · boneWorld ; localQ = parentWorld⁻¹ · desiredWorld
	const desiredWorld = _worldDelta.multiply(_boneWorldQ);
	const localQ = _parentWorldQ.invert().multiply(desiredWorld);
	bone.quaternion.copy(localQ);
	bone.updateMatrixWorld(true);
	return true;
}
