// Server-side additive-garment baker.
//
// The runtime counterpart lives in src/avatar-garment.js: it rebinds a garment
// GLB onto a live three.js skeleton in the editor. This module performs the
// SAME rebind on a @gltf-transform Document inside bakeAppearance(), so an
// avatar saved wearing catalog garments serves a fully dressed GLB to every
// consumer that never runs our runtime — embeds, AR quick-look, external
// engines, /play.
//
// The math is identical (see the skinning contract in avatar-garment.js):
//   1. rewrite each garment primitive's JOINTS_0 from garment-joint-order into
//      avatar-joint-order via canonical bone names, ancestor-fallback for
//      helper joints, weights zeroed+renormalised when a joint has no home;
//   2. give the garment a skin whose joints are the avatar's but whose
//      inverseBindMatrices keep the GARMENT's values where the two correspond —
//      that is what reconciles a divergent rest pose;
//   3. cull body triangles under the garment's declared `occludes` regions so
//      skin never pokes through cloth in the baked output.
//
// Failure posture mirrors the client: a garment that cannot bind at
// MIN_BIND_COVERAGE is skipped with a warning, never baked in mangled. A bake
// with zero attachable garments is still a valid bake.

import { createHash } from 'node:crypto';
import { canonicalizeBoneName } from '../../src/glb-canonicalize.js';
import {
	REGION_BONES,
	MIN_BIND_COVERAGE,
	clampOccludes,
} from '../../src/garment-taxonomy.js';
import { sanitizeCatalog } from '../../src/garment-catalog.js';

import { fetchUpstream } from './upstream-fetch.js';
export const GARMENT_CATALOG_URL =
	'https://storage.googleapis.com/three-ws-garments/garments/catalog.json';

// Catalog cache: the bake path can be hit in bursts (bulk re-bakes) and the
// catalog is small and slow-moving.
let _catalog = null; // { garments, expiresAt }
const CATALOG_TTL_MS = 5 * 60_000;

async function loadServerCatalog() {
	if (_catalog && _catalog.expiresAt > Date.now()) return _catalog.garments;
	const res = await fetchUpstream(GARMENT_CATALOG_URL, { headers: { accept: 'application/json' } }, { name: 'gcs-garments', timeoutMs: 15_000, attempts: 2, okWhen: () => true });
	if (!res.ok) throw new Error(`garment catalog fetch failed: ${res.status}`);
	const { garments } = sanitizeCatalog(await res.json());
	_catalog = { garments, expiresAt: Date.now() + CATALOG_TTL_MS };
	return garments;
}

/** Test seam + cache invalidation hook. */
export function _resetCatalogCache() {
	_catalog = null;
}

/* ── document helpers ────────────────────────────────────────────────────── */

/** The avatar's primary skin: the one deforming the most vertices. */
export function findPrimarySkin(doc) {
	let best = null;
	for (const node of doc.getRoot().listNodes()) {
		const skin = node.getSkin();
		const mesh = node.getMesh();
		if (!skin || !mesh) continue;
		let count = 0;
		for (const prim of mesh.listPrimitives()) {
			count += prim.getAttribute('POSITION')?.getCount() || 0;
		}
		if (!best || count > best.count) best = { skin, node, mesh, count };
	}
	return best;
}

/** canonical bone name → joint index for a skin. First occurrence wins. */
function jointIndexByCanonical(skin) {
	const map = new Map();
	skin.listJoints().forEach((joint, i) => {
		const canonical = canonicalizeBoneName(joint.getName() || '');
		if (canonical && !map.has(canonical)) map.set(canonical, i);
	});
	return map;
}

/** child node → parent node map for ancestor-fallback walks. */
function parentMap(doc) {
	const map = new Map();
	for (const node of doc.getRoot().listNodes()) {
		for (const child of node.listChildren()) map.set(child, node);
	}
	return map;
}

/**
 * Map garment joint indices onto avatar joint indices (canonical name match,
 * nearest-mapped-ancestor fallback, -1 when unresolvable).
 */
export function buildJointRemap(garmentSkin, avatarSkin, parents) {
	const avatarIndex = jointIndexByCanonical(avatarSkin);
	const joints = garmentSkin.listJoints();
	const jointSet = new Set(joints);
	const remap = new Int32Array(joints.length).fill(-1);

	joints.forEach((joint, i) => {
		for (let node = joint; node && jointSet.has(node); node = parents.get(node)) {
			const canonical = canonicalizeBoneName(node.getName() || '');
			if (canonical && avatarIndex.has(canonical)) {
				remap[i] = avatarIndex.get(canonical);
				return;
			}
		}
	});
	return remap;
}

/** Share of skin weight that survives the remap, across all of a mesh's prims. */
function bindCoverageOfMesh(mesh, remap) {
	let total = 0;
	let kept = 0;
	for (const prim of mesh.listPrimitives()) {
		const joints = prim.getAttribute('JOINTS_0');
		const weights = prim.getAttribute('WEIGHTS_0');
		if (!joints || !weights) continue;
		const j = joints.getArray();
		const w = weights.getArray();
		for (let i = 0; i < w.length; i++) {
			if (w[i] <= 0) continue;
			total += w[i];
			if (remap[j[i]] >= 0) kept += w[i];
		}
	}
	return total > 0 ? kept / total : 0;
}

/** Rewrite JOINTS_0/WEIGHTS_0 of every primitive into avatar joint order. */
function remapMeshSkinAttributes(mesh, remap) {
	for (const prim of mesh.listPrimitives()) {
		const joints = prim.getAttribute('JOINTS_0');
		const weights = prim.getAttribute('WEIGHTS_0');
		if (!joints || !weights) continue;
		const j = joints.getArray();
		const w = weights.getArray();
		const outJ = new Uint16Array(j.length);
		const outW = new Float32Array(w.length);
		for (let v = 0; v < j.length; v += 4) {
			let sum = 0;
			for (let c = 0; c < 4; c++) {
				const mapped = remap[j[v + c]];
				if (mapped >= 0 && w[v + c] > 0) {
					outJ[v + c] = mapped;
					outW[v + c] = w[v + c];
					sum += w[v + c];
				}
			}
			if (sum > 0 && Math.abs(sum - 1) > 1e-6) {
				for (let c = 0; c < 4; c++) outW[v + c] /= sum;
			}
		}
		joints.setArray(outJ);
		weights.setArray(outW);
	}
}

/**
 * A skin for the rebound garment: avatar joints, garment inverseBindMatrices
 * where a garment joint claimed that avatar joint, avatar IBMs elsewhere.
 */
function buildReboundSkin(doc, garmentSkin, avatarSkin, remap, label) {
	const avatarJoints = avatarSkin.listJoints();
	const avatarIbm = avatarSkin.getInverseBindMatrices()?.getArray();
	const garmentIbm = garmentSkin.getInverseBindMatrices()?.getArray();
	const out = new Float32Array(avatarJoints.length * 16);
	if (avatarIbm) out.set(avatarIbm.subarray(0, out.length));

	const claimed = new Set();
	for (let g = 0; g < remap.length; g++) {
		const a = remap[g];
		if (a < 0 || claimed.has(a) || !garmentIbm) continue;
		claimed.add(a);
		out.set(garmentIbm.subarray(g * 16, g * 16 + 16), a * 16);
	}

	const buffer = doc.getRoot().listBuffers()[0] || doc.createBuffer();
	const ibmAccessor = doc
		.createAccessor(`${label}:ibm`)
		.setType('MAT4')
		.setArray(out)
		.setBuffer(buffer);

	const skin = doc.createSkin(label).setInverseBindMatrices(ibmAccessor);
	for (const joint of avatarJoints) skin.addJoint(joint);
	const skeleton = avatarSkin.getSkeleton();
	if (skeleton) skin.setSkeleton(skeleton);
	return skin;
}

/* ── occlusion ───────────────────────────────────────────────────────────── */

/**
 * Drop body triangles fully covered by the garments' declared regions — the
 * bake-time equivalent of cullSkinByBones in avatar-garment.js. Same seam
 * policy: a triangle survives unless every corner is covered.
 */
export function cullBodyRegions(bodyMesh, avatarSkin, regions, threshold = 0.5) {
	const wanted = new Set();
	for (const region of regions) {
		for (const b of REGION_BONES[region] || []) wanted.add(b);
	}
	if (!wanted.size) return 0;

	const jointIndices = new Set();
	avatarSkin.listJoints().forEach((joint, i) => {
		if (wanted.has(canonicalizeBoneName(joint.getName() || ''))) jointIndices.add(i);
	});
	if (!jointIndices.size) return 0;

	let droppedTotal = 0;
	for (const prim of bodyMesh.listPrimitives()) {
		const indexAccessor = prim.getIndices();
		const joints = prim.getAttribute('JOINTS_0');
		const weights = prim.getAttribute('WEIGHTS_0');
		if (!indexAccessor || !joints || !weights) continue;

		const j = joints.getArray();
		const w = weights.getArray();
		const vertCount = joints.getCount();
		const covered = new Uint8Array(vertCount);
		for (let v = 0; v < vertCount; v++) {
			let sum = 0;
			for (let c = 0; c < 4; c++) {
				if (jointIndices.has(j[v * 4 + c])) sum += w[v * 4 + c];
			}
			covered[v] = sum >= threshold ? 1 : 0;
		}

		const src = indexAccessor.getArray();
		const kept = [];
		let dropped = 0;
		for (let i = 0; i < src.length; i += 3) {
			if (covered[src[i]] && covered[src[i + 1]] && covered[src[i + 2]]) { dropped++; continue; }
			kept.push(src[i], src[i + 1], src[i + 2]);
		}
		if (dropped) {
			indexAccessor.setArray(
				vertCount > 65535 ? new Uint32Array(kept) : new Uint16Array(kept),
			);
			droppedTotal += dropped;
		}
	}
	return droppedTotal;
}

/* ── main entry ──────────────────────────────────────────────────────────── */

/**
 * Merge every wearable in `garmentRefs` ({slot, id}[]) into `doc`, rebinding
 * each onto the avatar's primary skin, then cull occluded body regions.
 *
 * @param {import('@gltf-transform/core').NodeIO} io
 * @param {import('@gltf-transform/core').Document} doc
 * @param {Array<{slot: string, id: string}>} garmentRefs
 * @param {(doc: any, srcDoc: any) => void} mergeDocumentsFn  passed in from
 *        bake.js so this module doesn't duplicate the gltf-transform import
 *        surface bake.js already manages.
 * @param {object} [opts]                    test seams
 * @param {object[]} [opts.catalog]          bypass the live catalog fetch
 * @param {(manifest: object) => Promise<ArrayBuffer>} [opts.fetchBytes]
 * @returns {Promise<{ attached: string[], skipped: Array<{id: string, reason: string}> }>}
 */
export async function applyGarments(io, doc, garmentRefs, mergeDocumentsFn, opts = {}) {
	const attached = [];
	const skipped = [];
	if (!Array.isArray(garmentRefs) || !garmentRefs.length) return { attached, skipped };

	const primary = findPrimarySkin(doc);
	if (!primary) {
		return {
			attached,
			skipped: garmentRefs.map((r) => ({ id: r.id, reason: 'avatar has no skin to bind against' })),
		};
	}

	let catalog;
	try {
		catalog = opts.catalog || (await loadServerCatalog());
	} catch (err) {
		return {
			attached,
			skipped: garmentRefs.map((r) => ({ id: r.id, reason: `catalog unavailable: ${err.message}` })),
		};
	}
	const byKey = new Map(catalog.map((g) => [`${g.slot}/${g.id}`, g]));

	const scene = doc.getRoot().getDefaultScene() || doc.getRoot().listScenes()[0];
	const occludeRegions = new Set();

	for (const ref of garmentRefs) {
		const manifest = byKey.get(`${ref.slot}/${ref.id}`);
		if (!manifest) {
			skipped.push({ id: ref.id, reason: 'not in catalog' });
			continue;
		}

		let bytes;
		try {
			bytes = await (opts.fetchBytes || fetchGarmentBytes)(manifest);
		} catch (err) {
			skipped.push({ id: ref.id, reason: err.message });
			continue;
		}

		const garmentDoc = await io.readBinary(new Uint8Array(bytes));

		// Tag the garment's scene roots so we can find them after the merge
		// (mergeDocuments disconnects source refs — same trick as the accessory
		// path in bake.js).
		const gScene =
			garmentDoc.getRoot().getDefaultScene() || garmentDoc.getRoot().listScenes()[0];
		const roots = gScene
			? [...gScene.listChildren()]
			: garmentDoc.getRoot().listNodes().filter((n) => !n.listParents().some((p) => p.propertyType === 'Node'));
		const tag = `__garment_${ref.slot}_${ref.id}`;
		roots.forEach((node, i) => node.setName(`${tag}_${i}`));

		mergeDocumentsFn(doc, garmentDoc);

		const mergedRoots = doc.getRoot().listNodes().filter((n) => (n.getName() || '').startsWith(tag));
		// Collect every mesh-bearing node under the merged roots.
		const meshNodes = [];
		const stack = [...mergedRoots];
		while (stack.length) {
			const node = stack.pop();
			if (node.getMesh()) meshNodes.push(node);
			stack.push(...node.listChildren());
		}

		const parents = parentMap(doc);
		let attachedAny = false;
		for (const node of meshNodes) {
			const gSkin = node.getSkin();
			if (gSkin) {
				const remap = buildJointRemap(gSkin, primary.skin, parents);
				const coverage = bindCoverageOfMesh(node.getMesh(), remap);
				if (coverage < MIN_BIND_COVERAGE) {
					skipped.push({
						id: ref.id,
						reason: `binds ${(coverage * 100).toFixed(0)}% of skin weight (need ${MIN_BIND_COVERAGE * 100}%)`,
					});
					continue;
				}
				remapMeshSkinAttributes(node.getMesh(), remap);
				node.setSkin(buildReboundSkin(doc, gSkin, primary.skin, remap, `garment:${ref.id}`));
				// Per glTF 2.0 the transform of a skinned mesh node is ignored —
				// parking it at the scene root is spec-correct.
				for (const s of doc.getRoot().listScenes()) s.removeChild(node);
				const parent = parents.get(node);
				if (parent) parent.removeChild(node);
				scene.addChild(node);
				attachedAny = true;
			} else {
				// Rigid piece: parent to the manifest's attach bone, keeping the
				// authored offset (matches the runtime's rigid path).
				const boneName = canonicalizeBoneName(manifest.rig?.attachBone || 'Head') || 'Head';
				const target = primary.skin
					.listJoints()
					.find((jn) => canonicalizeBoneName(jn.getName() || '') === boneName);
				if (!target) continue;
				const parent = parents.get(node);
				if (parent) parent.removeChild(node);
				for (const s of doc.getRoot().listScenes()) s.removeChild(node);
				target.addChild(node);
				attachedAny = true;
			}
		}

		// Drop the garment's own skeleton/scene scaffolding; prune() reclaims it.
		for (const root of mergedRoots) {
			for (const s of doc.getRoot().listScenes()) s.removeChild(root);
		}

		if (attachedAny) {
			attached.push(ref.id);
			// Same apply-time clamp as the closet: a manifest cannot hide regions
			// its slot may not cover (and `scalp` is never cullable: Head-bone
			// granularity would take the face with it).
			for (const region of clampOccludes(manifest.slot, manifest.occludes)) occludeRegions.add(region);
		}
	}

	if (occludeRegions.size) {
		cullBodyRegions(primary.mesh, primary.skin, [...occludeRegions]);
	}

	return { attached, skipped };
}

async function fetchGarmentBytes(manifest) {
	const res = await fetchUpstream(manifest.model.uri, {}, { timeoutMs: 60_000, attempts: 2, okWhen: () => true });
	if (!res.ok) throw new Error(`garment download failed: ${res.status}`);
	const bytes = await res.arrayBuffer();
	const hex = createHash('sha256').update(Buffer.from(bytes)).digest('hex');
	if (hex !== manifest.model.sha256) {
		throw new Error('garment bytes failed integrity check');
	}
	return bytes;
}
