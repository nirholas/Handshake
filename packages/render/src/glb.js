/**
 * GLB container surgery.
 * ----------------------
 * three.js' GLTFLoader is happy to parse geometry, skins and animation clips
 * in Node, but every texture it meets goes through ImageBitmapLoader, which
 * needs a DOM that does not exist here. Rather than shimming a browser we do
 * the honest thing: split the container ourselves, lift the encoded images out
 * of the binary chunk, rewrite the JSON so it declares no images at all, and
 * re-attach our own decoded pixels afterwards.
 *
 * The rewrite carries a marker (`extras.__twsMaterial`) on every material so
 * the re-attach step can map a three.js Material back to the glTF material
 * index it came from. GLTFLoader copies `extras` onto `Material.userData`,
 * which makes that mapping exact rather than name-based (names collide).
 */

const MAGIC_GLTF = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a; // "JSON"
const CHUNK_BIN = 0x004e4942; // "BIN\0"

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

function pad4(n) {
	return (4 - (n % 4)) % 4;
}

/** Split a .glb ArrayBuffer into its JSON and BIN chunks. */
export function parseGlb(arrayBuffer) {
	const view = new DataView(arrayBuffer);
	if (arrayBuffer.byteLength < 12 || view.getUint32(0, true) !== MAGIC_GLTF) {
		throw new Error('not a GLB: missing glTF magic');
	}
	const version = view.getUint32(4, true);
	if (version !== 2) throw new Error(`unsupported GLB version ${version}`);
	const total = Math.min(view.getUint32(8, true), arrayBuffer.byteLength);

	let offset = 12;
	let json = null;
	let bin = null;
	while (offset + 8 <= total) {
		const length = view.getUint32(offset, true);
		const type = view.getUint32(offset + 4, true);
		const start = offset + 8;
		const end = Math.min(start + length, arrayBuffer.byteLength);
		if (type === CHUNK_JSON) json = JSON.parse(textDecoder.decode(new Uint8Array(arrayBuffer, start, end - start)));
		else if (type === CHUNK_BIN) bin = arrayBuffer.slice(start, end);
		offset = start + length + pad4(length);
	}
	if (!json) throw new Error('GLB has no JSON chunk');
	return { json, bin };
}

/** Re-pack a JSON + BIN pair into a .glb ArrayBuffer. */
export function packGlb(json, bin) {
	const jsonBytes = textEncoder.encode(JSON.stringify(json));
	const jsonPad = pad4(jsonBytes.length);
	const binBytes = bin ? new Uint8Array(bin) : null;
	const binPad = binBytes ? pad4(binBytes.length) : 0;

	let total = 12 + 8 + jsonBytes.length + jsonPad;
	if (binBytes) total += 8 + binBytes.length + binPad;

	const out = new ArrayBuffer(total);
	const view = new DataView(out);
	const bytes = new Uint8Array(out);

	view.setUint32(0, MAGIC_GLTF, true);
	view.setUint32(4, 2, true);
	view.setUint32(8, total, true);

	let offset = 12;
	view.setUint32(offset, jsonBytes.length + jsonPad, true);
	view.setUint32(offset + 4, CHUNK_JSON, true);
	bytes.set(jsonBytes, offset + 8);
	// glTF requires JSON chunks to be space-padded, not zero-padded.
	for (let i = 0; i < jsonPad; i++) bytes[offset + 8 + jsonBytes.length + i] = 0x20;
	offset += 8 + jsonBytes.length + jsonPad;

	if (binBytes) {
		view.setUint32(offset, binBytes.length + binPad, true);
		view.setUint32(offset + 4, CHUNK_BIN, true);
		bytes.set(binBytes, offset + 8);
	}
	return out;
}

function decodeDataUri(uri) {
	const comma = uri.indexOf(',');
	if (comma < 0) return null;
	const meta = uri.slice(5, comma);
	const isBase64 = /;base64$/i.test(meta);
	const mimeType = meta.replace(/;base64$/i, '') || 'application/octet-stream';
	const payload = uri.slice(comma + 1);
	const bytes = isBase64
		? Uint8Array.from(Buffer.from(payload, 'base64'))
		: textEncoder.encode(decodeURIComponent(payload));
	return { mimeType, bytes };
}

/**
 * Pull every embedded image out of a glTF, keyed by its image index.
 * Images referenced by an external URI are skipped: the renderer degrades to
 * the material's base colour factor rather than issuing side-band fetches.
 */
export function extractImages(json, bin) {
	const images = new Map();
	const defs = json.images || [];
	for (let i = 0; i < defs.length; i++) {
		const def = defs[i];
		if (typeof def.uri === 'string') {
			if (def.uri.startsWith('data:')) {
				const decoded = decodeDataUri(def.uri);
				if (decoded) images.set(i, { mimeType: def.mimeType || decoded.mimeType, bytes: decoded.bytes });
			}
			continue;
		}
		if (typeof def.bufferView !== 'number' || !bin) continue;
		const bv = json.bufferViews?.[def.bufferView];
		if (!bv) continue;
		// Only buffer 0 lives in the BIN chunk of a self-contained GLB.
		if ((bv.buffer ?? 0) !== 0) continue;
		const start = bv.byteOffset || 0;
		const length = bv.byteLength || 0;
		if (start + length > bin.byteLength) continue;
		images.set(i, { mimeType: def.mimeType || 'image/png', bytes: new Uint8Array(bin, start, length).slice() });
	}
	return images;
}

const WRAP = { 33071: 'clamp', 33648: 'mirror', 10497: 'repeat' };

function textureBinding(json, ref) {
	if (!ref || typeof ref.index !== 'number') return null;
	const tex = json.textures?.[ref.index];
	if (!tex) return null;
	// KHR_texture_basisu points at a KTX2 payload we do not decode; the caller
	// falls back to the material factor, which is a real colour, not a stand-in.
	const source = tex.source ?? tex.extensions?.KHR_texture_basisu?.source;
	if (typeof source !== 'number') return null;
	const sampler = typeof tex.sampler === 'number' ? json.samplers?.[tex.sampler] : null;
	return {
		image: source,
		uv: ref.texCoord || 0,
		wrapS: WRAP[sampler?.wrapS] || 'repeat',
		wrapT: WRAP[sampler?.wrapT] || 'repeat',
	};
}

/**
 * Rewrite a glTF so it declares no images, recording what each material used.
 * Returns the stripped JSON plus one binding record per material index.
 */
export function stripImages(json) {
	const out = structuredClone(json);
	const bindings = new Map();
	const materials = out.materials || [];

	for (let i = 0; i < materials.length; i++) {
		const mat = materials[i];
		const pbr = mat.pbrMetallicRoughness || {};
		const binding = {
			baseColor: textureBinding(json, pbr.baseColorTexture),
			emissive: textureBinding(json, mat.emissiveTexture),
			baseColorFactor: pbr.baseColorFactor || [1, 1, 1, 1],
			metallicFactor: pbr.metallicFactor ?? 1,
			roughnessFactor: pbr.roughnessFactor ?? 1,
			emissiveFactor: mat.emissiveFactor || [0, 0, 0],
			emissiveStrength: mat.extensions?.KHR_materials_emissive_strength?.emissiveStrength ?? 1,
			alphaMode: mat.alphaMode || 'OPAQUE',
			alphaCutoff: mat.alphaCutoff ?? 0.5,
			doubleSided: mat.doubleSided === true,
			name: mat.name || `material_${i}`,
		};
		bindings.set(i, binding);

		mat.extras = { ...(mat.extras || {}), __twsMaterial: i };
		delete pbr.baseColorTexture;
		delete pbr.metallicRoughnessTexture;
		delete mat.normalTexture;
		delete mat.occlusionTexture;
		delete mat.emissiveTexture;
		if (mat.extensions) {
			delete mat.extensions.KHR_materials_pbrSpecularGlossiness;
			delete mat.extensions.KHR_materials_sheen;
			delete mat.extensions.KHR_materials_transmission;
			delete mat.extensions.KHR_materials_volume;
			delete mat.extensions.KHR_materials_specular;
			delete mat.extensions.KHR_materials_clearcoat;
			delete mat.extensions.KHR_materials_iridescence;
			if (Object.keys(mat.extensions).length === 0) delete mat.extensions;
		}
	}

	delete out.images;
	delete out.textures;
	delete out.samplers;

	const dropped = new Set([
		'KHR_texture_basisu',
		'KHR_texture_transform',
		'EXT_texture_webp',
		'KHR_materials_pbrSpecularGlossiness',
		'KHR_materials_sheen',
		'KHR_materials_transmission',
		'KHR_materials_volume',
		'KHR_materials_specular',
		'KHR_materials_clearcoat',
		'KHR_materials_iridescence',
	]);
	const filterExt = (list) => (Array.isArray(list) ? list.filter((name) => !dropped.has(name)) : list);
	if (out.extensionsUsed) out.extensionsUsed = filterExt(out.extensionsUsed);
	if (out.extensionsRequired) out.extensionsRequired = filterExt(out.extensionsRequired);
	if (out.extensions) for (const name of dropped) delete out.extensions[name];

	return { json: out, bindings };
}
