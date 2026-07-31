// Deterministic GLB introspection helpers.
//
// Why server-side: we want to know whether a reconstructed avatar has a
// usable skeleton (skins[] in the glTF JSON) BEFORE it lands in the user's
// catalog, so the UI can show a "needs rigging" affordance and the materialize
// path can flag the avatar's metadata accordingly. Without this every
// TRELLIS / TripoSR output looks identical to a Hunyuan3D output that DOES
// have a rig — users would only discover the gap when they tried to animate.
//
// We parse only the 12-byte file header and the first JSON chunk header
// (the typical glTF 2.0 layout: HEADER + JSON_CHUNK + BIN_CHUNK?). We do not
// touch the BIN chunk so this is fast even on large meshes.
//
// Spec: https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#binary-gltf-layout

const GLB_MAGIC = 0x46546C67;       // 'glTF' little-endian
const CHUNK_JSON = 0x4E4F534A;      // 'JSON' little-endian
const CHUNK_BIN  = 0x004E4942;      // 'BIN\0' little-endian

/**
 * Inspect a GLB buffer and return what we can determine from the JSON chunk.
 * Returns null when the buffer isn't a valid binary glTF 2.0.
 *
 * @param {Buffer|Uint8Array} buf
 * @returns {null | {
 *   valid: true,
 *   sizeBytes: number,
 *   isRigged: boolean,
 *   skinCount: number,
 *   skeletonJointCount: number,
 *   nodeCount: number,
 *   meshCount: number,
 *   animationCount: number,
 *   generator: string | null,
 *   extensionsUsed: string[],
 *   hasBinChunk: boolean,
 *   binChunkBytes: number,
 *   morphTargetNames: string[],
 *   morphTargetSlots: number,
 *   boneNames: string[],
 *   animationNames: string[],
 *   primitiveCount: number,
 *   triangleCount: number,
 *   vertexCount: number,
 *   materialCount: number,
 *   textureCount: number,
 * }}
 */
export function inspectGlb(buf, { allowPartial = false } = {}) {
	if (!isBufferLike(buf) || buf.length < 12 + 8) return null;
	const view = bufToDataView(buf);
	if (view.getUint32(0, true) !== GLB_MAGIC) return null;
	if (view.getUint32(4, true) !== 2) return null;
	const declaredLen = view.getUint32(8, true);
	// Reject if declared length is inconsistent with the buffer or absurdly large.
	// 512 MB is a hard ceiling — no realistic avatar exceeds this; a corrupted
	// header could otherwise allocate enormous slices during JSON chunk reads.
	//
	// allowPartial: the caller deliberately fetched only a leading prefix (a
	// ranged read covering the JSON chunk), so declaredLen — the FULL file size —
	// legitimately exceeds buf.length. Skip that consistency check; the JSON
	// chunk's own bounds are still validated below, so a truncated/short prefix
	// (chunk not fully present) returns null and the caller can refetch.
	if (!allowPartial && declaredLen > buf.length) return null;
	if (declaredLen < 20) return null;
	if (declaredLen > 512 * 1024 * 1024) return null;

	// First chunk header at byte 12.
	const jsonChunkLen = view.getUint32(12, true);
	const jsonChunkType = view.getUint32(16, true);
	if (jsonChunkType !== CHUNK_JSON) return null;
	if (20 + jsonChunkLen > buf.length) return null;

	const jsonBytes = bufSlice(buf, 20, 20 + jsonChunkLen);
	let gltf;
	try {
		// glTF spec pads the JSON chunk with 0x20 (space) to a 4-byte boundary,
		// which JSON.parse tolerates as whitespace.
		gltf = JSON.parse(new TextDecoder('utf-8').decode(jsonBytes));
	} catch (err) {
		// Null signals "unparseable" to all callers uniformly. Log so the error
		// is diagnosable without changing the established return-type contract.
		console.warn('[glb-inspect] JSON chunk parse failed:', err.message);
		return null;
	}

	// Optional BIN chunk follows the JSON chunk at byte (20 + jsonChunkLen).
	// We don't read its body — just confirm the header validates so callers
	// can distinguish embedded-bin GLBs (Hunyuan3D, TRELLIS, model-viewer
	// exports) from JSON-only GLBs that point at external .bin files (rare in
	// our reconstruction flow but legal per spec).
	let hasBinChunk = false;
	let binChunkBytes = 0;
	const binChunkStart = 20 + jsonChunkLen;
	if (binChunkStart + 8 <= buf.length) {
		const binLen = view.getUint32(binChunkStart, true);
		const binType = view.getUint32(binChunkStart + 4, true);
		if (binType === CHUNK_BIN && binChunkStart + 8 + binLen <= buf.length) {
			hasBinChunk = true;
			binChunkBytes = binLen;
		}
	}

	const skins = Array.isArray(gltf.skins) ? gltf.skins : [];
	const animations = Array.isArray(gltf.animations) ? gltf.animations : [];
	const nodes = Array.isArray(gltf.nodes) ? gltf.nodes : [];
	const meshes = Array.isArray(gltf.meshes) ? gltf.meshes : [];
	const skeletonJointCount = skins.reduce(
		(acc, s) => acc + (Array.isArray(s.joints) ? s.joints.length : 0),
		0,
	);
	const generator = typeof gltf.asset?.generator === 'string' ? gltf.asset.generator : null;
	const extensionsUsed = Array.isArray(gltf.extensionsUsed) ? gltf.extensionsUsed : [];

	return {
		valid: true,
		sizeBytes: buf.length,
		isRigged: skins.length > 0 && skeletonJointCount > 0,
		skinCount: skins.length,
		skeletonJointCount,
		nodeCount: nodes.length,
		meshCount: meshes.length,
		animationCount: animations.length,
		generator,
		extensionsUsed,
		hasBinChunk,
		binChunkBytes,
		...describeAssetSurface(gltf, { skins, nodes, meshes, animations }),
	};
}

/**
 * The named, countable surface of a glTF asset: which morph targets and bones
 * it exposes, and how heavy the geometry is. Everything here is read from the
 * JSON chunk alone, so it costs nothing beyond the prefix already fetched.
 *
 * Morph target names live in `extras.targetNames` by convention (the glTF spec
 * has no first-class place for them). Blender, three.js, Ready Player Me and
 * Avaturn all write them on the mesh; some pipelines write them per-primitive
 * instead, so both are read and merged in declaration order.
 */
function describeAssetSurface(gltf, { skins, nodes, meshes, animations }) {
	const accessors = Array.isArray(gltf.accessors) ? gltf.accessors : [];
	const materials = Array.isArray(gltf.materials) ? gltf.materials : [];
	const textures = Array.isArray(gltf.textures) ? gltf.textures : [];

	const morphTargetNames = [];
	const seenMorph = new Set();
	const pushMorph = (list) => {
		if (!Array.isArray(list)) return;
		for (const name of list) {
			if (typeof name !== 'string' || seenMorph.has(name)) continue;
			seenMorph.add(name);
			morphTargetNames.push(name);
		}
	};

	let primitiveCount = 0;
	let triangleCount = 0;
	let vertexCount = 0;
	let morphSlotCount = 0;
	for (const mesh of meshes) {
		pushMorph(mesh?.extras?.targetNames);
		const primitives = Array.isArray(mesh?.primitives) ? mesh.primitives : [];
		for (const prim of primitives) {
			primitiveCount += 1;
			pushMorph(prim?.extras?.targetNames);
			if (Array.isArray(prim?.targets)) morphSlotCount = Math.max(morphSlotCount, prim.targets.length);
			const position = accessors[prim?.attributes?.POSITION];
			if (position?.count > 0) vertexCount += position.count;
			// mode 4 is TRIANGLES and is also the spec default when omitted.
			const mode = prim?.mode ?? 4;
			if (mode !== 4) continue;
			const indices = accessors[prim?.indices];
			const indexed = indices?.count > 0 ? indices.count : position?.count;
			if (indexed > 0) triangleCount += Math.floor(indexed / 3);
		}
	}

	const boneNames = [];
	const seenBone = new Set();
	for (const skin of skins) {
		const joints = Array.isArray(skin?.joints) ? skin.joints : [];
		for (const index of joints) {
			const name = nodes[index]?.name;
			if (typeof name !== 'string' || seenBone.has(name)) continue;
			seenBone.add(name);
			boneNames.push(name);
		}
	}

	const animationNames = animations
		.map((a) => (typeof a?.name === 'string' ? a.name : null))
		.filter(Boolean);

	return {
		morphTargetNames,
		// A mesh can carry morph targets with no names attached; the slot count
		// keeps "this model can morph" true even when nothing can address them.
		morphTargetSlots: morphSlotCount,
		boneNames,
		animationNames,
		primitiveCount,
		triangleCount,
		vertexCount,
		materialCount: materials.length,
		textureCount: textures.length,
	};
}

/**
 * Byte offset at which the glTF JSON chunk ends (i.e. the minimum prefix length
 * needed to parse it): 12-byte file header + 8-byte chunk header + chunk body.
 * Returns 0 when the buffer is too short or isn't a JSON-first binary glTF.
 * Lets a ranged-read caller fetch exactly enough on a second pass.
 */
export function glbJsonChunkEnd(buf) {
	if (!isBufferLike(buf) || buf.length < 20) return 0;
	const view = bufToDataView(buf);
	if (view.getUint32(0, true) !== GLB_MAGIC) return 0;
	if (view.getUint32(16, true) !== CHUNK_JSON) return 0;
	return 20 + view.getUint32(12, true);
}

/**
 * Strict header check used by upload boundaries — does not parse JSON.
 * Returns true iff the 12-byte header + first chunk header look valid.
 */
export function isValidGlbHeader(buf) {
	if (!isBufferLike(buf) || buf.length < 20) return false;
	const view = bufToDataView(buf);
	if (view.getUint32(0, true) !== GLB_MAGIC) return false;
	if (view.getUint32(4, true) !== 2) return false;
	const declaredLen = view.getUint32(8, true);
	if (declaredLen > buf.length || declaredLen < 20) return false;
	return true;
}

/**
 * Convenience: parse and report only the rigging signal, returning false on
 * any parse failure. Use this when you don't care about the full struct.
 */
export function isRiggedGlb(buf) {
	const info = inspectGlb(buf);
	return !!(info && info.isRigged);
}

function isBufferLike(buf) {
	return buf && typeof buf.byteLength === 'number' && buf.byteLength > 0;
}

function bufToDataView(buf) {
	if (buf instanceof DataView) return buf;
	if (ArrayBuffer.isView(buf)) {
		return new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	}
	if (buf instanceof ArrayBuffer) {
		return new DataView(buf);
	}
	// Node Buffer is a Uint8Array under the hood; covered above.
	throw new TypeError('expected Buffer / Uint8Array / DataView / ArrayBuffer');
}

function bufSlice(buf, start, end) {
	// `typeof` guard, not `Buffer?.isBuffer`: a browser has no `Buffer` binding
	// at all, and reading an undeclared identifier throws a ReferenceError that
	// optional chaining cannot catch. This module is reachable from the browser
	// via seed-mesh-gate.js (the /inspect page).
	if (typeof Buffer !== 'undefined' && Buffer.isBuffer?.(buf)) return buf.subarray(start, end);
	if (ArrayBuffer.isView(buf)) {
		return new Uint8Array(buf.buffer, buf.byteOffset + start, end - start);
	}
	return new Uint8Array(buf, start, end - start);
}
