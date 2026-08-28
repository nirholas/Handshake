// Turn a glTF Document into a flat, JSON-safe description of everything the
// diff cares about.
//
// This is the seam that makes the rest of the engine testable and portable.
// After describeDocument() runs there is no glTF-Transform object left in play,
// only plain data, so the matcher and the differ are ordinary functions over
// arrays that a unit test can build by hand. It is also what lets a description
// be computed once in the browser, cached, and diffed repeatedly against
// several candidates without re-parsing bytes.
//
// Two identity values hang off every entry and the distinction between them is
// the whole trick:
//   key         what the asset calls this thing (name, or hierarchy path for nodes)
//   fingerprint what this thing IS, with the name deliberately excluded
// Matching on `key` finds the obvious pairs. Matching leftovers on `fingerprint`
// is what turns "one object removed, one object added" into "renamed", which is
// the difference between a diff you can read and a wall of noise.

import { hashBytes, hashNumbers, hashString, hashValue } from './hash.js';
import { isGLB, readDocument } from './document.js';

export const DESCRIPTION_VERSION = 1;

// glTF primitive modes that produce triangles, and how many vertices each
// triangle consumes. Anything else (points, lines) contributes zero triangles.
const TRIANGLE_MODES = new Set([4, 5, 6]);

const PRIMITIVE_MODE_NAMES = {
	0: 'POINTS',
	1: 'LINES',
	2: 'LINE_LOOP',
	3: 'LINE_STRIP',
	4: 'TRIANGLES',
	5: 'TRIANGLE_STRIP',
	6: 'TRIANGLE_FAN',
};

// Attribute semantics whose values participate in the geometry hash, in a fixed
// order so the hash is stable. Positions decide "is this the same shape";
// normals and UVs decide "was it re-baked"; skin weights decide "was it
// re-skinned", which is a change a positions-only hash would miss entirely and
// which breaks animation in exactly the way this tool exists to catch.
const HASHED_SEMANTICS = ['POSITION', 'NORMAL', 'TANGENT', 'TEXCOORD_0', 'TEXCOORD_1', 'COLOR_0', 'JOINTS_0', 'WEIGHTS_0'];

function nameOf(prop, fallback) {
	const n = prop && typeof prop.getName === 'function' ? prop.getName() : '';
	return n || fallback;
}

// glTF names are optional, and plenty of exporters ship none. Inventing
// "mesh.0" would be worse than useless: it reads like a real name in the report
// and, worse, would match an unrelated object that happens to be third in the
// other file. Unnamed objects get a label that admits what it is and a key
// scoped to their index, so they only ever pair with the same slot on the other
// side.
function identify(prop, type, index) {
	const raw = prop && typeof prop.getName === 'function' ? prop.getName() : '';
	if (raw) return { name: raw, key: raw, unnamed: false };
	return { name: `(unnamed ${type} ${index})`, key: `#${type}.${index}`, unnamed: true };
}

function round(value, places = 5) {
	if (!Number.isFinite(value)) return 0;
	const f = 10 ** places;
	return Math.round(value * f) / f;
}

function roundArray(arr, places = 5) {
	if (!arr) return null;
	return Array.from(arr, (v) => round(v, places));
}

// ── Geometry ─────────────────────────────────────────────────────────────────

function describePrimitive(prim, materialNames) {
	const position = prim.getAttribute('POSITION');
	const vertices = position ? position.getCount() : 0;
	const indices = prim.getIndices();
	const mode = prim.getMode();
	const indexCount = indices ? indices.getCount() : 0;
	let triangles = 0;
	if (TRIANGLE_MODES.has(mode)) {
		const count = indices ? indexCount : vertices;
		triangles = mode === 4 ? Math.floor(count / 3) : Math.max(0, count - 2);
	}

	const semantics = prim.listSemantics().slice().sort();
	const material = prim.getMaterial();

	// The per-primitive geometry hash. Attribute arrays are hashed in a fixed
	// order under a seed naming the semantic, so a model that gained a UV set
	// does not hash the same as one that lost a color set of equal length.
	let geometry = hashString(`mode:${mode}`);
	for (const semantic of HASHED_SEMANTICS) {
		const attr = prim.getAttribute(semantic);
		if (!attr) continue;
		geometry = hashString(
			geometry + hashNumbers(attr.getArray(), { seed: semantic, quantize: !semantic.startsWith('JOINTS') }),
		);
	}
	if (indices) geometry = hashString(geometry + hashNumbers(indices.getArray(), { quantize: false, seed: 'INDICES' }));

	const targets = prim.listTargets().length;

	return {
		mode,
		modeName: PRIMITIVE_MODE_NAMES[mode] || `MODE_${mode}`,
		material: material ? nameOf(material, `material.${materialNames.get(material) ?? '?'}`) : null,
		attributes: semantics,
		vertices,
		triangles,
		indexed: Boolean(indices),
		morphTargets: targets,
		geometryHash: geometry,
	};
}

function boundsOf(prim) {
	const position = prim.getAttribute('POSITION');
	if (!position) return null;
	const min = position.getMin([]);
	const max = position.getMax([]);
	if (!min || !max || min.length < 3) return null;
	return { min: roundArray(min), max: roundArray(max) };
}

function unionBounds(a, b) {
	if (!a) return b;
	if (!b) return a;
	return {
		min: a.min.map((v, i) => Math.min(v, b.min[i])),
		max: a.max.map((v, i) => Math.max(v, b.max[i])),
	};
}

function describeMesh(mesh, index, materialNames) {
	const id = identify(mesh, 'mesh', index);
	const primitives = mesh.listPrimitives().map((p) => describePrimitive(p, materialNames));
	let bounds = null;
	for (const prim of mesh.listPrimitives()) bounds = unionBounds(bounds, boundsOf(prim));

	const vertices = primitives.reduce((sum, p) => sum + p.vertices, 0);
	const triangles = primitives.reduce((sum, p) => sum + p.triangles, 0);
	const geometryHash = hashString(primitives.map((p) => p.geometryHash).join('|'));

	return {
		type: 'mesh',
		index,
		name: id.name,
		unnamed: id.unnamed,
		primitives,
		vertices,
		triangles,
		bounds,
		geometryHash,
		key: id.key,
		fingerprint: hashString(`${geometryHash}|${primitives.map((p) => p.material || '').join(',')}`),
	};
}

// ── Hierarchy ────────────────────────────────────────────────────────────────

// Walk the scene graph and give every node a stable path. Siblings that share a
// name get a positional suffix, because a rig with three nodes called "Bone"
// under one parent is real and a path that cannot tell them apart would report
// phantom moves on every export.
function describeNodes(root, meshByProp) {
	const out = [];
	const seen = new Set();
	let index = 0;

	const visit = (node, parentPath, parentName, depth) => {
		const siblings = parentPath === null ? [] : null;
		void siblings;
		const raw = nameOf(node, `#node.${index}`);
		const path = parentPath ? `${parentPath}/${raw}` : raw;
		let unique = path;
		let bump = 1;
		while (seen.has(unique)) unique = `${path}#${bump++}`;
		seen.add(unique);

		const mesh = node.getMesh();
		const skin = node.getSkin();
		const camera = node.getCamera();
		const children = node.listChildren();
		const translation = roundArray(node.getTranslation());
		const rotation = roundArray(node.getRotation());
		const scale = roundArray(node.getScale());
		const meshDesc = mesh ? meshByProp.get(mesh) : null;

		out.push({
			type: 'node',
			index: index++,
			name: raw,
			path: unique,
			parent: parentName,
			depth,
			translation,
			rotation,
			scale,
			mesh: meshDesc ? meshDesc.name : null,
			skin: skin ? nameOf(skin, 'skin') : null,
			camera: camera ? nameOf(camera, 'camera') : null,
			childCount: children.length,
			key: unique,
			// Name-free identity: where it sits, what it carries, how it is posed.
			// A node that keeps its geometry and transform but changes name is a
			// rename; one that keeps its name and changes geometry is an edit.
			fingerprint: hashValue({
				t: translation,
				r: rotation,
				s: scale,
				g: meshDesc ? meshDesc.geometryHash : null,
				skin: Boolean(skin),
				children: children.length,
				depth,
			}),
		});

		for (const child of children) visit(child, unique, raw, depth + 1);
	};

	for (const scene of root.listScenes()) {
		for (const node of scene.listChildren()) visit(node, '', null, 0);
	}
	// Nodes reachable from no scene still ship in the file and still cost bytes,
	// so they are described rather than silently dropped.
	const covered = new Set(out.map((n) => n.name));
	for (const node of root.listNodes()) {
		if (node.getParentNode()) continue;
		const raw = nameOf(node, 'node');
		if (covered.has(raw)) continue;
		visit(node, '(detached)', null, 0);
	}
	return out;
}

// ── Appearance ───────────────────────────────────────────────────────────────

const TEXTURE_SLOTS = [
	['baseColor', 'getBaseColorTexture'],
	['metallicRoughness', 'getMetallicRoughnessTexture'],
	['normal', 'getNormalTexture'],
	['occlusion', 'getOcclusionTexture'],
	['emissive', 'getEmissiveTexture'],
];

function describeMaterial(material, index, textureByProp) {
	const id = identify(material, 'material', index);
	const slots = {};
	for (const [slot, getter] of TEXTURE_SLOTS) {
		const tex = material[getter]();
		const desc = tex ? textureByProp.get(tex) : null;
		slots[slot] = desc ? desc.name : tex ? 'texture' : null;
	}
	const core = {
		baseColorFactor: roundArray(material.getBaseColorFactor()),
		metallic: round(material.getMetallicFactor()),
		roughness: round(material.getRoughnessFactor()),
		emissiveFactor: roundArray(material.getEmissiveFactor()),
		normalScale: round(material.getNormalScale()),
		occlusionStrength: round(material.getOcclusionStrength()),
		alphaMode: material.getAlphaMode(),
		alphaCutoff: round(material.getAlphaCutoff()),
		doubleSided: material.getDoubleSided(),
		textures: slots,
	};
	const extensions = material
		.listExtensions()
		.map((e) => e.extensionName)
		.sort();
	return {
		type: 'material',
		index,
		name: id.name,
		unnamed: id.unnamed,
		...core,
		extensions,
		key: id.key,
		fingerprint: hashValue({ ...core, extensions }),
	};
}

function describeTexture(texture, index) {
	const id = identify(texture, 'texture', index);
	const image = texture.getImage();
	const size = texture.getSize();
	const [width, height] = size || [0, 0];
	const bytes = image ? image.byteLength : 0;
	const pixelHash = image ? hashBytes(image) : null;
	return {
		type: 'texture',
		index,
		name: id.name,
		unnamed: id.unnamed,
		mimeType: texture.getMimeType() || null,
		uri: texture.getURI() || null,
		width,
		height,
		bytes,
		pixelHash,
		key: id.key,
		fingerprint: pixelHash || hashValue({ width, height, bytes, mime: texture.getMimeType() }),
	};
}

// ── Motion ───────────────────────────────────────────────────────────────────

function samplerDuration(sampler) {
	const input = sampler.getInput();
	if (!input) return 0;
	const max = input.getMax([]);
	if (Array.isArray(max) && Number.isFinite(max[0])) return max[0];
	const array = input.getArray();
	return array && array.length ? array[array.length - 1] : 0;
}

function describeAnimation(animation, index) {
	const id = identify(animation, 'animation', index);
	const channels = animation.listChannels();
	const samplers = animation.listSamplers();
	let duration = 0;
	for (const sampler of samplers) duration = Math.max(duration, samplerDuration(sampler));

	// Which node each channel drives, and along which path. This is the list that
	// decides whether a clip still plays after a rig edit, so it is compared
	// entry by entry rather than summarized into a count.
	const targets = channels
		.map((ch) => {
			const node = ch.getTargetNode();
			return `${node ? nameOf(node, 'node') : '(none)'}.${ch.getTargetPath()}`;
		})
		.sort();

	const interpolations = [...new Set(samplers.map((s) => s.getInterpolation()))].sort();
	const keyframes = samplers.reduce((sum, s) => {
		const input = s.getInput();
		return sum + (input ? input.getCount() : 0);
	}, 0);

	return {
		type: 'animation',
		index,
		name: id.name,
		unnamed: id.unnamed,
		duration: round(duration, 4),
		channels: channels.length,
		samplers: samplers.length,
		keyframes,
		interpolations,
		targets,
		key: id.key,
		fingerprint: hashValue({ duration: round(duration, 4), targets, keyframes, interpolations }),
	};
}

function describeSkin(skin, index) {
	const id = identify(skin, 'skin', index);
	const joints = skin.listJoints().map((j) => nameOf(j, 'joint'));
	const ibm = skin.getInverseBindMatrices();
	const bindHash = ibm ? hashNumbers(ibm.getArray()) : null;
	const skeleton = skin.getSkeleton();
	return {
		type: 'skin',
		index,
		name: id.name,
		unnamed: id.unnamed,
		joints,
		jointCount: joints.length,
		skeleton: skeleton ? nameOf(skeleton, 'root') : null,
		bindHash,
		key: id.key,
		fingerprint: hashValue({ joints, bindHash }),
	};
}

// ── Entry point ──────────────────────────────────────────────────────────────

/**
 * Describe a parsed Document.
 * @param {import('@gltf-transform/core').Document} document
 * @param {{ name?: string, sizeBytes?: number, container?: 'glb'|'gltf' }} [meta]
 */
export function describeDocument(document, meta = {}) {
	const root = document.getRoot();
	const asset = root.getAsset();

	const materialProps = root.listMaterials();
	const textureProps = root.listTextures();
	const meshProps = root.listMeshes();

	const materialIndex = new Map(materialProps.map((m, i) => [m, i]));
	const textureByProp = new Map();
	const textures = textureProps.map((t, i) => {
		const desc = describeTexture(t, i);
		textureByProp.set(t, desc);
		return desc;
	});
	const materials = materialProps.map((m, i) => describeMaterial(m, i, textureByProp));
	const meshByProp = new Map();
	const meshes = meshProps.map((m, i) => {
		const desc = describeMesh(m, i, materialIndex);
		meshByProp.set(m, desc);
		return desc;
	});
	const nodes = describeNodes(root, meshByProp);
	const animations = root.listAnimations().map((a, i) => describeAnimation(a, i));
	const skins = root.listSkins().map((s, i) => describeSkin(s, i));

	const totals = {
		scenes: root.listScenes().length,
		nodes: nodes.length,
		meshes: meshes.length,
		materials: materials.length,
		textures: textures.length,
		animations: animations.length,
		skins: skins.length,
		joints: skins.reduce((sum, s) => sum + s.jointCount, 0),
		vertices: meshes.reduce((sum, m) => sum + m.vertices, 0),
		triangles: meshes.reduce((sum, m) => sum + m.triangles, 0),
		textureBytes: textures.reduce((sum, t) => sum + t.bytes, 0),
		sizeBytes: meta.sizeBytes ?? 0,
	};

	return {
		version: DESCRIPTION_VERSION,
		name: meta.name || null,
		container: meta.container || null,
		asset: {
			generator: asset.generator || null,
			version: asset.version || null,
			copyright: asset.copyright || null,
		},
		extensionsUsed: root
			.listExtensionsUsed()
			.map((x) => x.extensionName)
			.sort(),
		extensionsRequired: root
			.listExtensionsRequired()
			.map((x) => x.extensionName)
			.sort(),
		totals,
		nodes,
		meshes,
		materials,
		textures,
		animations,
		skins,
	};
}

/**
 * Read bytes and describe them in one call.
 * @param {Uint8Array} bytes
 * @param {{ name?: string }} [meta]
 */
export async function describeModel(bytes, meta = {}) {
	const document = await readDocument(bytes);
	return describeDocument(document, {
		...meta,
		sizeBytes: bytes.byteLength,
		container: isGLB(bytes) ? 'glb' : 'gltf',
	});
}
