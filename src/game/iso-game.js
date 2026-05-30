// Isometric RPG client — the /game scene. The front door to the authoritative
// MMO that already lives on the server (multiplayer/src/rooms/GameRoom.js):
// gathering, combat, skills, inventory, banking on the Mainland realm. This
// scene renders GameRoom's synced state through the GameNet bridge and turns
// player intent into the server's tile-stepped protocol.
//
// Design mirrors coincommunities.js (renderer → scene → RAF loop → phases) but
// the world is tile-based: a grid the server validates against, with a fixed
// three-quarter "isometric" camera that follows the local player. Avatar/anim
// loading is shared via avatar-rig.js so the RPG and the social walkaround
// never drift apart.
//
// Extension seams for the rest of Epic A (kept intentionally small so each task
// is a localized change):
//   • _buildNodeView(node)  — T7 replaces the placeholder gather-node meshes.
//   • _buildMobView(mob)    — T8 replaces the placeholder combat-mob meshes.
//   • onGatherTarget / onAttackTarget / bank/inventory hooks — T7/T8/T9.
// The baseline here renders real, navigable placeholders so the world is alive
// today; those tasks swap geometry without touching the networking or loop.

import {
	Scene, Color, Fog, WebGLRenderer, PerspectiveCamera, Group, Vector3,
	HemisphereLight, DirectionalLight, AmbientLight, PCFSoftShadowMap, SRGBColorSpace,
	Mesh, MeshStandardMaterial, MeshBasicMaterial, PlaneGeometry, BoxGeometry,
	CylinderGeometry, ConeGeometry, DodecahedronGeometry, IcosahedronGeometry,
	CircleGeometry, CanvasTexture, RepeatWrapping, DoubleSide,
} from 'three';
import nipplejs from 'nipplejs';

import { GameNet } from './game-net.js';
import {
	loadManifest, resolveAvatarUrl, buildAvatar, newAnim, CLIP_IDLE, CLIP_WALK,
} from './avatar-rig.js';
import { GUEST_SENTINEL, uploadPendingGuestAvatar } from './play-handoff.js';

const TILE = 1.0;            // world units per tile
const STEP_INTERVAL_MS = 165; // walk cadence — one authoritative step per tile
const MOVE_LERP = 0.22;      // position interpolation toward the server tile
const YAW_LERP = 0.22;
const AVATAR_DEFAULT = '/avatars/default.glb';

// ---------------------------------------------------------------------------
// GamePlayerView — a player's avatar rig in the tile world. The server owns the
// authoritative tile; this view interpolates toward it so movement reads smooth
// at the 15Hz patch rate. Used for both the local player and remote peers
// (T6 polishes remote-specific touches like HP bars on top of this baseline).
// ---------------------------------------------------------------------------
class GamePlayerView {
	constructor(scene, tileToWorld, player, isLocal) {
		this.scene = scene;
		this.tileToWorld = tileToWorld;
		this.isLocal = isLocal;
		this.id = player.id;

		this.rig = new Group();
		this.anim = newAnim();
		this.height = 1.7;

		// Authoritative tile + facing, and the interpolation targets derived from
		// them. tx/ty always reflect the latest server state (used for stepping).
		this.tx = player.tx;
		this.ty = player.ty;
		this.yaw = player.yaw || 0;
		this.curYaw = this.yaw;
		this.motion = player.motion || 'idle';
		this.hp = player.hp; this.maxHp = player.maxHp;
		this.dead = !!player.dead;

		const w = tileToWorld(player.tx, player.ty);
		this.rig.position.set(w.x, 0, w.z);
		this.target = new Vector3(w.x, 0, w.z);
		scene.add(this.rig);

		// Floating nameplate (DOM, projected each frame). HP bar fills in for the
		// local player and any damaged peer.
		this.label = document.createElement('div');
		this.label.className = 'kg-label' + (isLocal ? ' kg-label--me' : '');
		this.label.innerHTML =
			`<span class="kg-label-name"></span><span class="kg-hp"><i></i></span>`;
		this.nameEl = this.label.querySelector('.kg-label-name');
		this.hpFill = this.label.querySelector('.kg-hp i');
		this.nameEl.textContent = player.name || 'guest';
		document.getElementById('kg-labels')?.appendChild(this.label);
		this._renderHp();

		this._avatarUrl = null;
		this.setAvatar(player.cosmetic || '');
	}

	setAvatar(url) {
		const next = url || AVATAR_DEFAULT;
		if (next === this._avatarUrl) return;
		this._avatarUrl = next;
		this.rig.clear();
		this.anim = newAnim();
		resolveAvatarUrl(next).then((u) => buildAvatar(this.rig, u, this.anim).then(({ height }) => {
			this.height = height;
			this.anim.crossfadeTo(this.motion === 'walk' ? CLIP_WALK : CLIP_IDLE, 0);
		}));
	}

	apply(player) {
		const moved = player.tx !== this.tx || player.ty !== this.ty;
		this.tx = player.tx; this.ty = player.ty;
		this.yaw = player.yaw ?? this.yaw;
		const w = this.tileToWorld(player.tx, player.ty);
		this.target.set(w.x, 0, w.z);

		if (player.name && player.name !== this.nameEl.textContent) this.nameEl.textContent = player.name;
		if (player.hp !== this.hp || player.maxHp !== this.maxHp) {
			this.hp = player.hp; this.maxHp = player.maxHp; this._renderHp();
		}
		if (!!player.dead !== this.dead) {
			this.dead = !!player.dead;
			this.rig.visible = !this.dead;
			this.label.classList.toggle('kg-dead', this.dead);
		}
		if (player.motion !== this.motion) {
			this.motion = player.motion;
			this.anim.crossfadeTo(this.motion === 'walk' ? CLIP_WALK : CLIP_IDLE, 0.16);
		}
		// Peers' avatars are server-authoritative (the local player owns its own
		// look). setAvatar self-guards, so this is a no-op until a peer changes.
		if (!this.isLocal) this.setAvatar(player.cosmetic || '');
		// Mark when the server says we moved so the loop can settle us to idle on
		// arrival without waiting for a separate motion patch.
		if (moved) this._movedAt = performance.now();
	}

	_renderHp() {
		const pct = this.maxHp > 0 ? Math.max(0, Math.min(1, this.hp / this.maxHp)) : 0;
		this.hpFill.style.width = (pct * 100).toFixed(0) + '%';
		// Hide the bar at full health to keep nameplates clean; show when hurt.
		this.label.classList.toggle('kg-hurt', pct < 1);
	}

	tick(dt) {
		this.rig.position.x += (this.target.x - this.rig.position.x) * MOVE_LERP;
		this.rig.position.z += (this.target.z - this.rig.position.z) * MOVE_LERP;
		let d = this.yaw - this.curYaw;
		while (d > Math.PI) d -= Math.PI * 2;
		while (d < -Math.PI) d += Math.PI * 2;
		this.curYaw += d * YAW_LERP;
		this.rig.rotation.y = this.curYaw;
		this.anim?.update(dt);
	}

	dispose() {
		this.scene.remove(this.rig);
		this.label.remove();
	}
}

// ---------------------------------------------------------------------------
// IsoGame — the scene controller.
// ---------------------------------------------------------------------------
export class IsoGame {
	constructor(canvas) {
		this.canvas = canvas;
		this.phase = 'start'; // 'start' | 'connecting' | 'world' | 'offline'
		this.players = new Map();   // sessionId -> GamePlayerView
		this.nodeViews = new Map(); // id -> { group, node }
		this.mobViews = new Map();  // id -> { group, mob }
		this.keys = new Set();
		this.realm = null;
		this.myId = null;

		// Camera: a follow rig at a fixed three-quarter angle. Drag rotates yaw,
		// wheel/pinch zooms. Pitch is steep for the isometric read.
		this.camYaw = 0.7; this.camPitch = 0.95; this.camDist = 16;
		this._dragging = false; this._lastPtr = null; this._downAt = 0;
		this._stepAccum = 0;
		this._last = performance.now();
		this._camTarget = new Vector3(0, 0, 0);

		this._initRenderer();
		this._initScene();
		this._bindHud();
		this._bindInput();

		this._loop = this._loop.bind(this);
		requestAnimationFrame(this._loop);
	}

	// ---------------------------------------------------------------- render
	_initRenderer() {
		const r = new WebGLRenderer({ canvas: this.canvas, antialias: true });
		r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
		r.setSize(window.innerWidth, window.innerHeight);
		r.shadowMap.enabled = true; r.shadowMap.type = PCFSoftShadowMap;
		r.outputColorSpace = SRGBColorSpace;
		this.renderer = r;
		window.addEventListener('resize', () => this._onResize());
	}

	_initScene() {
		const scene = new Scene();
		scene.background = new Color(0x223a55);
		scene.fog = new Fog(0x223a55, 48, 120);
		this.scene = scene;

		this.camera = new PerspectiveCamera(48, window.innerWidth / window.innerHeight, 0.1, 400);
		this.camera.position.set(12, 16, 12);

		scene.add(new HemisphereLight(0xdcebff, 0x49603a, 1.0));
		scene.add(new AmbientLight(0xffffff, 0.28));
		const sun = new DirectionalLight(0xfff0d4, 1.25);
		sun.position.set(24, 40, 18); sun.castShadow = true;
		sun.shadow.mapSize.set(2048, 2048);
		const s = sun.shadow.camera; s.left = -40; s.right = 40; s.top = 40; s.bottom = -40; s.near = 1; s.far = 140;
		sun.shadow.bias = -0.0004;
		scene.add(sun, sun.target);
		this._sun = sun;

		// Static realm geometry (ground, buildings, fountain, tile paint) lives in
		// its own group so a realm (re)build is a single clear + rebuild WITHOUT
		// touching dynamic objects — gather nodes and mobs sync via schema patches
		// whose arrival order vs. the 'realm' message isn't guaranteed, so they
		// must survive a realm rebuild.
		this.staticGroup = new Group();
		this.objectGroup = new Group();
		scene.add(this.staticGroup, this.objectGroup);
	}

	// ---------------------------------------------------------------- coords
	// Tile (tx,ty) → world (x,z), centred on the realm so the camera orbits the
	// middle of the map and shadows stay inside the shadow-camera frustum.
	_tileToWorld(tx, ty) {
		const c = (this.realm?.grid ?? 48) / 2;
		return { x: (tx - c + 0.5) * TILE, z: (ty - c + 0.5) * TILE };
	}

	// ---------------------------------------------------------------- realm
	_buildRealm(layout) {
		this.realm = layout;
		// Clear only the static realm geometry; dynamic nodes/mobs (objectGroup)
		// and players (added straight to the scene) survive a realm rebuild.
		this.staticGroup.clear();

		const grid = layout.grid || 48;
		const size = grid * TILE;

		// Ground plane with a subtle tile grid so movement is legible.
		const ground = new Mesh(
			new PlaneGeometry(size, size),
			new MeshStandardMaterial({ map: this._gridTexture(grid), color: 0x6b9a52, roughness: 1 }),
		);
		ground.rotation.x = -Math.PI / 2;
		ground.receiveShadow = true;
		this.staticGroup.add(ground);

		// Solid blocks (bank building, pond water, etc.) — render each blocked
		// rect as a low box so the no-go zones are visually obvious and match the
		// server's walkability exactly.
		for (const b of layout.blocked || []) {
			const w = (b.x1 - b.x0 + 1) * TILE;
			const d = (b.y1 - b.y0 + 1) * TILE;
			const isWater = layout.name === 'pond';
			const h = isWater ? 0.25 : 2.4;
			const box = new Mesh(
				new BoxGeometry(w, h, d),
				new MeshStandardMaterial({
					color: isWater ? 0x2c5a86 : 0x4a4f5e,
					roughness: isWater ? 0.3 : 0.85,
					metalness: isWater ? 0.1 : 0,
					transparent: isWater, opacity: isWater ? 0.85 : 1,
				}),
			);
			const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
			const w0 = this._tileToWorld(cx, cy);
			box.position.set(w0.x, h / 2, w0.z);
			box.castShadow = !isWater; box.receiveShadow = true;
			this.staticGroup.add(box);
		}

		// Fountain landmark.
		if (layout.fountain) {
			const f = new Group();
			const base = new Mesh(new CylinderGeometry(1.6, 1.8, 0.5, 24),
				new MeshStandardMaterial({ color: 0x6b7280, roughness: 0.9 }));
			base.position.y = 0.25; base.castShadow = true; base.receiveShadow = true;
			const water = new Mesh(new CylinderGeometry(1.3, 1.3, 0.12, 24),
				new MeshStandardMaterial({ color: 0x3aa0d0, roughness: 0.2, emissive: 0x0a2a3a, emissiveIntensity: 0.4 }));
			water.position.y = 0.5;
			f.add(base, water);
			const w0 = this._tileToWorld(layout.fountain.tx, layout.fountain.ty);
			f.position.set(w0.x, 0, w0.z);
			this.staticGroup.add(f);
		}

		// Bank counter tiles — a warm highlight so players know where to bank.
		this._paintTiles(layout.bankZone, 0xffce5c, 0.85);
		// Fishing + cooking spots, if the realm has them.
		this._paintTiles(layout.fishing, 0x3aa0d0, 0.6);
		this._paintTiles(layout.cooking, 0xff7a3a, 0.6);
		// Portals.
		for (const p of layout.portals || []) {
			this._paintTiles(this._rectTiles(p), 0xae7bff, 0.7);
		}

		// Frame the camera on the spawn before the local player exists.
		const sp = this._tileToWorld(layout.spawn?.tx ?? grid / 2, layout.spawn?.ty ?? grid / 2);
		this._camTarget.set(sp.x, 0, sp.z);

		this.hud.realm.textContent = (layout.name || 'realm').replace(/^\w/, (m) => m.toUpperCase());
	}

	_rectTiles(r) {
		const out = [];
		for (let tx = r.x0; tx <= r.x1; tx++) for (let ty = r.y0; ty <= r.y1; ty++) out.push({ tx, ty });
		return out;
	}

	_paintTiles(tiles, color, opacity) {
		if (!tiles?.length) return;
		const mat = new MeshBasicMaterial({ color, transparent: true, opacity, side: DoubleSide });
		const geo = new PlaneGeometry(TILE * 0.92, TILE * 0.92);
		for (const t of tiles) {
			const m = new Mesh(geo, mat);
			m.rotation.x = -Math.PI / 2;
			const w = this._tileToWorld(t.tx, t.ty);
			m.position.set(w.x, 0.04, w.z);
			this.staticGroup.add(m);
		}
	}

	// A faint white tile grid drawn once into a tiling canvas texture.
	_gridTexture(grid) {
		const px = 64;
		const c = document.createElement('canvas'); c.width = c.height = px;
		const x = c.getContext('2d');
		x.fillStyle = '#5c8a44'; x.fillRect(0, 0, px, px);
		x.strokeStyle = 'rgba(255,255,255,0.10)'; x.lineWidth = 2;
		x.strokeRect(0, 0, px, px);
		const tex = new CanvasTexture(c);
		tex.wrapS = tex.wrapT = RepeatWrapping;
		tex.repeat.set(grid, grid);
		tex.colorSpace = SRGBColorSpace;
		return tex;
	}

	// ---------------------------------------------------------------- connect
	async start(name) {
		if (this.phase === 'world' || this.phase === 'connecting') return;
		this.phase = 'connecting';
		this._setHudPhase('connecting');
		// Reuse the avatar the player picked on /play (persisted in cc-avatar) and
		// network it through GamePlayer.cosmetic so peers render it too — both
		// scenes now share one look. A locally-staged guest avatar resolves to a
		// blob for our own view and uploads in the background; once it has a public
		// URL we broadcast it.
		this.avatarPref = localStorage.getItem('cc-avatar') || '';
		const isGuest = this.avatarPref === GUEST_SENTINEL;
		this.localAvatarUrl = await resolveAvatarUrl(this.avatarPref);
		const netAvatar = isGuest
			? ''
			: (/^https?:\/\//i.test(this.avatarPref) || this.avatarPref.startsWith('/')
				? this.avatarPref : this.localAvatarUrl);
		await loadManifest();

		this.net = new GameNet({ name, avatar: netAvatar });
		if (isGuest) uploadPendingGuestAvatar((publicUrl) => this.net?.setAvatar(publicUrl));
		this.net.on('status', ({ status, error }) => this._onStatus(status, error));
		this.net.on('realm', (layout) => this._buildRealm(layout));
		this.net.on('notice', (n) => this._toast(n));
		this.net.on('bank', (b) => this._onBank(b));
		this.net.on('playerAdd', (p, id) => this._playerAdd(p, id));
		this.net.on('playerChange', (p, id) => this._playerChange(p, id));
		this.net.on('playerRemove', (id) => this._playerRemove(id));
		this.net.on('nodeAdd', (n, id) => this._nodeAdd(n, id));
		this.net.on('nodeChange', (n, id) => this._nodeChange(n, id));
		this.net.on('nodeRemove', (id) => this._nodeRemove(id));
		this.net.on('mobAdd', (m, id) => this._mobAdd(m, id));
		this.net.on('mobChange', (m, id) => this._mobChange(m, id));
		this.net.on('mobRemove', (id) => this._mobRemove(id));

		await this.net.connect();
		this.myId = this.net.sessionId;
		this._initJoystick();
	}

	_onStatus(status, error) {
		this.hud.status.textContent = status;
		this.hud.status.dataset.status = status;
		if (status === 'online') {
			this.phase = 'world';
			this._setHudPhase('world');
		} else if (status === 'offline' || status === 'failed') {
			// Keep the world visible if we were already in it (a transient drop);
			// only fall back to the offline screen if we never connected.
			if (this.phase !== 'world') { this.phase = 'offline'; this._setHudPhase('offline'); }
			this.hud.offlineMsg.textContent = error || 'Disconnected from the game server.';
		}
		this._updateOnline();
	}

	// ---------------------------------------------------------------- players
	_playerAdd(p, id) {
		if (this.players.has(id)) { this.players.get(id).apply(p); return; }
		const isLocal = id === this.myId;
		const view = new GamePlayerView(this.scene, (tx, ty) => this._tileToWorld(tx, ty), p, isLocal);
		// The local player renders its own resolved avatar immediately (covers a
		// guest blob the server hasn't received the public URL for yet).
		if (isLocal && this.localAvatarUrl) view.setAvatar(this.localAvatarUrl);
		this.players.set(id, view);
		this._updateOnline();
	}
	_playerChange(p, id) { this.players.get(id)?.apply(p); }
	_playerRemove(id) {
		const v = this.players.get(id);
		if (v) { v.dispose(); this.players.delete(id); this._updateOnline(); }
	}
	_localView() { return this.myId ? this.players.get(this.myId) : null; }

	_updateOnline() {
		if (this.hud?.online) this.hud.online.textContent = String(this.players.size || 0);
	}

	// ---------------------------------------------------------------- nodes
	// Resource nodes (trees/rocks/coal). T7 swaps _buildNodeView for richer
	// geometry + gather interactions; the add/change/remove plumbing stays.
	_nodeAdd(node, id) {
		if (this.nodeViews.has(id)) { this._nodeChange(node, id); return; }
		const group = this._buildNodeView(node);
		const w = this._tileToWorld(node.tx, node.ty);
		group.position.set(w.x, 0, w.z);
		group.visible = !node.depleted;
		this.objectGroup.add(group);
		this.nodeViews.set(id, { group, node });
	}
	_nodeChange(node, id) {
		const v = this.nodeViews.get(id);
		if (!v) return;
		v.node = node;
		v.group.visible = !node.depleted;
	}
	_nodeRemove(id) {
		const v = this.nodeViews.get(id);
		if (v) { this.objectGroup.remove(v.group); this.nodeViews.delete(id); }
	}

	// Override seam for T7. Baseline: a recognizable low-poly prop per kind.
	_buildNodeView(node) {
		const g = new Group();
		if (node.kind === 'tree') {
			const trunk = new Mesh(new CylinderGeometry(0.12, 0.16, 0.9, 8),
				new MeshStandardMaterial({ color: 0x6b4a2b, roughness: 1 }));
			trunk.position.y = 0.45; trunk.castShadow = true;
			const leaves = new Mesh(new ConeGeometry(0.7, 1.4, 8),
				new MeshStandardMaterial({ color: 0x3f7d3a, roughness: 1 }));
			leaves.position.y = 1.5; leaves.castShadow = true;
			g.add(trunk, leaves);
		} else if (node.kind === 'coal') {
			const m = new Mesh(new IcosahedronGeometry(0.55, 0),
				new MeshStandardMaterial({ color: 0x23262e, roughness: 0.6, metalness: 0.2 }));
			m.position.y = 0.45; m.castShadow = true; g.add(m);
		} else { // rock
			const m = new Mesh(new DodecahedronGeometry(0.6, 0),
				new MeshStandardMaterial({ color: 0x8a8f9c, roughness: 0.9 }));
			m.position.y = 0.45; m.castShadow = true; g.add(m);
		}
		return g;
	}

	// ---------------------------------------------------------------- mobs
	// T8 swaps _buildMobView for proper enemies + attack interactions.
	_mobAdd(mob, id) {
		if (this.mobViews.has(id)) { this._mobChange(mob, id); return; }
		const group = this._buildMobView(mob);
		const w = this._tileToWorld(mob.tx, mob.ty);
		group.position.set(w.x, 0, w.z);
		group.visible = !mob.dead;
		this.objectGroup.add(group);
		this.mobViews.set(id, { group, mob });
	}
	_mobChange(mob, id) {
		const v = this.mobViews.get(id);
		if (!v) return;
		v.mob = mob;
		v.group.visible = !mob.dead;
		const w = this._tileToWorld(mob.tx, mob.ty);
		v.group.position.set(w.x, 0, w.z);
	}
	_mobRemove(id) {
		const v = this.mobViews.get(id);
		if (v) { this.objectGroup.remove(v.group); this.mobViews.delete(id); }
	}

	// Override seam for T8. Baseline: a colour-coded stand-in per mob kind.
	_buildMobView(mob) {
		const g = new Group();
		const color = mob.kind === 'ogre' ? 0x9c5a3c : mob.kind === 'goblin' ? 0x5a8c3c : 0x9aa0ac;
		const scale = mob.kind === 'ogre' ? 1.4 : 1;
		const body = new Mesh(new CylinderGeometry(0.3 * scale, 0.35 * scale, 1.1 * scale, 10),
			new MeshStandardMaterial({ color, roughness: 0.9 }));
		body.position.y = 0.55 * scale; body.castShadow = true;
		g.add(body);
		return g;
	}

	// ---------------------------------------------------------------- banking / notices
	// Bank contents arrive here (T9 renders the bank UI). Kept so the server's
	// 'bank' message has a real consumer and the latest snapshot is available.
	_onBank(payload) { this._bank = payload?.slots || []; }

	_toast({ kind, text }) {
		if (!text) return;
		const el = document.createElement('div');
		el.className = 'kg-toast kg-toast--' + (kind || 'info');
		el.textContent = text;
		this.hud.toasts.appendChild(el);
		requestAnimationFrame(() => el.classList.add('kg-toast--in'));
		setTimeout(() => { el.classList.remove('kg-toast--in'); setTimeout(() => el.remove(), 300); }, 2600);
	}

	// ---------------------------------------------------------------- input
	_bindInput() {
		window.addEventListener('keydown', (e) => {
			if (this._typing()) return;
			this.keys.add(e.key.toLowerCase());
		});
		window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
		window.addEventListener('blur', () => this.keys.clear());

		this.canvas.addEventListener('pointerdown', (e) => {
			this._dragging = true; this._lastPtr = { x: e.clientX, y: e.clientY }; this._downAt = performance.now();
		});
		window.addEventListener('pointerup', () => { this._dragging = false; });
		window.addEventListener('pointermove', (e) => {
			if (!this._dragging) return;
			const dx = e.clientX - this._lastPtr.x, dy = e.clientY - this._lastPtr.y;
			this._lastPtr = { x: e.clientX, y: e.clientY };
			this.camYaw -= dx * 0.005;
			this.camPitch = Math.max(0.45, Math.min(1.25, this.camPitch + dy * 0.004));
		});
		this.canvas.addEventListener('wheel', (e) => {
			e.preventDefault();
			this.camDist = Math.max(7, Math.min(30, this.camDist * (e.deltaY > 0 ? 1.1 : 0.9)));
		}, { passive: false });
	}

	_typing() {
		const a = document.activeElement;
		return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA');
	}

	_initJoystick() {
		const zone = document.getElementById('kg-joystick');
		if (!zone || this._nipple) return;
		if (!matchMedia('(pointer: coarse)').matches) { zone.style.display = 'none'; return; }
		this._nipple = nipplejs.create({ zone, mode: 'static', position: { left: '64px', bottom: '76px' }, color: '#9aa0ac', size: 110 });
		this._nipple.on('move', (_e, d) => {
			const f = Math.min(1, d.force);
			this._joy = { x: Math.cos(d.angle.radian) * f, z: -Math.sin(d.angle.radian) * f };
		});
		this._nipple.on('end', () => { this._joy = null; });
	}

	// Movement intent (keys + joystick) → a camera-relative world direction →
	// the nearest 8-way tile delta, sent as one authoritative step per cadence.
	_attemptStep() {
		const me = this._localView();
		if (!me || me.dead || !this.realm) return;

		let f = 0, r = 0;
		if (this.keys.has('w') || this.keys.has('arrowup')) f += 1;
		if (this.keys.has('s') || this.keys.has('arrowdown')) f -= 1;
		if (this.keys.has('d') || this.keys.has('arrowright')) r += 1;
		if (this.keys.has('a') || this.keys.has('arrowleft')) r -= 1;
		if (this._joy) { f += -this._joy.z; r += this._joy.x; }
		if (!f && !r) return;

		// Camera basis on the ground plane. forward = camera→target.
		const fwd = { x: -Math.sin(this.camYaw), z: -Math.cos(this.camYaw) };
		const right = { x: Math.cos(this.camYaw), z: -Math.sin(this.camYaw) };
		const wx = right.x * r + fwd.x * f;
		const wz = right.z * r + fwd.z * f;
		if (Math.abs(wx) < 1e-3 && Math.abs(wz) < 1e-3) return;

		const dtx = wx > 0.4 ? 1 : wx < -0.4 ? -1 : 0;
		const dty = wz > 0.4 ? 1 : wz < -0.4 ? -1 : 0;
		if (!dtx && !dty) return;

		const tx = me.tx + dtx, ty = me.ty + dty;
		const yaw = Math.atan2(wx, wz);
		if (!this._isWalkable(tx, ty)) {
			// Try sliding along whichever axis is clear so we hug walls instead of
			// sticking — server still validates the final step.
			if (dtx && this._isWalkable(me.tx + dtx, me.ty)) return this._sendStep(me.tx + dtx, me.ty, yaw);
			if (dty && this._isWalkable(me.tx, me.ty + dty)) return this._sendStep(me.tx, me.ty + dty, yaw);
			me.yaw = yaw; // still face the way we're pushing
			return;
		}
		this._sendStep(tx, ty, yaw);
	}

	_sendStep(tx, ty, yaw) {
		this.net?.step(tx, ty, yaw);
	}

	// Client-side walkability mirror of the server (bounds + blocked + live node/
	// mob occupancy) so we don't spam steps the server will reject.
	_isWalkable(tx, ty) {
		const grid = this.realm?.grid ?? 48;
		if (tx < 0 || ty < 0 || tx >= grid || ty >= grid) return false;
		for (const b of this.realm.blocked || []) {
			if (tx >= b.x0 && tx <= b.x1 && ty >= b.y0 && ty <= b.y1) return false;
		}
		for (const [, v] of this.nodeViews) {
			if (!v.node.depleted && v.node.tx === tx && v.node.ty === ty) return false;
		}
		for (const [, v] of this.mobViews) {
			if (!v.mob.dead && v.mob.tx === tx && v.mob.ty === ty) return false;
		}
		return true;
	}

	// ---------------------------------------------------------------- HUD
	_bindHud() {
		this.hud = {
			start: document.getElementById('kg-start'),
			startBtn: document.getElementById('kg-start-btn'),
			nameInput: document.getElementById('kg-name'),
			offline: document.getElementById('kg-offline'),
			offlineMsg: document.getElementById('kg-offline-msg'),
			retryBtn: document.getElementById('kg-retry'),
			topbar: document.getElementById('kg-topbar'),
			realm: document.getElementById('kg-realm'),
			online: document.getElementById('kg-online'),
			status: document.getElementById('kg-status'),
			toasts: document.getElementById('kg-toasts'),
			hint: document.getElementById('kg-hint'),
		};
		const savedName = localStorage.getItem('cc-name') || '';
		if (savedName) this.hud.nameInput.value = savedName;
		this.hud.nameInput.placeholder = 'guest-' + Math.random().toString(36).slice(2, 6);

		const begin = () => {
			const name = (this.hud.nameInput.value || this.hud.nameInput.placeholder).trim().slice(0, 24);
			localStorage.setItem('cc-name', name);
			this.start(name);
		};
		this.hud.startBtn.addEventListener('click', begin);
		this.hud.nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') begin(); });
		this.hud.retryBtn.addEventListener('click', () => {
			this._setHudPhase('connecting');
			this.phase = 'connecting';
			this.net ? this.net.retry() : this.start(this.hud.nameInput.value || this.hud.nameInput.placeholder);
		});
		this._setHudPhase('start');
	}

	_setHudPhase(phase) {
		this.hud.start.hidden = phase !== 'start';
		this.hud.offline.hidden = phase !== 'offline';
		this.hud.topbar.hidden = !(phase === 'world' || phase === 'connecting');
		this.hud.hint.hidden = phase !== 'world';
		document.body.classList.toggle('kg-loading-cursor', phase === 'connecting');
	}

	// ---------------------------------------------------------------- loop
	_loop() {
		requestAnimationFrame(this._loop);
		const now = performance.now();
		const dt = Math.min(0.05, (now - this._last) / 1000);
		this._last = now;

		if (this.phase === 'world') {
			this._stepAccum += now - (this._stepLast || now);
			this._stepLast = now;
			if (this._stepAccum >= STEP_INTERVAL_MS) { this._stepAccum = 0; this._attemptStep(); }
			for (const [, v] of this.players) v.tick(dt);
			this._updateCamera();
			this._updateLabels();
		} else {
			this._stepLast = now;
			this._idleCamera(dt);
		}
		this.renderer.render(this.scene, this.camera);
	}

	_updateCamera() {
		const me = this._localView();
		if (me) this._camTarget.lerp(new Vector3(me.rig.position.x, 0.8, me.rig.position.z), 0.12);
		this._placeCamera();
	}

	// Slow orbit of the spawn while on the start/offline screens for a touch of life.
	_idleCamera(dt) {
		this.camYaw += dt * 0.05;
		this._placeCamera();
	}

	_placeCamera() {
		const t = this._camTarget;
		const x = t.x + this.camDist * Math.cos(this.camPitch) * Math.sin(this.camYaw);
		const z = t.z + this.camDist * Math.cos(this.camPitch) * Math.cos(this.camYaw);
		const y = t.y + this.camDist * Math.sin(this.camPitch);
		this.camera.position.set(x, y, z);
		this.camera.lookAt(t);
		// Keep the sun roughly following the action so shadows stay framed.
		if (this._sun) {
			this._sun.position.set(t.x + 24, 40, t.z + 18);
			this._sun.target.position.set(t.x, 0, t.z);
			this._sun.target.updateMatrixWorld();
		}
	}

	// Project each player's head to screen space and place its DOM nameplate.
	_updateLabels() {
		const w = window.innerWidth, h = window.innerHeight;
		const v = new Vector3();
		for (const [, pv] of this.players) {
			if (pv.dead) { pv.label.style.display = 'none'; continue; }
			v.set(pv.rig.position.x, pv.height + 0.35, pv.rig.position.z).project(this.camera);
			const behind = v.z > 1;
			if (behind) { pv.label.style.display = 'none'; continue; }
			pv.label.style.display = '';
			const sx = (v.x * 0.5 + 0.5) * w;
			const sy = (-v.y * 0.5 + 0.5) * h;
			pv.label.style.transform = `translate(-50%, -100%) translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px)`;
		}
	}

	_onResize() {
		this.camera.aspect = window.innerWidth / window.innerHeight;
		this.camera.updateProjectionMatrix();
		this.renderer.setSize(window.innerWidth, window.innerHeight);
	}

	destroy() {
		this.net?.destroy();
		for (const [, v] of this.players) v.dispose();
		this.players.clear();
		this._nipple?.destroy();
	}
}

const canvas = document.getElementById('kg-canvas');
if (canvas) {
	const game = new IsoGame(canvas);
	if (typeof window !== 'undefined') window.__ISO__ = game;
}
