// /club entrance — walk up to the club as your own 3D avatar.
//
// You don't drop onto the pole floor — you walk there yourself, as a
// third-person avatar, in control the whole way: move (WASD / arrows / touch
// joystick) and look around (drag). We never auto-walk you. You spawn OUTSIDE
// in the alley and walk up to the neon door; step into range and a prompt
// appears — press E, tap, or click — and the cover-charge card (src/club-gate.js)
// asks you to pay. Pay the cover and you keep walking, under your own control,
// through each place in turn — a gallery hall, then the Space Smugglers club
// house interior — until you reach the strip club itself (the pole stage, in
// src/club.js), where you tip dancers to perform.
//
// The journey is the SEQUENCE list below: every venue is free-walk; you reach
// its exit and the next one fades in. The alley's door takes the cover; the
// last venue hands off to the pole stage. Everything renders into one
// full-screen canvas (#club-door-canvas) layered above the pole stage and below
// the cover card. Three Meshopt+WebP environments (built by
// scripts/build-club-entrance-venue.mjs) plus the shared avatar GLB; later
// places are prefetched while you walk so each transition never stalls. Already
// paid tonight? The whole approach is skipped on load. Any load failure
// degrades silently — the cover card and the pole stage still work.

import {
	AmbientLight,
	Box3,
	BoxGeometry,
	Color,
	DoubleSide,
	Fog,
	Group,
	HemisphereLight,
	Mesh,
	MeshStandardMaterial,
	PerspectiveCamera,
	PointLight,
	Raycaster,
	Scene,
	SpotLight,
	SRGBColorSpace,
	Vector2,
	Vector3,
	WebGLRenderer,
	NoToneMapping,
} from 'three';
import {
	EffectComposer,
	RenderPass,
	EffectPass,
	BloomEffect,
	ToneMappingEffect,
	VignetteEffect,
	SMAAEffect,
	ToneMappingMode,
} from 'postprocessing';
import { gltfLoader } from './loaders/gltf.js';
import { AnimationManager } from './animation-manager.js';
import { ClubCrowd } from './club-crowd.js';
import { detectProfile, PROFILES, createFrameWatchdog } from './club-perf.js';
import { getPowerSaver } from './shared/frame-governor.js';
import { log } from './shared/log.js';
import { isExpressEntry } from './shared/club-express.js';

const TOUR_URL = '/club/venue/tour.glb';
const ALLEYWAY_URL = '/club/venue/alleyway.glb';
const CLUBHOUSE_URL = '/club/venue/space-smugglers-clubhouse.glb';
const AVATAR_URL = '/avatars/default.glb';
const MANIFEST_URL = '/animations/manifest.json';
const PASS_KEY = 'club:pass:v1';

// Hard cap on background crowd bodies per room. Each member is a full skinned
// GLB rig (not an instanced mesh), so we keep the floor light for load + perf.
const MAX_CROWD_PER_SCENE = 5;
const MOVE_CLIPS = new Set(['idle', 'walk']);
// Canonical URLs for the player's locomotion clips, kept independent of the
// manifest so they survive a failed/empty manifest fetch. These back the
// guaranteed idle/walk defs below: even if both the prefetch AND the manifest
// fetch fail, play('idle') can still lazy-load from here rather than leave the
// avatar frozen in a bind/T-pose on entry. The url's match the prefetch URLs.
const MOVE_CLIP_URLS = {
	idle: '/animations/clips/idle.json',
	walk: '/animations/clips/walk.json',
};
// The dance the avatar breaks into the instant the cover charge settles — a
// twerk on the spot before it walks past the velvet rope. Lazy-loaded from the
// manifest on first admit (most visitors never pay a cover the same session as
// a reload, so there's no point bundling it with idle/walk up front).
const ADMIT_DANCE_CLIP = 'twerk';
const VENUE_NAMES = ['Alley', 'Gallery', 'Clubhouse']; // index-aligned with SEQUENCE, for the minimap label

// The agent switcher's catalog: bundled, known-good humanoid rigs that ship with
// the app (so the dropdown always has options offline — Hard rule 9), plus public
// avatars pulled from the gallery at runtime. Deduped by URL. A gallery rig the
// clip library can't drive (a non-humanoid sample model, an odd skeleton) is
// caught at swap time and rolled back to the working rig — see swapAvatarTo — so
// a pick never leaves the player frozen in a bind/T-pose mid-walk.
const BUNDLED_AGENTS = [
	{ key: 'default', name: 'Aria', url: AVATAR_URL },
	{ key: 'michelle', name: 'Michelle', url: '/avatars/michelle.glb' },
	{ key: 'realistic-female', name: 'Realistic', url: '/avatars/realistic-female.glb' },
	{ key: 'studio', name: 'Studio', url: '/avatars/studio.glb' },
	{ key: 'mannequin', name: 'Mannequin', url: '/avatars/mannequin.glb' },
];
const AGENT_GALLERY_URL = '/api/explore?source=avatar&category=avatar&only3d=1&limit=24';

const ROOM_HEIGHT = 7.0; // environments normalised to this Y so the avatar reads human
const AVATAR_HEIGHT = 1.75;
const MOVE_SPEED = 2.6; // metres / second
const DOOR_RANGE = 2.6; // how close you stand before the prompt shows
const CAM_DIST = 3.6;
const CAM_HEIGHT = 1.55;
const HEAD_Y = 1.2;
// Camera-wall collision: keep this much clearance in front of any wall the
// camera backs into. A fat skin matters because the near plane is small (0.08)
// — at a thin standoff a wall pokes through the lens and the frame fills with
// the wall's interior. CAM_MIN_DIST is only a floor so the camera never
// collapses onto the avatar's head; it is deliberately small, NOT a comfortable
// resting distance — clamping it up would shove the camera through any wall
// closer than the floor. Walls closer than this are caught by the double-sided
// env materials, which render solid from the inside instead of see-through.
const CAM_WALL_SKIN = 0.4;
const CAM_MIN_DIST = 0.5;

const ARRIVE = 0.9; // final fade (seconds) that reveals the pole stage

const isTouch = typeof window !== 'undefined' &&
	('ontouchstart' in window || (navigator.maxTouchPoints || 0) > 0);
const prefersReducedMotion = typeof window !== 'undefined' &&
	window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const canvas = document.getElementById('club-door-canvas');
const door = document.getElementById('club-door');

// The bouncer admits via a one-shot event; capture it at module scope so an
// admit that fires before the scene loads is never missed.
let admitted = false;
let onAdmit = null;
window.addEventListener('club:admitted', () => {
	admitted = true;
	if (onAdmit) onAdmit();
}, { once: true });

// ── Cinematic loader / intro ────────────────────────────────────────────────
// Real byte progress across the alley + avatar; no fake timers. Fades out the
// branded overlay once the scene is ready (or on failure, so nobody's stuck).
const loaderBar = document.getElementById('club-loader-bar');
const loaderStatus = document.getElementById('club-loader-status');
const loadFrac = { alley: 0, avatar: 0 };
function setLoaderProgress(which, e) {
	if (which && e && e.total) loadFrac[which] = Math.min(1, e.loaded / e.total);
	const pct = Math.round(((loadFrac.alley + loadFrac.avatar) / 2) * 100);
	if (loaderBar) loaderBar.style.width = `${Math.max(4, pct)}%`;
	if (loaderStatus && pct >= 100) loaderStatus.textContent = 'Step inside.';
}
function hideLoader() {
	const el = document.getElementById('club-loader');
	if (!el) return;
	if (loaderBar) loaderBar.style.width = '100%';
	el.classList.add('is-done');
}

if (canvas && door && !hasValidPass() && !isExpressEntry()) {
	start(canvas).catch((err) => {
		log.warn('[club-entrance] scene failed', err);
		// Scene is dead — let the player into the cover flow directly so they're
		// never stuck in a broken alley.
		hideLoader();
		try { canvas.remove(); } catch {}
		window.dispatchEvent(new CustomEvent('club:enter-door'));
	});
} else {
	// Paid already, express/demo entry, or no canvas — nothing to walk; clear
	// the intro overlay. (Express entry drops the cover rope in src/club-gate.js.)
	hideLoader();
	canvas?.remove();
}

function hasValidPass() {
	try {
		const raw = localStorage.getItem(PASS_KEY);
		if (!raw) return false;
		const p = JSON.parse(raw);
		return p?.expiresAt && Date.parse(p.expiresAt) > Date.now();
	} catch {
		return false;
	}
}

async function start(canvasEl) {
	// antialias off + tone mapping deferred — SMAA + ACES run in the composer
	// below, exactly like the pole stage (src/club.js), so the two halves of the
	// journey share one cinematic look.
	const renderer = new WebGLRenderer({ canvas: canvasEl, antialias: false, alpha: false, powerPreference: 'high-performance' });
	// One capability profile drives the whole render budget. Pixel ratio is the
	// single biggest heat lever — a 2× retina panel renders 4× the fragments of
	// 1×, so we cap it per tier (high 2 / medium 1.5 / low 1) instead of always
	// honouring the display's native ratio. The watchdog (see the frame loop)
	// can drop this further mid-session if frames stay slow.
	const profile = PROFILES[detectProfile()] || PROFILES.medium;
	renderer.setPixelRatio(profile.pixelRatio);
	renderer.setSize(window.innerWidth, window.innerHeight, false);
	renderer.outputColorSpace = SRGBColorSpace;
	renderer.toneMapping = NoToneMapping;

	const scene = new Scene();
	// Opaque backdrop (matches the fog) so the pole stage rendering behind this
	// canvas never shows through the alley's open edges — the club stays hidden
	// until the walk-through fades this whole canvas out via CSS opacity.
	scene.background = new Color(0x05030a);
	scene.fog = new Fog(0x05030a, 8, 34);

	const camera = new PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.08, 200);

	// ── Light rig — moody, works for the alley and the interior ──────────────
	// Keeps the noir palette but lifts the ambient/hemisphere floor so walls read
	// as dim surfaces instead of pure black where no accent light reaches.
	scene.add(new AmbientLight(0x241433, 0.95));
	const hemi = new HemisphereLight(0xff6abf, 0x0a0512, 0.62);
	hemi.position.set(0, ROOM_HEIGHT, 0);
	scene.add(hemi);
	const pink = new PointLight(0xff3bd6, 7, 26, 1.4);
	pink.position.set(-3, 3.2, -3);
	scene.add(pink);
	const cyan = new PointLight(0x4ad6ff, 5, 24, 1.5);
	cyan.position.set(3, 2.4, 2);
	scene.add(cyan);
	// A soft key that tracks the avatar so it never falls into shadow. Widened
	// from a tight PI/5 so it washes the walls beside you, not just a floor strip.
	const key = new SpotLight(0xffe6c2, 11, 28, Math.PI / 3.4, 0.7, 1.0);
	key.position.set(0, 5, 0);
	scene.add(key, key.target);
	// Warm fill that rides along with the avatar so the immediate surroundings —
	// the stretch of alley you're actually walking through — are always legible,
	// however far the fixed accent lights are behind you.
	const fill = new PointLight(0xffd9c2, 2.4, 12, 1.6);
	fill.position.set(0, 2.4, 0);
	scene.add(fill);

	// ── Postprocessing — the same cinematic stack as the pole stage ──────────
	// Bloom makes the neon door/sign actually glow, ACES gives filmic colour,
	// the vignette pulls focus to the path ahead, SMAA cleans the edges. We
	// replace renderer.render() with composer.render(dt) in the loop below.
	const bloomEffect = new BloomEffect({
		intensity: 1.35,
		luminanceThreshold: 0.32,
		luminanceSmoothing: 0.08,
		mipmapBlur: true,
	});
	const composer = new EffectComposer(renderer);
	composer.addPass(new RenderPass(scene, camera));
	composer.addPass(new EffectPass(
		camera,
		bloomEffect,
		new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC }),
		new VignetteEffect({ darkness: 0.5, offset: 0.3 }),
	));
	// SMAA is a full-screen edge pass — the first thing the watchdog drops when
	// frames stay slow, so we keep a handle on it. Off by default on the low tier.
	const smaaPass = new EffectPass(camera, new SMAAEffect());
	smaaPass.enabled = profile.tier !== 'low';
	composer.addPass(smaaPass);

	const loader = gltfLoader(renderer);

	// The journey, in order. You free-walk every one of these — no auto-walk.
	// `cover` marks the venue whose door takes the cover charge (the outside
	// alley); the rest just lead you to the next place. `door` anchors the exit
	// to a modelled doorway (+ seals it) where one exists; interiors exit down
	// their longest dimension. The last venue hands off to the strip club stage.
	const SEQUENCE = [
		{ url: ALLEYWAY_URL, cover: true, door: true },   // outside — pay the cover here
		{ url: TOUR_URL, cover: false, door: false },     // gallery hall
		{ url: CLUBHOUSE_URL, cover: false, door: false }, // club interior → the poles
	];

	// Land in the alley + the avatar first; prefetch the rest so each place is
	// ready the moment you walk into it. The loader bar tracks real bytes.
	// Clip JSON is fetched in the same parallel batch so idle is guaranteed
	// ready before the first render frame — no T-pose on entry.
	const [firstGltf, avatarGltf, manifest, idleClipJson, walkClipJson] = await Promise.all([
		loader.loadAsync(SEQUENCE[0].url, (e) => setLoaderProgress('alley', e)),
		loader.loadAsync(AVATAR_URL, (e) => setLoaderProgress('avatar', e)),
		fetch(MANIFEST_URL, { cache: 'force-cache' }).then((r) => (r.ok ? r.json() : [])).catch(() => []),
		fetch('/animations/clips/idle.json', { cache: 'force-cache' }).then((r) => r.ok ? r.json() : null).catch(() => null),
		fetch('/animations/clips/walk.json', { cache: 'force-cache' }).then((r) => r.ok ? r.json() : null).catch(() => null),
	]);
	const loaded = SEQUENCE.map(() => null); // index-aligned gltf cache
	loaded[0] = firstGltf;
	for (let i = 1; i < SEQUENCE.length; i++) {
		const idx = i;
		loader.loadAsync(SEQUENCE[idx].url)
			.then((g) => { loaded[idx] = g; })
			.catch((err) => { log.warn(`[club-entrance] venue ${idx} load failed`, err); loaded[idx] = 'error'; });
	}

	// ── Environment ──────────────────────────────────────────────────────────
	let venueIndex = 0;
	let paid = false;
	let currentCover = false;
	let env = null, doorAnchor = null, path = null, occluder = null;
	mountVenue(0);

	function mountVenue(i) {
		const v = SEQUENCE[i];
		if (occluder) { scene.remove(occluder); disposeObject(occluder); occluder = null; }
		if (env) { disposeObject(env.root); scene.remove(env.root); }
		env = mountEnvironment(scene, loaded[i].scene);
		// Anchor to the modelled door so the prompt + neon frame land on the real
		// doorway; interiors skip this and exit down their longest dimension.
		doorAnchor = v.door ? findDoorAnchor(env.root) : null;
		path = walkPath(env.box, doorAnchor);
		// Seal the doorway so the lit interior never reads from outside.
		occluder = doorAnchor ? buildDoorOccluder(doorAnchor, path.dir) : null;
		if (occluder) scene.add(occluder);
		currentCover = v.cover && !paid;
		venueIndex = i;
	}

	// ── Avatar ─────────────────────────────────────────────────────────────
	// `avatar` is the swappable child of the rig — the agent switcher (below)
	// hot-swaps it live without disturbing the rig's position/heading.
	let avatar = avatarGltf.scene;
	let currentAvatarUrl = AVATAR_URL;
	scaleToHeight(avatar, AVATAR_HEIGHT);
	placeOnFloor(avatar);
	const rig = new Group(); // yaw the rig; the model sits at the rig origin
	rig.add(avatar);
	scene.add(rig);

	const anim = new AnimationManager();
	anim.attach(avatar, { avatarUrl: AVATAR_URL });
	const manifestDefs = (Array.isArray(manifest) ? manifest : [])
		.filter((d) => MOVE_CLIPS.has(d.name) || d.name === ADMIT_DANCE_CLIP);
	// Guarantee an idle + walk def even if the manifest fetch failed or returned
	// no locomotion entries — without a def, a null prefetch leaves play('idle')
	// with nothing to load and the avatar enters the club in a T-pose. Manifest
	// entries win (they may carry richer metadata); these only fill the gaps.
	const sceneDefs = ['idle', 'walk']
		.filter((name) => !manifestDefs.some((d) => d.name === name))
		.map((name) => ({ name, url: MOVE_CLIP_URLS[name], loop: true }))
		.concat(manifestDefs);
	anim.setAnimationDefs(sceneDefs);
	// Inject the pre-fetched clip data directly — no second network round-trip,
	// animations are bound before the first render frame so there's no T-pose.
	anim.injectClip('idle', idleClipJson, { loop: true });
	anim.injectClip('walk', walkClipJson, { loop: true });
	await anim.play('idle');

	// ── Crowd — populate every environment with our avatars ──
	// You don't walk an empty set: each room fills with the full platform roster
	// (bundled rigs + public gallery), grounded and dancing/idling clear of your
	// path. Sized to the device's crowd budget; degrades to nothing if it can't
	// load. Re-populated on every venue swap via refreshCrowd().
	const crowdProfile = profile;
	const crowd = new ClubCrowd({
		renderer,
		scene,
		manifest,
		// Each crowd member is a full skinned GLB rig, so keep the floor light:
		// at most MAX_CROWD_PER_SCENE bodies per room, regardless of device budget.
		max: Math.min(MAX_CROWD_PER_SCENE, crowdProfile.crowdInstances),
		bundled: BUNDLED_AGENTS,
	});
	crowd.load(); // background fetch of roster + clip data; mount() awaits it
	const refreshCrowd = () => {
		if (!env) return;
		crowd.mount({ envRoot: env.root, bounds: env.bounds, path, roomIndex: venueIndex });
	};

	// ── Door marker — a neon frame at the end of the alley you walk up to ────
	const doorMarker = buildDoorMarker();
	scene.add(doorMarker.group);
	const doorGlow = new PointLight(0xff4fd8, 0, 9, 1.6);
	scene.add(doorGlow);

	// Top-down radar so you always know which way the exit is.
	const minimap = buildMinimap();

	// ── Camera + controller state ────────────────────────────────────────────
	let camYaw = Math.atan2(path.dir.x, path.dir.z); // start looking down the alley toward the door
	let camPitch = 0.12;
	let inputEnabled = true;

	// The pavement surface sits above the environment's y=0 origin, so stand the
	// avatar on the sampled floor rather than the box bottom (feet-through-floor).
	const groundRay = new Raycaster();
	const DOWN = new Vector3(0, -1, 0);
	let floorY = 0;
	// Ray for camera-wall collision (keeps its own `far`, used in updateCamera).
	const camRay = new Raycaster();

	placeSpawn();
	refreshCrowd(); // populate the opening room (alley)

	// Cast straight down from waist height to find the walkable floor.
	// Starting from ROOM_HEIGHT * 0.6 wrongly hit sculpture tops / arch geometry
	// in rooms like the gallery; starting from y=1.2 samples only floor-level
	// surfaces (floor is always near y=0 after mountEnvironment normalises).
	function sampleFloor(x, z) {
		const y = rayFloor(x, z);
		return y == null ? 0 : y;
	}

	// Raw floor height under (x, z), or null when the ray finds no surface.
	// Origin sits above the walkable band so it samples the floor, not the
	// avatar's own mesh; the band reaches a little below 0 for venues whose
	// floor normalises slightly under the origin.
	function rayFloor(x, z) {
		groundRay.set(new Vector3(x, 1.2, z), DOWN);
		groundRay.far = 1.5; // covers y ∈ [−0.3, 1.2] — the floor band
		const hit = groundRay.intersectObject(env.root, true)[0];
		return hit ? Math.max(0, hit.point.y) : null;
	}

	// Keep the avatar's feet planted as it walks: the floor height varies from
	// venue to venue (and across a single floor), so re-sample under the rig
	// each frame and ease toward it. Holding the last height on a ray miss
	// avoids dropping the avatar to y=0 over gaps in the floor geometry.
	function trackFloor(dt) {
		const y = rayFloor(rig.position.x, rig.position.z);
		if (y == null) return;
		floorY = y;
		rig.position.y += (floorY - rig.position.y) * (1 - Math.exp(-14 * dt));
	}

	function placeSpawn() {
		rig.position.copy(path.spawn);
		floorY = sampleFloor(path.spawn.x, path.spawn.z);
		rig.position.y = floorY;
		// Face the door (opposite the walk axis).
		rig.rotation.y = Math.atan2(-path.dir.x, -path.dir.z);
		doorMarker.group.position.copy(path.door);
		doorMarker.group.rotation.y = Math.atan2(path.dir.x, path.dir.z);
		doorGlow.position.copy(path.door).setY(1.6);
		camYaw = Math.atan2(path.dir.x, path.dir.z);
		updateCamera(1);
		setJourneyStep(venueIndex);
		minimap.setVenue(env.box, path.door, VENUE_NAMES[venueIndex] || 'Venue');
	}

	// ── Input ──────────────────────────────────────────────────────────────
	const keys = new Set();
	const joy = { active: false, id: null, ox: 0, oy: 0, nx: 0, ny: 0 };
	const look = { id: null, x: 0, y: 0, moved: false };

	// Drop any held movement while a form control (the agent switcher) has focus,
	// so arrow keys page its options instead of walking the avatar.
	const typingInForm = () => {
		const a = document.activeElement;
		return !!a && (a.tagName === 'SELECT' || a.tagName === 'INPUT' || a.tagName === 'TEXTAREA');
	};
	const onKeyDown = (e) => {
		if (typingInForm()) return;
		const k = e.key.toLowerCase();
		if (k === 'e') { tryEnter(); return; }
		if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) {
			keys.add(k);
			e.preventDefault();
		}
	};
	const onKeyUp = (e) => keys.delete(e.key.toLowerCase());
	// A held key whose keyup lands on another window (alt-tab, focus loss) would
	// otherwise stick "down" forever and walk the avatar on its own. Releasing
	// everything on blur / tab-hide is the fix.
	const releaseControls = () => {
		keys.clear();
		joy.active = false; joy.id = null; joy.nx = 0; joy.ny = 0;
		if (joyBase) joyBase.classList.remove('is-active');
		if (joyKnob) joyKnob.style.transform = 'translate(0,0)';
	};
	const onBlur = () => releaseControls();
	const onVisibility = () => { if (document.hidden) releaseControls(); };
	window.addEventListener('keydown', onKeyDown);
	window.addEventListener('keyup', onKeyUp);
	window.addEventListener('blur', onBlur);
	document.addEventListener('visibilitychange', onVisibility);

	// Pointer: a drag on the left third of the screen drives the joystick (touch
	// only); anything else orbits the camera.
	const joyBase = document.getElementById('club-joystick');
	const joyKnob = document.getElementById('club-joystick-knob');

	const onPointerDown = (e) => {
		if (!inputEnabled) return;
		const leftZone = isTouch && e.clientX < window.innerWidth * 0.4;
		if (leftZone && !joy.active) {
			joy.active = true; joy.id = e.pointerId; joy.ox = e.clientX; joy.oy = e.clientY;
			joy.nx = 0; joy.ny = 0;
			if (joyBase) { joyBase.style.left = `${e.clientX}px`; joyBase.style.top = `${e.clientY}px`; joyBase.classList.add('is-active'); }
		} else if (look.id === null) {
			look.id = e.pointerId; look.x = e.clientX; look.y = e.clientY; look.moved = false;
		}
		canvasEl.setPointerCapture?.(e.pointerId);
	};
	const onPointerMove = (e) => {
		if (joy.active && e.pointerId === joy.id) {
			const dx = e.clientX - joy.ox, dy = e.clientY - joy.oy;
			const max = 56;
			const len = Math.hypot(dx, dy) || 1;
			const cl = Math.min(len, max);
			joy.nx = (dx / len) * (cl / max);
			joy.ny = (dy / len) * (cl / max);
			if (joyKnob) joyKnob.style.transform = `translate(${(dx / len) * cl}px, ${(dy / len) * cl}px)`;
		} else if (e.pointerId === look.id) {
			const dx = e.clientX - look.x, dy = e.clientY - look.y;
			if (Math.abs(dx) + Math.abs(dy) > 3) look.moved = true;
			camYaw -= dx * 0.005;
			camPitch = clamp(camPitch + dy * 0.004, -0.12, 0.6);
			look.x = e.clientX; look.y = e.clientY;
		}
	};
	const endPointer = (e) => {
		if (e.pointerId === joy.id) {
			joy.active = false; joy.id = null; joy.nx = 0; joy.ny = 0;
			if (joyBase) joyBase.classList.remove('is-active');
			if (joyKnob) joyKnob.style.transform = 'translate(0,0)';
		}
		if (e.pointerId === look.id) look.id = null;
	};
	canvasEl.addEventListener('pointerdown', onPointerDown);
	canvasEl.addEventListener('pointermove', onPointerMove);
	canvasEl.addEventListener('pointerup', endPointer);
	canvasEl.addEventListener('pointercancel', endPointer);

	// Click the neon door directly to enter.
	const raycaster = new Raycaster();
	const onClick = (e) => {
		if (!inputEnabled || look.moved) return;
		const ndc = new Vector2((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
		raycaster.setFromCamera(ndc, camera);
		if (raycaster.intersectObject(doorMarker.group, true).length) tryEnter();
	};
	canvasEl.addEventListener('click', onClick);

	// The on-screen prompt button (also the mobile tap target).
	const promptEl = document.getElementById('club-door-prompt');
	const hintEl = document.getElementById('club-controls-hint');
	promptEl?.addEventListener('click', tryEnter);
	setHint();
	showHint(true);
	showJoystick(isTouch);
	showJourney(true);
	showMinimap(true);
	setJourneyStep(venueIndex);

	// ── Agent switcher ───────────────────────────────────────────────────────
	// Pick which avatar you walk as, live, at any point in the journey. Bundled
	// rigs are offered immediately; public gallery avatars stream in and append.
	const agentSelect = document.getElementById('club-agent-select');
	const agentBrowseBtn = document.getElementById('club-agent-browse');
	let swappingAgent = false;

	function setupAgentSwitch() {
		if (agentSelect) {
			renderAgentOptions(BUNDLED_AGENTS);
			agentSelect.value = currentAvatarUrl;
			agentSelect.addEventListener('change', onAgentChange);
			loadGalleryAgents();
		}
		if (agentBrowseBtn) agentBrowseBtn.addEventListener('click', onBrowseAgents);
	}

	// Open the full 3D-agent directory in a modal and walk in as the chosen one.
	// The picker module is lazy-loaded so the heavy club scene boots without it.
	async function onBrowseAgents() {
		if (swappingAgent) return;
		let openAgentPicker;
		try {
			({ openAgentPicker } = await import('./agent-picker.js'));
		} catch (err) {
			log.warn('[club-entrance] agent picker failed to load', err);
			return;
		}
		releaseControls();
		const agent = await openAgentPicker({
			title: 'Choose your 3D agent',
			ctaLabel: 'Walk in as this agent',
		});
		if (!agent) return;
		const url = agent.avatar_model_url || '';
		if (!url) {
			log.warn('[club-entrance] picked agent has no wearable avatar', agent.id);
			return;
		}
		// Register the pick in the quick-switch dropdown (deduped) so it can be
		// re-selected without reopening the modal, then swap onto it live.
		if (!agentList.some((a) => a.url === url)) {
			agentList = [...agentList, { key: `agent-${agent.id}`, name: agent.name || 'Agent', url }];
			renderAgentOptions(agentList);
		}
		await swapAvatarTo(url);
	}

	// Build/refresh the <option> list, keeping the active rig selected. Deduped by
	// URL so a gallery avatar that matches a bundled one isn't listed twice.
	function renderAgentOptions(list) {
		if (!agentSelect) return;
		const seen = new Set();
		const opts = [];
		for (const a of list) {
			if (!a?.url || seen.has(a.url)) continue;
			seen.add(a.url);
			const o = document.createElement('option');
			o.value = a.url;
			o.textContent = a.name || 'Agent';
			opts.push(o);
		}
		agentSelect.replaceChildren(...opts);
		agentSelect.value = currentAvatarUrl;
	}

	let agentList = [...BUNDLED_AGENTS];
	async function loadGalleryAgents() {
		try {
			const res = await fetch(AGENT_GALLERY_URL, { headers: { accept: 'application/json' } });
			if (!res.ok) return;
			const data = await res.json();
			const items = Array.isArray(data?.items) ? data.items : [];
			const extra = items
				.filter((it) => it?.glbUrl && it.has3d !== false && it.kind === 'avatar')
				.map((it) => ({ key: `gallery-${it.avatarId}`, name: it.name || 'Avatar', url: it.glbUrl }));
			if (!extra.length) return;
			agentList = [...BUNDLED_AGENTS, ...extra];
			renderAgentOptions(agentList);
		} catch (err) {
			log.warn('[club-entrance] gallery agents fetch failed', err);
		}
	}

	async function onAgentChange() {
		const url = agentSelect.value;
		if (!url || url === currentAvatarUrl) {
			agentSelect.value = currentAvatarUrl;
			return;
		}
		await swapAvatarTo(url);
	}

	// Swap the player's rig to `url` live — position, heading and camera untouched,
	// the clip library rebound so there's no T-pose flash. Shared by the quick
	// dropdown and the agent-picker modal. Returns true on a successful swap.
	async function swapAvatarTo(url) {
		if (!url || url === currentAvatarUrl || swappingAgent) return false;
		swappingAgent = true;
		if (agentSelect) agentSelect.disabled = true;
		if (agentBrowseBtn) agentBrowseBtn.disabled = true;
		const movingNow = anim.currentName === 'walk';
		const clip = movingNow ? 'walk' : 'idle';
		const prevAvatar = avatar; // kept mounted until the new rig proves it can move
		try {
			const gltf = await loader.loadAsync(url);
			const next = gltf.scene;
			scaleToHeight(next, AVATAR_HEIGHT);
			placeOnFloor(next);
			// Verify the clip library can actually drive this rig BEFORE committing.
			// The switcher lists public gallery rigs, not all of them humanoid — a
			// non-canonical skeleton (Fox, CesiumMan, a robot…) can't be retargeted
			// and would leave the player frozen in a bind/T-pose. Mount it, attach,
			// and require the clip to play; if it can't, roll back to the working
			// rig so her legs never stop moving (Hard rule 9: no errors without
			// solutions). The dancers (src/club.js) use the same verified fallback.
			rig.remove(prevAvatar);
			rig.add(next);
			anim.attach(next, { avatarUrl: url });
			const drivable = anim.supportsCanonicalClips() && await anim.play(clip);
			if (!drivable) {
				rig.remove(next);
				disposeObject(next);
				rig.add(prevAvatar);
				anim.attach(prevAvatar, { avatarUrl: currentAvatarUrl });
				await anim.play(clip);
				avatar = prevAvatar;
				if (agentSelect) agentSelect.value = currentAvatarUrl;
				log.warn(`[club-entrance] "${url}" can't be retargeted — keeping the current rig`);
				flashHint("That avatar can't dance our moves — keeping your current one.");
				return false;
			}
			// Committed: the new rig drives. Now it's safe to drop the old one.
			disposeObject(prevAvatar);
			avatar = next;
			currentAvatarUrl = url;
			if (agentSelect) agentSelect.value = url;
			return true;
		} catch (err) {
			log.warn('[club-entrance] agent swap failed', err);
			// A load/parse failure: make sure the working rig is still mounted and
			// animating, never a blank/frozen stage.
			if (avatar !== prevAvatar) {
				try {
					rig.add(prevAvatar);
					anim.attach(prevAvatar, { avatarUrl: currentAvatarUrl });
					await anim.play(clip);
					avatar = prevAvatar;
				} catch (e2) { log.warn('[club-entrance] rollback after swap failure also failed', e2); }
			}
			if (agentSelect) agentSelect.value = currentAvatarUrl; // keep the working rig selected
			flashHint("Couldn't load that avatar — keeping your current one.");
			return false;
		} finally {
			swappingAgent = false;
			if (agentSelect) agentSelect.disabled = false;
			if (agentBrowseBtn) agentBrowseBtn.disabled = false;
		}
	}

	setupAgentSwitch();
	showAgentSwitch(true);

	// Music clarity ramps with the journey: the bed plays muffled-through-the-door
	// while you're outside, opens up a step with each threshold you cross after
	// paying, and is wide open by the time the pole floor reveals. src/club.js
	// listens for club:clarity and drives the audio FX chain — the track itself
	// never restarts, it just gets clearer. 0 = outside, 1 = on the floor.
	function clarityForVenue(i) {
		if (!paid) return 0;
		// After paying, spread the opening evenly across the remaining walk:
		// admission sits ~30% open, each venue deeper adds the rest, and the
		// final hand-off to the stage (advance → arriving) snaps to fully open.
		return 0.3 + 0.7 * (i / SEQUENCE.length);
	}
	function pushClarity(frac) {
		window.dispatchEvent(new CustomEvent('club:clarity', { detail: { clarity: frac } }));
	}

	// Hint + prompt copy track where you are in the journey: the alley door takes
	// the cover, the final place opens the stage, the rest just lead onward.
	const isFinalVenue = () => venueIndex >= SEQUENCE.length - 1;
	function doorLabel() {
		if (currentCover) return 'Enter the club';
		if (isFinalVenue()) return 'Enter the stage';
		return 'Keep going';
	}
	function setHint() {
		if (!hintEl) return;
		const tail = currentCover ? 'walk to the door to enter'
			: isFinalVenue() ? 'walk to the doors at the end' : 'walk to the far end to keep going';
		hintEl.textContent = isTouch
			? `Drag to move and look · ${tail}`
			: `WASD / arrows to move · drag to look · ${tail}`;
	}
	// Briefly override the controls hint with a transient message (e.g. a rejected
	// avatar swap), then restore the normal movement hint. Self-cancelling so
	// rapid messages don't leave a stale one pinned.
	let hintFlashTimer = 0;
	function flashHint(msg) {
		if (!hintEl) return;
		if (hintFlashTimer) clearTimeout(hintFlashTimer);
		hintEl.textContent = msg;
		showHint(true);
		hintFlashTimer = setTimeout(() => { hintFlashTimer = 0; setHint(); }, 3200);
	}
	function setPromptLabel() {
		if (!promptEl) return;
		const label = doorLabel();
		promptEl.innerHTML = `${label} <kbd>E</kbd>`;
		promptEl.setAttribute('aria-label', label);
	}

	let nearDoor = false;
	function tryEnter() {
		if (!inputEnabled || !nearDoor) return;
		inputEnabled = false;
		releaseControls();
		showPrompt(false);
		showHint(false);
		showJoystick(false);
		showMinimap(false);
		showAgentSwitch(false);
		if (currentCover) {
			// Hand off to the cover-charge card; we resume on admit (onPaid).
			window.dispatchEvent(new CustomEvent('club:enter-door'));
		} else {
			advance();
		}
	}

	// Move on: the final place reveals the strip club (the pole stage); any other
	// place fades out and the next one fades in for you to keep walking.
	function advance() {
		nearDoor = false;
		if (isFinalVenue()) {
			setJourneyStep(SEQUENCE.length); // light the Stage step
			pushClarity(1); // stepping onto the floor — fully open the bed
			setPhase('arriving');
		} else {
			setPhase('swapOut');
		}
	}

	// Backed out of the cover card without paying — resume walking the alley.
	const onLeaveDoor = () => {
		if (phase !== 'walk') return;
		inputEnabled = true;
		showHint(true);
		showJoystick(isTouch);
		showMinimap(true);
		showAgentSwitch(true);
	};
	window.addEventListener('club:leave-door', onLeaveDoor);

	// ── State + render loop ──────────────────────────────────────────────────
	let phase = 'walk'; // walk (any place) → swapOut → swapIn → walk … → arriving → done
	let phaseStart = performance.now();
	let raf = 0;
	let last = performance.now();
	let lastDraw = 0;
	// Cap the draw rate at ~60 fps. Without this the loop renders at the panel's
	// native refresh (120/144 Hz on many laptops), doing 2–2.4× the GPU work for
	// no visible benefit — the dominant cause of the fans spinning up. Simulation
	// still steps every animation frame; only the expensive composer.render is
	// gated, so movement stays smooth.
	// Under the shared power-saver preference (see shared/frame-governor.js —
	// same toggle as the main club floor and /play) the cap halves to 30fps.
	const FRAME_BUDGET_MS = () => (getPowerSaver() ? 1000 / 30 : 1000 / 60) - 1; // -1ms slack so a 60Hz panel never skips
	// Sustained-slow-frame watchdog: drops pixel ratio one tier (and finally the
	// SMAA pass) when frames stay above budget, so a struggling GPU cools off
	// instead of grinding. Never upgrades — see club-perf.js.
	const watchdog = createFrameWatchdog({
		initialTier: profile.tier,
		onDowngrade(tier) {
			const next = PROFILES[tier];
			if (!next) return;
			renderer.setPixelRatio(next.pixelRatio);
			composer.setSize(window.innerWidth, window.innerHeight);
			smaaPass.enabled = next.tier !== 'low';
			log.info('[club] render downgraded to', tier, 'profile');
		},
	});
	// True only while the admission dance is playing. Freezes the movement clip
	// so the per-frame idle/walk crossfade in stepAvatar can't stomp the twerk
	// the instant it starts.
	let celebrating = false;

	function setPhase(p) { phase = p; phaseStart = performance.now(); }

	function frame(now) {
		// Cap at 0.1s so a single hitch (or a backgrounded tab) never teleports
		// the avatar, while keeping movement full-speed down to ~10 fps.
		const dt = Math.min((now - last) / 1000, 0.1);
		last = now;
		const elapsed = (now - phaseStart) / 1000;

		// Movement is always yours — keyboard or joystick, in every place. We
		// never walk the avatar for you.
		let ix = 0, iz = 0;
		if (inputEnabled) {
			if (keys.has('w') || keys.has('arrowup')) iz += 1;
			if (keys.has('s') || keys.has('arrowdown')) iz -= 1;
			if (keys.has('a') || keys.has('arrowleft')) ix -= 1;
			if (keys.has('d') || keys.has('arrowright')) ix += 1;
			if (joy.active) { ix += joy.nx; iz += -joy.ny; }
		}
		stepAvatar(ix, iz, dt);
		trackFloor(dt);
		anim.update(dt);
		crowd.update(dt);
		updateCamera(dt);
		if (phase === 'walk') minimap.update(rig.position, rig.rotation.y, nearDoor, now / 1000, prefersReducedMotion);

		// Key + fill follow the avatar so the patch of alley you're walking is lit.
		key.position.set(rig.position.x, 5, rig.position.z + 1);
		key.target.position.copy(rig.position).setY(1);
		fill.position.set(rig.position.x, 2.4, rig.position.z);

		if (phase === 'walk') {
			const d = Math.hypot(rig.position.x - path.door.x, rig.position.z - path.door.z);
			const inRange = d < DOOR_RANGE;
			if (inRange !== nearDoor) {
				nearDoor = inRange;
				if (inRange) setPromptLabel();
				showPrompt(inRange && inputEnabled);
			}
			doorGlow.intensity = inRange ? 3.2 : 1.4;
			doorMarker.pulse(now / 1000, inRange, prefersReducedMotion);
			// The neon glows a touch hotter the closer you get to the door.
			const near = clamp(1 - d / 12, 0, 1);
			if (!prefersReducedMotion) bloomEffect.intensity = 1.2 + near * 0.7;
		}

		switch (phase) {
			case 'swapOut': {
				// Fade the current place out, mount the next, then fade it in.
				const k = Math.min(1, elapsed / 0.6);
				canvasEl.style.opacity = String(1 - k);
				if (k >= 1) {
					const next = loaded[venueIndex + 1];
					if (next && next !== 'error') {
						mountVenue(venueIndex + 1);
						placeSpawn();
						refreshCrowd(); // fill the next room with the roster
						setHint();
						// New room revealed — open the bed up another step.
						pushClarity(clarityForVenue(venueIndex));
						setPhase('swapIn');
					} else if (next === 'error') {
						// A place failed to load — don't strand the visitor; reveal
						// the stage rather than hang on a black frame.
						setPhase('arriving');
					} else {
						// Still downloading — canvas is now invisible. Drop pointer
						// capture so stage tip buttons stay clickable during the stall.
						canvasEl.style.pointerEvents = 'none';
					}
				}
				break;
			}
			case 'swapIn': {
				const k = Math.min(1, elapsed / 0.5);
				canvasEl.style.pointerEvents = '';
				canvasEl.style.opacity = String(k);
				if (k >= 1) {
					setPhase('walk');
					inputEnabled = true;
					nearDoor = false;
					showHint(true);
					showJoystick(isTouch);
					showMinimap(true);
					showAgentSwitch(true);
				}
				break;
			}
			case 'arriving': {
				// Final hand-off: fade out to reveal the strip club (src/club.js).
				const k = Math.min(1, elapsed / ARRIVE);
				canvasEl.style.opacity = String(1 - k);
				if (k >= 1) return dispose();
				break;
			}
		}

		// Draw at most ~60 fps, and never while the tab is hidden — the GPU
		// shouldn't keep rendering a club nobody is looking at. Simulation above
		// already ran this frame; here we only decide whether to paint it.
		if (!document.hidden && now - lastDraw >= FRAME_BUDGET_MS()) {
			// Clamp like the sim dt so the first draw after a hidden tab (interval
			// of seconds) can't single-handedly trip the slow-frame watchdog.
			const drawDt = Math.min((now - lastDraw) / 1000, 0.1);
			lastDraw = now;
			composer.render(dt);
			watchdog.tick(drawDt);
		}
		raf = requestAnimationFrame(frame);
	}
	// Draw one frame so the alley is on screen, then lift the intro overlay.
	composer.render(0);
	hideLoader();
	raf = requestAnimationFrame(frame);

	// Move + face the avatar, clamp to the corridor, and drive the walk clip.
	function stepAvatar(ix, iz, dt) {
		// Hold position + clip while the admission celebration plays — the dance
		// owns the avatar until it finishes, then walking resumes.
		if (celebrating) return;
		const len = Math.hypot(ix, iz);
		if (len < 0.04) {
			anim.crossfadeTo('idle', 0.25).catch(() => {});
			return;
		}
		const nx = ix / len, nz = iz / len;
		const sinY = Math.sin(camYaw), cosY = Math.cos(camYaw);
		// forward (into screen) = (-sinY, 0, -cosY); right = (cosY, 0, -sinY)
		const wx = -sinY * nz + cosY * nx;
		const wz = -cosY * nz - sinY * nx;
		const speed = MOVE_SPEED * Math.min(1, len);
		rig.position.x = clamp(rig.position.x + wx * speed * dt, env.bounds.minX, env.bounds.maxX);
		rig.position.z = clamp(rig.position.z + wz * speed * dt, env.bounds.minZ, env.bounds.maxZ);
		// Face travel direction (shortest-arc yaw lerp).
		const targetYaw = Math.atan2(wx, wz);
		rig.rotation.y = lerpAngle(rig.rotation.y, targetYaw, 1 - Math.exp(-12 * dt));
		anim.crossfadeTo('walk', 0.2).catch(() => {});
	}

	// Distance from `target` at which the line of sight to the camera first hits a
	// wall, or `fallback` when the path is clear. Shared by the desired-position
	// solve and the post-lerp safety clamp so both use identical collision logic.
	function wallClearance(target, dir, maxDist, fallback) {
		camRay.set(target, dir);
		camRay.far = maxDist;
		const hit = camRay.intersectObject(env.root, true)[0];
		if (!hit) return fallback;
		return clamp(hit.distance - CAM_WALL_SKIN, CAM_MIN_DIST, maxDist);
	}

	function updateCamera(dt) {
		const cosP = Math.cos(camPitch);
		const off = new Vector3(Math.sin(camYaw) * cosP, Math.sin(camPitch), Math.cos(camYaw) * cosP);
		const target = new Vector3(rig.position.x, rig.position.y + HEAD_Y, rig.position.z);
		const desired = target.clone().addScaledVector(off, CAM_DIST);
		desired.y = rig.position.y + CAM_HEIGHT + Math.sin(camPitch) * CAM_DIST;

		// Pull the ideal position in front of any wall between it and the avatar,
		// so the resting framing never buries the camera in geometry.
		const toCam = desired.clone().sub(target);
		const dist = toCam.length();
		if (dist > 1e-3) {
			const dir = toCam.multiplyScalar(1 / dist);
			const clear = wallClearance(target, dir, dist, dist);
			if (clear < dist) desired.copy(target).addScaledVector(dir, clear);
		}

		const a = 1 - Math.exp(-9 * dt);
		camera.position.lerp(desired, a);

		// Safety clamp on the *actual* (post-lerp) position. The smoothed camera
		// lags the avatar, so during a fast turn or a step into a corner it can
		// drift through a wall a frame before the lerp catches up — that's the
		// flash of see-through brown geometry. Re-cast from the head to wherever
		// the camera really is and hard-snap it in front of any wall it crossed.
		// A hard snap (not a lerp) guarantees no frame is ever rendered from
		// behind a wall.
		const actual = camera.position.clone().sub(target);
		const aDist = actual.length();
		if (aDist > 1e-3) {
			const dir = actual.multiplyScalar(1 / aDist);
			const clear = wallClearance(target, dir, aDist, aDist);
			if (clear < aDist) camera.position.copy(target).addScaledVector(dir, clear);
		}

		camera.lookAt(target);
	}

	// Cover settled — the door is now just a doorway. The avatar breaks into a
	// twerk the moment the USDC lands, then keeps walking: fade out the alley and
	// into the next place. (Input is already disabled from tryEnter.)
	async function onPaid() {
		if (phase !== 'walk') return;
		paid = true;
		currentCover = false;
		showPrompt(false); showHint(false); showJoystick(false); showMinimap(false); showAgentSwitch(false);
		// Cover's paid and the rope drops — crack the door open so the bed clears
		// its first step the moment the walk-in dance starts.
		pushClarity(clarityForVenue(venueIndex));
		await celebrateAdmission();
		advance();
	}
	onAdmit = onPaid;
	if (admitted) onPaid();

	// Play the admission twerk once (the 5s built clip) and resolve when it
	// finishes, so the walk-in fade picks up cleanly off the last frame. Skipped
	// silently when motion is reduced or the active rig can't be driven by the
	// canonical clip library (the dance would be a no-op) — in both cases we
	// advance straight away. A hard cap (longer than the clip) backstops a
	// 'finished' event the mixer never fires (a clip that failed to retarget), so
	// a paying visitor is never stranded outside.
	function celebrateAdmission() {
		if (prefersReducedMotion || !anim.supportsCanonicalClips() || !anim.canPlay(ADMIT_DANCE_CLIP)) {
			return Promise.resolve();
		}
		return new Promise((resolve) => {
			let settled = false;
			const finish = () => {
				if (settled) return;
				settled = true;
				clearTimeout(cap);
				try { anim.mixer?.removeEventListener('finished', onFinished); } catch {}
				celebrating = false;
				resolve();
			};
			const onFinished = () => finish();
			const cap = setTimeout(finish, 7000);
			try { anim.mixer?.addEventListener('finished', onFinished); } catch {}
			celebrating = true;
			// settleTo:null — hold the final twerk pose under the fade-out instead
			// of snapping back to idle right before the alley dissolves.
			anim.playOnce(ADMIT_DANCE_CLIP, { settleTo: null, fade: 0.2 }).catch(finish);
		});
	}

	function onResize() {
		renderer.setSize(window.innerWidth, window.innerHeight, false);
		composer.setSize(window.innerWidth, window.innerHeight);
		camera.aspect = window.innerWidth / window.innerHeight;
		camera.updateProjectionMatrix();
		minimap.resize();
	}
	window.addEventListener('resize', onResize);

	function dispose() {
		cancelAnimationFrame(raf);
		if (hintFlashTimer) { clearTimeout(hintFlashTimer); hintFlashTimer = 0; }
		window.removeEventListener('resize', onResize);
		window.removeEventListener('keydown', onKeyDown);
		window.removeEventListener('keyup', onKeyUp);
		window.removeEventListener('blur', onBlur);
		window.removeEventListener('club:leave-door', onLeaveDoor);
		document.removeEventListener('visibilitychange', onVisibility);
		// Canvas pointer/click + the persistent door-prompt click listener — the
		// prompt outlives the canvas, so its listener would otherwise pin the whole
		// scene graph (scene, rig, crowd, renderer) in memory after teardown.
		canvasEl.removeEventListener('pointerdown', onPointerDown);
		canvasEl.removeEventListener('pointermove', onPointerMove);
		canvasEl.removeEventListener('pointerup', endPointer);
		canvasEl.removeEventListener('pointercancel', endPointer);
		canvasEl.removeEventListener('click', onClick);
		promptEl?.removeEventListener('click', tryEnter);
		agentSelect?.removeEventListener('change', onAgentChange);
		agentBrowseBtn?.removeEventListener('click', onBrowseAgents);
		onAdmit = null;
		try { anim.dispose?.(); } catch {}
		try { crowd.dispose(); } catch {}
		disposeObject(scene);
		composer.dispose();
		renderer.dispose();
		try { canvasEl.remove(); } catch {}
		showHint(false); showJoystick(false); showPrompt(false); showJourney(false); showMinimap(false); showAgentSwitch(false);
	}
}

// ── UI helpers ─────────────────────────────────────────────────────────────
function showPrompt(v) { toggle('club-door-prompt', v); }
function showHint(v) { toggle('club-controls-hint', v); }
function showJoystick(v) { toggle('club-joystick', v); }
function showJourney(v) { toggle('club-journey', v); }
function showMinimap(v) { toggle('club-minimap', v); }
function showAgentSwitch(v) { toggle('club-agent-switch', v); }
function toggle(id, v) {
	const el = document.getElementById(id);
	if (el) el.classList.toggle('is-visible', !!v);
}
// Light the step you're on (Alley/Gallery/Clubhouse/Stage); earlier steps read
// as done. `i` is the venue index; SEQUENCE.length marks arrival at the stage.
function setJourneyStep(i) {
	const el = document.getElementById('club-journey');
	if (!el) return;
	el.querySelectorAll('.club-journey-step').forEach((s) => {
		const n = Number(s.dataset.step);
		s.classList.toggle('is-done', n < i);
		s.classList.toggle('is-active', n === i);
	});
}

// ── Scene helpers ────────────────────────────────────────────────────────────

// Normalise an environment to a human-scaled room (height = ROOM_HEIGHT),
// recentre on the floor at the origin, add it, and return its box + the
// movement bounds (a margin inside the footprint so you don't clip walls).
function mountEnvironment(scene, root) {
	// Render the walls solid from both faces. These venue GLBs export single-sided
	// (FrontSide) walls, so the instant the chase camera grazes or dips behind a
	// building face the front faces cull away and you see straight through the
	// alley to the backfaces of the far walls — the geometry reads as abstract
	// brown shards rather than a room. DoubleSide keeps every surface opaque from
	// either side, so a tight camera angle can never punch a hole in the alley.
	root.traverse((n) => {
		if (!n.isMesh) return;
		n.frustumCulled = true;
		const mats = Array.isArray(n.material) ? n.material : [n.material];
		for (const m of mats) {
			if (m) m.side = DoubleSide;
		}
	});

	const box = new Box3().setFromObject(root);
	const size = box.getSize(new Vector3());
	root.scale.setScalar(ROOM_HEIGHT / (size.y || 1));
	const b2 = new Box3().setFromObject(root);
	const c = b2.getCenter(new Vector3());
	root.position.x -= c.x;
	root.position.z -= c.z;
	root.position.y -= b2.min.y;
	const group = new Group();
	group.add(root);
	scene.add(group);
	const wb = new Box3().setFromObject(group);
	const mx = (wb.max.x - wb.min.x) * 0.12;
	const mz = (wb.max.z - wb.min.z) * 0.12;
	return {
		root: group,
		box: wb,
		bounds: { minX: wb.min.x + mx, maxX: wb.max.x - mx, minZ: wb.min.z + mz, maxZ: wb.max.z - mz },
	};
}

// Where you spawn, where the door is, and which way you face. When the
// environment ships a modelled door (the alley does — `metal_door`), anchor to
// it: the approach axis runs from the door toward the room's interior, you
// spawn back down that axis, and you stand just in front of the door to enter.
// Otherwise fall back to the longer horizontal dimension so any unlabelled
// environment (e.g. the club interior) still gets a sane walk path.
function walkPath(box, anchor) {
	const size = box.getSize(new Vector3());
	const center = box.getCenter(new Vector3());

	if (anchor) {
		const door = anchor.center.clone().setY(0);
		let dir = new Vector3(center.x - door.x, 0, center.z - door.z);
		if (dir.lengthSq() < 1e-4) dir.set(0, 0, 1);
		dir.normalize();
		const reach = Math.abs(dir.x) * size.x + Math.abs(dir.z) * size.z;
		// Spawn a few steps from the door — close enough that the chase camera
		// stays well inside the alley (never behind the back wall) on load.
		const spawn = door.clone().addScaledVector(dir, clamp(reach * 0.32, 3.0, 5.0)).setY(0);
		// Stand just in front of the door (alley side), not inside the wall.
		const doorP = door.clone().addScaledVector(dir, 0.35).setY(0);
		return { dir, span: reach / 2, spawn, door: doorP, start: spawn, end: doorP };
	}

	const alongX = size.x > size.z;
	const span = (alongX ? size.x : size.z) / 2;
	const dir = alongX ? new Vector3(1, 0, 0) : new Vector3(0, 0, 1);
	const spawn = dir.clone().multiplyScalar(span * 0.6).setY(0);
	const doorP = dir.clone().multiplyScalar(-span * 0.82).setY(0);
	return { dir, span, spawn, door: doorP, start: spawn, end: doorP };
}

// Locate the modelled door in an environment by name (matches the alley's
// `metal_door*` meshes). Returns the largest match's world-space centre + size,
// or null when the environment has no labelled door.
function findDoorAnchor(root) {
	root.updateMatrixWorld(true);
	let best = null;
	root.traverse((n) => {
		if (!n.isMesh) return;
		if (!/door/i.test(n.name || '') && !/door/i.test(n.parent?.name || '')) return;
		const box = new Box3().setFromObject(n);
		if (box.isEmpty()) return;
		const size = box.getSize(new Vector3());
		const score = size.x * size.y * size.z;
		if (!best || score > best.score) best = { center: box.getCenter(new Vector3()), size, score };
	});
	return best;
}

// A dark slab set just inside the doorway, sized to the opening and turned to
// face the alley. Blocks the line of sight into the lit interior so the club is
// never visible from outside — paired with the neon frame in front of it, the
// entrance reads as a shut, glowing door.
function buildDoorOccluder(anchor, dir) {
	const { size } = anchor;
	const widthPerp = Math.abs(dir.z) * size.x + Math.abs(dir.x) * size.z;
	const geo = new BoxGeometry(Math.max(widthPerp, 1.4) * 1.2 + 0.3, size.y * 1.2, 0.3);
	const mat = new MeshStandardMaterial({ color: 0x06040b, roughness: 1, metalness: 0 });
	const mesh = new Mesh(geo, mat);
	mesh.position.copy(anchor.center);
	mesh.rotation.y = Math.atan2(dir.x, dir.z);
	// Nudge to the interior side of the door plane, hiding the recess behind it.
	mesh.position.addScaledVector(dir, -0.2);
	return mesh;
}

// A neon doorway: two posts, a lintel, and a glowing infill plane, with a
// gentle emissive pulse. Built from primitives so it works over any alley.
function buildDoorMarker() {
	const group = new Group();
	const frameMat = new MeshStandardMaterial({ color: 0x18121f, roughness: 0.5, metalness: 0.3, emissive: 0xff2fd0, emissiveIntensity: 0.5 });
	const glowMat = new MeshStandardMaterial({ color: 0x2a0a2a, emissive: 0xff5fe0, emissiveIntensity: 1.2, roughness: 0.4 });
	const post = (x) => {
		const m = new Mesh(new BoxGeometry(0.18, 2.7, 0.18), frameMat);
		m.position.set(x, 1.35, 0);
		return m;
	};
	const lintel = new Mesh(new BoxGeometry(1.5, 0.22, 0.2), frameMat);
	lintel.position.set(0, 2.62, 0);
	const infill = new Mesh(new BoxGeometry(1.2, 2.5, 0.04), glowMat);
	infill.position.set(0, 1.3, 0.02);
	group.add(post(-0.66), post(0.66), lintel, infill);
	return {
		group,
		pulse(t, hot, reduced = false) {
			const base = hot ? 2.2 : 1.0;
			const wave = reduced ? 0 : Math.sin(t * 2.4);
			glowMat.emissiveIntensity = base + wave * 0.35;
			frameMat.emissiveIntensity = (hot ? 1.0 : 0.5) + wave * 0.15;
		},
	};
}

// Top-down radar drawn on a 2D canvas: the room footprint, your avatar (an arrow
// that points where you're facing), and a pulsing dashed line to the door you're
// walking toward — so you always know which way the exit is. Pure 2D context, no
// extra WebGL; setVenue() re-fits the view to each room, update() redraws a frame.
function buildMinimap() {
	const cv = document.getElementById('club-minimap-canvas');
	const labelEl = document.getElementById('club-minimap-label');
	if (!cv) return { setVenue() {}, update() {}, resize() {} };
	const ctx = cv.getContext('2d');

	let cssW = 0, cssH = 0, dpr = 1;
	function resize() {
		const r = cv.getBoundingClientRect();
		cssW = r.width || cv.clientWidth || 138;
		cssH = r.height || cv.clientHeight || 110;
		dpr = Math.min(window.devicePixelRatio || 1, 2);
		cv.width = Math.round(cssW * dpr);
		cv.height = Math.round(cssH * dpr);
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	}
	resize();

	const PAD = 14;
	let bounds = null; // { minX, maxX, minZ, maxZ }
	let door = null;   // { x, z }

	// World (x, z) → minimap pixel (x, y), aspect-preserving so the room reads true.
	function project(x, z) {
		if (!bounds) return { x: cssW / 2, y: cssH / 2 };
		const bw = (bounds.maxX - bounds.minX) || 1;
		const bh = (bounds.maxZ - bounds.minZ) || 1;
		const scale = Math.min((cssW - PAD * 2) / bw, (cssH - PAD * 2) / bh);
		const ox = (cssW - bw * scale) / 2;
		const oy = (cssH - bh * scale) / 2;
		return { x: ox + (x - bounds.minX) * scale, y: oy + (z - bounds.minZ) * scale, scale };
	}

	function setVenue(box, doorPos, name) {
		bounds = { minX: box.min.x, maxX: box.max.x, minZ: box.min.z, maxZ: box.max.z };
		door = { x: doorPos.x, z: doorPos.z };
		if (labelEl && name) labelEl.textContent = name;
	}

	function update(pos, yaw, near, t, reduced) {
		ctx.clearRect(0, 0, cssW, cssH);
		if (!bounds || !door) return;

		// Room footprint.
		const a = project(bounds.minX, bounds.minZ);
		const b = project(bounds.maxX, bounds.maxZ);
		ctx.fillStyle = 'rgba(255, 59, 214, 0.06)';
		ctx.strokeStyle = 'rgba(255, 59, 214, 0.28)';
		ctx.lineWidth = 1;
		ctx.beginPath();
		ctx.rect(a.x, a.y, b.x - a.x, b.y - a.y);
		ctx.fill();
		ctx.stroke();

		const me = project(pos.x, pos.z);
		const dr = project(door.x, door.z);

		// Pulsing dashed guide line from you to the door — the "go this way" cue.
		ctx.save();
		ctx.setLineDash([5, 5]);
		ctx.lineDashOffset = reduced ? 0 : -(t * 14) % 10;
		ctx.strokeStyle = near ? 'rgba(120, 255, 180, 0.85)' : 'rgba(255, 79, 216, 0.7)';
		ctx.lineWidth = 1.5;
		ctx.beginPath();
		ctx.moveTo(me.x, me.y);
		ctx.lineTo(dr.x, dr.y);
		ctx.stroke();
		ctx.restore();

		// Door marker — glowing diamond.
		const pulse = reduced ? 0 : (Math.sin(t * 2.4) + 1) * 0.5;
		ctx.save();
		ctx.translate(dr.x, dr.y);
		ctx.rotate(Math.PI / 4);
		ctx.fillStyle = near ? '#78ffb4' : '#ff4fd8';
		ctx.shadowColor = ctx.fillStyle;
		ctx.shadowBlur = 6 + pulse * 6;
		const s = 4.5;
		ctx.fillRect(-s, -s, s * 2, s * 2);
		ctx.restore();

		// Avatar arrow — points the way you're facing (world heading = sin/cos yaw).
		ctx.save();
		ctx.translate(me.x, me.y);
		ctx.rotate(Math.atan2(Math.cos(yaw), Math.sin(yaw)));
		ctx.fillStyle = '#ffffff';
		ctx.shadowColor = 'rgba(255, 255, 255, 0.9)';
		ctx.shadowBlur = 5;
		ctx.beginPath();
		ctx.moveTo(7, 0);
		ctx.lineTo(-4, 4.5);
		ctx.lineTo(-4, -4.5);
		ctx.closePath();
		ctx.fill();
		ctx.restore();
	}

	return { setVenue, update, resize };
}

function scaleToHeight(obj, h) {
	const b = new Box3().setFromObject(obj, true);
	const cur = b.max.y - b.min.y || 1;
	obj.scale.multiplyScalar(h / cur);
}
function placeOnFloor(obj) {
	const b = new Box3().setFromObject(obj, true);
	obj.position.y -= b.min.y;
}

function disposeObject(obj) {
	obj.traverse((n) => {
		if (n.isMesh) {
			n.geometry?.dispose?.();
			const mats = Array.isArray(n.material) ? n.material : [n.material];
			mats.forEach((m) => {
				if (!m) return;
				for (const k in m) { if (m[k]?.isTexture) m[k].dispose(); }
				m.dispose?.();
			});
		}
	});
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function lerpAngle(a, b, t) {
	let d = (b - a) % (Math.PI * 2);
	if (d > Math.PI) d -= Math.PI * 2;
	if (d < -Math.PI) d += Math.PI * 2;
	return a + d * t;
}
