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
 * }}
 */
export function inspectGlb(buf) {
	if (!isBufferLike(buf) || buf.length < 12 + 8) return null;
	const view = bufToDataView(buf);
	if (view.getUint32(0, true) !== GLB_MAGIC) return null;
	if (view.getUint32(4, true) !== 2) return null;
	if (view.getUint32(8, true) !== buf.length) return null;

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
	} catch {
		return null;
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
	};
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
	if (view.getUint32(8, true) !== buf.length) return false;
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
	if (Buffer.isBuffer?.(buf)) return buf.subarray(start, end);
	if (ArrayBuffer.isView(buf)) {
		return new Uint8Array(buf.buffer, buf.byteOffset + start, end - start);
	}
	return new Uint8Array(buf, start, end - start);
}
