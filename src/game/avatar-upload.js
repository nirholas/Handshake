// Bring-your-own-avatar upload pipeline for the /play lobby.
//
// A dropped .glb is only useful to a multiplayer room if every peer can fetch it,
// so a local `blob:` URL won't do — it's valid only in the uploader's tab. This
// module validates the file is a real, renderable GLB, uploads it directly to R2
// via a short-lived presigned PUT (api/avatar/presign-glb), and returns the
// resulting PUBLIC url, which the scene then broadcasts like any other avatar URL.
//
// Validation runs fully client-side before a single byte is uploaded: parse the
// GLB, confirm it has a visible mesh and a measurable size. This rejects junk
// early and gives the picker a real reason string to show, rather than letting a
// broken model silently fall back to the capsule stand-in for everyone.

import { Box3, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { getMeshoptDecoder } from '../viewer/internal.js';

// Kept in sync with MAX_GLB_BYTES in api/avatar/presign-glb.js.
export const MAX_GLB_BYTES = 16 * 1024 * 1024;
export const MAX_GLB_MB = MAX_GLB_BYTES / (1024 * 1024);

// World props (P3.3) are downloaded by EVERY player in the world, not just the
// person who chose them, so their budget is tighter than an avatar's. Mirrors
// PROP_ASSET_MAX_BYTES in multiplayer/src/build-limits.js.
export const MAX_PROP_BYTES = 8 * 1024 * 1024;
export const MAX_PROP_MB = MAX_PROP_BYTES / (1024 * 1024);
// A prop that is metres across in every direction is a griefing wall, not a
// decoration; one that is sub-millimetre is an invisible placement. Both are
// rejected up front with a reason the uploader can act on.
const PROP_MAX_EXTENT_M = 40;
const PROP_MIN_EXTENT_M = 0.01;
// Triangle budget: one world can hold MAX_WORLD_OBJECTS props, so a single
// uploaded model has to stay inside a frame budget everyone else pays for too.
const PROP_MAX_TRIANGLES = 300_000;

const GLB_CONTENT_TYPE = 'model/gltf-binary';
const _loader = new GLTFLoader();
// three.ws GLBs may carry EXT_meshopt_compression — decoder required before load
const _meshoptReady = getMeshoptDecoder().then((d) => _loader.setMeshoptDecoder(d));

function disposeScene(scene) {
	scene.traverse((n) => {
		if (!n.isMesh) return;
		n.geometry?.dispose?.();
		const mats = Array.isArray(n.material) ? n.material : [n.material];
		for (const m of mats) m?.dispose?.();
	});
}

// Validate that `file` is a usable .glb avatar. Throws Error(userFacingMessage)
// on rejection; resolves to { bytes, height } on success.
export async function validateGlb(file) {
	if (!file) throw new Error('No file selected.');
	if (!file.name.toLowerCase().endsWith('.glb')) {
		throw new Error('Only .glb files work — they bundle meshes and textures into one file. Export your model as GLB (not .gltf or .fbx).');
	}
	if (file.size < 64) throw new Error('That file is empty.');
	if (file.size > MAX_GLB_BYTES) {
		throw new Error(`That .glb is ${(file.size / (1024 * 1024)).toFixed(1)} MB — the limit is ${MAX_GLB_MB} MB. Decimate the mesh or shrink textures and try again.`);
	}

	await _meshoptReady;
	let gltf;
	try {
		gltf = await _loader.parseAsync(await file.arrayBuffer(), '');
	} catch {
		throw new Error('That .glb could not be read as a 3D model — it may be corrupt or not actually a GLB.');
	}

	try {
		let hasMesh = false;
		gltf.scene.traverse((n) => { if (n.isMesh) hasMesh = true; });
		if (!hasMesh) throw new Error('That model has no visible geometry.');

		const size = new Vector3();
		new Box3().setFromObject(gltf.scene).getSize(size);
		const height = size.y;
		if (!Number.isFinite(height) || height <= 0) throw new Error('That model has no measurable size.');

		return { bytes: file.size, height };
	} finally {
		disposeScene(gltf.scene);
	}
}

// ── world props (P3.3) ───────────────────────────────────────────────────────
// A prop is validated harder than an avatar because everyone in the world pays
// for it: tighter size cap, a triangle budget, and a real bounding-box sanity
// check so a mis-exported model can't be dropped in as a kilometre-wide wall.
// Reuses the same parse-before-upload discipline as validateGlb — nothing reaches
// storage until it has been proven to be a renderable model right here.

/**
 * Validate `file` as a placeable world prop.
 * Accepts .glb and .vrm (a VRM file is a glTF binary — see vrm-loader.js).
 * @throws {Error} with a user-facing message on rejection
 * @returns {Promise<{bytes:number, height:number, extent:number, triangles:number, vrm:boolean}>}
 */
export async function validatePropModel(file) {
	if (!file) throw new Error('No file selected.');
	const name = (file.name || '').toLowerCase();
	const isVrm = name.endsWith('.vrm');
	if (!name.endsWith('.glb') && !isVrm) {
		throw new Error('Props must be .glb or .vrm — those bundle meshes and textures into one file. Export your model as GLB and try again.');
	}
	if (file.size < 64) throw new Error('That file is empty.');
	if (file.size > MAX_PROP_BYTES) {
		throw new Error(`That model is ${(file.size / (1024 * 1024)).toFixed(1)} MB — props are capped at ${MAX_PROP_MB} MB so they load fast for everyone in the world. Decimate the mesh or shrink its textures.`);
	}

	await _meshoptReady;
	let gltf;
	try {
		gltf = await _loader.parseAsync(await file.arrayBuffer(), '');
	} catch {
		throw new Error('That file could not be read as a 3D model — it may be corrupt or not actually a GLB/VRM.');
	}

	try {
		let hasMesh = false;
		let triangles = 0;
		gltf.scene.traverse((n) => {
			if (!n.isMesh || !n.geometry) return;
			hasMesh = true;
			const g = n.geometry;
			const count = g.index ? g.index.count : (g.attributes?.position?.count || 0);
			triangles += Math.floor(count / 3);
		});
		if (!hasMesh) throw new Error('That model has no visible geometry.');
		if (triangles > PROP_MAX_TRIANGLES) {
			throw new Error(`That model has ${triangles.toLocaleString()} triangles — props are capped at ${PROP_MAX_TRIANGLES.toLocaleString()} so a world full of them still runs smoothly. Decimate it and try again.`);
		}

		const size = new Vector3();
		new Box3().setFromObject(gltf.scene).getSize(size);
		const extent = Math.max(size.x, size.y, size.z);
		if (!Number.isFinite(extent) || extent <= 0) throw new Error('That model has no measurable size.');
		if (extent < PROP_MIN_EXTENT_M) {
			throw new Error('That model is smaller than a millimetre across — re-export it at a real-world scale (metres).');
		}
		if (extent > PROP_MAX_EXTENT_M) {
			throw new Error(`That model is ${Math.round(extent)} m across — props are capped at ${PROP_MAX_EXTENT_M} m. Re-export it at a real-world scale (metres).`);
		}

		return { bytes: file.size, height: size.y, extent, triangles, vrm: isVrm };
	} finally {
		disposeScene(gltf.scene);
	}
}

/**
 * Upload a validated world prop and return its public URL. Same presigned-PUT
 * path as an avatar (api/avatar/presign-glb) — one storage pipeline, one set of
 * server-side limits — so the resulting url passes the room's asset allow-list.
 */
export async function uploadPropModel(file, onProgress) {
	return uploadGlb(file, onProgress);
}

// PUT the file to a presigned URL, reporting progress (0..1) along the way.
function putWithProgress(url, file, onProgress) {
	return new Promise((resolve, reject) => {
		const xhr = new XMLHttpRequest();
		xhr.open('PUT', url);
		// Must match the Content-Type the server signed, or R2 rejects the PUT.
		xhr.setRequestHeader('Content-Type', GLB_CONTENT_TYPE);
		xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
		xhr.onload = () => (xhr.status >= 200 && xhr.status < 300
			? resolve()
			: reject(new Error(`Upload was rejected by storage (${xhr.status}).`)));
		xhr.onerror = () => reject(new Error('Upload failed — check your connection and try again.'));
		xhr.send(file);
	});
}

// Upload a (validated) .glb and return its public URL. `onProgress(fraction)` is
// called during the transfer. Throws Error(userFacingMessage) on any failure.
export async function uploadGlb(file, onProgress) {
	let presign;
	try {
		const r = await fetch('/api/avatar/presign-glb', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			credentials: 'include',
			body: JSON.stringify({ filename: file.name, content_type: GLB_CONTENT_TYPE, bytes: file.size }),
		});
		presign = await r.json().catch(() => ({}));
		if (!r.ok) throw new Error(presign?.message || `Could not prepare the upload (${r.status}).`);
	} catch (err) {
		throw new Error(err?.message || 'Could not reach the upload service.');
	}
	if (!presign?.upload_url || !presign?.public_url) throw new Error('Upload service returned an invalid response.');

	await putWithProgress(presign.upload_url, file, onProgress);
	return presign.public_url;
}
