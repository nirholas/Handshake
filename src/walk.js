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
	Timer,
	Color,
	CylinderGeometry,
	DirectionalLight,
	DoubleSide,
	Group,
	HemisphereLight,
	Mesh,
	MeshBasicMaterial,
	MeshStandardMaterial,
	OrthographicCamera,
	PCFShadowMap,
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
import { getMeshoptDecoder } from './viewer/internal.js';
import nipplejs from 'nipplejs';

import { AnimationManager } from './animation-manager.js';
import { AccessoryManager } from './agent-accessories.js';
import { WalkGestures, GESTURE_ORDER } from './walk-gestures.js';
import { WalkVoiceChat } from './walk-voice-chat.js';
import { WalkNet } from './walk-net.js';
import { applyLoadout } from './game/cosmetics-loadout.js';
import { getPlayCosmetics } from './game/play-handoff.js';
import { getPresenceTicket, friendsClient } from './friends.js';
import { FriendsPanel } from './game/friends-panel.js';
import { PhysicsWorld } from './physics/physics-world.js';
import { createTerrain } from './game/terrain.js';
import {
	fetchEnvironmentManifest,
	resolveEnvName,
	getEnvironment,
	loadEnvironmentScenery,
	loadEnvironmentHDR,
	applyLighting,
	applySky,
	skyFadeColor,
	terrainColor as envTerrainColor,
} from './walk-environments.js';
import { log } from './shared/log.js';
import { createWalkTrails3D, createTrailSetting, TRAIL_STYLE_LABELS } from './walk-trails.js';
import { createWalkSession, showWelcomeBackToast } from './walk-session.js';
import { createWalkNpcs } from './walk-npcs.js';
import { createWalkWalletProximity } from './walk-wallet.js';
import { openAvatarInspector, isAvatarInspectorOpen, closeAvatarInspector } from './shared/avatar-inspector.js';
import { applyWorldNameplate } from './shared/living-avatar.js';
import { createWalkCapture } from './walk-capture.js';
import { createMarketplaceGallery } from './marketplace-gallery.js';
import { createAgentDeskManager, fetchLiveAgentDesks } from './walk-agent-desk.js';

// Walk-Browse: on /marketplace-walk the page boots with ?gallery=marketplace and
// the engine becomes a strollable 3D marketplace hall. See marketplace-gallery.js.
const GALLERY_MODE = new URLSearchParams(location.search).get('gallery') === 'marketplace';

const AVATAR_URL_DEFAULT = '/avatars/default.glb';

// The GLB URL the local avatar actually loaded from. Captured by resolveAvatarUrl
// so we can (a) broadcast it to the room — other clients render us as our real
// avatar — and (b) short-circuit remote avatar loads that match ours.
let resolvedAvatarUrl = AVATAR_URL_DEFAULT;

// The resolved avatar record (id, name, description, agent_id) from
// /api/avatars/<id>, captured by resolveAvatarUrl so the voice-chat layer can
// answer in the avatar's persona. Null for the default avatar or a direct URL.
let avatarMeta = null;

// When the page is opened as an avatar-editor draft preview
// (?avatar=<draftId>&preview=true), the unsaved appearance to apply on top of
// the base GLB once it loads. Stashed by resolveAvatarUrl, consumed in loadAvatar.
let pendingDraftAppearance = null;
// True for a draft preview — run solo (no multiplayer broadcast of a throwaway
// presigned URL) and skip the player's own equipped cosmetics so the creator
// sees exactly the look they're editing.
let isDraftPreview = false;

async function resolveAvatarUrl() {
	const params = new URLSearchParams(location.search);
	// A direct GLB/VRM URL wins — this is what the /communities lobby passes when
	// a guest drops in with a pasted model or a Ready Player Me link.
	const direct = params.get('avatarUrl');
	if (direct) {
		resolvedAvatarUrl = direct;
		return direct;
	}
	const id = params.get('avatar');
	if (!id) {
		resolvedAvatarUrl = AVATAR_URL_DEFAULT;
		return AVATAR_URL_DEFAULT;
	}
	// Editor draft preview: resolve the unsaved look through the draft endpoint —
	// the base (unbaked) GLB plus an appearance overlay we apply client-side.
	if (params.get('preview') === 'true' || params.get('preview') === '1') {
		isDraftPreview = true;
		const dres = await fetch(`/api/avatars/draft/${encodeURIComponent(id)}`);
		if (!dres.ok) throw new Error(`draft ${id} not found (HTTP ${dres.status})`);
		const { draft } = await dres.json();
		if (!draft?.base_model_url) throw new Error(`draft ${id} has no model URL`);
		pendingDraftAppearance = draft.appearance || null;
		resolvedAvatarUrl = draft.base_model_url;
		return draft.base_model_url;
	}
	const res = await fetch(`/api/avatars/${encodeURIComponent(id)}`);
	if (!res.ok) throw new Error(`avatar ${id} not found (HTTP ${res.status})`);
	const { avatar } = await res.json();
	if (!avatar?.url) throw new Error(`avatar ${id} has no GLB URL`);
	avatarMeta = avatar;
	resolvedAvatarUrl = avatar.url;
	return avatar.url;
}

// ── Coin community context ────────────────────────────────────────────────
// /walk doubles as the renderer for coin community worlds. When the lobby
// hands off with ?coin=<mint>&coinName=…&coinSymbol=…&coinImage=…, every player
// who entered the same coin shares one room instance (matchmaking key on the
// server) and the world is themed with the coin's identity (HUD + 3D totem).
const COIN_PARAMS = (() => {
	const p = new URLSearchParams(location.search);
	const mint = (p.get('coin') || '').trim();
	const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
	if (!MINT_RE.test(mint))
		return { coin: '', name: '', symbol: '', image: '', agent: (p.get('agent') || '').trim() };
	return {
		coin: mint,
		name: (p.get('coinName') || '').slice(0, 48),
		symbol: (p.get('coinSymbol') || '').slice(0, 16),
		image: (p.get('coinImage') || '').slice(0, 1024),
		agent: (p.get('agent') || '').trim(),
	};
})();

const ANIMATIONS_MANIFEST_URL = '/animations/manifest.json';
const CLIP_IDLE = 'idle';
const CLIP_WALK = 'av-walk-feminine';
const CLIP_RUN = 'av-walk-feminine'; // no separate run clip; timeScale handles pace difference

const WALK_SPEED = 1.6; // m/s — target ground speed in walk mode
const RUN_SPEED = 4.0; // m/s — target ground speed in run mode
// Natural ground speed of the Mixamo clips at timeScale=1, in m/s. Measured
// from the clip cadence (root-bone delta per cycle ÷ cycle duration on the
// canonical Avaturn rig). We rescale the mixer's timeScale by
// actualSpeed / NATURAL_* so foot-plants line up with translation — kills
// the "skating" artifact that shows when clip cadence != translation speed.
const NATURAL_WALK_SPEED = 1.5;
const NATURAL_RUN_SPEED = 3.4;
const TURN_LERP = 0.18; // 0..1 — how snappy avatar facing follows movement
const CAM_LERP = 0.12; // 0..1 — how snappy follow-camera trails the avatar
// Procedural body lean — pitch the avatar slightly forward when moving so
// the silhouette communicates weight transfer instead of looking like the
// torso is being slid along on rails. Radians, ramped by speed fraction.
const LEAN_WALK_RAD = 0.05;
const LEAN_RUN_RAD = 0.13;
const LEAN_LERP = 0.12;
const CAM_OFFSET = new Vector3(0, 1.85, 3.6); // behind-and-above, relative to avatar yaw
const CAM_LOOK_OFFSET = new Vector3(0, 1.1, 0);
const GROUND_RADIUS = 12;
// Right-hand "look" stick — radians/sec the camera rotates at full deflection.
// Signs mirror the canvas drag-orbit handler so push-right turns right and
// push-up tilts the view up.
const LOOK_YAW_SPEED = 2.6;
const LOOK_PITCH_SPEED = 1.9;

// ── DOM ───────────────────────────────────────────────────────────────────
const stage = document.getElementById('walk-stage');
const canvas = document.getElementById('walk-canvas');
const video = document.getElementById('walk-camera-feed');
const joystickEl = document.getElementById('walk-joystick');
const lookJoystickEl = document.getElementById('walk-look-joystick');
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
	return (
		params.get('name') ||
		(typeof localStorage !== 'undefined' && localStorage.getItem(NAME_STORAGE_KEY)) ||
		''
	);
}
function storeName(name) {
	try {
		localStorage.setItem(NAME_STORAGE_KEY, name);
	} catch {}
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
		if (e.key === 'Enter') {
			nameInput.blur();
		}
	});
}

// ── Help toggle ──────────────────────────────────────────────────────────
const helpEl = document.getElementById('walk-help');
let helpAutoHideTimer = null;
if (helpToggleBtn) {
	helpToggleBtn.addEventListener('click', () => {
		toggleHelp();
		// Also hide the small hints if showing the full overlay
		if (helpEl && helpAutoHideTimer) {
			clearTimeout(helpAutoHideTimer);
			helpAutoHideTimer = null;
		}
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
		if (friendsPanelOpen) closeFriendsPanel();
		if (gestures?.isWheelOpen()) gestures.closeWheel();
	} else {
		document.body.classList.remove('zen-revealed');
	}
	if (zenBtn) zenBtn.setAttribute('aria-pressed', String(on));
	try {
		localStorage.setItem(ZEN_STORAGE_KEY, on ? '1' : '0');
	} catch {}
}
function toggleZen() {
	setZen(!zenActive);
}
if (zenBtn) zenBtn.addEventListener('click', toggleZen);
if (zenExitBtn) zenExitBtn.addEventListener('click', () => setZen(false));

// ── HUD button handlers for new features ─────────────────────────────────
if (cameraModeBtn) cameraModeBtn.addEventListener('click', () => cycleCameraMode());
if (envBtn) {
	envBtn.setAttribute('aria-haspopup', 'listbox');
	envBtn.setAttribute('aria-expanded', 'false');
	envBtn.addEventListener('click', () => toggleEnvPicker());
}
if (screenshotBtn) screenshotBtn.addEventListener('click', () => walkCapture.screenshot());
if (minimapBtn) minimapBtn.addEventListener('click', () => toggleMinimap());

// ── On-screen touch action cluster (mobile) ──────────────────────────────
// jump / camera flip / gestures for thumbs — keyboardless devices can't reach
// Space, C, or G. The gesture button is wired by WalkGestures.attachTouchButton
// (tap = open the wheel, long-press = aim-and-release) once gestures are ready.
document.getElementById('walk-touch-jump')?.addEventListener('click', () => triggerJump());
document.getElementById('walk-touch-camera')?.addEventListener('click', () => cycleCameraMode());

// ── Friends panel (Task 15) ───────────────────────────────────────────────
const friendsOverlay = document.getElementById('walk-friends-overlay');
const friendsBody = document.getElementById('walk-friends-body');
const friendsCloseBtn = document.getElementById('walk-friends-close');
const friendsHudBtn = document.getElementById('walk-friends-btn');
const friendsBadgeEl = document.getElementById('walk-friends-badge');

let _friendsPanel = null;
let friendsPanelOpen = false;

function openFriendsPanel() {
	if (friendsPanelOpen) return;
	friendsPanelOpen = true;
	if (friendsOverlay) {
		friendsOverlay.removeAttribute('hidden');
		// Trigger animation on next frame so the CSS transition fires.
		requestAnimationFrame(() => friendsOverlay.classList.add('is-open'));
	}
	if (friendsHudBtn) friendsHudBtn.setAttribute('aria-pressed', 'true');
	// Lazy-init the panel instance.
	if (!_friendsPanel && friendsBody) {
		_friendsPanel = new FriendsPanel(friendsBody, { walkMode: true });
	}
	_friendsPanel?.mount();
}

function closeFriendsPanel() {
	if (!friendsPanelOpen) return;
	friendsPanelOpen = false;
	if (friendsOverlay) {
		friendsOverlay.classList.remove('is-open');
		// Hide after transition so aria-hidden doesn't cut off the close anim.
		const onEnd = () => {
			friendsOverlay.setAttribute('hidden', '');
			friendsOverlay.removeEventListener('transitionend', onEnd);
		};
		friendsOverlay.addEventListener('transitionend', onEnd);
	}
	if (friendsHudBtn) friendsHudBtn.setAttribute('aria-pressed', 'false');
	_friendsPanel?.unmount();
}

function toggleFriendsPanel() {
	if (friendsPanelOpen) closeFriendsPanel();
	else openFriendsPanel();
}

if (friendsHudBtn) friendsHudBtn.addEventListener('click', toggleFriendsPanel);
if (friendsCloseBtn) friendsCloseBtn.addEventListener('click', closeFriendsPanel);

// Deep link from a DM notification: /walk?dm=<friendId> opens the panel
// straight into that thread instead of the friend list.
const _dmDeepLink = new URLSearchParams(location.search).get('dm');
if (_dmDeepLink) {
	openFriendsPanel();
	_friendsPanel?.client?.openThread?.(_dmDeepLink);
}

// Close on backdrop click.
if (friendsOverlay) {
	friendsOverlay.addEventListener('pointerdown', (e) => {
		if (e.target === friendsOverlay) closeFriendsPanel();
	});
}

// Keep HUD unread badge live — start a background load immediately so the
// badge appears before the user opens the panel for the first time.
const _fc = friendsClient();
_fc.subscribe(() => {
	const n = _fc.totalUnread;
	if (friendsBadgeEl) {
		friendsBadgeEl.textContent = n > 9 ? '9+' : String(n);
		friendsBadgeEl.hidden = n <= 0;
	}
	if (friendsHudBtn) friendsHudBtn.classList.toggle('walk-friends-btn--alert', n > 0);
});
_fc.refresh(); // seed unread counts without blocking the page

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
function esc(s) {
	return String(s).replace(
		/[<>&"']/g,
		(c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[c],
	);
}

// ── Renderer / scene ──────────────────────────────────────────────────────
// preserveDrawingBuffer is required so the canvas pixels remain readable for
// the "Record" feature — without it, drawImage(renderer.domElement, …) into
// the offscreen compositor canvas returns blank pixels after the next paint.
const renderer = new WebGLRenderer({
	canvas,
	antialias: true,
	alpha: true,
	preserveDrawingBuffer: true,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = PCFShadowMap;

const scene = new Scene();

const pmrem = new PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
// The neutral room IBL — restored for environments that ship no HDR (the void).
const defaultEnvTexture = scene.environment;

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
// The flat disc is kept only as the AR shadow backing; the rolling heightfield
// terrain below supersedes it as the visible, walkable ground in non-AR mode.
groundOpaque.visible = false;

// Procedural heightfield terrain — the single source of truth for ground shape.
// Its column-major height buffer feeds both this mesh and the Rapier heightfield
// collider (see initWalkPhysics), so the surface you see is the surface you walk.
// `let`, not `const`: each environment regenerates the heightfield with its own
// amplitude/tint/seed (flat indoors, rolling outdoors). Closures that read
// `terrain.*` pick up the new instance because they close over the binding.
let terrain = createTerrain({ color: 0x202833 });
scene.add(terrain.mesh);

// ── Walk path visualization (Task 36) ─────────────────────────────────────
// A footstep / glow / line trail painted behind the avatar. The style choice is
// persisted with the same namespaced-key convention as zen/camera-mode/haptics.
// The system itself is built once the avatar loads (so its accent is known); the
// setting is created up-front so the help-overlay control can render immediately.
const TRAIL_KEY = 'walk:trail-style';
const trailSetting = createTrailSetting(TRAIL_KEY, 'footprints');
/** @type {ReturnType<typeof createWalkTrails3D>|null} */
let trails = null;

// ── NPC companions (Task 19) ───────────────────────────────────────────────
// A small cast of autonomous companions — a greeter, a wanderer, and a guide —
// that make each environment feel inhabited. Built once the avatar + animation
// clips load (so NPCs share the resolved clip library), spawned/despawned per
// environment with its own dialogue table, and ticked in the render loop. The
// on/off choice is persisted with the same namespaced-key convention as the
// other walk settings, and the toggle lives in the controls overlay.
const NPC_KEY = 'walk:npcs';
let npcsEnabled = (() => {
	try {
		return localStorage.getItem(NPC_KEY) !== '0';
	} catch {
		return true;
	}
})();
/** @type {ReturnType<typeof createWalkNpcs>|null} */
let walkNpcs = null;

/** @type {ReturnType<typeof createAgentDeskManager>|null} */
let walkAgentDesks = null;

// Avatar accent → trail colour. The walk avatar is a raw GLB, so we read any
// authored meta accent (gltf.userData / scene.userData), else fall back to the
// brand --accent token (handled inside the trail system).
function avatarAccent() {
	const m = avatar?.userData?.meta || avatar?.userData || avatarTemplate?.userData || null;
	const a = m?.accent;
	return typeof a === 'string' || typeof a === 'number' ? a : null;
}

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
	new MeshBasicMaterial({
		map: new CanvasTexture(_blobCanvas),
		transparent: true,
		depthWrite: false,
		opacity: 0,
	}),
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

let cameraYaw = 0; // user-controlled orbit yaw around avatar (radians)
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
const CAMERA_MODE_LABELS = {
	follow: 'Follow',
	cinematic: 'Cinematic',
	firstperson: 'First Person',
	topdown: 'Top Down',
};
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

// Hot-path scratch — computeCameraForMode runs every frame; reuse these instead
// of allocating fresh Vector3s per call. _RIGHT is the world +X (pitch) axis;
// upY (the world +Y / yaw axis, defined below) is reused for the yaw rotation.
const _RIGHT = new Vector3(1, 0, 0);
const _camPos = new Vector3();
const _camLook = new Vector3();
const _camOffset = new Vector3();
const _camFpForward = new Vector3();
const _camResult = { pos: _camPos, look: _camLook };

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
	try {
		localStorage.setItem(CAMERA_MODE_KEY, mode);
	} catch {}
	updateCameraModeIndicator();
	walkSession?.save();
}

function cycleCameraMode() {
	const idx = CAMERA_MODES.indexOf(cameraMode);
	setCameraMode(CAMERA_MODES[(idx + 1) % CAMERA_MODES.length]);
	setStatus(`Camera: ${CAMERA_MODE_LABELS[cameraMode]}`);
	haptics.buzz(5);
}

// Camera mode indicator UI element
const cameraModeIndicator = (() => {
	const el = document.createElement('div');
	el.id = 'walk-camera-mode';
	el.setAttribute('role', 'status');
	el.style.cssText = [
		'position:fixed',
		'z-index:6',
		'left:50%',
		'top:calc(env(safe-area-inset-top, 0) + 60px)',
		'transform:translateX(-50%)',
		'background:rgba(17,17,17,0.72)',
		'border:1px solid rgba(255,255,255,0.08)',
		'border-radius:999px',
		'padding:5px 14px',
		'font-size:11px',
		'font-weight:500',
		'color:rgba(255,255,255,0.7)',
		'backdrop-filter:blur(10px)',
		'-webkit-backdrop-filter:blur(10px)',
		'pointer-events:none',
		'opacity:0',
		'transition:opacity 0.25s ease',
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
// Returns a shared scratch { pos, look } — the caller must read/copy the values
// in the same frame and must not retain the reference across frames.
function computeCameraForMode(mode, avatarPos, avatarHeight) {
	const pos = _camPos;
	const look = _camLook;
	if (mode === 'follow') {
		const offset = _camOffset.copy(CAM_OFFSET).multiplyScalar(camZoom);
		offset.applyAxisAngle(_RIGHT, -cameraPitch);
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
		const fpForward = _camFpForward.set(Math.sin(avatarYaw), 0, Math.cos(avatarYaw));
		look.copy(pos).add(fpForward.multiplyScalar(5));
		look.y -= 0.15; // slight downward gaze
	} else if (mode === 'topdown') {
		pos.set(avatarPos.x, avatarPos.y + TOPDOWN_HEIGHT, avatarPos.z + 0.01);
		look.copy(avatarPos);
	}
	return _camResult;
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

// ── Canvas camera control — one-finger drag orbits, two-finger pinch zooms ──
// Multi-touch aware via a live pointer map: the joystick(s) and the camera can
// be driven at the same time because pointers that land inside a stick zone are
// never tracked here. A single tracked pointer orbits; a second promotes the
// gesture to pinch-zoom; lifting back to one resumes orbit seamlessly.
{
	const pointers = new Map(); // pointerId → { x, y }
	let orbitId = -1;
	let pinchDist = 0;

	const inRect = (el, x, y) => {
		if (!el) return false;
		const r = el.getBoundingClientRect();
		return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
	};
	const pinchDistance = () => {
		const [a, b] = [...pointers.values()];
		return Math.hypot(a.x - b.x, a.y - b.y);
	};

	canvas.addEventListener('pointerdown', (e) => {
		// Pointers belonging to a stick zone are owned by nipplejs — capturing
		// them here would redirect its move stream and break movement.
		if (
			inRect(joystickEl, e.clientX, e.clientY) ||
			inRect(lookJoystickEl, e.clientX, e.clientY)
		)
			return;

		pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
		try {
			canvas.setPointerCapture?.(e.pointerId);
		} catch {}

		if (pointers.size === 1) {
			orbitId = e.pointerId;
		} else if (pointers.size === 2) {
			orbitId = -1; // suspend orbit while pinching
			pinchDist = pinchDistance();
		}
	});

	const onMove = (e) => {
		const p = pointers.get(e.pointerId);
		if (!p) return;
		const dx = e.clientX - p.x;
		const dy = e.clientY - p.y;
		p.x = e.clientX;
		p.y = e.clientY;

		if (pointers.size >= 2) {
			// Pinch: spreading fingers (distance grows) zooms in (camZoom down).
			const dist = pinchDistance();
			camZoom = Math.max(
				CAM_ZOOM_MIN,
				Math.min(CAM_ZOOM_MAX, camZoom - (dist - pinchDist) * 0.005),
			);
			pinchDist = dist;
		} else if (e.pointerId === orbitId) {
			cameraYaw -= dx * 0.005;
			cameraPitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, cameraPitch - dy * 0.0035));
		}
	};

	const onUp = (e) => {
		if (!pointers.has(e.pointerId)) return;
		pointers.delete(e.pointerId);
		try {
			canvas.releasePointerCapture?.(e.pointerId);
		} catch {}
		// Dropping from pinch back to a single finger resumes orbit with it.
		if (pointers.size === 1) {
			orbitId = [...pointers.keys()][0];
		} else if (pointers.size === 0) {
			orbitId = -1;
		}
	};

	canvas.addEventListener('pointermove', onMove);
	canvas.addEventListener('pointerup', onUp);
	canvas.addEventListener('pointercancel', onUp);
}

// ── Input state — combined keyboard + joystick → unit move vector ────────
const input = {
	keys: { forward: 0, back: 0, left: 0, right: 0, run: false },
	joy: { x: 0, y: 0, active: false },
	look: { x: 0, y: 0, active: false },
};

// ── Haptics ─────────────────────────────────────────────────────────────
// Tactile feedback on touch actions. Default on, persisted, and silently a
// no-op where the Vibration API is absent (every desktop, iOS Safari) so call
// sites never have to guard. Toggleable from the controls overlay.
const haptics = (() => {
	const KEY = 'walk:haptics';
	const supported = typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
	let enabled = true;
	try {
		enabled = localStorage.getItem(KEY) !== '0';
	} catch {}
	return {
		get supported() {
			return supported;
		},
		get enabled() {
			return enabled;
		},
		set(on) {
			enabled = !!on;
			try {
				localStorage.setItem(KEY, enabled ? '1' : '0');
			} catch {}
		},
		buzz(ms) {
			if (!enabled || !supported) return;
			try {
				navigator.vibrate(ms);
			} catch {}
		},
	};
})();

// ── Jump state ────────────────────────────────────────────────────────────
let jumpVelocity = 0;
let jumpActive = false;
const JUMP_FORCE = 5.8;
const GRAVITY = -14;
const GROUND_Y = 0;

// ── Physics ────────────────────────────────────────────────────────────────
// A real Rapier solver drives roaming when available (non-AR). Until the WASM
// runtime finishes loading — and in AR, where the avatar floats in the room —
// movement falls back to the legacy direct-mutation path below.
let physics = null;
let physicsReady = false;
let character = null;
let verticalVel = 0; // m/s — integrated vertical velocity for the physics path
let characterGrounded = true;
let physicsActivePrev = false; // rising-edge guard to resync after AR/legacy

function triggerJump() {
	// Physics path: only launch when actually standing on something.
	if (physicsReady && character && !arActive) {
		if (characterGrounded) {
			verticalVel = JUMP_FORCE;
			haptics.buzz(10);
		}
		return;
	}
	// Legacy parabola (AR / pre-physics).
	if (jumpActive) return;
	jumpActive = true;
	jumpVelocity = JUMP_FORCE;
	haptics.buzz(10);
}

// ── Snap-turn (Q / E) ────────────────────────────────────────────────────
const SNAP_TURN_RAD = Math.PI / 4; // 45°

// ── Scroll-wheel zoom ────────────────────────────────────────────────────
canvas.addEventListener(
	'wheel',
	(e) => {
		e.preventDefault();
		camZoom = Math.max(CAM_ZOOM_MIN, Math.min(CAM_ZOOM_MAX, camZoom + e.deltaY * 0.001));
	},
	{ passive: false },
);

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
	// The overlay is pointer-events:none at ALL times, including while shown.
	// It's a read-only info panel with no interactive controls, and on tall /
	// portrait viewports its card overlaps the bottom joysticks — a capturing
	// overlay (even at opacity:0) silently eats every joystick / canvas touch
	// and makes the controls feel dead. Dismissal is handled entirely by the
	// window-level pointerdown listener below plus H / Esc, so the panel never
	// needs to capture and the sticks underneath always stay live.
	el.style.cssText = [
		'position:fixed',
		'inset:0',
		'z-index:9999',
		'display:flex',
		'align-items:center',
		'justify-content:center',
		'background:rgba(0,0,0,0.72)',
		'backdrop-filter:blur(6px)',
		'color:#fff',
		'font-family:system-ui,sans-serif',
		'opacity:0',
		'pointer-events:none',
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
				<tr><td style="color:#aaa;padding-right:16px">R</td><td>Record a clip (up to 10s)</td></tr>
				<tr><td style="color:#aaa;padding-right:16px">M</td><td>Toggle minimap</td></tr>
				<tr><td style="color:#aaa;padding-right:16px">Z</td><td>Hide UI (scene + joystick only)</td></tr>
				<tr><td style="color:#aaa;padding-right:16px">H / ?</td><td>Toggle this overlay</td></tr>
				<tr><td style="color:#aaa;padding-right:16px">Left / right stick</td><td>Move &middot; look (touch)</td></tr>
				<tr><td style="color:#aaa;padding-right:16px">Mouse drag</td><td>Orbit camera</td></tr>
				<tr><td style="color:#aaa;padding-right:16px">Scroll / pinch</td><td>Zoom in / out</td></tr>
				<tr><td style="color:#aaa;padding-right:16px">Esc</td><td>Close overlay / release pointer</td></tr>
			</table>
			${
				haptics.supported
					? `
			<div style="margin:18px 0 0;padding-top:16px;border-top:1px solid rgba(255,255,255,0.1);display:flex;align-items:center;justify-content:space-between" data-help-keep>
				<span style="font-size:14px">Haptics</span>
				<button type="button" id="walk-haptics-toggle" role="switch" data-help-keep
					aria-checked="${haptics.enabled}"
					style="appearance:none;border:1px solid rgba(255,255,255,0.2);background:${haptics.enabled ? 'var(--accent,#7c5cff)' : 'rgba(255,255,255,0.08)'};color:#fff;border-radius:999px;padding:5px 14px;font:inherit;font-size:13px;cursor:pointer">
					${haptics.enabled ? 'On' : 'Off'}
				</button>
			</div>`
					: ''
			}
			<div style="margin:14px 0 0;padding-top:14px;border-top:1px solid rgba(255,255,255,0.1);display:flex;align-items:center;justify-content:space-between" data-help-keep>
				<span style="font-size:14px">Path trail</span>
				<button type="button" id="walk-trail-toggle" data-help-keep
					aria-label="Cycle path trail style"
					style="appearance:none;border:1px solid rgba(255,255,255,0.2);background:${trailSetting.get() === 'off' ? 'rgba(255,255,255,0.08)' : 'var(--accent,#7c5cff)'};color:#fff;border-radius:999px;padding:5px 14px;font:inherit;font-size:13px;cursor:pointer">
					${TRAIL_STYLE_LABELS[trailSetting.get()]}
				</button>
			</div>
			<div style="margin:14px 0 0;padding-top:14px;border-top:1px solid rgba(255,255,255,0.1);display:flex;align-items:center;justify-content:space-between" data-help-keep>
				<span style="font-size:14px">NPC companions</span>
				<button type="button" id="walk-npc-toggle" role="switch" data-help-keep
					aria-checked="${npcsEnabled}"
					style="appearance:none;border:1px solid rgba(255,255,255,0.2);background:${npcsEnabled ? 'var(--accent,#7c5cff)' : 'rgba(255,255,255,0.08)'};color:#fff;border-radius:999px;padding:5px 14px;font:inherit;font-size:13px;cursor:pointer">
					${npcsEnabled ? 'On' : 'Off'}
				</button>
			</div>
			<p style="margin:20px 0 0;font-size:12px;color:#666">Click the canvas to lock the mouse for first-person look.</p>
		</div>`;
	document.body.appendChild(el);
	return el;
})();

// Haptics on/off switch lives in the controls overlay — keep its tap from
// bubbling up to the dismiss-on-any-pointer handler below.
const hapticsToggle = helpOverlay.querySelector('#walk-haptics-toggle');
if (hapticsToggle) {
	hapticsToggle.addEventListener('click', () => {
		haptics.set(!haptics.enabled);
		hapticsToggle.setAttribute('aria-checked', String(haptics.enabled));
		hapticsToggle.textContent = haptics.enabled ? 'On' : 'Off';
		hapticsToggle.style.background = haptics.enabled
			? 'var(--accent,#7c5cff)'
			: 'rgba(255,255,255,0.08)';
		haptics.buzz(8); // confirm the new setting with a tick
	});
}

// Path-trail style switch — cycles off → footprints → glow → line. Persisted via
// trailSetting; applied live to the trail system (which may not exist yet if the
// avatar is still loading — the new style is still persisted and read on build).
const trailToggle = helpOverlay.querySelector('#walk-trail-toggle');
if (trailToggle) {
	trailToggle.addEventListener('click', () => {
		const next = trailSetting.cycle();
		trails?.setStyle(next);
		trailToggle.textContent = TRAIL_STYLE_LABELS[next];
		trailToggle.style.background =
			next === 'off' ? 'rgba(255,255,255,0.08)' : 'var(--accent,#7c5cff)';
		setStatus(`Path trail: ${TRAIL_STYLE_LABELS[next]}`);
		haptics.buzz(6);
	});
}

// NPC companions on/off. Persisted; applied live — turning them on respawns the
// current environment's cast, turning them off despawns and releases every NPC.
const npcToggle = helpOverlay.querySelector('#walk-npc-toggle');
if (npcToggle) {
	npcToggle.addEventListener('click', () => {
		npcsEnabled = !npcsEnabled;
		try {
			localStorage.setItem(NPC_KEY, npcsEnabled ? '1' : '0');
		} catch {}
		npcToggle.setAttribute('aria-checked', String(npcsEnabled));
		npcToggle.textContent = npcsEnabled ? 'On' : 'Off';
		npcToggle.style.background = npcsEnabled
			? 'var(--accent,#7c5cff)'
			: 'rgba(255,255,255,0.08)';
		if (walkNpcs) {
			walkNpcs.setEnabled(npcsEnabled);
			if (npcsEnabled && walkManifest) {
				const meta = getEnvironment(walkManifest, currentEnvName);
				if (meta) applyNpcsForEnv(meta, envApplyToken);
			}
		}
		setStatus(`NPC companions: ${npcsEnabled ? 'on' : 'off'}`);
		haptics.buzz(6);
	});
}

let helpVisible = false;
function toggleHelp() {
	helpVisible = !helpVisible;
	helpOverlay.style.opacity = helpVisible ? '1' : '0';
	helpOverlay.setAttribute('aria-hidden', String(!helpVisible));
}
// Any pointer interaction dismisses the overlay. Capture phase + a
// non-blocking backdrop means the SAME tap that closes the panel also reaches
// the joystick underneath — so the first-visit help never costs the user a
// stalled touch. Controls tagged data-help-keep (the haptics switch) are
// exempt so toggling a setting doesn't slam the panel shut.
window.addEventListener(
	'pointerdown',
	(e) => {
		if (helpVisible && !e.target?.closest?.('[data-help-keep]')) toggleHelp();
	},
	true,
);

window.addEventListener('keydown', (e) => {
	if (e.target?.tagName === 'INPUT' || e.target?.tagName === 'TEXTAREA') return;
	if (e.target !== document.body && e.target !== canvas) return;
	switch (e.code) {
		case 'KeyW':
		case 'ArrowUp':
			input.keys.forward = 1;
			break;
		case 'KeyS':
		case 'ArrowDown':
			input.keys.back = 1;
			break;
		case 'KeyA':
		case 'ArrowLeft':
			input.keys.left = 1;
			break;
		case 'KeyD':
		case 'ArrowRight':
			input.keys.right = 1;
			break;
		case 'ShiftLeft':
		case 'ShiftRight':
			input.keys.run = true;
			break;
		case 'Space':
			e.preventDefault();
			triggerJump();
			break;
		case 'KeyQ':
			cameraYaw += SNAP_TURN_RAD;
			break;
		// 'E' kept for snap turn — environment cycles via 'V'
		case 'KeyE':
			cameraYaw -= SNAP_TURN_RAD;
			break;
		case 'KeyC':
			e.preventDefault();
			cycleCameraMode();
			break;
		case 'KeyG':
			e.preventDefault();
			gestures?.wheelKeyDown(e.repeat);
			break;
		case 'KeyT':
			// Push-to-talk: hold T to speak to the avatar. Ignore the auto-repeat
			// the OS fires while held — recording starts on the first press and
			// ends on keyup. (Enter still opens the text chat box.)
			e.preventDefault();
			if (!e.repeat) voiceChat?.startListening();
			break;
		case 'KeyV':
			e.preventDefault();
			cycleEnvironment();
			break;
		case 'KeyP':
			e.preventDefault();
			walkCapture.screenshot();
			break;
		case 'KeyR':
			e.preventDefault();
			walkCapture.toggleRecording();
			break;
		case 'KeyM':
			e.preventDefault();
			toggleMinimap();
			break;
		case 'KeyI':
			// Inspect the nearest player (or yourself): identity, reputation,
			// wallet. Press again to close.
			e.preventDefault();
			if (!e.repeat) inspectNearestPlayer();
			break;
		case 'KeyZ':
			e.preventDefault();
			toggleZen();
			break;
		case 'KeyF':
			e.preventDefault();
			toggleFriendsPanel();
			break;
		case 'KeyH':
			e.preventDefault();
			toggleHelp();
			break;
		case 'Slash':
			if (e.shiftKey) {
				e.preventDefault();
				toggleHelp();
			}
			break;
		case 'Escape':
			if (friendsPanelOpen) {
				closeFriendsPanel();
				break;
			}
			if (helpVisible) {
				toggleHelp();
				break;
			}
			if (gestures?.isWheelOpen()) {
				gestures.closeWheel();
				break;
			}
			if (zenActive) {
				setZen(false);
				break;
			}
			break;
		// Number keys 1-8 trigger the eight gestures directly.
		case 'Digit1':
			e.preventDefault();
			gestures?.play(GESTURE_ORDER[0]);
			break;
		case 'Digit2':
			e.preventDefault();
			gestures?.play(GESTURE_ORDER[1]);
			break;
		case 'Digit3':
			e.preventDefault();
			gestures?.play(GESTURE_ORDER[2]);
			break;
		case 'Digit4':
			e.preventDefault();
			gestures?.play(GESTURE_ORDER[3]);
			break;
		case 'Digit5':
			e.preventDefault();
			gestures?.play(GESTURE_ORDER[4]);
			break;
		case 'Digit6':
			e.preventDefault();
			gestures?.play(GESTURE_ORDER[5]);
			break;
		case 'Digit7':
			e.preventDefault();
			gestures?.play(GESTURE_ORDER[6]);
			break;
		case 'Digit8':
			e.preventDefault();
			gestures?.play(GESTURE_ORDER[7]);
			break;
		default:
			return;
	}
});
window.addEventListener('keyup', (e) => {
	switch (e.code) {
		case 'KeyW':
		case 'ArrowUp':
			input.keys.forward = 0;
			break;
		case 'KeyS':
		case 'ArrowDown':
			input.keys.back = 0;
			break;
		case 'KeyA':
		case 'ArrowLeft':
			input.keys.left = 0;
			break;
		case 'KeyD':
		case 'ArrowRight':
			input.keys.right = 0;
			break;
		case 'ShiftLeft':
		case 'ShiftRight':
			input.keys.run = false;
			break;
		case 'KeyG':
			gestures?.wheelKeyUp();
			break;
		case 'KeyT':
			// Release push-to-talk → transcribe + reply.
			voiceChat?.stopListening();
			break;
	}
});

// Clear all movement input when the window loses focus or the page is hidden
// so keys/joystick don't get stuck on (keyup events won't fire while unfocused).
function clearInput() {
	input.keys.forward = 0;
	input.keys.back = 0;
	input.keys.left = 0;
	input.keys.right = 0;
	input.keys.run = false;
	input.joy.x = 0;
	input.joy.y = 0;
	input.joy.active = false;
}
window.addEventListener('blur', clearInput);
document.addEventListener('visibilitychange', () => {
	if (document.visibilityState === 'hidden') clearInput();
});

// Touch devices and narrow viewports get the on-screen sticks + action
// cluster; wide pointer-fine screens drive everything from WASD + mouse-look.
const wantsTouchControls = (() => {
	if (typeof matchMedia !== 'function') return false;
	return matchMedia('(hover: none)').matches || matchMedia('(max-width: 640px)').matches;
})();

// Radial dead zone — nipplejs reports a vector the instant a thumb grazes the
// ring, which reads as drift. We swallow the inner `dead` fraction and remap
// the remainder to the full [0, 1] range so the stick still reaches max speed
// at the rim while staying dead-still for tiny touches.
const JOY_DEADZONE = 0.12;
function applyDeadzone(x, y, dead = JOY_DEADZONE) {
	const m = Math.hypot(x, y);
	if (m < dead) return { x: 0, y: 0, active: false };
	const scaled = (m - dead) / (1 - dead);
	const k = scaled / m;
	return { x: x * k, y: y * k, active: true };
}

const joystick = nipplejs.create({
	zone: joystickEl,
	// Floating on touch — the stick materializes wherever the left thumb lands
	// inside the zone (which spans the lower-left of the screen) and follows it,
	// so the user never has to look for a fixed pad. Static elsewhere.
	mode: wantsTouchControls ? 'dynamic' : 'static',
	position: { left: '50%', top: '50%' },
	size: 110,
	color: 'rgba(255,255,255,0.85)',
	restOpacity: 0.6,
});
joystick.on('move', (evt) => {
	// nipplejs v1 calls handlers with a single { type, target, data } event
	// object — the move payload lives on evt.data, not a second argument.
	const data = evt?.data;
	if (data?.vector) {
		// data.vector is the proportional stick displacement within the radius,
		// already in [-1, 1] per axis (magnitude ≤ 1). y is positive when the
		// stick is pushed UP — our forward direction.
		const d = applyDeadzone(data.vector.x, data.vector.y);
		input.joy.x = d.x;
		input.joy.y = d.y;
		input.joy.active = d.active;
	}
});
joystick.on('end', () => {
	input.joy.x = 0;
	input.joy.y = 0;
	input.joy.active = false;
});

// Right-hand "look" stick — drives the follow-camera yaw/pitch so touch users
// can turn the view with a thumb instead of fighting the avatar for the
// canvas. Only mounted where the desktop mouse-look affordances are hidden
// (touch / narrow viewports); on a wide pointer-fine screen the WASD + mouse
// controls own the camera and a second stick would just overlap the hints.
if (lookJoystickEl && wantsTouchControls) {
	const lookJoystick = nipplejs.create({
		zone: lookJoystickEl,
		mode: 'static',
		position: { left: '50%', top: '50%' },
		size: 110,
		color: 'rgba(255,255,255,0.85)',
		restOpacity: 0.6,
	});
	lookJoystick.on('move', (evt) => {
		// nipplejs v1 passes a single { type, target, data } event object.
		const data = evt?.data;
		if (!data?.vector) return;
		// data.vector already carries direction + magnitude in [-1, 1] per axis.
		const d = applyDeadzone(data.vector.x, data.vector.y);
		input.look.x = d.x;
		input.look.y = d.y;
		input.look.active = d.active;
	});
	lookJoystick.on('end', () => {
		input.look.x = 0;
		input.look.y = 0;
		input.look.active = false;
	});
}

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

// The local avatar's equipped cosmetic loadout (R23), carried across worlds via
// the cc-cosmetics mirror. `applyLoadout` returns a handle we tick each frame
// (props re-glue to the head, the aura spins) and dispose before re-applying.
let localCosmetics = null;
let _localCosWire = null;
function applyLocalCosmetics(wire) {
	const next = typeof wire === 'string' ? wire : '';
	if (localCosmetics && _localCosWire === next) return;
	_localCosWire = next;
	try {
		localCosmetics?.dispose();
	} catch {
		/* already gone */
	}
	localCosmetics = applyLoadout(avatarRig, avatarHeight || 1.7, next);
}

// three.ws avatars ship with EXT_meshopt_compression, so every GLTFLoader that
// loads one must have the meshopt decoder wired first — otherwise GLTFLoader
// throws "setMeshoptDecoder must be called before loading compressed files".
// Build the loader once and share it across the initial load, live avatar swaps,
// and remote-player templates (mirrors walk-embed.js's getAvatarLoader).
let _avatarLoaderPromise = null;
function getAvatarLoader() {
	if (!_avatarLoaderPromise) {
		_avatarLoaderPromise = getMeshoptDecoder().then((decoder) => {
			const loader = new GLTFLoader();
			loader.setMeshoptDecoder(decoder);
			return loader;
		});
	}
	return _avatarLoaderPromise;
}

async function loadAvatar() {
	setLoadingText('Resolving avatar...');
	const avatarUrl = await resolveAvatarUrl();
	// Record the booted avatar's URL so a session snapshot captures the current
	// avatar even before any in-page swap (id is already seeded from ?avatar).
	selectedAvatarUrl = avatarUrl;
	setLoadingText('Loading 3D model...');
	const loader = await getAvatarLoader();
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

	// Build the trail system now that the avatar (and its accent) and the terrain
	// ground both exist. Decals project onto terrain.mesh and orient to
	// terrain.normalAt, so the trail follows the rolling surface.
	trails = createWalkTrails3D({
		scene,
		ground: terrain,
		getColor: avatarAccent,
		initialStyle: trailSetting.get(),
	});

	// Editor draft preview: dress the base GLB in the unsaved appearance the
	// creator is editing (outfit, accessories, sculpt morphs, garment layers).
	// Shares the AccessoryManager the editor uses, so the look is pixel-identical.
	if (pendingDraftAppearance) {
		try {
			const draftAccessories = new AccessoryManager({ content: avatar, invalidate: () => {} });
			await draftAccessories.hydrateFromAppearance(pendingDraftAppearance);
		} catch (err) {
			log.warn('[walk] draft appearance apply failed:', err?.message);
		}
	}

	// Dress the local avatar in the loadout the player last equipped (R23). The
	// equipped fit is persisted to their account in /play and mirrored to the
	// cross-world cc-cosmetics store, so the same wardrobe rides into /walk. Reuses
	// the shared applyLoadout, so a hat or aura renders identically in both worlds.
	// Skipped in draft preview so the creator sees only the look they're editing.
	if (!isDraftPreview) applyLocalCosmetics(getPlayCosmetics());

	animationManager.attach(avatar);

	setLoadingText('Preparing animations...');
	const manifest = await fetch(ANIMATIONS_MANIFEST_URL, { cache: 'force-cache' }).then((r) => {
		if (!r.ok) throw new Error(`HTTP ${r.status} fetching animation manifest`);
		return r.json();
	});
	// Store the full manifest for emote tray population.
	_fullManifest = manifest;
	const needed = manifest.filter(
		(d) => d.name === CLIP_IDLE || d.name === CLIP_WALK || d.name === CLIP_RUN,
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
	setupGestures();

	// Stand up the NPC companion system now that the clip library is resolved.
	// initEnvironments() (which runs after the avatar boots) populates the first
	// world's NPCs via applyNpcsForEnv(); subsequent env swaps respawn them.
	walkNpcs = createWalkNpcs({
		scene,
		camera,
		renderer,
		getGroundY: (x, z) => (arActive ? GROUND_Y : terrain.heightAt(x, z)),
		animationDefs,
		ttsEnabled: true,
	});
	walkNpcs.setEnabled(npcsEnabled);

	// Stand up the agent desk system — desks show live agent screens in-world.
	// Fetches active agents from Redis and spawns one desk per active stream.
	walkAgentDesks = createAgentDeskManager({ scene, camera, renderer });
	fetchLiveAgentDesks().then((deskConfigs) => {
		if (deskConfigs.length) walkAgentDesks.spawn(deskConfigs);
	}).catch(() => {});

	// Auto-hide help hints after 5 seconds — fade first, then remove from layout
	// so the transition in temporary.html's #walk-help { transition: opacity } plays.
	if (helpEl) {
		helpAutoHideTimer = setTimeout(() => {
			helpEl.style.opacity = '0';
			helpAutoHideTimer = setTimeout(() => {
				helpEl.style.display = 'none';
				helpAutoHideTimer = null;
			}, 400);
		}, 5000);
	}
}

// Swap the live avatar to a different GLB. Shared by the in-page avatar picker and
// by session restore so both paths build, frame, animate, and broadcast the new
// avatar identically. Throws on load failure so callers can surface it.
async function applyAvatarSwap(url, id) {
	const loader = await getAvatarLoader();
	const gltf = await loader.loadAsync(url);
	if (avatar) avatarRig.remove(avatar);
	avatar = gltf.scene;
	avatarTemplate = gltf.scene;
	avatar.traverse((n) => {
		if (n.isMesh) {
			n.castShadow = true;
			n.receiveShadow = false;
		}
	});
	const box = new Box3().setFromObject(avatar);
	avatar.position.y -= box.min.y;
	avatarRig.add(avatar);
	const height = Math.max(0.5, box.max.y - box.min.y);
	avatarHeight = height;
	CAM_OFFSET.set(0, height * 1.05, height * 1.95);
	CAM_LOOK_OFFSET.set(0, height * 0.6, 0);
	if (cameraMode === 'firstperson') avatar.visible = false;
	animationManager.attach(avatar);
	animationManager.crossfadeTo(motionToClipName(currentMotion), 0);
	resolvedAvatarUrl = url;
	setSelectedAvatar(id, url);
	setWalkMetricsAvatarId(id);
	net?.sendAvatar(url, id || '');
}

// ── Gestures (Task 14) ─────────────────────────────────────────────────────
// The expressive emote system lives in src/walk-gestures.js: wave / dance / sit
// / point / cheer / agree / disagree / talking, driven through the animation
// state machine's gesture slot with additive upper-body blending so the avatar
// can wave while it walks. Built once the avatar + animation manifest are ready.
let _fullManifest = null;
/** @type {WalkGestures|null} */
let gestures = null;
/** @type {import('./walk-voice-chat.js').WalkVoiceChat|null} */
let voiceChat = null;

function setupGestures() {
	if (gestures || !emoteTrayEl) return;
	gestures = new WalkGestures({
		animationManager,
		getMotionClip: () => motionToClipName(currentMotion),
		// Replicate the gesture's clip to other players over the existing emote
		// channel — remote avatars render it full-body via _playRemoteEmote.
		broadcast: (clip) => {
			if (net) net.sendEmote(clip);
		},
		// Make each gesture clip loadable: register its def with the manager and
		// the shared manifest so remote players can resolve it too.
		registerDefs: (defs) => {
			for (const d of defs) {
				if (animationDefs && !animationDefs.some((x) => x.name === d.name))
					animationDefs.push(d);
				if (_fullManifest && !_fullManifest.some((x) => x.name === d.name))
					_fullManifest.push(d);
			}
			if (animationDefs) animationManager.setAnimationDefs(animationDefs);
		},
		haptics,
		host: document.body,
	});
	gestures.buildTray(emoteTrayEl);
	gestures.attachTouchButton(document.getElementById('walk-touch-gesture'));

	// Track the user's recent gestures for session persistence. Wrapping play()
	// here (rather than editing walk-gestures.js) records every user-initiated
	// gesture — wheel, tray, quick keys, programmatic — without touching the
	// gesture module. Remote echoes pass { silent: true } and are not recorded.
	const _origPlay = gestures.play.bind(gestures);
	gestures.play = (name, opts = {}) => {
		const ok = _origPlay(name, opts);
		if (ok && !opts.silent) recordRecentGesture(name);
		return ok;
	};

	// Programmatic API for the narrator / chat / TTS and embedding hosts.
	window.walk = window.walk || {};
	window.walk.playGesture = (name) => (gestures ? gestures.play(name) : false);
	window.walk.stopGesture = () => gestures?.stop();
	window.walk.setTalking = (on) => gestures?.setTalking(!!on);
	window.walk.gestures = () => [...GESTURE_ORDER];

	setupVoiceChat();

	// Let an embedding host trigger gestures: `postMessage({ type:'walk:gesture', gesture })`.
	window.addEventListener('message', (e) => {
		const d = e.data;
		if (
			d &&
			typeof d === 'object' &&
			d.type === 'walk:gesture' &&
			typeof d.gesture === 'string'
		) {
			gestures?.play(d.gesture);
		}
	});
}

// Two-way voice chat (push-to-talk). Wires the WalkVoiceChat controller to the
// page's avatar, persona, speech bubble, chat log, talking overlay, and the
// multiplayer chat channel — then exposes walk.say(text, { voice, gesture }) so
// the narrator / scripts can make the avatar speak with real TTS + lipsync.
function setupVoiceChat() {
	if (voiceChat) return;
	const root = document.getElementById('walk-voice');
	if (!root) return;
	voiceChat = new WalkVoiceChat({
		root,
		getAvatar: () => avatar,
		getPersona: () => ({
			agentId: avatarMeta?.agent_id || null,
			name: avatarMeta?.name || nameInput?.value?.trim() || null,
			description: avatarMeta?.description || null,
			env: currentEnvName || null,
		}),
		getUserName: () => nameInput?.value?.trim() || 'you',
		showBubble: (text) => showSpeechBubbleFor('local', text),
		setTalking: (on) => gestures?.setTalking(!!on),
		addChatLog: (name, text, opts = {}) =>
			window._walkChat?.addChatMessage(name, text, opts),
		// Mirror the avatar's spoken line to the room so other players see it too.
		broadcast: (text) => net?.sendChat(text),
	});
	voiceChat.mount();

	window.walk = window.walk || {};
	// Speak a line aloud with TTS + lipsync + the talking gesture. Returns the
	// playback promise so callers can await the avatar finishing.
	window.walk.say = (text, opts) => voiceChat?.speak(text, opts);
	window.walk.voiceChat = voiceChat;
}

// Play the looping `talking` overlay for roughly as long as a chat/TTS line is
// on screen, scaled to its length (≈45ms/char) and capped to the bubble's life.
let _talkingTimer = null;
function triggerTalking(text) {
	if (!gestures) return;
	gestures.setTalking(true);
	clearTimeout(_talkingTimer);
	const ms = Math.min(SPEECH_BUBBLE_DURATION, Math.max(1500, (text?.length || 0) * 45));
	_talkingTimer = setTimeout(() => gestures?.setTalking(false), ms);
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
		let r = 0,
			g = 0,
			b = 0;
		const n = px.length / 4;
		for (let i = 0; i < px.length; i += 4) {
			r += px[i];
			g += px[i + 1];
			b += px[i + 2];
		}
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
	} catch {
		/* cross-origin or tainted canvas — skip */
	}
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
		const msg =
			err?.name === 'NotAllowedError'
				? 'camera permission denied'
				: `camera unavailable: ${err?.message ?? err}`;
		setStatus(msg, { error: true, sticky: true });
		return;
	}
	video.srcObject = mediaStream;
	try {
		await video.play();
	} catch {}

	arActive = true;
	stage.classList.add('is-ar');
	arBtn.setAttribute('aria-pressed', 'true');
	terrain.mesh.visible = false; // hide the world ground; the room is the floor in AR
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
		const hFovRad = 2 * Math.atan((w / diagPx) * Math.tan((diagFov * Math.PI) / 180 / 2));
		const aspect = window.innerWidth / window.innerHeight;
		const vFovDeg = 2 * Math.atan(Math.tan(hFovRad / 2) / aspect) * (180 / Math.PI);
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
			try {
				track.stop();
			} catch {}
		}
		mediaStream = null;
	}
	video.srcObject = null;
	arActive = false;
	stage.classList.remove('is-ar');
	arBtn.setAttribute('aria-pressed', 'false');
	terrain.mesh.visible = true; // restore the rolling ground when leaving AR
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
	return (
		matchMedia('(hover: none) and (pointer: coarse)').matches ||
		('ontouchstart' in window && navigator.maxTouchPoints > 0)
	);
})();
const CAMERA_SUPPORTED = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
const AR_CTA_DISMISS_KEY = 'walk:ar-cta-dismissed';

// ── AR button capability state ────────────────────────────────────────────
// Run once at load time: if the camera API is absent the button is marked
// disabled immediately so the user never encounters a dead click.
// On supported devices the button stays active and any getUserMedia failure
// (permission denied, no camera attached) is surfaced at click time by
// enableAR() with a clear error message.
(function initArButtonState() {
	if (!arBtn) return;
	if (CAMERA_SUPPORTED) return; // all good — leave the button as-is

	// Camera API unavailable: mark the button as disabled and explain why.
	arBtn.disabled = true;
	arBtn.setAttribute('aria-disabled', 'true');
	arBtn.title = 'AR requires a browser with camera access (try Chrome or Safari on a phone)';
	const dot = arBtn.querySelector('.dot');
	if (dot) dot.style.background = 'rgba(255,255,255,0.2)';
	const label = arBtn.querySelector('[data-label]');
	if (label) label.textContent = 'AR (unavailable)';
	// Prevent the click handler from firing via the disabled attribute, and
	// style it as inert so it doesn't look interactive.
	arBtn.style.opacity = '0.4';
	arBtn.style.cursor = 'not-allowed';
	arBtn.style.pointerEvents = 'none';
})();

function showArCta() {
	if (!arCta) return;
	if (arActive) return;
	if (!IS_TOUCH || !CAMERA_SUPPORTED) return;
	try {
		if (sessionStorage.getItem(AR_CTA_DISMISS_KEY) === '1') return;
	} catch {}
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
		const target = /** @type {HTMLElement} */ (e.target);
		if (target?.classList?.contains('dismiss')) {
			try {
				sessionStorage.setItem(AR_CTA_DISMISS_KEY, '1');
			} catch {}
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
		try {
			if (MediaRecorder.isTypeSupported(t)) return t;
		} catch {}
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
	recorder.ondataavailable = (e) => {
		if (e.data && e.data.size) chunks.push(e.data);
	};

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
			try {
				recorder.stop();
			} catch {}
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
					log.warn('[walk] share failed, falling back to download:', err);
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
		log.error('[walk] recorder error:', e);
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
const clock = new Timer();
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
			if (m > 0.01) {
				ix /= m;
				iy /= m;
			}
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
	clock.update();
	const dt = Math.min(clock.getDelta(), 0.05); // clamp huge frames after a tab switch

	// Right-stick look — rotate the follow-camera while the stick is held.
	// Signs match the drag-orbit handler: push right turns right, push up
	// tilts the view upward, clamped to the same pitch limits.
	if (input.look.active) {
		cameraYaw -= input.look.x * LOOK_YAW_SPEED * dt;
		cameraPitch = Math.max(
			PITCH_MIN,
			Math.min(PITCH_MAX, cameraPitch + input.look.y * LOOK_PITCH_SPEED * dt),
		);
	}

	// When the Rapier solver is up (and we're not in AR), the kinematic
	// character controller owns position, collision, and gravity. Otherwise the
	// legacy direct-mutation path keeps the scene fully playable.
	// Gallery mode uses the freely-writable legacy movement path so the treadmill
	// can re-anchor the avatar each frame without fighting the physics character.
	const usePhysics = physicsReady && !!character && !arActive && !GALLERY_MODE;

	// Legacy jump — simple parabola in Y, lands back at GROUND_Y. The physics
	// path integrates verticalVel against real ground contact instead.
	if (!usePhysics && jumpActive && avatar) {
		jumpVelocity += GRAVITY * dt;
		avatarRig.position.y += jumpVelocity * dt;
		// Land on the terrain surface (flat GROUND_Y while floating in AR).
		const landY = arActive
			? GROUND_Y
			: terrain.heightAt(avatarRig.position.x, avatarRig.position.z);
		if (avatarRig.position.y <= landY) {
			avatarRig.position.y = landY;
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
		// A movement input rises the avatar out of any full-body gesture (sit/dance)
		// so locomotion resumes the instant the player steers.
		gestures?.notifyMovement();
		// Forward = where the camera is currently looking, flattened to XZ.
		moveForward.copy(camLookCurrent).sub(camera.position);
		moveForward.y = 0;
		if (moveForward.lengthSq() < 1e-6) moveForward.set(0, 0, -1);
		else moveForward.normalize();
		moveRight.crossVectors(moveForward, upY).normalize();

		moveWorld
			.set(0, 0, 0)
			.addScaledVector(moveForward, iy / Math.max(mag, 1e-6))
			.addScaledVector(moveRight, ix / Math.max(mag, 1e-6))
			.normalize()
			.multiplyScalar(speed * dt);

		// Legacy path applies horizontal motion directly; the physics path feeds
		// moveWorld to the character controller after this block.
		if (!usePhysics) {
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
				// Follow the terrain surface until the physics solver takes over.
				if (!jumpActive) {
					avatarRig.position.y = terrain.heightAt(
						avatarRig.position.x,
						avatarRig.position.z,
					);
				}
			}
		}

		// Face the movement direction (smoothly).
		const wantYaw = Math.atan2(moveWorld.x, moveWorld.z);
		avatarYaw = lerpAngle(avatarYaw, wantYaw, TURN_LERP);
		avatarRig.quaternion.setFromAxisAngle(upY, avatarYaw);

		// Animation crossfade based on actual speed (the AnimationManager
		// no-ops if the requested name is already current). A full-body gesture
		// (sit/dance) owns the base layer — skip the locomotion crossfade until it
		// clears; an upper-body gesture (wave/point) rides additively over it.
		const want = wantRun ? 'run' : 'walk';
		if (currentMotion !== want) {
			currentMotion = want;
			if (!gestures?.isFullBodyActive()) {
				animationManager.crossfadeTo(want === 'run' ? CLIP_RUN : CLIP_WALK, 0.18);
			}
		}
	} else if (currentMotion !== 'idle' && avatar) {
		currentMotion = 'idle';
		if (!gestures?.isFullBodyActive()) {
			animationManager.crossfadeTo(CLIP_IDLE, 0.25);
		}
	}

	// Physics movement — feed the frame's horizontal displacement plus an
	// integrated vertical velocity to the kinematic character controller. It
	// resolves wall slides, step-ups, ground contact, and shoves dynamic props,
	// then hands back where the feet actually ended up. We step the world right
	// after so the solver consumes the queued kinematic move in the same frame.
	if (usePhysics && avatar) {
		// On the first physics frame after boot/AR, snap the body to wherever the
		// avatar currently is so the controller doesn't lurch from a stale pose.
		if (!physicsActivePrev) {
			character.setPosition(avatarRig.position);
			verticalVel = 0;
			physicsActivePrev = true;
		}
		const dispX = mag > 0.01 ? moveWorld.x : 0;
		const dispZ = mag > 0.01 ? moveWorld.z : 0;
		verticalVel += GRAVITY * dt;
		if (verticalVel < -40) verticalVel = -40; // terminal velocity guard
		const res = character.move({ x: dispX, y: verticalVel * dt, z: dispZ });
		characterGrounded = res.grounded;
		if (characterGrounded && verticalVel < 0) verticalVel = 0;

		// Boundary safety — keep roaming inside the ground disc. Snap the body
		// too so the controller's next query starts from the corrected spot.
		let px = res.position.x;
		let pz = res.position.z;
		const r = Math.hypot(px, pz);
		const maxR = GROUND_RADIUS - 0.5;
		if (r > maxR) {
			const k = maxR / r;
			px *= k;
			pz *= k;
			character.setPosition({ x: px, y: res.position.y, z: pz });
		}
		avatarRig.position.set(px, res.position.y, pz);

		physics.step(dt);
	} else {
		physicsActivePrev = false;
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
	const targetLean =
		currentMotion === 'run'
			? LEAN_RUN_RAD * mag
			: currentMotion === 'walk'
				? LEAN_WALK_RAD * mag
				: 0;
	avatarLean += (targetLean - avatarLean) * LEAN_LERP;
	if (avatar) avatar.rotation.x = avatarLean;

	// 1·9 Walk-Browse: scroll the marketplace hall and re-anchor the avatar before
	//      the camera reads its position, so the treadmill stays seamless.
	if (marketplaceGallery) marketplaceGallery.update(dt);

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
			const t = 1 - cameraModeTransition / CAMERA_MODE_TRANSITION_DUR;
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
	localCosmetics?.tick(dt);

	// 3b. Paint the path trail behind the avatar. Suppressed in AR (no rendered
	// ground to stamp decals onto) and when the style is 'off'.
	if (trails && trails.style !== 'off' && !arActive && avatar) {
		trails.update(dt, {
			x: avatarRig.position.x,
			y: avatarRig.position.y,
			z: avatarRig.position.z,
			yaw: avatarYaw,
			moving: currentMotion === 'walk' || currentMotion === 'run',
		});
	}

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

	// 4·5 Reveal the wallet of the nearest agent you walk up to (one card, cheap).
	walletProximity.update(performance.now());

	// 4a. Advance the NPC companions' FSMs (greeter waves on approach, wanderer
	//     roams, guide leads toward a landmark) against the live player position.
	if (walkNpcs && avatar) walkNpcs.update(dt, avatarRig.position);
	if (walkAgentDesks && avatar) walkAgentDesks.update(dt, avatarRig.position);

	// 4b. Animate the coin totem (billboard + bob + ring spin) when present.
	if (coinTotem) coinTotem.update(dt);

	// 5. Update speech bubbles (3D -> 2D projection)
	updateSpeechBubbles();

	// 6. Update minimap
	updateMinimapFrame();

	// 7. Accumulate walk metrics (distance + session time) for the leaderboard
	//    and per-creator analytics. Reads the resolved horizontal displacement
	//    this frame; flushes on a timer + pagehide (see the walk-metrics block).
	accumulateWalkMetrics(dt);

	renderer.render(scene, camera);
	requestAnimationFrame(tick);
}

function lerpAngle(a, b, t) {
	// Shortest-arc lerp in radians.
	let diff = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
	if (diff < -Math.PI) diff += Math.PI * 2;
	return a + diff * t;
}

// ── Walk metrics (leaderboard + per-creator analytics) ─────────────────────
//
// Accumulates the two signals the leaderboard (task 39) and embed analytics
// (task 40) rank/aggregate on — horizontal distance travelled and time spent
// actually walking — straight from the controller's resolved per-frame
// displacement, and flushes a compact batch to POST /api/walk/metrics every
// ~60s plus once on pagehide (sendBeacon, so it survives the unload). The same
// batch carries any achievement thresholds crossed this session so the server
// awards each badge exactly once.
//
// Attribution: a signed-in session is resolved server-side from the request
// cookie; anonymous walkers are attributed by a stable, locally-persisted
// anonymous id so they still appear on the leaderboard. The avatar in use and
// the current environment ride along so a creator's analytics attribute walks
// to the right avatar and the "all environments" badge can be detected.
const WALK_METRICS_ENDPOINT = '/api/walk/metrics';
const WALK_ANON_KEY = 'twx_walk_anon';
const WALK_ACHIEVED_KEY = 'twx_walk_achieved';
const WALK_FLUSH_INTERVAL_MS = 60_000;

// Stable anonymous walker id — generated once and persisted, so an unauthenticated
// walker accrues a continuous track record across sessions/visits.
function getWalkAnonId() {
	try {
		let id = localStorage.getItem(WALK_ANON_KEY);
		if (!id) {
			id =
				typeof crypto !== 'undefined' && crypto.randomUUID
					? `anon_${crypto.randomUUID()}`
					: `anon_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
			localStorage.setItem(WALK_ANON_KEY, id);
		}
		return id;
	} catch {
		// Private mode / storage disabled — fall back to a per-page id so the batch
		// is still attributable (just not continuous across reloads).
		if (!getWalkAnonId._mem) {
			getWalkAnonId._mem = `anon_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
		}
		return getWalkAnonId._mem;
	}
}

// The avatar whose walks we attribute. Seeded from ?avatar and kept in sync when
// the in-page picker swaps avatars (see the picker block, which calls
// setWalkMetricsAvatarId). Only forwarded when it is a real UUID — the default
// avatar has no id.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let walkMetricsAvatarId = (() => {
	const id = new URLSearchParams(location.search).get('avatar');
	return id && UUID_RE.test(id) ? id : null;
})();
function setWalkMetricsAvatarId(id) {
	walkMetricsAvatarId = id && UUID_RE.test(id) ? id : null;
}

// ── Walk session persistence (resume where you left off) ──────────────────────
// Mirrors the live scene state so a returning visitor resumes from where they
// left off. The avatar picker (a scoped block far below) updates these via
// setSelectedAvatar(); the env/camera/gesture/trail paths feed the same module
// through walkSession.save(). The controller persists to localStorage for
// everyone and syncs to /api/walk/session for signed-in users.
let selectedAvatarId =
	(() => {
		const id = new URLSearchParams(location.search).get('avatar');
		return id && UUID_RE.test(id) ? id : null;
	})();
let selectedAvatarUrl = null; // resolved on swap; null = default avatar
const recentGestures = []; // most-recent-first, capped at 5

function setSelectedAvatar(id, url) {
	selectedAvatarId = id && UUID_RE.test(id) ? id : null;
	selectedAvatarUrl = url || null;
}

// Record a gesture into the most-recent-first ring (deduped), capped at 5, and
// persist. Surfaces the user's recent gestures so a return visit can prioritise
// them. Called from the gesture-play wrapper installed in setupGestures().
function recordRecentGesture(name) {
	if (!name || typeof name !== 'string') return;
	const i = recentGestures.indexOf(name);
	if (i !== -1) recentGestures.splice(i, 1);
	recentGestures.unshift(name);
	if (recentGestures.length > 5) recentGestures.length = 5;
	walkSession?.save();
}

let walkSession = null;

// Read the live scene into a plain, serialisable snapshot. Everything captured is
// state walk.js genuinely owns; companion/room are mirrored when present so the
// document is complete. Returns null only if the avatar isn't placed yet.
function captureWalkState() {
	const p = avatarRig?.position;
	return {
		avatarId: selectedAvatarId || null,
		avatarUrl: selectedAvatarUrl || null,
		envId: currentEnvName || null,
		cameraMode,
		position: p ? { x: round3(p.x), y: round3(p.y), z: round3(p.z) } : null,
		heading: round3(avatarYaw),
		trailStyle: trailSetting.get(),
		recentGestures: [...recentGestures],
		// Multiplayer room — the coin mint doubles as the matchmaking key. Recorded
		// so the snapshot is complete; rejoining is URL-driven so it is informational.
		roomCode: COIN_PARAMS.coin || null,
	};
}

function round3(n) {
	return typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 1000) / 1000 : 0;
}

// Apply a restored snapshot to the live scene. Each field is applied defensively
// (a missing/invalid field is skipped) so a partial or older snapshot still
// restores what it can. Avatar swaps run async; the rest applies synchronously.
async function restoreWalkState(state) {
	if (!state || typeof state !== 'object') return;

	// Environment — only if it differs from what initEnvironments already staged.
	if (state.envId && walkManifest && state.envId !== currentEnvName) {
		const meta = getEnvironment(walkManifest, state.envId);
		if (meta) await applyEnvironment(meta.name, { initial: true });
	}

	// Camera mode.
	if (state.cameraMode && CAMERA_MODES.includes(state.cameraMode)) {
		cameraMode = state.cameraMode;
		try {
			localStorage.setItem(CAMERA_MODE_KEY, cameraMode);
		} catch {}
		if (avatar) avatar.visible = cameraMode !== 'firstperson';
		applyCameraImmediate();
	}

	// Position + heading. Clamp inside the walkable disc and re-snap the physics
	// body next frame so the controller starts from the restored spot, not spawn.
	if (state.position && Number.isFinite(state.position.x) && Number.isFinite(state.position.z)) {
		let x = state.position.x;
		let z = state.position.z;
		const r = Math.hypot(x, z);
		const maxR = GROUND_RADIUS - 0.5;
		if (r > maxR) {
			const k = maxR / r;
			x *= k;
			z *= k;
		}
		const y = terrain ? terrain.heightAt(x, z) : Number(state.position.y) || 0;
		avatarRig.position.set(x, y, z);
		physicsActivePrev = false; // force the character controller to re-sync to here
	}
	if (Number.isFinite(state.heading)) {
		avatarYaw = state.heading;
		avatarRig.quaternion.setFromAxisAngle(upY, avatarYaw);
	}

	// Trail style.
	if (state.trailStyle && TRAIL_STYLE_LABELS[state.trailStyle]) {
		trailSetting.set(state.trailStyle);
		trails?.setStyle(state.trailStyle);
		if (trailToggle) {
			trailToggle.textContent = TRAIL_STYLE_LABELS[state.trailStyle];
			trailToggle.style.background =
				state.trailStyle === 'off' ? 'rgba(255,255,255,0.08)' : 'var(--accent,#7c5cff)';
		}
	}

	// Recent gestures — seed the most-recent-first ring for quick re-use.
	if (Array.isArray(state.recentGestures)) {
		recentGestures.length = 0;
		for (const g of state.recentGestures.slice(0, 5)) {
			if (typeof g === 'string' && !recentGestures.includes(g)) recentGestures.push(g);
		}
	}

	// Avatar — swap last so it lands on the restored ground position. Only when it
	// differs from the booted avatar and resolves to a loadable URL.
	const wantUrl = state.avatarUrl || null;
	if (wantUrl && wantUrl !== resolvedAvatarUrl && isLoadableAvatarUrl(wantUrl)) {
		try {
			await applyAvatarSwap(wantUrl, state.avatarId || null);
		} catch (err) {
			log.warn('[walk] session avatar restore failed:', err?.message || err);
		}
	}

	frameAvatarCamera({ snap: true });
	updateCameraModeIndicator();
}

// Per-session accumulators. `pending*` hold metrics earned since the last flush;
// `session*` hold lifetime-of-session totals used for achievement thresholds and
// the distinct-environment set.
const walkMetrics = {
	pendingDistance: 0, // metres since last flush
	pendingDuration: 0, // seconds of walking since last flush
	sessionDistance: 0, // metres this session (for the 1 km / 5 km badges)
	sessionEnvs: new Set(), // distinct environments walked in this session
	prevX: null,
	prevZ: null,
	counted: false, // whether this session has produced any metric yet (session count)
	sessionFlushed: false, // the single session count has been sent
};

// Locally-remembered unlocked achievements so a toast fires only on the crossing,
// not on every subsequent flush. The server is the source of truth for awarding;
// this just gates the UI + avoids re-sending.
function loadAchievedSet() {
	try {
		const raw = localStorage.getItem(WALK_ACHIEVED_KEY);
		return new Set(raw ? JSON.parse(raw) : []);
	} catch {
		return new Set();
	}
}
function persistAchievedSet(set) {
	try {
		localStorage.setItem(WALK_ACHIEVED_KEY, JSON.stringify([...set]));
	} catch {
		/* storage disabled — toasts still fire from the in-memory set */
	}
}
const walkAchieved = loadAchievedSet();
// Achievements crossed this session but not yet flushed to the server.
const walkPendingAchievements = new Set();

const WALK_ACHIEVEMENTS = [
	{ code: 'distance_1km', label: '1 km walked', test: () => walkMetrics.sessionDistance >= 1000 },
	{ code: 'distance_5km', label: '5 km walked', test: () => walkMetrics.sessionDistance >= 5000 },
	{
		code: 'all_environments',
		label: 'Walked in all 6 environments',
		test: () => walkMetrics.sessionEnvs.size >= 6,
	},
];

function checkWalkAchievements() {
	for (const a of WALK_ACHIEVEMENTS) {
		if (walkAchieved.has(a.code)) continue;
		if (!a.test()) continue;
		walkAchieved.add(a.code);
		walkPendingAchievements.add(a.code);
		persistAchievedSet(walkAchieved);
		showAchievementToast(a.label);
	}
}

// Lightweight, self-contained achievement toast. Uses design-token colours via
// inline custom-property reads so it stays on-brand without a dedicated stylesheet
// (the walk page is canvas-first and ships no toast component).
let walkToastHost = null;
function showAchievementToast(label) {
	try {
		if (!walkToastHost) {
			walkToastHost = document.createElement('div');
			walkToastHost.className = 'walk-toast-host';
			walkToastHost.setAttribute('aria-live', 'polite');
			walkToastHost.style.cssText =
				'position:fixed;left:50%;top:calc(env(safe-area-inset-top,0) + 18px);transform:translateX(-50%);z-index:60;display:flex;flex-direction:column;gap:8px;pointer-events:none;';
			document.body.appendChild(walkToastHost);
		}
		const el = document.createElement('div');
		el.className = 'walk-toast';
		el.setAttribute('role', 'status');
		el.style.cssText =
			'display:flex;align-items:center;gap:10px;padding:10px 16px;border-radius:999px;' +
			'background:rgba(17,17,17,0.92);border:1px solid rgba(255,215,0,0.45);' +
			'color:#fafafa;font:600 13px/1.2 var(--font-body,Inter,system-ui,sans-serif);' +
			'box-shadow:0 8px 32px rgba(0,0,0,0.5);backdrop-filter:blur(16px);' +
			'-webkit-backdrop-filter:blur(16px);opacity:0;transform:translateY(-8px);' +
			'transition:opacity .22s ease,transform .22s ease;';
		el.innerHTML = `<span aria-hidden="true" style="font-size:16px;line-height:1">🏆</span><span>Achievement unlocked · ${esc(label)}</span>`;
		walkToastHost.appendChild(el);
		requestAnimationFrame(() => {
			el.style.opacity = '1';
			el.style.transform = 'translateY(0)';
		});
		setTimeout(() => {
			el.style.opacity = '0';
			el.style.transform = 'translateY(-8px)';
			el.addEventListener('transitionend', () => el.remove(), { once: true });
		}, 4200);
	} catch {
		/* DOM unavailable — non-fatal; the unlock is still flushed to the server */
	}
}

// Called once per frame from the render loop. Integrates horizontal displacement
// into distance and accumulates walking time whenever the avatar is moving.
function accumulateWalkMetrics(dt) {
	if (!avatar) return;
	const x = avatarRig.position.x;
	const z = avatarRig.position.z;
	if (walkMetrics.prevX === null) {
		walkMetrics.prevX = x;
		walkMetrics.prevZ = z;
		return;
	}
	const dx = x - walkMetrics.prevX;
	const dz = z - walkMetrics.prevZ;
	walkMetrics.prevX = x;
	walkMetrics.prevZ = z;
	const stepped = Math.hypot(dx, dz);
	// Ignore teleports/world-swaps (a single frame moving > 5 m is not a walk) and
	// sub-millimetre jitter so a standing avatar accrues no phantom distance.
	const moving = currentMotion === 'walk' || currentMotion === 'run';
	if (stepped > 0.001 && stepped < 5 && moving) {
		walkMetrics.pendingDistance += stepped;
		walkMetrics.sessionDistance += stepped;
		walkMetrics.pendingDuration += dt;
		if (!walkMetrics.counted) walkMetrics.counted = true;
		if (currentEnvName) walkMetrics.sessionEnvs.add(currentEnvName);
		checkWalkAchievements();
	}
}

// Build the flush payload (or null if there's nothing to send). `final` marks the
// pagehide flush, which counts the session exactly once.
function buildWalkMetricsBatch({ final = false } = {}) {
	const distance = walkMetrics.pendingDistance;
	const duration = walkMetrics.pendingDuration;
	const achievements = [...walkPendingAchievements];
	// Count the session once, on the first flush that carries real movement.
	const session = walkMetrics.counted && !walkMetrics.sessionFlushed ? 1 : 0;
	if (distance <= 0 && duration <= 0 && !achievements.length && session === 0) return null;
	return {
		distanceMeters: Math.round(distance * 100) / 100,
		durationSec: Math.round(duration * 10) / 10,
		sessions: session,
		envId: currentEnvName || null,
		avatarId: walkMetricsAvatarId || undefined,
		anonId: getWalkAnonId(),
		achievements,
		_final: final,
	};
}

// Flush via fetch (keepalive) on the interval; via sendBeacon on pagehide so the
// last batch survives the unload. Resets the pending accumulators on dispatch.
function flushWalkMetrics({ beacon = false } = {}) {
	const batch = buildWalkMetricsBatch({ final: beacon });
	if (!batch) return;
	const final = batch._final;
	delete batch._final;
	const body = JSON.stringify(batch);

	let sent = false;
	if (beacon && typeof navigator !== 'undefined' && navigator.sendBeacon) {
		try {
			sent = navigator.sendBeacon(
				WALK_METRICS_ENDPOINT,
				new Blob([body], { type: 'application/json' }),
			);
		} catch {
			sent = false;
		}
	}
	if (!sent) {
		fetch(WALK_METRICS_ENDPOINT, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body,
			credentials: 'include',
			keepalive: true,
		}).catch(() => {
			/* metrics are best-effort; never surface a flush failure to the walker */
		});
	}

	// Reset pending counters now that the batch is dispatched. The session is
	// marked flushed once its single count has been sent.
	walkMetrics.pendingDistance = 0;
	walkMetrics.pendingDuration = 0;
	if (batch.sessions > 0) walkMetrics.sessionFlushed = true;
	walkPendingAchievements.clear();
}

// Fire a creator-defined conversion event for the embed analytics dashboard.
// Posts immediately (events are sparse, unlike the batched metric flush) and is
// attributed server-side to the current avatar + walker the same way metrics are.
//   window.ThreeWalkAvatar.track('subscribe', { value: 9 })
function trackWalkEvent(eventName, opts = {}) {
	const name = typeof eventName === 'string' ? eventName.trim().slice(0, 64) : '';
	if (!name) return;
	const value = typeof opts.value === 'number' && Number.isFinite(opts.value) ? opts.value : undefined;
	const body = JSON.stringify({
		eventName: name,
		value,
		avatarId: walkMetricsAvatarId || undefined,
		anonId: getWalkAnonId(),
	});
	fetch(WALK_METRICS_ENDPOINT, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body,
		credentials: 'include',
		keepalive: true,
	}).catch(() => {
		/* event tracking is best-effort */
	});
}

function startWalkMetrics() {
	// Expose the embed SDK tracking API. Idempotent — merges onto any existing
	// global so a host page that defined a stub before load keeps working.
	window.ThreeWalkAvatar = Object.assign(window.ThreeWalkAvatar || {}, {
		track: trackWalkEvent,
	});
	setInterval(() => flushWalkMetrics({ beacon: false }), WALK_FLUSH_INTERVAL_MS);
	// pagehide is the reliable unload signal on mobile Safari + modern browsers;
	// visibilitychange→hidden covers tab-switch/app-background where pagehide may
	// not fire. Both route through the beacon path.
	window.addEventListener('pagehide', () => flushWalkMetrics({ beacon: true }));
	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'hidden') flushWalkMetrics({ beacon: true });
	});
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

// ── Avatar inspector ──────────────────────────────────────────────────────
// I (or clicking a nameplate) opens the shared inspector on a player: who they
// are, the agent they pilot, their reputation and wallet — the same server
// truth every other surface reads. See src/shared/avatar-inspector.js.
function worldInspectFacts() {
	if (COIN_PARAMS.coin) {
		return [{
			label: 'World',
			value: COIN_PARAMS.symbol ? `$${COIN_PARAMS.symbol}` : COIN_PARAMS.name || 'Coin world',
			href: `/temporary?coin=${encodeURIComponent(COIN_PARAMS.coin)}`,
		}];
	}
	return [{ label: 'World', value: GALLERY_MODE ? 'Marketplace hall' : 'Mainland' }];
}
function inspectRemotePlayer(rp) {
	if (!rp) return;
	openAvatarInspector({
		kind: 'peer',
		name: rp.name,
		world: COIN_PARAMS.coin ? 'coin world' : 'walk',
		agentId: rp.agent || '',
		wallet: rp.account || '',
		avatarUrl: rp._avatarUrl,
		facts: worldInspectFacts(),
	}, { trigger: canvas });
}
function inspectSelfPlayer() {
	openAvatarInspector({
		kind: 'self',
		name: nameInput?.value?.trim() || getStoredName() || 'You',
		world: COIN_PARAMS.coin ? 'coin world' : 'walk',
		agentId: COIN_PARAMS.agent || avatarMeta?.agent_id || '',
		avatarUrl: resolvedAvatarUrl,
		facts: worldInspectFacts(),
	}, { trigger: canvas });
}
// Nearest player within reach of your avatar; yourself when alone — the I key
// always answers.
function inspectNearestPlayer() {
	if (isAvatarInspectorOpen()) { closeAvatarInspector(); return; }
	const MAX_M = 10;
	let best = null;
	for (const rp of remotePlayers.values()) {
		const d = Math.hypot(rp.rig.position.x - avatarRig.position.x, rp.rig.position.z - avatarRig.position.z);
		if (d <= MAX_M && (!best || d < best.d)) best = { d, rp };
	}
	if (best) inspectRemotePlayer(best.rp);
	else inspectSelfPlayer();
}

// In-world wallet reveal: walk up to a player piloting an agent and its wallet
// (vanity address, live value, tip) rises beside the nameplate. Frugal by design
// — one card, throttled proximity scan, cached embed reads. See walk-wallet.js.
const walletProximity = createWalkWalletProximity({
	getLocalPosition: () => avatarRig.position,
	remotePlayers,
});

// Walk-Browse marketplace hall — only on /marketplace-walk; a no-op otherwise.
// Builds a recycling belt of listing plinths and treadmills it past the avatar.
const marketplaceGallery = GALLERY_MODE
	? createMarketplaceGallery({ scene, getLocalPosition: () => avatarRig.position })
	: null;

let net = null;
let netConnected = false;
let coinTotem = null; // CoinTotem instance when in a coin community world
let contentBillboard = null; // ContentBillboard instance — a static content panel in-world

// Remote-avatar template cache. Each distinct GLB URL is fetched once and
// reused (via SkeletonUtils.clone) for every player wearing it, so a room full
// of the same avatar costs a single download. Keyed by URL → entry. Each entry
// refcounts the live RemotePlayers cloning it; when a template falls to zero
// refs it is eligible for eviction. To keep GPU memory bounded in long-lived
// busy worlds we cap the number of *idle* (zero-ref) templates kept warm and
// dispose the geometries/textures/materials of any evicted scene. Templates
// with live refs are never disposed (their clones share geometry/materials).
// The local avatar is never stored here (short-circuited below), so disposing a
// remote template can never free buffers still used by the local avatar.
const _remoteAvatarTemplates = new Map();
const MAX_IDLE_REMOTE_TEMPLATES = 12;

function loadRemoteAvatarTemplate(url) {
	if (url === resolvedAvatarUrl && avatarTemplate) return Promise.resolve(avatarTemplate);
	let entry = _remoteAvatarTemplates.get(url);
	if (entry) {
		entry.lastUsed = performance.now();
		return entry.promise;
	}
	const promise = getAvatarLoader()
		.then((loader) => loader.loadAsync(url))
		.then((gltf) => {
			gltf.scene.traverse((n) => {
				if (n.isMesh) {
					n.castShadow = true;
					n.receiveShadow = false;
					if (n.material && 'envMapIntensity' in n.material)
						n.material.envMapIntensity = 0.85;
				}
			});
			if (entry) entry.scene = gltf.scene;
			return gltf.scene;
		})
		.catch((err) => {
			// A failed load must not poison the cache forever — drop the entry so a
			// later player can retry, and re-throw for the caller's own handling.
			if (_remoteAvatarTemplates.get(url) === entry) _remoteAvatarTemplates.delete(url);
			throw err;
		});
	entry = { promise, scene: null, refs: 0, lastUsed: performance.now() };
	_remoteAvatarTemplates.set(url, entry);
	return promise;
}

// A RemotePlayer claims/releases the template URL it is currently cloning so the
// cache knows when a template is unreferenced and safe to evict.
function acquireRemoteTemplate(url) {
	const entry = _remoteAvatarTemplates.get(url);
	if (entry) {
		entry.refs++;
		entry.lastUsed = performance.now();
	}
}

function releaseRemoteTemplate(url) {
	const entry = _remoteAvatarTemplates.get(url);
	if (!entry) return;
	if (entry.refs > 0) entry.refs--;
	entry.lastUsed = performance.now();
	pruneRemoteTemplates();
}

// Evict the least-recently-used idle (zero-ref) templates beyond the cap and
// dispose their GPU resources.
function pruneRemoteTemplates() {
	const idle = [];
	for (const [url, entry] of _remoteAvatarTemplates) {
		if (entry.refs <= 0 && entry.scene) idle.push([url, entry]);
	}
	if (idle.length <= MAX_IDLE_REMOTE_TEMPLATES) return;
	idle.sort((a, b) => a[1].lastUsed - b[1].lastUsed);
	const evictCount = idle.length - MAX_IDLE_REMOTE_TEMPLATES;
	for (let i = 0; i < evictCount; i++) {
		const [url, entry] = idle[i];
		_remoteAvatarTemplates.delete(url);
		disposeTemplateScene(entry.scene);
	}
}

function disposeTemplateScene(scene) {
	if (!scene) return;
	scene.traverse((n) => {
		if (n.geometry) n.geometry.dispose();
		const mats = Array.isArray(n.material) ? n.material : n.material ? [n.material] : [];
		for (const mat of mats) {
			for (const v of Object.values(mat)) {
				if (v && v.isTexture) v.dispose();
			}
			mat.dispose();
		}
	});
}
function isLoadableAvatarUrl(url) {
	return (
		typeof url === 'string' &&
		url.length > 0 &&
		(url.startsWith('/') || url.startsWith('http://') || url.startsWith('https://'))
	);
}

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
		this._avatarUrl = initial?.avatar || '';
		// The agent this peer is piloting (UUID) — drives the in-world wallet reveal.
		this.agent = initial?.agent || null;
		// Verified account wallet bound at sign-in (server-authoritative; empty for
		// guests). Feeds the avatar inspector alongside the piloted agent.
		this.account = initial?.account || '';
		this.name = initial?.name || sessionId.slice(0, 6);
		this._avatarLoadToken = 0;
		this._heldTemplateUrl = null; // remote-template URL this player currently clones
		this._root = root;

		this.rig = new Group();
		this.rig.add(root);
		scene.add(this.rig);

		// This peer's equipped cosmetic loadout (R23). Measure the body's height so
		// props anchor correctly (mountProp scales/places by it), then dress them in
		// the same applyLoadout the local player uses. Re-measured + re-applied after
		// any avatar swap, and re-applied when they change their fit.
		this._avatarHeight = measureRigHeight(root);
		this._cosWire = initial?.cosmetics || '';
		this._applyCosmetics();

		this.anim = new AnimationManager();
		this.anim.attach(root);
		this.anim.setAnimationDefs(animationDefs);
		// Reuse the already-fetched clips on the local manager — load asynchronously
		// so the remote doesn't block on a second manifest fetch.
		this.anim.loadAll().then(() => {
			this.anim.crossfadeTo(motionToClipName(this.motion), 0.0);
		});

		// If this player brought their own avatar / 3D agent, swap the stand-in
		// template for their real model once it loads. The default-template body
		// above keeps them visible meanwhile so nobody pops in late.
		if (isLoadableAvatarUrl(this._avatarUrl) && this._avatarUrl !== resolvedAvatarUrl) {
			this._swapAvatar(this._avatarUrl);
		}

		// Floating name tag — rendered as a CSS-styled DOM sprite that we
		// project onto the avatar's head each frame.
		this.label = document.createElement('div');
		this.label.className = 'walk-remote-label';
		this.label.textContent = initial?.name ?? sessionId.slice(0, 6);
		// The nameplate is also this peer's inspect target. The page CSS keeps
		// .walk-remote-label pointer-events off (nameplates must never eat the
		// orbit drag), so re-enable it just for this small pill.
		this.label.style.pointerEvents = 'auto';
		this.label.style.cursor = 'pointer';
		this.label.title = 'Inspect this player (I)';
		this.label.addEventListener('click', (e) => { e.stopPropagation(); inspectRemotePlayer(this); });
		document.body.appendChild(this.label);

		// Living-avatar legibility: enrich the nameplate with the piloted agent's
		// wealth tier (a coloured dot) + a vanity mark, so a crowded plaza reads at a
		// glance — who's funded, who's vanity — without walking up to each. One cached,
		// deduped public wallet-embed read per agent; the tier dot rides CSS so the
		// per-frame textContent name update never clobbers it. Released on dispose.
		this._wealthLabel = null;
		this._applyWealthLabel();

		// Visual state — target (latest server) vs current (interpolated).
		this.targetX = initial?.x ?? 0;
		this.targetY = initial?.y ?? 0;
		this.targetZ = initial?.z ?? 0;
		this.targetYaw = initial?.yaw ?? 0;
		this.motion = initial?.motion ?? 'idle';
		this.currentYaw = this.targetYaw;
		this.rig.position.set(this.targetX, this.targetY, this.targetZ);
		this.rig.quaternion.setFromAxisAngle(upY, this.targetYaw);
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
			this.name = player.name;
		}
		if (player.account !== undefined && player.account !== this.account) {
			this.account = player.account || '';
		}
		if (player.emote && player.emoteTs !== this._lastEmoteTs) {
			this._lastEmoteTs = player.emoteTs;
			this._playRemoteEmote(player.emote);
		}
		// Live avatar swap — a player picked a new avatar without rejoining.
		if (player.avatar !== this._avatarUrl && isLoadableAvatarUrl(player.avatar)) {
			this._avatarUrl = player.avatar;
			this._swapAvatar(player.avatar);
		}
		// Live cosmetic change — they equipped/unequipped something.
		if (player.cosmetics !== undefined && player.cosmetics !== this._cosWire) {
			this._applyCosmetics(player.cosmetics);
		}
		// A player can swap which agent they pilot without rejoining.
		if (player.agent !== undefined && player.agent !== this.agent) {
			this.agent = player.agent || null;
			this._applyWealthLabel();
		}
	}

	// (Re)bind the nameplate's wealth-tier + vanity enrichment to the currently
	// piloted agent. Idempotent — tears down a stale binding before rebinding, and
	// no-ops (clean label) when the peer isn't piloting a real agent.
	_applyWealthLabel() {
		try { this._wealthLabel?.destroy?.(); } catch { /* already gone */ }
		this._wealthLabel = null;
		const id = this.agent && UUID_RE.test(String(this.agent)) ? String(this.agent) : null;
		if (id && this.label) this._wealthLabel = applyWorldNameplate(this.label, id, { network: 'mainnet' });
	}

	// (Re)dress this peer in their equipped loadout. Idempotent — re-applies only
	// when the wire changed — and shares applyLoadout with the local avatar so one
	// wardrobe renders the same in every world.
	_applyCosmetics(wire) {
		const next = typeof wire === 'string' ? wire : this._cosWire || '';
		this._cosWire = next;
		if (!this.rig || !this._avatarHeight) return;
		if (this.cosmetics && this._cosApplied === next) return;
		this._cosApplied = next;
		try {
			this.cosmetics?.dispose();
		} catch {
			/* already gone */
		}
		this.cosmetics = applyLoadout(this.rig, this._avatarHeight, next);
	}

	// Replace the visible body with the player's own avatar GLB. Loads (cached)
	// off the main thread; a load token guards against an out-of-order resolve
	// when avatars are swapped faster than the network fetches them.
	async _swapAvatar(url) {
		const token = ++this._avatarLoadToken;
		let templateScene;
		try {
			templateScene = await loadRemoteAvatarTemplate(url);
		} catch (err) {
			log.warn(
				'[walk] remote avatar load failed, keeping stand-in:',
				url,
				err?.message ?? err,
			);
			return;
		}
		if (token !== this._avatarLoadToken || !this.rig) return; // superseded or disposed

		const root = cloneSkinnedScene(templateScene);
		root.traverse((n) => {
			if (n.isMesh) {
				n.castShadow = true;
				n.receiveShadow = false;
			}
		});
		// Center feet on the rig origin so y=0 is the ground, matching loadAvatar().
		const box = new Box3().setFromObject(root);
		root.position.y -= box.min.y;

		// Tear down the old body + its mixer, then attach a fresh one bound to the
		// new skeleton with the same shared clips.
		try {
			this.anim.dispose();
		} catch {}
		if (this._root) this.rig.remove(this._root);
		this._root = root;
		this.rig.add(root);

		// New body, new proportions: re-measure and re-dress so worn cosmetics fit
		// the swapped avatar (tint binds to the new meshes; props re-anchor to it).
		this._avatarHeight = Math.max(0.5, box.max.y - box.min.y);
		this._cosApplied = null;
		this._applyCosmetics();

		// Track template references so the cache can evict & dispose templates no
		// live player is cloning. Release the previous, claim the new.
		if (this._heldTemplateUrl && this._heldTemplateUrl !== url)
			releaseRemoteTemplate(this._heldTemplateUrl);
		acquireRemoteTemplate(url);
		this._heldTemplateUrl = url;

		this.anim = new AnimationManager();
		this.anim.attach(root);
		this.anim.setAnimationDefs(animationDefs);
		try {
			await this.anim.loadAll();
			if (token !== this._avatarLoadToken) return;
			this.anim.crossfadeTo(motionToClipName(this.motion), 0.0);
		} catch {}
	}

	async _playRemoteEmote(name) {
		if (!_fullManifest) return;
		const def = _fullManifest.find((d) => d.name === name);
		if (!def) return;
		if (!animationDefs.some((d) => d.name === name)) {
			animationDefs.push(def);
			this.anim.setAnimationDefs(animationDefs);
		}
		try {
			await this.anim.ensureLoaded(name);
		} catch {
			return;
		}
		this._emoting = true;
		this.anim.crossfadeTo(name, 0.2);
		const action = this.anim.currentAction;
		const dur = action && !action.loop ? action.getClip().duration * 1000 : 3000;
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
		this.rig.quaternion.setFromAxisAngle(upY, this.currentYaw);

		this.anim.update(dt);
		this.cosmetics?.tick(dt);
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
		this._avatarLoadToken++; // cancel any in-flight avatar swap
		if (this._heldTemplateUrl) {
			releaseRemoteTemplate(this._heldTemplateUrl);
			this._heldTemplateUrl = null;
		}
		try {
			this.cosmetics?.dispose();
		} catch {
			/* already gone */
		}
		scene.remove(this.rig);
		this.rig = null;
		this.anim.dispose();
		try { this._wealthLabel?.destroy?.(); } catch { /* already gone */ }
		this._wealthLabel = null;
		this.label.remove();
	}
}

// Head-anchor height for a freshly built body, used to scale/place worn props.
function measureRigHeight(root) {
	const b = new Box3().setFromObject(root);
	return Math.max(0.5, b.max.y - b.min.y);
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
							: status === 'unavailable'
								? 'multiplayer unavailable'
								: 'solo';
	}
}

function startNet() {
	// Draft previews run solo — never broadcast a throwaway, soon-to-expire
	// presigned GLB into a live room where peers would fail to load it.
	if (isDraftPreview) return;
	if (!avatarTemplate || !animationDefs) return;
	if (net) return;
	const stored = getStoredName();
	const name = (stored || `guest-${Math.random().toString(36).slice(2, 6)}`).slice(0, 24);
	if (nameInput && !nameInput.value) nameInput.value = name;
	net = new WalkNet({
		name,
		avatar: resolvedAvatarUrl,
		agent: COIN_PARAMS.agent,
		coin: COIN_PARAMS.coin,
		coinName: COIN_PARAMS.name,
		coinSymbol: COIN_PARAMS.symbol,
		coinImage: COIN_PARAMS.image,
		// The equipped cosmetic loadout (R23), carried in from the player's account /
		// the cross-world mirror so peers see their fit on arrival.
		cosmetics: getPlayCosmetics(),
		// Publish account presence (Task 15) so friends see this player online in
		// this coin world, and so DMs can deliver here live. No-op when signed out.
		getPresence: getPresenceTicket,
	});

	// Friends realtime (Task 15): keep the shared friends client's threads + unread
	// warm with any live DM / request events delivered to this coin world.
	net.on('social', (m) => friendsClient().handleSocial(m));

	net.on('status', ({ status }) => {
		netConnected = status === 'online';
		setOnlineStatus(status);
		renderOnlineCount();
	});
	net.on('add', (player, sessionId) => {
		if (sessionId === net.mySessionId) return; // skip self
		if (remotePlayers.has(sessionId)) return;
		remotePlayers.set(
			sessionId,
			new RemotePlayer(sessionId, {
				x: player.x,
				y: player.y,
				z: player.z,
				yaw: player.yaw,
				motion: player.motion,
				name: player.name,
				color: player.color,
				avatar: player.avatar,
				agent: player.agent,
				account: player.account,
				cosmetics: player.cosmetics,
			}),
		);
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
	net.on('chat', (msg) => {
		// Our own messages are rendered optimistically on send — skip the echo.
		if (!msg || msg.id === net.mySessionId) return;
		const rp = remotePlayers.get(msg.id);
		const color = rp?._color;
		window._walkChat?.addChatMessage(msg.name || 'guest', msg.text, { color });
		showSpeechBubbleFor(msg.id, msg.text);
	});

	setupOnlinePill();
	setOnlineStatus('connecting');
	renderOnlineCount();
	net.connect();
}

// ── Gestures: see setupGestures() and src/walk-gestures.js. The radial
// gesture wheel (hold G / long-press), the 1–8 quick keys, and the side
// tray are all owned by the WalkGestures controller built in setupGestures().

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
		'position:fixed',
		'z-index:3',
		'pointer-events:none',
		'max-width:240px',
		'padding:8px 14px',
		'background:rgba(10,10,10,0.82)',
		'color:#fafafa',
		'border:1px solid rgba(255,255,255,0.12)',
		'border-radius:14px',
		'backdrop-filter:blur(8px)',
		'-webkit-backdrop-filter:blur(8px)',
		'font-size:12px',
		'line-height:1.45',
		'word-break:break-word',
		'white-space:pre-wrap',
		'transform:translate(-50%,-100%) scale(0.7)',
		'opacity:0',
		'transition:opacity 0.25s ease, transform 0.25s ease',
		'will-change:transform,opacity',
	].join(';');
	// Arrow pointer
	const arrow = document.createElement('div');
	arrow.style.cssText = [
		'position:absolute',
		'bottom:-6px',
		'left:50%',
		'transform:translateX(-50%)',
		'width:0',
		'height:0',
		'border-left:6px solid transparent',
		'border-right:6px solid transparent',
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
	const clean = text
		.replace(
			/[<>&"']/g,
			(c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[c],
		)
		.slice(0, SPEECH_BUBBLE_MAX_LEN);
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
			localBubble.el.style.top = sy - 10 + 'px';
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
			bubble.el.style.top = sy - 10 + 'px';
			bubble.el.style.display = '';
		} else {
			bubble.el.style.display = 'none';
		}
	}
}

// ── Environment selector ─────────────────────────────────────────────────
// Six worlds the avatar can roam — park, cyberpunk street, beach, gallery,
// abstract void, and the three.ws office. Each is a real glTF scene (or the
// procedural void) with its own terrain tint, sky gradient, light rig, and HDR
// image-based lighting, defined in public/environments/index.json and loaded
// through src/walk-environments.js. The terrain heightfield stays the walkable
// ground; an environment supplies scenery + lighting on top of it.
const ENV_KEY = 'walk:environment';
let walkManifest = null;
let currentEnvName = 'park';
let envApplyToken = 0; // bumped per swap so a stale async load can't clobber a newer one
const envPropsGroup = new Group(); // holds the kickable dynamic props (balls/crates)
scene.add(envPropsGroup);
let envScenery = null; // { group, dispose } — the current GLB/void scenery in the scene
let envHdr = null; // { texture, dispose } — the current pre-filtered IBL

// Collider descriptors for the current environment. `worldObstacles` are static
// (trees/buildings/walls); `worldDynamicProps` are the kickable bodies whose
// meshes the physics solver drives each frame. Rebuilt on every swap and
// consumed by rebuildPhysicsWorld().
let worldObstacles = [];
let worldDynamicProps = [];

// Regenerate the heightfield terrain for an environment: flat indoors, gently
// rolling outdoors. Swaps the render mesh and re-points the physics ground at
// the new surface so collider and visual never drift apart.
function swapTerrain(meta) {
	const t = meta.terrain || {};
	const next = createTerrain({
		amplitude: typeof t.amplitude === 'number' ? t.amplitude : 1.8,
		color: envTerrainColor(meta),
		seed: t.seed || 1337,
	});
	scene.remove(terrain.mesh);
	terrain.dispose();
	terrain = next;
	terrain.mesh.visible = !arActive;
	scene.add(terrain.mesh);
	// Re-point the trail system at the new heightfield so footprint decals project
	// onto (and orient to) the environment's ground instead of the old one.
	trails?.setGround(terrain);
	groundOpaque.material.color.setHex(envTerrainColor(meta));
	if (physics && physicsReady) physics.addHeightfield(terrain);
}

// Translate the manifest's collider list into solver obstacles, resolving each
// y from the live terrain so trees/posts/walls sit on the ground they render on.
function buildCollidersFromMeta(meta) {
	worldObstacles = [];
	for (const c of meta.colliders || []) {
		const gy = terrain.heightAt(c.x, c.z);
		if (c.type === 'cylinder') {
			worldObstacles.push({
				type: 'cylinder',
				position: { x: c.x, y: gy + c.halfHeight, z: c.z },
				radius: c.radius,
				halfHeight: c.halfHeight,
			});
		} else {
			worldObstacles.push({
				type: 'box',
				position: { x: c.x, y: gy + c.hy, z: c.z },
				halfExtents: { x: c.hx, y: c.hy, z: c.hz },
				rotationY: c.rotationY || 0,
			});
		}
	}
	// The content billboard is a persistent prop, not part of any environment's
	// manifest — re-add its post colliders on every swap (this array is reset above).
	if (contentBillboard) worldObstacles.push(...contentBillboard.colliders());
}

// Kickable physics props — beach balls and crates that fall, roll, and get
// shoved when the avatar walks into them. Counts come from the manifest. Each
// mesh is added to envPropsGroup (torn down on swap) with a descriptor in
// worldDynamicProps that rebuildPhysicsWorld() binds a rigid body to.
const PROP_BALL_COLORS = [0xff5a5f, 0x2ec4b6, 0xffd166, 0x5a8dee];
function clearDynamicMeshes() {
	while (envPropsGroup.children.length > 0) {
		const child = envPropsGroup.children[0];
		envPropsGroup.remove(child);
		child.geometry?.dispose?.();
		const mats = Array.isArray(child.material) ? child.material : [child.material];
		mats.forEach((m) => m?.dispose?.());
	}
}
function buildDynamicProps(meta) {
	worldDynamicProps = [];
	const dp = meta.dynamicProps || { balls: 3, crates: 3 };
	const balls = dp.balls || 0;
	const crates = dp.crates || 0;

	for (let i = 0; i < balls; i++) {
		const radius = 0.28 + Math.random() * 0.12;
		const mesh = new Mesh(
			new SphereGeometry(radius, 24, 16),
			new MeshStandardMaterial({
				color: PROP_BALL_COLORS[i % PROP_BALL_COLORS.length],
				roughness: 0.35,
				metalness: 0.05,
			}),
		);
		const angle = (i / Math.max(1, balls)) * Math.PI * 2 + 0.6;
		const r = 2.4 + Math.random() * 1.6;
		const x = Math.cos(angle) * r;
		const z = Math.sin(angle) * r;
		mesh.position.set(x, terrain.heightAt(x, z) + radius + 0.05, z);
		mesh.castShadow = true;
		envPropsGroup.add(mesh);
		worldDynamicProps.push({ kind: 'ball', mesh, radius });
	}

	for (let i = 0; i < crates; i++) {
		const s = 0.4 + Math.random() * 0.18;
		const mesh = new Mesh(
			new BoxGeometry(s * 2, s * 2, s * 2),
			new MeshStandardMaterial({ color: 0x9c6b3f, roughness: 0.85, metalness: 0.0 }),
		);
		const angle = (i / Math.max(1, crates)) * Math.PI * 2 - 0.8;
		const r = 2.0 + Math.random() * 1.4;
		const x = Math.cos(angle) * r;
		const z = Math.sin(angle) * r;
		mesh.position.set(x, terrain.heightAt(x, z) + s + 0.02, z);
		mesh.rotation.y = Math.random() * Math.PI;
		mesh.castShadow = true;
		mesh.receiveShadow = true;
		envPropsGroup.add(mesh);
		worldDynamicProps.push({ kind: 'box', mesh, half: s });
	}
}

// The synchronous half of a swap: terrain, lights, sky, colliders, props.
// Runs while the screen is faded out so none of it is seen mid-change.
function applyEnvironmentMeta(meta) {
	swapTerrain(meta);
	applyLighting(meta, { ambientLight, hemi, sun });
	applySky(meta, stage);
	clearDynamicMeshes();
	buildCollidersFromMeta(meta);
	contentBillboard?.placeOnTerrain();
	buildDynamicProps(meta);
	rebuildPhysicsWorld();
	try {
		localStorage.setItem(ENV_KEY, meta.name);
	} catch {}
	updateEnvIndicator();
	updateEnvPickerSelection();
}

// The asynchronous half: load the GLB scenery + HDR, then swap them into the
// scene. Guarded by `token` so a rapid re-selection discards a superseded load.
async function loadEnvScenery(meta, token) {
	let scenery = null;
	let hdr = null;
	try {
		scenery = await loadEnvironmentScenery(meta, {
			heightAt: (x, z) => terrain.heightAt(x, z),
		});
	} catch (err) {
		log.warn('[walk] scenery load failed for', meta.name, err?.message || err);
	}
	try {
		hdr = await loadEnvironmentHDR(meta, renderer);
	} catch (err) {
		log.warn('[walk] HDR load failed for', meta.name, err?.message || err);
	}
	if (token !== envApplyToken) {
		scenery?.dispose();
		hdr?.dispose();
		return;
	}
	if (envScenery) {
		scene.remove(envScenery.group);
		envScenery.dispose();
	}
	envScenery = scenery;
	if (scenery) scene.add(scenery.group);
	if (envHdr) {
		envHdr.dispose();
		envHdr = null;
	}
	if (hdr) {
		envHdr = hdr;
		scene.environment = hdr.texture;
	} else {
		scene.environment = defaultEnvTexture;
	}
	if ('environmentIntensity' in scene) scene.environmentIntensity = meta.envIntensity || 1;
}

// Per-environment NPC dialogue tables, cached so re-entering a world doesn't
// re-fetch. Each table is the parsed public/environments/<env>/dialogue.json
// (greeter / guide lines + landmarks); a missing or malformed file degrades to
// the NPC system's built-in coin-agnostic fallback copy.
const _npcDialogueCache = new Map(); // envName → { greeter, 'guide-arrive', 'guide-wait', landmarks }

async function loadEnvDialogue(meta) {
	if (_npcDialogueCache.has(meta.name)) return _npcDialogueCache.get(meta.name);
	let table = {};
	try {
		const res = await fetch(`/environments/${meta.name}/dialogue.json`, { cache: 'force-cache' });
		if (res.ok) table = await res.json();
	} catch (err) {
		log.warn('[walk] NPC dialogue unavailable for', meta.name, err?.message || err);
	}
	_npcDialogueCache.set(meta.name, table);
	return table;
}

// Spawn the NPC cast for an environment. The dialogue table supplies the spoken
// lines and the guide's landmarks; the cast itself defaults to the built-in
// greeter/wanderer/guide trio unless the table provides an explicit `npcs` list.
// Guarded by `token` so a rapid env re-selection discards a superseded spawn.
async function applyNpcsForEnv(meta, token) {
	if (!walkNpcs) return;
	const table = await loadEnvDialogue(meta);
	if (token !== envApplyToken) return; // a newer swap already took over
	walkNpcs.spawn({
		cast: Array.isArray(table.npcs) ? table.npcs : null,
		landmarks: Array.isArray(table.landmarks) ? table.landmarks : null,
		dialogue: table,
	});
}

// Full environment swap. The first paint applies instantly; later swaps fade to
// the new sky's horizon colour for ~300 ms so the world change is seamless.
async function applyEnvironment(name, { initial = false } = {}) {
	const meta = getEnvironment(walkManifest, name);
	if (!meta) return;
	const token = ++envApplyToken;
	currentEnvName = meta.name;
	// Persist the scene choice (debounced) so a return visit reloads it. Skipped on
	// the initial stage so a restore-driven first apply doesn't echo a redundant save.
	if (!initial) walkSession?.save();
	if (initial) {
		applyEnvironmentMeta(meta);
		await loadEnvScenery(meta, token);
		applyNpcsForEnv(meta, token);
		return;
	}
	await fadeWorld(skyFadeColor(meta), 1);
	if (token !== envApplyToken) return;
	applyEnvironmentMeta(meta);
	await loadEnvScenery(meta, token);
	if (token !== envApplyToken) return;
	applyNpcsForEnv(meta, token);
	await fadeWorld(null, 0);
}

// Fade-to-colour overlay used during environment swaps. Resolves after the CSS
// transition (skipped instantly when the user prefers reduced motion).
let envFadeEl = null;
function fadeWorld(color, opacity) {
	if (!envFadeEl) {
		envFadeEl = document.createElement('div');
		envFadeEl.id = 'walk-env-fade';
		envFadeEl.style.cssText =
			'position:fixed;inset:0;z-index:40;pointer-events:none;opacity:0;background:#05070c;transition:opacity .3s ease';
		document.body.appendChild(envFadeEl);
	}
	if (color) envFadeEl.style.background = color;
	const reduced =
		typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
	if (reduced) {
		envFadeEl.style.transition = 'none';
		envFadeEl.style.opacity = String(opacity);
		return Promise.resolve();
	}
	envFadeEl.style.transition = 'opacity .3s ease';
	return new Promise((resolve) => {
		requestAnimationFrame(() => {
			envFadeEl.style.opacity = String(opacity);
			setTimeout(resolve, 320);
		});
	});
}

// Environment indicator — a transient pill naming the active scene.
const envIndicator = (() => {
	const el = document.createElement('div');
	el.id = 'walk-env-indicator';
	el.setAttribute('role', 'status');
	el.style.cssText = [
		'position:fixed',
		'z-index:6',
		'left:16px',
		'top:calc(env(safe-area-inset-top, 0) + 60px)',
		'background:rgba(17,17,17,0.72)',
		'border:1px solid rgba(255,255,255,0.08)',
		'border-radius:999px',
		'padding:5px 14px',
		'font-size:11px',
		'font-weight:500',
		'color:rgba(255,255,255,0.7)',
		'backdrop-filter:blur(10px)',
		'-webkit-backdrop-filter:blur(10px)',
		'pointer-events:none',
		'opacity:0',
		'transition:opacity 0.25s ease',
	].join(';');
	document.body.appendChild(el);
	return el;
})();
let envIndicatorTimer = 0;
function updateEnvIndicator() {
	const meta = getEnvironment(walkManifest, currentEnvName);
	envIndicator.textContent = `Scene: ${meta?.label || currentEnvName}`;
	envIndicator.style.opacity = '1';
	clearTimeout(envIndicatorTimer);
	envIndicatorTimer = setTimeout(() => {
		envIndicator.style.opacity = '0';
	}, 2000);
}

function cycleEnvironment() {
	if (!walkManifest?.environments?.length) return;
	const list = walkManifest.environments;
	const i = list.findIndex((e) => e.name === currentEnvName);
	const next = list[(i + 1) % list.length];
	applyEnvironment(next.name);
	setStatus(`Environment: ${next.label}`);
}

// ── Environment picker (HUD dropdown) ─────────────────────────────────────
// A previews-first dropdown anchored to the HUD's environment button. Built
// once the manifest is known; selecting a tile triggers a faded swap.
let envPickerEl = null;
let envPickerOpen = false;

function ensureEnvPickerStyles() {
	if (document.getElementById('walk-env-picker-style')) return;
	const style = document.createElement('style');
	style.id = 'walk-env-picker-style';
	style.textContent = `
#walk-env-picker{position:fixed;left:16px;top:calc(env(safe-area-inset-top,0) + 96px);z-index:9;width:248px;max-height:70vh;overflow-y:auto;display:flex;flex-direction:column;gap:4px;padding:8px;background:rgba(14,14,18,0.92);border:1px solid rgba(255,255,255,0.1);border-radius:14px;box-shadow:0 18px 48px rgba(0,0,0,0.5);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);opacity:0;transform:translateY(-6px) scale(0.98);transform-origin:top left;transition:opacity .2s ease,transform .2s ease;pointer-events:none}
#walk-env-picker.is-open{opacity:1;transform:translateY(0) scale(1);pointer-events:auto}
.walk-env-opt{display:flex;align-items:center;gap:10px;width:100%;padding:6px;border:1px solid transparent;border-radius:10px;background:transparent;color:#f2f4f8;font:inherit;text-align:left;cursor:pointer;transition:background .15s ease,border-color .15s ease}
.walk-env-opt:hover{background:rgba(255,255,255,0.07)}
.walk-env-opt:focus-visible{outline:2px solid #7aa2ff;outline-offset:1px}
.walk-env-opt[aria-selected="true"]{background:rgba(122,162,255,0.16);border-color:rgba(122,162,255,0.5)}
.walk-env-opt-thumb{width:54px;height:54px;border-radius:8px;object-fit:cover;flex:0 0 54px;background:#1c1c24;border:1px solid rgba(255,255,255,0.08)}
.walk-env-opt-text{display:flex;flex-direction:column;gap:2px;min-width:0}
.walk-env-opt-name{font-size:13px;font-weight:600;line-height:1.1}
.walk-env-opt-blurb{font-size:11px;line-height:1.25;color:rgba(255,255,255,0.55);overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
@media (prefers-reduced-motion:reduce){#walk-env-picker{transition:none}}
`;
	document.head.appendChild(style);
}

function buildEnvPicker() {
	if (envPickerEl || !walkManifest?.environments?.length) return;
	ensureEnvPickerStyles();
	const el = document.createElement('div');
	el.id = 'walk-env-picker';
	el.setAttribute('role', 'listbox');
	el.setAttribute('aria-label', 'Choose environment');
	el.hidden = true;
	el.innerHTML = walkManifest.environments
		.map(
			(e) => `
		<button type="button" class="walk-env-opt" role="option" data-env="${e.name}" aria-selected="${e.name === currentEnvName ? 'true' : 'false'}">
			<img class="walk-env-opt-thumb" src="/environments/${e.preview}" alt="" width="54" height="54" loading="lazy" />
			<span class="walk-env-opt-text"><span class="walk-env-opt-name">${e.label}</span><span class="walk-env-opt-blurb">${e.blurb || ''}</span></span>
		</button>`,
		)
		.join('');
	el.addEventListener('click', (ev) => {
		const btn = ev.target.closest?.('.walk-env-opt');
		if (btn) selectEnvironment(btn.getAttribute('data-env'));
	});
	document.body.appendChild(el);
	envPickerEl = el;
	document.addEventListener('pointerdown', onEnvPickerOutside, true);
}

function updateEnvPickerSelection() {
	if (!envPickerEl) return;
	envPickerEl.querySelectorAll('.walk-env-opt').forEach((b) => {
		b.setAttribute(
			'aria-selected',
			b.getAttribute('data-env') === currentEnvName ? 'true' : 'false',
		);
	});
}

function openEnvPicker() {
	if (!envPickerEl || envPickerOpen) return;
	envPickerOpen = true;
	envPickerEl.hidden = false;
	requestAnimationFrame(() => envPickerEl.classList.add('is-open'));
	envBtn?.setAttribute('aria-expanded', 'true');
}
function closeEnvPicker() {
	if (!envPickerEl || !envPickerOpen) return;
	envPickerOpen = false;
	envPickerEl.classList.remove('is-open');
	envBtn?.setAttribute('aria-expanded', 'false');
	const onEnd = () => {
		if (!envPickerOpen) envPickerEl.hidden = true;
		envPickerEl.removeEventListener('transitionend', onEnd);
	};
	envPickerEl.addEventListener('transitionend', onEnd);
}
function toggleEnvPicker() {
	if (!envPickerEl) return;
	if (envPickerOpen) closeEnvPicker();
	else openEnvPicker();
}
function onEnvPickerOutside(ev) {
	if (!envPickerOpen) return;
	if (envPickerEl.contains(ev.target) || envBtn?.contains(ev.target)) return;
	closeEnvPicker();
}

function selectEnvironment(name) {
	if (name && name !== currentEnvName) {
		const meta = getEnvironment(walkManifest, name);
		applyEnvironment(name);
		if (meta) setStatus(`Environment: ${meta.label}`);
	}
	closeEnvPicker();
}

// Load the manifest, resolve the requested scene (?env=… → localStorage →
// default), build the picker, and stage the world. Failures degrade to the
// default terrain/lighting already in the scene rather than blanking the page.
async function initEnvironments() {
	try {
		walkManifest = await fetchEnvironmentManifest();
	} catch (err) {
		log.warn(
			'[walk] environments manifest unavailable; using default world:',
			err?.message || err,
		);
		return;
	}
	const params = new URLSearchParams(location.search);
	let want = params.get('env');
	if (!want) {
		try {
			want = localStorage.getItem(ENV_KEY);
		} catch {}
	}
	currentEnvName = resolveEnvName(walkManifest, want);
	buildEnvPicker();
	await applyEnvironment(currentEnvName, { initial: true });
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
		'position:fixed',
		'z-index:8',
		'right:16px',
		'top:calc(env(safe-area-inset-top, 0) + 60px)',
		'background:rgba(248,113,113,0.92)',
		'color:#fff',
		'border:1px solid rgba(255,255,255,0.25)',
		'border-radius:999px',
		'padding:6px 14px',
		'font-size:12px',
		'font-weight:600',
		'display:none',
		'align-items:center',
		'gap:8px',
		'pointer-events:none',
		'backdrop-filter:blur(6px)',
		'-webkit-backdrop-filter:blur(6px)',
	].join(';');
	const dot = document.createElement('span');
	dot.style.cssText =
		'width:8px;height:8px;border-radius:50%;background:#fff;animation:walk-rec-pulse 0.9s infinite';
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
	if (gifInterval) {
		clearInterval(gifInterval);
		gifInterval = null;
	}
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
	recorder.ondataavailable = (e) => {
		if (e.data?.size) chunks.push(e.data);
	};

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
		await new Promise((r) => setTimeout(r, GIF_FRAME_INTERVAL));
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
		'position:fixed',
		'z-index:6',
		'right:16px',
		'bottom:calc(28px + env(safe-area-inset-bottom, 0))',
		'width:' + MINIMAP_SIZE + 'px',
		'height:' + MINIMAP_SIZE + 'px',
		'border-radius:12px',
		'overflow:hidden',
		'background:rgba(10,10,10,0.7)',
		'border:1px solid rgba(255,255,255,0.1)',
		'backdrop-filter:blur(6px)',
		'-webkit-backdrop-filter:blur(6px)',
		'display:none',
		'opacity:0',
		'transition:opacity 0.2s ease',
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
		requestAnimationFrame(() => {
			minimapContainer.style.opacity = '1';
		});
	} else {
		minimapContainer.style.opacity = '0';
		setTimeout(() => {
			if (!minimapVisible) minimapContainer.style.display = 'none';
		}, 200);
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

	// Environment props indicator — a dot per static obstacle (trees, towers,
	// pedestals, desks) so the minimap reflects the scenery the avatar weaves
	// through. Positions come from the live collider set.
	ctx.fillStyle = 'rgba(255,255,255,0.2)';
	for (const o of worldObstacles) {
		const px = o.position.x * scale + offsetX;
		const pz = o.position.z * scale + offsetZ;
		ctx.beginPath();
		ctx.arc(px, pz, 2, 0, Math.PI * 2);
		ctx.fill();
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
	// The overlay is a keyboard cheat-sheet (WASD/Shift/Space) and its card is
	// tall enough to cover the joystick on a phone. Both are wrong on touch, so
	// skip the auto-popup there — the on-screen sticks are self-explanatory and
	// the help button still opens it on demand.
	if (IS_TOUCH) return;
	try {
		if (localStorage.getItem(HELP_FIRST_VISIT_KEY) === '1') return;
		localStorage.setItem(HELP_FIRST_VISIT_KEY, '1');
	} catch {
		return;
	}
	// Show help briefly on first visit
	toggleHelp();
	setTimeout(() => {
		if (helpVisible) toggleHelp();
	}, 6000);
}

// ── Physics bring-up ────────────────────────────────────────────────────────
// Rebuild the static + dynamic colliders to match the current scenery. Safe to
// call before physics is ready (no-op) and on every environment swap.
function rebuildPhysicsWorld() {
	if (!physics || !physicsReady) return;
	physics.clearObstacles();
	physics.clearDynamics();
	for (const o of worldObstacles) {
		if (o.type === 'box') physics.addStaticBox(o);
		else if (o.type === 'cylinder') physics.addStaticCylinder(o);
	}
	for (const p of worldDynamicProps) {
		if (p.kind === 'ball') physics.addDynamicBall({ mesh: p.mesh, radius: p.radius });
		else if (p.kind === 'box')
			physics.addDynamicBox({
				mesh: p.mesh,
				halfExtents: { x: p.half, y: p.half, z: p.half },
			});
	}
}

async function initWalkPhysics() {
	try {
		physics = await PhysicsWorld.create({ gravity: { x: 0, y: GRAVITY, z: 0 } });
		// Heightfield ground matching the rendered terrain (not a flat plane), so
		// the character climbs slopes, follows dips, and stands on the real surface.
		physics.addHeightfield(terrain);
		character = physics.createCharacter({
			position: { x: avatarRig.position.x, y: avatarRig.position.y, z: avatarRig.position.z },
			radius: 0.3,
			halfHeight: Math.max(0.3, (avatarHeight || 1.7) / 2 - 0.3),
		});
		physicsReady = true;
		// Catch up to whatever environment is already showing.
		rebuildPhysicsWorld();
	} catch (err) {
		// Solver failed to load — the legacy movement path keeps the scene fully
		// playable, so degrade quietly rather than blocking the experience.
		log.warn('[walk] physics unavailable, using legacy movement:', err);
		physics = null;
		physicsReady = false;
		character = null;
	}
}

// ── Boot ──────────────────────────────────────────────────────────────────
loadAvatar()
	.then(async () => {
		requestAnimationFrame(tick);
		startNet();
		// Begin the leaderboard / analytics metrics pipeline: per-frame distance +
		// time accumulate in the tick loop; this starts the 60s + pagehide flush.
		startWalkMetrics();
		// Stage the world: manifest → ?env / saved / default scene (terrain set
		// synchronously, scenery + HDR streamed in). Degrades to the default
		// ground/lighting if the manifest can't be reached.
		await initEnvironments();

		// Resume where you left off: restore the last walk snapshot (server for
		// signed-in users, else localStorage), apply it to the staged scene, and
		// surface a "Welcome back" toast with a "Start fresh" action. An explicit
		// deep-link (?env / ?avatar) is honoured over the saved value.
		const params = new URLSearchParams(location.search);
		const hasEnvParam = params.has('env');
		const hasAvatarParam = params.has('avatar');
		walkSession = createWalkSession({
			capture: () => captureWalkState(),
			restore: (state) => {
				const s = { ...state };
				if (hasEnvParam) delete s.envId; // URL deep-link wins
				if (hasAvatarParam) {
					delete s.avatarUrl;
					delete s.avatarId;
				}
				return restoreWalkState(s);
			},
		});
		walkSession.ready
			.then((result) => {
				if (result?.restored) {
					const meta = getEnvironment(walkManifest, currentEnvName);
					showWelcomeBackToast({
						sceneLabel: meta?.label || null,
						onStartFresh: () => {
							walkSession.startFresh();
							setStatus('Started a fresh walk');
						},
					});
				}
			})
			.catch(() => {});

		// Bring up the physics solver (async WASM); legacy movement runs until ready.
		initWalkPhysics();
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
		log.error('[walk] failed to load avatar:', err);
		// Tear down the full-screen loading overlay so the error is readable and
		// the scene (default ground/lighting) is visible behind the message.
		dismissLoading();
		const hasParam = new URLSearchParams(location.search).has('avatar');
		const suffix = hasParam ? ' — <a href="/temporary">try the default avatar</a>' : '';
		if (statusEl) {
			statusEl.innerHTML = `failed to load avatar: ${err?.message ?? err}${suffix}`;
			statusEl.classList.add('is-error');
			statusEl.classList.remove('is-hidden');
		}
		requestAnimationFrame(tick);
	});

// Dev-only introspection hook for verifying the physics integration from a
// headless browser. Stripped from production builds (import.meta.env.DEV is
// statically false there, so the whole block is dead-code-eliminated).
if (import.meta.env?.DEV) {
	window.__walkPhysics = () => ({
		ready: physicsReady,
		grounded: characterGrounded,
		pos: { x: avatarRig.position.x, y: avatarRig.position.y, z: avatarRig.position.z },
		obstacles: worldObstacles.length,
		props: worldDynamicProps.map((p) => ({
			kind: p.kind,
			x: p.mesh.position.x,
			y: p.mesh.position.y,
			z: p.mesh.position.z,
		})),
		env: currentEnvName,
	});
}

// ── Avatar picker ────────────────────────────────────────────────────────
{
	const pickerPanel = document.getElementById('walk-avatar-picker');
	const pickerList = document.getElementById('walk-avatar-picker-list');
	const pickerBtn = document.getElementById('walk-avatar-btn');
	const pickerClose = document.getElementById('walk-avatar-picker-close');
	let pickerOpen = false;
	let pickerLoaded = false;
	// Mirror the module-level selection (seeded from ?avatar, updated by session
	// restore + swaps) so the active row reflects a restored avatar.
	let currentAvatarId = selectedAvatarId || new URLSearchParams(location.search).get('avatar') || null;

	function togglePicker() {
		pickerOpen = !pickerOpen;
		if (pickerPanel) pickerPanel.hidden = !pickerOpen;
		if (pickerOpen && !pickerLoaded) loadAvatarList();
	}

	if (pickerBtn) pickerBtn.addEventListener('click', togglePicker);
	if (pickerClose)
		pickerClose.addEventListener('click', () => {
			pickerOpen = false;
			if (pickerPanel) pickerPanel.hidden = true;
		});

	async function loadAvatarList() {
		pickerLoaded = true;
		try {
			const res = await fetch('/api/avatars?limit=20', { credentials: 'include' });
			if (!res.ok) throw new Error('not signed in');
			const data = await res.json();
			const avatars = data?.avatars ?? [];
			if (!avatars.length) {
				pickerList.innerHTML =
					'<div class="walk-avatar-picker-loading">No avatars yet. <a href="/create" style="color:#fff;text-decoration:underline">Create one</a></div>';
				return;
			}
			pickerList.innerHTML = `
				<button class="walk-avatar-opt${!currentAvatarId ? ' is-active' : ''}" data-avatar-url="/avatars/default.glb" data-avatar-id="">
					<div class="walk-avatar-opt-thumb" style="background:#333;display:flex;align-items:center;justify-content:center;font-size:16px">D</div>
					<span class="walk-avatar-opt-name">Default avatar</span>
				</button>
				${avatars
					.map((a) => {
						const thumb = a.thumbnail_url || '';
						const name = a.name || a.slug || 'Untitled';
						const active = currentAvatarId === a.id;
						return `<button class="walk-avatar-opt${active ? ' is-active' : ''}" data-avatar-url="${esc(a.url || '')}" data-avatar-id="${esc(a.id ?? '')}">
						${thumb ? `<img class="walk-avatar-opt-thumb" src="${esc(thumb)}" alt="" loading="lazy" />` : `<div class="walk-avatar-opt-thumb" style="display:flex;align-items:center;justify-content:center;font-size:14px;color:#999">${esc(name[0] || '')}</div>`}
						<span class="walk-avatar-opt-name">${esc(name)}</span>
					</button>`;
					})
					.join('')}
			`;
		} catch {
			pickerList.innerHTML =
				'<div class="walk-avatar-picker-loading"><a href="/login" style="color:#fff;text-decoration:underline">Sign in</a> to use your avatars</div>';
		}
	}

	if (pickerList)
		pickerList.addEventListener('click', async (e) => {
			const btn = e.target.closest('.walk-avatar-opt');
			if (!btn) return;
			const url = btn.dataset.avatarUrl;
			if (!url) return;

			pickerList
				.querySelectorAll('.walk-avatar-opt')
				.forEach((b) => b.classList.remove('is-active'));
			btn.classList.add('is-active');
			currentAvatarId = btn.dataset.avatarId || null;
			setStatus('Switching avatar...');
			try {
				// Shared swap path (build + frame + animate + broadcast) which also
				// updates the session-tracked selection, then persist the choice.
				await applyAvatarSwap(url, currentAvatarId);
				walkSession?.save();
				setStatus('Avatar switched');
			} catch (err) {
				setStatus('Failed to load avatar', { error: true });
				log.error('[walk] avatar switch failed:', err);
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

	if (chatForm)
		chatForm.addEventListener('submit', (e) => {
			e.preventDefault();
			const text = chatInput.value.trim();
			if (!text) return;
			chatInput.value = '';
			chatInput.blur(); // return focus to canvas so WASD works
			const name = nameInput?.value?.trim() || 'you';
			addChatMessage(name, text);
			// Show speech bubble above local avatar
			showSpeechBubbleFor('local', text);
			// Read the avatar as speaking for the life of the bubble — the talking
			// overlay animates the upper body while the message is on screen.
			triggerTalking(text);
			net?.sendChat(text);
		});

	window.addEventListener('keydown', (e) => {
		if (
			e.key === 'Enter' &&
			!e.shiftKey &&
			document.activeElement !== chatInput &&
			document.activeElement?.tagName !== 'INPUT' &&
			document.activeElement?.tagName !== 'TEXTAREA'
		) {
			e.preventDefault();
			chatInput?.focus();
		}
	});

	window._walkChat = { addChatMessage };
}

// ── Coin community theming (HUD + 3D totem) ──────────────────────────────
// When /walk is entered as a coin community (?coin=<mint>&…), we theme the
// world: a top-center HUD carrying the coin's identity + live trade flow, and
// a 3D totem at world center — a billboarded medallion of the coin over a
// glowing ground ring — so each coin's space looks unmistakably its own.
{
	const COIN_FRONTEND = 'https://pump.fun/coin/';
	const TRADE_POLL_MS = 7000;

	// Per-coin accent hue keeps every community visually distinct without us
	// having to assign palettes by hand.
	function coinAccent(seed) {
		let h = 0;
		for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
		const hue = h % 360;
		return { css: `hsl(${hue} 85% 62%)`, three: new Color().setHSL(hue / 360, 0.78, 0.6) };
	}

	function initials(symbol, name) {
		const s = (symbol || name || '?').replace(/[^A-Za-z0-9]/g, '');
		return (s.slice(0, 3) || '?').toUpperCase();
	}

	// Circular coin medallion drawn to a canvas → CanvasTexture. Falls back to a
	// tinted disc with the ticker initials when there's no image or it taints
	// the canvas (cross-origin). Returns { texture, paint(img) } so the async
	// image load can repaint once it arrives.
	function makeMedallionTexture(accent) {
		const size = 320;
		const cv = document.createElement('canvas');
		cv.width = cv.height = size;
		const ctx = cv.getContext('2d');
		const tex = new CanvasTexture(cv);
		tex.anisotropy = 4;

		const drawFallback = () => {
			ctx.clearRect(0, 0, size, size);
			const grad = ctx.createLinearGradient(0, 0, size, size);
			grad.addColorStop(0, accent.css);
			grad.addColorStop(1, 'rgba(10,10,18,0.95)');
			ctx.fillStyle = grad;
			ctx.beginPath();
			ctx.arc(size / 2, size / 2, size / 2 - 8, 0, Math.PI * 2);
			ctx.fill();
			ctx.fillStyle = 'rgba(255,255,255,0.95)';
			ctx.font = `700 ${size * 0.32}px system-ui, sans-serif`;
			ctx.textAlign = 'center';
			ctx.textBaseline = 'middle';
			ctx.fillText(initials(COIN_PARAMS.symbol, COIN_PARAMS.name), size / 2, size / 2 + 4);
		};

		const ring = () => {
			ctx.lineWidth = 14;
			ctx.strokeStyle = accent.css;
			ctx.shadowColor = accent.css;
			ctx.shadowBlur = 22;
			ctx.beginPath();
			ctx.arc(size / 2, size / 2, size / 2 - 9, 0, Math.PI * 2);
			ctx.stroke();
			ctx.shadowBlur = 0;
		};

		drawFallback();
		ring();
		tex.needsUpdate = true;

		if (COIN_PARAMS.image) {
			const img = new Image();
			img.crossOrigin = 'anonymous';
			img.referrerPolicy = 'no-referrer';
			img.onload = () => {
				try {
					ctx.clearRect(0, 0, size, size);
					ctx.save();
					ctx.beginPath();
					ctx.arc(size / 2, size / 2, size / 2 - 12, 0, Math.PI * 2);
					ctx.clip();
					// cover-fit the image into the circle
					const s = Math.max(size / img.width, size / img.height);
					const w = img.width * s,
						h = img.height * s;
					ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
					ctx.restore();
					ring();
					tex.needsUpdate = true;
				} catch {
					drawFallback();
					ring();
					tex.needsUpdate = true;
				}
			};
			img.src = COIN_PARAMS.image;
		}
		return tex;
	}

	// Flat glowing ring laid on the ground around spawn.
	function makeGroundRingTexture(accent) {
		const size = 512;
		const cv = document.createElement('canvas');
		cv.width = cv.height = size;
		const ctx = cv.getContext('2d');
		const c = size / 2;
		for (const [r, a, w] of [
			[c - 18, 0.85, 10],
			[c - 60, 0.35, 6],
			[c - 150, 0.18, 3],
		]) {
			ctx.beginPath();
			ctx.arc(c, c, r, 0, Math.PI * 2);
			ctx.strokeStyle = accent.css;
			ctx.globalAlpha = a;
			ctx.lineWidth = w;
			ctx.shadowColor = accent.css;
			ctx.shadowBlur = 24;
			ctx.stroke();
		}
		ctx.globalAlpha = 1;
		const tex = new CanvasTexture(cv);
		tex.anisotropy = 4;
		return tex;
	}

	class CoinTotem {
		constructor() {
			const accent = coinAccent(COIN_PARAMS.coin);
			this.group = new Group();

			// Ground ring — flat, additive, slowly spinning.
			this.ringMesh = new Mesh(
				new CircleGeometry(2.6, 64),
				new MeshBasicMaterial({
					map: makeGroundRingTexture(accent),
					transparent: true,
					depthWrite: false,
					opacity: 0.9,
				}),
			);
			this.ringMesh.rotation.x = -Math.PI / 2;
			this.ringMesh.position.y = 0.02;
			this.group.add(this.ringMesh);

			// Faint light beam from the ring up to the medallion.
			this.beam = new Mesh(
				new CylinderGeometry(0.04, 0.22, 3.0, 16, 1, true),
				new MeshBasicMaterial({
					color: accent.three,
					transparent: true,
					opacity: 0.12,
					depthWrite: false,
					side: DoubleSide,
				}),
			);
			this.beam.position.y = 1.5;
			this.group.add(this.beam);

			// Billboarded medallion.
			this.medallion = new Mesh(
				new PlaneGeometry(1.5, 1.5),
				new MeshBasicMaterial({
					map: makeMedallionTexture(accent),
					transparent: true,
					depthWrite: false,
				}),
			);
			this.medallion.position.y = 3.4;
			this.group.add(this.medallion);

			// Stand the totem ahead of the spawn point (players spawn facing it) so
			// it reads as a monument to gather around. The medallion rides high
			// enough to clear the avatar's head in the default follow framing.
			this.group.position.set(0, 0, -7);
			scene.add(this.group);
			this._t = 0;
		}

		update(dt) {
			this._t += dt;
			this.ringMesh.rotation.z += dt * 0.15;
			// Bob the medallion gently and keep it facing the camera.
			this.medallion.position.y = 3.4 + Math.sin(this._t * 1.4) * 0.08;
			this.medallion.quaternion.copy(camera.quaternion);
		}
	}

	if (COIN_PARAMS.coin) {
		coinTotem = new CoinTotem();
		document.title = `${COIN_PARAMS.symbol ? '$' + COIN_PARAMS.symbol : 'Coin'} · three.ws`;
		buildCoinHud();
	}

	// ── Coin HUD (top-center) ───────────────────────────────────────────────
	function buildCoinHud() {
		const accent = coinAccent(COIN_PARAMS.coin);
		const hud = document.createElement('div');
		hud.id = 'walk-coin-hud';
		hud.style.cssText = [
			'position:fixed',
			'z-index:7',
			'left:50%',
			'top:calc(env(safe-area-inset-top, 0) + 56px)',
			'transform:translateX(-50%)',
			'display:flex',
			'align-items:center',
			'gap:10px',
			'background:rgba(14,14,22,0.74)',
			`border:1px solid ${accent.css}`,
			'border-radius:999px',
			'padding:6px 14px 6px 7px',
			'backdrop-filter:blur(12px)',
			'-webkit-backdrop-filter:blur(12px)',
			'font-family:system-ui,sans-serif',
			'color:#fff',
			'box-shadow:0 6px 24px rgba(0,0,0,0.35)',
			'max-width:min(92vw, 460px)',
		].join(';');

		const imgHtml = COIN_PARAMS.image
			? `<img loading="lazy" decoding="async" src="${escAttr(COIN_PARAMS.image)}" alt="" referrerpolicy="no-referrer" onerror="this.replaceWith(Object.assign(document.createElement('span'),{textContent:'${escAttr(initials(COIN_PARAMS.symbol, COIN_PARAMS.name))}',className:'coin-fallback'}))" style="width:34px;height:34px;border-radius:50%;object-fit:cover;border:1px solid ${accent.css};flex:0 0 34px;background:#0e0e16" />`
			: `<span class="coin-fallback">${esc(initials(COIN_PARAMS.symbol, COIN_PARAMS.name))}</span>`;

		const title = COIN_PARAMS.symbol ? `$${esc(COIN_PARAMS.symbol)}` : 'Coin';
		const sub = COIN_PARAMS.name
			? esc(COIN_PARAMS.name)
			: `${COIN_PARAMS.coin.slice(0, 4)}…${COIN_PARAMS.coin.slice(-4)}`;

		hud.innerHTML = `
			<style>
				#walk-coin-hud .coin-fallback{width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;background:${accent.css};color:#0b0b12;flex:0 0 34px}
				#walk-coin-hud a{color:rgba(255,255,255,0.85);text-decoration:none}
				#walk-coin-hud a:hover{color:#fff}
				#walk-coin-hud .coin-meta{display:flex;flex-direction:column;line-height:1.15;min-width:0}
				#walk-coin-hud .coin-title{font-weight:700;font-size:14px;letter-spacing:-0.2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
				#walk-coin-hud .coin-sub{font-size:11px;color:rgba(255,255,255,0.55);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
				#walk-coin-hud .coin-trade{font-size:11px;font-variant-numeric:tabular-nums;padding:2px 8px;border-radius:999px;background:rgba(255,255,255,0.06);white-space:nowrap;opacity:0;transition:opacity .25s}
				#walk-coin-hud .coin-trade.is-live{opacity:1}
				#walk-coin-hud .coin-trade.buy{color:#34d399}
				#walk-coin-hud .coin-trade.sell{color:#f87171}
				#walk-coin-hud .coin-actions{display:flex;gap:8px;align-items:center;margin-left:2px;border-left:1px solid rgba(255,255,255,0.12);padding-left:10px}
				#walk-coin-hud .coin-actions a{font-size:11px;font-weight:600}
				body.is-zen #walk-coin-hud{opacity:0;pointer-events:none}
			</style>
			${imgHtml}
			<a class="coin-meta" href="${COIN_FRONTEND}${escAttr(COIN_PARAMS.coin)}" target="_blank" rel="noopener" title="Open on pump.fun">
				<span class="coin-title">${title}</span>
				<span class="coin-sub">${sub}</span>
			</a>
			<span class="coin-trade" data-trade></span>
			<span class="coin-actions">
				<a href="/communities" title="Switch community">↩ coins</a>
			</span>`;
		document.body.appendChild(hud);

		// Live trade flow — last on-chain trade for this mint, refreshed on an
		// interval. Real data only: on any failure we leave the chip hidden.
		const tradeEl = hud.querySelector('[data-trade]');
		const url = `/api/pump/coin-trades?mint=${encodeURIComponent(COIN_PARAMS.coin)}&limit=1`;
		let stopped = false;
		async function pollTrade() {
			if (stopped) return;
			try {
				const r = await fetch(url, { headers: { accept: 'application/json' } });
				if (r.ok) {
					const data = await r.json();
					const t = data?.trades?.[0];
					if (t && Number.isFinite(t.sol_amount)) {
						const sol =
							t.sol_amount >= 1 ? t.sol_amount.toFixed(2) : t.sol_amount.toFixed(3);
						tradeEl.textContent = `${t.is_buy ? '▲' : '▼'} ${sol} SOL`;
						tradeEl.className = `coin-trade is-live ${t.is_buy ? 'buy' : 'sell'}`;
						tradeEl.title = 'Most recent on-chain trade';
					}
				}
			} catch {
				/* offline / rate-limited — keep last value */
			}
			if (!stopped) setTimeout(pollTrade, TRADE_POLL_MS);
		}
		pollTrade();
		window.addEventListener('beforeunload', () => {
			stopped = true;
		});
	}

	function escAttr(s) {
		return String(s).replace(
			/[<>&"]/g,
			(c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c],
		);
	}
}

// ── Content billboard ────────────────────────────────────────────────────────
// A cheap, static billboard you can drop content onto — a framed panel on two
// posts standing as a backdrop behind spawn. It is decoration, not an ad unit:
// no targeting, no tracking, no network of its own. It just shows one image (or
// a short caption) so a space has something on its walls.
//
//   /temporary?board=<image-url>   put your own content on it
//   /temporary?boardText=<text>    caption strip under the image (or use it alone)
//   /temporary?board=off           hide it entirely
//
// With no params it falls back to the coin's own image in a coin world, or the
// three.ws cover image on the mainland, so the panel is never blank.
{
	const params = new URLSearchParams(location.search);
	const boardParam = (params.get('board') || '').trim();
	const boardText = (params.get('boardText') || '').slice(0, 80).trim();

	// Resolve the content image: explicit param → the coin's image → cover image.
	function resolveContentImage() {
		if (boardParam && boardParam !== 'off') {
			try {
				const u = new URL(boardParam, location.origin);
				if (u.protocol === 'http:' || u.protocol === 'https:') return u.href;
			} catch {
				/* not a URL — treated as no image, caption-only is still valid */
			}
		}
		if (COIN_PARAMS.image) return COIN_PARAMS.image;
		return new URL('/og-image.png', location.origin).href;
	}

	// 16:9 content surface painted to a canvas → CanvasTexture. The image is
	// cover-fit; a tinted gradient + caption stands in until (or unless) it loads,
	// so cross-origin taint or a 404 degrades to something legible, never blank.
	// Parameterized so the same painter draws the world default and any paid
	// placement that streams in later (see ContentBillboard.setContent).
	function paintContentTexture({ imageSrc, caption } = {}) {
		const W = 1024;
		const H = 576;
		const cv = document.createElement('canvas');
		cv.width = W;
		cv.height = H;
		const ctx = cv.getContext('2d');
		const tex = new CanvasTexture(cv);
		tex.anisotropy = 8;

		const label = caption || (COIN_PARAMS.symbol ? `$${COIN_PARAMS.symbol}` : 'three.ws');

		const drawCaptionStrip = () => {
			if (!caption) return;
			const stripH = Math.round(H * 0.16);
			ctx.fillStyle = 'rgba(8,9,14,0.72)';
			ctx.fillRect(0, H - stripH, W, stripH);
			ctx.fillStyle = 'rgba(255,255,255,0.96)';
			ctx.font = `600 ${Math.round(stripH * 0.46)}px system-ui, sans-serif`;
			ctx.textAlign = 'center';
			ctx.textBaseline = 'middle';
			ctx.fillText(caption, W / 2, H - stripH / 2, W - 48);
		};

		const drawFallback = () => {
			const grad = ctx.createLinearGradient(0, 0, W, H);
			grad.addColorStop(0, '#12141f');
			grad.addColorStop(1, '#05060a');
			ctx.fillStyle = grad;
			ctx.fillRect(0, 0, W, H);
			ctx.fillStyle = 'rgba(255,255,255,0.92)';
			ctx.font = `700 ${Math.round(H * 0.18)}px system-ui, sans-serif`;
			ctx.textAlign = 'center';
			ctx.textBaseline = 'middle';
			ctx.fillText(label, W / 2, H / 2, W - 64);
		};

		drawFallback();
		tex.needsUpdate = true;

		if (imageSrc) {
			const img = new Image();
			img.crossOrigin = 'anonymous';
			img.referrerPolicy = 'no-referrer';
			img.onload = () => {
				try {
					ctx.clearRect(0, 0, W, H);
					const s = Math.max(W / img.width, H / img.height);
					const w = img.width * s;
					const h = img.height * s;
					ctx.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
					drawCaptionStrip();
					tex.needsUpdate = true;
				} catch {
					drawFallback();
					tex.needsUpdate = true;
				}
			};
			// On error we keep the fallback that's already painted — no handler needed.
			img.src = imageSrc;
		}
		return tex;
	}

	// Footprint and proportions (metres). Panel rides above head height on two
	// posts so the avatar can pass beneath it; only the posts are solid.
	const PANEL_W = 8;
	const PANEL_H = 4.5;
	const PANEL_BOTTOM = 2.4; // clearance from ground to the underside of the frame
	const POST_HALF = 0.14; // post half-thickness
	const POST_X = PANEL_W / 2 - 0.7; // inset from the panel edges
	const FOOT = { x: 0, z: -17 }; // behind spawn (origin) and the coin totem (z=-7)

	class ContentBillboard {
		constructor() {
			this.group = new Group();
			const panelCenterY = PANEL_BOTTOM + PANEL_H / 2;

			const postMat = new MeshStandardMaterial({
				color: 0x2a2d38,
				roughness: 0.7,
				metalness: 0.2,
			});
			const postGeo = new BoxGeometry(POST_HALF * 2, PANEL_BOTTOM + 0.2, POST_HALF * 2);
			for (const sx of [-1, 1]) {
				const post = new Mesh(postGeo, postMat);
				post.position.set(sx * POST_X, (PANEL_BOTTOM + 0.2) / 2, 0);
				post.castShadow = true;
				post.receiveShadow = true;
				this.group.add(post);
			}

			// Backing frame — a thin dark slab a touch larger than the screen so the
			// panel reads as a solid board from any angle and the back isn't see-through.
			const frame = new Mesh(
				new BoxGeometry(PANEL_W + 0.4, PANEL_H + 0.4, 0.16),
				new MeshStandardMaterial({ color: 0x16181f, roughness: 0.85, metalness: 0.1 }),
			);
			frame.position.set(0, panelCenterY, 0);
			frame.castShadow = true;
			this.group.add(frame);

			// Content screen — unlit so the artwork is always legible and cheap to
			// draw, sitting just proud of the frame's front face. Starts on the world
			// default; a paid placement (if any) swaps in via setContent() once the
			// /api/billboard fetch resolves.
			this.screen = new Mesh(
				new PlaneGeometry(PANEL_W, PANEL_H),
				new MeshBasicMaterial({
					map: paintContentTexture({ imageSrc: resolveContentImage(), caption: boardText }),
					toneMapped: false,
				}),
			);
			this.screen.position.set(0, panelCenterY, 0.09);
			this.group.add(this.screen);

			scene.add(this.group);
			this.placeOnTerrain();
		}

		// Swap the panel's artwork. Repaints a fresh texture and disposes the old
		// one. A placement with no image but a caption shows the caption full-bleed;
		// an empty placement reverts to the world default.
		setContent({ image, caption } = {}) {
			const imageSrc = image || (caption ? null : resolveContentImage());
			const tex = paintContentTexture({ imageSrc, caption });
			const prev = this.screen.material.map;
			this.screen.material.map = tex;
			this.screen.material.needsUpdate = true;
			prev?.dispose();
		}

		// Sit the structure on the live terrain — re-called on every environment
		// swap so the billboard tracks the new ground instead of floating or sinking.
		placeOnTerrain() {
			const y = terrain ? terrain.heightAt(FOOT.x, FOOT.z) : 0;
			this.group.position.set(FOOT.x, y, FOOT.z);
		}

		// Static box colliders for the two posts (panel sits above head height, so
		// it is intentionally walk-through). Y is resolved against the live terrain.
		colliders() {
			const gy = terrain ? terrain.heightAt(FOOT.x, FOOT.z) : 0;
			const hy = (PANEL_BOTTOM + 0.2) / 2;
			return [-1, 1].map((sx) => ({
				type: 'box',
				position: { x: FOOT.x + sx * POST_X, y: gy + hy, z: FOOT.z },
				halfExtents: { x: POST_HALF, y: hy, z: POST_HALF },
				rotationY: 0,
			}));
		}
	}

	if (boardParam !== 'off') {
		contentBillboard = new ContentBillboard();

		// In a coin world, the billboard is a paid community canvas: fetch whoever
		// currently holds the board and show their content (unless the visitor
		// passed an explicit ?board= preview override, which wins locally).
		const hasLocalOverride = boardParam && boardParam !== 'off';
		if (COIN_PARAMS.coin && !hasLocalOverride) {
			fetch(`/api/billboard?coin=${encodeURIComponent(COIN_PARAMS.coin)}`, {
				headers: { accept: 'application/json' },
			})
				.then((r) => (r.ok ? r.json() : null))
				.then((data) => {
					const p = data?.placement;
					if (p && (p.image || p.caption)) {
						contentBillboard.setContent({ image: p.image, caption: p.caption });
					}
				})
				.catch(() => {
					/* offline / not configured — the world default stays on the panel */
				});

			buildBillboardPublisher();
		}
	}

	// ── Publish flow ─────────────────────────────────────────────────────────
	// A compact "Feature your content" button + dialog that takes an image URL
	// and caption and pays for the slot over x402 (window.X402.pay, loaded from
	// /x402.js). On a settled payment the panel updates immediately for this
	// viewer; everyone else picks it up from /api/billboard on their next load.
	function buildBillboardPublisher() {
		const SLOT_LABEL = '$0.05 · 6 hours';
		const btn = document.createElement('button');
		btn.id = 'walk-billboard-publish';
		btn.type = 'button';
		btn.textContent = '📢 Feature your content';
		btn.title = 'Put your image on this world’s billboard';
		btn.style.cssText = [
			'position:fixed',
			'z-index:7',
			'left:16px',
			'bottom:calc(env(safe-area-inset-bottom, 0) + 128px)',
			'display:inline-flex',
			'align-items:center',
			'gap:6px',
			'padding:8px 12px',
			'border-radius:999px',
			'border:1px solid rgba(255,255,255,0.16)',
			'background:rgba(14,16,24,0.78)',
			'backdrop-filter:blur(8px)',
			'-webkit-backdrop-filter:blur(8px)',
			'color:#fff',
			'font:600 13px/1 system-ui, sans-serif',
			'cursor:pointer',
			'transition:transform .12s ease, border-color .12s ease, background .12s ease',
		].join(';');
		btn.addEventListener('pointerenter', () => {
			btn.style.transform = 'translateY(-1px)';
			btn.style.borderColor = 'rgba(255,255,255,0.32)';
		});
		btn.addEventListener('pointerleave', () => {
			btn.style.transform = '';
			btn.style.borderColor = 'rgba(255,255,255,0.16)';
		});
		btn.addEventListener('click', openPublishDialog);
		document.body.appendChild(btn);

		let overlay = null;

		function closeDialog() {
			overlay?.remove();
			overlay = null;
		}

		function openPublishDialog() {
			if (overlay) return;
			overlay = document.createElement('div');
			overlay.style.cssText = [
				'position:fixed',
				'inset:0',
				'z-index:60',
				'display:flex',
				'align-items:center',
				'justify-content:center',
				'padding:20px',
				'background:rgba(4,5,9,0.6)',
				'backdrop-filter:blur(4px)',
				'-webkit-backdrop-filter:blur(4px)',
			].join(';');
			overlay.addEventListener('click', (e) => {
				if (e.target === overlay) closeDialog();
			});

			const card = document.createElement('div');
			card.setAttribute('role', 'dialog');
			card.setAttribute('aria-label', 'Feature your content on the billboard');
			card.style.cssText = [
				'width:min(420px, 100%)',
				'background:#0e1018',
				'border:1px solid rgba(255,255,255,0.12)',
				'border-radius:16px',
				'padding:20px',
				'box-shadow:0 24px 60px rgba(0,0,0,0.55)',
				'color:#fff',
				'font-family:system-ui, sans-serif',
			].join(';');
			card.innerHTML = `
				<div style="font:700 16px/1.2 system-ui;margin-bottom:4px">Feature your content</div>
				<div style="font:400 13px/1.45 system-ui;color:rgba(255,255,255,0.6);margin-bottom:16px">
					Hold this world’s billboard for everyone who walks in. ${SLOT_LABEL}. It’s a content
					slot, not an ad — nothing is tracked.
				</div>
				<label style="display:block;font:600 12px/1 system-ui;color:rgba(255,255,255,0.7);margin-bottom:6px">Image URL</label>
				<input id="bb-image" type="url" inputmode="url" placeholder="https://…/art.png"
					style="width:100%;box-sizing:border-box;padding:10px 12px;margin-bottom:14px;border-radius:10px;border:1px solid rgba(255,255,255,0.14);background:#05060a;color:#fff;font:400 14px system-ui" />
				<label style="display:block;font:600 12px/1 system-ui;color:rgba(255,255,255,0.7);margin-bottom:6px">Caption <span style="font-weight:400;color:rgba(255,255,255,0.4)">(optional)</span></label>
				<input id="bb-caption" type="text" maxlength="80" placeholder="gm from the gallery"
					style="width:100%;box-sizing:border-box;padding:10px 12px;margin-bottom:8px;border-radius:10px;border:1px solid rgba(255,255,255,0.14);background:#05060a;color:#fff;font:400 14px system-ui" />
				<div id="bb-msg" role="status" style="min-height:18px;font:500 12px/1.4 system-ui;color:#ffb4b4;margin-bottom:10px"></div>
				<div style="display:flex;gap:8px;justify-content:flex-end">
					<button id="bb-cancel" type="button" style="padding:9px 14px;border-radius:10px;border:1px solid rgba(255,255,255,0.14);background:transparent;color:rgba(255,255,255,0.8);font:600 13px system-ui;cursor:pointer">Cancel</button>
					<button id="bb-pay" type="button" style="padding:9px 16px;border-radius:10px;border:0;background:#5a8dee;color:#fff;font:700 13px system-ui;cursor:pointer">Feature — pay</button>
				</div>`;
			overlay.appendChild(card);
			document.body.appendChild(overlay);

			const imageEl = card.querySelector('#bb-image');
			const captionEl = card.querySelector('#bb-caption');
			const msgEl = card.querySelector('#bb-msg');
			const payBtn = card.querySelector('#bb-pay');
			card.querySelector('#bb-cancel').addEventListener('click', closeDialog);
			imageEl.focus();

			const setMsg = (t) => {
				msgEl.textContent = t || '';
			};

			payBtn.addEventListener('click', async () => {
				const image = imageEl.value.trim();
				const caption = captionEl.value.trim();
				if (!image && !caption) {
					setMsg('Add an image URL or a caption.');
					return;
				}
				if (image && !/^https?:\/\//i.test(image)) {
					setMsg('Image URL must start with http:// or https://');
					return;
				}
				if (!window.X402?.pay) {
					setMsg('Wallet widget still loading — try again in a second.');
					return;
				}
				setMsg('');
				payBtn.disabled = true;
				payBtn.textContent = 'Open wallet…';
				try {
					const qs = new URLSearchParams({ coin: COIN_PARAMS.coin });
					if (image) qs.set('image', image);
					if (caption) qs.set('caption', caption);
					const out = await window.X402.pay({
						endpoint: `/api/x402/billboard?${qs.toString()}`,
						method: 'GET',
						merchant: 'three.ws Coin-World Billboard',
						action: 'Feature your content on this world’s billboard',
						autoConnect: true,
					});
					const res = out?.result;
					if (!res?.ok) throw new Error(res?.error || 'placement did not settle');
					contentBillboard.setContent({ image: res.image, caption: res.caption });
					closeDialog();
				} catch (err) {
					if (err?.code === 'cancelled') {
						payBtn.disabled = false;
						payBtn.textContent = 'Feature — pay';
						return;
					}
					setMsg(err?.message || 'Payment failed — please try again.');
					payBtn.disabled = false;
					payBtn.textContent = 'Feature — pay';
				}
			});

			const onKey = (e) => {
				if (e.key === 'Escape') {
					closeDialog();
					window.removeEventListener('keydown', onKey);
				}
			};
			window.addEventListener('keydown', onKey);
		}
	}
}

// ── Restore zen preference ───────────────────────────────────────────────
// Runs after all UI state is declared. URL param wins, then stored choice.
(() => {
	const param = new URLSearchParams(location.search).get('ui');
	if (param === 'hidden' || param === 'off') {
		setZen(true);
		return;
	}
	if (param === 'on' || param === 'shown') return;
	try {
		if (localStorage.getItem(ZEN_STORAGE_KEY) === '1') setZen(true);
	} catch {}
})();

// ── Programmatic control mode (REST) ─────────────────────────────────────────
// When the page is opened as /walk?control=<sessionId>&ck=<controlToken>, an
// external system (another agent, a CI bot, a webhook) is driving this avatar
// over the control API (api/walk/control/[action].js). We short-poll the
// session every second, fold our live position into the same request, and apply
// each drained command to the real scene:
//
//   move    → set the existing waypointTarget; the locomotion pipeline walks
//             (and faces, and animates) the avatar there, exactly as a minimap
//             click does.
//   gesture → gestures.play(name) — the same call the wheel / quick keys use.
//   say     → a speech bubble above the avatar + the talking overlay, with
//             optional browser TTS when the command requested voice.
//   env     → applyEnvironment(name) — a live, faded environment swap.
//
// Commands are delivered exactly once by the server, so we simply apply what each
// poll returns. The poll cadence backs off on transient failures so a blip never
// turns into a request storm, and stops cleanly if the session 401s (expired or
// revoked) — there is nothing left to drive.
(() => {
	const params = new URLSearchParams(location.search);
	const sessionId = (params.get('control') || '').trim();
	const controlToken = (params.get('ck') || '').trim();
	if (!sessionId || !controlToken) return;

	const POLL_MS = 1000;
	const MAX_BACKOFF_MS = 15000;
	let backoff = POLL_MS;
	let stopped = false;
	let inFlight = false;

	function speakControl(text, withVoice) {
		showSpeechBubbleFor('local', text);
		triggerTalking(text);
		net?.sendChat(text);
		if (withVoice && typeof window.speechSynthesis !== 'undefined') {
			try {
				const u = new SpeechSynthesisUtterance(text.slice(0, 280));
				u.rate = 1;
				u.pitch = 1;
				window.speechSynthesis.cancel();
				window.speechSynthesis.speak(u);
			} catch {
				/* synthesis unavailable — the bubble already conveyed the line */
			}
		}
	}

	function applyControlCommand(cmd) {
		switch (cmd.kind) {
			case 'move': {
				if (Number.isFinite(cmd.x) && Number.isFinite(cmd.z)) {
					// Clamp to just inside the playable disc, mirroring the server.
					let { x, z } = cmd;
					const r = Math.hypot(x, z);
					if (r > GROUND_RADIUS - 0.5) {
						const k = (GROUND_RADIUS - 0.5) / r;
						x *= k;
						z *= k;
					}
					waypointTarget = { x, z };
					setStatus('Remote control: walking to target');
				}
				break;
			}
			case 'gesture': {
				if (cmd.gesture) {
					gestures?.play(cmd.gesture);
					setStatus(`Remote control: ${cmd.gesture}`);
				}
				break;
			}
			case 'say': {
				if (cmd.text) speakControl(String(cmd.text), !!cmd.voice);
				break;
			}
			case 'env': {
				if (cmd.env && cmd.env !== currentEnvName) {
					applyEnvironment(cmd.env);
					setStatus(`Remote control: environment → ${cmd.env}`);
				}
				break;
			}
			default:
				break;
		}
	}

	async function pollOnce() {
		if (stopped || inFlight) return;
		inFlight = true;
		// Fold our live state into the poll so the controller's /state read reflects
		// the real avatar without a second request.
		const q = new URLSearchParams({ sessionId, ck: controlToken });
		if (avatar) {
			q.set('x', avatarRig.position.x.toFixed(3));
			q.set('z', avatarRig.position.z.toFixed(3));
			q.set('facing', avatarYaw.toFixed(3));
			q.set('motion', currentMotion);
			q.set('cenv', currentEnvName);
		}
		try {
			const res = await fetch(`/api/walk/control/session?${q.toString()}`, {
				headers: { accept: 'application/json' },
				cache: 'no-store',
			});
			if (res.status === 401 || res.status === 403) {
				// Session expired or revoked — nothing left to drive.
				stopped = true;
				setStatus('Remote-control session ended', { sticky: false });
				return;
			}
			if (res.ok) {
				const data = await res.json();
				for (const cmd of data.commands || []) applyControlCommand(cmd);
				backoff = POLL_MS; // healthy round-trip resets the cadence
			} else {
				backoff = Math.min(MAX_BACKOFF_MS, backoff * 2);
			}
		} catch {
			// Offline / transient — back off and retry.
			backoff = Math.min(MAX_BACKOFF_MS, backoff * 2);
		} finally {
			inFlight = false;
			if (!stopped) setTimeout(pollOnce, backoff);
		}
	}

	window.addEventListener('beforeunload', () => {
		stopped = true;
	});

	setStatus('Remote control active — awaiting commands', { sticky: false });
	// First poll after a short delay so the avatar/scene have a frame to settle.
	setTimeout(pollOnce, 600);
})();
