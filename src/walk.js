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
	Box3,
	CircleGeometry,
	Clock,
	Color,
	DirectionalLight,
	Group,
	HemisphereLight,
	Mesh,
	MeshStandardMaterial,
	PCFSoftShadowMap,
	PerspectiveCamera,
	PMREMGenerator,
	Quaternion,
	Scene,
	ShadowMaterial,
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
const statusEl = document.getElementById('walk-status');
const onlinePill = document.getElementById('walk-online');
const onlineCountEl = document.getElementById('walk-online-count');

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

// ── Renderer / scene ──────────────────────────────────────────────────────
const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = PCFSoftShadowMap;

const scene = new Scene();

const pmrem = new PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

// Lights — ambient + hemi for soft fill, directional for shadow cast.
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
const PITCH_MIN = -0.6;
const PITCH_MAX = 0.7;

// Place the camera at its starting pose immediately so frame 0 isn't blank.
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

// Cached gltf scene + animation manifest defs, populated by loadAvatar — the
// multiplayer layer reuses both to spawn remote-player avatars without
// re-fetching the .glb or the clip manifest. SkeletonUtils.clone() makes a
// proper deep copy of skinned hierarchies; vanilla object3D.clone() would
// share bones and corrupt the rig.
let avatarTemplate = null;
let animationDefs = null;

async function loadAvatar() {
	setStatus('loading avatar…', { sticky: true });

	const avatarUrl = await resolveAvatarUrl();
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
	CAM_OFFSET.set(0, height * 1.05, height * 1.95);
	CAM_LOOK_OFFSET.set(0, height * 0.6, 0);
	applyCameraImmediate();

	animationManager.attach(avatar);

	// Load only the three clips the controller actually uses — keeps startup
	// fast and avoids fetching ~30MB of dance/jump clips we don't need.
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
	animationDefs = needed;
	animationManager.setAnimationDefs(needed);
	await animationManager.loadAll();

	await animationManager.crossfadeTo(CLIP_IDLE, 0.0);
	currentMotion = 'idle';

	setStatus('walk it', { sticky: false });
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
	renderer.setClearColor(0x000000, 0);
	scene.background = null;

	setStatus('AR on — point at a floor');
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
	scene.background = null; // CSS gradient on #walk-stage shows through

	setStatus('AR off');
}

arBtn.addEventListener('click', () => {
	if (arActive) disableAR();
	else enableAR();
});

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
const tmpQuat = new Quaternion();
const upY = new Vector3(0, 1, 0);

function readMoveInput() {
	let ix, iy;
	if (input.joy.active) {
		// Joystick vector — y up is forward.
		ix = input.joy.x;
		iy = input.joy.y;
	} else {
		ix = input.keys.right - input.keys.left;
		iy = input.keys.forward - input.keys.back;
	}
	return { ix, iy };
}

function tick() {
	const dt = Math.min(clock.getDelta(), 0.05); // clamp huge frames after a tab switch

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

	// 2. Update camera follow-rig.
	const offset = CAM_OFFSET.clone();
	offset.applyAxisAngle(new Vector3(1, 0, 0), -cameraPitch);
	offset.applyAxisAngle(upY, cameraYaw);
	camDesired.copy(avatarRig.position).add(offset);
	camera.position.lerp(camDesired, CAM_LERP);

	camLookTarget.copy(avatarRig.position).add(CAM_LOOK_OFFSET);
	camLookCurrent.lerp(camLookTarget, CAM_LERP);
	camera.lookAt(camLookCurrent);

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
			this.anim.crossfadeTo(motionToClipName(player.motion), 0.18);
		}
		if (this.label.textContent !== player.name && player.name) {
			this.label.textContent = player.name;
		}
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
	if (!avatarTemplate || !animationDefs) return; // wait until loadAvatar finished
	if (net) return;
	const params = new URLSearchParams(location.search);
	const name = (params.get('name') || `guest-${Math.random().toString(36).slice(2, 6)}`).slice(0, 24);
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
		if (r) r.applyServerState(player);
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

// ── Boot ──────────────────────────────────────────────────────────────────
loadAvatar()
	.then(() => {
		requestAnimationFrame(tick);
		startNet();
	})
	.catch((err) => {
		console.error('[walk] failed to load avatar:', err);
		const hasParam = new URLSearchParams(location.search).has('avatar');
		const suffix = hasParam ? ' — <a href="/walk">try the default avatar</a>' : '';
		if (statusEl) statusEl.innerHTML = `failed to load avatar: ${err?.message ?? err}${suffix}`;
		if (statusEl) {
			statusEl.classList.add('is-error');
			statusEl.classList.remove('is-hidden');
		}
		requestAnimationFrame(tick);
	});
