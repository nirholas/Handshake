// Server-side avatar appearance baker.
//
// Takes a base GLB + an `appearance` record and produces a derived GLB where:
//   - outfit morph bindings + raw morph overrides are baked into node-level weights
//   - bone-attached accessory GLBs (hats, glasses, earrings) are merged in and
//     re-parented under the named skeleton bone (Head, etc).
//
// The output is a single glTF 2.0 binary — every viewer (three.js, model-viewer,
// Babylon.js, Unreal/Unity importers) sees the fully dressed avatar with no
// special runtime code. three.ws serves the baked URL directly so consumers
// never have to know about the customization layer.
//
// Bone-name matching tolerates the common `mixamorig:`, `CC_Base_`, and `rig_`
// prefixes so avatars produced by any upstream rigger work without rename.

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import {
	mergeDocuments,
	prune,
	dedup,
	unpartition,
	weld,
	quantize,
	meshopt,
	textureCompress,
} from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import sharp from 'sharp';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isValidPresetId } from './accessories.js';
import { env } from './env.js';
import { getObjectBuffer, putObject } from './r2.js';

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Stable sha256 over the canonical JSON form of `appearance`. Used as the cache
 * key for baked GLBs — when the hash matches `avatars.appearance_hash`, the
 * existing `baked_storage_key` is still valid.
 */
export function appearanceHash(appearance) {
	if (!appearance) return null;
	return createHash('sha256').update(canonicalize(appearance)).digest('hex');
}

/**
 * Returns true if the appearance has anything bakeable (outfit, accessories, morphs).
 * An empty / null appearance bakes to the base GLB unchanged — skip the work.
 */
export function isBakeable(appearance) {
	if (!appearance) return false;
	if (appearance.outfit) return true;
	if (Array.isArray(appearance.accessories) && appearance.accessories.length > 0) return true;
	if (appearance.morphs && Object.keys(appearance.morphs).length > 0) return true;
	if (appearance.colors && Object.keys(appearance.colors).length > 0) return true;
	if (Array.isArray(appearance.hidden) && appearance.hidden.length > 0) return true;
	return false;
}

/**
 * Bake `appearance` into a copy of the base GLB. Returns Uint8Array of the GLB.
 *
 * @param {Uint8Array|Buffer} baseGlbBytes
 * @param {object} appearance — { outfit?, accessories?, morphs? }
 * @returns {Promise<Uint8Array>}
 */
export async function bakeAppearance(baseGlbBytes, appearance) {
	// `meshopt({ encoder })` configures the EXT_meshopt_compression extension on
	// the document, but the writer also needs the encoder when serializing the
	// compressed buffers, and the reader needs the decoder when re-baking a
	// previously-baked GLB that already carries meshopt-compressed buffers.
	// Register both as io-level dependencies.
	await Promise.all([MeshoptEncoder.ready, MeshoptDecoder.ready]);
	const io = new NodeIO()
		.registerExtensions(ALL_EXTENSIONS)
		.registerDependencies({
			'meshopt.encoder': MeshoptEncoder,
			'meshopt.decoder': MeshoptDecoder,
		});
	const doc = await io.readBinary(toUint8(baseGlbBytes));

	const presets = await loadPresets();
	const byId = new Map(presets.map((p) => [p.id, p]));

	const presetIds = [];
	if (appearance?.outfit && isValidPresetId(appearance.outfit)) presetIds.push(appearance.outfit);
	for (const id of appearance?.accessories || []) {
		if (isValidPresetId(id)) presetIds.push(id);
	}

	// 1) Aggregate morph weights: outfit.morphBinding + appearance.morphs.
	//    appearance.morphs wins on key conflict (user override beats preset).
	const morphMap = {};
	for (const id of presetIds) {
		const p = byId.get(id);
		if (p?.morphBinding) Object.assign(morphMap, p.morphBinding);
	}
	if (appearance?.morphs) Object.assign(morphMap, appearance.morphs);
	if (Object.keys(morphMap).length > 0) applyMorphs(doc, morphMap);

	// 1b) Material tints: multiply each slot's baseColorFactor by the chosen color.
	if (appearance?.colors && Object.keys(appearance.colors).length > 0) {
		applyColors(doc, appearance.colors);
	}

	// 1c) Hidden garment layers: drop the meshes so the bake exposes the base
	//     body (the "start minimal" wardrobe state). prune() in the compression
	//     pass reclaims the now-unreferenced meshes/materials/textures.
	if (Array.isArray(appearance?.hidden) && appearance.hidden.length > 0) {
		applyHidden(doc, appearance.hidden);
	}

	// 2) Bone-mounted accessory GLBs.
	for (let i = 0; i < presetIds.length; i++) {
		const id = presetIds[i];
		const preset = byId.get(id);
		if (!preset?.glbUrl) continue;

		let accessoryBytes;
		try {
			accessoryBytes = await loadAccessoryGlb(preset.glbUrl);
		} catch (err) {
			console.warn(`[bake] failed to load accessory ${preset.id}: ${err.message}`);
			continue;
		}

		const accDoc = await io.readBinary(toUint8(accessoryBytes));
		const bone = findBone(doc, preset.attachBone);
		if (!bone) {
			console.warn(`[bake] bone "${preset.attachBone}" not found for ${preset.id}`);
			continue;
		}

		// mergeDocuments copies properties into the target graph — the originals
		// in accDoc become disconnected. We can't keep refs across the merge, so
		// rename the accessory's scene roots to a guaranteed-unique tag, merge,
		// then look them up by name in the merged document. Re-parent under the
		// target bone and finally restore each node's original name.
		const accScene =
			accDoc.getRoot().getDefaultScene() || accDoc.getRoot().listScenes()[0] || null;
		const accRootSrcs = accScene
			? [...accScene.listChildren()]
			: accDoc
					.getRoot()
					.listNodes()
					.filter((n) => !n.getParentNode());

		const tag = `__bake_${id}_${i}_${Date.now().toString(36)}`;
		const renamed = accRootSrcs.map((node, idx) => {
			const original = node.getName();
			const unique = `${tag}_${idx}`;
			node.setName(unique);
			return { unique, original };
		});

		mergeDocuments(doc, accDoc);

		for (const { unique, original } of renamed) {
			const node = doc
				.getRoot()
				.listNodes()
				.find((n) => n.getName() === unique);
			if (!node) {
				console.warn(`[bake] merged node "${unique}" missing after mergeDocuments`);
				continue;
			}
			// Detach from any scene it landed in after merge.
			for (const scene of doc.getRoot().listScenes()) {
				scene.removeChild(node);
			}
			bone.addChild(node);
			node.setName(original);
		}
	}

	// 3) Tag + clean.
	const asset = doc.getRoot().getAsset();
	asset.generator =
		(asset.generator || '') + ' / three.ws appearance-baker @gltf-transform';
	const extras = doc.getRoot().getAsset().extras || {};
	doc.getRoot().getAsset().extras = {
		...extras,
		bakedAt: new Date().toISOString(),
		appearance: appearance ?? null,
	};

	// Compression pipeline:
	//
	//   unpartition  →  collapse base+accessory buffers into one (GLB requires it)
	//   prune        →  drop unreachable nodes/materials/textures
	//   dedup        →  merge identical accessors, materials, samplers
	//   weld         →  fold duplicate vertices (typically -15..30% mesh bytes)
	//   quantize     →  reduce attribute precision: int16 positions / int8 normals
	//                   / int16 UVs. Visually lossless for human-scale meshes.
	//   textureCompress → re-encode base-color / normal / roughness textures via
	//                   sharp to WebP at a 1024px cap. WebP is supported by every
	//                   browser model-viewer ships in and by three.js since r136.
	//   meshopt        →  KHR_mesh_quantization + KHR_meshopt_compression encoding.
	//                   Adds 2–3× further size reduction on top of weld+quantize.
	//                   Natively decoded by three.js; no separate decoder bundle needed.
	//
	// All operations are conservative: defaults chosen so the same bake works on
	// arbitrary user-uploaded GLBs without visible artifacts. If a transform
	// throws on a pathological input we still want a baked GLB to land, so each
	// transform group is wrapped — a failure in compression is logged and we
	// fall back to the unoptimized but correct output.
	try {
		await MeshoptEncoder.ready;
		await doc.transform(
			unpartition(),
			prune(),
			dedup(),
			weld(),
			quantize({
				quantizePosition: 14,
				quantizeNormal: 10,
				quantizeTexcoord: 12,
				quantizeColor: 8,
				quantizeWeight: 8,
				quantizeGeneric: 12,
			}),
			// level: 'medium' — keeps bake time bounded. 'high' adds a small
			// extra reduction at substantial encoder-time cost.
			meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
			textureCompress({
				encoder: sharp,
				targetFormat: 'webp',
				resize: [1024, 1024],
				quality: 85,
			}),
		);
	} catch (err) {
		console.warn(
			`[bake] compression pass failed (${err?.message}); falling back to minimal transform`,
		);
		// Keep the basics so the GLB at least validates and is small-ish.
		await doc.transform(unpartition(), prune(), dedup());
	}

	return io.writeBinary(doc);
}

/**
 * Derive the R2 storage key for the baked variant of an avatar.
 * Path mirrors the base storage layout so all derived files for an avatar stay
 * grouped by user and slug, and the hash is the cache key so old bakes don't
 * overwrite mid-flight.
 */
export function bakedStorageKeyFor({ baseStorageKey, hash }) {
	// baseStorageKey is "u/{userId}/{slug}/{ts}.glb"
	const parts = baseStorageKey.split('/');
	const base = parts.slice(0, -1).join('/');
	return `${base}/baked-${hash.slice(0, 16)}.glb`;
}

/**
 * End-to-end bake: read the base GLB from R2, apply `appearance`, upload the
 * resulting GLB to R2 under a hash-keyed path, and return the new key + hash.
 *
 * Returns `null` if `appearance` has nothing bakeable (no outfit, accessories,
 * or morph overrides) — caller should clear the baked fields in that case.
 *
 * @param {object} args
 * @param {string} args.baseStorageKey  Existing GLB key in R2 (avatar.storage_key)
 * @param {object} args.appearance      { outfit?, accessories?, morphs? }
 * @returns {Promise<{baked_storage_key: string, appearance_hash: string, size_bytes: number} | null>}
 */
export async function bakeAndUploadAppearance({ baseStorageKey, appearance }) {
	if (!isBakeable(appearance)) return null;

	const baseBytes = await getObjectBuffer(baseStorageKey);
	const bakedBytes = await bakeAppearance(baseBytes, appearance);
	const hash = appearanceHash(appearance);
	const bakedKey = bakedStorageKeyFor({ baseStorageKey, hash });

	await putObject({
		key: bakedKey,
		body: Buffer.from(bakedBytes),
		contentType: 'model/gltf-binary',
		metadata: {
			'baked-from': baseStorageKey,
			'appearance-hash': hash,
		},
	});

	return {
		baked_storage_key: bakedKey,
		appearance_hash: hash,
		size_bytes: bakedBytes.byteLength,
	};
}

// ── Internals ──────────────────────────────────────────────────────────────

function toUint8(buf) {
	if (buf instanceof Uint8Array && !Buffer.isBuffer(buf)) return buf;
	if (Buffer.isBuffer(buf)) return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
	return new Uint8Array(buf);
}

function canonBoneName(name) {
	return String(name || '')
		.replace(/^mixamorig[_:]?/i, '')
		.replace(/^CC_Base_/i, '')
		.replace(/^rig_/i, '')
		.toLowerCase();
}

function findBone(doc, targetName) {
	if (!targetName) return null;
	const target = String(targetName).toLowerCase();
	for (const node of doc.getRoot().listNodes()) {
		const n = node.getName();
		if (n === targetName) return node;
		if (canonBoneName(n) === target) return node;
	}
	return null;
}

/**
 * Apply a name→weight binding to every node whose mesh exposes a matching morph
 * target. Target names are read from `mesh.extras.targetNames` (KHR convention)
 * with a fallback to per-primitive extras. Node-level weights override mesh
 * defaults; setting them here means every renderer sees the baked pose.
 */
function applyMorphs(doc, binding) {
	for (const node of doc.getRoot().listNodes()) {
		const mesh = node.getMesh();
		if (!mesh) continue;

		const names = collectTargetNames(mesh);
		if (!names.length) continue;

		// Start from existing node weights, falling back to mesh defaults, padded
		// to the target count so we don't lose existing morph pose.
		const meshWeights = mesh.getWeights() || [];
		const nodeWeights = node.getWeights() || [];
		const weights = new Array(names.length);
		for (let i = 0; i < names.length; i++) {
			weights[i] = nodeWeights[i] ?? meshWeights[i] ?? 0;
		}

		let changed = false;
		for (const [name, weight] of Object.entries(binding)) {
			const idx = names.indexOf(name);
			if (idx < 0) continue;
			weights[idx] = clamp01(weight);
			changed = true;
		}
		if (changed) node.setWeights(weights);
	}
}

// Garment slots → GLB material names. Mirrors COLOR_SLOTS in src/avatar-studio.js,
// WARDROBE_SLOTS in src/avatar-wardrobe.js, and the slot-id allowlists in
// api/_lib/accessories.js. Tints key skin/hair/outfit; hide keys
// hair/outfit/glasses (skin is never hidden).
const SLOT_MATERIALS = {
	skin: ['Wolf3D_Skin', 'Wolf3D_Body'],
	hair: ['Wolf3D_Hair'],
	outfit: ['Wolf3D_Outfit_Top', 'Wolf3D_Outfit_Bottom', 'Wolf3D_Outfit_Footwear'],
	glasses: ['Wolf3D_Glasses'],
};

/**
 * Set the baseColorFactor RGB of each slot's materials to the chosen color,
 * preserving the existing alpha. This mirrors the studio live preview, which
 * replaces `material.color` (the shader then multiplies factor × baseColorTexture
 * at render, so texture detail is retained in both places).
 *
 * Colors arrive as sRGB hex (matching the browser <input type=color> and the
 * three.js color pipeline); glTF baseColorFactor is linear, so convert per
 * channel to keep the baked GLB identical to what the user saw in the studio.
 */
function applyColors(doc, colors) {
	const nameToFactor = new Map();
	for (const [slot, hex] of Object.entries(colors)) {
		const mats = SLOT_MATERIALS[slot];
		const rgb = hexToLinearRgb(hex);
		if (!mats || !rgb) continue;
		for (const name of mats) nameToFactor.set(name, rgb);
	}
	if (nameToFactor.size === 0) return;

	for (const material of doc.getRoot().listMaterials()) {
		const factor = nameToFactor.get(material.getName());
		if (!factor) continue;
		const prevAlpha = material.getBaseColorFactor()?.[3] ?? 1;
		material.setBaseColorFactor([factor[0], factor[1], factor[2], prevAlpha]);
	}
}

/**
 * Remove the meshes belonging to each hidden slot. A node is dropped when any
 * of its mesh primitives uses one of the slot's named materials; disposing the
 * node orphans the mesh, which prune() then reclaims. Skeleton joints are never
 * touched (they carry no mesh), so the rig stays intact for the base body and
 * any still-visible garments.
 */
function applyHidden(doc, hidden) {
	const names = new Set();
	for (const slot of hidden) {
		const mats = SLOT_MATERIALS[slot];
		if (mats) for (const m of mats) names.add(m);
	}
	if (names.size === 0) return;

	for (const node of doc.getRoot().listNodes()) {
		const mesh = node.getMesh();
		if (!mesh) continue;
		const hit = mesh
			.listPrimitives()
			.some((p) => names.has(p.getMaterial()?.getName()));
		if (hit) node.dispose();
	}
}

function hexToLinearRgb(hex) {
	if (typeof hex !== 'string' || !/^#[0-9a-f]{6}$/i.test(hex)) return null;
	const n = parseInt(hex.slice(1), 16);
	return [
		srgbToLinear(((n >> 16) & 0xff) / 255),
		srgbToLinear(((n >> 8) & 0xff) / 255),
		srgbToLinear((n & 0xff) / 255),
	];
}

function srgbToLinear(c) {
	return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function collectTargetNames(mesh) {
	const ext = mesh.getExtras() || {};
	if (Array.isArray(ext.targetNames) && ext.targetNames.length > 0) return ext.targetNames;
	for (const prim of mesh.listPrimitives()) {
		const pExt = prim.getExtras() || {};
		if (Array.isArray(pExt.targetNames) && pExt.targetNames.length > 0) return pExt.targetNames;
	}
	return [];
}

function clamp01(n) {
	const v = Number(n);
	if (!Number.isFinite(v)) return 0;
	if (v < 0) return 0;
	if (v > 1) return 1;
	return v;
}

let _presetsCache = null;
async function loadPresets() {
	if (_presetsCache) return _presetsCache;
	const file = await readFile(
		path.resolve(process.cwd(), 'public/accessories/presets.json'),
		'utf-8',
	);
	_presetsCache = JSON.parse(file);
	return _presetsCache;
}

const _accCache = new Map();
async function loadAccessoryGlb(glbUrl) {
	if (_accCache.has(glbUrl)) return _accCache.get(glbUrl);

	const fsPath = path.resolve(process.cwd(), 'public' + glbUrl);
	let buf;
	try {
		buf = await readFile(fsPath);
	} catch (err) {
		// On Vercel functions, public/ assets may not be bundled with the function.
		// Fall back to fetching from the deployed site over HTTPS.
		const base = env.APP_ORIGIN || 'https://three.ws';
		const r = await fetch(base + glbUrl);
		if (!r.ok) {
			throw new Error(`accessory fetch failed: ${base + glbUrl} → ${r.status}`);
		}
		buf = Buffer.from(await r.arrayBuffer());
	}
	_accCache.set(glbUrl, buf);
	return buf;
}

// Canonical JSON for hashing: keys sorted, objects/arrays recursed, primitives
// serialized stably. NaN/undefined collapse to null so two semantically equal
// inputs always hash the same regardless of caller key ordering.
function canonicalize(obj) {
	if (obj === undefined || obj === null) return 'null';
	if (typeof obj === 'number') return Number.isFinite(obj) ? String(obj) : 'null';
	if (typeof obj === 'boolean' || typeof obj === 'string') return JSON.stringify(obj);
	if (Array.isArray(obj)) return '[' + obj.map(canonicalize).join(',') + ']';
	if (typeof obj === 'object') {
		const keys = Object.keys(obj).sort();
		return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') + '}';
	}
	return 'null';
}
