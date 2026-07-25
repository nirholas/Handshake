// Additive wardrobe — bind an arbitrary garment GLB onto an already-loaded
// avatar's skeleton at runtime.
//
// This is the counterpart to src/avatar-wardrobe.js. That module is
// *subtractive*: it discovers garment meshes already baked into the avatar GLB
// and lets the user hide or tint them. It cannot put on a shirt the mesh does
// not already have. This module is *additive*: it takes a separately authored
// garment (its own GLB, its own skeleton) and rebinds it onto the avatar's
// bones so it deforms with every animation the avatar plays.
//
// Why rebinding rather than "author everything against one template":
// the common industry approach ships garments authored against a single
// skeleton the vendor controls, so attaching is a no-op bind. That buys a clean
// pipeline and costs it every avatar that did not come out of that vendor's own
// generator. We already normalise arbitrary rigs to a canonical bone set in
// src/glb-canonicalize.js (Mixamo, Unreal, VRM, Daz, MakeHuman, Blender .L/.R,
// …), so we can bind a garment to *any* humanoid the platform can load,
// including meshes users bring from the Forge lane. The garment's own bind pose
// is preserved through its boneInverses, which means a garment authored in
// T-pose lands correctly on an A-pose avatar without re-authoring.
//
// The skinning contract, for reference:
//     skinned(v) = Σ_i  w_i · (bone_i.matrixWorld · boneInverse_i) · bindMatrix · v
//
// Rebinding therefore needs exactly two things:
//   1. skinIndex values rewritten from garment-bone-order to avatar-bone-order,
//   2. boneInverses re-indexed into avatar-bone-order, keeping the *garment's*
//      matrices. Keeping the garment's own inverses is what makes divergent
//      rest poses reconcile: at the avatar's rest, the garment bone matrix
//      becomes avatarRestWorld · garmentRestWorld⁻¹, which is precisely the
//      transform that carries the garment from its rest into the avatar's.

import {
	Bone,
	Float32BufferAttribute,
	Matrix4,
	Skeleton,
	SkinnedMesh,
	Uint16BufferAttribute,
} from 'three';
import { canonicalizeBoneName } from './glb-canonicalize.js';
import {
	GARMENT_SLOTS,
	BODY_REGIONS,
	REGION_BONES,
	MIN_BIND_COVERAGE,
} from './garment-taxonomy.js';

// Shared vocabulary lives in src/garment-taxonomy.js (pure, also consumed by
// the server-side baker). Re-exported so existing consumers keep one import.
export { GARMENT_SLOTS, BODY_REGIONS, REGION_BONES, MIN_BIND_COVERAGE };

/* ────────────────────────────────────────────────────────────────────────── *
 * Skeleton discovery
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * The skeleton an avatar's garments should bind to: the one driving the most
 * skinned vertices. Avatars regularly carry several SkinnedMeshes (body, head,
 * teeth, pre-baked outfit) that all share one skeleton, but a stray prop with
 * its own two-bone rig would win a naive "first SkinnedMesh" search.
 * @returns {{ skeleton: Skeleton, mesh: SkinnedMesh } | null}
 */
export function findAvatarSkeleton(root) {
	const byUuid = new Map();
	root?.traverse?.((obj) => {
		if (!obj?.isSkinnedMesh || !obj.skeleton?.bones?.length) return;
		const count = obj.geometry?.attributes?.position?.count || 0;
		const entry = byUuid.get(obj.skeleton.uuid);
		if (entry) { entry.weight += count; return; }
		byUuid.set(obj.skeleton.uuid, { skeleton: obj.skeleton, mesh: obj, weight: count });
	});
	let best = null;
	for (const entry of byUuid.values()) {
		if (!best || entry.weight > best.weight) best = entry;
	}
	return best ? { skeleton: best.skeleton, mesh: best.mesh } : null;
}

/** canonical bone name → index, for one skeleton. First occurrence wins, so a
 *  duplicate canonical name (some rigs carry a helper twin) cannot shadow the
 *  real joint, which appears first in a depth-first GLB node order. */
function indexByCanonical(skeleton) {
	const map = new Map();
	skeleton.bones.forEach((bone, i) => {
		const canonical = canonicalizeBoneName(bone?.name || '');
		if (canonical && !map.has(canonical)) map.set(canonical, i);
	});
	return map;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Bone remapping
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Map every garment bone index onto an avatar bone index.
 *
 * A garment bone with no canonical counterpart on the avatar falls back to its
 * nearest *mapped ancestor* — a garment rigged with twist or helper joints the
 * avatar lacks then rides the parent joint instead of losing its vertices. Only
 * when no ancestor maps either does the bone go unresolved (-1), and the
 * weights referencing it are zeroed and redistributed.
 *
 * @returns {{ remap: Int32Array, unresolved: string[], resolvedCount: number }}
 */
export function buildBoneRemap(garmentSkeleton, avatarSkeleton) {
	const avatarIndex = indexByCanonical(avatarSkeleton);
	const bones = garmentSkeleton.bones;
	const remap = new Int32Array(bones.length).fill(-1);
	const boneSet = new Set(bones);
	const unresolved = [];

	bones.forEach((bone, i) => {
		// Walk self → parents, stopping at the skeleton boundary, and take the
		// first joint the avatar actually has.
		for (let node = bone; node && boneSet.has(node); node = node.parent) {
			const canonical = canonicalizeBoneName(node.name || '');
			if (canonical && avatarIndex.has(canonical)) {
				remap[i] = avatarIndex.get(canonical);
				return;
			}
		}
		unresolved.push(bone?.name || `<bone ${i}>`);
	});

	const resolvedCount = remap.reduce((n, v) => n + (v >= 0 ? 1 : 0), 0);
	return { remap, unresolved, resolvedCount };
}

/**
 * Share of skin *weight* (not bone count) that survives the remap. Weighting by
 * influence is what matters: a garment can leave twenty unused helper bones
 * unresolved and still bind perfectly, while losing the single spine bone that
 * carries most of a shirt is fatal. Counting bones would invert that judgement.
 */
export function bindCoverage(geometry, remap) {
	const skinIndex = geometry?.attributes?.skinIndex;
	const skinWeight = geometry?.attributes?.skinWeight;
	if (!skinIndex || !skinWeight) return 0;

	let total = 0;
	let kept = 0;
	for (let i = 0; i < skinIndex.count; i++) {
		for (let c = 0; c < 4; c++) {
			const w = skinWeight.getComponent(i, c);
			if (w <= 0) continue;
			total += w;
			const bone = skinIndex.getComponent(i, c);
			if (remap[bone] >= 0) kept += w;
		}
	}
	return total > 0 ? kept / total : 0;
}

/**
 * Rewrite a geometry's skinIndex into avatar-bone-order, in place on a clone.
 * Weights whose bone did not resolve are zeroed and the vertex's surviving
 * weights renormalised, so no vertex silently collapses toward the origin.
 */
export function remapSkinAttributes(geometry, remap) {
	const srcIndex = geometry.attributes.skinIndex;
	const srcWeight = geometry.attributes.skinWeight;
	const count = srcIndex.count;

	const outIndex = new Uint16Array(count * 4);
	const outWeight = new Float32Array(count * 4);

	for (let i = 0; i < count; i++) {
		let sum = 0;
		for (let c = 0; c < 4; c++) {
			const bone = srcIndex.getComponent(i, c);
			const w = srcWeight.getComponent(i, c);
			const mapped = remap[bone];
			if (mapped >= 0 && w > 0) {
				outIndex[i * 4 + c] = mapped;
				outWeight[i * 4 + c] = w;
				sum += w;
			}
		}
		if (sum > 0 && Math.abs(sum - 1) > 1e-6) {
			for (let c = 0; c < 4; c++) outWeight[i * 4 + c] /= sum;
		}
	}

	// Fresh attributes, not in-place copies: loader-produced geometries can
	// carry interleaved or normalized-integer skin attributes, which neither
	// accept copyArray nor store floats.
	geometry.setAttribute('skinIndex', new Uint16BufferAttribute(outIndex, 4));
	geometry.setAttribute('skinWeight', new Float32BufferAttribute(outWeight, 4));
	return geometry;
}

/**
 * Build the boneInverses array the rebound garment needs: one entry per *avatar*
 * bone, carrying the *garment's* inverse where the two correspond.
 *
 * Avatar bones the garment never referenced get that bone's own inverse from the
 * avatar skeleton, not identity. Identity would be wrong the moment a weight
 * touched them (it would fling those vertices by the bone's full world
 * transform); the avatar's own inverse is the neutral, no-op choice.
 */
export function reindexBoneInverses(garmentSkeleton, avatarSkeleton, remap) {
	const out = avatarSkeleton.boneInverses.map((m) => m.clone());
	const claimed = new Set();
	for (let g = 0; g < remap.length; g++) {
		const a = remap[g];
		if (a < 0 || claimed.has(a)) continue;   // first garment bone to claim an
		claimed.add(a);                          // avatar bone owns its inverse
		const inv = garmentSkeleton.boneInverses[g];
		if (inv) out[a] = inv.clone();
	}
	return out;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Attach / detach
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Bind every skinned mesh in `garmentRoot` onto `avatarRoot`'s skeleton.
 *
 * Non-skinned meshes in the garment (rigid props — a hat, a pair of glasses,
 * an earring) are parented to the bone named by `rigidBone` instead, which is
 * the correct treatment: they should follow a joint, not deform.
 *
 * @param {object} avatarRoot   loaded avatar scene root
 * @param {object} garmentRoot  loaded garment scene root (consumed, not cloned —
 *                              clone upstream if you intend to attach it twice)
 * @param {object} [opts]
 * @param {string} [opts.slot='top']       wardrobe slot this garment occupies
 * @param {string} [opts.rigidBone='Head'] canonical bone for non-skinned meshes
 * @param {number} [opts.minCoverage=MIN_BIND_COVERAGE]
 * @returns {{ ok: boolean, slot: string, meshes: object[], coverage: number,
 *             unresolved: string[], reason?: string, detach: () => void }}
 */
export function attachGarment(avatarRoot, garmentRoot, opts = {}) {
	const slot = opts.slot || 'top';
	const minCoverage = opts.minCoverage ?? MIN_BIND_COVERAGE;
	const fail = (reason) => ({
		ok: false, slot, meshes: [], coverage: 0, unresolved: [], reason, detach: () => {},
	});

	const found = findAvatarSkeleton(avatarRoot);
	if (!found) return fail('avatar has no skinned mesh to bind against');
	const { skeleton: avatarSkeleton, mesh: avatarMesh } = found;
	// Garments are siblings of the body mesh, never children of a bone: their
	// own world matrix participates in skinning via bindMatrixInverse.
	const parent = avatarMesh.parent || avatarRoot;

	const skinned = [];
	const rigid = [];
	garmentRoot.traverse((obj) => {
		if (obj?.isSkinnedMesh && obj.geometry?.attributes?.skinIndex) skinned.push(obj);
		else if (obj?.isMesh) rigid.push(obj);
	});
	if (!skinned.length && !rigid.length) return fail('garment contains no meshes');

	const attached = [];
	let worstCoverage = 1;
	const allUnresolved = new Set();

	for (const src of skinned) {
		const { remap, unresolved } = buildBoneRemap(src.skeleton, avatarSkeleton);
		const coverage = bindCoverage(src.geometry, remap);
		if (coverage < minCoverage) {
			for (const m of attached) m.parent?.remove(m);
			return {
				...fail(`garment binds only ${(coverage * 100).toFixed(0)}% of its skin weight ` +
					`to this avatar's skeleton (need ${(minCoverage * 100).toFixed(0)}%)`),
				coverage,
				unresolved,
			};
		}
		worstCoverage = Math.min(worstCoverage, coverage);
		for (const name of unresolved) allUnresolved.add(name);

		const geometry = src.geometry.clone();
		remapSkinAttributes(geometry, remap);

		const mesh = new SkinnedMesh(geometry, src.material);
		mesh.name = src.name || `garment:${slot}`;
		mesh.frustumCulled = false;   // skinned bounds go stale under animation
		mesh.castShadow = true;
		mesh.receiveShadow = true;
		mesh.userData.garmentSlot = slot;

		const inverses = reindexBoneInverses(src.skeleton, avatarSkeleton, remap);
		parent.add(mesh);
		mesh.bind(new Skeleton(avatarSkeleton.bones, inverses), src.bindMatrix.clone());
		attached.push(mesh);
	}

	for (const src of rigid) {
		const boneName = canonicalizeBoneName(opts.rigidBone || 'Head') || 'Head';
		const target = avatarSkeleton.bones.find(
			(b) => canonicalizeBoneName(b.name || '') === boneName,
		);
		if (!target) continue;
		const mesh = src.clone();
		mesh.userData.garmentSlot = slot;
		// Preserve the garment's authored offset relative to the joint.
		target.add(mesh);
		attached.push(mesh);
	}

	if (!attached.length) return fail('no mesh in the garment could be bound');

	return {
		ok: true,
		slot,
		meshes: attached,
		coverage: worstCoverage,
		unresolved: [...allUnresolved],
		detach: () => { for (const m of attached) m.parent?.remove(m); },
	};
}

/** Remove every mesh previously attached into `slot`. Safe to call on an empty
 *  slot; returns how many meshes were removed. */
export function detachSlot(avatarRoot, slot) {
	const doomed = [];
	avatarRoot?.traverse?.((obj) => {
		if (obj?.userData?.garmentSlot === slot) doomed.push(obj);
	});
	for (const m of doomed) m.parent?.remove(m);
	return doomed.length;
}

/** Every slot currently carrying an attached garment. */
export function occupiedSlots(avatarRoot) {
	const slots = new Set();
	avatarRoot?.traverse?.((obj) => {
		const slot = obj?.userData?.garmentSlot;
		if (slot) slots.add(slot);
	});
	return [...slots];
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Skin occlusion
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Hide the body wherever attached garments cover it.
 *
 * Two mechanisms, in order of fidelity:
 *
 *  1. If the avatar's skin material carries a region mask (an RGBA texture in
 *     body-UV space whose channels encode region membership, authored alongside
 *     the body and referenced as `userData.regionMask`), we drive the material's
 *     alphaMap from it, which cuts the skin exactly at the garment's edge.
 *  2. Otherwise we fall back to bone-region culling: skin vertices weighted
 *     predominantly to the bones a covered region owns are dropped. Coarser
 *     than a mask, but it needs no authored texture and never leaves a limb
 *     visibly stabbing through a sleeve.
 *
 * Returns the regions actually occluded, so callers can report the gap when a
 * body ships without a mask.
 */
export function applySkinOcclusion(avatarRoot, regions, opts = {}) {
	const wanted = new Set((regions || []).filter((r) => BODY_REGIONS.includes(r)));
	const found = findAvatarSkeleton(avatarRoot);
	if (!found || !wanted.size) return { occluded: [], method: 'none' };

	const skinMesh = found.mesh;
	const material = Array.isArray(skinMesh.material) ? skinMesh.material[0] : skinMesh.material;
	const mask = material?.userData?.regionMask;

	if (mask && typeof opts.buildAlphaMap === 'function') {
		const alphaMap = opts.buildAlphaMap(mask, [...wanted]);
		if (alphaMap) {
			material.alphaMap = alphaMap;
			material.alphaTest = opts.alphaTest ?? 0.5;
			material.transparent = false;   // alphaTest cuts, no blend cost
			material.needsUpdate = true;
			return { occluded: [...wanted], method: 'mask' };
		}
	}

	const boneNames = new Set();
	for (const region of wanted) {
		for (const b of REGION_BONES[region] || []) boneNames.add(b);
	}
	const indices = new Set();
	found.skeleton.bones.forEach((bone, i) => {
		if (boneNames.has(canonicalizeBoneName(bone?.name || ''))) indices.add(i);
	});
	if (!indices.size) return { occluded: [], method: 'none' };

	const hidden = cullSkinByBones(skinMesh.geometry, indices, opts.cullThreshold ?? 0.5);
	return { occluded: [...wanted], method: 'bone-cull', trianglesHidden: hidden };
}

/**
 * Drop triangles whose vertices are predominantly weighted to `boneIndices`.
 *
 * Rebuilds the index buffer rather than mutating positions, so the operation is
 * reversible (the original index is stashed on userData) and costs no extra
 * vertex memory. A triangle survives unless *every* corner is covered, which
 * keeps the seam a triangle wider than the garment edge instead of a triangle
 * narrower — erring toward a hidden seam rather than a visible hole.
 */
export function cullSkinByBones(geometry, boneIndices, threshold = 0.5) {
	const index = geometry.getIndex();
	const skinIndex = geometry.attributes?.skinIndex;
	const skinWeight = geometry.attributes?.skinWeight;
	if (!index || !skinIndex || !skinWeight) return 0;

	if (!geometry.userData.originalIndex) geometry.userData.originalIndex = index.clone();
	const src = geometry.userData.originalIndex;

	const covered = new Uint8Array(skinIndex.count);
	for (let v = 0; v < skinIndex.count; v++) {
		let w = 0;
		for (let c = 0; c < 4; c++) {
			if (boneIndices.has(skinIndex.getComponent(v, c))) w += skinWeight.getComponent(v, c);
		}
		covered[v] = w >= threshold ? 1 : 0;
	}

	const kept = [];
	let dropped = 0;
	for (let i = 0; i < src.count; i += 3) {
		const a = src.getX(i), b = src.getX(i + 1), c = src.getX(i + 2);
		if (covered[a] && covered[b] && covered[c]) { dropped++; continue; }
		kept.push(a, b, c);
	}
	geometry.setIndex(kept);
	return dropped;
}

/** Undo cullSkinByBones, restoring the body's full mesh. */
export function restoreSkin(geometry) {
	if (!geometry?.userData?.originalIndex) return false;
	geometry.setIndex(geometry.userData.originalIndex.clone());
	return true;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Rigid helper
 * ────────────────────────────────────────────────────────────────────────── */

/** True when `root` carries enough of a humanoid skeleton to dress at all.
 *  Mirrors AnimationManager.supportsCanonicalClips()'s intent: a prop with no
 *  spine is not a mannequin, and should be refused before the UI offers a
 *  wardrobe it cannot honour. */
export function supportsWardrobe(root) {
	const found = findAvatarSkeleton(root);
	if (!found) return false;
	const names = new Set(
		found.skeleton.bones.map((b) => canonicalizeBoneName(b?.name || '')).filter(Boolean),
	);
	return ['Hips', 'Spine', 'Head'].every((b) => names.has(b))
		&& (names.has('LeftArm') || names.has('RightArm'));
}

export { Bone, Matrix4 };
