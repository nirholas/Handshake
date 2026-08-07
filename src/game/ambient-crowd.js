// Ambient crowd for /play — a living world without a server.
//
// Self-attaching: this module watches the live CoinCommunities scene
// (window.__CC__) and, while the player is inside a coin world, fills the plaza
// with decorative wandering avatars that stroll, idle, emote, and drop the
// occasional line into chat. So a solo demo never looks like an empty room — and
// the crowd tapers to nothing as real peers join, so the space is never padded
// with fakes once it's genuinely busy.
//
// Deliberately ZERO edits to coincommunities.js: it reads only the public
// scene/camera/ui and runs its own rAF. That keeps it collision-free while the
// rest of the scene is under active development.

import { Group, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinnedScene } from 'three/addons/utils/SkeletonUtils.js';
import { getMeshoptDecoder } from '../viewer/internal.js';
import { Box3, Mesh, CapsuleGeometry, SphereGeometry, MeshStandardMaterial } from 'three';
import { AnimationManager } from '../animation-manager.js';
import { detectProfile } from '../club-perf.js';
import { loadCitizenPool, isCitizen, openCitizenProfile } from './npc/citizens.js';

const AVATAR_DEFAULT = '/avatars/default.glb';
const MANIFEST_URL = '/animations/manifest.json';
const CLIP_IDLE = 'idle';
const CLIP_WALK = 'av-walk-feminine';
const WORLD_RADIUS = 54;       // a touch inside the plaza edge
const AMBIENT_SPEED = 1.7;     // gentle stroll, slower than the player

const MB = 1024 * 1024;

// Memory budget for the decorative crowd, per render tier.
//
// The public gallery is user-uploaded and uncapped: live models in it run from
// ~700 KB to 24 MB. The crowd used to draw a fresh random model per wanderer,
// per re-sync, with no size filter, no reuse and no disposal, so a phone that
// happened to draw a few heavy avatars pulled tens of megabytes of GLB into
// memory within seconds of world entry, and iOS Safari killed the tab. That is
// what made /play "randomly" kick mobile players: the draw is random, so the
// crash was too.
//
// Three limits keep it bounded. `maxModelBytes` filters the pool down to models
// the device can afford at all, `sessionBytes` caps what one visit may download
// in total (past it, the crowd re-clones models already resident rather than
// fetching more), and `count` sizes the crowd itself. Shadow casting is dropped
// on the low tier, where five shadow-casting skinned meshes cost more than the
// crowd is worth.
const CROWD_BUDGET = {
	high:   { count: 5, maxModelBytes: 12 * MB, sessionBytes: 80 * MB, shadows: true },
	medium: { count: 4, maxModelBytes: 6 * MB,  sessionBytes: 32 * MB, shadows: true },
	low:    { count: 2, maxModelBytes: 3 * MB,  sessionBytes: 10 * MB, shadows: false },
};
// A phone lands in the shared 'medium' tier because Safari reports neither
// deviceMemory nor hardwareConcurrency, so the detector defaults both to
// "plenty". That is the right call for the renderer (a modern iPhone draws the
// world fine) and the wrong one for a download budget: the phone still has a
// fraction of a laptop's memory headroom and is the device that actually gets
// killed. Step the crowd budget down one tier when the primary pointer is
// coarse, without touching the shared render profile.
function crowdBudget() {
	const tiers = ['high', 'medium', 'low'];
	let i = Math.max(0, tiers.indexOf(detectProfile()));
	const touchPrimary = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
	if (touchPrimary) i = Math.min(tiers.length - 1, i + 1);
	return CROWD_BUDGET[tiers[i]];
}
const BUDGET = crowdBudget();

const NAMES = ['satoshi', 'anon', 'gm_ser', 'degenape', 'moonboy', 'pepe', 'wagmi', 'hodlqueen', 'vibes', 'chad', 'frfr', 'fomo', 'ngmi', 'based_dev', 'gigachad', '0xshill', 'florp'];
const LINES = ['gm ☀️', 'wen moon', 'lfg 🚀', 'wagmi', 'probably nothing', 'few understand', 'based', 'diamond hands 💎', 'ser…', 'this is the way', 'bullish af', 'vibes immaculate', 'we so back', 'iykyk', 'up only 📈'];

const _gltf = new GLTFLoader();
// three.ws GLBs may carry EXT_meshopt_compression — decoder required before load
const _meshoptReady = getMeshoptDecoder().then((d) => _gltf.setMeshoptDecoder(d));
let _defs = null;     // [idle, walk] animation defs
let _emotes = null;   // a handful of emote defs
let _avatars = null;  // pool of affordable gallery picks ([] once the fetch settles)

// One download per distinct model, shared by every wanderer that wears it.
// SkeletonUtils.clone() deep-copies a skinned hierarchy (bones included) while
// sharing geometry and materials with the template, so the second wanderer in a
// given model costs no network and almost no memory. Cloned meshes share the
// template's buffers, so a template must outlive every clone of it. Disposal
// happens in AmbientCrowd.clear(), once the whole crowd is gone.
const _templates = new Map(); // url → Promise<Group>
let _spentBytes = 0;          // gallery bytes downloaded this visit

async function loadManifest() {
	if (_defs) return;
	let manifest = [];
	try {
		const r = await fetch(MANIFEST_URL, { cache: 'force-cache' });
		if (r.ok) manifest = await r.json();
	} catch { /* locomotion-only fallback below */ }
	const by = (n) => manifest.find((d) => d.name === n);
	_defs = [by(CLIP_IDLE), by(CLIP_WALK)].filter(Boolean);
	_emotes = manifest.filter((d) => d.name !== CLIP_IDLE && d.name !== CLIP_WALK).slice(0, 6);
}

// Pull a varied set of real avatars from the public gallery so the crowd reads as
// a living mix of community models rather than one repeated default. The shared
// citizen pool (citizens.js) supplies full records, so each wanderer keeps the
// identity of the avatar it wears: its gallery name, bio, and the registered
// agent behind it. Only models whose published size fits this device's
// per-model budget make the pool; an entry with no size is skipped rather than
// gambled on, since one 24 MB draw is enough to end a mobile session. Settles
// to an empty array on failure; each wanderer then falls back to AVATAR_DEFAULT.
async function loadAvatarPool() {
	if (_avatars) return;
	const records = await loadCitizenPool();
	_avatars = records.filter((p) => p.url && p.bytes > 0 && p.bytes <= BUDGET.maxModelBytes);
}

// Fetch a model once and hand every later wanderer a clone of it. `bytes` is the
// published size charged against this visit's download budget; a cache hit costs
// nothing and is never charged twice.
function loadTemplate(url, bytes) {
	let pending = _templates.get(url);
	if (!pending) {
		_spentBytes += bytes;
		pending = _meshoptReady.then(() => _gltf.loadAsync(url)).then((gltf) => gltf.scene);
		_templates.set(url, pending);
		// Evict a failed load so one bad model doesn't poison the URL for the rest
		// of the visit, and refund its budget: nothing was actually held.
		pending.catch(() => {
			if (_templates.get(url) === pending) _templates.delete(url);
			_spentBytes = Math.max(0, _spentBytes - bytes);
		});
	}
	return pending;
}

// Load a gallery avatar (or the default) into a rig + animation manager. Falls
// back to a simple stand-in so a wanderer is never invisible.
async function buildAvatar(rig, anim, pick) {
	const url = pick?.url || AVATAR_DEFAULT;
	try {
		const template = await loadTemplate(url, pick?.bytes || 0);
		const model = cloneSkinnedScene(template);
		model.traverse((n) => { if (n.isMesh) { n.castShadow = BUDGET.shadows; n.receiveShadow = false; } });
		const box = new Box3().setFromObject(model);
		model.position.y -= box.min.y;
		rig.add(model);
		anim.attach(model);
		if (_defs?.length) { anim.setAnimationDefs(_defs); await anim.loadAll(); await anim.crossfadeTo(CLIP_IDLE, 0); }
		return Math.max(0.5, box.max.y - box.min.y);
	} catch {
		// A gallery model that fails to load shouldn't strand the wanderer on a
		// capsule — fall back to the bundled default once before the stand-in.
		if (url !== AVATAR_DEFAULT) return buildAvatar(rig, anim, null);
		const body = new Mesh(new CapsuleGeometry(0.32, 0.7, 4, 10), new MeshStandardMaterial({ color: 0x9aa3ad }));
		body.position.y = 0.85; body.castShadow = BUDGET.shadows;
		const head = new Mesh(new SphereGeometry(0.28, 14, 10), new MeshStandardMaterial({ color: 0xc9cdd2 }));
		head.position.y = 1.55; head.castShadow = BUDGET.shadows;
		rig.add(body, head);
		return 1.7;
	}
}

// Release every model this visit downloaded. Safe only once no wanderer is left
// standing: clones share their template's geometry and materials, so freeing a
// template while a clone still renders would corrupt it.
function disposeTemplates() {
	for (const pending of _templates.values()) {
		pending.then((scene) => {
			scene.traverse((n) => {
				if (!n.isMesh) return;
				n.geometry?.dispose?.();
				for (const mat of Array.isArray(n.material) ? n.material : [n.material]) {
					if (!mat) continue;
					for (const value of Object.values(mat)) value?.isTexture && value.dispose();
					mat.dispose?.();
				}
			});
		}).catch(() => { /* never loaded, nothing to free */ });
	}
	_templates.clear();
	_spentBytes = 0;
}

async function playEmote(anim, motion) {
	if (!_emotes?.length) return;
	const def = _emotes[(Math.random() * _emotes.length) | 0];
	try {
		if (!anim.clips?.has?.(def.name)) await anim.loadAnimation(def.name, def.url, { loop: false });
		await anim.crossfadeTo(def.name, 0.15);
		setTimeout(() => anim.crossfadeTo(motion === 'walk' ? CLIP_WALK : CLIP_IDLE, 0.2), 2400);
	} catch { /* clip missing — ignore */ }
}

class Wanderer {
	constructor(scene, name, avatarPick, onInspect) {
		// A wanderer wearing a named gallery avatar IS that citizen: it carries the
		// avatar's real name and identity, and its nameplate opens the profile.
		// Only the nameless (default-avatar or anonymous-model) wanderers keep the
		// decorative crowd names.
		this.record = isCitizen(avatarPick) ? avatarPick : null;
		this.name = this.record ? this.record.name : name;
		this.held = false;
		this.rig = new Group();
		this.anim = new AnimationManager();
		this.height = 1.7;
		this.motion = 'idle';
		const a = Math.random() * Math.PI * 2, r = 5 + Math.random() * (WORLD_RADIUS * 0.7);
		this.rig.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
		this.yaw = Math.random() * Math.PI * 2; this.rig.rotation.y = this.yaw;
		scene.add(this.rig);
		this.scene = scene;

		this.label = document.createElement('div');
		this.label.className = 'cc-label';
		this.label.textContent = this.name;
		if (this.record) {
			this.citizen = {
				record: this.record,
				name: this.name,
				say: (t) => this.say(t),
				hold: () => { this.held = true; this._setMotion('idle'); },
				release: () => { this.held = false; },
			};
			// .cc-label is pointer-events:none globally; re-enable for this one, the
			// same way peer nameplates do, so the name itself is the tap target.
			this.label.style.pointerEvents = 'auto';
			this.label.style.cursor = 'pointer';
			this.label.title = `Meet ${this.name}`;
			this.label.addEventListener('click', (e) => { e.stopPropagation(); onInspect?.(this); });
		}
		document.body.appendChild(this.label);

		this.bubble = null; this._bubbleTimer = null;
		this._dest = null;
		this._wait = 0.5 + Math.random() * 2.5;
		this._sayIn = 5 + Math.random() * 16;
		this._emoteIn = 9 + Math.random() * 22;

		buildAvatar(this.rig, this.anim, avatarPick).then((h) => { this.height = h; });
	}
	_setMotion(m) {
		if (m === this.motion) return;
		this.motion = m;
		this.anim.crossfadeTo(m === 'walk' ? CLIP_WALK : CLIP_IDLE, 0.2);
	}
	say(text, onChat) {
		if (this._disposed) return; // churned away mid-conversation; the chat panel outlives the body
		if (this.bubble) this.bubble.remove();
		this.bubble = document.createElement('div');
		this.bubble.className = 'cc-bubble';
		this.bubble.textContent = text;
		document.body.appendChild(this.bubble);
		clearTimeout(this._bubbleTimer);
		this._bubbleTimer = setTimeout(() => { this.bubble?.remove(); this.bubble = null; }, 4500);
		onChat?.(this.name, text);
	}
	update(dt, onChat, player) {
		// Held for a conversation: stand still, face whoever stopped to talk, and
		// keep quiet (the chat panel drives the speech bubble now).
		if (this.held) {
			this._dest = null;
			this._wait = 1 + Math.random() * 2;
			if (player) {
				const want = Math.atan2(player.x - this.rig.position.x, player.z - this.rig.position.z);
				let d = want - this.yaw;
				while (d > Math.PI) d -= Math.PI * 2;
				while (d < -Math.PI) d += Math.PI * 2;
				this.yaw += d * Math.min(1, dt * 6);
				this.rig.rotation.y = this.yaw;
			}
			this.anim.update(dt);
			return;
		}
		this._sayIn -= dt;
		if (this._sayIn <= 0) { this._sayIn = 12 + Math.random() * 26; this.say(LINES[(Math.random() * LINES.length) | 0], onChat); }
		this._emoteIn -= dt;
		if (this._emoteIn <= 0 && this.motion === 'idle') { this._emoteIn = 16 + Math.random() * 26; playEmote(this.anim, this.motion); }

		if (!this._dest) {
			this._wait -= dt;
			if (this._wait <= 0) {
				const a = Math.random() * Math.PI * 2, r = Math.random() * (WORLD_RADIUS * 0.8);
				this._dest = new Vector3(Math.cos(a) * r, 0, Math.sin(a) * r);
				this._setMotion('walk');
			}
		} else {
			const p = this.rig.position;
			const dx = this._dest.x - p.x, dz = this._dest.z - p.z;
			const dist = Math.hypot(dx, dz);
			if (dist < 0.45) { this._dest = null; this._wait = 1.5 + Math.random() * 4.5; this._setMotion('idle'); }
			else {
				const step = Math.min(dist, AMBIENT_SPEED * dt);
				p.x += (dx / dist) * step; p.z += (dz / dist) * step;
				const tYaw = Math.atan2(dx, dz);
				let d = tYaw - this.yaw;
				while (d > Math.PI) d -= Math.PI * 2;
				while (d < -Math.PI) d += Math.PI * 2;
				this.yaw += d * Math.min(1, dt * 6);
				this.rig.rotation.y = this.yaw;
			}
		}
		this.anim.update(dt);
	}
	dispose() {
		this._disposed = true;
		this.scene.remove(this.rig);
		this.rig.clear();
		// Drop the mixer + its bound clip actions. The clips themselves are shared
		// module-wide and stay cached; only this rig's bindings go.
		this.anim.dispose();
		this.label.remove();
		this.bubble?.remove();
		clearTimeout(this._bubbleTimer);
	}
}

class AmbientCrowd {
	constructor(cc) {
		this.cc = cc;
		this.list = [];
		this.active = false;
		this._names = [...NAMES];
		this._avatarBag = []; // shuffled gallery URLs, drained for distinct assignment
		// Wanderers speak only through their overhead bubbles. They used to also
		// append lines into the real chat log as if they were players, which reads
		// as fabricated activity the moment anyone answers "gm" and gets silence.
		// The chat log carries real messages only.
		this._onChat = null;
	}
	_takeName() {
		if (!this._names.length) this._names = [...NAMES];
		const i = (Math.random() * this._names.length) | 0;
		return this._names.splice(i, 1)[0];
	}
	// Hand out a distinct gallery avatar each time; refill (and reshuffle) only once
	// the bag empties, so we exhaust the pool before any model repeats. Once this
	// visit's download budget is spent, keep the variety we already paid for: draw
	// from the models still resident in memory instead of fetching another one.
	// Wanderers churn every time a real player joins or leaves, so without this an
	// hour in a busy world would download the whole gallery.
	_takeAvatar() {
		if (!_avatars?.length) return null;
		if (_spentBytes >= BUDGET.sessionBytes) {
			const resident = [..._templates.keys()];
			if (!resident.length) return null;
			const url = resident[(Math.random() * resident.length) | 0];
			// Keep the identity riding the resident model: same record, zero new
			// bytes charged (the download already happened this visit).
			const rec = _avatars.find((p) => p.url === url);
			return rec ? { ...rec, bytes: 0 } : { url, bytes: 0 };
		}
		if (!this._avatarBag.length) this._avatarBag = [..._avatars];
		const i = (Math.random() * this._avatarBag.length) | 0;
		return this._avatarBag.splice(i, 1)[0];
	}
	// Open the citizen profile card for a wanderer: the real agent behind the
	// gallery avatar it wears, with a "Talk 1-on-1" into the live NPC chat.
	_inspect(w) {
		if (!w.citizen) return;
		const coin = this.cc.coin || {};
		openCitizenProfile(w.citizen, {
			world: { mint: coin.mint, name: coin.name, symbol: coin.symbol },
			ui: this.cc.ui,
			trigger: w.label,
		});
	}
	sync(realCount) {
		const want = Math.max(0, BUDGET.count - (realCount | 0));
		while (this.list.length < want) this.list.push(new Wanderer(this.cc.scene, this._takeName(), this._takeAvatar(), (w) => this._inspect(w)));
		while (this.list.length > want) this.list.pop().dispose();
		// The HUD's online count reports REAL players only (self + live peers).
		// Padding it with the decorative crowd was a lie a livestream can catch in
		// one screenshot; the wanderers are scenery, not population.
		try { this.cc.ui?.setOnline?.((realCount | 0) + 1); } catch { /* ignore */ }
	}
	update(dt) {
		const cam = this.cc.camera;
		const W = window.innerWidth, H = window.innerHeight;
		const place = (node, pos, dy) => {
			const v = new Vector3(pos.x, pos.y + dy, pos.z).project(cam);
			if (v.z > 1 || v.z < -1) { node.style.display = 'none'; return; }
			node.style.display = '';
			node.style.transform = `translate(-50%, -100%) translate(${(v.x * 0.5 + 0.5) * W}px, ${(-v.y * 0.5 + 0.5) * H}px)`;
		};
		for (const w of this.list) {
			w.update(dt, this._onChat, this.cc.localPos);
			place(w.label, w.rig.position, w.height + 0.2);
			if (w.bubble) place(w.bubble, w.rig.position, w.height + 0.7);
		}
	}
	clear() {
		for (const w of this.list) w.dispose();
		this.list = [];
		this._avatarBag = [];
		// Every clone is gone, so the shared templates can go too. Leaving a world
		// used to keep every model the crowd had ever worn resident for the rest of
		// the page's life; on a phone that alone could outlive the tab.
		disposeTemplates();
	}
}

// ---- bootstrap: wait for the scene, then run an independent update loop ----
async function attach(attempt = 0) {
	const cc = window.__CC__;
	if (!cc || !cc.scene || !cc.camera) {
		// The scene never appearing means boot failed (e.g. no WebGL, error card
		// up). Give up after ~90s instead of polling a dead page forever.
		if (attempt < 300) setTimeout(() => attach(attempt + 1), 300);
		return;
	}
	await Promise.all([loadManifest(), loadAvatarPool()]);
	const crowd = new AmbientCrowd(cc);
	let last = performance.now();
	let realCount = -1;
	const tick = () => {
		requestAnimationFrame(tick);
		const now = performance.now();
		const dt = Math.min(0.05, (now - last) / 1000);
		last = now;
		if (cc.phase === 'world') {
			const rc = (cc.remotes?.size) | 0;
			if (!crowd.active) { crowd.active = true; realCount = -1; }
			if (rc !== realCount) { realCount = rc; crowd.sync(rc); }
			crowd.update(dt);
		} else if (crowd.active) {
			crowd.clear();
			crowd.active = false;
		}
	};
	requestAnimationFrame(tick);
}

attach();
