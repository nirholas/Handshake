// Server-side skeleton-proportions baker.
//
// The runtime counterpart is src/avatar-proportions.js: it rewrites the rest
// transforms of a live three.js skeleton while the user drags the Proportions
// sliders in Avatar Studio. This module performs the SAME rewrite on a
// @gltf-transform Document inside bakeAppearance(), so `appearance.proportions`
// reaches every consumer that never runs our runtime: embeds, AR quick-look,
// /play, Blender, Unreal.
//
// Why it has to exist: Avatar Studio saves by exporting the live scene, so a
// build sculpted there bakes in for free. The avatar editor at /avatars/:id/edit
// does not. It PATCHes the appearance record and lets the server render the GLB
// from the pristine base, and until this module ran in that path a proportion
// edit persisted, reloaded and re-applied in the editor while the GLB everyone
// else downloaded stayed at default height.
//
// The maths is not duplicated. `computeProportionTransforms` in
// src/avatar-proportions.js is dependency-free precisely so it can run here, in
// the browser, and in vitest against the same table; this file is only the
// glTF-shaped adapter around it:
//   1. resolve the skin's joints to canonical bone names (glb-canonicalize.js),
//   2. read their rest translation/rotation/scale into the shared RestBone form,
//   3. hand that to the shared solver,
//   4. write the returned locals back, plus the stature factor onto the node
//      that parents the skeleton.
//
// Rotations are never written, matching the client, which is what keeps the
// pre-baked clip library and the bind-space morph deltas valid.

import { canonicalizeBoneName } from '../../src/glb-canonicalize.js';
import {
	PROPORTION_BONES,
	computeProportionTransforms,
	normalizeProportions,
} from '../../src/avatar-proportions.js';

/** True when this appearance carries a non-default build worth baking. */
export function hasProportions(appearance) {
	return Object.keys(normalizeProportions(appearance?.proportions)).length > 0;
}

/**
 * Canonical bone name → glTF node, taken from the document's skins. Joints are
 * the only nodes we trust: a mesh node called "Head" is a mesh, not a bone, and
 * scaling it would be a silent disfigurement. The skin deforming the most
 * vertices wins when a document carries several (an avatar plus a garment).
 *
 * @param {import('@gltf-transform/core').Document} doc
 * @returns {Map<string, import('@gltf-transform/core').Node>}
 */
function resolveJoints(doc) {
	const skins = doc.getRoot().listSkins();
	if (!skins.length) return new Map();

	const weightOf = new Map();
	for (const node of doc.getRoot().listNodes()) {
		const skin = node.getSkin();
		const mesh = node.getMesh();
		if (!skin || !mesh) continue;
		let count = 0;
		for (const prim of mesh.listPrimitives()) {
			count += prim.getAttribute('POSITION')?.getCount() || 0;
		}
		weightOf.set(skin, (weightOf.get(skin) || 0) + count);
	}
	const ordered = [...skins].sort((a, b) => (weightOf.get(b) || 0) - (weightOf.get(a) || 0));

	const wanted = new Set(PROPORTION_BONES);
	const out = new Map();
	for (const skin of ordered) {
		for (const joint of skin.listJoints()) {
			const canonical = canonicalizeBoneName(joint.getName() || '');
			if (!canonical || !wanted.has(canonical) || out.has(canonical)) continue;
			out.set(canonical, joint);
		}
	}
	return out;
}

const v3 = (a, fallback = 0) => ({
	x: Number.isFinite(a?.[0]) ? a[0] : fallback,
	y: Number.isFinite(a?.[1]) ? a[1] : fallback,
	z: Number.isFinite(a?.[2]) ? a[2] : fallback,
});

const v4 = (a) => ({
	x: Number.isFinite(a?.[0]) ? a[0] : 0,
	y: Number.isFinite(a?.[1]) ? a[1] : 0,
	z: Number.isFinite(a?.[2]) ? a[2] : 0,
	w: Number.isFinite(a?.[3]) ? a[3] : 1,
});

/**
 * Apply `proportions` to the document's skeleton in place.
 *
 * Never throws on a rig that cannot honour a parameter: a bone that is absent
 * is reported in `missing` and its parameter is dropped, mirroring the client,
 * where a slider whose bones are missing is simply not offered.
 *
 * @param {import('@gltf-transform/core').Document} doc
 * @param {Record<string, number>} proportions
 * @returns {{ applied: string[], stature: number, missing: string[] }}
 */
export function applyProportions(doc, proportions) {
	const values = normalizeProportions(proportions);
	const result = { applied: [], stature: 1, missing: [] };
	if (!Object.keys(values).length) return result;

	const joints = resolveJoints(doc);
	if (!joints.has('Hips')) {
		result.missing = [...Object.keys(values)];
		return result;
	}

	// Nearest canonical ancestor of each joint, so the shared solver can walk
	// chains without knowing anything about the glTF node graph.
	const nodeToCanonical = new Map();
	for (const [canonical, node] of joints) nodeToCanonical.set(node, canonical);
	const parentOf = (node) => {
		for (let n = node.getParentNode(); n; n = n.getParentNode()) {
			const canonical = nodeToCanonical.get(n);
			if (canonical) return canonical;
		}
		return null;
	};

	const rest = new Map();
	for (const [canonical, node] of joints) {
		rest.set(canonical, {
			position: v3(node.getTranslation()),
			quaternion: v4(node.getRotation()),
			scale: v3(node.getScale(), 1),
			parent: parentOf(node),
		});
	}

	const { bones, stature, applied } = computeProportionTransforms(rest, values);

	for (const [canonical, local] of bones) {
		const node = joints.get(canonical);
		if (!node) continue;
		node.setTranslation([local.position.x, local.position.y, local.position.z]);
		node.setScale([local.scale.x, local.scale.y, local.scale.z]);
	}

	// Stature scales the node that parents the whole skeleton. Per the glTF
	// spec a skinned mesh node's own transform is ignored, so the skin follows
	// the joints rather than needing its own scale, and scaling the armature is
	// the one edit that moves every joint at once. When the Hips are a scene
	// root there is no such node and the parameter is dropped, exactly as the
	// client drops the Height slider on the same rig.
	const armature = joints.get('Hips').getParentNode();
	if (stature !== 1) {
		if (armature) {
			const s = v3(armature.getScale(), 1);
			armature.setScale([s.x * stature, s.y * stature, s.z * stature]);
			result.stature = stature;
		} else {
			result.missing.push('height');
		}
	}

	result.applied = applied.filter((id) => id !== 'height' || result.stature !== 1);
	for (const id of Object.keys(values)) {
		if (!result.applied.includes(id) && !result.missing.includes(id)) result.missing.push(id);
	}
	return result;
}
