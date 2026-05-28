/**
 * OSS Avatar pipeline — CharacterStudio demo.
 *
 * Mounts CharacterStudio in an iframe and listens for the `characterstudio`
 * postMessage `export` event (same contract the production AvatarCreator uses
 * for the CharacterStudio fallback path). Renders the exported GLB in a
 * standalone three.js viewer + offers download / save-to-account.
 */

import {
	Scene,
	Color,
	PerspectiveCamera,
	WebGLRenderer,
	SRGBColorSpace,
	HemisphereLight,
	DirectionalLight,
	GridHelper,
	Box3,
	Vector3,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const PUBLIC_STUDIO = 'https://m3-org.github.io/CharacterStudio';
const LOCAL_STUDIO = 'http://localhost:5173';

const iframeHost = document.getElementById('iframe-host');
const iframeEmpty = document.getElementById('iframe-empty');
const previewViewer = document.getElementById('preview-viewer');
const previewBadge = document.getElementById('preview-badge');
const btnLocal = document.getElementById('btn-open-local');
const btnPublic = document.getElementById('btn-open-public');
const btnDownload = document.getElementById('btn-download');
const btnSave = document.getElementById('btn-save');
const studioStatus = document.getElementById('studio-status');
const exportStatus = document.getElementById('export-status');

let currentIframeOrigin = null;
let lastGlbBlob = null;

function setStatus(el, msg, kind) {
	el.textContent = msg;
	el.classList.remove('ok', 'err');
	if (kind === 'ok') el.classList.add('ok');
	if (kind === 'err') el.classList.add('err');
}

function openStudio(url) {
	if (iframeEmpty) iframeEmpty.style.display = 'none';
	const existing = iframeHost.querySelector('iframe.studio-frame');
	if (existing) existing.remove();
	const frame = document.createElement('iframe');
	frame.className = 'studio-frame';
	frame.allow = 'camera *; microphone *; clipboard-write';
	frame.sandbox =
		'allow-scripts allow-same-origin allow-forms allow-popups allow-downloads';
	frame.src = url;
	frame.style.minHeight = '600px';
	try {
		currentIframeOrigin = new URL(url).origin;
	} catch {
		currentIframeOrigin = null;
	}
	iframeHost.appendChild(frame);
	setStatus(studioStatus, `loading ${url}…`);
	frame.addEventListener('load', () => {
		setStatus(studioStatus, `loaded ${url}`, 'ok');
	});
	frame.addEventListener('error', () => {
		setStatus(studioStatus, `failed to load ${url}`, 'err');
	});
}

btnLocal.addEventListener('click', () => openStudio(LOCAL_STUDIO));
btnPublic.addEventListener('click', () => openStudio(PUBLIC_STUDIO));

// ── Listen for export from CharacterStudio iframe ──────────────────────────

window.addEventListener('message', async (event) => {
	if (currentIframeOrigin && event.origin !== currentIframeOrigin) return;
	const msg = event.data;
	if (!msg || msg.source !== 'characterstudio' || msg.type !== 'export') return;
	if (!(msg.glb instanceof ArrayBuffer)) {
		setStatus(exportStatus, 'export received but glb payload missing', 'err');
		return;
	}
	const blob = new Blob([msg.glb], { type: 'model/gltf-binary' });
	lastGlbBlob = blob;
	setStatus(
		exportStatus,
		`received ${(blob.size / 1024).toFixed(1)} KB GLB · rendering preview…`,
		'ok',
	);
	btnDownload.disabled = false;
	btnSave.disabled = false;
	await renderPreview(blob);
});

// ── Preview viewer ─────────────────────────────────────────────────────────

let previewState = null;

async function renderPreview(blob) {
	previewViewer.style.display = 'block';
	if (!previewState) previewState = initViewer(previewViewer);
	const { scene, controls } = previewState;
	// Drop any prior avatar
	while (scene.children.find((c) => c.userData.kind === 'avatar')) {
		const old = scene.children.find((c) => c.userData.kind === 'avatar');
		scene.remove(old);
	}
	const url = URL.createObjectURL(blob);
	try {
		const loader = new GLTFLoader();
		const gltf = await loader.loadAsync(url);
		gltf.scene.userData.kind = 'avatar';
		scene.add(gltf.scene);
		fitToObject(previewState, gltf.scene);
		const box = new Box3().setFromObject(gltf.scene);
		const size = new Vector3();
		box.getSize(size);
		previewBadge.textContent = `GLB · ${size.x.toFixed(2)}×${size.y.toFixed(2)}×${size.z.toFixed(2)}m`;
		setStatus(
			exportStatus,
			`loaded · ${(blob.size / 1024).toFixed(1)} KB · ${size.y.toFixed(2)}m tall`,
			'ok',
		);
	} catch (err) {
		setStatus(exportStatus, `preview failed: ${err.message}`, 'err');
	} finally {
		URL.revokeObjectURL(url);
	}
}

function initViewer(host) {
	const width = host.clientWidth;
	const height = host.clientHeight || 360;
	const scene = new Scene();
	scene.background = new Color(0x050505);
	const camera = new PerspectiveCamera(35, width / height, 0.01, 100);
	camera.position.set(0, 1.4, 2.4);

	const renderer = new WebGLRenderer({ antialias: true });
	renderer.setPixelRatio(window.devicePixelRatio);
	renderer.setSize(width, height);
	renderer.outputColorSpace = SRGBColorSpace;
	host.appendChild(renderer.domElement);

	scene.add(new HemisphereLight(0xffffff, 0x444444, 1.2));
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
		const w = host.clientWidth;
		const h = host.clientHeight || 360;
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

	return { scene, camera, renderer, controls };
}

function fitToObject({ camera, controls }, obj) {
	const box = new Box3().setFromObject(obj);
	const size = new Vector3();
	const center = new Vector3();
	box.getSize(size);
	box.getCenter(center);
	const maxDim = Math.max(size.x, size.y, size.z);
	const dist = (maxDim / Math.tan((Math.PI / 180) * camera.fov / 2)) * 1.3;
	camera.position.set(center.x, center.y + size.y * 0.2, center.z + dist);
	controls.target.copy(center);
	controls.update();
}

// ── Download & save ────────────────────────────────────────────────────────

btnDownload.addEventListener('click', () => {
	if (!lastGlbBlob) return;
	const url = URL.createObjectURL(lastGlbBlob);
	const a = document.createElement('a');
	a.href = url;
	a.download = `avatar-os-${Date.now()}.glb`;
	a.click();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
});

btnSave.addEventListener('click', async () => {
	if (!lastGlbBlob) return;
	setStatus(exportStatus, 'requesting presigned URL…');
	try {
		const initRes = await fetch('/api/avatars/presign', {
			method: 'POST',
			credentials: 'include',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				size_bytes: lastGlbBlob.size,
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
			body: lastGlbBlob,
		});
		if (!putRes.ok) throw new Error(`R2 PUT ${putRes.status}`);
		setStatus(exportStatus, 'creating avatar record…');
		const createRes = await fetch('/api/avatars', {
			method: 'POST',
			credentials: 'include',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				name: 'OSS demo avatar',
				storage_key: init.storage_key,
				size_bytes: lastGlbBlob.size,
				visibility: 'private',
			}),
		});
		if (!createRes.ok) {
			const txt = await createRes.text();
			throw new Error(`/api/avatars ${createRes.status}: ${txt.slice(0, 120)}`);
		}
		const created = await createRes.json();
		setStatus(exportStatus, `saved · avatar id ${created.id || created.avatar?.id}`, 'ok');
	} catch (err) {
		setStatus(exportStatus, `save failed: ${err.message}`, 'err');
	}
});
