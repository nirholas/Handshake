// glTF/GLB reading, shared by the library, the CLI, and the browser page.
//
// Deliberately mirrors the reader three.ws already runs in production
// (src/gltf-inspect.js): same WebIO, same full extension registry, same lazy
// meshopt decoder. Any divergence here would mean the diff sees a different
// model than the viewer does, which is the one bug this tool cannot afford.

import { WebIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';

const GLB_MAGIC = 0x46546c67; // "glTF"

export function isGLB(bytes) {
	if (!bytes || bytes.byteLength < 4) return false;
	const view = new DataView(bytes.buffer, bytes.byteOffset, Math.min(4, bytes.byteLength));
	return view.getUint32(0, true) === GLB_MAGIC;
}

// EXT_meshopt_compression is registered by ALL_EXTENSIONS but cannot decode
// without its wasm decoder supplied as a dependency, and most optimized web
// assets ship meshopt-compressed. Without the decoder those models throw on
// read, so the diff would refuse exactly the files people most want to compare
// (an optimized build against its source). Loaded lazily and memoized: a caller
// diffing two uncompressed models never pays for the wasm.
let decoderPromise = null;
function loadMeshoptDecoder() {
	if (!decoderPromise) {
		decoderPromise = import('meshoptimizer')
			.then(async (mod) => {
				const decoder = mod.MeshoptDecoder;
				if (!decoder) return null;
				if (decoder.ready) await decoder.ready;
				return decoder;
			})
			.catch(() => null);
	}
	return decoderPromise;
}

export async function createIO() {
	const io = new WebIO().registerExtensions(ALL_EXTENSIONS);
	const decoder = await loadMeshoptDecoder();
	if (decoder) io.registerDependencies({ 'meshopt.decoder': decoder });
	return io;
}

/**
 * Read raw bytes into a glTF-Transform Document.
 * @param {Uint8Array} bytes binary GLB or JSON glTF
 * @returns {Promise<import('@gltf-transform/core').Document>}
 */
export async function readDocument(bytes) {
	const io = await createIO();
	if (isGLB(bytes)) return io.readBinary(bytes);
	const text = new TextDecoder().decode(bytes);
	let json;
	try {
		json = JSON.parse(text);
	} catch {
		throw new Error('input is not a valid GLB or JSON glTF');
	}
	return io.readJSON({ json, resources: {} });
}
