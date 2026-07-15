// src/irl.js — IRL AR playground
//
// Full-screen walking avatar + camera AR passthrough + tap-to-place 3D objects.
// Visual style mirrors /avatars/:id/ar (bottom panel, gradient bg, hero CTA).
// Walking + joystick from walk-embed. Camera mode makes the real floor the stage.

import {
	ACESFilmicToneMapping,
	AmbientLight,
	Box3,
	BoxGeometry,
	CircleGeometry,
	CylinderGeometry,
	DirectionalLight,
	Group,
	HemisphereLight,
	Mesh,
	MeshBasicMaterial,
	MeshPhysicalMaterial,
	MeshStandardMaterial,
	OctahedronGeometry,
	OrthographicCamera,
	PCFSoftShadowMap,
	PerspectiveCamera,
	PlaneGeometry,
	PMREMGenerator,
	Quaternion,
	Raycaster,
	Scene,
	ShadowMaterial,
	SphereGeometry,
	Sprite,
	SpriteMaterial,
	SRGBColorSpace,
	Timer,
	TorusGeometry,
	Vector2,
	Vector3,
	WebGLRenderer,
	WebGLRenderTarget,
} from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import nipplejs from 'nipplejs';
import { AnimationManager } from './animation-manager.js';
import { WebXRSession } from './ar/webxr.js';
import { clampPinScale } from './ar/pinch-scale.js';
import { resolvePlacementCapability } from './ar/placement-capability.js';
import { openQuickLook } from './ar/quick-look.js';
import { createPersistGate, placementHint } from './ar/anchor-lifecycle.js';
import { IrlNet } from './irl-net.js';
import { wireShareButton } from './irl/share-frame.js';
import { log } from './shared/log.js';
import { createAvatarPicker } from './avatar-picker.js';
import { errorStateEl, skeletonHTML, emptyStateHTML, errorStateHTML, ensureStateKitStyles, attachRetry } from './shared/state-kit.js';
import { startOnboarding, ensurePermission, needsMotionGesture, setPermissionState } from './irl/onboarding.js';
import { reserveWebGLContext, releaseWebGLContext } from './webgl-budget.js';
import { detectTier, BUDGETS, TIER_ORDER, shiftTier } from './irl/perf-budget.js';
import { sharedGLTFLoader, createLoadQueue } from './irl/load-queue.js';
import { mountPinIdle, getIdleClipJson } from './irl/pin-idle.js';
import { createWealthAura3D } from './shared/wealth-aura-3d.js';
import { fetchWealthState } from './shared/agent-wealth-state.js';
import { trackLevelUp, installLevelUpCelebrations } from './shared/wealth-levelup.js';
import { roomOriginWorld, agentWorldPosition, localToGeo, calibrateRoomOrigin } from './irl/room-anchor.js';
import { anchorPoseToPin, yawDegFromQuat, roomPlacementFromHit, roomRelFromGeo } from './irl/floor-anchor.js';
import { initRoomMode } from './irl/room-mode.js';
import { initMarkerMode } from './irl/marker-mode.js';
import { isMarkerRoomId, markerWorldPos, markerRelFromWorld, markerYawFromEdge, markerRoomBlock } from './irl/marker-anchor.js';
import { markerPoseCamera } from './irl/marker-pose.js';
import { cornerCenter, cornerRightMid } from './irl/qr-detect.js';
import { createRoomGhost } from './irl/room-ghost.js';
import { isFiniteReading, isCompassFresh, shouldUseAbsoluteYaw, resolveLockYaw, clampPitch, screenPitchDeg } from './irl/sensor-fusion.js';
import { deriveVerticalFovDeg, DEFAULT_DIAG_FOV_DEG } from './irl/camera-fov.js';
import { pinBandAction } from './irl/proximity-band.js';
import { gpsAccuracyBucket, easeGpsTransition, GPS_TRANSITION_MS } from './irl/gps-lifecycle.js';
import { pickLabelHit } from './irl/tap-pick.js';
import {
	shouldCueArrival,
	relativeBearing,
	isFacingAgent,
	edgeNudgePlacement,
	nearestAgent,
} from './irl/proximity-cue.js';
import { loadInto } from './shared/async-state.js';
import { openMapPlacePicker } from './irl/map-place.js';
import { openPrivacyCenter, maybeShowFirstRunDisclosure, getDiscoveryPrecision } from './irl/privacy-center.js';
import { GlassesBridge } from './irl/glasses/bridge.js';
import { openGlassesConnect } from './irl/glasses/connect-ui.js';
import { loadLeaflet } from './shared/leaflet-loader.js';
import { initDiscovery } from './irl/discovery.js';
import { initIrlDrops } from './shared/irl-drops.js';
import { walletChipEl, hasWallet } from './shared/agent-wallet-chip.js';
import { buildSolanaPayUri } from './shared/solana-pay.js';
import { renderQRToSVG } from './erc8004/qr.js';

const AVATAR_URL_DEFAULT = '/avatars/default.glb';
const ANIMATIONS_MANIFEST_URL = '/animations/manifest.json';
const CLIP_IDLE = 'idle';
const CLIP_WALK = 'av-walk-feminine';
const CLIP_RUN  = 'av-walk-feminine';

const WALK_SPEED         = 1.6;
const RUN_SPEED          = 4.0;
const NATURAL_WALK_SPEED = 1.5;
const NATURAL_RUN_SPEED  = 3.4;
const TURN_LERP          = 0.18;
const CAM_LERP           = 0.12;
const LEAN_WALK_RAD      = 0.05;
const LEAN_RUN_RAD       = 0.13;
const LEAN_LERP          = 0.12;
const GROUND_RADIUS      = 16;
const CAM_OFFSET         = new Vector3(0, 1.85, 3.6);
const CAM_LOOK_OFFSET    = new Vector3(0, 1.1, 0);
const SPAWN_DURATION     = 0.38; // seconds for placed object scale-up
const TAP_THRESHOLD      = 10;   // px — beyond this it's a drag, not a tap
// ── Camera-aware agents ──────────────────────────────────────────────────
// Loaded nearby agents notice the viewer: they yaw their body toward the phone
// camera, lead with a head turn inside a natural neck cone, idle-drift when
// nobody's close, and perk up once when you first walk into range.
const AWARE_RADIUS_M    = 12;    // viewer must be this close (m) to engage tracking
const NOTICE_RADIUS_M   = 4;     // crossing this (m) fires the one-shot "notice"
const AWARE_MAX_AGENTS  = 5;     // only the nearest N get full per-frame head tracking
const HEAD_CLAMP        = 0.7;   // max neck yaw/pitch from rest (rad) — natural cone
const BODY_SLERP        = 0.05;  // eased body yaw toward the camera
const BODY_RETURN_SLERP = 0.03;  // eased body yaw back to the placed heading
const HEAD_SLERP        = 0.12;  // eased head toward its gaze target
const HEAD_SLERP_NOTICE = 0.40;  // boosted head slerp during a notice reaction
const NOTICE_BOOST_SEC  = 0.40;  // seconds the head-slerp boost lasts after a notice
const POP_DURATION      = 0.45;  // seconds for the perk-up scale pop
const POP_AMOUNT        = 0.04;  // peak +Y scale during the pop (1.0 → 1.04 → 1.0)

// ── URL params ────────────────────────────────────────────────────────────
const params = new URLSearchParams(location.search);
const avatarIdParam  = params.get('avatar')    || '';
const highlightPinId = params.get('highlight') || '';
// Deep-focus a specific agent's pin (from an agent profile's "View in IRL" link):
// once that agent's pin loads nearby, flash it and open its inspect card. Fires
// once so it doesn't re-open the sheet on every nearby refresh.
const agentFocusId   = params.get('agent')     || '';
let _agentFocusDone  = false;

function resolveAvatarUrl(id) {
	if (!id) return AVATAR_URL_DEFAULT;
	if (/^https?:\/\//i.test(id) || id.startsWith('/')) return id;
	return `/api/avatars/${encodeURIComponent(id)}/glb`;
}

// ── DOM refs ──────────────────────────────────────────────────────────────
const $  = (id) => document.getElementById(id);
// Pre-allocated vectors used in tick() camera-awareness detection (avoids GC churn)
const _camWorldDir = new Vector3();
const _camDirH     = new Vector3();
const _toAgentH    = new Vector3();

const canvas      = $('irl-canvas');
const videoEl     = $('irl-camera');
const joystickEl  = $('irl-joystick');
const nameEl      = $('irl-avatar-name');
const subtitleEl  = $('irl-subtitle');
// First-run guidance: the subtitle is the always-visible signpost to the next
// concrete step in the core loop (turn on Camera AR → aim → Pin here). It tracks
// three states so a brand-new user is never left guessing what to tap next.
const SUBTITLE = {
	cameraOff: 'Turn on Camera AR, then tap Pin here to anchor your agent in real space.',
	aiming:    'Tap Move here to set your agent on the floor, then Pin here to anchor it.',
	placing:   'Aim the ring at the floor and tap to set your agent down — then Pin here.',
	pinned:    'Your agent is anchored here. Tap Pin here again to release it.',
};
function setSubtitle(text) { if (subtitleEl) subtitleEl.textContent = text; }
const statusEl    = $('irl-status');
const statusTxt   = $('irl-status-text');
const spinner     = $('irl-spinner');
const cameraBtn      = $('irl-camera-btn');
const cameraLabel    = $('irl-camera-label');
const placeBtn       = $('irl-place-btn');
const clearBtn       = $('irl-clear-btn');
const pickerEl       = $('irl-picker');
const avatarBtn      = $('irl-avatar-btn');
const lockBtn        = $('irl-lock-btn');
const carryBtn       = $('irl-carry-btn');      // "Move here" — carry the agent and set it on the floor
const anchorBtn      = $('irl-anchor-btn');     // WebXR "Place on floor" — revealed only when supported
const xrOverlay      = $('irl-xr-overlay');     // WebXR dom-overlay root (in-session hint + exit + error)
const xrBarEl        = $('irl-xr-bar');         // hint+exit pill; .is-anchored reveals the ✓ confirm
const xrHintEl       = $('irl-xr-hint');
const xrExitBtn      = $('irl-xr-exit');

// ── Status helpers ────────────────────────────────────────────────────────
function setStatus(msg, { error = false, warn = false, loading = false, sticky = false } = {}) {
	clearTimeout(setStatus._t);
	if (!msg) { statusEl.classList.add('is-hidden'); return; }
	statusTxt.textContent = msg;
	statusEl.classList.remove('is-hidden');
	statusEl.classList.toggle('is-error', error);
	statusEl.classList.toggle('is-warn', warn && !error);
	spinner.classList.toggle('hidden', !loading);
	if (!sticky) setStatus._t = setTimeout(() => statusEl.classList.add('is-hidden'), 3000);
}

// ── Renderer / scene ──────────────────────────────────────────────────────
const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.setClearColor(0x000000, 0);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = PCFSoftShadowMap;
// Filmic tone mapping is what separates "sticker pasted on the camera feed"
// from "object standing in the room" — highlight rolloff + midtone contrast,
// the same treatment Quick Look applies to a USDZ. Exposure compensates for
// ACES's overall darkening at these light levels.
renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;

const scene = new Scene();
const pmrem = new PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

// Keyed like a studio portrait, not a flood: the IBL carries the specular/rim
// detail, the sun carries shape + shadow. The old 0.55 ambient + 0.6 hemi fill
// flattened every model into a cardboard cutout.
const ambientLight = new AmbientLight(0xffffff, 0.3);
scene.add(ambientLight);
const hemi = new HemisphereLight(0xbcd6ff, 0x202830, 0.45);
hemi.position.set(0, 5, 0);
scene.add(hemi);
const sun = new DirectionalLight(0xffffff, 1.55);
sun.position.set(4, 8, 6);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.camera.near = 0.5;
sun.shadow.camera.far = 32;
sun.shadow.camera.left = -12;
sun.shadow.camera.right = 12;
sun.shadow.camera.top = 12;
sun.shadow.camera.bottom = -12;
sun.shadow.bias = -0.0005;
scene.add(sun);

// ── Performance tier + render budget (E2) ───────────────────────────────────
// IRL owns ONE long-lived WebGL context shared by every pin (all pins live in
// this single scene). Reserve it against the page-wide budget so the homepage's
// other renderers stay under the browser's ~16-context cap; never spawn a
// per-pin context. Released on pagehide.
reserveWebGLContext();
window.addEventListener('pagehide', releaseWebGLContext, { once: true });

// Pick a device class from REAL signals (cores, memory, DPR, mobile UA, GPU
// capabilities) and hold its budget. `baseTier` is the hardware ceiling: the
// runtime watchdog may degrade below it under load and recover back up to it,
// but never above what the device can actually carry.
let activeTier = detectTier(renderer);
const baseTier = activeTier;
let budget = BUDGETS[activeTier];

// One shared GLTFLoader (Draco + meshopt) behind a nearest-first, concurrency
// capped queue — replaces the old `new GLTFLoader()` per pin + `loadedCount < 5`
// guard. Priority is the pin's live camera distance (set in enforceLOD).
const glbQueue = createLoadQueue({
	run: (pin) => sharedGLTFLoader().loadAsync(pin.avatar_url),
	maxActive: budget.maxGLB,
	priorityOf: (pin) => (pin._lodDist != null ? pin._lodDist : (pin.distance_m != null ? pin.distance_m : 1e9)),
});

// Warm the shared idle clip while the first GLBs are still downloading, so a
// freshly mounted pin can start breathing on its very first frame.
getIdleClipJson();

// Anisotropic filtering on every model texture — cloth/skin detail stays sharp
// at the oblique angles an avatar standing on the real floor is actually seen
// from. Capped at 8: past that the visual gain is nil and the bandwidth isn't.
const _maxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy() || 1);
const _ANISO_SLOTS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap'];
function sharpenModelTextures(root) {
	root.traverse((n) => {
		if (!n.isMesh) return;
		const mats = Array.isArray(n.material) ? n.material : [n.material];
		for (const m of mats) {
			if (!m) continue;
			for (const slot of _ANISO_SLOTS) {
				const tex = m[slot];
				if (tex && tex.anisotropy < _maxAniso) {
					tex.anisotropy = _maxAniso;
					tex.needsUpdate = true;
				}
			}
		}
	});
}

// Apply the active tier to the renderer + load queue. Called at boot and each
// time the watchdog steps the tier. Idempotent.
function applyTierToRenderer() {
	renderer.setPixelRatio(Math.min(window.devicePixelRatio, budget.pixelRatio));
	renderer.setSize(window.innerWidth, window.innerHeight, false);
	const wantShadow = budget.shadow > 0;
	renderer.shadowMap.enabled = wantShadow;
	sun.castShadow = wantShadow;
	if (wantShadow && sun.shadow.mapSize.x !== budget.shadow) {
		sun.shadow.mapSize.set(budget.shadow, budget.shadow);
		// Force the shadow map to regenerate at the new resolution.
		if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
	}
	glbQueue.setMaxActive(budget.maxGLB);
}
applyTierToRenderer();

// ── Ground ────────────────────────────────────────────────────────────────
const groundOpaque = new Mesh(
	new CircleGeometry(GROUND_RADIUS, 64),
	new MeshStandardMaterial({ color: 0x121820, roughness: 0.95, metalness: 0.0 }),
);
groundOpaque.rotation.x = -Math.PI / 2;
groundOpaque.receiveShadow = true;
scene.add(groundOpaque);

const groundShadow = new Mesh(
	new CircleGeometry(GROUND_RADIUS, 64),
	new ShadowMaterial({ opacity: 0.5 }),
);
groundShadow.rotation.x = -Math.PI / 2;
groundShadow.receiveShadow = true;
groundShadow.visible = false;
scene.add(groundShadow);

// Invisible plane at y=0 for raycasting tap-to-place targets
const rayPlane = new Mesh(
	new PlaneGeometry(60, 60),
	new MeshStandardMaterial({ visible: false, side: 2 }),
);
rayPlane.rotation.x = -Math.PI / 2;
rayPlane.position.y = 0.005;
scene.add(rayPlane);

// Carry-and-place reticle — a soft teal ground ring that tracks where the screen
// centre meets the floor while "Move here" is armed, so you can aim a real spot in
// the room and set your agent down there (the gesture the fixed camera-offset never
// allowed). Hidden until carry mode reveals it; pulses on a successful drop.
const carryReticle = new Group();
{
	const ring = new Mesh(
		new TorusGeometry(0.28, 0.022, 10, 44),
		new MeshBasicMaterial({ color: 0x34d399, transparent: true, opacity: 0.9, depthTest: false }),
	);
	ring.rotation.x = -Math.PI / 2;
	ring.renderOrder = 10;
	const dot = new Mesh(
		new CircleGeometry(0.05, 24),
		new MeshBasicMaterial({ color: 0x34d399, transparent: true, opacity: 0.55, depthTest: false }),
	);
	dot.rotation.x = -Math.PI / 2;
	dot.renderOrder = 10;
	carryReticle.add(ring, dot);
}
carryReticle.position.y = 0.012;
carryReticle.visible = false;
scene.add(carryReticle);

// ── Camera ────────────────────────────────────────────────────────────────
// near = 0.02 m: held one-handed, a virtual agent brought close to inspect can put
// its near face inside the clip cone and vanish (and so dodge the inspect tap). 2 cm
// keeps it visible without the depth-fighting a 1 cm near would risk against the
// coplanar ground/shadow planes at the 0.02→200 ratio. Raycasting itself is
// near-independent (Raycaster.near defaults to 0), so this is purely a render fix.
const camera = new PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.02, 200);
const avatarRig = new Group();
scene.add(avatarRig);

const camDesired     = new Vector3();
const camLookTarget  = new Vector3();
const camLookCurrent = new Vector3();
const lockForward    = new Vector3(); // scratch — derives lock yaw/pitch at pin time
let cameraYaw   = 0;
let cameraPitch = 0.05;
const PITCH_MIN = -0.5;
const PITCH_MAX = 0.65;

function applyCameraImmediate() {
	const offset = CAM_OFFSET.clone();
	offset.applyAxisAngle(new Vector3(1, 0, 0), -cameraPitch);
	offset.applyAxisAngle(new Vector3(0, 1, 0), cameraYaw);
	camDesired.copy(avatarRig.position).add(offset);
	camera.position.copy(camDesired);
	camLookTarget.copy(avatarRig.position).add(CAM_LOOK_OFFSET);
	camLookCurrent.copy(camLookTarget);
	camera.lookAt(camLookCurrent);
}
applyCameraImmediate();

// ── AR passthrough ────────────────────────────────────────────────────────
let arActive        = false;
let mediaStream     = null;
// Single mutex over camera + render-loop ownership. getUserMedia camera-AR and the
// WebXR immersive session both want the rear camera and the RAF; a fast tap during
// the async handoff (disableAR → session start, or session end → enableAR) could
// double-acquire the camera (black screen / dangling track). This blocks every
// entry point — enableAR(), enterFloorAnchor(), the Camera button — until the prior
// acquire/release fully settles. Always cleared in a finally so a failure can't
// wedge the toggle permanently.
let _arTransitioning = false;
let arFrozenCamPos  = null;
let arFrozenCamLook = null;
// Pivot for the local (no-GPS) gyro world-lock: once set, the camera holds this
// fixed point and only rotates with the phone, so a pinned avatar stays anchored
// in the room and is only visible when the camera points at it. null = inactive.
let gyroLockCamPos  = null;
// Last rear-camera sensor dimensions (from the video track) — captured when AR
// starts and refreshed on viewport change so the FOV can be re-derived against the
// current viewport aspect rather than frozen at the orientation AR opened in.
let arTrackW = 0;
let arTrackH = 0;

// Re-derive and apply the camera vertical FOV from the live video track + current
// viewport. Safe to call any time: a no-op (just the projection-matrix refresh)
// when AR is off / no track, so the resize path can call it unconditionally.
function applyCameraFov() {
	const track = mediaStream?.getVideoTracks?.()[0];
	if (track) {
		const s = track.getSettings?.() ?? {};
		if (Number.isFinite(s.width)  && s.width  > 0) arTrackW = s.width;
		if (Number.isFinite(s.height) && s.height > 0) arTrackH = s.height;
	}
	if (!arActive || !(arTrackW > 0) || !(arTrackH > 0)) return;
	camera.fov = deriveVerticalFovDeg({
		trackWidth: arTrackW,
		trackHeight: arTrackH,
		viewWidth: window.innerWidth,
		viewHeight: window.innerHeight,
		diagFovDeg: DEFAULT_DIAG_FOV_DEG,
	});
	camera.updateProjectionMatrix();
}

async function enableAR() {
	// Refuse while a camera/XR handoff is still settling, while AR is already on, and
	// while the immersive XR session owns the camera — acquiring getUserMedia in any
	// of those states collides on the rear camera. The XR dom-overlay is
	// pointer-events:none, so a tap can fall through to the Camera button mid-session;
	// xrSession is a real guard case, not a theoretical one. The guard is always
	// released in a finally so a permission denial or a getUserMedia error can't wedge
	// the toggle.
	if (_arTransitioning || arActive || xrSession) return;
	_arTransitioning = true;
	try {
		await _enableARBody();
	} finally {
		_arTransitioning = false;
	}
}

async function _enableARBody() {
	if (!navigator.mediaDevices?.getUserMedia) {
		// Designed state via the shared guidance sheet, not a toast — the 3D scene
		// still works without the camera, so say so instead of just "unavailable".
		setPermissionState('camera', 'unsupported');
		showErrorState({
			title: 'Camera not available here',
			body: 'This browser can’t open the camera, so AR passthrough is off. The 3D scene still works — or reopen IRL in Chrome or Safari.',
		});
		return;
	}
	// Permission routes through the onboarding module (E1): a denial lands on the
	// designed card + topbar re-request chip. The granted fast-path resolves
	// immediately so AR proceeds within the same user gesture.
	const camPerm = await ensurePermission('camera');
	if (camPerm !== 'granted') return;
	setStatus('Requesting camera…', { loading: true, sticky: true });
	try {
		mediaStream = await navigator.mediaDevices.getUserMedia({
			video: { facingMode: { ideal: 'environment' } },
			audio: false,
		});
	} catch (err) {
		// Clear the "Requesting camera…" progress toast, then surface a recoverable
		// card (the full onboarding copy is E1's; this is the reactive recovery).
		setStatus(null);
		if (err?.name === 'NotAllowedError') {
			setPermissionState('camera', 'denied');
			showErrorState({
				title: 'Camera access needed for AR',
				body: 'Allow camera access in your browser settings, then tap Try again to drop your agent into the real world.',
				actionLabel: 'Try again',
				onAction: enableAR,
			});
		} else {
			showErrorState({
				title: 'Couldn’t start the camera',
				body: `The camera didn’t start (${err?.message ?? err}). Close any other app using it, then tap Try again.`,
				actionLabel: 'Try again',
				onAction: enableAR,
			});
		}
		return;
	}

	videoEl.srcObject = mediaStream;

	// Reveal the AR state BEFORE play(). A display:none <video> can leave
	// play()'s promise unsettled in some browsers (notably iOS Safari), which
	// would otherwise hang camera activation forever. Make it visible first,
	// then start playback without blocking on the promise.
	arActive = true;
	document.body.classList.add('is-ar');
	cameraBtn.classList.add('is-active');
	cameraBtn.setAttribute('aria-pressed', 'true');
	cameraLabel.textContent = 'Camera On';
	setSubtitle(SUBTITLE.aiming);
	groundOpaque.visible = false;
	groundShadow.visible = true;
	renderer.setClearColor(0x000000, 0);
	scene.background = null;

	videoEl.play().catch(() => {/* autoplay policies — frames still arrive via the stream */});

	// Match Three.js FOV to device rear camera so the avatar's scale agrees with
	// real-world objects. The sensor dimensions are captured so the resize /
	// orientation path can re-derive the FOV when the viewport rotates — the
	// derivation is no longer a one-shot frozen at portrait (task-02).
	applyCameraFov();

	// Freeze camera so the avatar walks through the real room instead of the
	// follow-camera chasing it (which would shift the real-world background).
	arFrozenCamPos  = camera.position.clone();
	arFrozenCamLook = camLookCurrent.clone();

	setStatus('Camera on — aim at a spot, then tap Pin here');
}

function disableAR() {
	if (mediaStream) {
		mediaStream.getTracks().forEach(t => { try { t.stop(); } catch {} });
		mediaStream = null;
	}
	videoEl.srcObject = null;
	arActive = false;
	document.body.classList.remove('is-ar');
	cameraBtn.classList.remove('is-active');
	cameraBtn.setAttribute('aria-pressed', 'false');
	cameraLabel.textContent = 'Camera AR';
	setSubtitle(SUBTITLE.cameraOff);
	groundOpaque.visible = true;
	groundShadow.visible = false;
	camera.fov = 50;
	camera.updateProjectionMatrix();
	ambientLight.intensity = 0.55;
	sun.intensity = 1.4;
	arFrozenCamPos  = null;
	arFrozenCamLook = null;
	gyroLockCamPos  = null;
	if (carryModeActive) setCarryMode(false); // carry only makes sense with the camera on
	_carryActive = false;
	arTrackW = 0;
	arTrackH = 0;
	setStatus('Camera off');
}

cameraBtn.addEventListener('click', () => {
	// Unlock the arrival-cue chime inside this real gesture (same tap that grants
	// camera + motion), so it can play later without an autoplay-policy warning.
	unlockArrivalAudio();
	// Ignore taps mid-handoff: enableAR/disableAR own the rear camera and the RAF, so
	// a tap landing between release and re-acquire would collide; and the XR session
	// owns the camera while it runs. enableAR() re-checks the guard too — this just
	// keeps the toggle from flipping state under a double-tap.
	if (_arTransitioning || xrSession) return;
	if (arActive) disableAR();
	else enableAR();
});

// Disable hero button if camera API is absent
if (!navigator.mediaDevices?.getUserMedia) {
	cameraBtn.disabled = true;
	cameraBtn.setAttribute('aria-disabled', 'true');
	cameraLabel.textContent = 'Camera unavailable';
}

// ── Placed objects ────────────────────────────────────────────────────────
let placeModeActive = false;
let selectedType    = 'orb';
// Carry-and-place: while armed, a floor tap sets the agent down at that world
// point and it eases there (no teleport). _carryTarget/_carryActive drive the glide
// in tick(); the gyro world-lock then holds the agent at the chosen spot.
let carryModeActive = false;
let _carryActive    = false;
const _carryTarget  = new Vector3();
const placedObjects = []; // { mesh, spawnT, type }

// ── Session persistence (localStorage) ───────────────────────────────────
const SESSION_KEY = 'irl_session_v1';

// Snapshot the persisted session ONCE at module load. loadAvatar() runs
// _saveSession() against the empty boot scene before _restoreSession() gets to
// read it, so reading localStorage live inside restore would see that wiped
// state. Capture the real saved session here instead.
const _savedSession = (() => {
	try {
		const raw = localStorage.getItem(SESSION_KEY);
		return raw ? JSON.parse(raw) : null;
	} catch { return null; }
})();

function _saveSession() {
	try {
		localStorage.setItem(SESSION_KEY, JSON.stringify({
			avatarId: _currentAvatarId,
			locked:   avatarLocked,
			placedObjects: placedObjects.map(o => ({
				type: o.type,
				x:    o.mesh.position.x,
				z:    o.mesh.position.z,
			})),
		}));
	} catch {}
}

function _restoreSession() {
	const s = _savedSession;
	if (!s) return;
	try {
		// Objects first, then lock — so setLocked()'s own save (and the explicit
		// one below) capture the fully restored scene rather than an empty one.
		for (const o of (s.placedObjects ?? [])) {
			const def = OBJ_DEFS[o.type];
			if (!def) continue;
			const mesh = def.create();
			mesh.position.x = Number(o.x) || 0;
			mesh.position.z = Number(o.z) || 0;
			mesh.scale.setScalar(1); // skip spawn animation on restore
			scene.add(mesh);
			placedObjects.push({ mesh, spawnT: SPAWN_DURATION, type: o.type });
		}
		if (placedObjects.length) clearBtn.hidden = false;
		if (s.locked) setLocked(true);
		// loadAvatar() persisted the empty boot scene before we got here; write
		// the restored state back so it survives a refresh with no further edits.
		_saveSession();
	} catch {}
}

const OBJ_DEFS = {
	orb: {
		create() {
			const m = new Mesh(
				new SphereGeometry(0.22, 32, 24),
				new MeshPhysicalMaterial({
					color: 0x88bbff,
					emissive: 0x1a44aa,
					emissiveIntensity: 0.55,
					metalness: 0.15,
					roughness: 0.04,
					transmission: 0.45,
					thickness: 0.3,
				}),
			);
			m.castShadow = true;
			m.position.y = 0.22;
			return m;
		},
	},
	crate: {
		create() {
			const m = new Mesh(
				new BoxGeometry(0.4, 0.4, 0.4),
				new MeshStandardMaterial({ color: 0xb07830, roughness: 0.85, metalness: 0.0 }),
			);
			m.castShadow = true;
			m.position.y = 0.2;
			return m;
		},
	},
	crystal: {
		create() {
			const m = new Mesh(
				new OctahedronGeometry(0.28, 0),
				new MeshPhysicalMaterial({
					color: 0xcc77ff,
					emissive: 0x440066,
					emissiveIntensity: 0.5,
					metalness: 0.0,
					roughness: 0.0,
					transmission: 0.65,
					thickness: 0.4,
				}),
			);
			m.castShadow = true;
			m.position.y = 0.28;
			return m;
		},
	},
	ring: {
		create() {
			const m = new Mesh(
				new TorusGeometry(0.22, 0.065, 16, 48),
				new MeshStandardMaterial({ color: 0xffd700, metalness: 0.95, roughness: 0.08 }),
			);
			m.castShadow = true;
			m.rotation.x = Math.PI / 2;
			m.position.y = 0.065;
			return m;
		},
	},
	pillar: {
		create() {
			const m = new Mesh(
				new CylinderGeometry(0.1, 0.12, 0.9, 12),
				new MeshStandardMaterial({ color: 0xd8d0c4, roughness: 0.72, metalness: 0.0 }),
			);
			m.castShadow = true;
			m.position.y = 0.45;
			return m;
		},
	},
};

// Object picker wiring
document.querySelectorAll('.irl-obj-btn').forEach(btn => {
	btn.addEventListener('click', () => {
		selectedType = btn.dataset.type;
		document.querySelectorAll('.irl-obj-btn').forEach(b => b.classList.remove('active'));
		btn.classList.add('active');
	});
});
document.querySelector('.irl-obj-btn[data-type="orb"]')?.classList.add('active');

placeBtn.addEventListener('click', () => {
	placeModeActive = !placeModeActive;
	if (placeModeActive) setCarryMode(false); // the two floor-tap modes are exclusive
	placeBtn.setAttribute('aria-pressed', String(placeModeActive));
	placeBtn.classList.toggle('is-active', placeModeActive);
	pickerEl.hidden = !placeModeActive;
	if (placeModeActive) {
		canvas.style.cursor = 'crosshair';
		setStatus('Tap the floor to drop an object');
	} else {
		canvas.style.cursor = '';
		setStatus(null);
	}
});

// ── Carry-and-place ("Move here") ─────────────────────────────────────────────
// Arm a floor-aim reticle; a tap sets the agent down at that real-world spot. This
// is what makes "carry my agent across the room and put it on the couch" possible —
// before this the agent was frozen 3.6 m in front of the camera (CAM_OFFSET).
function setCarryMode(on) {
	carryModeActive = on && arActive;
	carryBtn?.setAttribute('aria-pressed', String(carryModeActive));
	carryBtn?.classList.toggle('is-active', carryModeActive);
	canvas.style.cursor = carryModeActive ? 'crosshair' : '';
	if (carryModeActive) {
		if (placeModeActive) placeBtn.click(); // exclusive with the object-drop mode
		setSubtitle(SUBTITLE.placing);
		setStatus('Aim the ring at the floor, then tap to set your agent down');
	} else {
		carryReticle.visible = false;
		setSubtitle(avatarLocked ? SUBTITLE.pinned : SUBTITLE.aiming);
		if (!placeModeActive) setStatus(null);
	}
}

// Set the agent down at a chosen floor point and turn it to face the viewer, so a
// freshly placed agent looks at you rather than away. The glide + final snap run in
// tick() via _carryActive; the gyro world-lock holds the spot once you Pin here.
function placeAvatarAt(point) {
	_carryTarget.set(point.x, 0, point.z);
	_carryActive = true;
	const dx = camera.position.x - point.x, dz = camera.position.z - point.z;
	if (dx * dx + dz * dz > 1e-4) avatarYaw = Math.atan2(dx, dz);
	carryReticle.scale.setScalar(1.4); // confirm pulse — eased back to rest in tick()
	setStatus('Agent set down — tap Pin here to anchor it in the room');
	_saveSession();
}

if (carryBtn) {
	carryBtn.addEventListener('click', async () => {
		if (!arActive) {
			setStatus('Turn on Camera AR first, then move your agent into the room.', { warn: true });
			return;
		}
		// Arming carry requires the world-lock: only the locked/gyro camera tracks the
		// room as you pan, so the floor reticle lands on the real floor and the agent
		// stays put where you set it. Engage it first if you haven't pinned yet.
		if (!carryModeActive && !avatarLocked) await setLocked(true);
		setCarryMode(!carryModeActive);
	});
}

clearBtn.addEventListener('click', () => {
	for (const obj of placedObjects) scene.remove(obj.mesh);
	placedObjects.length = 0;
	clearBtn.hidden = true;
	setStatus('Objects cleared');
	_saveSession();
});

// ── Tap-to-place raycasting ───────────────────────────────────────────────
const raycaster  = new Raycaster();
const pointerNDC = new Vector2();
let tapDownX = 0, tapDownY = 0;

canvas.addEventListener('pointerdown', e => {
	// The WebXR floor-anchor session (and its failed-start error card) layers a modal
	// overlay over the canvas; don't arm a long-press behind it.
	if (xrOverlay && !xrOverlay.hidden) return;
	tapDownX = e.clientX; tapDownY = e.clientY; armLongPress(e);
});
canvas.addEventListener('pointerup', e => {
	cancelLongPress();
	// While the WebXR floor-anchor overlay is up, the immersive session owns taps —
	// its 'select' places the anchor — and on a failed start the error card is modal.
	// Either way the 2D pin/place raycast behind it must not also fire (dead taps,
	// stray sheets). The overlay is display:none whenever AR/gyro mode is active, so
	// this only gates during an actual XR session or its error state.
	if (xrOverlay && !xrOverlay.hidden) return;
	// While calibrating, taps belong to the nudge gesture — never re-open a sheet.
	if (calibrateActive) return;
	if (Math.hypot(e.clientX - tapDownX, e.clientY - tapDownY) > TAP_THRESHOLD) return;

	pointerNDC.set(
		(e.clientX  / window.innerWidth)  * 2 - 1,
		-(e.clientY / window.innerHeight) * 2 + 1,
	);
	raycaster.setFromCamera(pointerNDC, camera);

	if (carryModeActive) {
		// ── Carry mode: set the agent down on the floor where you tapped ──
		const hits = raycaster.intersectObject(rayPlane);
		if (!hits.length) return;
		placeAvatarAt(hits[0].point);
		return;
	}

	if (placeModeActive) {
		// ── Place mode: drop an object on the ground ─────────────────────
		const hits = raycaster.intersectObject(rayPlane);
		if (!hits.length) return;
		const def = OBJ_DEFS[selectedType];
		if (!def) return;
		const mesh = def.create();
		mesh.position.x = hits[0].point.x;
		mesh.position.z = hits[0].point.z;
		mesh.scale.setScalar(0.001);
		scene.add(mesh);
		placedObjects.push({ mesh, spawnT: 0, type: selectedType });
		clearBtn.hidden = false;
		_saveSession();
	} else {
		// ── Tap on a nearby agent: mesh body first, 2D label net as fallback ──
		// Mesh ray: the nearest intersection is closest to the camera, so two
		// agents projecting to the same pixel resolve to the FRONT body for free.
		let pin = null;
		const agentGroups = nearbyPins.map(p => p.group).filter(Boolean);
		if (agentGroups.length) {
			const hits = raycaster.intersectObjects(agentGroups, true);
			if (hits.length) pin = _pinForObject(hits[0].object);
		}
		// Label net: a finger-sized slop around each on-screen name label catches
		// taps that miss the (often small or distant) body — the floor for tap
		// reliability on a phone. Front agent wins a cluster tie (see helper).
		if (!pin) pin = _nearestLabelWithinSlop(e.clientX, e.clientY);
		if (pin) openPinSheet(pin);
		// A clean tap on empty space hits no agent — the canonical immersive
		// gesture: toggle the chrome so you can clear the view (or bring it back)
		// without hunting for the eye button.
		else toggleImmersive();
	}
});

// Nearest on-screen name label within a finger-sized radius of the tap (B4).
// Uses the screen positions cached by updateLabels() each frame, so it costs a
// short loop with no projection. The ranking (clear pixel winner takes it; cluster
// ties resolve to the nearer/front agent) lives in the pure, unit-tested
// pickLabelHit helper — here we only adapt each pin into a candidate it understands.
function _nearestLabelWithinSlop(px, py) {
	const candidates = [];
	for (const pin of nearbyPins) {
		if (!pin._labelOnScreen) continue;
		candidates.push({ sx: pin._labelSx, sy: pin._labelSy, distance: pin.distance_m, pin });
	}
	return pickLabelHit(candidates, px, py)?.pin ?? null;
}

function _pinForObject(obj) {
	// Walk up to the agent group and read the pin cached on it (set in
	// spawnNearbyPin). O(depth) with no per-node array scan.
	let node = obj;
	while (node) {
		if (node.userData && node.userData.pin) return node.userData.pin;
		node = node.parent;
	}
	return null;
}

// ── Joystick ──────────────────────────────────────────────────────────────
const input = {
	joy:  { x: 0, y: 0, active: false },
	keys: { forward: 0, back: 0, left: 0, right: 0, run: false },
};

// nipplejs's .on() returns undefined (not chainable), so attach each listener
// on the stored manager — chaining would throw and abort the module's boot.
const joystick = nipplejs.create({
	zone: joystickEl, mode: 'static', position: { left: '50%', top: '50%' },
	size: 110, color: 'rgba(255,255,255,0.85)', restOpacity: 0.6,
});
joystick.on('move', evt => {
	const v = evt?.data?.vector;
	if (v) { input.joy.x = v.x; input.joy.y = v.y; input.joy.active = Math.hypot(v.x, v.y) > 0.05; }
});
joystick.on('end', () => { input.joy.x = 0; input.joy.y = 0; input.joy.active = false; });

// Don't drive the avatar while the keyboard belongs to something else: a text
// field (typing a caption / message) or an open modal sheet (its own focus trap
// owns Tab/Escape). Otherwise WASD/arrows would both type and walk.
function movementKeysCaptured() {
	const a = document.activeElement;
	if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)) return true;
	return !!document.querySelector('.is-open[aria-modal="true"]');
}

window.addEventListener('keydown', e => {
	if (movementKeysCaptured()) return;
	switch (e.code) {
		case 'KeyW': case 'ArrowUp':         input.keys.forward = 1; break;
		case 'KeyS': case 'ArrowDown':       input.keys.back    = 1; break;
		case 'KeyA': case 'ArrowLeft':       input.keys.left    = 1; break;
		case 'KeyD': case 'ArrowRight':      input.keys.right   = 1; break;
		case 'ShiftLeft': case 'ShiftRight': input.keys.run     = true; break;
	}
});
window.addEventListener('keyup', e => {
	switch (e.code) {
		case 'KeyW': case 'ArrowUp':         input.keys.forward = 0; break;
		case 'KeyS': case 'ArrowDown':       input.keys.back    = 0; break;
		case 'KeyA': case 'ArrowLeft':       input.keys.left    = 0; break;
		case 'KeyD': case 'ArrowRight':      input.keys.right   = 0; break;
		case 'ShiftLeft': case 'ShiftRight': input.keys.run     = false; break;
	}
});

// ── Drag-to-orbit (disabled in place mode so taps don't orbit) ───────────
{
	let dragging = false, lastX = 0, lastY = 0, downId = -1;
	canvas.addEventListener('pointerdown', e => {
		if (placeModeActive || calibrateActive) return;
		// Don't orbit the (paused, hidden) IRL camera behind the WebXR overlay.
		if (xrOverlay && !xrOverlay.hidden) return;
		const r = joystickEl.getBoundingClientRect();
		if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) return;
		dragging = true; downId = e.pointerId; lastX = e.clientX; lastY = e.clientY;
		canvas.setPointerCapture?.(e.pointerId);
	});
	const onMove = e => {
		// Calibration may engage mid-drag (long-press fires while still held) — yield
		// the pointer to the nudge gesture instead of orbiting the camera.
		if (calibrateActive) { dragging = false; return; }
		if (!dragging || e.pointerId !== downId) return;
		cameraYaw   -= (e.clientX - lastX) * 0.005;
		cameraPitch  = Math.max(PITCH_MIN, Math.min(PITCH_MAX, cameraPitch - (e.clientY - lastY) * 0.0035));
		lastX = e.clientX; lastY = e.clientY;
	};
	const onUp = e => {
		if (e.pointerId !== downId) return;
		dragging = false; downId = -1;
		try { canvas.releasePointerCapture?.(e.pointerId); } catch {}
	};
	canvas.addEventListener('pointermove', onMove);
	canvas.addEventListener('pointerup',     onUp);
	canvas.addEventListener('pointercancel', onUp);
}

// ── Avatar loading ────────────────────────────────────────────────────────
const animMgr = new AnimationManager();
let avatar = null, avatarYaw = 0, avatarLean = 0, currentMotion = 'idle';
let _currentAvatarId = null;
let _currentAgentId  = null;
// Embodied-finance: the carried avatar wears its real wallet — a GPU-cheap glow
// keyed to its live wealth tier/momentum, refreshed from the real custody flow.
let wealthAura = null;
let _stopWealthPoll = null;
// iOS AR Quick Look (capability 'quicklook'): the GLB actually loaded for the
// current avatar, the server-hosted USDZ companion (if the record carries one),
// and a lazily generated USDZ blob URL when it doesn't. The generated URL is
// cached by source GLB and revoked whenever the avatar changes so we never leak
// object URLs or hand Quick Look a stale model.
let _currentGlbUrl   = null;
let _currentUsdzUrl  = null;
let _usdzObjectUrl   = null;
let _usdzObjectUrlFor = null;

function _clearAvatar() {
	// Detach the mixer FIRST so it stops every action and uncaches the root's clips
	// before we free the model's GPU resources — otherwise an orphaned
	// AnimationAction would keep pointing at geometry we're about to dispose. detach()
	// is idempotent, so a failed (re)load that never re-attaches leaves the manager
	// clean (no nulled mixer holding stale clips) rather than half-torn-down.
	animMgr.detach();
	// Tear down the wealth aura + its live poll before the rig is reused.
	if (_stopWealthPoll) { try { _stopWealthPoll(); } catch {} _stopWealthPoll = null; }
	if (wealthAura) { try { wealthAura.dispose(); } catch {} wealthAura = null; }
	if (avatar) {
		avatarRig.remove(avatar);
		// Free the previous avatar's geometry/materials/textures. Without this every
		// hot-swap leaked a full skinned mesh's GPU memory — fatal over a long session.
		disposeObject3D(avatar);
		avatar = null;
	}
}

// Attach the embodied-finance glow to the carried avatar and start its live feed.
// Only an agent-bound avatar has a real wallet to read; an anonymous GLB stays
// un-glowed (honest — no wallet, no aura).
function mountWealthAura(height) {
	const agentId = _currentAgentId;
	if (!agentId) return;
	wealthAura = createWealthAura3D({ height });
	avatarRig.add(wealthAura.object);
	_stopWealthPoll = startWealthPoll(agentId);
}

// Poll the real custody-backed wealth state on a calm interval, push it into the
// 3D aura, and fire the one-shot pulse only when a genuinely NEW tip lands or a
// money stream opens (tracked across polls) — never on a bare timer.
function startWealthPoll(agentId) {
	let stopped = false, timer = 0, lastTipAt = null, lastStreaming = 0, lastLevel = null, primed = false;
	installLevelUpCelebrations();
	const run = async () => {
		if (stopped) return;
		try {
			const state = await fetchWealthState(agentId, { fresh: true });
			if (state.ok && wealthAura) {
				wealthAura.applyState(state);
				const tipAdvanced = state.lastTipAt && state.lastTipAt !== lastTipAt;
				const streamOpened = state.streamingNow > lastStreaming;
				if (primed && (tipAdvanced || streamOpened)) wealthAura.pulse();
				// A real tier crossing for the owner's own placed agent → level-up card.
				lastLevel = trackLevelUp(agentId, lastLevel, state);
				lastTipAt = state.lastTipAt;
				lastStreaming = state.streamingNow;
				primed = true;
			}
		} catch { /* transient — keep the last real glow, never invent a trend */ }
		if (!stopped) timer = setTimeout(run, 30_000);
	};
	run();
	return () => { stopped = true; if (timer) clearTimeout(timer); };
}

async function loadAvatar(idOrUrl, nameOverride) {
	// Resolve id/url — accepts: null (default), a UUID (look up), a direct URL
	const id  = idOrUrl !== undefined ? idOrUrl : avatarIdParam;
	// Track the active avatar for session persistence
	if (id && !/^https?:\/\//.test(id) && !id.startsWith('/')) _currentAvatarId = id;
	let avatarName = nameOverride || 'Your Avatar';
	let glbUrl     = resolveAvatarUrl(typeof idOrUrl === 'string' && /^https?:\/\/|^\//.test(idOrUrl) ? idOrUrl : id);

	// New avatar invalidates any USDZ we prepared for the previous one: forget the
	// server companion and revoke a generated blob URL so iOS Quick Look never
	// opens the wrong agent and we don't leak object URLs across avatar switches.
	_currentUsdzUrl = null;
	if (_usdzObjectUrl) { URL.revokeObjectURL(_usdzObjectUrl); _usdzObjectUrl = null; _usdzObjectUrlFor = null; }

	// Fetch metadata only when id is a DB UUID (not already a URL)
	_currentAgentId = null;
	if (id && !/^https?:\/\//.test(id) && !id.startsWith('/')) {
		try {
			const res = await fetch(`/api/avatars/${encodeURIComponent(id)}`);
			if (res.ok) {
				const { avatar: meta } = await res.json();
				if (meta?.name && !nameOverride) avatarName = meta.name;
				if (meta?.url)  glbUrl = meta.url;
				if (meta?.agent_id) _currentAgentId = meta.agent_id;
				// Server-hosted USDZ companion (presign-usdz pipeline) → iOS Quick Look
				// opens it directly, no client-side conversion needed.
				if (meta?.usdz_url) _currentUsdzUrl = meta.usdz_url;
			}
		} catch {}
	}
	// Remember the GLB we're actually loading so the iOS path can convert it to a
	// USDZ on demand when the record has no hosted companion.
	_currentGlbUrl = glbUrl;

	nameEl.textContent = avatarName;
	document.title     = `${avatarName} IRL · three.ws`;

	setStatus('Loading avatar…', { loading: true, sticky: true });

	_clearAvatar();

	// Reuse the one shared Draco+meshopt loader (the pin queue's loader) instead of
	// a fresh GLTFLoader per swap — the player's own avatar can be compressed too,
	// and a per-swap loader allocated decoders the shared one already holds.
	const gltf = await sharedGLTFLoader().loadAsync(glbUrl);
	avatar = gltf.scene;
	avatar.traverse(n => {
		if (n.isMesh) {
			n.castShadow = true;
			if (n.material?.envMapIntensity !== undefined) n.material.envMapIntensity = 0.85;
		}
	});
	sharpenModelTextures(avatar);
	const box = new Box3().setFromObject(avatar);
	avatar.position.y -= box.min.y;
	avatarRig.add(avatar);

	const height = Math.max(0.5, box.max.y - box.min.y);
	CAM_OFFSET.set(0, height * 1.05, height * 1.95);
	CAM_LOOK_OFFSET.set(0, height * 0.6, 0);
	applyCameraImmediate();

	// Embodied finance: glow the carried avatar by its real wallet wealth. Only an
	// agent-bound avatar has a wallet to read; an anonymous GLB stays un-glowed.
	mountWealthAura(height);

	animMgr.attach(avatar);
	const manifest = await fetch(ANIMATIONS_MANIFEST_URL, { cache: 'force-cache' }).then(r => {
		if (!r.ok) throw new Error(`HTTP ${r.status}`);
		return r.json();
	});
	const needed = manifest.filter(d => [CLIP_IDLE, CLIP_WALK, CLIP_RUN].includes(d.name));
	if (!needed.length) throw new Error('Animation manifest missing required clips');
	animMgr.setAnimationDefs(needed);
	await animMgr.loadAll();
	await animMgr.crossfadeTo(CLIP_IDLE, 0.0);
	currentMotion = 'idle';

	// Unlock the camera hero button now that the avatar is ready
	cameraBtn.disabled = false;
	cameraBtn.removeAttribute('aria-busy');
	setStatus(null);
	_saveSession();
}

// ── Avatar picker ─────────────────────────────────────────────────────────
const irlAvatarPicker = createAvatarPicker({
	onSelect: async ({ id, url, name }) => {
		_currentAvatarId = id;
		// Update URL so sharing reflects the choice
		const sp = new URLSearchParams(location.search);
		if (id) sp.set('avatar', id); else sp.delete('avatar');
		history.replaceState(null, '', location.pathname + (sp.toString() ? '?' + sp : ''));
		// Pass UUID id (not the CDN url) so loadAvatar fetches metadata
		// and captures agent_id for pin attribution (task-06). On failure show the
		// designed overlay with a Retry that re-loads this same selection.
		const retry = () => loadAvatar(id || url, name)
			.then(hideOverlay)
			.catch((err) => { log.error('[irl] avatar swap failed:', err); showAvatarLoadError(err, retry); });
		try {
			await loadAvatar(id || url, name);
			hideOverlay();
		} catch (err) {
			log.error('[irl] avatar swap failed:', err);
			showAvatarLoadError(err, retry);
		}
	},
});

if (avatarBtn) {
	avatarBtn.addEventListener('click', () => irlAvatarPicker.open(_currentAvatarId));
}

// ── Device orientation (gyro world-lock) ──────────────────────────────────
// When the avatar is locked in AR mode, device rotation drives the Three.js
// camera so the avatar appears pinned to a real-world location as the user
// physically rotates their phone — Pokémon GO style.
//
// Heading frame (A4). iOS Safari has no WebXR and never fires
// `deviceorientationabsolute`; its `alpha` is page-relative (arbitrary zero), so
// a delta-only yaw is consistent for THIS device but lands every placement at a
// different absolute bearing — breaking cross-user reconciliation (A3). iOS does
// expose a true magnetic-north bearing via `event.webkitCompassHeading`, so when
// it's present we drive yaw from it absolutely: the scene becomes north-aligned
// (−Z = north, matching gpsToWorld), the avatar holds its real-world bearing for
// every viewer, and the stored pose is a genuine compass heading. Page-relative
// devices keep the delta fallback and are tagged `:rel` for A3 down-weighting.
let lastDevAlpha = 0, lastDevBeta = 90, lastDevGamma = 0;
let devOrientBaseAlpha    = null; // null = inactive
let devOrientBaseBeta     = null;
let devOrientBaseCamYaw   = 0;
let devOrientBaseCamPitch = 0;
let prefersAbsOrientation = false;  // true once a north-referenced bearing is seen (source tagging)
let hasAbsoluteEventStream = false; // true if the dedicated deviceorientationabsolute event fires (Android)
let lastCompassHeading = null;      // iOS true compass bearing (deg, 0=N clockwise); null = none/uncalibrated
let lastCompassAt = 0;              // performance.now() of the last finite compass sample; 0 = never seen
let lockYawMode = 'relative';       // last frame's yaw path ('absolute'|'relative') for a seamless handoff

// iOS Safari's magnetic-north bearing. A negative webkitCompassAccuracy means the
// magnetometer isn't calibrated yet — treat that as no absolute reference rather
// than trusting a garbage heading. Returns null when no usable compass is present.
function readCompassHeading(e) {
	const h = e.webkitCompassHeading;
	if (typeof h !== 'number' || !Number.isFinite(h)) return null;
	const acc = e.webkitCompassAccuracy;
	if (typeof acc === 'number' && acc < 0) return null;
	return ((h % 360) + 360) % 360;
}

// THREE.js Y-rotation maps to a clockwise-from-north bearing as renderedBearing =
// (−cameraYaw); to point the rendered camera at compass bearing H we set
// cameraYaw = −H (verified against three's quaternion). Portrait AR assumed.
function compassToYaw(headingDeg) {
	return -headingDeg * (Math.PI / 180);
}

function onDeviceOrientation(e) {
	// Hold the last valid reading when a frame delivers null/undefined/NaN. The old
	// `?? 0` / `?? 90` only caught null/undefined and let NaN through into the delta
	// math (→ a NaN quaternion → the avatar vanishes); and substituting 0/90 yanks
	// the yaw to page-north and slams the pitch to the horizon. A held value simply
	// pauses the view for one bad frame until the sensor recovers.
	if (isFiniteReading(e.alpha, e.beta)) {
		lastDevAlpha = e.alpha;
		lastDevBeta  = e.beta;
		// gamma (left↔right tilt) only matters when the screen is landscape, where it
		// becomes the pitch axis. Hold the last value if a frame omits it.
		if (Number.isFinite(e.gamma)) lastDevGamma = e.gamma;
	}
	const a = lastDevAlpha;
	// Portrait-equivalent pitch: in landscape the user's look-up/down rides gamma,
	// not beta, so fold the screen angle in before the baseline-delta math (task-02).
	const b = screenPitchDeg(lastDevBeta, lastDevGamma, currentScreenAngle());
	const compass = readCompassHeading(e);
	if (compass !== null) {
		lastCompassHeading = compass;
		lastCompassAt = performance.now();
		prefersAbsOrientation = true;
	} else if (hasAbsoluteEventStream) {
		prefersAbsOrientation = true;
	}
	if (!avatarLocked || !arActive || devOrientBaseAlpha === null) return;

	// A stale compass (uncalibrated, or walked into a magnetic dead-zone) keeps its
	// last heading forever — detect that and fall back to the relative gyro path
	// instead of steering by a dead bearing.
	const compassFresh = isCompassFresh(lastCompassAt, performance.now());
	const useAbsolute = shouldUseAbsoluteYaw({ gpsModeActive, compassHeading: lastCompassHeading, compassFresh });

	// On an absolute→relative handoff (the compass just went stale), re-baseline the
	// relative integrator to the current pose so it continues from where the absolute
	// path left off rather than snapping back to the lock-time baseline.
	if (lockYawMode === 'absolute' && !useAbsolute) {
		devOrientBaseAlpha  = a;
		devOrientBaseCamYaw = cameraYaw;
	}

	// Absolute path: yaw eases toward the true bearing along the shortest arc (so a
	// 359°→1° turn is a ~2° move, never a spin) — only meaningful once a GPS pin
	// gives the scene an absolute origin. Relative path: integrate alpha deltas from
	// the lock baseline so the view rotates with the phone while the avatar holds the
	// exact spot it was pinned at.
	const nextYaw = resolveLockYaw({
		useAbsolute,
		prevYaw: cameraYaw,
		alpha: a,
		baseAlpha: devOrientBaseAlpha,
		baseYaw: devOrientBaseCamYaw,
		compassHeading: lastCompassHeading,
	});
	lockYawMode = useAbsolute ? 'absolute' : 'relative';

	const nextPitch = clampPitch(
		devOrientBaseCamPitch - (b - devOrientBaseBeta) * (Math.PI / 180),
		PITCH_MIN, PITCH_MAX);

	// Final backstop: never write a non-finite value to the camera. The helpers
	// guarantee this given finite inputs, but a corrupted baseline must never spin
	// or freeze the view — hold the prior frame instead.
	if (Number.isFinite(nextYaw))   cameraYaw   = nextYaw;
	if (Number.isFinite(nextPitch)) cameraPitch = nextPitch;
}

// Two orientation streams: Android's dedicated absolute event (north-referenced
// alpha) owns updates when present; iOS only fires the plain event, which is where
// webkitCompassHeading rides — so the relative listener gates on the *stream*
// existing, never on prefersAbsOrientation (which a compass reading now also sets,
// and which would otherwise silence iOS after the first event).
window.addEventListener('deviceorientationabsolute', e => {
	hasAbsoluteEventStream = true;
	onDeviceOrientation(e);
}, true);
window.addEventListener('deviceorientation', e => {
	if (hasAbsoluteEventStream) return;
	onDeviceOrientation(e);
}, true);

// iOS only starts firing orientation events once motion access is granted, and the
// compass rides those events — so a lock that anchors synchronously right after the
// grant would store a stale page-relative bearing. Wait briefly for the first
// compass sample so the persisted pose is the real heading. Resolves in a frame on
// iOS; resolves immediately on devices that don't expose a compass (no wait).
function waitForCompass(ms = 1200) {
	if (lastCompassHeading !== null || !needsMotionGesture()) return Promise.resolve();
	return new Promise((resolve) => {
		let done = false;
		const finish = () => {
			if (done) return;
			done = true;
			clearTimeout(to);
			window.removeEventListener('deviceorientation', onEvt, true);
			resolve();
		};
		const onEvt = () => { if (lastCompassHeading !== null) finish(); };
		const to = setTimeout(finish, ms);
		window.addEventListener('deviceorientation', onEvt, true);
	});
}

// ── Avatar lock ───────────────────────────────────────────────────────────
let avatarLocked = false;

async function setLocked(next) {
	// iOS 13+ requires a user-gesture permission for DeviceOrientationEvent.
	// A declined prompt rejects (or returns 'denied') — either way the gyro
	// world-lock can't work, so surface the designed recovery state instead of
	// silently locking a glued, sensor-less avatar.
	// Permissions for the world-lock route through the onboarding module (E1) so a
	// denial lands on a designed recovery card + topbar chip, not a dead toast.
	// Location (the real-world anchor) surfaces its prompt and starts the GPS watch
	// the instant it is granted; motion (look-around) is gesture-gated on iOS.
	let locGranted = false;
	if (next && arActive) {
		const locState = await ensurePermission('location');
		locGranted = locState === 'granted';
		if (locGranted) initGPS();
		if (needsMotionGesture()) {
			const motionState = await ensurePermission('motion');
			if (motionState !== 'granted') {
				if (lockBtn) {
					lockBtn.setAttribute('aria-pressed', 'false');
					lockBtn.classList.remove('is-active');
				}
				return;
			}
			// Let the first compass sample land before we capture the bearing, so the
			// stored pose is the real heading rather than a page-relative placeholder.
			await waitForCompass();
		}
	}
	avatarLocked = next;
	if (lockBtn) {
		lockBtn.setAttribute('aria-pressed', String(next));
		lockBtn.classList.toggle('is-active', next);
		lockBtn.querySelector('.irl-lock-label').textContent = next ? 'Pinned' : 'Pin here';
	}
	if (arActive) {
		if (next) {
			// Pin the camera pivot to its current spot. From here the camera only
			// *rotates* with the phone (gyro), so the avatar stays planted in the room
			// instead of orbiting with the view. Derive the lock yaw/pitch from where
			// the camera is actually looking right now so the lock is seamless (no
			// jump) wherever the avatar happens to sit on screen.
			gyroLockCamPos = camera.position.clone();
			// Read the camera's true facing (the frozen-AR branch points it with
			// lookAt, so camLookCurrent can be stale — getWorldDirection never is).
			const fwd = camera.getWorldDirection(lockForward);
			cameraYaw   = Math.atan2(fwd.x, -fwd.z);
			cameraPitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX,
				Math.asin(Math.max(-1, Math.min(1, -fwd.y)))));
			// Capture baseline orientation — gyro deltas from here drive the camera
			// on the page-relative fallback path. The pitch baseline is used by both
			// paths; the yaw baseline only by the delta fallback.
			devOrientBaseAlpha    = lastDevAlpha;
			// Same screen-corrected pitch source as the per-frame path, so the first
			// delta after locking is 0 regardless of how the device is held (task-02).
			devOrientBaseBeta     = screenPitchDeg(lastDevBeta, lastDevGamma, currentScreenAngle());
			devOrientBaseCamYaw   = cameraYaw;
			devOrientBaseCamPitch = cameraPitch;
			// iOS compass + a live GPS fix: snap the first locked frame to the true
			// bearing so the scene is north-aligned before the next orientation event.
			// A local-only lock (no GPS yet) stays on the seamless relative yaw above,
			// otherwise the avatar would snap off-frame to its absolute bearing.
			if (gpsState.ready && lastCompassHeading !== null) cameraYaw = compassToYaw(lastCompassHeading);
			arFrozenCamPos  = null;
			arFrozenCamLook = null;
			document.body.classList.add('is-locked');

			setSubtitle(SUBTITLE.pinned);

			// GPS: anchor the avatar to real-world coordinates. If the first fix
			// isn't in yet, defer the precise pin to it (onGPSPosition) rather than
			// dropping the agent at a default origin — locking still works locally.
			if (gpsState.ready) {
				anchorGpsPin();
			} else if (locGranted) {
				_pendingGpsLock = true;
				setStatus('Getting your location to place the pin — this is quicker outdoors with a clear view of the sky.', { loading: true, sticky: true });
			} else {
				// Location unavailable — lock the gyro view locally; no cross-user pin.
				setStatus('Your agent is pinned on this device. Turn on location to place it at this real-world spot for others.', { warn: true });
			}
		} else {
			setSubtitle(SUBTITLE.aiming);
			devOrientBaseAlpha = null;
			gyroLockCamPos  = null;
			_pendingGpsLock = false;
			_gpsCamTransition = null;
			lockYawMode     = 'relative';
			arFrozenCamPos  = camera.position.clone();
			arFrozenCamLook = camLookCurrent.clone();
			document.body.classList.remove('is-locked');
			document.body.classList.remove('gps-mode');

			// Remove the GPS pin
			if (gpsPin?.id) {
				fetch(`/api/irl/pins?id=${encodeURIComponent(gpsPin.id)}`, {
				method: 'DELETE',
				headers: deviceHeaders({ 'Content-Type': 'application/json' }),
				body: JSON.stringify({ deviceToken: _deviceToken }),
			}).catch(() => {});
			}
			gpsPin = null;
			gpsModeActive = false;
		}
	}
	// In AR the lock path owns its own status — the deferred-GPS "Waiting…",
	// the no-compass warning, and the final "Pinned facing …" from commitPin —
	// so don't clobber it here. Only the non-AR orbit lock and unlock fall through.
	if (!arActive) setStatus(next ? 'Agent pinned — drag to orbit' : 'Agent unpinned');
	else if (!next) setStatus('Agent unpinned');
	_saveSession();
}

if (lockBtn) {
	lockBtn.addEventListener('click', () => setLocked(!avatarLocked));
}

// ── Discovery onboarding + designed empty state (task 02) ───────────────────
// "Place an agent here" — the CTA on the empty-state prompt and the first-run
// explainer. Placing your own agent so others stumble on it IS the pin: bring up
// the camera if it's off, then drop the GPS-anchored pin. setLocked() owns the
// location/motion permission flow and the precise anchor, so this just sequences
// into it within the user's tap.
async function placeAgentHere() {
	unlockArrivalAudio();
	if (!arActive) await enableAR();
	if (arActive && !avatarLocked) setLocked(true);
}

const discovery = initDiscovery({ onPlace: placeAgentHere });

// ── Designed guidance sheet ───────────────────────────────────────────────
// iOS Safari has no WebXR, so the whole world-lock rides on motion + GPS
// permissions. When one is missing, a silent no-op leaves the user staring at
// a glued avatar with no idea why — so surface a recoverable state with the
// exact Settings path and a re-tap that re-requests the permission.
const errorSheet     = document.getElementById('irl-error-sheet');
const errorTitleEl   = document.getElementById('irl-error-title');
const errorBodyEl    = document.getElementById('irl-error-body');
const errorActionEl  = document.getElementById('irl-error-action');
const errorDismissEl = document.getElementById('irl-error-dismiss');
let _errorAction = null;

function showErrorState({ title, body, actionLabel, onAction }) {
	if (!errorSheet) { setStatus(title, { error: true, sticky: true }); return; }
	errorTitleEl.textContent = title;
	errorBodyEl.textContent  = body;
	_errorAction = onAction || null;
	if (onAction) {
		errorActionEl.textContent = actionLabel || 'Try again';
		errorActionEl.hidden = false;
	} else {
		errorActionEl.hidden = true;
	}
	errorSheet.classList.add('is-open');
	// Trap focus + Escape; land on the primary action when there is one, else the
	// dismiss control, so a keyboard user starts on the most useful target.
	trapSheet(errorSheet, hideErrorState, { initialFocus: onAction ? errorActionEl : errorDismissEl });
}

function hideErrorState() {
	if (errorSheet) errorSheet.classList.remove('is-open');
	releaseSheet(errorSheet);
	_errorAction = null;
}

if (errorActionEl) errorActionEl.addEventListener('click', () => {
	const fn = _errorAction;
	hideErrorState();
	if (fn) fn();
});
if (errorDismissEl) errorDismissEl.addEventListener('click', hideErrorState);

// ── Full-screen overlay state (E4) ─────────────────────────────────────────
// #irl-overlay is the canvas-level designed-state host (shared with the
// capability gate in irl.html). It carries states the user can't act on through
// a vanishing toast — chiefly a failed avatar load, which otherwise leaves a
// blank scene with a 3-second error message. Render a retryable card instead.
const overlayEl = document.getElementById('irl-overlay');

function hideOverlay() {
	if (overlayEl) { releaseSheet(overlayEl); overlayEl.hidden = true; overlayEl.innerHTML = ''; }
}

function showAvatarLoadError(err, onRetry) {
	if (!overlayEl) {
		setStatus(`Couldn't load avatar: ${err?.message ?? err}`, { error: true, sticky: true });
		return;
	}
	ensureStateKitStyles();
	overlayEl.innerHTML = `<div class="irl-overlay-card">${errorStateHTML({
		title: "Couldn't load this agent",
		body: 'The 3D avatar failed to load. Check your connection and try again.',
		scope: 'irl-avatar',
	})}</div>`;
	overlayEl.hidden = false;
	const retry = () => { hideOverlay(); onRetry?.(); };
	overlayEl.querySelector('[data-sk-retry]')?.addEventListener('click', retry);
	// This avatar-load failure is recoverable, so Escape acts as Retry and focus is
	// trapped on the Retry control. (The terminal "unsupported device" overlay is
	// rendered by the page's capability gate, not here, and is intentionally not
	// Escape-dismissable — there's nothing working behind it.)
	trapSheet(overlayEl, retry, { initialFocus: overlayEl.querySelector('[data-sk-retry]') });
}

// ── GPS world-anchor system ───────────────────────────────────────────────
//
// When the user pins their agent we record the GPS latitude/longitude of that
// real-world spot. From then on the avatar's 3D position is derived from the
// delta between the user's current GPS and the pin's GPS. As they walk away
// the avatar appears smaller (perspective); as they turn, the existing gyro
// system already rotates the camera so the agent stays locked to real-world
// direction — Pokémon GO style, but for 3D AI agents.
//
// Coordinate system: North = −Z  ·  East = +X  ·  Y = up  ·  1 unit = 1 m.

const EYE_HEIGHT = 1.6; // metres — camera height in GPS pin mode

let _deviceToken = localStorage.getItem('irl_device_token');
if (!_deviceToken) {
	_deviceToken = crypto.randomUUID();
	localStorage.setItem('irl_device_token', _deviceToken);
}

// The anonymous device token is a bearer credential — it reads this device's full
// pin location history. Carry it in the `x-irl-device` REQUEST HEADER (H2), never
// a URL query string, so it can't leak via access logs, browser history, or a
// cross-origin Referer. Spread into any fetch's `headers`.
function deviceHeaders(extra = {}) {
	return _deviceToken ? { 'x-irl-device': _deviceToken, ...extra } : { ...extra };
}

// Smart-glasses bridge — mirrors the nearest-agent cue (direction · distance ·
// arrivals) to companion glasses (Brilliant Labs Frame / Even Realities G1) over Web
// Bluetooth. Idle until the user pairs from the topbar; the render loop pushes live
// state to it every frame (it self-throttles + early-outs when not connected), and a
// connected link stamps interaction telemetry as a 'glasses' encounter.
const glassesBridge = new GlassesBridge();

const gpsState = { lat: null, lng: null, ready: false, watchId: null, accuracy: null, altitude: null };
window.addEventListener('pagehide', () => {
	if (gpsState.watchId != null) { navigator.geolocation.clearWatch(gpsState.watchId); gpsState.watchId = null; }
}, { once: true });
// DEV-only simulated-location guard (L1). Always false in production — the mock
// machinery that flips it lives entirely inside an `import.meta.env.DEV` block and
// is tree-shaken out, leaving this as an inert, always-false check. When set, the
// real geolocation watch is suppressed so no real coordinate is ever read.
let _mockLocation = false;
let gpsPin = null;        // { lat, lng, id?, heightM } — the user's own anchored pin
let gpsModeActive = false;
// True when the user locked before the first GPS fix landed: onGPSPosition()
// finishes the anchor the instant a fix arrives, instead of pinning at origin.
let _pendingGpsLock = false;
// Camera glide for the local→GPS lock upgrade. When the first fix flips
// gpsModeActive, the camera jumps from the gyro pivot to the viewer origin and the
// avatar reprojects via gpsToWorld — without easing, that reads as a teleport. Set
// to { from: Vector3, elapsed: 0 } at the flip; the GPS camera branch in tick()
// eases position from `from` toward the origin over GPS_TRANSITION_MS, then clears.
let _gpsCamTransition = null;
// Pending re-arm of the geolocation watch after a transient (non-permission) error.
// watchPosition does not reliably resume after an indoor timeout, and initGPS() is
// idempotent on a live watchId — so onGPSError() tears the dead watch down and
// schedules this backoff re-arm, letting an idle session self-heal without a reload.
let _gpsRetryTimer = null;
const GPS_RETRY_MS = 4000;
// Below this horizontal accuracy a GPS fix is trusted to *move* the own pinned
// avatar — reprojecting it from its coordinates so walking translates the world.
// Above it the fix is too coarse for close-range placement: an indoor fix (typically
// 20–60 m) would swim the avatar metres off the spot it was dropped on every ~10 s
// poll. A coarse fix leaves the avatar planted (its placed position is already the
// pin's round-trip, so it's correct in the viewer frame) while the camera, radar, and
// nearby agents keep tracking; a later sub-bar fix resumes moving the own avatar.
// 10 m: indoor fixes report 15–60 m (often optimistically low), so they stay planted;
// a clear-sky outdoor fix (3–10 m) is trusted to track. ORIGIN_REJECT_M (35) already
// drops the very worst fixes from the origin blend; this is the tighter own-avatar bar.
const GPS_RENDER_MAX_ACC_M = 10;

function gpsToWorld(agentLat, agentLng) {
	if (!gpsState.ready) return new Vector3(0, 0, 0);
	const mLat = 110540;
	const mLng = 111320 * Math.cos(gpsState.lat * (Math.PI / 180));
	return new Vector3(
		(agentLng - gpsState.lng) * mLng,   // east  = +X
		0,
		-(agentLat - gpsState.lat) * mLat,  // north = −Z
	);
}

// ── Cross-user anchor consistency (A3) ──────────────────────────────────────
// Foreign pins render from the placement's OWN stored absolute pose — compass
// yaw + floor height — not the viewer's incidental facing. Because both the
// placing device and every viewer reference absolute compass yaw and a shared
// geodetic (lat/lng) frame, the agent lands in the same bearing and floor spot
// for everyone. anchor_yaw_deg / anchor_height_m fall back to the legacy
// `heading` / ground plane when a pin predates the A2 pose columns.
//
// Yaw source priority (irl-floor-anchor task 02): when a WebXR placement stored
// the full tap-moment surface quaternion (anchor_quat = [x,y,z,w], float), derive
// yaw from it for exact facing — anchor_yaw_deg is that same angle rounded to a
// whole degree by the persist path, so a 47.6° placement reloads as 47.6° instead
// of snapping to 48°. Gyro/legacy pins carry no quat, so they keep falling back to
// the rounded anchor_yaw_deg, then to the legacy `heading` — fallback intact.
//
// Pitch/roll from the quat are DELIBERATELY DROPPED here: a standing humanoid is
// kept upright (yaw-only). Tilting an avatar to match a sloped surface looks broken,
// not realistic; true surface tilt is reserved for a future non-humanoid prop mode
// behind an explicit flag (see task 02, "Out of scope"). So we read only the yaw
// component of anchor_quat and apply it about world-Y via setFromAxisAngle(upY, …).
function pinQuatYawDeg(pin) {
	const q = pin.anchor_quat;
	// Guard the JSONB shape the API returns ([x,y,z,w] of finite numbers); a
	// malformed/partial value falls through to the rounded yaw rather than NaN.
	if (!Array.isArray(q) || q.length !== 4) return null;
	if (!q.every(n => Number.isFinite(n))) return null;
	return yawDegFromQuat(q[0], q[1], q[2], q[3]);
}
function pinYawRad(pin) {
	const quatYaw = pinQuatYawDeg(pin);
	const deg = quatYaw != null ? quatYaw
		: Number.isFinite(pin.anchor_yaw_deg) ? pin.anchor_yaw_deg
		: (pin.heading != null ? pin.heading : 0);
	return -(deg * Math.PI / 180);
}
// Pinch-resized render scale — the owner's chosen size, honoured for every
// viewer. clampPinScale() maps a legacy/absent column to natural size (1).
function pinScale(pin) {
	return clampPinScale(pin.anchor_scale);
}
function pinHeightM(pin) {
	const h = pin.anchor_height_m;
	// Honour only a small, genuine floor offset — a deliberate calibrate height
	// nudge or a future depth-aware/VPS source. Larger magnitudes are eye-height /
	// session-origin conventions, not a cross-user floor delta, so the agent's feet
	// sit on the viewer's own ground plane (y=0) — the honest default until VPS lands.
	return (Number.isFinite(h) && Math.abs(h) <= 1) ? h : 0;
}

// ── Room frame (shared room-relative anchoring) ──────────────────────────────
// A pin placed in a ROOM carries its EXACT offset from a shared origin instead
// of trusting its own ~10 m-noisy GPS, so a cluster keeps its room-scale layout
// identical for every viewer — couch-agent and wall-agent stay metres apart on
// the right sides no matter how GPS drifts. The math lives in the pure, unit-
// tested src/irl/room-anchor.js; here we only read it. The proximity-poll
// projection delivers these as snake_case, the one shape this reads.

// Per-room viewer-local frame rotation (R2 relative-frame alignment). A room
// placed WITHOUT an absolute compass (origin_yaw_deg ≠ 0, or anchor_source
// 'gyro-gps:rel') can't recover true north from GPS alone, so its layout may
// render rotated for another viewer. The one-tap "face the room's front and tap"
// alignment captures an extra rotation THIS viewer applies on top of the stored
// frame so the cluster sits where the real room is. It's viewer-local — never
// sent to the server, it doesn't move the room for anyone else — and persisted
// per room so it survives a reload.
const ROOM_ALIGN_KEY = 'irl_room_align_v1';
const _roomYawOffset = new Map(); // roomId → extra degrees, viewer-local
try {
	const saved = JSON.parse(localStorage.getItem(ROOM_ALIGN_KEY) || '{}');
	for (const [k, v] of Object.entries(saved)) if (Number.isFinite(v)) _roomYawOffset.set(k, v);
} catch { /* corrupt store → start fresh */ }
function persistRoomAlign() {
	try { localStorage.setItem(ROOM_ALIGN_KEY, JSON.stringify(Object.fromEntries(_roomYawOffset))); } catch { /* private mode */ }
}

function pinRoom(pin) {
	if (!pin || !pin.room_id) return null;
	const oLat = Number(pin.origin_lat), oLng = Number(pin.origin_lng);
	if (!Number.isFinite(oLat) || !Number.isFinite(oLng)) return null;
	const extra = _roomYawOffset.get(pin.room_id) || 0;
	return {
		roomId: pin.room_id,
		relEast: Number(pin.rel_east_m) || 0,
		relNorth: Number(pin.rel_north_m) || 0,
		originLat: oLat,
		originLng: oLng,
		// Stored frame + this viewer's one-tap alignment (0 for a true-north room).
		originYawDeg: (Number(pin.origin_yaw_deg) || 0) + extra,
	};
}

// World position of a nearby agent in the viewer's frame. Room pins resolve
// through their shared origin (exact relative layout); legacy standalone pins
// fall back to their own absolute GPS. Returns {x,y,z}. Requires a GPS fix —
// callers already gate on gpsState.ready before placing/reprojecting.
// ── Marker frame (Epic M — indoor visual colocalization) ─────────────────────
// A marker pin is anchored to a QR both phones can see, NOT to GPS. The live
// observation of that marker (its world pose in THIS session, refreshed each frame
// the camera sees it) is the origin its agents render against — see
// src/irl/marker-anchor.js for why this colocalizes indoors where GPS+compass
// can't. `liveMarker` holds the current observation; null when no marker is in
// view, in which case marker pins hide (there is no odometry to coast on).
let liveMarker = null;          // { roomId, markerWorld:{x,z}, markerY, markerYawDeg }
let _markerPinsPresent = false; // cheap gate so the per-frame pass is free when unused
function setLiveMarker(roomId, obs) {
	liveMarker = (roomId && obs) ? { roomId, ...obs } : null;
}

// Per-frame placement + visibility for marker pins. When their marker is in view,
// each renders at its exact offset from the live marker pose, facing a marker-
// relative heading (so "facing me" holds for every viewer, cross-session). When
// the marker isn't currently observed, they hide rather than freeze at a stale
// spot. Drives only marker pins; GPS/room pins are world-fixed and untouched here.
function updateMarkerPins() {
	const DEG = Math.PI / 180;
	for (const pin of nearbyPins) {
		if (!isMarkerRoomId(pin.room_id) || !pin.group) continue;
		const localized = liveMarker && liveMarker.roomId === pin.room_id;
		pin.group.visible = !!localized;
		if (!localized) continue;
		const wp = markerWorldPos({
			markerWorld: liveMarker.markerWorld,
			markerYawDeg: liveMarker.markerYawDeg,
			relEast: Number(pin.rel_east_m) || 0,
			relNorth: Number(pin.rel_north_m) || 0,
			heightM: pinHeightM(pin),
		});
		pin.group.position.set(wp.x, wp.y, wp.z);
		// Facing is stored marker-relative (anchor_yaw_deg) and composed with the live
		// marker azimuth, so the avatar turns with the marker frame, not absolute north.
		const relYaw = Number(pin.anchor_yaw_deg) || 0;
		pin.group.rotation.y = -(((liveMarker.markerYawDeg + relYaw) % 360) * DEG);
		if ('baseYaw' in pin) pin.baseYaw = pin.group.rotation.y;
	}
}

function pinWorldPos(pin) {
	// Marker pins resolve FIRST: they carry a coarse origin_lat/lng too (a GPS index
	// only), so falling through to pinRoom would wrongly place them at that index.
	if (isMarkerRoomId(pin.room_id)) {
		if (liveMarker && liveMarker.roomId === pin.room_id) {
			return markerWorldPos({
				markerWorld: liveMarker.markerWorld,
				markerYawDeg: liveMarker.markerYawDeg,
				relEast: Number(pin.rel_east_m) || 0,
				relNorth: Number(pin.rel_north_m) || 0,
				heightM: pinHeightM(pin),
			});
		}
		// Not localized this frame — a harmless in-band placeholder at the viewer;
		// updateMarkerPins() hides the group until the marker is seen again.
		return { x: 0, y: pinHeightM(pin), z: 0 };
	}
	const room = pinRoom(pin);
	if (room) {
		const originWorld = roomOriginWorld(gpsState.lat, gpsState.lng, room.originLat, room.originLng);
		return agentWorldPosition({
			originWorld,
			relEast: room.relEast,
			relNorth: room.relNorth,
			heightM: pinHeightM(pin),
			originYawDeg: room.originYawDeg,
		});
	}
	const wp = gpsToWorld(pin.lat, pin.lng);
	return { x: wp.x, y: pinHeightM(pin), z: wp.z };
}

// Low-pass the viewer's GPS origin so anchored agents don't swim as GPS jitters
// frame-to-frame. We smooth the ORIGIN, never the pins. A fix worse than the
// reject threshold is dropped outright; a large jump (real walk or a big
// correction) snaps so the origin can't lag a block behind. Tighter fixes are
// trusted more (higher blend weight).
const ORIGIN_REJECT_M = 35;  // ignore fixes noisier than this (m)
const ORIGIN_SNAP_M   = 50;  // beyond this delta, snap instead of blend (m)
function blendOrigin(prev, fix) {
	const acc = Number.isFinite(fix.accuracy) ? fix.accuracy : 20;
	if (acc > ORIGIN_REJECT_M) return prev;
	const jump = haversineMeters(prev.lat, prev.lng, fix.lat, fix.lng);
	if (jump > ORIGIN_SNAP_M) return { lat: fix.lat, lng: fix.lng };
	const k = Math.min(0.4, 12 / acc);
	return {
		lat: prev.lat + (fix.lat - prev.lat) * k,
		lng: prev.lng + (fix.lng - prev.lng) * k,
	};
}

// Tight "stumble upon" gate: an agent only renders once you're within ~40 m of
// it. You discover one by physically being near it with your camera up — never from
// a list, map, or neighbourhood feed. This is the band's ENTER threshold; a rendered
// pin is then held out to EXIT_RADIUS_M (proximity-band.js) so edge GPS jitter can't
// pop it in and out.
const NEARBY_RADIUS = 40; // metres
// Ask the server for the wider read (its hard 60 m cap), NOT the tight discovery
// radius. A wider set keeps an edge agent stably returned so it can't blink in/out as
// GPS jitters; loadNearbyPins() then trims that coarse set to the asymmetric band
// locally (pinBandAction). Never widen past the cap — the server still gates the
// roster to 60 m, so this discovers nothing the user couldn't already stumble upon.
const NEARBY_READ_RADIUS = 60; // metres — matches api/irl/pins.js Math.min(60, …)

// L4 — Approximate discovery. The origin we SEND to the nearby read. In precise
// mode it's the live fix; in approximate mode we snap to a ~25 m grid so our
// exact position never leaves the device while browsing. 25 m is the largest cell
// that still keeps every agent inside the 40 m display band returned by the 60 m
// read (worst-case snap offset ≈ 17.7 m; 40 + 17.7 < 60). Rendering + the
// ENTER/EXIT band always measure against the TRUE gpsState, so coarsening changes
// only WHICH pins come back, never where they draw.
function discoveryOrigin() {
	if (getDiscoveryPrecision() !== 'approximate') return { lat: gpsState.lat, lng: gpsState.lng };
	const latCell = 25 / 110540;
	const lngCell = 25 / ((111320 * Math.cos(gpsState.lat * Math.PI / 180)) || 1);
	return {
		lat: Math.round(gpsState.lat / latCell) * latCell,
		lng: Math.round(gpsState.lng / lngCell) * lngCell,
	};
}

// ── H4 / L4 — Approximate placement (how a pin the user PLACES is stored) ─────
// Distinct from discovery precision (which governs the nearby READ): placement
// precision governs the coordinate we WRITE. 'precise' stores the agent exactly
// where chosen; 'approximate' stores a point fuzzed within PLACEMENT_FUZZ_RADIUS_M
// so the exact standing spot is never recorded. The first-placement consent sheet
// (maybeConfirmPlacement) sets it; the choice is remembered across sessions.
const PLACEMENT_KIND_KEY = 'irl_placement_kind';
const PLACEMENT_FUZZ_KEY = 'irl_placement_fuzz_m';
const PLACEMENT_CONSENT_KEY = 'irl_placement_consented_v1';
// The blur radii the consent sheet offers, and the default. ~30 m drops the agent
// on the same block, ~100 m anywhere on the street, ~250 m somewhere in the
// neighbourhood — all comfortably above GPS error and below the point it stops
// meaning "near here". These mirror the server's FUZZ_MIN_M / FUZZ_MAX_M band.
const PLACEMENT_FUZZ_OPTIONS = [30, 100, 250];
const PLACEMENT_FUZZ_DEFAULT = 100;

function getPlacementKind() {
	try { return localStorage.getItem(PLACEMENT_KIND_KEY) === 'approximate' ? 'approximate' : 'precise'; }
	catch { return 'precise'; }
}
function setPlacementKind(v) {
	try { localStorage.setItem(PLACEMENT_KIND_KEY, v === 'approximate' ? 'approximate' : 'precise'); } catch {}
}
function getPlacementFuzzRadius() {
	try {
		const v = Number(localStorage.getItem(PLACEMENT_FUZZ_KEY));
		return PLACEMENT_FUZZ_OPTIONS.includes(v) ? v : PLACEMENT_FUZZ_DEFAULT;
	} catch { return PLACEMENT_FUZZ_DEFAULT; }
}
function setPlacementFuzzRadius(v) {
	const r = PLACEMENT_FUZZ_OPTIONS.includes(Number(v)) ? Number(v) : PLACEMENT_FUZZ_DEFAULT;
	try { localStorage.setItem(PLACEMENT_FUZZ_KEY, String(r)); } catch {}
}
function hasPlacementConsent() {
	try { return localStorage.getItem(PLACEMENT_CONSENT_KEY) === '1'; } catch { return false; }
}
function markPlacementConsented() {
	try { localStorage.setItem(PLACEMENT_CONSENT_KEY, '1'); } catch {}
}

// Human-readable badge for a placement choice — shared by the caption chip, the
// My-pins rows, and the inspect sheet so the wording never drifts. An approximate
// pin shows its blur radius; a precise (or legacy/unknown) pin shows the exact pin.
function placementBadgeText(kind, radiusM) {
	if (kind === 'approximate') {
		const r = Number.isFinite(radiusM) ? Math.round(radiusM) : getPlacementFuzzRadius();
		return `≈ Approximate · ~${r} m`;
	}
	return '📍 Exact';
}

// Offset a coordinate by a uniformly-distributed random point inside a disc of
// `radiusM` metres (not a square — a square biases the corners). sqrt(rand) gives a
// uniform areal distribution; the bearing is uniform. Returns a fresh {lat,lng} so a
// caller can fuzz once at commit and store the result, keeping the true spot local.
function fuzzCoord(lat, lng, radiusM) {
	const r = radiusM * Math.sqrt(Math.random());
	const theta = Math.random() * Math.PI * 2;
	const dNorth = r * Math.cos(theta);
	const dEast  = r * Math.sin(theta);
	const mLat = 110540;
	const mLng = 111320 * Math.cos(lat * Math.PI / 180) || 1;
	return { lat: lat + dNorth / mLat, lng: lng + dEast / mLng };
}

// Apply the active placement kind to a coordinate at commit time. In approximate
// mode it returns the fuzzed point + the metadata the pin-create call sends
// (placement_kind + fuzz_radius_m); precise mode returns the coordinate untouched.
function applyPlacementKind(lat, lng) {
	if (getPlacementKind() !== 'approximate') {
		return { lat, lng, placementKind: 'precise', fuzzRadiusM: 0 };
	}
	const radiusM = getPlacementFuzzRadius();
	const fuzzed = fuzzCoord(lat, lng, radiusM);
	return { lat: fuzzed.lat, lng: fuzzed.lng, placementKind: 'approximate', fuzzRadiusM: radiusM };
}

// H3 — Proof-of-presence. The nearby read is bound to a genuine fix: we mint a
// short-lived, server-signed token from our REAL geolocation and attach it
// (x-irl-fix) to every loadNearbyPins call, so the server only answers for where
// we actually are. Invisible to the user — they already granted location. We
// re-mint on a coarse cell change (~150 m of travel) or on a 401 fix_required.
let _fixToken = null;
let _fixCell = null;       // the ~110 m cell key the current token was minted for
let _fixExpiresAt = 0;     // performance.now()-relative ms when the cached token lapses
let _fixMintInflight = null;
// Re-mint a hair before the server clock would reject the token, so a poll or a pin
// create never races the boundary and eats a 401.
const FIX_EXPIRY_SKEW_MS = 8000;

// A coarse cell key for the origin we send to the read — 3 decimals ≈ 110 m, the
// granularity the server token anchors at. When this changes we re-mint.
function fixCellKey(origin) {
	if (!origin || !Number.isFinite(origin.lat) || !Number.isFinite(origin.lng)) return null;
	return `${origin.lat.toFixed(3)},${origin.lng.toFixed(3)}`;
}

// True when the cached token is still good for the current cell AND hasn't lapsed.
// A cell change (the user walked ~150 m) or an imminent expiry both force a re-mint.
function fixTokenFresh(cell) {
	return !!_fixToken && cell === _fixCell && Date.now() < _fixExpiresAt;
}

// Mint (or re-mint) a fix token for the current discovery origin. De-duped so a
// burst of GPS callbacks issues one request; cached until the cell changes OR the
// server-supplied expires_in lapses. On a dev/preview server with IRL_FIX_SECRET
// unset the read ignores the token, so a mint failure there is harmless — we simply
// poll without one.
async function ensureFixToken(force = false) {
	const origin = discoveryOrigin();
	const cell = fixCellKey(origin);
	if (!cell) return null;
	if (!force && fixTokenFresh(cell)) return _fixToken;
	if (_fixMintInflight) return _fixMintInflight;
	_fixMintInflight = (async () => {
		try {
			const r = await fetch('/api/irl/fix-token', {
				method: 'POST',
				credentials: 'include',
				headers: deviceHeaders({ 'Content-Type': 'application/json' }),
				body: JSON.stringify({ deviceToken: _deviceToken, lat: origin.lat, lng: origin.lng, accuracy: gpsState.accuracy }),
			});
			if (!r.ok) return null;
			// `expires_in` is the token TTL in seconds (the server's exp expressed as a
			// relative lifetime); cache the absolute lapse moment so a long-idle session
			// re-mints rather than re-using a stale token the server now rejects.
			const { token, expires_in } = await r.json();
			if (token) {
				_fixToken = token;
				_fixCell = cell;
				const ttlMs = Number.isFinite(expires_in) ? expires_in * 1000 : 180000;
				_fixExpiresAt = Date.now() + Math.max(0, ttlMs - FIX_EXPIRY_SKEW_MS);
			}
			return _fixToken;
		} catch {
			return null;
		} finally {
			_fixMintInflight = null;
		}
	})();
	return _fixMintInflight;
}

// Headers for a request that proves presence: device id + a guaranteed-fresh fix
// token. Awaits a mint when the cache is cold/expired so a pin create or nearby read
// is never sent without proof when one is obtainable. Falls back to device-only
// headers when no fix is available yet (dev/preview, or location off) so the call
// still goes out rather than dead-ending.
async function presenceHeaders(extra = {}) {
	let token = _fixToken;
	const cell = fixCellKey(discoveryOrigin());
	if (cell && !fixTokenFresh(cell)) token = await ensureFixToken();
	return deviceHeaders(token ? { 'x-irl-fix': token, ...extra } : { ...extra });
}

// The nearby read returned 401 fix_required (proof-of-presence enforced and our
// token is missing/expired/out-of-area). Re-mint from the current fix and let the
// next ~10 s poll cycle pick it up — or, if location is unavailable, surface the
// existing designed permission/no-fix state rather than a blank screen.
async function handleFixRequired(_resp) {
	const token = await ensureFixToken(true);
	if (!token) {
		// Couldn't mint — almost always because we don't have a usable fix. Flag the
		// badge so the user sees a retrying state instead of an empty world.
		_nearbyError = true;
		updateNearbyBadge();
	}
}

// ── IRL Money Drops & Bounties (Wave II task 06) ─────────────────────────────
// Value placed in the real world: glowing coin markers anchored to a spot, a
// "drop money here" create flow, and a presence-gated claim. Self-contained in
// src/shared/irl-drops.js — we hand it accessors into the live scene + the same
// presence-token headers the nearby read uses, and it owns the rest.
initIrlDrops({
	scene,
	getCamera: () => camera,
	getGpsState: () => gpsState,
	gpsToWorld: (lat, lng) => gpsToWorld(lat, lng),
	presenceHeaders: (extra) => presenceHeaders(extra),
	deviceHeaders: (extra) => deviceHeaders(extra),
	isAR: () => arActive,
	NEARBY_READ_RADIUS,
});

// Honour the OS "reduce motion" setting for the spawn/despawn transitions below —
// scale in/out for everyone else, instant for users who asked for less animation.
function prefersReducedMotion() {
	return typeof matchMedia === 'function'
		&& matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function onGPSPosition(pos) {
	// A fix landed — cancel any pending transient-loss re-arm; the watch is alive.
	if (_gpsRetryTimer != null) { clearTimeout(_gpsRetryTimer); _gpsRetryTimer = null; }
	const wasReady = gpsState.ready;
	const rawLat = pos.coords.latitude;
	const rawLng = pos.coords.longitude;
	// Retain sensor metadata so a placement records how trustworthy the fix was
	// (A2 anchor pose). accuracy is metres of horizontal error; altitude is the
	// WGS-84 height above the ellipsoid (null where the device can't measure it).
	gpsState.accuracy = pos.coords.accuracy ?? null;
	gpsState.altitude = pos.coords.altitude ?? null;
	// Low-pass the viewer origin (A3) so anchored agents don't swim; the first fix
	// seeds the filter, later fixes are blended by blendOrigin().
	if (!wasReady) {
		gpsState.lat = rawLat;
		gpsState.lng = rawLng;
	} else {
		const blended = blendOrigin(
			{ lat: gpsState.lat, lng: gpsState.lng },
			{ lat: rawLat, lng: rawLng, accuracy: gpsState.accuracy },
		);
		gpsState.lat = blended.lat;
		gpsState.lng = blended.lng;
	}
	gpsState.ready    = true;
	_gpsAcquiring     = false;   // first fix in hand — leave the "finding you" state

	// First fix: GPS is live, so the user can place + manage pins from here.
	if (!wasReady) revealMyPinsBtn();
	// First fix: start the proximity poll (the sole pin-discovery transport) and join
	// the presence/reaction socket for this geocell. Pins are NOT streamed — they ride
	// the ~10 s REST poll; the socket carries only live presence + ambient reactions,
	// and the poll runs the whole session even if that socket never connects.
	if (!wasReady) startPinSync();

	// H3: keep a fresh proof-of-presence token for the nearby read. ensureFixToken
	// is a no-op unless our coarse cell changed, so this fires a mint on the first
	// fix and then only every ~150 m of travel — invisible, and cheap. Fire-and-forget.
	ensureFixToken();

	// A lock was requested before the first fix — finish anchoring now that we
	// have real coordinates, rather than dropping the agent at a default origin.
	if (_pendingGpsLock && avatarLocked && arActive) {
		_pendingGpsLock = false;
		anchorGpsPin();
	}

	// A WebXR floor anchor was placed before this first fix — persist its pin now.
	// The XRAnchor already holds the agent in the room; this lands the durable,
	// shareable record it couldn't save without coordinates. gpsState.ready is true
	// by here, so the gate drains its held pose exactly once (a no-op otherwise).
	floorPersist.onFix(gpsState.ready);

	// Move the pinned avatar to its GPS-anchored world position — but ONLY when the fix
	// is accurate enough to be an improvement. Reprojecting the own avatar from a noisy
	// fix is exactly what swims it off the spot it was dropped: indoors the accuracy is
	// tens of metres, so each ~10 s fix would yank it across the room. A coarse fix
	// leaves the avatar planted at its placed position (which is the pin's round-trip,
	// so it's already correct in the viewer frame); a fix that lands under the accuracy
	// bar — typically once the user steps outside — resumes tracking and snaps it to its
	// true world spot. anchor_height_m (A2) keeps the feet on the ground plane — 0 today,
	// but read it back so future floor-corrected placements render at the right height.
	if (gpsPin && gpsFixRendersOwnAvatar()) {
		const wp = gpsToWorld(gpsPin.lat, gpsPin.lng);
		avatarRig.position.set(wp.x, gpsPin.heightM ?? 0, wp.z);
	}

	// Update world positions of all nearby agents. Because each agent's world
	// position is in metres relative to the user at the origin, its live distance
	// is simply hypot(x, z) — so recompute it every fix (the server's distance_m
	// goes stale the moment the user moves). The LOD/load decision is NOT made here
	// any more: enforceLOD() (4 Hz, from tick) owns band assignment and the queued
	// GLB load / impostor bake / eviction off the live camera distance.
	for (const p of nearbyPins) {
		if (!p.group) continue;
		// The agent being calibrated is driven by the nudge gesture this frame, not
		// by GPS — re-apply its working pose against the (possibly shifted) origin.
		if (calibrateActive && _cal && _cal.pin === p) { applyCalToGroup(); updatePinRing(p); continue; }
		// A room being aligned is driven by the room-cal gesture against a temporary
		// origin; skip the default reproject so it isn't double-corrected. The whole
		// cluster is re-applied once below so it still tracks the blended viewer origin.
		if (calibrateActive && _roomCal && _roomCal.pins.includes(p)) continue;
		const wp = pinWorldPos(p);
		p.group.position.set(wp.x, wp.y, wp.z);
		p.distance_m = Math.round(Math.hypot(wp.x, wp.z));
		updatePinRing(p);
	}
	// Re-apply the active room-cal cluster against the freshly blended origin so the
	// rig holds its real-world spot as the viewer's GPS settles mid-alignment.
	if (calibrateActive && _roomCal) applyRoomCalToGroups();

	// Re-anchor live presence ghosts against the shifted origin too, so a co-viewer's
	// orb holds its real-world bearing as the user walks (same treatment as pins).
	for (const g of ghostViewers.values()) positionGhostOrb(g);

	// Live presence follows the viewer into a new geocell as they walk — a no-op
	// until they actually cross a ~1.2 km cell boundary (and while the socket is
	// offline). Pin discovery doesn't ride this tick; it's the proximity poll's own
	// timer (startPinPolling), scoped to a tight radius around the live position.
	irlNet?.moveTo(gpsState.lat, gpsState.lng);
}

// True when the live fix is accurate enough to move the own avatar to its GPS spot.
// A coarse (indoor) fix leaves the avatar planted where it was dropped instead of
// swimming it across the room with GPS noise. See GPS_RENDER_MAX_ACC_M.
function gpsFixRendersOwnAvatar() {
	return Number.isFinite(gpsState.accuracy) && gpsState.accuracy <= GPS_RENDER_MAX_ACC_M;
}

// Hand the own pinned avatar from the local gyro lock to the viewer-centric GPS
// frame: camera at the origin, avatar reprojected from its coordinates each fix.
// Eases the camera from the gyro pivot to the origin (the avatar holds its world
// spot) so the upgrade reads as a glide, not a teleport. Idempotent.
function enterGpsRenderMode() {
	if (gpsModeActive) return;
	if (gyroLockCamPos && !prefersReducedMotion()) {
		_gpsCamTransition = { from: gyroLockCamPos.clone(), elapsed: 0 };
	}
	gpsModeActive = true;
	document.body.classList.add('gps-mode');
}

// Build the GPS world-anchor for the freshly locked own avatar and open the
// caption panel to persist its A2 pose. Requires a live GPS fix — setLocked()
// calls this directly when one is ready, or defers it here via _pendingGpsLock
// until onGPSPosition() lands the first fix.
function anchorGpsPin() {
	// Hard gate: never anchor without a real fix. Without this a null/origin
	// gpsState would pin the agent at lat/lng 0,0 (off the coast of Africa) and
	// persist it there. setLocked() already defers via _pendingGpsLock until the
	// first fix; this guards every other caller and re-defers if one slips through.
	if (!gpsState.ready || !Number.isFinite(gpsState.lat) || !Number.isFinite(gpsState.lng)) {
		_pendingGpsLock = true;
		setStatus('Getting your location…', { loading: true, sticky: true });
		return;
	}
	const mLat = 110540;
	const mLng = 111320 * Math.cos(gpsState.lat * (Math.PI / 180));
	const pinLat = gpsState.lat + (-avatarRig.position.z / mLat);
	const pinLng = gpsState.lng + ( avatarRig.position.x / mLng);
	// Local→GPS upgrade: glide the camera from the gyro pivot to the viewer origin
	// instead of snapping. The avatar holds its world spot (its placed position is the
	// pin's round-trip), so easing the only thing that moves — the camera — keeps it
	// from visibly teleporting in the room. This always enters the GPS frame so the
	// radar and nearby agents stay live; whether each later fix is allowed to *move*
	// the own avatar is gated separately on accuracy (onGPSPosition) so a coarse indoor
	// fix can't swim it off the spot it was dropped.
	enterGpsRenderMode();
	// On iOS the live compass is the authoritative bearing — re-derive cameraYaw from
	// the freshest reading so the stored heading is north-anchored even when this runs
	// between orientation events (notably the deferred first-GPS-fix path).
	if (lastCompassHeading !== null) cameraYaw = compassToYaw(lastCompassHeading);
	const headingDeg = ((cameraYaw * 180 / Math.PI) % 360 + 360) % 360;
	// Snap the avatar to face the heading we're about to store so it matches how
	// nearby users will see it — spawnNearbyPin() rotates foreign avatars with the
	// same -(heading) → Y mapping. Keeping avatarYaw in sync means a later
	// unlock+walk lerps from here too.
	avatarYaw = -(headingDeg * Math.PI / 180);
	avatarRig.quaternion.setFromAxisAngle(upY, avatarYaw);
	// Dead-reckoning is only consistent across users when the heading is absolute
	// (compass-referenced). With only page-relative orientation the agent still
	// locks locally, but cross-user bearing (A3) degrades — record the distinction
	// in anchor_source (':rel') so A3 can down-weight it, and warn the user.
	const source = prefersAbsOrientation ? 'gyro-gps' : 'gyro-gps:rel';
	if (!prefersAbsOrientation) {
		setStatus('Pinned. Compass isn’t available here, so the direction your agent faces may be approximate for others.', { warn: true });
	}
	openCaptionPanel(pinLat, pinLng, headingDeg, source);
}

function onGPSError(err) {
	const denied = err && err.code === err.PERMISSION_DENIED;
	// A revoked location permission always surfaces a re-request chip (E1), even
	// outside an active pin attempt. Leave the "finding you" state too — the denied
	// chip owns recovery from here, and the badge falls back to hidden. The watch is
	// kept on its designed re-request path (a re-grant resumes the same watch).
	if (denied) {
		_gpsAcquiring = false;
		setPermissionState('location', 'denied');
		updateNearbyBadge();
	} else {
		// Transient failure (indoor timeout, momentary signal loss). watchPosition does
		// not reliably resume after a timeout, and initGPS() is idempotent on a live
		// watchId — so a dead watch would never restart, leaving a zombie that needs a
		// reload. Tear it down so any retry path (the placement sheet below, or the
		// backoff re-arm) can re-establish it cleanly.
		stopGPSWatch();
	}
	// Only intervene with a sheet when a placement is actively waiting on a fix —
	// a transient watchPosition timeout shouldn't disturb a working session.
	if (!_pendingGpsLock) {
		// No placement waiting: a denial waits for a user re-grant; a transient loss
		// self-heals on a short backoff so an indoor dropout recovers without a reload.
		if (!denied) scheduleGpsRetry();
		return;
	}
	_pendingGpsLock = false;
	showErrorState({
		title: denied ? 'Location access needed to pin' : 'Couldn’t get your location',
		body: denied
			? 'Pinning your agent to a real spot needs your location. Enable it in Settings › Safari › Location, then tap Try again.'
			: 'We couldn’t read a GPS fix to pin precisely. Move somewhere with a clearer view of the sky, then tap Try again.',
		actionLabel: 'Try again',
		onAction: () => setLocked(true),
	});
}

function initGPS() {
	if (_mockLocation) return;             // DEV simulated location active — never attach the real watch
	if (!navigator.geolocation) return;
	if (gpsState.watchId != null) return; // idempotent — onboarding, boot, and Pin may all call
	// Enter the "finding you" state the moment the watch attaches (unless a fix is
	// somehow already in hand) so the topbar shows honest progress, not a blank gap,
	// before the first position lands.
	if (!gpsState.ready) { _gpsAcquiring = true; updateNearbyBadge(); }
	gpsState.watchId = navigator.geolocation.watchPosition(
		onGPSPosition,
		onGPSError,
		{ enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 },
	);
}

// Stop the live geolocation watch, if any, and clear its id so initGPS() will
// re-attach on the next call. The single owner of watch teardown — onGPSError()'s
// transient path, the DEV mock, and unload all route through here.
function stopGPSWatch() {
	if (gpsState.watchId != null) {
		navigator.geolocation.clearWatch(gpsState.watchId);
		gpsState.watchId = null;
	}
}

// Re-arm the watch a short moment after a transient loss. Debounced on the pending
// timer so a burst of error callbacks schedules one re-arm, and a no-op under the
// DEV mock so a simulated location is never overridden by the real watch.
function scheduleGpsRetry() {
	if (_gpsRetryTimer != null || _mockLocation) return;
	_gpsRetryTimer = setTimeout(() => {
		_gpsRetryTimer = null;
		initGPS();
	}, GPS_RETRY_MS);
}

function compassLabel(deg) {
	const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
	return dirs[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
}

async function savePin(lat, lng, heading = 0, caption = '', anchor = null, placement = null) {
	try {
		// Anchor pose (A2): a reproducible record of where the agent stands —
		// floor height, orientation, and how trustworthy this GPS fix was — so a
		// later session or another user can reconstruct the placement. accuracy /
		// altitude always come from the live fix; heightM / yawDeg / quat / source
		// come from the placement mode (gyro-gps today, webxr later).
		const a = anchor || {};
		// 'webxr' (A1) · 'gyro-gps' (absolute compass) · 'gyro-gps:rel' (page-relative
		// heading — A3 down-weights its cross-user bearing) · 'map' (L2: a point chosen
		// on the map, NOT a live fix at that spot — so it carries no GPS accuracy/altitude
		// and its bearing isn't compass-trustworthy).
		const src = a.source === 'webxr' ? 'webxr'
			: a.source === 'map' ? 'map'
			: a.source === 'gyro-gps:rel' ? 'gyro-gps:rel' : 'gyro-gps';
		const anchorBody = {
			heightM:      Number.isFinite(a.heightM) ? a.heightM : null,
			yawDeg:       Number.isFinite(a.yawDeg)  ? a.yawDeg  : ((Math.round(heading) % 360) + 360) % 360,
			quat:         Array.isArray(a.quat) ? a.quat : null,
			// accuracy / altitude describe the live fix; a map placement has neither.
			gpsAccuracyM: src === 'map' ? null : gpsState.accuracy,
			altitudeM:    src === 'map' ? null : gpsState.altitude,
			source:       src,
		};
		const r = await fetch('/api/irl/pins', {
			method: 'POST',
			credentials: 'include',
			headers: deviceHeaders({ 'Content-Type': 'application/json' }),
			body: JSON.stringify({
				lat, lng,
				heading:     Math.round(heading) % 360,
				caption:     caption || null,
				avatarUrl:   resolveAvatarUrl(_currentAvatarId),
				avatarName:  nameEl.textContent,
				deviceToken: _deviceToken,
				agentId:     _currentAgentId || null,
				anchor:      anchorBody,
				// Placement consent (H4): the kind + radius the coordinate above was
				// already fuzzed by (precise → unchanged). The server stores only this
				// fuzzed spot, never the true one. Defaults keep old behaviour intact.
				placement:   placement?.placementKind || 'precise',
				fuzzRadiusM: placement?.fuzzRadiusM || 0,
			}),
		});
		if (!r.ok) {
			// Surface the server's designed moderation/cap/rate rejection (D4) so the
			// caller can show an actionable message instead of a silent failure.
			let payload = {};
			try { payload = await r.json(); } catch {}
			return {
				ok: false,
				status: r.status,
				error: payload.error || 'error',
				message: payload.message || saveErrorFallback(payload.error),
				retryAfter: Number.isFinite(payload.retryAfter) ? payload.retryAfter : null,
			};
		}
		const data = await r.json();
		return data.pin
			? { ok: true, id: data.pin.id, permanent: !!data.pin.permanent }
			: { ok: false, error: 'error', message: saveErrorFallback() };
	} catch {
		return { ok: false, error: 'network', message: saveErrorFallback('network') };
	}
}

// Place an agent into a shared ROOM (Epic R / R1). The room-mode UI hands us a
// computed body { lat, lng, heading, room:{…}, absolute } from room-session.js;
// we attach the device's identity + avatar + A2 anchor pose, POST it (the room
// block rides through to api/irl/pins.js), and on success spawn it immediately so
// it renders world-locked at once via the room frame (pinWorldPos). Returns the
// same { ok, id, message } shape the UI surfaces.
async function placeRoomAgent(body) {
	const room = body?.room;
	if (!room || !room.id) return { ok: false, message: 'Could not anchor the room — try again.' };
	const heading = ((Math.round(body.heading) % 360) + 360) % 360;
	// Gyro placement has no measured floor depth and no surface quaternion: the agent
	// stands on the viewer's own ground plane (heightM 0) facing the compass heading.
	// 'gyro-gps' vs ':rel' carries the absolute-vs-page-relative bearing distinction A3
	// down-weights. The WebXR path (postRoomPin via persistFloorAnchor) supplies a
	// richer anchor — real floor height + surface quat + 'webxr' source.
	const anchor = {
		heightM: 0, yawDeg: heading,
		gpsAccuracyM: gpsState.accuracy, altitudeM: gpsState.altitude,
		source: body.absolute ? 'gyro-gps' : 'gyro-gps:rel',
	};
	return postRoomPin({
		lat: body.lat, lng: body.lng, heading,
		room: {
			id: room.id,
			originLat: room.originLat, originLng: room.originLng,
			originYawDeg: room.originYawDeg || 0,
			relEast: room.relEast, relNorth: room.relNorth,
		},
		anchor,
	});
}

// Shared POST for a room-anchored agent — the one network+spawn path behind both
// the gyro aim flow (R1, slider + compass) and the WebXR floor flow (R3, on-device
// hit-test). The caller hands the computed absolute lat/lng (the GPS index), the
// agent heading, the shared room block (origin + exact rel offset), and the A2
// anchor pose, whose `source` / `quat` / `heightM` ride straight through so a
// WebXR placement persists with centimetre precision while a gyro one degrades
// honestly. On success we spawn locally so the agent is world-locked at once via
// the shared frame (pinWorldPos), and bump the room badge through the room-mode API.
async function postRoomPin({ lat, lng, heading, room, anchor, vps = null }) {
	try {
		if (!room || !room.id) return { ok: false, message: 'Could not anchor the room — try again.' };
		const h = ((Math.round(heading) % 360) + 360) % 360;
		const quat = Array.isArray(anchor?.quat) && anchor.quat.length === 4 ? anchor.quat : null;
		const r = await fetch('/api/irl/pins', {
			method: 'POST',
			credentials: 'include',
			headers: deviceHeaders({ 'Content-Type': 'application/json' }),
			body: JSON.stringify({
				lat, lng, heading: h,
				caption: null,
				avatarUrl: resolveAvatarUrl(_currentAvatarId),
				avatarName: nameEl.textContent,
				deviceToken: _deviceToken,
				agentId: _currentAgentId || null,
				anchor: {
					heightM: anchor?.heightM ?? 0,
					yawDeg: anchor?.yawDeg ?? h,
					quat,
					gpsAccuracyM: anchor?.gpsAccuracyM ?? gpsState.accuracy,
					altitudeM: anchor?.altitudeM ?? gpsState.altitude,
					source: anchor?.source || 'gyro-gps',
					// Pinch-resized size (WebXR path) — omitted at natural scale so
					// non-XR placements are byte-identical to before.
					scale: Number.isFinite(anchor?.scale) && anchor.scale !== 1 ? anchor.scale : undefined,
				},
				// Visual-positioning identity (Epic M) — present only on a marker
				// placement; the server persists it to vps_provider/vps_id and ignores it
				// for every other source.
				vps: vps && vps.id ? { provider: vps.provider || 'qr', id: vps.id } : undefined,
				room: {
					id: room.id,
					originLat: room.originLat, originLng: room.originLng,
					originYawDeg: room.originYawDeg || 0,
					relEast: room.relEast, relNorth: room.relNorth,
				},
			}),
		});
		if (!r.ok) {
			let payload = {};
			try { payload = await r.json(); } catch {}
			return { ok: false, status: r.status, error: payload.error || 'error', message: payload.message || saveErrorFallback(payload.error) };
		}
		const data = await r.json();
		if (!data.pin) return { ok: false, message: saveErrorFallback() };

		// Spawn locally so the just-placed agent is world-locked immediately, without
		// waiting for the next proximity poll. snake_case shape incl. the room frame,
		// matching the nearby projection so pinRoom()/pinWorldPos() render it correctly.
		const pin = {
			id: data.pin.id,
			lat, lng,
			heading: h, anchor_yaw_deg: anchor?.yawDeg ?? h,
			anchor_height_m: anchor?.heightM ?? 0,
			anchor_quat: quat,
			anchor_scale: Number.isFinite(anchor?.scale) && anchor.scale !== 1 ? anchor.scale : null,
			anchor_source: anchor?.source || 'gyro-gps',
			vps_provider: vps?.id ? (vps.provider || 'qr') : null, vps_id: vps?.id || null,
			room_id: room.id, rel_east_m: room.relEast, rel_north_m: room.relNorth,
			origin_lat: room.originLat, origin_lng: room.originLng, origin_yaw_deg: room.originYawDeg || 0,
			avatar_url: resolveAvatarUrl(_currentAvatarId), avatar_name: nameEl.textContent,
			caption: '', x402_endpoint: null, agent_id: _currentAgentId || null,
			distance_m: 0, group: null, labelEl: null, glbLoaded: false,
		};
		if (!nearbyPins.find(p => p.id === pin.id)) {
			_myPinIds.add(pin.id);
			nearbyPins.push(pin);
			spawnNearbyPin(pin);
			updateNearbyBadge();
			revealMyPinsBtn();
		}
		return { ok: true, id: pin.id, permanent: data.pin.permanent === true };
	} catch {
		return { ok: false, error: 'network', message: saveErrorFallback('network') };
	}
}

// Human fallback for a placement rejection when the server didn't ship a message.
// The API always sends one for D4 rejections; this covers network/parse gaps.
function saveErrorFallback(code) {
	switch (code) {
		case 'content':   return 'That text isn’t allowed on a public pin. Try rewording it.';
		case 'coin':      return 'A pin can only reference $THREE.';
		case 'endpoint':  return 'Pay endpoints must be hosted on three.ws.';
		case 'area_full': return 'This area already has the maximum number of agents. Try another spot.';
		case 'pin_limit': return 'You’ve reached your active pin limit. Remove an old pin first.';
		case 'rate':      return 'You’re placing agents too fast. Wait a moment and try again.';
		case 'network':   return 'Couldn’t reach the server — check your connection and try again.';
		default:          return 'Couldn’t place the agent. Try again.';
	}
}

// ── Modal-sheet keyboard accessibility (task 07) ──────────────────────────
// A small shared primitive the bottom sheets reuse: while a sheet is open it
// (1) closes on Escape, (2) keeps Tab focus inside the sheet, and (3) restores
// focus to whatever opened it on close. It generalises the bespoke trap the
// bulk-purge confirm already ships so every modal sheet behaves identically.
//
// Each sheet keeps its own open/close functions (no over-refactor) and simply
// calls trapSheet() after adding .is-open and releaseSheet() after removing it.
// opts.suspendWhile lets an outer sheet defer to a nested confirm (My Pins → the
// "remove all" purge) that runs its own trap; opts.manageFocus=false lets a
// caller that focuses its own field (the caption input) keep doing so.
const A11Y_FOCUSABLE = 'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';
const _sheetTraps = new Map();

function trapSheet(el, onClose, opts = {}) {
	if (!el || _sheetTraps.has(el)) return;
	const lastFocus = opts.restoreFocus === false ? null : document.activeElement;
	const keydown = (e) => {
		if (opts.suspendWhile?.()) return;            // a nested dialog owns the keyboard
		if (e.key === 'Escape') { e.preventDefault(); onClose?.(); return; }
		if (e.key !== 'Tab') return;
		const nodes = [...el.querySelectorAll(A11Y_FOCUSABLE)].filter(n => n.offsetParent !== null);
		if (!nodes.length) { e.preventDefault(); return; }
		const first = nodes[0], last = nodes[nodes.length - 1], act = document.activeElement;
		if (e.shiftKey && (act === first || !el.contains(act))) { e.preventDefault(); last.focus(); }
		else if (!e.shiftKey && (act === last || !el.contains(act))) { e.preventDefault(); first.focus(); }
	};
	document.addEventListener('keydown', keydown, true);
	_sheetTraps.set(el, { keydown, lastFocus });
	if (opts.manageFocus === false) return;           // caller focuses its own field
	const initial = opts.initialFocus || el.querySelector(A11Y_FOCUSABLE) || el;
	requestAnimationFrame(() => { try { initial.focus({ preventScroll: true }); } catch {} });
}

function releaseSheet(el) {
	const t = el && _sheetTraps.get(el);
	if (!t) return;
	document.removeEventListener('keydown', t.keydown, true);
	_sheetTraps.delete(el);
	if (t.lastFocus && document.contains(t.lastFocus)) {
		try { t.lastFocus.focus({ preventScroll: true }); } catch {}
	}
}

// ── Caption panel (pre-save) ──────────────────────────────────────────────

const captionPanel   = document.getElementById('irl-caption-panel');
const captionInput   = document.getElementById('irl-caption-input');
const captionConfirm = document.getElementById('irl-caption-confirm');
const captionCancel  = document.getElementById('irl-caption-cancel');

// Focus the caption field once the sheet has finished sliding up. iOS only opens
// the on-screen keyboard when focus lands on a visible, settled input, so we tie
// focus to the panel's open transition rather than a brittle fixed delay — with a
// safety timer for the cases where transitionend never fires (an interrupted
// transition, or a browser that skips it).
function focusCaptionWhenOpen() {
	if (!captionInput || !captionPanel) return;
	let done = false;
	const focusNow = () => {
		if (done) return;
		done = true;
		captionPanel.removeEventListener('transitionend', onEnd);
		clearTimeout(safety);
		try { captionInput.focus({ preventScroll: true }); } catch {}
	};
	const onEnd = (e) => { if (!e || e.propertyName === 'transform') focusNow(); };
	captionPanel.addEventListener('transitionend', onEnd);
	const safety = setTimeout(focusNow, 360);
}

// ── Placement consent sheet (H4) ──────────────────────────────────────────
// The single most consequential moment in /irl is placement: the chosen spot IS
// a real-world location that persists and that anyone nearby can read. Before the
// first placement we make that legible and offer a safer default — drop the agent
// "approximately" (a deliberately fuzzed point) instead of at the exact spot. The
// two choices are equally weighted (no dark pattern); "don't show every time"
// suppresses the sheet on later placements (the remembered kind still applies),
// and the caption-panel "ⓘ" chip re-opens it so the choice is always changeable.
const consentSheet = document.getElementById('irl-consent-sheet');

// Paint the radius segmented control + the heading to reflect the stored choice.
function syncConsentRadius() {
	if (!consentSheet) return;
	const radius = getPlacementFuzzRadius();
	consentSheet.querySelectorAll('[data-fuzz]').forEach((b) => {
		const on = Number(b.dataset.fuzz) === radius;
		b.classList.toggle('on', on);
		b.setAttribute('aria-pressed', String(on));
	});
}

// Open the consent sheet. Resolves true if the user picked a placement kind
// (exact or approximate) — both persist the choice — or false if they cancelled.
// When the markup is missing (degraded DOM) we fail safe to 'precise' and proceed,
// never dead-ending a placement (Rule 9).
function showPlacementConsentSheet() {
	return new Promise((resolve) => {
		if (!consentSheet) { setPlacementKind('precise'); resolve(true); return; }
		const exactBtn  = document.getElementById('irl-consent-exact');
		const approxBtn = document.getElementById('irl-consent-approx');
		const cancelBtn = document.getElementById('irl-consent-cancel');
		const dontShow  = document.getElementById('irl-consent-dontshow');
		if (dontShow) dontShow.checked = false;
		syncConsentRadius();

		let settled = false;
		const finish = (proceed) => {
			if (settled) return;
			settled = true;
			consentSheet.classList.remove('is-open');
			releaseSheet(consentSheet);
			resolve(proceed);
		};
		const choose = (kind) => {
			setPlacementKind(kind);
			if (dontShow?.checked) markPlacementConsented();
			refreshCaptionPlacementChip();
			finish(true);
		};

		consentSheet.querySelectorAll('[data-fuzz]').forEach((b) => {
			b.onclick = () => { setPlacementFuzzRadius(Number(b.dataset.fuzz)); syncConsentRadius(); };
		});
		if (exactBtn)  exactBtn.onclick  = () => choose('precise');
		if (approxBtn) approxBtn.onclick = () => choose('approximate');
		if (cancelBtn) cancelBtn.onclick = () => finish(false);

		consentSheet.classList.add('is-open');
		trapSheet(consentSheet, () => finish(false));
	});
}

// Gate a placement on consent. After the user has ticked "don't show every time"
// the sheet is skipped and the remembered kind is used; otherwise it appears and
// the user makes the choice explicitly per placement. Returns whether to proceed.
async function maybeConfirmPlacement() {
	if (hasPlacementConsent()) return true;
	return showPlacementConsentSheet();
}

// The caption panel always shows how THIS pin will be stored (exact vs approximate)
// as a tappable chip — both a clear disclosure and the "ⓘ" re-opener for the
// consent sheet, so the choice is changeable right up to the moment of saving.
const captionPlacementBtn = document.getElementById('irl-caption-placement');
function refreshCaptionPlacementChip() {
	if (!captionPlacementBtn) return;
	const kind = getPlacementKind();
	const badge = captionPlacementBtn.querySelector('.irl-caption-place-badge');
	if (badge) badge.textContent = placementBadgeText(kind, getPlacementFuzzRadius());
	captionPlacementBtn.classList.toggle('is-approx', kind === 'approximate');
	captionPlacementBtn.setAttribute('aria-label',
		`Placement: ${kind === 'approximate' ? `approximate, within about ${getPlacementFuzzRadius()} metres` : 'exact spot'}. Tap to change how this agent's location is stored.`);
}
if (captionPlacementBtn) {
	captionPlacementBtn.onclick = () => { showPlacementConsentSheet(); };
}

async function openCaptionPanel(pinLat, pinLng, headingDeg, source = 'gyro-gps') {
	// Consent gate (H4) — disclose what placing means and let the user choose exact
	// vs approximate before the agent is written. Cancelling here releases the AR
	// lock instead of leaving the user stuck in a locked, half-placed state.
	if (!(await maybeConfirmPlacement())) { setLocked(false); return; }
	if (!captionPanel) {
		commitPin(pinLat, pinLng, headingDeg, '', source);
		return;
	}
	captionInput.value = '';
	refreshCaptionPlacementChip();
	captionPanel.classList.add('is-open');
	focusCaptionWhenOpen();
	const cancel = () => {
		captionPanel.classList.remove('is-open');
		releaseSheet(captionPanel);
		setLocked(false);
	};
	captionConfirm.onclick = () => {
		captionPanel.classList.remove('is-open');
		releaseSheet(captionPanel);
		commitPin(pinLat, pinLng, headingDeg, captionInput.value.trim(), source);
	};
	captionCancel.onclick = cancel;
	// Escape mirrors Cancel (release the AR lock); the caption field manages its
	// own focus via focusCaptionWhenOpen(), so the trap doesn't steal it.
	trapSheet(captionPanel, cancel, { manageFocus: false });
}

function commitPin(pinLat, pinLng, headingDeg, caption, source = 'gyro-gps') {
	// Final origin guard: never persist a pin at null/origin coordinates. The deferred
	// lock and anchorGpsPin()'s gate should make this unreachable, but a pin at 0,0 is
	// corrupt and shared with others — so refuse it and release the lock rather than
	// writing a permanent record at the wrong place.
	if (!Number.isFinite(pinLat) || !Number.isFinite(pinLng)) {
		setStatus('Couldn’t read your location to pin — try again.', { error: true });
		setLocked(false);
		return;
	}
	// Placement consent (H4): in approximate mode fuzz the coordinate HERE, at commit,
	// so the true standing spot is never persisted AND the agent renders at the fuzzed
	// spot for everyone — including the owner (gpsPin below). Precise mode is a no-op.
	const place = applyPlacementKind(pinLat, pinLng);
	pinLat = place.lat;
	pinLng = place.lng;
	gpsPin = { lat: pinLat, lng: pinLng, heightM: 0 };
	// Gyro-GPS placement pose (A2/A3): the agent stands on the floor. anchor_height_m
	// is a floor-relative offset, and gyro placement has no measured floor depth, so
	// it's 0 — every viewer renders the feet on their own ground plane (pinHeightM).
	// yawDeg is the absolute compass heading; source carries the absolute-vs-relative
	// distinction ('gyro-gps' | 'gyro-gps:rel') for A3. accuracy / altitude are filled
	// from the live GPS fix inside savePin().
	const anchor = { heightM: 0, yawDeg: headingDeg, source };
	// Tell the truth about precision: a noisy fix (>25 m) is an approximate spot, not a
	// pinpoint. The exact metres ride the stored gpsAccuracyM (savePin); here we surface
	// a subtle note so the success copy never implies more accuracy than the fix had.
	// An intentionally-approximate placement says so plainly instead of citing the fix.
	const acc = gpsAccuracyBucket(gpsState.accuracy);
	// Only annotate when we have a concrete metres figure to show (skip the unknown
	// bucket, which has no label — no number, nothing honest to add).
	const accNote = place.placementKind === 'approximate'
		? ` · approximate spot (~${place.fuzzRadiusM} m)`
		: acc.precise || !acc.label ? '' : ` · approximate spot (${acc.label})`;
	savePin(pinLat, pinLng, headingDeg, caption, anchor, place).then(result => {
		if (result?.ok && gpsPin) {
			gpsPin.id = result.id;
			_myPinIds.add(result.id);
			const dir = compassLabel(headingDeg);
			setStatus(result.permanent
				? `Pinned facing ${dir}${accNote} — permanently visible to nearby users`
				: `Pinned facing ${dir}${accNote} — others nearby can see you for 7 days`);
			revealMyPinsBtn();
		} else {
			// Rejected (content / area_full / pin_limit / rate / network) — show the
			// designed, actionable message and release the lock so the user can fix it
			// and retry, never a silent dead end.
			setStatus(result?.message || saveErrorFallback(result?.error), { error: true });
			setLocked(false);
		}
	});
}

// ── Place on the map (L2) ──────────────────────────────────────────────────
//
// A privacy-first, remote alternative to "Pin here": instead of writing the
// user's exact standing GPS, they choose a spot on a map and the agent is placed
// there. This path NEVER engages the local AR lock (no gpsPin, no gps-mode) — the
// agent isn't in front of you, it's dropped at the chosen coordinate and surfaces
// to anyone who walks near that spot (and to you here if you happen to be close).
function startMapPlacement() {
	const start = gpsState.ready ? { lat: gpsState.lat, lng: gpsState.lng } : null;
	openMapPlacePicker({
		start,
		onConfirm: ({ lat, lng, label }) => openCaptionForMapPin(lat, lng, label),
	});
}

// Optional caption step for a map-placed pin. Reuses the caption panel UI but
// routes confirm/cancel to the remote commit — cancel just closes (there is no AR
// lock to release, unlike the gyro/GPS caption flow).
async function openCaptionForMapPin(lat, lng, label) {
	// Same consent gate as the GPS path (H4) — a map-placed agent is still a public
	// real-world spot, and approximate placement applies here too. Cancelling just
	// drops out (no AR lock to release on this remote path).
	if (!(await maybeConfirmPlacement())) return;
	if (!captionPanel) { commitMapPin(lat, lng, '', label); return; }
	captionInput.value = '';
	refreshCaptionPlacementChip();
	captionPanel.classList.add('is-open');
	focusCaptionWhenOpen();
	const close = () => { captionPanel.classList.remove('is-open'); releaseSheet(captionPanel); };
	captionConfirm.onclick = () => {
		close();
		commitMapPin(lat, lng, captionInput.value.trim(), label);
	};
	captionCancel.onclick = close;
	// No AR lock to release here — Escape just closes the panel.
	trapSheet(captionPanel, close, { manageFocus: false });
}

async function commitMapPin(lat, lng, caption, label) {
	setStatus('Placing agent…', { loading: true, sticky: true });
	// Apply the placement choice (H4) — approximate fuzzes the chosen point so only
	// the blurred spot is ever stored. precise leaves it untouched.
	const place = applyPlacementKind(lat, lng);
	// source:'map' → the server records a non-GPS, non-compass placement; savePin
	// nulls the GPS accuracy/altitude for it. heading 0 (no live bearing to store).
	const result = await savePin(place.lat, place.lng, 0, caption, { heightM: 0, yawDeg: 0, source: 'map' }, place);
	if (result?.ok) {
		_myPinIds.add(result.id);
		const where = label ? ` at ${label}` : '';
		setStatus(result.permanent
			? `Agent placed${where} — permanently visible to people nearby that spot`
			: `Agent placed${where} — visible to people nearby for 7 days`);
		revealMyPinsBtn();
		// If the chosen spot happens to be near the viewer, surface it immediately
		// instead of waiting for the next proximity poll.
		if (gpsState.ready) loadNearbyPins();
	} else {
		setStatus(result?.message || saveErrorFallback(result?.error), { error: true });
	}
}

// ── WebXR floor anchor (A1) ────────────────────────────────────────────────
//
// On WebXR-capable devices (primarily Android Chrome) the user taps a real
// floor point through a hit-test reticle; the agent binds to a real XRAnchor
// so it stays glued to that world point as the phone moves — no GPS jitter, no
// camera-relative slide. The anchored local pose is converted to a GPS pin and
// persisted through savePin() (A2) so it reloads near the same spot and nearby
// users can see it. iOS Safari (no immersive-ar) never reaches here and stays
// on the gyro+GPS Pin path (A4).

// Viewer shim — the minimal interface WebXRSession drives (see src/xr.js for the
// canonical shape). `content` is the positioned avatar group the anchor glues to.
const xrViewer = {
	renderer,
	scene,
	content: avatarRig,
	controls: { enabled: true },   // stub: IRL drives its own camera, not OrbitControls
	mixer: null,                   // animMgr.update() already advances the mixer — avoid double-stepping
	animationManager: animMgr,
	_afterAnimateHooks: [],
	_rafId: null,
	prevTime: null,
	activeCamera: camera,
	_needsRender: true,
	_updateRenderLoop() { startTick(); },
};

// While an immersive WebXR session runs, ITS loop renders the scene and IRL's
// tick is parked — pins would freeze mid-idle without this hook (the XR loop
// calls each after-animate hook with dt every frame).
xrViewer._afterAnimateHooks.push((dt) => updatePinIdles(dt));

// Single owner of the IRL render loop's RAF handle so WebXRSession can pause it
// (cancelAnimationFrame on xrViewer._rafId) while the XR animation loop runs,
// then resume it on exit via _updateRenderLoop().
function startTick() {
	if (xrViewer._rafId !== null || _renderPaused) return;
	xrViewer._rafId = requestAnimationFrame(tick);
}

// ── Render-loop lifecycle: backgrounding + GPU context loss (task-06) ────────
// IRL is a long-lived single-page session. A backgrounded tab must stop burning
// battery (RAF + camera), and a lost WebGL context (the OS reclaiming GPU memory,
// common on mobile after the tab idles) must recover instead of leaving a silent
// black canvas. Both pause the same render loop; resume rebuilds only what the GPU
// dropped.
let _renderPaused = false;   // RAF intentionally stopped (tab hidden or context lost)
let _contextLost  = false;   // true between webglcontextlost and …restored

// Stop the render loop without tearing down any session/AR state. The in-flight
// tick (if one is mid-execution) finishes, then declines to reschedule.
function pauseRender() {
	if (_renderPaused) return;
	_renderPaused = true;
	if (xrViewer._rafId !== null) { cancelAnimationFrame(xrViewer._rafId); xrViewer._rafId = null; }
}

// Resume the loop. No-ops before the loop ever started (ensureTick owns first
// start) and while the context is still lost (rendering to a dead context is
// pointless). dt is clamped in tick(), so the first resumed frame never jumps.
function resumeRender() {
	if (!_renderPaused) return;
	// Don't start IRL's own loop while it's still lost, before boot, or during an
	// immersive WebXR session (which drives its own animation loop — IRL's tick is
	// intentionally parked then). The clear of _renderPaused still happens so a later
	// XR exit / context restore resumes through the normal path.
	if (_contextLost || !_tickStarted || xrSession) { _renderPaused = false; return; }
	_renderPaused = false;
	startTick();
}

// Quiet the camera while hidden: disabling the track stops frame production (and
// the sensor churn / battery cost) and is instantly reversible — no re-prompt, no
// getUserMedia round-trip, unlike track.stop(). Pausing the <video> stops decode.
function setCameraQuiet(quiet) {
	if (!mediaStream) return;
	for (const t of mediaStream.getVideoTracks()) { try { t.enabled = !quiet; } catch {} }
	if (quiet) { try { videoEl.pause(); } catch {} }
	else { videoEl.play?.().catch(() => { /* autoplay policy — frames still arrive */ }); }
}

// The GPU dropped every uploaded resource on context loss. three.js re-uploads
// geometries/materials/textures lazily on the next render, but resources it can't
// reach from the scene graph — the PMREM environment map and each pin's baked
// impostor render target — are blank now and must be rebuilt explicitly.
function rebuildAfterContextRestore() {
	try {
		const prevEnv = scene.environment;
		scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
		prevEnv?.dispose?.();
	} catch (e) {
		log.warn('[irl] environment rebuild after context restore failed:', e);
	}
	// Baked impostor snapshots are empty framebuffers now — drop them and reset each
	// pin's band so enforceLOD re-bakes/re-mounts from scratch on its next pass.
	for (const pin of nearbyPins) {
		disposeImpostor(pin);
		pin._lod = null;
		if (pin.group) showDot(pin);
	}
	applyTierToRenderer();
}

canvas.addEventListener('webglcontextlost', (e) => {
	// Without preventDefault the context is gone permanently and the canvas stays
	// black. Claim it so the browser will fire webglcontextrestored when it can.
	e.preventDefault();
	_contextLost = true;
	pauseRender();
	setCameraQuiet(true);
	showErrorState({
		title: 'AR paused',
		body: 'The graphics context was lost — the device reclaimed GPU memory. Restoring…',
		actionLabel: 'Reload AR',
		// Manual escape hatch if the browser never auto-restores: a full reload
		// rebuilds the scene cleanly. If restore already fired, just dismiss.
		onAction: () => { if (_contextLost) location.reload(); else hideErrorState(); },
	});
}, false);

canvas.addEventListener('webglcontextrestored', () => {
	_contextLost = false;
	rebuildAfterContextRestore();
	hideErrorState();
	if (!document.hidden) { setCameraQuiet(false); resumeRender(); }
}, false);

// Backgrounded tab: pause the loop + quiet the camera; resume cleanly on return.
document.addEventListener('visibilitychange', () => {
	if (document.hidden) {
		pauseRender();
		setCameraQuiet(true);
	} else if (!_contextLost) {
		setCameraQuiet(false);
		resumeRender();
	}
});

let xrSession = null;
// The room-authoring API (src/irl/room-mode.js), captured from initRoomMode below.
// The WebXR floor path reads it to anchor a hit into the active room (or establish
// one) and to bump the room badge — so on-device precision and the gyro slider flow
// always share one room. Assigned at init; only referenced after a user gesture.
let roomModeApi = null;
// The marker-authoring API (src/irl/marker-mode.js), captured from initMarkerMode
// below — the indoor visual-colocalization path. Assigned at init.
let markerModeApi = null;
// The room pin currently being sharpened by a WebXR "Refine on floor" session, or
// null for a normal placement. onFloorAnchored routes the tap to refine when set;
// enterFloorPlacement clears it so a plain "Place on floor" never re-targets a stale
// pin. Bounds-checked server-side — refine only sharpens this one agent's offset.
let _refinePin = null;
// Pinch-resize state for the live WebXR session. _xrScale is the current uniform
// scale the user pinched to (1 = natural); it rides into the pin persisted on the
// placement tap. A pinch AFTER the tap (the usual order — place first, then size)
// lands as an owner-gated PATCH against _xrPlacedPinId, so the final size always
// wins no matter which order the gestures happened in.
let _xrScale = 1;
let _xrPlacedPinId = null;

function onXrScaled(scale, { final } = {}) {
	_xrScale = scale;
	setXrResting(`Size ${Math.round(scale * 100)}% — pinch to resize`);
	if (!final || !_xrPlacedPinId) return;
	const pinId = _xrPlacedPinId;
	fetch('/api/irl/pins', {
		method: 'PATCH', credentials: 'include',
		headers: deviceHeaders({ 'Content-Type': 'application/json' }),
		body: JSON.stringify({ id: pinId, deviceToken: _deviceToken, scale }),
	}).then((r) => {
		if (!r.ok) { setXrResting('Placed — the new size couldn’t be saved, pinch again to retry'); return; }
		// Commit onto the live local pin so the size holds after the session ends
		// (the XR exit restores the avatar rig itself to its pre-AR transform).
		const pin = nearbyPins.find((p) => p.id === pinId);
		if (pin) {
			pin.anchor_scale = scale;
			if (pin.group && pin._spawnT >= SPAWN_DURATION) pin.group.scale.setScalar(pinScale(pin));
		}
		setXrResting(`Saved at ${Math.round(scale * 100)}% size — nearby viewers see it this big too`);
	}).catch(() => {
		setXrResting('Placed — the new size couldn’t be saved (offline?), pinch again to retry');
	});
}

// A floor anchor placed before the first GPS fix is held here and persisted the
// instant onGPSPosition() lands real coordinates (mirrors _pendingGpsLock for the
// gyro path). The in-session XRAnchor already glues the agent; this rescues its
// durable, shareable pin from a quick tap during GPS warm-up. The gate owns the
// "save exactly once" guarantee: place() holds or saves, onFix() drains a held
// pose a single time, drop() discards one abandoned on exit — so no code path can
// double-save, skip the save, or persist a placement the user walked away from.
const floorPersist = createPersistGate((payload) => persistFloorAnchor(payload.pose, payload.degraded));

// Coordinated XR hint priority so transient lifecycle states (backgrounding,
// tracking loss) never clobber — or get clobbered by — the placement copy.
// Highest active state wins: paused > tracking-lost > the latest resting message,
// which walks the placement arc searching → aiming → placed → saved. Every callback
// funnels through here instead of calling setXrHint directly, so the displayed line
// is always the single most important thing the user needs to know right now.
const SEARCHING_HINT = 'Sweep your phone slowly to find the floor';
const xrHintState = { paused: false, trackingLost: false, resting: SEARCHING_HINT };

function renderXrHint() {
	if (xrHintState.paused) setXrHint('Paused — bring the app forward to keep placing');
	else if (xrHintState.trackingLost) setXrHint('Lost the room — move to a brighter, more textured spot');
	else setXrHint(xrHintState.resting);
}

// Update the resting (placement-progress) line and re-render under current priority.
function setXrResting(text) { xrHintState.resting = text; renderXrHint(); }

// Reveal/clear the ✓ confirm affordance on the hint pill (paired with the in-scene
// pulse + haptic from WebXRSession). Idempotent; safe when the bar is absent.
function setXrConfirmed(on) { if (xrBarEl) xrBarEl.classList.toggle('is-anchored', !!on); }

// Reset the priority machine (and the confirm ✓) for a fresh session entry.
function resetXrHint() {
	xrHintState.paused = false;
	xrHintState.trackingLost = false;
	xrHintState.resting = SEARCHING_HINT;
	setXrConfirmed(false);
	renderXrHint();
}

// The placement path this device can deliver, resolved once on load. Drives both
// the button's visibility/label and which entry handler its click runs.
let _placementCapability = 'pin';

async function detectFloorAnchorSupport() {
	try {
		_placementCapability = await resolvePlacementCapability();
	} catch {
		_placementCapability = 'pin';
	}
	if (!anchorBtn) return;
	// No AR surface (older Android, desktop, locked-down WebView) → keep the button
	// hidden; the Pin button (A4 gyro+GPS) remains the placement, exactly as before.
	if (_placementCapability === 'pin') return;
	// 'Place on floor' is the same label everywhere (one mental model); only the
	// accessible description differs, since iOS opens the system AR viewer (Quick
	// Look) rather than placing inside our canvas.
	anchorBtn.setAttribute('aria-label', _placementCapability === 'quicklook'
		? 'View your agent on the floor in AR (iOS Quick Look)'
		: 'Place agent on the floor with AR');
	// This device has a true AR surface — lead with it. The gyro Pin path stays
	// one pill away, but the flagship placement should be the first thing seen.
	const row = anchorBtn.parentElement;
	row?.prepend(anchorBtn);
	anchorBtn.hidden = false;
	// Capability detection resolves after first layout, so this prepend lands in a
	// scroll strip the browser has already laid out. Return it to its start once the
	// new pill has been measured, or the lead action sits off the left edge unseen.
	if (row) requestAnimationFrame(() => { row.scrollLeft = 0; });
}

function setXrHint(text) {
	if (xrHintEl) {
		xrHintEl.textContent = text;
		xrHintEl.hidden = false;
	}
}

function clearXrError() {
	const mount = $('irl-xr-error');
	if (mount) { mount.replaceChildren(); mount.hidden = true; }
}

function showXrError(err) {
	const denied = err?.name === 'NotAllowedError' || err?.name === 'SecurityError';
	const body = denied
		? 'Camera and motion access are needed to place your agent on the floor. Allow them in your browser, then retry — or use Pin here for compass + GPS placement.'
		: 'Your device couldn’t hold an AR session. Retry, or use Pin here to place with compass + GPS instead.';
	const mount = $('irl-xr-error');
	if (xrOverlay && mount) {
		if (xrHintEl) xrHintEl.hidden = true;
		mount.replaceChildren(errorStateEl({
			title: 'Floor anchoring couldn’t start',
			body,
			actions: [
				{ label: 'Retry', id: 'xr-retry', primary: true },
				{ label: 'Use Pin instead', id: 'xr-pin' },
			],
		}));
		mount.hidden = false;
		xrOverlay.hidden = false;
	} else {
		setStatus('Floor anchoring couldn’t start — use Pin here instead', { error: true, sticky: true });
	}
}

async function enterFloorAnchor() {
	// Block while a prior camera/XR handoff is still settling — a fast double-tap, or
	// a tap during disableAR → session start, must not start a second session or
	// re-acquire the camera underneath this one.
	if (_arTransitioning) return;
	// Re-tapping the button once the session is fully live toggles it off. (Mid-startup
	// the guard above already absorbed the tap, so this only ever ends a started
	// session — never a half-built one.)
	if (xrSession) { await xrSession.end(); return; }
	_arTransitioning = true;
	// immersive-ar owns the rear camera and the full screen; release the
	// getUserMedia passthrough first so the two don't contend for the camera.
	// Remember whether the user was in camera-AR so we can put them back there on
	// exit — returning to a black/gradient view would feel like a crash.
	const resumeAR = arActive;
	// The immersive WebXR session takes sole ownership of the camera — stop the marker
	// scan loop (which reads getUserMedia frames) so the two never contend for it.
	markerModeApi?.exit?.();
	if (arActive) disableAR();

	clearXrError();
	if (anchorBtn) anchorBtn.classList.add('is-active');
	if (xrOverlay) xrOverlay.hidden = false;
	resetXrHint();
	// Fresh session, fresh size: the pinch composes from natural scale, and there
	// is no placed pin yet for a resize PATCH to target.
	_xrScale = 1;
	_xrPlacedPinId = null;

	let failedStart = false;
	try {
		xrSession = new WebXRSession(xrViewer, {
			domOverlayRoot: xrOverlay,
			onHit: (has) => setXrResting(has ? 'Looks good — tap to place, pinch to resize' : SEARCHING_HINT),
			// Tracking loss / recovery is a transient, higher-priority overlay on the
			// resting hint — recoverable, self-clearing, never a dead reticle.
			onTracking: (ok) => { xrHintState.trackingLost = !ok; renderXrHint(); },
			// Backgrounding (lock, call, app switch) pauses the session; show a
			// resume hint and restore the resting line when foregrounded again.
			onVisibility: (visible) => { xrHintState.paused = !visible; renderXrHint(); },
			onAnchored: (pose, meta) => onFloorAnchored(pose, meta),
			// Two-finger pinch resizes the agent live; the final value persists onto
			// the placed pin (or rides into the tap's pin when sized before placing).
			onScale: (scale, meta) => onXrScaled(scale, meta),
			onEnd: () => {
				xrSession = null;
				// Drop any anchor still waiting on a GPS fix — the user left this
				// placement, so don't surprise them with a pin saved after they walk
				// away (parity with the gyro path's arActive gate).
				floorPersist.drop();
				// WebXRSession restored an OPAQUE clear color on exit (_handleEnd); IRL
				// always renders the canvas transparent (alpha:true) over the page
				// gradient or the camera feed. Re-assert transparent + the ground that
				// matches the mode we return to, so passthrough resumes rather than a
				// black fill.
				renderer.setClearColor(0x000000, 0);
				scene.background = null;
				if (anchorBtn) anchorBtn.classList.remove('is-active');
				if (xrOverlay) xrOverlay.hidden = true;
				if (resumeAR) {
					// Returning to camera-AR: show the soft passthrough contact shadow
					// now; enableAR() re-acquires the stream and finishes the rest (FOV,
					// status) async. enableAR() no-ops if a failed start left the guard
					// raised — the post-settle resume below covers that case.
					groundOpaque.visible = false;
					groundShadow.visible = true;
					enableAR();
				} else {
					// Back to the plain 3D view: opaque ground, no passthrough shadow.
					groundOpaque.visible = true;
					groundShadow.visible = false;
				}
			},
		});
		await xrSession.start();
		setStatus('Floor anchoring on — find the floor, then tap to place your agent');
	} catch (err) {
		log.error('[irl] WebXR start failed:', err);
		failedStart = true;
		// A session that created its XRSession but threw mid-setup never reached
		// setAnimationLoop, so its 'end' (→ onEnd) won't fire on its own. Tear it down
		// explicitly so we don't leak a live immersive session, and reset the renderer
		// state it touched (xr.enabled was set true before requestSession; an opaque
		// clear color restored on its 'end'). The IRL RAF kept running through the
		// failure, so the scene stays live — never frozen.
		const failed = xrSession;
		xrSession = null;
		if (failed) { try { await failed.end(); } catch {} }
		renderer.xr.enabled = false;
		renderer.setClearColor(0x000000, 0);
		scene.background = null;
		if (anchorBtn) anchorBtn.classList.remove('is-active');
		if (xrOverlay) xrOverlay.hidden = true;
		showXrError(err);
	} finally {
		_arTransitioning = false;
	}
	// Resume camera-AR once the guard has cleared. On a failed start, onEnd's own
	// resume was suppressed by the still-raised guard (when the session reached
	// _handleEnd), or onEnd never fired (requestSession rejected) — either way the
	// entry attempt must not be one-way. No-op on success or when there was no AR to
	// return to; enableAR() re-checks every precondition.
	if (failedStart && resumeAR && !arActive && !xrSession) enableAR();
}

// Entry point for a placed floor anchor: persist it now if we have a GPS fix,
// otherwise hold the pose until the first fix lands. The in-session XRAnchor
// already glues the agent either way — this only governs the durable pin. `meta`
// carries the degraded flag (no real XRAnchor) so we tell the user the truth.
function onFloorAnchored(pose, meta = {}) {
	const degraded = meta.degraded === true;
	// The DOM half of the confirm beat: light the ✓ on the hint pill the instant the
	// tap takes (the in-scene pulse + haptic fire from WebXRSession). It rides every
	// downstream copy change until the session resets.
	setXrConfirmed(true);
	// Refine-on-floor (R3): the tap re-places ONE existing room agent rather than
	// dropping a new one. Consume the target latch and PATCH the single agent's offset
	// — bypassing the new-pin persist gate entirely (the agent already exists).
	if (_refinePin) {
		const target = _refinePin;
		_refinePin = null;
		refineFloorAnchored(target, pose);
		return;
	}
	// The gate decides: with a live fix it persists now; during GPS warm-up it
	// holds the pose (degraded flag rides along) and onGPSPosition drains it once.
	const outcome = floorPersist.place({ pose, degraded }, gpsState.ready);
	if (outcome === 'held') {
		// The anchor still glues the agent in-session; we just can't convert it to a
		// GPS pin yet. A quick tap during GPS warm-up should still persist, not vanish.
		setXrResting(degraded
			? 'Placed — saving this spot once your location locks in (may drift on this device)'
			: 'Placed — saving this spot the moment your location locks in');
	}
	// outcome === 'persisted' → persistFloorAnchor set the resting hint already.
}

// Persist a WebXR floor placement as a shared ROOM pin (R3). The hit-test gives a
// metres-from-eye-level local pose; we fold the placer's GPS offset from the room
// origin into it and store the EXACT room-frame offset (relEast/relNorth) + the real
// floor height + the surface quaternion, tagged `anchor_source: 'webxr'`. The agent
// then renders for every viewer through the same shared frame as a gyro placement —
// WebXR only improved WHERE it was captured. If the user reached "Place on floor"
// without entering room mode, we establish a room at the current fix first, so a
// WebXR drop is never a one-off standalone pin. Split out so onGPSPosition() can
// replay a pose captured before the first fix; the gate guarantees gpsState.ready.
// `degraded` (no real XRAnchor) only changes the in-session honesty copy.
function persistFloorAnchor(pose, degraded = false) {
	const { position, quaternion } = pose;
	const quat = [quaternion.x, quaternion.y, quaternion.z, quaternion.w];

	// Establish (or reuse) the shared room this precise placement anchors into. The
	// compass frame matches the gyro path's getHeading dep: true compass when present,
	// else camera-yaw, with prefersAbsOrientation deciding the true-north frame.
	const headingDeg = lastCompassHeading != null
		? lastCompassHeading
		: ((-(cameraYaw * 180 / Math.PI)) % 360 + 360) % 360;
	const room = roomModeApi?.ensureRoom({
		lat: gpsState.lat, lng: gpsState.lng,
		headingDeg, absolute: !!prefersAbsOrientation,
	});
	if (!room) {
		// Behind the persist gate gpsState.ready is true, so this is defensive only:
		// never strand the tap — the in-session anchor still holds the agent.
		setXrResting('Placed — couldn’t lock your location to save it; move to a clearer sky and retry');
		return;
	}

	// Pure, unit-tested conversion (src/irl/floor-anchor.js): XR hit pose → exact
	// offset in the room frame + the absolute lat/lng GPS index + heading from the quat.
	const placement = roomPlacementFromHit({
		originLat: room.originLat, originLng: room.originLng, originYawDeg: room.originYawDeg || 0,
		viewerLat: gpsState.lat, viewerLng: gpsState.lng,
		x: position.x, y: position.y, z: position.z, quat,
	});

	setXrResting(placementHint(degraded));
	postRoomPin({
		lat: placement.lat, lng: placement.lng, heading: placement.relYawDeg,
		room: {
			id: room.id, originLat: room.originLat, originLng: room.originLng,
			originYawDeg: room.originYawDeg || 0,
			relEast: placement.relEast, relNorth: placement.relNorth,
		},
		anchor: {
			heightM: placement.heightM, yawDeg: placement.relYawDeg, quat: placement.quat,
			gpsAccuracyM: gpsState.accuracy, altitudeM: gpsState.altitude, source: 'webxr',
			scale: _xrScale,
		},
	}).then(result => {
		if (result?.ok) {
			// Later pinches in this session resize THIS pin (owner-gated PATCH).
			_xrPlacedPinId = result.id;
			roomModeApi?.notePlacement();
			setXrResting(result.permanent
				? 'Saved on the floor — pinch to resize; your agent is here for everyone nearby'
				: 'Saved on the floor — pinch to resize; people nearby can see your agent for 7 days');
		} else {
			// Surface the moderation/cap/rate reason; the in-session anchor still holds.
			setXrResting(result?.message || 'Placed — couldn’t save the pin yet, retry on exit');
		}
	});
}

// Re-place ONE existing room agent from a fresh WebXR hit (R3 "refine on floor").
// Converts the hit to the SAME room's frame (the agent's stored origin, never a new
// one) and PATCHes only this agent's rel offset + floor height + facing — the shared
// origin is untouched, so the cluster stays put and only the local view sharpens.
// Bounds are enforced server-side; an over-large move is rejected with the existing
// 422 copy. The session stays open on the sharpened agent; the user exits when ready.
function refineFloorAnchored(pin, pose) {
	if (!gpsState.ready) { setXrResting('Waiting for your location to refine — hold still a moment'); return; }
	const room = pinRoom(pin);
	if (!room) { setXrResting('This agent isn\u2019t in a room — exit and use Calibrate instead'); return; }
	const { position, quaternion } = pose;
	const placement = roomPlacementFromHit({
		originLat: room.originLat, originLng: room.originLng, originYawDeg: room.originYawDeg,
		viewerLat: gpsState.lat, viewerLng: gpsState.lng,
		x: position.x, y: position.y, z: position.z,
		quat: [quaternion.x, quaternion.y, quaternion.z, quaternion.w],
	});
	setXrResting('Sharpening this agent\u2019s spot\u2026');
	const body = { id: pin.id, deviceToken: _deviceToken, calibrate: {
		lat: placement.lat, lng: placement.lng,
		anchorYawDeg: placement.relYawDeg, anchorHeightM: placement.heightM,
		relEast: placement.relEast, relNorth: placement.relNorth,
	} };
	fetch('/api/irl/pins', {
		method: 'PATCH', credentials: 'include',
		headers: deviceHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(body),
	}).then(async (r) => {
		if (!r.ok) {
			const msg = r.status === 403 ? 'Only the owner can refine this agent.'
				: r.status === 422 ? 'That\u2019s too far from the agent\u2019s spot — refine sharpens a placement, it doesn\u2019t move it across the room.'
				: r.status === 404 ? 'This agent is no longer here.'
				: 'Couldn\u2019t save the refined spot — try again.';
			setXrResting(msg);
			return;
		}
		// Commit the sharpened offset onto the live pin so it re-renders at once and
		// every nearby viewer picks it up on their next proximity poll (~10 s).
		pin.rel_east_m = placement.relEast;
		pin.rel_north_m = placement.relNorth;
		pin.lat = placement.lat; pin.lng = placement.lng;
		pin.anchor_height_m = placement.heightM;
		pin.anchor_yaw_deg = placement.relYawDeg; pin.heading = Math.round(placement.relYawDeg);
		pin.anchor_quat = placement.quat;
		if (pin.group && gpsState.ready) {
			const wp = pinWorldPos(pin);
			pin.group.position.set(wp.x, wp.y, wp.z);
			pin.group.rotation.y = pinYawRad(pin);
			if (pin.baseYaw != null) pin.baseYaw = pin.group.rotation.y;
		}
		setXrResting('Refined — saved here; nearby viewers update within ~10s. Tap exit when you\u2019re done.');
		try { navigator.vibrate?.(12); } catch {}
		loadNearbyPins();
	}).catch(() => {
		setXrResting('Couldn\u2019t reach the server — exit and try again.');
	});
}

// Enter a WebXR floor session aimed at refining ONE existing room agent. Latches the
// target so the next tap routes to refineFloorAnchored, then reuses the same hit-test
// session as placement. WebXR-only and owner-only — gated where the entry is offered.
function enterRefineOnFloor(pin) {
	if (_placementCapability !== 'webxr' || !pin) return;
	_refinePin = pin;
	enterFloorAnchor();
}

// ── iOS AR Quick Look (capability 'quicklook') ─────────────────────────────
//
// ARKit Quick Look needs a USDZ. Prefer the server-hosted companion the avatar
// record carries (presign-usdz pipeline); otherwise convert the GLB we already
// loaded for this avatar to USDZ in-browser (src/usdz-pipeline.js → three's
// USDZExporter), cache the blob URL by source GLB, and reuse it for the session.
// The same client-side export model-viewer ships, so a blob: URL drives Quick
// Look on modern Safari. Real conversion, real model — never a hidden button.
async function resolveQuickLookUrl() {
	if (_currentUsdzUrl) return _currentUsdzUrl;
	const glbUrl = _currentGlbUrl || resolveAvatarUrl(_currentAvatarId);
	if (_usdzObjectUrl && _usdzObjectUrlFor === glbUrl) return _usdzObjectUrl;
	const res = await fetch(glbUrl);
	if (!res.ok) throw new Error(`GLB fetch failed: ${res.status}`);
	const glbBlob = await res.blob();
	const usdzBlob = await bakeQuickLookUsdz(glbBlob);
	if (_usdzObjectUrl) URL.revokeObjectURL(_usdzObjectUrl);
	_usdzObjectUrl = URL.createObjectURL(usdzBlob);
	_usdzObjectUrlFor = glbUrl;
	return _usdzObjectUrl;
}

// Prefer a living, animated avatar in Quick Look (same policy as /ar): bake the
// idle clip into the USDZ so the agent breathes on the real floor instead of
// standing frozen in its bind pose. Fall back to the static bake if the rig
// can't take the clip or the animation fetch fails — animation is upside,
// never a gate.
async function bakeQuickLookUsdz(glbBlob) {
	try {
		const { glbBlobToAnimatedUsdzBlob, DEFAULT_AR_ANIMATION } = await import('./usdz-animated.js');
		const animResp = await fetch(DEFAULT_AR_ANIMATION);
		if (!animResp.ok) throw new Error(`animation fetch ${animResp.status}`);
		const animationGlbBlob = await animResp.blob();
		return await glbBlobToAnimatedUsdzBlob(glbBlob, { animationGlbBlob });
	} catch (err) {
		log.warn('[irl] animated USDZ unavailable, using static:', err?.message);
		const { glbBlobToUsdzBlob } = await import('./usdz-pipeline.js');
		return glbBlobToUsdzBlob(glbBlob);
	}
}

async function enterQuickLookPlacement() {
	if (anchorBtn) { anchorBtn.classList.add('is-active'); anchorBtn.disabled = true; }
	setStatus('Preparing your agent for AR…', { loading: true, sticky: true });
	try {
		const usdzUrl = await resolveQuickLookUrl();
		openQuickLook(usdzUrl);
		// Quick Look is a separate system viewer — it places-and-views the agent on
		// your real floor but can't hand a pose back to our canvas, so the durable,
		// shareable pin still comes from the Pin path. State that, no silent gap.
		setStatus('Opening AR — point at your floor to place your agent. To leave a shareable pin nearby people can find, tap Pin here.', { sticky: true });
	} catch (err) {
		log.error('[irl] Quick Look prep failed:', err);
		setStatus('Couldn’t prepare AR for this agent — use Pin here for compass + GPS placement instead.', { error: true, sticky: true });
	} finally {
		if (anchorBtn) { anchorBtn.classList.remove('is-active'); anchorBtn.disabled = false; }
	}
}

// One button, capability-routed: iOS opens AR Quick Look; WebXR devices enter the
// in-canvas hit-test session. ('pin' devices never reach here — the button stays
// hidden and the Pin path is the placement.)
function enterFloorPlacement() {
	// A plain "Place on floor" drops a NEW agent — clear any refine target a prior,
	// exited-without-tapping refine session left latched, so this never re-places an
	// old agent instead of creating one.
	_refinePin = null;
	if (_placementCapability === 'quicklook') return enterQuickLookPlacement();
	return enterFloorAnchor();
}

if (anchorBtn) anchorBtn.addEventListener('click', enterFloorPlacement);
if (xrExitBtn) xrExitBtn.addEventListener('click', () => { xrSession?.end(); });
// Taps on the overlay chrome (hint, exit, error actions) must not also fire the
// XR 'select' that places an anchor.
if (xrOverlay) {
	xrOverlay.addEventListener('beforexrselect', (e) => e.preventDefault());
	xrOverlay.addEventListener('click', (e) => {
		const action = e.target.closest('[data-sk-action]')?.dataset.skAction;
		if (action === 'xr-retry') { clearXrError(); enterFloorAnchor(); }
		else if (action === 'xr-pin') { clearXrError(); xrOverlay.hidden = true; setLocked(true); }
	});
}

// Composite share — flatten the camera feed (when AR is on) under the 3D canvas
// into one PNG and offer it through the native share sheet, desktop download, or
// URL/clipboard fallback. Shared module so /irl and /xr never drift; the renderer
// is built with preserveDrawingBuffer:true so the canvas reads back non-blank.
wireShareButton($('irl-share-btn'), {
	getCanvas: () => canvas,
	getVideo:  () => videoEl,
	getIsAR:   () => arActive,
	filename:  'three-ws-irl.png',
	title:     'IRL · three.ws',
});

// ── Nearby agents ─────────────────────────────────────────────────────────
let nearbyPins = []; // [{ id, lat, lng, avatar_url, avatar_name, caption, x402_endpoint, distance_m, group, labelEl, glbLoaded }]
// Set true when the last nearby fetch failed; cleared on the next good fetch, so
// a failed refresh shows a visible indicator on the badge instead of going silent.
let _nearbyError = false;
// Set true on a 429 from the nearby read — a calm, auto-recovering "catching up"
// state distinct from the scary error badge (the next poll clears it). The limiter
// is generous, so this is rare, but it must never read as "discovery is broken".
let _nearbyRateLimited = false;
// Location is granted and the GPS watch is attached, but no first fix has landed
// yet. A distinct "finding you" state so the gap before the first fix is never
// mistaken for "nobody's here." Cleared the instant gpsState.ready flips true.
let _gpsAcquiring = false;
// True once the first proximity read has returned. The window between the GPS fix
// landing and that read resolving is still "looking around", NOT empty — gating the
// empty state on this stops a premature "0 nearby" / "be the first" flash before we
// actually know whether anyone is here. Set on the first completed read; never reset.
let _nearbyLoaded = false;

// ── "Newly stable in-range" signal (task 04 → task 03) ──────────────────────
// The hysteresis band (proximity-band.js) makes membership steady: a pin only
// joins `nearbyPins` once it has genuinely crossed the tight ENTER gate, and it
// can't leave until it's been out-of-band for DROP_POLLS *consecutive* polls. So
// the single moment the band promotes a pin from not-rendered → the stable set
// (the band's 'spawn' action below) is exactly one clean, debounced arrival — it
// never re-fires while a steady agent jitters at the edge, because a rendered pin
// is never re-spawned. Task 03's proximity-arrival cue consumes this: it gets one
// callback per agent the viewer has genuinely walked up to, never a flicker storm.
//
// A subscriber registry (not a single hook) so other surfaces can listen too
// without fighting over one slot; emission is fire-and-forget and never lets a
// listener throw into the membership reconcile. Subscribing returns an unsubscribe.
const _pinStableListeners = new Set();
function onPinStable(listener) {
	if (typeof listener !== 'function') return () => {};
	_pinStableListeners.add(listener);
	return () => { _pinStableListeners.delete(listener); };
}
function emitPinStable(pin) {
	if (!_pinStableListeners.size) return;
	for (const listener of _pinStableListeners) {
		try { listener(pin); }
		catch (err) { log.error('[irl] pin-stable listener failed:', err); }
	}
}

// ── Proximity-arrival cue + non-map directional hint (task 03) ──────────────
// We deleted the list and the radar on purpose: a pin's location is private and
// you find an agent only by physically walking into its ~40 m bubble. The cost is
// that you can be 15 m away, facing the wrong way, and never know. This is the cue
// that fixes it — the in-world equivalent of hearing a sound nearby. When the
// hysteresis band promotes a genuinely new agent into range (emitPinStable, task
// 04), we fire a quiet, rate-limited burst: an optional haptic, an optional soft
// chime, and an aria-live "look around" banner — then a soft edge glow points
// toward the nearest in-range agent and fades the moment you turn to face it. The
// hint reveals a *direction*, never a list or a coordinate (proximity-cue.js).
//
// Sound is opt-out (a persisted mute toggle) and the WebAudio context is only ever
// resumed on the camera-start tap (unlockArrivalAudio), so there is never an
// autoplay-policy warning. The animated glow honours prefers-reduced-motion.

const CUE_MUTE_KEY = 'irl_cue_muted_v1';
let _cueMuted = (() => { try { return localStorage.getItem(CUE_MUTE_KEY) === '1'; } catch { return false; } })();
let _lastCueAt = null;          // ms of the last fired cue (global cooldown)
let _audioCtx = null;           // lazily created, resumed on the camera gesture
let _audioUnlocked = false;

// Resume / create the WebAudio context inside a real user gesture so the chime is
// never an autoplay violation. Called from the camera-start tap (the same gesture
// that grants camera + motion), and idempotent.
function unlockArrivalAudio() {
	if (_audioUnlocked) { _audioCtx?.resume?.().catch(() => {}); return; }
	const Ctx = window.AudioContext || window.webkitAudioContext;
	if (!Ctx) return; // no WebAudio — haptic + banner still fire
	try {
		_audioCtx = new Ctx();
		_audioCtx.resume?.().catch(() => {});
		_audioUnlocked = true;
	} catch { _audioCtx = null; }
}

// A short, quiet two-note chime — a gentle "✨" rather than a notification ping.
// Synthesised (no asset to load/decode), gated by the mute toggle and a live,
// unlocked context. Two sine partials with a fast attack + soft exponential decay.
function playArrivalChime() {
	if (_cueMuted || !_audioCtx || _audioCtx.state === 'closed') return;
	try {
		const ctx = _audioCtx;
		const now = ctx.currentTime;
		const master = ctx.createGain();
		master.gain.setValueAtTime(0.0001, now);
		master.gain.exponentialRampToValueAtTime(0.16, now + 0.012);
		master.gain.exponentialRampToValueAtTime(0.0001, now + 0.9);
		master.connect(ctx.destination);
		// Two ascending notes (a major sixth) for a friendly, non-alarming arrival.
		[[659.25, 0], [987.77, 0.11]].forEach(([freq, at]) => {
			const osc = ctx.createOscillator();
			const g = ctx.createGain();
			osc.type = 'sine';
			osc.frequency.setValueAtTime(freq, now + at);
			g.gain.setValueAtTime(0.0001, now + at);
			g.gain.exponentialRampToValueAtTime(1, now + at + 0.02);
			g.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.5);
			osc.connect(g); g.connect(master);
			osc.start(now + at);
			osc.stop(now + at + 0.55);
		});
	} catch { /* audio is a flourish — never let it break discovery */ }
}

// Persisted mute toggle (topbar button #irl-cue-mute). Reflects state into the
// button's aria-pressed + icon so it's an honest, accessible control.
function setCueMuted(muted) {
	_cueMuted = !!muted;
	try { localStorage.setItem(CUE_MUTE_KEY, _cueMuted ? '1' : '0'); } catch {}
	syncCueMuteButton();
}
function syncCueMuteButton() {
	const btn = document.getElementById('irl-cue-mute');
	if (!btn) return;
	btn.setAttribute('aria-pressed', _cueMuted ? 'true' : 'false');
	btn.classList.toggle('is-muted', _cueMuted);
	btn.setAttribute('aria-label', _cueMuted ? 'Arrival sound off — tap to unmute' : 'Arrival sound on — tap to mute');
	btn.title = _cueMuted ? 'Arrival sound off' : 'Arrival sound on';
	const sub = document.getElementById('irl-cue-mute-sub');
	if (sub) sub.textContent = _cueMuted ? 'Off — tap to turn back on' : 'On — plays when an agent enters range';
}

// The transient "look around" banner. aria-live polite so a screen reader announces
// the arrival without stealing focus; auto-dismisses, and a fresh arrival restarts
// the timer rather than stacking banners.
let _cueBannerTimer = null;
function showArrivalBanner() {
	const el = document.getElementById('irl-arrival-cue');
	if (!el) return;
	el.textContent = 'An agent is near — look around';
	el.classList.add('is-visible');
	el.hidden = false;
	clearTimeout(_cueBannerTimer);
	_cueBannerTimer = setTimeout(() => {
		el.classList.remove('is-visible');
		// Keep it in the DOM (hidden) so the next arrival re-announces cleanly.
		setTimeout(() => { if (!el.classList.contains('is-visible')) el.hidden = true; }, 320);
	}, 4200);
}

// Fire the full arrival cue for a freshly-in-range agent: haptic (where supported),
// chime (unless muted), and the banner. Rate-limited by shouldCueArrival so a busy
// corner where several agents drift in at once buzzes once, not like a slot machine.
function fireArrivalCue() {
	const now = Date.now();
	if (!shouldCueArrival(now, _lastCueAt)) return;
	_lastCueAt = now;
	// Haptic — guarded; iOS Safari and many desktops ignore vibrate() entirely, so
	// it's a bonus, never the cue. A short double-tap reads as "notice me".
	try { navigator.vibrate?.([18, 40, 18]); } catch {}
	playArrivalChime();
	showArrivalBanner();
	// Flash the arrival on paired glasses too (no-op when none connected).
	glassesBridge.announce('Agent nearby — look around');
}

onPinStable(() => fireArrivalCue());

// ── Directional nudge (non-map "that way" hint) ─────────────────────────────
// A soft glow + arrow pinned to the screen edge pointing toward the NEAREST
// in-range agent's current screen-relative bearing (recomputed every frame from
// cameraYaw + the agent's world offset, so it tracks live as the user rotates). It
// fades the instant that agent is comfortably on-screen — the visible avatar is
// then its own cue. Never a minimap, never a distance readout: just a direction,
// the in-world equivalent of "look over there". Honours reduced motion (the glow's
// pulse is CSS-gated; the arrow still points, it just doesn't breathe).
let _nudgeEl = null;
let _nudgeArrowEl = null;
let _nudgeVisible = false;
// Throttle the DOM writes to ~20 Hz — the bearing changes smoothly and a full
// per-frame style write is wasted work; CSS transitions cover the gaps.
let _nudgeAccum = 0;
const NUDGE_INTERVAL = 0.05;

function _ensureNudgeEls() {
	if (_nudgeEl) return;
	_nudgeEl = document.getElementById('irl-dir-nudge');
	_nudgeArrowEl = _nudgeEl?.querySelector('.irl-dir-nudge-arrow') ?? null;
}

// Pick the agent to point at and the camera's half-FOV, then either place + show
// the glow toward an off-screen agent or fade it once we're facing the nearest one.
// Reads only world offsets the scene already renders — no coordinate ever touched.
function updateDirectionalNudge(dt) {
	_nudgeAccum += dt;
	if (_nudgeAccum < NUDGE_INTERVAL) return;
	_nudgeAccum = 0;
	_ensureNudgeEls();
	if (!_nudgeEl) return;

	// Candidates: every rendered in-range agent, measured from where we stand. The
	// band distance (not the live AR-head distance) is the honest "how near is this
	// agent to me" — stable as the camera pans.
	let candidates = null;
	for (const pin of nearbyPins) {
		if (!pin.group) continue;
		(candidates ??= []).push({ pin, distance: bandDistance(pin) });
	}
	const target = candidates && nearestAgent(candidates);
	if (!target) { _hideNudge(); return; }

	const wp = target.pin.group.position;
	const relBearing = relativeBearing(wp.x, wp.z, cameraYaw);
	// Half the camera's horizontal FOV (camera.fov is vertical; convert via aspect).
	const aspect = window.innerWidth / Math.max(1, window.innerHeight);
	const halfVFov = (camera.fov * Math.PI) / 180 / 2;
	const halfHFov = Math.atan(Math.tan(halfVFov) * aspect);

	// Already looking at the nearest agent (and it's actually drawing on-screen)? The
	// avatar is the cue now — fade the hint.
	if (isFacingAgent(relBearing, halfHFov) && pinOnScreen(target.pin)) { _hideNudge(); return; }

	const { x, y, rotateDeg } = edgeNudgePlacement(relBearing, window.innerWidth, window.innerHeight);
	_nudgeEl.style.transform = `translate(-50%, -50%) translate(${x}px, ${y}px)`;
	if (_nudgeArrowEl) _nudgeArrowEl.style.transform = `rotate(${rotateDeg}deg)`;
	if (!_nudgeVisible) {
		_nudgeVisible = true;
		_nudgeEl.hidden = false;
		// Next frame so the transition runs from the hidden state.
		requestAnimationFrame(() => { if (_nudgeVisible) _nudgeEl.classList.add('is-visible'); });
	}
}

function _hideNudge() {
	if (!_nudgeVisible) return;
	_nudgeVisible = false;
	_nudgeEl?.classList.remove('is-visible');
}

// ── Smart-glasses HUD push ──────────────────────────────────────────────────
// The same nearest-agent read that drives the on-screen directional nudge, reshaped
// for the glasses bridge: which agent, how far, and the screen-relative bearing
// (0 = ahead, + = turn right). Privacy-preserving by construction — it consumes the
// world offset the scene already renders, never a coordinate, exactly like the nudge.
function glassesNearbyState() {
	let candidates = null;
	let count = 0;
	for (const pin of nearbyPins) {
		if (!pin.group) continue;
		count++;
		(candidates ??= []).push({ pin, distance: bandDistance(pin) });
	}
	const target = candidates && nearestAgent(candidates);
	if (!target) return { nearest: null, count };
	const wp = target.pin.group.position;
	return {
		nearest: {
			name: target.pin.avatar_name || 'Agent',
			distanceM: target.distance,
			relBearingRad: relativeBearing(wp.x, wp.z, cameraYaw),
		},
		count,
	};
}

// Per-frame push, gated + accumulated so we only build state at ~6 Hz; the bridge
// throttles the actual BLE write further and skips byte-identical frames.
let _glassesAccum = 0;
const GLASSES_PUSH_INTERVAL = 0.16;
function pushGlassesHud(dt) {
	if (!glassesBridge.connected) return;
	_glassesAccum += dt;
	if (_glassesAccum < GLASSES_PUSH_INTERVAL) return;
	_glassesAccum = 0;
	glassesBridge.pushState(glassesNearbyState());
}

// Briefly tint a pin's floating label so a deep-linked target (?highlight= or
// ?agent=) is easy to spot among the nearby agents. No-op for a missing pin/label.
function flashPinLabel(pin) {
	const label = pin?.labelEl;
	if (!label) return;
	label.style.transition = 'background .2s, color .2s';
	label.style.background = 'rgba(139,92,246,0.9)';
	label.style.color = '#fff';
	setTimeout(() => {
		if (pin.labelEl) {
			pin.labelEl.style.background = '';
			pin.labelEl.style.color = '';
		}
	}, 2500);
}

// Free every GPU resource a pin holds: cancel any queued load, dispose the group
// (geometry/materials/textures of dot, ring, model and impostor sprite) and the
// impostor render target's framebuffer (not reached by the group traversal), then
// drop the DOM label. The single place that knows the full E2 resource set.
function disposePin(p) {
	cancelPinGLB(p);
	// Idle mixer first — its actions bind the skeleton the group disposal frees.
	if (p.animMgr) { p.animMgr.detach(); p.animMgr = null; }
	// Tear the impostor down FIRST, in the correct order (null the sprite material's
	// texture ref → dispose material → dispose RT + its texture). If the group
	// traversal below reached the sprite instead, it would dispose the RT's texture
	// via the material's `.map`, then `_impostorRT.dispose()` would free it twice.
	disposeImpostor(p);
	if (p.group)   { scene.remove(p.group); disposeObject3D(p.group); }
	if (p.labelEl) p.labelEl.remove();
}

// Drop one nearby pin from the scene now — disposing its GPU resources — instead
// of waiting for the next loadNearbyPins() reconcile. Used when a pin is hidden by
// a report (D4) so the reporter sees it vanish immediately.
function removeNearbyPin(id) {
	nearbyPins = nearbyPins.filter(p => {
		if (p.id !== id) return true;
		disposePin(p);
		return false;
	});
	updateNearbyBadge();
}

// ── Animated spawn / despawn (membership transitions) ───────────────────────
// A pin that genuinely arrives or leaves should ease in/out, never pop — even a
// legitimate exit looks like a glitch as a hard cut. Spawn grows the group from 0→1
// (cubic ease-out, set in spawnNearbyPin + advanced in tick); despawn shrinks it
// 1→0 here, then disposes. Both honour prefers-reduced-motion (instant). These are
// purely visual: the pin is already gone from `nearbyPins` (membership) before it
// fades, so the band logic, labels and LOD never touch a leaving avatar.
const DESPAWN_DURATION = 0.32; // seconds for the despawn shrink
const _despawningPins = [];    // pins fading out before disposePin

// Begin an animated despawn for a pin the band has evicted. The caller has already
// removed it from `nearbyPins`; we cancel any in-flight GLB (it's leaving), hide its
// 2D label immediately (a frozen HTML label can't shrink with the 3D group), then
// either dispose at once (reduced motion / no group) or queue the fade.
function despawnNearbyPin(p) {
	if (p.labelEl) p.labelEl.style.display = 'none';
	if (prefersReducedMotion() || !p.group) { disposePin(p); return; }
	cancelPinGLB(p);
	p._despawnT = 0;
	_despawningPins.push(p);
}

// ── Realtime presence + reactions (D2/D3) ───────────────────────────────────
// IrlNet joins the irl_world room for the viewer's geocell — but ONLY for live
// PRESENCE (who else is viewing nearby) and ambient REACTIONS. The room is NOT a
// pin transport: a placed agent's coordinates are never broadcast as a roster.
// Agents are discovered solely through the per-viewer proximity poll below
// (loadNearbyPins), which the server scopes to a tight radius around our OWN
// position — so you see another agent only by being physically near it with your
// camera up, never from a list, map, or neighbourhood feed. The poll runs the
// whole session once GPS is ready, independent of whether the socket connects.
let irlNet = null;
let _streamOnline = false;        // true only while the presence/reaction socket is live
let _pollTimer = null;            // proximity poll handle (the sole pin-discovery transport)
const POLL_INTERVAL_MS = 10000;   // proximity refresh cadence

function startPinSync() {
	if (!gpsState.ready) return;
	if (irlNet) irlNet.destroy();
	irlNet = new IrlNet({
		lat: gpsState.lat, lng: gpsState.lng,
		deviceToken: _deviceToken, agent: _currentAgentId || '',
		// D2 — opt-in to being seen as a ghost (default off). Avatar only matters
		// when sharing; the server drops it otherwise.
		ghost: getShareGhost(), avatar: resolveAvatarUrl(_currentAvatarId),
	});
	irlNet.on('reaction',   (msg) => onReaction(msg));   // D3 ambient interaction reactions
	irlNet.on('presence',   ({ count, viewers }) => updatePresence(count, viewers)); // D2
	irlNet.on('status', ({ status }) => onNetStatus(status));
	irlNet.connect();
	startHeartbeat();
	// Pins come from the proximity poll, never the socket — start it now and keep it
	// running for the whole session regardless of presence connectivity.
	startPinPolling();
}

function onNetStatus(status) {
	_streamOnline = status === 'online';
	if (status === 'online') setNetPill('live');
	else if (status === 'connecting' || status === 'offline') setNetPill('connecting');
	else setNetPill('idle');   // failed | unavailable | idle — presence off; pins still poll
	// D2 presence (count chip + ghosts) is live-only: clear it whenever the socket
	// isn't online so a stale count or frozen ghost never lingers. Pin discovery is
	// unaffected — it runs on the proximity poll either way.
	if (status !== 'online') clearPresence();
}

function startPinPolling() {
	if (_pollTimer) return;
	loadNearbyPins();                                  // immediate first fetch, don't wait a cycle
	_pollTimer = setInterval(loadNearbyPins, POLL_INTERVAL_MS);
}
function stopPinPolling() {
	if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
}

// The presence/reaction socket status pill in the topbar: live (green — you can
// see who else is here and their reactions), connecting (amber pulse), or hidden
// when unavailable. Pin discovery never depends on this; it always runs via the
// proximity poll.
function setNetPill(state) {
	const pill = document.getElementById('irl-net-pill');
	if (!pill) return;
	pill.classList.remove('is-live', 'is-connecting');
	if (state === 'live') {
		pill.classList.add('is-live'); pill.hidden = false;
		pill.textContent = 'Live'; pill.title = 'Live — you can see who else is viewing nearby and their reactions in realtime';
	} else if (state === 'connecting') {
		pill.classList.add('is-connecting'); pill.hidden = false;
		pill.textContent = 'Connecting'; pill.title = 'Connecting to live presence…';
	} else {
		pill.hidden = true;
	}
	pill.setAttribute('aria-label', `Live presence: ${pill.textContent || 'off'}`);
}

// ── Live viewer presence (D2) ───────────────────────────────────────────────
// A pin is a static artifact; a person also looking at this spot right now is
// social proof. Presence rides the SAME geocell room D1 opened — the server adds
// each viewer to a `viewers` MapSchema at the cell centre + jitter (never precise
// GPS) and Colyseus delta-broadcasts it, so we get a live "N viewing nearby"
// count for free, plus optional ghost markers for viewers who opted to be seen.
//
// Privacy: you always SEE the count and others' ghosts; you only BROADCAST
// yourself as a ghost if you opt in ("Appear to others nearby", default off,
// stored in localStorage). Count-only presence reveals nothing beyond "someone
// in this ~1 km cell." Presence is live-only — cleared in poll fallback / while
// connecting (onNetStatus), never faked from the REST poll.
const SHARE_GHOST_KEY = 'irl_share_ghost';
function getShareGhost() {
	try { return localStorage.getItem(SHARE_GHOST_KEY) === '1'; } catch { return false; }
}
function setShareGhost(on) {
	try { localStorage.setItem(SHARE_GHOST_KEY, on ? '1' : '0'); } catch {}
}

// Compass-referenced facing we report on each heartbeat — the same absolute yaw
// placement uses, so a shared ghost is oriented consistently for every viewer.
function currentHeadingDeg() {
	return ((-cameraYaw * 180 / Math.PI) % 360 + 360) % 360;
}

// 15 s heartbeat: proves we're still here (the server's 30 s reaper drops silent
// viewers) and refreshes our facing. A no-op off a live socket — presence is
// inherently live, so we never heartbeat into the poll fallback.
let _heartbeatTimer = null;
const HEARTBEAT_MS = 15000;
function startHeartbeat() {
	stopHeartbeat();
	_heartbeatTimer = setInterval(() => { irlNet?.heartbeat(currentHeadingDeg()); }, HEARTBEAT_MS);
}
function stopHeartbeat() {
	if (_heartbeatTimer) { clearInterval(_heartbeatTimer); _heartbeatTimer = null; }
}

// Rendered ghosts (others who opted to be seen), keyed by session id. Each entry
// carries its coarse coords + a faint scene orb. The count chip always shows the
// true crowd size; only this bounded set is drawn.
const ghostViewers = new Map();
const GHOST_RENDER_CAP = 24;     // bound drawn orbs/dots; the chip still shows the real count
const GHOST_MAX_SCENE_M = 60;    // clamp a coarse ghost to a soft nearby radius (it's approximate)
const GHOST_HOVER_Y = 1.3;       // float the orb near head height
let _ghostPhase = 0;             // shared gentle pulse phase

// Coarse ghost → scene XZ, clamped to a comfortable radius. The position is
// approximate by construction (cell centre + jitter), so a far cell-centre reads
// as a soft nearby presence in roughly the right direction rather than a speck on
// the horizon implying a precision we don't have.
function ghostWorldXZ(g) {
	const wp = gpsToWorld(g.glat, g.glng);
	let x = wp.x, z = wp.z;
	const d = Math.hypot(x, z);
	if (d > GHOST_MAX_SCENE_M && d > 1e-3) {
		const k = GHOST_MAX_SCENE_M / d;
		x *= k; z *= k;
	}
	return { x, z };
}

// A ghost is deliberately distinct from a pin: a faint translucent orb, no name
// label, no confidence ring, and never added to the raycast set (the tap/long-press
// handlers only scan nearbyPins groups), so it can never be mistaken for or tapped
// as a placed agent.
function createGhostOrb() {
	const orb = new Mesh(
		new SphereGeometry(0.5, 16, 12),
		new MeshBasicMaterial({ color: 0x9fd8ff, transparent: true, opacity: 0.28, depthWrite: false }),
	);
	orb.renderOrder = 4;
	orb.userData.ghost = true; // marker; ghosts are never in the pin raycast list anyway
	scene.add(orb);
	return orb;
}
function positionGhostOrb(g) {
	if (!g.orb || !gpsState.ready) return;
	const { x, z } = ghostWorldXZ(g);
	g.orb.position.set(x, GHOST_HOVER_Y, z);
}
function removeGhostOrb(g) {
	if (!g.orb) return;
	scene.remove(g.orb);
	g.orb.geometry.dispose();
	g.orb.material.dispose();
	g.orb = null;
}

// Reconcile the live presence delta: update the count chip and the drawn ghost
// set. `viewers` is already only OTHER opted-in viewers (self + count-only entries
// filtered out in irl-net), so everything here is a renderable ghost.
function updatePresence(count, viewers) {
	const chip = document.getElementById('irl-presence-chip');
	if (chip) {
		const show = _streamOnline && count > 1; // 1 = just me; nothing social to show
		chip.hidden = !show;
		if (show) {
			chip.textContent = `${count} viewing nearby`;
			chip.setAttribute('aria-label', `${count} people viewing this location`);
		}
	}

	const incoming = new Map();
	for (const v of viewers) {
		if (incoming.size >= GHOST_RENDER_CAP) break;
		if (v && v.id) incoming.set(v.id, v);
	}
	// Despawn ghosts that left or stopped sharing.
	for (const [id, g] of ghostViewers) {
		if (!incoming.has(id)) { removeGhostOrb(g); ghostViewers.delete(id); }
	}
	// Spawn / refresh the rest.
	for (const [id, v] of incoming) {
		let g = ghostViewers.get(id);
		if (!g) { g = { id }; ghostViewers.set(id, g); }
		g.glat = v.glat; g.glng = v.glng; g.heading = v.heading; g.avatar = v.avatar;
		if (!g.orb) g.orb = createGhostOrb();
		positionGhostOrb(g);
	}
}

// Hide the chip and drop every ghost cleanly — called whenever the live stream
// isn't owning presence (connecting, poll fallback, offline) so a stale count or
// frozen orb never lingers. Restored from the next presence delta on reconnect.
function clearPresence() {
	const chip = document.getElementById('irl-presence-chip');
	if (chip) chip.hidden = true;
	for (const g of ghostViewers.values()) removeGhostOrb(g);
	ghostViewers.clear();
}

// Gentle shared pulse so ghosts read as "alive" without per-orb cost. Cheap: only
// touches scale + opacity on the bounded ghost set, and early-outs when empty.
function updateGhosts(dt) {
	if (!ghostViewers.size) return;
	_ghostPhase += dt;
	const wave = Math.sin(_ghostPhase * 2);
	const scale = 1 + wave * 0.08;
	const opacity = 0.22 + (wave * 0.5 + 0.5) * 0.16; // 0.22 … 0.38
	for (const g of ghostViewers.values()) {
		if (!g.orb) continue;
		g.orb.scale.setScalar(scale);
		g.orb.material.opacity = opacity;
	}
}

// Refresh an already-rendered pin from a fresh proximity-poll row: move it if its
// stored position / heading / room frame changed (an owner calibrate or edit),
// relabel it on a rename, then let applyPinUpdate swap the GLB on a re-skin
// (avatar_version bump). Repositioning uses pinWorldPos so room-anchored clusters
// resolve through their shared origin exactly as on spawn.
function refreshKnownPin(known, pin) {
	let moved = false;
	for (const k of ['lat', 'lng', 'heading', 'room_id', 'rel_east_m', 'rel_north_m',
	                 'origin_lat', 'origin_lng', 'origin_yaw_deg']) {
		if (pin[k] !== undefined && pin[k] !== known[k]) { known[k] = pin[k]; moved = true; }
	}
	if (pin.caption !== undefined) known.caption = pin.caption;
	if (pin.x402_endpoint !== undefined) known.x402_endpoint = pin.x402_endpoint;
	// Name lives on the floating label; update it here because applyPinUpdate only
	// reaches its name branch on an avatar change, so a rename-only edit would miss it.
	if (pin.avatar_name != null && pin.avatar_name !== known.avatar_name) {
		known.avatar_name = pin.avatar_name;
		const nameEl = known.labelEl?.querySelector('.irl-agent-label-name');
		if (nameEl) nameEl.textContent = known.avatar_name || 'Agent';
	}
	if (moved && known.group) {
		const wp = pinWorldPos(known);
		known.group.position.set(wp.x, wp.y, wp.z);
		known.group.rotation.y = pinYawRad(known);
		if ('baseYaw' in known) known.baseYaw = known.group.rotation.y;
	}
	applyPinUpdate(known, pin);
}

// Ground-plane distance (m) from the viewer to a pin, computed locally from the
// SMOOTHED origin via pinWorldPos — stable even when the server's coarse set jitters
// at the edge, and valid before a pin has a group (a fresh server row). This is what
// the membership band measures, NOT the live camera distance (which tracks AR head
// movement); membership is "how far is this agent from where I'm standing".
function bandDistance(pin) {
	const wp = pinWorldPos(pin);
	return Math.hypot(wp.x, wp.z);
}

async function loadNearbyPins() {
	if (!gpsState.ready) return;
	// The proximity poll is the SOLE pin-discovery transport: the server returns the
	// agents within a tight radius of our live position (no roster, no map). We ask for
	// the wider read (NEARBY_READ_RADIUS = the 60 m cap) so an agent on the discovery
	// edge stays stably returned, then apply the asymmetric ENTER/EXIT band + despawn
	// debounce CLIENT-side (pinBandAction) so consumer GPS jitter can't pop it in and out.
	const _o = discoveryOrigin();
	try {
		// presenceHeaders awaits a mint when the cached token is cold or lapsed, so the
		// read is never sent with a stale token that the server would 401 on.
		const r = await fetch(
			`/api/irl/pins?lat=${_o.lat}&lng=${_o.lng}&radius=${NEARBY_READ_RADIUS}`,
			{ headers: await presenceHeaders() },
		);
		if (r.status === 401) { return handleFixRequired(r); }
		// 429: we're polling faster than the limiter allows (rare — the cadence is
		// fixed at 10 s — but possible behind a shared NAT or after a manual retry
		// storm). Treat it as a transient, self-healing pause, NOT an error: keep the
		// last good pins on screen and let the next cycle catch up. Never alarm the user.
		if (r.status === 429) { _nearbyRateLimited = true; updateNearbyBadge(); return; }
		if (!r.ok) { _nearbyError = true; updateNearbyBadge(); return; }
		const { pins } = await r.json();
		_nearbyError = false;
		_nearbyRateLimited = false;
		_nearbyLoaded = true;   // first real read in hand — empty now means genuinely empty

		const incoming     = pins.filter(p => !gpsPin?.id || p.id !== gpsPin.id);
		const incomingById = new Map(incoming.map(p => [p.id, p]));

		// 1) Reconcile already-rendered pins through the hysteresis band. Refresh each
		//    from its fresh server row FIRST (a calibrate/edit may have moved it) so the
		//    band distance is measured against the current position, then keep / debounce
		//    / drop. A pin is out-of-band when it's beyond EXIT_RADIUS_M *or* the server
		//    no longer lists it (deleted, hidden, or walked far past the cap); either way
		//    it must stay out-of-band for DROP_POLLS consecutive polls before disposal, so
		//    a single bad fix or inconsistent reply never evicts a steady agent. Despawn
		//    is animated (despawnNearbyPin); disposal frees every GPU resource it held.
		const survivors = [];
		for (const p of nearbyPins) {
			// Marker pins are discovered through the marker mode's ?room= read, never the
			// GPS proximity feed, so they are absent from `incoming` every poll — exempt
			// them from band eviction or they'd drop after DROP_POLLS. The marker mode
			// owns their lifecycle (hidden when the marker leaves view, gone on exit).
			if (isMarkerRoomId(p.room_id)) { survivors.push(p); continue; }
			const row = incomingById.get(p.id);
			if (row) refreshKnownPin(p, row);
			const action = pinBandAction({
				distance: bandDistance(p),
				rendered: true,
				listed:   !!row,
				oobPolls: p._oobPolls || 0,
			}, { enter: NEARBY_RADIUS });
			if (action === 'keep')      { p._oobPolls = 0; survivors.push(p); }
			else if (action === 'wait') { p._oobPolls = (p._oobPolls || 0) + 1; survivors.push(p); }
			else                        { despawnNearbyPin(p); } // 'drop'
		}
		nearbyPins = survivors;

		// 2) Spawn genuinely new arrivals — only those that have crossed the tight ENTER
		//    gate. A server row sitting in the 40–55 m band we've never rendered stays
		//    'ignore'd: you DISCOVER an agent by getting within the enter radius, never by
		//    drifting near its outer edge. Each new pin starts the spawn-in scale (once).
		for (const pin of incoming) {
			if (nearbyPins.some(n => n.id === pin.id)) continue;
			const entry = { ...pin, group: null, labelEl: null, glbLoaded: false, _oobPolls: 0 };
			const action = pinBandAction({
				distance: bandDistance(entry),
				rendered: false,
				listed:   true,
				oobPolls: 0,
			}, { enter: NEARBY_RADIUS });
			if (action !== 'spawn') continue;
			nearbyPins.push(entry);
			spawnNearbyPin(entry);
			// Clean, debounced "newly stable in-range" signal: the band only reaches
			// 'spawn' for a pin that has genuinely crossed the ENTER gate and isn't
			// already rendered, so this fires exactly once per real arrival — never on
			// the GPS-edge jitter the hysteresis absorbs. Task 03's arrival cue listens.
			emitPinStable(entry);
		}

		updateNearbyBadge();

		// R2: offer the one-tap align for any nearby relative-frame room this viewer
		// doesn't own (a room placed without a compass that may render rotated here).
		maybePromptRoomAlign();

		// Flash pin label if ?highlight= matches
		if (highlightPinId) {
			flashPinLabel(nearbyPins.find(p => p.id === highlightPinId));
		}

		// Deep-focus this agent's pin if ?agent= matches one that just loaded — flash
		// its label and open its inspect card so an agent profile's "View in IRL"
		// link lands the visitor right on that agent. Once only (see _agentFocusDone).
		if (agentFocusId && !_agentFocusDone) {
			const target = nearbyPins.find(p => String(p.agent_id) === agentFocusId);
			if (target) {
				_agentFocusDone = true;
				flashPinLabel(target);
				openPinSheet(target);
			}
		}
	} catch {
		// Don't fail silently — a busy spot that can't load looks identical to an
		// empty one otherwise. Flag it on the badge; the 15 s poll retries. A genuine
		// network drop supersedes a prior rate-limit pause (error is the actionable state).
		_nearbyError = true;
		_nearbyRateLimited = false;
		updateNearbyBadge();
	}
}

// ── Confidence ring (A3) ────────────────────────────────────────────────────
// A flat ground ring under each agent whose radius communicates the REAL GPS
// uncertainty (max of the viewer's live accuracy and the pin's stored
// gps_accuracy_m). Honest by design: consumer GPS is ~5–15 m open-sky and far
// worse in urban canyons / indoors, so we never imply a centimetre-perfect
// pinpoint. Amber when the lock is loose (> RING_LOW_ACC_M).
const RING_LOW_ACC_M = 25;   // above this, the ring goes amber + copy warns
const RING_MIN_M     = 1.4;  // floor radius so a tight fix is still visible
const RING_MAX_M     = 10;   // cap render radius so a loose fix doesn't swallow the scene
const RING_OK_COLOR  = 0x4cc9ff;
const RING_LOW_COLOR = 0xffb020;

// (Re)create the ring mesh on a pin's group. Called on spawn and again after a
// GLB swap (which disposes all group children, ring included).
function attachPinRing(pin) {
	if (!pin.group) return;
	if (pin.ringMesh) { pin.group.remove(pin.ringMesh); disposeObject3D(pin.ringMesh); pin.ringMesh = null; }
	// Unit-radius torus laid flat on the ground; scaled by updatePinRing().
	const ring = new Mesh(
		new TorusGeometry(1, 0.045, 8, 64),
		new MeshStandardMaterial({
			color: RING_OK_COLOR, emissive: RING_OK_COLOR, emissiveIntensity: 0.9,
			roughness: 0.4, metalness: 0, transparent: true, opacity: 0.55, depthWrite: false,
		}),
	);
	ring.rotation.x = Math.PI / 2;
	ring.position.y = 0.02;
	ring.renderOrder = 2;
	pin.group.add(ring);
	pin.ringMesh = ring;
}

// Size + colour the ring from the worse of viewer / pin accuracy. Cheap; called
// every GPS fix (viewer accuracy changes) and once on spawn.
function updatePinRing(pin) {
	const ring = pin.ringMesh;
	if (!ring) return;
	const viewerAcc = Number.isFinite(gpsState.accuracy) ? gpsState.accuracy : 12;
	const pinAcc    = Number.isFinite(pin.gps_accuracy_m) ? pin.gps_accuracy_m : viewerAcc;
	const acc       = Math.max(viewerAcc, pinAcc);
	const radius    = Math.min(RING_MAX_M, Math.max(RING_MIN_M, acc));
	ring.scale.set(radius, radius, 1);
	const low = acc > RING_LOW_ACC_M;
	const m = ring.material;
	m.color.setHex(low ? RING_LOW_COLOR : RING_OK_COLOR);
	m.emissive.setHex(low ? RING_LOW_COLOR : RING_OK_COLOR);
	m.opacity = low ? 0.62 : 0.5;
}

function spawnNearbyPin(pin) {
	const g  = new Group();
	const wp = pinWorldPos(pin);
	// Stored pose: a room pin resolves through its shared origin (exact relative
	// layout for every viewer); a standalone pin uses its own absolute GPS + compass
	// yaw. Either way two devices at the same place agree (see pinWorldPos/pinYawRad).
	g.position.set(wp.x, wp.y, wp.z);
	g.rotation.y = pinYawRad(pin);

	// Cheap unlit "dot" — the agent's far/low-cost representation (E2). The old
	// placeholder was a transmission+emissive MeshPhysicalMaterial sphere with a
	// shadow: far too expensive for a marker that's often just a distant speck and
	// multiplied across dozens of pins. enforceLOD() promotes this to an impostor
	// billboard, then the full skinned GLB, as the viewer approaches — and demotes
	// back as they leave. The dot, ring and label persist for the pin's lifetime;
	// only the model + impostor are swapped in and out.
	const dot = new Mesh(
		new SphereGeometry(0.18, 12, 8),
		new MeshBasicMaterial({ color: 0x88bbff }),
	);
	dot.position.y = 1.2;
	g.add(dot);
	pin.dotMesh = dot;
	pin.group = g;
	// Cache the owning pin on the group so a mesh raycast (_pinForObject) maps a
	// hit back to its agent without scanning nearbyPins per node.
	g.userData.pin = pin;
	scene.add(g);

	// Spawn-in transition (membership): a freshly discovered agent eases up from
	// nothing rather than popping into the scene. tick() advances _spawnT and scales
	// the whole group (dot/impostor/full all ride it) with a cubic ease-out. Reduced
	// motion lands it at full size immediately. See despawnNearbyPin for the exit.
	if (prefersReducedMotion()) {
		pin._spawnT = SPAWN_DURATION;
	} else {
		pin._spawnT = 0;
		g.scale.setScalar(0.01);
	}

	// Confidence ring (A3) — a ground footprint sized to the real GPS uncertainty
	// so users see the true precision instead of being misled into thinking it's
	// centimetre-perfect. Amber when the lock is loose. Built before the label so
	// the agent reads as "somewhere in here", not a false pinpoint.
	attachPinRing(pin);
	updatePinRing(pin);

	// Floating HTML name label — gold border if this is the owner's own pin
	const el = document.createElement('div');
	el.className   = 'irl-agent-label';
	// Own pin = one this device placed (matched by id via /mine) or the live anchor.
	if (isOwnPin(pin)) {
		el.classList.add('is-own');
	}
	el.style.display = 'none';
	el.innerHTML = `<span class="irl-agent-label-name">${_escHtml(pin.avatar_name || 'Agent')}</span>`;
	el.addEventListener('click', () => openPinSheet(pin));
	document.body.appendChild(el);
	pin.labelEl = el;

	// No load here: enforceLOD() (4 Hz, from tick) assigns this pin a band from its
	// live camera distance and the active budget, and drives the queued GLB load /
	// impostor bake / eviction. The dot is visible immediately in the meantime.
}

function _escHtml(s) {
	return String(s ?? '').replace(/[&<>"']/g, c =>
		({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Recursively free a detached Object3D's GPU resources (geometry, materials,
// and any texture maps on them) so removing a nearby agent doesn't leak.
function disposeObject3D(root) {
	root.traverse(n => {
		// Sprites share ONE module-level geometry across every Sprite instance in
		// three.js — disposing it from here would yank the buffer out from under
		// every other live sprite (radar, impostors). Skip sprite geometry; its
		// material + texture are still freed below. Impostor RTs are disposed by
		// disposeImpostor(), which runs before this traversal reaches the sprite.
		if (n.geometry && !n.isSprite) n.geometry.dispose();
		const mats = Array.isArray(n.material) ? n.material : n.material ? [n.material] : [];
		for (const m of mats) {
			for (const k in m) {
				const v = m[k];
				if (v && v.isTexture) v.dispose();
			}
			m.dispose();
		}
	});
}

// ── GLB load queue, impostor bake + eviction (E2) ───────────────────────────
//
// Pins no longer each `new GLTFLoader()` behind a crude count gate; they go
// through the shared, nearest-first, concurrency-capped `glbQueue`. Every GLB
// that loads is baked ONCE into a small impostor texture, so when the agent
// later recedes past lodNear we drop the skinned mesh (freeing geometry /
// materials / textures) and show a ~1 draw-call billboard instead — bounded
// memory no matter how many pins the user walks past. Re-approach re-queues the
// full model. enforceLOD() (below) decides each pin's band and drives all this.

// Shared offscreen rig for impostor snapshots. Renders to a render target with
// the MAIN renderer — no extra WebGL context, so the page's context budget is
// untouched. Created lazily on the first bake.
const IMPOSTOR_PX = 256;
let _snapScene = null, _snapCam = null;
function _ensureSnapRig() {
	if (_snapScene) return;
	_snapScene = new Scene();
	_snapCam = new OrthographicCamera(-1, 1, 1, -1, 0.01, 100);
	// Balanced against the main scene's ambient/hemi/sun + IBL (the environment
	// is assigned per-bake below) so an impostor reads like the model it replaces.
	_snapScene.add(new AmbientLight(0xffffff, 0.45));
	const key = new DirectionalLight(0xffffff, 1.4);
	key.position.set(2, 4, 5);
	_snapScene.add(key);
}

const _snapBox = new Box3();
const _snapSize = new Vector3();
const _snapCenter = new Vector3();
// Render `model` head-on to a fresh render target; return { rt, side, centerY }.
// `side` is the world size of the square billboard; `centerY` its local centre so
// the impostor's feet land where the model's did.
function bakeImpostor(model) {
	_ensureSnapRig();
	// Share the live scene's IBL (re-read each bake — it's rebuilt on context
	// restore) so a billboard's shading matches the full model it stands in for.
	_snapScene.environment = scene.environment;
	_snapBox.setFromObject(model);
	_snapBox.getSize(_snapSize);
	_snapBox.getCenter(_snapCenter);
	const side = (Math.max(_snapSize.x, _snapSize.y, _snapSize.z) * 1.08) || 1;
	const half = side / 2;
	_snapCam.left = -half; _snapCam.right = half; _snapCam.top = half; _snapCam.bottom = -half;
	_snapCam.near = 0.01; _snapCam.far = side * 4 + 10;
	_snapCam.position.set(_snapCenter.x, _snapCenter.y, _snapCenter.z + side * 2 + 1);
	_snapCam.lookAt(_snapCenter.x, _snapCenter.y, _snapCenter.z);
	_snapCam.updateProjectionMatrix();

	const rt = new WebGLRenderTarget(IMPOSTOR_PX, IMPOSTOR_PX);
	rt.texture.colorSpace = SRGBColorSpace;
	_snapScene.add(model);
	const prevTarget = renderer.getRenderTarget();
	renderer.setRenderTarget(rt);
	renderer.clear();              // page clear colour is transparent → cutout bg
	renderer.render(_snapScene, _snapCam);
	renderer.setRenderTarget(prevTarget);
	_snapScene.remove(model);
	return { rt, side, centerY: _snapCenter.y };
}

function disposeImpostor(pin) {
	if (pin._impostorSprite) {
		pin.group?.remove(pin._impostorSprite);
		const mat = pin._impostorSprite.material;
		if (mat) {
			// Drop the material's reference to the RT's texture BEFORE we dispose the
			// RT, so no live material is left pointing at a freed texture (and the RT's
			// own dispose() is the single owner that frees it, just below).
			mat.map = null;
			mat.dispose();
		}
		// NB: don't dispose the sprite geometry — three.js shares one geometry across
		// every Sprite; freeing it here would corrupt all other live sprites.
		pin._impostorSprite = null;
	}
	if (pin._impostorRT) { pin._impostorRT.dispose(); pin._impostorRT = null; }
	pin._impostorSide = 0; pin._impostorCenterY = 0;
}

function showImpostor(pin) {
	if (!pin._impostorRT) return false;
	if (!pin._impostorSprite) {
		const mat = new SpriteMaterial({ map: pin._impostorRT.texture, transparent: true, depthWrite: false });
		const sp = new Sprite(mat);
		sp.scale.set(pin._impostorSide, pin._impostorSide, 1);
		sp.position.y = pin._impostorCenterY;
		sp.userData.impostor = true;
		pin.group.add(sp);
		pin._impostorSprite = sp;
	}
	pin._impostorSprite.visible = true;
	return true;
}
function hideImpostor(pin) { if (pin._impostorSprite) pin._impostorSprite.visible = false; }
function showDot(pin) { if (pin.dotMesh) pin.dotMesh.visible = true; }
function hideDot(pin) { if (pin.dotMesh) pin.dotMesh.visible = false; }

// Enqueue a pin's GLB through the shared queue. `bakeOnly` loads purely to bake
// the impostor (the model is disposed right after) — used for mid-distance pins
// that have never been close. Idempotent while a load is in flight.
function requestPinGLB(pin, bakeOnly = false) {
	if (pin.glbLoaded || pin._glbLoading || !pin.avatar_url) return;
	if (bakeOnly && pin._impostorRT) return;   // already have a snapshot
	pin._glbLoading = true;
	pin._bakeOnly = bakeOnly;
	glbQueue.request(pin)
		.then(gltf => onPinGLBLoaded(pin, gltf))
		.catch(() => { /* network/CDN blip or cancelled — a later LOD pass retries */ })
		.finally(() => {
			pin._glbLoading = false;
			pin._bakeOnly = false;
			// A re-skin (C6) that arrived mid-load fetched the OLD url — swap again.
			if (pin._reloadQueued) { pin._reloadQueued = false; reloadPinGLB(pin); }
		});
}

async function onPinGLBLoaded(pin, gltf) {
	// The pin may have been removed (walked out of the fetch radius) mid-flight.
	if (!pin.group) { disposeObject3D(gltf.scene); return; }
	const model = gltf.scene;
	const castShadow = budget.shadow > 0;
	model.traverse(n => { if (n.isMesh) { n.castShadow = castShadow; n.frustumCulled = false; } });
	sharpenModelTextures(model);
	const box = new Box3().setFromObject(model);
	model.position.y -= box.min.y;   // feet to ground

	// Bring the rig to life BEFORE the impostor bake so the snapshot (and the
	// mounted model) show a natural idle stance, never the bind-pose T. The await
	// is bounded: the clip JSON is one page-wide cached fetch. A rig that can't
	// be driven (prop, non-humanoid) returns null and stays static as before.
	const animMgrForPin = await mountPinIdle(model, { avatarUrl: pin.avatar_url });
	// Re-check: the pin may have been disposed while the clip was fetching.
	if (!pin.group) {
		animMgrForPin?.detach();
		disposeObject3D(model);
		return;
	}

	// Bake the impostor once; reused whenever this agent later recedes past lodNear.
	if (!pin._impostorRT) {
		try {
			const imp = bakeImpostor(model);
			pin._impostorRT = imp.rt; pin._impostorSide = imp.side; pin._impostorCenterY = imp.centerY;
		} catch { /* impostor unavailable — the pin falls back to its dot */ }
	}

	// If the viewer receded past lodNear during the load (or this was a bake-only
	// request), don't mount the skinned mesh — the impostor we just baked covers it.
	if (pin._bakeOnly || pin._lod !== 'full') {
		animMgrForPin?.detach();
		disposeObject3D(model);
		if (pin._lod === 'impostor') { hideDot(pin); showImpostor(pin); }
		return;
	}

	// Mount the full skinned avatar; hide the cheaper representations.
	hideDot(pin); hideImpostor(pin);
	pin.group.add(model);
	pin.model = model;
	pin.animMgr = animMgrForPin;
	pin.glbLoaded = true;
	pin.group.rotation.y = pinYawRad(pin);
	pin.group.position.y = pinHeightM(pin);

	// Cache the head/torso bone + rest pose once so the per-frame awareness step
	// (camera-aware gaze, B1) never walks the tree. baseYaw is the placed heading
	// we ease back to; the gaze bone (head preferred, torso fallback) drives the
	// "looks at you" turn. Agents with neither just turn whole-body.
	pin.baseYaw = pin.group.rotation.y;
	pin.headBone = null; pin.spineBone = null;
	model.traverse(n => {
		if (!n.isBone) return;
		const nm = n.name.toLowerCase();
		if (!pin.headBone  && /head|neck/.test(nm))         pin.headBone  = n;
		if (!pin.spineBone && /spine|chest|torso/.test(nm)) pin.spineBone = n;
	});
	pin.restHeadQuat  = pin.headBone  ? pin.headBone.quaternion.clone()  : null;
	pin.restSpineQuat = pin.spineBone ? pin.spineBone.quaternion.clone() : null;
	pin.idleT   = 0;      // idle-drift phase clock
	pin.noticed = false;  // has the viewer already crossed the notice radius?
	pin.noticeT = 0;      // remaining head-slerp boost time after a notice
	pin.popT    = -1;     // perk-up pop clock (-1 = inactive)
}

// Evict a pin's skinned GLB — dispose geometry/materials/textures and fall back to
// the cheaper representation. The impostor snapshot + dot + ring persist, so this
// is reversible: enforceLOD re-queues the full model on re-approach. Bounded
// memory regardless of how many pins the user walks past.
function evictPinGLB(pin) {
	if (!pin.glbLoaded || !pin.model) return;
	// Stop the idle mixer FIRST so no orphaned action keeps binding the skeleton
	// we're about to dispose (same ordering the carried avatar's _clearAvatar uses).
	if (pin.animMgr) { pin.animMgr.detach(); pin.animMgr = null; }
	pin.group.remove(pin.model);
	disposeObject3D(pin.model);
	pin.model = null;
	pin.glbLoaded = false;
	pin.headBone = pin.spineBone = null;
	pin.restHeadQuat = pin.restSpineQuat = null;
}

// Cancel a still-queued (not yet started) load when a pin is culled or demoted.
// Dropping it frees the slot for a NEARER pin's load — a now-distant pin must not
// hold a slot ahead of one the viewer is walking toward. Already-running loads
// can't be aborted mid-flight, but onPinGLBLoaded() disposes their result when the
// pin is no longer in the 'full' band, so the GPU memory is reclaimed either way.
// `keepBakeOnly` spares a cheap impostor-bake load (still worth finishing) while
// cancelling an in-flight full-model load the demotion no longer needs.
function cancelPinGLB(pin, { keepBakeOnly = false } = {}) {
	if (!pin._glbLoading) return;
	if (keepBakeOnly && pin._bakeOnly) return;
	glbQueue.cancel(p => p === pin);
}

// Apply a re-skin (C6) detected by the nearby-poll diff: adopt the new versioned
// avatar_url + name and swap the rendered GLB. Cheap when nothing changed (version
// equal) so it's safe to call for every incoming pin.
function applyPinUpdate(pin, next) {
	const nextVer = Number(next.avatar_version) || 0;
	const prevVer = Number(pin.avatar_version) || 0;
	const urlChanged = next.avatar_url && next.avatar_url !== pin.avatar_url;
	if (nextVer === prevVer && !urlChanged) return;

	pin.avatar_version = nextVer || prevVer;
	if (next.avatar_url) pin.avatar_url = next.avatar_url;
	if (next.avatar_name != null && next.avatar_name !== pin.avatar_name) {
		pin.avatar_name = next.avatar_name;
		const nameEl = pin.labelEl?.querySelector('.irl-agent-label-name');
		if (nameEl) nameEl.textContent = pin.avatar_name || 'Agent';
	}
	reloadPinGLB(pin);
}

// Swap a pin's rendered GLB to its current avatar_url after a re-skin (C6). Safe
// whether the pin is mid-load (queues the swap for when the in-flight load
// settles), or already showing a model/impostor. The baked impostor + mounted
// model are of the OLD avatar, so drop both and reset the LOD band; enforceLOD
// re-bakes and re-mounts from the new (versioned, cache-busting) url next pass.
function reloadPinGLB(pin) {
	if (pin._glbLoading) { pin._reloadQueued = true; return; }
	evictPinGLB(pin);
	disposeImpostor(pin);
	pin._lod = null;       // force enforceLOD to re-evaluate + reload this pin
	showDot(pin);
}


function updateNearbyBadge() {
	const badge = document.getElementById('irl-nearby-badge');
	if (!badge) return;
	const n = nearbyPins.length;
	// Compute the target text/class first, then only write when it changes — the badge
	// is aria-live, so re-setting identical content on every reconcile would spam a
	// screen reader.
	let text, mod;
	if (_nearbyError) {
		// Visible, not silent: the 15 s poll retries; show we know the data is stale.
		text = n > 0 ? `${n} nearby · refresh failed` : 'Couldn’t load nearby — retrying…';
		mod = 'is-error';
	} else if (_nearbyRateLimited) {
		// Calm + specific + self-healing: we backed off, the next cycle resumes. Keep any
		// pins we already have visible ("N nearby · catching up"); never an error tone.
		text = n > 0 ? `${n} nearby · catching up…` : 'Refreshing too fast — catching up…';
		mod = 'is-rate';
	} else if (n > 0) {
		text = `${n} nearby`;
		mod = '';
	} else if (gpsState.ready && _nearbyLoaded) {
		// GPS-ready, the first read has landed, and nobody's here — a designed empty state
		// that invites the user to be the first, rather than hiding (reads as "feature off").
		text = 'No agents nearby — be the first to pin here';
		mod = 'is-empty';
	} else if (gpsState.ready) {
		// Fix in hand but the first proximity read hasn't returned — still "looking", NOT
		// empty. Gating on _nearbyLoaded above stops the empty "0 nearby" flash before we
		// actually know whether anyone is here.
		text = 'Looking for agents nearby…';
		mod = 'is-acquiring';
	} else if (_gpsAcquiring) {
		// Granted but no fix yet — a distinct, honest "finding you" state (shimmer skeleton
		// in CSS) so the pre-fix gap never reads as the empty "nobody's here" state.
		text = 'Finding your location…';
		mod = 'is-acquiring';
	} else {
		// No location yet (denied / not asked) → nothing to say about "nearby"; stay
		// hidden until a fix lands. The permission chips own the recovery path.
		text = '';
		mod = 'hidden';
	}
	badge.classList.toggle('is-error', mod === 'is-error');
	badge.classList.toggle('is-empty', mod === 'is-empty');
	badge.classList.toggle('is-rate', mod === 'is-rate');
	badge.classList.toggle('is-acquiring', mod === 'is-acquiring');
	if (mod === 'hidden') { badge.hidden = true; discovery.setEmpty(false); return; }
	badge.hidden = false;
	if (badge.textContent !== text) badge.textContent = text;
	// Task 02 — the designed in-scene "keep exploring" prompt shows ONLY in the
	// genuine empty state (GPS ready, first read landed, nobody here). Every other
	// state (looking, acquiring, populated, error, rate-limited) retires it. The
	// badge above owns the polite SR announcement; the prompt is the visual story.
	discovery.setEmpty(mod === 'is-empty', { ar: arActive });
}

// ── My Pins management ────────────────────────────────────────────────────
//
// Anonymous ownership: pins are tied to the localStorage device token, so a
// visitor can browse and delete the pins they placed from this device even
// after a reload — no account needed. The endpoint also unions in any pins the
// user placed while signed in.

const TRASH_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';

// Haversine distance in metres between two GPS points
function haversineMeters(lat1, lng1, lat2, lng2) {
	const R = 6371000;
	const dLat = (lat2 - lat1) * Math.PI / 180;
	const dLng = (lng2 - lng1) * Math.PI / 180;
	const a = Math.sin(dLat / 2) ** 2 +
		Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
	return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function relativeTime(iso) {
	const t = new Date(iso).getTime();
	if (!isFinite(t)) return '';
	const secs = Math.max(0, Math.round((Date.now() - t) / 1000));
	if (secs < 60) return 'just now';
	const mins = Math.round(secs / 60);
	if (mins < 60) return `${mins}m ago`;
	const hrs = Math.round(mins / 60);
	if (hrs < 24) return `${hrs}h ago`;
	return `${Math.round(hrs / 24)}d ago`;
}

// Expiry phrasing for the My-pins meta line. Anonymous pins self-destruct on a
// 7-day timer (a countdown, so a tester knows exactly when a forgotten test pin
// is gone); signed-in pins are permanent. Returns { label, cls } so the row can
// tint the chip amber when a pin is within a day of expiring.
function relativeExpiry(iso) {
	if (!iso) return { label: 'permanent', cls: 'is-perm' };
	const t = new Date(iso).getTime();
	if (!isFinite(t)) return { label: 'permanent', cls: 'is-perm' };
	const secs = Math.round((t - Date.now()) / 1000);
	if (secs <= 0) return { label: 'expired', cls: 'is-soon' }; // shouldn't surface — the feed filters expired
	const days = Math.floor(secs / 86400);
	if (days >= 1) return { label: `expires in ${days}d`, cls: days <= 1 ? 'is-soon' : '' };
	const hrs = Math.floor(secs / 3600);
	if (hrs >= 1) return { label: `expires in ${hrs}h`, cls: 'is-soon' };
	const mins = Math.max(1, Math.floor(secs / 60));
	return { label: `expires in ${mins}m`, cls: 'is-soon' };
}

// Composes the meta line — distance · age · expiry — as one line. Returns HTML:
// the expiry segment is a styled chip, so the dynamic text pieces are escaped
// here and renderMyPins inserts the result without re-escaping.
function _pinMetaLine(p) {
	const parts = [];
	if (gpsState.ready && isFinite(p.lat) && isFinite(p.lng)) {
		parts.push(_escHtml(`${Math.round(haversineMeters(gpsState.lat, gpsState.lng, p.lat, p.lng))}m away`));
	}
	if (p.placed_at) parts.push(_escHtml(relativeTime(p.placed_at)));
	const exp = relativeExpiry(p.expires_at);
	parts.push(`<span class="irl-pin-exp ${exp.cls}">${_escHtml(exp.label)}</span>`);
	return parts.join(' · ');
}

// Exact/Approximate badge (H4) for an owned pin row — so the owner always sees how
// exposed each placement is. An approximate pin shows its blur radius; precise (and
// legacy pins with no placement_kind) show the exact pin. Returns escaped HTML.
function _placementBadgeHTML(p) {
	const approx = p?.placement_kind === 'approximate';
	const text = approx
		? `≈ Approximate (~${Math.round(Number(p.fuzz_radius_m) || PLACEMENT_FUZZ_DEFAULT)} m)`
		: '📍 Exact';
	const title = approx
		? 'Stored at a deliberately blurred spot — your exact location was never saved.'
		: 'Stored at the exact spot you placed it.';
	return `<span class="irl-pin-place${approx ? ' is-approx' : ''}" title="${_escHtml(title)}">${_escHtml(text)}</span>`;
}

// Designed empty state for the My-pins sheet — shared by loadInto (sheet open)
// and deleteMyPin (when the last pin is removed) so the copy never diverges.
const MYPINS_EMPTY = {
	icon: '📍',
	title: 'No active pins yet',
	body: 'Pin your agent to a real-world spot and it shows up here to manage.',
};

// Throws on failure (network or non-2xx) so callers can tell a real error from a
// genuinely empty list — openMyPinsSheet routes that through loadInto's error
// state instead of silently showing "no pins". Returns [] only when this device
// has no token yet (nothing could have been placed).
async function loadMyPins() {
	if (!_deviceToken) return [];
	const r = await fetch('/api/irl/pins/mine', {
		credentials: 'include',
		headers: deviceHeaders(),
	});
	if (!r.ok) throw new Error(`HTTP ${r.status}`);
	const pins = (await r.json()).pins ?? [];
	// Track which nearby pins this device owns so the calibrate affordance (and
	// the gold "your agent" label) light up. The server re-checks ownership on
	// PATCH, so this is purely a client-side gate.
	for (const p of pins) _myPinIds.add(p.id);
	refreshOwnLabels();
	return pins;
}

// Re-mark already-spawned nearby labels as own once /mine resolves (the pins may
// have spawned before we knew which were ours).
function refreshOwnLabels() {
	for (const p of nearbyPins) {
		if (p.labelEl) p.labelEl.classList.toggle('is-own', isOwnPin(p));
	}
}

// Renders the populated list into the sheet container. Empty/error/loading are
// owned by loadInto in openMyPinsSheet — this only paints rows.
function renderMyPins(pins, listEl) {
	const list = listEl || document.getElementById('irl-mypins-list');
	if (!list) return;
	list.innerHTML = pins.map(p => `<div class="irl-pin-row" data-pid="${_escHtml(p.id)}">
		<div class="irl-pin-info">
			<div class="irl-pin-name"><span class="irl-pin-name-txt">${_escHtml(p.avatar_name || 'Agent')}</span>${_placementBadgeHTML(p)}</div>
			${p.caption ? `<div class="irl-pin-caption">${_escHtml(p.caption)}</div>` : ''}
			<div class="irl-pin-meta">${_pinMetaLine(p)}</div>
		</div>
		<button class="irl-pin-del" data-del="${_escHtml(p.id)}" type="button" aria-label="Delete this pin">${TRASH_SVG}</button>
	</div>`).join('');
}

// ── My-pins overview map (lazy Leaflet) ────────────────────────────────────
// A small dark map above the list plots every owned pin, so "where did I drop
// things?" is answered visually. The map is a pure enhancement: the list is the
// source of truth, and any CDN failure degrades to the list alone (Rule 9).
let _myPinsMap = null;             // Leaflet map for the sheet, or null when down
const _myPinsMarkers = new Map();  // pin id -> Leaflet marker
let _myPinsMapSeq = 0;             // bumped each open/close; guards async CDN builds
let _purgeKeydown = null;          // active confirm focus-trap handler, or null

// A gold dot marker — matches the "your agent" gold used on nearby labels.
function makeMyPinIcon(L) {
	return L.divIcon({
		className: 'irl-mypins-pin',
		html: '<span class="irl-mypins-marker"></span>',
		iconSize: [14, 14],
		iconAnchor: [7, 7],
	});
}

function teardownMyPinsMap() {
	try { _myPinsMap?.remove(); } catch { /* leaflet teardown best-effort */ }
	_myPinsMap = null;
	_myPinsMarkers.clear();
	const mapEl = document.getElementById('irl-mypins-map');
	if (mapEl) { mapEl.classList.remove('is-shown'); mapEl.innerHTML = ''; }
}

function closePurgeConfirmTrap() {
	if (_purgeKeydown) { document.removeEventListener('keydown', _purgeKeydown, true); _purgeKeydown = null; }
}

function hideMyPinsFooter() {
	closePurgeConfirmTrap();
	const foot = document.getElementById('irl-mypins-foot');
	if (foot) { foot.hidden = true; foot.innerHTML = ''; }
}

// Clean slate on every open: void any in-flight CDN build, drop the old map +
// footer, and show the map skeleton so the loading state reads as "map + rows".
function resetMyPinsChrome() {
	_myPinsMapSeq++;
	teardownMyPinsMap();
	hideMyPinsFooter();
	const mapEl = document.getElementById('irl-mypins-map');
	if (mapEl) {
		mapEl.classList.add('is-shown');
		mapEl.innerHTML = '<div class="irl-mypins-map-skel" aria-hidden="true"></div>';
	}
}

// Tapping a marker scrolls its row into view and flashes it, so the map and list
// stay legibly linked.
function highlightMyPinRow(id) {
	const list = document.getElementById('irl-mypins-list');
	if (!list) return;
	const sel = (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(id) : String(id).replace(/"/g, '\\"');
	const row = list.querySelector(`.irl-pin-row[data-pid="${sel}"]`);
	if (!row) return;
	row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
	row.classList.remove('is-highlight');
	void row.offsetWidth;              // restart the flash if already highlighted
	row.classList.add('is-highlight');
	setTimeout(() => row.classList.remove('is-highlight'), 1600);
}

// Re-fit the map to whatever markers remain (after a single delete). Empties → hide.
function refitMyPinsMap() {
	if (!_myPinsMap) return;
	if (!_myPinsMarkers.size) { teardownMyPinsMap(); return; }
	const lls = [...(_myPinsMarkers.values())].map(m => m.getLatLng());
	if (lls.length === 1) _myPinsMap.setView(lls[0], 16);
	else { try { _myPinsMap.fitBounds(lls, { padding: [28, 28], maxZoom: 17 }); } catch { /* noop */ } }
}

function removeMyPinMarker(id) {
	const mk = _myPinsMarkers.get(id);
	if (mk) { try { _myPinsMap?.removeLayer(mk); } catch { /* best-effort */ } }
	_myPinsMarkers.delete(id);
	refitMyPinsMap();
}

// Builds the Leaflet map + a marker per owned pin and fits to them. Awaits the
// shared lazy loader; on any CDN failure or a sheet that closed mid-load, it
// quietly drops back to the list. `_myPinsMapSeq` guards against a stale build
// mounting after the sheet was reopened.
async function renderMyPinsMap(pins) {
	const seq = _myPinsMapSeq;
	const mapEl = document.getElementById('irl-mypins-map');
	if (!mapEl) return;
	const geo = pins.filter(p => isFinite(+p.lat) && isFinite(+p.lng));
	if (!geo.length) { teardownMyPinsMap(); return; }   // nothing to plot → list only

	let L;
	try { L = await loadLeaflet(); }
	catch { if (seq === _myPinsMapSeq) teardownMyPinsMap(); return; }   // CDN blocked/offline → list only
	if (seq !== _myPinsMapSeq || !mapEl.isConnected) return;            // sheet closed/reopened mid-load

	mapEl.innerHTML = '';
	const map = L.map(mapEl, { zoomControl: true, attributionControl: true, scrollWheelZoom: false });
	_myPinsMap = map;
	L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
		attribution: '© OpenStreetMap · © CARTO',
		subdomains: 'abcd',
		maxZoom: 19,
	}).addTo(map);

	_myPinsMarkers.clear();
	const latlngs = [];
	for (const p of geo) {
		const ll = [+p.lat, +p.lng];
		latlngs.push(ll);
		const mk = L.marker(ll, { keyboard: false, icon: makeMyPinIcon(L), title: p.avatar_name || 'Your pin' }).addTo(map);
		mk.on('click', () => highlightMyPinRow(p.id));
		_myPinsMarkers.set(p.id, mk);
	}
	if (latlngs.length === 1) map.setView(latlngs[0], 16);
	else map.fitBounds(latlngs, { padding: [28, 28], maxZoom: 17 });

	// The sheet animates in (translateY), so the map can mount mid-transition;
	// Leaflet must re-measure once layout settles or tiles render into a 0-size box.
	requestAnimationFrame(() => { if (seq === _myPinsMapSeq && _myPinsMap === map) map.invalidateSize(); });
	setTimeout(() => { if (seq === _myPinsMapSeq && _myPinsMap === map) map.invalidateSize(); }, 320);
}

// ── Bulk purge — "Remove all from this device" ─────────────────────────────
// A footer affordance for fast cleanup after a testing session. Only shown for an
// anonymous device with ≥1 pin; signed-in permanent pins are managed from the
// dashboard (out of scope here), so the button is gated on _deviceToken.
function renderPurgeFooter(count) {
	const foot = document.getElementById('irl-mypins-foot');
	if (!foot) return;
	if (!_deviceToken || count < 1) { hideMyPinsFooter(); return; }
	closePurgeConfirmTrap();
	foot.hidden = false;
	foot.innerHTML = `<button class="irl-mypins-purge" id="irl-mypins-purge" type="button"
		aria-label="Remove all ${count} agent${count === 1 ? '' : 's'} you placed from this device">
		${TRASH_SVG}<span>Remove all from this device</span>
	</button>`;
	foot.querySelector('#irl-mypins-purge')?.addEventListener('click', () => openPurgeConfirm(count));
}

// A designed confirm step (not window.confirm): focus-trapped between Cancel and
// Remove, Esc cancels, default focus on Cancel (the safe choice for a destructive
// action).
function openPurgeConfirm(count) {
	const foot = document.getElementById('irl-mypins-foot');
	if (!foot) return;
	foot.hidden = false;
	foot.innerHTML = `<div class="irl-mypins-confirm" role="alertdialog" aria-modal="true" aria-labelledby="irl-purge-q">
		<p class="irl-mypins-confirm-q" id="irl-purge-q">Remove all ${count} agent${count === 1 ? '' : 's'} you placed from this device? This can’t be undone.</p>
		<div class="irl-mypins-confirm-row">
			<button class="irl-mypins-confirm-cancel" type="button" data-cancel>Cancel</button>
			<button class="irl-mypins-confirm-go" type="button" data-go>Remove all</button>
		</div>
	</div>`;
	const cancelBtn = foot.querySelector('[data-cancel]');
	const goBtn     = foot.querySelector('[data-go]');
	cancelBtn?.addEventListener('click', () => closePurgeConfirm(count));
	goBtn?.addEventListener('click', () => runPurge(goBtn, cancelBtn));
	closePurgeConfirmTrap();
	_purgeKeydown = (ev) => {
		if (ev.key === 'Escape') { ev.preventDefault(); closePurgeConfirm(count); return; }
		if (ev.key !== 'Tab') return;
		const order = [cancelBtn, goBtn].filter(Boolean);
		if (!order.length) return;
		ev.preventDefault();
		const i = order.indexOf(document.activeElement);
		const n = order.length;
		const next = ev.shiftKey ? (i <= 0 ? n - 1 : i - 1) : (i >= n - 1 ? 0 : i + 1);
		order[next]?.focus();
	};
	document.addEventListener('keydown', _purgeKeydown, true);
	cancelBtn?.focus();
}

function closePurgeConfirm(count) {
	closePurgeConfirmTrap();
	renderPurgeFooter(count);   // back to the "Remove all" button
	document.getElementById('irl-mypins-purge')?.focus();
}

// One request deletes every pin tied to this device token; the sheet then lands
// on the empty state. The list is read for the about-to-be-purged ids so their
// nearby labels stop reading as "yours".
async function runPurge(goBtn, cancelBtn) {
	if (goBtn) { goBtn.disabled = true; goBtn.textContent = 'Removing…'; }
	if (cancelBtn) cancelBtn.disabled = true;
	const r = await fetch(
		'/api/irl/pins?all=1',
		{
			method: 'DELETE',
			credentials: 'include',
			headers: deviceHeaders({ 'Content-Type': 'application/json' }),
			body: JSON.stringify({ deviceToken: _deviceToken }),
		},
	).catch(() => null);
	if (!r?.ok) {
		if (goBtn) { goBtn.disabled = false; goBtn.textContent = 'Remove all'; }
		if (cancelBtn) cancelBtn.disabled = false;
		setStatus('Could not remove your pins', { error: true });
		return;
	}
	let deleted = 0;
	try { deleted = (await r.json()).deleted ?? 0; } catch { /* count is best-effort */ }

	closePurgeConfirmTrap();
	// If a pin anchored in this session was among them, release the lock.
	if (gpsPin?.id && _myPinIds.has(gpsPin.id)) setLocked(false);
	const list = document.getElementById('irl-mypins-list');
	if (list) for (const row of list.querySelectorAll('.irl-pin-row')) _myPinIds.delete(row.dataset.pid);
	refreshOwnLabels();

	teardownMyPinsMap();
	hideMyPinsFooter();
	if (list) { ensureStateKitStyles(); list.innerHTML = emptyStateHTML(MYPINS_EMPTY); }
	setStatus(deleted > 0 ? `Removed ${deleted} pin${deleted === 1 ? '' : 's'} from this device` : 'Nothing to remove');
}

async function openMyPinsSheet() {
	const sheet = document.getElementById('irl-mypins-sheet');
	const list  = document.getElementById('irl-mypins-list');
	if (!sheet || !list) return;
	sheet.classList.add('is-open');
	// Trap focus + Escape. suspendWhile defers to the bulk-purge confirm's own trap
	// when it's open, so Escape there closes only the confirm, not the whole sheet.
	trapSheet(sheet, closeMyPinsSheet, {
		initialFocus: document.getElementById('irl-mypins-close'),
		suspendWhile: () => !!document.querySelector('.irl-mypins-confirm'),
	});
	resetMyPinsChrome();   // map skeleton on, footer + any stale confirm cleared
	// Designed loading → list / empty / error(+retry). loadInto returns the data on
	// success or null when empty/errored; the map + purge footer ride a real,
	// non-empty result — in the empty and error cases the list is the source of truth.
	const pins = await loadInto(list, {
		load: loadMyPins,
		render: (pins, el) => renderMyPins(pins, el),
		skeleton: { count: 3, variant: 'row' },
		empty: MYPINS_EMPTY,
		error: { title: "Couldn't load your pins", body: 'Check your connection and try again.' },
		context: 'irl:my-pins',
	});
	if (pins && pins.length) {
		renderMyPinsMap(pins);          // async; degrades to the list on any CDN failure
		renderPurgeFooter(pins.length);
	} else {
		teardownMyPinsMap();            // empty/error → no map, no footer
		hideMyPinsFooter();
	}
}

function closeMyPinsSheet() {
	const sheet = document.getElementById('irl-mypins-sheet');
	sheet?.classList.remove('is-open');
	releaseSheet(sheet);
	_myPinsMapSeq++;        // void any in-flight CDN build
	teardownMyPinsMap();
	hideMyPinsFooter();
}

async function deleteMyPin(id, btn) {
	if (btn) { btn.disabled = true; btn.innerHTML = '…'; }
	const r = await fetch(
		`/api/irl/pins?id=${encodeURIComponent(id)}`,
		{
			method: 'DELETE',
			credentials: 'include',
			headers: deviceHeaders({ 'Content-Type': 'application/json' }),
			body: JSON.stringify({ deviceToken: _deviceToken }),
		},
	).catch(() => null);
	if (!r?.ok) {
		if (btn) { btn.disabled = false; btn.innerHTML = TRASH_SVG; }
		setStatus('Could not delete that pin', { error: true });
		return;
	}
	// If we just deleted the avatar currently anchored in this session, clear it.
	if (gpsPin?.id === id) setLocked(false);
	_myPinIds.delete(id);

	// Drop the row + its map marker so the overview stays honest with the list.
	btn?.closest('.irl-pin-row')?.remove();
	removeMyPinMarker(id);
	const list = document.getElementById('irl-mypins-list');
	const remaining = list ? list.querySelectorAll('.irl-pin-row').length : 0;
	if (!remaining) {
		ensureStateKitStyles();
		if (list) list.innerHTML = emptyStateHTML(MYPINS_EMPTY);
		teardownMyPinsMap();
		hideMyPinsFooter();
	} else {
		renderPurgeFooter(remaining);   // keep the purge button's aria-count accurate
	}
	setStatus('Pin removed');
}

// Reveal the My pins control once GPS is live and this device has a token.
function revealMyPinsBtn() {
	if (!_deviceToken) return;
	const btn = document.getElementById('irl-mypins-btn');
	if (btn) btn.style.display = '';
}

document.getElementById('irl-mypins-btn')?.addEventListener('click', openMyPinsSheet);
document.getElementById('irl-mapplace-btn')?.addEventListener('click', startMapPlacement);

// ── "Appear to others nearby" toggle (D2) ──────────────────────────────────
// Reflects the stored opt-in on the pill (default off) and flips it live: the
// preference persists, and setGhost() pushes it to the room so co-viewers see the
// ghost appear / disappear without anyone reconnecting. Seeing others is always
// on; this gates only being seen.
function syncGhostToggle() {
	const btn = document.getElementById('irl-ghost-toggle');
	if (!btn) return;
	const on = getShareGhost();
	btn.classList.toggle('is-active', on);
	btn.setAttribute('aria-pressed', on ? 'true' : 'false');
	btn.title = on
		? 'You appear as a ghost to others viewing this area. Tap to hide.'
		: 'Only your presence count is shared. Tap to appear as a ghost to others nearby.';
}
// Single path for flipping the presence opt-in — used by the topbar pill AND the
// L3 privacy center, so both stay in sync (pill state, stored intent, live room).
function applyGhost(on) {
	setShareGhost(on);
	syncGhostToggle();
	// Push the change to the live room (no-op off a live socket; the next connect
	// carries the stored intent regardless).
	irlNet?.setGhost(on, resolveAvatarUrl(_currentAvatarId));
	setStatus(on ? 'You now appear to others nearby' : 'You no longer appear to others');
}
document.getElementById('irl-ghost-toggle')?.addEventListener('click', () => applyGhost(!getShareGhost()));
syncGhostToggle();

// Arrival-cue mute toggle (task 03) — persisted; reflects state into the button.
document.getElementById('irl-cue-mute')?.addEventListener('click', () => setCueMuted(!_cueMuted));
syncCueMuteButton();

// ── Immersive mode ────────────────────────────────────────────────────────
// Collapse every chrome layer (topbar, bottom panel, radar, room badge, aim
// HUD, hints) so the live AR view is unobstructed. The joystick and
// drag-to-orbit stay live underneath, so you can still look around and move the
// avatar while hidden. Two ways in/out, tuned per device:
//   • Touch  — chrome auto-hides after idle (once the camera is live); tap empty
//     space (or the eye button) to bring it back. Joystick/drag never reveal it,
//     so you can move freely with nothing in the way.
//   • Desktop — a focus/cinematic mode: controls behave like a video player
//     (move the mouse to reveal, idle to hide), with H to toggle, F for
//     fullscreen, Esc to restore.
const immersiveBtn   = document.getElementById('irl-immersive-toggle');
const immersiveHint  = document.getElementById('irl-immersive-hint');
const FINE_POINTER   = typeof matchMedia === 'function'
	&& matchMedia('(hover: hover) and (pointer: fine)').matches;
const IMMERSIVE_IDLE_MS = FINE_POINTER ? 4500 : 5000;
let _idleTimer = 0;
let _hintShown = false;
let _engaged   = false;   // never auto-hide until the user has actually interacted

const chromeHidden = () => document.body.classList.contains('irl-immersive');

function setImmersive(on) {
	document.body.classList.toggle('irl-immersive', on);
	if (immersiveBtn) {
		immersiveBtn.setAttribute('aria-pressed', String(on));
		const label = on ? 'Show controls' : 'Hide controls';
		const hotkey = FINE_POINTER ? ' (H)' : '';
		immersiveBtn.setAttribute('aria-label', label);
		immersiveBtn.title = label + hotkey;
	}
}

// Auto-hide is appropriate only when there's a live scene to enjoy and nothing
// modal is competing for the screen: on touch that means the camera is on; on
// desktop the 3D walk view always qualifies. A focused input or open sheet
// (movementKeysCaptured) always blocks it, and so does an active room-placement.
function _canAutoHide() {
	if (!_engaged || chromeHidden() || movementKeysCaptured()) return false;
	const aimHud = document.getElementById('irl-aim-hud');
	if (aimHud && aimHud.classList.contains('is-open')) return false;
	if (!FINE_POINTER && !document.body.classList.contains('is-ar')) return false;
	return true;
}
function _armIdle() {
	clearTimeout(_idleTimer);
	if (!_canAutoHide()) return;
	_idleTimer = setTimeout(() => {
		if (!_canAutoHide()) return;
		setImmersive(true);
		_flashImmersiveHint();
	}, IMMERSIVE_IDLE_MS);
}

// One-time coachmark the first time the chrome disappears, so the reveal gesture
// is discoverable. The eye button stays on screen regardless, so this only ever
// shows once per device.
function _flashImmersiveHint() {
	if (!immersiveHint || _hintShown) return;
	try { if (localStorage.getItem('irl_immersive_hinted')) { _hintShown = true; return; } } catch {}
	_hintShown = true;
	try { localStorage.setItem('irl_immersive_hinted', '1'); } catch {}
	immersiveHint.textContent = FINE_POINTER
		? 'Move the mouse or press H to show controls'
		: 'Tap anywhere to show controls';
	immersiveHint.classList.add('is-visible');
	clearTimeout(_flashImmersiveHint._t);
	_flashImmersiveHint._t = setTimeout(() => immersiveHint.classList.remove('is-visible'), 2800);
}

// Deliberate toggle (eye button, H key, tap on empty scene). Showing re-arms the
// idle timer; hiding cancels it and is sticky until the user asks for chrome again.
function toggleImmersive() {
	if (chromeHidden()) {
		setImmersive(false);
		immersiveHint?.classList.remove('is-visible');
		_armIdle();
	} else {
		setImmersive(true);
		clearTimeout(_idleTimer);
		_flashImmersiveHint();
	}
}
// Reveal without toggling (desktop pointer motion / any explicit "show"): restore
// chrome if hidden, then re-arm so it fades again after the next idle stretch.
function revealChrome() {
	if (chromeHidden()) { setImmersive(false); immersiveHint?.classList.remove('is-visible'); }
	_armIdle();
}

immersiveBtn?.addEventListener('click', toggleImmersive);

window.addEventListener('keydown', (e) => {
	if (movementKeysCaptured() && e.key !== 'Escape') return;
	if (e.key === 'Escape') {
		if (chromeHidden()) { setImmersive(false); _armIdle(); }
		return;
	}
	if (e.key === 'h' || e.key === 'H') { toggleImmersive(); }
	else if (e.key === 'f' || e.key === 'F') { toggleFullscreen(); }
	else { _engaged = true; _armIdle(); }   // any other walk key resets the idle countdown
});

// Real fullscreen (desktop focus mode). iOS Safari has no element Fullscreen API,
// so this no-ops there — the optional-chaining guards make that graceful.
function toggleFullscreen() {
	const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
	if (fsEl) {
		(document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
	} else {
		const el = document.documentElement;
		(el.requestFullscreen || el.webkitRequestFullscreen)?.call(el);
	}
}

// Activity wiring. Touch: world interaction only re-arms the hide timer (it must
// NOT reveal, so the user can move/look with the chrome gone). Desktop: pointer
// motion reveals like a video player. Joystick + canvas taps are the world.
const _noteWorldActivity = () => { _engaged = true; _armIdle(); };
if (FINE_POINTER) {
	let _moveThrottle = 0;
	window.addEventListener('pointermove', (e) => {
		if (e.pointerType === 'touch') return;
		const now = e.timeStamp || 0;
		if (now - _moveThrottle < 200) return;
		_moveThrottle = now;
		if (movementKeysCaptured()) return;
		_engaged = true;
		revealChrome();
	}, { passive: true });
}
canvas.addEventListener('pointerdown', _noteWorldActivity, { passive: true });
joystickEl?.addEventListener('pointerdown', _noteWorldActivity, { passive: true });
// Once the camera goes live, start the idle countdown (the body gains .is-ar in
// enableAR); a class-watch keeps this independent of that code path's internals.
new MutationObserver(() => {
	if (document.body.classList.contains('is-ar')) { _engaged = true; _armIdle(); }
}).observe(document.body, { attributes: true, attributeFilter: ['class'] });

// L3 — Location & privacy center: honest disclosure + discovery precision +
// presence opt-in + a jump into pin management, all in one designed surface.
document.getElementById('irl-privacy-btn')?.addEventListener('click', () => {
	closeMoreSheet();
	openPrivacyCenter({
		getGhost: getShareGhost,
		setGhost: applyGhost,
		onManagePins: openMyPinsSheet,
		// A delete/unpublish from the data panel must vanish from the live world too.
		onChanged: () => { loadNearbyPins().catch(() => {}); },
	});
});

// Connect smart glasses — mirror the nearest-agent cue to a Frame / G1 lens over Web
// Bluetooth. The button reflects the live link state so a connected pair reads at a
// glance; the sheet owns the capability gate, pairing flow and disconnect.
const glassesBtn = document.getElementById('irl-glasses-btn');
function syncGlassesButton() {
	if (!glassesBtn) return;
	const on = glassesBridge.connected;
	glassesBtn.classList.toggle('is-connected', on);
	glassesBtn.setAttribute('aria-pressed', String(on));
	const label = on ? `Glasses connected — ${glassesBridge.deviceName || 'tap to manage'}` : 'Connect smart glasses';
	glassesBtn.setAttribute('aria-label', label);
	glassesBtn.title = label;
	const sub = document.getElementById('irl-glasses-sub');
	if (sub) sub.textContent = on ? `Connected — ${glassesBridge.deviceName || 'tap to manage'}` : 'Mirror the nearest-agent cue to a paired lens';
}
glassesBtn?.addEventListener('click', () => { closeMoreSheet(); openGlassesConnect(glassesBridge); });
glassesBridge.on('status', syncGlassesButton);
syncGlassesButton();
// Clean BLE teardown if the page goes away while paired.
window.addEventListener('pagehide', () => { try { glassesBridge.destroy(); } catch {} });

// "More" overflow sheet — arrival sound, location & privacy, World Lines,
// smart glasses. Mirrors the My Pins sheet's open/close + focus-trap contract.
const moreBtn = document.getElementById('irl-more-btn');
function openMoreSheet() {
	const sheet = document.getElementById('irl-more-sheet');
	if (!sheet) return;
	sheet.classList.add('is-open');
	moreBtn?.setAttribute('aria-expanded', 'true');
	trapSheet(sheet, closeMoreSheet, { initialFocus: document.getElementById('irl-more-close') });
}
function closeMoreSheet() {
	const sheet = document.getElementById('irl-more-sheet');
	sheet?.classList.remove('is-open');
	moreBtn?.setAttribute('aria-expanded', 'false');
	releaseSheet(sheet);
}
moreBtn?.addEventListener('click', openMoreSheet);
document.getElementById('irl-more-close')?.addEventListener('click', closeMoreSheet);

document.getElementById('irl-mypins-close')?.addEventListener('click', closeMyPinsSheet);

document.getElementById('irl-mypins-list')?.addEventListener('click', (e) => {
	const btn = e.target.closest('[data-del]');
	if (btn) deleteMyPin(btn.dataset.del, btn);
});

// ── Inspect card (v2) helpers ──────────────────────────────────────────────
// Tapping a nearby agent opens a rich card: avatar + name + tier badge, a bio
// line, an on-chain reputation strip, and the paid x402 services the agent
// offers — all from one /api/irl/agent-card aggregation call. Every state
// (skeleton, populated, empty services, no-reputation, error+retry) renders
// through the shared state-kit.

let _cardAbort = null;   // aborts the in-flight agent-card fetch when switching agents
let _activePin = null;   // the pin whose card is shown (drives retry)
let _lastFocus = null;   // element focused before open (restored on close)

// Title-case a tier enum ('trusted' → 'Trusted').
function _tierLabel(tier) {
	return tier ? tier.charAt(0).toUpperCase() + tier.slice(1) : '';
}

// Reputation strip / chip. A real number only when the on-chain asset actually
// has attestations; otherwise an honest "new / unreviewed" chip — never a
// fabricated score.
function _repStripHTML(rep) {
	const hasRep = rep && rep.available && rep.attestation_count > 0;
	if (!hasRep) {
		const label = rep && rep.available
			? 'On-chain · no reviews yet'
			: 'New here · no on-chain reputation yet';
		return `<div class="irl-rep-chip">✦ ${label}</div>`;
	}
	const n = rep.attestation_count;
	const parts = [
		`<span class="irl-rep-star">★</span> <b>${rep.score}</b>/100`,
		`${n} attestation${n === 1 ? '' : 's'}`,
		_tierLabel(rep.tier),
	];
	if (rep.tasks_accepted > 0) {
		parts.push(`${rep.tasks_accepted} task${rep.tasks_accepted === 1 ? '' : 's'} done`);
	}
	return `<div class="irl-rep-strip">${parts.join('<span class="irl-rep-sep">·</span>')}</div>`;
}

// Header tier badge — only when reputation is real (an asset with attestations).
function _setTierBadge(rep) {
	const badge = document.getElementById('irl-sheet-tier');
	if (!badge) return;
	if (rep && rep.available && rep.attestation_count > 0 && rep.tier) {
		badge.textContent = `★ ${rep.score} · ${_tierLabel(rep.tier)}`;
		badge.dataset.tier = rep.tier;
		badge.hidden = false;
	} else {
		badge.hidden = true;
		badge.removeAttribute('data-tier');
	}
}

// Services menu, or a designed empty state when the agent sells nothing.
function _servicesHTML(services) {
	if (!services || !services.length) {
		return emptyStateHTML({
			icon: '',
			title: 'No paid services yet',
			body: 'This agent is here to meet, not to sell.',
			compact: true,
		});
	}
	const rows = services.map((s) => {
		const price = s.price_usd != null
			? `$${Number(s.price_usd).toFixed(2)} ${s.currency || 'USDC'}`
			: 'Free';
		const ep = s.x402_endpoint || '';
		// Stamp price + skill + name on the button so the pay handler can bound
		// maxPaymentUsd to exactly what's displayed and attribute the interaction.
		const useBtn = ep
			? `<button type="button" class="irl-service-use" data-x402="${_escHtml(ep)}" data-price="${s.price_usd != null ? Number(s.price_usd) : ''}" data-skill="${_escHtml(s.skill || '')}" data-name="${_escHtml(s.name || s.skill || 'Service')}">Use</button>`
			: '';
		return `<div class="irl-service-row">
			<div class="irl-service-info">
				<span class="irl-service-name">${_escHtml(s.name || s.skill)}</span>
				${s.description ? `<span class="irl-service-desc">${_escHtml(s.description)}</span>` : ''}
			</div>
			<span class="irl-service-price">${_escHtml(price)}</span>
			${useBtn}
		</div>`;
	}).join('');
	return `<div class="irl-sheet-services">
		<div class="irl-services-label">Services</div>
		<div class="irl-services-list">${rows}</div>
	</div>`;
}

// Loading skeleton for the card body (a bio line + a few service rows).
function _cardSkeletonHTML() {
	ensureStateKitStyles();
	return `${skeletonHTML(1, 'text')}${skeletonHTML(3, 'row')}`;
}

const _TAPTIP_B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// Build the IRL "tap to tip" block: a Solana Pay QR + a one-tap deep link to the
// agent's real public address. This is the moment that only exists when you meet
// an autonomous agent in physical space — scan the QR with a phone wallet, or tap
// "Open in wallet" to launch Phantom/Solflare pre-filled. Public data only (the
// agent's solana_address); no secret is ever involved. Returns null when the
// agent has no valid address so the card simply omits the block.
function _buildTapToTip(agent) {
	const address = agent?.solana_address;
	if (!address || !_TAPTIP_B58.test(String(address))) return null;
	const label = (agent.name || 'three.ws agent').slice(0, 32);
	const uri = buildSolanaPayUri(address, { label });
	if (!uri) return null;

	const wrap = document.createElement('div');
	wrap.className = 'irl-taptip';
	wrap.innerHTML =
		`<button type="button" class="irl-taptip-toggle" aria-expanded="false">` +
		`<span>◎ Tap to tip in person</span><span class="irl-taptip-caret">▾</span></button>` +
		`<div class="irl-taptip-panel" hidden>` +
		`<div class="irl-taptip-qr" aria-hidden="true"></div>` +
		`<div class="irl-taptip-meta">` +
		`<div class="irl-taptip-cap">Scan with Phantom · Solflare · Backpack</div>` +
		`<a class="irl-taptip-open" href="${uri}">Open in wallet ↗</a>` +
		`</div></div>`;

	const toggle = wrap.querySelector('.irl-taptip-toggle');
	const panel = wrap.querySelector('.irl-taptip-panel');
	const qrSlot = wrap.querySelector('.irl-taptip-qr');
	toggle.addEventListener('click', () => {
		const open = panel.hidden;
		panel.hidden = !open;
		toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
		if (open && !qrSlot.dataset.done) {
			try {
				qrSlot.innerHTML = renderQRToSVG(uri, { scale: 4, margin: 1 });
				qrSlot.dataset.done = '1';
			} catch {
				// QR generation can overflow on a very long label — fall back to the
				// deep link alone, never a broken slot.
				qrSlot.remove();
			}
		}
	});
	return wrap;
}

// Render the resolved card into the open sheet.
function _applyCard(card, pin) {
	const agent = card.agent || {};
	const sheet = document.getElementById('irl-sheet');

	const thumb = document.getElementById('irl-sheet-thumb');
	if (thumb) {
		if (agent.thumbnail_url) { thumb.src = agent.thumbnail_url; thumb.hidden = false; }
		else { thumb.removeAttribute('src'); thumb.hidden = true; }
	}

	// The card may carry a richer name than the pin's avatar label.
	if (agent.name) {
		const nameEl = document.getElementById('irl-sheet-name');
		if (nameEl) nameEl.textContent = agent.name;
		if (sheet) sheet.dataset.agentName = agent.name;
	}
	if (sheet && agent.profile_url) sheet.dataset.profileUrl = agent.profile_url;

	_setTierBadge(card.reputation);

	const body = document.getElementById('irl-card-body');
	if (body) {
		const parts = [];
		const bio = agent.bio;
		// Skip the bio when it just repeats the pin caption shown above.
		if (bio && bio !== pin.caption) parts.push(`<p class="irl-card-bio">${_escHtml(bio)}</p>`);
		parts.push(_repStripHTML(card.reputation));
		parts.push(_servicesHTML(card.services));
		body.innerHTML = parts.join('');

		// The agent's custodial Solana wallet — the same chip every other surface
		// shows, so a tapped agent's identity reads identically in the world. The
		// body is rebuilt on each tap (innerHTML above), so appending here can't
		// duplicate. isOwner reflects whether this device placed the pin (gold
		// "your agent" ownership); a stranger sees a Tip action, never owner
		// controls. No-op unless the card carries a wallet (showPending:false).
		if (hasWallet(agent)) {
			const chip = walletChipEl(agent, { isOwner: isOwnRoomPin(pin), showPending: false });
			if (chip) {
				chip.classList.add('irl-card-wallet');
				chip.style.marginTop = '10px';
				body.appendChild(chip);
			}
			// Tap-to-tip in the real world — the moment unique to IRL/AR. You meet
			// the agent in physical space and pay it on the spot: scan the Solana
			// Pay QR with a phone wallet, or tap "Open in wallet" on this device to
			// launch Phantom/Solflare pre-filled with the agent's real address. The
			// chip above already covers the connected-browser-wallet tip; this is
			// the in-person, no-extension path.
			const tap = _buildTapToTip(agent);
			if (tap) body.appendChild(tap);
		}
	}

	// Prefer the card's resolved x402 endpoint for the footer Pay button.
	if (card.x402_endpoint) {
		const payBtn = document.getElementById('irl-sheet-pay');
		if (payBtn) { payBtn.hidden = false; payBtn.dataset.endpoint = card.x402_endpoint; }
	}
}

// Fetch + render the agent card. Aborts any in-flight request so switching
// agents never lands stale data. Re-callable for retry.
async function loadAgentCard(pin) {
	_cardAbort?.abort();
	const ctrl = new AbortController();
	_cardAbort = ctrl;

	const body = document.getElementById('irl-card-body');
	if (body) body.innerHTML = _cardSkeletonHTML();

	// Real agents resolve by agent_id; anonymous pins fall back to the pin id.
	const url = pin.agent_id
		? `/api/irl/agent-card?agent_id=${encodeURIComponent(pin.agent_id)}`
		: `/api/irl/agent-card?pin=${encodeURIComponent(pin.id)}`;

	try {
		const r = await fetch(url, { signal: ctrl.signal });
		if (ctrl.signal.aborted) return;
		if (!r.ok) throw new Error(`HTTP ${r.status}`);
		const { card } = await r.json();
		if (ctrl.signal.aborted) return;
		if (!card) throw new Error('empty card');
		_applyCard(card, pin);
	} catch (err) {
		if (ctrl.signal.aborted || err?.name === 'AbortError') return;
		if (body) {
			body.innerHTML = errorStateHTML({
				title: "Couldn't load this agent",
				body: 'Check your connection and try again.',
			});
		}
	}
}

function closeInspectSheet() {
	_cardAbort?.abort();
	document.getElementById('irl-sheet')?.classList.remove('is-open');
	document.getElementById('irl-sheet-backdrop')?.classList.remove('is-open');
	_activePin = null;
	if (_lastFocus && document.contains(_lastFocus)) {
		try { _lastFocus.focus({ preventScroll: true }); } catch { /* element gone */ }
	}
	_lastFocus = null;
}

// USDC on Base mainnet — the asset every hosted x402 service settles in. The
// interactions API only records a `pay` whose currency_mint is $THREE or USDC;
// this is the mint that backs the EVM x402 rail window.ethereum signs.
const USDC_BASE_MINT = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
// Upper safety bound (USD) for a pin-level Pay button whose price isn't on the
// card. The 402 challenge carries the real amount; withX402 rejects anything
// above this, so a misconfigured endpoint can't silently over-charge.
const PIN_PAY_CAP_USD = 5;

// Best-effort interaction telemetry → C4's /api/irl/interactions
// ({ pinId, type, deviceToken, ... }). Never blocks or breaks the UX: callers
// swallow failures (a 404 before C4 shipped is harmless). agent_id + owner are
// derived from the pin server-side; a `pay` is only recorded with a real
// on-chain settlement signature + an allowed mint.
function postInteraction(body) {
	return fetch('/api/irl/interactions', {
		method: 'POST',
		credentials: 'include',
		headers: deviceHeaders({ 'Content-Type': 'application/json' }),
		body: JSON.stringify({ deviceToken: _deviceToken, device_type: glassesBridge.deviceType(), ...body }),
	});
}

// Decode the x402 settlement receipt a paywall returns on a paid retry: header
// `x-payment-response` is base64 JSON { success, transaction, network, payer }.
// `transaction` is the on-chain signature the owner's inbox links to. Null when
// the response carried no receipt (e.g. a free / already-granted endpoint that
// never issued a 402).
function decodeSettlement(resp) {
	try {
		const h = resp.headers.get('x-payment-response') || resp.headers.get('payment-response');
		if (!h) return null;
		const txt = typeof atob === 'function'
			? decodeURIComponent(escape(atob(h)))
			: Buffer.from(h, 'base64').toString('utf8');
		return JSON.parse(txt);
	} catch {
		return null;
	}
}

// Surface the paid service's response inside the card — the value the user paid
// for, not just a toast. Small JSON/text only; a large body is truncated.
function showServiceResult(label, payload) {
	const body = document.getElementById('irl-card-body');
	if (!body) return;
	let text;
	try {
		text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
	} catch {
		text = String(payload);
	}
	body.querySelector('.irl-service-result')?.remove();
	const block = document.createElement('div');
	block.className = 'irl-service-result';
	const title = document.createElement('div');
	title.className = 'irl-service-result-label';
	title.textContent = `${label} — response`;
	const pre = document.createElement('pre');
	pre.textContent = text.length > 1800 ? `${text.slice(0, 1800)}…` : text;
	block.append(title, pre);
	body.appendChild(block);
	block.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// Wallet-not-connected is a *state*, not a transient event: the user can't pay
// until they have a wallet, so a 3 s toast that vanishes leaves them stuck with no
// next step. Render a designed, persistent state-kit card into the inspect sheet
// body (below the services it blocks) with the exact recovery path. Cleared the
// moment a payment actually proceeds, and wiped automatically when loadAgentCard
// re-renders the body for a different agent.
function showWalletNeeded(body) {
	const host = document.getElementById('irl-card-body');
	if (!host) { setStatus(body, { error: true, sticky: true }); return; }
	ensureStateKitStyles();
	host.querySelector('.irl-pay-notice')?.remove();
	const wrap = document.createElement('div');
	wrap.className = 'irl-pay-notice';
	wrap.innerHTML = emptyStateHTML({
		icon: '👛',
		title: 'Connect a wallet to pay',
		body,
		compact: true,
	});
	host.appendChild(wrap);
	wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
function clearWalletNotice() {
	document.getElementById('irl-card-body')?.querySelector('.irl-pay-notice')?.remove();
}

// Run a real x402 payment against one service endpoint and, on success, surface
// the response inline + record a verified `pay` interaction. Drives ONLY the
// clicked button's state, so per-service buttons stay independent. Shared by the
// footer Pay button and each service row's "Use" button; price / skill / name
// ride on the button's dataset so the cap binds to exactly what's displayed.
async function runX402Payment(endpoint, btn) {
	if (!btn) return;
	if (!endpoint) { setStatus('This service has no endpoint yet', { error: true }); return; }
	if (!window.ethereum) {
		// No injected wallet at all — a designed, persistent recovery state, not a toast.
		showWalletNeeded('This browser has no wallet. Open three.ws in a wallet browser (e.g. MetaMask) or install one, then tap Use again to pay in USDC.');
		return;
	}

	const sheet     = document.getElementById('irl-sheet');
	const priceAttr = btn.dataset.price;
	const priceUsd  = priceAttr ? Number(priceAttr) : null;
	const skill     = btn.dataset.skill || null;
	const label     = btn.dataset.name || sheet?.dataset.agentName || 'Service';

	const origText = btn.textContent;
	btn.disabled = true;
	btn.textContent = 'Connecting…';

	// Gate on an authorized wallet up front so a decline bails cleanly here rather
	// than surfacing mid-signature inside the x402 adapter.
	let accounts;
	try {
		accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
	} catch (err) {
		const m = err?.message ?? String(err);
		setStatus(/reject|denied|4001|cancel/i.test(m) ? 'Wallet connection cancelled' : `Couldn't connect wallet — ${m}`, { error: true });
		btn.disabled = false; btn.textContent = origText;
		return;
	}
	if (!Array.isArray(accounts) || !accounts.length) {
		// Wallet present but locked / no account approved — designed recovery state.
		showWalletNeeded('No wallet account is connected. Unlock your wallet and approve the connection, then tap Use again.');
		btn.disabled = false; btn.textContent = origText;
		return;
	}

	// A wallet is connected and we're proceeding — drop any prior "connect a wallet"
	// notice so a resolved state doesn't linger under the now-working payment.
	clearWalletNotice();
	btn.textContent = 'Paying…';
	try {
		const { withX402 } = await import('../packages/x402-fetch/src/index.js');
		// Cap the payment at the displayed price (small epsilon for rounding); a
		// pin-level endpoint with no shown price falls back to a fixed ceiling.
		const maxPaymentUsd = priceUsd != null && Number.isFinite(priceUsd)
			? Math.max(priceUsd, 0.01)
			: PIN_PAY_CAP_USD;
		// Capture the exact amount from the 402 challenge (authoritative even when
		// the card showed no price) so the recorded settlement is accurate.
		let settledUsd = priceUsd;
		const pay = withX402(window.ethereum, {
			maxPaymentUsd,
			onPayment: ({ amount }) => { if (Number.isFinite(amount)) settledUsd = amount; },
		});
		const r = await pay(endpoint, { method: 'POST' });   // 402 → sign → retry inside
		if (!r.ok) {
			const detail = await r.text().catch(() => `HTTP ${r.status}`);
			setStatus(`Service error — ${String(detail).slice(0, 140)}`, { error: true });
			btn.disabled = false; btn.textContent = origText;
			return;
		}

		btn.textContent = 'Used ✓';
		btn.disabled = true;
		setStatus('Service paid — response delivered');

		// Show the response the user paid for. Hosted services wrap the upstream
		// payload as { service, result, … }; unwrap to the inner result.
		let result = null;
		try {
			result = (r.headers.get('content-type') || '').includes('json') ? await r.json() : await r.text();
		} catch { /* empty / unreadable body — the receipt below still records the pay */ }
		if (result != null && result !== '') {
			const shown = result && typeof result === 'object' && 'result' in result ? result.result : result;
			showServiceResult(label, shown);
		}

		// Record the verified pay. The interactions API requires the on-chain
		// settlement signature, so log ONLY when the receipt carried one — never a
		// fabricated tx. Best-effort; a failure never disrupts the user.
		const settlement = decodeSettlement(r);
		if (settlement?.transaction && sheet?.dataset.pinId) {
			postInteraction({
				pinId: sheet.dataset.pinId,
				type: 'pay',
				agentId: sheet.dataset.agentId || null,
				signature: settlement.transaction,
				currencyMint: USDC_BASE_MINT,
				network: settlement.network || 'base',
				amount: Number.isFinite(settledUsd) ? Math.round(settledUsd * 1e6) : null,
				payload: { skill, payer: settlement.payer || null },
			}).catch(() => {});
			// D3 — high-signal: fan a "paid" reaction to co-located viewers. Only here,
			// after a real on-chain settlement, never optimistically — so the agent's
			// celebration (and the owner's earned event) is never a lie.
			irlNet?.interaction({ type: 'pay', pinId: sheet.dataset.pinId, agentId: sheet.dataset.agentId || '' });
		}
	} catch (err) {
		const m = err?.message ?? String(err);
		setStatus(/reject|denied|4001|cancel/i.test(m) ? 'Payment cancelled' : `Payment failed — ${m}`, { error: true });
		btn.disabled = false; btn.textContent = origText;
	}
}

// ── Interaction sheet ─────────────────────────────────────────────────────
function openPinSheet(pin) {
	const sheet = document.getElementById('irl-sheet');
	if (!sheet) return;

	// Populate basic fields immediately so the sheet opens without delay
	document.getElementById('irl-sheet-name').textContent = pin.avatar_name || 'Agent';
	const distEl = document.getElementById('irl-sheet-dist');
	if (distEl) distEl.textContent = pin.distance_m != null ? `${pin.distance_m}m away` : '';

	const cap = document.getElementById('irl-sheet-caption');
	if (cap) { cap.textContent = pin.caption || ''; cap.hidden = !pin.caption; }

	const payBtn = document.getElementById('irl-sheet-pay');
	if (payBtn) {
		payBtn.hidden = !pin.x402_endpoint;
		payBtn.dataset.endpoint = pin.x402_endpoint ?? '';
	}

	// Calibrate (A3) — only the owner of this pin can fine-tune its real-world
	// spot. The server re-checks ownership; this is the discoverable entry point
	// alongside the long-press gesture.
	const calBtn = document.getElementById('irl-sheet-calibrate');
	if (calBtn) {
		const own = isOwnPin(pin);
		calBtn.hidden = !own;
		calBtn.onclick = own
			? () => { closeInspectSheet(); enterCalibrate(pin); }
			: null;
	}

	// Refine on floor (R3) — the precision layer. On a WebXR device, the owner can
	// re-place their OWN room agent with a real on-device hit-test (feet on the actual
	// floor) instead of the drag nudge. Only shown for an own ROOM pin on a WebXR
	// device; iOS/unsupported keep Calibrate (the button stays absent, never a dead
	// end). It sharpens this one agent without touching the shared origin.
	const refineBtn = document.getElementById('irl-sheet-refine');
	if (refineBtn) {
		const canRefine = _placementCapability === 'webxr' && isOwnPin(pin) && !!pinRoom(pin);
		refineBtn.hidden = !canRefine;
		refineBtn.onclick = canRefine
			? () => { closeInspectSheet(); enterRefineOnFloor(pin); }
			: null;
	}

	// Align this room (R2) — the headline one-gesture tool. Shown when this agent
	// belongs to a multi-agent room THIS device owns entirely: align the whole
	// cluster in one move instead of nudging each agent. The server re-checks
	// ownership across every pin in the room.
	const alignBtn = document.getElementById('irl-sheet-align-room');
	if (alignBtn) {
		const rid = alignableRoomId(pin);
		const count = rid ? nearbyPins.filter(p => p.room_id === rid && p.group).length : 0;
		const show = !!rid && count >= 2;
		alignBtn.hidden = !show;
		alignBtn.textContent = show ? `Align this room (${count})` : 'Align this room';
		alignBtn.onclick = show ? () => { closeInspectSheet(); enterRoomCalibrate(rid); } : null;
	}

	// Report (D4) — community moderation. Pointless on your own pin (the server
	// no-ops owner self-reports), so it's shown only on someone else's placement.
	const reportBtn = document.getElementById('irl-sheet-report');
	if (reportBtn) {
		const own = isOwnPin(pin);
		reportBtn.hidden = own || !pin.id;
		reportBtn.onclick = (!own && pin.id)
			? () => openReportSheet(pin.id)
			: null;
	}

	// Honest accuracy line (A3) — never imply the placement is centimetre-perfect.
	const accEl = document.getElementById('irl-sheet-accuracy');
	if (accEl) {
		const acc = Number.isFinite(pin.gps_accuracy_m) ? Math.round(pin.gps_accuracy_m) : null;
		if (acc != null) {
			accEl.textContent = acc > RING_LOW_ACC_M
				? `Placed with ~${acc} m GPS accuracy — position can vary between phones. Find a spot with clearer sky for a tighter lock.`
				: `Placed with ~${acc} m GPS accuracy.`;
			accEl.classList.toggle('is-low', acc > RING_LOW_ACC_M);
			accEl.hidden = false;
		} else {
			accEl.hidden = true;
		}
	}

	// Placement badge (H4) — only on the owner's own pin: tell them how exposed this
	// placement is (exact spot vs a deliberately blurred one). A non-owner never sees
	// it; legacy own pins (no placement_kind) read as precise.
	const placeEl = document.getElementById('irl-sheet-placement');
	if (placeEl) {
		if (isOwnPin(pin)) {
			const approx = pin.placement_kind === 'approximate';
			placeEl.textContent = approx
				? `≈ Approximate placement (~${Math.round(Number(pin.fuzz_radius_m) || PLACEMENT_FUZZ_DEFAULT)} m) — your exact spot was never stored`
				: '📍 Exact placement — stored at the precise spot you chose';
			placeEl.classList.toggle('is-approx', approx);
			placeEl.hidden = false;
		} else {
			placeEl.hidden = true;
		}
	}

	// Reset the rich-card surfaces before the fresh card resolves: hide the
	// previous agent's thumbnail + tier badge so neither flashes while the next
	// card loads. #irl-card-body gets its skeleton from loadAgentCard() below.
	const multiEl = document.getElementById('irl-sheet-multiplayer');
	const thumbEl = document.getElementById('irl-sheet-thumb');
	const tierEl  = document.getElementById('irl-sheet-tier');
	if (thumbEl) { thumbEl.removeAttribute('src'); thumbEl.hidden = true; }
	if (tierEl)  { tierEl.hidden = true; tierEl.removeAttribute('data-tier'); }
	if (multiEl) multiEl.hidden = true;

	sheet.dataset.agentId   = pin.agent_id   ?? '';
	sheet.dataset.agentName = pin.avatar_name ?? '';
	sheet.dataset.pinId     = pin.id ?? '';
	// Reset the message composer for this agent
	{
		const msgInput  = document.getElementById('irl-msg-input');
		const msgStatus = document.getElementById('irl-sheet-status');
		if (msgInput)  { msgInput.value = ''; msgInput.disabled = false; }
		if (msgStatus) { msgStatus.hidden = true; msgStatus.classList.remove('is-error'); }
	}

	// Open with a designed transition + focus management. Remember what had focus
	// so closeInspectSheet() can restore it; fade the backdrop in alongside the
	// sheet and move focus to the dialog so Escape and screen readers land here.
	_activePin = pin;
	_lastFocus = document.activeElement;
	document.getElementById('irl-sheet-backdrop')?.classList.add('is-open');
	sheet.classList.add('is-open');
	try { sheet.focus({ preventScroll: true }); } catch { /* older browsers */ }

	// Multiplayer note — always show since all pins are publicly visible
	if (multiEl) {
		const multiText = document.getElementById('irl-sheet-multiplayer-text');
		if (multiText) {
			const viewDesc = pin.view_count > 0
				? `Seen by ${pin.view_count} visitor${pin.view_count !== 1 ? 's' : ''} · visible to all users nearby`
				: 'Visible to all users at this location';
			multiText.textContent = viewDesc;
		}
		multiEl.hidden = false;
	}

	// Log the view interaction (fire-and-forget, best-effort)
	if (pin.id) {
		fetch('/api/irl/interactions', {
			method: 'POST',
			headers: deviceHeaders({ 'Content-Type': 'application/json' }),
			body: JSON.stringify({
				pinId: pin.id,
				type: 'view',
				deviceToken: _deviceToken,
				device_type: glassesBridge.deviceType(),
				agentId: pin.agent_id ?? null,
			}),
		}).catch(() => {});
		pin.view_count = (pin.view_count ?? 0) + 1;
		// D3 — fan an ambient reaction to co-located viewers (the REST POST above is the
		// durable record + owner notification; this is the live flourish, no-op off-WS).
		irlNet?.interaction({ type: 'view', pinId: pin.id, agentId: pin.agent_id ?? '' });
	}

	// Rich card: avatar bio + on-chain reputation + the agent's paid x402 services,
	// from one /api/irl/agent-card aggregation call. loadAgentCard() drops a
	// skeleton into #irl-card-body immediately, then renders the populated /
	// empty-services / no-reputation / error+retry state, and aborts the in-flight
	// fetch when the viewer taps a different agent so stale data never lands.
	loadAgentCard(pin);
}

document.getElementById('irl-sheet-close')?.addEventListener('click', closeInspectSheet);
document.getElementById('irl-sheet-backdrop')?.addEventListener('click', closeInspectSheet);
window.addEventListener('keydown', (e) => {
	if (e.key === 'Escape' && document.getElementById('irl-sheet')?.classList.contains('is-open')) {
		closeInspectSheet();
	}
});

// Per-service "Use" CTA → x402 payment; the error-state Retry re-fetches the card.
// Both delegate off #irl-card-body so they survive every innerHTML re-render
// (skeleton → populated / error).
{
	const cardBody = document.getElementById('irl-card-body');
	if (cardBody) {
		cardBody.addEventListener('click', (e) => {
			const useBtn = e.target.closest('.irl-service-use[data-x402]');
			if (useBtn) runX402Payment(useBtn.dataset.x402, useBtn);
		});
		attachRetry(cardBody, () => { if (_activePin) loadAgentCard(_activePin); });
	}
}

// Leave-a-message — a visitor's note becomes a 'message' interaction in the
// owner's IRL feed (dashboard). Pin id is stamped on the sheet by openPinSheet.
document.getElementById('irl-sheet-msg')?.addEventListener('submit', async (e) => {
	e.preventDefault();
	const sheet  = document.getElementById('irl-sheet');
	const input  = document.getElementById('irl-msg-input');
	const sendBtn = document.getElementById('irl-msg-send');
	const status = document.getElementById('irl-sheet-status');
	const pinId  = sheet?.dataset.pinId;
	const text   = (input?.value ?? '').trim();
	if (!pinId || !text) return;

	if (sendBtn) sendBtn.disabled = true;
	if (input)   input.disabled = true;
	try {
		const r = await fetch('/api/irl/interactions', {
			method: 'POST',
			headers: deviceHeaders({ 'Content-Type': 'application/json' }),
			body: JSON.stringify({
				pinId,
				type: 'message',
				message: text,
				deviceToken: _deviceToken,
				device_type: glassesBridge.deviceType(),
				agentId: sheet.dataset.agentId || null,
			}),
		});
		if (!r.ok) throw new Error(`HTTP ${r.status}`);
		if (input) input.value = '';
		// D3 — high-signal: the agent reacts to a left message for everyone nearby.
		irlNet?.interaction({ type: 'message', pinId, agentId: sheet.dataset.agentId || '' });
		if (status) {
			status.textContent = 'Message delivered — the owner will see it.';
			status.classList.remove('is-error');
			status.hidden = false;
		}
	} catch {
		if (status) {
			status.textContent = "Couldn't send — try again.";
			status.classList.add('is-error');
			status.hidden = false;
		}
	} finally {
		if (sendBtn) sendBtn.disabled = false;
		if (input)   input.disabled = false;
	}
});

// ── Report flow (D4) ───────────────────────────────────────────────────────
// A visitor flags a pin for moderation. The server de-dupes per reporter and
// hides the pin once enough distinct people flag it — so this is a single,
// honest action with loading / success / error states, never a dead button.

let _reportPinId = null;

function openReportSheet(pinId) {
	const sheet = document.getElementById('irl-report-sheet');
	if (!sheet || !pinId) return;
	_reportPinId = pinId;
	closeInspectSheet();
	const status = document.getElementById('irl-report-status');
	if (status) { status.hidden = true; status.classList.remove('is-error'); }
	sheet.querySelectorAll('.irl-report-reason').forEach((b) => { b.disabled = false; });
	sheet.classList.add('is-open');
	// Trap focus + Escape; start on the first reason so a keyboard user can pick
	// one immediately.
	trapSheet(sheet, closeReportSheet, { initialFocus: sheet.querySelector('.irl-report-reason') });
}

function closeReportSheet() {
	const sheet = document.getElementById('irl-report-sheet');
	sheet?.classList.remove('is-open');
	releaseSheet(sheet);
	_reportPinId = null;
}

document.getElementById('irl-report-close')?.addEventListener('click', closeReportSheet);

document.querySelectorAll('.irl-report-reason').forEach((btn) => {
	btn.addEventListener('click', async () => {
		const pinId  = _reportPinId;
		const reason = btn.dataset.reason || 'other';
		const status = document.getElementById('irl-report-status');
		const sheet  = document.getElementById('irl-report-sheet');
		if (!pinId) return;

		sheet?.querySelectorAll('.irl-report-reason').forEach((b) => { b.disabled = true; });
		if (status) {
			status.textContent = 'Sending…';
			status.classList.remove('is-error');
			status.hidden = false;
		}
		try {
			const r = await fetch('/api/irl/report', {
				method: 'POST',
				headers: deviceHeaders({ 'Content-Type': 'application/json' }),
				body: JSON.stringify({ pinId, reason, deviceToken: _deviceToken }),
			});
			if (!r.ok) throw new Error(`HTTP ${r.status}`);
			const data = await r.json().catch(() => ({}));
			if (status) {
				status.textContent = data.hidden
					? 'Thanks — enough reports came in, so this pin has been hidden.'
					: 'Thanks, we’ll review it.';
				status.classList.remove('is-error');
				status.hidden = false;
			}
			// If it was hidden, drop it from the scene immediately rather than waiting
			// for the next nearby re-fetch.
			if (data.hidden) removeNearbyPin(pinId);
			setTimeout(closeReportSheet, 1400);
		} catch {
			if (status) {
				status.textContent = 'Couldn’t submit the report — try again.';
				status.classList.add('is-error');
				status.hidden = false;
			}
			// Re-enable so the failed report is retryable, never a dead end.
			sheet?.querySelectorAll('.irl-report-reason').forEach((b) => { b.disabled = false; });
		}
	});
});

// ── Agent picker ──────────────────────────────────────────────────────────
// Lists the authenticated user's agents. Selecting one loads its avatar GLB
// into the scene and sets it as the current agent for any new pins.

async function openAgentPicker() {
	const sheet = document.getElementById('irl-agents-sheet');
	const list  = document.getElementById('irl-agents-list');
	if (!sheet || !list) return;
	sheet.classList.add('is-open');
	// Trap focus + Escape; the rows load async, so start focus on the close button.
	trapSheet(sheet, closeAgentPicker, { initialFocus: document.getElementById('irl-agents-close') });
	list.innerHTML = '<p class="irl-agents-empty">Loading…</p>';

	let agents = [];
	try {
		const r = await fetch('/api/agents', { credentials: 'include' });
		if (!r.ok) throw new Error('not_auth');
		const data = await r.json();
		agents = data.agents ?? [];
	} catch {
		list.innerHTML = '<p class="irl-agents-empty">Sign in to switch agents. <a href="/login">Log in →</a></p>';
		return;
	}

	if (!agents.length) {
		list.innerHTML = '<p class="irl-agents-empty">No agents yet. <a href="/create">Create your first agent →</a></p>';
		return;
	}

	list.innerHTML = agents.map(a => `
		<div class="irl-agent-row${_currentAgentId === a.id ? ' is-active' : ''}"
		     role="button" tabindex="0"
		     aria-pressed="${_currentAgentId === a.id ? 'true' : 'false'}"
		     aria-label="Use agent ${_escHtml(a.name)}"
		     data-agent-id="${_escHtml(a.id)}"
		     data-avatar-id="${_escHtml(a.avatar_id ?? '')}"
		     data-avatar-url="${_escHtml(a.avatar_model_url ?? '')}"
		     data-name="${_escHtml(a.name)}">
			<div class="irl-agent-thumb">
				${a.avatar_thumbnail_url
					? `<img src="${_escHtml(a.avatar_thumbnail_url)}" alt="" loading="lazy">`
					: '🤖'}
			</div>
			<div class="irl-agent-row-info">
				<div class="irl-agent-row-name">${_escHtml(a.name)}</div>
				${a.description ? `<div class="irl-agent-row-desc">${_escHtml(a.description.slice(0, 90))}</div>` : ''}
			</div>
			${_currentAgentId === a.id ? '<span class="irl-agent-row-check">✓</span>' : ''}
		</div>
	`).join('');
}

function closeAgentPicker() {
	const sheet = document.getElementById('irl-agents-sheet');
	sheet?.classList.remove('is-open');
	releaseSheet(sheet);
}

document.getElementById('irl-agents-btn')?.addEventListener('click', openAgentPicker);
document.getElementById('irl-agents-close')?.addEventListener('click', closeAgentPicker);

// Agent rows are role="button" divs — make Enter/Space activate them like a
// native button so the picker is fully operable from the keyboard.
document.getElementById('irl-agents-list')?.addEventListener('keydown', (e) => {
	if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
	const row = e.target.closest('.irl-agent-row[data-agent-id]');
	if (!row) return;
	e.preventDefault();
	row.click();
});

document.getElementById('irl-agents-list')?.addEventListener('click', async (e) => {
	const row = e.target.closest('.irl-agent-row[data-agent-id]');
	if (!row) return;
	const agentId   = row.dataset.agentId;
	const avatarId  = row.dataset.avatarId;
	const avatarUrl = row.dataset.avatarUrl;
	const name      = row.dataset.name;
	closeAgentPicker();
	_currentAgentId = agentId;
	// Update URL so a share link carries the chosen agent's avatar
	const sp = new URLSearchParams(location.search);
	if (avatarId) sp.set('avatar', avatarId); else sp.delete('avatar');
	history.replaceState(null, '', location.pathname + (sp.toString() ? '?' + sp : ''));
	try {
		await loadAvatar(avatarId || avatarUrl || null, name || null);
		setStatus(`Switched to ${name}`);
	} catch (err) {
		log.error('[irl] agent switch failed:', err);
		setStatus(`Couldn't load agent: ${err?.message ?? err}`, { error: true });
	}
});

document.getElementById('irl-sheet-view')?.addEventListener('click', () => {
	const sheet   = document.getElementById('irl-sheet');
	const agentId = sheet?.dataset.agentId;
	const pinId   = sheet?.dataset.pinId;
	const name    = sheet?.dataset.agentName || document.getElementById('irl-sheet-name')?.textContent || '';
	// Opening the profile is active engagement — record a 'tap' (the API's
	// active-sighting type), distinct from the passive 'view' logged on card open.
	// Best-effort; capture pinId before closeInspectSheet and never block nav.
	if (pinId) postInteraction({ pinId, type: 'tap', agentId: agentId || null }).catch(() => {});
	closeInspectSheet();
	if (agentId) {
		window.open(`/agents/${agentId}`, '_blank', 'noopener');
	} else {
		window.open(`/temporary?agent=${encodeURIComponent(name)}`, '_blank', 'noopener');
	}
});

// Footer Pay CTA — same x402 flow as the per-service "Use" buttons.
document.getElementById('irl-sheet-pay')?.addEventListener('click', (e) => {
	runX402Payment(e.currentTarget.dataset.endpoint, e.currentTarget);
});

// ── Radar minimap ────────────────────────────────────────────────────────
function updateRadar() {
	const radar = document.getElementById('irl-radar');
	if (!radar || !gpsModeActive) return;
	radar.querySelectorAll('.irl-radar-dot, .irl-radar-ghost').forEach(d => d.remove());
	const R = 60; // half of 120px radar
	let shown = 0;
	for (const pin of nearbyPins) {
		if (!pin.group) continue;
		const wx = pin.group.position.x;
		const wz = pin.group.position.z;
		const px = R + (wx / NEARBY_RADIUS) * R;
		const py = R + (-wz / NEARBY_RADIUS) * R;
		if (px < 0 || px > 120 || py < 0 || py > 120) continue;
		const dot = document.createElement('div');
		dot.className = 'irl-radar-dot';
		dot.style.left = `${px}px`;
		dot.style.top  = `${py}px`;
		dot.title = `${pin.avatar_name || 'Agent'} · ${pin.distance_m ?? Math.round(Math.hypot(wx, wz))}m`;
		dot.addEventListener('click', () => openPinSheet(pin));
		radar.appendChild(dot);
		shown++;
	}
	// Live presence ghosts (D2) — faint, smaller, not tappable, drawn beneath the
	// agent dots. They sit at the orb's clamped coarse position, so they read as
	// "someone roughly here" rather than a precise placement. Not counted in `shown`
	// (the empty hint is about placed agents, not co-viewers).
	for (const g of ghostViewers.values()) {
		if (!g.orb) continue;
		const px = R + (g.orb.position.x / NEARBY_RADIUS) * R;
		const py = R + (-g.orb.position.z / NEARBY_RADIUS) * R;
		if (px < 0 || px > 120 || py < 0 || py > 120) continue;
		const gd = document.createElement('div');
		gd.className = 'irl-radar-ghost';
		gd.style.left = `${px}px`;
		gd.style.top  = `${py}px`;
		gd.title = 'Someone viewing nearby';
		radar.appendChild(gd);
	}
	// Designed in-radar states (E4): a failed nearby refresh and an empty dial each
	// get an honest centred hint instead of a blank radar that reads as "nobody here"
	// even when the fetch broke. The hint reuses the existing 15 s poll / live stream
	// to recover, so it clears itself on the next good update.
	let hint = radar.querySelector('.irl-radar-hint');
	const message = _nearbyError ? 'Can’t refresh'
		: _nearbyRateLimited ? 'Catching up…'
		: !_nearbyLoaded ? 'Looking around…'
		: (shown === 0 ? 'Be the first to pin here' : '');
	if (message) {
		if (!hint) {
			hint = document.createElement('div');
			hint.className = 'irl-radar-hint';
			radar.appendChild(hint);
		}
		hint.textContent = message;
		hint.classList.toggle('is-error', _nearbyError);
		hint.hidden = false;
	} else if (hint) {
		hint.hidden = true;
	}
}

// ── Label 3D→2D projection (called each frame) ───────────────────────────
const _lblVec = new Vector3();
// Only flag a focus target when an agent is near enough to actually walk up to
// and interact with — a visible agent across the street shouldn't claim it.
const FOCUS_REACH_M = 60;
let _focusPin = null;
function updateLabels() {
	// Pick the nearest on-screen agent within reach as the proximity focus target
	// (B4) in the same projection pass — the "you'll tap this" affordance.
	let focusPin = null, focusDist = Infinity;
	for (const pin of nearbyPins) {
		// Skip pins with no label/group, ones culled by enforceLOD, and ones past the
		// tier's label cap (_labelAllowed === false). This bounds the live DOM label
		// nodes to BUDGET.label nearest-first and keeps the loop off-screen-cheap.
		if (!pin.labelEl || !pin.group || pin._lod === 'hidden' || pin._labelAllowed === false) {
			if (pin.labelEl) pin.labelEl.style.display = 'none';
			pin._labelOnScreen = false;
			continue;
		}
		_lblVec.set(
			pin.group.position.x,
			pin.group.position.y + 2.5,
			pin.group.position.z,
		);
		_lblVec.project(camera);
		if (_lblVec.z > 1) { pin.labelEl.style.display = 'none'; pin._labelOnScreen = false; continue; }
		const sx = (_lblVec.x * 0.5 + 0.5) * window.innerWidth;
		const sy = (-_lblVec.y * 0.5 + 0.5) * window.innerHeight;
		const offscreen = sx < -80 || sx > window.innerWidth + 80 || sy < -80 || sy > window.innerHeight + 80;
		pin.labelEl.style.display = offscreen ? 'none' : 'block';
		pin.labelEl.style.left    = `${sx}px`;
		pin.labelEl.style.top     = `${sy}px`;
		// Cache the projected label centre + visibility for the tap handler's 2D
		// label net (_nearestLabelWithinSlop) — no re-projection on tap.
		pin._labelSx = sx;
		pin._labelSy = sy;
		pin._labelOnScreen = !offscreen;
		if (!offscreen) {
			const dm = pin.distance_m ?? Math.hypot(pin.group.position.x, pin.group.position.z);
			if (dm <= FOCUS_REACH_M && dm < focusDist) { focusDist = dm; focusPin = pin; }
		}
	}
	// Exactly one agent is focused at a time; the swap is eased by the label's
	// transform/box-shadow transition. Cheap: only touches the class on change.
	if (focusPin !== _focusPin) {
		_focusPin?.labelEl?.classList.remove('is-focus');
		focusPin?.labelEl?.classList.add('is-focus');
		_focusPin = focusPin;
	}
}

// ── Distance LOD + draw/label budget (E2) ───────────────────────────────────
// Called ~4 Hz from tick(), not per frame. Sorts loaded pins nearest-first, then
// assigns each a band — full (skinned GLB) | impostor (billboard) | dot (cheap
// marker) | hidden (no draw, no label) — from its LIVE camera distance and the
// active tier budget. Caps concurrent fulls (maxGLB) and simultaneous labels,
// demoting the farthest pins first, so a crowded plaza can't blow the frame.
const _lodList = [];
const _lodProj = new Vector3();
function _byLodDist(a, b) { return a._lodDist - b._lodDist; }

function liveDist2D(pin) {
	return Math.hypot(
		camera.position.x - pin.group.position.x,
		camera.position.z - pin.group.position.z,
	);
}
// Cheap NDC bounds test so we never bake/keep impostors for agents behind the viewer.
function pinOnScreen(pin) {
	_lodProj.set(pin.group.position.x, pin.group.position.y + 1.2, pin.group.position.z).project(camera);
	return _lodProj.z < 1 && Math.abs(_lodProj.x) < 1.3 && Math.abs(_lodProj.y) < 1.3;
}

let _drawEstimate = 0; // approx scene draw calls the last LOD pass projected

// Pick a pin's band from its live distance, with hysteresis: each band's outer
// (farther/cheaper) edge is sticky by LOD_HYST metres relative to the pin's
// CURRENT band, so a pin idling right on a boundary (GPS jitter) doesn't flap
// between loading and evicting its GLB. Getting closer promotes immediately;
// only moving away by the margin demotes.
const LOD_HYST = 1.5;
function bandFor(d, cur) {
	const nearT = budget.lodNear + (cur === 'full' ? LOD_HYST : 0);
	const farT  = budget.lodFar  + (cur === 'full' || cur === 'impostor' ? LOD_HYST : 0);
	const cullT = budget.cull    + (cur && cur !== 'hidden' ? LOD_HYST : 0);
	if (d > cullT) return 'hidden';
	if (d > farT)  return 'dot';
	if (d > nearT) return 'impostor';
	return 'full';
}

function enforceLOD() {
	_lodList.length = 0;
	for (const pin of nearbyPins) {
		if (!pin.group) continue;
		pin._lodDist = liveDist2D(pin);
		_lodList.push(pin);
	}
	_lodList.sort(_byLodDist);

	let fullBudget  = budget.maxGLB;
	let labelBudget = budget.label;
	// Approximate draw-call budget: base scene (ground, lights, avatar, UI) ≈ 30,
	// each full skinned avatar ≈ 6 draws, impostor/dot ≈ 1. Demote the farthest
	// fulls to impostors once the projection would exceed the tier ceiling.
	let draws = 30;

	for (let i = 0; i < _lodList.length; i++) {
		const pin = _lodList[i];
		const d = pin._lodDist;
		let band = bandFor(d, pin._lod);

		// Concurrency + draw-budget demotion: full → impostor when out of GLB slots
		// or over the draw ceiling. Nearest-first ordering spends the budget on the
		// agents the viewer is closest to.
		if (band === 'full') {
			const cost = draws + 6;
			if (fullBudget > 0 && cost <= budget.draw) { fullBudget--; draws = cost; }
			else band = 'impostor';
		}
		if (band === 'impostor' || band === 'dot') draws += 1;

		pin._labelAllowed = band !== 'hidden' && labelBudget > 0;
		if (pin._labelAllowed) labelBudget--;

		applyBand(pin, band);
	}
	_drawEstimate = draws;
}

function applyBand(pin, band) {
	if (pin._lod === band) {
		// Already in this band — but an impostor still waiting on its background bake
		// shows the dot; promote it the instant the snapshot exists.
		if (band === 'impostor' && pin._impostorRT && !(pin._impostorSprite && pin._impostorSprite.visible)) {
			hideDot(pin); showImpostor(pin);
		}
		return;
	}
	pin._lod = band;
	switch (band) {
		case 'hidden':
			pin.group.visible = false;
			cancelPinGLB(pin);
			evictPinGLB(pin);
			break;
		case 'dot':
			pin.group.visible = true;
			// Distance jumped out of the model bands — drop any queued load so it
			// can't hold a slot ahead of a nearer pin (a dot needs no GLB at all).
			cancelPinGLB(pin);
			evictPinGLB(pin);
			hideImpostor(pin);
			showDot(pin);
			break;
		case 'impostor':
			pin.group.visible = true;
			// Cancel an in-flight FULL-model load the demotion no longer needs, but
			// let a cheap impostor-bake load finish (it's what this band wants).
			cancelPinGLB(pin, { keepBakeOnly: true });
			evictPinGLB(pin);
			if (pin._impostorRT) { hideDot(pin); showImpostor(pin); }
			else {
				// No snapshot yet (never been close). Show the dot now and bake one in
				// the background — but only for on-screen pins, so a load slot is never
				// spent on an agent behind the viewer.
				showDot(pin);
				if (pinOnScreen(pin)) requestPinGLB(pin, true);
			}
			break;
		case 'full':
			pin.group.visible = true;
			if (!pin.glbLoaded) {
				// Show the impostor (if already baked) or the dot while the full model
				// streams in; onPinGLBLoaded swaps to the skinned mesh on arrival.
				if (pin._impostorRT) { hideDot(pin); showImpostor(pin); }
				else showDot(pin);
				requestPinGLB(pin, false);
			}
			break;
	}
}

// ── Viewport / orientation change ───────────────────────────────────────────
// One funnel for resize, orientationchange, and screen.orientation's change event
// (feature-detected — iOS support varies). It re-applies the active perf tier's
// pixel ratio + render size, the new aspect, AND re-derives the camera FOV from
// the rear-camera sensor against the now-current viewport — so rotating
// portrait↔landscape holds the avatar's real-world scale instead of leaving it at
// the orientation AR opened in (task-02). iOS Safari's dynamic toolbar fires
// `resize` on every scroll frame, so the work is debounced to a single rAF and
// skipped entirely when the viewport dimensions did not actually change.
let _lastViewW = window.innerWidth;
let _lastViewH = window.innerHeight;
let _viewportRaf = 0;
function onViewportChanged() {
	if (_viewportRaf) return;
	_viewportRaf = requestAnimationFrame(() => {
		_viewportRaf = 0;
		const w = window.innerWidth, h = window.innerHeight;
		if (w === _lastViewW && h === _lastViewH) return; // toolbar jitter with no real change
		_lastViewW = w; _lastViewH = h;
		// setPixelRatio first so setSize allocates the drawing buffer at the right DPR.
		renderer.setPixelRatio(Math.min(window.devicePixelRatio, budget.pixelRatio));
		renderer.setSize(w, h, false);
		camera.aspect = w / h;
		camera.updateProjectionMatrix();
		applyCameraFov(); // no-op when AR is off; re-derives + refreshes projection otherwise
		rebaselineGyroForScreenAngle();
	});
}
// `screen.orientation.angle` for the landscape gyro-frame correction. Falls back
// to the legacy `window.orientation` (older iOS) and finally 0 (assume portrait).
function currentScreenAngle() {
	const a = window.screen?.orientation?.angle;
	if (Number.isFinite(a)) return a;
	const legacy = window.orientation;
	if (Number.isFinite(legacy)) return ((legacy % 360) + 360) % 360;
	return 0;
}
// When the screen rotates mid-lock the pitch axis switches (beta↔gamma), so the
// relative integrator baselines — captured under the previous angle — no longer
// describe the current pose and the view would snap. Re-pin them to the live pose
// at the new angle so rotation is seamless (the absolute-yaw path is unaffected;
// it tracks the compass directly). No-op when not locked in AR.
let _lastGyroScreenAngle = currentScreenAngle();
function rebaselineGyroForScreenAngle() {
	const angle = currentScreenAngle();
	if (angle === _lastGyroScreenAngle) return;
	_lastGyroScreenAngle = angle;
	if (!avatarLocked || !arActive || devOrientBaseAlpha === null) return;
	devOrientBaseAlpha    = lastDevAlpha;
	devOrientBaseBeta     = screenPitchDeg(lastDevBeta, lastDevGamma, angle);
	devOrientBaseCamYaw   = cameraYaw;
	devOrientBaseCamPitch = cameraPitch;
}
window.addEventListener('resize', onViewportChanged);
window.addEventListener('orientationchange', onViewportChanged);
if (window.screen?.orientation?.addEventListener) {
	window.screen.orientation.addEventListener('change', onViewportChanged);
}

// ── Main loop ─────────────────────────────────────────────────────────────
const clock      = new Timer();
const moveWorld  = new Vector3();
const moveFwd    = new Vector3();
const moveRight  = new Vector3();
const upY        = new Vector3(0, 1, 0);

function lerpAngle(a, b, t) {
	let diff = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
	if (diff < -Math.PI) diff += Math.PI * 2;
	return a + diff * t;
}

const _clampSym = (v, max) => (v < -max ? -max : v > max ? max : v);

// ── Camera-aware agents ────────────────────────────────────────────────────
// Reused temporaries — the awareness step runs every frame over several agents,
// so it allocates nothing: all vectors/quaternions below are scratch space.
const _awareList       = [];                   // nearest-first work list, reused
const _awareProj       = new Vector3();        // NDC on-screen test
const _gazePitchAxis   = new Vector3();        // horizontal axis the head pitches about
const _gazeBoneWorld   = new Vector3();        // gaze bone world position
const _gazeYawQuat     = new Quaternion();
const _gazePitchQuat   = new Quaternion();
const _gazeOffsetQuat  = new Quaternion();
const _gazeParentWorld = new Quaternion();
const _gazeParentInv   = new Quaternion();
const _gazeRestWorld   = new Quaternion();
const _gazeTargetWorld = new Quaternion();
const _gazeTargetLocal = new Quaternion();

function _byAwareDist(a, b) { return a._dist2D - b._dist2D; }

// Advance each mounted pin's idle mixer. Cost is bounded by the LOD budget:
// only pins at the 'full' band ever hold an animMgr (≤ budget.maxGLB of them).
// Runs from tick() in the normal loop and from the WebXR after-animate hook
// while an immersive session drives rendering instead.
function updatePinIdles(dt) {
	for (const pin of nearbyPins) {
		if (pin.animMgr) pin.animMgr.update(dt);
	}
}

// Rotate a head/torso bone so its neutral (rest) orientation is offset by a
// clamped yaw + pitch about WORLD axes — natural neck movement that reads right
// on any rig without knowing the bone's local "face" axis. `_gazePitchAxis`
// must already hold the horizontal axis to pitch about. Slerps from the bone's
// current pose toward the target so the gaze eases in instead of snapping.
function driveGazeBone(bone, restLocalQuat, yaw, pitch, slerpT) {
	bone.parent.getWorldQuaternion(_gazeParentWorld);
	_gazeRestWorld.multiplyQuaternions(_gazeParentWorld, restLocalQuat);
	_gazeYawQuat.setFromAxisAngle(upY, yaw);
	_gazePitchQuat.setFromAxisAngle(_gazePitchAxis, pitch);
	_gazeOffsetQuat.multiplyQuaternions(_gazeYawQuat, _gazePitchQuat);
	_gazeTargetWorld.multiplyQuaternions(_gazeOffsetQuat, _gazeRestWorld);
	_gazeParentInv.copy(_gazeParentWorld).invert();
	_gazeTargetLocal.multiplyQuaternions(_gazeParentInv, _gazeTargetWorld);
	bone.quaternion.slerp(_gazeTargetLocal, slerpT);
}

// Same clamped world-axis yaw+pitch offset as driveGazeBone, but composed ON TOP
// of whatever pose the pin's idle mixer wrote this frame — newLocal = Wp⁻¹·O·Wp·L,
// so worldAfter = O·worldBefore. driveGazeBone slerps from a captured rest pose,
// which a running mixer would overwrite every frame; this variant is stateless
// per frame (the easing lives in the caller's pin._gazeYaw/_gazePitch scalars).
// `_gazePitchAxis` must already hold the horizontal axis to pitch about.
function applyGazeOffset(bone, yaw, pitch) {
	bone.parent.getWorldQuaternion(_gazeParentWorld);
	_gazeYawQuat.setFromAxisAngle(upY, yaw);
	_gazePitchQuat.setFromAxisAngle(_gazePitchAxis, pitch);
	_gazeOffsetQuat.multiplyQuaternions(_gazeYawQuat, _gazePitchQuat);
	_gazeParentInv.copy(_gazeParentWorld).invert();
	_gazeTargetWorld.multiplyQuaternions(_gazeOffsetQuat, _gazeParentWorld);
	_gazeTargetLocal.multiplyQuaternions(_gazeParentInv, _gazeTargetWorld);
	bone.quaternion.premultiply(_gazeTargetLocal);
}

// Turn loaded nearby agents toward the viewer. Called from tick() right after
// animMgr.update(dt) and before label projection. Pure client render logic over
// nearbyPins — no data, no network. Cheap: only the nearest few, on-screen,
// in-range agents get full head tracking; everyone else eases home and idles.
function updateAgentAwareness(dt) {
	// Camera forward (horizontal) drives the "is-aware" label glow.
	camera.getWorldDirection(_camWorldDir);
	_camDirH.set(_camWorldDir.x, 0, _camWorldDir.z);
	const camDirHLen = _camDirH.length();
	if (camDirHLen > 0.001) _camDirH.divideScalar(camDirHLen);

	// Collect loaded agents and order nearest-first so the AWARE_MAX_AGENTS cap
	// always spends its budget on the agents the viewer is most likely facing.
	_awareList.length = 0;
	for (const pin of nearbyPins) {
		if (!pin.glbLoaded || !pin.group) continue;
		// The agent under active calibration is driven by the nudge gesture; don't
		// let camera-aware tracking fight the owner's yaw adjustment (A3).
		if (calibrateActive && _cal && _cal.pin === pin) continue;
		pin._dist2D = Math.hypot(
			camera.position.x - pin.group.position.x,
			camera.position.z - pin.group.position.z,
		);
		_awareList.push(pin);
	}
	_awareList.sort(_byAwareDist);

	for (let i = 0; i < _awareList.length; i++) {
		const pin  = _awareList[i];
		const dist = pin._dist2D;
		const dx   = camera.position.x - pin.group.position.x;
		const dz   = camera.position.z - pin.group.position.z;

		// On-screen test (cheap NDC bounds) so off-camera agents cost almost nothing.
		_awareProj
			.set(pin.group.position.x, pin.group.position.y + 1.4, pin.group.position.z)
			.project(camera);
		const onScreen = _awareProj.z < 1 &&
			Math.abs(_awareProj.x) < 1.25 && Math.abs(_awareProj.y) < 1.25;

		const engaged  = i < AWARE_MAX_AGENTS && dist <= AWARE_RADIUS_M && onScreen;
		const gazeBone = pin.headBone || pin.spineBone;
		const restQuat = pin.headBone ? pin.restHeadQuat : pin.restSpineQuat;

		if (engaged) {
			// 1) Body: ease the whole agent's yaw toward the camera's ground point.
			const wantYaw = Math.atan2(dx, dz);
			pin.group.rotation.y = lerpAngle(pin.group.rotation.y, wantYaw, BODY_SLERP);

			// 2) Head/torso: lead the body toward the camera inside a natural cone.
			if (gazeBone && (pin.animMgr || restQuat)) {
				// Yaw the head should add beyond the body's current facing.
				let resYaw = ((wantYaw - pin.group.rotation.y + Math.PI) % (Math.PI * 2)) - Math.PI;
				if (resYaw < -Math.PI) resYaw += Math.PI * 2;
				resYaw = _clampSym(resYaw, HEAD_CLAMP);
				// Pitch toward the camera's height (look up/down at the viewer's face).
				gazeBone.getWorldPosition(_gazeBoneWorld);
				const pitch = _clampSym(
					Math.atan2(camera.position.y - _gazeBoneWorld.y, Math.max(dist, 1e-3)),
					HEAD_CLAMP,
				);
				const inv = 1 / Math.max(dist, 1e-6);
				_gazePitchAxis.set(-dz * inv, 0, dx * inv); // = cross(toward-camera, up)
				const rate = pin.noticeT > 0 ? HEAD_SLERP_NOTICE : HEAD_SLERP;
				if (pin.animMgr) {
					// The idle mixer rewrites this bone every frame, so a persistent
					// slerp can never accumulate. Ease scalar offsets instead and stamp
					// the full clamped offset onto the mixer's pose each frame.
					pin._gazeYaw   = (pin._gazeYaw   || 0) + (resYaw - (pin._gazeYaw   || 0)) * rate;
					pin._gazePitch = (pin._gazePitch || 0) + (pitch  - (pin._gazePitch || 0)) * rate;
					applyGazeOffset(gazeBone, pin._gazeYaw, pin._gazePitch);
				} else {
					driveGazeBone(gazeBone, restQuat, resYaw, pitch, rate);
				}
			}
			pin.idleT = 0;
		} else {
			// Not engaged: ease the body back to its placed heading...
			const baseYaw = pin.baseYaw != null ? pin.baseYaw : pin.group.rotation.y;
			pin.group.rotation.y = lerpAngle(pin.group.rotation.y, baseYaw, BODY_RETURN_SLERP);
			if (gazeBone && pin.animMgr) {
				// The idle clip already carries natural head motion; just bleed any
				// leftover engaged-gaze offset back to zero so disengaging never snaps.
				const gy = pin._gazeYaw || 0, gp = pin._gazePitch || 0;
				if (Math.abs(gy) > 0.002 || Math.abs(gp) > 0.002) {
					pin._gazeYaw   = gy * (1 - HEAD_SLERP * 0.5);
					pin._gazePitch = gp * (1 - HEAD_SLERP * 0.5);
					const fy = pin.group.rotation.y; // body forward = (sin fy, 0, cos fy)
					_gazePitchAxis.set(-Math.cos(fy), 0, Math.sin(fy)); // cross(forward, up)
					applyGazeOffset(gazeBone, pin._gazeYaw, pin._gazePitch);
				} else {
					pin._gazeYaw = pin._gazePitch = 0;
				}
			} else if (gazeBone && restQuat) {
				// No mixer on this rig — play the old scripted gaze drift so a static
				// (non-humanoid / unriggable) agent still never reads as frozen.
				pin.idleT = (pin.idleT || 0) + dt;
				const driftYaw   = Math.sin(pin.idleT * 0.4) * 0.12;
				const driftPitch = Math.sin(pin.idleT * 0.27 + 1.3) * 0.05;
				const fy = pin.group.rotation.y; // body forward = (sin fy, 0, cos fy)
				_gazePitchAxis.set(-Math.cos(fy), 0, Math.sin(fy)); // cross(forward, up)
				driveGazeBone(gazeBone, restQuat, driftYaw, driftPitch, HEAD_SLERP * 0.5);
			}
		}

		// ── "Notice" one-shot — fire once each time the viewer enters NOTICE_RADIUS_M.
		// Hysteresis on the way out so a re-approach re-greets without flicker.
		if (!pin.noticed && dist < NOTICE_RADIUS_M) {
			pin.noticed = true;
			pin.noticeT = NOTICE_BOOST_SEC; // snap the head to attention briefly
			pin.popT    = 0;                // start the perk-up scale pop
			pin._popAmp = 0;                // default subtle amplitude (D3 reactions set their own)
		} else if (pin.noticed && dist > NOTICE_RADIUS_M + 1) {
			pin.noticed = false;
		}
		if (pin.noticeT > 0) pin.noticeT = Math.max(0, pin.noticeT - dt);
		// Perk-up scale pop. The greet sets the default POP_AMOUNT; a D3 reaction
		// (playEmote) reuses this same one-shot with a bigger _popAmp so a `pay`
		// reads as a stronger bounce than a glance — one driver, never two fighting.
		if (pin.popT >= 0) {
			pin.popT += dt;
			const amp = pin._popAmp || POP_AMOUNT;
			if (pin.popT >= POP_DURATION) {
				pin.popT = -1;
				pin._popAmp = 0;
				pin.group.scale.y = pinScale(pin);
			} else {
				// The pop rides on top of the pin's persisted size (scale.x/z untouched).
				pin.group.scale.y = pinScale(pin) * (1 + amp * Math.sin(Math.PI * pin.popT / POP_DURATION));
			}
		}

		// ── "is-aware" label glow — is the camera roughly pointed at this agent? ──
		_toAgentH.set(-dx, 0, -dz);
		const d2 = _toAgentH.length();
		if (d2 > 0.001) _toAgentH.divideScalar(d2);
		const inView = camDirHLen > 0.001 && _camDirH.dot(_toAgentH) > 0.9 && d2 < 30;
		pin.labelEl?.classList.toggle('is-aware', inView);
	}
}

// ── Ambient interaction reactions (D3) ──────────────────────────────────────
// A co-located viewer tapped / paid / messaged a nearby agent; the room fanned a
// `reaction` to everyone here (see irl-net.js + IrlRoom). We answer with the two
// things a bystander actually sees: the agent perks up (a scale "emote" pop on its
// loaded model) and a glyph rises off its head — 💜 for a glance, ✨ paid for a
// settled payment, 💬 for a left message. Pure transform/opacity, GPU-only, capped
// and auto-cleaned: never a layout reflow. A reaction whose pin scrolled out of
// range is silently dropped — the durable record already landed over REST, so only
// the live flourish is skipped, never the data.
const REACTION_TTL    = 1.2;        // seconds a floating glyph lives (matches the CSS rise)
const MAX_REACTIONS   = 14;         // concurrent floaters cap — a busy plaza can't churn the DOM
const _reactions      = [];         // [{ pin, outer, t }]
const _reactVec       = new Vector3(); // scratch for per-frame projection (no per-call alloc)

// Glyph + optional label + style hook per reaction type. open/view share the heart.
const REACTION_GLYPH = {
	open:    { mark: '💜', text: '',     cls: '' },
	view:    { mark: '💜', text: '',     cls: '' },
	pay:     { mark: '✨', text: 'paid', cls: 'is-pay' },
	message: { mark: '💬', text: '',     cls: 'is-msg' },
};

function onReaction(msg) {
	const pinId = msg?.pinId;
	const type  = msg?.type;
	if (!pinId || !type) return;
	const pin = nearbyPins.find((p) => p.id === pinId);
	if (!pin?.group) return;          // out of range / not spawned → drop the flourish
	playEmote(pin, type);
}

// The agent's gesture: a one-shot perk-up scale pop on its loaded model, reusing
// the E2 notice-pop driver in updateAgentAwareness. pay/message get a bigger pop
// than a glance. A pin that's only a far dot/impostor (not glbLoaded) has no model
// to pop — the floating glyph still plays, so it's always something, never a no-op.
function playEmote(pin, type) {
	if (!pin?.group) return;
	if (pin.glbLoaded) {
		pin.popT = 0;
		pin._popAmp = type === 'pay' ? 0.16 : type === 'message' ? 0.11 : 0.07;
	}
	spawnFloatingReaction(pin, type);
}

// A glyph that rises off the agent's head and fades. Two layers so positioning and
// the flourish never fight: the OUTER is reprojected to the pin's screen point each
// frame (updateReactions); the INNER runs the CSS rise+fade and is never touched by
// JS. Capped + auto-removed so the DOM stays tiny even in a crowd.
function spawnFloatingReaction(pin, type) {
	if (!pin?.group) return;
	const g = REACTION_GLYPH[type] || REACTION_GLYPH.open;

	// Evict the oldest floater at the cap so a stampede can't grow the DOM unbounded.
	while (_reactions.length >= MAX_REACTIONS) {
		const old = _reactions.shift();
		old?.outer?.remove();
	}

	const outer = document.createElement('div');
	outer.className = 'irl-reaction';
	outer.setAttribute('aria-hidden', 'true'); // decorative; the action it mirrors is announced elsewhere
	const inner = document.createElement('div');
	inner.className = `irl-reaction-burst ${g.cls}`.trim();
	inner.innerHTML = g.text
		? `<span class="irl-reaction-mark">${g.mark}</span><span class="irl-reaction-text">${g.text}</span>`
		: `<span class="irl-reaction-mark">${g.mark}</span>`;
	outer.appendChild(inner);
	document.body.appendChild(outer);

	const entry = { pin, outer, t: 0 };
	_reactions.push(entry);
	_projectReaction(entry); // place it now so it never flashes at (0,0) for a frame
}

// Project one reaction's anchor (just above the agent's head) to screen space and
// move its outer wrapper there. Hidden when behind the camera. Mirrors updateLabels().
function _projectReaction(entry) {
	const pin = entry.pin;
	if (!pin?.group) { entry.outer.style.display = 'none'; return; }
	_reactVec.set(pin.group.position.x, pin.group.position.y + 2.9, pin.group.position.z);
	_reactVec.project(camera);
	if (_reactVec.z > 1) { entry.outer.style.display = 'none'; return; }
	const sx = (_reactVec.x * 0.5 + 0.5) * window.innerWidth;
	const sy = (-_reactVec.y * 0.5 + 0.5) * window.innerHeight;
	entry.outer.style.display = 'block';
	entry.outer.style.left = `${sx}px`;
	entry.outer.style.top  = `${sy}px`;
}

// Advance every live floater: age it, reproject it to follow its agent, retire it
// (DOM removed) past its TTL or once its pin left the nearby set. Called each frame.
function updateReactions(dt) {
	if (!_reactions.length) return;
	for (let i = _reactions.length - 1; i >= 0; i--) {
		const entry = _reactions[i];
		entry.t += dt;
		const live = entry.pin?.group && nearbyPins.includes(entry.pin);
		if (entry.t >= REACTION_TTL || !live) {
			entry.outer.remove();
			_reactions.splice(i, 1);
			continue;
		}
		_projectReaction(entry);
	}
}

// ── LOD / radar throttles + frame-time watchdog (E2) ────────────────────────
const LOD_INTERVAL   = 0.25;   // enforceLOD at ~4 Hz — band changes don't need 60 Hz
const RADAR_INTERVAL = 0.2;    // rebuild radar DOM at ~5 Hz, not every frame
let _lodAccum = 0, _radarAccum = 0;

// Rolling frame-time governor. If the average frame stays slow for ~2 s we step
// the tier DOWN live (lower DPR, then shadows off, then fewer GLBs); if it runs
// with headroom for ~4 s we step back UP, but never above the device's detected
// `baseTier`. The app degrades visibly-gracefully instead of freezing.
const _fps = { ema: 16, over: 0, under: 0 };
function frameWatchdog(dt) {
	const ms = dt * 1000;
	_fps.ema += (ms - _fps.ema) * 0.1;
	if (_fps.ema > 28) {            // < ~36 fps
		_fps.over += dt; _fps.under = 0;
		if (_fps.over > 2) { _fps.over = 0; stepTier(-1); }
	} else if (_fps.ema < 20) {     // > ~50 fps, room to recover
		_fps.under += dt; _fps.over = 0;
		if (_fps.under > 4) { _fps.under = 0; stepTier(+1); }
	} else {
		_fps.over *= 0.5; _fps.under *= 0.5;
	}
}
function stepTier(dir) {
	const next = shiftTier(activeTier, dir);
	// Never climb above the hardware ceiling detected at boot.
	if (dir > 0 && TIER_ORDER.indexOf(next) > TIER_ORDER.indexOf(baseTier)) return;
	if (next === activeTier) return;
	activeTier = next;
	budget = BUDGETS[activeTier];
	applyTierToRenderer();
	log.info(`[irl] perf tier → ${activeTier} (frame ~${_fps.ema.toFixed(0)}ms)`);
}

function tick() {
	clock.update();
	const dt  = Math.min(clock.getDelta(), 0.05);
	const ix  = input.joy.active ? input.joy.x : (input.keys.right   - input.keys.left);
	const iy  = input.joy.active ? input.joy.y : (input.keys.forward  - input.keys.back);
	const mag = Math.min(1, Math.hypot(ix, iy));
	const wantRun = mag > 0.9 || input.keys.run;
	const speed   = mag * (wantRun ? RUN_SPEED : WALK_SPEED);

	if (mag > 0.01 && avatar && !avatarLocked) {
		moveFwd.copy(camLookCurrent).sub(camera.position);
		moveFwd.y = 0;
		if (moveFwd.lengthSq() < 1e-6) moveFwd.set(0, 0, -1); else moveFwd.normalize();
		moveRight.crossVectors(moveFwd, upY).normalize();

		moveWorld
			.set(0, 0, 0)
			.addScaledVector(moveFwd,   iy / Math.max(mag, 1e-6))
			.addScaledVector(moveRight, ix / Math.max(mag, 1e-6))
			.normalize()
			.multiplyScalar(speed * dt);

		avatarRig.position.add(moveWorld);
		const r = Math.hypot(avatarRig.position.x, avatarRig.position.z);
		if (r > GROUND_RADIUS - 0.5) {
			const k = (GROUND_RADIUS - 0.5) / r;
			avatarRig.position.x *= k;
			avatarRig.position.z *= k;
		}

		avatarYaw = lerpAngle(avatarYaw, Math.atan2(moveWorld.x, moveWorld.z), TURN_LERP);
		avatarRig.quaternion.setFromAxisAngle(upY, avatarYaw);

		const want = wantRun ? 'run' : 'walk';
		if (currentMotion !== want) {
			currentMotion = want;
			animMgr.crossfadeTo(want === 'run' ? CLIP_RUN : CLIP_WALK, 0.18);
		}
	} else if (currentMotion !== 'idle' && avatar) {
		currentMotion = 'idle';
		animMgr.crossfadeTo(CLIP_IDLE, 0.25);
	}

	if (animMgr.mixer) {
		let ts = 1.0;
		if (currentMotion === 'walk') ts = Math.max(0.45, speed / NATURAL_WALK_SPEED);
		else if (currentMotion === 'run') ts = Math.max(0.6, speed / NATURAL_RUN_SPEED);
		animMgr.mixer.timeScale = ts;
	}

	const targetLean = currentMotion === 'run'
		? LEAN_RUN_RAD  * mag
		: currentMotion === 'walk' ? LEAN_WALK_RAD * mag : 0;
	avatarLean += (targetLean - avatarLean) * LEAN_LERP;
	if (avatar) avatar.rotation.x = avatarLean;

	// Carry glide — ease a set-down agent to its chosen floor spot (works locked or
	// not). Any joystick/keys input cancels it so manual control always wins.
	if (_carryActive) {
		if (mag > 0.01) {
			_carryActive = false;
		} else {
			avatarRig.position.x += (_carryTarget.x - avatarRig.position.x) * 0.18;
			avatarRig.position.z += (_carryTarget.z - avatarRig.position.z) * 0.18;
			avatarRig.quaternion.setFromAxisAngle(upY, avatarYaw);
			if (Math.hypot(_carryTarget.x - avatarRig.position.x, _carryTarget.z - avatarRig.position.z) < 0.01) {
				avatarRig.position.x = _carryTarget.x;
				avatarRig.position.z = _carryTarget.z;
				_carryActive = false;
			}
		}
	}

	// Carry reticle — track the floor point under the screen centre while armed, so
	// you can aim a real spot before tapping. Eases its confirm pulse back to rest.
	if (carryModeActive) {
		pointerNDC.set(0, 0);
		raycaster.setFromCamera(pointerNDC, camera);
		const rHits = raycaster.intersectObject(rayPlane);
		if (rHits.length) {
			carryReticle.position.set(rHits[0].point.x, 0.012, rHits[0].point.z);
			carryReticle.visible = true;
		} else {
			carryReticle.visible = false;
		}
		carryReticle.scale.setScalar(carryReticle.scale.x + (1 - carryReticle.scale.x) * 0.15);
	} else if (carryReticle.visible) {
		carryReticle.visible = false;
	}

	// Camera ─────────────────────────────────────────────────────────────────
	if (gpsModeActive && avatarLocked && arActive) {
		// GPS mode (iOS world-lock, A4). Viewer-centric frame: the user is always
		// the origin, so the camera sits at their eye level (0, EYE_HEIGHT, 0) and
		// every agent is positioned relative to them via gpsToWorld(). Walking is
		// the *world* translating past a fixed camera — onGPSPosition() re-derives
		// the locked avatar (and nearby agents) from their GPS pins each fix, so
		// they grow/hold their real spot instead of following the user. Panning
		// only rotates the camera (gyro cameraYaw/Pitch), leaving the avatar on its
		// real-world bearing. Net effect matches WebXR (A1) without any WebXR.
		//
		// Local→GPS upgrade: ease the camera from the gyro pivot to the viewer origin
		// over GPS_TRANSITION_MS instead of snapping, so the avatar glides into its
		// precise anchor rather than teleporting. The transition clears itself on arrival.
		if (_gpsCamTransition) {
			_gpsCamTransition.elapsed += dt * 1000;
			const e = easeGpsTransition(_gpsCamTransition.elapsed / GPS_TRANSITION_MS);
			const from = _gpsCamTransition.from;
			camera.position.set(
				from.x + (0 - from.x) * e,
				from.y + (EYE_HEIGHT - from.y) * e,
				from.z + (0 - from.z) * e,
			);
			if (e >= 1) _gpsCamTransition = null;
		} else {
			camera.position.set(0, EYE_HEIGHT, 0);
		}
		camera.rotation.order = 'YXZ';
		camera.rotation.y = cameraYaw;
		camera.rotation.x = -cameraPitch;
		camera.rotation.z = 0;
		camLookCurrent.set(
			Math.sin(cameraYaw) * Math.cos(cameraPitch),
			Math.sin(-cameraPitch),
			-Math.cos(cameraYaw) * Math.cos(cameraPitch),
		).add(camera.position);
	} else if (avatarLocked && arActive && gyroLockCamPos) {
		// Local gyro world-lock (A4 without a GPS anchor — location off, no fix yet,
		// or a compass-only device). The camera holds the captured pivot and only
		// rotates with the phone, so the pinned avatar stays where it was placed and
		// is only visible when the camera points at it. Identical rotation math to
		// the GPS branch above, minus the absolute world origin.
		camera.position.copy(gyroLockCamPos);
		camera.rotation.order = 'YXZ';
		camera.rotation.y = cameraYaw;
		camera.rotation.x = -cameraPitch;
		camera.rotation.z = 0;
		camLookCurrent.set(
			Math.sin(cameraYaw) * Math.cos(cameraPitch),
			Math.sin(-cameraPitch),
			-Math.cos(cameraYaw) * Math.cos(cameraPitch),
		).add(camera.position);
	} else if (arFrozenCamPos) {
		// Plain AR mode: background stays anchored, avatar walks freely
		camera.position.copy(arFrozenCamPos);
		camera.lookAt(arFrozenCamLook);
	} else {
		// Normal follow camera
		const offset = CAM_OFFSET.clone();
		offset.applyAxisAngle(new Vector3(1, 0, 0), -cameraPitch);
		offset.applyAxisAngle(upY, cameraYaw);
		camDesired.copy(avatarRig.position).add(offset);
		camera.position.lerp(camDesired, CAM_LERP);
		camLookTarget.copy(avatarRig.position).add(CAM_LOOK_OFFSET);
		camLookCurrent.lerp(camLookTarget, CAM_LERP);
		camera.lookAt(camLookCurrent);
	}

	animMgr.update(dt);

	// Marker-anchored agents track the live marker frame every frame (the marker
	// observation refreshes as the camera moves) and hide when the marker isn't in
	// view — there's no odometry to coast on without it. Free when no marker pins exist.
	if (liveMarker || _markerPinsPresent) updateMarkerPins();

	// Animate placed-object spawn (scale 0 → 1, cubic ease-out)
	for (const obj of placedObjects) {
		if (obj.spawnT < SPAWN_DURATION) {
			obj.spawnT += dt;
			const p = Math.min(1, obj.spawnT / SPAWN_DURATION);
			obj.mesh.scale.setScalar(1 - Math.pow(1 - p, 3));
		}
	}

	// Membership transitions (task 04): ease a freshly discovered agent up from
	// nothing (scale 0 → 1, cubic ease-out), and shrink an evicted one to nothing
	// before disposing it. Both run far from the viewer (spawn at the ~40 m enter
	// edge, despawn past ~55 m), so they never collide with the close-range greet pop
	// that drives scale.y. Reduced-motion skips straight to the end state.
	for (const pin of nearbyPins) {
		if (pin.group && pin._spawnT < SPAWN_DURATION) {
			pin._spawnT += dt;
			const t = Math.min(1, pin._spawnT / SPAWN_DURATION);
			// Ease up to the owner's pinch-resized size, not a hardcoded 1.
			pin.group.scale.setScalar((1 - Math.pow(1 - t, 3)) * pinScale(pin));
		}
	}
	for (let i = _despawningPins.length - 1; i >= 0; i--) {
		const pin = _despawningPins[i];
		pin._despawnT += dt;
		const t = Math.min(1, pin._despawnT / DESPAWN_DURATION);
		if (pin.group) pin.group.scale.setScalar(Math.max(0.001, (1 - t) * (1 - t) * pinScale(pin)));
		if (t >= 1) { disposePin(pin); _despawningPins.splice(i, 1); }
	}

	// Distance LOD / draw budget (E2) — ~4 Hz. Decides each pin's band, drives the
	// queued GLB loads, impostor bakes and evictions, and sets the per-pin label
	// allowance. Runs before awareness so head-tracking only touches mounted models.
	_lodAccum += dt;
	if (_lodAccum >= LOD_INTERVAL) { _lodAccum = 0; enforceLOD(); }

	// Advance every mounted pin's idle mixer BEFORE awareness, so the gaze offset
	// composes on top of this frame's animated pose instead of being overwritten.
	updatePinIdles(dt);
	// Nearby agents notice the viewer — body/head turn, idle drift, greet pop.
	updateAgentAwareness(dt);

	// Project nearby agent labels to screen space (capped to BUDGET.label nearest).
	updateLabels();
	// Advance any live ambient interaction reactions (D3): age, reproject, retire.
	updateReactions(dt);
	// Gentle pulse on live presence ghosts (D2) — early-outs when none are present.
	updateGhosts(dt);
	// Non-map directional hint (task 03): point the edge glow toward the nearest
	// in-range agent and fade it once it's on-screen. ~20 Hz internally, no map.
	updateDirectionalNudge(dt);
	// Mirror that same nearest-agent cue onto paired smart glasses (no-op until paired).
	pushGlassesHud(dt);
	// Radar DOM is rebuilt at ~5 Hz, not every frame (it was a per-frame churn).
	_radarAccum += dt;
	if (_radarAccum >= RADAR_INTERVAL) { _radarAccum = 0; updateRadar(); }

	// Embodied finance: advance the carried avatar's wealth glow (breath/pulse).
	if (wealthAura) wealthAura.update(dt);

	renderer.render(scene, camera);
	frameWatchdog(dt);
	// Decline to reschedule if a pause landed mid-frame (tab hidden / context lost),
	// so the loop truly stops instead of resurrecting itself the next frame.
	xrViewer._rafId = _renderPaused ? null : requestAnimationFrame(tick);
}

// ── Nudge-to-calibrate (A3) ────────────────────────────────────────────────
// Cross-user anchor consistency means a placed agent must land in the SAME real
// spot for everyone. Consumer GPS is only ~5–15 m accurate (worse in urban
// canyons / indoors), so the owner — or the anonymous device that placed it —
// can long-press their agent (or tap "Calibrate" in its card) and nudge it a few
// centimetres / degrees into its true spot. The corrected pose re-saves and every
// nearby viewer re-fetches it.
//
// Honest about the ceiling: sub-metre cross-user agreement needs visual
// positioning (VPS). A2 reserved `vps_provider` / `vps_id` for that future path —
// capture a feature snapshot at placement, relocalize viewers against it, and
// store the VPS frame in those columns. Until then the confidence ring + this
// nudge keep the UX truthful and correctable. No coin is involved anywhere here.

let calibrateActive = false;
let _cal = null;                 // active per-pin calibration session, or null
let _roomCal = null;             // active one-gesture room-calibrate session, or null

// Pin ids this device placed — gates the client-side calibrate affordance and the
// gold "your agent" label. The server re-checks ownership on every PATCH, so this
// is convenience, not a security boundary.
const _myPinIds = new Set();
function isOwnPin(pin) {
	return _myPinIds.has(pin.id) || (gpsPin?.id != null && pin.id === gpsPin.id);
}
// Room ownership: the server's is_mine (authoritative across sessions/reloads) or
// a pin this device placed this session. Used to gate the whole-room align.
function isOwnRoomPin(pin) {
	return pin?.is_mine === true || isOwnPin(pin);
}
// The room id the given pin belongs to, IF this device owns every rendered agent
// in it (so a whole-room align can never move a stranger's agent). Null otherwise.
function alignableRoomId(pin) {
	const rid = pin?.room_id;
	if (!rid) return null;
	const inRoom = nearbyPins.filter(p => p.room_id === rid && p.group);
	if (!inRoom.length) return null;
	return inRoom.every(isOwnRoomPin) ? rid : null;
}

// — Long-press to enter calibrate —
let _lpTimer = null, _lpPin = null, _lpX = 0, _lpY = 0, _lpPointerId = -1;
const LONG_PRESS_MS = 520;

function _pinUnderPointer(e) {
	const groups = nearbyPins.map(p => p.group).filter(Boolean);
	if (!groups.length) return null;
	pointerNDC.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
	raycaster.setFromCamera(pointerNDC, camera);
	const hits = raycaster.intersectObjects(groups, true);
	if (!hits.length) return null;
	let node = hits[0].object;
	while (node) { const f = nearbyPins.find(p => p.group === node); if (f) return f; node = node.parent; }
	return null;
}

function armLongPress(e) {
	if (placeModeActive || calibrateActive) return;
	cancelLongPress();
	const pin = _pinUnderPointer(e);
	if (!pin) return;
	_lpPin = pin; _lpX = e.clientX; _lpY = e.clientY; _lpPointerId = e.pointerId;
	_lpTimer = setTimeout(() => {
		_lpTimer = null;
		const pin2 = _lpPin;
		if (!pin2) return;
		if (isOwnPin(pin2)) {
			try { navigator.vibrate?.(15); } catch {}
			enterCalibrate(pin2, { pointerId: _lpPointerId, x: _lpX, y: _lpY });
		} else {
			showCalibrateDenied();
		}
	}, LONG_PRESS_MS);
}
function cancelLongPress() { if (_lpTimer) { clearTimeout(_lpTimer); _lpTimer = null; } _lpPin = null; }
function cancelLongPressIfMoved(e) {
	if (_lpTimer && Math.hypot(e.clientX - _lpX, e.clientY - _lpY) > TAP_THRESHOLD) cancelLongPress();
}

// — Calibration session —
function enterCalibrate(pin, seed = null) {
	const panel = document.getElementById('irl-calibrate-panel');
	if (!panel || !pin) return;
	document.getElementById('irl-sheet')?.classList.remove('is-open');
	const yaw0 = Number.isFinite(pin.anchor_yaw_deg) ? pin.anchor_yaw_deg : (pin.heading ?? 0);
	const norm = ((yaw0 % 360) + 360) % 360;
	const h0   = pinHeightM(pin);
	_cal = { pin, origLat: pin.lat, origLng: pin.lng, origYaw: norm, origHeight: h0,
	         lat: pin.lat, lng: pin.lng, yaw: norm, height: h0 };
	calibrateActive = true;
	document.body.classList.add('is-calibrating');
	pin.labelEl?.classList.add('is-calibrating');
	const titleEl = document.getElementById('irl-cal-title');
	if (titleEl) titleEl.textContent = `Calibrating ${pin.avatar_name || 'agent'}`;
	const errEl = document.getElementById('irl-cal-error');
	if (errEl) { errEl.hidden = true; errEl.replaceChildren(); }
	const saveBtn = document.getElementById('irl-cal-save');
	if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save position'; }
	updateCalReadout(); updateCalAccuracy(); updateCalHeightLabel();
	panel.classList.add('is-open');
	setStatus('Drag to nudge · twist with two fingers to rotate');
	// Reset gesture state; adopt the held finger (long-press) so the drag is live now.
	_calPtrs.clear(); _calTwistStart = null; _calGroundStart = null; _calDragStart = null;
	if (seed) {
		_calPtrs.set(seed.pointerId, { x: seed.x, y: seed.y });
		const gp = _groundPointXY(seed.x, seed.y);
		_calGroundStart = gp ? { x: gp.x, z: gp.z } : null;
		_calDragStart = { lat: _cal.lat, lng: _cal.lng };
		try { canvas.setPointerCapture?.(seed.pointerId); } catch {}
	}
}

function exitCalibrate(revert) {
	if (_roomCal) return exitRoomCalibrate(revert);
	document.getElementById('irl-calibrate-panel')?.classList.remove('is-open');
	document.body.classList.remove('is-calibrating');
	if (_cal) {
		_cal.pin.labelEl?.classList.remove('is-calibrating');
		if (revert) {
			_cal.lat = _cal.origLat; _cal.lng = _cal.origLng;
			_cal.yaw = _cal.origYaw; _cal.height = _cal.origHeight;
			applyCalToGroup();
		}
	}
	_cal = null;
	calibrateActive = false;
	_calPtrs.clear(); _calTwistStart = null; _calGroundStart = null; _calDragStart = null;
	const saveBtn = document.getElementById('irl-cal-save');
	if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save position'; }
}

// Clamp the working pose to a small correction — calibration, never relocation.
function clampCalToBounds() {
	if (!_cal) return;
	const mLat = 110540, mLng = 111320 * Math.cos(_cal.origLat * Math.PI / 180);
	const north = Math.max(-3, Math.min(3, (_cal.lat - _cal.origLat) * mLat));
	const east  = Math.max(-3, Math.min(3, (_cal.lng - _cal.origLng) * mLng));
	_cal.lat = _cal.origLat + north / mLat;
	_cal.lng = _cal.origLng + east / mLng;
	let dy = ((_cal.yaw - _cal.origYaw + 540) % 360) - 180;
	dy = Math.max(-45, Math.min(45, dy));
	_cal.yaw = ((_cal.origYaw + dy) % 360 + 360) % 360;
	_cal.height = Math.max(-1, Math.min(1, _cal.height));
}

// Apply the working pose to the live 3D group so the nudge is fully optimistic.
function applyCalToGroup() {
	if (!_cal?.pin.group) return;
	clampCalToBounds();
	const wp = gpsToWorld(_cal.lat, _cal.lng);
	_cal.pin.group.position.set(wp.x, _cal.height, wp.z);
	_cal.pin.group.rotation.y = -(_cal.yaw * Math.PI / 180);
	_cal.pin.baseYaw = _cal.pin.group.rotation.y;  // keep the camera-aware rest target in sync
}

function _deltaMetres() {
	const mLat = 110540, mLng = 111320 * Math.cos(_cal.origLat * Math.PI / 180);
	const north = (_cal.lat - _cal.origLat) * mLat;
	const east  = (_cal.lng - _cal.origLng) * mLng;
	const dyaw  = ((_cal.yaw - _cal.origYaw + 540) % 360) - 180;
	return { north, east, dyaw };
}
function updateCalReadout() {
	const el = document.getElementById('irl-cal-readout');
	if (!el || !_cal) return;
	const { north, east, dyaw } = _deltaMetres();
	const ns = north >= 0 ? 'N' : 'S', ew = east >= 0 ? 'E' : 'W';
	const dh = (_cal.height - _cal.origHeight) * 100;
	el.textContent = `${Math.abs(north).toFixed(2)} m ${ns} · ${Math.abs(east).toFixed(2)} m ${ew} · ${dyaw >= 0 ? '+' : ''}${dyaw.toFixed(0)}° · ${dh >= 0 ? '+' : ''}${dh.toFixed(0)} cm`;
}
function updateCalAccuracy() {
	const el = document.getElementById('irl-cal-accuracy');
	if (!el || !_cal) return;
	const acc = Number.isFinite(_cal.pin.gps_accuracy_m) ? _cal.pin.gps_accuracy_m
		: (Number.isFinite(gpsState.accuracy) ? gpsState.accuracy : null);
	const low = acc != null && acc > RING_LOW_ACC_M;
	el.classList.toggle('is-low', low);
	el.textContent = acc != null
		? (low
			? `Position is GPS-accurate to ~${Math.round(acc)} m. Find a spot with clearer sky for a tighter lock, then drag to fine-tune.`
			: `Position is GPS-accurate to ~${Math.round(acc)} m. Drag to fine-tune.`)
		: 'Drag to fine-tune this agent’s real-world spot.';
}
function updateCalHeightLabel() {
	const el = document.getElementById('irl-cal-height');
	if (!el || !_cal) return;
	const dh = (_cal.height - _cal.origHeight) * 100;
	el.textContent = `${dh >= 0 ? '+' : ''}${dh.toFixed(0)} cm`;
}
function nudgeHeight(d) {
	if (!_cal) return;
	_cal.height = Math.max(-1, Math.min(1, (_cal.height || 0) + d));
	applyCalToGroup(); updateCalReadout(); updateCalHeightLabel();
}

// — Touch gestures (drag = move on the ground, two-finger twist = rotate yaw) —
const _calPtrs = new Map();
let _calDragStart = null, _calGroundStart = null, _calTwistStart = null;

function _groundPointXY(clientX, clientY) {
	pointerNDC.set((clientX / window.innerWidth) * 2 - 1, -(clientY / window.innerHeight) * 2 + 1);
	raycaster.setFromCamera(pointerNDC, camera);
	const hits = raycaster.intersectObject(rayPlane);
	return hits.length ? hits[0].point : null;
}
function _twoFingerAngle() {
	const pts = [..._calPtrs.values()];
	return Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x);
}
function calPointerDown(e) {
	if (!calibrateActive) return;
	_calPtrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
	try { canvas.setPointerCapture?.(e.pointerId); } catch {}
	if (_calPtrs.size >= 2) {
		_calTwistStart = { angle: _twoFingerAngle(), yaw: _roomCal ? _roomCal.dYaw : _cal.yaw };
		_calGroundStart = null;
	} else {
		const gp = _groundPointXY(e.clientX, e.clientY);
		_calGroundStart = gp ? { x: gp.x, z: gp.z } : null;
		_calDragStart = _roomCal ? { dEast: _roomCal.dEast, dNorth: _roomCal.dNorth } : { lat: _cal.lat, lng: _cal.lng };
	}
}
function calPointerMove(e) {
	if (!calibrateActive || !_calPtrs.has(e.pointerId)) return;
	_calPtrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
	// Room align: the whole cluster slides (drag) / rotates about its origin (twist).
	if (_roomCal) {
		if (_calPtrs.size >= 2) {
			if (!_calTwistStart) _calTwistStart = { angle: _twoFingerAngle(), yaw: _roomCal.dYaw };
			let dDeg = (_twoFingerAngle() - _calTwistStart.angle) * 180 / Math.PI;
			dDeg = Math.max(-45, Math.min(45, dDeg));
			_roomCal.dYaw = _calTwistStart.yaw + dDeg;
			applyRoomCalToGroups(); updateRoomCalReadout();
			return;
		}
		if (!_calGroundStart || !_calDragStart) {
			const gp0 = _groundPointXY(e.clientX, e.clientY);
			if (gp0) { _calGroundStart = { x: gp0.x, z: gp0.z }; _calDragStart = { dEast: _roomCal.dEast, dNorth: _roomCal.dNorth }; }
			return;
		}
		const gpr = _groundPointXY(e.clientX, e.clientY);
		if (!gpr) return;
		_roomCal.dEast  = _calDragStart.dEast  + (gpr.x - _calGroundStart.x);
		_roomCal.dNorth = _calDragStart.dNorth - (gpr.z - _calGroundStart.z); // north = −Z
		applyRoomCalToGroups(); updateRoomCalReadout();
		return;
	}
	if (_calPtrs.size >= 2) {
		// Two-finger twist → yaw nudge. Live feedback lets the owner aim it; clamp ±45°.
		if (!_calTwistStart) _calTwistStart = { angle: _twoFingerAngle(), yaw: _cal.yaw };
		let dDeg = (_twoFingerAngle() - _calTwistStart.angle) * 180 / Math.PI;
		dDeg = Math.max(-45, Math.min(45, dDeg));
		_cal.yaw = ((_calTwistStart.yaw + dDeg) % 360 + 360) % 360;
		applyCalToGroup(); updateCalReadout();
		return;
	}
	// Single-finger ground drag → horizontal nudge in metres (clamped ±3 m N/E).
	if (!_calGroundStart || !_calDragStart) {
		const gp0 = _groundPointXY(e.clientX, e.clientY);
		if (gp0) { _calGroundStart = { x: gp0.x, z: gp0.z }; _calDragStart = { lat: _cal.lat, lng: _cal.lng }; }
		return;
	}
	const gp = _groundPointXY(e.clientX, e.clientY);
	if (!gp) return;
	const dEast  = Math.max(-3, Math.min(3, gp.x - _calGroundStart.x));
	const dNorth = Math.max(-3, Math.min(3, -(gp.z - _calGroundStart.z)));
	const mLat = 110540, mLng = 111320 * Math.cos(_calDragStart.lat * Math.PI / 180);
	_cal.lat = _calDragStart.lat + dNorth / mLat;
	_cal.lng = _calDragStart.lng + dEast / mLng;
	applyCalToGroup(); updateCalReadout();
}
function calPointerUp(e) {
	if (!_calPtrs.has(e.pointerId)) return;
	_calPtrs.delete(e.pointerId);
	try { canvas.releasePointerCapture?.(e.pointerId); } catch {}
	if (_calPtrs.size < 2) _calTwistStart = null;
	if (_calPtrs.size === 0) { _calGroundStart = null; _calDragStart = null; }
	else { // rebase the remaining finger so lifting one doesn't jump the rig
		_calGroundStart = null;
		_calDragStart = _roomCal ? { dEast: _roomCal.dEast, dNorth: _roomCal.dNorth } : { lat: _cal.lat, lng: _cal.lng };
	}
}

// — Save / errors —
async function saveCalibrate() {
	if (_roomCal) return saveRoomCalibrate();
	if (!_cal) return;
	const saveBtn = document.getElementById('irl-cal-save');
	const errEl   = document.getElementById('irl-cal-error');
	if (errEl) { errEl.hidden = true; errEl.replaceChildren(); }
	if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }
	const pin = _cal.pin;
	// For a ROOM pin the render path resolves position from rel_east_m/rel_north_m
	// (not the absolute lat/lng), so a drag that moved only lat/lng would snap back on
	// the next viewer re-fetch. Re-derive the agent's exact room-frame offset from the
	// calibrated coordinate and send it too, so the per-agent nudge sticks for everyone.
	const _room = pinRoom(pin);
	const _rel = _room
		? roomRelFromGeo({ originLat: _room.originLat, originLng: _room.originLng, originYawDeg: _room.originYawDeg, lat: _cal.lat, lng: _cal.lng })
		: null;
	const body = { id: pin.id, deviceToken: _deviceToken, calibrate: {
		lat: _cal.lat, lng: _cal.lng, anchorYawDeg: _cal.yaw, anchorHeightM: _cal.height,
		...(_rel ? { relEast: _rel.relEast, relNorth: _rel.relNorth } : {}) } };
	try {
		const r = await fetch('/api/irl/pins', {
			method: 'PATCH', credentials: 'include',
			headers: deviceHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(body),
		});
		if (!r.ok) {
			const m = r.status === 403 ? 'Only the owner can calibrate this agent.'
				: r.status === 422 ? 'That nudge is too large — calibration is for fine-tuning, not moving the agent.'
				: r.status === 404 ? 'This agent is no longer here.'
				: 'Could not save the new position.';
			throw new Error(m);
		}
		// Commit the corrected pose onto the live pin so it persists this session and
		// every nearby viewer picks it up on their next proximity re-fetch (~10 s).
		pin.lat = _cal.lat; pin.lng = _cal.lng;
		pin.anchor_yaw_deg = _cal.yaw; pin.heading = Math.round(_cal.yaw);
		pin.anchor_height_m = _cal.height;
		if (_rel) { pin.rel_east_m = _rel.relEast; pin.rel_north_m = _rel.relNorth; }
		// The manual yaw nudge supersedes the captured surface quaternion; drop it so
		// pinYawRad (task 02) reads the corrected anchor_yaw_deg, matching the server
		// (handleCalibrate clears anchor_quat on a yaw change). Without this the live
		// pin would keep rendering the pre-nudge facing until the next re-fetch.
		pin.anchor_quat = null;
		setStatus('Position calibrated — saved here; nearby viewers update within ~10s');
		exitCalibrate(false);
		loadNearbyPins();
	} catch (err) {
		// Optimistic-undo: keep the nudge on screen with a retry / undo chip — never
		// leave a half-applied, local-only correction.
		if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save position'; }
		if (errEl) {
			errEl.replaceChildren(errorStateEl({
				title: 'Save failed',
				body: _escHtml(err.message || 'Could not save the new position.'),
				actions: [
					{ label: 'Retry', id: 'cal-retry', primary: true },
					{ label: 'Undo',  id: 'cal-undo' },
				],
			}));
			errEl.hidden = false;
		}
	}
}

// ── One-gesture ROOM calibrate (R2) ─────────────────────────────────────────
// The headline alignment tool. Every agent in a room is rigidly tied to one
// shared origin, so instead of nudging each agent (A3) the owner grabs the WHOLE
// cluster and slides / twists it onto its true real-world spot once — moving
// every agent together with the internal layout intact. The gesture mirrors the
// per-pin calibrate (reusing _calPtrs / _groundPointXY) but is applied to the
// room ORIGIN (roomOriginWorld) and re-renders the cluster live; the save is the
// owner-gated, bounds-checked room-scoped PATCH (handleCalibrateRoom), which
// re-derives each agent's absolute lat/lng from its unchanged room-frame offset.

function enterRoomCalibrate(roomId) {
	const panel = document.getElementById('irl-calibrate-panel');
	const pins = nearbyPins.filter(p => p.room_id === roomId && p.group);
	if (!panel || !pins.length) return;
	if (!pins.every(isOwnRoomPin)) { showCalibrateDenied(); return; }
	if (!gpsState.ready) { setStatus('Waiting for a GPS fix before aligning the room…', { warn: true }); return; }
	document.getElementById('irl-sheet')?.classList.remove('is-open');
	const base = pins[0];
	_roomCal = {
		roomId, pins,
		originLat: Number(base.origin_lat), originLng: Number(base.origin_lng),
		originYawDeg: Number(base.origin_yaw_deg) || 0,
		dEast: 0, dNorth: 0, dYaw: 0,
	};
	for (const p of pins) {
		const yaw0 = Number.isFinite(p.anchor_yaw_deg) ? p.anchor_yaw_deg : (p.heading ?? 0);
		p._roomCalBaseYaw = ((yaw0 % 360) + 360) % 360;
		p.labelEl?.classList.add('is-calibrating');
	}
	calibrateActive = true;
	document.body.classList.add('is-calibrating', 'is-room-cal');
	const titleEl = document.getElementById('irl-cal-title');
	if (titleEl) titleEl.textContent = `Align ${pins.length} agent${pins.length === 1 ? '' : 's'} in this room`;
	const errEl = document.getElementById('irl-cal-error');
	if (errEl) { errEl.hidden = true; errEl.replaceChildren(); }
	const saveBtn = document.getElementById('irl-cal-save');
	if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save room position'; }
	updateRoomCalReadout(); updateRoomCalAccuracy();
	panel.classList.add('is-open');
	setStatus('Drag to slide the whole room · twist with two fingers to rotate');
	_calPtrs.clear(); _calTwistStart = null; _calGroundStart = null; _calDragStart = null;
}

function exitRoomCalibrate(revert) {
	document.getElementById('irl-calibrate-panel')?.classList.remove('is-open');
	document.body.classList.remove('is-calibrating', 'is-room-cal');
	if (_roomCal) {
		if (revert) { _roomCal.dEast = 0; _roomCal.dNorth = 0; _roomCal.dYaw = 0; applyRoomCalToGroups(); }
		for (const p of _roomCal.pins) { p.labelEl?.classList.remove('is-calibrating'); delete p._roomCalBaseYaw; }
	}
	_roomCal = null;
	calibrateActive = false;
	_calPtrs.clear(); _calTwistStart = null; _calGroundStart = null; _calDragStart = null;
	const saveBtn = document.getElementById('irl-cal-save');
	if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save position'; }
	const titleEl = document.getElementById('irl-cal-title');
	if (titleEl) titleEl.textContent = 'Calibrate position';
}

// Clamp the working alignment to a small correction — slide a few metres / twist,
// never relocate. Matches the server ceilings (±5 m translation magnitude, ±45°).
function clampRoomCal() {
	if (!_roomCal) return;
	const m = Math.hypot(_roomCal.dEast, _roomCal.dNorth);
	if (m > 5) { const s = 5 / m; _roomCal.dEast *= s; _roomCal.dNorth *= s; }
	_roomCal.dYaw = Math.max(-45, Math.min(45, _roomCal.dYaw));
}

// Apply the working alignment to every group in the cluster so the whole room
// moves rigidly and live. Reuses the pure room-anchor math against a temporary
// origin (current origin + the drag) and frame yaw (+ the twist).
function applyRoomCalToGroups() {
	if (!_roomCal) return;
	clampRoomCal();
	const moved = localToGeo(_roomCal.originLat, _roomCal.originLng, _roomCal.dEast, _roomCal.dNorth);
	const yaw = ((_roomCal.originYawDeg + _roomCal.dYaw) % 360 + 360) % 360;
	const originWorld = roomOriginWorld(gpsState.lat, gpsState.lng, moved.lat, moved.lng);
	for (const p of _roomCal.pins) {
		if (!p.group) continue;
		const wp = agentWorldPosition({
			originWorld,
			relEast: Number(p.rel_east_m) || 0,
			relNorth: Number(p.rel_north_m) || 0,
			heightM: pinHeightM(p),
			originYawDeg: yaw,
		});
		p.group.position.set(wp.x, wp.y, wp.z);
		const fy = -(((p._roomCalBaseYaw || 0) + _roomCal.dYaw) * Math.PI / 180);
		p.group.rotation.y = fy;
		p.baseYaw = fy; // keep the camera-aware rest target in sync
		updatePinRing(p);
	}
}

function updateRoomCalReadout() {
	const el = document.getElementById('irl-cal-readout');
	if (!el || !_roomCal) return;
	clampRoomCal();
	const ns = _roomCal.dNorth >= 0 ? 'N' : 'S', ew = _roomCal.dEast >= 0 ? 'E' : 'W';
	const dy = _roomCal.dYaw;
	el.textContent = `${Math.abs(_roomCal.dNorth).toFixed(1)} m ${ns} · ${Math.abs(_roomCal.dEast).toFixed(1)} m ${ew} · ${dy >= 0 ? '+' : ''}${dy.toFixed(0)}°`;
}

// Honest room-level confidence: anchor the cluster to the LOOSEST origin-GPS
// accuracy across its agents, so the owner understands "this room is anchored to
// about ±N m — align it if it's off." Never imply centimetre precision.
function updateRoomCalAccuracy() {
	const el = document.getElementById('irl-cal-accuracy');
	if (!el || !_roomCal) return;
	let acc = null;
	for (const p of _roomCal.pins) {
		const a = Number.isFinite(p.gps_accuracy_m) ? p.gps_accuracy_m : null;
		if (a != null) acc = acc == null ? a : Math.max(acc, a);
	}
	if (acc == null && Number.isFinite(gpsState.accuracy)) acc = gpsState.accuracy;
	const low = acc != null && acc > RING_LOW_ACC_M;
	el.classList.toggle('is-low', low);
	el.textContent = acc != null
		? `This room is anchored to about ±${Math.round(acc)} m. Slide and twist the whole cluster onto its real spot, then save.`
		: 'Slide and twist the whole cluster onto its real spot, then save.';
}

async function saveRoomCalibrate() {
	if (!_roomCal) return;
	clampRoomCal();
	const saveBtn = document.getElementById('irl-cal-save');
	const errEl   = document.getElementById('irl-cal-error');
	if (errEl) { errEl.hidden = true; errEl.replaceChildren(); }
	const { roomId, dEast, dNorth, dYaw } = _roomCal;
	// A no-op gesture: nothing to persist — exit cleanly rather than burn a write.
	if (Math.hypot(dEast, dNorth) < 0.02 && Math.abs(dYaw) < 0.5) {
		exitRoomCalibrate(false);
		setStatus('Room already aligned — no change to save');
		return;
	}
	if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }
	const pins = _roomCal.pins;
	const baseOrigin = { originLat: _roomCal.originLat, originLng: _roomCal.originLng, originYawDeg: _roomCal.originYawDeg };
	try {
		const r = await fetch('/api/irl/pins', {
			method: 'PATCH', credentials: 'include',
			headers: deviceHeaders({ 'Content-Type': 'application/json' }),
			body: JSON.stringify({ deviceToken: _deviceToken, calibrateRoom: {
				roomId, dEastM: dEast, dNorthM: dNorth, dYawDeg: dYaw } }),
		});
		if (!r.ok) {
			const m = r.status === 403 ? 'Only the room owner can align this room.'
				: r.status === 422 ? 'That move is too large — alignment slides the room a few metres, it doesn’t relocate it.'
				: r.status === 404 ? 'This room is no longer here.'
				: 'Could not save the room alignment.';
			throw new Error(m);
		}
		const data = await r.json().catch(() => ({}));
		const next = (data && data.origin)
			? { originLat: data.origin.lat, originLng: data.origin.lng, originYawDeg: data.origin.yawDeg }
			: calibrateRoomOrigin({ ...baseOrigin, dEastM: dEast, dNorthM: dNorth, dYawDeg: dYaw });
		// Commit the new origin + per-agent facing onto every live pin so the cluster
		// persists this session; nearby viewers pick it up on their next poll. Render
		// keeps using the room frame (origin + rel), so this avoids a snap on exit.
		for (const p of pins) {
			p.origin_lat = next.originLat; p.origin_lng = next.originLng; p.origin_yaw_deg = next.originYawDeg;
			const newYaw = (((p._roomCalBaseYaw || 0) + dYaw) % 360 + 360) % 360;
			p.anchor_yaw_deg = newYaw; p.heading = Math.round(newYaw);
			if (dYaw !== 0) p.anchor_quat = null;
		}
		setStatus('Room aligned — saved here; nearby viewers update within ~10s');
		exitRoomCalibrate(false);
		loadNearbyPins();
	} catch (err) {
		if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save room position'; }
		if (errEl) {
			errEl.replaceChildren(errorStateEl({
				title: 'Alignment failed',
				body: _escHtml(err.message || 'Could not save the room alignment.'),
				actions: [
					{ label: 'Retry', id: 'cal-retry', primary: true },
					{ label: 'Undo',  id: 'cal-undo' },
				],
			}));
			errEl.hidden = false;
		}
	}
}

// ── Relative-frame one-tap alignment (R2) ───────────────────────────────────
// A room placed WITHOUT an absolute compass can render rotated for a second
// viewer. When such a cluster is nearby (and this viewer doesn't own it — owners
// get the full gesture), offer a one-tap "face the room's front and tap" align
// that rotates THIS viewer's frame to match (a viewer-local _roomYawOffset). It
// never moves the room for anyone else.
const _roomAlignDismissed = new Set();
function isRelativeFrameRoom(pin) {
	return (Number(pin.origin_yaw_deg) || 0) !== 0 || pin.anchor_source === 'gyro-gps:rel';
}
function maybePromptRoomAlign() {
	const prompt = document.getElementById('irl-room-align-prompt');
	if (!prompt) return;
	if (calibrateActive) return; // don't stack over an active alignment
	let target = null;
	for (const p of nearbyPins) {
		if (!p.room_id || !p.group) continue;
		if (_roomYawOffset.has(p.room_id) || _roomAlignDismissed.has(p.room_id)) continue;
		if (alignableRoomId(p)) continue;          // owner — use the full align gesture instead
		if (!isRelativeFrameRoom(p)) continue;
		target = p; break;
	}
	if (!target) { prompt.classList.remove('is-shown'); prompt.hidden = true; return; }
	prompt.dataset.roomId = target.room_id;
	prompt.dataset.storedYaw = String(Number(target.origin_yaw_deg) || 0);
	prompt.hidden = false;
	requestAnimationFrame(() => prompt.classList.add('is-shown'));
}
function alignRelativeRoom(roomId, storedYaw) {
	const heading = lastCompassHeading != null
		? lastCompassHeading
		: ((-(cameraYaw * 180 / Math.PI)) % 360 + 360) % 360;
	// Effective frame yaw becomes the viewer's current facing, so the room's local
	// "forward" (relNorth+) aligns to where the viewer is looking.
	_roomYawOffset.set(roomId, (((heading - storedYaw) % 360) + 360) % 360);
	persistRoomAlign();
	for (const p of nearbyPins) {
		if (p.room_id !== roomId || !p.group) continue;
		const wp = pinWorldPos(p);
		p.group.position.set(wp.x, wp.y, wp.z);
		p.distance_m = Math.round(Math.hypot(wp.x, wp.z));
		updatePinRing(p);
	}
	setStatus('Room aligned to your view');
}

function showCalibrateDenied() {
	const el = document.getElementById('irl-cal-denied');
	if (!el) { setStatus('Only the owner can calibrate this agent', { error: true }); return; }
	el.replaceChildren(errorStateEl({
		title: 'Calibration locked',
		body: 'Only the owner can calibrate this agent’s position.',
		actions: [{ label: 'Got it', id: 'cal-denied-ok', primary: true }],
	}));
	el.hidden = false;
	requestAnimationFrame(() => el.classList.add('is-open'));
	clearTimeout(showCalibrateDenied._t);
	showCalibrateDenied._t = setTimeout(() => {
		el.classList.remove('is-open');
		setTimeout(() => { el.hidden = true; }, 220);
	}, 4200);
}

// — Wiring —
canvas.addEventListener('pointermove',   cancelLongPressIfMoved);
canvas.addEventListener('pointercancel', cancelLongPress);
// Capture phase so a calibrate gesture beats the orbit / tap handlers; no-op when
// calibration isn't active, so normal orbiting / tapping is untouched.
canvas.addEventListener('pointerdown',   calPointerDown, true);
canvas.addEventListener('pointermove',   calPointerMove, true);
canvas.addEventListener('pointerup',     calPointerUp,   true);
canvas.addEventListener('pointercancel', calPointerUp,   true);

document.getElementById('irl-cal-save')?.addEventListener('click', saveCalibrate);
document.getElementById('irl-cal-cancel')?.addEventListener('click', () => exitCalibrate(true));
document.getElementById('irl-cal-up')?.addEventListener('click', () => nudgeHeight(0.05));
document.getElementById('irl-cal-down')?.addEventListener('click', () => nudgeHeight(-0.05));
document.getElementById('irl-cal-error')?.addEventListener('click', (e) => {
	const a = e.target.closest('[data-sk-action]');
	if (!a) return;
	if (a.dataset.skAction === 'cal-retry') saveCalibrate();
	else if (a.dataset.skAction === 'cal-undo') exitCalibrate(true);
});
document.getElementById('irl-cal-denied')?.addEventListener('click', (e) => {
	if (!e.target.closest('[data-sk-action]')) return;
	const el = document.getElementById('irl-cal-denied');
	el.classList.remove('is-open');
	setTimeout(() => { el.hidden = true; }, 220);
});
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && calibrateActive) exitCalibrate(true); });

// Relative-frame one-tap alignment prompt (R2). "Align" rotates this viewer's
// frame to match the room; "Dismiss" hides it for the session.
document.getElementById('irl-room-align-prompt')?.addEventListener('click', (e) => {
	const btn = e.target.closest('[data-ra-action]');
	if (!btn) return;
	const prompt = document.getElementById('irl-room-align-prompt');
	const roomId = prompt?.dataset.roomId;
	if (btn.dataset.raAction === 'align' && roomId) {
		alignRelativeRoom(roomId, Number(prompt.dataset.storedYaw) || 0);
	} else if (roomId) {
		_roomAlignDismissed.add(roomId);
	}
	prompt?.classList.remove('is-shown');
	if (prompt) setTimeout(() => { prompt.hidden = true; }, 220);
});

// ── Boot ──────────────────────────────────────────────────────────────────
// Permissions + first-run onboarding (E1) own the camera/motion/location prompts.
// GPS starts only once location is granted — via first-run, a repeat-visit replay,
// or a later chip tap — so there's no silent native location prompt on load.
startOnboarding({ onGrant: (kind) => {
	if (kind === 'location') { initGPS(); maybeShowFirstRunDisclosure(); }
} }).finally(() => {
	// Task 02 — once the permission flow settles, reveal the "?" affordance and, on
	// a fresh device, show the discovery explainer once. maybeFirstRun() defers
	// behind any open first-run privacy disclosure so the two never stack.
	discovery.maybeFirstRun();
});

// Reveal My pins on load if this device already owns pins — management must
// survive a reload (and a denied GPS prompt). The GPS-ready path reveals it too.
loadMyPins().then(pins => { if (pins.length) revealMyPinsBtn(); }).catch(() => {});

// Tap the realtime pill to force a reconnect when it's in the polling fallback.
document.getElementById('irl-net-pill')?.addEventListener('click', () => irlNet?.retry());
// Tear down the live stream + poll on navigation away so we never leak a socket or
// an interval across an SPA transition / tab close.
window.addEventListener('pagehide', () => { irlNet?.destroy(); stopPinPolling(); });

// URL ?avatar= wins over the saved session (an explicit link is intentional);
// otherwise fall back to whatever avatar was active last visit.
const _targetAvatarId = avatarIdParam || _savedSession?.avatarId || null;

// Start the render loop exactly once; the avatar streams in (or retries) on top
// of it, so a failed first load never freezes the scene or double-starts the tick.
let _tickStarted = false;
function ensureTick() { if (!_tickStarted) { _tickStarted = true; startTick(); } }

function bootAvatar() {
	return loadAvatar(_targetAvatarId)
		.then(() => {
			hideOverlay();
			_restoreSession();
			ensureTick();
		})
		.catch(err => {
			log.error('[irl] avatar load failed:', err);
			nameEl.textContent = 'Avatar';
			cameraBtn.disabled = false;
			cameraBtn.removeAttribute('aria-busy');
			ensureTick();
			// Designed, retryable state instead of a 3-second toast over a blank scene.
			showAvatarLoadError(err, bootAvatar);
		});
}
bootAvatar();

// Detect WebXR floor-anchoring support and reveal the entry once ready. iOS
// Safari (no immersive-ar) never sees the button and stays on the gyro+GPS Pin
// path; desktop Chrome reports false and adds no console noise.
detectFloorAnchorSupport();

// ── Room authoring mode (Epic R / R1) — "place agents around me" ────────────
// Self-contained UI lives in src/irl/room-mode.js (its own DOM + styles); we
// supply the live pose, AR/permission readiness, and the placement (network +
// scene spawn) it calls back into. Rooms are delivered to other viewers by the
// REST proximity read — there is no realtime pin push to wire here.
// Live ghost preview (R1 §3): a translucent stand-in at the exact spot the agent
// will land, so the user sees it in the room before committing. room-mode drives
// it each animation frame via the previewAim dep; the geometry is the same
// room-anchor.js math the real placement uses, so the agent doesn't jump on Place.
const roomGhost = createRoomGhost(scene, { reducedMotion: prefersReducedMotion });
roomModeApi = initRoomMode({
	controlRow: document.querySelector('.irl-secondary-row'),
	getFix: () => ({ lat: gpsState.lat, lng: gpsState.lng, ready: gpsState.ready, accuracy: gpsState.accuracy }),
	getHeading: () => ({
		// Prefer the iOS true-compass bearing; otherwise derive from the camera yaw
		// (which onDeviceOrientation north-anchors when an absolute stream exists).
		deg: lastCompassHeading != null
			? lastCompassHeading
			: ((-(cameraYaw * 180 / Math.PI)) % 360 + 360) % 360,
		absolute: !!prefersAbsOrientation,
	}),
	ensureReady: async () => {
		try {
			if (!arActive) await enableAR();
			initGPS();
			ensurePermission('motion').catch(() => {});
			ensurePermission('location').catch(() => {});
		} catch { /* honest disabled states in the HUD cover a denied permission */ }
		return arActive;
	},
	placeRoomAgent,
	previewAim: (s) => roomGhost.preview(s),
	status: (m, o) => setStatus(m, o),
});

// ── Marker authoring/finding mode (Epic M) — indoor visual colocalization ────
// Place an agent against a QR marker both phones can see, so a second viewer who
// scans the same marker finds it standing in the same physical spot — GPS-free,
// the one thing the room frame can't do indoors. Self-contained UI in
// src/irl/marker-mode.js; here we supply the camera→world observation (the only
// part that needs the live Three.js camera) and the network/scene calls, mirroring
// the room-mode contract. Marker pins ride the existing nearby-pin pipeline (LOD,
// load queue, labels) but are exempt from GPS-feed eviction and are positioned each
// frame by updateMarkerPins() from the live marker observation.
markerModeApi = initMarkerMode({
	controlRow: document.querySelector('.irl-secondary-row'),
	ensureReady: async () => {
		try {
			if (!arActive) await enableAR();
			initGPS();
			ensurePermission('location').catch(() => {});
		} catch { /* honest disabled states in the HUD cover a denied permission */ }
		return arActive;
	},
	getVideo: () => videoEl,
	getFix: () => ({ lat: gpsState.lat, lng: gpsState.lng, ready: gpsState.ready, accuracy: gpsState.accuracy }),
	// Resolve the detected QR's world pose from THIS session's live camera: monocular
	// pose (known marker size + camera FOV) → camera space → world via the real camera.
	observeMarker: (picked) => {
		try {
			const frame = picked.frame;
			const pose = markerPoseCamera({
				center: cornerCenter(picked.cornerPoints),
				rightMid: cornerRightMid(picked.cornerPoints),
				spanPx: picked.spanPx,
				frame,
				vfovDeg: camera.fov, // Three.js PerspectiveCamera.fov is the vertical FOV in degrees
			});
			if (!pose.ok) return null;
			camera.updateMatrixWorld();
			const wc = camera.localToWorld(new Vector3(pose.center.x, pose.center.y, pose.center.z));
			const wr = camera.localToWorld(new Vector3(pose.right.x, pose.right.y, pose.right.z));
			const markerYawDeg = markerYawFromEdge({ x: wc.x, z: wc.z }, { x: wr.x, z: wr.z });
			if (markerYawDeg == null) return null;
			return { markerWorld: { x: wc.x, z: wc.z }, markerY: wc.y, markerYawDeg, distanceM: pose.distanceM };
		} catch { return null; }
	},
	setLiveMarker,
	// In gyro/AR mode the viewer stands at the world origin (camera at eye height);
	// their feet — where "Place here" drops the agent — are that XZ on the floor (y=0).
	getViewerWorld: () => ({ x: camera.position.x, z: camera.position.z, y: 0 }),
	placeMarkerAgent: async ({ roomId, token, marker, viewer, fix }) => {
		if (!fix || !fix.ready) {
			return { ok: false, message: 'Turn location on once — the marker needs a coarse index to save your placement.' };
		}
		const rel = markerRelFromWorld({
			markerWorld: marker.markerWorld, markerYawDeg: marker.markerYawDeg,
			x: viewer.x, z: viewer.z,
		});
		const room = markerRoomBlock({ roomId, indexLat: fix.lat, indexLng: fix.lng, relEast: rel.relEast, relNorth: rel.relNorth });
		// 180° marker-relative facing: the agent turns back toward the marker, so a
		// viewer who walks up from the marker meets its face. updateMarkerPins composes
		// this with the live marker azimuth per viewer.
		const result = await postRoomPin({
			lat: fix.lat, lng: fix.lng, heading: 180,
			room,
			anchor: { heightM: 0, yawDeg: 180, source: 'marker' },
			vps: { provider: 'qr', id: token },
		});
		if (result.ok) _markerPinsPresent = true;
		return result;
	},
	loadMarkerRoom: async (roomId) => {
		try {
			const r = await fetch(`/api/irl/pins?room=${encodeURIComponent(roomId)}`, { headers: deviceHeaders() });
			if (!r.ok) return { count: 0 };
			const { pins } = await r.json();
			let count = 0;
			for (const p of (pins || [])) {
				if (nearbyPins.some(n => n.id === p.id)) continue; // already spawned (e.g. our own placement)
				const entry = { ...p, group: null, labelEl: null, glbLoaded: false, _oobPolls: 0 };
				nearbyPins.push(entry);
				spawnNearbyPin(entry);
				count++;
			}
			if (count) _markerPinsPresent = true;
			return { count };
		} catch { return { count: 0 }; }
	},
	status: (m, o) => setStatus(m, o),
});

// ── Dev-only perf harness (E2) ──────────────────────────────────────────────
// Gated behind import.meta.env.DEV → tree-shaken out of production builds, so no
// synthetic pins ever ship. Lets us verify the LOD/culling/queue budget under a
// dense crowd: `__irlSeedPins(30)` lays 30 default-avatar pins in a grid around
// the avatar; `__irlPerf()` reports the live tier, band counts and draw calls.
if (import.meta.env.DEV) {
	window.__irlSeedPins = (n = 30, spacing = 6) => {
		const cols = Math.ceil(Math.sqrt(n));
		for (let i = 0; i < n; i++) {
			const id = `dev-seed-${i}`;
			if (nearbyPins.find(p => p.id === id)) continue;
			const entry = {
				id, lat: 0, lng: 0,
				avatar_url: AVATAR_URL_DEFAULT,
				avatar_name: `Seed ${i + 1}`,
				caption: '', x402_endpoint: null,
				distance_m: 0, group: null, labelEl: null, glbLoaded: false,
			};
			nearbyPins.push(entry);
			spawnNearbyPin(entry);
			// Lay them in a grid around the avatar, overriding the GPS-derived spawn
			// position so they don't stack at the origin when there's no live fix.
			const gx = (i % cols) - cols / 2;
			const gz = Math.floor(i / cols) - cols / 2;
			entry.group.position.set(
				avatarRig.position.x + gx * spacing,
				entry.group.position.y,
				avatarRig.position.z + gz * spacing,
			);
		}
		updateNearbyBadge();
		log.info(`[irl] seeded ${n} synthetic pins for LOD stress test`);
		return n;
	};
	// Dispose every synthetic pin and return the count cleared. Pair with
	// __irlSeedPins to run seed→clear churn and confirm renderer.info.memory returns
	// to baseline (the task-06 leak check) rather than climbing each cycle.
	window.__irlClearSeed = () => {
		const seeded = nearbyPins.filter(p => String(p.id).startsWith('dev-seed-'));
		for (const p of seeded) disposePin(p);
		nearbyPins = nearbyPins.filter(p => !String(p.id).startsWith('dev-seed-'));
		updateNearbyBadge();
		log.info(`[irl] cleared ${seeded.length} synthetic pins`);
		return seeded.length;
	};
	window.__irlPerf = () => ({
		tier: activeTier,
		baseTier,
		pins: nearbyPins.length,
		full:     nearbyPins.filter(p => p._lod === 'full').length,
		impostor: nearbyPins.filter(p => p._lod === 'impostor').length,
		dot:      nearbyPins.filter(p => p._lod === 'dot').length,
		hidden:   nearbyPins.filter(p => p._lod === 'hidden').length,
		drawsEstimate: _drawEstimate,
		drawCalls: renderer.info.render.calls,
		// GPU resource counts — the leak signal. Across repeated avatar swaps and
		// seed/clear cycles these must return to baseline, not grow monotonically.
		memory: { geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures },
		queue: { active: glbQueue.active, pending: glbQueue.pending },
		reservedContexts: window.__agent3dReservedContexts,
	});

	// Lay out the canonical room scenario as ONE shared room so the room-frame
	// render path can be verified without a phone: the viewer stands on the origin
	// facing north (a "cup" dead ahead), an agent on the couch 3 m to the RIGHT
	// (+X), three agents BEHIND (+Z, distinct), and nothing to the left. Each pin
	// resolves through pinWorldPos → the shared origin, so __irlRoomCheck() can
	// confirm the world positions land on the right sides.
	window.__irlSeedRoom = () => {
		const origin = { lat: 37.7749, lng: -122.4194 };
		gpsState.lat = origin.lat; gpsState.lng = origin.lng; gpsState.ready = true;
		const layout = [
			{ tag: 'couch-right', relEast: 3,    relNorth: 0,    heading: 270 },
			{ tag: 'behind-1',    relEast: -0.5, relNorth: -2.5, heading: 0   },
			{ tag: 'behind-2',    relEast: 0.5,  relNorth: -3,   heading: 0   },
			{ tag: 'behind-3',    relEast: 1.5,  relNorth: -3.5, heading: 0   },
		];
		const seeded = layout.map((l, i) => {
			const id = `dev-room-${i}`;
			if (nearbyPins.find(p => p.id === id)) return null;
			const entry = {
				id, lat: origin.lat, lng: origin.lng,
				heading: l.heading, anchor_yaw_deg: l.heading,
				avatar_url: AVATAR_URL_DEFAULT, avatar_name: l.tag,
				caption: '', x402_endpoint: null,
				room_id: 'dev-room', rel_east_m: l.relEast, rel_north_m: l.relNorth,
				origin_lat: origin.lat, origin_lng: origin.lng, origin_yaw_deg: 0,
				distance_m: 0, group: null, labelEl: null, glbLoaded: false,
			};
			nearbyPins.push(entry);
			spawnNearbyPin(entry);
			return entry;
		}).filter(Boolean);
		updateNearbyBadge();
		log.info(`[irl] seeded ${seeded.length} room pins (couch-right, three behind)`);
		return seeded.length;
	};
	// Assert the seeded room renders on the right sides (no phone needed).
	window.__irlRoomCheck = () => nearbyPins
		.filter(p => p.room_id === 'dev-room' && p.group)
		.map(p => ({
			tag: p.avatar_name,
			x: +p.group.position.x.toFixed(2),
			z: +p.group.position.z.toFixed(2),
			side: p.group.position.x > 0.5 ? 'right' : p.group.position.x < -0.5 ? 'left' : 'center',
			depth: p.group.position.z > 0.5 ? 'behind' : p.group.position.z < -0.5 ? 'ahead' : 'level',
		}));

	// ── Simulated location (L1) ─────────────────────────────────────────────
	// Run the REAL place/discover flow at any chosen coordinate without touching
	// the device GPS. This is the only safe way to test on a phone (iOS Safari
	// can't spoof location) and the only way to test a LAN dev build at all
	// (geolocation is blocked on non-secure origins). Boot with
	// `?mockLoc=lat,lng[&mockAcc=8]`, or call `__irlMockLocation(lat,lng)` /
	// `__irlMockLocation(null)` from the console. A persistent badge makes a fake
	// fix impossible to mistake for a real one.
	let _mockBadge = null;
	function showMockBadge(lat, lng) {
		if (!_mockBadge) {
			_mockBadge = document.createElement('div');
			_mockBadge.id = 'irl-mock-badge';
			_mockBadge.setAttribute('role', 'status');
			_mockBadge.style.cssText = [
				'position:fixed', 'top:8px', 'left:50%', 'transform:translateX(-50%)',
				'z-index:99999', 'pointer-events:none',
				'padding:5px 11px', 'border-radius:999px',
				'background:rgba(20,16,4,.92)', 'border:1px solid #f0b400', 'color:#ffd45e',
				'font:600 11px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace',
				'letter-spacing:.04em', 'box-shadow:0 2px 10px rgba(0,0,0,.5)', 'white-space:nowrap',
			].join(';');
			document.body.appendChild(_mockBadge);
		}
		_mockBadge.textContent = `📍 SIMULATED LOCATION · ${lat.toFixed(4)}, ${lng.toFixed(4)}`;
		_mockBadge.style.display = '';
	}
	function hideMockBadge() { if (_mockBadge) _mockBadge.style.display = 'none'; }

	// Seed a synthetic fix through the REAL onGPSPosition path (forcing the
	// first-fix seed branch so the mock lands exactly, with no low-pass blend),
	// after stopping any live watch so a real coordinate is never read.
	function applyMockFix(lat, lng, accuracy = 10) {
		if (gpsState.watchId != null) { navigator.geolocation.clearWatch(gpsState.watchId); gpsState.watchId = null; }
		_mockLocation = true;
		gpsState.ready = false; // force the exact-seed branch
		onGPSPosition({ coords: { latitude: lat, longitude: lng, accuracy, altitude: null } });
		showMockBadge(lat, lng);
	}

	window.__irlMockLocation = (lat, lng, acc = 10) => {
		if (lat == null) {
			_mockLocation = false;
			hideMockBadge();
			initGPS(); // resume the real watch
			log.info('[irl] simulated location cleared — resuming real GPS');
			return 'cleared';
		}
		if (!Number.isFinite(lat) || !Number.isFinite(lng) ||
			lat < -90 || lat > 90 || lng < -180 || lng > 180) {
			return 'usage: __irlMockLocation(lat, lng[, accuracyM]) — lat∈[-90,90], lng∈[-180,180]; null to clear';
		}
		applyMockFix(lat, lng, Number.isFinite(acc) ? acc : 10);
		log.info(`[irl] simulated location set → ${lat}, ${lng}`);
		return { mocked: { lat, lng, acc } };
	};

	// Boot-time URL param. Malformed input warns and falls through to real GPS.
	try {
		const params = new URLSearchParams(location.search);
		const mp = params.get('mockLoc');
		if (mp) {
			const [a, b] = mp.split(',').map((s) => parseFloat(s.trim()));
			const acc = parseFloat(params.get('mockAcc'));
			if (Number.isFinite(a) && Number.isFinite(b) && a >= -90 && a <= 90 && b >= -180 && b <= 180) {
				applyMockFix(a, b, Number.isFinite(acc) ? acc : 10);
				log.info(`[irl] ?mockLoc → simulated location ${a}, ${b}`);
			} else {
				log.warn(`[irl] ignoring malformed ?mockLoc="${mp}" — expected "lat,lng"`);
			}
		}
	} catch (e) {
		log.warn('[irl] mockLoc parse failed:', e?.message || e);
	}

	// ── Arrival-signal harness (task 04 → task 03 handoff) ────────────────────
	// Record every "newly stable in-range" emission so the hysteresis no-double-fire
	// guarantee is verifiable in a real browser: drive a GPS wobble around a pin at
	// the boundary (the Verify recipe) and confirm __irlStableArrivals() lists each
	// agent exactly once — never a flicker storm. Returns the recorded arrivals.
	const _stableArrivals = [];
	onPinStable((pin) => { _stableArrivals.push({ id: pin.id, name: pin.avatar_name, at: Date.now() }); });
	window.__irlStableArrivals = () => _stableArrivals.slice();
	window.__irlResetStableArrivals = () => { _stableArrivals.length = 0; return 'reset'; };

	// ── E2E discovery + privacy harness (task 07) ─────────────────────────────
	// Hermetic hooks that let the Playwright regression LOCK the location-privacy
	// invariant without a phone, a live socket, or a real database: the test routes
	// /api/irl/pins to serve chosen rows, drives the REAL proximity reconcile
	// (loadNearbyPins → the asymmetric ENTER/EXIT band), and reads back EXACTLY what
	// the client is holding. The reader is the assertion surface: if an out-of-range
	// coordinate ever survived the band into client state, it would show up here.
	//
	// setGps writes straight into gpsState and deliberately does NOT open the
	// presence socket (startPinSync), so the run stays fully offline — pins ride the
	// poll regardless, and skipping the socket keeps the console error-free.
	window.__irlE2E = {
		setGps(lat, lng, accuracy = 8) {
			gpsState.lat = lat;
			gpsState.lng = lng;
			gpsState.accuracy = accuracy;
			gpsState.altitude = null;
			gpsState.ready = true;
			_gpsAcquiring = false;
			updateNearbyBadge();
			return { lat: gpsState.lat, lng: gpsState.lng };
		},
		// Run exactly one proximity reconcile against whatever the test has routed for
		// /api/irl/pins, then resolve — deterministic, no 10 s poll-timer wait.
		poll: () => loadNearbyPins(),
		// The full set of pin coordinates the client currently holds — the privacy
		// assertion's window into client state. An out-of-range pin that the band
		// correctly refused to render never enters this list, so its coordinate is
		// provably absent from the client.
		nearby: () => nearbyPins.map((p) => ({
			id: p.id,
			lat: p.lat,
			lng: p.lng,
			distance: Math.round(bandDistance(p)),
			rendered: !!p.group,
		})),
		// Turn a metres-offset (north/east) into a coordinate so a test can plant a
		// served pin at an EXACT distance from the viewer and assert the ENTER/EXIT gate.
		offsetCoord(lat, lng, north = 0, east = 0) {
			const mLat = 110540;
			const mLng = 111320 * Math.cos(lat * (Math.PI / 180));
			return { lat: lat + north / mLat, lng: lng + east / mLng };
		},
	};
}
