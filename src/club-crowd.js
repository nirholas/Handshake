// /club crowd — fills every walk-in environment with three.ws avatars.
//
// As you walk the alley → gallery → clubhouse (src/club-entrance.js) you're no
// longer alone: each room is populated with a living crowd built from the full
// platform avatar roster — the bundled known-good rigs plus every public 3D
// avatar in the gallery (/api/explore). Each member is grounded on the room's
// floor, scaled to human height, and driven by a varied loop (idle/lean/chill
// near the entrance, dancing deeper in) so the rooms feel like a real club, not
// an empty set.
//
// Performance is the whole game here. We:
//   • retarget each clip ONCE per unique avatar GLB (via AnimationManager), then
//     reuse the resulting bound clips across every clone of that rig with a bare
//     AnimationMixer — so a room of 80 dancers costs ~N cheap mixers, not N
//     retargets;
//   • cap the head-count to the device's `crowdInstances` budget (src/club-perf.js)
//     and log when the roster is larger than the cap (no silent truncation);
//   • clone once per instance (SkeletonUtils), leave frustum culling on, cast no
//     shadows, and stagger instantiation so a swap never stalls the walk.
//
// Any failure degrades silently to a smaller (or empty) crowd — the walk-in and
// the pole stage always work without it. A rig the canonical clip library can't
// drive is skipped rather than left standing in a bind/T-pose.

import { AnimationMixer, Box3, Group, Raycaster, Vector3 } from 'three';
import { clone as cloneSkinnedScene } from 'three/addons/utils/SkeletonUtils.js';
import { gltfLoader } from './loaders/gltf.js';
import { AnimationManager } from './animation-manager.js';
import { log } from './shared/log.js';

// Clip pools, by mood. Names must exist in /animations/manifest.json; URLs are
// resolved from the manifest passed to the constructor. A missing clip is just
// dropped — the crowd falls back to whatever else retargeted on that rig.
const IDLE_CLIPS = ['idle', 'av-idle-breath', 'av-waiting', 'av-chilling', 'av-leaning-wall', 'av-listening-music', 'av-smoking'];
const DANCE_CLIPS = ['twerk', 'dance', 'rumba', 'av-dance-shuffle', 'av-rap-dance', 'av-headbang', 'av-banging-tunes', 'av-cheering', 'av-boxer-dance', 'av-offabean-dance', 'michelle-samba-dance'];
const ALL_CROWD_CLIPS = [...new Set([...IDLE_CLIPS, ...DANCE_CLIPS])];

// Public 3D avatars to pull for the crowd. Larger page than the entrance's agent
// switcher (limit=24) so a populated room shows real variety; deduped by GLB URL
// against the bundled rigs.
const CROWD_GALLERY_URL = '/api/explore?source=avatar&category=avatar&only3d=1&limit=60';

const MIN_HEIGHT = 1.6;
const MAX_HEIGHT = 1.82;
// Keep the central walk lane (spawn → door) clear so the crowd lines the route
// rather than blocking it, and don't spawn anyone on top of the player.
const CORRIDOR_HALF_WIDTH = 1.35;
const SPAWN_CLEAR = 1.7;
const MIN_SPACING = 0.85;
const WALL_INSET = 0.6; // extra margin inside the walkable bounds
// Fraction of the crowd that dances rather than idles, per room index. The
// energy ramps up as you get closer to the stage.
const DANCE_RATIO = [0.18, 0.32, 0.6];
// Don't leave a room feeling dead when the gallery is unreachable — cycle the
// bundled rigs up to this floor (still capped by the device budget).
const LIVELY_FLOOR = 9;

const DOWN = new Vector3(0, -1, 0);
const _box = new Box3();
const _origin = new Vector3();

function scaleToHeight(obj, h) {
	_box.setFromObject(obj, true);
	const cur = _box.max.y - _box.min.y || 1;
	obj.scale.multiplyScalar(h / cur);
}
function groundFeet(obj) {
	_box.setFromObject(obj, true);
	if (Number.isFinite(_box.min.y)) obj.position.y -= _box.min.y;
}

function shuffle(arr) {
	const a = arr.slice();
	for (let i = a.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[a[i], a[j]] = [a[j], a[i]];
	}
	return a;
}

// Distance from point (px,pz) to the segment a→b in the XZ plane.
function distToSegmentXZ(px, pz, ax, az, bx, bz) {
	const dx = bx - ax, dz = bz - az;
	const len2 = dx * dx + dz * dz;
	let t = len2 > 1e-6 ? ((px - ax) * dx + (pz - az) * dz) / len2 : 0;
	t = Math.max(0, Math.min(1, t));
	const cx = ax + dx * t, cz = az + dz * t;
	return Math.hypot(px - cx, pz - cz);
}

function dedupeRoster(list) {
	const seen = new Set();
	const out = [];
	for (const a of list) {
		if (!a?.url || seen.has(a.url)) continue;
		seen.add(a.url);
		out.push({ name: a.name || 'Avatar', url: a.url });
	}
	return out;
}

export class ClubCrowd {
	/**
	 * @param {object} opts
	 * @param {import('three').WebGLRenderer} opts.renderer
	 * @param {import('three').Scene} opts.scene
	 * @param {Array} opts.manifest               animation manifest (name→url defs)
	 * @param {number} opts.max                   per-room instance cap (crowdInstances)
	 * @param {Array<{name:string,url:string}>} [opts.bundled]  guaranteed offline rigs
	 */
	constructor({ renderer, scene, manifest, max, bundled = [] }) {
		this.scene = scene;
		this.loader = gltfLoader(renderer);
		this.max = Math.max(0, Math.floor(max) || 0);
		this.raycaster = new Raycaster();

		// name → clip URL, for the pools we actually use.
		this._clipUrls = new Map();
		const defs = Array.isArray(manifest) ? manifest : [];
		for (const name of ALL_CROWD_CLIPS) {
			const def = defs.find((d) => d?.name === name);
			if (def?.url) this._clipUrls.set(name, def.url);
		}

		// Parsed clip JSON, fetched once and shared across every template.
		this._clipJson = new Map();     // name → parsed AnimationClip JSON
		this._clipJsonReady = null;     // Promise

		// url → Promise<{ scene, clips: Map<name, retargetedClip>, drivable }>
		this._templates = new Map();

		this._roster = dedupeRoster(bundled);
		this._rosterLoaded = false;

		// Current room: a fresh Group per mount, tracked so a swap disposes the
		// previous crowd. `_gen` cancels an in-flight async populate when the room
		// changes underneath it.
		this._root = null;
		this._instances = [];
		this._placed = [];     // {x,z} of placed members, for spacing checks
		this._gen = 0;
		this._disposed = false;
	}

	/** Kick off the gallery roster + clip fetches. Safe to call repeatedly. */
	async load() {
		this._ensureClips();
		if (this._rosterLoaded) return;
		this._rosterLoaded = true;
		try {
			const res = await fetch(CROWD_GALLERY_URL, { headers: { accept: 'application/json' } });
			if (res.ok) {
				const data = await res.json();
				const items = Array.isArray(data?.items) ? data.items : [];
				const extra = items
					.filter((it) => it?.glbUrl && it.has3d !== false && it.kind === 'avatar')
					.map((it) => ({ name: it.name || 'Avatar', url: it.glbUrl }));
				this._roster = dedupeRoster([...this._roster, ...extra]);
			}
		} catch (err) {
			log.warn('[club-crowd] gallery roster fetch failed', err);
		}
	}

	_ensureClips() {
		if (this._clipJsonReady) return this._clipJsonReady;
		const entries = [...this._clipUrls.entries()];
		this._clipJsonReady = Promise.all(entries.map(async ([name, url]) => {
			try {
				const r = await fetch(url, { cache: 'force-cache' });
				if (r.ok) this._clipJson.set(name, await r.json());
			} catch (err) {
				log.warn(`[club-crowd] clip "${name}" fetch failed`, err);
			}
		})).then(() => this._clipJson);
		return this._clipJsonReady;
	}

	/**
	 * Load a unique avatar GLB once and produce its reusable, retargeted clips.
	 * Returns { scene, clips, drivable }. `clips` maps each crowd clip name to a
	 * bound AnimationClip whose tracks are keyed by this rig's node names — those
	 * names are identical on every SkeletonUtils.clone, so the clips drive any
	 * clone via a plain AnimationMixer (no per-instance retarget).
	 */
	_template(url) {
		if (this._templates.has(url)) return this._templates.get(url);
		const p = (async () => {
			await this._ensureClips();
			const gltf = await this.loader.loadAsync(url);
			const root = gltf.scene;
			root.traverse((n) => {
				if (!n.isMesh) return;
				n.castShadow = false;
				n.receiveShadow = false;
			});
			// Retarget against a throwaway clone so the shared template stays pristine.
			const ref = cloneSkinnedScene(root);
			const mgr = new AnimationManager();
			mgr.attach(ref, { avatarUrl: url });
			const clips = new Map();
			if (mgr.supportsCanonicalClips()) {
				for (const [name, json] of this._clipJson) {
					mgr.injectClip(name, json, { loop: true });
					const clip = mgr.actions.get(name)?.getClip?.();
					if (clip) clips.set(name, clip);
				}
			}
			mgr.detach();
			return { scene: root, clips, drivable: clips.size > 0 };
		})().catch((err) => {
			log.warn('[club-crowd] template load failed', url, err);
			return { scene: null, clips: new Map(), drivable: false };
		});
		this._templates.set(url, p);
		return p;
	}

	/**
	 * Populate a freshly-mounted environment. Clears the previous room's crowd,
	 * then scatters up to `max` avatars across the floor, clear of the walk lane.
	 *
	 * @param {object} ctx
	 * @param {import('three').Object3D} ctx.envRoot  the mounted environment group (for floor rays)
	 * @param {{minX:number,maxX:number,minZ:number,maxZ:number}} ctx.bounds  walkable bounds
	 * @param {{spawn:import('three').Vector3, door:import('three').Vector3}} ctx.path
	 * @param {number} ctx.roomIndex
	 */
	mount({ envRoot, bounds, path, roomIndex = 0 }) {
		if (this._disposed || this.max <= 0) return;
		this.clear();
		const gen = ++this._gen;
		const root = new Group();
		root.name = 'club-crowd';
		this.scene.add(root);
		this._root = root;
		this._populate({ gen, root, envRoot, bounds, path, roomIndex })
			.catch((err) => log.warn('[club-crowd] populate failed', err));
	}

	async _populate({ gen, root, envRoot, bounds, path, roomIndex }) {
		await this.load();
		if (gen !== this._gen) return; // room swapped while we were fetching

		// Build the target roster: as many distinct avatars as the budget allows,
		// shuffled so each room differs. If the live roster is thin (gallery down),
		// cycle the bundled rigs up to a lively floor so the room never feels dead.
		const distinct = shuffle(this._roster);
		const targets = distinct.slice(0, this.max);
		const floor = Math.min(this.max, LIVELY_FLOOR);
		for (let i = 0; targets.length < floor && distinct.length; i++) {
			targets.push(distinct[i % distinct.length]);
		}
		if (this._roster.length > this.max) {
			log.info(`[club-crowd] roster ${this._roster.length} exceeds budget ${this.max} — showing ${this.max} this room`);
		}

		const danceRatio = DANCE_RATIO[Math.min(roomIndex, DANCE_RATIO.length - 1)] ?? 0.3;

		for (let i = 0; i < targets.length; i++) {
			if (gen !== this._gen) return;
			const spot = this._pickSpot(envRoot, bounds, path);
			if (!spot) break; // room is full / no clear floor left
			const tpl = await this._template(targets[i].url);
			if (gen !== this._gen) return;
			if (!tpl?.scene || !tpl.drivable) continue; // skip undrivable rigs (no T-pose crowd)

			const wantDance = Math.random() < danceRatio;
			this._spawn(root, tpl, spot, path, wantDance);
			this._placed.push({ x: spot.x, z: spot.z });

			// Yield between members so a large room fills progressively instead of
			// stalling the walk on one heavy frame.
			if ((i & 3) === 3) await new Promise((r) => setTimeout(r, 0));
		}
	}

	// Find a clear floor point: inside the bounds, off the walk lane, away from
	// the spawn, and not on top of another crowd member. Null when none found.
	_pickSpot(envRoot, bounds, path) {
		const minX = bounds.minX + WALL_INSET, maxX = bounds.maxX - WALL_INSET;
		const minZ = bounds.minZ + WALL_INSET, maxZ = bounds.maxZ - WALL_INSET;
		if (maxX <= minX || maxZ <= minZ) return null;
		for (let tries = 0; tries < 48; tries++) {
			const x = minX + Math.random() * (maxX - minX);
			const z = minZ + Math.random() * (maxZ - minZ);
			if (distToSegmentXZ(x, z, path.spawn.x, path.spawn.z, path.door.x, path.door.z) < CORRIDOR_HALF_WIDTH) continue;
			if (Math.hypot(x - path.spawn.x, z - path.spawn.z) < SPAWN_CLEAR) continue;
			let tooClose = false;
			for (const p of this._placed) {
				if (Math.hypot(x - p.x, z - p.z) < MIN_SPACING) { tooClose = true; break; }
			}
			if (tooClose) continue;
			const y = this._sampleFloor(envRoot, x, z);
			return { x, z, y };
		}
		return null;
	}

	// Cast straight down from waist height through the floor band — the same
	// strategy the player floor tracker uses — so sculpture/arch tops aren't hit.
	_sampleFloor(envRoot, x, z) {
		this.raycaster.set(_origin.set(x, 1.2, z), DOWN);
		this.raycaster.far = 1.6;
		const hit = this.raycaster.intersectObject(envRoot, true)[0];
		return hit ? Math.max(0, hit.point.y) : 0;
	}

	_spawn(root, tpl, spot, path, wantDance) {
		const clip = this._pickClip(tpl, wantDance);
		const model = cloneSkinnedScene(tpl.scene);
		model.traverse((n) => { if (n.isMesh) n.castShadow = false; });
		scaleToHeight(model, MIN_HEIGHT + Math.random() * (MAX_HEIGHT - MIN_HEIGHT));
		groundFeet(model);

		const group = new Group();
		group.add(model);
		group.position.set(spot.x, spot.y, spot.z);
		// Face roughly toward the walk lane (a crowd watching the route) with jitter;
		// dancers spin off in any direction.
		const cx = (path.spawn.x + path.door.x) / 2;
		const cz = (path.spawn.z + path.door.z) / 2;
		const faceYaw = Math.atan2(cx - spot.x, cz - spot.z);
		group.rotation.y = wantDance
			? Math.random() * Math.PI * 2
			: faceYaw + (Math.random() - 0.5) * 1.1;
		root.add(group);

		let mixer = null;
		if (clip) {
			mixer = new AnimationMixer(model);
			const action = mixer.clipAction(clip);
			action.time = Math.random() * (clip.duration || 1); // desync the loop
			action.play();
		}
		this._instances.push({ group, mixer, model });
	}

	_pickClip(tpl, wantDance) {
		const pool = wantDance ? DANCE_CLIPS : IDLE_CLIPS;
		const avail = pool.filter((n) => tpl.clips.has(n));
		const pick = avail.length ? avail[Math.floor(Math.random() * avail.length)] : null;
		// Always fall back to a held clip so the member is never a static T-pose.
		const name = pick || (tpl.clips.has('idle') ? 'idle' : [...tpl.clips.keys()][0]);
		return name ? tpl.clips.get(name) : null;
	}

	/** Advance every crowd member's loop. Cheap — one mixer.update per member. */
	update(dt) {
		for (const inst of this._instances) inst.mixer?.update(dt);
	}

	/** Tear down the current room's crowd (called on every venue swap). */
	clear() {
		this._gen++; // cancel any in-flight populate
		for (const inst of this._instances) {
			inst.mixer?.stopAllAction();
			// Clones share geometry + materials with the cached template
			// (SkeletonUtils.clone) — disposing them would corrupt every other
			// clone and the template, so we only unparent.
			inst.group.parent?.remove(inst.group);
		}
		this._instances = [];
		this._placed = [];
		if (this._root) {
			this.scene.remove(this._root);
			this._root = null;
		}
	}

	dispose() {
		this._disposed = true;
		this.clear();
		this._templates.clear();
	}
}
