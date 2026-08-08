// war-world.js — the 3D arena a Coin Wars battle is fought in.
//
// ClashRoom (multiplayer/src/rooms/ClashRoom.js) is fully authoritative: it owns
// positions, targeting, damage, respawns, the round clock and the score. This
// module is the eyes and hands for that room and nothing more — it renders the
// arena and every fighter in it, walks the local fighter around (sending intent,
// never claiming an outcome), and plays the feedback the server broadcasts.
//
// Deliberately lean. Avatars, the canonical clip library and the retargeting all
// come from the platform's existing animation system via ArenaAvatar, the same
// class the trading arena uses, so any humanoid GLB a player owns fights with
// the same idle/walk/celebrate set instead of T-posing.

import {
	Scene, PerspectiveCamera, WebGLRenderer, Group, Vector3,
	AmbientLight, DirectionalLight, HemisphereLight,
	Color, Fog, MathUtils,
	PlaneGeometry, CircleGeometry, RingGeometry, BoxGeometry, CylinderGeometry, SphereGeometry,
	MeshStandardMaterial, MeshBasicMaterial, Mesh, DoubleSide,
	SRGBColorSpace, ACESFilmicToneMapping, AdditiveBlending,
} from 'three';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import { AnimationManager } from '../animation-manager.js';
import { gltfLoader } from '../loaders/gltf.js';
import { ArenaAvatar } from './arena-world.js';

const MANIFEST_URL = '/animations/manifest.json';

// The clip set a battle needs. Same names the trading arena pulls, so the shared
// library is warm and nothing extra is fetched for a player who came from there.
const CLIPS = {
	idle: 'idle',
	walk: 'walk',
	run: 'walk',
	win: 'celebrate',
	loss: 'defeated',
};
const CORE_CLIPS = ['idle', 'walk', 'celebrate', 'defeated'];

// Must match ClashRoom: the server clamps to this square and spawns each faction
// at ±SPAWN_OFFSET on z. Rendering a floor smaller than the play area would let a
// fighter walk off the visible world while still being legal.
export const ARENA_BOUND = 60;
const SPAWN_OFFSET = 22;

// Local walk speed. Kept under the server's per-move teleport clamp (3 m) at the
// send rate below with plenty of headroom, so a legitimate sprint is never
// mistaken for a teleport and pinned.
const WALK_SPEED = 5.2;

const COL = {
	bg: 0x05060a,
	floor: 0x0b0d14,
	a: 0x7fd8ff,
	b: 0xff9d7a,
	line: 0x2a2e3a,
};

export class WarWorld {
	constructor(canvas) {
		this.canvas = canvas;
		this.fighters = new Map();  // sessionId -> ArenaAvatar (+ .target for lerp)
		this.localId = '';
		this.factions = { a: '', b: '' };
		this._templates = new Map();
		this._lib = null;
		this._loopByName = new Map();
		this._defs = [];
		this._fx = [];
		this._running = false;
		this._raf = 0;
		this._last = 0;
		this._onLabels = null;

		this._initRenderer();
		// The shared GLTF loader is keyed on the renderer (it probes KTX2 support
		// from it), so it can only be built once the context exists.
		this.loader = gltfLoader(this.renderer);
		this._initScene();
		this._initControls();
	}

	_initRenderer() {
		this.renderer = new WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
		this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
		this.renderer.outputColorSpace = SRGBColorSpace;
		this.renderer.toneMapping = ACESFilmicToneMapping;
		this.renderer.toneMappingExposure = 1.05;
		this._onResize = () => this._resize();
		addEventListener('resize', this._onResize);
		this._resize();
	}

	_initScene() {
		this.scene = new Scene();
		this.scene.background = new Color(COL.bg);
		this.scene.fog = new Fog(COL.bg, 60, 190);
		this.camera = new PerspectiveCamera(58, this._aspect(), 0.1, 500);

		this.scene.add(new HemisphereLight(0x9fc6ff, 0x0a0a10, 0.65));
		this.scene.add(new AmbientLight(0xffffff, 0.25));
		const key = new DirectionalLight(0xffffff, 1.15);
		key.position.set(24, 44, 18);
		this.scene.add(key);

		this._buildArena();
	}

	// The arena: one flat field, a hard centre line, and each community's half
	// tinted with its own colour so "which end is mine" reads instantly from any
	// camera angle. Faction A defends −z, faction B defends +z, matching where
	// ClashRoom actually spawns them.
	_buildArena() {
		const floor = new Mesh(
			new PlaneGeometry(ARENA_BOUND * 2, ARENA_BOUND * 2),
			new MeshStandardMaterial({ color: COL.floor, roughness: 0.95, metalness: 0.05 }),
		);
		floor.rotation.x = -Math.PI / 2;
		this.scene.add(floor);

		this._endZones = {};
		for (const [side, sign, color] of [['a', -1, COL.a], ['b', 1, COL.b]]) {
			const zone = new Mesh(
				new CircleGeometry(16, 48),
				new MeshBasicMaterial({ color, transparent: true, opacity: 0.07, side: DoubleSide }),
			);
			zone.rotation.x = -Math.PI / 2;
			zone.position.set(0, 0.02, sign * SPAWN_OFFSET);
			this.scene.add(zone);
			const ring = new Mesh(
				new RingGeometry(15.6, 16, 64),
				new MeshBasicMaterial({ color, transparent: true, opacity: 0.3, side: DoubleSide }),
			);
			ring.rotation.x = -Math.PI / 2;
			ring.position.set(0, 0.03, sign * SPAWN_OFFSET);
			this.scene.add(ring);
			this._endZones[side] = { zone, ring };
		}

		const centre = new Mesh(
			new PlaneGeometry(ARENA_BOUND * 2, 0.35),
			new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.1 }),
		);
		centre.rotation.x = -Math.PI / 2;
		centre.position.y = 0.03;
		this.scene.add(centre);

		// A low perimeter wall so the clamp at ARENA_BOUND is something you can see
		// rather than an invisible shove.
		const wallMat = new MeshStandardMaterial({ color: COL.line, roughness: 0.7, metalness: 0.2 });
		for (const [w, d, x, z] of [
			[ARENA_BOUND * 2, 1, 0, -ARENA_BOUND],
			[ARENA_BOUND * 2, 1, 0, ARENA_BOUND],
			[1, ARENA_BOUND * 2, -ARENA_BOUND, 0],
			[1, ARENA_BOUND * 2, ARENA_BOUND, 0],
		]) {
			const wall = new Mesh(new BoxGeometry(w, 2.2, d), wallMat);
			wall.position.set(x, 1.1, z);
			this.scene.add(wall);
		}

		// Floodlight pylons at the corners: pure silhouette, no extra lights.
		const poleMat = new MeshStandardMaterial({ color: 0x191c24, roughness: 0.8 });
		for (const sx of [-1, 1]) {
			for (const sz of [-1, 1]) {
				const pole = new Mesh(new CylinderGeometry(0.5, 0.7, 20, 8), poleMat);
				pole.position.set(sx * (ARENA_BOUND - 3), 10, sz * (ARENA_BOUND - 3));
				this.scene.add(pole);
				const lamp = new Mesh(
					new BoxGeometry(3.6, 0.5, 1.4),
					new MeshBasicMaterial({ color: 0xdfe9ff, transparent: true, opacity: 0.7, toneMapped: false, fog: false }),
				);
				lamp.position.set(sx * (ARENA_BOUND - 3), 20, sz * (ARENA_BOUND - 3));
				lamp.rotation.y = sx * sz > 0 ? Math.PI / 4 : -Math.PI / 4;
				this.scene.add(lamp);
			}
		}
	}

	// Recolour the end zones to the actual two communities once the room state
	// arrives. Called with the mints so the caller does not have to know the
	// palette.
	setFactions({ a, b }) {
		this.factions = { a: a || '', b: b || '' };
	}

	factionColor(mint) {
		return mint && mint === this.factions.b ? COL.b : COL.a;
	}

	// ── animation library ────────────────────────────────────────────────────

	async loadAnimations() {
		const defs = await fetch(MANIFEST_URL, { cache: 'force-cache' })
			.then((r) => (r.ok ? r.json() : []))
			.catch(() => []);
		this._defs = Array.isArray(defs) ? defs : [];
		for (const d of this._defs) this._loopByName.set(d.name, d.loop !== false);

		const lib = new AnimationManager();
		lib.setAnimationDefs(this._defs);
		await Promise.all(CORE_CLIPS.map((name) => {
			const def = this._defs.find((d) => d.name === name);
			return def ? lib.loadAnimation(def.name, def.url, { loop: this._loopByName.get(name) }).catch(() => {}) : null;
		}));
		this._lib = lib;
	}

	_loadTemplate(url) {
		if (this._templates.has(url)) return this._templates.get(url);
		const p = this.loader.loadAsync(url);
		this._templates.set(url, p);
		return p;
	}

	// A fighter's body. Any humanoid GLB works: the canonical clip library is
	// retargeted onto whatever rig it carries. A GLB that fails or stalls falls
	// back to a known-good rig so nobody ever fights as an invisible body.
	async _makeAvatar(glbUrl) {
		let gltf;
		let loadedUrl = glbUrl || '/avatars/default.glb';
		try {
			gltf = await Promise.race([
				this._loadTemplate(loadedUrl),
				new Promise((_, rej) => setTimeout(() => rej(new Error('glb timeout')), 20000)),
			]);
		} catch {
			loadedUrl = '/avatars/default.glb';
			gltf = await this._loadTemplate(loadedUrl);
		}
		const model = cloneSkeleton(gltf.scene);
		model.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; } });
		return new ArenaAvatar(model, this._lib, this._loopByName, CLIPS, loadedUrl);
	}

	// ── roster ───────────────────────────────────────────────────────────────

	/**
	 * Put a fighter on the field. Returns the avatar, or null if the world was
	 * torn down while the GLB was loading (a real race when a battle ends during
	 * a slow avatar fetch).
	 */
	async spawnFighter(id, { avatarUrl = '', faction = '', name = '', x = 0, y = 0, z = 0, yaw = 0 } = {}) {
		if (this.fighters.has(id)) return this.fighters.get(id);
		// Reserve the slot before the await so two state callbacks for the same
		// fighter cannot both spawn a body.
		this.fighters.set(id, null);
		const avatar = await this._makeAvatar(avatarUrl);
		if (!this._scenePresent()) { avatar.dispose(); this.fighters.delete(id); return null; }

		const root = new Group();
		root.position.set(x, y, z);
		root.rotation.y = yaw;
		root.add(avatar.object);
		this.scene.add(root);

		avatar.root = root;
		avatar.id = id;
		avatar.name = name;
		avatar.faction = faction;
		avatar.headHeight = avatar.measureHeadHeight();
		avatar.target = new Vector3(x, y, z);
		avatar.targetYaw = yaw;
		avatar.dead = false;
		avatar.idle();

		// A ground disc in the fighter's faction colour: at a glance, in a
		// 16-a-side brawl, that is how you tell friend from enemy.
		const disc = new Mesh(
			new RingGeometry(0.5, 0.72, 24),
			new MeshBasicMaterial({ color: this.factionColor(faction), transparent: true, opacity: 0.75, side: DoubleSide }),
		);
		disc.rotation.x = -Math.PI / 2;
		disc.position.y = 0.04;
		root.add(disc);
		avatar.disc = disc;

		this.fighters.set(id, avatar);
		return avatar;
	}

	// Apply one authoritative update. Remote fighters lerp toward it; the local
	// fighter keeps its own predicted position EXCEPT on a respawn, where the
	// server picks the spawn point and the client must snap to it.
	updateFighter(id, patch = {}) {
		const f = this.fighters.get(id);
		if (!f) return;
		const isLocal = id === this.localId;
		const wasDead = f.dead;
		if (typeof patch.dead === 'boolean') f.dead = patch.dead;

		if (Number.isFinite(patch.x)) f.target.x = patch.x;
		if (Number.isFinite(patch.y)) f.target.y = patch.y;
		if (Number.isFinite(patch.z)) f.target.z = patch.z;
		if (Number.isFinite(patch.yaw)) f.targetYaw = patch.yaw;

		if (isLocal && wasDead && !f.dead) {
			// Respawned: take the server's spawn point verbatim.
			f.root.position.copy(f.target);
			f.root.rotation.y = f.targetYaw;
		}
		if (!isLocal && patch.motion) f.setMoving(patch.motion !== 'idle');

		// Downed fighters lie flat and stop animating; the server revives them.
		if (f.dead !== wasDead) {
			f.root.rotation.x = f.dead ? -Math.PI / 2.2 : 0;
			f.object.visible = true;
			f.disc.material.opacity = f.dead ? 0.2 : 0.75;
			if (f.dead) f.emote('loss'); else f.idle();
		}
	}

	removeFighter(id) {
		const f = this.fighters.get(id);
		this.fighters.delete(id);
		if (!f) return;
		this.scene.remove(f.root);
		f.disc?.geometry?.dispose?.();
		f.disc?.material?.dispose?.();
		f.dispose();
	}

	setLocal(id) {
		this.localId = id;
		const f = this.fighters.get(id);
		if (f) this._cam.yaw = f.root.rotation.y;
	}

	// What the net layer sends to the server each tick. Null before the local
	// fighter's body exists.
	localPose() {
		const f = this.fighters.get(this.localId);
		if (!f) return null;
		return {
			x: f.root.position.x,
			y: f.root.position.y,
			z: f.root.position.z,
			yaw: f.root.rotation.y,
			motion: this._moving ? 'run' : 'idle',
		};
	}

	// ── feedback ─────────────────────────────────────────────────────────────

	// A swing the server resolved. A hit draws a tracer to the target and a burst
	// on it; a miss draws the tracer alone, so a whiff still reads as an action.
	swing(fromId, toId, { hit = false, killed = false } = {}) {
		const from = this.fighters.get(fromId);
		if (!from) return;
		const color = this.factionColor(from.faction);
		const start = from.root.position.clone().setY(1.3);
		const to = toId && this.fighters.get(toId);
		const end = to ? to.root.position.clone().setY(1.2) : start.clone().add(
			new Vector3(Math.sin(from.root.rotation.y), 0, Math.cos(from.root.rotation.y)).multiplyScalar(20),
		);
		this._tracer(start, end, color);
		if (hit && to) this._burst(end, killed ? 0xffd166 : color, killed ? 22 : 10);
	}

	celebrate(id) {
		this.fighters.get(id)?.emote('win');
	}

	_tracer(start, end, color) {
		const dir = end.clone().sub(start);
		const len = dir.length() || 0.01;
		const beam = new Mesh(
			new CylinderGeometry(0.045, 0.045, len, 6),
			new MeshBasicMaterial({ color, transparent: true, opacity: 0.85, toneMapped: false, fog: false, blending: AdditiveBlending }),
		);
		beam.position.copy(start).add(dir.clone().multiplyScalar(0.5));
		beam.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), dir.clone().normalize());
		this.scene.add(beam);
		this._fx.push({
			life: 0.16,
			tick: (dt, fx) => {
				fx.life -= dt;
				beam.material.opacity = Math.max(0, fx.life / 0.16) * 0.85;
				if (fx.life > 0) return false;
				this.scene.remove(beam);
				beam.geometry.dispose();
				beam.material.dispose();
				return true;
			},
		});
	}

	_burst(at, color, count) {
		const group = new Group();
		group.position.copy(at);
		const parts = [];
		const geo = new SphereGeometry(0.09, 6, 5);
		const mat = new MeshBasicMaterial({ color, transparent: true, opacity: 0.95, toneMapped: false, fog: false });
		for (let i = 0; i < count; i++) {
			const m = new Mesh(geo, mat);
			const a = Math.random() * Math.PI * 2;
			const up = 1.5 + Math.random() * 3;
			parts.push({ m, vx: Math.cos(a) * (2 + Math.random() * 4), vy: up, vz: Math.sin(a) * (2 + Math.random() * 4) });
			group.add(m);
		}
		this.scene.add(group);
		this._fx.push({
			life: 0.8,
			tick: (dt, fx) => {
				fx.life -= dt;
				for (const p of parts) {
					p.vy -= 12 * dt;
					p.m.position.x += p.vx * dt;
					p.m.position.y += p.vy * dt;
					p.m.position.z += p.vz * dt;
				}
				mat.opacity = Math.max(0, fx.life / 0.8);
				if (fx.life > 0) return false;
				this.scene.remove(group);
				geo.dispose();
				mat.dispose();
				return true;
			},
		});
	}

	// ── controls ─────────────────────────────────────────────────────────────

	_initControls() {
		this._cam = { yaw: 0, pitch: 0.28, dist: 8.5 };
		this._keys = new Set();
		this._drag = null;
		this._move = { x: 0, y: 0 };
		this._moving = false;
		this._locked = false; // set while the match is not live

		const move = ['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'];
		this._onKeyDown = (e) => {
			const k = e.key.toLowerCase();
			if (move.includes(k)) { this._keys.add(k); e.preventDefault(); }
		};
		this._onKeyUp = (e) => this._keys.delete(e.key.toLowerCase());
		addEventListener('keydown', this._onKeyDown);
		addEventListener('keyup', this._onKeyUp);

		const el = this.canvas;
		el.addEventListener('pointerdown', (e) => {
			if (e.target.closest?.('.no-orbit')) return;
			this._drag = { x: e.clientX, y: e.clientY, id: e.pointerId };
			el.setPointerCapture?.(e.pointerId);
		});
		el.addEventListener('pointermove', (e) => {
			if (!this._drag || this._drag.id !== e.pointerId) return;
			this._cam.yaw -= (e.clientX - this._drag.x) * 0.005;
			this._cam.pitch = MathUtils.clamp(this._cam.pitch + (e.clientY - this._drag.y) * 0.004, -0.1, 0.75);
			this._drag.x = e.clientX;
			this._drag.y = e.clientY;
		});
		const end = (e) => { if (this._drag?.id === e.pointerId) this._drag = null; };
		el.addEventListener('pointerup', end);
		el.addEventListener('pointercancel', end);
		el.addEventListener('wheel', (e) => {
			this._cam.dist = MathUtils.clamp(this._cam.dist + Math.sign(e.deltaY) * 0.8, 3.5, 18);
		}, { passive: true });
	}

	setJoystick(x, y) { this._move.x = x; this._move.y = y; }

	// Movement is frozen outside the live phases, so nobody wanders the field
	// during the countdown or after the final whistle.
	setLocked(locked) { this._locked = !!locked; }

	_updateLocal(dt) {
		const f = this.fighters.get(this.localId);
		if (!f) return;
		if (f.dead || this._locked) { f.setMoving(false); this._moving = false; return; }

		let mx = 0, mz = 0;
		if (this._keys.has('w') || this._keys.has('arrowup')) mz -= 1;
		if (this._keys.has('s') || this._keys.has('arrowdown')) mz += 1;
		if (this._keys.has('a') || this._keys.has('arrowleft')) mx -= 1;
		if (this._keys.has('d') || this._keys.has('arrowright')) mx += 1;
		mx += this._move.x;
		mz -= this._move.y;

		const mag = Math.hypot(mx, mz);
		this._moving = mag > 0.08;
		if (this._moving) {
			const len = Math.max(mag, 1);
			mx /= len; mz /= len;
			const cos = Math.cos(this._cam.yaw), sin = Math.sin(this._cam.yaw);
			const wx = mx * cos - mz * sin;
			const wz = mx * sin + mz * cos;
			const step = WALK_SPEED * dt;
			f.root.position.x = MathUtils.clamp(f.root.position.x + wx * step, -ARENA_BOUND, ARENA_BOUND);
			f.root.position.z = MathUtils.clamp(f.root.position.z + wz * step, -ARENA_BOUND, ARENA_BOUND);
			f.root.rotation.y = dampAngle(f.root.rotation.y, Math.atan2(wx, wz), 14 * dt);
		}
		f.setMoving(this._moving);
	}

	// Where the local fighter is aiming, so the HUD can show whether a swing has
	// any chance of landing before the player burns the cooldown.
	nearestEnemyDistance() {
		const me = this.fighters.get(this.localId);
		if (!me) return null;
		let best = null;
		for (const [, f] of this.fighters) {
			if (!f || f === me || f.dead || f.faction === me.faction) continue;
			const d = Math.hypot(f.root.position.x - me.root.position.x, f.root.position.z - me.root.position.z);
			if (best == null || d < best) best = d;
		}
		return best;
	}

	// ── loop ─────────────────────────────────────────────────────────────────

	start() {
		if (this._running) return;
		this._running = true;
		this._last = performance.now();
		const frame = (t) => {
			if (!this._running) return;
			this._raf = requestAnimationFrame(frame);
			const dt = Math.min(0.05, (t - this._last) / 1000);
			this._last = t;
			this._tick(dt);
		};
		this._raf = requestAnimationFrame(frame);
	}

	_tick(dt) {
		this._updateLocal(dt);
		for (const [id, f] of this.fighters) {
			if (!f) continue;
			if (id !== this.localId) {
				// Interpolate remotes toward their last authoritative pose. 12/s is
				// fast enough to track a sprint and slow enough to smooth a 15 Hz
				// patch rate into continuous motion.
				f.root.position.lerp(f.target, Math.min(1, 12 * dt));
				if (!f.dead) f.root.rotation.y = dampAngle(f.root.rotation.y, f.targetYaw, 12 * dt);
			}
			f.update(dt);
		}
		for (let i = this._fx.length - 1; i >= 0; i--) {
			if (this._fx[i].tick(dt, this._fx[i])) this._fx.splice(i, 1);
		}
		this._updateCamera(dt);
		this._onLabels?.();
		this.renderer.render(this.scene, this.camera);
	}

	_updateCamera(dt) {
		const f = this.fighters.get(this.localId);
		const focus = f ? f.root.position : new Vector3(0, 0, 0);
		const { yaw, pitch, dist } = this._cam;
		const want = new Vector3(
			focus.x - Math.sin(yaw) * Math.cos(pitch) * dist,
			focus.y + 1.6 + Math.sin(pitch) * dist,
			focus.z - Math.cos(yaw) * Math.cos(pitch) * dist,
		);
		this.camera.position.lerp(want, Math.min(1, 9 * dt));
		this.camera.lookAt(focus.x, focus.y + 1.35, focus.z);
	}

	// Project a fighter's head into screen space so the page can pin a DOM name
	// tag over it. Returns null when the head is behind the camera.
	projectHead(id, out = { x: 0, y: 0 }) {
		const f = this.fighters.get(id);
		if (!f) return null;
		const v = new Vector3().copy(f.root.position);
		v.y += (f.headHeight || 1.7) + 0.25;
		v.project(this.camera);
		if (v.z > 1) return null;
		out.x = (v.x * 0.5 + 0.5) * this.canvas.clientWidth;
		out.y = (-v.y * 0.5 + 0.5) * this.canvas.clientHeight;
		return out;
	}

	setLabelUpdater(fn) { this._onLabels = fn; }

	// dispose() drops the scene, which is the signal an in-flight avatar load uses
	// to bail instead of adding a body to a world that is gone.
	_scenePresent() { return !!this.scene; }

	_aspect() {
		return (this.canvas.clientWidth || innerWidth) / (this.canvas.clientHeight || innerHeight);
	}

	_resize() {
		const w = this.canvas.clientWidth || innerWidth;
		const h = this.canvas.clientHeight || innerHeight;
		this.renderer.setSize(w, h, false);
		if (this.camera) {
			this.camera.aspect = this._aspect();
			this.camera.updateProjectionMatrix();
		}
	}

	dispose() {
		this._running = false;
		cancelAnimationFrame(this._raf);
		removeEventListener('resize', this._onResize);
		removeEventListener('keydown', this._onKeyDown);
		removeEventListener('keyup', this._onKeyUp);
		for (const id of [...this.fighters.keys()]) this.removeFighter(id);
		this.scene?.traverse((o) => {
			if (o.isMesh) {
				o.geometry?.dispose?.();
				const m = o.material;
				if (Array.isArray(m)) m.forEach((x) => x?.dispose?.()); else m?.dispose?.();
			}
		});
		this.renderer?.dispose();
		this.scene = null;
	}
}

function dampAngle(current, target, lambda) {
	let diff = ((target - current + Math.PI) % (Math.PI * 2)) - Math.PI;
	if (diff < -Math.PI) diff += Math.PI * 2;
	return current + diff * Math.min(1, lambda);
}
