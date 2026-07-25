// Runtime animation retargeting — apply a canonical-skeleton clip to an
// arbitrary rigged model whose bones may be named differently (Mixamo, Blender,
// Rigify, snake_case, …) and proportioned differently (tall, short, chunky).
//
// The pre-baked library in /public/animations/clips addresses tracks by the
// canonical Avaturn bone names (Hips, Spine, LeftArm, …). A loaded GLB rig might
// name the same bones `mixamorig:Hips`, `DEF-spine`, `left_arm`, etc. To drive
// (and export) that rig we rewrite each track's bone name to the *actual* node
// name on the target, drop tracks the rig has no bone for, and rescale the hip
// translation so root motion lands at the new rig's height instead of the
// authoring rig's. We retarget only the true-motion channels — joint rotations
// and the root (Hips) translation — and skip the clips' per-bone position/scale
// channels, which encode the *authoring* rig's bone lengths and would crush a
// differently-proportioned avatar into a heap. The result binds cleanly in both
// THREE.AnimationMixer (preview) and THREE.GLTFExporter (animated-GLB export).
//
// Pure module — three + the canonicalizer only — so it runs unchanged in the
// browser (the /pose gallery) and in Node (the apply_animation MCP tool, vitest).

import { AnimationClip, Box3, Quaternion, Vector3 } from 'three';
import { canonicalizeBoneName } from './glb-canonicalize.js';
import { CANONICAL_REST, CANONICAL_REST_WORLD } from './animation-canonical-rest.js';

// A clip retargets cleanly only when enough of its tracks find a home on the
// target rig. Below this the motion would read as a few twitching joints rather
// than a performance, so callers surface an actionable "can't retarget" error.
export const MIN_COVERAGE = 0.5;

// Rest (bind-pose) local rotation of each canonical bone *on the authoring rig*
// the clips were baked against (the Avaturn-rigged public/avatars/cz.glb). The
// library stores absolute local rotations, so a clip only looks right when the
// target bone's rest matches the authoring rest — otherwise we must replay the
// motion in the target's own rest frame (see `bindCorrections`).
//
// The full skeleton is covered (generated from cz.glb into
// animation-canonical-rest.js), not just Hips. Hips carries the up-axis
// convention — Mixamo/FBX bake a +90°X on the armature and a −90°X on Hips, and
// copying the clip's Hips rotation verbatim wipes that out and tips the body onto
// its back. The limb bones carry the pose convention — cz rests in an A-pose,
// Mixamo in a T-pose — so without per-limb correction an upright avatar still
// plays clips with the arms/legs in the wrong frame. Because the values are cz's
// own rest, retargeting back onto cz yields an identity correction per bone
// (skipped below), so a matching rig round-trips byte-for-byte.
const SOURCE_REST = new Map(
	Object.entries(CANONICAL_REST).map(([bone, q]) => [bone, new Quaternion(q[0], q[1], q[2], q[3])]),
);

// World-space (model-frame) bind rotation of each canonical bone on the authoring
// rig. Paired with SOURCE_REST so the bind correction can preserve a clip bone's
// *world* motion delta (not just its local deviation) when the target rig rests
// in a different pose — see `bindCorrections`.
const SOURCE_WORLD_REST = new Map(
	Object.entries(CANONICAL_REST_WORLD).map(([bone, q]) => [
		bone,
		new Quaternion(q[0], q[1], q[2], q[3]),
	]),
);

// A quaternion within this of identity (|w| ≈ 1) is treated as no rotation, so a
// rig that already matches the authoring convention round-trips bit-for-bit.
const BIND_EPSILON = 1e-6;

// Track property prefix for a blendshape lane, e.g.
// `Face.morphTargetInfluences[browInnerUp]`.
const MORPH_PROPERTY = 'morphTargetInfluences[';

const _v = new Vector3();
const _q = new Quaternion();

/**
 * @typedef {Object} RetargetResult
 * @property {AnimationClip|null} clip   Retargeted clip (track names rewritten to
 *   the target's bone names), or null when coverage is below MIN_COVERAGE.
 * @property {number} matched   Tracks successfully mapped onto the target.
 * @property {number} total     Tracks in the source clip.
 * @property {number} coverage  matched / total (0–1).
 * @property {string[]} dropped Canonical bone names the target rig lacks.
 * @property {number} hipScale  Factor applied to hip translation (1 = none).
 * @property {number} face      Blendshape lanes bound on the target (0 = no face).
 */

/**
 * Build a `canonical bone → target node name` map by walking an Object3D graph.
 * Used server-side (apply_animation) where there's no GltfRig wrapper. Prefers
 * SkinnedMesh skeleton bones, falls back to any named Bone nodes.
 *
 * @param {import('three').Object3D} root
 * @returns {Map<string,string>}
 */
export function canonicalNodeMapFromObject(root) {
	const map = new Map();
	const consider = (node) => {
		if (!node?.name) return;
		const canonical = canonicalizeBoneName(node.name);
		if (canonical && !map.has(canonical)) map.set(canonical, node.name);
	};
	const skinned = [];
	root.traverse((node) => {
		if (node.isSkinnedMesh) skinned.push(node);
		if (node.isBone) consider(node);
	});
	for (const sm of skinned) {
		for (const bone of sm.skeleton?.bones || []) consider(bone);
	}
	return map;
}

/**
 * Build the same map from a GltfRig/MannequinRig (src/pose-rig.js), which has
 * already resolved canonical → node. We read each node's live `.name` so the
 * rewritten track binds to the real graph node.
 *
 * @param {{ getBones: () => Array<{key:string,node:import('three').Object3D}> }} rig
 * @returns {Map<string,string>}
 */
export function canonicalNodeMapFromRig(rig) {
	const map = new Map();
	for (const { key, node } of rig.getBones?.() || []) {
		if (node?.name) map.set(key, node.name);
	}
	return map;
}

/**
 * Capture each canonical bone's rest (bind-pose) local rotation by walking an
 * Object3D graph — the companion to {@link canonicalNodeMapFromObject}, read in
 * the same first-bone-wins order so the rest quaternion belongs to the very node
 * a track gets renamed onto. Call while the model is in its authored bind pose
 * (i.e. before any clip has been sampled), which is the case at attach time.
 *
 * @param {import('three').Object3D} root
 * @returns {Map<string,import('three').Quaternion>}
 */
export function canonicalRestMapFromObject(root) {
	const map = new Map();
	const consider = (node) => {
		if (!node?.name) return;
		const canonical = canonicalizeBoneName(node.name);
		if (canonical && !map.has(canonical)) map.set(canonical, node.quaternion.clone());
	};
	const skinned = [];
	root.traverse((node) => {
		if (node.isSkinnedMesh) skinned.push(node);
		if (node.isBone) consider(node);
	});
	for (const sm of skinned) {
		for (const bone of sm.skeleton?.bones || []) consider(bone);
	}
	return map;
}

/**
 * Rest-rotation map from a GltfRig/MannequinRig, mirroring
 * {@link canonicalNodeMapFromRig}.
 *
 * @param {{ getBones: () => Array<{key:string,node:import('three').Object3D}> }} rig
 * @returns {Map<string,import('three').Quaternion>}
 */
export function canonicalRestMapFromRig(rig) {
	const map = new Map();
	for (const { key, node } of rig.getBones?.() || []) {
		if (node && !map.has(key)) map.set(key, node.quaternion.clone());
	}
	return map;
}

// World (model-frame) bind rotation of a node: the pure-quaternion product of its
// ancestors' rotations down to `stopAt` (exclusive), times the node's own. Stops
// at the model root so a placement rotation the viewer applies to the whole avatar
// is excluded — the same frame SOURCE_WORLD_REST is measured in. Requires local
// rotations to be at bind pose (true at attach time).
function worldRestQuat(node, stopAt) {
	const q = node.quaternion.clone();
	for (let n = node.parent; n && n !== stopAt; n = n.parent) q.premultiply(n.quaternion);
	return q;
}

/**
 * World bind-rotation map by walking an Object3D graph — the world-frame companion
 * to {@link canonicalRestMapFromObject}, read in the same first-bone-wins order.
 * Excludes `root` so it matches {@link hipsParentWorldQuat}'s within-model frame.
 *
 * @param {import('three').Object3D} root
 * @returns {Map<string,import('three').Quaternion>}
 */
export function canonicalWorldRestMapFromObject(root) {
	const map = new Map();
	const consider = (node) => {
		if (!node?.name) return;
		const canonical = canonicalizeBoneName(node.name);
		if (canonical && !map.has(canonical)) map.set(canonical, worldRestQuat(node, root));
	};
	const skinned = [];
	root.traverse((node) => {
		if (node.isSkinnedMesh) skinned.push(node);
		if (node.isBone) consider(node);
	});
	for (const sm of skinned) {
		for (const bone of sm.skeleton?.bones || []) consider(bone);
	}
	return map;
}

/**
 * World bind-rotation map from a GltfRig/MannequinRig. The rig is posed at the
 * origin (within-model == world), so we compose all the way to the top.
 *
 * @param {{ getBones: () => Array<{key:string,node:import('three').Object3D}> }} rig
 * @returns {Map<string,import('three').Quaternion>}
 */
export function canonicalWorldRestMapFromRig(rig) {
	const map = new Map();
	for (const { key, node } of rig.getBones?.() || []) {
		if (node && !map.has(key)) map.set(key, worldRestQuat(node, null));
	}
	return map;
}

/**
 * Map every blendshape name the target carries to the mesh nodes that own it, so
 * a face lane authored once can be re-pointed at this avatar. Faces are commonly
 * split across several meshes (head, teeth, brows), and all of them need driving.
 *
 * @param {import('three').Object3D} root
 * @returns {Map<string,string[]>}
 */
export function morphTargetMapFromObject(root) {
	const map = new Map();
	root.traverse((node) => {
		if (!node?.morphTargetDictionary || !node.name) return;
		for (const shape of Object.keys(node.morphTargetDictionary)) {
			if (!map.has(shape)) map.set(shape, []);
			const meshes = map.get(shape);
			if (!meshes.includes(node.name)) meshes.push(node.name);
		}
	});
	return map;
}

/**
 * Per-bone bind correction `{L, R}` such that `q' = L · q · R` re-expresses a clip
 * bone's keyframe so it produces the SAME world-space rotation delta on a target
 * rig that rests in a different pose:
 *
 *   L = Rt · WT⁻¹ · WS · Rs⁻¹      R = WS⁻¹ · WT
 *
 * where Rs/Rt are the source/target LOCAL bind rotations and WS/WT their WORLD
 * (model-frame) bind rotations. This is the standard world-delta-preserving
 * retarget (trgLocal = WTp⁻¹·WSp · q · WS⁻¹·WT, with the parent worlds derived as
 * WSp = WS·Rs⁻¹, WTp = WT·Rt⁻¹). It collapses to:
 *   • the pure axis-convention reframe for the Hips (different parent frame, same
 *     world rest — e.g. a Mixamo Hips baked at −90°X), and
 *   • the correct limb reframe for an A-pose clip on a T-pose rig, which a
 *     local-only `Rt·Rs⁻¹` premultiply skewed by ~30°.
 *
 * When world rests are unavailable we fall back to the prior local-only premultiply
 * (`L = Rt·Rs⁻¹`, `R = I`) so callers that don't supply them still work. Bones whose
 * correction is identity are omitted, so a matching rig skips the work and
 * round-trips unchanged.
 *
 * @param {Map<string,import('three').Quaternion>|null} targetRest        target LOCAL bind
 * @param {Map<string,import('three').Quaternion>|null} [targetWorldRest] target WORLD bind
 * @returns {Map<string,{L:import('three').Quaternion,R:import('three').Quaternion|null}>}
 */
function bindCorrections(targetRest, targetWorldRest) {
	const out = new Map();
	if (!(targetRest instanceof Map)) return out;
	const haveWorld = targetWorldRest instanceof Map;
	for (const [canonical, Rs] of SOURCE_REST) {
		const Rt = targetRest.get(canonical);
		if (!Rt) continue;
		const WS = SOURCE_WORLD_REST.get(canonical);
		const WT = haveWorld ? targetWorldRest.get(canonical) : null;
		let L;
		let R = null;
		if (WS && WT) {
			// L = Rt · WT⁻¹ · WS · Rs⁻¹
			L = Rt.clone()
				.multiply(WT.clone().invert())
				.multiply(WS)
				.multiply(Rs.clone().invert());
			// R = WS⁻¹ · WT
			R = WS.clone().invert().multiply(WT);
			if (1 - Math.abs(R.w) < BIND_EPSILON) R = null; // identity post-factor
		} else {
			// Fallback: local-only premultiply (prior behaviour).
			L = Rt.clone().multiply(Rs.clone().invert());
		}
		const identityL = 1 - Math.abs(L.w) < BIND_EPSILON;
		if (identityL && !R) continue; // nothing to do → round-trips unchanged
		out.set(canonical, { L: identityL ? null : L, R });
	}
	return out;
}

// Apply the bind correction `q ← L · q · R` to every [x,y,z,w] keyframe in place.
// Either factor may be null (identity).
function correctQuaternionTrack(values, { L, R }) {
	for (let i = 0; i < values.length; i += 4) {
		_q.set(values[i], values[i + 1], values[i + 2], values[i + 3]);
		if (L) _q.premultiply(L);
		if (R) _q.multiply(R);
		values[i] = _q.x;
		values[i + 1] = _q.y;
		values[i + 2] = _q.z;
		values[i + 3] = _q.w;
	}
}

// Rotate every [x,y,z] keyframe of a position track by `c` in place, so root
// motion stays aligned once the parent armature's axis convention is corrected.
function rotateVectorTrack(values, c) {
	for (let i = 0; i < values.length; i += 3) {
		_v.set(values[i], values[i + 1], values[i + 2]).applyQuaternion(c);
		values[i] = _v.x;
		values[i + 1] = _v.y;
		values[i + 2] = _v.z;
	}
}

// Rotation to apply to the Hips position (root-motion) track. The clip authors
// hip translation in the authoring rig's hips-parent frame, whose world rotation
// is identity (cz's armature has none). To preserve world motion on the target,
// rotate by the inverse of the target's hips-parent world rotation. When the
// caller can't supply that (a bare retargetClip call), fall back to the Hips
// bone correction — exact for any rig whose hips are upright at bind, i.e. every
// real humanoid. Returns null when no rotation is needed.
function hipPositionCorrection(hipsParentWorldQuat, corrections) {
	if (hipsParentWorldQuat) {
		const q = hipsParentWorldQuat.isQuaternion
			? hipsParentWorldQuat.clone()
			: new Quaternion(
					hipsParentWorldQuat[0],
					hipsParentWorldQuat[1],
					hipsParentWorldQuat[2],
					hipsParentWorldQuat[3],
				);
		q.invert();
		return 1 - Math.abs(q.w) < BIND_EPSILON ? null : q;
	}
	// Fallback: the Hips correction's premultiply (parent-frame) factor, which for
	// the Hips carries the axis-convention reframe (its post-factor is identity
	// when source and target share a world rest).
	return corrections.get('Hips')?.L || null;
}

/**
 * World rotation of the target Hips' parent, measured *within the model* (i.e.
 * relative to `root`, so a placement rotation the viewer applies to the whole
 * avatar is excluded). Inverting it lets {@link retargetClip} re-express a clip's
 * authored hip translation in the target's hips-parent frame, so root motion
 * travels the same world direction on a Mixamo `+90°X` armature, an RPM rig, etc.
 * Requires the graph's local rotations to be at bind pose (true at attach time).
 *
 * @param {import('three').Object3D} root
 * @returns {import('three').Quaternion|null}
 */
export function hipsParentWorldQuat(root) {
	let hips = null;
	root.traverse((n) => {
		if (!hips && n.isBone && n.name && canonicalizeBoneName(n.name) === 'Hips') hips = n;
	});
	if (!hips) {
		root.traverse((n) => {
			if (!hips && n.name && canonicalizeBoneName(n.name) === 'Hips') hips = n;
		});
	}
	if (!hips || !hips.parent) return null;
	const q = new Quaternion();
	for (let n = hips.parent; n && n !== root; n = n.parent) q.premultiply(n.quaternion);
	return q;
}

/**
 * World-space rest height of the target's hips, used to scale root translation
 * onto a differently-sized rig. Returns 0 if it can't be determined (callers
 * then skip hip scaling). Requires world matrices to be current.
 *
 * @param {{ getNode: (k:string) => import('three').Object3D|null }} rig
 * @returns {number}
 */
export function hipRestHeight(rig) {
	const hips = rig.getNode?.('Hips');
	if (!hips) return 0;
	hips.updateWorldMatrix(true, false);
	hips.getWorldPosition(_v);
	return _v.y;
}

// Bounding-box bottom of the model, or NaN when it can't be computed. Guarded:
// three's pose-aware SkinnedMesh.computeBoundingBox walks skin attributes per
// vertex and throws on synthetic rigs whose geometry lacks them; a rig we can't
// measure just keeps the pre-floor behavior instead of failing the mount.
function safeFloorY(root) {
	try {
		return new Box3().setFromObject(root).min.y;
	} catch {
		return NaN;
	}
}

const _hipScalePos = new Vector3();
const _hipScaleQuat = new Quaternion();
const _hipScaleScale = new Vector3();

/**
 * Rest height of an Object3D rig's Hips expressed in the *hips-parent's local
 * units*, i.e. world height divided by the parent's accumulated world scale.
 * Hip-position tracks are authored in metres and set the Hips bone's *local*
 * position, so the scale factor that lands them at the right place is this local
 * height ÷ the clip's authored baseline — not the world height. The two agree
 * for a metre-native rig (parent scale ≈ 1) but diverge hard for a centimetre
 * rig (e.g. a Mixamo armature exported at `scale 0.01`, whose Hips local sits
 * near −100): matching world heights there would collapse the hip track to ~1cm
 * of motion and sink the avatar a metre into the floor. Returns 0 when the hips
 * or a usable parent scale can't be determined (caller then skips hip scaling).
 *
 * @param {import('three').Object3D} root
 * @returns {number}
 */
export function hipRestLocalHeight(root) {
	let hips = null;
	root.traverse((n) => {
		if (!hips && n.isBone && n.name && canonicalizeBoneName(n.name) === 'Hips') hips = n;
	});
	if (!hips) {
		root.traverse((n) => {
			if (!hips && n.name && canonicalizeBoneName(n.name) === 'Hips') hips = n;
		});
	}
	if (!hips || !hips.parent) return 0;
	hips.updateWorldMatrix(true, false);
	hips.getWorldPosition(_hipScalePos);
	let worldY = _hipScalePos.y;
	// Measure above the model's own floor (its bounding-box bottom), not above
	// world y=0. Viewers recenter content around the origin (setContent
	// subtracts the bbox center) and origin-centered GLB exports put the floor
	// below zero; measured from world zero, both read as "hips at or below the
	// ground", which skipped scaling and let the metre-authored hip track fling
	// a small rig into the air. Clips author ground at 0, so hips-above-floor
	// is the like-for-like height. For a ground-native rig floorY is 0 and
	// nothing changes.
	const floorY = safeFloorY(root);
	if (Number.isFinite(floorY)) worldY -= floorY;
	hips.parent.matrixWorld.decompose(_hipScalePos, _hipScaleQuat, _hipScaleScale);
	const parentScale = (_hipScaleScale.x + _hipScaleScale.y + _hipScaleScale.z) / 3;
	if (!(parentScale > 1e-6) || !(worldY > 0) || !Number.isFinite(worldY)) return 0;
	return worldY / parentScale;
}

/**
 * The model's floor (bounding-box bottom) expressed in the hips-parent's local
 * frame — the Y a hip-position track must be offset by so the clip's ground
 * (authored at 0) lands on this rig's actual ground. 0 for a ground-native rig
 * (floor at local 0); negative for an origin-centered export (floor below the
 * local origin). Returns 0 when it can't be determined, which leaves the
 * retarget exactly as before.
 *
 * @param {import('three').Object3D} root
 * @returns {number}
 */
export function hipGroundLocalY(root) {
	let hips = null;
	root.traverse((n) => {
		if (!hips && n.isBone && n.name && canonicalizeBoneName(n.name) === 'Hips') hips = n;
	});
	if (!hips) {
		root.traverse((n) => {
			if (!hips && n.name && canonicalizeBoneName(n.name) === 'Hips') hips = n;
		});
	}
	if (!hips || !hips.parent) return 0;
	hips.updateWorldMatrix(true, false);
	const floorY = safeFloorY(root);
	if (!Number.isFinite(floorY)) return 0;
	hips.getWorldPosition(_hipScalePos);
	// The floor point under the hips, mapped into the parent's local frame so
	// the offset composes with the track's local-position values.
	const local = hips.parent.worldToLocal(new Vector3(_hipScalePos.x, floorY, _hipScalePos.z));
	return Number.isFinite(local.y) ? local.y : 0;
}

// First Y value of a `Hips.position` track — the height the clip's root motion
// was authored around. The retarget scales other-height rigs by target/source.
export function clipHipBaselineY(clip) {
	const track = clip.tracks.find(
		(t) =>
			t.name.endsWith('.position') && canonicalizeBoneName(t.name.split('.')[0]) === 'Hips',
	);
	if (!track || track.values.length < 3) return 0;
	return track.values[1]; // [x, y, z, …] — Y of the first keyframe
}

/**
 * Core rewrite. Splits each track into `bone.property`, canonicalizes the bone,
 * looks up the target's node name, and emits a renamed track. Hip position
 * tracks are scaled by `hipScale`. Returns null clip when coverage is too low.
 *
 * @param {AnimationClip} clip
 * @param {Map<string,string>} canonicalToNode
 * @param {{ hipScale?: number, hipOffsetY?: number, minCoverage?: number, morphTargets?: Map<string,string[]> }} [opts]
 * @returns {RetargetResult}
 */
export function retargetClip(clip, canonicalToNode, opts = {}) {
	const hipScale = Number.isFinite(opts.hipScale) && opts.hipScale > 0 ? opts.hipScale : 1;
	const hipOffsetY = Number.isFinite(opts.hipOffsetY) ? opts.hipOffsetY : 0;
	const minCoverage = opts.minCoverage ?? MIN_COVERAGE;
	const corrections = bindCorrections(opts.targetRest, opts.targetWorldRest);
	const hipsPosCorrection = hipPositionCorrection(opts.hipsParentWorldQuat, corrections);
	const dropped = [];
	const tracks = [];
	const faceTracks = [];
	// Denominator counts only *retargetable* tracks (see below), so a clip baked
	// with per-bone position/scale channels still reports honest coverage.
	let total = 0;

	for (const track of clip.tracks) {
		const dot = track.name.indexOf('.');
		if (dot === -1) continue;
		const boneRaw = track.name.slice(0, dot);
		const property = track.name.slice(dot + 1);

		// Face (morph-target) lanes. Signing carries grammar on the face — raised
		// brows make a question, furrowed brows a wh-question — so a clip may drive
		// blendshapes as well as bones. They are authored against a placeholder node
		// (`Face.morphTargetInfluences[browInnerUp]`) and re-pointed here at whatever
		// mesh on THIS avatar owns that shape, because the mesh is named differently
		// on every rig and a face is often split across several. An avatar with no
		// such shape simply loses the lane: the sign still performs, just without the
		// marker. They never count toward bone coverage, so a face-less rig is not
		// judged to have failed the retarget.
		if (property.startsWith(MORPH_PROPERTY)) {
			const shape = property.slice(MORPH_PROPERTY.length, -1);
			const meshes = opts.morphTargets instanceof Map ? opts.morphTargets.get(shape) : null;
			if (!meshes?.length) {
				dropped.push(shape);
				continue;
			}
			for (const meshName of meshes) {
				const next = track.clone();
				next.name = `${meshName}.${property}`;
				faceTracks.push(next);
			}
			continue;
		}

		const canonical = canonicalizeBoneName(boneRaw) || boneRaw;

		// The clips are baked from cz with a full position/quaternion/scale channel
		// per bone. A bone's local scale and its local position (its fixed offset
		// from its parent — i.e. the skeleton's bone lengths) are *structure of the
		// authoring rig*, not motion. Rewriting them onto a differently-proportioned
		// or differently-scaled avatar overwrites that rig's own bone lengths with
		// cz's centimetre-vs-metre offsets and folds the whole skeleton into a heap —
		// even though every bone "matches", so coverage lies at 100%. Only joint
		// rotations and the root (Hips) translation are true motion; retarget those
		// and skip the structural channels so every rig keeps its own proportions.
		const retargetable =
			property === 'quaternion' || (property === 'position' && canonical === 'Hips');
		if (!retargetable) continue;

		total++;
		const nodeName = canonicalToNode.get(canonical);
		if (!nodeName) {
			dropped.push(canonical);
			continue;
		}
		const next = track.clone();
		next.name = `${nodeName}.${property}`;
		if (property === 'quaternion') {
			// Bind correction q ← L·q·R: replay the clip bone's motion as the same
			// world-space delta on the target's rest pose, so a clip authored for one
			// rest pose (cz's A-pose) drives a differently-rigged avatar (a Mixamo
			// T-pose, or a Hips baked at −90°X that would otherwise read as "lying
			// down") without skewing limbs.
			const correction = corrections.get(canonical);
			if (correction) correctQuaternionTrack(next.values, correction);
		} else {
			// Root motion (Hips.position): the clip authors hip translation in the
			// authoring rig's world-Y-up frame; re-express it in the target's
			// hips-parent frame so it travels the same world direction on any rig,
			// then scale for height.
			if (hipsPosCorrection) rotateVectorTrack(next.values, hipsPosCorrection);
			if (hipScale !== 1) {
				for (let i = 0; i < next.values.length; i++) next.values[i] *= hipScale;
			}
			// Land the clip's ground (authored at 0) on this rig's actual floor:
			// origin-centered exports keep their floor below the local origin, and
			// without this offset the scaled track still hovers the body a
			// floor-height above the mesh.
			if (hipOffsetY !== 0) {
				for (let i = 1; i < next.values.length; i += 3) next.values[i] += hipOffsetY;
			}
		}
		tracks.push(next);
	}

	const matched = tracks.length;
	const coverage = total > 0 ? matched / total : 0;
	if (coverage < minCoverage) {
		return { clip: null, matched, total, coverage, dropped, hipScale, face: 0 };
	}
	const out = clip.clone();
	out.tracks = [...tracks, ...faceTracks];
	return { clip: out, matched, total, coverage, dropped, hipScale, face: faceTracks.length };
}

/**
 * High-level: retarget a canonical clip onto a rig (GltfRig/MannequinRig),
 * computing hip scaling from the rig's actual proportions.
 *
 * The bind correction (and hip scaling) is measured from the rig's LIVE bone
 * transforms, so they must read the rig's true rest pose — not whatever pose a
 * previously-previewed clip left the bones in. A preview mixer leaves the bones
 * mid-animation after it stops, so without this the second clip a user plays is
 * retargeted against a garbage "rest" and its limbs skew by 60–90° (an avatar
 * that plays one clip fine, then plays the next with its arms stuck overhead).
 * We restore the rig to its bind pose first; the caller's mixer immediately
 * re-poses it on the next frame, so the reset is invisible. Aside from that
 * normalization the clip itself is not mutated.
 *
 * @param {AnimationClip} clip
 * @param {object} rig
 * @param {{ scaleHips?: boolean, minCoverage?: number }} [opts]
 * @returns {RetargetResult}
 */
export function retargetClipToRig(clip, rig, opts = {}) {
	rig.resetPose?.(); // read the bind pose, not a leftover preview pose
	const map = canonicalNodeMapFromRig(rig);
	const targetRest = canonicalRestMapFromRig(rig);
	const targetWorldRest = canonicalWorldRestMapFromRig(rig);
	let hipScale = 1;
	if (opts.scaleHips !== false) {
		const targetY = hipRestHeight(rig);
		const sourceY = clipHipBaselineY(clip);
		if (targetY > 0.05 && sourceY > 0.05) {
			// Clamp so a wildly off baseline (or a near-zero in-place clip) can't
			// fling the root metres away.
			hipScale = Math.min(5, Math.max(0.2, targetY / sourceY));
		}
	}
	// Walk the hips' ancestor chain to the top so root motion is corrected for the
	// rig's axis convention (the rig is posed at origin, so within-model == world).
	let hipsParent = null;
	const hipsNode = rig.getNode?.('Hips');
	if (hipsNode?.parent) {
		hipsParent = new Quaternion();
		for (let n = hipsNode.parent; n; n = n.parent) hipsParent.premultiply(n.quaternion);
	}
	return retargetClip(clip, map, {
		hipScale,
		minCoverage: opts.minCoverage,
		targetRest,
		targetWorldRest,
		hipsParentWorldQuat: hipsParent,
		morphTargets: opts.morphTargets ?? (rig.root ? morphTargetMapFromObject(rig.root) : undefined),
	});
}

/**
 * Retarget onto a raw Object3D graph (server-side apply_animation). No hip
 * scaling by default — the caller may pass an explicit factor.
 *
 * @param {AnimationClip} clip
 * @param {import('three').Object3D} root
 * @param {{ hipScale?: number, minCoverage?: number }} [opts]
 * @returns {RetargetResult}
 */
export function retargetClipToObject(clip, root, opts = {}) {
	const map = canonicalNodeMapFromObject(root);
	const targetRest = opts.targetRest || canonicalRestMapFromObject(root);
	const targetWorldRest = opts.targetWorldRest || canonicalWorldRestMapFromObject(root);
	const hipsParentWorld = opts.hipsParentWorldQuat || hipsParentWorldQuat(root);
	return retargetClip(clip, map, {
		...opts,
		targetRest,
		targetWorldRest,
		hipsParentWorldQuat: hipsParentWorld,
		morphTargets: opts.morphTargets ?? morphTargetMapFromObject(root),
	});
}

/**
 * Resample a clip's timing to play at `factor`× speed (1.8 turns a walk into a
 * run). Used so an exported GLB carries the tempo the user previewed, not just
 * a mixer timeScale that doesn't survive the file. Pure — returns a clone.
 *
 * @param {AnimationClip} clip
 * @param {number} factor  >1 faster, <1 slower
 * @returns {AnimationClip}
 */
export function scaleClipSpeed(clip, factor) {
	if (!(factor > 0) || factor === 1) return clip;
	const out = clip.clone();
	const inv = 1 / factor;
	for (const track of out.tracks) {
		for (let i = 0; i < track.times.length; i++) track.times[i] *= inv;
	}
	out.duration = clip.duration * inv;
	return out;
}

/**
 * Convenience: parse a clip from its three.js JSON (the on-disk clip format),
 * naming it. Centralised so browser and server load clips identically.
 *
 * @param {object} json
 * @param {string} name
 * @returns {AnimationClip}
 */
export function parseClipJSON(json, name) {
	const clip = AnimationClip.parse(json);
	if (name) clip.name = name;
	return clip;
}
