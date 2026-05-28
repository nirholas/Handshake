/**
 * OSS Avatar pipeline — Selfie demo.
 *
 * Flow:
 *   1. Capture up to 3 photos (camera or file) — frontal is required.
 *   2. Run MediaPipe Face Landmarker on the frontal image → 478 3D landmarks.
 *   3. Build a three.js mesh:
 *      - position: landmark XYZ (normalized image coords + mediapipe z depth)
 *      - uv: landmark XY (texture is the original photo)
 *      - index: TRIANGULATION from tfjs-models (Apache-2.0)
 *   4. Render with OrbitControls + export as GLB via GLTFExporter.
 *
 * No server calls for inference. WASM + model fetch from Google's CDN at init.
 */

import {
	BufferGeometry,
	BufferAttribute,
	CanvasTexture,
	SRGBColorSpace,
	MeshStandardMaterial,
	DoubleSide,
	Mesh,
	Scene,
	Color,
	PerspectiveCamera,
	WebGLRenderer,
	HemisphereLight,
	DirectionalLight,
	GridHelper,
	Box3,
	Vector3,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { FilesetResolver, FaceLandmarker } from '@mediapipe/tasks-vision';
import { TRIANGULATION } from './triangulation.js';

const MODEL_URL =
	'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const WASM_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm';

const slots = ['frontal', 'left', 'right'];
const photoData = { frontal: null, left: null, right: null };

const captureStatus = document.getElementById('capture-status');
const buildStatus = document.getElementById('build-status');
const exportStatus = document.getElementById('export-status');
const viewerHost = document.getElementById('viewer-host');
const viewerBadge = document.getElementById('viewer-badge');
const viewerOverlay = document.getElementById('viewer-overlay');
const btnBuild = document.getElementById('btn-build');
const btnDownload = document.getElementById('btn-download');
const btnSave = document.getElementById('btn-save');
const btnCamera = document.getElementById('btn-camera');
const btnClear = document.getElementById('btn-clear');
const cameraVideo = document.getElementById('camera-video');
const cameraControls = document.getElementById('camera-controls');

let landmarker = null;
let landmarkerLoading = null;
let cameraStream = null;
let viewer = null;
let lastMesh = null;
let lastGlbBlob = null;

function setStatus(el, msg, kind) {
	el.textContent = msg;
	el.classList.remove('ok', 'err');
	if (kind === 'ok') el.classList.add('ok');
	if (kind === 'err') el.classList.add('err');
}

function refreshCaptureStatus() {
	const done = slots.filter((s) => photoData[s]);
	setStatus(
		captureStatus,
		`${done.length}/3 · ${done.join(', ') || 'none'}`,
		done.includes('frontal') ? 'ok' : null,
	);
	btnBuild.disabled = !photoData.frontal;
}

// ── File input slots ───────────────────────────────────────────────────────

document.querySelectorAll('.photo-slot').forEach((slot) => {
	const name = slot.dataset.slot;
	const input = slot.querySelector('input[type=file]');
	input.addEventListener('change', async () => {
		const file = input.files?.[0];
		if (!file) return;
		await setPhoto(name, file);
	});
});

async function setPhoto(name, file) {
	const url = URL.createObjectURL(file);
	const img = await loadImage(url);
	photoData[name] = { file, url, img };
	const slot = document.querySelector(`.photo-slot[data-slot="${name}"]`);
	let prev = slot.querySelector('img');
	if (!prev) {
		prev = document.createElement('img');
		slot.insertBefore(prev, slot.firstChild);
	}
	prev.src = url;
	refreshCaptureStatus();
}

function loadImage(src) {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.crossOrigin = 'anonymous';
		img.onload = () => resolve(img);
		img.onerror = reject;
		img.src = src;
	});
}

btnClear.addEventListener('click', () => {
	for (const s of slots) {
		if (photoData[s]?.url) URL.revokeObjectURL(photoData[s].url);
		photoData[s] = null;
		const slot = document.querySelector(`.photo-slot[data-slot="${s}"]`);
		const prev = slot.querySelector('img');
		if (prev) prev.remove();
	}
	refreshCaptureStatus();
});

// ── Camera capture ─────────────────────────────────────────────────────────

btnCamera.addEventListener('click', async () => {
	if (cameraStream) return stopCamera();
	try {
		cameraStream = await navigator.mediaDevices.getUserMedia({
			video: { facingMode: 'user', width: 1280, height: 960 },
			audio: false,
		});
		cameraVideo.srcObject = cameraStream;
		cameraVideo.style.display = 'block';
		cameraControls.style.display = 'flex';
		btnCamera.textContent = 'Hide camera';
	} catch (err) {
		setStatus(captureStatus, `camera failed: ${err.message}`, 'err');
	}
});

function stopCamera() {
	if (cameraStream) {
		cameraStream.getTracks().forEach((t) => t.stop());
		cameraStream = null;
	}
	cameraVideo.srcObject = null;
	cameraVideo.style.display = 'none';
	cameraControls.style.display = 'none';
	btnCamera.textContent = 'Use camera';
}

document.getElementById('btn-stop-camera').addEventListener('click', stopCamera);

for (const which of slots) {
	document
		.getElementById(`btn-snap-${which}`)
		.addEventListener('click', () => snapTo(which));
}

async function snapTo(name) {
	if (!cameraStream) return;
	const canvas = document.createElement('canvas');
	canvas.width = cameraVideo.videoWidth;
	canvas.height = cameraVideo.videoHeight;
	canvas.getContext('2d').drawImage(cameraVideo, 0, 0);
	const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.92));
	const file = new File([blob], `${name}.jpg`, { type: 'image/jpeg' });
	await setPhoto(name, file);
}

// ── MediaPipe init ─────────────────────────────────────────────────────────

async function getLandmarker() {
	if (landmarker) return landmarker;
	if (landmarkerLoading) return landmarkerLoading;
	landmarkerLoading = (async () => {
		const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);
		const lm = await FaceLandmarker.createFromOptions(fileset, {
			baseOptions: {
				modelAssetPath: MODEL_URL,
				delegate: 'GPU',
			},
			runningMode: 'IMAGE',
			numFaces: 1,
			outputFaceBlendshapes: false,
			outputFacialTransformationMatrixes: true,
		});
		landmarker = lm;
		return lm;
	})();
	return landmarkerLoading;
}

// ── Build the face mesh ────────────────────────────────────────────────────

btnBuild.addEventListener('click', async () => {
	if (!photoData.frontal) return;
	btnBuild.disabled = true;
	try {
		setStatus(buildStatus, 'loading MediaPipe wasm + model…');
		const lm = await getLandmarker();
		setStatus(buildStatus, 'detecting landmarks…');
		const result = lm.detect(photoData.frontal.img);
		if (!result.faceLandmarks || !result.faceLandmarks.length) {
			throw new Error('no face detected in frontal photo');
		}
		const landmarks = result.faceLandmarks[0];
		setStatus(buildStatus, `detected ${landmarks.length} landmarks · building mesh…`);

		ensureViewer();
		if (lastMesh) {
			viewer.scene.remove(lastMesh);
			lastMesh.geometry.dispose();
			if (lastMesh.material.map) lastMesh.material.map.dispose();
			lastMesh.material.dispose();
			lastMesh = null;
		}

		const mesh = buildFaceMesh(landmarks, photoData.frontal.img);
		viewer.scene.add(mesh);
		lastMesh = mesh;
		fitToObject(viewer, mesh);

		viewerOverlay.style.display = 'none';
		viewerBadge.textContent = `face · ${landmarks.length} verts · ${TRIANGULATION.length / 3} tris`;
		setStatus(
			buildStatus,
			`mesh ready · ${landmarks.length} vertices · ${TRIANGULATION.length / 3} triangles`,
			'ok',
		);
		btnDownload.disabled = false;
		btnSave.disabled = false;
		setStatus(exportStatus, 'ready to export');
	} catch (err) {
		setStatus(buildStatus, `build failed: ${err.message}`, 'err');
		console.error('[os-selfie] build failed', err);
	} finally {
		btnBuild.disabled = false;
	}
});

function buildFaceMesh(landmarks, photoImg) {
	const geom = new BufferGeometry();

	// Landmarks: { x, y, z } with x,y in [0,1] image coords, y=down, z=depth (negative into screen)
	// Convert into a centered, world-up mesh. Scale so the face is roughly 0.2m tall.
	const aspect = photoImg.naturalWidth / photoImg.naturalHeight;
	const scale = 0.2;
	const positions = new Float32Array(landmarks.length * 3);
	const uvs = new Float32Array(landmarks.length * 2);
	for (let i = 0; i < landmarks.length; i++) {
		const p = landmarks[i];
		positions[i * 3 + 0] = (p.x - 0.5) * aspect * scale;
		positions[i * 3 + 1] = -(p.y - 0.5) * scale;
		positions[i * 3 + 2] = -p.z * scale;
		uvs[i * 2 + 0] = p.x;
		uvs[i * 2 + 1] = 1 - p.y;
	}
	geom.setAttribute('position', new BufferAttribute(positions, 3));
	geom.setAttribute('uv', new BufferAttribute(uvs, 2));
	geom.setIndex(TRIANGULATION);
	geom.computeVertexNormals();

	// Photo as texture
	const canvas = document.createElement('canvas');
	canvas.width = photoImg.naturalWidth;
	canvas.height = photoImg.naturalHeight;
	canvas.getContext('2d').drawImage(photoImg, 0, 0);
	const texture = new CanvasTexture(canvas);
	texture.colorSpace = SRGBColorSpace;
	texture.flipY = false; // we already flipped V

	const material = new MeshStandardMaterial({
		map: texture,
		side: DoubleSide,
		roughness: 0.85,
		metalness: 0,
	});
	const mesh = new Mesh(geom, material);
	mesh.name = 'os-face-mesh';
	return mesh;
}

// ── Viewer ─────────────────────────────────────────────────────────────────

function ensureViewer() {
	if (viewer) return viewer;
	const width = viewerHost.clientWidth;
	const height = viewerHost.clientHeight || 480;

	const scene = new Scene();
	scene.background = new Color(0x050505);

	const camera = new PerspectiveCamera(35, width / height, 0.001, 10);
	camera.position.set(0, 0, 0.6);

	const renderer = new WebGLRenderer({ antialias: true });
	renderer.setPixelRatio(window.devicePixelRatio);
	renderer.setSize(width, height);
	renderer.outputColorSpace = SRGBColorSpace;
	viewerHost.appendChild(renderer.domElement);

	scene.add(new HemisphereLight(0xffffff, 0x333333, 1.2));
	const dir = new DirectionalLight(0xffffff, 1.4);
	dir.position.set(1, 2, 3);
	scene.add(dir);
	const dir2 = new DirectionalLight(0xffffff, 0.6);
	dir2.position.set(-2, 1, -1);
	scene.add(dir2);

	const grid = new GridHelper(1, 10, 0x222222, 0x111111);
	grid.position.y = -0.2;
	scene.add(grid);

	const controls = new OrbitControls(camera, renderer.domElement);
	controls.target.set(0, 0, 0);
	controls.enableDamping = true;
	controls.update();

	const onResize = () => {
		const w = viewerHost.clientWidth;
		const h = viewerHost.clientHeight || 480;
		camera.aspect = w / h;
		camera.updateProjectionMatrix();
		renderer.setSize(w, h);
	};
	window.addEventListener('resize', onResize);

	(function tick() {
		controls.update();
		renderer.render(scene, camera);
		requestAnimationFrame(tick);
	})();

	viewer = { scene, camera, renderer, controls };
	return viewer;
}

function fitToObject({ camera, controls }, obj) {
	const box = new Box3().setFromObject(obj);
	const size = new Vector3();
	const center = new Vector3();
	box.getSize(size);
	box.getCenter(center);
	const maxDim = Math.max(size.x, size.y, size.z);
	const dist = (maxDim / Math.tan((Math.PI / 180) * camera.fov / 2)) * 1.3;
	camera.position.set(center.x, center.y, center.z + dist);
	controls.target.copy(center);
	controls.update();
}

// ── Export GLB ─────────────────────────────────────────────────────────────

async function exportGlb() {
	if (!lastMesh) return null;
	if (lastGlbBlob) return lastGlbBlob;
	const exporter = new GLTFExporter();
	const arrayBuffer = await new Promise((resolve, reject) => {
		exporter.parse(
			lastMesh,
			(result) => resolve(result),
			(err) => reject(err),
			{ binary: true, embedImages: true },
		);
	});
	const blob = new Blob([arrayBuffer], { type: 'model/gltf-binary' });
	lastGlbBlob = blob;
	return blob;
}

btnDownload.addEventListener('click', async () => {
	try {
		setStatus(exportStatus, 'exporting GLB…');
		const blob = await exportGlb();
		if (!blob) return;
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `os-face-${Date.now()}.glb`;
		a.click();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
		setStatus(exportStatus, `downloaded · ${(blob.size / 1024).toFixed(1)} KB`, 'ok');
	} catch (err) {
		setStatus(exportStatus, `export failed: ${err.message}`, 'err');
	}
});

btnSave.addEventListener('click', async () => {
	try {
		setStatus(exportStatus, 'exporting GLB…');
		const blob = await exportGlb();
		if (!blob) return;
		setStatus(exportStatus, 'requesting presigned URL…');
		const initRes = await fetch('/api/avatars/presign', {
			method: 'POST',
			credentials: 'include',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				size_bytes: blob.size,
				content_type: 'model/gltf-binary',
			}),
		});
		if (!initRes.ok) {
			const txt = await initRes.text();
			throw new Error(`presign ${initRes.status}: ${txt.slice(0, 120)}`);
		}
		const init = await initRes.json();
		setStatus(exportStatus, 'uploading to R2…');
		const putRes = await fetch(init.upload_url, {
			method: 'PUT',
			headers: { 'content-type': 'model/gltf-binary' },
			body: blob,
		});
		if (!putRes.ok) throw new Error(`R2 PUT ${putRes.status}`);
		setStatus(exportStatus, 'creating avatar record…');
		const createRes = await fetch('/api/avatars', {
			method: 'POST',
			credentials: 'include',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				name: 'OSS face mesh',
				storage_key: init.storage_key,
				size_bytes: blob.size,
				visibility: 'private',
			}),
		});
		if (!createRes.ok) {
			const txt = await createRes.text();
			throw new Error(`/api/avatars ${createRes.status}: ${txt.slice(0, 120)}`);
		}
		const created = await createRes.json();
		setStatus(
			exportStatus,
			`saved · avatar id ${created.id || created.avatar?.id || 'ok'}`,
			'ok',
		);
	} catch (err) {
		setStatus(exportStatus, `save failed: ${err.message}`, 'err');
	}
});

refreshCaptureStatus();
