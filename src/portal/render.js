// Portal: the walkable renderer.
//
// Takes a PortalWorld (src/portal/layout.js) and builds a real place you can
// walk through: districts you can see from the plaza, buildings sized by how
// much a section says, doors you step into, billboards showing the page's own
// images, and your avatar animated by the platform's universal clip library, so
// any rig walks correctly rather than sliding around in a T-pose.
//
// The module owns WebGL and input and nothing else: it never fetches a site,
// never parses HTML, and never decides what a world contains. It renders the
// document it is handed and reports two things back, `door` (what you are
// standing in front of) and `ready`, which is all the page needs to drive its
// HUD.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { AnimationManager } from '../animation-manager.js';
import { collidersFor } from './layout.js';
import { log } from '../shared/log.js';

const AVATAR_URL = '/avatars/default.glb';
const MANIFEST_URL = '/animations/manifest.json';
const WALK_SPEED = 4.4;
const RUN_SPEED = 8.2;
const TURN_RATE = 9;
const DOOR_REACH = 3.2;
const EYE_HEIGHT = 1.55;

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const lerp = (a, b, t) => a + (b - a) * t;

/** A label drawn to a canvas and hung in the world as a sprite. */
function makeLabel(text, { color = '#ffffff', background = 'rgba(6,8,14,0.72)', size = 44, maxWidth = 640 } = {}) {
	const canvas = document.createElement('canvas');
	const ctx = canvas.getContext('2d');
	const font = `600 ${size}px "Inter", system-ui, sans-serif`;
	ctx.font = font;
	const text1 = String(text || '').slice(0, 64);
	const width = Math.min(maxWidth, Math.ceil(ctx.measureText(text1).width) + size * 1.2);
	canvas.width = width;
	canvas.height = Math.ceil(size * 1.8);
	const c = canvas.getContext('2d');
	c.font = font;
	c.textBaseline = 'middle';
	c.fillStyle = background;
	const r = canvas.height / 2;
	c.beginPath();
	c.roundRect(0, 0, canvas.width, canvas.height, r);
	c.fill();
	c.fillStyle = color;
	c.fillText(text1, size * 0.6, canvas.height / 2, canvas.width - size * 1.2);
	const texture = new THREE.CanvasTexture(canvas);
	texture.colorSpace = THREE.SRGBColorSpace;
	texture.anisotropy = 4;
	const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false }));
	sprite.scale.set((canvas.width / canvas.height) * 1.1, 1.1, 1);
	sprite.userData.dispose = () => {
		texture.dispose();
		sprite.material.dispose();
	};
	return sprite;
}

/**
 * Build and run a portal world.
 * @param {{ canvas: HTMLCanvasElement, world: object, onDoor?: (door:object|null)=>void, onReady?: ()=>void }} opts
 */
export function createPortalWorld({ canvas, world, onDoor, onReady }) {
	const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
	renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
	renderer.outputColorSpace = THREE.SRGBColorSpace;
	renderer.toneMapping = THREE.ACESFilmicToneMapping;
	renderer.toneMappingExposure = 1.05;
	renderer.shadowMap.enabled = true;
	renderer.shadowMap.type = THREE.PCFSoftShadowMap;

	const scene = new THREE.Scene();
	scene.background = new THREE.Color(world.ground.sky);
	scene.fog = new THREE.Fog(world.ground.fog, 34, world.ground.radius * 1.5);

	const camera = new THREE.PerspectiveCamera(58, 1, 0.1, world.ground.radius * 4);
	const disposables = [];
	const track = (obj) => {
		disposables.push(obj);
		return obj;
	};

	// ── lighting ──────────────────────────────────────────────────────────────
	const hemi = new THREE.HemisphereLight(world.palette.accent, world.ground.color, 1.15);
	scene.add(hemi);
	const sun = new THREE.DirectionalLight(0xfff3e0, 2.2);
	sun.position.set(28, 46, 18);
	sun.castShadow = true;
	sun.shadow.mapSize.set(2048, 2048);
	const shadowSpan = Math.min(70, world.ground.radius);
	Object.assign(sun.shadow.camera, { left: -shadowSpan, right: shadowSpan, top: shadowSpan, bottom: -shadowSpan, near: 1, far: 160 });
	sun.shadow.bias = -0.0008;
	scene.add(sun);
	scene.add(new THREE.AmbientLight(world.palette.secondary, 0.25));

	// ── ground, plaza, roads ──────────────────────────────────────────────────
	const groundGeo = track(new THREE.CircleGeometry(world.ground.radius, 96));
	const groundMat = track(new THREE.MeshStandardMaterial({ color: world.ground.color, roughness: 0.96, metalness: 0.02 }));
	const ground = new THREE.Mesh(groundGeo, groundMat);
	ground.rotation.x = -Math.PI / 2;
	ground.receiveShadow = true;
	scene.add(ground);

	const plazaGeo = track(new THREE.CircleGeometry(world.plaza.radius, 64));
	const plazaMat = track(new THREE.MeshStandardMaterial({ color: world.palette.accent, roughness: 0.45, metalness: 0.25, transparent: true, opacity: 0.35 }));
	const plaza = new THREE.Mesh(plazaGeo, plazaMat);
	plaza.rotation.x = -Math.PI / 2;
	plaza.position.y = 0.02;
	plaza.receiveShadow = true;
	scene.add(plaza);

	// A road out to every district, so the city reads as connected from the air.
	const roadMat = track(new THREE.MeshBasicMaterial({ color: world.palette.accent, transparent: true, opacity: 0.16 }));
	for (const d of world.districts) {
		const length = Math.hypot(d.x, d.z);
		const geo = track(new THREE.PlaneGeometry(2.4, length));
		const road = new THREE.Mesh(geo, roadMat);
		road.rotation.x = -Math.PI / 2;
		road.rotation.z = -Math.atan2(d.z, d.x) + Math.PI / 2;
		road.position.set(d.x / 2, 0.015, d.z / 2);
		scene.add(road);
	}

	// ── the monument: the page's own title, standing at the centre ────────────
	const monumentGeo = track(new THREE.BoxGeometry(1.6, world.plaza.monument.h, 1.6));
	const monumentMat = track(new THREE.MeshStandardMaterial({
		color: world.palette.primary,
		emissive: new THREE.Color(world.palette.primary).multiplyScalar(0.35),
		roughness: 0.3,
		metalness: 0.4,
	}));
	const monument = new THREE.Mesh(monumentGeo, monumentMat);
	monument.position.y = world.plaza.monument.h / 2;
	monument.castShadow = true;
	scene.add(monument);
	const titleLabel = makeLabel(world.plaza.monument.label, { size: 52 });
	titleLabel.position.set(0, world.plaza.monument.h + 1.4, 0);
	titleLabel.scale.multiplyScalar(2.1);
	scene.add(titleLabel);
	disposables.push({ dispose: () => titleLabel.userData.dispose() });

	// ── buildings ─────────────────────────────────────────────────────────────
	const edgeMat = track(new THREE.LineBasicMaterial({ color: world.palette.accent, transparent: true, opacity: 0.55 }));
	for (const b of world.buildings) {
		const geo = track(new THREE.BoxGeometry(b.w, b.h, b.d));
		const mat = track(new THREE.MeshStandardMaterial({ color: b.color, roughness: 0.55, metalness: 0.2 }));
		const mesh = new THREE.Mesh(geo, mat);
		mesh.position.set(b.x, b.h / 2, b.z);
		mesh.rotation.y = -b.rot;
		mesh.castShadow = true;
		mesh.receiveShadow = true;
		mesh.userData.portal = { kind: 'building', id: b.id, label: b.label };
		scene.add(mesh);

		const edges = new THREE.LineSegments(track(new THREE.EdgesGeometry(geo)), edgeMat);
		edges.position.copy(mesh.position);
		edges.rotation.copy(mesh.rotation);
		scene.add(edges);

		// Floor bands read as storeys, so height means something at a glance.
		for (let f = 1; f < b.floors; f++) {
			const bandGeo = track(new THREE.BoxGeometry(b.w * 1.01, 0.06, b.d * 1.01));
			const band = new THREE.Mesh(bandGeo, track(new THREE.MeshBasicMaterial({ color: world.palette.accent, transparent: true, opacity: 0.3 })));
			band.position.set(b.x, (b.h / b.floors) * f, b.z);
			band.rotation.y = -b.rot;
			scene.add(band);
		}

		const label = makeLabel(b.label, { size: 40 });
		label.position.set(b.x, b.h + 1.1, b.z);
		label.scale.multiplyScalar(1.35);
		scene.add(label);
		disposables.push({ dispose: () => label.userData.dispose() });
	}

	// ── doors ─────────────────────────────────────────────────────────────────
	const doorMeshes = [];
	for (const d of world.doors) {
		const geo = track(new THREE.PlaneGeometry(d.w, d.h));
		const mat = track(new THREE.MeshStandardMaterial({
			color: d.color,
			emissive: new THREE.Color(d.color),
			emissiveIntensity: 0.7,
			roughness: 0.25,
			side: THREE.DoubleSide,
			transparent: true,
			opacity: 0.92,
		}));
		const mesh = new THREE.Mesh(geo, mat);
		mesh.position.set(d.x + Math.cos(d.yaw) * 0.06, d.h / 2, d.z + Math.sin(d.yaw) * 0.06);
		mesh.rotation.y = -d.yaw + Math.PI / 2;
		mesh.userData.door = d;
		scene.add(mesh);
		doorMeshes.push({ mesh, door: d, material: mat });

		const label = makeLabel(d.label || new URL(d.href).host, { size: 34, color: d.internal ? '#eaf6ff' : '#ffeede' });
		label.position.set(d.x, d.h + 0.75, d.z);
		scene.add(label);
		disposables.push({ dispose: () => label.userData.dispose() });
	}

	// ── billboards and monoliths ──────────────────────────────────────────────
	const loaderTexture = new THREE.TextureLoader();
	loaderTexture.setCrossOrigin('anonymous');
	for (const p of world.props) {
		if (p.kind === 'billboard') {
			const geo = track(new THREE.PlaneGeometry(p.w, p.h));
			const mat = track(new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide }));
			const mesh = new THREE.Mesh(geo, mat);
			mesh.position.set(p.x, p.h / 2 + 1.2, p.z);
			mesh.rotation.y = -p.yaw + Math.PI / 2;
			scene.add(mesh);
			// The image is fetched through our own proxy: a foreign host that sends
			// no CORS header would otherwise taint the texture and render black.
			loaderTexture.load(
				`/api/img?url=${encodeURIComponent(p.src)}`,
				(tex) => {
					tex.colorSpace = THREE.SRGBColorSpace;
					mat.map = tex;
					mat.needsUpdate = true;
					disposables.push(tex);
				},
				undefined,
				() => {
					// An image we cannot read becomes its own alt text, which is more
					// useful than a blank panel and is exactly what the page meant.
					mat.color.set(p.color);
					if (p.label) {
						const alt = makeLabel(p.label, { size: 30 });
						alt.position.set(p.x, p.h + 1.6, p.z);
						scene.add(alt);
						disposables.push({ dispose: () => alt.userData.dispose() });
					}
				},
			);
			const postGeo = track(new THREE.CylinderGeometry(0.09, 0.09, 1.2, 8));
			const post = new THREE.Mesh(postGeo, track(new THREE.MeshStandardMaterial({ color: world.palette.monolith, roughness: 0.8 })));
			post.position.set(p.x, 0.6, p.z);
			post.castShadow = true;
			scene.add(post);
		} else if (p.kind === 'monolith') {
			const geo = track(new THREE.BoxGeometry(p.w, p.h, p.w));
			const mat = track(new THREE.MeshStandardMaterial({
				color: p.color,
				emissive: new THREE.Color(world.palette.accent).multiplyScalar(0.22),
				roughness: 0.2,
				metalness: 0.7,
			}));
			const mesh = new THREE.Mesh(geo, mat);
			mesh.position.set(p.x, p.h / 2, p.z);
			mesh.rotation.y = -p.yaw;
			mesh.castShadow = true;
			scene.add(mesh);
		}
	}

	// ── the player ────────────────────────────────────────────────────────────
	const player = new THREE.Group();
	player.position.set(world.spawn.x, 0, world.spawn.z);
	player.rotation.y = world.spawn.yaw;
	scene.add(player);

	// A designed stand-in that is visible from frame one, replaced the moment the
	// rigged avatar loads. It is never the final state on a working connection,
	// and it is a real body rather than an empty camera when the GLB cannot load.
	const standInGeo = track(new THREE.CapsuleGeometry(0.32, 1.05, 6, 14));
	const standInMat = track(new THREE.MeshStandardMaterial({
		color: world.palette.accent,
		emissive: new THREE.Color(world.palette.accent).multiplyScalar(0.4),
		roughness: 0.35,
	}));
	const standIn = new THREE.Mesh(standInGeo, standInMat);
	standIn.position.y = 0.85;
	standIn.castShadow = true;
	player.add(standIn);

	const anim = new AnimationManager();
	let avatarModel = null;
	let moving = false;

	(async () => {
		try {
			const [gltf, defs] = await Promise.all([
				new GLTFLoader().loadAsync(AVATAR_URL),
				fetch(MANIFEST_URL, { cache: 'force-cache' }).then((r) => (r.ok ? r.json() : [])),
			]);
			avatarModel = gltf.scene;
			avatarModel.traverse((o) => {
				if (o.isMesh) {
					o.castShadow = true;
					o.frustumCulled = false;
				}
			});
			anim.setAvatarContext({ avatarUrl: AVATAR_URL });
			anim.attach(avatarModel);
			if (Array.isArray(defs) && defs.length) {
				anim.setAnimationDefs(defs.filter((d) => d.name === 'idle' || d.name === 'walk'));
				await anim.ensureLoaded('idle').catch(() => {});
				await anim.ensureLoaded('walk').catch(() => {});
				await anim.play('idle').catch(() => {});
			}
			player.remove(standIn);
			player.add(avatarModel);
		} catch (err) {
			log.warn('[portal] avatar unavailable, keeping the stand-in:', err?.message || err);
		} finally {
			onReady?.();
		}
	})();

	// ── input ─────────────────────────────────────────────────────────────────
	const keys = new Set();
	const onKeyDown = (e) => {
		if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
		keys.add(e.code);
		if (e.code === 'Enter' && nearDoor) activate();
		if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
	};
	const onKeyUp = (e) => keys.delete(e.code);
	window.addEventListener('keydown', onKeyDown);
	window.addEventListener('keyup', onKeyUp);

	let orbit = { yaw: world.spawn.yaw + Math.PI, pitch: 0.34, distance: 9.5 };
	let dragging = false;
	let lastPointer = { x: 0, y: 0 };
	const onPointerDown = (e) => {
		dragging = true;
		lastPointer = { x: e.clientX, y: e.clientY };
		canvas.setPointerCapture?.(e.pointerId);
	};
	const onPointerMove = (e) => {
		if (!dragging) return;
		orbit.yaw -= (e.clientX - lastPointer.x) * 0.006;
		orbit.pitch = clamp(orbit.pitch + (e.clientY - lastPointer.y) * 0.004, -0.15, 1.05);
		lastPointer = { x: e.clientX, y: e.clientY };
	};
	const onPointerUp = (e) => {
		dragging = false;
		canvas.releasePointerCapture?.(e.pointerId);
	};
	const onWheel = (e) => {
		orbit.distance = clamp(orbit.distance + e.deltaY * 0.01, 4.2, 26);
		e.preventDefault();
	};
	canvas.addEventListener('pointerdown', onPointerDown);
	window.addEventListener('pointermove', onPointerMove);
	window.addEventListener('pointerup', onPointerUp);
	canvas.addEventListener('wheel', onWheel, { passive: false });

	/** Touch and on-screen steering: set by the page's joystick, read by the loop. */
	const stick = { x: 0, y: 0 };

	// ── movement ──────────────────────────────────────────────────────────────
	const colliders = collidersFor(world);
	let nearDoor = null;
	const velocity = new THREE.Vector3();

	function inputVector() {
		let x = stick.x;
		let y = stick.y;
		if (keys.has('KeyW') || keys.has('ArrowUp')) y -= 1;
		if (keys.has('KeyS') || keys.has('ArrowDown')) y += 1;
		if (keys.has('KeyA') || keys.has('ArrowLeft')) x -= 1;
		if (keys.has('KeyD') || keys.has('ArrowRight')) x += 1;
		const len = Math.hypot(x, y);
		return len > 1 ? { x: x / len, y: y / len } : { x, y };
	}

	function resolveCollisions(next) {
		for (const c of colliders) {
			const dx = next.x - c.x;
			const dz = next.z - c.z;
			const dist = Math.hypot(dx, dz);
			const min = c.r + 0.45;
			if (dist < min && dist > 0.0001) {
				next.x = c.x + (dx / dist) * min;
				next.z = c.z + (dz / dist) * min;
			}
		}
		const edge = world.ground.radius - 1.5;
		const out = Math.hypot(next.x, next.z);
		if (out > edge) {
			next.x = (next.x / out) * edge;
			next.z = (next.z / out) * edge;
		}
		return next;
	}

	function activate() {
		if (nearDoor && onDoor) onDoor(nearDoor, 'activate');
	}

	const clock = new THREE.Clock();
	let raf = 0;
	let disposed = false;

	function frame() {
		if (disposed) return;
		raf = requestAnimationFrame(frame);
		const dt = Math.min(0.05, clock.getDelta());
		const input = inputVector();
		const running = keys.has('ShiftLeft') || keys.has('ShiftRight');
		const speed = running ? RUN_SPEED : WALK_SPEED;

		// Move relative to where the camera looks, which is what every player
		// expects and what makes a third-person world feel like a place.
		const forward = new THREE.Vector3(Math.sin(orbit.yaw), 0, Math.cos(orbit.yaw));
		const right = new THREE.Vector3(forward.z, 0, -forward.x);
		const wish = new THREE.Vector3()
			.addScaledVector(forward, -input.y)
			.addScaledVector(right, input.x);
		const wishLen = wish.length();
		if (wishLen > 0.001) wish.normalize();
		velocity.lerp(wish.multiplyScalar(wishLen > 0.001 ? speed : 0), 1 - Math.exp(-12 * dt));

		const next = resolveCollisions({
			x: player.position.x + velocity.x * dt,
			z: player.position.z + velocity.z * dt,
		});
		player.position.x = next.x;
		player.position.z = next.z;

		const wasMoving = moving;
		moving = velocity.lengthSq() > 0.35;
		if (moving) {
			const target = Math.atan2(velocity.x, velocity.z);
			let delta = target - player.rotation.y;
			delta = Math.atan2(Math.sin(delta), Math.cos(delta));
			player.rotation.y += delta * Math.min(1, TURN_RATE * dt);
		}
		if (moving !== wasMoving && avatarModel) {
			anim.crossfadeTo(moving ? 'walk' : 'idle', 0.22).catch(() => {});
		}
		if (avatarModel) anim.setSpeed(running && moving ? 1.55 : 1);
		anim.update?.(dt);

		// Camera: behind the player, easing, never inside a wall it can avoid.
		const camTarget = new THREE.Vector3(
			player.position.x - Math.sin(orbit.yaw) * orbit.distance * Math.cos(orbit.pitch),
			EYE_HEIGHT + orbit.distance * Math.sin(orbit.pitch) + 0.9,
			player.position.z - Math.cos(orbit.yaw) * orbit.distance * Math.cos(orbit.pitch),
		);
		camera.position.lerp(camTarget, 1 - Math.exp(-9 * dt));
		camera.lookAt(player.position.x, EYE_HEIGHT, player.position.z);

		// Nearest door in reach, reported once per change.
		let best = null;
		let bestDist = DOOR_REACH;
		for (const { door, material } of doorMeshes) {
			const dist = Math.hypot(door.x - player.position.x, door.z - player.position.z);
			material.emissiveIntensity = lerp(material.emissiveIntensity, dist < DOOR_REACH ? 1.9 : 0.7, 0.15);
			if (dist < bestDist) {
				best = door;
				bestDist = dist;
			}
		}
		if (best?.id !== nearDoor?.id) {
			nearDoor = best;
			onDoor?.(best, 'near');
		}

		titleLabel.position.y = world.plaza.monument.h + 1.4 + Math.sin(clock.elapsedTime * 1.4) * 0.08;
		renderer.render(scene, camera);
	}
	frame();

	function setSize(width, height) {
		renderer.setSize(width, height, false);
		camera.aspect = width / Math.max(1, height);
		camera.updateProjectionMatrix();
	}

	return {
		setSize,
		activate,
		get player() {
			return { x: player.position.x, z: player.position.z, yaw: player.rotation.y };
		},
		get nearDoor() {
			return nearDoor;
		},
		steer(x, y) {
			stick.x = clamp(x, -1, 1);
			stick.y = clamp(y, -1, 1);
		},
		dispose() {
			disposed = true;
			cancelAnimationFrame(raf);
			window.removeEventListener('keydown', onKeyDown);
			window.removeEventListener('keyup', onKeyUp);
			window.removeEventListener('pointermove', onPointerMove);
			window.removeEventListener('pointerup', onPointerUp);
			canvas.removeEventListener('pointerdown', onPointerDown);
			canvas.removeEventListener('wheel', onWheel);
			anim.detach?.();
			for (const d of disposables) d.dispose?.();
			renderer.dispose();
		},
	};
}
