// @ts-check
// Avatar Composer — core composition engine.
//
// Assembles a single rigged GLB by mixing skinned parts across the RPM base
// bodies (see parts.js) onto one shared skeleton, then recolors each part and
// scales the whole avatar. Buffer-in / buffer-out and deterministic — no I/O, no
// GPU, no external service.
//
// The one rule that makes this correct (confirmed against gltf-transform's
// source and RPM/Avaturn's architecture): body parts are NEVER fused into a
// single mesh. `join()` refuses skinned/morph meshes for good reason — each part
// stays its own skinned primitive, and they all reference ONE shared Skin. All
// four bases share a byte-identical joint list, so re-pointing a borrowed part
// to the identity base's skin transfers its skin weights without distortion.
//
// Pipeline per compose():
//   1. Start from the identity base (its head+body+eyes+teeth+beard + skeleton).
//   2. For each swappable slot, either keep the identity's part, drop it, or
//      merge a donor base's part and re-point it to the shared skin.
//   3. Collapse every skinned mesh onto one shared Skin; prune orphans.
//   4. Recolor each part's material by its colorway channel.
//   5. Scale the rig uniformly for height variety.
//   6. dedup → prune → meshopt-compress → single buffer → write.

import { NodeIO, Document } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { mergeDocuments, prune, dedup, meshopt } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import draco3d from 'draco3dgltf';
import { MATERIAL_SLOT, SWAPPABLE_SLOTS, SLOT_CHANNEL } from './parts.js';

let _ioPromise = null;
// One NodeIO per process, with every decoder/encoder the bases need
// (EXT_meshopt_compression, KHR_mesh_quantization, EXT_texture_webp, Draco).
// Lazy so importing this module never blocks on WASM init.
async function getIO() {
	if (_ioPromise) return _ioPromise;
	_ioPromise = (async () => {
		const [dDec, dEnc] = await Promise.all([
			draco3d.createDecoderModule(),
			draco3d.createEncoderModule(),
		]);
		await MeshoptDecoder.ready;
		await MeshoptEncoder.ready;
		return new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
			'meshopt.decoder': MeshoptDecoder,
			'meshopt.encoder': MeshoptEncoder,
			'draco3d.decoder': dDec,
			'draco3d.encoder': dEnc,
		});
	})();
	return _ioPromise;
}

function meshSlot(mesh) {
	const mat = mesh.listPrimitives()[0]?.getMaterial()?.getName();
	return mat ? MATERIAL_SLOT[mat] || null : null;
}

function nodeForMesh(doc, mesh) {
	return doc.getRoot().listNodes().find((n) => n.getMesh() === mesh) || null;
}

// The skin borrowed parts bind to. It must be the identity BODY mesh's skin, not
// the head's: RPM stores inverse-bind matrices per skin, and the head skin's
// binds are only trustworthy for the head/arm joints it actually deforms — bind
// a shoe to it and the foot joints resolve wrong (the shoe flies to the
// shoulders). The body mesh spans the whole skeleton, so its inverse binds are
// correct for every region. Falls back to head, then the first skin.
function canonicalSkin(doc) {
	const root = doc.getRoot();
	const bySlot = (slot) => {
		for (const mesh of root.listMeshes()) {
			if (meshSlot(mesh) === slot) {
				const node = nodeForMesh(doc, mesh);
				if (node?.getSkin()) return node.getSkin();
			}
		}
		return null;
	};
	return bySlot('body') || bySlot('head') || root.listSkins()[0] || null;
}

function removeSlotMeshes(doc, slot) {
	for (const mesh of doc.getRoot().listMeshes()) {
		if (meshSlot(mesh) !== slot) continue;
		const node = nodeForMesh(doc, mesh);
		node?.dispose();
		mesh.dispose();
	}
}

/**
 * @typedef {Object} ComposeRecipe
 * @property {string} identity  base id providing head/body/eyes/teeth/beard
 * @property {Record<string,string|null>} slots  swappable slot → donor base id (or null to omit)
 * @property {{skin?:number[],hair?:number[],top?:number[],bottom?:number[],footwear?:number[]}} [colorway]
 *   per-channel baseColorFactor multipliers in [0,1]
 * @property {number} [scale=1]  uniform height multiplier applied to the rig
 */

/**
 * Compose one avatar GLB from base-body bytes.
 *
 * @param {ComposeRecipe} recipe
 * @param {Record<string, Uint8Array>} bytesByBase  base id → GLB bytes for every
 *   base referenced by `identity` and `slots` (donors and identity).
 * @returns {Promise<{ bytes: Uint8Array, meshes: string[], recolored: string[] }>}
 */
export async function composeAvatar(recipe, bytesByBase) {
	const io = await getIO();
	const identityId = recipe.identity;
	const identityBytes = bytesByBase[identityId];
	if (!identityBytes) throw new Error(`composeAvatar: missing bytes for identity base "${identityId}"`);

	const target = await io.readBinary(identityBytes);
	const tScene = target.getRoot().getDefaultScene() || target.getRoot().listScenes()[0];

	// The identity skeleton: its joint NODES (canonical order) and skeleton root,
	// taken from the body mesh's skin (the one skin that spans every joint). Every
	// borrowed part gets remapped onto exactly these nodes so the whole avatar is
	// driven by ONE skeleton and animates as a unit.
	const bodySkin = canonicalSkin(target);
	if (!bodySkin) throw new Error('composeAvatar: identity base has no body skin');
	const identityJoints = bodySkin.listJoints();
	const identitySkeleton = bodySkin.getSkeleton();
	// The armature node identity meshes hang under — borrowed nodes join it so
	// their world matrix (three.js uses it as the skinning bind matrix) matches.
	const bodyNode = target.getRoot().listNodes().find((n) => n.getMesh() && meshSlot(n.getMesh()) === 'body');
	const armature = bodyNode?.getParentNode() || tScene.listChildren()[0] || tScene;

	// Drop the identity's own mesh for any slot we are swapping out or omitting.
	for (const slot of SWAPPABLE_SLOTS) {
		const src = recipe.slots?.[slot];
		if (src !== identityId) removeSlotMeshes(target, slot);
	}

	const donorIds = new Set();
	for (const slot of SWAPPABLE_SLOTS) {
		const src = recipe.slots?.[slot];
		if (src && src !== identityId) donorIds.add(src);
	}
	/** @type {Map<string, {doc: Document, map: Map<any,any>}>} */
	const donors = new Map();
	const donorScenes = [];
	for (const id of donorIds) {
		const bytes = bytesByBase[id];
		if (!bytes) throw new Error(`composeAvatar: missing bytes for donor base "${id}"`);
		const donorDoc = await io.readBinary(bytes);
		const before = new Set(target.getRoot().listScenes());
		const map = mergeDocuments(target, donorDoc);
		for (const s of target.getRoot().listScenes()) if (!before.has(s)) donorScenes.push(s);
		donors.set(id, { doc: donorDoc, map });
	}

	// Graft each borrowed part: keep its OWN skin (its inverse-bind matrices are
	// the only ones correct for that part's region — re-pointing to another skin
	// throws the part across the body), but remap that skin's joints onto the
	// identity skeleton's nodes. Joint order is byte-identical across bases, so
	// slot i maps to slot i; the part now deforms with the identity skeleton while
	// keeping its own correct binds.
	const remapped = new Set();
	for (const slot of SWAPPABLE_SLOTS) {
		const src = recipe.slots?.[slot];
		if (src == null || src === identityId) continue;
		const donor = donors.get(src);
		if (!donor) continue;
		for (const donorMesh of donor.doc.getRoot().listMeshes()) {
			if (meshSlot(donorMesh) !== slot) continue;
			const donorNode = nodeForMesh(donor.doc, donorMesh);
			const mergedNode = donor.map.get(donorNode);
			if (!mergedNode) continue;
			armature.addChild(mergedNode); // same parent as identity meshes → matching bind matrix
			mergedNode.setName(`${slot}:${src}`);
			const partSkin = mergedNode.getSkin();
			if (partSkin && !remapped.has(partSkin)) {
				const donorJoints = partSkin.listJoints();
				if (donorJoints.length === identityJoints.length) {
					for (const j of donorJoints) partSkin.removeJoint(j);
					for (const j of identityJoints) partSkin.addJoint(j);
					if (identitySkeleton) partSkin.setSkeleton(identitySkeleton);
				}
				remapped.add(partSkin);
			}
		}
	}

	// Donor scenes now hold only the parts we did NOT take; dispose them so prune()
	// reclaims the donor skeletons (now unreferenced) and unused meshes.
	for (const s of donorScenes) s.dispose();
	target.getRoot().setDefaultScene(tScene);

	await target.transform(prune());

	// Recolor each surviving part by its channel.
	const recolored = [];
	const cw = recipe.colorway || {};
	for (const mat of target.getRoot().listMaterials()) {
		const slot = MATERIAL_SLOT[mat.getName()];
		const channel = slot && SLOT_CHANNEL[slot];
		const color = channel && cw[channel];
		if (!color) continue;
		const [r, g, b] = color;
		const a = mat.getBaseColorFactor()?.[3] ?? 1;
		mat.setBaseColorFactor([r, g, b, a]);
		recolored.push(mat.getName());
	}

	// Uniform height scale on the rig roots (mirrors the legacy studio lane).
	const s = Number(recipe.scale) || 1;
	if (Math.abs(s - 1) > 1e-4) {
		for (const node of tScene.listChildren()) {
			const cur = node.getScale();
			node.setScale([cur[0] * s, cur[1] * s, cur[2] * s]);
		}
	}

	// Optimize + guarantee a single buffer for GLB output.
	await target.transform(dedup(), prune(), meshopt({ encoder: MeshoptEncoder }));
	const buffers = target.getRoot().listBuffers();
	if (buffers.length > 1) {
		const buf0 = buffers[0];
		for (const acc of target.getRoot().listAccessors()) acc.setBuffer(buf0);
		for (const b of buffers.slice(1)) b.dispose();
	}

	const bytes = await io.writeBinary(target);
	return {
		bytes,
		meshes: target.getRoot().listMeshes().map((m) => m.getName() || meshSlot(m) || '?'),
		recolored,
	};
}
