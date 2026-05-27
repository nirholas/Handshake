// /xr — immersive AR experience with full/half-body avatar.
//
// Provides a standalone Three.js scene wired to WebXRSession for real
// immersive-ar. Falls back to camera-passthrough on non-WebXR devices.
// The viewer shim object matches the interface expected by WebXRSession.

import {
	AmbientLight,
	CircleGeometry,
	DirectionalLight,
	HemisphereLight,
	Mesh,
	MeshStandardMaterial,
	PCFSoftShadowMap,
	PerspectiveCamera,
	PMREMGenerator,
	Scene,
	ShadowMaterial,
	WebGLRenderer,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { AnimationManager } from './animation-manager.js';
import { WebXRSession } from './ar/webxr.js';
import { canUseQuickLook } from './ar/quick-look.js';
import { canUseSceneViewer, openSceneViewer } from './ar/scene-viewer.js';

// ── DOM ──────────────────────────────────────────────────────────────────────

const canvas        = document.getElementById('xr-canvas');
const videoEl       = document.getElementById('xr-camera-feed');
const enterArBtn    = document.getElementById('xr-enter-ar');
const bodyToggle    = document.getElementById('xr-body-toggle');
const fullBtn       = document.getElementById('xr-body-full');
const halfBtn       = document.getElementById('xr-body-half');
const statusEl      = document.getElementById('xr-status');
const statusDot     = document.getElementById('xr-status-dot');
const deviceChip    = document.getElementById('xr-device-chip');
const avatarLabel   = document.getElementById('xr-avatar-label');
const loadingEl     = document.getElementById('xr-loading');

function setStatus(msg, type = 'idle') {
	if (!statusEl) return;
	statusEl.textContent = msg;
	if (statusDot) {
		statusDot.className = 'xr-dot xr-dot--' + type;
	}
}

// ── Three.js setup ───────────────────────────────────────────────────────────

const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = PCFSoftShadowMap;
renderer.outputColorSpace = 'srgb';

const scene = new Scene();
const pmrem = new PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

const camera = new PerspectiveCamera(35, window.innerWidth / window.innerHeight, 0.01, 100);
camera.position.set(0, 1.4, 2.6);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1, 0);
controls.enableDamping = true;
controls.minDistance = 0.8;
controls.maxDistance = 6;
controls.minPolarAngle = 0.2;
controls.maxPolarAngle = Math.PI * 0.65;
controls.update();

// Lights
const hemi = new HemisphereLight(0xbcd6ff, 0x202830, 0.7);
hemi.position.set(0, 5, 0);
scene.add(hemi);
const ambient = new AmbientLight(0xffffff, 0.4);
scene.add(ambient);
const sun = new DirectionalLight(0xffffff, 1.5);
sun.position.set(4, 8, 6);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.camera.near = 0.5;
sun.shadow.camera.far = 30;
sun.shadow.camera.left = -5;
sun.shadow.camera.right = 5;
sun.shadow.camera.top = 5;
sun.shadow.camera.bottom = -5;
sun.shadow.bias = -0.0005;
scene.add(sun);
scene.add(sun.target);

// Ground — opaque ring in preview, shadow-only in AR
const groundOpaque = new Mesh(
	new CircleGeometry(3, 64),
	new MeshStandardMaterial({ color: 0x151821, roughness: 0.95, metalness: 0 }),
);
groundOpaque.rotation.x = -Math.PI / 2;
groundOpaque.receiveShadow = true;
scene.add(groundOpaque);

const groundShadow = new Mesh(
	new CircleGeometry(3, 64),
	new ShadowMaterial({ opacity: 0.4 }),
);
groundShadow.rotation.x = -Math.PI / 2;
groundShadow.receiveShadow = true;
groundShadow.visible = false;
scene.add(groundShadow);

// ── Animation + viewer shim ───────────────────────────────────────────────────

const animationManager = new AnimationManager();

/** Viewer shim — matches the interface WebXRSession expects. */
const xrViewer = {
	renderer,
	scene,
	content: null,
	controls,
	mixer: null,
	animationManager,
	_afterAnimateHooks: [],
	_rafId: null,
	prevTime: null,
	activeCamera: camera,
	_needsRender: true,
	_updateRenderLoop() { _startRAF(); },
};

function _rafTick(time) {
	xrViewer._rafId = requestAnimationFrame(_rafTick);
	const dt = xrViewer.prevTime ? (time - xrViewer.prevTime) / 1000 : 0.016;
	xrViewer.prevTime = time;
	if (xrViewer.mixer) xrViewer.mixer.update(dt);
	animationManager.update(dt);
	for (const hook of xrViewer._afterAnimateHooks) hook(dt);
	controls.update();
	renderer.render(scene, camera);
}

function _startRAF() {
	if (xrViewer._rafId !== null) return;
	xrViewer._rafId = requestAnimationFrame(_rafTick);
}

// ── State ──────────────────────────────────────────────────────────────────────

let halfBodyActive = false;
let halfBodyBones = [];   // { bone, scale } pairs captured on enter
let xrSession = null;
let arCameraActive = false;
let mediaStream = null;

// ── Half-body logic ───────────────────────────────────────────────────────────

const LOWER_BODY_FRAGMENTS = ['upleg','leg','thigh','knee','shin','calf','foot','toe','ankle'];
function _normalizeBone(name) {
	return String(name || '').toLowerCase()
		.replace(/^mixamorig:?_?/, '').replace(/^cc_base_/, '')
		.replace(/^armature[:_|]/, '').replace(/^rig[:_]/, '');
}
function _isLowerBody(name) {
	const n = _normalizeBone(name);
	return LOWER_BODY_FRAGMENTS.some((f) => n.includes(f));
}

function applyHalfBody() {
	const content = xrViewer.content;
	if (!content) return;
	halfBodyBones = [];
	content.traverse((obj) => {
		if (!obj.isSkinnedMesh || !obj.skeleton) return;
		for (const bone of obj.skeleton.bones || []) {
			if (!_isLowerBody(bone.name)) continue;
			if (halfBodyBones.some((b) => b.bone === bone)) continue;
			halfBodyBones.push({ bone, scale: bone.scale.clone() });
			bone.scale.set(0.0001, 0.0001, 0.0001);
		}
	});
	content.traverse((obj) => {
		if (obj.isSkinnedMesh && obj.skeleton) obj.skeleton.update();
	});
}

function removeHalfBody() {
	for (const { bone, scale } of halfBodyBones) bone.scale.copy(scale);
	halfBodyBones = [];
	const content = xrViewer.content;
	if (content) {
		content.traverse((obj) => {
			if (obj.isSkinnedMesh && obj.skeleton) obj.skeleton.update();
		});
	}
}

function setHalfBody(active) {
	halfBodyActive = active;
	if (active) {
		applyHalfBody();
		fullBtn.classList.remove('active');
		halfBtn.classList.add('active');
	} else {
		removeHalfBody();
		fullBtn.classList.add('active');
		halfBtn.classList.remove('active');
	}
}

// ── AR: camera passthrough (non-WebXR fallback) ───────────────────────────────

async function enableCameraAR() {
	try {
		mediaStream = await navigator.mediaDevices.getUserMedia({
			video: { facingMode: { ideal: 'environment' } },
			audio: false,
		});
	} catch (err) {
		const msg = err?.name === 'NotAllowedError' ? 'camera permission denied' : `camera unavailable: ${err?.message}`;
		setStatus(msg, 'error');
		return false;
	}
	videoEl.srcObject = mediaStream;
	try { await videoEl.play(); } catch {}

	arCameraActive = true;
	document.getElementById('xr-stage').classList.add('is-ar');
	groundOpaque.visible = false;
	groundShadow.visible = true;
	renderer.setClearColor(0x000000, 0);
	scene.background = null;

	if (halfBodyActive) applyHalfBody();
	setStatus('Camera AR active — your avatar in your space', 'ar');
	enterArBtn.textContent = 'Exit AR';
	enterArBtn.classList.add('active');
	return true;
}

function disableCameraAR() {
	if (mediaStream) {
		for (const track of mediaStream.getTracks()) { try { track.stop(); } catch {} }
		mediaStream = null;
	}
	videoEl.srcObject = null;
	arCameraActive = false;
	document.getElementById('xr-stage').classList.remove('is-ar');
	groundOpaque.visible = true;
	groundShadow.visible = false;
	renderer.setClearColor(0x000000, 1);
	setStatus('Preview', 'idle');
	enterArBtn.textContent = _arBtnLabel();
	enterArBtn.classList.remove('active');
}

// ── AR: WebXR immersive-ar ────────────────────────────────────────────────────

async function enterWebXR() {
	if (xrSession) {
		await xrSession.end();
		return;
	}
	enterArBtn.disabled = true;
	enterArBtn.textContent = 'Starting XR…';
	setStatus('Requesting XR session…', 'loading');
	try {
		xrSession = new WebXRSession(xrViewer, {
			halfBody: halfBodyActive,
			onEnd: () => {
				xrSession = null;
				groundOpaque.visible = true;
				groundShadow.visible = false;
				enterArBtn.disabled = false;
				enterArBtn.textContent = _arBtnLabel();
				enterArBtn.classList.remove('active');
				setStatus('Preview', 'idle');
			},
		});
		await xrSession.start();
		groundOpaque.visible = false;
		groundShadow.visible = true;
		setStatus('WebXR active — tap real surface to place avatar', 'ar');
		enterArBtn.disabled = false;
		enterArBtn.textContent = 'Exit XR';
		enterArBtn.classList.add('active');
	} catch (err) {
		xrSession = null;
		setStatus('XR failed: ' + (err?.message || err), 'error');
		enterArBtn.disabled = false;
		enterArBtn.textContent = _arBtnLabel();
	}
}

// ── AR button logic ───────────────────────────────────────────────────────────

let _arMode = 'none'; // 'none' | 'webxr' | 'camera' | 'sceneviewer' | 'quicklook'
let _avatarGlbUrl = '/avatars/default.glb';

function _arBtnLabel() {
	switch (_arMode) {
		case 'webxr':       return 'Enter AR';
		case 'camera':      return 'Enter AR';
		case 'sceneviewer': return 'View in AR';
		case 'quicklook':   return 'View in AR';
		default:            return 'AR not available';
	}
}

async function _detectARMode() {
	if (navigator.xr && await navigator.xr.isSessionSupported('immersive-ar').catch(() => false)) {
		_arMode = 'webxr';
		if (deviceChip) {
			deviceChip.textContent = 'WebXR';
			deviceChip.className = 'xr-chip xr-chip--webxr';
		}
		setStatus('WebXR supported — tap Enter AR to place your avatar', 'ready');
	} else if (canUseSceneViewer()) {
		_arMode = 'sceneviewer';
		if (deviceChip) {
			deviceChip.textContent = 'ARCore';
			deviceChip.className = 'xr-chip xr-chip--arcore';
		}
		setStatus('ARCore available', 'ready');
	} else if (canUseQuickLook()) {
		_arMode = 'quicklook';
		if (deviceChip) {
			deviceChip.textContent = 'Quick Look';
			deviceChip.className = 'xr-chip xr-chip--ios';
		}
		setStatus('Quick Look available', 'ready');
	} else if (navigator.mediaDevices?.getUserMedia) {
		_arMode = 'camera';
		if (deviceChip) {
			deviceChip.textContent = 'Camera AR';
			deviceChip.className = 'xr-chip xr-chip--camera';
		}
		setStatus('Camera passthrough available', 'ready');
	} else {
		_arMode = 'none';
		if (deviceChip) {
			deviceChip.textContent = 'No AR';
			deviceChip.className = 'xr-chip xr-chip--none';
		}
		enterArBtn.disabled = true;
		setStatus('AR not available on this device', 'idle');
	}
	if (enterArBtn && _arMode !== 'none') {
		enterArBtn.textContent = _arBtnLabel();
		enterArBtn.disabled = false;
	}
}

enterArBtn.addEventListener('click', async () => {
	if (xrSession) { await xrSession.end(); return; }
	if (arCameraActive) { disableCameraAR(); return; }

	if (_arMode === 'webxr') {
		await enterWebXR();
	} else if (_arMode === 'sceneviewer') {
		openSceneViewer(_avatarGlbUrl, { title: 'three.ws avatar', link: location.href });
	} else if (_arMode === 'camera') {
		await enableCameraAR();
	}
});

// ── Body toggle ───────────────────────────────────────────────────────────────

fullBtn.addEventListener('click', () => {
	if (!halfBodyActive) return;
	setHalfBody(false);
	// If already in XR, restart with updated mode
	if (xrSession) {
		xrSession.end().then(() => enterWebXR());
	}
});
halfBtn.addEventListener('click', () => {
	if (halfBodyActive) return;
	setHalfBody(true);
	if (xrSession) {
		xrSession.end().then(() => enterWebXR());
	}
});

// ── Avatar loading ────────────────────────────────────────────────────────────

async function resolveAvatarUrl() {
	const params = new URLSearchParams(location.search);
	const id = params.get('avatar');
	if (!id) return '/avatars/default.glb';
	const res = await fetch(`/api/avatars/${encodeURIComponent(id)}`);
	if (!res.ok) return '/avatars/default.glb';
	const { avatar } = await res.json();
	return avatar?.url || '/avatars/default.glb';
}

async function loadAvatar() {
	const url = await resolveAvatarUrl();
	_avatarGlbUrl = url;
	const loader = new GLTFLoader();
	const gltf = await loader.loadAsync(url);
	const root = gltf.scene;
	root.traverse((obj) => {
		if (obj.isMesh) {
			obj.castShadow = true;
			obj.receiveShadow = true;
		}
	});
	scene.add(root);
	xrViewer.content = root;

	// Frame camera to avatar bounds
	const { Box3, Vector3: V3 } = await import('three');
	const box = new Box3().setFromObject(root);
	const size = box.getSize(new V3()).length();
	const center = box.getCenter(new V3());
	controls.target.copy(center).setY(center.y * 0.7);
	camera.position.set(0, center.y + size * 0.2, size * 1.4);
	controls.update();

	// Animations — fetch manifest, load idle clip, attach to model
	try {
		const manifest = await fetch('/animations/manifest.json', { cache: 'force-cache' })
			.then((r) => r.ok ? r.json() : []);
		const idleDef = manifest.find((d) => d.name === 'idle') || manifest[0];
		if (idleDef) {
			animationManager.setAnimationDefs([idleDef]);
			await animationManager.loadAll();
		}
	} catch {}
	animationManager.attach(root);
	xrViewer.mixer = animationManager.mixer;
	if (animationManager._animationDefs.length) animationManager.play('idle');

	// Avatar name from URL param
	const params = new URLSearchParams(location.search);
	const handle = params.get('handle');
	if (avatarLabel && handle) avatarLabel.textContent = handle;
}

// ── Resize ───────────────────────────────────────────────────────────────────

window.addEventListener('resize', () => {
	renderer.setSize(window.innerWidth, window.innerHeight, false);
	camera.aspect = window.innerWidth / window.innerHeight;
	camera.updateProjectionMatrix();
});

// ── Init ─────────────────────────────────────────────────────────────────────

(async () => {
	_startRAF();
	setStatus('Loading avatar…', 'loading');

	try {
		await loadAvatar();
	} catch (err) {
		setStatus('Failed to load avatar', 'error');
		console.error('[xr] avatar load failed:', err);
	}

	if (loadingEl) loadingEl.hidden = true;

	// Body toggle: start on full body
	fullBtn.classList.add('active');

	await _detectARMode();
})();
