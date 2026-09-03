/**
 * The live 3D home.
 *
 * Geometry comes from `scene-model.js`, which is pure and testable; this file
 * owns Three.js, the render loop and the transitions. The split matters: the
 * layout of a real house is asserted in a unit test with no GPU, and everything
 * here is about how a change LOOKS when it arrives.
 *
 * Three properties are non-negotiable, and each one has code that exists only
 * to hold it:
 *
 *   * A real light changing in Home Assistant reaches the screen inside one
 *     animation frame of the event arriving. `applyModel` retargets in place
 *     from a diff, so a burst of a hundred entities touches a hundred numbers
 *     and rebuilds nothing.
 *   * Nothing pops. Every visual quantity is a spring toward a target, damped
 *     framerate-independently, so a light comes up rather than snapping on.
 *   * The house never empties. A dropped socket desaturates the scene and shows
 *     its age; the last known state stays on screen, because a person watching
 *     their home should see it go grey, not watch it vanish.
 */

import {
	AmbientLight,
	BoxGeometry,
	CanvasTexture,
	Color,
	CylinderGeometry,
	ConeGeometry,
	Group,
	HemisphereLight,
	LinearFilter,
	Mesh,
	MeshBasicMaterial,
	MeshStandardMaterial,
	PerspectiveCamera,
	PlaneGeometry,
	PointLight,
	Raycaster,
	Scene,
	SphereGeometry,
	Sprite,
	SpriteMaterial,
	Vector2,
	Vector3,
	WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createFrameGovernor, FPS_ACTIVE, FPS_IDLE, FPS_SAVER, getPowerSaver, onPowerSaverChange, trackWindowFocus } from '../shared/frame-governor.js';
import { diffScene } from './scene-model.js';

/** Real point lights cost shader time per fragment; emissive glow does not. */
const MAX_ROOM_LIGHTS = 12;

/** Damping half-life in seconds. Fast enough to feel instant, slow enough to read. */
const EASE = 0.09;

const GREY = new Color(0x6a7080);
const WARM = new Color(0xff8a3d);
const COOL = new Color(0x4fc3f7);

const SURFACE = 0x11131c;
const WALL = 0x2b3042;
const SECURE = 0x2fbf71;
const OPEN = 0xe0a33a;
const ALERT = 0xe05a4a;

/**
 * Geometry is shared across every object of a kind: one BoxGeometry serves
 * every wall plate in the house. Materials are per object, because colour is
 * per object, and they are disposed with the object.
 */
function sharedGeometry() {
	return {
		slab: new BoxGeometry(1, 1, 1),
		panel: new BoxGeometry(1, 1, 1),
		bulb: new SphereGeometry(0.15, 16, 12),
		blade: new BoxGeometry(0.62, 0.02, 0.1),
		puck: new CylinderGeometry(0.19, 0.19, 0.09, 18),
		post: new CylinderGeometry(0.07, 0.07, 0.86, 10),
		cone: new ConeGeometry(0.11, 0.24, 10),
		ring: new CylinderGeometry(0.17, 0.17, 0.05, 20),
		plane: new PlaneGeometry(1, 1),
	};
}

/** The four waist-high walls of a room, as one geometry. */
function roomShell(w, d) {
	const h = 0.92;
	const parts = [];
	for (const [sx, sz, px, pz] of [
		[w, 0.06, 0, -d / 2],
		[w, 0.06, 0, d / 2],
		[0.06, d, -w / 2, 0],
		[0.06, d, w / 2, 0],
	]) {
		const box = new BoxGeometry(sx, h, sz);
		box.translate(px, h / 2, pz);
		parts.push(box);
	}
	const merged = mergeGeometries(parts, false);
	for (const part of parts) part.dispose();
	return merged;
}

/** The "this device is not answering" marker, built only when one is. */
function addMissingMarker(node) {
	const marker = new Sprite(new SpriteMaterial({ color: 0xe05a4a, transparent: true, opacity: 0, depthWrite: false, depthTest: false }));
	marker.scale.set(0.34, 0.34, 1);
	marker.position.y = 0.42;
	node.add(marker);
	return marker;
}

/**
 * @param {HTMLElement} container
 * @param {object} [options]
 * @param {(entityId: string|null, object: object|null) => void} [options.onSelect]
 * @param {(roomId: string) => void} [options.onFocusRoom]
 * @param {() => void} [options.onFirstFrame]
 */
export function createHomeScene(container, options = {}) {
	const renderer = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
	renderer.setClearColor(0x000000, 0);
	// A phone at devicePixelRatio 3 renders nine times the fragments of a
	// desktop for a scene nobody looks at that closely. 2 is the point past
	// which the extra pixels stop being visible and start costing frames.
	renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
	container.appendChild(renderer.domElement);
	renderer.domElement.setAttribute('aria-hidden', 'true');
	renderer.domElement.style.display = 'block';
	renderer.domElement.style.width = '100%';
	renderer.domElement.style.height = '100%';
	renderer.domElement.style.touchAction = 'none';

	const scene = new Scene();
	const camera = new PerspectiveCamera(46, 1, 0.1, 400);
	const controls = new OrbitControls(camera, renderer.domElement);
	controls.enableDamping = true;
	controls.dampingFactor = 0.08;
	controls.maxPolarAngle = Math.PI * 0.49;
	controls.minDistance = 4;
	controls.maxDistance = 140;

	scene.add(new AmbientLight(0xffffff, 0.16));
	const sky = new HemisphereLight(0x8fa6ff, 0x0b0d14, 0.34);
	scene.add(sky);

	const geo = sharedGeometry();
	const world = new Group();
	scene.add(world);

	/** @type {Map<string, object>} entityId to its live object record */
	const objects = new Map();
	/** @type {Map<string, object>} roomId to its live room record */
	const rooms = new Map();
	const spare = { color: new Color(), target: new Color(), v: new Vector3(), toward: new Vector3(), forward: new Vector3() };

	let model = null;
	let stale = false;
	let staleAmount = 0;
	let acting = null;
	let actingUntil = 0;
	let selected = null;
	let agent = null;
	let disposed = false;
	let firstFrameSent = false;
	let frames = 0;
	let fpsWindowStart = 0;
	let fps = 0;
	// Split on purpose. Under a software rasterizer (headless CI, a locked-down
	// browser) `render` dominates and says nothing about the scene's own cost, so
	// the update work is timed separately and both numbers are reported.
	let updateMs = 0;
	let renderMs = 0;

	const raycaster = new Raycaster();
	const pointer = new Vector2();
	const governor = createFrameGovernor();
	const focus = trackWindowFocus();
	let powerSaver = getPowerSaver();
	const stopPowerSaver = onPowerSaverChange((on) => {
		powerSaver = on;
	});

	// ── structure ─────────────────────────────────────────────────────────────

	/** Rebuild the house. Called when the set of rooms or entities changes. */
	function setModel(next) {
		const structural = !model || structureKey(model) !== structureKey(next);
		if (!structural) return applyModel(next);
		clearWorld();
		model = next;
		for (const room of next.rooms) rooms.set(room.id, buildRoom(room));
		frameCamera(next);
		placeAgent(next.agent);
		applyModel(next, { snap: true });
	}

	/**
	 * Retarget every changed value in place. This is the hot path: it must not
	 * allocate a mesh, a material or an array proportional to the update.
	 */
	function applyModel(next, { snap = false } = {}) {
		const previous = model;
		model = next;
		const delta = previous ? diffScene(previous, next) : null;

		for (const room of next.rooms) {
			const record = rooms.get(room.id);
			if (!record) continue;
			record.source = room;
			record.targetIntensity = room.light.intensity;
			record.targetColor.set(room.light.hex);
			record.targetSecure = room.security ? (room.security.secure ? 0 : 1) : 0;
			if (record.labelText !== labelFor(room)) {
				record.labelText = labelFor(room);
				paintLabel(record);
			}
			if (snap) {
				record.intensity = record.targetIntensity;
				record.color.copy(record.targetColor);
				record.secure = record.targetSecure;
				commitRoom(record);
			}
		}

		const touched = delta ? [...delta.changed, ...delta.added] : allObjects(next);
		for (const object of touched) {
			const record = objects.get(object.entityId);
			if (!record) continue;
			record.source = object;
			record.targetActivity = object.activity;
			record.targetAvailable = object.available ? 1 : 0;
			if (snap) {
				record.activity = record.targetActivity;
				record.availability = record.targetAvailable;
				commitObject(record);
			}
		}
	}

	/** Only these change the geometry; everything else is a value on a mesh. */
	function structureKey(m) {
		return m.rooms.map((r) => `${r.id}:${r.x},${r.y},${r.z}:${r.objects.map((o) => o.entityId).join(',')}`).join('|');
	}

	function allObjects(m) {
		const out = [];
		for (const room of m.rooms) out.push(...room.objects);
		return out;
	}

	function buildRoom(room) {
		const group = new Group();
		group.position.set(room.x, room.y, room.z);
		world.add(group);

		const floorMat = new MeshStandardMaterial({ color: SURFACE, roughness: 0.92, metalness: 0.02, emissive: new Color(0x000000) });
		const floor = new Mesh(geo.slab, floorMat);
		floor.scale.set(room.w, 0.12, room.d);
		floor.position.y = -0.06;
		floor.userData.roomId = room.id;
		group.add(floor);

		// Waist-high walls, translucent. Full-height walls would hide the room's
		// contents from every angle an orbiting camera can reach, and a dollhouse
		// you cannot see into is a box.
		//
		// All four are ONE geometry. As separate meshes they were four draw calls
		// per room, which is four hundred in a hundred-room house for a shape that
		// never moves relative to its room.
		const wallMat = new MeshStandardMaterial({ color: WALL, roughness: 0.75, metalness: 0.05, transparent: true, opacity: 0.34 });
		const wallGeo = roomShell(room.w, room.d);
		const walls = new Mesh(wallGeo, wallMat);
		group.add(walls);

		// The security tell: a line around the room's foot that goes amber the
		// moment something in it is unlocked or open. Readable from across the
		// room without reading a single label, which is the whole point.
		const edgeMat = new MeshBasicMaterial({ color: SECURE, transparent: true, opacity: 0 });
		const edge = new Mesh(geo.slab, edgeMat);
		edge.scale.set(room.w + 0.1, 0.05, room.d + 0.1);
		edge.position.y = 0.02;
		group.add(edge);

		const light = new PointLight(0xffffff, 0, room.w * 2.6, 1.7);
		light.position.set(0, room.h * 0.72, 0);
		const usesLight = rooms.size < MAX_ROOM_LIGHTS;
		if (usesLight) group.add(light);

		const label = makeLabel();
		label.position.set(0, room.h + 0.5, 0);
		group.add(label);

		const record = {
			id: room.id,
			source: room,
			group,
			floorMat,
			wallMat,
			edgeMat,
			light: usesLight ? light : null,
			label,
			wallGeo,
			labelText: '',
			color: new Color(room.light.hex),
			targetColor: new Color(room.light.hex),
			intensity: 0,
			targetIntensity: room.light.intensity,
			secure: 0,
			targetSecure: 0,
			highlight: 0,
		};
		record.labelText = labelFor(room);
		paintLabel(record);

		for (const object of room.objects) objects.set(object.entityId, buildObject(object, group, room));
		return record;
	}

	function buildObject(object, group, room) {
		const node = new Group();
		node.position.set(object.x, object.y, object.z);
		node.rotation.y = object.rotation;
		group.add(node);

		const material = new MeshStandardMaterial({
			color: 0x6f7690,
			roughness: 0.55,
			metalness: 0.15,
			emissive: new Color(0x000000),
			transparent: true,
			opacity: 1,
		});
		const record = {
			entityId: object.entityId,
			roomId: room.id,
			source: object,
			node,
			material,
			parts: [],
			activity: 0,
			targetActivity: object.activity,
			availability: 1,
			targetAvailable: object.available ? 1 : 0,
			select: 0,
		};

		switch (object.kind) {
			case 'lamp': {
				const bulb = new Mesh(geo.bulb, material);
				bulb.userData.entityId = object.entityId;
				node.add(bulb);
				const stem = new Mesh(geo.post, new MeshStandardMaterial({ color: 0x3a3f52, roughness: 0.8 }));
				stem.scale.y = 0.42;
				stem.position.y = 0.33;
				node.add(stem);
				record.parts.push(stem.material);
				const halo = new Sprite(new SpriteMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false }));
				halo.scale.set(2.1, 2.1, 1);
				node.add(halo);
				record.halo = halo;
				break;
			}
			case 'fan': {
				const hub = new Mesh(geo.puck, material);
				hub.scale.set(0.6, 0.6, 0.6);
				hub.userData.entityId = object.entityId;
				node.add(hub);
				const rotor = new Group();
				for (let i = 0; i < 3; i += 1) {
					const blade = new Mesh(geo.blade, material);
					blade.rotation.y = (i * Math.PI * 2) / 3;
					blade.position.y = -0.04;
					rotor.add(blade);
				}
				node.add(rotor);
				record.rotor = rotor;
				break;
			}
			case 'lock': {
				const body = new Mesh(geo.panel, material);
				body.scale.set(0.2, 0.3, 0.1);
				body.userData.entityId = object.entityId;
				node.add(body);
				const shackle = new Mesh(geo.ring, material);
				shackle.scale.set(0.62, 0.9, 0.62);
				shackle.position.y = 0.2;
				node.add(shackle);
				record.shackle = shackle;
				break;
			}
			case 'door':
			case 'window': {
				const frame = new Mesh(geo.panel, new MeshStandardMaterial({ color: 0x394059, roughness: 0.8, transparent: true, opacity: 0.6 }));
				const wide = object.kind === 'door' ? 1.05 : 0.92;
				frame.scale.set(wide, object.kind === 'door' ? 1.9 : 1.1, 0.06);
				frame.position.y = object.kind === 'door' ? 0.35 : 0.1;
				node.add(frame);
				record.parts.push(frame.material);
				const leaf = new Mesh(geo.panel, material);
				leaf.scale.set(wide * 0.94, (object.kind === 'door' ? 1.9 : 1.1) * 0.94, 0.04);
				leaf.position.set(0, frame.position.y, 0.03);
				leaf.userData.entityId = object.entityId;
				node.add(leaf);
				record.leaf = leaf;
				record.leafSpan = wide * 0.94;
				record.leafHeight = (object.kind === 'door' ? 1.9 : 1.1) * 0.94;
				record.leafY = frame.position.y;
				break;
			}
			case 'thermostat': {
				const post = new Mesh(geo.post, new MeshStandardMaterial({ color: 0x3a3f52, roughness: 0.8 }));
				post.scale.y = 0.72;
				post.position.y = 0.31;
				node.add(post);
				record.parts.push(post.material);
				const dial = new Mesh(geo.ring, material);
				dial.rotation.x = Math.PI / 2;
				dial.position.y = 0.68;
				dial.scale.set(1.1, 1, 1.1);
				dial.userData.entityId = object.entityId;
				node.add(dial);
				break;
			}
			case 'screen': {
				const panel = new Mesh(geo.panel, material);
				panel.scale.set(0.92, 0.52, 0.05);
				panel.userData.entityId = object.entityId;
				node.add(panel);
				break;
			}
			case 'camera': {
				const lens = new Mesh(geo.cone, material);
				lens.rotation.x = Math.PI / 2;
				lens.userData.entityId = object.entityId;
				node.add(lens);
				break;
			}
			case 'alarm': {
				const box = new Mesh(geo.panel, material);
				box.scale.set(0.3, 0.42, 0.08);
				box.userData.entityId = object.entityId;
				node.add(box);
				break;
			}
			case 'puck': {
				const disc = new Mesh(geo.puck, material);
				disc.scale.set(1.5, 1, 1.5);
				disc.position.y = 0.05;
				disc.userData.entityId = object.entityId;
				node.add(disc);
				break;
			}
			default: {
				const plate = new Mesh(geo.panel, material);
				plate.scale.set(0.22, 0.22, 0.05);
				plate.userData.entityId = object.entityId;
				node.add(plate);
			}
		}

		commitObject(record);
		return record;
	}

	// ── per-frame values ──────────────────────────────────────────────────────

	function commitRoom(record) {
		const room = record.source;
		const dim = 1 - staleAmount * 0.72;
		spare.color.copy(record.color);
		if (staleAmount > 0) spare.color.lerp(GREY, staleAmount * 0.85);

		if (record.light) {
			record.light.color.copy(spare.color);
			record.light.intensity = record.intensity * 3.4 * dim;
		}
		record.floorMat.emissive.copy(spare.color).multiplyScalar(record.intensity * 0.42 * dim);
		record.floorMat.color.setHex(SURFACE).lerp(spare.color, Math.min(0.22, record.intensity * 0.2));
		record.wallMat.opacity = 0.24 + record.intensity * 0.12 + record.highlight * 0.24;

		const alarmed = record.secure;
		record.edgeMat.color.setHex(alarmed > 0.5 ? OPEN : SECURE);
		record.edgeMat.opacity = (room.security ? 0.18 + alarmed * 0.5 : 0) + record.highlight * 0.4;
		record.label.material.opacity = 0.92 * (1 - staleAmount * 0.4);
	}

	function commitObject(record) {
		const object = record.source;
		const room = rooms.get(record.roomId);
		const on = record.activity;
		const available = record.availability;
		const dim = 1 - staleAmount * 0.7;

		spare.target.setHex(0x6f7690);
		let emissiveStrength = 0;

		switch (object.kind) {
			case 'lamp': {
				const roomColor = room ? room.color : spare.color.setHex(0xffe0b0);
				spare.target.copy(roomColor);
				emissiveStrength = on * 1.5;
				if (record.halo) record.halo.material.opacity = on * 0.4 * dim * available;
				if (record.halo) record.halo.material.color.copy(roomColor);
				break;
			}
			case 'lock': {
				spare.target.setHex(on > 0.5 ? ALERT : SECURE);
				emissiveStrength = on > 0.5 ? 0.85 : 0.22;
				if (record.shackle) record.shackle.position.y = 0.2 + on * 0.12;
				break;
			}
			case 'door':
			case 'window': {
				spare.target.setHex(on > 0.02 ? OPEN : 0x5a6178);
				emissiveStrength = on * 0.5;
				if (record.leaf) {
					// Openness is a real position: a cover at 40% is 40% open, not a
					// colour change standing in for one.
					record.leaf.scale.x = Math.max(0.02, record.leafSpan * (1 - on * 0.94));
					record.leaf.position.x = -(record.leafSpan * on * 0.47);
				}
				break;
			}
			case 'thermostat': {
				const tint = room?.source?.climate?.tint ?? 0;
				spare.target.setHex(0x4f88d8).lerp(WARM, Math.max(0, tint)).lerp(COOL, Math.max(0, -tint));
				emissiveStrength = on * 0.7;
				break;
			}
			case 'screen':
				spare.target.setHex(0x8fa6ff);
				emissiveStrength = on * 1.15;
				break;
			case 'alarm':
				spare.target.setHex(on > 0.5 ? ALERT : 0x5a6178);
				emissiveStrength = on * 0.9;
				break;
			case 'camera':
				spare.target.setHex(0x7c5cff);
				emissiveStrength = 0.3;
				break;
			case 'fan':
				spare.target.setHex(on > 0.5 ? 0x8fa6ff : 0x6f7690);
				emissiveStrength = on * 0.4;
				break;
			default:
				spare.target.setHex(on > 0.5 ? 0x8fa6ff : 0x6f7690);
				emissiveStrength = on * 0.6;
		}

		if (staleAmount > 0) spare.target.lerp(GREY, staleAmount * 0.85);
		record.material.color.copy(spare.target);
		record.material.emissive.copy(spare.target).multiplyScalar(emissiveStrength * dim * available);
		// Unreachable reads as a ghost of itself plus a live marker, so "the lamp
		// is off" and "the lamp is gone" can never look the same.
		record.material.opacity = 0.24 + available * 0.76;
		for (const part of record.parts) part.opacity = 0.3 + available * 0.7;
		// A device Home Assistant cannot reach is drawn, never omitted: a thing
		// that vanished from a house is information, and hiding it is how a scene
		// tells a comfortable lie. The marker is built the first time a device
		// actually goes missing, so a healthy house pays nothing for it.
		if (available < 0.999 && !record.missing) record.missing = addMissingMarker(record.node);
		if (record.missing) record.missing.material.opacity = (1 - available) * 0.9;
		record.node.scale.setScalar(1 + record.select * 0.18);
	}

	// ── loop ──────────────────────────────────────────────────────────────────

	function damp(current, target, dt) {
		// Framerate-independent exponential approach: the same visual speed at
		// 30 fps and at 144.
		return current + (target - current) * (1 - Math.exp(-dt / EASE));
	}

	let last = 0;
	let raf = 0;
	let staleMoving = false;
	function tick(now) {
		if (disposed) return;
		raf = requestAnimationFrame(tick);
		// A wall display is the real deployment: an unfocused tab and a
		// power-saver phone both step down to 30, and the governor keeps the
		// average honest on a 120Hz panel instead of quantizing it to 40.
		const cap = powerSaver ? FPS_SAVER : focus.focused ? FPS_ACTIVE : FPS_IDLE;
		if (!governor.shouldRun(now, cap)) return;
		const dt = last ? Math.min(0.1, (now - last) / 1000) : 0.016;
		last = now;

		const updateStart = performance.now();
		const staleTarget = stale ? 1 : 0;
		staleMoving = Math.abs(staleAmount - staleTarget) > 0.002;
		staleAmount = damp(staleAmount, staleTarget, dt);
		if (acting && now > actingUntil) acting = null;

		for (const record of rooms.values()) {
			const wasHighlight = record.highlight;
			record.highlight = damp(record.highlight, acting?.roomId === record.id ? 1 : 0, dt);
			const before = record.intensity;
			record.intensity = damp(record.intensity, record.targetIntensity, dt);
			record.secure = damp(record.secure, record.targetSecure, dt);
			const moved = Math.abs(before - record.intensity) > 0.0005 || Math.abs(wasHighlight - record.highlight) > 0.001;
			if (moved || !record.color.equals(record.targetColor) || staleMoving) {
				record.color.lerp(record.targetColor, 1 - Math.exp(-dt / EASE));
				commitRoom(record);
			}
		}

		for (const record of objects.values()) {
			const before = record.activity;
			record.activity = damp(record.activity, record.targetActivity, dt);
			record.availability = damp(record.availability, record.targetAvailable, dt);
			const wanted = selected === record.entityId ? 1 : 0;
			const beforeSelect = record.select;
			record.select = damp(record.select, wanted, dt);
			if (record.rotor && record.activity > 0.02) record.rotor.rotation.y += dt * (2 + record.activity * 16);
			if (
				Math.abs(before - record.activity) > 0.0008 ||
				Math.abs(beforeSelect - record.select) > 0.002 ||
				Math.abs(record.availability - record.targetAvailable) > 0.002 ||
				staleMoving
			) {
				commitObject(record);
			}
		}

		if (agent) agent.update(dt, now);
		controls.update();
		const renderStart = performance.now();
		updateMs = renderStart - updateStart;
		renderer.render(scene, camera);
		renderMs = performance.now() - renderStart;

		frames += 1;
		if (!fpsWindowStart) fpsWindowStart = now;
		if (now - fpsWindowStart >= 1000) {
			fps = Math.round((frames * 1000) / (now - fpsWindowStart));
			frames = 0;
			fpsWindowStart = now;
		}
		if (!firstFrameSent) {
			firstFrameSent = true;
			options.onFirstFrame?.();
		}
	}

	// ── camera, agent, labels, picking ────────────────────────────────────────

	function frameCamera(m) {
		const b = m.bounds;
		const cx = (b.minX + b.maxX) / 2;
		const cz = (b.minZ + b.maxZ) / 2;
		const span = Math.max(b.width, b.depth, 8);
		controls.target.set(cx, Math.min(b.maxY * 0.35, 3), cz);
		camera.position.set(cx + span * 0.62, span * 0.66 + 4, cz + span * 0.86);
		camera.updateProjectionMatrix();
		controls.update();
	}

	/**
	 * Move the camera onto a room.
	 *
	 * Deliberately silent: this is the ANSWER to a focus request, not a new one.
	 * Firing `onFocusRoom` from here meant the page's own handler called back
	 * into it and the two recursed until the stack ran out, which is exactly what
	 * clicking a room in the rail did.
	 */
	function focusRoom(roomId) {
		const record = rooms.get(roomId);
		if (!record || !model) return;
		const room = record.source;
		controls.target.set(room.x, room.y + 1.1, room.z);
		const distance = Math.max(room.w, room.d) * 1.9;
		camera.position.set(room.x + distance * 0.55, room.y + distance * 0.72, room.z + distance);
		controls.update();
	}

	function makeLabel() {
		const canvas = document.createElement('canvas');
		canvas.width = 512;
		canvas.height = 128;
		const texture = new CanvasTexture(canvas);
		texture.minFilter = LinearFilter;
		const sprite = new Sprite(new SpriteMaterial({ map: texture, transparent: true, depthWrite: false, depthTest: false }));
		sprite.scale.set(4.4, 1.1, 1);
		sprite.userData.canvas = canvas;
		sprite.userData.texture = texture;
		return sprite;
	}

	function labelFor(room) {
		const bits = [room.name];
		if (room.climate) bits.push(room.climate.label);
		if (room.light.total) bits.push(`${room.light.count}/${room.light.total} lit`);
		return bits.join('   ');
	}

	function paintLabel(record) {
		const canvas = record.label.userData.canvas;
		const ctx = canvas.getContext('2d');
		ctx.clearRect(0, 0, canvas.width, canvas.height);
		ctx.font = '600 46px "Inter", system-ui, sans-serif';
		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';
		ctx.fillStyle = 'rgba(8, 9, 14, 0.72)';
		const width = Math.min(canvas.width - 8, ctx.measureText(record.labelText).width + 56);
		roundRect(ctx, (canvas.width - width) / 2, 26, width, 76, 22);
		ctx.fill();
		ctx.fillStyle = '#eef1ff';
		ctx.fillText(record.labelText, canvas.width / 2, 64);
		record.label.userData.texture.needsUpdate = true;
	}

	function roundRect(ctx, x, y, w, h, r) {
		ctx.beginPath();
		ctx.moveTo(x + r, y);
		ctx.arcTo(x + w, y, x + w, y + h, r);
		ctx.arcTo(x + w, y + h, x, y + h, r);
		ctx.arcTo(x, y + h, x, y, r);
		ctx.arcTo(x, y, x + w, y, r);
		ctx.closePath();
	}

	function placeAgent(stand) {
		if (!stand) return;
		if (!agent) {
			agent = createAgentBody(scene, renderer);
		}
		agent.moveTo(stand.x, stand.y, stand.z, stand.facing);
	}

	function onPointerDown(event) {
		const rect = renderer.domElement.getBoundingClientRect();
		pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
		pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
		raycaster.setFromCamera(pointer, camera);
		const hits = raycaster.intersectObjects(world.children, true);
		for (const hit of hits) {
			const entityId = hit.object.userData.entityId;
			if (entityId) {
				selected = entityId;
				options.onSelect?.(entityId, objects.get(entityId)?.source || null);
				return;
			}
			const roomId = hit.object.userData.roomId;
			if (roomId) {
				selected = null;
				options.onSelect?.(null, null);
				options.onFocusRoom?.(roomId);
				return;
			}
		}
		selected = null;
		options.onSelect?.(null, null);
	}
	renderer.domElement.addEventListener('pointerdown', onPointerDown);

	function resize() {
		const w = container.clientWidth || 1;
		const h = container.clientHeight || 1;
		renderer.setSize(w, h, false);
		camera.aspect = w / h;
		camera.updateProjectionMatrix();
	}
	const observer = new ResizeObserver(resize);
	observer.observe(container);
	resize();
	raf = requestAnimationFrame(tick);

	function clearWorld() {
		for (const record of objects.values()) {
			record.material.dispose();
			for (const part of record.parts) part.dispose();
			record.halo?.material.dispose();
			record.missing?.material.dispose();
		}
		objects.clear();
		for (const record of rooms.values()) {
			record.floorMat.dispose();
			record.wallMat.dispose();
			record.wallGeo.dispose();
			record.edgeMat.dispose();
			record.label.material.map?.dispose();
			record.label.material.dispose();
		}
		rooms.clear();
		world.clear();
	}

	return {
		setModel,
		focusRoom,
		select(entityId) {
			selected = entityId;
		},
		setStale(next) {
			stale = Boolean(next);
		},
		/** Highlight the room an action is happening in, for a short beat. */
		setActing(next, holdMs = 2600) {
			acting = next;
			actingUntil = performance.now() + holdMs;
			if (next?.roomId) agent?.moveToRoom(rooms.get(next.roomId)?.source);
			agent?.act();
		},
		/**
		 * Where an entity currently sits on screen, so the confirmation can be
		 * pinned to the door it would open rather than to a corner of the page.
		 * @returns {{ x: number, y: number, visible: boolean }|null}
		 */
		project(entityId) {
			const record = objects.get(entityId);
			if (!record) return null;
			record.node.getWorldPosition(spare.v);
			spare.v.y += 0.5;
			spare.toward.copy(spare.v).sub(camera.position);
			camera.getWorldDirection(spare.forward);
			const behind = spare.toward.dot(spare.forward) <= 0;
			spare.v.project(camera);
			const rect = renderer.domElement.getBoundingClientRect();
			return {
				x: ((spare.v.x + 1) / 2) * rect.width,
				y: ((1 - spare.v.y) / 2) * rect.height,
				visible: !behind && Math.abs(spare.v.x) <= 1.05 && Math.abs(spare.v.y) <= 1.05,
			};
		},
		stats() {
			return {
				fps,
				updateMs: Math.round(updateMs * 100) / 100,
				renderMs: Math.round(renderMs * 100) / 100,
				objects: objects.size,
				rooms: rooms.size,
				drawCalls: renderer.info.render.calls,
				geometries: renderer.info.memory.geometries,
				textures: renderer.info.memory.textures,
			};
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			cancelAnimationFrame(raf);
			stopPowerSaver();
			observer.disconnect();
			renderer.domElement.removeEventListener('pointerdown', onPointerDown);
			clearWorld();
			agent?.dispose();
			for (const value of Object.values(geo)) value.dispose();
			controls.dispose();
			renderer.dispose();
			renderer.domElement.remove();
		},
	};
}

/**
 * The agent's body, standing in the house.
 *
 * The platform's default rigged body driven by the canonical clip library, the
 * same pair `/walk`, `/play` and Docs World use, so a rig that animates
 * anywhere on three.ws animates here. A rig that cannot be skeleton-driven, or
 * a load that fails outright, falls back to a lit capsule: the house stays
 * fully usable, it just loses the face.
 */
function createAgentBody(scene, renderer) {
	const root = new Group();
	scene.add(root);
	let anim = null;
	let disposed = false;
	const target = new Vector3();
	let bob = 0;
	let gesture = 0;
	let placeholder = null;

	const glow = new PointLight(0x8fa6ff, 1.4, 6, 2);
	glow.position.y = 1.2;
	root.add(glow);

	placeholder = new Mesh(
		new CylinderGeometry(0.26, 0.3, 1.5, 12),
		new MeshStandardMaterial({ color: 0x2a2444, roughness: 0.5, metalness: 0.3, emissive: 0x7c5cff, emissiveIntensity: 0.45 }),
	);
	placeholder.position.y = 0.75;
	root.add(placeholder);

	(async () => {
		try {
			const [{ gltfLoader }, { AnimationManager }] = await Promise.all([
				import('../loaders/gltf.js'),
				import('../animation-manager.js'),
			]);
			const gltf = await new Promise((resolve, reject) => gltfLoader(renderer).load('/avatars/default.glb', resolve, undefined, reject));
			if (disposed) return;
			const model = gltf.scene;
			model.traverse((node) => {
				if (node.isMesh) node.frustumCulled = false;
			});
			root.add(model);
			placeholder.visible = false;
			anim = new AnimationManager();
			anim.attach(model, { avatarUrl: '/avatars/default.glb' });
			anim.relaxUndrivenArms?.();
			const defs = await fetch('/animations/manifest.json').then((r) => (r.ok ? r.json() : []));
			if (Array.isArray(defs) && defs.length && anim.supportsCanonicalClips?.() !== false) {
				anim.setAnimationDefs(defs);
				if (await anim.ensureLoaded('idle')) await anim.crossfadeTo('idle', 0);
			}
		} catch {
			// The capsule is already standing; the house does not need the body.
		}
	})();

	return {
		moveTo(x, y, z, facing) {
			target.set(x, y, z);
			root.position.copy(target);
			root.rotation.y = facing;
		},
		moveToRoom(room) {
			if (!room) return;
			this.moveTo(room.x - room.w * 0.22, room.y, room.z + room.d * 0.2, 0);
		},
		/** A short lift as the agent performs an action, so it is clearly the actor. */
		act() {
			gesture = 1;
		},
		update(dt) {
			bob += dt;
			gesture = Math.max(0, gesture - dt * 0.8);
			root.position.y = target.y + Math.sin(bob * 1.6) * 0.012 + gesture * 0.14;
			glow.intensity = 1.1 + Math.sin(bob * 2.2) * 0.2 + gesture * 1.6;
			anim?.update?.(dt);
		},
		dispose() {
			disposed = true;
			anim?.dispose?.();
			scene.remove(root);
			placeholder?.geometry.dispose();
			placeholder?.material.dispose();
		},
	};
}
