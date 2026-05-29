// Mini walk viewer for the homepage "Walk Embed" section.
// Stripped-down version of walk.js: avatar + joystick + WASD + camera follow.
// No multiplayer, AR, recording, chat, or HUD — just the interactive 3D demo.

import {
	AmbientLight,
	CircleGeometry,
	Clock,
	Color,
	DirectionalLight,
	Group,
	HemisphereLight,
	Mesh,
	MeshBasicMaterial,
	MeshStandardMaterial,
	CanvasTexture,
	PCFSoftShadowMap,
	PerspectiveCamera,
	PlaneGeometry,
	PMREMGenerator,
	Quaternion,
	Scene,
	ShadowMaterial,
	Vector3,
	WebGLRenderer,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import nipplejs from 'nipplejs';
import { AnimationManager } from './animation-manager.js';

const AVATAR_URL = '/avatars/default.glb';
const ANIMATIONS_MANIFEST_URL = '/animations/manifest.json';
const CLIP_IDLE = 'idle';
const CLIP_WALK = 'av-walk-feminine';

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
const GROUND_RADIUS = 8;
const JUMP_VELOCITY = 5.0;
const GRAVITY = -14;
const GROUND_Y = 0;

function lerpAngle(a, b, t) {
	let d = ((b - a + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
	return a + d * t;
}

export function initWalkPreview(container) {
	const canvas = container.querySelector('canvas');
	const joystickEl = container.querySelector('[data-walk-joystick]');
	if (!canvas || !joystickEl) return;

	// ── Renderer ────────────────────────────────────────────────────
	const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true });
	renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
	renderer.shadowMap.enabled = true;
	renderer.shadowMap.type = PCFSoftShadowMap;

	const scene = new Scene();
	const pmrem = new PMREMGenerator(renderer);
	scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

	// Lights
	const ambient = new AmbientLight(0xffffff, 0.55);
	scene.add(ambient);
	const hemi = new HemisphereLight(0xbcd6ff, 0x202830, 0.6);
	hemi.position.set(0, 5, 0);
	scene.add(hemi);
	const sun = new DirectionalLight(0xffffff, 1.4);
	sun.position.set(4, 8, 6);
	sun.castShadow = true;
	sun.shadow.mapSize.set(512, 512);
	sun.shadow.camera.near = 0.5;
	sun.shadow.camera.far = 30;
	sun.shadow.camera.left = -8;
	sun.shadow.camera.right = 8;
	sun.shadow.camera.top = 8;
	sun.shadow.camera.bottom = -8;
	sun.shadow.bias = -0.0005;
	scene.add(sun);
	scene.add(sun.target);

	// Ground
	const ground = new Mesh(
		new CircleGeometry(GROUND_RADIUS, 64),
		new MeshStandardMaterial({ color: 0x202833, roughness: 0.95, metalness: 0.0 }),
	);
	ground.rotation.x = -Math.PI / 2;
	ground.receiveShadow = true;
	scene.add(ground);

	// Blob shadow
	const blobCanvas = document.createElement('canvas');
	blobCanvas.width = 64;
	blobCanvas.height = 64;
	const bCtx = blobCanvas.getContext('2d');
	const bGrad = bCtx.createRadialGradient(32, 32, 0, 32, 32, 32);
	bGrad.addColorStop(0, 'rgba(0,0,0,0.68)');
	bGrad.addColorStop(0.45, 'rgba(0,0,0,0.28)');
	bGrad.addColorStop(1, 'rgba(0,0,0,0)');
	bCtx.fillStyle = bGrad;
	bCtx.fillRect(0, 0, 64, 64);
	const blobShadow = new Mesh(
		new PlaneGeometry(1.0, 1.0),
		new MeshBasicMaterial({ map: new CanvasTexture(blobCanvas), transparent: true, depthWrite: false, opacity: 0 }),
	);
	blobShadow.rotation.x = -Math.PI / 2;
	blobShadow.position.y = 0.004;
	scene.add(blobShadow);

	// Camera
	const rect = container.getBoundingClientRect();
	const camera = new PerspectiveCamera(50, rect.width / rect.height, 0.05, 200);
	const avatarRig = new Group();
	scene.add(avatarRig);

	const camTarget = new Vector3();
	const camLookTarget = new Vector3();
	const camPosCurrent = new Vector3();
	const camLookCurrent = new Vector3();
	let cameraYaw = 0;
	let cameraPitch = 0.15;

	function applyCameraImmediate() {
		const offset = CAM_OFFSET.clone();
		offset.applyAxisAngle(new Vector3(0, 1, 0), cameraYaw);
		offset.y += Math.sin(cameraPitch) * offset.length() * 0.3;
		camTarget.copy(avatarRig.position).add(offset);
		camLookTarget.copy(avatarRig.position).add(CAM_LOOK_OFFSET);
		camPosCurrent.copy(camTarget);
		camLookCurrent.copy(camLookTarget);
		camera.position.copy(camPosCurrent);
		camera.lookAt(camLookCurrent);
	}
	applyCameraImmediate();

	// ── Input ───────────────────────────────────────────────────────
	const input = {
		joy: { x: 0, y: 0, active: false },
		keys: { forward: 0, back: 0, left: 0, right: 0, run: false },
	};

	const joystick = nipplejs.create({
		zone: joystickEl,
		mode: 'static',
		position: { left: '50%', top: '50%' },
		size: 90,
		color: 'rgba(255,255,255,0.85)',
		restOpacity: 0.6,
	});
	joystick.on('move', (_evt, data) => {
		if (data?.vector) {
			const mag = Math.min(1, data.distance / 45);
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

	// Keyboard — only when container is hovered or focused
	let containerFocused = false;
	container.setAttribute('tabindex', '0');
	container.addEventListener('mouseenter', () => { containerFocused = true; });
	container.addEventListener('mouseleave', () => {
		containerFocused = false;
		input.keys.forward = 0;
		input.keys.back = 0;
		input.keys.left = 0;
		input.keys.right = 0;
		input.keys.run = false;
	});
	container.addEventListener('focus', () => { containerFocused = true; });
	container.addEventListener('blur', () => {
		containerFocused = false;
		input.keys.forward = 0;
		input.keys.back = 0;
		input.keys.left = 0;
		input.keys.right = 0;
		input.keys.run = false;
	});

	window.addEventListener('keydown', (e) => {
		if (!containerFocused) return;
		if (e.target?.tagName === 'INPUT' || e.target?.tagName === 'TEXTAREA') return;
		switch (e.code) {
			case 'KeyW': case 'ArrowUp': input.keys.forward = 1; e.preventDefault(); break;
			case 'KeyS': case 'ArrowDown': input.keys.back = 1; e.preventDefault(); break;
			case 'KeyA': case 'ArrowLeft': input.keys.left = 1; e.preventDefault(); break;
			case 'KeyD': case 'ArrowRight': input.keys.right = 1; e.preventDefault(); break;
			case 'ShiftLeft': case 'ShiftRight': input.keys.run = true; break;
			case 'Space': e.preventDefault(); triggerJump(); break;
		}
	});
	window.addEventListener('keyup', (e) => {
		switch (e.code) {
			case 'KeyW': case 'ArrowUp': input.keys.forward = 0; break;
			case 'KeyS': case 'ArrowDown': input.keys.back = 0; break;
			case 'KeyA': case 'ArrowLeft': input.keys.left = 0; break;
			case 'KeyD': case 'ArrowRight': input.keys.right = 0; break;
			case 'ShiftLeft': case 'ShiftRight': input.keys.run = false; break;
		}
	});

	// Drag to orbit
	let dragActive = false;
	let dragStartX = 0, dragStartY = 0;
	let yawAtDragStart = 0, pitchAtDragStart = 0;
	canvas.addEventListener('pointerdown', (e) => {
		dragActive = true;
		dragStartX = e.clientX;
		dragStartY = e.clientY;
		yawAtDragStart = cameraYaw;
		pitchAtDragStart = cameraPitch;
		canvas.setPointerCapture(e.pointerId);
	});
	canvas.addEventListener('pointermove', (e) => {
		if (!dragActive) return;
		const dx = e.clientX - dragStartX;
		const dy = e.clientY - dragStartY;
		cameraYaw = yawAtDragStart + dx * 0.006;
		cameraPitch = Math.max(-0.5, Math.min(0.8, pitchAtDragStart + dy * 0.004));
	});
	canvas.addEventListener('pointerup', () => { dragActive = false; });
	canvas.addEventListener('pointercancel', () => { dragActive = false; });

	// ── Jump ────────────────────────────────────────────────────────
	let jumpActive = false;
	let jumpVelocity = 0;
	function triggerJump() {
		if (jumpActive) return;
		jumpActive = true;
		jumpVelocity = JUMP_VELOCITY;
	}

	// ── Avatar ──────────────────────────────────────────────────────
	const animationManager = new AnimationManager();
	let avatar = null;
	let avatarYaw = 0;
	let avatarLean = 0;
	let currentMotion = 'idle';

	async function loadAvatar() {
		const loader = new GLTFLoader();
		const gltf = await loader.loadAsync(AVATAR_URL);
		const model = gltf.scene;
		model.traverse((c) => {
			if (c.isMesh) {
				c.castShadow = true;
				c.receiveShadow = true;
			}
		});
		avatarRig.add(model);
		avatar = model;
		blobShadow.material.opacity = 0.6;

		animationManager.attach(model);

		// Fetch the clip manifest, register only the clips this preview plays
		// (idle + walk), then load them. loadAll() iterates the registered defs —
		// it does NOT take a manifest URL, so the defs must be set first or no
		// animation ever loads and the avatar renders frozen in its bind pose.
		const manifest = await fetch(ANIMATIONS_MANIFEST_URL, { cache: 'force-cache' })
			.then((r) => {
				if (!r.ok) throw new Error(`HTTP ${r.status} fetching animation manifest`);
				return r.json();
			});
		const needed = manifest.filter((d) => d.name === CLIP_IDLE || d.name === CLIP_WALK);
		if (needed.length === 0) throw new Error('Animation manifest missing idle/walk clips');
		animationManager.setAnimationDefs(needed);
		await animationManager.loadAll();

		animationManager.play(CLIP_IDLE);
		applyCameraImmediate();

		// Hide loading overlay
		const loadingEl = container.querySelector('[data-walk-loading]');
		if (loadingEl) {
			loadingEl.classList.add('is-done');
			loadingEl.addEventListener('transitionend', () => loadingEl.remove(), { once: true });
		}
	}

	// ── Resize ──────────────────────────────────────────────────────
	function resize() {
		const r = container.getBoundingClientRect();
		const w = r.width;
		const h = r.height;
		renderer.setSize(w, h, false);
		camera.aspect = w / h;
		camera.updateProjectionMatrix();
	}
	resize();
	const ro = new ResizeObserver(resize);
	ro.observe(container);

	// ── Tick ─────────────────────────────────────────────────────────
	const clock = new Clock();
	const moveWorld = new Vector3();
	const moveForward = new Vector3();
	const moveRight = new Vector3();
	const upY = new Vector3(0, 1, 0);
	let running = true;

	function tick() {
		if (!running) return;
		requestAnimationFrame(tick);

		const dt = Math.min(clock.getDelta(), 0.05);

		// Jump
		if (jumpActive && avatar) {
			jumpVelocity += GRAVITY * dt;
			avatarRig.position.y += jumpVelocity * dt;
			if (avatarRig.position.y <= GROUND_Y) {
				avatarRig.position.y = GROUND_Y;
				jumpVelocity = 0;
				jumpActive = false;
			}
		}

		// Input
		let ix, iy;
		if (input.joy.active) {
			ix = input.joy.x;
			iy = input.joy.y;
		} else if (input.keys.forward || input.keys.back || input.keys.left || input.keys.right) {
			ix = input.keys.right - input.keys.left;
			iy = input.keys.forward - input.keys.back;
		} else {
			ix = 0;
			iy = 0;
		}
		const mag = Math.min(1, Math.hypot(ix, iy));
		const wantRun = mag > 0.9 || input.keys.run;
		const speed = mag * (wantRun ? RUN_SPEED : WALK_SPEED);

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

			// Clamp to ground disc
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

			// Lean
			const leanTarget = wantRun ? LEAN_RUN_RAD : LEAN_WALK_RAD;
			avatarLean += (leanTarget - avatarLean) * LEAN_LERP;
		} else {
			avatarLean += (0 - avatarLean) * LEAN_LERP;
		}

		if (avatar) {
			avatar.rotation.x = avatarLean;
		}

		// Animation crossfade
		let wantMotion = 'idle';
		if (mag > 0.01) wantMotion = wantRun ? 'run' : 'walk';
		if (wantMotion !== currentMotion) {
			currentMotion = wantMotion;
			const clip = wantMotion === 'idle' ? CLIP_IDLE : CLIP_WALK;
			animationManager.crossfadeTo(clip, 0.35);
		}

		// Animation speed sync
		if (currentMotion !== 'idle' && animationManager.currentAction) {
			const naturalSpeed = wantRun ? NATURAL_RUN_SPEED : NATURAL_WALK_SPEED;
			animationManager.currentAction.timeScale = speed / naturalSpeed;
		}

		animationManager.mixer?.update(dt);

		// Blob shadow follows avatar
		blobShadow.position.x = avatarRig.position.x;
		blobShadow.position.z = avatarRig.position.z;

		// Sun follows avatar
		sun.position.set(
			avatarRig.position.x + 4,
			8,
			avatarRig.position.z + 6,
		);
		sun.target.position.copy(avatarRig.position);

		// Camera follow
		const offset = CAM_OFFSET.clone();
		offset.applyAxisAngle(upY, cameraYaw);
		offset.y += Math.sin(cameraPitch) * offset.length() * 0.3;
		camTarget.copy(avatarRig.position).add(offset);
		camLookTarget.copy(avatarRig.position).add(CAM_LOOK_OFFSET);
		camPosCurrent.lerp(camTarget, CAM_LERP);
		camLookCurrent.lerp(camLookTarget, CAM_LERP);
		camera.position.copy(camPosCurrent);
		camera.lookAt(camLookCurrent);

		renderer.render(scene, camera);
	}

	// ── Lazy init — only start when visible ─────────────────────────
	let started = false;
	const observer = new IntersectionObserver((entries) => {
		for (const entry of entries) {
			if (entry.isIntersecting && !started) {
				started = true;
				loadAvatar().catch((err) => console.warn('[walk-preview] load failed', err));
				tick();
				observer.disconnect();
			}
		}
	}, { threshold: 0.1 });
	observer.observe(container);

	// Pause rendering when off-screen
	const visObserver = new IntersectionObserver((entries) => {
		for (const entry of entries) {
			if (!entry.isIntersecting && running) {
				running = false;
				clock.stop();
			} else if (entry.isIntersecting && !running && started) {
				running = true;
				clock.start();
				tick();
			}
		}
	}, { threshold: 0 });
	visObserver.observe(container);
}
