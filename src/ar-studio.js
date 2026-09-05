// AR Studio (/ar/studio) — a live multi-model AR scene through your camera.
//
// The gap this closes: every AR surface before it was single-model and one-way.
// /ar generates a model THEN hands off to the native viewer (one model, exits
// the page); /irl walks ONE owned avatar; the WebXR session anchors exactly one
// group. The studio is the standalone surface where all three asks land:
//
//   · place ANY number of models/avatars into one live camera view,
//   · pull in ANY model — your forge creations, the community feed, a pasted
//     GLB URL, or a ?src= deep link,
//   · forge a brand-new model from a prompt WITHOUT leaving the camera — the
//     generation runs behind the live view and the result drops into the room.
//
// Rendering modes, best-first (same ladder as /irl, minus GPS/pins machinery):
//   · WebXR immersive-ar (Android Chrome): hit-test reticle, one XRAnchor per
//     placed model (src/ar/multi-place.js), dom-overlay HUD stays usable.
//   · getUserMedia passthrough (iOS Safari + everywhere else with a camera):
//     transparent WebGL over the live feed, gyro world-lock look, tap/drag/
//     pinch/twist gestures on the floor plane.
//   · plain 3D preview (no camera / desktop): grid floor, drag-look — the same
//     scene, still fully arrangeable, plus a QR handoff to a phone.
//
// Scene state (model sources + floor transforms) persists in localStorage and
// round-trips through ?src= links, so a desktop arrangement reopens on a phone.

import {
	AnimationMixer, Box3, CanvasTexture, Color, DirectionalLight, Fog, GridHelper, Group,
	HemisphereLight, Mesh, MeshBasicMaterial, PerspectiveCamera, PlaneGeometry,
	Raycaster, RingGeometry, Scene, Vector2, Vector3, WebGLRenderer,
} from 'three';
import { clone as cloneSkinnedScene } from 'three/addons/utils/SkeletonUtils.js';
import { applyCinematicDefaults, detectQualityTier, loadEnvironment } from './shared/cinematic-render.js';

import { EstimatedLighting } from './ar/estimated-lighting.js';
import {
	generateRoomCode, localToShared, normalizeRoomCode, roomKeyForCode,
	roomShareUrl, sharedToLocal,
} from './ar/studio-coords.js';
import { StudioNet } from './ar/studio-net.js';
import { MultiPlaceSession } from './ar/multi-place.js';
import { canUseQuickLook, openQuickLook } from './ar/quick-look.js';
import { canUseSceneViewer, openSceneViewer } from './ar/scene-viewer.js';
import { glbBlobToUsdzBlob } from './usdz-pipeline.js';
import { forgeStageNarration } from './shared/forge-frames.js';
import { cardTitleFromPrompt } from './model-lib.js';
import {
	createPinchState, pinchEnd, pinchMove, pinchStart, touchDist,
	PINCH_SCALE_MAX, PINCH_SCALE_MIN,
} from './ar/pinch-scale.js';
import {
	deserializeScene, fitTransform, MAX_PLACEMENTS, normalizeGlbUrl,
	parseSrcParams, roomLightFromPixels, sceneFromHashParam, serializeScene,
	SPAWN_DISTANCE_M, spawnPointInFront, studioSceneUrl, studioShareUrl,
	touchAngle, twistDelta,
} from './ar/studio-scene.js';
import { renderQRToSVG } from './erc8004/qr.js';
import { deriveVerticalFovDeg, DEFAULT_DIAG_FOV_DEG } from './irl/camera-fov.js';
import { createLoadQueue, loadGLTF } from './irl/load-queue.js';
import { mountPinIdle } from './irl/pin-idle.js';
import { clampPitch, isFiniteReading, resolveLockYaw, screenPitchDeg } from './irl/sensor-fusion.js';
import { captureComposite, shareOrDownload } from './irl/share-frame.js';
import { createLogger } from './shared/log.js';

const log = createLogger('ar-studio');

const $ = (id) => document.getElementById(id);
const esc = (s) =>
	String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const SCENE_KEY = 'twx_ar_studio_scene_v1';
// Shared with /ar (AR Forge) on purpose: a model forged on either page shows up
// in the other's recents — one history, two doors.
const RECENT_KEY = 'twx_ar_forge_recent';
const POLL_MS = 3000;
const MAX_POLL_MS = 300000;
const EYE_HEIGHT_M = 1.55;
const PITCH_MIN = -1.25;
const PITCH_MAX = 1.35;

// Same anonymous forge identity as /forge and /creations — scopes the "Yours"
// tray tab and attributes in-studio generations to this browser's gallery.
const CLIENT_ID = (() => {
	const KEY = 'forge:cid';
	try {
		let id = localStorage.getItem(KEY);
		if (!id) {
			id = crypto?.randomUUID?.() || `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
			localStorage.setItem(KEY, id);
		}
		return id;
	} catch {
		return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
	}
})();

// ── DOM ───────────────────────────────────────────────────────────────────────
const videoEl = $('ars-video');
const canvas = $('ars-canvas');
const hud = $('ars-hud');
const statusEl = $('ars-status');
const countEl = $('ars-count');
const cameraBtn = $('ars-camera-btn');
const xrBtn = $('ars-xr-btn');
const addBtn = $('ars-add-btn');
const clearBtn = $('ars-clear-btn');
const photoBtn = $('ars-photo-btn');
const qrBtn = $('ars-qr-btn');
const forgeForm = $('ars-forge-form');
const forgeInput = $('ars-forge-input');
const forgeGo = $('ars-forge-go');
const forgeChip = $('ars-forge-chip');
const selbar = $('ars-selbar');
const selName = $('ars-sel-name');
const tray = $('ars-tray');
const trayBody = $('ars-tray-body');
const trayClose = $('ars-tray-close');
const emptyEl = $('ars-empty');
const qrModal = $('ars-qr-modal');
const roomBtn = $('ars-room-btn');
const roomModal = $('ars-room-modal');

if (!canvas || !hud) {
	throw new Error('AR Studio: page skeleton missing');
}

// ── Renderer / scene ─────────────────────────────────────────────────────────
const renderer = new WebGLRenderer({
	canvas, alpha: true, antialias: true, preserveDrawingBuffer: true,
});
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x000000, 0);
// Filmic tone mapping + correct sRGB output + soft shadows: the shared bar
// every viewer on the platform now matches (src/shared/cinematic-render.js).
const qualityTier = detectQualityTier();
applyCinematicDefaults(renderer, { tier: qualityTier });

const scene = new Scene();
const camera = new PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.02, 200);
camera.position.set(0, EYE_HEIGHT_M, 0);

// Real HDRI IBL (studio preset) so forge materials (metal, glass, emissive)
// read correctly against a real room; falls back to the procedural
// RoomEnvironment on fetch failure or mobile tier.
loadEnvironment(renderer, scene, qualityTier === 'mobile' ? null : 'studio').catch((err) => {
	log.warn('environment map failed', err);
});

const HEMI_BASE = 1.0;
const SUN_BASE = 1.15;
const hemi = new HemisphereLight(0xffffff, 0x444455, HEMI_BASE);
scene.add(hemi);
const sun = new DirectionalLight(0xffffff, SUN_BASE);
sun.position.set(2.5, 6, 3);
scene.add(sun);

// Preview-mode floor: a calm grid that hides the moment the camera feed becomes
// the ground truth. The ray plane is the invisible tap/drag target either way.
const grid = new GridHelper(24, 48, 0x3a3f52, 0x23273a);
grid.position.y = 0.001;
grid.material.transparent = true;
grid.material.opacity = 0.75;
// Distance fog fades the far lines out instead of letting a flat grid viewed at
// a shallow angle collapse into a moire band across the horizon. It starts well
// beyond any placement, so it never touches a model, and it is removed the
// moment the real room becomes the backdrop.
const previewFog = new Fog(0x06070a, 5, 17);
scene.fog = previewFog;
scene.add(grid);
const rayPlane = new Mesh(
	new PlaneGeometry(80, 80),
	new MeshBasicMaterial({ visible: false, side: 2 }),
);
rayPlane.rotation.x = -Math.PI / 2;
scene.add(rayPlane);

// Selection ring — one reusable marker parked under the selected model.
const selRing = new Mesh(
	new RingGeometry(0.3, 0.34, 48).rotateX(-Math.PI / 2),
	new MeshBasicMaterial({ color: 0x8b7cf8, transparent: true, opacity: 0.85, depthTest: false }),
);
selRing.renderOrder = 998;
selRing.visible = false;
scene.add(selRing);

// Shared radial-gradient contact-shadow texture for fallback-mode placements.
const shadowTex = (() => {
	try {
		const size = 128;
		const cnv = document.createElement('canvas');
		cnv.width = cnv.height = size;
		const ctx = cnv.getContext('2d');
		const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
		g.addColorStop(0, 'rgba(0,0,0,0.40)');
		g.addColorStop(0.55, 'rgba(0,0,0,0.18)');
		g.addColorStop(1, 'rgba(0,0,0,0)');
		ctx.fillStyle = g;
		ctx.fillRect(0, 0, size, size);
		return new CanvasTexture(cnv);
	} catch {
		return null;
	}
})();

const reducedMotion = (() => {
	try {
		return !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
	} catch {
		return false;
	}
})();

// ── Camera look (yaw/pitch; gyro on mobile, drag anywhere) ───────────────────
let cameraYaw = 0;
let cameraPitch = -0.24;
// Once the viewer aims the camera themselves (drag-look, gyro, passthrough),
// their aim is the truth and the studio stops reframing for them.
let userLooked = false;

// Desktop and phone preview have no room to look at, so a model dropped on the
// floor lands below the eyeline and reads as "nothing happened". Aim the view at
// what is actually in the scene.
function framePreview() {
	if (arActive || xrSession || userLooked || !placements.length) return;
	let sx = 0;
	let sz = 0;
	let sh = 0;
	for (const p of placements) {
		sx += p.group.position.x;
		sz += p.group.position.z;
		sh += (p.height || 0.4) * (p.group.userData._targetScale ?? 1);
	}
	const n = placements.length;
	const cx = sx / n;
	const cz = sz / n;
	const centre = (sh / n) * 0.5;
	const dist = Math.hypot(cx - camera.position.x, cz - camera.position.z);
	if (!(dist > 0.05)) return;
	cameraYaw = Math.atan2(cx - camera.position.x, -(cz - camera.position.z));
	cameraPitch = clampPitch(-Math.atan2(camera.position.y - centre, dist), PITCH_MIN, PITCH_MAX);
}

function applyCameraLook() {
	camera.rotation.set(0, 0, 0);
	camera.rotateY(cameraYaw);
	camera.rotateX(cameraPitch);
}
applyCameraLook();

// ── State ─────────────────────────────────────────────────────────────────────
/**
 * @typedef {object} Placement
 * @property {string} id
 * @property {string} src
 * @property {string} title
 * @property {Group}  group     Outer group at the floor point (y=0).
 * @property {Mesh|null} shadow
 * @property {AnimationMixer|null} mixer
 * @property {number} yaw
 * @property {number} baseRadius  Footprint radius for the selection ring.
 * @property {number} spawnT      Spawn scale-in progress 0→1.
 */
/** @type {Placement[]} */
const placements = [];
/** @type {Placement|null} */
let selected = null;
let arActive = false;
let mediaStream = null;
let arTransitioning = false;
let xrSession = null;
let estimatedLight = null;
let arTrackW = 0;
let arTrackH = 0;
let statusTimer = null;
let undoItems = null;

// ── Shared-room networking (purely additive; null = single-player) ────────────
/** @type {import('./ar/studio-net.js').StudioNet|null} */
let net = null;
let roomCode = '';
/** netId → placement, for reconciling remote models against local ones. */
const netModelsById = new Map();
let roomPresence = { count: 1, names: [] };

// A placement I control: single-player models (no ownerId) and my own room
// models. Others' room models are visible + live but not editable by me (the
// server owner-gates edits too — this is the local UX guard).
function isMine(p) {
	return !p.ownerId || p.ownerId === CLIENT_ID;
}

// True once a freshly-joined room's initial model burst has settled, so per-model
// "someone added…" cues fire only for genuinely new activity, not the join sync.
let roomSyncSettled = false;

// A soft two-note chime for room arrivals — a small "someone's here" cue that
// makes collaboration feel alive. WebAudio only, unlocked inside the create/join
// user gesture; silent (never throws) where audio is blocked or reduced-motion.
let _audioCtx = null;
function unlockAudio() {
	try {
		if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
		if (_audioCtx.state === 'suspended') _audioCtx.resume();
	} catch { _audioCtx = null; }
}
function chime() {
	if (reducedMotion || !_audioCtx) return;
	try {
		const now = _audioCtx.currentTime;
		for (const [i, freq] of [587.33, 880].entries()) { // D5 → A5
			const osc = _audioCtx.createOscillator();
			const gain = _audioCtx.createGain();
			osc.type = 'sine';
			osc.frequency.value = freq;
			const t = now + i * 0.11;
			gain.gain.setValueAtTime(0, t);
			gain.gain.linearRampToValueAtTime(0.08, t + 0.02);
			gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
			osc.connect(gain).connect(_audioCtx.destination);
			osc.start(t);
			osc.stop(t + 0.3);
		}
	} catch { /* audio is a bonus, never a failure path */ }
}

// Template cache: one load per GLB source no matter how many copies are placed.
/** @type {Map<string, Promise<{ gltf: any, skinned: boolean, fit: { scale: number, yOffset: number }, radius: number }>>} */
const templates = new Map();
// Resolved templates, synchronously readable — an XR `select` handler can't
// await, so it places only sources that have already finished loading.
const tplReady = new Map();
const loadQueue = createLoadQueue({
	run: (src) => loadGLTF(src),
	maxActive: 3,
});

// ── Status line ───────────────────────────────────────────────────────────────
function setStatus(msg, { warn = false, sticky = false, actionLabel = '', onAction = null } = {}) {
	if (!statusEl) return;
	clearTimeout(statusTimer);
	statusEl.innerHTML = '';
	if (!msg) {
		statusEl.hidden = true;
		return;
	}
	statusEl.hidden = false;
	statusEl.classList.toggle('is-warn', warn);
	const span = document.createElement('span');
	span.textContent = msg;
	statusEl.appendChild(span);
	if (actionLabel && onAction) {
		const btn = document.createElement('button');
		btn.type = 'button';
		btn.className = 'ars-status-action';
		btn.textContent = actionLabel;
		btn.addEventListener('click', () => {
			setStatus(null);
			onAction();
		});
		statusEl.appendChild(btn);
	}
	if (!sticky) statusTimer = setTimeout(() => { statusEl.hidden = true; }, 5000);
}

function updateCount() {
	if (!countEl) return;
	const n = placements.length;
	updatePresencePill(); // owns the count-pill text (folds in room presence)
	if (clearBtn) clearBtn.hidden = n === 0;
	if (emptyEl) emptyEl.hidden = n > 0;
	if (photoBtn) photoBtn.disabled = n === 0;
}

// A placement's LOGICAL scale — the size the user chose, independent of the
// spawn-in animation. While a model is easing in (spawnT < 1) group.scale.x is
// a fraction of the target; reading it then would persist ~0 and clamp the
// model to SCALE_MIN on the next load. Post-spawn, group.scale.x IS the truth
// (pinch writes it directly), so it wins.
function logicalScale(p) {
	if (p.spawnT < 1) return p.group.userData._targetScale ?? 1;
	return p.group.scale.x;
}

// ── Scene persistence ─────────────────────────────────────────────────────────
// Only MY models persist to localStorage — never another participant's room
// models, which would otherwise reappear as mine on a later solo visit.
function saveScene() {
	try {
		localStorage.setItem(SCENE_KEY, serializeScene(placements.filter(isMine).map((p) => ({
			src: p.src,
			title: p.title,
			x: p.group.position.x,
			z: p.group.position.z,
			yaw: p.yaw,
			scale: logicalScale(p),
		}))));
	} catch {}
}

// ── Selection ─────────────────────────────────────────────────────────────────
function select(p) {
	selected = p;
	if (!selbar) return;
	if (!p) {
		selbar.hidden = true;
		selRing.visible = false;
		return;
	}
	selbar.hidden = false;
	if (selName) selName.textContent = p.title || 'Model';
	selRing.visible = true;
	positionSelRing();
}

function positionSelRing() {
	if (!selected) return;
	const p = selected;
	selRing.position.set(p.group.position.x, p.group.position.y + 0.006, p.group.position.z);
	const r = Math.max(0.24, p.baseRadius * p.group.scale.x * 1.15);
	selRing.scale.setScalar(r / 0.34);
}

// ── Model loading + placement ─────────────────────────────────────────────────
function loadTemplate(src) {
	let t = templates.get(src);
	if (!t) {
		t = loadQueue.request(src).then((gltf) => {
			let skinned = false;
			gltf.scene.traverse((o) => { if (o.isSkinnedMesh) skinned = true; });
			const box = new Box3().setFromObject(gltf.scene);
			const fit = fitTransform(
				{ min: { x: box.min.x, y: box.min.y, z: box.min.z }, max: { x: box.max.x, y: box.max.y, z: box.max.z } },
				{ skinned },
			);
			const radius = Math.max(
				(box.max.x - box.min.x) * fit.scale,
				(box.max.z - box.min.z) * fit.scale,
			) / 2;
			const height = (box.max.y - box.min.y) * fit.scale;
			return {
				gltf, skinned, fit,
				radius: Number.isFinite(radius) ? radius : 0.3,
				height: Number.isFinite(height) ? height : 0.75,
			};
		});
		templates.set(src, t);
		t.then((tpl) => tplReady.set(src, tpl))
			.catch(() => templates.delete(src)); // a failed load is retryable
	}
	return t;
}

// Instantiate a template into a floor-ready group. Cloned per placement so ten
// copies of one crate are ten independent models; SkeletonUtils handles skinned
// avatars (plain .clone() breaks bone bindings).
function instantiate(tpl, src) {
	const inner = cloneSkinnedScene(tpl.gltf.scene);
	inner.scale.setScalar(tpl.fit.scale);
	inner.position.y = tpl.fit.yOffset;
	const group = new Group();
	group.add(inner);
	let mixer = null;
	if (tpl.gltf.animations?.length) {
		mixer = new AnimationMixer(inner);
		mixer.clipAction(tpl.gltf.animations[0]).play();
	}
	// A humanoid with no baked clips gets the universal idle retargeted onto its
	// rig (same pipeline as /irl pins) — never a bind-pose T-pose statue. Async
	// and best-effort: props and undriveable rigs resolve null and stay static.
	let idlePromise = null;
	if (!mixer && tpl.skinned) {
		idlePromise = mountPinIdle(inner, { avatarUrl: src }).catch(() => null);
	}
	return { group, mixer, idlePromise };
}

function makeShadow(radius) {
	if (!shadowTex) return null;
	const d = Math.max(0.4, radius * 2.4);
	const mesh = new Mesh(
		new PlaneGeometry(d, d).rotateX(-Math.PI / 2),
		new MeshBasicMaterial({ map: shadowTex, transparent: true, opacity: 0.85, depthWrite: false }),
	);
	mesh.renderOrder = 1;
	return mesh;
}

// Spread same-spot spawns into a small ring so "add, add, add" reads as a
// lineup instead of a z-fighting pile.
function nudgeSpawn(pt) {
	let { x, z } = pt;
	for (let attempt = 0; attempt < 8; attempt++) {
		const clash = placements.some((p) =>
			Math.hypot(p.group.position.x - x, p.group.position.z - z) < 0.45);
		if (!clash) break;
		const a = attempt * 2.399963; // golden angle
		x = pt.x + Math.cos(a) * 0.55 * (1 + attempt * 0.18);
		z = pt.z + Math.sin(a) * 0.55 * (1 + attempt * 0.18);
	}
	return { x, z };
}

/**
 * Add a model to the scene. Loads (or reuses) the template, drops it on the
 * floor in front of the camera (or at the given transform on restore), selects
 * it, and persists. Resolves with the placement or null on failure.
 */
async function addModel({ src, title = '' }, {
	x = null, z = null, yaw = null, scale = null, announce = true, persist = true,
	remote = false, netId = null, ownerId = null,
} = {}) {
	const url = normalizeGlbUrl(src);
	if (!url) {
		setStatus('That link is not a loadable https GLB.', { warn: true });
		return null;
	}
	if (placements.length >= MAX_PLACEMENTS) {
		setStatus(`Scene is full (${MAX_PLACEMENTS} models). Remove one to add more.`, { warn: true });
		return null;
	}
	if (announce) setStatus(`Loading ${title || 'model'}…`, { sticky: true });
	let tpl;
	try {
		tpl = await loadTemplate(url);
	} catch (err) {
		log.warn('model load failed', url, err);
		setStatus(`Couldn't load ${title || 'that model'} — the file may be gone.`, {
			warn: true, actionLabel: 'Retry', onAction: () => addModel({ src: url, title }),
		});
		return null;
	}

	const { group, mixer, idlePromise } = instantiate(tpl, url);
	let px = x, pz = z;
	if (px === null || pz === null) {
		// Tall models (avatars, statues) land further back so they don't fill
		// the frame the moment they appear.
		const dist = Math.max(SPAWN_DISTANCE_M, (tpl.height || 0) * 1.15);
		const fwd = camera.getWorldDirection(new Vector3());
		const spot = nudgeSpawn(spawnPointInFront(camera.position, fwd, dist));
		px = spot.x;
		pz = spot.z;
	}
	group.position.set(px, 0, pz);
	const yawV = yaw ?? Math.atan2(camera.position.x - px, camera.position.z - pz);
	group.rotation.y = yawV;
	if (scale) group.scale.setScalar(Math.min(PINCH_SCALE_MAX, Math.max(PINCH_SCALE_MIN, scale)));
	scene.add(group);

	const shadow = makeShadow(tpl.radius);
	if (shadow) {
		shadow.position.set(px, 0.004, pz);
		shadow.scale.setScalar(group.scale.x);
		shadow.visible = !xrSession; // XR session draws its own anchored shadows
		scene.add(shadow);
	}

	const placement = {
		id: `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
		src: url,
		title: String(title || '').slice(0, 120),
		group,
		shadow,
		mixer,
		idle: null,
		yaw: yawV,
		baseRadius: tpl.radius,
		spawnT: reducedMotion ? 1 : 0,
		height: tpl.height || 0,
		// Room fields: netId is the shared-scene id (null until broadcast); ownerId
		// null = single-player / mine. Set for remote models so isMine() gates edits.
		netId: netId || null,
		ownerId: remote ? ownerId : null,
		remote,
		_lastNetSend: 0,
	};
	idlePromise?.then((mgr) => {
		if (!mgr) return;
		// Removed before the idle clip arrived → release the manager, not leak it.
		if (placements.includes(placement)) placement.idle = mgr;
		else mgr.detach();
	});
	group.userData._targetScale = group.scale.x;
	if (!reducedMotion) group.scale.setScalar(0.001);
	placements.push(placement);
	if (placement.netId) netModelsById.set(placement.netId, placement);
	if (!remote) armedSrc = { src: url, title: placement.title };
	updateCount();
	if (!remote) select(placement);
	if (!remote) framePreview();
	if (persist) saveScene();

	// Broadcast a locally-added model to the shared room (once): mint a wire id,
	// tag the placement with it, and send its shared-frame transform. Remote adds
	// (reconciled from the room) never re-broadcast.
	if (!remote && net && net.status === 'online') {
		const wireId = `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.slice(0, 40);
		placement.netId = wireId;
		placement.ownerId = CLIENT_ID;
		netModelsById.set(wireId, placement);
		net.spawn(placementWire(placement, wireId));
	}

	if (announce) {
		setStatus(remote
			? `${title || 'A model'} was added by someone in the room.`
			: 'Placed. Drag to move, pinch to resize, twist to rotate.');
	}
	return placement;
}

// A placement's transform in the shared logical frame (for the wire).
function placementShared(p) {
	return localToShared({
		x: p.group.position.x,
		z: p.group.position.z,
		yaw: p.yaw,
		scale: logicalScale(p),
		height: p.height || 0,
	});
}

// The full spawn payload for the wire: source + title + shared-frame transform.
function placementWire(p, wireId) {
	return { id: wireId, src: p.src, title: p.title, ...placementShared(p) };
}

// Broadcast a transform change for one of MY room models, throttled to ~12 Hz so
// a drag doesn't flood the socket. No-op single-player or for others' models.
function netBroadcastTransform(p) {
	if (!net || net.status !== 'online' || !p.netId || !isMine(p)) return;
	const now = Date.now();
	if (now - (p._lastNetSend || 0) < 80) return;
	p._lastNetSend = now;
	const s = placementShared(p);
	net.update(p.netId, { relEast: s.relEast, relNorth: s.relNorth, yawDeg: s.yawDeg, scale: s.scale });
}

// Apply a shared-frame transform from the room to a placement's local group.
function applySharedTransform(p, m) {
	const l = sharedToLocal(m);
	p.group.position.set(l.x, 0, l.z);
	p.yaw = l.yaw;
	p.group.rotation.y = l.yaw;
	p.group.scale.setScalar(l.scale);
	p.group.userData._targetScale = l.scale;
	p.spawnT = 1; // an update is not a spawn — no scale-in pop
	if (p.shadow) {
		p.shadow.position.set(l.x, 0.004, l.z);
		p.shadow.scale.setScalar(l.scale);
	}
	if (selected === p) positionSelRing();
}

// Reconcile the full shared model list against local placements: add models that
// appeared (others' or my own from a prior session), drop REMOTE ones that left,
// and refresh others' transforms. My own live models are authored locally — never
// overwritten by their own echo.
function reconcileRemoteModels(models) {
	const serverIds = new Set(models.map((m) => m.id));
	// Remove remote placements that vanished from the room (owner deleted / reaped).
	for (const p of [...placements]) {
		if (p.remote && p.netId && !serverIds.has(p.netId)) {
			removePlacement(p, { persist: false, broadcast: false });
		}
	}
	let freshFromOthers = 0;
	for (const m of models) {
		const existing = netModelsById.get(m.id);
		if (existing) {
			if (!isMine(existing)) applySharedTransform(existing, m);
			continue;
		}
		// New to me: reconcile it in. Mark mine when the server says I own it (a
		// rejoin) so I keep control; otherwise it's someone else's, view-only.
		const local = sharedToLocal(m);
		const mine = !!m.mine || m.ownerId === CLIENT_ID;
		if (!mine) freshFromOthers++;
		addModel({ src: m.src, title: m.title }, {
			x: local.x, z: local.z, yaw: local.yaw, scale: local.scale,
			remote: true, netId: m.id, ownerId: mine ? CLIENT_ID : m.ownerId,
			announce: false, persist: false,
		});
	}
	updateCount();
	// After the join burst settles, a new model from someone else is live activity
	// worth surfacing — but never during the initial sync (that would spam N toasts).
	if (roomSyncSettled && freshFromOthers > 0) {
		setStatus(freshFromOthers === 1 ? 'Someone added a model to the room.' : `${freshFromOthers} models were added to the room.`);
	}
	roomSyncSettled = true;
}

// A single model changed (per-field delta) or was removed. Refresh others' live;
// ignore echoes of my own.
function applyRemoteModelChange(m) {
	const p = netModelsById.get(m.id);
	if (!p) return;
	if (m.removed) {
		if (p.remote) removePlacement(p, { persist: false, broadcast: false });
		return;
	}
	if (!isMine(p)) applySharedTransform(p, m);
}

// ── Room lifecycle ────────────────────────────────────────────────────────────
function updatePresencePill() {
	if (!countEl) return;
	// The count pill doubles as the presence indicator when in a room.
	const n = placements.length;
	if (net && net.status === 'online' && roomPresence.count > 1) {
		countEl.textContent = `${roomPresence.count} here · ${n} ${n === 1 ? 'model' : 'models'}`;
		countEl.hidden = false;
	} else {
		countEl.textContent = n === 1 ? '1 model' : `${n} models`;
		countEl.hidden = n === 0;
	}
}

function wireNet(n) {
	n.on('status', ({ status }) => {
		if (status === 'online') {
			setStatus(`Shared room ${roomCode} is live — edits sync to everyone here.`);
			document.body.classList.add('is-room');
		} else if (status === 'connecting') {
			setStatus(`Joining room ${roomCode}…`, { sticky: true });
		} else if (status === 'unavailable' || status === 'failed') {
			setStatus('Shared rooms are offline right now — you can still build solo.', { warn: true });
			leaveRoom({ silent: true });
		} else if (status === 'offline') {
			setStatus('Reconnecting to the room…', { sticky: true });
		}
		updateRoomButton();
	});
	n.on('models', (models) => reconcileRemoteModels(models));
	n.on('model', (m) => applyRemoteModelChange(m));
	n.on('presence', (p) => {
		const prev = roomPresence.count;
		roomPresence = p;
		updatePresencePill();
		if (roomModal && !roomModal.hidden) renderRoomModal();
		// Ambient life: announce a real arrival/departure (not the initial join, and
		// not our own presence appearing). Makes a shared room feel inhabited.
		if (prev > 0 && p.count > prev) {
			setStatus(p.count === 2 ? 'Someone joined — you’re building together now.' : 'Someone else joined the room.');
			chime();
		} else if (prev > 1 && p.count < prev && p.count >= 1) {
			setStatus(p.count === 1 ? 'You’re on your own in the room now.' : 'Someone left the room.');
		}
	});
	n.on('reject', (msg) => {
		const why = msg?.reason === 'room_full' ? 'the room is full'
			: msg?.reason === 'owner_full' ? 'you have the max models in this room'
			: 'the room declined it';
		setStatus(`Couldn't share that model — ${why}.`, { warn: true });
	});
}

// Push every model I ALREADY have into a freshly joined room, so a solo scene
// becomes the shared starting point instead of vanishing.
function seedRoomWithLocalScene() {
	if (!net || net.status !== 'online') return;
	for (const p of placements) {
		if (p.netId) continue; // already shared
		const wireId = `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.slice(0, 40);
		p.netId = wireId;
		p.ownerId = CLIENT_ID;
		p.remote = false;
		netModelsById.set(wireId, p);
		net.spawn(placementWire(p, wireId));
	}
}

let _roomHeartbeat = null;

// seed=true pushes my current scene into the room as its starting point — right
// for CREATE (I'm the first one there). JOIN never seeds: entering a room means
// entering ITS shared scene, so my solo models stay local (private) and can't
// duplicate the server's authoritative copies on a refresh-rejoin.
async function joinRoom(code, { seed = false } = {}) {
	const norm = normalizeRoomCode(code);
	if (!norm) {
		setStatus('That room code looks off — check the 6 characters and try again.', { warn: true });
		return;
	}
	leaveRoom({ silent: true });
	roomSyncSettled = false; // the join's model burst must not fire "added" cues
	roomCode = norm;
	net = new StudioNet({
		roomKey: roomKeyForCode(norm),
		clientId: CLIENT_ID,
		name: '',
	});
	wireNet(net);
	const joining = net;
	await joining.connect();
	// A failed connect fires status 'failed' synchronously, and the handler above
	// calls leaveRoom() which nulls `net`, so read through the local handle and
	// re-check identity rather than dereferencing a module field that may be gone.
	if (net === joining && joining.status === 'online') {
		if (seed) seedRoomWithLocalScene();
		_roomHeartbeat = setInterval(() => net?.heartbeat(), 15000);
		try {
			const url = new URL(location.href);
			url.searchParams.set('room', norm);
			history.replaceState(null, '', url);
		} catch {}
	}
	updateRoomButton();
}

function createRoom() {
	// Creating a room shares my current scene as its starting point. Returning the
	// promise is load-bearing: the caller awaits it before rendering the live panel
	// and copying the invite link, and dropping it here made both run against a
	// still-connecting room.
	return joinRoom(generateRoomCode(), { seed: true });
}

function leaveRoom({ silent = false } = {}) {
	if (_roomHeartbeat) { clearInterval(_roomHeartbeat); _roomHeartbeat = null; }
	if (net) {
		try { net.destroy(); } catch {}
		net = null;
	}
	// Remote models leave with the room; my own stay as a local scene.
	for (const p of [...placements]) {
		if (p.remote && !isMine(p)) removePlacement(p, { persist: false, broadcast: false });
		else { p.netId = null; p.remote = false; }
	}
	netModelsById.clear();
	roomCode = '';
	roomPresence = { count: 1, names: [] };
	document.body.classList.remove('is-room');
	try {
		const url = new URL(location.href);
		url.searchParams.delete('room');
		history.replaceState(null, '', url);
	} catch {}
	updatePresencePill();
	updateRoomButton();
	if (!silent) setStatus('Left the shared room. Your models are still here.');
}

// ── Room modal UI ─────────────────────────────────────────────────────────────
function updateRoomButton() {
	if (!roomBtn) return;
	const live = !!net && (net.status === 'online' || net.status === 'connecting');
	roomBtn.classList.toggle('is-active', live);
	// Two labels rather than one rewritten string. The idle one carries the page's
	// data-i18n binding, so writing the room code straight onto the button (what
	// this used to do) replaced the visitor's translated "Share live" with English
	// the first time the room state changed. Swapping which span is hidden leaves
	// the translated label untouched.
	const idleLabel = $('ars-room-label');
	const codeLabel = $('ars-room-code-label');
	if (idleLabel) idleLabel.hidden = live;
	if (codeLabel) {
		codeLabel.hidden = !live;
		codeLabel.textContent = live ? `👥 ${roomCode || 'Room'}` : '';
	}
	// Keep the live modal panel in sync if it's open.
	if (roomModal && !roomModal.hidden) renderRoomModal();
}

function renderRoomModal() {
	const idle = $('ars-room-idle');
	const liveEl = $('ars-room-live');
	const online = !!net && net.status === 'online';
	if (idle) idle.hidden = online;
	if (liveEl) liveEl.hidden = !online;
	if (online) {
		const codeEl = $('ars-room-code');
		if (codeEl) codeEl.textContent = roomCode;
		const pres = $('ars-room-presence');
		if (pres) {
			pres.textContent = roomPresence.count > 1
				? `${roomPresence.count} people are building here.`
				: "You're the only one here yet — share the code to invite someone.";
		}
		const box = $('ars-room-qr');
		if (box) {
			try {
				box.innerHTML = renderQRToSVG(roomShareUrl('https://three.ws', roomCode), {
					scale: 5, margin: 2, dark: '#0b0b0b', light: '#ffffff',
				});
			} catch { box.textContent = roomShareUrl('https://three.ws', roomCode); }
		}
	}
}

function openRoomModal() {
	if (!roomModal) return;
	roomModal.hidden = false;
	renderRoomModal();
	(net && net.status === 'online' ? $('ars-room-copy') : $('ars-room-create'))?.focus?.();
}

function closeRoomModal() {
	if (!roomModal) return;
	const hadFocus = roomModal.contains(document.activeElement);
	roomModal.hidden = true;
	if (hadFocus) restoreFocus(roomBtn);
}

// Unlock the arrival chime inside a real user gesture (the same tap that opens
// the room flow) so it can play later without an autoplay-policy warning.
roomBtn?.addEventListener('click', () => { unlockAudio(); openRoomModal(); });
$('ars-room-close')?.addEventListener('click', closeRoomModal);
roomModal?.addEventListener('click', (e) => { if (e.target === roomModal) closeRoomModal(); });

$('ars-room-create')?.addEventListener('click', async () => {
	unlockAudio();
	await createRoom();
	renderRoomModal();
	// One-tap invite: put the join link on the clipboard immediately (still inside
	// this click's user activation) so hosting a room is create → paste, not
	// create → find button → copy. Best-effort; the Copy button remains as backup.
	if (net && net.status === 'online' && navigator.clipboard?.writeText) {
		try {
			await navigator.clipboard.writeText(roomShareUrl(location.origin, roomCode));
			setStatus(`Room ${roomCode} is live — invite link copied. Paste it to a friend.`);
		} catch { /* clipboard blocked — the Copy button below still works */ }
	}
});

$('ars-room-join-form')?.addEventListener('submit', async (e) => {
	e.preventDefault();
	unlockAudio();
	const input = $('ars-room-join-input');
	const code = normalizeRoomCode(input?.value);
	if (!code) {
		setStatus('That room code looks off — check the 6 characters.', { warn: true });
		input?.focus?.();
		return;
	}
	await joinRoom(code);
	renderRoomModal();
});

$('ars-room-copy')?.addEventListener('click', () => {
	const url = roomShareUrl(location.origin, roomCode);
	const btn = $('ars-room-copy');
	const done = () => {
		if (!btn) return;
		const old = btn.textContent;
		btn.textContent = 'Link copied ✓';
		setTimeout(() => { btn.textContent = old; }, 1600);
	};
	if (navigator.share) {
		navigator.share({ title: 'Build with me in AR Studio', text: `Join my AR Studio room: ${roomCode}`, url }).catch(() => {});
	} else if (navigator.clipboard) {
		navigator.clipboard.writeText(url).then(done).catch(() => window.prompt('Copy this invite link:', url));
	} else {
		window.prompt('Copy this invite link:', url);
	}
});

$('ars-room-leave')?.addEventListener('click', () => {
	leaveRoom();
	renderRoomModal();
});

function removePlacement(p, { persist = true, broadcast = true } = {}) {
	const i = placements.indexOf(p);
	if (i === -1) return;
	placements.splice(i, 1);
	if (p.netId) {
		netModelsById.delete(p.netId);
		// Tell the room, unless this removal CAME from the room (reconcile) or it's
		// not mine to remove (the server would reject it anyway).
		if (broadcast && net && net.status === 'online' && isMine(p)) net.remove(p.netId);
	}
	p.idle?.detach();
	p.idle = null;
	xrSession?.release(p.group);
	scene.remove(p.group);
	if (p.shadow) {
		scene.remove(p.shadow);
		p.shadow.geometry?.dispose();
		p.shadow.material?.dispose();
	}
	// Geometry/materials belong to the shared template — other copies (and
	// future adds of the same source) still use them, so nothing is disposed.
	// SkeletonUtils.clone shares geometry between copies; only the shadow above
	// is per-placement.
	if (selected === p) select(placements[placements.length - 1] ?? null);
	updateCount();
	if (persist) saveScene();
}

// ── Restore + deep links ──────────────────────────────────────────────────────
let armedSrc = null; // { src, title } — what an XR reticle tap places

async function restoreScene({ skipLocal = false } = {}) {
	const params = new URLSearchParams(location.search);
	const linked = parseSrcParams(params);

	// A #s= hash is a FULL shared arrangement (models + transforms) — it opens
	// like a document, replacing the working scene rather than merging into it.
	// skipLocal (arriving via a ?room= link) means the shared ROOM is the source
	// of truth, so we don't also restore the local/hash scene (which would
	// duplicate the server's authoritative copies).
	const sharedScene = skipLocal ? [] : sceneFromHashParam(
		new URLSearchParams(location.hash.replace(/^#/, '')).get('s'),
	);

	let items = sharedScene;
	if (!items.length && !skipLocal) {
		try {
			items = deserializeScene(localStorage.getItem(SCENE_KEY));
		} catch {}
	}

	for (const it of items) {
		await addModel({ src: it.src, title: it.title }, {
			x: it.x, z: it.z, yaw: it.yaw, scale: it.scale, announce: false, persist: false,
		});
	}
	// Deep-linked models land in front of the camera, skipping ones already
	// restored at an arranged spot.
	const have = new Set(placements.map((p) => p.src));
	for (const it of linked) {
		if (have.has(it.src)) continue;
		await addModel(it, { announce: false });
	}
	if (placements.length) {
		select(placements[placements.length - 1]);
		if (sharedScene.length) {
			setStatus('Shared scene loaded, exactly as arranged. Clear to start fresh.');
		} else {
			setStatus(linked.length ? 'Models loaded — tap the camera to see them in your space.' : 'Your scene is back.');
		}
	}
	saveScene();

	const forgePrompt = (params.get('forge') || '').trim();
	if (forgePrompt.length >= 3 && forgeInput) {
		forgeInput.value = forgePrompt;
		startForge(forgePrompt);
	}
}

// ── Camera passthrough ────────────────────────────────────────────────────────
function applyCameraFov() {
	const track = mediaStream?.getVideoTracks?.()[0];
	if (track) {
		const s = track.getSettings?.() ?? {};
		if (Number.isFinite(s.width) && s.width > 0) arTrackW = s.width;
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

// ── Ambient light matching ────────────────────────────────────────────────────
// Sample the live camera feed's mean luminance every couple of seconds and
// ease the scene lights toward it, so a model placed in a dim bedroom doesn't
// glow like it's under studio lights (and one on a sunny balcony isn't muddy).
let lightTimer = null;
const roomTint = new Color(); // reused scratch — no per-sample allocation
const lightProbe = (() => {
	try {
		const cnv = document.createElement('canvas');
		cnv.width = cnv.height = 16;
		return { cnv, ctx: cnv.getContext('2d', { willReadFrequently: true }) };
	} catch {
		return null;
	}
})();

// Passthrough (iOS / no-WebXR) has no lighting-estimation API, so we read the
// room ourselves: mean brightness AND mean colour of the camera feed. Brightness
// drives light intensity (a dim room dims the model); colour drives a gentle
// white-balance tint (a warm-lamp room warms the model's whites, a daylight room
// cools them) so the model belongs to the room instead of glowing neutral on it.
function sampleCameraLight() {
	if (!arActive || !lightProbe?.ctx || !videoEl?.videoWidth) return;
	let data;
	try {
		lightProbe.ctx.drawImage(videoEl, 0, 0, 16, 16);
		data = lightProbe.ctx.getImageData(0, 0, 16, 16).data;
	} catch {
		return; // frame not readable yet — try again next tick
	}
	// Pure read (tested in studio-scene.test.js); ease the result onto the lights
	// so it adapts over a couple of seconds instead of popping frame to frame.
	const { intensity, tint } = roomLightFromPixels(data);
	hemi.intensity += (intensity * HEMI_BASE - hemi.intensity) * 0.4;
	sun.intensity += (intensity * SUN_BASE - sun.intensity) * 0.4;
	roomTint.setRGB(tint.r, tint.g, tint.b);
	hemi.color.lerp(roomTint, 0.4);
	sun.color.lerp(roomTint, 0.4);
}

function startLightMatching() {
	if (lightTimer || !lightProbe) return;
	lightTimer = setInterval(sampleCameraLight, 2000);
	sampleCameraLight();
}

function stopLightMatching() {
	clearInterval(lightTimer);
	lightTimer = null;
	hemi.intensity = HEMI_BASE;
	sun.intensity = SUN_BASE;
	hemi.color.setHex(0xffffff);
	sun.color.setHex(0xffffff);
}

async function startCamera() {
	if (arTransitioning || arActive || xrSession) return;
	if (!navigator.mediaDevices?.getUserMedia) {
		setStatus('This browser can’t open the camera — the 3D preview still works.', { warn: true });
		return;
	}
	arTransitioning = true;
	try {
		setStatus('Starting camera…', { sticky: true });
		try {
			mediaStream = await navigator.mediaDevices.getUserMedia({
				video: { facingMode: { ideal: 'environment' } },
				audio: false,
			});
		} catch (err) {
			if (err?.name === 'NotAllowedError') {
				setStatus('Camera permission is blocked. Allow it in your browser settings, then try again.', {
					warn: true, sticky: true, actionLabel: 'Try again', onAction: startCamera,
				});
			} else {
				setStatus(`The camera didn’t start (${err?.message ?? err}).`, {
					warn: true, actionLabel: 'Try again', onAction: startCamera,
				});
			}
			return;
		}
		if (videoEl) videoEl.srcObject = mediaStream;
		arActive = true;
		document.body.classList.add('is-ar');
		cameraBtn?.classList.add('is-active');
		cameraBtn?.setAttribute('aria-pressed', 'true');
		grid.visible = false;
		scene.fog = null;
		userLooked = true;
		videoEl?.play?.().catch(() => {});
		applyCameraFov();
		startLightMatching();
		await startGyro();
		setStatus('Camera on — your models are in the room. Look around.');
	} finally {
		arTransitioning = false;
	}
}

function stopCamera() {
	if (mediaStream) {
		mediaStream.getTracks().forEach((t) => { try { t.stop(); } catch {} });
		mediaStream = null;
	}
	if (videoEl) videoEl.srcObject = null;
	arActive = false;
	stopLightMatching();
	document.body.classList.remove('is-ar');
	cameraBtn?.classList.remove('is-active');
	cameraBtn?.setAttribute('aria-pressed', 'false');
	grid.visible = true;
	scene.fog = previewFog;
	userLooked = false;
	camera.fov = 58;
	camera.updateProjectionMatrix();
	gyroBase = null;
	arTrackW = 0;
	arTrackH = 0;
}

cameraBtn?.addEventListener('click', () => {
	if (arTransitioning || xrSession) return;
	if (arActive) {
		stopCamera();
		setStatus('Camera off — preview mode.');
	} else {
		startCamera();
	}
});
if (!navigator.mediaDevices?.getUserMedia && cameraBtn) {
	cameraBtn.disabled = true;
	cameraBtn.setAttribute('aria-disabled', 'true');
}

// ── Gyro look (relative world-lock; no GPS, no compass persistence) ──────────
let gyroBase = null; // { alpha, beta, yaw, pitch }
let lastDevAlpha = 0;
let lastDevBeta = 90;
let lastDevGamma = 0;
let hasAbsoluteEventStream = false;

function currentScreenAngle() {
	try {
		const a = screen.orientation?.angle;
		if (Number.isFinite(a)) return a;
	} catch {}
	return Number(window.orientation) || 0;
}

function onDeviceOrientation(e) {
	if (isFiniteReading(e.alpha, e.beta)) {
		lastDevAlpha = e.alpha;
		lastDevBeta = e.beta;
		if (Number.isFinite(e.gamma)) lastDevGamma = e.gamma;
	}
	if (!arActive || !gyroBase) return;
	const b = screenPitchDeg(lastDevBeta, lastDevGamma, currentScreenAngle());
	const nextYaw = resolveLockYaw({
		useAbsolute: false,
		prevYaw: cameraYaw,
		alpha: lastDevAlpha,
		baseAlpha: gyroBase.alpha,
		baseYaw: gyroBase.yaw,
		compassHeading: null,
	});
	const nextPitch = clampPitch(
		gyroBase.pitch - (b - gyroBase.beta) * (Math.PI / 180),
		PITCH_MIN, PITCH_MAX,
	);
	if (Number.isFinite(nextYaw)) cameraYaw = nextYaw;
	if (Number.isFinite(nextPitch)) cameraPitch = nextPitch;
}

window.addEventListener('deviceorientationabsolute', (e) => {
	hasAbsoluteEventStream = true;
	onDeviceOrientation(e);
}, true);
window.addEventListener('deviceorientation', (e) => {
	if (hasAbsoluteEventStream) return;
	onDeviceOrientation(e);
}, true);

async function startGyro() {
	// iOS 13+ gates DeviceOrientationEvent behind a user-gesture permission; the
	// camera button tap we are inside satisfies it.
	try {
		if (typeof DeviceOrientationEvent !== 'undefined'
			&& typeof DeviceOrientationEvent.requestPermission === 'function') {
			const state = await DeviceOrientationEvent.requestPermission();
			if (state !== 'granted') {
				setStatus('Motion access is off — drag to look around instead.', { warn: true });
				return;
			}
		}
	} catch {
		return; // declined prompt → drag-look still works
	}
	gyroBase = {
		alpha: lastDevAlpha,
		beta: screenPitchDeg(lastDevBeta, lastDevGamma, currentScreenAngle()),
		yaw: cameraYaw,
		pitch: cameraPitch,
	};
}

// ── Pointer gestures (fallback + camera modes; XR has its own) ───────────────
const raycaster = new Raycaster();
const ndc = new Vector2();
let pointerDown = null; // { x, y, placement|null, moved }
const pinch = createPinchState();
let pinchEndedAt = -Infinity;
let twist = null; // { startAngle, baseYaw, placement }

function placementAt(clientX, clientY) {
	ndc.set((clientX / window.innerWidth) * 2 - 1, -(clientY / window.innerHeight) * 2 + 1);
	raycaster.setFromCamera(ndc, camera);
	const groups = placements.map((p) => p.group);
	if (!groups.length) return null;
	const hits = raycaster.intersectObjects(groups, true);
	if (!hits.length) return null;
	let obj = hits[0].object;
	while (obj) {
		const found = placements.find((p) => p.group === obj);
		if (found) return found;
		obj = obj.parent;
	}
	return null;
}

function floorPointAt(clientX, clientY) {
	ndc.set((clientX / window.innerWidth) * 2 - 1, -(clientY / window.innerHeight) * 2 + 1);
	raycaster.setFromCamera(ndc, camera);
	const hits = raycaster.intersectObject(rayPlane);
	return hits.length ? hits[0].point : null;
}

canvas.addEventListener('pointerdown', (e) => {
	if (xrSession) return;
	if (pinch.active || performance.now() - pinchEndedAt < 350) return;
	pointerDown = {
		x: e.clientX, y: e.clientY,
		placement: placementAt(e.clientX, e.clientY),
		lookYaw: cameraYaw, lookPitch: cameraPitch,
		moved: false,
	};
});

canvas.addEventListener('pointermove', (e) => {
	if (!pointerDown || xrSession) return;
	if (pinch.active) return;
	const dx = e.clientX - pointerDown.x;
	const dy = e.clientY - pointerDown.y;
	if (Math.hypot(dx, dy) > 6) pointerDown.moved = true;
	if (!pointerDown.moved) return;

	if (pointerDown.placement && isMine(pointerDown.placement)) {
		// Drag a model along the floor (only models I own in a shared room).
		const pt = floorPointAt(e.clientX, e.clientY);
		if (!pt) return;
		const p = pointerDown.placement;
		p.group.position.x = pt.x;
		p.group.position.z = pt.z;
		if (p.shadow) p.shadow.position.set(pt.x, 0.004, pt.z);
		if (selected === p) positionSelRing();
		netBroadcastTransform(p);
	} else if (!pointerDown.placement && !(arActive && gyroBase)) {
		// Drag-look: only when the gyro isn't already steering the view.
		userLooked = true;
		cameraYaw = pointerDown.lookYaw + dx * 0.0042;
		cameraPitch = clampPitch(pointerDown.lookPitch + dy * 0.0032, PITCH_MIN, PITCH_MAX);
	}
});

function endPointer(e) {
	if (!pointerDown || xrSession) return;
	const wasTap = !pointerDown.moved
		&& Math.hypot(e.clientX - pointerDown.x, e.clientY - pointerDown.y) <= 8
		&& !pinch.active && performance.now() - pinchEndedAt >= 350;
	if (wasTap) {
		select(pointerDown.placement); // null = deselect
	} else if (pointerDown.placement && pointerDown.moved && isMine(pointerDown.placement)) {
		pointerDown.placement._lastNetSend = 0; // force the settle broadcast through
		netBroadcastTransform(pointerDown.placement);
		saveScene();
		setStatus(null);
	}
	pointerDown = null;
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', () => { pointerDown = null; });

// Two-finger pinch = scale, twist = rotate — on the selected (or last) model I own.
function gestureTarget() {
	const t = selected ?? placements[placements.length - 1] ?? null;
	return t && isMine(t) ? t : null;
}

canvas.addEventListener('touchstart', (e) => {
	if (xrSession || e.touches.length !== 2) return;
	const target = gestureTarget();
	if (!target) return;
	pointerDown = null; // the pair owns the gesture; no drag/tap
	pinchStart(pinch, touchDist(e.touches), target.group.scale.x);
	twist = { startAngle: touchAngle(e.touches), baseYaw: target.yaw, placement: target };
}, { passive: true });

canvas.addEventListener('touchmove', (e) => {
	if (xrSession || e.touches.length !== 2) return;
	const target = twist?.placement;
	if (!target) return;
	const s = pinchMove(pinch, touchDist(e.touches));
	if (s != null) {
		target.group.scale.setScalar(s);
		target.shadow?.scale.setScalar(s);
		if (selected === target) positionSelRing();
	}
	target.yaw = twist.baseYaw + twistDelta(twist.startAngle, touchAngle(e.touches));
	target.group.rotation.y = target.yaw;
	netBroadcastTransform(target);
}, { passive: true });

canvas.addEventListener('touchend', () => {
	const s = pinchEnd(pinch);
	const target = twist?.placement;
	if (s != null) {
		pinchEndedAt = performance.now();
		saveScene();
	}
	if (target) { target._lastNetSend = 0; netBroadcastTransform(target); }
	twist = null;
}, { passive: true });

// ── Selection toolbar ─────────────────────────────────────────────────────────
selbar?.addEventListener('click', (e) => {
	const btn = e.target.closest('[data-act]');
	if (!btn || !selected) return;
	const act = btn.dataset.act;
	if (act === 'rotate') {
		if (!isMine(selected)) { setStatus('That model belongs to someone else in the room.', { warn: true }); return; }
		selected.yaw += Math.PI / 4;
		selected.group.rotation.y = selected.yaw;
		selected._lastNetSend = 0;
		netBroadcastTransform(selected);
		saveScene();
	} else if (act === 'duplicate') {
		addModel({ src: selected.src, title: selected.title }, {
			yaw: selected.yaw, scale: logicalScale(selected),
		});
	} else if (act === 'remove') {
		if (!isMine(selected)) { setStatus('That model belongs to someone else in the room.', { warn: true }); return; }
		const removed = selected;
		removePlacement(removed);
		setStatus('Removed.', {
			actionLabel: 'Undo',
			onAction: () => addModel({ src: removed.src, title: removed.title }, {
				x: removed.group.position.x, z: removed.group.position.z,
				yaw: removed.yaw, scale: logicalScale(removed),
			}),
		});
	}
});

clearBtn?.addEventListener('click', () => {
	if (!placements.length) return;
	undoItems = placements.map((p) => ({
		src: p.src, title: p.title,
		x: p.group.position.x, z: p.group.position.z,
		yaw: p.yaw, scale: logicalScale(p),
	}));
	for (const p of [...placements]) removePlacement(p, { persist: false });
	saveScene();
	setStatus('Scene cleared.', {
		actionLabel: 'Undo',
		onAction: async () => {
			const items = undoItems ?? [];
			undoItems = null;
			for (const it of items) {
				await addModel({ src: it.src, title: it.title }, {
					x: it.x, z: it.z, yaw: it.yaw, scale: it.scale, announce: false,
				});
			}
		},
	});
});

// ── Forge without leaving the camera ─────────────────────────────────────────
let forgeBusy = false;
let forgeSeq = 0;

function forgeChipState(state, label) {
	if (!forgeChip) return;
	forgeChip.dataset.state = state;
	forgeChip.hidden = state === 'idle';
	const text = forgeChip.querySelector('.ars-chip-label');
	if (text) text.textContent = label || '';
}

async function startForge(prompt) {
	prompt = String(prompt || '').trim();
	if (prompt.length < 3 || forgeBusy) return;
	forgeBusy = true;
	const seq = ++forgeSeq;
	if (forgeGo) forgeGo.disabled = true;
	const t0 = Date.now();
	// Real ETA + cold-start signal from the initial /api/forge response (see
	// api/_lib/forge-lane-health.js#coldStartFor). No poll response repeats
	// these fields, so they're captured once here and folded into every later
	// forgeStageNarration() call via the shared eta_seconds/cold_start contract.
	let etaSeconds = null;
	let coldStart = false;
	let coldSeconds = null;
	let laneBackend = null;
	// The last status the pipeline actually reported, so the repaint timer never
	// claims a stage the worker has not entered.
	let liveStatus = 'queued';
	forgeChipState('working', 'Sending your prompt to the forge…');
	const setStage = (status) => {
		if (!forgeChip) return;
		const elapsedS = (Date.now() - t0) / 1000;
		const remaining = etaSeconds != null ? Math.max(0, Math.round(etaSeconds - elapsedS)) : null;
		// The cold-start budget counts down from the real spin-up seconds the API
		// reported, so the line shrinks against the clock instead of repeating.
		const coldLeft = coldSeconds != null ? Math.max(0, Math.round(coldSeconds - elapsedS)) : null;
		const narration = forgeStageNarration({
			status,
			eta_seconds: remaining ?? undefined,
			backend: laneBackend ?? undefined,
			cold_start: coldStart && status !== 'done',
			cold_seconds: coldLeft ?? undefined,
		});
		const label = forgeChip.querySelector('.ars-chip-label');
		const el = forgeChip.querySelector('.ars-chip-elapsed');
		if (label) label.textContent = narration;
		if (el) el.textContent = `${Math.round(elapsedS)}s`;
	};
	const elapsed = setInterval(() => {
		if (forgeChip?.dataset.state === 'working') setStage(liveStatus);
	}, 1000);

	try {
		const res = await fetch('/api/forge', {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-forge-client': CLIENT_ID },
			body: JSON.stringify({ prompt, backend: 'nvidia' }),
		});
		const data = await res.json().catch(() => ({}));
		if (res.status === 503 || data.error === 'unconfigured') {
			throw new Error('The generator is offline right now. Try again in a few minutes.');
		}
		if (res.status === 429 || data.error === 'rate_limited') {
			const secs = Number(data.retry_after) > 0 ? Math.ceil(Number(data.retry_after)) : 15;
			throw new Error(data.message || `The forge is busy — try again in about ${secs}s.`);
		}
		if (!res.ok) throw new Error(data.message || `The generator returned ${res.status}.`);
		if (Number(data.eta_seconds) > 0) etaSeconds = Math.round(Number(data.eta_seconds));
		coldStart = Boolean(data.cold_start);
		if (Number(data.cold_start_seconds) > 0) coldSeconds = Math.round(Number(data.cold_start_seconds));
		if (typeof data.backend === 'string' && data.backend) laneBackend = data.backend;

		let done = data;
		if (!(data.status === 'done' && data.glb_url)) {
			if (!data.job_id) throw new Error('The forge did not accept the job. Try again.');
			setStage('queued');
			done = await pollForge(data.job_id, seq, (d) => {
				if (typeof d.status === 'string' && d.status) liveStatus = d.status;
				// A worker that answers "running" is up, so the boot is genuinely over.
				if (d.status === 'running') coldStart = false;
				if (typeof d.backend === 'string' && d.backend) laneBackend = d.backend;
				setStage(liveStatus);
			});
		}
		if (!done || seq !== forgeSeq) return;
		rememberForge(prompt, done.glb_url);
		forgeChipState('idle');
		if (forgeInput) forgeInput.value = '';
		await addModel({ src: done.glb_url, title: prompt }, { announce: false });
		setStatus('Forged and placed. Pinch to resize, drag to move.');
	} catch (err) {
		if (seq === forgeSeq) {
			forgeChipState('error', (err && err.message) || 'Generation failed.');
			setTimeout(() => {
				if (forgeChip?.dataset.state === 'error') forgeChipState('idle');
			}, 6000);
		}
	} finally {
		clearInterval(elapsed);
		if (seq === forgeSeq) {
			forgeBusy = false;
			if (forgeGo) forgeGo.disabled = false;
		}
	}
}

async function pollForge(jobId, seq, onUpdate) {
	const deadline = Date.now() + MAX_POLL_MS;
	for (;;) {
		if (seq !== forgeSeq) return null;
		if (Date.now() > deadline) throw new Error('Generation timed out. Try a simpler, single-object prompt.');
		await new Promise((r) => setTimeout(r, POLL_MS));
		if (seq !== forgeSeq) return null;
		const res = await fetch(`/api/forge?job=${encodeURIComponent(jobId)}`, {
			headers: { 'x-forge-client': CLIENT_ID },
		});
		const data = await res.json().catch(() => ({}));
		if (typeof onUpdate === 'function') onUpdate(data);
		if (data.status === 'done' && data.glb_url) return data;
		if (data.status === 'failed') throw new Error(data.error || 'Generation failed. Try rephrasing the prompt.');
	}
}

function readRecent() {
	try {
		const v = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
		return Array.isArray(v)
			? v.filter((e) => e && normalizeGlbUrl(e.glb) && e.prompt)
			: [];
	} catch {
		return [];
	}
}

function rememberForge(prompt, glb) {
	try {
		const list = readRecent().filter((e) => e.glb !== glb);
		list.unshift({ prompt: String(prompt).slice(0, 200), glb, ts: Date.now() });
		localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 8)));
	} catch {}
}

forgeForm?.addEventListener('submit', (e) => {
	e.preventDefault();
	startForge(forgeInput?.value);
});

// ── Model tray ────────────────────────────────────────────────────────────────
let trayTab = 'recent';
const trayCache = new Map(); // tab → items

// Closing a dialog must hand the keyboard back to whatever opened it; dropping
// focus on <body> strands a keyboard user at the top of the document with the
// scene they were just editing behind them.
function restoreFocus(el) {
	if (el && document.contains(el) && !el.hidden) el.focus?.();
}

function openTray(tab = trayTab) {
	if (!tray) return;
	tray.hidden = false;
	addBtn?.setAttribute('aria-expanded', 'true');
	setTrayTab(tab);
	trayClose?.focus?.();
}

function closeTray() {
	if (!tray) return;
	const wasOpen = !tray.hidden;
	tray.hidden = true;
	addBtn?.setAttribute('aria-expanded', 'false');
	if (wasOpen && tray.contains(document.activeElement)) restoreFocus(addBtn);
}

function closeQrModal() {
	if (!qrModal) return;
	const hadFocus = qrModal.contains(document.activeElement);
	qrModal.hidden = true;
	if (hadFocus) restoreFocus(qrBtn);
}

addBtn?.addEventListener('click', () => (tray?.hidden ? openTray() : closeTray()));
trayClose?.addEventListener('click', closeTray);
tray?.addEventListener('click', (e) => {
	if (e.target === tray) closeTray();
});
document.addEventListener('keydown', (e) => {
	if (e.key === 'Escape') {
		if (tray && !tray.hidden) closeTray();
		else if (roomModal && !roomModal.hidden) closeRoomModal();
		else if (qrModal && !qrModal.hidden) closeQrModal();
		else select(null);
	}
});

// ── Desktop keyboard controls ─────────────────────────────────────────────────
// Arrows nudge the selected model camera-relative (Shift = fine), R rotates,
// D duplicates, Delete removes — the mouse never has to leave the scene.
document.addEventListener('keydown', (e) => {
	if (e.target.closest?.('input, textarea, select')) return;
	if ((tray && !tray.hidden) || (qrModal && !qrModal.hidden) || xrSession) return;
	if (!selected) return;
	// Keyboard edits act on the selected model — only if it's mine in a room.
	const editable = isMine(selected);

	const key = e.key;
	if (key.startsWith('Arrow')) {
		if (!editable) return;
		e.preventDefault();
		const step = e.shiftKey ? 0.02 : 0.1;
		const fwd = camera.getWorldDirection(new Vector3());
		fwd.y = 0;
		if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
		fwd.normalize();
		const right = new Vector3(-fwd.z, 0, fwd.x);
		const move = key === 'ArrowUp' ? fwd
			: key === 'ArrowDown' ? fwd.negate()
			: key === 'ArrowLeft' ? right.negate()
			: right;
		selected.group.position.addScaledVector(move, step);
		selected.shadow?.position.set(selected.group.position.x, 0.004, selected.group.position.z);
		positionSelRing();
		netBroadcastTransform(selected);
		saveScene();
	} else if (key === 'r' || key === 'R') {
		if (!editable) return;
		selected.yaw += Math.PI / 4;
		selected.group.rotation.y = selected.yaw;
		selected._lastNetSend = 0;
		netBroadcastTransform(selected);
		saveScene();
	} else if (key === 'd' || key === 'D') {
		e.preventDefault();
		addModel({ src: selected.src, title: selected.title }, {
			yaw: selected.yaw, scale: logicalScale(selected),
		});
	} else if (key === 'Delete' || key === 'Backspace') {
		if (!editable) return;
		e.preventDefault();
		const removed = selected;
		removePlacement(removed);
		setStatus('Removed.', {
			actionLabel: 'Undo',
			onAction: () => addModel({ src: removed.src, title: removed.title }, {
				x: removed.group.position.x, z: removed.group.position.z,
				yaw: removed.yaw, scale: logicalScale(removed),
			}),
		});
	}
});

const trayTabs = [...(tray?.querySelectorAll('[data-tab]') || [])];
trayTabs.forEach((btn) => {
	btn.addEventListener('click', () => setTrayTab(btn.dataset.tab));
});

// A role="tablist" owes the keyboard the arrow-key contract: Left/Right (and
// Home/End) move between tabs and select as they go, with a roving tabindex so
// Tab enters the strip once and then leaves it for the panel.
tray?.querySelector('.ars-tabs')?.addEventListener('keydown', (e) => {
	const i = trayTabs.indexOf(document.activeElement);
	if (i === -1) return;
	const last = trayTabs.length - 1;
	const next = e.key === 'ArrowRight' ? (i === last ? 0 : i + 1)
		: e.key === 'ArrowLeft' ? (i === 0 ? last : i - 1)
		: e.key === 'Home' ? 0
		: e.key === 'End' ? last
		: -1;
	if (next === -1) return;
	e.preventDefault();
	setTrayTab(trayTabs[next].dataset.tab);
	trayTabs[next].focus();
});

// Mark which way the tab strip can still scroll so the CSS edge fade points at
// the hidden tabs instead of guessing (see .ars-tabs[data-scroll] in the page).
const tabStrip = tray?.querySelector('.ars-tabs');
function updateTabScrollHints() {
	if (!tabStrip) return;
	const slack = tabStrip.scrollWidth - tabStrip.clientWidth;
	const hints = [];
	if (slack > 2 && tabStrip.scrollLeft > 2) hints.push('start');
	if (slack > 2 && tabStrip.scrollLeft < slack - 2) hints.push('end');
	tabStrip.dataset.scroll = hints.join(' ');
}
tabStrip?.addEventListener('scroll', updateTabScrollHints, { passive: true });
window.addEventListener('resize', updateTabScrollHints);

function setTrayTab(tab) {
	trayTab = tab;
	trayTabs.forEach((b) => {
		const on = b.dataset.tab === tab;
		b.classList.toggle('is-active', on);
		b.setAttribute('aria-selected', String(on));
		b.tabIndex = on ? 0 : -1;
		if (on) {
			trayBody?.setAttribute('aria-labelledby', b.id);
			b.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
		}
	});
	updateTabScrollHints();
	renderTray();
}

function trayItemHTML(it) {
	const img = it.poster
		? `<img src="${esc(it.poster)}" alt="" loading="lazy" />`
		: '<span class="ars-item-cube" aria-hidden="true">◆</span>';
	// A forge row's "title" is the prompt it was generated from, and a refined
	// or image-derived prompt is a multi-clause spec. Cards get the first
	// clause; the whole prompt stays reachable as the tooltip.
	const label = cardTitleFromPrompt(it.title);
	const full = String(it.title || '').trim();
	return `
		<li class="ars-item">
			<button type="button" class="ars-item-add" data-src="${esc(it.src)}" data-title="${esc(label)}"
				${full ? `title="${esc(full)}"` : ''}
				aria-label="Add ${esc(label)} to your space">
				<span class="ars-item-thumb">${img}</span>
				<span class="ars-item-title">${esc(label)}</span>
				<span class="ars-item-cta">Add</span>
			</button>
		</li>`;
}

async function fetchTrayItems(tab) {
	if (trayCache.has(tab)) return trayCache.get(tab);
	let items = [];
	if (tab === 'recent') {
		items = readRecent().map((e) => ({ src: e.glb, title: e.prompt, poster: '' }));
	} else if (tab === 'objects') {
		// The CC0 object library (/objects). The full manifest is a few hundred
		// small records; fetch it once so the tab's filter box runs client-side
		// with no further requests.
		const res = await fetch('/api/objects/library');
		if (!res.ok) throw new Error(`objects ${res.status}`);
		const data = await res.json();
		items = (data.objects || [])
			.map((o) => ({
				src: o.url || '',
				title: o.label || o.name || '',
				poster: o.thumb || '',
				keywords: `${o.label || o.name || ''} ${(o.categories || []).join(' ')}`.toLowerCase(),
			}))
			.filter((o) => normalizeGlbUrl(o.src));
	} else {
		const qs = tab === 'community' ? '?scope=community&limit=24' : '?limit=24';
		const res = await fetch(`/api/forge-gallery${qs}`, {
			headers: tab === 'yours' ? { 'x-forge-client': CLIENT_ID } : {},
		});
		if (!res.ok) throw new Error(`gallery ${res.status}`);
		const data = await res.json();
		items = (data.creations || [])
			.map((c) => ({
				src: c.glb_url || c.glbUrl || '',
				title: c.prompt || c.title || '',
				poster: c.preview_image_url || c.previewImageUrl || '',
			}))
			.filter((c) => normalizeGlbUrl(c.src));
	}
	trayCache.set(tab, items);
	return items;
}

async function renderTray() {
	if (!trayBody) return;
	const tab = trayTab;

	if (tab === 'link') {
		trayBody.innerHTML = `
			<form class="ars-link-form" id="ars-link-form">
				<label class="ars-link-label" for="ars-link-input">Paste a GLB link</label>
				<div class="ars-link-row">
					<input id="ars-link-input" type="url" inputmode="url" required
						placeholder="https://example.com/model.glb" />
					<button type="submit" class="ars-btn ars-btn-primary">Add</button>
				</div>
				<p class="ars-link-hint">Any https .glb works — a forge result, a viewer share link's src, or your own hosting.</p>
			</form>`;
		const form = $('ars-link-form');
		form?.addEventListener('submit', (e) => {
			e.preventDefault();
			const input = $('ars-link-input');
			const url = normalizeGlbUrl(input?.value);
			if (!url) {
				setStatus('That link is not a loadable https GLB.', { warn: true });
				return;
			}
			closeTray();
			addModel({ src: url, title: url.split('/').pop()?.replace(/\.glb.*$/i, '') || 'Linked model' });
		});
		return;
	}

	trayBody.innerHTML = '<div class="ars-tray-loading"><span class="ars-spinner" aria-hidden="true"></span> Loading models…</div>';
	let items;
	try {
		items = await fetchTrayItems(tab);
	} catch (err) {
		log.warn('tray fetch failed', tab, err);
		if (trayTab !== tab) return;
		trayBody.innerHTML = `
			<div class="ars-tray-empty">
				<p>Couldn’t load models right now.</p>
				<button type="button" class="ars-btn" id="ars-tray-retry">Retry</button>
			</div>`;
		$('ars-tray-retry')?.addEventListener('click', () => {
			trayCache.delete(tab);
			renderTray();
		});
		return;
	}
	if (trayTab !== tab) return;

	if (!items.length) {
		const copy = {
			recent: 'Nothing forged on this device yet. Type a prompt below and your first model appears here.',
			yours: 'No saved creations yet. Forge something here or in the <a href="/forge">Forge studio</a> and it lands in this tab.',
			community: 'The community feed is quiet right now. Check back in a bit.',
			objects: 'The <a href="/objects">object library</a> is unreachable right now. Check back in a bit.',
		}[tab] || 'Nothing here yet.';
		trayBody.innerHTML = `
			<div class="ars-tray-empty">
				<p>${copy}</p>
				<button type="button" class="ars-btn ars-btn-primary" id="ars-tray-forge">Forge a model</button>
			</div>`;
		$('ars-tray-forge')?.addEventListener('click', () => {
			closeTray();
			forgeInput?.focus();
		});
		return;
	}
	if (tab === 'objects') {
		renderObjectsTray(items);
		return;
	}
	trayBody.innerHTML = `<ul class="ars-item-list">${items.map(trayItemHTML).join('')}</ul>`;
	wireTrayAdds();
}

function wireTrayAdds() {
	trayBody.querySelectorAll('.ars-item-add').forEach((btn) => {
		btn.addEventListener('click', () => {
			closeTray();
			addModel({ src: btn.dataset.src, title: btn.dataset.title });
		});
	});
	// A poster that 404s or times out would otherwise leave a broken-image glyph
	// in the grid. Fall back to the same cube mark a poster-less item already
	// uses, so a flaky thumbnail host never makes the tray look broken.
	trayBody.querySelectorAll('.ars-item-thumb img').forEach((img) => {
		img.addEventListener('error', () => {
			const slot = img.parentElement;
			if (!slot) return;
			slot.textContent = '';
			const cube = document.createElement('span');
			cube.className = 'ars-item-cube';
			cube.setAttribute('aria-hidden', 'true');
			cube.textContent = '◆';
			slot.appendChild(cube);
		}, { once: true });
	});
}

// The object library is ~500 CC0 props, too many to scroll blind, so this tab
// filters over name + category and renders matches in slices.
const OBJECTS_SLICE = 60;
function renderObjectsTray(items) {
	trayBody.innerHTML = `
		<div class="ars-objects-head">
			<div class="ars-link-row">
				<input id="ars-objects-search" type="search" autocomplete="off"
					placeholder="Search ${items.length} CC0 props…"
					aria-label="Search the object library" />
			</div>
			<p class="ars-link-hint">Free CC0 props from the <a href="/objects">object library</a>. Tap one to place it in your space.</p>
		</div>
		<ul class="ars-item-list" id="ars-objects-list"></ul>
		<div class="ars-objects-more" id="ars-objects-more"></div>`;
	const list = $('ars-objects-list');
	const more = $('ars-objects-more');
	const input = $('ars-objects-search');
	let shown = OBJECTS_SLICE;
	const paint = () => {
		const q = (input?.value || '').trim().toLowerCase();
		const matches = q ? items.filter((o) => o.keywords.includes(q)) : items;
		list.innerHTML = matches.slice(0, shown).map(trayItemHTML).join('');
		wireTrayAdds();
		if (matches.length > shown) {
			more.innerHTML = `<button type="button" class="ars-btn" id="ars-objects-show-more">Show ${Math.min(OBJECTS_SLICE, matches.length - shown)} more (${matches.length - shown} left)</button>`;
			$('ars-objects-show-more')?.addEventListener('click', () => {
				shown += OBJECTS_SLICE;
				paint();
			});
		} else {
			more.innerHTML = matches.length ? '' : '<p class="ars-link-hint">No props match that search.</p>';
		}
	};
	input?.addEventListener('input', () => {
		shown = OBJECTS_SLICE;
		paint();
	});
	paint();
}

// ── Entering AR ──────────────────────────────────────────────────────────────
// Three device classes, three genuinely different experiences, and only one of
// them is WebXR. An iPhone has no immersive-ar session, and until this existed
// it was offered nothing but the camera-passthrough composite: the model floats
// convincingly in a screenshot and not at all in the hand, because there is no
// plane detection, no real scale and nothing occluding it. Every iPhone already
// ships ARKit through AR Quick Look, which is what /avatars/:id/ar has always
// used, so the studio now hands one model to it the same way.
//
// 'webxr' keeps the whole multi-model scene in the page and stays first.
/** @type {'webxr'|'quicklook'|'sceneviewer'|'none'} */
let arMode = 'none';

async function resolveArMode() {
	try {
		if (await MultiPlaceSession.isSupported()) return 'webxr';
	} catch {
		// A throwing support probe is just "not webxr".
	}
	if (canUseQuickLook()) return 'quicklook';
	if (canUseSceneViewer()) return 'sceneviewer';
	return 'none';
}

resolveArMode().then((mode) => {
	arMode = mode;
	if (!xrBtn || mode === 'none') return;
	xrBtn.hidden = false;
	const label = xrBtn.querySelector('.ars-ar-label');
	if (mode === 'webxr') {
		if (label) label.textContent = 'Immersive';
		xrBtn.setAttribute('aria-label', 'Enter immersive AR');
	} else {
		// Do not promise an immersive session to a device that has none.
		if (label) {
			label.textContent = 'Place in AR';
			label.setAttribute('data-i18n', 'ar_studio.place_in_ar');
		}
		xrBtn.setAttribute('aria-label', 'Open this in your device AR viewer and place it in your real space');
	}
});

// The device's own AR viewer, for one model. Quick Look reads USDZ rather than
// glTF, so the GLB is converted here on the device (a real conversion through
// three's USDZExporter, the same pipeline /avatars/:id/ar uses) and handed over
// as a blob. A couple of silent seconds after a tap reads as a dead button, so
// every stage reports.
let nativeArBusy = false;
let nativeArObjectUrl = null;

async function placeNative(placement) {
	const target = placement || selected || placements[placements.length - 1];
	if (!target) {
		setStatus('Add a model first, then place it in your space.', { warn: true });
		return;
	}
	if (nativeArBusy) return;
	nativeArBusy = true;
	xrBtn?.setAttribute('aria-busy', 'true');
	try {
		if (canUseQuickLook()) {
			setStatus('Fetching the model…', { sticky: true });
			const res = await fetch(target.src);
			if (!res.ok) throw new Error(`model fetch ${res.status}`);
			const glbBlob = await res.blob();
			setStatus('Preparing it for AR…', { sticky: true });
			const usdzBlob = await glbBlobToUsdzBlob(glbBlob);
			if (nativeArObjectUrl) URL.revokeObjectURL(nativeArObjectUrl);
			nativeArObjectUrl = URL.createObjectURL(usdzBlob);
			setStatus('Opening AR…', { sticky: true });
			openQuickLook(nativeArObjectUrl);
		} else if (canUseSceneViewer()) {
			setStatus('Opening AR…', { sticky: true });
			openSceneViewer(target.src, { title: target.title || '', link: location.href });
		} else {
			setStatus('This device has no AR viewer. Open this scene on a phone to place it in a room.', {
				warn: true, actionLabel: 'Show QR', onAction: () => qrBtn?.click(),
			});
			return;
		}
		setStatus('Point at the floor, then drag to place it.');
	} catch (err) {
		setStatus(`Could not open AR for this model (${err?.message || err}).`, {
			warn: true, actionLabel: 'Try again', onAction: () => placeNative(target),
		});
	} finally {
		nativeArBusy = false;
		xrBtn?.removeAttribute('aria-busy');
	}
}

window.addEventListener('pagehide', () => {
	if (nativeArObjectUrl) URL.revokeObjectURL(nativeArObjectUrl);
});

xrBtn?.addEventListener('click', async () => {
	// Anything that is not WebXR goes to the platform's own viewer instead.
	if (arMode !== 'webxr') {
		placeNative();
		return;
	}
	if (xrSession) {
		xrSession.end();
		return;
	}
	if (arTransitioning) return;
	arTransitioning = true;
	try {
		if (arActive) stopCamera(); // the immersive session owns the rear camera
		const session = new MultiPlaceSession({
			renderer,
			scene,
			camera,
			domOverlayRoot: hud,
			getArmedContent: () => {
				const src = armedSrc?.src ?? placements[placements.length - 1]?.src;
				if (!src) {
					setStatus('Pick a model first — Add or forge one, then tap the floor.', { warn: true });
					return null;
				}
				// An XR select can't await: only an already-resolved template places.
				const tpl = tplReady.get(src);
				if (!tpl) {
					loadTemplate(src);
					setStatus('Model is still loading — one moment, then tap again.', { sticky: true });
					return null;
				}
				const { group, mixer, idlePromise } = instantiate(tpl, src);
				const placement = {
					id: `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
					src,
					title: armedSrc?.title || '',
					group,
					shadow: null,
					mixer,
					idle: null,
					yaw: 0,
					baseRadius: tpl.radius,
					spawnT: 1,
				};
				idlePromise?.then((mgr) => {
					if (!mgr) return;
					if (placements.includes(placement)) placement.idle = mgr;
					else mgr.detach();
				});
				placements.push(placement);
				updateCount();
				return group;
			},
			onPlaced: (group) => {
				const p = placements.find((x) => x.group === group);
				if (p) {
					p.yaw = 0;
					select(null); // the ring is a fallback-mode affordance
				}
				saveScene();
				setStatus(`Placed ${xrSession?.placedCount ?? ''} — tap another spot to add one more.`);
			},
			getScaleTarget: () => placements[placements.length - 1]?.group ?? null,
			onScale: (s, { final }) => {
				if (final) saveScene();
			},
			onHit: (has) => {
				document.body.classList.toggle('xr-has-floor', has);
			},
			onTracking: (ok) => {
				if (!ok) setStatus('Tracking lost — move to a brighter spot with more texture.', { warn: true, sticky: true });
				else setStatus(null);
			},
			onFrame: (dt) => {
				for (const p of placements) {
					p.mixer?.update(dt);
					p.idle?.update(dt);
				}
			},
			onEnd: () => {
				xrSession = null;
				estimatedLight?.dispose();
				estimatedLight = null;
				document.body.classList.remove('is-xr', 'xr-has-floor');
				xrBtn.classList.remove('is-active');
				xrBtn.setAttribute('aria-pressed', 'false');
				// Ground anything the session placed mid-air back onto the floor
				// plane so the fallback layout stays coherent, then resume our loop.
				for (const p of placements) {
					p.group.position.y = 0;
					if (p.shadow) {
						p.shadow.visible = true;
						p.shadow.position.set(p.group.position.x, 0.004, p.group.position.z);
					}
				}
				grid.visible = true;
				if (!arActive) scene.fog = previewFog;
				saveScene();
				startLoop();
				setStatus('Back to the studio view.');
			},
		});
		stopLoop();
		await session.start();
		xrSession = session;
		// Real-world lighting + reflections: replaces the baked hemi/sun with the
		// room's actual light the moment the device starts estimating it. Created
		// after start() so the addon's sessionstart listener requests the probe.
		estimatedLight = new EstimatedLighting({
			renderer,
			scene,
			baseLights: [hemi, sun],
			onChange: (on) => {
				if (on) setStatus('Lit by your room — reflections and shadows match the real light.');
			},
		});
		estimatedLight.start();
		document.body.classList.add('is-xr');
		grid.visible = false;
		scene.fog = null;
		selRing.visible = false;
		for (const p of placements) {
			if (p.shadow) p.shadow.visible = false;
		}
		xrBtn.classList.add('is-active');
		xrBtn.setAttribute('aria-pressed', 'true');
		setStatus('Point at the floor, then tap to place. Every tap adds another model.');
	} catch (err) {
		log.warn('XR session failed', err);
		estimatedLight?.dispose();
		estimatedLight = null;
		startLoop();
		setStatus('Couldn’t start immersive AR on this device. Camera mode still works.', { warn: true });
	} finally {
		arTransitioning = false;
	}
});

// ── Photo + QR handoff ────────────────────────────────────────────────────────
photoBtn?.addEventListener('click', async () => {
	renderer.render(scene, camera); // fresh pixels under preserveDrawingBuffer
	const blob = await captureComposite({ canvas, video: videoEl, isAR: arActive });
	if (!blob) {
		setStatus('Couldn’t capture the frame.', { warn: true });
		return;
	}
	await shareOrDownload(blob, { filename: 'three-ws-ar-studio.png', title: 'AR Studio · three.ws' });
});

qrBtn?.addEventListener('click', () => {
	if (!qrModal) return;
	const url = studioSceneUrl('https://three.ws', placements.map((p) => ({
		src: p.src,
		title: p.title,
		x: p.group.position.x,
		z: p.group.position.z,
		yaw: p.yaw,
		scale: logicalScale(p),
	})));
	const box = $('ars-qr-box');
	if (box) {
		try {
			box.innerHTML = renderQRToSVG(url, { scale: 6, margin: 2, dark: '#0b0b0b', light: '#ffffff' });
		} catch {
			// Arrangement hash too dense for the encoder → a models-only QR still
			// beats a wall of text (the full link below keeps the arrangement).
			try {
				box.innerHTML = renderQRToSVG(studioShareUrl('https://three.ws', placements), {
					scale: 6, margin: 2, dark: '#0b0b0b', light: '#ffffff',
				});
			} catch {
				box.textContent = url;
			}
		}
	}
	const link = $('ars-qr-link');
	if (link) {
		link.href = url;
		link.textContent = url.length > 64 ? `${url.slice(0, 61)}…` : url;
	}
	qrModal.hidden = false;
	// aria-modal="true" is a promise that focus is inside the dialog; leaving it
	// on the trigger reads the HUD behind instead of the QR code.
	$('ars-qr-close')?.focus?.();
});
$('ars-qr-close')?.addEventListener('click', closeQrModal);
qrModal?.addEventListener('click', (e) => {
	if (e.target === qrModal) closeQrModal();
});

// ── Render loop ───────────────────────────────────────────────────────────────
let rafId = null;
let prevT = 0;

function tick(t) {
	rafId = requestAnimationFrame(tick);
	const dt = prevT ? Math.min(0.1, (t - prevT) / 1000) : 0.016;
	prevT = t;

	for (const p of placements) {
		p.mixer?.update(dt);
		p.idle?.update(dt);
		if (p.spawnT < 1) {
			p.spawnT = Math.min(1, p.spawnT + dt * 3.2);
			const e = 1 - (1 - p.spawnT) ** 3; // ease-out cubic
			const target = p.group.userData._targetScale ?? 1;
			p.group.scale.setScalar(Math.max(0.001, target * e));
			p.shadow?.scale.setScalar(Math.max(0.001, target * e));
		}
	}
	if (selected) positionSelRing();
	applyCameraLook();
	renderer.render(scene, camera);
}

function startLoop() {
	if (rafId === null) {
		prevT = 0;
		rafId = requestAnimationFrame(tick);
	}
}

function stopLoop() {
	if (rafId !== null) {
		cancelAnimationFrame(rafId);
		rafId = null;
	}
}

// ── Resize / lifecycle ────────────────────────────────────────────────────────
window.addEventListener('resize', () => {
	renderer.setSize(window.innerWidth, window.innerHeight);
	camera.aspect = window.innerWidth / window.innerHeight;
	camera.updateProjectionMatrix();
	applyCameraFov();
});

window.addEventListener('pagehide', () => {
	stopCamera();
	xrSession?.end();
	net?.destroy();
});

// ── Boot ──────────────────────────────────────────────────────────────────────
updateCount();
updateRoomButton();
startLoop();
{
	let bootRoom = '';
	try { bootRoom = normalizeRoomCode(new URLSearchParams(location.search).get('room') || ''); } catch {}
	// Arriving via a ?room= link: the shared room is the scene, so skip the local
	// restore and join straight in (no seed — I'm entering someone else's room).
	restoreScene({ skipLocal: !!bootRoom }).then(() => {
		if (bootRoom) joinRoom(bootRoom);
	});
}

// Read-only introspection hook, enabled only with ?e2e=1 — used by the shared-
// room sync test to observe remote model transforms. Never present in normal use.
try {
	if (new URLSearchParams(location.search).has('e2e')) {
		window.__arsDebug = {
			count: () => placements.length,
			netStatus: () => net?.status ?? 'none',
			netIds: () => placements.map((p) => p.netId),
			remoteX: () => {
				const p = placements.find((x) => x.remote && !isMine(x));
				return p ? p.group.position.x : null;
			},
		};
	}
} catch {}

// Mobile: lead with the camera (one tap, inside a user gesture via the empty
// state CTA). Desktop: preview + QR chip.
const isTouch = window.matchMedia?.('(pointer: coarse)').matches;
if (!isTouch && qrBtn) qrBtn.hidden = false;
$('ars-empty-camera')?.addEventListener('click', startCamera);
$('ars-empty-add')?.addEventListener('click', () => openTray('community'));
$('ars-empty-forge')?.addEventListener('click', () => forgeInput?.focus());
