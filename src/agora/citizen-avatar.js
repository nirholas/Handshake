// Agora citizens — the living population of the Commons.
//
// Each citizen from /api/agora/citizens is rendered as an avatar standing in the
// City square: its real `avatarUrl` GLB, canonicalized + retargeted so the shared
// idle clip drives any rig, with a billboarded name + profession label above its
// head. This module owns the *crowd*: loading, pooling, the per-frame loop, and
// hit-testing. Selection state, the passport panel, and accessibility chrome live
// in src/agora/agora-world.js.
//
// Performance is the whole game (the DoD asks for 50 citizens at 60fps):
//   • Each unique avatar GLB is loaded ONCE and its idle/walk clips retargeted
//     ONCE (via AnimationManager). Every citizen wearing that GLB is a cheap
//     SkeletonUtils clone driven by a bare AnimationMixer reusing those bound
//     clips — N mixers, not N retargets. (Same proven pattern as src/club-crowd.js.)
//   • Clip JSON is fetched once and shared across every template.
//   • Concurrent GLB loads are capped so a 50-strong fleet doesn't open 50 sockets.
//   • A rig the canonical library can't drive still renders (the model is shown),
//     it just holds its authored pose instead of idling — never a T-pose void.

import {
	AnimationMixer, Box3, CanvasTexture, Group, Mesh, RingGeometry,
	MeshBasicMaterial, Sprite, SpriteMaterial, Vector3, DoubleSide, SRGBColorSpace,
} from 'three';
import { clone as cloneSkinnedScene } from 'three/addons/utils/SkeletonUtils.js';
import { gltfLoader } from '../loaders/gltf.js';
import { AnimationManager } from '../animation-manager.js';
import { loadManifest, getLocomotionDefs, resolveAvatarUrl, AVATAR_DEFAULT, CLIP_IDLE, CLIP_WALK } from '../game/avatar-rig.js';
import { log } from '../shared/log.js';

// Target on-screen height so wildly-scaled GLBs all read as people in the square.
const AVATAR_HEIGHT = 1.74;
// Cap simultaneous GLB fetch+parse so a big fleet loads progressively instead of
// saturating the network and stalling the first frame.
const MAX_CONCURRENT_LOADS = 4;

// How many citizens may wear their OWN avatar GLB.
//
// The square renders the 200 most recently active citizens and a community
// avatar runs 2.7 MB to 21 MB, so dressing all of them is close to a gigabyte of
// download. Measured before this cap: the first personal GLB landed 81 seconds
// in and 19 of 200 citizens were standing after four and a half minutes, with an
// empty plaza the whole time. Presence comes first now (everyone is placed on the
// shared default rig, one 748 KB load for the entire crowd) and the most recently
// active citizens upgrade to their own model as it streams in. Nobody is missing
// and nobody is invented; only fidelity arrives progressively. Phones and tablets
// take a smaller share of that budget, matching the per-model download ceiling
// src/game/avatar-rig.js already applies there.
const _coarsePointer = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
export const MAX_PERSONAL_AVATARS = _coarsePointer ? 8 : 24;
const FADE_IN_SEC = 0.55;
// Citizen locomotion (Task 06 claim-walk). A citizen strolls to the board to
// claim and on to a work spot; the economy layer drives this via walkTo().
const WALK_SPEED = 2.7;          // m/s
const TURN_RATE = 9;             // rad/s toward heading
const ARRIVE_EPS = 0.35;         // metres "close enough"
const CELEBRATE_SEC = 1.1;       // duration of the completion hop

// Profession → accent colour. Keys match the API's profession keys
// (api/agora/[action].js PROFESSIONS). Used for the label chip and selection ring
// so the labour market is legible at a glance. Unknown professions fall back to a
// neutral platform accent — open by design, never a hardcoded allowlist gate.
export const PROFESSION_COLORS = {
	fetcher: '#4ea1ff',
	sculptor: '#ff8a5c',
	scribe: '#9b8cff',
	cartographer: '#36d399',
	crier: '#ff6fae',
	appraiser: '#ffd166',
	verifier: '#5ce0d8',
	namekeeper: '#c0a6ff',
};
const NEUTRAL_ACCENT = '#9fb4cc';

export function professionColor(profession) {
	return PROFESSION_COLORS[String(profession || '').toLowerCase()] || NEUTRAL_ACCENT;
}

// Display labels for the profession keys the API emits (lowercase). Falls back to
// a capitalised key so an unmapped/new profession still reads cleanly: open by
// design, never a hardcoded gate. Lives beside the colour map so a profession's
// name and its accent can never disagree.
export const PROFESSION_LABELS = {
	fetcher: 'Fetcher', sculptor: 'Sculptor', scribe: 'Scribe',
	cartographer: 'Cartographer', crier: 'Crier', appraiser: 'Appraiser',
	verifier: 'Verifier', namekeeper: 'Namekeeper',
};
export function professionLabelFor(profession) {
	const key = String(profession || '').toLowerCase();
	if (PROFESSION_LABELS[key]) return PROFESSION_LABELS[key];
	if (!key) return 'Citizen';
	return key.charAt(0).toUpperCase() + key.slice(1);
}

// The craft a citizen is *known for*, as a profession key.
//
// A citizen carries two profession fields and they mean different things:
// `profession` is the primary craft the world seeds and the job board hires on,
// while `professions` is the decoded AgenC capability bitmap (everything it is
// allowed to claim). Every citizen is granted the fetcher bit because an x402
// service call is the one craft anyone can do (workers/agora-citizens/roster.js),
// so `professions[0]` is *always* Fetcher and says nothing about who this is.
// Reading it as the citizen's craft labelled all 200 citizens "FETCHER" while
// their accent colour showed the real primary. Primary first, bitmap only as the
// fallback, so name, chip and colour always agree.
export function primaryProfessionKey(citizen) {
	return citizen?.profession || citizen?.professions?.[0]?.key || null;
}

/** The citizen's craft as display text ("Appraiser"), never an empty chip. */
export function citizenProfessionLabel(citizen) {
	const key = primaryProfessionKey(citizen);
	if (key) return professionLabelFor(key);
	// No primary key: honour a label the API already formatted before giving up.
	return citizen?.professions?.[0]?.label || 'Citizen';
}

const _box = new Box3();
const _v = new Vector3();

function scaleToHeight(obj, h) {
	_box.setFromObject(obj, true);
	const cur = _box.max.y - _box.min.y || 1;
	obj.scale.multiplyScalar(h / cur);
}
function groundFeet(obj) {
	_box.setFromObject(obj, true);
	if (Number.isFinite(_box.min.y)) obj.position.y -= _box.min.y;
}

// Build a crisp, high-DPI billboard label: bold name over a profession chip.
// Returns a Sprite that always faces the camera (sizeAttenuation on, so distant
// labels recede naturally). Drawn on a transparent rounded panel for contrast
// against both bright sky and dark buildings. Exported so the player mode's
// remote humans (player-mode.js) wear the exact same nameplate as citizens.
export function buildLabelSprite(name, profession, accent) {
	const dpr = Math.min(window.devicePixelRatio || 1, 2);
	const padX = 22, nameSize = 34, profSize = 22, gap = 8;
	const font = (px, w) => `${w} ${px}px Inter, system-ui, sans-serif`;

	// Clamp a pathologically long display name so its billboard can't dominate the
	// square (the 3D sprite has no CSS ellipsis to fall back on). Truncate to a
	// sane width with an ellipsis; the full name still shows in the passport.
	const MAX_NAME = 24;
	const raw = String(name ?? 'Citizen');
	const shown = raw.length > MAX_NAME ? `${raw.slice(0, MAX_NAME - 1)}…` : raw;

	const measure = document.createElement('canvas').getContext('2d');
	measure.font = font(nameSize, 700);
	const nameW = measure.measureText(shown).width;
	const profText = (profession || 'Citizen').toUpperCase();
	measure.font = font(profSize, 600);
	const profW = measure.measureText(profText).width;

	const w = Math.ceil(Math.max(nameW, profW + 26) + padX * 2);
	const h = Math.ceil(nameSize + gap + profSize + 30);

	const c = document.createElement('canvas');
	c.width = Math.ceil(w * dpr);
	c.height = Math.ceil(h * dpr);
	const ctx = c.getContext('2d');
	ctx.scale(dpr, dpr);

	// Rounded translucent panel.
	const r = 12;
	ctx.fillStyle = 'rgba(8, 10, 14, 0.74)';
	ctx.strokeStyle = 'rgba(255,255,255,0.10)';
	ctx.lineWidth = 1;
	roundRect(ctx, 1, 1, w - 2, h - 2, r);
	ctx.fill();
	ctx.stroke();

	// Name (clamped — the canvas was sized for `shown`, so draw `shown` or a long
	// name would hard-clip at the canvas edge with no ellipsis).
	ctx.textBaseline = 'top';
	ctx.fillStyle = '#ffffff';
	ctx.font = font(nameSize, 700);
	ctx.fillText(shown, padX, 13);

	// Profession chip: accent dot + label.
	const py = 13 + nameSize + gap;
	ctx.fillStyle = accent;
	ctx.beginPath();
	ctx.arc(padX + 6, py + profSize / 2, 5, 0, Math.PI * 2);
	ctx.fill();
	ctx.fillStyle = 'rgba(255,255,255,0.78)';
	ctx.font = font(profSize, 600);
	ctx.fillText(profText, padX + 20, py + 1);

	const tex = new CanvasTexture(c);
	tex.colorSpace = SRGBColorSpace;
	tex.needsUpdate = true;
	const mat = new SpriteMaterial({ map: tex, transparent: true, depthTest: true, depthWrite: false });
	const sprite = new Sprite(mat);
	// World height of the label ~0.42m; width preserves the canvas aspect.
	const worldH = 0.46;
	sprite.scale.set(worldH * (w / h), worldH, 1);
	sprite.renderOrder = 2;
	sprite.userData.isLabel = true;
	return sprite;
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

export class CitizenPopulation {
	/**
	 * @param {object} opts
	 * @param {import('three').WebGLRenderer} opts.renderer
	 * @param {import('three').Scene} opts.scene
	 * @param {boolean} [opts.reducedMotion] honor prefers-reduced-motion (no fade/idle motion)
	 */
	constructor({ renderer, scene, reducedMotion = false }) {
		this.scene = scene;
		this.reducedMotion = reducedMotion;
		this.loader = gltfLoader(renderer);

		this.root = new Group();
		this.root.name = 'agora-citizens';
		scene.add(this.root);

		this.instances = [];          // { citizen, group, model, mixer, label, materials, fade, height }
		this._byId = new Map();       // citizen.id → instance
		this._templates = new Map();  // url → Promise<{ scene, clips, drivable }>
		this._clipJson = null;        // Promise<Map<name, clipJson>>
		this._loadSlots = 0;
		this._loadQueue = [];
		this._disposed = false;

		// A single reusable selection ring, parented to the highlighted citizen.
		this._ring = this._buildRing();
		this._ring.visible = false;
		scene.add(this._ring);
		this._selectedId = null;
	}

	_buildRing() {
		const geo = new RingGeometry(0.5, 0.62, 48);
		geo.rotateX(-Math.PI / 2);
		const mat = new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, side: DoubleSide, depthWrite: false });
		const ring = new Mesh(geo, mat);
		ring.renderOrder = 1;
		ring.name = 'agora-selection-ring';
		return ring;
	}

	// Fetch idle + walk clip JSON once, shared across every template.
	_ensureClips() {
		if (this._clipJson) return this._clipJson;
		this._clipJson = (async () => {
			await loadManifest();
			const defs = getLocomotionDefs();
			const map = new Map();
			await Promise.all(defs.map(async (d) => {
				try {
					const r = await fetch(d.url, { cache: 'force-cache' });
					if (r.ok) map.set(d.name, await r.json());
				} catch (err) {
					log.warn(`[agora] clip "${d.name}" fetch failed`, err?.message);
				}
			}));
			return map;
		})();
		return this._clipJson;
	}

	// Throttle concurrent GLB loads. Resolves when a slot frees up.
	_acquireSlot() {
		if (this._loadSlots < MAX_CONCURRENT_LOADS) {
			this._loadSlots++;
			return Promise.resolve();
		}
		return new Promise((resolve) => this._loadQueue.push(resolve));
	}
	_releaseSlot() {
		this._loadSlots--;
		const next = this._loadQueue.shift();
		if (next) { this._loadSlots++; next(); }
	}

	// Load a unique GLB once → reusable retargeted idle/walk clips bound to this
	// rig's node names (identical across every SkeletonUtils.clone).
	_template(url) {
		if (this._templates.has(url)) return this._templates.get(url);
		const p = (async () => {
			const clipJson = await this._ensureClips();
			await this._acquireSlot();
			let gltf;
			try {
				gltf = await this.loader.loadAsync(url);
			} finally {
				this._releaseSlot();
			}
			const sceneRoot = gltf.scene;
			sceneRoot.traverse((n) => {
				if (!n.isMesh) return;
				n.castShadow = true;
				n.receiveShadow = false;
			});
			// Retarget against a throwaway clone so the cached template stays pristine.
			const ref = cloneSkinnedScene(sceneRoot);
			const mgr = new AnimationManager();
			mgr.attach(ref, { avatarUrl: url });
			const clips = new Map();
			if (mgr.supportsCanonicalClips()) {
				for (const [name, json] of clipJson) {
					mgr.injectClip(name, json, { loop: true });
					const clip = mgr.actions.get(name)?.getClip?.();
					if (clip) clips.set(name, clip);
				}
			}
			mgr.detach();
			return { scene: sceneRoot, clips, drivable: clips.size > 0 };
		})().catch((err) => {
			log.warn('[agora] template load failed', url, err?.message);
			return { scene: null, clips: new Map(), drivable: false };
		});
		this._templates.set(url, p);
		return p;
	}

	/**
	 * Add one citizen to the world at (x, z) facing roughly toward the plaza
	 * centre. Returns the instance (or null if its GLB couldn't be loaded). Safe
	 * to call concurrently for the whole fleet — loads are pooled internally.
	 *
	 * @param {object} citizen   shaped citizen from /api/agora/citizens
	 * @param {{x:number,z:number}} pos
	 */
	async add(citizen, pos) {
		if (this._disposed || this._byId.has(citizen.id)) return null;
		const url = await resolveAvatarUrl(citizen.avatarUrl || '');
		const tpl = await this._template(url);
		if (this._disposed) return null;
		if (!tpl?.scene) return null;

		const model = cloneSkinnedScene(tpl.scene);
		scaleToHeight(model, AVATAR_HEIGHT);
		groundFeet(model);

		// Per-instance materials so the fade-in opacity is isolated (the template's
		// shared materials/geometry/textures are otherwise reused across clones).
		const materials = [];
		model.traverse((n) => {
			if (!n.isMesh || !n.material) return;
			const mats = Array.isArray(n.material) ? n.material : [n.material];
			const cloned = mats.map((m) => {
				const c = m.clone();
				c.transparent = true;
				c.depthWrite = true;
				return c;
			});
			n.material = Array.isArray(n.material) ? cloned : cloned[0];
			materials.push(...cloned);
		});

		const group = new Group();
		group.name = `citizen-${citizen.id}`;
		group.add(model);
		group.position.set(pos.x, 0, pos.z);
		// Face the plaza centre with a little jitter so the crowd feels gathered,
		// not regimented. atan2(x,z) points the +Z-forward avatar toward origin.
		const baseYaw = Math.atan2(-pos.x, -pos.z);
		group.rotation.y = baseYaw + (hashJitter(citizen.id) - 0.5) * 0.8;
		group.userData.citizenId = citizen.id;
		this.root.add(group);

		const accent = professionColor(primaryProfessionKey(citizen));
		const label = buildLabelSprite(citizen.displayName || 'Citizen', citizenProfessionLabel(citizen), accent);
		_box.setFromObject(model, true);
		const height = Number.isFinite(_box.max.y) ? _box.max.y : AVATAR_HEIGHT;
		label.position.set(0, height + 0.3, 0);
		group.add(label);

		// Idle loop, desynced so the crowd doesn't breathe in lockstep.
		let mixer = null;
		let idleAction = null;
		const idleClip = tpl.clips.get(CLIP_IDLE) || [...tpl.clips.values()][0];
		const walkClip = tpl.clips.get(CLIP_WALK) || null;
		if (idleClip && !this.reducedMotion) {
			mixer = new AnimationMixer(model);
			idleAction = mixer.clipAction(idleClip);
			idleAction.time = hashJitter(citizen.id + 'x') * (idleClip.duration || 1);
			idleAction.play();
		} else if (idleClip && this.reducedMotion) {
			// Reduced motion: hold a calm idle pose (frame 0), no looping motion.
			mixer = new AnimationMixer(model);
			idleAction = mixer.clipAction(idleClip);
			idleAction.play();
			mixer.update(0);
			idleAction.paused = true;
		}

		const fade = this.reducedMotion ? null : { t: 0 };
		for (const m of materials) m.opacity = this.reducedMotion ? 1 : 0;

		const inst = {
			citizen, group, model, mixer, label, materials, fade, height, baseYaw,
			// Locomotion + economy state (Task 06).
			idleClip, walkClip, idleAction, walkAction: null,
			motion: 'idle', walkTarget: null, onArrive: null, heading: group.rotation.y,
			busy: false, busyRing: null, busyT: 0, celebrateT: null,
		};
		this.instances.push(inst);
		this._byId.set(citizen.id, inst);
		// Pickable meshes carry a back-reference so a raycast hit resolves to the id.
		model.traverse((n) => { if (n.isMesh) n.userData.citizenId = citizen.id; });
		return inst;
	}

	/** Advance idle loops + fade-ins + locomotion. Cheap: one mixer.update per citizen. */
	update(dt) {
		for (const inst of this.instances) {
			this._advanceMotion(inst, dt);
			if (!this.reducedMotion) inst.mixer?.update(dt);
			if (inst.fade) {
				inst.fade.t += dt;
				const k = Math.min(1, inst.fade.t / FADE_IN_SEC);
				const eased = k * (2 - k); // ease-out
				for (const m of inst.materials) m.opacity = eased;
				if (k >= 1) {
					for (const m of inst.materials) { m.transparent = false; }
					inst.fade = null;
				}
			}
		}
	}

	// ── Locomotion + economy state (Task 06) ──────────────────────────────────
	// Drive one citizen toward a target; on arrival fire its callback. Reduced
	// motion places it instantly (no travelling motion), per the DoD.
	_advanceMotion(inst, dt) {
		// Busy ring. Under reduced motion it holds a steady presence (no throbbing
		// opacity, no scale pulse) — a Busy citizen still reads as busy without the
		// animation the DoD says to suppress. Reads reducedMotion live so an OS
		// toggle mid-session takes effect.
		if (inst.busyRing) {
			let target;
			if (!inst.busy) target = 0;
			else if (this.reducedMotion) target = 0.6;
			else target = 0.55 + 0.25 * Math.sin((inst.busyT += dt) * 3.2);
			inst.busyRing.material.opacity += (target - inst.busyRing.material.opacity) * Math.min(1, dt * 6);
			inst.busyRing.position.set(inst.group.position.x, 0.03, inst.group.position.z);
			if (inst.busy && !this.reducedMotion) {
				inst.busyRing.scale.setScalar(1 + 0.06 * Math.sin(inst.busyT * 3.2));
			} else if (inst.busyRing.scale.x !== 1) {
				inst.busyRing.scale.setScalar(1);
			}
		}

		// Completion celebrate — a short, tasteful hop (skipped under reduced motion).
		if (inst.celebrateT != null) {
			inst.celebrateT += dt;
			const p = inst.celebrateT / CELEBRATE_SEC;
			if (p >= 1) { inst.celebrateT = null; inst.model.position.y = 0; }
			else { inst.model.position.y = Math.sin(p * Math.PI) * 0.32; }
		}

		// Walk toward the active target.
		if (inst.walkTarget) {
			const g = inst.group.position;
			const tx = inst.walkTarget.x, tz = inst.walkTarget.z;
			const dx = tx - g.x, dz = tz - g.z;
			const dist = Math.hypot(dx, dz);
			if (dist <= ARRIVE_EPS) {
				const cb = inst.onArrive;
				inst.walkTarget = null; inst.onArrive = null;
				this._playMotion(inst, 'idle');
				if (cb) cb();
			} else {
				const step = Math.min(dist, WALK_SPEED * dt);
				g.x += (dx / dist) * step;
				g.z += (dz / dist) * step;
				inst.heading = Math.atan2(dx, dz);
				this._playMotion(inst, 'walk');
				let diff = inst.heading - inst.group.rotation.y;
				while (diff > Math.PI) diff -= Math.PI * 2;
				while (diff < -Math.PI) diff += Math.PI * 2;
				inst.group.rotation.y += diff * Math.min(1, dt * TURN_RATE);
			}
		}
	}

	// Crossfade a citizen between its idle and walk clips. No-op for rigs the
	// canonical clips can't drive (the model still translates — never a T-pose).
	_playMotion(inst, motion) {
		if (inst.motion === motion || !inst.mixer || this.reducedMotion) { inst.motion = motion; return; }
		inst.motion = motion;
		if (motion === 'walk' && inst.walkClip) {
			if (!inst.walkAction) inst.walkAction = inst.mixer.clipAction(inst.walkClip);
			inst.walkAction.reset().fadeIn(0.2).play();
			inst.idleAction?.fadeOut(0.2);
		} else {
			inst.idleAction?.reset().fadeIn(0.2).play();
			inst.walkAction?.fadeOut(0.2);
		}
	}

	_buildBusyRing(accent) {
		const geo = new RingGeometry(0.46, 0.6, 40);
		geo.rotateX(-Math.PI / 2);
		const mat = new MeshBasicMaterial({ color: accent, transparent: true, opacity: 0, side: DoubleSide, depthWrite: false });
		const ring = new Mesh(geo, mat);
		ring.renderOrder = 1;
		this.scene.add(ring);
		return ring;
	}

	/** Route a citizen to a world target; onArrive fires once when reached. */
	walkTo(id, target, onArrive) {
		const inst = this._byId.get(id);
		if (!inst || !target) return;
		const tx = Number(target.x), tz = Number(target.z);
		if (!Number.isFinite(tx) || !Number.isFinite(tz)) return;
		if (this.reducedMotion) {
			// No travelling motion under reduced motion — place + settle.
			inst.group.position.x = tx; inst.group.position.z = tz;
			inst.walkTarget = null;
			if (onArrive) onArrive();
			return;
		}
		inst.walkTarget = { x: tx, z: tz };
		inst.onArrive = typeof onArrive === 'function' ? onArrive : null;
	}

	/** Reflect an economy status — Busy shows a glowing profession-coloured ring. */
	setStatus(id, status) {
		const inst = this._byId.get(id);
		if (!inst) return;
		inst.busy = status === 'Busy';
		if (inst.busy && !inst.busyRing) {
			const accent = professionColor(primaryProfessionKey(inst.citizen));
			inst.busyRing = this._buildBusyRing(accent);
		}
	}

	/** A short completion celebrate (a tasteful hop). No-op under reduced motion. */
	celebrate(id) {
		const inst = this._byId.get(id);
		if (!inst || this.reducedMotion) return;
		inst.celebrateT = 0;
	}

	/** Resolve a citizen by display name (pulse.recent carries names, not ids). */
	findByName(name) {
		if (!name) return null;
		const inst = this.instances.find((i) => i.citizen.displayName === name);
		if (!inst) return null;
		return { id: inst.citizen.id, position: this.worldPosition(inst.citizen.id) };
	}

	/**
	 * Hit-test pickable avatars. Returns the citizen id under the ray, or null.
	 * @param {import('three').Raycaster} raycaster
	 */
	pick(raycaster) {
		const hits = raycaster.intersectObjects(this.root.children, true);
		for (const h of hits) {
			let o = h.object;
			while (o) {
				if (o.userData?.citizenId) return o.userData.citizenId;
				o = o.parent;
			}
		}
		return null;
	}

	/** Move + show the selection ring under a citizen (null clears it). */
	highlight(id) {
		this._selectedId = id;
		const inst = id ? this._byId.get(id) : null;
		if (!inst) { this._ring.visible = false; return; }
		inst.group.getWorldPosition(_v);
		this._ring.position.set(_v.x, 0.02, _v.z);
		const accent = professionColor(primaryProfessionKey(inst.citizen));
		this._ring.material.color.set(accent);
		this._ring.visible = true;
	}

	get selectedId() { return this._selectedId; }

	getInstance(id) { return this._byId.get(id) || null; }

	/** World position of a citizen (for framing the camera). Null if unknown. */
	worldPosition(id) {
		const inst = this._byId.get(id);
		if (!inst) return null;
		inst.group.getWorldPosition(_v);
		return _v.clone();
	}

	get count() { return this.instances.length; }

	dispose() {
		this._disposed = true;
		for (const inst of this.instances) {
			inst.mixer?.stopAllAction();
			for (const m of inst.materials) m.dispose?.();
			inst.label.material.map?.dispose?.();
			inst.label.material.dispose?.();
			if (inst.busyRing) {
				inst.busyRing.geometry.dispose();
				inst.busyRing.material.dispose();
				this.scene.remove(inst.busyRing);
			}
			inst.group.parent?.remove(inst.group);
		}
		this.instances = [];
		this._byId.clear();
		this._ring.geometry.dispose();
		this._ring.material.dispose();
		this.scene.remove(this._ring);
		this.scene.remove(this.root);
		this._templates.clear();
	}
}

// Deterministic per-id jitter in [0,1) — keeps facing/desync stable across
// reloads (no Math.random, so the same citizen always stands the same way).
function hashJitter(seed) {
	const s = String(seed);
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return ((h >>> 0) % 100000) / 100000;
}
