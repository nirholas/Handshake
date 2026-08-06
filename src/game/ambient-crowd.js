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
import { getMeshoptDecoder } from '../viewer/internal.js';
import { Box3, Mesh, CapsuleGeometry, SphereGeometry, MeshStandardMaterial } from 'three';
import { AnimationManager } from '../animation-manager.js';

const AVATAR_DEFAULT = '/avatars/default.glb';
const MANIFEST_URL = '/animations/manifest.json';
const GALLERY_URL = '/api/avatars/public?limit=96'; // public avatar gallery — a broad pool so each wanderer is a distinct community model
const CLIP_IDLE = 'idle';
const CLIP_WALK = 'av-walk-feminine';
const WORLD_RADIUS = 54;       // a touch inside the plaza edge
const AMBIENT_SPEED = 1.7;     // gentle stroll, slower than the player
const AMBIENT_TARGET = 5;      // strollers to keep around when you're alone

const NAMES = ['satoshi', 'anon', 'gm_ser', 'degenape', 'moonboy', 'pepe', 'wagmi', 'hodlqueen', 'vibes', 'chad', 'frfr', 'fomo', 'ngmi', 'based_dev', 'gigachad', '0xshill', 'florp'];
const LINES = ['gm ☀️', 'wen moon', 'lfg 🚀', 'wagmi', 'probably nothing', 'few understand', 'based', 'diamond hands 💎', 'ser…', 'this is the way', 'bullish af', 'vibes immaculate', 'we so back', 'iykyk', 'up only 📈'];

const _gltf = new GLTFLoader();
// three.ws GLBs may carry EXT_meshopt_compression — decoder required before load
const _meshoptReady = getMeshoptDecoder().then((d) => _gltf.setMeshoptDecoder(d));
let _defs = null;     // [idle, walk] animation defs
let _emotes = null;   // a handful of emote defs
let _avatars = null;  // pool of public-gallery GLB URLs ([] once the fetch settles)

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
// a living mix of community models rather than one repeated default. Settles to an
// empty array on failure — each wanderer then falls back to AVATAR_DEFAULT.
async function loadAvatarPool() {
	if (_avatars) return;
	let urls = [];
	try {
		const r = await fetch(GALLERY_URL, { headers: { accept: 'application/json' } });
		if (r.ok) {
			const { avatars } = await r.json();
			urls = (avatars || []).map((a) => a.model_url || a.base_model_url).filter(Boolean);
		}
	} catch { /* default-avatar fallback below */ }
	_avatars = urls;
}

// Load a gallery avatar (or the default) into a rig + animation manager. Falls
// back to a simple stand-in so a wanderer is never invisible.
async function buildAvatar(rig, anim, url) {
	try {
		await _meshoptReady;
		const gltf = await _gltf.loadAsync(url || AVATAR_DEFAULT);
		const model = gltf.scene;
		model.traverse((n) => { if (n.isMesh) { n.castShadow = true; n.receiveShadow = false; } });
		const box = new Box3().setFromObject(model);
		model.position.y -= box.min.y;
		rig.add(model);
		anim.attach(model);
		if (_defs?.length) { anim.setAnimationDefs(_defs); await anim.loadAll(); await anim.crossfadeTo(CLIP_IDLE, 0); }
		return Math.max(0.5, box.max.y - box.min.y);
	} catch {
		// A gallery model that fails to load shouldn't strand the wanderer on a
		// capsule — fall back to the bundled default once before the stand-in.
		if (url && url !== AVATAR_DEFAULT) return buildAvatar(rig, anim, AVATAR_DEFAULT);
		const body = new Mesh(new CapsuleGeometry(0.32, 0.7, 4, 10), new MeshStandardMaterial({ color: 0x9aa3ad }));
		body.position.y = 0.85; body.castShadow = true;
		const head = new Mesh(new SphereGeometry(0.28, 14, 10), new MeshStandardMaterial({ color: 0xc9cdd2 }));
		head.position.y = 1.55; head.castShadow = true;
		rig.add(body, head);
		return 1.7;
	}
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
	constructor(scene, name, avatarUrl) {
		this.name = name;
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
		this.label.textContent = name;
		document.body.appendChild(this.label);

		this.bubble = null; this._bubbleTimer = null;
		this._dest = null;
		this._wait = 0.5 + Math.random() * 2.5;
		this._sayIn = 5 + Math.random() * 16;
		this._emoteIn = 9 + Math.random() * 22;

		buildAvatar(this.rig, this.anim, avatarUrl).then((h) => { this.height = h; });
	}
	_setMotion(m) {
		if (m === this.motion) return;
		this.motion = m;
		this.anim.crossfadeTo(m === 'walk' ? CLIP_WALK : CLIP_IDLE, 0.2);
	}
	say(text, onChat) {
		if (this.bubble) this.bubble.remove();
		this.bubble = document.createElement('div');
		this.bubble.className = 'cc-bubble';
		this.bubble.textContent = text;
		document.body.appendChild(this.bubble);
		clearTimeout(this._bubbleTimer);
		this._bubbleTimer = setTimeout(() => { this.bubble?.remove(); this.bubble = null; }, 4500);
		onChat?.(this.name, text);
	}
	update(dt, onChat) {
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
		this.scene.remove(this.rig);
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
	// the bag empties, so we exhaust the pool before any model repeats.
	_takeAvatar() {
		if (!_avatars?.length) return AVATAR_DEFAULT;
		if (!this._avatarBag.length) this._avatarBag = [..._avatars];
		const i = (Math.random() * this._avatarBag.length) | 0;
		return this._avatarBag.splice(i, 1)[0];
	}
	sync(realCount) {
		const want = Math.max(0, AMBIENT_TARGET - (realCount | 0));
		while (this.list.length < want) this.list.push(new Wanderer(this.cc.scene, this._takeName(), this._takeAvatar()));
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
			w.update(dt, this._onChat);
			place(w.label, w.rig.position, w.height + 0.2);
			if (w.bubble) place(w.bubble, w.rig.position, w.height + 0.7);
		}
	}
	clear() {
		for (const w of this.list) w.dispose();
		this.list = [];
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
