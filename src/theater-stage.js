// Live Trading Theater — the shared 3D stage.
//
// A single Three.js scene holds every staged agent as a real 3D avatar, arranged
// in a tiered arc so the highest-reputation performers stand center-front. When a
// REAL on-chain event for an agent lands (driven from src/theater-feed.js, which
// tails the same Redis-backed feed every surface uses), that agent's avatar plays
// a one-shot performance and a real receipt rises above it with an explorer link.
//
// No timers fake activity here: this module only animates when the controller
// hands it a real, already-confirmed event. The idle loop is the only ambient
// motion, and it's the pre-baked canonical clip every avatar shares.
//
// Reuses the platform primitives rather than rebuilding them:
//   • gltfLoader(renderer)         — shared Draco/KTX2/Meshopt loader
//   • AnimationManager             — retargets the canonical clip library onto any rig
//   • agentAvatarGlb(agent)        — resolves a real GLB (custom or mannequin fallback)
// so a brand-new agent with no custom body still renders as a real figure, never a
// T-pose (CLAUDE.md: no rig allowlist, mannequin is the designed fallback).
//
// Rigged avatars only. The stage is a performance space — every body must be able
// to act. A resolved avatar earns the stage only if it's a drivable humanoid rig
// with sane proportions; a static forge prop, a non-humanoid mesh, or a broken rig
// is swapped for the rigged mannequin at load time and never staged as-is. That's
// what stops a forge blob from sprawling across the floor instead of standing as a
// figure that can idle and react.

import {
	Scene,
	PerspectiveCamera,
	WebGLRenderer,
	Group,
	Box3,
	Vector3,
	Color,
	Fog,
	HemisphereLight,
	DirectionalLight,
	SpotLight,
	PointLight,
	CircleGeometry,
	RingGeometry,
	CylinderGeometry,
	BoxGeometry,
	PlaneGeometry,
	MeshStandardMaterial,
	MeshBasicMaterial,
	Mesh,
	Raycaster,
	Vector2,
	SRGBColorSpace,
	ACESFilmicToneMapping,
	DoubleSide,
} from 'three';
import { clone as cloneSkinnedScene } from 'three/addons/utils/SkeletonUtils.js';
import { gltfLoader, disposeGltfLoader } from './loaders/gltf.js';
import { AnimationManager } from './animation-manager.js';
import { agentAvatarGlb, MANNEQUIN_GLB } from './shared/agent-3d.js';
import { log } from './shared/log.js';
import { loadEnvironment } from './shared/cinematic-render.js';

// Reaction vocabulary mapped onto the real pre-baked clip library
// (public/animations/manifest.json). Each kind picks deterministically from its
// pool so the same agent reacting to the same event type looks consistent.
const REACTIONS = {
	win:    ['celebrate', 'av-celebrating', 'av-joy', 'av-cheering'],
	buy:    ['av-cheering', 'celebrate', 'av-joy'],
	launch: ['av-celebrating', 'celebrate', 'av-joy'],
	verify: ['wave', 'av-cheering'],
	pay:    ['av-cheering', 'wave'],
	loss:   ['defeated', 'reaction'],
	taunt:  ['taunt', 'reaction'],
	guard:  ['reaction', 'defeated'], // a safety refusal — the trader waves the bad trade off
};
const ALL_REACTION_CLIPS = [...new Set(Object.values(REACTIONS).flat())];

// Distinct rigged bodies for agents that don't ship their own avatar. A trading
// floor of identical mannequins reads as clones, so each avatar-less agent is
// dressed in a different humanoid rig from this pool — assigned round-robin so no
// two adjacent desks match. Every entry is a rigged humanoid that drives the
// canonical clips; anything that fails the rig gate still falls back to the
// mannequin (rare), it just costs one repeat rather than a T-pose.
// Distinct Avaturn / Mixamo rigged HUMANS — each a different person, all carrying
// the canonical (Avaturn) skeleton so they retarget the clip library cleanly and
// never detonate. Ordered lightest first so the most-visible front desks paint
// fast. cesium-man's odd 22-bone rig (the earlier "blob") is deliberately out.
const FALLBACK_RIGS = [
	'/avatars/cz.glb',                // ~0.6 MB, Avaturn
	'/avatars/default.glb',           // ~0.7 MB, Avaturn (platform default)
	'/avatars/xbot.glb',              // ~2.9 MB, Mixamo
	'/avatars/michelle.glb',          // ~3.2 MB, Mixamo
	'/avatars/realistic-female.glb',  // ~5.7 MB, Avaturn
	'/avatars/realistic-halfbody.glb',// ~5.9 MB, Avaturn (behind a desk = fine)
];

// A distinct, deterministic colour per desk index (golden-angle hue walk) so that
// even two desks wearing the same fallback rig never look identical — the last
// line of defence for "no two the same" once the small rig pool repeats.
function fbHue(i) { return (i * 0.6180339887) % 1; }
function tintModel(model, hue) {
	if (hue == null) return;
	const col = new Color().setHSL(hue, 0.5, 0.56);
	model.traverse((n) => {
		if (!n.isMesh || !n.material) return;
		// Clone before recolouring — the cloned scene shares materials with the
		// cached template, so mutating in place would tint every other instance too.
		const one = (m) => { const c = m.clone(); if (c.color) c.color.copy(col); return c; };
		n.material = Array.isArray(n.material) ? n.material.map(one) : one(n.material);
	});
}

// The colour a trader's monitor flashes for each event — green on a fill, violet
// on a verify/pay, amber when a safety rule refuses a buy. The resting glow is a
// dim blue so a room of idle desks still reads as "screens on, market open".
const SCREEN_IDLE = 0x38507f;
const SCREEN_REST = 0.75; // resting emissive so a room of idle desks reads as "screens on"
const SCREEN_FLASH = {
	buy: 0x22c55e, win: 0x22c55e, launch: 0x22c55e,
	verify: 0x8b5cf6, pay: 0x8b5cf6,
	loss: 0xf59e0b, guard: 0xf59e0b,
};

// Clips every performer registers. `idle` loops as the resting state; the rest
// are one-shots loaded lazily on first reaction so startup only fetches idle.
const CLIP_DEFS = [
	{ name: 'idle', url: '/animations/clips/idle.json', loop: true },
	...ALL_REACTION_CLIPS.map((name) => ({ name, url: `/animations/clips/${name}.json`, loop: false })),
];

const _box = new Box3();
const _v = new Vector3();
const _v2 = new Vector3();

function scaleToHeight(obj, h) {
	_box.setFromObject(obj, true);
	const cur = _box.max.y - _box.min.y || 1;
	obj.scale.multiplyScalar(h / cur);
}
function groundFeet(obj) {
	_box.setFromObject(obj, true);
	if (Number.isFinite(_box.min.y)) obj.position.y -= _box.min.y;
}

// Deterministic small hash so a given agent id always picks the same reaction
// from a pool (stable performances across reconnects).
function hashPick(arr, key) {
	let h = 0;
	const s = String(key || '');
	for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
	return arr[Math.abs(h) % arr.length];
}

/**
 * Dealing-room layout: even rows of workstations facing the camera, like desks in
 * a trading pit. Partial last row is centred. Returns { x, z, scale, row }.
 */
function deskSlot(index, total) {
	const perRow = total <= 6 ? 3 : total <= 10 ? 4 : 5;
	const row = Math.floor(index / perRow);
	const inRow = index % perRow;
	const rowItems = Math.min(perRow, total - row * perRow);
	// Stagger alternating rows by half a column so back desks peek between the
	// front ones (an auditorium pit) instead of hiding directly behind them — this
	// also stops the projected nameplates from colliding.
	const stagger = (row % 2) * 1.5;
	const x = (inRow - (rowItems - 1) / 2) * 3.0 + stagger;
	const z = -1.5 - row * 2.6; // rows recede from the camera
	const scale = Math.max(0.9, 1 - row * 0.035);
	return { x, z, scale, row };
}

export function createStage({ canvas, overlay, onSelect, reducedMotion = false, environmentUrl = null }) {
	const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
	renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
	renderer.outputColorSpace = SRGBColorSpace;
	renderer.toneMapping = ACESFilmicToneMapping;
	renderer.toneMappingExposure = 1.12;

	const scene = new Scene();
	scene.fog = new Fog(0x05050a, 16, 46);

	// Real HDRI image-based lighting so the desks' PBR materials (screens,
	// metal trim, avatar skin) pick up believable reflections instead of
	// flat directional-light-only shading. Falls back to a procedural room
	// environment internally on fetch failure, so this never blocks the stage.
	loadEnvironment(renderer, scene, 'studio');

	// A dealing-room vantage: raised and pulled back so several rows of desks read
	// as a room, not a line-up. Looks slightly down into the pit.
	const CAM_BASE_Z = 10.4;
	const camera = new PerspectiveCamera(42, 1, 0.1, 200);
	camera.position.set(0, 2.5, CAM_BASE_Z);
	camera.lookAt(0, 1.05, -3.4);

	// Lighting — a cool key from above the audience plus a warm rim so avatars
	// read against the near-black backdrop. Violet accent matches the finance tokens.
	scene.add(new HemisphereLight(0xaab4ff, 0x0a0a12, 0.9));
	const key = new DirectionalLight(0xffffff, 1.5);
	key.position.set(3, 9, 6);
	scene.add(key);
	const rim = new DirectionalLight(0x8b5cf6, 0.8);
	rim.position.set(-5, 4, -6);
	scene.add(rim);
	const spot = new SpotLight(0xc4b5fd, 1.6, 30, Math.PI / 5, 0.4, 1.2);
	spot.position.set(0, 11, 4);
	spot.target.position.set(0, 0, -1);
	scene.add(spot);
	scene.add(spot.target);

	// Stage floor — a dark reflective-feeling disc with a violet ring horizon.
	const floor = new Mesh(
		new CircleGeometry(22, 64),
		new MeshStandardMaterial({ color: 0x0b0b14, roughness: 0.62, metalness: 0.35 }),
	);
	floor.rotation.x = -Math.PI / 2;
	floor.position.y = 0;
	scene.add(floor);
	const ring = new Mesh(
		new RingGeometry(7.6, 7.9, 96),
		new MeshBasicMaterial({ color: 0x8b5cf6, transparent: true, opacity: 0.28, side: DoubleSide }),
	);
	ring.rotation.x = -Math.PI / 2;
	ring.position.y = 0.01;
	scene.add(ring);

	// Procedural dealing-room shell — a big back-wall board and side glow so the
	// desks sit in a room, not a void. A supplied `environmentUrl` GLB drops in
	// behind the desks as a richer backdrop; the desks themselves are always ours
	// so every workstation lands at a known, data-driven spot.
	const board = new Mesh(
		new PlaneGeometry(22, 6),
		new MeshStandardMaterial({ color: 0x07070e, emissive: new Color(0x160f2e), emissiveIntensity: 0.7, roughness: 0.9, metalness: 0.1 }),
	);
	board.position.set(0, 3.4, -16);
	scene.add(board);
	const boardEdge = new Mesh(
		new PlaneGeometry(22, 0.08),
		new MeshBasicMaterial({ color: 0x8b5cf6, transparent: true, opacity: 0.5 }),
	);
	boardEdge.position.set(0, 0.9, -15.98);
	scene.add(boardEdge);

	if (environmentUrl) {
		gltfLoader(renderer)
			.loadAsync(environmentUrl)
			.then((gltf) => { if (!disposed) { gltf.scene.position.set(0, 0, 0); scene.add(gltf.scene); } })
			.catch((err) => log.warn('[theater] environment load failed', environmentUrl, err?.message));
	}

	// Shared desk material — one instance across every workstation (never disposed
	// per-performer, only at teardown).
	const deskMat = new MeshStandardMaterial({ color: 0x20202e, roughness: 0.6, metalness: 0.4 });

	// Group that holds all performers + their desks so a gentle sway moves the room
	// as one (a full spin would look wrong for a room; this is a subtle drift).
	const cast = new Group();
	scene.add(cast);

	const loader = gltfLoader(renderer);
	const templates = new Map(); // glbUrl → Promise<{ scene }>
	const performers = new Map(); // agentId → performer record
	const receipts = []; // floating DOM receipts anchored to world points

	let disposed = false;
	let raf = 0;
	let last = performance.now();
	let autoOrbit = !reducedMotion;
	let orbitYaw = 0;
	let swayT = 0;
	let highlightId = null;
	let lastExplodeCheck = 0;
	// A humanoid — even mid-celebration with arms overhead — never exceeds a couple
	// of metres. A retargeted skin that detonates balloons far past this, so any
	// performer whose animated body crosses it is swapped to the clean mannequin.
	const EXPLODE_LIMIT = 5;

	// Build a workstation (desk + monitor) in front of a performer, toward the
	// camera, so the trader stands behind a lit terminal. The monitor's emissive
	// screen is the state light: a resting blue glow, flashing on a real event.
	function buildWorkstation(slot) {
		const s = slot.scale;
		const g = new Group();
		g.position.set(slot.x, 0, slot.z + 1.02 * s); // desk between the trader and the camera
		// A slim desktop on a thin plinth reads as a trading desk, not a coffin.
		const top = new Mesh(new BoxGeometry(1.5 * s, 0.08 * s, 0.62 * s), deskMat);
		top.position.y = 0.74 * s;
		g.add(top);
		const plinth = new Mesh(new BoxGeometry(1.28 * s, 0.7 * s, 0.42 * s), deskMat);
		plinth.position.y = 0.37 * s;
		g.add(plinth);
		// The monitor: a dark bezel framing a bright emissive screen on a thin stalk,
		// tilted up toward the camera so the state colour is the readable thing. Kept
		// low enough that the trader's head and shoulders read above it.
		const bezel = new Mesh(new BoxGeometry(0.96 * s, 0.56 * s, 0.05 * s), deskMat);
		bezel.position.set(0, 1.0 * s, -0.05 * s);
		bezel.rotation.x = -0.12;
		g.add(bezel);
		const screenMat = new MeshStandardMaterial({
			color: 0x0a1120, emissive: new Color(SCREEN_IDLE), emissiveIntensity: SCREEN_REST, roughness: 0.4, metalness: 0.05,
		});
		const monitor = new Mesh(new BoxGeometry(0.84 * s, 0.44 * s, 0.05 * s), screenMat);
		monitor.position.set(0, 1.0 * s, -0.02 * s);
		monitor.rotation.x = -0.12;
		g.add(monitor);
		const stalk = new Mesh(new BoxGeometry(0.06 * s, 0.2 * s, 0.06 * s), deskMat);
		stalk.position.set(0, 0.78 * s, -0.05 * s);
		g.add(stalk);
		cast.add(g);
		return { deskGroup: g, screenMat };
	}

	// Flash a performer's monitor for a real event, then it eases back to rest in
	// the render loop. A no-op under reduced motion (the resting glow stays).
	function flashScreen(rec, kind) {
		if (!rec.screenMat || reducedMotion) return;
		rec.screenMat.emissive.setHex(SCREEN_FLASH[kind] ?? SCREEN_FLASH.buy);
		rec.screenMat.emissiveIntensity = 1.35;
		rec.screenFlash = performance.now() + 1300;
	}

	// ── Avatar templates ────────────────────────────────────────────────────────
	function template(url) {
		if (templates.has(url)) return templates.get(url);
		const p = loader
			.loadAsync(url)
			.then((gltf) => {
				gltf.scene.traverse((n) => { if (n.isMesh) { n.frustumCulled = true; n.castShadow = false; } });
				return { scene: gltf.scene };
			})
			.catch((err) => {
				log.warn('[theater] template load failed', url, err?.message);
				return { scene: null };
			});
		templates.set(url, p);
		return p;
	}

	// Build a candidate body from a GLB url: clone it, size it to the stage, and
	// attach the canonical animation rig. Reports whether the result is a rigged,
	// sanely-proportioned humanoid we can actually drive — the gate that keeps
	// static forge props and exploded rigs off the stage. Returns null if the GLB
	// has no usable scene. The returned body is not yet parented to the scene, so
	// a rejected candidate can be disposed without any teardown of live state.
	async function buildBody(url, slot) {
		const tpl = await template(url);
		if (!tpl.scene) return null;

		const model = cloneSkinnedScene(tpl.scene);
		model.traverse((n) => { if (n.isMesh) n.frustumCulled = true; });
		scaleToHeight(model, 1.74 * slot.scale);
		groundFeet(model);

		const anim = new AnimationManager();
		let drivable = false;
		try {
			anim.attach(model, { avatarUrl: url });
			anim.setAnimationDefs(CLIP_DEFS);
			drivable = anim.supportsCanonicalClips();
		} catch (err) {
			log.warn('[theater] anim attach failed', url, err?.message);
		}

		// Proportion sanity: a rigged avatar occupies a tall, narrow box (even arms
		// fully out, span ≈ height). A forge prop or a mesh exploded by a bad rig
		// sprawls far wider — reject it so it can never reach the stage as a blob.
		_box.setFromObject(model, true);
		const h = _box.max.y - _box.min.y || 1;
		const wide = Math.max(_box.max.x - _box.min.x, _box.max.z - _box.min.z);
		const humanoid = Number.isFinite(wide) && wide / h <= 3;

		return { model, anim, drivable: drivable && humanoid };
	}

	async function addPerformer(agent, index, total, fallbackRig = null, tintHue = null) {
		if (disposed || performers.has(agent.id)) return;
		const slot = deskSlot(index, total);
		const fbRig = fallbackRig || MANNEQUIN_GLB;

		// The agent's own rigged avatar wins ONLY when it actually drives the clips.
		// Everything else — an avatar-less agent, or a custom avatar that can't be
		// rigged (a forge mesh, which is most of them) — becomes this desk's ASSIGNED
		// fallback rig, tinted a unique colour, so no two desks ever look the same.
		// Forge avatars are static text-to-3D meshes (no skeleton) — trying them is a
		// wasted multi-MB download that always fails the rig gate, so skip straight to
		// the assigned Avaturn rig. Only a genuinely riggable custom avatar is tried.
		const realUrl = agentAvatarGlb(agent);
		const tryReal = realUrl !== MANNEQUIN_GLB && !/\/forge\//.test(realUrl);
		let body = tryReal ? await buildBody(realUrl, slot) : null;
		if (disposed || performers.has(agent.id)) { body?.anim?.dispose?.(); return; }
		if (!body || !body.drivable) {
			body?.anim?.dispose?.();
			body = await buildBody(fbRig, slot);
			if (disposed || performers.has(agent.id)) { body?.anim?.dispose?.(); return; }
			if ((!body || !body.drivable) && fbRig !== MANNEQUIN_GLB) {
				body?.anim?.dispose?.();
				body = await buildBody(MANNEQUIN_GLB, slot);
				if (disposed || performers.has(agent.id)) { body?.anim?.dispose?.(); return; }
				// Only a bare mannequin gets a unique tint (so the rare fallback-of-a-
				// fallback still reads distinct); the Avaturn humans render as-is.
				if (body?.model) tintModel(body.model, tintHue);
			}
		}
		if (!body || !body.model) return;

		const { model, anim, drivable } = body;

		const group = new Group();
		group.name = `performer:${agent.id}`;
		group.add(model);
		group.position.set(slot.x, 0, slot.z);
		group.rotation.y = (Math.atan2(-group.position.x, (CAM_BASE_Z + 2) - group.position.z) || 0) * 0.3; // face the camera / pit
		group.userData.agentId = agent.id;
		cast.add(group);

		// The trader's workstation — desk + lit monitor in front of them.
		const { deskGroup, screenMat } = buildWorkstation(slot);

		// A soft contact shadow grounds the figure on the floor — always faintly
		// present so no performer ever reads as floating (the flat disc used to make
		// bodies look like they hovered). Sits just under the highlight pad.
		const shadow = new Mesh(
			new CircleGeometry(0.62, 40),
			new MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.34, side: DoubleSide, depthWrite: false }),
		);
		shadow.rotation.x = -Math.PI / 2;
		shadow.position.set(slot.x, 0.012, slot.z);
		shadow.renderOrder = -1;
		cast.add(shadow);

		// A soft pedestal glow under each performer; brightens when highlighted.
		const pad = new Mesh(
			new CircleGeometry(0.78, 40),
			new MeshBasicMaterial({ color: 0x8b5cf6, transparent: true, opacity: 0.0, side: DoubleSide }),
		);
		pad.rotation.x = -Math.PI / 2;
		pad.position.set(slot.x, 0.02, slot.z);
		cast.add(pad);

		if (drivable && !reducedMotion) anim.play('idle');

		const rec = { agent, group, model, pad, shadow, deskGroup, screenMat, anim, drivable, slot, fallbackRig: fbRig, tintHue, busy: false, plate: null };
		rec.plate = makePlate(rec, index);
		performers.set(agent.id, rec);
	}

	// A projected DOM nameplate over each performer: shows who's on stage (the
	// bodies are otherwise anonymous), and IS the primary hit target — a real
	// keyboard-focusable button, far more reliable to click than a posed skinned
	// mesh, and accessible on touch. The body raycast stays as a secondary path.
	function makePlate(rec, index) {
		const btn = document.createElement('button');
		btn.className = 'th-plate';
		btn.type = 'button';
		btn.tabIndex = 0;
		btn.setAttribute('aria-label', `${rec.agent.name || 'Agent'} — open details`);
		const name = document.createElement('span');
		name.className = 'th-plate-name';
		name.textContent = rec.agent.name || 'Agent';
		btn.appendChild(name);
		if (Number.isFinite(rec.agent.score)) {
			const pip = document.createElement('span');
			pip.className = 'th-plate-score';
			pip.textContent = String(Math.round(rec.agent.score));
			btn.appendChild(pip);
		}
		btn.addEventListener('click', (e) => { e.stopPropagation(); onSelect?.(rec.agent.id); });
		overlay.appendChild(btn);
		return btn;
	}

	/**
	 * Reconcile the staged cast with a new roster (room switch / refresh). Removes
	 * performers no longer present and adds new ones, preserving any that stay.
	 */
	async function setRoster(agents) {
		const keep = new Set(agents.map((a) => a.id));
		for (const [id, rec] of [...performers]) {
			if (!keep.has(id)) removePerformer(id, rec);
		}
		// Reserve a distinct fallback rig + a unique colour for every desk by index.
		// A desk uses them only if the agent's own avatar can't be rigged (which, for
		// forge avatars, is nearly always) — but reserving by index guarantees the
		// hues never collide, so no two fallback desks are identical.
		// Add sequentially with a micro-yield so a full room fills progressively
		// instead of stalling one frame on a dozen GLB clones.
		for (let i = 0; i < agents.length; i++) {
			if (disposed) return;
			await addPerformer(agents[i], i, agents.length, FALLBACK_RIGS[i % FALLBACK_RIGS.length], fbHue(i));
			if ((i & 3) === 3) await new Promise((r) => setTimeout(r, 0));
		}
	}

	// A rig detonated under animation — hide the wreck and hot-swap the clean
	// mannequin into the same desk so the floor never shows a blob. Idempotent per
	// performer via `_fixing`. The desk/plate/shadow stay; only the body changes.
	async function neutralizeExploded(rec) {
		if (rec._fixing) return;
		rec._fixing = true;
		rec.model.visible = false;
		try { rec.anim?.dispose?.(); } catch {}
		rec.drivable = false;
		// Rebuild as the MANNEQUIN (the one rig that never detonates) tinted this
		// desk's unique colour. Rebuilding as the assigned fallback rig would loop
		// forever if that rig is itself the exploder; a uniquely-tinted mannequin
		// still keeps the desk distinct from every neighbour.
		const body = await buildBody(MANNEQUIN_GLB, rec.slot);
		if (disposed || !performers.has(rec.agent.id) || !body?.model) { body?.anim?.dispose?.(); return; }
		tintModel(body.model, rec.tintHue);
		const old = rec.model;
		rec.group.remove(old);
		old.traverse?.((n) => { if (n.isMesh) { n.geometry?.dispose?.(); disposeMaterial(n.material); } });
		rec.group.add(body.model);
		rec.model = body.model;
		rec.anim = body.anim;
		rec.drivable = body.drivable;
		if (rec.drivable && !reducedMotion) rec.anim.play('idle');
		rec._fixing = false;
	}

	function removePerformer(id, rec) {
		performers.delete(id);
		try { rec.anim?.dispose?.(); } catch {}
		rec.plate?.remove();
		rec.group?.parent?.remove(rec.group);
		rec.pad?.parent?.remove(rec.pad);
		if (rec.shadow) { rec.shadow.parent?.remove(rec.shadow); rec.shadow.geometry?.dispose?.(); disposeMaterial(rec.shadow.material); }
		if (rec.deskGroup) {
			// Dispose the desk's geometries + this desk's own screen material, but NOT
			// the shared deskMat (reused across every workstation, freed at teardown).
			rec.deskGroup.parent?.remove(rec.deskGroup);
			rec.deskGroup.traverse((n) => { if (n.isMesh) n.geometry?.dispose?.(); });
			rec.screenMat?.dispose?.();
		}
		rec.group?.traverse?.((n) => {
			if (n.isMesh) { n.geometry?.dispose?.(); disposeMaterial(n.material); }
		});
	}

	function disposeMaterial(m) {
		if (!m) return;
		(Array.isArray(m) ? m : [m]).forEach((x) => x?.dispose?.());
	}

	// ── Performances ─────────────────────────────────────────────────────────────
	/**
	 * Trigger a real performance for an agent. `kind` selects the reaction pool;
	 * `receipt` (optional) is a DOM node that rises above the avatar and fades.
	 * No-op if the agent isn't staged — the controller still shows it in the ticker.
	 */
	function perform(agentId, { kind = 'win', receipt = null } = {}) {
		const rec = performers.get(agentId);
		if (!rec) { if (receipt) attachReceiptToCenter(receipt); return false; }
		if (rec.drivable && !reducedMotion) {
			const pool = REACTIONS[kind] || REACTIONS.win;
			const clip = hashPick(pool, agentId + kind);
			rec.busy = true;
			rec.anim.playOnce(clip, { settleTo: 'idle' });
		}
		pulsePad(rec);
		flashScreen(rec, kind);
		if (receipt) attachReceiptToPerformer(rec, receipt);
		return true;
	}

	function pulsePad(rec) {
		rec.pad.material.opacity = 0.55;
		rec.pad.userData.fade = performance.now();
	}

	// ── Floating receipts (DOM projected over the canvas) ───────────────────────
	// Anchored to the rotating cast so a receipt tracks its performer as the stage
	// orbits; centre receipts (for unstaged actors) anchor to the stage middle.
	function attachReceiptToCenter(el) {
		receipts.push({ el, anchor: new Vector3(0, 2.4, -1), born: performance.now(), rise: 1.1 });
		overlay.appendChild(el);
	}
	function attachReceiptToPerformer(rec, el) {
		receipts.push({ el, born: performance.now(), rise: 0.9, follow: rec });
		overlay.appendChild(el);
	}

	/**
	 * A centerpiece object for a launch / coin-buy spectacle — a glowing token
	 * coin rises from the stage floor, holds, then sinks and is removed. Driven
	 * only by a real coin-buy/launch event.
	 */
	function spawnCenterpiece({ tint = 0x8b5cf6, magnitude = 0.4 } = {}) {
		// The coin's size and glow scale with the real fill magnitude (0..1), so a
		// whale buy visibly dwarfs a small one — the drama tracks the money.
		const mag = Math.max(0, Math.min(1, magnitude));
		const radius = 0.5 + mag * 0.5;
		const coin = new Mesh(
			new CylinderGeometry(radius, radius, 0.12, 40),
			new MeshStandardMaterial({ color: tint, emissive: new Color(tint), emissiveIntensity: 0.75 + mag * 0.5, metalness: 0.7, roughness: 0.25 }),
		);
		coin.rotation.x = Math.PI / 2;
		coin.position.set(0, 0.2, -1);
		coin.userData.born = performance.now();
		scene.add(coin);
		const glow = new PointLight(tint, 1.8 + mag * 2.2, 9 + mag * 3, 2);
		glow.position.set(0, 1.6, -1);
		scene.add(glow);
		coin.userData.glow = glow;
		centerpieces.push(coin);
	}

	// A brief camera dolly toward the stage on a marquee moment (a center-stage
	// buy/launch). Eases in and back out over ~0.7s; a no-op under reduced motion.
	let punchStart = -1;
	function punchCamera() { if (!reducedMotion) punchStart = performance.now(); }
	const centerpieces = [];

	// ── Selection (raycast) ──────────────────────────────────────────────────────
	const raycaster = new Raycaster();
	const ndc = new Vector2();
	let downX = 0, downY = 0, downAt = 0;
	function onPointerDown(e) { downX = e.clientX; downY = e.clientY; downAt = performance.now(); }
	function onPointerUp(e) {
		const moved = Math.hypot(e.clientX - downX, e.clientY - downY);
		if (moved > 8 || performance.now() - downAt > 600) return; // a drag, not a click
		const rect = canvas.getBoundingClientRect();
		ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
		ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
		raycaster.setFromCamera(ndc, camera);
		const hits = raycaster.intersectObjects(cast.children, true);
		for (const h of hits) {
			let o = h.object;
			while (o && !o.userData?.agentId) o = o.parent;
			if (o?.userData?.agentId) { onSelect?.(o.userData.agentId); return; }
		}
	}
	canvas.addEventListener('pointerdown', onPointerDown);
	canvas.addEventListener('pointerup', onPointerUp);

	// Drag to rotate the cast; pauses auto-orbit while dragging.
	let dragging = false, lastX = 0;
	canvas.addEventListener('pointerdown', (e) => { dragging = true; lastX = e.clientX; autoOrbit = false; });
	window.addEventListener('pointerup', () => { dragging = false; });
	window.addEventListener('pointermove', (e) => {
		if (!dragging) return;
		orbitYaw += (e.clientX - lastX) * 0.005;
		lastX = e.clientX;
	});

	function highlight(agentId) {
		highlightId = agentId;
	}

	// ── Render loop ──────────────────────────────────────────────────────────────
	function frame(now) {
		if (disposed) return;
		raf = requestAnimationFrame(frame);
		const dt = Math.min(0.05, (now - last) / 1000);
		last = now;

		// Auto = a gentle room sway around dead-ahead (a full spin reads wrong for a
		// room); a drag switches to manual look-around via orbitYaw.
		if (autoOrbit && !reducedMotion) { swayT += dt; cast.rotation.y = Math.sin(swayT * 0.16) * 0.05; }
		else cast.rotation.y = orbitYaw;
		ring.rotation.z += dt * 0.05;

		// Camera push-in: sin(0→π) over 0.7s pulls the camera ~1 unit toward the
		// stage and eases back, punctuating a marquee fill without disorienting.
		if (punchStart >= 0) {
			const t = (now - punchStart) / 700;
			if (t >= 1) { punchStart = -1; camera.position.z = CAM_BASE_Z; }
			else camera.position.z = CAM_BASE_Z - Math.sin(t * Math.PI) * 1.0;
		}

		if (!reducedMotion) {
			for (const rec of performers.values()) {
				if (rec.drivable) rec.anim.update(dt);
				// fade pedestal pulse back down
				if (rec.pad.material.opacity > 0) {
					const target = rec.agent.id === highlightId ? 0.32 : 0;
					rec.pad.material.opacity += (target - rec.pad.material.opacity) * Math.min(1, dt * 3);
				} else if (rec.agent.id === highlightId) {
					rec.pad.material.opacity = 0.32;
				}
				// ease a flashed monitor back to its resting glow
				if (rec.screenMat) {
					rec.screenMat.emissiveIntensity += (SCREEN_REST - rec.screenMat.emissiveIntensity) * Math.min(1, dt * 2.4);
					if (rec.screenFlash && now > rec.screenFlash) { rec.screenMat.emissive.setHex(SCREEN_IDLE); rec.screenFlash = 0; }
				}
			}

			// Explosion guard (throttled): a rig that detonates under the idle clip is
			// hot-swapped to the mannequin so the floor never shows a blob. Cheap — a
			// bbox measure per performer twice a second.
			if (now - lastExplodeCheck > 500) {
				lastExplodeCheck = now;
				for (const rec of performers.values()) {
					if (!rec.drivable || rec._fixing || !rec.model?.visible) continue;
					_box.setFromObject(rec.model, true);
					const hh = _box.max.y - _box.min.y;
					if (!(hh < EXPLODE_LIMIT)) { log.warn('[theater] rig exploded, swapping to mannequin', rec.agent?.id); neutralizeExploded(rec); }
				}
			}
		}

		// Centerpiece coins: rise (0–0.6s), hold, sink + remove (after 3.4s).
		for (let i = centerpieces.length - 1; i >= 0; i--) {
			const coin = centerpieces[i];
			const age = (now - coin.userData.born) / 1000;
			coin.rotation.z += dt * 2.2;
			coin.position.y = age < 0.6 ? 0.2 + age * 2.4 : age < 2.8 ? 1.64 : Math.max(0.2, 1.64 - (age - 2.8) * 2.4);
            if (coin.userData.glow) coin.userData.glow.position.y = coin.position.y + 0.3;
			if (age > 3.4) {
				scene.remove(coin); if (coin.userData.glow) scene.remove(coin.userData.glow);
				coin.geometry.dispose(); disposeMaterial(coin.material);
				centerpieces.splice(i, 1);
			}
		}

		cast.updateMatrixWorld();
		projectPlates();
		projectReceipts(now);
		renderer.render(scene, camera);
	}

	function projectPlates() {
		const rect = canvas.getBoundingClientRect();
		for (const rec of performers.values()) {
			const plate = rec.plate;
			if (!plate) continue;
			_v.set(rec.group.position.x, 1.96 * (rec.slot?.scale || 1), rec.group.position.z).applyMatrix4(cast.matrixWorld);
			_v2.copy(_v).project(camera);
			const onScreen = _v2.z < 1 && _v2.x > -1.05 && _v2.x < 1.05;
			if (!onScreen) { plate.style.opacity = '0'; plate.style.pointerEvents = 'none'; continue; }
			const x = (_v2.x * 0.5 + 0.5) * rect.width;
			const y = (-_v2.y * 0.5 + 0.5) * rect.height;
			// Fade with depth so the back rows recede; nearest stay crisp.
			const depth = Math.max(0, Math.min(1, (_v2.z - 0.96) / 0.04));
			plate.style.opacity = String(0.95 - depth * 0.55);
			plate.style.pointerEvents = 'auto';
			plate.style.transform = `translate(-50%, -100%) translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
			plate.classList.toggle('is-highlight', rec.agent.id === highlightId);
		}
	}

	function projectReceipts(now) {
		for (let i = receipts.length - 1; i >= 0; i--) {
			const r = receipts[i];
			const age = (now - r.born) / 1000;
			if (age > 4.4) { r.el.remove(); receipts.splice(i, 1); continue; }
			// follow a moving performer (cast rotates), else use static anchor
			if (r.follow) {
				_v.set(r.follow.group.position.x, 2.05 * (r.follow.slot?.scale || 1), r.follow.group.position.z);
				_v.applyMatrix4(cast.matrixWorld);
			} else {
				_v.copy(r.anchor);
			}
			_v.y += Math.min(r.rise, age * r.rise); // rise then settle
			_v2.copy(_v).project(camera);
			const rect = canvas.getBoundingClientRect();
			const x = (_v2.x * 0.5 + 0.5) * rect.width;
			const y = (-_v2.y * 0.5 + 0.5) * rect.height;
			const visible = _v2.z < 1 && x > -120 && x < rect.width + 120;
			r.el.style.opacity = visible ? String(age < 0.25 ? age / 0.25 : age > 3.6 ? Math.max(0, (4.4 - age) / 0.8) : 1) : '0';
			r.el.style.transform = `translate(-50%, -100%) translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
		}
	}

	function resize() {
		const rect = canvas.getBoundingClientRect();
		const w = Math.max(1, rect.width), h = Math.max(1, rect.height);
		renderer.setSize(w, h, false);
		camera.aspect = w / h;
		camera.updateProjectionMatrix();
	}

	function setReducedMotion(on) {
		reducedMotion = on;
		autoOrbit = !on;
		for (const rec of performers.values()) {
			if (!rec.drivable) continue;
			if (on) rec.anim.freeze?.();
			else rec.anim.play('idle');
		}
	}

	function dispose() {
		disposed = true;
		cancelAnimationFrame(raf);
		canvas.removeEventListener('pointerdown', onPointerDown);
		canvas.removeEventListener('pointerup', onPointerUp);
		for (const [id, rec] of [...performers]) removePerformer(id, rec);
		for (const r of receipts) r.el.remove();
		receipts.length = 0;
		for (const coin of centerpieces) { scene.remove(coin); coin.userData.glow && scene.remove(coin.userData.glow); }
		// Room shell + shared desk material.
		for (const m of [board, boardEdge]) { m.geometry?.dispose?.(); disposeMaterial(m.material); }
		deskMat.dispose();
		try { disposeGltfLoader(renderer); } catch {}
		renderer.dispose();
	}

	resize();
	raf = requestAnimationFrame(frame);

	return {
		setRoster,
		perform,
		spawnCenterpiece,
		punchCamera,
		highlight,
		resize,
		setReducedMotion,
		dispose,
		hasPerformer: (id) => performers.has(id),
		get count() { return performers.size; },
	};
}
