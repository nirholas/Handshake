// /walk-embed — chrome-less, iframe-safe walking avatar
//
// Duplicated from src/walk.js so embeds can evolve independently without
// destabilizing the canonical /walk page. Differences vs /walk:
//   • No multiplayer (WalkNet) — embeds don't connect strangers to a room.
//   • No AR camera passthrough — embed hosts can't grant getUserMedia.
//   • No HUD card, no help text, no online pill.
//   • Reads ?bg, ?controls, ?autoplay, ?env, ?ground, ?orbit query params.
//   • postMessage's `walk:ready` on load and `walk:position` each tick.
//
// If you find yourself fixing the same bug here and in walk.js, consider
// extracting a shared controller — but until then duplication keeps the
// blast radius small.

import {
	AmbientLight,
	Box3,
	CircleGeometry,
	Clock,
	Color,
	DirectionalLight,
	Fog,
	Group,
	HemisphereLight,
	Mesh,
	MeshStandardMaterial,
	PCFSoftShadowMap,
	PerspectiveCamera,
	PMREMGenerator,
	Scene,
	ShadowMaterial,
	Vector3,
	WebGLRenderer,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import nipplejs from 'nipplejs';

import { AnimationManager } from './animation-manager.js';

const AVATAR_URL_DEFAULT = '/avatars/default.glb';

// ── Embed params ─────────────────────────────────────────────────────────
const params = new URLSearchParams(location.search);
const BG_PARAM = params.get('bg'); // '' or 'transparent' or '#rrggbb'
const CONTROLS = (params.get('controls') || 'joystick').toLowerCase(); // 'joystick' | 'keyboard' | 'none'
const AUTOPLAY = params.get('autoplay') === 'true' || params.get('autoplay') === '1';
const SHOW_GROUND = params.get('ground') !== 'false';
const ORBIT_ENABLED = params.get('orbit') !== 'false';
const ENV_PARAM = (params.get('env') || 'studio').toLowerCase();

// Real, self-contained scene presets. Each preset retints the clear color,
// fog, ground disc, and the hemisphere/sun lights — no external HDRIs to
// fetch, so the embed stays a single iframe with no extra requests. An
// explicit ?bg= always overrides the preset's background (see applyEnvironment).
const ENVIRONMENTS = {
	studio: { bg: null,     ground: 0x202833, hemiSky: 0xbcd6ff, hemiGround: 0x202830, hemiInt: 0.6,  sun: 0xffffff, sunInt: 1.4, fog: null },
	void:   { bg: 0x08090b, ground: 0x101218, hemiSky: 0x3a4250, hemiGround: 0x0a0c0f, hemiInt: 0.5,  sun: 0xcdd6ff, sunInt: 1.1, fog: null },
	beach:  { bg: 0x86c5ff, ground: 0xe2c98a, hemiSky: 0xcfeaff, hemiGround: 0xb89968, hemiInt: 0.9,  sun: 0xfff2d6, sunInt: 1.7, fog: [0x86c5ff, 16, 44] },
	sunset: { bg: 0xff9d6e, ground: 0x4a3340, hemiSky: 0xffc59e, hemiGround: 0x2a1f33, hemiInt: 0.8,  sun: 0xffcaa0, sunInt: 1.6, fog: [0xff9d6e, 14, 42] },
	night:  { bg: 0x0a1020, ground: 0x141a28, hemiSky: 0x2a3a66, hemiGround: 0x05070d, hemiInt: 0.45, sun: 0x9fb4ff, sunInt: 0.8, fog: [0x0a1020, 16, 46] },
	grid:   { bg: 0x0d0f12, ground: 0x1a1f2a, hemiSky: 0x4a5a80, hemiGround: 0x0d0f12, hemiInt: 0.7,  sun: 0xffffff, sunInt: 1.3, fog: null },
};

function resolveAvatarUrl() {
	const id = params.get('avatar');
	if (!id) return AVATAR_URL_DEFAULT;
	// Go through the same-origin GLB proxy (api/avatars/[id]/glb) instead
	// of the metadata JSON. The proxy streams the bytes with
	// `Access-Control-Allow-Origin: *` so hosts on any origin can iframe
	// this page. Fetching the JSON first would just give us back the raw
	// R2 URL, which R2 only allows from the three.ws origin and breaks the
	// moment the embed is dropped onto a third-party site.
	return `/api/avatars/${encodeURIComponent(id)}/glb`;
}

const ANIMATIONS_MANIFEST_URL = '/animations/manifest.json';
const CLIP_IDLE = 'idle';
const CLIP_WALK = 'av-walk-feminine';
const CLIP_RUN = 'av-walk-feminine'; // no separate run clip; timeScale handles pace difference

const WALK_SPEED = 1.6;
const RUN_SPEED = 4.0;
const NATURAL_WALK_SPEED = 1.5;
const NATURAL_RUN_SPEED = 3.4;
const TURN_LERP = 0.18;
const CAM_LERP = 0.12;
const LEAN_WALK_RAD = 0.05;
const LEAN_RUN_RAD = 0.13;
const LEAN_LERP = 0.12;
const CAM_OFFSET = new Vector3(0, 1.85, 3.6);
const CAM_LOOK_OFFSET = new Vector3(0, 1.1, 0);
const GROUND_RADIUS = 12;

// ── DOM ───────────────────────────────────────────────────────────────────
const stage = document.getElementById('walk-stage');
const canvas = document.getElementById('walk-canvas');
const joystickEl = document.getElementById('walk-joystick');
const statusEl = document.getElementById('walk-status');

stage.dataset.controls = CONTROLS;

// Apply background. Default is transparent so the host page shows through.
// `?bg=#101820` paints a solid color; `?bg=transparent` is explicit no-op.
if (BG_PARAM && BG_PARAM !== 'transparent') {
	document.body.style.background = BG_PARAM;
	stage.style.background = BG_PARAM;
}

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

// ── postMessage bridge to host page ──────────────────────────────────────
// The host frame learns about embed lifecycle + avatar position via
// window.postMessage. We post to window.parent only when it's a different
// window (i.e. we're actually inside an iframe). Direct page loads still
// work — they just don't emit messages.
const INSIDE_IFRAME = window.parent && window.parent !== window;
function postToHost(payload) {
	if (!INSIDE_IFRAME) return;
	try { window.parent.postMessage(payload, '*'); } catch {}
}

// ── Renderer / scene ──────────────────────────────────────────────────────
const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.setClearColor(0x000000, BG_PARAM && BG_PARAM !== 'transparent' ? 1 : 0);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = PCFSoftShadowMap;

const scene = new Scene();

const pmrem = new PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

scene.add(new AmbientLight(0xffffff, 0.55));
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

// Ground disc — visible by default; ?ground=false swaps it for a shadow
// catcher so the avatar floats on the host page's background.
const groundOpaque = new Mesh(
	new CircleGeometry(GROUND_RADIUS, 64),
	new MeshStandardMaterial({ color: 0x202833, roughness: 0.95, metalness: 0.0 }),
);
groundOpaque.rotation.x = -Math.PI / 2;
groundOpaque.receiveShadow = true;
groundOpaque.visible = SHOW_GROUND;
scene.add(groundOpaque);

const groundShadowCatcher = new Mesh(
	new CircleGeometry(GROUND_RADIUS, 64),
	new ShadowMaterial({ opacity: 0.32 }),
);
groundShadowCatcher.rotation.x = -Math.PI / 2;
groundShadowCatcher.receiveShadow = true;
groundShadowCatcher.visible = !SHOW_GROUND;
scene.add(groundShadowCatcher);

// Apply a scene preset. An explicit ?bg= wins over the preset background so
// transparent/custom embeds keep working; otherwise the preset paints the
// clear color and matching fog. Live-swappable via the `walk:setEnv` message.
function applyEnvironment(id) {
	const env = ENVIRONMENTS[id] || ENVIRONMENTS.studio;
	if (BG_PARAM && BG_PARAM !== 'transparent') {
		renderer.setClearColor(new Color(BG_PARAM), 1);
	} else if (env.bg == null) {
		renderer.setClearColor(0x000000, 0); // transparent — host page shows through
	} else {
		renderer.setClearColor(new Color(env.bg), 1);
		document.body.style.background = `#${env.bg.toString(16).padStart(6, '0')}`;
	}
	scene.fog = env.fog ? new Fog(env.fog[0], env.fog[1], env.fog[2]) : null;
	groundOpaque.material.color.setHex(env.ground);
	hemi.color.setHex(env.hemiSky);
	hemi.groundColor.setHex(env.hemiGround);
	hemi.intensity = env.hemiInt;
	sun.color.setHex(env.sun);
	sun.intensity = env.sunInt;
}
applyEnvironment(ENV_PARAM);

const camera = new PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.05, 200);
const avatarRig = new Group();
scene.add(avatarRig);

const camDesired = new Vector3();
const camLookTarget = new Vector3();
const camLookCurrent = new Vector3();

let cameraYaw = 0;
let cameraPitch = 0.05;
const PITCH_MIN = -0.6;
const PITCH_MAX = 0.7;

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

// ── Drag-to-orbit ─────────────────────────────────────────────────────────
// Skipped entirely when ?orbit=false (e.g. the SDK uses it for autoplay-only
// floating avatars where stray pointer drags would just look broken).
if (ORBIT_ENABLED) {
	let dragging = false;
	let lastX = 0, lastY = 0;
	let downId = -1;

	canvas.addEventListener('pointerdown', (e) => {
		const jRect = joystickEl.getBoundingClientRect();
		const overJoystick = CONTROLS === 'joystick' && (
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

// ── Input state ───────────────────────────────────────────────────────────
const input = {
	keys: { forward: 0, back: 0, left: 0, right: 0, run: false },
	joy: { x: 0, y: 0, active: false },
	autoplay: { active: false, t: 0 },
	_speedMultiplier: 1.0,
};

if (CONTROLS === 'keyboard' || CONTROLS === 'joystick') {
	window.addEventListener('keydown', (e) => {
		switch (e.code) {
			case 'KeyW': case 'ArrowUp':    input.keys.forward = 1; break;
			case 'KeyS': case 'ArrowDown':  input.keys.back = 1; break;
			case 'KeyA': case 'ArrowLeft':  input.keys.left = 1; break;
			case 'KeyD': case 'ArrowRight': input.keys.right = 1; break;
			case 'ShiftLeft': case 'ShiftRight': input.keys.run = true; break;
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
}

if (CONTROLS === 'joystick') {
	const joystick = nipplejs.create({
		zone: joystickEl,
		mode: 'static',
		position: { left: '50%', top: '50%' },
		size: 110,
		color: 'rgba(255,255,255,0.85)',
		restOpacity: 0.6,
	});
	joystick.on('move', (evt) => {
		// nipplejs v1 passes a single { type, target, data } event object.
		const data = evt?.data;
		if (data?.vector) {
			// data.vector is the proportional stick displacement, already in
			// [-1, 1] per axis (magnitude ≤ 1); y positive = pushed up = forward.
			input.joy.x = data.vector.x;
			input.joy.y = data.vector.y;
			input.joy.active = Math.hypot(data.vector.x, data.vector.y) > 0.05;
		}
	});
	joystick.on('end', () => {
		input.joy.x = 0;
		input.joy.y = 0;
		input.joy.active = false;
	});
}

// ── Avatar loading + animations ──────────────────────────────────────────
const animationManager = new AnimationManager();
let avatar = null;
let avatarYaw = 0;
let avatarLean = 0;
let currentMotion = 'idle';

async function loadAvatar() {
	setStatus('loading avatar…', { sticky: true });

	const avatarUrl = resolveAvatarUrl();
	const loader = new GLTFLoader();
	const gltf = await loader.loadAsync(avatarUrl);
	avatar = gltf.scene;
	avatar.traverse((n) => {
		if (n.isMesh) {
			n.castShadow = true;
			n.receiveShadow = false;
			if (n.material && 'envMapIntensity' in n.material) {
				n.material.envMapIntensity = 0.85;
			}
		}
	});

	const box = new Box3().setFromObject(avatar);
	const minY = box.min.y;
	avatar.position.y -= minY;

	avatarRig.add(avatar);

	const height = Math.max(0.5, box.max.y - box.min.y);
	CAM_OFFSET.set(0, height * 1.05, height * 1.95);
	CAM_LOOK_OFFSET.set(0, height * 0.6, 0);
	applyCameraImmediate();

	animationManager.attach(avatar);

	const manifest = await fetch(ANIMATIONS_MANIFEST_URL, { cache: 'force-cache' })
		.then((r) => {
			if (!r.ok) throw new Error(`HTTP ${r.status} fetching animation manifest`);
			return r.json();
		});
	const needed = manifest.filter((d) =>
		d.name === CLIP_IDLE || d.name === CLIP_WALK || d.name === CLIP_RUN,
	);
	if (needed.length === 0) {
		throw new Error('Animation manifest missing idle/walking/running clips');
	}
	animationManager.setAnimationDefs(needed);
	await animationManager.loadAll();

	await animationManager.crossfadeTo(CLIP_IDLE, 0.0);
	currentMotion = 'idle';

	if (AUTOPLAY) {
		input.autoplay.active = true;
		input.autoplay.t = 0;
	}

	setStatus('walk it');
	postToHost({ type: 'walk:ready', avatar: avatarUrl });
}

// ── Resize ────────────────────────────────────────────────────────────────
function resize() {
	const w = window.innerWidth;
	const h = window.innerHeight;
	renderer.setSize(w, h, false);
	camera.aspect = w / h;
	camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
window.addEventListener('orientationchange', resize);

// ── Main loop ─────────────────────────────────────────────────────────────
const clock = new Clock();
const moveWorld = new Vector3();
const moveForward = new Vector3();
const moveRight = new Vector3();
const upY = new Vector3(0, 1, 0);

function readMoveInput(dt) {
	if (input.joy.active) return { ix: input.joy.x, iy: input.joy.y };
	if (CONTROLS !== 'none') {
		const ix = input.keys.right - input.keys.left;
		const iy = input.keys.forward - input.keys.back;
		if (ix || iy) return { ix, iy };
	}
	if (input.autoplay.active) {
		// Lazy "walk in a slow circle" pattern — readable, non-distracting,
		// and keeps the avatar within the visible ground disc no matter how
		// long the page sits idle. Period ~16s, radius ramps in over 1s so
		// the avatar starts from rest instead of snapping into motion.
		input.autoplay.t += dt;
		const ramp = Math.min(1, input.autoplay.t / 1.0);
		const angle = input.autoplay.t * (Math.PI * 2 / 16);
		return { ix: Math.cos(angle) * 0.6 * ramp, iy: Math.sin(angle) * 0.6 * ramp };
	}
	return { ix: 0, iy: 0 };
}

let lastBroadcastX = 0;
let lastBroadcastZ = 0;
const BROADCAST_EPSILON = 0.02; // metres — skip duplicate post messages

function tick() {
	const dt = Math.min(clock.getDelta(), 0.05);

	const { ix, iy } = readMoveInput(dt);
	const mag = Math.min(1, Math.hypot(ix, iy));

	const wantRun = mag > 0.9 || input.keys.run;
	const speed = mag * (wantRun ? RUN_SPEED : WALK_SPEED) * (input._speedMultiplier || 1.0);

	if (mag > 0.01 && avatar) {
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

		const r = Math.hypot(avatarRig.position.x, avatarRig.position.z);
		const max = GROUND_RADIUS - 0.5;
		if (r > max) {
			const k = max / r;
			avatarRig.position.x *= k;
			avatarRig.position.z *= k;
		}

		const wantYaw = Math.atan2(moveWorld.x, moveWorld.z);
		avatarYaw = lerpAngle(avatarYaw, wantYaw, TURN_LERP);
		avatarRig.quaternion.setFromAxisAngle(upY, avatarYaw);

		const want = wantRun ? 'run' : 'walk';
		if (currentMotion !== want) {
			currentMotion = want;
			animationManager.crossfadeTo(want === 'run' ? CLIP_RUN : CLIP_WALK, 0.18);
		}
	} else if (currentMotion !== 'idle' && avatar) {
		currentMotion = 'idle';
		animationManager.crossfadeTo(CLIP_IDLE, 0.25);
	}

	if (animationManager.mixer) {
		let ts = 1.0;
		if (currentMotion === 'walk') {
			ts = Math.max(0.45, speed / NATURAL_WALK_SPEED);
		} else if (currentMotion === 'run') {
			ts = Math.max(0.6, speed / NATURAL_RUN_SPEED);
		}
		animationManager.mixer.timeScale = ts;
	}

	const targetLean = currentMotion === 'run'
		? LEAN_RUN_RAD * mag
		: currentMotion === 'walk'
			? LEAN_WALK_RAD * mag
			: 0;
	avatarLean += (targetLean - avatarLean) * LEAN_LERP;
	if (avatar) avatar.rotation.x = avatarLean;

	const offset = CAM_OFFSET.clone();
	offset.applyAxisAngle(new Vector3(1, 0, 0), -cameraPitch);
	offset.applyAxisAngle(upY, cameraYaw);
	camDesired.copy(avatarRig.position).add(offset);
	camera.position.lerp(camDesired, CAM_LERP);

	camLookTarget.copy(avatarRig.position).add(CAM_LOOK_OFFSET);
	camLookCurrent.lerp(camLookTarget, CAM_LERP);
	camera.lookAt(camLookCurrent);

	animationManager.update(dt);

	if (
		avatar && (
			Math.abs(avatarRig.position.x - lastBroadcastX) > BROADCAST_EPSILON ||
			Math.abs(avatarRig.position.z - lastBroadcastZ) > BROADCAST_EPSILON
		)
	) {
		lastBroadcastX = avatarRig.position.x;
		lastBroadcastZ = avatarRig.position.z;
		postToHost({
			type: 'walk:position',
			x: avatarRig.position.x,
			z: avatarRig.position.z,
			yaw: avatarYaw,
			motion: currentMotion,
		});
	}

	renderer.render(scene, camera);
	requestAnimationFrame(tick);
}

function lerpAngle(a, b, t) {
	let diff = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
	if (diff < -Math.PI) diff += Math.PI * 2;
	return a + diff * t;
}

// ── Host commands ─────────────────────────────────────────────────────────
// Hosts can drive the embed via window.postMessage. Supported commands:
//   { type: 'walk:setAvatar', id }   — swap avatar live
//   { type: 'walk:setMotion', motion } — 'idle' | 'walk' | 'run' (autoplay)
//   { type: 'walk:resetPose' }       — recenter avatar on the ground
window.addEventListener('message', async (e) => {
	const msg = e.data;
	if (!msg || typeof msg !== 'object') return;
	if (msg.type === 'walk:setAvatar' && msg.id) {
		try {
			const loader = new GLTFLoader();
			const gltf = await loader.loadAsync(`/api/avatars/${encodeURIComponent(msg.id)}/glb`);
			if (avatar) avatarRig.remove(avatar);
			avatar = gltf.scene;
			avatar.traverse((n) => { if (n.isMesh) n.castShadow = true; });
			const box = new Box3().setFromObject(avatar);
			avatar.position.y -= box.min.y;
			avatarRig.add(avatar);
			animationManager.attach(avatar);
			await animationManager.crossfadeTo(CLIP_IDLE, 0.0);
			currentMotion = 'idle';
			postToHost({ type: 'walk:avatarChanged', id: msg.id });
		} catch (err) {
			postToHost({ type: 'walk:error', error: String(err?.message || err) });
		}
	} else if (msg.type === 'walk:setMotion') {
		if (msg.motion === 'walk' || msg.motion === 'run') {
			input.autoplay.active = true;
			input.autoplay.t = 0;
		} else if (msg.motion === 'idle') {
			input.autoplay.active = false;
		}
	} else if (msg.type === 'walk:resetPose') {
		avatarRig.position.set(0, 0, 0);
		avatarYaw = 0;
		avatarRig.quaternion.setFromAxisAngle(upY, 0);
		applyCameraImmediate();
	} else if (msg.type === 'walk:narrate' && typeof msg.text === 'string') {
		// Show a DOM speech bubble above the avatar for the narration text.
		showSpeechBubble(msg.text);
	} else if (msg.type === 'walk:narrateEnd') {
		hideSpeechBubble();
	} else if (msg.type === 'walk:config') {
		if (typeof msg.speed === 'number') {
			// Walk speed multiplier — applied to input magnitude each frame
			input._speedMultiplier = Math.max(0.3, Math.min(3, msg.speed));
		}
	} else if (msg.type === 'walk:setEnv' && typeof msg.env === 'string') {
		applyEnvironment(msg.env.toLowerCase());
	}
});

// ── Speech bubble (DOM overlay) ───────────────────────────────────────────
let bubbleEl = null;
let bubbleHideTimer = null;

function ensureBubble() {
	if (bubbleEl) return bubbleEl;
	bubbleEl = document.createElement('div');
	bubbleEl.style.cssText = `
		position: fixed;
		left: 50%;
		bottom: 180px;
		transform: translateX(-50%);
		max-width: 280px;
		background: rgba(10,10,10,0.88);
		color: #fafafa;
		font-family: Inter, system-ui, sans-serif;
		font-size: 13px;
		line-height: 1.45;
		padding: 10px 14px;
		border-radius: 14px;
		border: 1px solid rgba(255,255,255,0.12);
		backdrop-filter: blur(12px);
		-webkit-backdrop-filter: blur(12px);
		pointer-events: none;
		z-index: 10;
		opacity: 0;
		transition: opacity 0.25s ease;
		word-break: break-word;
	`;
	// Pointer triangle
	const tri = document.createElement('div');
	tri.style.cssText = `
		position: absolute;
		bottom: -7px;
		left: 50%;
		transform: translateX(-50%);
		width: 0;
		height: 0;
		border-left: 7px solid transparent;
		border-right: 7px solid transparent;
		border-top: 7px solid rgba(10,10,10,0.88);
	`;
	bubbleEl.appendChild(tri);
	document.body.appendChild(bubbleEl);
	return bubbleEl;
}

function showSpeechBubble(text) {
	clearTimeout(bubbleHideTimer);
	const el = ensureBubble();
	// Set text without the pointer triangle child
	const tri = el.lastChild;
	el.textContent = text.slice(0, 220);
	el.appendChild(tri);
	el.style.opacity = '1';
	// Auto-hide after estimated reading time
	const ms = Math.max(2500, text.length * 55);
	bubbleHideTimer = setTimeout(hideSpeechBubble, ms);
}

function hideSpeechBubble() {
	if (bubbleEl) bubbleEl.style.opacity = '0';
}

// ── Boot ──────────────────────────────────────────────────────────────────
loadAvatar()
	.then(() => {
		requestAnimationFrame(tick);
	})
	.catch((err) => {
		console.error('[walk-embed] failed to load avatar:', err);
		if (statusEl) {
			statusEl.textContent = `failed to load avatar: ${err?.message ?? err}`;
			statusEl.classList.add('is-error');
			statusEl.classList.remove('is-hidden');
		}
		postToHost({ type: 'walk:error', error: String(err?.message || err) });
		requestAnimationFrame(tick);
	});
