/**
 * OSS Avatar pipeline — Combined demo.
 *
 * Loads a body GLB + a frontal selfie, generates the MediaPipe face mesh, and
 * attaches it to the body. If the body has a head bone, the face mesh is
 * parented to it (so it animates with the body). Otherwise it sits at the top
 * of the body's bounding box. The whole scene exports as one GLB.
 */

import {
	Box3,
	Vector3,
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
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { FilesetResolver, FaceLandmarker } from '@mediapipe/tasks-vision';
import { TRIANGULATION } from './triangulation.js';

const MODEL_URL =
	'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const WASM_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm';
const DEFAULT_BODY = '/avatars/default.glb';

const HEAD_BONE_PATTERNS = [
	/^head$/i,
	/head_/i,
	/_head/i,
	/^J_Bip_C_Head$/, // VRM
	/mixamorig:?Head/i,
];

const viewerHost = document.getElementById('viewer-host');
const viewerBadge = document.getElementById('viewer-badge');
const viewerOverlay = document.getElementById('viewer-overlay');
const bodyStatus = document.getElementById('body-status');
const captureStatus = document.getElementById('capture-status');
const buildStatus = document.getElementById('build-status');
const exportStatus = document.getElementById('export-status');
const btnBodyDefault = document.getElementById('btn-body-default');
const btnBodyUpload = document.getElementById('btn-body-upload');
const bodyFileInput = document.getElementById('body-file-input');
const btnBuild = document.getElementById('btn-build');
const btnDownload = document.getElementById('btn-download');
const btnSave = document.getElementById('btn-save');

let landmarker = null;
let landmarkerLoading = null;
let viewer = null;
let bodyRoot = null;
let faceMesh = null;
let selfieImg = null;
let lastGlbBlob = null;

function setStatus(el, msg, kind) {
	el.textContent = msg;
	el.classList.remove('ok', 'err');
	if (kind === 'ok') el.classList.add('ok');
	if (kind === 'err') el.classList.add('err');
}

function refreshBuildEnabled() {
	btnBuild.disabled = !(bodyRoot && selfieImg);
}

// ── Body loading ───────────────────────────────────────────────────────────

btnBodyDefault.addEventListener('click', () => loadBody(DEFAULT_BODY));
btnBodyUpload.addEventListener('click', () => bodyFileInput.click());
bodyFileInput.addEventListener('change', () => {
	const file = bodyFileInput.files?.[0];
	if (!file) return;
	const url = URL.createObjectURL(file);
	loadBody(url, file.name);
});

async function loadBody(url, label) {
	ensureViewer();
	setStatus(bodyStatus, `loading ${label || url}…`);
	try {
		const loader = new GLTFLoader();
		const gltf = await loader.loadAsync(url);
		if (bodyRoot) {
			viewer.scene.remove(bodyRoot);
			bodyRoot = null;
		}
		bodyRoot = gltf.scene;
		bodyRoot.name = 'body-root';
		viewer.scene.add(bodyRoot);
		fitToObject(viewer, bodyRoot);
		viewerOverlay.style.display = 'none';
		const headBone = findHeadBone(bodyRoot);
		const bones = countBones(bodyRoot);
		setStatus(
			bodyStatus,
			`loaded · ${bones} bones · head bone: ${headBone ? headBone.name : 'none (will use bbox)'}`,
			'ok',
		);
		viewerBadge.textContent = `body · ${bones} bones`;
		refreshBuildEnabled();
	} catch (err) {
		setStatus(bodyStatus, `load failed: ${err.message}`, 'err');
	}
}

function findHeadBone(root) {
	let found = null;
	root.traverse((node) => {
		if (found || !node.isBone) return;
		for (const re of HEAD_BONE_PATTERNS) {
			if (re.test(node.name)) {
				found = node;
				return;
			}
		}
	});
	return found;
}

function countBones(root) {
	let n = 0;
	root.traverse((node) => {
		if (node.isBone) n++;
	});
	return n;
}

// ── Selfie capture ─────────────────────────────────────────────────────────

document.querySelectorAll('.photo-slot').forEach((slot) => {
	const input = slot.querySelector('input[type=file]');
	input.addEventListener('change', async () => {
		const file = input.files?.[0];
		if (!file) return;
		const url = URL.createObjectURL(file);
		const img = await loadImage(url);
		selfieImg = img;
		let prev = slot.querySelector('img');
		if (!prev) {
			prev = document.createElement('img');
			slot.insertBefore(prev, slot.firstChild);
		}
		prev.src = url;
		setStatus(captureStatus, `loaded · ${img.naturalWidth}×${img.naturalHeight}`, 'ok');
		refreshBuildEnabled();
	});
});

function loadImage(src) {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.crossOrigin = 'anonymous';
		img.onload = () => resolve(img);
		img.onerror = reject;
		img.src = src;
	});
}

// ── MediaPipe ──────────────────────────────────────────────────────────────

async function getLandmarker() {
	if (landmarker) return landmarker;
	if (landmarkerLoading) return landmarkerLoading;
	landmarkerLoading = (async () => {
		const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);
		landmarker = await FaceLandmarker.createFromOptions(fileset, {
			baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
			runningMode: 'IMAGE',
			numFaces: 1,
			outputFacialTransformationMatrixes: true,
		});
		return landmarker;
	})();
	return landmarkerLoading;
}

// ── Combine ────────────────────────────────────────────────────────────────

btnBuild.addEventListener('click', async () => {
	if (!bodyRoot || !selfieImg) return;
	btnBuild.disabled = true;
	try {
		setStatus(buildStatus, 'loading MediaPipe…');
		const lm = await getLandmarker();
		setStatus(buildStatus, 'detecting landmarks…');
		const result = lm.detect(selfieImg);
		if (!result.faceLandmarks || !result.faceLandmarks.length) {
			throw new Error('no face detected in photo');
		}
		const landmarks = result.faceLandmarks[0];

		if (faceMesh) {
			faceMesh.removeFromParent();
			faceMesh.geometry.dispose();
			if (faceMesh.material.map) faceMesh.material.map.dispose();
			faceMesh.material.dispose();
			faceMesh = null;
		}

		const mesh = buildFaceMesh(landmarks, selfieImg);
		const headBone = findHeadBone(bodyRoot);

		if (headBone) {
			// Parent to head bone, position at bone origin.
			// Bone local-space puts face roughly forward.
			headBone.add(mesh);
			mesh.position.set(0, 0.1, 0.1);
		} else {
			// No head bone: position at top of body bbox.
			const box = new Box3().setFromObject(bodyRoot);
			const center = new Vector3();
			box.getCenter(center);
			mesh.position.set(center.x, box.max.y - 0.12, center.z + 0.08);
			bodyRoot.add(mesh);
		}
		// Scale face to roughly match a human head (~0.15m tall)
		mesh.scale.setScalar(0.7);
		faceMesh = mesh;

		viewerBadge.textContent = `combined · ${countBones(bodyRoot)} bones · ${landmarks.length} face verts`;
		setStatus(
			buildStatus,
			`attached to ${headBone ? `bone "${headBone.name}"` : 'body bbox'} · ${landmarks.length} face verts`,
			'ok',
		);
		btnDownload.disabled = false;
		btnSave.disabled = false;
		setStatus(exportStatus, 'ready to export');
	} catch (err) {
		setStatus(buildStatus, `build failed: ${err.message}`, 'err');
		console.error('[os-combined] build failed', err);
	} finally {
		btnBuild.disabled = false;
	}
});

function buildFaceMesh(landmarks, photoImg) {
	const geom = new BufferGeometry();
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

	const canvas = document.createElement('canvas');
	canvas.width = photoImg.naturalWidth;
	canvas.height = photoImg.naturalHeight;
	canvas.getContext('2d').drawImage(photoImg, 0, 0);
	const texture = new CanvasTexture(canvas);
	texture.colorSpace = SRGBColorSpace;
	texture.flipY = false;

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
	const height = viewerHost.clientHeight || 600;

	const scene = new Scene();
	scene.background = new Color(0x050505);
	const camera = new PerspectiveCamera(35, width / height, 0.01, 100);
	camera.position.set(0, 1.4, 2.4);

	const renderer = new WebGLRenderer({ antialias: true });
	renderer.setPixelRatio(window.devicePixelRatio);
	renderer.setSize(width, height);
	renderer.outputColorSpace = SRGBColorSpace;
	viewerHost.appendChild(renderer.domElement);

	scene.add(new HemisphereLight(0xffffff, 0x333333, 1.2));
	const dir = new DirectionalLight(0xffffff, 1.5);
	dir.position.set(2, 4, 3);
	scene.add(dir);

	const grid = new GridHelper(4, 8, 0x222222, 0x111111);
	scene.add(grid);

	const controls = new OrbitControls(camera, renderer.domElement);
	controls.target.set(0, 1, 0);
	controls.enableDamping = true;
	controls.update();

	const onResize = () => {
		const w = viewerHost.clientWidth;
		const h = viewerHost.clientHeight || 600;
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
	const dist = (maxDim / Math.tan((Math.PI / 180) * camera.fov / 2)) * 1.4;
	camera.position.set(center.x, center.y + size.y * 0.2, center.z + dist);
	controls.target.copy(center);
	controls.update();
}

// ── Export ─────────────────────────────────────────────────────────────────

async function exportGlb() {
	if (!bodyRoot) return null;
	if (lastGlbBlob) return lastGlbBlob;
	const exporter = new GLTFExporter();
	const arrayBuffer = await new Promise((resolve, reject) => {
		exporter.parse(
			bodyRoot,
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
		setStatus(exportStatus, 'exporting merged GLB…');
		const blob = await exportGlb();
		if (!blob) return;
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `os-avatar-${Date.now()}.glb`;
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
				name: 'OSS combined avatar',
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
