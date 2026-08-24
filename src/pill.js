/**
 * /pill: the pump.fun pill mascot, rigged and drivable.
 *
 * pump.fun verified $THREE as officially ours, and the obvious way to say thank you
 * on a 3D platform is not a press release: it is their mascot, rigged properly,
 * standing in a stage you can walk it around. The model ships from
 * `/avatars/pumpfun-pill-cupsey.glb` with a 52-bone Mixamo-named skeleton and
 * six clips baked in (scripts/rig-pill-mascot.py), so this page needs no
 * retargeting at load: it plays the model's own animations.
 *
 * Everything here is one canvas and one keyboard handler. WASD or the arrows
 * drive it, Shift runs, Space jumps, drag orbits, and the toolbar fires the
 * one-shots. Touch gets a real joystick (nipplejs, already in the tree for
 * /walk) rather than a "desktop only" apology.
 *
 * Failure is designed. No WebGL, a blocked GPU, or a GLB that will not load all
 * fall back to the poster still with a line saying what happened -- the page is
 * a thank-you note first and a demo second, and it has to read either way.
 */

import { log } from './shared/log.js';

const MODEL_URL = '/avatars/pumpfun-pill-cupsey.glb';
const POSTER_URL = '/avatars/thumbs/pumpfun-pill-cupsey.png';

// Ground radius, in model units. The mascot is ~2.1 units tall, so this is a
// stage a little over four of it across: big enough to build up a run, small
// enough that it never wanders out of frame.
const STAGE_RADIUS = 7;
const WALK_SPEED = 1.05;
const RUN_SPEED = 2.45;
// Metres each clip covers per second at timeScale 1, measured off the baked
// stride. Playback is scaled by actual speed / this, so the feet never skate.
const WALK_STRIDE_RATE = 0.95;
const RUN_STRIDE_RATE = 2.3;
const TURN_RATE = 9.0;          // radians per second

const KEY_AXES = {
	KeyW: [0, 1], ArrowUp: [0, 1],
	KeyS: [0, -1], ArrowDown: [0, -1],
	KeyA: [-1, 0], ArrowLeft: [-1, 0],
	KeyD: [1, 0], ArrowRight: [1, 0],
};

const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

// The stage is a lit 3D scene, not an image, so the theme switch has to reach
// into it: a black floor punched into a light page reads as a broken asset.
const STAGE_THEMES = {
	dark: { fog: 0x0b0d11, floor: 0x161b21, sky: 0xdfe9ff, ground: 0x1b2a20, accent: 0x2fd35f, grid: 0x22302a, exposure: 1.05 },
	light: { fog: 0xeef1f5, floor: 0xdde3e9, sky: 0xffffff, ground: 0xbccfc2, accent: 0x14a544, grid: 0xc3d0c8, exposure: 1.0 },
};

function stageTheme() {
	return document.documentElement.getAttribute('data-theme') === 'light'
		? STAGE_THEMES.light : STAGE_THEMES.dark;
}

const stage = document.getElementById('pill-stage');
const canvas = document.getElementById('pill-canvas');
const statusEl = document.getElementById('pill-status');
const progressEl = document.getElementById('pill-progress');
const hintEl = document.getElementById('pill-hint');
const toolbar = document.getElementById('pill-clips');
const joystickZone = document.getElementById('pill-joystick');

/** Swap the stage for the poster still and say why. */
function fallback(reason) {
	stage?.setAttribute('data-state', 'fallback');
	if (statusEl) {
		statusEl.innerHTML = '';
		const img = new Image();
		img.src = POSTER_URL;
		img.alt = 'The pump.fun pill mascot, rigged by three.ws';
		img.className = 'pill-poster';
		img.decoding = 'async';
		const note = document.createElement('p');
		note.className = 'pill-fallback-note';
		note.textContent = reason;
		statusEl.append(img, note);
	}
	toolbar?.setAttribute('hidden', '');
	hintEl?.setAttribute('hidden', '');
}

function hasWebGL() {
	try {
		const probe = document.createElement('canvas');
		return Boolean(probe.getContext('webgl2') || probe.getContext('webgl'));
	} catch {
		return false;
	}
}

/**
 * Soft round contact shadow, drawn once into a canvas texture.
 * Cheaper than a shadow map by an order of magnitude, and on a stage with one
 * character and a flat floor it is indistinguishable from one.
 */
function shadowTexture(THREE) {
	const size = 256;
	const c = document.createElement('canvas');
	c.width = c.height = size;
	const g = c.getContext('2d');
	const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
	grad.addColorStop(0, 'rgba(0,0,0,0.42)');
	grad.addColorStop(0.55, 'rgba(0,0,0,0.16)');
	grad.addColorStop(1, 'rgba(0,0,0,0)');
	g.fillStyle = grad;
	g.fillRect(0, 0, size, size);
	const tex = new THREE.CanvasTexture(c);
	tex.colorSpace = THREE.SRGBColorSpace;
	return tex;
}

async function boot() {
	if (!canvas || !stage) return;
	if (!hasWebGL()) {
		fallback('Your browser could not start WebGL, so here is the pill holding still.');
		return;
	}

	let THREE;
	let GLTFLoader;
	try {
		THREE = await import('three');
		({ GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js'));
	} catch (err) {
		log.warn('pill: three failed to load', err);
		fallback('The 3D runtime did not load. Reload the page to try again.');
		return;
	}

	const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
	renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
	renderer.outputColorSpace = THREE.SRGBColorSpace;
	renderer.toneMapping = THREE.ACESFilmicToneMapping;
	renderer.toneMappingExposure = 1.05;

	const scene = new THREE.Scene();
	scene.fog = new THREE.Fog(0x0b0d11, STAGE_RADIUS * 0.9, STAGE_RADIUS * 2.6);

	const ambient = new THREE.HemisphereLight(0xdfe9ff, 0x1b2a20, 1.9);
	scene.add(ambient);
	const key = new THREE.DirectionalLight(0xffffff, 2.1);
	key.position.set(4, 7, 5);
	scene.add(key);
	const rim = new THREE.DirectionalLight(0x8affc8, 0.9);
	rim.position.set(-5, 2.5, -4);
	scene.add(rim);

	// Floor: a dark disc with a green ring, matching the mascot rather than the
	// site's iris accent. The mascot is the accent on this page.
	const floor = new THREE.Mesh(
		new THREE.CircleGeometry(STAGE_RADIUS, 96),
		new THREE.MeshStandardMaterial({ color: 0x161b21, roughness: 0.96, metalness: 0 }),
	);
	floor.rotation.x = -Math.PI / 2;
	scene.add(floor);
	const ring = new THREE.Mesh(
		new THREE.RingGeometry(STAGE_RADIUS - 0.09, STAGE_RADIUS, 96),
		new THREE.MeshBasicMaterial({ color: 0x2fd35f, transparent: true, opacity: 0.35, side: THREE.DoubleSide }),
	);
	ring.rotation.x = -Math.PI / 2;
	ring.position.y = 0.002;
	scene.add(ring);
	const gridHelper = new THREE.PolarGridHelper(STAGE_RADIUS, 8, 6, 96);
	gridHelper.position.y = 0.001;
	gridHelper.material.vertexColors = false;
	gridHelper.material.transparent = true;
	gridHelper.material.opacity = 0.55;
	scene.add(gridHelper);

	function applyStageTheme() {
		const t = stageTheme();
		scene.fog.color.setHex(t.fog);
		floor.material.color.setHex(t.floor);
		ambient.color.setHex(t.sky);
		ambient.groundColor.setHex(t.ground);
		ring.material.color.setHex(t.accent);
		gridHelper.material.color.setHex(t.grid);
		renderer.toneMappingExposure = t.exposure;
	}
	applyStageTheme();
	const themeWatcher = new MutationObserver(applyStageTheme);
	themeWatcher.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

	const shadow = new THREE.Mesh(
		new THREE.PlaneGeometry(2.2, 2.2),
		new THREE.MeshBasicMaterial({ map: shadowTexture(THREE), transparent: true, depthWrite: false }),
	);
	shadow.rotation.x = -Math.PI / 2;
	shadow.position.y = 0.004;
	scene.add(shadow);

	const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 120);

	// ── Load ──────────────────────────────────────────────────────────────
	let gltf;
	try {
		gltf = await new GLTFLoader().loadAsync(MODEL_URL, (event) => {
			if (progressEl && event.total) {
				progressEl.style.setProperty('--pill-progress', `${Math.round((event.loaded / event.total) * 100)}%`);
			}
		});
	} catch (err) {
		log.warn('pill: model failed to load', err);
		fallback('The mascot could not be downloaded right now. Reload the page to try again.');
		renderer.dispose();
		return;
	}

	const rig = gltf.scene;
	const bounds = new THREE.Box3().setFromObject(rig);
	rig.position.y = -bounds.min.y;   // stand it on the floor, not through it
	const height = bounds.max.y - bounds.min.y;

	const actor = new THREE.Group();
	actor.add(rig);
	scene.add(actor);

	const mixer = new THREE.AnimationMixer(rig);
	const clips = new Map();
	for (const clip of gltf.animations) clips.set(clip.name, mixer.clipAction(clip));
	if (!clips.size) {
		fallback('This build of the mascot shipped without its animations.');
		return;
	}
	for (const [name, action] of clips) {
		if (name === 'jump' || name === 'wave') {
			action.setLoop(THREE.LoopOnce, 1);
			action.clampWhenFinished = true;
		}
	}

	let current = null;
	function play(name, fade = 0.28) {
		const next = clips.get(name);
		if (!next || next === current) return;
		next.reset().setEffectiveWeight(1).fadeIn(fade).play();
		if (current) current.fadeOut(fade);
		current = next;
		toolbar?.querySelectorAll('[data-clip]').forEach((btn) => {
			btn.setAttribute('aria-pressed', String(btn.dataset.clip === name));
		});
	}
	play('idle', 0);

	// ── Input ─────────────────────────────────────────────────────────────
	const held = new Set();
	const stick = { x: 0, y: 0, force: 0 };
	let sprinting = false;
	// `oneShot` is the clip that owns the body: until it finishes (jump, wave),
	// or until the player moves (dance, and the locomotion previews the toolbar
	// fires). Without the second kind, clicking Walk plays one frame and the
	// next tick's "no input, so idle" overwrites it.
	let oneShot = null;
	let looping = false;

	function clearOneShot() {
		oneShot = null;
		looping = false;
	}

	mixer.addEventListener('finished', (event) => {
		if (oneShot && event.action === clips.get(oneShot)) clearOneShot();
	});

	function trigger(name) {
		if (!clips.has(name)) return;
		if (name === 'dance') {
			if (oneShot === 'dance') { clearOneShot(); play('idle'); return; }
			oneShot = 'dance';
			looping = true;
			play('dance');
			return;
		}
		if (name === 'jump') { jump(); return; }
		if (name === 'idle' || name === 'walk' || name === 'run') {
			oneShot = name;
			looping = true;
			play(name);
			return;
		}
		oneShot = name;
		looping = false;
		play(name, 0.18);
	}

	function jump() {
		if (oneShot === 'jump') return;
		// The hop lives in the clip's own Hips track, authored against the
		// mascot's proportions. Adding a physics arc on top of it lifted the
		// character twice as high as either intended and landed it a third of a
		// second before the animation finished.
		oneShot = 'jump';
		looping = false;
		play('jump', 0.1);
	}

	function onKeyDown(event) {
		if (event.metaKey || event.ctrlKey || event.altKey) return;
		const target = event.target;
		if (target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
		if (event.code === 'ShiftLeft' || event.code === 'ShiftRight') { sprinting = true; return; }
		if (event.code === 'Space') { event.preventDefault(); jump(); return; }
		if (event.code === 'KeyE') { trigger('wave'); return; }
		if (event.code === 'KeyQ') { trigger('dance'); return; }
		if (!(event.code in KEY_AXES)) return;
		event.preventDefault();
		held.add(event.code);
		hintEl?.setAttribute('data-used', 'true');
	}
	function onKeyUp(event) {
		if (event.code === 'ShiftLeft' || event.code === 'ShiftRight') sprinting = false;
		held.delete(event.code);
	}
	window.addEventListener('keydown', onKeyDown);
	window.addEventListener('keyup', onKeyUp);
	window.addEventListener('blur', () => { held.clear(); sprinting = false; });

	toolbar?.addEventListener('click', (event) => {
		const btn = event.target instanceof Element ? event.target.closest('[data-clip]') : null;
		if (btn) trigger(btn.dataset.clip);
	});

	// Drag to orbit. Pointer events cover mouse, pen and touch with one path.
	const orbit = { yaw: 0.42, pitch: 0.17, distance: height * 2.3 };
	let dragging = null;
	canvas.addEventListener('pointerdown', (event) => {
		dragging = { id: event.pointerId, x: event.clientX, y: event.clientY };
		canvas.setPointerCapture(event.pointerId);
	});
	canvas.addEventListener('pointermove', (event) => {
		if (!dragging || dragging.id !== event.pointerId) return;
		orbit.yaw -= (event.clientX - dragging.x) * 0.006;
		orbit.pitch = Math.min(0.85, Math.max(-0.05, orbit.pitch + (event.clientY - dragging.y) * 0.004));
		dragging.x = event.clientX;
		dragging.y = event.clientY;
	});
	const endDrag = (event) => {
		if (dragging?.id === event.pointerId) dragging = null;
	};
	canvas.addEventListener('pointerup', endDrag);
	canvas.addEventListener('pointercancel', endDrag);
	canvas.addEventListener('wheel', (event) => {
		event.preventDefault();
		orbit.distance = Math.min(height * 4.5, Math.max(height * 1.35, orbit.distance + event.deltaY * 0.005));
	}, { passive: false });

	if (joystickZone && matchMedia('(pointer: coarse)').matches) {
		joystickZone.removeAttribute('hidden');
		try {
			const { default: nipplejs } = await import('nipplejs');
			const joystick = nipplejs.create({
				zone: joystickZone, mode: 'static', position: { left: '50%', top: '50%' },
				color: '#2fd35f', size: 92, restOpacity: 0.26,
			});
			joystick.on('move', (_event, data) => {
				const force = Math.min(1, data.force / 1.6);
				stick.force = force;
				stick.x = Math.cos(data.angle.radian) * force;
				stick.y = Math.sin(data.angle.radian) * force;
				hintEl?.setAttribute('data-used', 'true');
			});
			joystick.on('end', () => { stick.x = 0; stick.y = 0; stick.force = 0; });
		} catch (err) {
			log.warn('pill: joystick unavailable', err);
			joystickZone.setAttribute('hidden', '');
		}
	}

	// ── Frame loop ────────────────────────────────────────────────────────
	stage.setAttribute('data-state', 'ready');
	statusEl?.setAttribute('hidden', '');

	const forward = new THREE.Vector3();
	const right = new THREE.Vector3();
	const move = new THREE.Vector3();
	const camTarget = new THREE.Vector3();
	const camWanted = new THREE.Vector3();
	const hipsWorld = new THREE.Vector3();
	const hips = rig.getObjectByName('mixamorig:Hips') ?? null;
	const hipsRestY = hips ? hips.getWorldPosition(new THREE.Vector3()).y : 0;
	let heading = 0;

	function resize() {
		const rect = stage.getBoundingClientRect();
		const w = Math.max(1, Math.round(rect.width));
		const h = Math.max(1, Math.round(rect.height));
		renderer.setSize(w, h, false);
		camera.aspect = w / h;
		camera.updateProjectionMatrix();
	}
	const observer = new ResizeObserver(resize);
	observer.observe(stage);
	resize();

	let last = performance.now();
	let running = true;
	renderer.setAnimationLoop(() => {
		if (!running) return;
		const now = performance.now();
		const dt = Math.min(0.05, (now - last) / 1000);
		last = now;

		// Camera-relative input: W walks away from the camera, the way a
		// third-person camera sitting behind the character implies.
		forward.set(-Math.sin(orbit.yaw), 0, -Math.cos(orbit.yaw));
		right.set(-forward.z, 0, forward.x);
		move.set(0, 0, 0);
		for (const code of held) {
			const [x, z] = KEY_AXES[code];
			move.addScaledVector(right, x).addScaledVector(forward, z);
		}
		move.addScaledVector(right, stick.x).addScaledVector(forward, stick.y);
		const input = Math.min(1, move.length());
		if (input > 0.001) move.normalize();

		// Sprint is Shift on a keyboard and a hard push on a joystick; a plain
		// key press always walks, so the walk cycle is what most visitors see.
		const sprint = (sprinting || stick.force > 0.88) && input > 0.35;
		const speed = input * (sprint ? RUN_SPEED : WALK_SPEED);

		if (input > 0.05) {
			if (oneShot && looping) clearOneShot();
			const wanted = Math.atan2(move.x, move.z);
			let delta = ((wanted - heading + Math.PI) % (Math.PI * 2)) - Math.PI;
			if (delta < -Math.PI) delta += Math.PI * 2;
			heading += Math.max(-TURN_RATE * dt, Math.min(TURN_RATE * dt, delta));
			actor.position.addScaledVector(move, speed * dt);
			const radial = Math.hypot(actor.position.x, actor.position.z);
			if (radial > STAGE_RADIUS - 0.7) {
				const scale = (STAGE_RADIUS - 0.7) / radial;
				actor.position.x *= scale;
				actor.position.z *= scale;
			}
		}
		actor.rotation.y = heading;

		if (!oneShot) {
			const name = input > 0.05 ? (sprint ? 'run' : 'walk') : 'idle';
			play(name);
			const action = clips.get(name);
			if (action) {
				action.timeScale = name === 'idle' ? 1
					: Math.max(0.55, speed / (name === 'run' ? RUN_STRIDE_RATE : WALK_STRIDE_RATE));
			}
		}

		mixer.update(dt);

		// The shadow reads the hips off the skeleton rather than the actor, so it
		// shrinks under a jump that only the clip knows about.
		shadow.position.set(actor.position.x, 0.004, actor.position.z);
		const lift = hips ? Math.max(0, hips.getWorldPosition(hipsWorld).y - hipsRestY) : 0;
		shadow.scale.setScalar(1 / (1 + lift * 0.9));
		shadow.material.opacity = 1 / (1 + lift * 1.9);

		camTarget.set(actor.position.x, actor.position.y + height * 0.45, actor.position.z);
		camWanted.set(
			camTarget.x + Math.sin(orbit.yaw) * Math.cos(orbit.pitch) * orbit.distance,
			camTarget.y + Math.sin(orbit.pitch) * orbit.distance + height * 0.1,
			camTarget.z + Math.cos(orbit.yaw) * Math.cos(orbit.pitch) * orbit.distance,
		);
		camera.position.lerp(camWanted, reduceMotion ? 1 : Math.min(1, dt * 6));
		camera.lookAt(camTarget);

		renderer.render(scene, camera);
	});

	// Stop the loop when the stage scrolls away: a mascot idling in a canvas
	// nobody is looking at is a battery bug, not a feature.
	const visibility = new IntersectionObserver((entries) => {
		running = entries.some((entry) => entry.isIntersecting);
		if (running) last = performance.now();
	}, { threshold: 0.02 });
	visibility.observe(stage);
	document.addEventListener('visibilitychange', () => {
		if (document.hidden) running = false;
		else { running = true; last = performance.now(); }
	});
}

boot().catch((err) => {
	log.warn('pill: stage failed', err);
	fallback('The stage did not start. Reload the page to try again.');
});
