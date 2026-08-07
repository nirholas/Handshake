// Ambient world life — pedestrians and vehicle traffic that make the plaza
// breathe (W08).
//
// Everything here is a *pure function of a shared world clock* (wall time) and
// the world seed, so two players standing in the same town see the same crowd
// walking the same routes and the same cars on the same stretch of road —
// without a single ambient NPC crossing the wire. That's the brief's deal:
// ambient life is client-side and deterministic; only consequential NPCs
// (vendors, quests, mobs) are server-authoritative.
//
// Performance is built in: a small cast of detailed GLB pedestrians near the
// action, a larger instanced "impostor" crowd in the distance (two InstancedMesh
// for the whole background), and a handful of grouped vehicles on the ring road.
// Counts are honest and capped, and the detailed crowd tapers as real players
// join so a busy world is never padded with fakes.

import {
	Group, Vector3, Object3D, Color, Mesh,
	InstancedMesh, CapsuleGeometry, SphereGeometry, MeshStandardMaterial,
	BoxGeometry, CylinderGeometry, MeshBasicMaterial,
} from 'three';
import { AnimationManager } from '../../animation-manager.js';
import { buildAvatar, CLIP_IDLE, CLIP_WALK } from '../avatar-rig.js';
import { mulberry32 } from './nav-graph.js';
import { loadCitizenPool, isCitizen } from './citizens.js';

const DEFAULT_AVATAR = '/avatars/default.glb';

const PED_WALK_SPEED = 1.35;     // m/s along the loop — an unhurried stroll
const DETAILED_PEDS = 6;         // GLB-bodied pedestrians near the centre
const IMPOSTOR_PEDS = 14;        // cheap instanced crowd in the distance
const VEHICLES = 5;              // cars/wagons on the ring road
const VEHICLE_SPEED = 6.5;       // m/s
const PED_AVOID_RADIUS = 2.0;    // how close before a ped sidesteps the player
const CAR_BRAKE_RADIUS = 5.5;    // how close before a car yields to the player

const PED_LINES = ['gm', 'wagmi', 'nice build', 'lfg', 'few understand', 'vibes', 'we so back', 'probably nothing'];

// One shared wall clock, in seconds. Clients are NTP-close, so a continuous
// function of this reads identically across machines for ambient purposes.
const worldClock = () => Date.now() / 1000;

// ---- detailed GLB pedestrian -------------------------------------------------

class Pedestrian {
	constructor(scene, nav, { loopIdx, phase, speedScale, record, seed, onInspect }) {
		this.scene = scene;
		this.nav = nav;
		this.loopIdx = loopIdx;
		this.phase = phase;
		this.speed = PED_WALK_SPEED * speedScale;
		this.height = 1.7;
		this._disposed = false;
		this._avoid = new Vector3();
		this._rng = mulberry32(seed);
		this._sayIn = 8 + this._rng() * 22;
		// Hold-to-talk: while a player has this pedestrian's profile or chat open,
		// they stop and face the player. `_lag` is how many seconds of stroll they
		// owe the shared schedule; it grows while held and decays after release, so
		// they briskly catch back up to where every other client says they are.
		this._held = false;
		this._lag = 0;

		this.rig = new Group();
		scene.add(this.rig);
		this.anim = new AnimationManager();
		this.bubble = null;
		this._bubbleTimer = null;

		// Real identity from the public avatar gallery (name, bio, and usually the
		// registered agent this avatar represents). A nameless model stays honest
		// anonymous scenery: no nameplate, no profile, no chat.
		this.record = record || null;
		this.label = null;
		if (isCitizen(record)) {
			this.name = record.name;
			this.citizen = {
				record,
				name: record.name,
				say: (t) => this.say(t),
				hold: () => this._setHeld(true),
				release: () => this._setHeld(false),
			};
			this.label = document.createElement('div');
			this.label.className = 'cc-label npc-name';
			this.label.textContent = record.name;
			// .cc-label is pointer-events:none globally (bubbles must never block the
			// look-drag); re-enable it for this one, the same way peer nameplates do.
			this.label.style.pointerEvents = 'auto';
			this.label.style.cursor = 'pointer';
			this.label.title = `Meet ${record.name}`;
			this.label.addEventListener('click', (e) => { e.stopPropagation(); onInspect?.(this); });
			document.body.appendChild(this.label);
		}

		// Locomotion clips only: pedestrians never emote, and each one with its own
		// AnimationManager would otherwise fetch the entire clip library.
		buildAvatar(this.rig, record?.url || DEFAULT_AVATAR, this.anim, { clips: 'locomotion' })
			.then(({ height }) => {
				if (this._disposed) return;
				this.height = height;
				// Loaded into idle by buildAvatar — set them strolling.
				if (!this._held) this.anim.crossfadeTo(CLIP_WALK, 0.2).catch(() => {});
			})
			.catch(() => {});
	}

	_setHeld(held) {
		if (this._held === !!held) return;
		this._held = !!held;
		this.anim.crossfadeTo(this._held ? CLIP_IDLE : CLIP_WALK, 0.25).catch(() => {});
	}

	say(text) {
		if (this._disposed) return; // churned away mid-conversation; the chat panel outlives the body
		if (this.bubble) this.bubble.remove();
		this.bubble = document.createElement('div');
		this.bubble.className = 'cc-bubble npc-bubble';
		this.bubble.textContent = text;
		document.body.appendChild(this.bubble);
		clearTimeout(this._bubbleTimer);
		this._bubbleTimer = setTimeout(() => { this.bubble?.remove(); this.bubble = null; }, 4000);
	}

	update(dt, T, player) {
		// Base position is a pure function of the shared clock — identical on every
		// client. Arc-length advances at a steady stroll. Hold-to-talk is a local,
		// cosmetic deviation like the sidestep below: while held the pedestrian
		// banks lag instead of moving, and afterwards walks it off at a brisk pace
		// until they re-converge with the shared baseline.
		if (this._held) this._lag += dt;
		else if (this._lag > 0) this._lag = Math.max(0, this._lag - dt * 0.6);
		const d = this.phase + this.speed * (T - this._lag);
		const p = this.nav.pedPoint(this.loopIdx, d);

		// Local, cosmetic sidestep around the player. Re-converges to zero, so it
		// never desyncs the shared baseline between clients.
		if (player && !this._held) {
			const dx = p.x - player.x, dz = p.z - player.z;
			const dist = Math.hypot(dx, dz);
			if (dist < PED_AVOID_RADIUS && dist > 1e-3) {
				const push = (PED_AVOID_RADIUS - dist);
				this._avoid.x += (dx / dist * push - this._avoid.x) * Math.min(1, dt * 4);
				this._avoid.z += (dz / dist * push - this._avoid.z) * Math.min(1, dt * 4);
			}
		}
		this._avoid.multiplyScalar(1 - Math.min(1, dt * 2));

		this.rig.position.set(p.x + this._avoid.x, 0, p.z + this._avoid.z);
		// Held: turn to face whoever stopped to talk. Otherwise face travel.
		if (this._held && player) {
			const want = Math.atan2(player.x - this.rig.position.x, player.z - this.rig.position.z);
			let delta = want - this.rig.rotation.y;
			while (delta > Math.PI) delta -= Math.PI * 2;
			while (delta < -Math.PI) delta += Math.PI * 2;
			this.rig.rotation.y += delta * Math.min(1, dt * 6);
		} else {
			this.rig.rotation.y = Math.atan2(p.dirX, p.dirZ);
		}
		this.anim.update(dt);

		this._sayIn -= dt;
		if (this._sayIn <= 0 && !this._held) { this._sayIn = 14 + this._rng() * 26; this.say(PED_LINES[(this._rng() * PED_LINES.length) | 0]); }
	}

	dispose() {
		this._disposed = true;
		this.scene.remove(this.rig);
		this.bubble?.remove();
		clearTimeout(this._bubbleTimer);
		this.label?.remove();
		this.anim.dispose?.();
	}
}

// ---- vehicle (grouped, biome-styled) -----------------------------------------

// Build a low-poly vehicle. style 'wagon' for frontier towns, 'car' elsewhere.
// Shared unit geometry scaled per part keeps a vehicle to a handful of meshes.
function buildVehicle(style) {
	const g = new Group();
	const box = new BoxGeometry(1, 1, 1);
	const wheelGeo = new CylinderGeometry(0.34, 0.34, 0.22, 12);
	const wheels = [];
	const wheelMat = new MeshStandardMaterial({ color: 0x1a1a1d, roughness: 0.9 });
	const addWheel = (x, z) => {
		const w = new Mesh(wheelGeo, wheelMat);
		w.rotation.z = Math.PI / 2;
		w.position.set(x, 0.34, z);
		w.castShadow = true;
		g.add(w); wheels.push(w);
	};

	let brakeLights = null;
	if (style === 'wagon') {
		const bodyMat = new MeshStandardMaterial({ color: 0x6e5238, roughness: 1 });
		const coverMat = new MeshStandardMaterial({ color: 0xd8cdb0, roughness: 1 });
		const body = new Mesh(box, bodyMat); body.scale.set(1.5, 0.7, 3.0); body.position.y = 0.75; body.castShadow = true; g.add(body);
		const cover = new Mesh(box, coverMat); cover.scale.set(1.45, 1.0, 2.2); cover.position.set(0, 1.45, -0.1); cover.castShadow = true; g.add(cover);
		// A simple draft animal up front so a wagon isn't gliding on its own.
		const horse = new Mesh(box, new MeshStandardMaterial({ color: 0x3a2a1e, roughness: 1 }));
		horse.scale.set(0.7, 0.9, 1.4); horse.position.set(0, 0.9, 2.4); horse.castShadow = true; g.add(horse);
		addWheel(-0.85, 1.0); addWheel(0.85, 1.0); addWheel(-0.85, -1.0); addWheel(0.85, -1.0);
	} else {
		const bodyMat = new MeshStandardMaterial({ color: 0x2b3340, roughness: 0.5, metalness: 0.3 });
		const cabinMat = new MeshStandardMaterial({ color: 0x10151c, roughness: 0.3, metalness: 0.2 });
		const body = new Mesh(box, bodyMat); body.scale.set(1.7, 0.7, 3.6); body.position.y = 0.62; body.castShadow = true; g.add(body);
		const cabin = new Mesh(box, cabinMat); cabin.scale.set(1.5, 0.7, 1.9); cabin.position.set(0, 1.15, -0.1); cabin.castShadow = true; g.add(cabin);
		const head = new Mesh(box, new MeshBasicMaterial({ color: 0xfff3cf })); head.scale.set(1.5, 0.16, 0.1); head.position.set(0, 0.62, 1.81); g.add(head);
		brakeLights = new Mesh(box, new MeshBasicMaterial({ color: 0x551111 })); brakeLights.scale.set(1.5, 0.18, 0.1); brakeLights.position.set(0, 0.62, -1.81); g.add(brakeLights);
		addWheel(-0.92, 1.15); addWheel(0.92, 1.15); addWheel(-0.92, -1.2); addWheel(0.92, -1.2);
	}
	return { group: g, wheels, brakeLights };
}

class Vehicle {
	constructor(scene, nav, { phase, lane, style, dir }) {
		this.nav = nav;
		this.phase = phase;
		this.lane = lane;
		this.dir = dir; // +1 / -1 travel direction around the ring
		this.curL = phase;
		const built = buildVehicle(style);
		this.group = built.group;
		this.wheels = built.wheels;
		this.brakeLights = built.brakeLights;
		scene.add(this.group);
		this.scene = scene;
	}

	update(dt, T, player) {
		// Target arc-length from the shared clock — the consistent baseline.
		const targetL = this.phase + this.dir * VEHICLE_SPEED * T;

		// Yield to the local player: if they're standing on the road just ahead,
		// hold position rather than drive through them. This is local-only (each
		// player sees traffic yield to them) and re-converges to the baseline once
		// the road clears, so the shared schedule stays the source of truth.
		let blocked = false;
		if (player) {
			const ahead = this.nav.roadPoint(this.curL + this.dir * 3.5, this.lane);
			const dx = ahead.x - player.x, dz = ahead.z - player.z;
			if (Math.hypot(dx, dz) < CAR_BRAKE_RADIUS) blocked = true;
		}
		const desired = blocked ? Math.min(this.curL, targetL, this.curL) : targetL;
		const prevL = this.curL;
		this.curL += (desired - this.curL) * Math.min(1, dt * (blocked ? 4 : 2.5));

		const p = this.nav.roadPoint(this.curL, this.lane);
		this.group.position.set(p.x, 0, p.z);
		this.group.rotation.y = Math.atan2(p.dirX * this.dir, p.dirZ * this.dir);

		// Spin the wheels with actual travel; flash brake lights when yielding.
		const moved = Math.abs(this.curL - prevL);
		for (const w of this.wheels) w.rotation.x += moved * 1.8;
		if (this.brakeLights) this.brakeLights.material.color.setHex(blocked ? 0xff3b30 : 0x551111);
	}

	dispose() { this.scene.remove(this.group); }
}

// ---- the ambient-life system -------------------------------------------------

export class AmbientLife {
	// `onInspectPed` (optional) makes the detailed pedestrians selectable: called
	// with the Pedestrian when a player clicks its nameplate or body. The world
	// manager wires it to the citizen profile card (see citizens.js).
	constructor({ scene, nav, biome, onInspectPed }) {
		this.scene = scene;
		this.nav = nav;
		this.biome = biome;
		this.onInspectPed = onInspectPed || null;
		this.peds = [];
		this.vehicles = [];
		this._avatarPool = null;
		this._impostor = null;
		this._dummy = new Object3D();
		this._wantPeds = DETAILED_PEDS;

		this._buildImpostors();
		this._buildVehicles();
		this._loadAvatarPoolThenPeds();
	}

	// A single InstancedMesh pair (bodies + heads) carries the whole background
	// crowd on the outermost loop — one draw call each, no per-ped objects.
	_buildImpostors() {
		const rand = mulberry32((this.nav.seed ^ 0x9e3779b9) >>> 0);
		const bodyGeo = new CapsuleGeometry(0.28, 0.7, 4, 8);
		const headGeo = new SphereGeometry(0.22, 10, 8);
		const bodyMat = new MeshStandardMaterial({ roughness: 0.95 });
		const headMat = new MeshStandardMaterial({ roughness: 0.9, color: 0xcaa98a });
		const bodies = new InstancedMesh(bodyGeo, bodyMat, IMPOSTOR_PEDS);
		const heads = new InstancedMesh(headGeo, headMat, IMPOSTOR_PEDS);
		bodies.castShadow = true;
		this._impostorSpec = [];
		const palette = [0x5a6472, 0x6b5a72, 0x4d6b5a, 0x72655a, 0x556070];
		for (let i = 0; i < IMPOSTOR_PEDS; i++) {
			bodies.setColorAt(i, new Color(palette[i % palette.length]));
			this._impostorSpec.push({
				loopIdx: 0, // outermost loop only — keeps impostors in the distance
				phase: rand() * 1000,
				speed: PED_WALK_SPEED * (0.85 + rand() * 0.4),
				bob: rand() * Math.PI * 2,
			});
		}
		if (bodies.instanceColor) bodies.instanceColor.needsUpdate = true;
		this.scene.add(bodies, heads);
		this._impostor = { bodies, heads };
	}

	_buildVehicles() {
		const rand = mulberry32((this.nav.seed ^ 0x85ebca6b) >>> 0);
		const style = this.biome?.town === 'frontier' ? 'wagon' : 'car';
		const spacing = this.nav.roadLen / VEHICLES;
		for (let i = 0; i < VEHICLES; i++) {
			const dir = i % 2 === 0 ? 1 : -1;
			const lane = dir > 0 ? -this.nav.roadWidth * 0.22 : this.nav.roadWidth * 0.22;
			this.vehicles.push(new Vehicle(this.scene, this.nav, {
				phase: i * spacing + rand() * spacing * 0.4,
				lane,
				dir,
				style,
			}));
		}
	}

	async _loadAvatarPoolThenPeds() {
		// The shared citizen pool: full gallery records (model URL + the identity
		// riding it) so a pedestrian is a real, inspectable community avatar, not
		// an anonymous mesh. Settles to [] on failure; peds then wear the default.
		this._avatarPool = await loadCitizenPool();
		this._syncPeds();
	}

	// Deterministic avatar assignment: shuffle the pool by seed so ped #k shows the
	// same model — and therefore the same identity — on every client.
	_pedAvatar(k) {
		const pool = this._avatarPool;
		if (!pool || !pool.length) return null;
		const rand = mulberry32((this.nav.seed ^ (k * 0x27d4eb2f)) >>> 0);
		return pool[(rand() * pool.length) | 0];
	}

	_syncPeds() {
		if (!this._avatarPool) return; // pool still loading
		const want = this._wantPeds;
		while (this.peds.length < want) {
			const k = this.peds.length;
			const rand = mulberry32((this.nav.seed ^ (k * 0x165667b1)) >>> 0);
			// Detailed peds ride the inner loops; impostors hold the outer one.
			const loopIdx = 1 + (k % (this.nav.pedLoopCount - 1));
			this.peds.push(new Pedestrian(this.scene, this.nav, {
				loopIdx,
				phase: rand() * 1000,
				speedScale: 0.85 + rand() * 0.4,
				record: this._pedAvatar(k),
				seed: (this.nav.seed ^ (k * 0x9e3779b9)) >>> 0,
				onInspect: this.onInspectPed ? (ped) => this.onInspectPed(ped) : null,
			}));
		}
		while (this.peds.length > want) this.peds.pop().dispose();
	}

	// The crowd tapers as real peers arrive, so the world is lively when empty but
	// never padded with fakes once it's genuinely busy. Peer count is the room's
	// authoritative set, so this stays consistent across clients.
	setRealPeers(n) {
		const want = Math.max(0, DETAILED_PEDS - (n | 0));
		if (want === this._wantPeds) return;
		this._wantPeds = want;
		this._syncPeds();
	}

	// Drive everything from the shared clock. `project` places detailed-ped speech
	// bubbles; `player` is the local player position for reactivity.
	update(dt, { player, project } = {}) {
		const T = worldClock();

		for (const p of this.peds) {
			p.update(dt, T, player);
			if (project) {
				if (p.label) project(p.label, p.rig.position.x, p.height + 0.2, p.rig.position.z);
				if (p.bubble) project(p.bubble, p.rig.position.x, p.height + 0.6, p.rig.position.z);
			}
		}
		for (const v of this.vehicles) v.update(dt, T, player);

		// Impostor crowd — one matrix write per instance, distance only.
		if (this._impostor) {
			const { bodies, heads } = this._impostor;
			for (let i = 0; i < this._impostorSpec.length; i++) {
				const s = this._impostorSpec[i];
				const pt = this.nav.pedPoint(s.loopIdx, s.phase + s.speed * T);
				const bob = Math.sin(T * 4 + s.bob) * 0.04;
				this._dummy.position.set(pt.x, 0.71 + bob, pt.z);
				this._dummy.rotation.set(0, Math.atan2(pt.dirX, pt.dirZ), 0);
				this._dummy.updateMatrix();
				bodies.setMatrixAt(i, this._dummy.matrix);
				this._dummy.position.y = 1.5 + bob;
				this._dummy.updateMatrix();
				heads.setMatrixAt(i, this._dummy.matrix);
			}
			bodies.instanceMatrix.needsUpdate = true;
			heads.instanceMatrix.needsUpdate = true;
		}
	}

	// Honest live counts for the manager's HUD / debugging.
	get counts() {
		return { detailed: this.peds.length, impostors: IMPOSTOR_PEDS, vehicles: this.vehicles.length };
	}

	dispose() {
		for (const p of this.peds) p.dispose();
		for (const v of this.vehicles) v.dispose();
		this.peds = []; this.vehicles = [];
		if (this._impostor) {
			this.scene.remove(this._impostor.bodies, this._impostor.heads);
			this._impostor.bodies.geometry.dispose();
			this._impostor.heads.geometry.dispose();
			this._impostor = null;
		}
	}
}
