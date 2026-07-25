// Assemble a publishable garment GLB from a generated mesh + the canonical
// body: fit, skin-transfer, occludes, strip the body, keep the skeleton.
//
// The emitted GLB contains the garment mesh skinned to the canonical
// (mixamorig) skeleton — exactly what specs/GARMENT_MANIFEST.md requires of a
// `three.ws-canonical-v1` wearable, and what src/avatar-garment.js rebinds
// onto any humanoid at wear-time.

import { mergeDocuments, prune, unpartition } from '@gltf-transform/functions';
import {
	findBodyMesh,
	fitGarmentToBody,
	transferSkinWeights,
	deriveOccludes,
} from './skin-transfer.mjs';

/**
 * @param {import('@gltf-transform/core').NodeIO} io
 * @param {Uint8Array} baseBytes     canonical body GLB (parametric-base.glb)
 * @param {Uint8Array} garmentBytes  generated garment GLB (unrigged)
 * @param {string} slot
 * @returns {Promise<{ bytes: Uint8Array, occludes: string[], stats: object }>}
 */
export async function assembleGarment(io, baseBytes, garmentBytes, slot) {
	const doc = await io.readBinary(baseBytes);
	const garmentDoc = await io.readBinary(garmentBytes);

	const bodyNode = findBodyMesh(doc);
	if (!bodyNode) throw new Error('canonical body GLB has no skinned mesh');
	const skin = bodyNode.getSkin();
	// Everything the base ships (body, eyes, teeth, …) gets stripped at the end —
	// the garment GLB carries skeleton + cloth only. Record the set now, before
	// the merge adds the garment's meshes.
	const baseMeshes = new Set(doc.getRoot().listMeshes());

	// Tag garment roots so they are findable after the merge disconnects refs.
	const gScene = garmentDoc.getRoot().getDefaultScene() || garmentDoc.getRoot().listScenes()[0];
	const roots = gScene ? [...gScene.listChildren()] : [];
	if (!roots.length) throw new Error('generated garment GLB has an empty scene');
	roots.forEach((n, i) => n.setName(`__garment_src_${i}`));

	mergeDocuments(doc, garmentDoc);

	const scene = doc.getRoot().getDefaultScene() || doc.getRoot().listScenes()[0];
	const mergedRoots = doc
		.getRoot()
		.listNodes()
		.filter((n) => (n.getName() || '').startsWith('__garment_src_'));

	// Collect the garment's mesh-bearing nodes; bake their node transforms into
	// POSITION is unnecessary — generators emit identity transforms — but their
	// meshes must be re-hosted on skinned nodes at the scene root.
	const garmentMeshes = [];
	const stack = [...mergedRoots];
	while (stack.length) {
		const n = stack.pop();
		if (n.getMesh()) garmentMeshes.push(n.getMesh());
		stack.push(...n.listChildren());
	}
	if (!garmentMeshes.length) throw new Error('generated garment GLB contains no mesh');

	const stats = { meshes: garmentMeshes.length, transferred: 0 };
	for (const mesh of garmentMeshes) {
		const fit = fitGarmentToBody(mesh, doc, slot);
		const { transferred } = transferSkinWeights(mesh, doc, doc);
		stats.transferred += transferred;
		stats.fit = fit;

		const node = doc.createNode(`garment:${slot}`).setMesh(mesh).setSkin(skin);
		scene.addChild(node);
	}

	const occludes = deriveOccludes(garmentMeshes[0], skin, slot);

	// Strip the body: the garment GLB ships skeleton + cloth, not a person.
	for (const node of doc.getRoot().listNodes()) {
		if (baseMeshes.has(node.getMesh())) node.setMesh(null);
	}
	for (const root of mergedRoots) {
		for (const s of doc.getRoot().listScenes()) s.removeChild(root);
	}

	await doc.transform(unpartition(), prune());
	const bytes = await io.writeBinary(doc);
	return { bytes, occludes, stats };
}
