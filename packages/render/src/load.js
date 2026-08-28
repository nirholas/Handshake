/**
 * Load a GLB into a renderable model, with no DOM and no GPU.
 * ----------------------------------------------------------
 * Textures are lifted out of the container before three.js sees the file (see
 * ./glb.js), decoded here, and re-attached as plain CPU mip pyramids keyed by
 * the glTF material index. Geometry, skins and animation clips come from the
 * real GLTFLoader, so anything the three.ws viewer can display, this can too:
 * meshopt compression, quantized attributes, morph-free humanoid rigs.
 */

import './env-shim.js';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import fs from 'node:fs/promises';
import { parseGlb, packGlb, extractImages, stripImages } from './glb.js';
import { decodeImage, buildMipmaps } from './image.js';

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

async function readSource(source, { maxBytes, fetchImpl, timeoutMs }) {
	if (source instanceof ArrayBuffer) return source;
	if (ArrayBuffer.isView(source)) return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
	if (typeof source !== 'string') throw new Error('source must be a URL, a file path, an ArrayBuffer or a TypedArray');

	if (/^https?:\/\//i.test(source)) {
		const doFetch = fetchImpl || globalThis.fetch;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const res = await doFetch(source, { signal: controller.signal, redirect: 'follow' });
			if (!res.ok) throw new Error(`model fetch failed: ${res.status} ${res.statusText}`);
			const declared = Number(res.headers?.get?.('content-length') || 0);
			if (declared && declared > maxBytes) throw new Error(`model is ${declared} bytes, over the ${maxBytes} byte cap`);
			const buf = await res.arrayBuffer();
			if (buf.byteLength > maxBytes) throw new Error(`model is ${buf.byteLength} bytes, over the ${maxBytes} byte cap`);
			return buf;
		} finally {
			clearTimeout(timer);
		}
	}

	const file = await fs.readFile(source);
	if (file.byteLength > maxBytes) throw new Error(`model is ${file.byteLength} bytes, over the ${maxBytes} byte cap`);
	return file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
}

function assertSupported(json) {
	const required = json.extensionsRequired || [];
	const unsupported = required.filter((name) => name === 'KHR_draco_mesh_compression');
	if (unsupported.length) {
		throw new Error(
			`${unsupported.join(', ')} needs an external decoder this renderer does not ship. ` +
				'Re-export the model with meshopt compression (gltfpack -cc) and it loads.',
		);
	}
}

async function decodeTextures(images, bindings, { maxTextureSize }) {
	const wanted = new Set();
	for (const binding of bindings.values()) {
		if (binding.baseColor) wanted.add(binding.baseColor.image);
		if (binding.emissive) wanted.add(binding.emissive.image);
	}
	const textures = new Map();
	await Promise.all(
		[...wanted].map(async (index) => {
			const encoded = images.get(index);
			if (!encoded) return;
			const decoded = await decodeImage(encoded.bytes, encoded.mimeType, { maxSize: maxTextureSize });
			if (decoded) textures.set(index, buildMipmaps(decoded));
		}),
	);
	return textures;
}

/**
 * @param {string|ArrayBuffer|ArrayBufferView} source URL, path, or raw GLB bytes.
 * @returns {Promise<{scene: THREE.Object3D, animations: THREE.AnimationClip[], bindings: Map, textures: Map}>}
 */
export async function loadModel(source, options = {}) {
	const {
		maxBytes = DEFAULT_MAX_BYTES,
		maxTextureSize = 1024,
		textures: wantTextures = true,
		fetchImpl,
		timeoutMs = 20_000,
	} = options;

	const raw = await readSource(source, { maxBytes, fetchImpl, timeoutMs });
	const { json, bin } = parseGlb(raw);
	assertSupported(json);

	const images = wantTextures ? extractImages(json, bin) : new Map();
	const { json: strippedJson, bindings } = stripImages(json);
	const stripped = packGlb(strippedJson, bin);

	const loader = new GLTFLoader();
	loader.setMeshoptDecoder(MeshoptDecoder);

	const gltf = await new Promise((resolve, reject) => {
		loader.parse(stripped, '', resolve, (err) => reject(err instanceof Error ? err : new Error(String(err))));
	});

	const textures = wantTextures ? await decodeTextures(images, bindings, { maxTextureSize }) : new Map();

	gltf.scene.updateMatrixWorld(true);
	return { scene: gltf.scene, animations: gltf.animations || [], bindings, textures };
}

export { THREE };
