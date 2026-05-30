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

// Kept in sync with MAX_GLB_BYTES in api/avatar/presign-glb.js.
export const MAX_GLB_BYTES = 16 * 1024 * 1024;
export const MAX_GLB_MB = MAX_GLB_BYTES / (1024 * 1024);

const GLB_CONTENT_TYPE = 'model/gltf-binary';
const _loader = new GLTFLoader();

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
