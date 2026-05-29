// Skeleton-agnostic posing abstraction for the Animation Studio (/pose).
//
// A "rig" presents one uniform interface over two very different backends:
//   - the built-in primitive Mannequin (a tree of THREE.Group joints), and
//   - a loaded rigged GLB avatar (a THREE.Skeleton of THREE.Bone nodes).
//
// Everything above this layer — the gizmos, IK, FK sliders, and (Task 2) the
// keyframe timeline — talks only to this interface and never needs to know
// which backend is underneath. Poses are keyed by CANONICAL bone names
// (Avaturn / Mixamo-retargeted: Hips, Spine, LeftArm, …) and carry
// quaternions, so a pose recorded on one rig bakes into a clip whose track
// names play on standard three.ws avatars.

import { Bone, Quaternion, Vector3, Euler, MathUtils } from 'three';
import { normalizeBoneName } from './avatar-export.js';
import { Mannequin } from './pose-mannequin.js';

// ── Canonical skeleton ──────────────────────────────────────────────────────
// The exact bare bone names used by built-in clips (public/animations/clips/*).
// Order is head→spine→arms→legs so generated UI lists read naturally.
export const CANONICAL_BONES = [
	'Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head',
	'LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand',
	'RightShoulder', 'RightArm', 'RightForeArm', 'RightHand',
	'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftToeBase',
	'RightUpLeg', 'RightLeg', 'RightFoot', 'RightToeBase',
	// Fingers — captured when a rig has them so detailed hand poses survive.
	'LeftHandThumb1', 'LeftHandThumb2', 'LeftHandThumb3',
	'LeftHandIndex1', 'LeftHandIndex2', 'LeftHandIndex3',
	'LeftHandMiddle1', 'LeftHandMiddle2', 'LeftHandMiddle3',
	'LeftHandRing1', 'LeftHandRing2', 'LeftHandRing3',
	'LeftHandPinky1', 'LeftHandPinky2', 'LeftHandPinky3',
	'RightHandThumb1', 'RightHandThumb2', 'RightHandThumb3',
	'RightHandIndex1', 'RightHandIndex2', 'RightHandIndex3',
	'RightHandMiddle1', 'RightHandMiddle2', 'RightHandMiddle3',
	'RightHandRing1', 'RightHandRing2', 'RightHandRing3',
	'RightHandPinky1', 'RightHandPinky2', 'RightHandPinky3',
];

// Human-readable labels for the canonical bones (UI lists / selection HUD).
export const CANONICAL_LABELS = {
	Hips: 'Hips', Spine: 'Spine (lower)', Spine1: 'Spine (mid)', Spine2: 'Chest',
	Neck: 'Neck', Head: 'Head',
	LeftShoulder: 'Shoulder L', LeftArm: 'Upper arm L', LeftForeArm: 'Forearm L', LeftHand: 'Hand L',
	RightShoulder: 'Shoulder R', RightArm: 'Upper arm R', RightForeArm: 'Forearm R', RightHand: 'Hand R',
	LeftUpLeg: 'Thigh L', LeftLeg: 'Shin L', LeftFoot: 'Foot L', LeftToeBase: 'Toe L',
	RightUpLeg: 'Thigh R', RightLeg: 'Shin R', RightFoot: 'Foot R', RightToeBase: 'Toe R',
};

// Primitive-mannequin joint → canonical bone. The mannequin only has 17
// joints; we route them onto the canonical names so both rigs emit the same
// pose shape (Task 1 contract for Task 2).
const MANNEQUIN_TO_CANONICAL = {
	pelvis: 'Hips', spine: 'Spine', chest: 'Spine2', neck: 'Neck', head: 'Head',
	shoulderL: 'LeftArm', elbowL: 'LeftForeArm', wristL: 'LeftHand',
	shoulderR: 'RightArm', elbowR: 'RightForeArm', wristR: 'RightHand',
	hipL: 'LeftUpLeg', kneeL: 'LeftLeg', ankleL: 'LeftFoot',
	hipR: 'RightUpLeg', kneeR: 'RightLeg', ankleR: 'RightFoot',
};
const CANONICAL_TO_MANNEQUIN = Object.fromEntries(
	Object.entries(MANNEQUIN_TO_CANONICAL).map(([j, c]) => [c, j]),
);

// normalize(canonical) → canonical, so an arbitrary GLB bone name (mixamorig:,
// case, separators) can be matched to a canonical bone via normalizeBoneName().
const NORMALIZED_CANONICAL = new Map(
	CANONICAL_BONES.map((c) => [normalizeBoneName(c), c]),
);

// IK chains: drag the end-effector, the link bones rotate to reach it. Defined
// once in canonical space and resolved per-rig (links present on the rig only).
// Order: links go from the effector's parent outward toward the root.
export const IK_CHAINS = [
	{ name: 'Left arm', effector: 'LeftHand', links: ['LeftForeArm', 'LeftArm'] },
	{ name: 'Right arm', effector: 'RightHand', links: ['RightForeArm', 'RightArm'] },
	{ name: 'Left leg', effector: 'LeftFoot', links: ['LeftLeg', 'LeftUpLeg'] },
	{ name: 'Right leg', effector: 'RightFoot', links: ['RightLeg', 'RightUpLeg'] },
];

// ── Lightweight CCD IK ───────────────────────────────────────────────────────
// Cyclic Coordinate Descent over a chain of THREE.Object3D bones toward a
// world-space target. Works uniformly on mannequin Groups and GLB Bones (no
// SkinnedMesh / skeleton-index assumptions), so neither rig has a dead toggle.
const _targetLocal = new Vector3();
const _effectorLocal = new Vector3();
const _axis = new Vector3();
const _q = new Quaternion();
const _invParent = new Quaternion();

function solveCCD(links, effector, targetWorld, { iterations = 10, threshold = 0.001 } = {}) {
	if (!links.length || !effector) return;
	for (let iter = 0; iter < iterations; iter++) {
		for (const bone of links) {
			bone.updateWorldMatrix(true, true);
			effector.updateWorldMatrix(true, false);
			// Vector from this bone to the effector and to the target, in the
			// bone's LOCAL frame (so the resulting rotation is a local delta).
			const inv = bone.matrixWorld.clone().invert();
			_effectorLocal.setFromMatrixPosition(effector.matrixWorld).applyMatrix4(inv);
			_targetLocal.copy(targetWorld).applyMatrix4(inv);
			if (_effectorLocal.lengthSq() < 1e-8 || _targetLocal.lengthSq() < 1e-8) continue;
			_effectorLocal.normalize();
			_targetLocal.normalize();
			let dot = MathUtils.clamp(_effectorLocal.dot(_targetLocal), -1, 1);
			const angle = Math.acos(dot);
			if (angle < 1e-5) continue;
			_axis.crossVectors(_effectorLocal, _targetLocal);
			if (_axis.lengthSq() < 1e-10) continue;
			_axis.normalize();
			_q.setFromAxisAngle(_axis, angle);
			bone.quaternion.multiply(_q);
			bone.updateWorldMatrix(true, true);
		}
		effector.updateWorldMatrix(true, false);
		const dist = _effectorLocal
			.setFromMatrixPosition(effector.matrixWorld)
			.distanceTo(targetWorld);
		if (dist < threshold) break;
	}
}

// ── Base rig ─────────────────────────────────────────────────────────────────
class BaseRig {
	constructor() {
		this.kind = 'base';
		/** @type {Map<string, import('three').Object3D>} canonical → node */
		this.bones = new Map();
		/** @type {import('three').Object3D} added to the scene */
		this.root = null;
		this.selectableMeshes = [];
	}

	/** Ordered posable bones present on this rig. */
	getBones() {
		const out = [];
		for (const key of CANONICAL_BONES) {
			if (this.bones.has(key)) {
				out.push({ key, label: CANONICAL_LABELS[key] || key, node: this.bones.get(key) });
			}
		}
		return out;
	}

	hasBone(key) { return this.bones.has(key); }
	getNode(key) { return this.bones.get(key) || null; }

	getBoneQuaternion(key) {
		const n = this.bones.get(key);
		return n ? n.quaternion.clone() : new Quaternion();
	}
	setBoneQuaternion(key, quat) {
		const n = this.bones.get(key);
		if (n) n.quaternion.copy(quat);
	}
	getBoneEuler(key) {
		const n = this.bones.get(key);
		if (!n) return { x: 0, y: 0, z: 0 };
		const e = new Euler().setFromQuaternion(n.quaternion, 'XYZ');
		return { x: e.x, y: e.y, z: e.z };
	}
	setBoneEuler(key, { x = 0, y = 0, z = 0 }) {
		const n = this.bones.get(key);
		if (n) n.quaternion.setFromEuler(new Euler(x, y, z, 'XYZ'));
	}

	getRootPosition() {
		return this.root ? this.root.position.clone() : new Vector3();
	}
	setRootPosition(vec) {
		if (this.root) this.root.position.set(vec.x, vec.y, vec.z);
	}

	// Canonical pose snapshot — the shape Task 2's timeline records.
	//   { bones: { Hips: [x,y,z,w], … }, rootPosition: {x,y,z} }
	getPose() {
		const bones = {};
		for (const [key, node] of this.bones) {
			const q = node.quaternion;
			bones[key] = [q.x, q.y, q.z, q.w];
		}
		const p = this.getRootPosition();
		return { bones, rootPosition: { x: p.x, y: p.y, z: p.z } };
	}

	applyPose(pose) {
		if (!pose) return;
		this.resetPose();
		const bones = pose.bones || pose; // tolerate a bare bones map
		for (const [key, v] of Object.entries(bones)) {
			if (key === 'rootPosition') continue;
			const node = this.bones.get(key);
			if (!node || !Array.isArray(v) || v.length < 4) continue;
			node.quaternion.set(v[0], v[1], v[2], v[3]);
		}
		const rp = pose.rootPosition;
		if (rp && this.root) this.root.position.set(rp.x || 0, rp.y || 0, rp.z || 0);
	}

	// Resolve the IK chains that actually exist on this rig.
	getIKChains() {
		const out = [];
		for (const chain of IK_CHAINS) {
			const effector = this.bones.get(chain.effector);
			const links = chain.links.map((k) => this.bones.get(k)).filter(Boolean);
			if (effector && links.length) {
				out.push({ name: chain.name, effectorKey: chain.effector, effector, links });
			}
		}
		return out;
	}

	/** Drag-IK: rotate the named chain's links so its effector reaches target. */
	solveIK(effectorKey, targetWorld) {
		const chain = this.getIKChains().find((c) => c.effectorKey === effectorKey);
		if (!chain) return;
		solveCCD(chain.links, chain.effector, targetWorld);
	}

	getSelectableMeshes() { return this.selectableMeshes; }
	dispose() {}
}

// ── Mannequin-backed rig ──────────────────────────────────────────────────────
export class MannequinRig extends BaseRig {
	constructor(opts = {}) {
		super();
		this.kind = 'mannequin';
		this.mannequin = new Mannequin(opts);
		this.root = this.mannequin.root;
		this.selectableMeshes = this.mannequin.selectableMeshes;
		this._rebuildMap();
	}

	_rebuildMap() {
		this.bones = new Map();
		for (const [joint, canonical] of Object.entries(MANNEQUIN_TO_CANONICAL)) {
			const node = this.mannequin.joints[joint];
			if (node) this.bones.set(canonical, node);
		}
	}

	// Map a raycast hit back to a canonical bone key.
	boneFromHit(object) {
		const joint = this.mannequin.jointFromHit(object);
		return joint ? MANNEQUIN_TO_CANONICAL[joint] || null : null;
	}

	resetPose() {
		this.mannequin.resetPose();
	}

	// Mannequin-only conveniences the studio still exposes.
	setBuild(build) {
		this.mannequin.setBuild(build);
		this.root = this.mannequin.root;
		this.selectableMeshes = this.mannequin.selectableMeshes;
		this._rebuildMap();
	}
	setColor(hex) { this.mannequin.setColor(hex); }
	setConstraintsEnabled(on) { this.mannequin.setConstraintsEnabled(on); }
	getApproxHeight() { return this.mannequin.getApproxHeight(); }

	// The mannequin's biological constraints operate on Euler angles; honor them
	// when posing via the FK sliders so the figure can't bend impossibly.
	setBoneEuler(key, euler) {
		const joint = CANONICAL_TO_MANNEQUIN[key];
		if (joint) {
			this.mannequin.setJointRotation(joint, 'x', euler.x || 0);
			this.mannequin.setJointRotation(joint, 'y', euler.y || 0);
			this.mannequin.setJointRotation(joint, 'z', euler.z || 0);
		} else {
			super.setBoneEuler(key, euler);
		}
	}
}

// ── GLB-backed rig ────────────────────────────────────────────────────────────
export class GltfRig extends BaseRig {
	/**
	 * @param {THREE.Object3D} scene  gltf.scene
	 */
	constructor(scene) {
		super();
		this.kind = 'glb';
		this.root = scene;
		this.skinnedMeshes = [];
		this._buildFromScene(scene);
	}

	_buildFromScene(scene) {
		// Collect skeleton bones. Prefer SkinnedMesh skeletons; fall back to any
		// Bone nodes in the graph for rigs exported without a bound skin.
		const seen = new Set();
		const consider = (node) => {
			const canonical = NORMALIZED_CANONICAL.get(normalizeBoneName(node.name));
			if (canonical && !this.bones.has(canonical)) {
				this.bones.set(canonical, node);
			}
			if (!seen.has(node)) {
				seen.add(node);
				this.selectableMeshes.push(node);
			}
		};
		scene.traverse((node) => {
			if (node.isSkinnedMesh) this.skinnedMeshes.push(node);
			if (node.isBone) consider(node);
		});
		// Some exporters name bones only on the skeleton, not the node graph.
		for (const sm of this.skinnedMeshes) {
			for (const bone of sm.skeleton?.bones || []) consider(bone);
		}
	}

	get hasSkeleton() { return this.bones.size > 0; }

	// GLB bones aren't directly raycastable (they have no geometry); the studio
	// raycasts the skinned mesh and we resolve the nearest skinned bone by
	// screen proximity in the studio. Bones themselves return their canonical
	// key when hit (covers rigs that ship bone helper geometry).
	boneFromHit(object) {
		let o = object;
		while (o) {
			if (o.isBone) {
				const canonical = NORMALIZED_CANONICAL.get(normalizeBoneName(o.name));
				if (canonical && this.bones.has(canonical)) return canonical;
			}
			o = o.parent;
		}
		return null;
	}

	resetPose() {
		// Restore each posable bone to its bind/rest local transform. We captured
		// nothing at load besides the live transform, so reset means identity-ish
		// rest: re-read from the skeleton's boneInverses when available.
		for (const sm of this.skinnedMeshes) {
			const sk = sm.skeleton;
			if (!sk) continue;
			sk.pose(); // restores bones to their bind pose
		}
		if (this._restRootPos) this.root.position.copy(this._restRootPos);
	}

	captureRest() {
		// Snapshot the bind pose so resetPose() and applyPose() have a baseline.
		this._restRootPos = this.root.position.clone();
	}
}

// Convert a legacy mannequin preset ({ jointName: {x,y,z} Euler, rootPosition })
// into a canonical quaternion pose so presets apply to any rig uniformly.
export function poseFromMannequinPreset(presetPose) {
	const bones = {};
	for (const [joint, rot] of Object.entries(presetPose || {})) {
		if (joint === 'rootPosition' || !rot) continue;
		const canonical = MANNEQUIN_TO_CANONICAL[joint];
		if (!canonical) continue;
		const q = new Quaternion().setFromEuler(new Euler(rot.x || 0, rot.y || 0, rot.z || 0, 'XYZ'));
		bones[canonical] = [q.x, q.y, q.z, q.w];
	}
	const pose = { bones };
	if (presetPose?.rootPosition) pose.rootPosition = presetPose.rootPosition;
	return pose;
}

// Build a rig over a freshly-loaded gltf scene; returns null if it has no
// recognizable humanoid skeleton (caller shows an actionable error).
export function makeGltfRig(scene) {
	const rig = new GltfRig(scene);
	if (!rig.hasSkeleton) return null;
	rig.captureRest();
	return rig;
}
