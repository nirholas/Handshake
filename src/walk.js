// /walk — a third-person walkaround for three.ws
//
// Loads the default avatar, attaches the project's AnimationManager so the
// skinned mesh can crossfade between idle / walking / running clips, and
// wires a joystick (mobile) + WASD (desktop) controller that drives the
// avatar across an XZ ground plane while the camera follows behind. An AR
// toggle hides the rendered ground, makes the canvas transparent, and
// streams the back camera into a fullscreen <video> behind everything so
// the avatar appears to walk on whatever surface the phone is pointed at.

import {
	AmbientLight,
	BoxGeometry,
	Box3,
	CanvasTexture,
	CircleGeometry,
	Clock,
	Color,
	ConeGeometry,
	CylinderGeometry,
	DirectionalLight,
	DoubleSide,
	Group,
	HemisphereLight,
	InstancedMesh,
	Matrix4,
	Mesh,
	MeshBasicMaterial,
	MeshStandardMaterial,
	Object3D,
	OrthographicCamera,
	PCFSoftShadowMap,
	PerspectiveCamera,
	PlaneGeometry,
	PMREMGenerator,
	Quaternion,
	Scene,
	ShadowMaterial,
	SphereGeometry,
	Vector3,
	WebGLRenderer,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { clone as cloneSkinnedScene } from 'three/addons/utils/SkeletonUtils.js';
import nipplejs from 'nipplejs';

import { AnimationManager } from './animation-manager.js';
import { WalkNet } from './walk-net.js';

const AVATAR_URL_DEFAULT = '/avatars/default.glb';

async function resolveAvatarUrl() {
	const params = new URLSearchParams(location.search);
	const id = params.get('avatar');
	if (!id) return AVATAR_URL_DEFAULT;
	const res = await fetch(`/api/avatars/${encodeURIComponent(id)}`);
	if (!res.ok) throw new Error(`avatar ${id} not found (HTTP ${res.status})`);
	const { avatar } = await res.json();
	if (!avatar?.url) throw new Error(`avatar ${id} has no GLB URL`);
	return avatar.url;
}

const ANIMATIONS_MANIFEST_URL = '/animations/manifest.json';
const CLIP_IDLE = 'idle';
const CLIP_WALK = 'av-walk-feminine';
const CLIP_RUN = 'av-walk-feminine'; // no separate run clip; timeScale handles pace difference

const WALK_SPEED = 1.6; // m/s — target ground speed in walk mode
const RUN_SPEED = 4.0;  // m/s — target ground speed in run mode
// Natural ground speed of the Mixamo clips at timeScale=1, in m/s. Measured
// from the clip cadence (root-bone delta per cycle ÷ cycle duration on the
// canonical Avaturn rig). We rescale the mixer's timeScale by
// actualSpeed / NATURAL_* so foot-plants line up with translation — kills
// the "skating" artifact that shows when clip cadence != translation speed.
const NATURAL_WALK_SPEED = 1.5;
const NATURAL_RUN_SPEED = 3.4;
const TURN_LERP = 0.18; // 0..1 — how snappy avatar facing follows movement
const CAM_LERP = 0.12;  // 0..1 — how snappy follow-camera trails the avatar
// Procedural body lean — pitch the avatar slightly forward when moving so
// the silhouette communicates weight transfer instead of looking like the
// torso is being slid along on rails. Radians, ramped by speed fraction.
const LEAN_WALK_RAD = 0.05;
const LEAN_RUN_RAD = 0.13;
const LEAN_LERP = 0.12;
const CAM_OFFSET = new Vector3(0, 1.85, 3.6); // behind-and-above, relative to avatar yaw
const CAM_LOOK_OFFSET = new Vector3(0, 1.1, 0);
const GROUND_RADIUS = 12;

// ── DOM ───────────────────────────────────────────────────────────────────
const stage = document.getElementById('walk-stage');
const canvas = document.getElementById('walk-canvas');
const video = document.getElementById('walk-camera-feed');
const joystickEl = document.getElementById('walk-joystick');
const arBtn = document.getElementById('walk-ar-toggle');
const arCta = document.getElementById('walk-ar-cta');
const recordBtn = document.getElementById('walk-record-btn');
const recordStatus = document.getElementById('walk-record-status');
const recordStatusLabel = recordStatus?.querySelector('[data-label]');
const statusEl = document.getElementById('walk-status');
const onlinePill = document.getElementById('walk-online');
const onlineCountEl = document.getElementById('walk-online-count');
const loadingOverlay = document.getElementById('walk-loading');
const loadingText = document.getElementById('walk-loading-text');
const nameInput = /** @type {HTMLInputElement|null} */ (document.getElementById('walk-name-input'));
const playersPanelEl = document.getElementById('walk-players-panel');
const playersListEl = document.getElementById('walk-players-list');
const playersCloseBtn = document.getElementById('walk-players-close');
const helpToggleBtn = document.getElementById('walk-help-toggle');
const zenBtn = document.getElementById('walk-zen-btn');
const zenExitBtn = document.getElementById('walk-zen-exit');
const emoteTrayEl = document.getElementById('walk-emote-tray');
const cameraModeBtn = document.getElementById('walk-camera-mode-btn');
const envBtn = document.getElementById('walk-env-btn');
const screenshotBtn = document.getElementById('walk-screenshot-btn');
const minimapBtn = document.getElementById('walk-minimap-btn');

const NAME_STORAGE_KEY = 'walk:player-name';

function setStatus(text, { error = false, sticky = false } = {}) {
	if (!statusEl) return;
	statusEl.textContent = text;
	statusEl.classList.toggle('is-error', error);
	statusEl.classList.remove('is-hidden');
	if (!sticky) {
		clearTimeout(setStatus._t);
		setStatus._t = setTimeout(() => statusEl.classList.add('is-hidden'), 2200);
	}
}

function setLoadingText(text) {
	if (loadingText) loadingText.textContent = text;
}

function dismissLoading() {
	if (!loadingOverlay) return;
	loadingOverlay.classList.add('is-done');
	loadingOverlay.addEventListener('transitionend', () => loadingOverlay.remove(), { once: true });
}

// ── Name persistence ─────────────────────────────────────────────────────
function getStoredName() {
	const params = new URLSearchParams(location.search);
	return params.get('name')
		|| (typeof localStorage !== 'undefined' && localStorage.getItem(NAME_STORAGE_KEY))
		|| '';
}
function storeName(name) {
	try { localStorage.setItem(NAME_STORAGE_KEY, name); } catch {}
}
if (nameInput) {
	const initial = getStoredName();
	if (initial) nameInput.value = initial;
	const commitName = () => {
		const v = nameInput.value.trim().slice(0, 24);
		if (v) {
			storeName(v);
			if (net) net.rename(v);
		}
	};
	nameInput.addEventListener('blur', commitName);
	nameInput.addEventListener('keydown', (e) => {
		if (e.key === 'Enter') { nameInput.blur(); }
	});
}

// ── Help toggle ──────────────────────────────────────────────────────────
const helpEl = document.getElementById('walk-help');
let helpAutoHideTimer = null;
if (helpToggleBtn) {
	helpToggleBtn.addEventListener('click', () => {
		toggleHelp();
		// Also hide the small hints if showing the full overlay
		if (helpEl && helpAutoHideTimer) { clearTimeout(helpAutoHideTimer); helpAutoHideTimer = null; }
	});
}

// ── Zen mode (hide all UI) ───────────────────────────────────────────────
// Strips every overlay so the scene is just the 3D background and the
// movement joystick. Preference persists across sessions and can be set
// from a shared link with ?ui=hidden.
const ZEN_STORAGE_KEY = 'walk:zen';
let zenActive = false;
function setZen(on) {
	zenActive = on;
	document.body.classList.toggle('is-zen', on);
	if (on) {
		// Defer the reveal class one frame so the restore pill fades in.
		requestAnimationFrame(() => document.body.classList.add('zen-revealed'));
		// Close any open panels so they don't pop back when chrome returns.
		// DOM-based checks keep this safe to call during module init.
		if (playersPanelEl && !playersPanelEl.hidden) togglePlayersPanel();
		if (gesturePaletteVisible) hideGesturePalette();
	} else {
		document.body.classList.remove('zen-revealed');
	}
	if (zenBtn) zenBtn.setAttribute('aria-pressed', String(on));
	try { localStorage.setItem(ZEN_STORAGE_KEY, on ? '1' : '0'); } catch {}
}
function toggleZen() { setZen(!zenActive); }
if (zenBtn) zenBtn.addEventListener('click', toggleZen);
if (zenExitBtn) zenExitBtn.addEventListener('click', () => setZen(false));

// ── HUD button handlers for new features ─────────────────────────────────
if (cameraModeBtn) cameraModeBtn.addEventListener('click', () => cycleCameraMode());
if (envBtn) envBtn.addEventListener('click', () => cycleEnvironment());
if (screenshotBtn) screenshotBtn.addEventListener('click', () => takeScreenshot());
if (minimapBtn) minimapBtn.addEventListener('click', () => toggleMinimap());

// ── Players panel ────────────────────────────────────────────────────────
let playersPanelOpen = false;
function togglePlayersPanel() {
	playersPanelOpen = !playersPanelOpen;
	if (playersPanelEl) playersPanelEl.hidden = !playersPanelOpen;
	if (playersPanelOpen) renderPlayerList();
}
if (playersCloseBtn) playersCloseBtn.addEventListener('click', togglePlayersPanel);

function renderPlayerList() {
	if (!playersListEl) return;
	playersListEl.innerHTML = '';
	const localName = nameInput?.value?.trim() || 'you';
	const li = document.createElement('li');
	li.className = 'is-you';
	li.innerHTML = `<span class="player-dot" style="background:var(--accent)"></span>${esc(localName)}<span class="player-motion">${currentMotion}</span>`;
	playersListEl.appendChild(li);
	for (const [sid, rp] of remotePlayers) {
		const row = document.createElement('li');
		const colorHex = '#' + (rp._color ?? 0xffffff).toString(16).padStart(6, '0');
		row.innerHTML = `<span class="player-dot" style="background:${colorHex}"></span>${esc(rp.label?.textContent || sid.slice(0, 6))}<span class="player-motion">${rp.motion}</span>`;
		playersListEl.appendChild(row);
	}
}
function esc(s) { return String(s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[c]); }

// ── Renderer / scene ──────────────────────────────────────────────────────
// preserveDrawingBuffer is required so the canvas pixels remain readable for
// the "Record" feature — without it, drawImage(renderer.domElement, …) into
// the offscreen compositor canvas returns blank pixels after the next paint.
const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = PCFSoftShadowMap;

const scene = new Scene();

const pmrem = new PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

// Lights — ambient + hemi for soft fill, directional for shadow cast.
const ambientLight = new AmbientLight(0xffffff, 0.55);
scene.add(ambientLight);
const hemi = new HemisphereLight(0xbcd6ff, 0x202830, 0.6);
hemi.position.set(0, 5, 0);
scene.add(hemi);
const sun = new DirectionalLight(0xffffff, 1.4);
sun.position.set(4, 8, 6);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.camera.near = 0.5;
sun.shadow.camera.far = 30;
sun.shadow.camera.left = -8;
sun.shadow.camera.right = 8;
sun.shadow.camera.top = 8;
sun.shadow.camera.bottom = -8;
sun.shadow.bias = -0.0005;
scene.add(sun);
// sun.target must be in the scene for position updates to take effect.
scene.add(sun.target);

// Ground — opaque disc in non-AR mode, swapped to a shadow-only catcher in AR.
const groundOpaque = new Mesh(
	new CircleGeometry(GROUND_RADIUS, 64),
	new MeshStandardMaterial({ color: 0x202833, roughness: 0.95, metalness: 0.0 }),
);
groundOpaque.rotation.x = -Math.PI / 2;
groundOpaque.receiveShadow = true;
scene.add(groundOpaque);

const groundShadowCatcher = new Mesh(
	new CircleGeometry(GROUND_RADIUS, 64),
	new ShadowMaterial({ opacity: 0.32 }),
);
groundShadowCatcher.rotation.x = -Math.PI / 2;
groundShadowCatcher.receiveShadow = true;
groundShadowCatcher.visible = false;
scene.add(groundShadowCatcher);

// Blob contact shadow — radial gradient decal that moves with the avatar.
// Ensures there is always a convincing foot-contact cue even on low-end
// devices where PCF shadow maps may be coarse or disabled.
const _blobCanvas = document.createElement('canvas');
_blobCanvas.width = 64;
_blobCanvas.height = 64;
const _blobCtx = _blobCanvas.getContext('2d');
const _blobGrad = _blobCtx.createRadialGradient(32, 32, 0, 32, 32, 32);
_blobGrad.addColorStop(0, 'rgba(0,0,0,0.68)');
_blobGrad.addColorStop(0.45, 'rgba(0,0,0,0.28)');
_blobGrad.addColorStop(1, 'rgba(0,0,0,0)');
_blobCtx.fillStyle = _blobGrad;
_blobCtx.fillRect(0, 0, 64, 64);
const blobShadow = new Mesh(
	new PlaneGeometry(1.0, 1.0),
	new MeshBasicMaterial({ map: new CanvasTexture(_blobCanvas), transparent: true, depthWrite: false, opacity: 0 }),
);
blobShadow.rotation.x = -Math.PI / 2;
blobShadow.position.y = 0.004;
scene.add(blobShadow);

// Camera + follow-rig — avatar lives at scene origin (translated by a group)
// so the camera offset math stays in local space.
const camera = new PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.05, 200);
const avatarRig = new Group();
scene.add(avatarRig);

const camTarget = new Vector3();
const camDesired = new Vector3();
const camLookTarget = new Vector3();
const camLookCurrent = new Vector3();

let cameraYaw = 0;     // user-controlled orbit yaw around avatar (radians)
let cameraPitch = 0.05; // small downward tilt by default
// In AR mode the camera is frozen in world space instead of following the
// avatar — the joystick then walks the avatar around physically and natural
// perspective makes it grow/shrink as it approaches/recedes. Captured when
// AR is enabled, cleared when AR is disabled.
let arFrozenCamPos = null;
let arFrozenCamLook = null;
const PITCH_MIN = -0.6;
const PITCH_MAX = 0.7;

const CAM_ZOOM_MIN = 0.6;
const CAM_ZOOM_MAX = 3.2;
let camZoom = 1.0;

// ── Camera mode system ───────────────────────────────────────────────────
// Modes: 'follow' (default third-person), 'cinematic' (orbiting), 'firstperson', 'topdown'
const CAMERA_MODES = ['follow', 'cinematic', 'firstperson', 'topdown'];
const CAMERA_MODE_LABELS = { follow: 'Follow', cinematic: 'Cinematic', firstperson: 'First Person', topdown: 'Top Down' };
const CAMERA_MODE_FOV = { follow: 50, cinematic: 35, firstperson: 75, topdown: 50 };
const CAMERA_MODE_KEY = 'walk:camera-mode';
let cameraMode = 'follow';
let cameraModeTransition = 0; // 0 = done, >0 = lerping
const CAMERA_MODE_TRANSITION_DUR = 0.5; // seconds
let cameraModeFrom = { pos: new Vector3(), look: new Vector3(), fov: 50 };
let cameraModeTo = { pos: new Vector3(), look: new Vector3(), fov: 50 };
let cinematicAngle = 0;
let cinematicCutTimer = 0;
const CINEMATIC_ORBIT_SPEED = 0.15; // rad/s
const CINEMATIC_CUT_INTERVAL = 5; // seconds between auto-cuts
const CINEMATIC_RADIUS_MULT = 1.8;
const CINEMATIC_HEIGHT_MULT = 0.7;
const FP_EYE_HEIGHT_MULT = 0.9; // fraction of avatar height for eye position
const TOPDOWN_HEIGHT = 18;
const TOPDOWN_LOOK_DOWN = new Vector3(0, -1, 0.001); // slight offset so lookAt works

// Restore saved camera mode
try {
	const saved = localStorage.getItem(CAMERA_MODE_KEY);
	if (saved && CAMERA_MODES.includes(saved)) cameraMode = saved;
} catch {}

function setCameraMode(mode) {
	if (mode === cameraMode) return;
	// Snapshot current camera state as "from"
	cameraModeFrom.pos.copy(camera.position);
	cameraModeFrom.look.copy(camLookCurrent);
	cameraModeFrom.fov = camera.fov;
	cameraMode = mode;
	cameraModeTransition = CAMERA_MODE_TRANSITION_DUR;
	cameraModeTo.fov = CAMERA_MODE_FOV[mode] || 50;
	// Hide/show avatar for first person
	if (avatar) avatar.visible = mode !== 'firstperson';
	try { localStorage.setItem(CAMERA_MODE_KEY, mode); } catch {}
	updateCameraModeIndicator();
}

function cycleCameraMode() {
	const idx = CAMERA_MODES.indexOf(cameraMode);
	setCameraMode(CAMERA_MODES[(idx + 1) % CAMERA_MODES.length]);
	setStatus(`Camera: ${CAMERA_MODE_LABELS[cameraMode]}`);
}

// Camera mode indicator UI element
const cameraModeIndicator = (() => {
	const el = document.createElement('div');
	el.id = 'walk-camera-mode';
	el.setAttribute('role', 'status');
	el.style.cssText = [
		'position:fixed', 'z-index:6',
		'left:50%', 'top:calc(env(safe-area-inset-top, 0) + 60px)',
		'transform:translateX(-50%)',
		'background:rgba(17,17,17,0.72)', 'border:1px solid rgba(255,255,255,0.08)',
		'border-radius:999px', 'padding:5px 14px',
		'font-size:11px', 'font-weight:500', 'color:rgba(255,255,255,0.7)',
		'backdrop-filter:blur(10px)', '-webkit-backdrop-filter:blur(10px)',
		'pointer-events:none',
		'opacity:0', 'transition:opacity 0.25s ease',
	].join(';');
	document.body.appendChild(el);
	return el;
})();
let cameraModeIndicatorTimer = 0;

function updateCameraModeIndicator() {
	cameraModeIndicator.textContent = CAMERA_MODE_LABELS[cameraMode];
	cameraModeIndicator.style.opacity = '1';
	clearTimeout(cameraModeIndicatorTimer);
	cameraModeIndicatorTimer = setTimeout(() => {
		cameraModeIndicator.style.opacity = '0';
	}, 2000);
}

// Compute desired camera position/look for each mode
function computeCameraForMode(mode, avatarPos, avatarHeight) {
	const pos = new Vector3();
	const look = new Vector3();
	if (mode === 'follow') {
		const offset = CAM_OFFSET.clone().multiplyScalar(camZoom);
		offset.applyAxisAngle(new Vector3(1, 0, 0), -cameraPitch);
		offset.applyAxisAngle(upY, cameraYaw);
		pos.copy(avatarPos).add(offset);
		look.copy(avatarPos).add(CAM_LOOK_OFFSET);
	} else if (mode === 'cinematic') {
		const r = (avatarHeight || 1.8) * CINEMATIC_RADIUS_MULT * camZoom;
		const h = (avatarHeight || 1.8) * CINEMATIC_HEIGHT_MULT;
		pos.set(
			avatarPos.x + Math.cos(cinematicAngle) * r,
			avatarPos.y + h + 0.8,
			avatarPos.z + Math.sin(cinematicAngle) * r,
		);
		look.copy(avatarPos).add(CAM_LOOK_OFFSET);
	} else if (mode === 'firstperson') {
		const eyeH = (avatarHeight || 1.8) * FP_EYE_HEIGHT_MULT;
		pos.set(avatarPos.x, avatarPos.y + eyeH, avatarPos.z);
		// Look in the direction the avatar is facing
		const fpForward = new Vector3(Math.sin(avatarYaw), 0, Math.cos(avatarYaw));
		look.copy(pos).add(fpForward.multiplyScalar(5));
		look.y -= 0.15; // slight downward gaze
	} else if (mode === 'topdown') {
		pos.set(avatarPos.x, avatarPos.y + TOPDOWN_HEIGHT, avatarPos.z + 0.01);
		look.copy(avatarPos);
	}
	return { pos, look };
}

// Place the camera at its starting pose immediately so frame 0 isn't blank.
function applyCameraImmediate() {
	const offset = CAM_OFFSET.clone().multiplyScalar(camZoom);
	offset.applyAxisAngle(new Vector3(1, 0, 0), -cameraPitch);
	offset.applyAxisAngle(new Vector3(0, 1, 0), cameraYaw);
	camDesired.copy(avatarRig.position).add(offset);
	camera.position.copy(camDesired);
	camLookTarget.copy(avatarRig.position).add(CAM_LOOK_OFFSET);
	camLookCurrent.copy(camLookTarget);
	camera.lookAt(camLookCurrent);
}

// Recompute the follow offset so the full avatar plus headroom fits the
// current viewport. Distance is derived from the camera's vertical FOV, and
// portrait/narrow viewports (phones) get pulled back further so the head
// isn't cropped. Safe to call before an avatar loads — uses the cached height.
// On a resize we update the offset only and let the follow loop lerp to it;
// on first load we snap so frame 0 is already framed.
function frameAvatarCamera({ snap = true } = {}) {
	const height = avatarHeight || 1.8;
	const aspect = camera.aspect || window.innerWidth / window.innerHeight;
	// 1.5× the avatar height as the vertical span gives ~25% headroom top and
	// bottom; narrower-than-square viewports get up to ~1.6× for clear headroom.
	const portraitBoost = aspect < 1 ? 1 + (1 - aspect) * 0.6 : 1;
	const coverage = height * 1.5 * portraitBoost;
	const vFovRad = (camera.fov * Math.PI) / 180;
	const fitDist = coverage / (2 * Math.tan(vFovRad / 2));
	CAM_OFFSET.set(0, height * 0.62, fitDist);
	CAM_LOOK_OFFSET.set(0, height * 0.5, 0);
	if (snap) applyCameraImmediate();
}
applyCameraImmediate();

// ── Drag-to-orbit on the canvas (one-finger drag rotates the camera yaw) ──
{
	let dragging = false;
	let lastX = 0, lastY = 0;
	let downId = -1;

	canvas.addEventListener('pointerdown', (e) => {
		// Don't steal pointer events that belong to the joystick zone.
		// On some mobile browsers the canvas (being full-screen) can receive
		// a pointerdown before nipplejs does, and setPointerCapture would
		// redirect all subsequent pointermove events here — breaking movement.
		const jRect = joystickEl.getBoundingClientRect();
		const overJoystick = (
			e.clientX >= jRect.left && e.clientX <= jRect.right &&
			e.clientY >= jRect.top  && e.clientY <= jRect.bottom
		);
		if (overJoystick) return;

		dragging = true;
		downId = e.pointerId;
		lastX = e.clientX;
		lastY = e.clientY;
		canvas.setPointerCapture?.(e.pointerId);
	});
	const onMove = (e) => {
		if (!dragging || e.pointerId !== downId) return;
		const dx = e.clientX - lastX;
		const dy = e.clientY - lastY;
		lastX = e.clientX;
		lastY = e.clientY;
		cameraYaw -= dx * 0.005;
		cameraPitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, cameraPitch - dy * 0.0035));
	};
	const onUp = (e) => {
		if (e.pointerId !== downId) return;
		dragging = false;
		downId = -1;
		try { canvas.releasePointerCapture?.(e.pointerId); } catch {}
	};
	canvas.addEventListener('pointermove', onMove);
	canvas.addEventListener('pointerup', onUp);
	canvas.addEventListener('pointercancel', onUp);
}

// ── Input state — combined keyboard + joystick → unit move vector ────────
const input = {
	keys: { forward: 0, back: 0, left: 0, right: 0, run: false },
	joy: { x: 0, y: 0, active: false },
};

// ── Jump state ────────────────────────────────────────────────────────────
let jumpVelocity = 0;
let jumpActive = false;
const JUMP_FORCE = 5.8;
const GRAVITY = -14;
const GROUND_Y = 0;

function triggerJump() {
	if (jumpActive) return;
	jumpActive = true;
	jumpVelocity = JUMP_FORCE;
}

// ── Snap-turn (Q / E) ────────────────────────────────────────────────────
const SNAP_TURN_RAD = Math.PI / 4; // 45°

// ── Scroll-wheel zoom ────────────────────────────────────────────────────
canvas.addEventListener('wheel', (e) => {
	e.preventDefault();
	camZoom = Math.max(CAM_ZOOM_MIN, Math.min(CAM_ZOOM_MAX, camZoom + e.deltaY * 0.001));
}, { passive: false });

// ── Pointer lock (click canvas → lock; Esc → unlock) ────────────────────
let pointerLocked = false;

canvas.addEventListener('click', () => {
	if (!pointerLocked && !IS_TOUCH) {
		canvas.requestPointerLock?.();
	}
});
document.addEventListener('pointerlockchange', () => {
	pointerLocked = document.pointerLockElement === canvas;
});
document.addEventListener('mousemove', (e) => {
	if (!pointerLocked) return;
	cameraYaw -= e.movementX * 0.002;
	cameraPitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, cameraPitch - e.movementY * 0.002));
});

// ── Help overlay (? key) ─────────────────────────────────────────────────
const helpOverlay = (() => {
	const el = document.createElement('div');
	el.id = 'walk-help-overlay';
	el.setAttribute('aria-hidden', 'true');
	el.style.cssText = [
		'position:fixed', 'inset:0', 'z-index:9999',
		'display:flex', 'align-items:center', 'justify-content:center',
		'background:rgba(0,0,0,0.72)', 'backdrop-filter:blur(6px)',
		'color:#fff', 'font-family:system-ui,sans-serif',
		'opacity:0', 'pointer-events:none',
		'transition:opacity 0.18s',
	].join(';');
	el.innerHTML = `
		<div style="max-width:420px;width:90%;background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.12);border-radius:16px;padding:28px 32px">
			<h2 style="margin:0 0 20px;font-size:18px;font-weight:600;letter-spacing:-0.3px">Controls</h2>
			<table style="width:100%;border-collapse:collapse;font-size:14px;line-height:2">
				<tr><td style="color:#aaa;padding-right:16px">W A S D / Arrows</td><td>Move</td></tr>
				<tr><td style="color:#aaa;padding-right:16px">Shift</td><td>Run</td></tr>
				<tr><td style="color:#aaa;padding-right:16px">Space</td><td>Jump</td></tr>
				<tr><td style="color:#aaa;padding-right:16px">Q / E</td><td>Snap turn 45&deg;</td></tr>
				<tr><td style="color:#aaa;padding-right:16px">C</td><td>Cycle camera mode</td></tr>
				<tr><td style="color:#aaa;padding-right:16px">G</td><td>Gesture palette</td></tr>
				<tr><td style="color:#aaa;padding-right:16px">1 &ndash; 9</td><td>Quick gesture</td></tr>
				<tr><td style="color:#aaa;padding-right:16px">T / Enter</td><td>Chat</td></tr>
				<tr><td style="color:#aaa;padding-right:16px">V</td><td>Cycle environment</td></tr>
				<tr><td style="color:#aaa;padding-right:16px">P</td><td>Screenshot</td></tr>
				<tr><td style="color:#aaa;padding-right:16px">R</td><td>Toggle GIF recording</td></tr>
				<tr><td style="color:#aaa;padding-right:16px">M</td><td>Toggle minimap</td></tr>
				<tr><td style="color:#aaa;padding-right:16px">Z</td><td>Hide UI (scene + joystick only)</td></tr>
				<tr><td style="color:#aaa;padding-right:16px">H / ?</td><td>Toggle this overlay</td></tr>
				<tr><td style="color:#aaa;padding-right:16px">Mouse drag</td><td>Orbit camera</td></tr>
				<tr><td style="color:#aaa;padding-right:16px">Scroll wheel</td><td>Zoom in / out</td></tr>
				<tr><td style="color:#aaa;padding-right:16px">Esc</td><td>Close overlay / release pointer</td></tr>
			</table>
			<p style="margin:20px 0 0;font-size:12px;color:#666">Click the canvas to lock the mouse for first-person look.</p>
		</div>`;
	document.body.appendChild(el);
	return el;
})();

let helpVisible = false;
function toggleHelp() {
	helpVisible = !helpVisible;
	helpOverlay.style.opacity = helpVisible ? '1' : '0';
	helpOverlay.style.pointerEvents = helpVisible ? 'auto' : 'none';
	helpOverlay.setAttribute('aria-hidden', String(!helpVisible));
}
helpOverlay.addEventListener('click', (e) => {
	if (e.target === helpOverlay) toggleHelp();
});

window.addEventListener('keydown', (e) => {
	if (e.target?.tagName === 'INPUT' || e.target?.tagName === 'TEXTAREA') return;
	if (e.target !== document.body && e.target !== canvas) return;
	switch (e.code) {
		case 'KeyW': case 'ArrowUp':    input.keys.forward = 1; break;
		case 'KeyS': case 'ArrowDown':  input.keys.back = 1; break;
		case 'KeyA': case 'ArrowLeft':  input.keys.left = 1; break;
		case 'KeyD': case 'ArrowRight': input.keys.right = 1; break;
		case 'ShiftLeft': case 'ShiftRight': input.keys.run = true; break;
		case 'Space': e.preventDefault(); triggerJump(); break;
		case 'KeyQ': cameraYaw += SNAP_TURN_RAD; break;
		// 'E' kept for snap turn — environment cycles via 'V'
		case 'KeyE': cameraYaw -= SNAP_TURN_RAD; break;
		case 'KeyC': e.preventDefault(); cycleCameraMode(); break;
		case 'KeyG': e.preventDefault(); toggleGesturePalette(); break;
		case 'KeyT': e.preventDefault(); focusChat(); break;
		case 'KeyV': e.preventDefault(); cycleEnvironment(); break;
		case 'KeyP': e.preventDefault(); takeScreenshot(); break;
		case 'KeyR': e.preventDefault(); toggleGifRecording(); break;
		case 'KeyM': e.preventDefault(); toggleMinimap(); break;
		case 'KeyZ': e.preventDefault(); toggleZen(); break;
		case 'KeyH': e.preventDefault(); toggleHelp(); break;
		case 'Slash':
			if (e.shiftKey) { e.preventDefault(); toggleHelp(); }
			break;
		case 'Escape':
			if (helpVisible) { toggleHelp(); break; }
			if (gesturePaletteVisible) { hideGesturePalette(); break; }
			if (zenActive) { setZen(false); break; }
			break;
		// Number keys 1-9 for quick gestures
		case 'Digit1': e.preventDefault(); triggerQuickGesture(0); break;
		case 'Digit2': e.preventDefault(); triggerQuickGesture(1); break;
		case 'Digit3': e.preventDefault(); triggerQuickGesture(2); break;
		case 'Digit4': e.preventDefault(); triggerQuickGesture(3); break;
		case 'Digit5': e.preventDefault(); triggerQuickGesture(4); break;
		case 'Digit6': e.preventDefault(); triggerQuickGesture(5); break;
		case 'Digit7': e.preventDefault(); triggerQuickGesture(6); break;
		case 'Digit8': e.preventDefault(); triggerQuickGesture(7); break;
		case 'Digit9': e.preventDefault(); triggerQuickGesture(8); break;
		default: return;
	}
});
window.addEventListener('keyup', (e) => {
	switch (e.code) {
		case 'KeyW': case 'ArrowUp':    input.keys.forward = 0; break;
		case 'KeyS': case 'ArrowDown':  input.keys.back = 0; break;
		case 'KeyA': case 'ArrowLeft':  input.keys.left = 0; break;
		case 'KeyD': case 'ArrowRight': input.keys.right = 0; break;
		case 'ShiftLeft': case 'ShiftRight': input.keys.run = false; break;
	}
});

const joystick = nipplejs.create({
	zone: joystickEl,
	mode: 'static',
	position: { left: '50%', top: '50%' },
	size: 110,
	color: 'rgba(255,255,255,0.85)',
	restOpacity: 0.6,
});
joystick.on('move', (_evt, data) => {
	if (data?.vector) {
		// nipple's vector y is positive when stick is pushed UP — that's our
		// forward direction. Vector magnitude is already in [0, 1].
		const mag = Math.min(1, data.distance / 50);
		input.joy.x = data.vector.x * mag;
		input.joy.y = data.vector.y * mag;
		input.joy.active = mag > 0.05;
	}
});
joystick.on('end', () => {
	input.joy.x = 0;
	input.joy.y = 0;
	input.joy.active = false;
});

// ── Avatar loading + animations ──────────────────────────────────────────
const animationManager = new AnimationManager();
let avatar = null;
let avatarYaw = 0; // current facing (radians); we lerp this toward movement angle
let avatarLean = 0; // current torso pitch (radians); lerps toward target lean
let currentMotion = 'idle'; // 'idle' | 'walk' | 'run' — drives clip crossfades
let avatarHeight = 1.8; // cached avatar height, updated on load/switch

// Cached gltf scene + animation manifest defs, populated by loadAvatar — the
// multiplayer layer reuses both to spawn remote-player avatars without
// re-fetching the .glb or the clip manifest. SkeletonUtils.clone() makes a
// proper deep copy of skinned hierarchies; vanilla object3D.clone() would
// share bones and corrupt the rig.
let avatarTemplate = null;
let animationDefs = null;

async function loadAvatar() {
	setLoadingText('Resolving avatar...');
	const avatarUrl = await resolveAvatarUrl();
	setLoadingText('Loading 3D model...');
	const loader = new GLTFLoader();
	const gltf = await loader.loadAsync(avatarUrl);
	avatar = gltf.scene;
	avatarTemplate = gltf.scene;
	avatar.traverse((n) => {
		if (n.isMesh) {
			n.castShadow = true;
			n.receiveShadow = false;
			if (n.material && 'envMapIntensity' in n.material) {
				n.material.envMapIntensity = 0.85;
			}
		}
	});

	// Center the avatar's feet on the rig origin so y=0 is the ground.
	const box = new Box3().setFromObject(avatar);
	const minY = box.min.y;
	avatar.position.y -= minY;

	avatarRig.add(avatar);

	// Frame the camera relative to the avatar's height.
	const height = Math.max(0.5, box.max.y - box.min.y);
	avatarHeight = height;
	frameAvatarCamera();

	animationManager.attach(avatar);

	setLoadingText('Preparing animations...');
	const manifest = await fetch(ANIMATIONS_MANIFEST_URL, { cache: 'force-cache' })
		.then((r) => {
			if (!r.ok) throw new Error(`HTTP ${r.status} fetching animation manifest`);
			return r.json();
		});
	// Store the full manifest for emote tray population.
	_fullManifest = manifest;
	const needed = manifest.filter((d) =>
		d.name === CLIP_IDLE || d.name === CLIP_WALK || d.name === CLIP_RUN,
	);
	if (needed.length === 0) {
		throw new Error('Animation manifest missing idle/walking/running clips');
	}
	animationDefs = needed;
	animationManager.setAnimationDefs(needed);
	await animationManager.loadAll();

	await animationManager.crossfadeTo(CLIP_IDLE, 0.0);
	currentMotion = 'idle';

	dismissLoading();
	// Clear the sticky "loading avatar…" pill that #walk-status ships with —
	// setStatus auto-hides this confirmation after a couple of seconds.
	setStatus('Ready — drag to look around');
	buildEmoteTray();

	// Auto-hide help hints after 5 seconds.
	if (helpEl) {
		helpAutoHideTimer = setTimeout(() => {
			helpEl.style.display = 'none';
			helpAutoHideTimer = null;
		}, 5000);
	}
}

// ── Emote tray ───────────────────────────────────────────────────────────
let _fullManifest = null;
let _emoteActive = false;

const EMOTE_CLIPS = [
	{ name: 'wave', icon: '👋', label: 'Wave' },
	{ name: 'dance', icon: '💃', label: 'Dance' },
	{ name: 'celebrate', icon: '🎉', label: 'Celebrate' },
	{ name: 'angry', icon: '😠', label: 'Angry' },
	{ name: 'silly', icon: '🤪', label: 'Silly' },
	{ name: 'pray', icon: '🙏', label: 'Pray' },
	{ name: 'taunt', icon: '😏', label: 'Taunt' },
	{ name: 'kiss', icon: '😘', label: 'Kiss' },
];

function buildEmoteTray() {
	if (!emoteTrayEl || !_fullManifest) return;
	const available = EMOTE_CLIPS.filter(e =>
		_fullManifest.some(d => d.name === e.name),
	);
	if (available.length === 0) return;
	emoteTrayEl.hidden = false;
	emoteTrayEl.innerHTML = '';
	for (const emote of available) {
		const btn = document.createElement('button');
		btn.type = 'button';
		btn.className = 'walk-emote-btn';
		btn.title = emote.label;
		btn.setAttribute('aria-pressed', 'false');
		btn.innerHTML = `<span>${emote.icon}</span><span class="emote-label">${emote.label}</span>`;
		btn.addEventListener('click', () => playEmote(emote.name, btn));
		emoteTrayEl.appendChild(btn);
	}
}

async function playEmote(name, btn) {
	if (_emoteActive) return;
	_emoteActive = true;

	emoteTrayEl?.querySelectorAll('.walk-emote-btn').forEach(b => b.setAttribute('aria-pressed', 'false'));
	if (btn) btn.setAttribute('aria-pressed', 'true');

	const def = _fullManifest?.find(d => d.name === name);
	if (!def) { _emoteActive = false; return; }

	if (!animationDefs.some(d => d.name === name)) {
		animationDefs.push(def);
		animationManager.setAnimationDefs(animationDefs);
	}
	try {
		await animationManager.ensureLoaded(name);
	} catch {
		_emoteActive = false;
		return;
	}

	await animationManager.crossfadeTo(name, 0.2);
	if (net) net.sendEmote(name);

	const action = animationManager.currentAction;
	if (action && !action.loop) {
		const dur = action.getClip().duration * 1000;
		setTimeout(() => {
			if (!_emoteActive) return;
			_emoteActive = false;
			animationManager.crossfadeTo(motionToClipName(currentMotion), 0.25);
			if (btn) btn.setAttribute('aria-pressed', 'false');
		}, dur + 100);
	} else {
		setTimeout(() => {
			_emoteActive = false;
			animationManager.crossfadeTo(motionToClipName(currentMotion), 0.25);
			if (btn) btn.setAttribute('aria-pressed', 'false');
		}, 3000);
	}
}

// ── AR depth: light estimation ────────────────────────────────────────────
// Sample the camera feed at low resolution each second, derive scene
// brightness and tint, and adapt ambient/directional/hemi lights so the
// avatar is lit by the real environment instead of a static studio rig.
const _leSampleCanvas = document.createElement('canvas');
_leSampleCanvas.width = 8;
_leSampleCanvas.height = 6;
const _leSampleCtx = _leSampleCanvas.getContext('2d', { willReadFrequently: true });
let _leTickCount = 0;
const _leColor = new Color();

function estimateLighting() {
	if (!arActive || video.readyState < 2) return;
	_leTickCount++;
	if (_leTickCount % 30 !== 0) return;
	try {
		_leSampleCtx.drawImage(video, 0, 0, 8, 6);
		const px = _leSampleCtx.getImageData(0, 0, 8, 6).data;
		let r = 0, g = 0, b = 0;
		const n = px.length / 4;
		for (let i = 0; i < px.length; i += 4) { r += px[i]; g += px[i + 1]; b += px[i + 2]; }
		r = r / n / 255;
		g = g / n / 255;
		b = b / n / 255;
		const lum = 0.299 * r + 0.587 * g + 0.114 * b;
		// Smoothly adapt intensities to real scene brightness.
		ambientLight.intensity += (0.25 + lum * 0.95 - ambientLight.intensity) * 0.12;
		sun.intensity += (0.4 + lum * 1.6 - sun.intensity) * 0.12;
		// Tint the hemisphere sky to the dominant scene color.
		_leColor.setRGB(
			Math.min(1, 0.55 + r * 0.9),
			Math.min(1, 0.55 + g * 0.9),
			Math.min(1, 0.65 + b * 0.9),
		);
		hemi.color.lerp(_leColor, 0.12);
	} catch { /* cross-origin or tainted canvas — skip */ }
}

// ── AR passthrough ───────────────────────────────────────────────────────
let arActive = false;
let mediaStream = null;

async function enableAR() {
	if (!navigator.mediaDevices?.getUserMedia) {
		setStatus('camera API unavailable on this browser', { error: true, sticky: true });
		return;
	}
	try {
		mediaStream = await navigator.mediaDevices.getUserMedia({
			video: { facingMode: { ideal: 'environment' } },
			audio: false,
		});
	} catch (err) {
		const msg = err?.name === 'NotAllowedError'
			? 'camera permission denied'
			: `camera unavailable: ${err?.message ?? err}`;
		setStatus(msg, { error: true, sticky: true });
		return;
	}
	video.srcObject = mediaStream;
	try { await video.play(); } catch {}

	arActive = true;
	stage.classList.add('is-ar');
	arBtn.setAttribute('aria-pressed', 'true');
	groundOpaque.visible = false;
	groundShadowCatcher.visible = true;
	groundShadowCatcher.material.opacity = 0.55;
	renderer.setClearColor(0x000000, 0);
	scene.background = null;

	// Match the Three.js camera FOV to the device rear camera so the avatar's
	// perspective agrees with the real world (phones are typically ~70-75°).
	{
		const track = mediaStream?.getVideoTracks?.()[0];
		const s = track?.getSettings?.() ?? {};
		const w = s.width ?? window.innerWidth;
		const h = s.height ?? window.innerHeight;
		// Estimate horizontal FOV from diagonal FOV ≈ 72° default for rear cameras.
		const diagFov = 72;
		const diagPx = Math.hypot(w, h);
		const hFovRad = 2 * Math.atan((w / diagPx) * Math.tan((diagFov * Math.PI / 180) / 2));
		const aspect = window.innerWidth / window.innerHeight;
		const vFovDeg = (2 * Math.atan(Math.tan(hFovRad / 2) / aspect)) * (180 / Math.PI);
		camera.fov = Math.max(50, Math.min(90, vFovDeg));
		camera.updateProjectionMatrix();
	}

	// Show blob contact shadow.
	blobShadow.material.opacity = 1;

	// Freeze the camera at its current pose so the avatar walks around in
	// world space instead of being chased by a follow cam. With the camera
	// fixed, joystick-forward = avatar walks away (gets smaller), joystick-
	// back = avatar walks toward you (gets bigger).
	arFrozenCamPos = camera.position.clone();
	arFrozenCamLook = camLookCurrent.clone();

	setStatus('AR on — joystick walks your agent');
}

function disableAR() {
	if (mediaStream) {
		for (const track of mediaStream.getTracks()) {
			try { track.stop(); } catch {}
		}
		mediaStream = null;
	}
	video.srcObject = null;
	arActive = false;
	stage.classList.remove('is-ar');
	arBtn.setAttribute('aria-pressed', 'false');
	groundOpaque.visible = true;
	groundShadowCatcher.visible = false;
	groundShadowCatcher.material.opacity = 0.32;
	scene.background = null; // CSS gradient on #walk-stage shows through

	// Restore camera FOV and lighting defaults.
	camera.fov = 50;
	camera.updateProjectionMatrix();
	ambientLight.intensity = 0.55;
	sun.intensity = 1.4;
	hemi.color.set(0xbcd6ff);

	// Hide blob shadow.
	blobShadow.material.opacity = 0;

	arFrozenCamPos = null;
	arFrozenCamLook = null;

	setStatus('AR off');
}

arBtn.addEventListener('click', () => {
	if (arActive) disableAR();
	else enableAR();
	hideArCta();
});

// ── Mobile AR CTA ────────────────────────────────────────────────────────
// three.ws is "3D agents in real life," not a metaverse — the AR camera
// feature is the point. On touch devices the small "AR" pill in the corner
// is easy to miss, so we surface a prominent CTA after the avatar loads
// inviting the user to put their agent on their real floor. Dismissible.
const IS_TOUCH = (() => {
	if (typeof window === 'undefined') return false;
	return matchMedia('(hover: none) and (pointer: coarse)').matches
		|| ('ontouchstart' in window && navigator.maxTouchPoints > 0);
})();
const CAMERA_SUPPORTED = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
const AR_CTA_DISMISS_KEY = 'walk:ar-cta-dismissed';

function showArCta() {
	if (!arCta) return;
	if (arActive) return;
	if (!IS_TOUCH || !CAMERA_SUPPORTED) return;
	try { if (sessionStorage.getItem(AR_CTA_DISMISS_KEY) === '1') return; } catch {}
	arCta.classList.add('is-visible');
	arCta.setAttribute('aria-hidden', 'false');
}
function hideArCta() {
	if (!arCta) return;
	arCta.classList.remove('is-visible');
	arCta.setAttribute('aria-hidden', 'true');
}
if (arCta) {
	arCta.addEventListener('click', (e) => {
		// Tap the explicit dismiss "×" → remember and don't re-show this session.
		const target = /** @type {HTMLElement} */(e.target);
		if (target?.classList?.contains('dismiss')) {
			try { sessionStorage.setItem(AR_CTA_DISMISS_KEY, '1'); } catch {}
			hideArCta();
			return;
		}
		hideArCta();
		enableAR();
	});
}

// ── Recording (6s composite clip → Web Share API or download) ────────────
// Composites the live camera feed (when AR is active) plus the WebGL canvas
// into a single offscreen canvas, runs MediaRecorder on its captureStream,
// and hands the resulting blob to navigator.share — the IRL viral loop.
const RECORD_SECONDS = 6;
let recording = false;

function pickRecorderMime() {
	if (typeof MediaRecorder === 'undefined') return null;
	const candidates = [
		'video/mp4;codecs=avc1',
		'video/mp4',
		'video/webm;codecs=vp9',
		'video/webm;codecs=vp8',
		'video/webm',
	];
	for (const t of candidates) {
		try { if (MediaRecorder.isTypeSupported(t)) return t; } catch {}
	}
	return '';
}

async function startRecording() {
	if (recording) return;
	if (typeof MediaRecorder === 'undefined') {
		setStatus('recording not supported on this browser', { error: true });
		return;
	}
	const mime = pickRecorderMime();
	if (mime === null) {
		setStatus('recording not supported on this browser', { error: true });
		return;
	}

	const w = renderer.domElement.width;
	const h = renderer.domElement.height;
	const compose = document.createElement('canvas');
	compose.width = w;
	compose.height = h;
	const cctx = compose.getContext('2d');
	if (!cctx) {
		setStatus('recording context unavailable', { error: true });
		return;
	}

	const stream = compose.captureStream(30);
	let recorder;
	try {
		recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
	} catch (err) {
		setStatus(`recorder error: ${err?.message ?? err}`, { error: true });
		return;
	}
	const chunks = [];
	recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };

	recording = true;
	recordBtn?.setAttribute('data-recording', 'true');
	recordStatus?.classList.add('is-visible');
	if (recordStatusLabel) recordStatusLabel.textContent = `REC ${RECORD_SECONDS}s`;

	const startMs = performance.now();
	const renderCanvas = renderer.domElement;

	function paint() {
		if (!recording) return;
		// 1. Camera feed (covers in AR; opaque dark fill otherwise).
		if (arActive && video.readyState >= 2 && video.videoWidth > 0) {
			const vw = video.videoWidth;
			const vh = video.videoHeight;
			const scale = Math.max(w / vw, h / vh);
			const dw = vw * scale;
			const dh = vh * scale;
			cctx.drawImage(video, (w - dw) / 2, (h - dh) / 2, dw, dh);
		} else {
			cctx.fillStyle = '#0a0a0a';
			cctx.fillRect(0, 0, w, h);
		}
		// 2. Composite the 3D canvas on top (transparent regions show camera).
		cctx.drawImage(renderCanvas, 0, 0, w, h);

		const elapsed = (performance.now() - startMs) / 1000;
		const remaining = Math.max(0, Math.ceil(RECORD_SECONDS - elapsed));
		if (recordStatusLabel) recordStatusLabel.textContent = `REC ${remaining}s`;

		if (elapsed < RECORD_SECONDS) {
			requestAnimationFrame(paint);
		} else {
			try { recorder.stop(); } catch {}
		}
	}

	recorder.onstop = async () => {
		recording = false;
		recordBtn?.setAttribute('data-recording', 'false');
		recordStatus?.classList.remove('is-visible');

		const isMp4 = (recorder.mimeType || mime || '').includes('mp4');
		const ext = isMp4 ? 'mp4' : 'webm';
		const blobType = isMp4 ? 'video/mp4' : 'video/webm';
		const blob = new Blob(chunks, { type: blobType });
		const filename = `three-ws-walk-${Date.now()}.${ext}`;
		const file = new File([blob], filename, { type: blobType });

		const canShareFile = !!(navigator.canShare && navigator.canShare({ files: [file] }));
		if (canShareFile) {
			try {
				await navigator.share({
					files: [file],
					title: 'My 3D agent on three.ws',
					text: 'Walking around on three.ws — your AI, in the real world.',
				});
				setStatus('shared');
				return;
			} catch (err) {
				// User cancelled or share failed — fall through to download.
				if (err?.name !== 'AbortError') {
					console.warn('[walk] share failed, falling back to download:', err);
				} else {
					setStatus('share cancelled');
					return;
				}
			}
		}

		// Download fallback (desktop, or mobile browsers without file share).
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = filename;
		document.body.appendChild(a);
		a.click();
		a.remove();
		setTimeout(() => URL.revokeObjectURL(url), 4000);
		setStatus('clip saved');
	};

	recorder.onerror = (e) => {
		console.error('[walk] recorder error:', e);
		recording = false;
		recordBtn?.setAttribute('data-recording', 'false');
		recordStatus?.classList.remove('is-visible');
		setStatus('recording failed', { error: true });
	};

	recorder.start();
	requestAnimationFrame(paint);
}

if (recordBtn) {
	recordBtn.addEventListener('click', () => {
		if (recording) return; // single shot — must finish first
		startRecording();
		hideArCta(); // recording is a user gesture; if they hit record, dismiss the CTA
	});
}

// ── Resize ────────────────────────────────────────────────────────────────
function resize() {
	const w = window.innerWidth;
	const h = window.innerHeight;
	renderer.setSize(w, h, false);
	camera.aspect = w / h;
	camera.updateProjectionMatrix();
	// Re-fit the follow framing for the new aspect (e.g. phone rotation) so the
	// avatar's head stays in frame. Update the offset only; the loop lerps to it.
	frameAvatarCamera({ snap: false });
}
window.addEventListener('resize', resize);
window.addEventListener('orientationchange', resize);

// ── Main loop ─────────────────────────────────────────────────────────────
const clock = new Clock();
const moveWorld = new Vector3();
const moveForward = new Vector3();
const moveRight = new Vector3();
const tmpQuat = new Quaternion();
const upY = new Vector3(0, 1, 0);
const _camFwdTmp = new Vector3();
const _camToAvatarTmp = new Vector3();

function readMoveInput() {
	let ix, iy;
	if (input.joy.active) {
		// Joystick vector — y up is forward.
		ix = input.joy.x;
		iy = input.joy.y;
		// User input cancels waypoint
		if (waypointTarget) waypointTarget = null;
	} else if (input.keys.forward || input.keys.back || input.keys.left || input.keys.right) {
		ix = input.keys.right - input.keys.left;
		iy = input.keys.forward - input.keys.back;
		// User input cancels waypoint
		if (waypointTarget) waypointTarget = null;
	} else if (waypointTarget) {
		// Auto-walk toward waypoint — compute direction in world space,
		// then project to camera-relative input so the existing movement
		// pipeline handles facing and animation correctly.
		const dx = waypointTarget.x - avatarRig.position.x;
		const dz = waypointTarget.z - avatarRig.position.z;
		const dist = Math.hypot(dx, dz);
		if (dist < WAYPOINT_ARRIVE_DIST) {
			waypointTarget = null;
			ix = 0;
			iy = 0;
		} else {
			// World direction to waypoint
			const worldDir = new Vector3(dx, 0, dz).normalize();
			// Camera forward (XZ)
			const camFwd = new Vector3();
			camFwd.copy(camLookCurrent).sub(camera.position);
			camFwd.y = 0;
			if (camFwd.lengthSq() < 1e-6) camFwd.set(0, 0, -1);
			else camFwd.normalize();
			const camRight = new Vector3().crossVectors(camFwd, upY).normalize();
			// Project world direction onto camera axes
			ix = worldDir.dot(camRight);
			iy = worldDir.dot(camFwd);
			const m = Math.hypot(ix, iy);
			if (m > 0.01) { ix /= m; iy /= m; }
			// Slow down near target
			const speed = Math.min(1, dist / 1.5);
			ix *= speed * 0.7;
			iy *= speed * 0.7;
		}
	} else {
		ix = 0;
		iy = 0;
	}
	return { ix, iy };
}

function tick() {
	const dt = Math.min(clock.getDelta(), 0.05); // clamp huge frames after a tab switch

	// Jump physics — simple parabola in Y, lands back at GROUND_Y.
	if (jumpActive && avatar) {
		jumpVelocity += GRAVITY * dt;
		avatarRig.position.y += jumpVelocity * dt;
		if (avatarRig.position.y <= GROUND_Y) {
			avatarRig.position.y = GROUND_Y;
			jumpVelocity = 0;
			jumpActive = false;
		}
	}

	// 1. Resolve move input in camera-relative XZ space.
	const { ix, iy } = readMoveInput();
	const mag = Math.min(1, Math.hypot(ix, iy));

	const wantRun = mag > 0.9 || input.keys.run;
	const speed = mag * (wantRun ? RUN_SPEED : WALK_SPEED);

	if (mag > 0.01 && avatar) {
		// Forward = where the camera is currently looking, flattened to XZ.
		moveForward.copy(camLookCurrent).sub(camera.position);
		moveForward.y = 0;
		if (moveForward.lengthSq() < 1e-6) moveForward.set(0, 0, -1);
		else moveForward.normalize();
		moveRight.crossVectors(moveForward, upY).normalize();

		moveWorld.set(0, 0, 0)
			.addScaledVector(moveForward, iy / Math.max(mag, 1e-6))
			.addScaledVector(moveRight, ix / Math.max(mag, 1e-6))
			.normalize()
			.multiplyScalar(speed * dt);

		avatarRig.position.add(moveWorld);

		// Clamp roaming radius so the avatar can't walk off the ground disc
		// in non-AR mode. In AR there's no ground, so let it roam freely.
		if (!arActive) {
			const r = Math.hypot(avatarRig.position.x, avatarRig.position.z);
			const max = GROUND_RADIUS - 0.5;
			if (r > max) {
				const k = max / r;
				avatarRig.position.x *= k;
				avatarRig.position.z *= k;
			}
		}

		// Face the movement direction (smoothly).
		const wantYaw = Math.atan2(moveWorld.x, moveWorld.z);
		avatarYaw = lerpAngle(avatarYaw, wantYaw, TURN_LERP);
		avatarRig.quaternion.setFromAxisAngle(upY, avatarYaw);

		// Animation crossfade based on actual speed (the AnimationManager
		// no-ops if the requested name is already current).
		const want = wantRun ? 'run' : 'walk';
		if (currentMotion !== want) {
			currentMotion = want;
			animationManager.crossfadeTo(want === 'run' ? CLIP_RUN : CLIP_WALK, 0.18);
		}
	} else if (currentMotion !== 'idle' && avatar) {
		currentMotion = 'idle';
		animationManager.crossfadeTo(CLIP_IDLE, 0.25);
	}

	// Sync clip playback rate to actual ground speed so feet plant instead
	// of skating. mixer.timeScale is a global multiplier on every action;
	// when idle (speed≈0) we hold it at 1.0 so the breathing/sway cycle
	// stays natural.
	if (animationManager.mixer) {
		let ts = 1.0;
		if (currentMotion === 'walk') {
			ts = Math.max(0.45, speed / NATURAL_WALK_SPEED);
		} else if (currentMotion === 'run') {
			ts = Math.max(0.6, speed / NATURAL_RUN_SPEED);
		}
		animationManager.mixer.timeScale = ts;
	}

	// Procedural forward lean — sells weight transfer. Target lean ramps
	// with how much of the input is engaged; we lerp to it so direction
	// changes don't snap.
	const targetLean = currentMotion === 'run'
		? LEAN_RUN_RAD * mag
		: currentMotion === 'walk'
			? LEAN_WALK_RAD * mag
			: 0;
	avatarLean += (targetLean - avatarLean) * LEAN_LERP;
	if (avatar) avatar.rotation.x = avatarLean;

	// 2. Update camera — frozen in AR mode, camera-mode system otherwise.
	if (arFrozenCamPos && arFrozenCamLook) {
		// Clamp the avatar so it can't walk through (or past) the frozen camera.
		_camFwdTmp.subVectors(arFrozenCamLook, arFrozenCamPos);
		_camFwdTmp.y = 0;
		if (_camFwdTmp.lengthSq() > 1e-6) {
			_camFwdTmp.normalize();
			_camToAvatarTmp.subVectors(avatarRig.position, arFrozenCamPos);
			_camToAvatarTmp.y = 0;
			const forwardDist = _camToAvatarTmp.dot(_camFwdTmp);
			const MIN_FRONT_DIST = 0.8;
			if (forwardDist < MIN_FRONT_DIST) {
				avatarRig.position.addScaledVector(_camFwdTmp, MIN_FRONT_DIST - forwardDist);
			}
		}
		camera.position.copy(arFrozenCamPos);
		camLookCurrent.copy(arFrozenCamLook);
		camera.lookAt(camLookCurrent);
	} else {
		// Cinematic mode auto-orbit
		if (cameraMode === 'cinematic') {
			cinematicAngle += CINEMATIC_ORBIT_SPEED * dt;
			cinematicCutTimer += dt;
			if (cinematicCutTimer > CINEMATIC_CUT_INTERVAL) {
				cinematicCutTimer = 0;
				cinematicAngle += Math.PI * 0.6 + Math.random() * Math.PI * 0.8;
			}
		}

		const desired = computeCameraForMode(cameraMode, avatarRig.position, avatarHeight);

		// Camera mode transition (smooth lerp)
		if (cameraModeTransition > 0) {
			cameraModeTransition = Math.max(0, cameraModeTransition - dt);
			const t = 1 - (cameraModeTransition / CAMERA_MODE_TRANSITION_DUR);
			const ease = t * t * (3 - 2 * t); // smoothstep
			camera.position.lerpVectors(cameraModeFrom.pos, desired.pos, ease);
			camLookCurrent.lerpVectors(cameraModeFrom.look, desired.look, ease);
			camera.fov = cameraModeFrom.fov + (cameraModeTo.fov - cameraModeFrom.fov) * ease;
			camera.updateProjectionMatrix();
			camera.lookAt(camLookCurrent);
		} else {
			// Normal per-mode camera following
			const lerpFactor = cameraMode === 'firstperson' ? 0.2 : CAM_LERP;
			camera.position.lerp(desired.pos, lerpFactor);
			camLookCurrent.lerp(desired.look, lerpFactor);
			const targetFov = CAMERA_MODE_FOV[cameraMode] || 50;
			if (Math.abs(camera.fov - targetFov) > 0.1) {
				camera.fov += (targetFov - camera.fov) * 0.1;
				camera.updateProjectionMatrix();
			}
			camera.lookAt(camLookCurrent);
		}
	}

	// AR depth: track sun + blob shadow to the avatar each frame
	if (arActive) {
		const ap = avatarRig.position;
		sun.position.set(ap.x + 4, ap.y + 8, ap.z + 6);
		sun.target.position.copy(ap);
		sun.target.updateMatrixWorld();
		blobShadow.position.set(ap.x, 0.004, ap.z);
		estimateLighting();
	}

	// 3. Tick the animation mixer.
	animationManager.update(dt);

	// 4. Broadcast our state to the server (throttled inside WalkNet) and
	//    advance every remote player's interpolated transform + animation.
	if (net && avatar) {
		net.sendState({
			x: avatarRig.position.x,
			y: avatarRig.position.y,
			z: avatarRig.position.z,
			yaw: avatarYaw,
			motion: currentMotion,
		});
	}
	updateRemotePlayers(dt);

	// 5. Update speech bubbles (3D -> 2D projection)
	updateSpeechBubbles();

	// 6. Update minimap
	updateMinimapFrame();

	renderer.render(scene, camera);
	requestAnimationFrame(tick);
}

function lerpAngle(a, b, t) {
	// Shortest-arc lerp in radians.
	let diff = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
	if (diff < -Math.PI) diff += Math.PI * 2;
	return a + diff * t;
}

// ── Multiplayer ───────────────────────────────────────────────────────────
//
// The server is best-effort. /walk works fully as a single-player page if
// the Colyseus server is unreachable — the WalkNet client emits status
// transitions but never blocks the render loop or the local controller.

const REMOTE_LERP = 0.22; // per-frame lerp factor toward the latest server state
const REMOTE_YAW_LERP = 0.18;

/** @type {Map<string, RemotePlayer>} */
const remotePlayers = new Map();

let net = null;
let netConnected = false;

class RemotePlayer {
	constructor(sessionId, initial) {
		this.sessionId = sessionId;

		// Clone the loaded template via SkeletonUtils.clone so the skinned
		// mesh gets its own bone hierarchy. Plain Object3D.clone() would share
		// bones with the local avatar and produce visual chaos.
		const root = cloneSkinnedScene(avatarTemplate);
		root.traverse((n) => {
			if (n.isMesh) {
				n.castShadow = true;
				n.receiveShadow = false;
				// Materials are still shared with the template, which is fine
				// for env intensity, but we tint a hue offset onto the cloned
				// skinned mesh's emissive so each player is visually distinct.
				if (n.material && n.material.color && initial?.color != null) {
					n.material = n.material.clone();
					n.material.emissive = n.material.color.clone();
					n.material.emissive.setHex(initial.color);
					n.material.emissiveIntensity = 0.18;
				}
			}
		});

		this._color = initial?.color ?? 0xffffff;
		this._lastEmoteTs = 0;
		this._emoting = false;

		this.rig = new Group();
		this.rig.add(root);
		scene.add(this.rig);

		this.anim = new AnimationManager();
		this.anim.attach(root);
		this.anim.setAnimationDefs(animationDefs);
		// Reuse the already-fetched clips on the local manager — load asynchronously
		// so the remote doesn't block on a second manifest fetch.
		this.anim.loadAll().then(() => {
			this.anim.crossfadeTo(motionToClipName(this.motion), 0.0);
		});

		// Floating name tag — rendered as a CSS-styled DOM sprite that we
		// project onto the avatar's head each frame.
		this.label = document.createElement('div');
		this.label.className = 'walk-remote-label';
		this.label.textContent = initial?.name ?? sessionId.slice(0, 6);
		document.body.appendChild(this.label);

		// Visual state — target (latest server) vs current (interpolated).
		this.targetX = initial?.x ?? 0;
		this.targetY = initial?.y ?? 0;
		this.targetZ = initial?.z ?? 0;
		this.targetYaw = initial?.yaw ?? 0;
		this.motion = initial?.motion ?? 'idle';
		this.currentYaw = this.targetYaw;
		this.rig.position.set(this.targetX, this.targetY, this.targetZ);
		this.rig.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), this.targetYaw);
	}

	applyServerState(player) {
		this.targetX = player.x;
		this.targetY = player.y;
		this.targetZ = player.z;
		this.targetYaw = player.yaw;
		if (player.motion !== this.motion) {
			this.motion = player.motion;
			if (!this._emoting) {
				this.anim.crossfadeTo(motionToClipName(player.motion), 0.18);
			}
		}
		if (this.label.textContent !== player.name && player.name) {
			this.label.textContent = player.name;
		}
		if (player.emote && player.emoteTs !== this._lastEmoteTs) {
			this._lastEmoteTs = player.emoteTs;
			this._playRemoteEmote(player.emote);
		}
	}

	async _playRemoteEmote(name) {
		if (!_fullManifest) return;
		const def = _fullManifest.find(d => d.name === name);
		if (!def) return;
		if (!animationDefs.some(d => d.name === name)) {
			animationDefs.push(def);
			this.anim.setAnimationDefs(animationDefs);
		}
		try { await this.anim.ensureLoaded(name); } catch { return; }
		this._emoting = true;
		this.anim.crossfadeTo(name, 0.2);
		const action = this.anim.currentAction;
		const dur = (action && !action.loop) ? action.getClip().duration * 1000 : 3000;
		setTimeout(() => {
			this._emoting = false;
			this.anim.crossfadeTo(motionToClipName(this.motion), 0.25);
		}, dur + 100);
	}

	tick(dt) {
		// Position lerp.
		this.rig.position.x += (this.targetX - this.rig.position.x) * REMOTE_LERP;
		this.rig.position.y += (this.targetY - this.rig.position.y) * REMOTE_LERP;
		this.rig.position.z += (this.targetZ - this.rig.position.z) * REMOTE_LERP;
		// Yaw lerp (shortest arc).
		this.currentYaw = lerpAngle(this.currentYaw, this.targetYaw, REMOTE_YAW_LERP);
		this.rig.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), this.currentYaw);

		this.anim.update(dt);
		this._updateLabel();
	}

	_updateLabel() {
		// Project head world-space → screen-space for the floating name tag.
		const head = _tmpV3;
		head.set(this.rig.position.x, this.rig.position.y + 2.05, this.rig.position.z);
		head.project(camera);
		const onScreen = head.z > -1 && head.z < 1;
		if (!onScreen) {
			this.label.style.display = 'none';
			return;
		}
		const w = renderer.domElement.clientWidth;
		const h = renderer.domElement.clientHeight;
		const x = (head.x * 0.5 + 0.5) * w;
		const y = (-head.y * 0.5 + 0.5) * h;
		this.label.style.display = '';
		this.label.style.transform = `translate(-50%, -100%) translate(${x}px, ${y}px)`;
	}

	dispose() {
		scene.remove(this.rig);
		this.anim.dispose();
		this.label.remove();
	}
}

const _tmpV3 = new Vector3();

function motionToClipName(motion) {
	if (motion === 'run') return CLIP_RUN;
	if (motion === 'walk') return CLIP_WALK;
	return CLIP_IDLE;
}

function updateRemotePlayers(dt) {
	for (const r of remotePlayers.values()) r.tick(dt);
}

function setupOnlinePill() {
	if (!onlinePill) return;
	onlinePill.addEventListener('click', () => {
		if (!net) return;
		if (net.status === 'failed' || net.status === 'offline') {
			net.retry();
		} else {
			togglePlayersPanel();
		}
	});
}

function renderOnlineCount() {
	if (!onlineCountEl) return;
	// +1 for the local player — they're not in remotePlayers.
	onlineCountEl.textContent = String(remotePlayers.size + (netConnected ? 1 : 0));
}

function setOnlineStatus(status) {
	if (!onlinePill) return;
	onlinePill.dataset.status = status;
	const label = onlinePill.querySelector('[data-label]');
	if (label) {
		label.textContent =
			status === 'online'
				? 'online'
				: status === 'connecting'
					? 'connecting…'
					: status === 'failed'
						? 'offline — tap to retry'
						: status === 'offline'
							? 'reconnecting…'
							: 'solo';
	}
}

function startNet() {
	if (!avatarTemplate || !animationDefs) return;
	if (net) return;
	const stored = getStoredName();
	const name = (stored || `guest-${Math.random().toString(36).slice(2, 6)}`).slice(0, 24);
	if (nameInput && !nameInput.value) nameInput.value = name;
	net = new WalkNet({ name });

	net.on('status', ({ status }) => {
		netConnected = status === 'online';
		setOnlineStatus(status);
		renderOnlineCount();
	});
	net.on('add', (player, sessionId) => {
		if (sessionId === net.mySessionId) return; // skip self
		if (remotePlayers.has(sessionId)) return;
		remotePlayers.set(sessionId, new RemotePlayer(sessionId, {
			x: player.x, y: player.y, z: player.z, yaw: player.yaw,
			motion: player.motion, name: player.name, color: player.color,
		}));
		renderOnlineCount();
	});
	net.on('change', (player, sessionId) => {
		if (sessionId === net.mySessionId) return;
		const r = remotePlayers.get(sessionId);
		if (r) {
			r.applyServerState(player);
			if (playersPanelOpen) renderPlayerList();
		}
	});
	net.on('remove', (sessionId) => {
		const r = remotePlayers.get(sessionId);
		if (r) {
			r.dispose();
			remotePlayers.delete(sessionId);
			renderOnlineCount();
		}
	});

	setupOnlinePill();
	setOnlineStatus('connecting');
	renderOnlineCount();
	net.connect();
}

// ── Gesture palette (radial menu) ────────────────────────────────────────
// G key opens a radial menu of gesture shortcuts. Number keys 1-9 trigger
// gestures directly from the EMOTE_CLIPS list.
let gesturePaletteVisible = false;
const gesturePaletteEl = (() => {
	const el = document.createElement('div');
	el.id = 'walk-gesture-palette';
	el.setAttribute('aria-hidden', 'true');
	el.style.cssText = [
		'position:fixed', 'z-index:9998',
		'left:50%', 'top:50%', 'transform:translate(-50%,-50%)',
		'width:280px', 'height:280px',
		'border-radius:50%',
		'background:rgba(10,10,10,0.82)',
		'border:1px solid rgba(255,255,255,0.1)',
		'backdrop-filter:blur(16px)', '-webkit-backdrop-filter:blur(16px)',
		'display:none', 'opacity:0',
		'transition:opacity 0.18s ease, transform 0.18s ease',
		'pointer-events:none',
	].join(';');
	document.body.appendChild(el);
	return el;
})();

function buildGesturePalette() {
	gesturePaletteEl.innerHTML = '';
	const items = EMOTE_CLIPS;
	const count = items.length;
	const radius = 100;
	const centerX = 140;
	const centerY = 140;
	items.forEach((emote, i) => {
		const angle = (i / count) * Math.PI * 2 - Math.PI / 2;
		const x = centerX + Math.cos(angle) * radius - 24;
		const y = centerY + Math.sin(angle) * radius - 24;
		const btn = document.createElement('button');
		btn.type = 'button';
		btn.style.cssText = [
			'position:absolute', `left:${x}px`, `top:${y}px`,
			'width:48px', 'height:48px', 'border-radius:50%',
			'background:rgba(255,255,255,0.08)', 'border:1px solid rgba(255,255,255,0.15)',
			'color:#fff', 'font-size:22px', 'cursor:pointer',
			'display:flex', 'align-items:center', 'justify-content:center',
			'transition:transform 0.1s, background 0.1s',
		].join(';');
		btn.title = `${emote.label} [${i + 1}]`;
		btn.setAttribute('aria-label', emote.label);
		btn.textContent = emote.icon;
		btn.addEventListener('click', () => {
			playEmote(emote.name);
			hideGesturePalette();
		});
		btn.addEventListener('mouseenter', () => { btn.style.transform = 'scale(1.18)'; btn.style.background = 'rgba(255,255,255,0.18)'; });
		btn.addEventListener('mouseleave', () => { btn.style.transform = ''; btn.style.background = 'rgba(255,255,255,0.08)'; });
		gesturePaletteEl.appendChild(btn);
	});
	// Center label
	const label = document.createElement('div');
	label.style.cssText = 'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);font-size:11px;color:rgba(255,255,255,0.5);text-align:center;pointer-events:none;line-height:1.4';
	label.textContent = 'Gestures';
	gesturePaletteEl.appendChild(label);
}

function showGesturePalette() {
	if (!gesturePaletteEl.children.length) buildGesturePalette();
	gesturePaletteVisible = true;
	gesturePaletteEl.style.display = 'block';
	gesturePaletteEl.style.pointerEvents = 'auto';
	gesturePaletteEl.setAttribute('aria-hidden', 'false');
	requestAnimationFrame(() => {
		gesturePaletteEl.style.opacity = '1';
		gesturePaletteEl.style.transform = 'translate(-50%,-50%) scale(1)';
	});
}

function hideGesturePalette() {
	gesturePaletteVisible = false;
	gesturePaletteEl.style.opacity = '0';
	gesturePaletteEl.style.transform = 'translate(-50%,-50%) scale(0.85)';
	gesturePaletteEl.style.pointerEvents = 'none';
	gesturePaletteEl.setAttribute('aria-hidden', 'true');
	setTimeout(() => {
		if (!gesturePaletteVisible) gesturePaletteEl.style.display = 'none';
	}, 200);
}

function toggleGesturePalette() {
	if (gesturePaletteVisible) hideGesturePalette();
	else showGesturePalette();
}

function triggerQuickGesture(index) {
	if (index < 0 || index >= EMOTE_CLIPS.length) return;
	const emote = EMOTE_CLIPS[index];
	playEmote(emote.name);
	setStatus(`Gesture: ${emote.label}`);
}

// Close gesture palette on click outside
gesturePaletteEl.addEventListener('click', (e) => {
	if (e.target === gesturePaletteEl) hideGesturePalette();
});

// ── Chat focus helper ────────────────────────────────────────────────────
function focusChat() {
	const chatInput = document.getElementById('walk-chat-input');
	if (chatInput) chatInput.focus();
}

// ── Speech bubbles (3D→2D projected CSS overlays) ────────────────────────
// Floating text above the local avatar and remote players. Messages appear
// as styled DOM elements positioned each frame by projecting the avatar's
// head position from world space to screen space.
const speechBubbles = new Map(); // key: 'local' or sessionId → { el, timer, birth }
const SPEECH_BUBBLE_DURATION = 5000;
const SPEECH_BUBBLE_MAX_LEN = 140;

function createSpeechBubbleEl() {
	const wrap = document.createElement('div');
	wrap.className = 'walk-speech-bubble';
	wrap.style.cssText = [
		'position:fixed', 'z-index:3', 'pointer-events:none',
		'max-width:240px', 'padding:8px 14px',
		'background:rgba(10,10,10,0.82)', 'color:#fafafa',
		'border:1px solid rgba(255,255,255,0.12)',
		'border-radius:14px',
		'backdrop-filter:blur(8px)', '-webkit-backdrop-filter:blur(8px)',
		'font-size:12px', 'line-height:1.45',
		'word-break:break-word', 'white-space:pre-wrap',
		'transform:translate(-50%,-100%) scale(0.7)',
		'opacity:0',
		'transition:opacity 0.25s ease, transform 0.25s ease',
		'will-change:transform,opacity',
	].join(';');
	// Arrow pointer
	const arrow = document.createElement('div');
	arrow.style.cssText = [
		'position:absolute', 'bottom:-6px', 'left:50%',
		'transform:translateX(-50%)',
		'width:0', 'height:0',
		'border-left:6px solid transparent', 'border-right:6px solid transparent',
		'border-top:6px solid rgba(10,10,10,0.82)',
	].join(';');
	wrap.appendChild(arrow);
	document.body.appendChild(wrap);
	// Animate in
	requestAnimationFrame(() => {
		wrap.style.opacity = '1';
		wrap.style.transform = 'translate(-50%,-100%) scale(1)';
	});
	return wrap;
}

function showSpeechBubbleFor(key, text) {
	// Sanitize
	const clean = text.replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[c]).slice(0, SPEECH_BUBBLE_MAX_LEN);
	// Remove existing bubble for this key
	const existing = speechBubbles.get(key);
	if (existing) {
		clearTimeout(existing.timer);
		existing.el.remove();
		speechBubbles.delete(key);
	}
	const el = createSpeechBubbleEl();
	// Insert text before the arrow child
	const textNode = document.createElement('span');
	textNode.innerHTML = clean;
	el.insertBefore(textNode, el.firstChild);
	const timer = setTimeout(() => {
		el.style.opacity = '0';
		el.style.transform = 'translate(-50%,-100%) scale(0.85)';
		setTimeout(() => {
			el.remove();
			speechBubbles.delete(key);
		}, 300);
	}, SPEECH_BUBBLE_DURATION);
	speechBubbles.set(key, { el, timer, birth: performance.now() });
}

function updateSpeechBubbles() {
	const w = renderer.domElement.clientWidth;
	const h = renderer.domElement.clientHeight;
	const headV = _tmpV3;
	// Local avatar bubble
	const localBubble = speechBubbles.get('local');
	if (localBubble && avatar) {
		headV.set(avatarRig.position.x, avatarRig.position.y + 2.2, avatarRig.position.z);
		headV.project(camera);
		const onScreen = headV.z > -1 && headV.z < 1;
		if (onScreen) {
			const sx = (headV.x * 0.5 + 0.5) * w;
			const sy = (-headV.y * 0.5 + 0.5) * h;
			localBubble.el.style.left = sx + 'px';
			localBubble.el.style.top = (sy - 10) + 'px';
			localBubble.el.style.display = '';
		} else {
			localBubble.el.style.display = 'none';
		}
	}
	// Remote player bubbles
	for (const [sid, rp] of remotePlayers) {
		const bubble = speechBubbles.get(sid);
		if (!bubble) continue;
		headV.set(rp.rig.position.x, rp.rig.position.y + 2.2, rp.rig.position.z);
		headV.project(camera);
		const onScreen = headV.z > -1 && headV.z < 1;
		if (onScreen) {
			const sx = (headV.x * 0.5 + 0.5) * w;
			const sy = (-headV.y * 0.5 + 0.5) * h;
			bubble.el.style.left = sx + 'px';
			bubble.el.style.top = (sy - 10) + 'px';
			bubble.el.style.display = '';
		} else {
			bubble.el.style.display = 'none';
		}
	}
}

// ── Environment selector ─────────────────────────────────────────────────
// Four procedural environments using simple geometries. No external GLBs.
const ENV_KEY = 'walk:environment';
const ENVIRONMENTS = [
	{ name: 'default', label: 'Studio', groundColor: 0x202833, skyTop: '#1a2538', skyBot: '#0a0a0a', ambientColor: 0xffffff, ambientIntensity: 0.55, sunIntensity: 1.4, hemiSky: 0xbcd6ff },
	{ name: 'park', label: 'Park', groundColor: 0x2d5a27, skyTop: '#4a90c4', skyBot: '#87ceeb', ambientColor: 0xfffbe6, ambientIntensity: 0.7, sunIntensity: 1.6, hemiSky: 0xa8d8ea },
	{ name: 'city', label: 'City', groundColor: 0x3a3a3a, skyTop: '#1a1a2e', skyBot: '#16213e', ambientColor: 0xd4d4ff, ambientIntensity: 0.4, sunIntensity: 0.9, hemiSky: 0x8888aa },
	{ name: 'beach', label: 'Beach', groundColor: 0xc2b280, skyTop: '#3b7dd8', skyBot: '#87ceeb', ambientColor: 0xfff8e7, ambientIntensity: 0.75, sunIntensity: 1.8, hemiSky: 0xccddff },
];

let currentEnvIndex = 0;
const envPropsGroup = new Group();
scene.add(envPropsGroup);

// Restore saved environment
try {
	const savedEnv = localStorage.getItem(ENV_KEY);
	if (savedEnv) {
		const idx = ENVIRONMENTS.findIndex(e => e.name === savedEnv);
		if (idx >= 0) currentEnvIndex = idx;
	}
} catch {}

function applyEnvironment(index) {
	const env = ENVIRONMENTS[index];
	if (!env) return;
	currentEnvIndex = index;
	// Ground color
	groundOpaque.material.color.setHex(env.groundColor);
	// Stage background gradient
	if (stage) stage.style.background = `radial-gradient(80% 60% at 50% 30%, ${env.skyTop} 0%, ${env.skyBot} 70%) ${env.skyBot}`;
	// Lighting
	ambientLight.color.setHex(env.ambientColor);
	ambientLight.intensity = env.ambientIntensity;
	sun.intensity = env.sunIntensity;
	hemi.color.setHex(env.hemiSky);
	// Clear old props
	while (envPropsGroup.children.length > 0) {
		const child = envPropsGroup.children[0];
		envPropsGroup.remove(child);
		if (child.geometry) child.geometry.dispose();
		if (child.material) child.material.dispose();
		// InstancedMesh
		if (child.isInstancedMesh) {
			child.geometry.dispose();
			child.material.dispose();
		}
	}
	// Add environment props
	if (env.name === 'park') buildParkProps();
	else if (env.name === 'city') buildCityProps();
	else if (env.name === 'beach') buildBeachProps();
	try { localStorage.setItem(ENV_KEY, env.name); } catch {}
	updateEnvIndicator();
}

function buildParkProps() {
	// Trees as instanced cones + cylinders
	const trunkGeo = new CylinderGeometry(0.08, 0.12, 0.8, 6);
	const trunkMat = new MeshStandardMaterial({ color: 0x5c3a1e, roughness: 0.9 });
	const foliageGeo = new ConeGeometry(0.6, 1.4, 6);
	const foliageMat = new MeshStandardMaterial({ color: 0x2d7a2d, roughness: 0.85 });
	const dummy = new Object3D();
	const treeCount = 18;
	const trunkMesh = new InstancedMesh(trunkGeo, trunkMat, treeCount);
	const foliageMesh = new InstancedMesh(foliageGeo, foliageMat, treeCount);
	trunkMesh.castShadow = true;
	foliageMesh.castShadow = true;
	for (let i = 0; i < treeCount; i++) {
		const angle = (i / treeCount) * Math.PI * 2 + Math.random() * 0.3;
		const r = 5 + Math.random() * 5.5;
		const x = Math.cos(angle) * r;
		const z = Math.sin(angle) * r;
		const scale = 0.8 + Math.random() * 0.6;
		dummy.position.set(x, 0.4 * scale, z);
		dummy.scale.set(scale, scale, scale);
		dummy.updateMatrix();
		trunkMesh.setMatrixAt(i, dummy.matrix);
		dummy.position.y = 1.1 * scale;
		dummy.updateMatrix();
		foliageMesh.setMatrixAt(i, dummy.matrix);
	}
	envPropsGroup.add(trunkMesh);
	envPropsGroup.add(foliageMesh);
}

function buildCityProps() {
	// Buildings as instanced boxes along the perimeter
	const buildingGeo = new BoxGeometry(1, 1, 1);
	const buildingMat = new MeshStandardMaterial({ color: 0x2a2a3a, roughness: 0.7, metalness: 0.3 });
	const dummy = new Object3D();
	const count = 24;
	const mesh = new InstancedMesh(buildingGeo, buildingMat, count);
	mesh.castShadow = true;
	mesh.receiveShadow = true;
	for (let i = 0; i < count; i++) {
		const angle = (i / count) * Math.PI * 2 + Math.random() * 0.15;
		const r = 8 + Math.random() * 3;
		const x = Math.cos(angle) * r;
		const z = Math.sin(angle) * r;
		const h = 1.5 + Math.random() * 4;
		const w = 0.8 + Math.random() * 1.2;
		const d = 0.8 + Math.random() * 1.2;
		dummy.position.set(x, h / 2, z);
		dummy.scale.set(w, h, d);
		dummy.rotation.y = Math.random() * Math.PI;
		dummy.updateMatrix();
		mesh.setMatrixAt(i, dummy.matrix);
	}
	envPropsGroup.add(mesh);
	// Grid lines on ground
	const gridMat = new MeshBasicMaterial({ color: 0x555577, transparent: true, opacity: 0.15, side: DoubleSide });
	for (let i = -10; i <= 10; i += 2) {
		const lineH = new Mesh(new PlaneGeometry(24, 0.02), gridMat);
		lineH.rotation.x = -Math.PI / 2;
		lineH.position.set(0, 0.005, i);
		envPropsGroup.add(lineH);
		const lineV = new Mesh(new PlaneGeometry(0.02, 24), gridMat);
		lineV.rotation.x = -Math.PI / 2;
		lineV.position.set(i, 0.005, 0);
		envPropsGroup.add(lineV);
	}
}

function buildBeachProps() {
	// Wave plane
	const waveMat = new MeshStandardMaterial({ color: 0x2196f3, roughness: 0.2, metalness: 0.1, transparent: true, opacity: 0.6 });
	const wave = new Mesh(new PlaneGeometry(30, 14, 1, 1), waveMat);
	wave.rotation.x = -Math.PI / 2;
	wave.position.set(0, 0.01, -10);
	envPropsGroup.add(wave);
	// Palm trees
	const trunkGeo = new CylinderGeometry(0.06, 0.1, 2.5, 6);
	const trunkMat = new MeshStandardMaterial({ color: 0x8b6914, roughness: 0.9 });
	const leafGeo = new ConeGeometry(0.9, 0.5, 5);
	const leafMat = new MeshStandardMaterial({ color: 0x228b22, roughness: 0.8 });
	const dummy = new Object3D();
	const palmCount = 8;
	const palmTrunks = new InstancedMesh(trunkGeo, trunkMat, palmCount);
	const palmLeaves = new InstancedMesh(leafGeo, leafMat, palmCount);
	palmTrunks.castShadow = true;
	palmLeaves.castShadow = true;
	for (let i = 0; i < palmCount; i++) {
		const angle = (i / palmCount) * Math.PI + Math.PI * 0.5 + Math.random() * 0.3;
		const r = 6 + Math.random() * 4;
		const x = Math.cos(angle) * r;
		const z = Math.sin(angle) * r;
		dummy.position.set(x, 1.25, z);
		dummy.rotation.set(Math.random() * 0.15, 0, Math.random() * 0.15);
		dummy.scale.setScalar(1);
		dummy.updateMatrix();
		palmTrunks.setMatrixAt(i, dummy.matrix);
		dummy.position.y = 2.6;
		dummy.updateMatrix();
		palmLeaves.setMatrixAt(i, dummy.matrix);
	}
	envPropsGroup.add(palmTrunks);
	envPropsGroup.add(palmLeaves);
}

// Environment indicator
const envIndicator = (() => {
	const el = document.createElement('div');
	el.id = 'walk-env-indicator';
	el.setAttribute('role', 'status');
	el.style.cssText = [
		'position:fixed', 'z-index:6',
		'left:16px', 'top:calc(env(safe-area-inset-top, 0) + 60px)',
		'background:rgba(17,17,17,0.72)', 'border:1px solid rgba(255,255,255,0.08)',
		'border-radius:999px', 'padding:5px 14px',
		'font-size:11px', 'font-weight:500', 'color:rgba(255,255,255,0.7)',
		'backdrop-filter:blur(10px)', '-webkit-backdrop-filter:blur(10px)',
		'pointer-events:none',
		'opacity:0', 'transition:opacity 0.25s ease',
	].join(';');
	document.body.appendChild(el);
	return el;
})();
let envIndicatorTimer = 0;

function updateEnvIndicator() {
	const env = ENVIRONMENTS[currentEnvIndex];
	envIndicator.textContent = `Scene: ${env.label}`;
	envIndicator.style.opacity = '1';
	clearTimeout(envIndicatorTimer);
	envIndicatorTimer = setTimeout(() => {
		envIndicator.style.opacity = '0';
	}, 2000);
}

function cycleEnvironment() {
	const next = (currentEnvIndex + 1) % ENVIRONMENTS.length;
	applyEnvironment(next);
	setStatus(`Environment: ${ENVIRONMENTS[next].label}`);
}

// ── Screenshot capture ───────────────────────────────────────────────────
function takeScreenshot() {
	renderer.render(scene, camera); // ensure latest frame
	const dataUrl = renderer.domElement.toDataURL('image/png');
	const a = document.createElement('a');
	a.href = dataUrl;
	a.download = `three-ws-walk-${Date.now()}.png`;
	document.body.appendChild(a);
	a.click();
	a.remove();
	setStatus('Screenshot saved');
}

// ── GIF/frame recording ─────────────────────────────────────────────────
// Captures canvas frames at intervals and encodes as an animated GIF
// using a minimal inline LZW-based GIF encoder (no external deps).
let gifRecording = false;
let gifFrames = [];
let gifInterval = null;
const GIF_FRAME_INTERVAL = 100; // ms between captures
const GIF_MAX_FRAMES = 100; // 10 seconds max

// Recording indicator
const gifIndicator = (() => {
	const el = document.createElement('div');
	el.id = 'walk-gif-indicator';
	el.style.cssText = [
		'position:fixed', 'z-index:8',
		'right:16px', 'top:calc(env(safe-area-inset-top, 0) + 60px)',
		'background:rgba(248,113,113,0.92)', 'color:#fff',
		'border:1px solid rgba(255,255,255,0.25)',
		'border-radius:999px', 'padding:6px 14px',
		'font-size:12px', 'font-weight:600',
		'display:none', 'align-items:center', 'gap:8px',
		'pointer-events:none',
		'backdrop-filter:blur(6px)', '-webkit-backdrop-filter:blur(6px)',
	].join(';');
	const dot = document.createElement('span');
	dot.style.cssText = 'width:8px;height:8px;border-radius:50%;background:#fff;animation:walk-rec-pulse 0.9s infinite';
	el.appendChild(dot);
	const label = document.createElement('span');
	label.textContent = 'REC';
	el.appendChild(label);
	document.body.appendChild(el);
	return el;
})();

function startGifRecording() {
	gifRecording = true;
	gifFrames = [];
	gifIndicator.style.display = 'inline-flex';
	setStatus('Recording started — press R to stop');

	gifInterval = setInterval(() => {
		if (!gifRecording) return;
		if (gifFrames.length >= GIF_MAX_FRAMES) {
			stopGifRecording();
			return;
		}
		// Capture frame as PNG data URL
		renderer.render(scene, camera);
		const dataUrl = renderer.domElement.toDataURL('image/png');
		gifFrames.push(dataUrl);
		// Update indicator
		const secs = ((gifFrames.length * GIF_FRAME_INTERVAL) / 1000).toFixed(1);
		gifIndicator.lastChild.textContent = `REC ${secs}s`;
	}, GIF_FRAME_INTERVAL);
}

function stopGifRecording() {
	gifRecording = false;
	if (gifInterval) { clearInterval(gifInterval); gifInterval = null; }
	gifIndicator.style.display = 'none';

	if (gifFrames.length === 0) {
		setStatus('No frames captured');
		return;
	}
	setStatus(`Encoding ${gifFrames.length} frames...`);
	// Since building a full GIF encoder inline is complex, we export as
	// individual PNG frames bundled in a webm video via MediaRecorder,
	// or as a simple PNG download of the last frame. For a proper
	// animated output, use canvas.captureStream + MediaRecorder.
	exportFramesAsVideo(gifFrames);
}

async function exportFramesAsVideo(frames) {
	// Re-render frames onto a canvas and use MediaRecorder for a real video file
	if (frames.length < 2) {
		// Single frame — just download as PNG
		const a = document.createElement('a');
		a.href = frames[0];
		a.download = `three-ws-walk-${Date.now()}.png`;
		document.body.appendChild(a);
		a.click();
		a.remove();
		setStatus('Screenshot saved (single frame)');
		return;
	}

	const img = new Image();
	await new Promise((resolve, reject) => {
		img.onload = resolve;
		img.onerror = reject;
		img.src = frames[0];
	});

	const w = img.naturalWidth;
	const h = img.naturalHeight;
	const offscreen = document.createElement('canvas');
	offscreen.width = w;
	offscreen.height = h;
	const ctx = offscreen.getContext('2d');
	const stream = offscreen.captureStream(0); // manually push frames
	const videoTrack = stream.getVideoTracks()[0];

	const mime = pickRecorderMime();
	let recorder;
	try {
		recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
	} catch {
		setStatus('Recording not supported in this browser', { error: true });
		return;
	}

	const chunks = [];
	recorder.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };

	recorder.onstop = () => {
		const isMp4 = (recorder.mimeType || '').includes('mp4');
		const ext = isMp4 ? 'mp4' : 'webm';
		const blob = new Blob(chunks, { type: isMp4 ? 'video/mp4' : 'video/webm' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `three-ws-walk-${Date.now()}.${ext}`;
		document.body.appendChild(a);
		a.click();
		a.remove();
		setTimeout(() => URL.revokeObjectURL(url), 4000);
		setStatus(`Recording saved (${frames.length} frames)`);
	};

	recorder.start();

	// Play back each frame onto the offscreen canvas
	for (let i = 0; i < frames.length; i++) {
		const frameImg = new Image();
		await new Promise((resolve) => {
			frameImg.onload = resolve;
			frameImg.onerror = resolve;
			frameImg.src = frames[i];
		});
		ctx.clearRect(0, 0, w, h);
		ctx.drawImage(frameImg, 0, 0, w, h);
		// Request a frame from the stream
		if (videoTrack.requestFrame) videoTrack.requestFrame();
		await new Promise(r => setTimeout(r, GIF_FRAME_INTERVAL));
	}

	recorder.stop();
}

function toggleGifRecording() {
	if (gifRecording) stopGifRecording();
	else startGifRecording();
}

// ── Minimap ──────────────────────────────────────────────────────────────
// Small top-down canvas in the bottom-right corner showing player positions
// and environment bounds.
let minimapVisible = false;
const MINIMAP_SIZE = 160;
const MINIMAP_WORLD_RADIUS = 14; // world units visible in the minimap

const minimapContainer = (() => {
	const el = document.createElement('div');
	el.id = 'walk-minimap';
	el.style.cssText = [
		'position:fixed', 'z-index:6',
		'right:16px', 'bottom:calc(28px + env(safe-area-inset-bottom, 0))',
		'width:' + MINIMAP_SIZE + 'px', 'height:' + MINIMAP_SIZE + 'px',
		'border-radius:12px', 'overflow:hidden',
		'background:rgba(10,10,10,0.7)',
		'border:1px solid rgba(255,255,255,0.1)',
		'backdrop-filter:blur(6px)', '-webkit-backdrop-filter:blur(6px)',
		'display:none',
		'opacity:0', 'transition:opacity 0.2s ease',
		'cursor:crosshair',
	].join(';');
	document.body.appendChild(el);
	return el;
})();

const minimapCanvas = (() => {
	const c = document.createElement('canvas');
	c.width = MINIMAP_SIZE * 2; // 2x for retina
	c.height = MINIMAP_SIZE * 2;
	c.style.cssText = 'width:100%;height:100%;display:block';
	minimapContainer.appendChild(c);
	return c;
})();

const minimapCtx = minimapCanvas.getContext('2d');

// Waypoint: click on minimap to set a target position for the avatar
let waypointTarget = null;
const WAYPOINT_SPEED = 2.0;
const WAYPOINT_ARRIVE_DIST = 0.3;

minimapContainer.addEventListener('click', (e) => {
	const rect = minimapContainer.getBoundingClientRect();
	const nx = (e.clientX - rect.left) / rect.width;
	const ny = (e.clientY - rect.top) / rect.height;
	// Map from minimap coords to world coords
	// minimap center = avatar position
	const wx = avatarRig.position.x + (nx - 0.5) * MINIMAP_WORLD_RADIUS * 2;
	const wz = avatarRig.position.z + (ny - 0.5) * MINIMAP_WORLD_RADIUS * 2;
	// Clamp to ground radius
	const r = Math.hypot(wx, wz);
	if (r > GROUND_RADIUS - 0.5) {
		const k = (GROUND_RADIUS - 0.5) / r;
		waypointTarget = { x: wx * k, z: wz * k };
	} else {
		waypointTarget = { x: wx, z: wz };
	}
	setStatus('Waypoint set — avatar walking to target');
});

function toggleMinimap() {
	minimapVisible = !minimapVisible;
	if (minimapVisible) {
		minimapContainer.style.display = 'block';
		requestAnimationFrame(() => { minimapContainer.style.opacity = '1'; });
	} else {
		minimapContainer.style.opacity = '0';
		setTimeout(() => { if (!minimapVisible) minimapContainer.style.display = 'none'; }, 200);
	}
	setStatus(minimapVisible ? 'Minimap on' : 'Minimap off');
}

function updateMinimapFrame() {
	if (!minimapVisible) return;
	const ctx = minimapCtx;
	const s = MINIMAP_SIZE * 2;
	const half = s / 2;
	const scale = s / (MINIMAP_WORLD_RADIUS * 2);

	ctx.clearRect(0, 0, s, s);

	// Background
	ctx.fillStyle = 'rgba(10,10,10,0.6)';
	ctx.fillRect(0, 0, s, s);

	// Ground disc outline
	ctx.save();
	ctx.translate(half, half);
	const groundPxR = GROUND_RADIUS * scale;
	const offsetX = -avatarRig.position.x * scale;
	const offsetZ = -avatarRig.position.z * scale;
	ctx.beginPath();
	ctx.arc(offsetX, offsetZ, groundPxR, 0, Math.PI * 2);
	ctx.strokeStyle = 'rgba(255,255,255,0.15)';
	ctx.lineWidth = 1;
	ctx.stroke();
	ctx.fillStyle = 'rgba(255,255,255,0.03)';
	ctx.fill();

	// Environment props indicator (dots for trees/buildings)
	for (const child of envPropsGroup.children) {
		if (child.isInstancedMesh && child.count > 0) {
			const m = new Matrix4();
			for (let i = 0; i < child.count; i++) {
				child.getMatrixAt(i, m);
				const px = m.elements[12] * scale + offsetX;
				const pz = m.elements[14] * scale + offsetZ;
				ctx.beginPath();
				ctx.arc(px, pz, 2, 0, Math.PI * 2);
				ctx.fillStyle = 'rgba(255,255,255,0.2)';
				ctx.fill();
			}
		}
	}

	// Remote players
	for (const [sid, rp] of remotePlayers) {
		const px = (rp.rig.position.x - avatarRig.position.x) * scale;
		const pz = (rp.rig.position.z - avatarRig.position.z) * scale;
		ctx.beginPath();
		ctx.arc(px, pz, 4, 0, Math.PI * 2);
		const colorHex = '#' + (rp._color ?? 0xff8844).toString(16).padStart(6, '0');
		ctx.fillStyle = colorHex;
		ctx.fill();
	}

	// Waypoint indicator
	if (waypointTarget) {
		const wpx = (waypointTarget.x - avatarRig.position.x) * scale;
		const wpz = (waypointTarget.z - avatarRig.position.z) * scale;
		ctx.beginPath();
		ctx.arc(wpx, wpz, 5, 0, Math.PI * 2);
		ctx.strokeStyle = '#4ade80';
		ctx.lineWidth = 2;
		ctx.stroke();
		// Pulsing ring
		const pulse = (performance.now() % 1500) / 1500;
		ctx.beginPath();
		ctx.arc(wpx, wpz, 5 + pulse * 8, 0, Math.PI * 2);
		ctx.strokeStyle = `rgba(74,222,128,${0.5 - pulse * 0.5})`;
		ctx.lineWidth = 1;
		ctx.stroke();
	}

	// Local player (green arrow at center)
	ctx.save();
	ctx.rotate(-avatarYaw);
	ctx.beginPath();
	ctx.moveTo(0, -7);
	ctx.lineTo(5, 5);
	ctx.lineTo(0, 2);
	ctx.lineTo(-5, 5);
	ctx.closePath();
	ctx.fillStyle = '#4ade80';
	ctx.fill();
	ctx.restore();

	ctx.restore();
}

// ── Help overlay first-visit auto-show ───────────────────────────────────
const HELP_FIRST_VISIT_KEY = 'walk:help-shown';
function showHelpOnFirstVisit() {
	try {
		if (localStorage.getItem(HELP_FIRST_VISIT_KEY) === '1') return;
		localStorage.setItem(HELP_FIRST_VISIT_KEY, '1');
	} catch { return; }
	// Show help briefly on first visit
	toggleHelp();
	setTimeout(() => {
		if (helpVisible) toggleHelp();
	}, 6000);
}

// ── Boot ──────────────────────────────────────────────────────────────────
loadAvatar()
	.then(() => {
		requestAnimationFrame(tick);
		startNet();
		// Apply saved environment
		applyEnvironment(currentEnvIndex);
		// Show camera mode if not default
		if (cameraMode !== 'follow') {
			if (avatar) avatar.visible = cameraMode !== 'firstperson';
			updateCameraModeIndicator();
		}
		// First-visit help
		showHelpOnFirstVisit();
		// Mobile + camera-capable → invite the user into AR. Delayed so it
		// lands after the "walk it" status fade, not on top of it.
		setTimeout(showArCta, 900);
	})
	.catch((err) => {
		console.error('[walk] failed to load avatar:', err);
		// Tear down the full-screen loading overlay so the error is readable and
		// the scene (default ground/lighting) is visible behind the message.
		dismissLoading();
		const hasParam = new URLSearchParams(location.search).has('avatar');
		const suffix = hasParam ? ' — <a href="/walk">try the default avatar</a>' : '';
		if (statusEl) {
			statusEl.innerHTML = `failed to load avatar: ${err?.message ?? err}${suffix}`;
			statusEl.classList.add('is-error');
			statusEl.classList.remove('is-hidden');
		}
		requestAnimationFrame(tick);
	});

// ── Avatar picker ────────────────────────────────────────────────────────
{
	const pickerPanel = document.getElementById('walk-avatar-picker');
	const pickerList = document.getElementById('walk-avatar-picker-list');
	const pickerBtn = document.getElementById('walk-avatar-btn');
	const pickerClose = document.getElementById('walk-avatar-picker-close');
	let pickerOpen = false;
	let pickerLoaded = false;
	let currentAvatarId = new URLSearchParams(location.search).get('avatar') || null;

	function togglePicker() {
		pickerOpen = !pickerOpen;
		if (pickerPanel) pickerPanel.hidden = !pickerOpen;
		if (pickerOpen && !pickerLoaded) loadAvatarList();
	}

	if (pickerBtn) pickerBtn.addEventListener('click', togglePicker);
	if (pickerClose) pickerClose.addEventListener('click', () => { pickerOpen = false; if (pickerPanel) pickerPanel.hidden = true; });

	async function loadAvatarList() {
		pickerLoaded = true;
		try {
			const res = await fetch('/api/avatars?limit=20', { credentials: 'include' });
			if (!res.ok) throw new Error('not signed in');
			const data = await res.json();
			const avatars = data?.avatars ?? [];
			if (!avatars.length) {
				pickerList.innerHTML = '<div class="walk-avatar-picker-loading">No avatars yet. <a href="/create" style="color:#fff;text-decoration:underline">Create one</a></div>';
				return;
			}
			pickerList.innerHTML = `
				<button class="walk-avatar-opt${!currentAvatarId ? ' is-active' : ''}" data-avatar-url="/avatars/default.glb" data-avatar-id="">
					<div class="walk-avatar-opt-thumb" style="background:#333;display:flex;align-items:center;justify-content:center;font-size:16px">D</div>
					<span class="walk-avatar-opt-name">Default avatar</span>
				</button>
				${avatars.map(a => {
					const thumb = a.thumbnail_url || '';
					const name = a.name || a.slug || 'Untitled';
					const active = currentAvatarId === a.id;
					return `<button class="walk-avatar-opt${active ? ' is-active' : ''}" data-avatar-url="${a.url || ''}" data-avatar-id="${a.id}">
						${thumb ? `<img class="walk-avatar-opt-thumb" src="${thumb}" alt="" loading="lazy" />` : `<div class="walk-avatar-opt-thumb" style="display:flex;align-items:center;justify-content:center;font-size:14px;color:#999">${name[0]}</div>`}
						<span class="walk-avatar-opt-name">${name.replace(/[<>&"']/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":"&#39;"})[c])}</span>
					</button>`;
				}).join('')}
			`;
		} catch {
			pickerList.innerHTML = '<div class="walk-avatar-picker-loading"><a href="/login" style="color:#fff;text-decoration:underline">Sign in</a> to use your avatars</div>';
		}
	}

	if (pickerList) pickerList.addEventListener('click', async (e) => {
		const btn = e.target.closest('.walk-avatar-opt');
		if (!btn) return;
		const url = btn.dataset.avatarUrl;
		if (!url) return;

		pickerList.querySelectorAll('.walk-avatar-opt').forEach(b => b.classList.remove('is-active'));
		btn.classList.add('is-active');
		currentAvatarId = btn.dataset.avatarId || null;

		setStatus('Switching avatar...');
		try {
			const loader = new GLTFLoader();
			const gltf = await loader.loadAsync(url);
			if (avatar) avatarRig.remove(avatar);
			avatar = gltf.scene;
			avatarTemplate = gltf.scene;
			avatar.traverse(n => {
				if (n.isMesh) { n.castShadow = true; n.receiveShadow = false; }
			});
			const box = new Box3().setFromObject(avatar);
			avatar.position.y -= box.min.y;
			avatarRig.add(avatar);
			const height = Math.max(0.5, box.max.y - box.min.y);
			avatarHeight = height;
			CAM_OFFSET.set(0, height * 1.05, height * 1.95);
			CAM_LOOK_OFFSET.set(0, height * 0.6, 0);
			// Respect current camera mode visibility
			if (cameraMode === 'firstperson') avatar.visible = false;
			animationManager.attach(avatar);
			animationManager.crossfadeTo(motionToClipName(currentMotion), 0);
			setStatus('Avatar switched');
		} catch (err) {
			setStatus('Failed to load avatar', { error: true });
			console.error('[walk] avatar switch failed:', err);
		}
		togglePicker();
	});
}

// ── Chat system ──────────────────────────────────────────────────────────
{
	const chatMessages = document.getElementById('walk-chat-messages');
	const chatForm = document.getElementById('walk-chat-form');
	const chatInput = document.getElementById('walk-chat-input');
	const MAX_VISIBLE = 8;
	const FADE_MS = 12000;

	function addChatMessage(name, text, opts = {}) {
		if (!chatMessages) return;
		const msg = document.createElement('div');
		msg.className = 'walk-chat-msg' + (opts.system ? ' is-system' : '');
		if (opts.system) {
			msg.textContent = text;
		} else {
			const colorHex = opts.color ? '#' + opts.color.toString(16).padStart(6, '0') : '#fff';
			msg.innerHTML = `<span class="walk-chat-msg-name" style="color:${colorHex}">${esc(name)}</span>${esc(text)}`;
		}
		chatMessages.appendChild(msg);

		while (chatMessages.children.length > MAX_VISIBLE) {
			chatMessages.removeChild(chatMessages.firstChild);
		}

		setTimeout(() => {
			msg.style.opacity = '0';
			setTimeout(() => msg.remove(), 300);
		}, FADE_MS);
	}

	if (chatForm) chatForm.addEventListener('submit', (e) => {
		e.preventDefault();
		const text = chatInput.value.trim();
		if (!text) return;
		chatInput.value = '';
		chatInput.blur(); // return focus to canvas so WASD works
		const name = nameInput?.value?.trim() || 'you';
		addChatMessage(name, text);
		// Show speech bubble above local avatar
		showSpeechBubbleFor('local', text);
		if (net?.room) {
			net.room.send('chat', { text: text.slice(0, 200) });
		}
	});

	window.addEventListener('keydown', (e) => {
		if (e.key === 'Enter' && !e.shiftKey && document.activeElement !== chatInput
			&& document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
			e.preventDefault();
			chatInput?.focus();
		}
	});

	window._walkChat = { addChatMessage };
}

// ── Restore zen preference ───────────────────────────────────────────────
// Runs after all UI state is declared. URL param wins, then stored choice.
(() => {
	const param = new URLSearchParams(location.search).get('ui');
	if (param === 'hidden' || param === 'off') { setZen(true); return; }
	if (param === 'on' || param === 'shown') return;
	try { if (localStorage.getItem(ZEN_STORAGE_KEY) === '1') setZen(true); } catch {}
})();
