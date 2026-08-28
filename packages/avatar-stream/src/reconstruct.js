/**
 * Headless reconstruction - replays an A3S stream back into plain geometry.
 * Node only.
 *
 * The three.js binding is the path a browser takes, but a format nobody can
 * check outside a GPU context is a format nobody can trust. This module applies
 * the same patches with nothing but typed arrays, which is what lets the test
 * suite prove the round trip is lossless, and what lets `a3s verify --deep`
 * check a file on a server with no renderer anywhere near it.
 */

import { A3SStream } from './reader.js';
import { getIO } from './pack.js';

const COMPONENT_ARRAYS = {
	5120: Int8Array,
	5121: Uint8Array,
	5122: Int16Array,
	5123: Uint16Array,
	5125: Uint32Array,
	5126: Float32Array,
};

function typedArrayFrom(bytes, componentType) {
	const TypedArray = COMPONENT_ARRAYS[componentType];
	if (!TypedArray) throw new Error(`a3s: unknown component type ${componentType}`);
	const copy = bytes.slice();
	return new TypedArray(copy.buffer, copy.byteOffset, copy.byteLength / TypedArray.BYTES_PER_ELEMENT);
}

/**
 * Read the base layer's per-primitive geometry, keyed by the packer's ordinal.
 * @returns {Promise<Map<number, { attributes: Record<string, {array: ArrayLike, elementSize: number}>, indices: Uint32Array }>>}
 */
export async function readBaseGeometry(baseGlb) {
	const io = await getIO();
	const doc = await io.readBinary(new Uint8Array(baseGlb));
	const primitives = new Map();
	let fallbackOrdinal = 0;
	for (const mesh of doc.getRoot().listMeshes()) {
		for (const prim of mesh.listPrimitives()) {
			const ordinal = prim.getExtras()?.a3sPrim ?? fallbackOrdinal;
			fallbackOrdinal++;
			const attributes = {};
			for (const semantic of prim.listSemantics()) {
				const accessor = prim.getAttribute(semantic);
				attributes[semantic] = { array: accessor.getArray(), elementSize: accessor.getElementSize() };
			}
			prim.listTargets().forEach((target, t) => {
				for (const semantic of target.listSemantics()) {
					const accessor = target.getAttribute(semantic);
					attributes[`targets/${t}/${semantic}`] = { array: accessor.getArray(), elementSize: accessor.getElementSize() };
				}
			});
			const indices = prim.getIndices();
			primitives.set(ordinal, {
				attributes,
				indices: indices ? new Uint32Array(indices.getArray()) : new Uint32Array(0),
			});
		}
	}
	return primitives;
}

/**
 * Replay a stream up to `throughLevel` (default: every layer) and return the
 * resulting geometry per primitive.
 *
 * @param {string|Uint8Array|object} target anything A3SStream.open accepts
 * @param {object} [options]
 * @param {number} [options.throughLevel]
 * @param {boolean} [options.verify] check each layer's hash while replaying
 */
export async function reconstruct(target, options = {}) {
	const stream = await A3SStream.open(target, options);
	const primitives = await readBaseGeometry(stream.base);
	const last = options.throughLevel ?? stream.layerCount - 1;

	for (let level = 1; level <= last; level++) {
		const { descriptor, payload } = await stream.layer(level, options);
		for (const entry of descriptor.prims || []) {
			const primitive = primitives.get(entry.prim);
			if (!primitive) continue;
			for (const [key, meta] of Object.entries(entry.attributes)) {
				// An attribute carries its own window, since morph deltas begin at zero
				// in the patch that introduces them while base attributes resume.
				const start = meta.start ?? entry.newVertexStart;
				const count = meta.count ?? entry.newVertexCount;
				const incoming = typedArrayFrom(A3SStream.chunk(payload, meta), meta.componentType);
				const stride = meta.elementSize;
				const TypedArray = COMPONENT_ARRAYS[meta.componentType];
				const existing = primitive.attributes[key]?.array;
				const merged = new TypedArray((start + count) * stride);
				if (existing) merged.set(existing.subarray(0, Math.min(existing.length, start * stride)), 0);
				merged.set(incoming.subarray(0, count * stride), start * stride);
				primitive.attributes[key] = { array: merged, elementSize: stride };
			}
			primitive.indices = new Uint32Array(typedArrayFrom(A3SStream.chunk(payload, entry.indices), entry.indices.componentType));
		}
	}
	return { stream, primitives };
}

/** Total triangles across every reconstructed primitive. */
export function triangleCount(primitives) {
	let total = 0;
	for (const primitive of primitives.values()) total += primitive.indices.length / 3;
	return total;
}

/**
 * A deterministic fingerprint of a primitive's triangles that does not depend on
 * vertex ordering: the sorted list of rounded triangle centroids. Two meshes
 * with the same fingerprint describe the same surface, however their buffers are
 * arranged, which is exactly the invariant the packer's reordering must preserve.
 */
export function triangleFingerprint(positions, indices, precision = 4) {
	const scale = 10 ** precision;
	const centroids = new Array(indices.length / 3);
	for (let t = 0; t < indices.length; t += 3) {
		const a = indices[t] * 3;
		const b = indices[t + 1] * 3;
		const c = indices[t + 2] * 3;
		const x = Math.round(((positions[a] + positions[b] + positions[c]) / 3) * scale) / scale;
		const y = Math.round(((positions[a + 1] + positions[b + 1] + positions[c + 1]) / 3) * scale) / scale;
		const z = Math.round(((positions[a + 2] + positions[b + 2] + positions[c + 2]) / 3) * scale) / scale;
		centroids[t / 3] = `${x},${y},${z}`;
	}
	centroids.sort();
	return centroids;
}
