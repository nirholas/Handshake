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
import { canonicalizeBoneName as normalizeBoneName } from './glb-canonicalize.js';
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

// Mannequin joint hierarchy (parent per joint), mirroring Mannequin's build
// order. Needed to compose a preset's per-joint local rotations into the
// world-frame deltas that applyPose() replays on any rig's rest pose.
const MANNEQUIN_PARENT = {
	pelvis: null,
	spine: 'pelvis', chest: 'spine', neck: 'chest', head: 'neck',
	shoulderL: 'chest', elbowL: 'shoulderL', wristL: 'elbowL',
	shoulderR: 'chest', elbowR: 'shoulderR', wristR: 'elbowR',
	hipL: 'pelvis', kneeL: 'hipL', ankleL: 'kneeL',
	hipR: 'pelvis', kneeR: 'hipR', ankleR: 'kneeR',
};
const MANNEQUIN_JOINT_ORDER = Object.keys(MANNEQUIN_PARENT);

// Presets are ABSOLUTE poses authored against the mannequin's reference stance
// (standing, arms hanging at the sides). A loaded GLB can bind in any stance
// (Mixamo T-pose, Avaturn A-pose), so before replaying a preset's world deltas
// we align each bone from its bind direction to the reference direction its
// canonical joint has on the mannequin. Directions are measured bone→child at
// bind; bones without a measurable child (head, hands, fingers, toes) inherit
// the nearest measured ancestor's alignment so the whole limb moves as one.
const REFERENCE_DIR = {
	Hips: [0, 1, 0], Spine: [0, 1, 0], Spine1: [0, 1, 0], Spine2: [0, 1, 0], Neck: [0, 1, 0],
	LeftShoulder: [1, 0, 0], LeftArm: [0, -1, 0], LeftForeArm: [0, -1, 0],
	RightShoulder: [-1, 0, 0], RightArm: [0, -1, 0], RightForeArm: [0, -1, 0],
	LeftUpLeg: [0, -1, 0], LeftLeg: [0, -1, 0],
	RightUpLeg: [0, -1, 0], RightLeg: [0, -1, 0],
	LeftFoot: [0, -0.29, 0.96], RightFoot: [0, -0.29, 0.96],
};
const DIRECTION_CHILD = {
	Hips: ['Spine', 'Spine1', 'Spine2', 'Neck'],
	Spine: ['Spine1', 'Spine2', 'Neck'],
	Spine1: ['Spine2', 'Neck'],
	Spine2: ['Neck', 'Head'],
	Neck: ['Head'],
	LeftShoulder: ['LeftArm'], LeftArm: ['LeftForeArm'], LeftForeArm: ['LeftHand'],
	RightShoulder: ['RightArm'], RightArm: ['RightForeArm'], RightForeArm: ['RightHand'],
	LeftUpLeg: ['LeftLeg'], LeftLeg: ['LeftFoot'], LeftFoot: ['LeftToeBase'],
	RightUpLeg: ['RightLeg'], RightLeg: ['RightFoot'], RightFoot: ['RightToeBase'],
};

// normalize(canonical) → canonical, so an arbitrary GLB bone name (mixamorig:,
// case, separators) can be matched to a canonical bone via normalizeBoneName().
const NORMALIZED_CANONICAL = new Map(
	CANONICAL_BONES.map((c) => [normalizeBoneName(c), c]),
);

// Left ↔ right bone name (canonical). Center bones (Hips, Spine, Head…) map to
// themselves. Used to mirror a pose across the sagittal plane.
export function mirrorBoneName(key) {
	if (key.startsWith('Left')) return `Right${key.slice(4)}`;
	if (key.startsWith('Right')) return `Left${key.slice(5)}`;
	return key;
}

// Reflect a world-space rotation across the x=0 (sagittal) plane: conjugation by
// diag(-1,1,1) keeps x, negates y and z. Operates in place on a THREE.Quaternion.
export function reflectWorldQuaternion(q) {
	return q.set(q.x, -q.y, -q.z, q.w);
}

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

	/**
	 * Snapshot the rig's rest pose: each posable bone's LOCAL bind rotation and
	 * its WORLD (within-model) bind rotation. Both rigs call this once while
	 * still in bind pose; applyPose()/the FK sliders express rotations as
	 * deltas on top of these, so the same preset lands identically on the
	 * mannequin (identity rest) and on a GLB whose bones carry bind rotations.
	 */
	captureRest() {
		this._restLocal = new Map();
		this._restWorld = new Map();
		for (const [key, node] of this.bones) {
			this._restLocal.set(key, node.quaternion.clone());
			this._restWorld.set(key, this._parentQuat(node).multiply(node.quaternion));
		}
		this._restRootPos = this.root ? this.root.position.clone() : new Vector3();
		this._captureReferenceStance();
	}

	// Compute _restRef: each bone's world rotation in the REFERENCE stance
	// (arms at the sides — the frame presets are authored in), by rotating its
	// bind orientation from its measured bind direction onto the reference
	// direction. On the mannequin every direction already matches, so the
	// alignment is identity and _restRef === _restWorld (identity).
	_captureReferenceStance() {
		this._restRef = new Map();
		if (!this.root) return;
		this.root.updateMatrixWorld(true);
		const keyByNode = new Map();
		for (const [key, node] of this.bones) keyByNode.set(node, key);
		const posInRoot = (node) =>
			this.root.worldToLocal(node.getWorldPosition(new Vector3()));
		const aligns = new Map();
		for (const key of CANONICAL_BONES) {
			const node = this.bones.get(key);
			if (!node) continue;
			let align = null;
			const ref = REFERENCE_DIR[key];
			const childKey = (DIRECTION_CHILD[key] || []).find((k) => this.bones.has(k));
			if (ref && childKey) {
				const dir = posInRoot(this.bones.get(childKey)).sub(posInRoot(node));
				if (dir.lengthSq() > 1e-10) {
					align = new Quaternion().setFromUnitVectors(
						dir.normalize(),
						new Vector3(ref[0], ref[1], ref[2]).normalize(),
					);
				}
			}
			if (!align) {
				// Leaf / unmeasurable bone: inherit the nearest canonical ancestor's
				// alignment (CANONICAL_BONES order guarantees ancestors are done).
				for (let n = node.parent; n && n !== this.root; n = n.parent) {
					const ancestorKey = keyByNode.get(n);
					if (ancestorKey && aligns.has(ancestorKey)) {
						align = aligns.get(ancestorKey);
						break;
					}
				}
			}
			aligns.set(key, align || new Quaternion());
			this._restRef.set(
				key,
				(align ? align.clone() : new Quaternion()).multiply(this._restWorld.get(key)),
			);
		}
	}

	// Composed rotation of a node's ancestors up to (excluding) the rig root —
	// the pure-quaternion frame both rest capture and delta application share.
	_parentQuat(node) {
		const chain = [];
		for (let n = node?.parent; n && n !== this.root; n = n.parent) chain.push(n);
		const q = new Quaternion();
		for (let i = chain.length - 1; i >= 0; i--) q.multiply(chain[i].quaternion);
		return q;
	}

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
		if (pose.worldDeltas) {
			this._applyWorldDeltas(pose.worldDeltas);
		} else {
			const bones = pose.bones || pose; // tolerate a bare bones map
			for (const [key, v] of Object.entries(bones)) {
				if (key === 'rootPosition') continue;
				const node = this.bones.get(key);
				if (!node || !Array.isArray(v) || v.length < 4) continue;
				node.quaternion.set(v[0], v[1], v[2], v[3]);
			}
		}
		const rp = pose.rootPosition;
		if (rp && this.root) this.root.position.set(rp.x || 0, rp.y || 0, rp.z || 0);
	}

	// Replay a preset's world-frame rotation deltas on this rig: worldTarget =
	// delta · restRef, where restRef is the bone's orientation in the REFERENCE
	// stance (bind aligned to arms-at-sides), reprojected into the bone's live
	// parent frame. Root→leaf order (CANONICAL_BONES is topological) so each
	// parent's new rotation is current before its children reproject. On the
	// mannequin (identity rest, matching stance) this reproduces the preset's
	// local Eulers exactly; on a GLB it lands the same absolute pose regardless
	// of whether the avatar binds in a T-pose or an A-pose.
	_applyWorldDeltas(deltas) {
		if (!this._restRef) this.captureRest();
		const worldTarget = new Quaternion();
		for (const key of CANONICAL_BONES) {
			const v = deltas[key];
			if (!Array.isArray(v) || v.length < 4) continue;
			const node = this.bones.get(key);
			const restRef = this._restRef.get(key);
			if (!node || !restRef) continue;
			worldTarget.set(v[0], v[1], v[2], v[3]).multiply(restRef);
			node.quaternion.copy(this._parentQuat(node).invert().multiply(worldTarget));
		}
	}

	/**
	 * Resolve a pose to the per-bone LOCAL quaternions it produces on this rig,
	 * without leaving the rig posed. Used by surfaces that tween toward a pose
	 * (agent-screen's live pose driver) instead of snapping applyPose().
	 * @returns {Map<string, Quaternion>} canonical bone key → target local quat
	 */
	localTargetsForPose(pose) {
		const saved = [];
		const record = (node) => saved.push({
			node,
			pos: node.position.clone(),
			quat: node.quaternion.clone(),
			scale: node.scale.clone(),
		});
		const seen = new Set();
		for (const sm of this.skinnedMeshes || []) {
			for (const bone of sm.skeleton?.bones || []) {
				if (!seen.has(bone)) { seen.add(bone); record(bone); }
			}
		}
		for (const node of this.bones.values()) {
			if (!seen.has(node)) { seen.add(node); record(node); }
		}
		const rootPos = this.root ? this.root.position.clone() : null;
		this.applyPose(pose);
		// Only bones the pose names get targets — callers blend those on top of
		// whatever (idle animation, live tracking) drives the rest of the body.
		const named = pose?.worldDeltas || pose?.bones || pose || {};
		const targets = new Map();
		for (const key of Object.keys(named)) {
			if (key === 'rootPosition') continue;
			const node = this.bones.get(key);
			if (node) targets.set(key, node.quaternion.clone());
		}
		for (const { node, pos, quat, scale } of saved) {
			node.position.copy(pos);
			node.quaternion.copy(quat);
			node.scale.copy(scale);
		}
		if (rootPos && this.root) this.root.position.copy(rootPos);
		return targets;
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

	// Mirror the current pose left ↔ right. Works on any rig (mannequin or GLB),
	// including ones whose left/right rest frames aren't symmetric, by mirroring
	// in WORLD space and reprojecting each bone into its own parent frame. Bones
	// are processed root→leaf (CANONICAL_BONES order is topological) so each
	// parent's new world rotation is current before its children reproject.
	mirrorPose() {
		if (!this.root) return;
		this.root.updateWorldMatrix(true, true);
		const ordered = this.getBones();
		// Snapshot every posable bone's ORIGINAL world rotation first, so swaps
		// read pre-mirror values and the operation is its own inverse.
		const origWorld = new Map();
		for (const { key, node } of ordered) {
			origWorld.set(key, node.getWorldQuaternion(new Quaternion()));
		}
		const parentWorld = new Quaternion();
		for (const { key, node } of ordered) {
			const source = origWorld.get(mirrorBoneName(key)) || origWorld.get(key);
			const targetWorld = reflectWorldQuaternion(source.clone());
			if (node.parent) {
				node.parent.getWorldQuaternion(parentWorld);
				node.quaternion.copy(parentWorld.invert().multiply(targetWorld));
			} else {
				node.quaternion.copy(targetWorld);
			}
			node.updateWorldMatrix(false, false);
		}
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
		this.captureRest();
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
		this.captureRest();
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

	// Snapshot every skeleton bone's local TRS as the rest pose. Deliberately
	// NOT skeleton.pose(): inverse-bind matrices live in the skin's own frame,
	// and on plenty of exports (Mixamo cm-scale — michelle.glb, xbot.glb) that
	// frame differs from the node graph's, so reconstructing "bind" from them
	// collapses the avatar to 1% scale. The node transforms at load ARE the
	// authored bind pose; trust them.
	captureRest() {
		this._restNodes = [];
		const seen = new Set();
		const record = (node) => {
			if (seen.has(node)) return;
			seen.add(node);
			this._restNodes.push({
				node,
				pos: node.position.clone(),
				quat: node.quaternion.clone(),
				scale: node.scale.clone(),
			});
		};
		for (const sm of this.skinnedMeshes) {
			for (const bone of sm.skeleton?.bones || []) record(bone);
		}
		for (const node of this.bones.values()) record(node);
		super.captureRest();
	}

	resetPose() {
		// Restore every bone (skeleton + loose) to its captured rest transform.
		for (const { node, pos, quat, scale } of this._restNodes || []) {
			node.position.copy(pos);
			node.quaternion.copy(quat);
			node.scale.copy(scale);
		}
		if (this._restRootPos) this.root.position.copy(this._restRootPos);
	}

	// FK sliders and "reset this bone" speak model-frame deltas from rest, the
	// same convention the mannequin's zeroed joints give for free. Without this
	// a GLB bone's sliders show its raw bind rotation (e.g. 94°/90° on an
	// untouched shoulder) and zeroing them wipes the bind pose entirely.
	getBoneEuler(key) {
		const node = this.bones.get(key);
		const restWorld = this._restWorld?.get(key);
		if (!node || !restWorld) return super.getBoneEuler(key);
		const world = this._parentQuat(node).multiply(node.quaternion);
		const delta = world.multiply(restWorld.clone().invert());
		const e = new Euler().setFromQuaternion(delta, 'XYZ');
		return { x: e.x, y: e.y, z: e.z };
	}

	setBoneEuler(key, { x = 0, y = 0, z = 0 }) {
		const node = this.bones.get(key);
		const restWorld = this._restWorld?.get(key);
		if (!node || !restWorld) return super.setBoneEuler(key, { x, y, z });
		const delta = new Quaternion().setFromEuler(new Euler(x, y, z, 'XYZ'));
		const worldTarget = delta.multiply(restWorld);
		node.quaternion.copy(this._parentQuat(node).invert().multiply(worldTarget));
	}
}

// Convert a legacy mannequin preset ({ jointName: {x,y,z} Euler, rootPosition })
// into a canonical pose that applies to any rig uniformly.
//
// `bones` keeps the raw local quaternions (mannequin frame, identity rest) for
// callers that address the mannequin convention directly. `worldDeltas` is what
// applyPose() consumes: each joint's preset rotation composed down the mannequin
// hierarchy. Because every mannequin joint rests at identity, that chain product
// IS the joint's world-frame rotation delta — replayable on top of any rig's
// own rest pose, so the same preset reads correctly on a GLB avatar whose bones
// carry bind rotations (where the raw locals used to garble every pose).
export function poseFromMannequinPreset(presetPose) {
	const bones = {};
	const local = new Map();
	for (const [joint, rot] of Object.entries(presetPose || {})) {
		if (joint === 'rootPosition' || !rot) continue;
		const canonical = MANNEQUIN_TO_CANONICAL[joint];
		if (!canonical) continue;
		const q = new Quaternion().setFromEuler(new Euler(rot.x || 0, rot.y || 0, rot.z || 0, 'XYZ'));
		bones[canonical] = [q.x, q.y, q.z, q.w];
		local.set(joint, q);
	}
	const worldDeltas = {};
	const composed = new Map(); // joint → chain product root→joint
	for (const joint of MANNEQUIN_JOINT_ORDER) {
		const parent = MANNEQUIN_PARENT[joint];
		const q = (parent ? composed.get(parent).clone() : new Quaternion())
			.multiply(local.get(joint) || new Quaternion());
		composed.set(joint, q);
		if (local.has(joint)) {
			const canonical = MANNEQUIN_TO_CANONICAL[joint];
			worldDeltas[canonical] = [q.x, q.y, q.z, q.w];
		}
	}
	const pose = { bones, worldDeltas };
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
