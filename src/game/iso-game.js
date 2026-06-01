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
	Raycaster, Vector2, SphereGeometry, RingGeometry,
	BufferGeometry, Line, LineBasicMaterial, Float32BufferAttribute,
} from 'three';
import nipplejs from 'nipplejs';

import { GameNet } from './game-net.js';
import {
	loadManifest, resolveAvatarUrl, buildAvatar, newAnim, CLIP_IDLE, CLIP_WALK,
} from './avatar-rig.js';
import { GUEST_SENTINEL, uploadPendingGuestAvatar } from './play-handoff.js';
import { GameHud } from './game-hud.js';

const TILE = 1.0;            // world units per tile
const STEP_INTERVAL_MS = 165; // walk cadence — one authoritative step per tile
const INTERACT_ACTION_MS = 380; // cadence for repeated gather/attack while adjacent to a target
// Quest badge glyphs, mirrored from the server (quests.js BADGES), so a player's
// earned badges render as small icons on their nameplate (the in-world profile).
const BADGE_ICONS = { newcomer: '🎓', warrior: '⚔️', forager: '🧺', devoted: '🌟' };
const MOVE_LERP = 0.22;      // position interpolation toward the server tile
const YAW_LERP = 0.22;
const AVATAR_DEFAULT = '/avatars/default.glb';

// Skills surface — display order, label, accent hue, and a line-art glyph for
// each trainable skill. The order mirrors the server's SKILLS array so the panel
// reads consistently; the server stays the source of truth for levels/XP/cap.
const SKILL_ORDER = ['combat', 'woodcutting', 'mining', 'fishing', 'cooking'];
const SKILL_META = {
	combat: { label: 'Combat', hue: '#ff8a8a', icon: 'M5 5l14 14M19 5L5 19' },
	woodcutting: { label: 'Woodcutting', hue: '#6ee787', icon: 'M12 3l5 8H7zM9.5 11h5l2.5 6H7zM12 17v4' },
	mining: { label: 'Mining', hue: '#c8cedb', icon: 'M3 8c5-4 13-4 18 0M12 7v13' },
	fishing: { label: 'Fishing', hue: '#5cb6e6', icon: 'M3 12c4-5 12-5 16 0-4 5-12 5-16 0zM19 12l3-2v4M7 11v.01' },
	cooking: { label: 'Cooking', hue: '#ff9a4d', icon: 'M12 3c2.5 3.5 4 5.5 4 8a4 4 0 0 1-8 0c0-1.6.8-2.7 1.7-3.6.2 1.7 1 2.6 2.3 2.6-1-2.5 0-4.6 0-7z' },
};
const fmtXp = (n) => Math.round(n).toLocaleString('en-US');

// Items the player can eat to heal — mirrors the server item registry's `edible`
// flag (items.js). Kept as a small client-side set, like the walkability mirror,
// so the action bar can offer "Eat" without round-tripping the full registry.
const EDIBLE = new Set(['cookedFish', 'healthPotion']);
const FOOD_LABEL = { cookedFish: 'cooked fish', healthPotion: 'potion' };

// Lightweight item presentation for the death-bag recovery panel: a readable
// label + a chip colour per known item. Unknown items fall back to a titlecase
// of their id and a neutral chip, so a future item never renders blank.
const ITEM_LABEL = {
	wood: 'Wood', stone: 'Stone', coal: 'Coal', fish: 'Raw fish',
	cookedFish: 'Cooked fish', gold: 'Gold',
	axe: 'Axe', pickaxe: 'Pickaxe', rod: 'Fishing rod', hammer: 'Hammer', sword: 'Sword',
};
const ITEM_COLOR = {
	wood: '#a9743f', stone: '#9aa0ac', coal: '#3a3f48', fish: '#5cb6e6',
	cookedFish: '#e6a85c', gold: '#ffce5c',
};
const itemLabel = (id) => ITEM_LABEL[id] || (id ? id.replace(/^\w/, (m) => m.toUpperCase()) : 'Item');
const itemColor = (id) => ITEM_COLOR[id] || '#7d8696';

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
			`<span class="kg-label-row"><span class="kg-badges"></span><span class="kg-label-name"></span></span><span class="kg-hp"><i></i></span>`;
		this.nameEl = this.label.querySelector('.kg-label-name');
		this.hpFill = this.label.querySelector('.kg-hp i');
		this.badgesEl = this.label.querySelector('.kg-badges');
		this.nameEl.textContent = player.name || 'guest';
		this.badges = '';
		this._renderBadges(player.badges || '');
		document.getElementById('kg-labels')?.appendChild(this.label);
		this._renderHp();

		// Mount visuals (Task 09): a steed mesh + saddle lift, attached in applyMount.
		this.mounted = false;
		this._steed = null;
		this._saddleY = 0;
		this._rideRate = 1.5;
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
		if ((player.badges || '') !== this.badges) this._renderBadges(player.badges || '');
		if (player.hp !== this.hp || player.maxHp !== this.maxHp) {
			this.hp = player.hp; this.maxHp = player.maxHp; this._renderHp();
		}
		// Keep the authoritative respawn deadline so the local death overlay can
		// count down to it from the synced schema (no client-side fake timer).
		this.respawnAt = player.respawnAt || 0;
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

	// Render the comma-separated badge ids as small glyphs ahead of the name.
	_renderBadges(badges) {
		this.badges = badges;
		const ids = badges ? badges.split(',').filter(Boolean) : [];
		this.badgesEl.innerHTML = ids
			.map((id) => BADGE_ICONS[id] ? `<span class="kg-badge-glyph" title="${id}">${BADGE_ICONS[id]}</span>` : '')
			.join('');
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
		// Saddle lift: a mount raises the rider; on foot the body settles back to ground.
		this.rig.position.y += ((this.mounted ? this._saddleY : 0) - this.rig.position.y) * 0.2;
		let d = this.yaw - this.curYaw;
		while (d > Math.PI) d -= Math.PI * 2;
		while (d < -Math.PI) d += Math.PI * 2;
		this.curYaw += d * YAW_LERP;
		this.rig.rotation.y = this.curYaw;
		if (this._steed) {
			this._steed.position.set(this.rig.position.x, 0, this.rig.position.z);
			this._steed.rotation.y = this.curYaw;
		}
		// A mounted, moving rider reads faster — nudge the walk clip rate while riding.
		this.anim?.update(dt * (this.mounted && this.motion === 'walk' ? this._rideRate : 1));
	}

	// Mount or dismount the steed under this avatar. `def` is the registry mount
	// tuning ({ color, accent, scale }) or null to dismount. The steed is a scene
	// sibling (not a child of the async avatar rig), so it survives avatar reloads;
	// tick() keeps it glued under the rider.
	applyMount(def) {
		const want = !!def;
		if (want === this.mounted && (!want || this._steed)) return;
		this.mounted = want;
		if (want) {
			if (this._steed) this.scene.remove(this._steed);
			this._steed = this._buildSteed(def);
			this._steed.position.set(this.rig.position.x, 0, this.rig.position.z);
			this._steed.rotation.y = this.curYaw;
			this.scene.add(this._steed);
			this._saddleY = 0.62 * (def.scale || 1);
		} else if (this._steed) {
			this.scene.remove(this._steed);
			this._steed = null;
			this._saddleY = 0;
		}
	}

	// A low-poly quadruped steed coloured from the registry: body + neck + head,
	// four legs, and a tail + snout accent so dire wolf and war boar read distinct.
	_buildSteed(def) {
		const g = new Group();
		const s = def.scale || 1;
		const body = new MeshStandardMaterial({ color: def.color ?? 0x6b7280, roughness: 0.85 });
		const accent = new MeshStandardMaterial({ color: def.accent ?? 0xb9c2d0, roughness: 0.8 });
		const torso = new Mesh(new BoxGeometry(0.5 * s, 0.42 * s, 1.0 * s), body);
		torso.position.y = 0.5 * s; torso.castShadow = true;
		const neck = new Mesh(new BoxGeometry(0.28 * s, 0.4 * s, 0.3 * s), body);
		neck.position.set(0, 0.72 * s, 0.5 * s); neck.rotation.x = -0.5; neck.castShadow = true;
		const head = new Mesh(new BoxGeometry(0.26 * s, 0.26 * s, 0.4 * s), body);
		head.position.set(0, 0.92 * s, 0.66 * s); head.castShadow = true;
		const snout = new Mesh(new BoxGeometry(0.18 * s, 0.16 * s, 0.18 * s), accent);
		snout.position.set(0, 0.86 * s, 0.86 * s);
		const legGeo = new BoxGeometry(0.12 * s, 0.5 * s, 0.12 * s);
		for (const [lx, lz] of [[-0.18, 0.38], [0.18, 0.38], [-0.18, -0.38], [0.18, -0.38]]) {
			const leg = new Mesh(legGeo, body);
			leg.position.set(lx * s, 0.25 * s, lz * s); leg.castShadow = true;
			g.add(leg);
		}
		const tail = new Mesh(new BoxGeometry(0.08 * s, 0.08 * s, 0.34 * s), accent);
		tail.position.set(0, 0.6 * s, -0.6 * s); tail.rotation.x = 0.6;
		g.add(torso, neck, head, snout, tail);
		return g;
	}

	dispose() {
		this.scene.remove(this.rig);
		if (this._steed) this.scene.remove(this._steed);
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
		this.npcViews = new Map();  // id -> { group, npc, label, markerEl }
		this.tombViews = new Map(); // id -> { group, tomb, label, nameEl, ttlEl }
		this.keys = new Set();
		this.realm = null;
		this.myId = null;

		// Click-to-interact: a tap on a node/mob/NPC sets a target the loop walks
		// to and then services (gather/attack/talk); a tap on open ground sets a
		// move-to tile. _interactAccum paces repeated gather/attack while adjacent.
		this._target = null; // { kind:'node'|'mob'|'npc'|'tile', id?, tx?, ty? }
		this._interactAccum = 0;
		this.items = {}; // server item registry (mount tuning, icons) — arrives on join
		// Latest authoritative quest snapshot (drives the NPC markers + quest dot).
		this.quests = null;

		// Death & death-bag UI state. _raycaster/_ptr turn a tap into a world pick
		// (used to click an adjacent tombstone). _lootTombId is the bag whose
		// recovery panel is open; _deathInfo carries the last 'died' notice so the
		// respawn overlay can describe what was dropped.
		this._raycaster = new Raycaster();
		this._ptr = new Vector2();
		this._dragMoved = 0;
		this._lootTombId = null;
		this._deathInfo = null;
		this._deathShown = false;

		// Active fishing cast — the line/bobber/ripple visual while a cast is in the
		// water. Local-only (peers don't see our bobber); the authoritative catch
		// result rides back as a 'fish' notice that resolves it. null when idle.
		this._cast = null;

		// Skills panel state: latest server snapshot, open flag, and the live-refresh
		// timer that polls XP while the panel is open so bars fill as XP is earned.
		this._skills = null;
		this._skillsOpen = false;
		this._skillsTimer = null;

		// World chat: open flag (drives the expanded vs. click-through collapsed
		// state) and the per-account mute set. Mutes are keyed by display name —
		// the stable identity until accounts land — and persisted locally;
		// Task 16 migrates this to the account-scoped profile store. The closer
		// fn is the document listener that dismisses an open mute popover.
		this._chatOpen = false;
		this.muted = this._loadMuted();
		this._muteMenuCloser = null;

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

		// Quest/hotbar/bank HUD. Self-contained DOM; intents route back through net.
		this.q = new GameHud({
			onEquip: (i) => this._equipOrRide(i),
			onTurnIn: (id) => this.net?.questTurnIn(id),
			onBankOpen: () => this.net?.bankOpen(),
			onDeposit: (i) => this.net?.bankDeposit(i, 999),
			onWithdraw: (i) => this.net?.bankWithdraw(i, 999),
			onReset: () => this.net?.questOpen(),
		});

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

		// The mine interior reads as an enclosed cave: a dark rocky floor, rock
		// walls, and a tight, dim atmosphere. Surface realms keep the open sky
		// look. Background + fog are reset on every realm build, so walking back
		// up to the Mainland restores daylight cleanly.
		const isCave = layout.name === 'mine';
		this.scene.background.set(isCave ? 0x130f0b : 0x223a55);
		this.scene.fog.color.set(isCave ? 0x130f0b : 0x223a55);
		this.scene.fog.near = isCave ? 16 : 48;
		this.scene.fog.far = isCave ? 70 : 120;

		// Ground plane with a subtle tile grid so movement is legible. The cave
		// uses a dark rock floor instead of grass.
		const ground = new Mesh(
			new PlaneGeometry(size, size),
			new MeshStandardMaterial({ map: this._gridTexture(grid, isCave), color: isCave ? 0x2a241d : 0x6b9a52, roughness: 1 }),
		);
		ground.rotation.x = -Math.PI / 2;
		ground.receiveShadow = true;
		this.staticGroup.add(ground);

		// Water bodies are a visual subset of the blocked rects (server marks them in
		// `layout.water`). Render those as low, translucent pools and everything else
		// as solid no-go boxes — both match the server's walkability exactly. A set of
		// per-tile water keys also lets a tap on the pond resolve to a cast.
		const rectKey = (r) => `${r.x0},${r.y0},${r.x1},${r.y1}`;
		const waterRects = new Set((layout.water || []).map(rectKey));
		this._waterTiles = new Set();
		for (const r of layout.water || []) {
			for (let tx = r.x0; tx <= r.x1; tx++) for (let ty = r.y0; ty <= r.y1; ty++) this._waterTiles.add(`${tx},${ty}`);
		}
		// Solid blocks (bank building, walls, etc.) — render each blocked rect as a
		// low box so the no-go zones are visually obvious.
		for (const b of layout.blocked || []) {
			const isWater = waterRects.has(rectKey(b));
			const w = (b.x1 - b.x0 + 1) * TILE;
			const d = (b.y1 - b.y0 + 1) * TILE;
			const h = isWater ? 0.25 : 2.4;
			const box = new Mesh(
				new BoxGeometry(w, h, d),
				isWater
					? new MeshStandardMaterial({
						color: 0x2c5a86, roughness: 0.3, metalness: 0.1,
						transparent: true, opacity: 0.85,
						emissive: 0x0a2030, emissiveIntensity: 0.35,
					})
					: isCave
						? new MeshStandardMaterial({ map: this._rockTexture(), color: 0x6a5f4f, roughness: 1 })
						: new MeshStandardMaterial({ color: 0x4a4f5e, roughness: 0.85 }),
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

		// Fixed NPCs (Aldric the Guide, …) — distinct characters with a nameplate +
		// quest marker. Rebuilt with the realm since they ride in the realm layout.
		this._buildNpcs(layout);

		// Frame the camera on the spawn before the local player exists.
		const sp = this._tileToWorld(layout.spawn?.tx ?? grid / 2, layout.spawn?.ty ?? grid / 2);
		this._camTarget.set(sp.x, 0, sp.z);

		this.hud.realm.textContent = (layout.name || 'realm').replace(/^\w/, (m) => m.toUpperCase());
	}

	// ---------------------------------------------------------------- NPCs
	_buildNpcs(layout) {
		this._disposeNpcs();
		for (const npc of layout.npcs || []) {
			const group = this._buildNpcView(npc);
			const w = this._tileToWorld(npc.tx, npc.ty);
			group.position.set(w.x, 0, w.z);
			group.traverse((o) => { o.userData.npcId = npc.id; }); // raycast → talk target
			this.objectGroup.add(group);

			const label = document.createElement('div');
			label.className = 'kg-npc-label';
			label.innerHTML = `<span class="kg-npc-marker" hidden></span><span class="kg-npc-tag"></span>`;
			label.querySelector('.kg-npc-tag').textContent = npc.name;
			document.getElementById('kg-labels')?.appendChild(label);

			this.npcViews.set(npc.id, { group, npc, label, markerEl: label.querySelector('.kg-npc-marker'), height: 1.9 });
		}
		this._refreshNpcMarkers();
	}

	// A distinct robed guide figure (so it never reads as a player capsule): a
	// hooded body, a face disc, and a small staff. Low-poly, no asset load.
	_buildNpcView(npc) {
		const g = new Group();
		const robe = new Mesh(new CylinderGeometry(0.32, 0.5, 1.3, 12),
			new MeshStandardMaterial({ color: 0x3b5b8c, roughness: 0.85 }));
		robe.position.y = 0.65; robe.castShadow = true;
		const hood = new Mesh(new ConeGeometry(0.36, 0.5, 12),
			new MeshStandardMaterial({ color: 0x2c4468, roughness: 0.85 }));
		hood.position.y = 1.45; hood.castShadow = true;
		const face = new Mesh(new SphereGeometry(0.2, 16, 12),
			new MeshStandardMaterial({ color: 0xe8c9a0, roughness: 0.7 }));
		face.position.y = 1.32;
		const staff = new Mesh(new CylinderGeometry(0.04, 0.04, 1.6, 6),
			new MeshStandardMaterial({ color: 0x6b4a2b, roughness: 1 }));
		staff.position.set(0.42, 0.8, 0); staff.castShadow = true;
		const orb = new Mesh(new IcosahedronGeometry(0.12, 0),
			new MeshStandardMaterial({ color: 0xffce5c, emissive: 0x6b5410, emissiveIntensity: 0.8, roughness: 0.4 }));
		orb.position.set(0.42, 1.65, 0);
		g.add(robe, hood, face, staff, orb);
		return g;
	}

	// Aldric's floating "!" (tutorial in progress) / "?" (a daily ready to claim)
	// marker, derived from the local quest snapshot. Cleared when there's nothing
	// to do at him.
	_refreshNpcMarkers() {
		const tutorialActive = !!(this.quests?.tutorial && !this.quests.tutorial.done);
		const turnIn = (this.quests?.daily?.quests || []).some((q) => q.progress >= q.count && !q.claimed);
		for (const [, v] of this.npcViews) {
			const mark = turnIn ? '?' : tutorialActive ? '!' : '';
			v.markerEl.textContent = mark;
			v.markerEl.hidden = !mark;
			v.markerEl.className = 'kg-npc-marker' + (turnIn ? ' kq-marker-turnin' : ' kq-marker-new');
		}
	}

	_disposeNpcs() {
		for (const [, v] of this.npcViews) { this.objectGroup.remove(v.group); v.label.remove(); }
		this.npcViews.clear();
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

	// A faint tile grid drawn once into a tiling canvas texture. `dark` swaps the
	// grass palette for a dim rock floor used by the cave (mine) interior.
	_gridTexture(grid, dark = false) {
		const px = 64;
		const c = document.createElement('canvas'); c.width = c.height = px;
		const x = c.getContext('2d');
		x.fillStyle = dark ? '#241f19' : '#5c8a44'; x.fillRect(0, 0, px, px);
		x.strokeStyle = dark ? 'rgba(0,0,0,0.45)' : 'rgba(255,255,255,0.10)'; x.lineWidth = 2;
		x.strokeRect(0, 0, px, px);
		const tex = new CanvasTexture(c);
		tex.wrapS = tex.wrapT = RepeatWrapping;
		tex.repeat.set(grid, grid);
		tex.colorSpace = SRGBColorSpace;
		return tex;
	}

	// Mottled rock texture for cave walls, drawn once and cached. Speckle + a few
	// dark cracks over a stone base read as rough rock without an image asset.
	_rockTexture() {
		if (this._rockTex) return this._rockTex;
		const px = 128;
		const c = document.createElement('canvas'); c.width = c.height = px;
		const x = c.getContext('2d');
		x.fillStyle = '#4f4538'; x.fillRect(0, 0, px, px);
		for (let i = 0; i < 480; i++) {
			const g = 40 + Math.floor(Math.random() * 55);
			x.fillStyle = `rgba(${g + 18},${g + 8},${g - 6},${0.18 + Math.random() * 0.4})`;
			x.beginPath(); x.arc(Math.random() * px, Math.random() * px, 1 + Math.random() * 3, 0, Math.PI * 2); x.fill();
		}
		x.strokeStyle = 'rgba(12,9,6,0.5)'; x.lineWidth = 1.5;
		for (let i = 0; i < 9; i++) {
			x.beginPath(); x.moveTo(Math.random() * px, Math.random() * px); x.lineTo(Math.random() * px, Math.random() * px); x.stroke();
		}
		const tex = new CanvasTexture(c);
		tex.wrapS = tex.wrapT = RepeatWrapping;
		tex.colorSpace = SRGBColorSpace;
		this._rockTex = tex;
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

		// Realm is chosen by ?realm=<name> (each realm is its own room). Until
		// Task 01's portal traversal lands this is how a danger realm like
		// Wilderness is reached directly; the server still validates everything.
		const realm = new URLSearchParams(location.search).get('realm') || 'mainland';
		this.net = new GameNet({ name, avatar: netAvatar, realm, pid: this._playerId() });
		if (isGuest) uploadPendingGuestAvatar((publicUrl) => this.net?.setAvatar(publicUrl));
		this.net.on('status', ({ status, error }) => this._onStatus(status, error));
		this.net.on('realm', (layout) => this._buildRealm(layout));
		this.net.on('items', (r) => this._onItems(r));
		this.net.on('notice', (n) => this._onNotice(n));
		this.net.on('cooked', (c) => this._onCooked(c));
		this.net.on('chat', (m) => this._onChat(m));
		this.net.on('bank', (b) => this._onBank(b));
		this.net.on('skills', (s) => this._onSkills(s));
		this.net.on('levelup', (l) => this._onLevelup(l));
		this.net.on('playerAdd', (p, id) => this._playerAdd(p, id));
		this.net.on('playerChange', (p, id) => this._playerChange(p, id));
		this.net.on('playerRemove', (id) => this._playerRemove(id));
		this.net.on('nodeAdd', (n, id) => this._nodeAdd(n, id));
		this.net.on('nodeChange', (n, id) => this._nodeChange(n, id));
		this.net.on('nodeRemove', (id) => this._nodeRemove(id));
		this.net.on('mobAdd', (m, id) => this._mobAdd(m, id));
		this.net.on('mobChange', (m, id) => this._mobChange(m, id));
		this.net.on('mobRemove', (id) => this._mobRemove(id));
		this.net.on('tombAdd', (t, id) => this._tombAdd(t, id));
		this.net.on('tombChange', (t, id) => this._tombChange(t, id));
		this.net.on('tombRemove', (id) => this._tombRemove(id));
		this.net.on('died', (d) => this._onDied(d));
		this.net.on('quests', (q) => this._onQuests(q));

		await this.net.connect();
		this.myId = this.net.sessionId;
		this._initJoystick();
	}

	// Stable account id for persistence (tutorial completion, dailies, badges).
	// Prefers a connected wallet address, else a persistent per-browser guest id.
	_playerId() {
		try {
			const wallet = localStorage.getItem('cc-wallet') || '';
			if (wallet) return wallet;
			let id = localStorage.getItem('kg-pid');
			if (!id) { id = 'g_' + Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem('kg-pid', id); }
			return id;
		} catch { return ''; }
	}

	_onStatus(status, error) {
		this.hud.status.textContent = status;
		this.hud.status.dataset.status = status;
		if (status === 'online') {
			this.phase = 'world';
			this._setHudPhase('world');
			this.q?.enterWorld();
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
		view.applyMount(p.mounted ? this._mountDef(p.mount) : null);
		if (isLocal) this._syncLocalHud(p);
		this._updateOnline();
	}
	_playerChange(p, id) {
		const v = this.players.get(id);
		if (!v) return;
		v.apply(p);
		v.applyMount(p.mounted ? this._mountDef(p.mount) : null);
		if (id === this.myId) this._syncLocalHud(p);
	}

	// Push the local player's authoritative inventory/hotbar into the HUD: the
	// hotbar bar, the bank panel's backpack column, and the "Bank" prompt that
	// appears only while standing on a bank-counter tile.
	_syncLocalHud(p) {
		if (!this.q) return;
		this.q.setHotbar(p.hotbar.map((s) => ({ item: s.item, qty: s.qty })), p.activeSlot);
		this.q.setInventory(p.inv.map((s) => ({ item: s.item, qty: s.qty })));
		const onBank = (this.realm?.bankZone || []).some((t) => t.tx === p.tx && t.ty === p.ty);
		this.q.setBankAvailable(onBank);
		this._updateMountChip(p);
	}
	_playerRemove(id) {
		const v = this.players.get(id);
		if (v) { v.dispose(); this.players.delete(id); this._updateOnline(); }
	}
	_localView() { return this.myId ? this.players.get(this.myId) : null; }

	_updateOnline() {
		if (this.hud?.online) this.hud.online.textContent = String(this.players.size || 0);
	}

	// ------------------------------------------------------------ items & mounts
	// The server item registry (icons, labels, mount tuning) arrives once on join.
	// Re-apply mounts to every avatar now that their visuals are resolvable.
	_onItems(reg) {
		this.items = reg || {};
		const players = this.net?.state?.players;
		if (players) {
			for (const [id, v] of this.players) {
				const sp = players.get(id);
				if (sp) v.applyMount(sp.mounted ? this._mountDef(sp.mount) : null);
			}
		}
		const me = this.net?.state?.players?.get(this.myId);
		if (me) this._updateMountChip(me);
	}

	_mountDef(id) { return this.items?.[id]?.mount || null; }

	// Equip a hotbar slot; if it holds a mount, also ride it — the natural "tap your
	// steed to mount" gesture. Both are server-authoritative (equip + use intents).
	_equipOrRide(i) {
		if (this.phase !== 'world') return;
		this.net?.equip(i);
		const ps = this.net?.state?.players?.get(this.myId);
		const item = ps?.hotbar?.[i]?.item;
		if (item && this._mountDef(item) && !(ps.mounted && ps.mount === item)) this.net?.use(i);
	}

	// Effective step cadence: a mount lowers it to (its server floor + headroom) so
	// the client never out-paces what the server accepts, yet rides visibly faster.
	_stepInterval() {
		const ps = this.net?.state?.players?.get(this.myId);
		const ms = ps?.mounted ? this._mountDef(ps.mount)?.stepMs : 0;
		return ms ? ms + 22 : STEP_INTERVAL_MS;
	}

	// Mount status chip + Dismount button: shown only while riding, naming the steed
	// from the registry. Driven by the authoritative mounted flag (no client guess).
	_updateMountChip(p) {
		const chip = this.hud?.mount;
		if (!chip) return;
		const show = !!p.mounted && this.phase === 'world';
		if (chip.hidden === show) chip.hidden = !show;
		if (show && this.hud.mountName) {
			const name = this.items?.[p.mount]?.label || (p.mount ? p.mount.replace(/_/g, ' ') : 'mount');
			if (this.hud.mountName.textContent !== name) this.hud.mountName.textContent = name;
		}
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
		group.traverse((o) => { o.userData.nodeId = id; }); // resolve raycast hits → gather target
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
		group.traverse((o) => { o.userData.mobId = id; }); // resolve raycast hits → attack target
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

	// ---------------------------------------------------------------- tombstones
	// Death-bags dropped in danger realms. Each gets a distinct gravestone mesh
	// (so it never reads as a rock node) plus a floating DOM label with the owner
	// name and a live "expires in Xs" countdown driven by the synced expiresAt.
	// Clicking an adjacent bag sends 'tombLoot' and opens the recovery panel.
	_tombAdd(tomb, id) {
		if (this.tombViews.has(id)) { this._tombChange(tomb, id); return; }
		const group = this._buildTombView(id);
		const w = this._tileToWorld(tomb.tx, tomb.ty);
		group.position.set(w.x, 0, w.z);
		this.objectGroup.add(group);

		const label = document.createElement('div');
		label.className = 'kg-tomblabel';
		label.innerHTML = `<span class="kg-tomb-name"></span><span class="kg-tomb-ttl"></span>`;
		const nameEl = label.querySelector('.kg-tomb-name');
		const ttlEl = label.querySelector('.kg-tomb-ttl');
		nameEl.textContent = `${tomb.ownerName || 'someone'}’s bag`;
		document.getElementById('kg-labels')?.appendChild(label);

		this.tombViews.set(id, { group, tomb, label, nameEl, ttlEl });
	}
	_tombChange(tomb, id) {
		const v = this.tombViews.get(id);
		if (!v) return;
		v.tomb = tomb;
		const w = this._tileToWorld(tomb.tx, tomb.ty);
		v.group.position.set(w.x, 0, w.z);
		v.nameEl.textContent = `${tomb.ownerName || 'someone'}’s bag`;
		// Keep an open recovery panel in sync as items flow out of the bag.
		if (this._lootTombId === id) this._renderLootPanel();
	}
	_tombRemove(id) {
		const v = this.tombViews.get(id);
		if (v) { this.objectGroup.remove(v.group); v.label.remove(); this.tombViews.delete(id); }
		// If the open panel's bag just vanished (looted dry or expired), close it.
		if (this._lootTombId === id) this._closeLootPanel();
	}

	_buildTombView(id) {
		const g = new Group();
		// A small earth mound + a glowing headstone slab. The cool violet emissive
		// keys it to the "lootable death-bag" colour used on the panel + portals.
		const mound = new Mesh(
			new CylinderGeometry(0.5, 0.6, 0.18, 16),
			new MeshStandardMaterial({ color: 0x3a2f4a, roughness: 1 }),
		);
		mound.position.y = 0.09; mound.receiveShadow = true;
		const slabMat = new MeshStandardMaterial({ color: 0x6b5a8a, roughness: 0.7, emissive: 0x2a1f4a, emissiveIntensity: 0.6 });
		const slab = new Mesh(new BoxGeometry(0.5, 0.7, 0.14), slabMat);
		slab.position.y = 0.52; slab.castShadow = true;
		const cap = new Mesh(new CylinderGeometry(0.25, 0.25, 0.14, 16, 1, false, 0, Math.PI), slabMat);
		cap.rotation.x = Math.PI / 2; cap.position.set(0, 0.87, 0);
		g.add(mound, slab, cap);
		// Tag every mesh so a raycast hit can resolve back to the tombstone id.
		g.traverse((o) => { o.userData.tombId = id; });
		return g;
	}

	// ---------------------------------------------------------------- death & loot
	// The local player died: stash the notice so the respawn overlay can describe
	// the drop, and close any open bag panel (you can't loot while dead).
	_onDied(info) {
		this._deathInfo = info || null;
		this._closeLootPanel();
		// The 'died' notice can land a frame after the dead-flag patch already
		// showed the overlay — refresh the message so the drop detail isn't lost.
		if (this._deathShown && this.hud.deathMsg) this.hud.deathMsg.textContent = this._deathMessage();
	}

	_deathMessage() {
		const info = this._deathInfo;
		let msg = 'You died.';
		if (info?.byName) msg = `Slain by ${info.byName}.`;
		if (info?.danger && info?.dropped > 0) {
			msg += ` Your bag (${info.dropped} item${info.dropped === 1 ? '' : 's'}) dropped where you fell — get back to recover it.`;
		} else if (info && !info.danger) {
			msg += ' Your belongings are safe here.';
		}
		return msg;
	}

	// A tap (not a drag) in the world. Two world interactions resolve from a pick:
	// click an adjacent tombstone to loot it, or click the pond (water / a shore
	// spot) to cast a line. Camera drags are filtered out before we get here.
	_onTap(clientX, clientY) {
		if (this.phase !== 'world') return;
		const me = this._localView();
		if (!me || me.dead) return;
		this._ptr.x = (clientX / window.innerWidth) * 2 - 1;
		this._ptr.y = -(clientY / window.innerHeight) * 2 + 1;
		this._raycaster.setFromCamera(this._ptr, this.camera);

		// 1) Tombstone under the cursor (dynamic objects).
		if (this.tombViews.size) {
			const hits = this._raycaster.intersectObject(this.objectGroup, true);
			let id = null;
			for (const h of hits) {
				const t = h.object?.userData?.tombId;
				if (t && this.tombViews.has(t)) { id = t; break; }
			}
			if (id) {
				const v = this.tombViews.get(id);
				if (Math.abs(me.tx - v.tomb.tx) > 1 || Math.abs(me.ty - v.tomb.ty) > 1) {
					this._toast({ kind: 'tomb', text: 'Walk up to the bag to loot it.' });
					this._openLootPanel(id); // still show contents so they know what's inside
				} else {
					this.net?.tombLoot(id);
					this._openLootPanel(id);
				}
				return;
			}
		}

		// 2) A resource node, mob, or NPC under the cursor → set it as the target
		// the loop walks to and interacts with (gather / attack / talk).
		const objHits = this._raycaster.intersectObject(this.objectGroup, true);
		for (const hp of objHits) {
			const ud = hp.object?.userData || {};
			if (ud.nodeId && this.nodeViews.has(ud.nodeId)) { this._setTarget('node', ud.nodeId); return; }
			if (ud.mobId && this.mobViews.has(ud.mobId)) { this._setTarget('mob', ud.mobId); return; }
			if (ud.npcId && this.npcViews.has(ud.npcId)) { this._setTarget('npc', ud.npcId); return; }
		}

		// 3) Ground pick: water / a shore spot is a cast intent; otherwise a walkable
		// tile is a click-to-walk move target.
		const tile = this._pickGroundTile();
		if (tile) {
			const onWater = this._waterTiles?.has(`${tile.tx},${tile.ty}`);
			const onSpot = (this.realm?.fishing || []).some((f) => f.tx === tile.tx && f.ty === tile.ty);
			if (onWater || onSpot) { this._attemptCast(); return; }
			if (this._isWalkable(tile.tx, tile.ty)) { this._target = { kind: 'tile', tx: tile.tx, ty: tile.ty }; this._interactAccum = 0; }
		}
	}

	// Set a click-to-interact target (node/mob/npc). Walking + the action itself
	// are serviced by the loop (_stepTowardTarget / _serviceInteraction).
	_setTarget(kind, id) {
		this._target = { kind, id };
		this._interactAccum = INTERACT_ACTION_MS; // act on the first adjacent frame
	}

	// Raycast the static realm geometry (ground + water + painted tiles) and turn
	// the first hit point into a tile index. Returns null if the ray missed.
	_pickGroundTile() {
		const hits = this._raycaster.intersectObject(this.staticGroup, true);
		if (!hits.length) return null;
		const p = hits[0].point;
		const c = (this.realm?.grid ?? 48) / 2;
		return { tx: Math.round(p.x / TILE + c - 0.5), ty: Math.round(p.z / TILE + c - 0.5) };
	}

	// ---------------------------------------------------------------- fishing
	// Cast a line. Mirrors the server's gates client-side for instant feedback
	// (adjacent to water, holding a rod) before sending the intent; the server
	// stays authoritative for the catch roll. The rod is auto-equipped from the
	// hotbar the same way the Cook/Eat actions resolve their requirements, so a
	// player never has to hunt for a slot to fish.
	_attemptCast() {
		const me = this._localView();
		const ps = this.net?.state?.players?.get(this.myId);
		if (!me || !ps || me.dead) return;
		if (!this._nearFishingSpot(ps.tx, ps.ty)) {
			this._toast({ kind: 'fish', text: 'Move next to the water to cast.' });
			return;
		}
		if (!this._ensureRodEquipped(ps)) {
			this._toast({ kind: 'tool', text: 'You need a fishing rod to cast.' });
			return;
		}
		this.net?.fish();
		this._spawnCast(ps.tx, ps.ty);
	}

	_nearFishingSpot(tx, ty) {
		for (const f of this.realm?.fishing || []) {
			if (Math.abs(tx - f.tx) <= 1 && Math.abs(ty - f.ty) <= 1) return true;
		}
		return false;
	}

	_hasRod(ps) {
		return ps.hotbar.some((s) => s.item === 'rod') || ps.inv.some((s) => s.item === 'rod');
	}

	// Make sure the rod is the active hotbar tool. Returns true if it already is or
	// we just equipped it; false if the player has no rod on the hotbar at all.
	_ensureRodEquipped(ps) {
		if (ps.hotbar[ps.activeSlot]?.item === 'rod') return true;
		for (let i = 0; i < ps.hotbar.length; i++) {
			if (ps.hotbar[i].item === 'rod') { this.net?.equip(i); return true; }
		}
		return false;
	}

	// World position of the water tile nearest (tx,ty) — where the bobber lands.
	_nearestWaterWorld(tx, ty) {
		let best = null, bd = Infinity;
		for (const r of this.realm?.water || []) {
			const cx = Math.max(r.x0, Math.min(tx, r.x1));
			const cy = Math.max(r.y0, Math.min(ty, r.y1));
			const dist = (cx - tx) ** 2 + (cy - ty) ** 2;
			if (dist < bd) { bd = dist; best = { tx: cx, ty: cy }; }
		}
		return best ? this._tileToWorld(best.tx, best.ty) : null;
	}

	// Spawn the cast visual: a line from the angler to a bobber floating on the
	// water, with an expanding ripple. Local-only and replaced on each new cast.
	_spawnCast(tx, ty) {
		this._clearCast();
		const w = this._nearestWaterWorld(tx, ty) || this._tileToWorld(tx, ty);
		const group = new Group();

		const baseY = 0.34;
		const bob = new Mesh(
			new SphereGeometry(0.12, 12, 10),
			new MeshStandardMaterial({ color: 0xff5a4d, emissive: 0x4a1009, emissiveIntensity: 0.5, roughness: 0.5 }),
		);
		bob.position.set(w.x, baseY, w.z);
		group.add(bob);

		const ring = new Mesh(
			new RingGeometry(0.16, 0.24, 22),
			new MeshBasicMaterial({ color: 0x9fe4ff, transparent: true, opacity: 0.6, side: DoubleSide }),
		);
		ring.rotation.x = -Math.PI / 2;
		ring.position.set(w.x, 0.27, w.z);
		group.add(ring);

		const lineGeo = new BufferGeometry();
		lineGeo.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 0, 0, 0], 3));
		const line = new Line(lineGeo, new LineBasicMaterial({ color: 0xeaf4ff, transparent: true, opacity: 0.7 }));
		group.add(line);

		this.objectGroup.add(group);
		this._cast = { group, bob, ring, line, lineGeo, baseY, start: performance.now(), resolved: false, resolvedAt: 0, caught: false };
	}

	// Per-frame cast animation: bob the float, loop the ripple, and keep the line
	// anchored to the angler's hands. After the server resolves the cast, play a
	// short bite splash (or quiet sink on a miss) then dispose.
	_tickCast(now) {
		const c = this._cast;
		if (!c) return;
		const t = (now - c.start) / 1000;
		c.bob.position.y = c.baseY + Math.sin(t * 5) * 0.04;

		if (c.resolved) {
			const since = now - c.resolvedAt;
			const k = Math.min(1, since / 280);
			c.ring.scale.setScalar(0.8 + k * (c.caught ? 2.8 : 1.4));
			c.ring.material.opacity = Math.max(0, 0.6 * (1 - k));
			if (since > 320) { this._clearCast(); return; }
		} else {
			const rp = (t % 0.9) / 0.9;
			c.ring.scale.setScalar(0.6 + rp * 1.6);
			c.ring.material.opacity = (1 - rp) * 0.55;
			// Safety net: if the result never arrives (e.g. a silently dropped cast),
			// reel the line in after a beat rather than leaving it dangling.
			if (now - c.start > 2400) { this._clearCast(); return; }
		}

		const me = this._localView();
		if (me) {
			const pos = c.lineGeo.attributes.position;
			pos.setXYZ(0, me.rig.position.x, (me.height || 1.6) * 0.85, me.rig.position.z);
			pos.setXYZ(1, c.bob.position.x, c.bob.position.y, c.bob.position.z);
			pos.needsUpdate = true;
		}
	}

	// Resolve the active cast from the authoritative result (a 'fish'/'full'
	// notice). `caught` greens the bobber and triggers a bigger bite splash.
	_resolveCast(caught) {
		const c = this._cast;
		if (!c || c.resolved) return;
		c.resolved = true;
		c.resolvedAt = performance.now();
		c.caught = !!caught;
		if (caught) c.bob.material.color.set(0x6ee787);
	}

	_clearCast() {
		const c = this._cast;
		if (!c) return;
		this.objectGroup.remove(c.group);
		c.group.traverse((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
		this._cast = null;
	}

	_openLootPanel(id) {
		this._lootTombId = id;
		const panel = this.hud.tombPanel;
		if (!panel) return;
		panel.hidden = false;
		requestAnimationFrame(() => panel.classList.add('kg-tomb-panel--in'));
		this._renderLootPanel();
	}

	_closeLootPanel() {
		this._lootTombId = null;
		const panel = this.hud.tombPanel;
		if (!panel) return;
		panel.classList.remove('kg-tomb-panel--in');
		setTimeout(() => { if (!this._lootTombId) panel.hidden = true; }, 240);
	}

	_renderLootPanel() {
		const panel = this.hud.tombPanel;
		const v = this._lootTombId ? this.tombViews.get(this._lootTombId) : null;
		if (!panel || !v) return;
		const tomb = v.tomb;
		this.hud.tombOwner.textContent = `${tomb.ownerName || 'someone'}’s bag`;
		const items = (tomb.items || []).filter((s) => s.item && s.qty > 0);
		const list = this.hud.tombItems;
		list.innerHTML = '';
		if (!items.length) {
			const empty = document.createElement('div');
			empty.className = 'kg-tomb-empty';
			empty.textContent = 'This bag is empty.';
			list.appendChild(empty);
			this.hud.tombTake.disabled = true;
		} else {
			for (const s of items) {
				const row = document.createElement('div');
				row.className = 'kg-tomb-item';
				row.innerHTML =
					`<span class="kg-tomb-chip" style="--chip:${itemColor(s.item)}"></span>` +
					`<span class="kg-tomb-iname">${itemLabel(s.item)}</span>` +
					`<span class="kg-tomb-iqty">×${s.qty}</span>`;
				list.appendChild(row);
			}
			this.hud.tombTake.disabled = false;
		}
		this._updateTombPanelTtl();
	}

	_updateTombPanelTtl() {
		const v = this._lootTombId ? this.tombViews.get(this._lootTombId) : null;
		if (!v || !this.hud.tombTtl) return;
		const ms = Math.max(0, v.tomb.expiresAt - Date.now());
		this.hud.tombTtl.textContent = `expires in ${Math.ceil(ms / 1000)}s`;
	}

	// ---------------------------------------------------------------- banking / notices
	// Bank contents arrive here and feed the HUD's bank panel (the "Stored" column).
	_onBank(payload) {
		this._bank = payload?.slots || [];
		this.q?.setBank(this._bank.map((s) => ({ item: s.item, qty: s.qty })));
	}

	// Authoritative quest snapshot: drive the panel, refresh Aldric's "!"/"?"
	// markers, and open the NPC dialog when the snapshot answers a talk.
	_onQuests(snapshot) {
		this.quests = snapshot || null;
		this.q?.setQuests(this.quests);
		this._refreshNpcMarkers();
		if (snapshot?.npc && this.npcViews.has(snapshot.npc)) {
			this.q?.openNpc(this.npcViews.get(snapshot.npc).npc.name);
		}
	}

	// Server notices route here so a few carry an extra flourish beyond the
	// toast: a successful bite reports "+N HP", which we echo as a green flash
	// on the local nameplate so the heal reads on the avatar too.
	_onNotice(n) {
		this._toast(n);
		if (n?.kind === 'eat' && /^\+\d/.test(n.text || '')) this._healFlash();
		// Resolve the in-water cast from the authoritative result: a 'fish' notice is
		// the catch/miss verdict; 'full' (or a tool gate) ends a cast that can't land.
		if (n?.kind === 'fish') this._resolveCast(/caught/i.test(n.text || ''));
		else if ((n?.kind === 'full' || n?.kind === 'tool') && this._cast) this._resolveCast(false);
	}

	_toast({ kind, text }) {
		if (!text) return;
		const el = document.createElement('div');
		el.className = 'kg-toast kg-toast--' + (kind || 'info');
		el.textContent = text;
		this.hud.toasts.appendChild(el);
		requestAnimationFrame(() => el.classList.add('kg-toast--in'));
		setTimeout(() => { el.classList.remove('kg-toast--in'); setTimeout(() => el.remove(), 300); }, 2600);
	}

	// ---------------------------------------------------------------- cooking & food
	// Contextual action bar. The client surfaces the two world actions it supports
	// today — Cook (at a Roast Pit, with raw fish) and Eat (when hurt and carrying
	// food) — only when they're actually possible, reading the local player's live
	// server state each frame. Both drive the server's cook/consume intents, so a
	// future full inventory UI can reuse the exact same path.
	_updateActions() {
		const bar = this.hud.actions;
		if (!bar) return;
		const me = this._localView();
		const ps = this.net?.state?.players?.get(this.myId);
		if (!me || !ps || me.dead) { if (!bar.hidden) bar.hidden = true; return; }

		// Cook: on/next to a Roast Pit AND carrying raw fish.
		const fishN = this._countItem(ps, 'fish');
		const showCook = fishN > 0 && this._nearCookingTile(ps.tx, ps.ty);
		this._toggleAction(this.hud.cookBtn, showCook, `Cook fish (${fishN})`);

		// Eat: below max HP AND carrying something edible.
		const edible = this._findEdibleSlot(ps);
		const showEat = ps.hp < ps.maxHp && !!edible;
		this._eatRef = showEat ? edible.ref : null;
		this._toggleAction(this.hud.eatBtn, showEat, showEat ? `Eat ${edible.label} (${edible.count})` : 'Eat');

		// Cast: standing beside fishable water. The rod auto-equips on cast, so the
		// button just reflects whether the player owns one — when they don't, it
		// reads "Need a rod" and explains on click (casting is gated, not silent).
		const showCast = this._nearFishingSpot(ps.tx, ps.ty);
		const hasRod = this._hasRod(ps);
		this._toggleAction(this.hud.castBtn, showCast, hasRod ? 'Cast line 🎣' : 'Need a rod 🎣');
		if (this.hud.castBtn) this.hud.castBtn.classList.toggle('kg-action--muted', showCast && !hasRod);

		bar.hidden = !(showCook || showEat || showCast);
	}

	_toggleAction(btn, show, label) {
		if (!btn) return;
		if (btn.hidden === show) btn.hidden = !show;
		if (show) {
			const lbl = btn.querySelector('.kg-action-lbl');
			if (lbl && lbl.textContent !== label) lbl.textContent = label;
		}
	}

	_nearCookingTile(tx, ty) {
		for (const t of this.realm?.cooking || []) {
			if (Math.abs(tx - t.tx) <= 1 && Math.abs(ty - t.ty) <= 1) return true;
		}
		return false;
	}

	_countItem(ps, item) {
		let n = 0;
		for (const s of ps.inv) if (s.item === item) n += s.qty;
		for (const s of ps.hotbar) if (s.item === item) n += s.qty;
		return n;
	}

	// The first edible slot — hotbar before backpack — with the server-resolvable
	// {zone,i} ref, a friendly label, and how many of that food the player holds.
	_findEdibleSlot(ps) {
		const scan = (arr, zone) => {
			for (let i = 0; i < arr.length; i++) {
				const it = arr[i].item;
				if (it && EDIBLE.has(it)) return { ref: { zone, i }, item: it, label: FOOD_LABEL[it] || 'food', count: this._countItem(ps, it) };
			}
			return null;
		};
		return scan(ps.hotbar, 'hotbar') || scan(ps.inv, 'inv');
	}

	// A successful cook ('cooked' event) — pulse the Cook button so the action
	// reads as landed; the honest result (cooked/burned counts) arrives as a toast.
	_onCooked() {
		const btn = this.hud.cookBtn;
		if (!btn || btn.hidden) return;
		btn.classList.remove('kg-action--pulse');
		void btn.offsetWidth; // restart the animation
		btn.classList.add('kg-action--pulse');
	}

	// Flash the local nameplate green when the player eats, so the heal reads on
	// the avatar, not just in a toast.
	_healFlash() {
		const me = this._localView();
		if (!me?.label) return;
		me.label.classList.remove('kg-heal');
		void me.label.offsetWidth;
		me.label.classList.add('kg-heal');
		setTimeout(() => me.label?.classList.remove('kg-heal'), 700);
	}

	// ---------------------------------------------------------------- skills
	// The server replies to a 'skills' request with the local player's own XP
	// detail (raw XP is never broadcast to peers). Cache the snapshot and, when
	// the panel is open, re-render its bars.
	_onSkills(payload) {
		this._skills = payload && payload.skills ? payload : null;
		if (this._skillsOpen) this._renderSkills();
	}

	// A real server 'levelup' event: refresh the panel snapshot (so its bar/level
	// jump immediately) and fire a celebratory toast with the skill's icon.
	_onLevelup({ skill, level } = {}) {
		const meta = SKILL_META[skill];
		if (!meta || !Number.isFinite(level)) return;
		this.net?.skills(); // pull fresh XP so an open panel reflects the new level

		const cap = this._skills?.cap || 99;
		const maxed = level >= cap;
		const el = document.createElement('div');
		el.className = 'kg-levelup';
		el.style.setProperty('--kg-hue', meta.hue);
		el.innerHTML =
			`<span class="kg-levelup-ico"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${meta.icon}"/></svg></span>` +
			`<span class="kg-levelup-txt">` +
				`<span class="kg-levelup-kicker">${maxed ? 'Skill mastered' : 'Level up'}</span>` +
				`<span class="kg-levelup-main">${meta.label} <b>${level}</b></span>` +
			`</span>`;
		this.hud.levelups?.appendChild(el);
		requestAnimationFrame(() => el.classList.add('kg-levelup--in'));
		setTimeout(() => { el.classList.remove('kg-levelup--in'); setTimeout(() => el.remove(), 420); }, 3400);
	}

	// Open/close the skills drawer. `force` (true/false) sets an explicit state;
	// omitting it toggles. On open we pull a fresh snapshot and start a light poll
	// so XP bars fill in real time as the player gathers/fights.
	_toggleSkills(force) {
		const next = force === undefined ? !this._skillsOpen : !!force;
		if (next === this._skillsOpen) return;
		// Only meaningful in the world; ignore opens from the start/offline screens.
		if (next && this.phase !== 'world') return;
		this._skillsOpen = next;

		const panel = this.hud.skillsPanel;
		this.hud.skillsBtn?.setAttribute('aria-expanded', String(next));
		if (!panel) return;

		if (next) {
			panel.hidden = false;
			void panel.offsetWidth; // reflow so the slide-in transition runs
			panel.classList.add('kg-skills--open');
			this._renderSkills();             // paint cached data (or the loading row)
			this.net?.skills();               // and request the freshest snapshot
			clearInterval(this._skillsTimer);
			this._skillsTimer = setInterval(() => this.net?.skills(), 1500);
			this.hud.skillsClose?.focus();
		} else {
			panel.classList.remove('kg-skills--open');
			clearInterval(this._skillsTimer);
			this._skillsTimer = null;
			if (document.activeElement && panel.contains(document.activeElement)) this.hud.skillsBtn?.focus();
			// Hide after the slide-out so it isn't focusable mid-transition.
			setTimeout(() => { if (!this._skillsOpen) panel.hidden = true; }, 220);
		}
	}

	_renderSkills() {
		const list = this.hud.skillsList;
		if (!list) return;
		const data = this._skills;
		if (!data) {
			list.setAttribute('aria-busy', 'true');
			list.innerHTML = '<li class="kg-skills-loading">Loading your progress…</li>';
			return;
		}
		list.setAttribute('aria-busy', 'false');
		const cap = data.cap || 99;
		if (this.hud.skillsCap) this.hud.skillsCap.textContent = String(cap);
		if (this.hud.skillsTotal) this.hud.skillsTotal.textContent = data.total != null ? String(data.total) : '—';
		if (this.hud.skillsAvg) this.hud.skillsAvg.textContent = data.average != null ? data.average.toFixed(1) : '—';

		const rows = [];
		for (const skill of SKILL_ORDER) {
			const s = data.skills[skill];
			const meta = SKILL_META[skill];
			if (!s || !meta) continue;
			const maxed = s.level >= cap;
			const fresh = s.level <= 1 && (s.xp | 0) === 0;
			let pct, xpLabel, aria;
			if (maxed) {
				pct = 1;
				xpLabel = 'Mastered';
				aria = `${meta.label} mastered, level ${cap}`;
			} else {
				const span = Math.max(1, s.nextXp - s.levelXp);
				const into = Math.max(0, Math.min(span, s.xp - s.levelXp));
				pct = into / span;
				xpLabel = `${fmtXp(into)} / ${fmtXp(span)} XP`;
				aria = `${meta.label} level ${s.level}, ${Math.round(pct * 100)}% to level ${s.level + 1}`;
			}
			const cls = 'kg-skill' + (maxed ? ' kg-skill--max' : '') + (fresh ? ' kg-skill--fresh' : '');
			rows.push(
				`<li class="${cls}" data-skill="${skill}" style="--kg-hue:${meta.hue}" aria-label="${aria}">` +
					`<span class="kg-skill-ico"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${meta.icon}"/></svg></span>` +
					`<span class="kg-skill-main">` +
						`<span class="kg-skill-top">` +
							`<span class="kg-skill-name">${meta.label}</span>` +
							`<span class="kg-skill-lvl">${maxed ? '<em>MAX</em>' : ''}<b>${s.level}</b><i>/${cap}</i></span>` +
						`</span>` +
						`<span class="kg-skill-bar"><i style="width:${(pct * 100).toFixed(1)}%"></i></span>` +
						`<span class="kg-skill-xp">${xpLabel}</span>` +
					`</span>` +
				`</li>`,
			);
		}
		list.innerHTML = rows.join('');
	}

	// ---------------------------------------------------------------- input
	_bindInput() {
		window.addEventListener('keydown', (e) => {
			if (this._typing()) return;
			const k = e.key.toLowerCase();
			// Skills panel: K toggles, Escape closes it. Handled as discrete actions
			// (not movement keys) so they don't leak into the held-key set.
			if (k === 'k') { e.preventDefault(); this._toggleSkills(); return; }
			if (k === 'escape' && this._skillsOpen) { e.preventDefault(); this._toggleSkills(false); return; }
			// Quests panel: Q toggles, Escape closes any open quest/bank/NPC surface.
			if (k === 'q' && this.phase === 'world') { e.preventDefault(); this.q?.toggleQuests(); return; }
			// Hotbar number keys 1–6: select that slot (and ride a mount on it).
			if (this.phase === 'world' && k >= '1' && k <= '6') { e.preventDefault(); this._equipOrRide(+k - 1); return; }
			if (k === 'escape') { this.q?.closeQuests(); this.q?.closeBank(); this.q?.closeNpc(); }
			// Hotbar 1–6: equip that slot (server validates + patches activeSlot back).
			if (this.phase === 'world' && k >= '1' && k <= '6') { e.preventDefault(); this.net?.equip(parseInt(k, 10) - 1); return; }
			// Chat focus: C (or Enter) opens the chat input once in the world. The
			// _typing() guard above means held movement keys never leak into chat,
			// and opening clears the held set so the avatar doesn't walk while typing.
			if (this.phase === 'world' && (k === 'c' || k === 'enter')) { e.preventDefault(); this._openChat(); return; }
			this.keys.add(k);
		});
		window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
		window.addEventListener('blur', () => this.keys.clear());

		this.canvas.addEventListener('pointerdown', (e) => {
			this._dragging = true; this._lastPtr = { x: e.clientX, y: e.clientY };
			this._downAt = performance.now(); this._dragMoved = 0;
		});
		window.addEventListener('pointerup', (e) => {
			const wasDragging = this._dragging;
			this._dragging = false;
			// A short, near-stationary press over the canvas is a tap → world pick
			// (click an adjacent tombstone to loot it). A drag rotated the camera.
			if (!wasDragging || e.target !== this.canvas) return;
			if (performance.now() - this._downAt < 300 && this._dragMoved < 7) {
				this._onTap(e.clientX, e.clientY);
			}
		});
		window.addEventListener('pointermove', (e) => {
			if (!this._dragging) return;
			const dx = e.clientX - this._lastPtr.x, dy = e.clientY - this._lastPtr.y;
			this._lastPtr = { x: e.clientX, y: e.clientY };
			this._dragMoved += Math.abs(dx) + Math.abs(dy);
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
		// No manual input: walk toward a click-to-interact / move target instead.
		if (!f && !r) { if (this._target) this._stepTowardTarget(me); return; }
		this._target = null; // manual movement overrides any click target

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

	// The tile of the current target (a node/mob/npc view, or a plain move tile).
	// Returns null — and clears the target — once the target is gone (node
	// depleted, mob dead, view removed), so the loop never chases a ghost.
	_targetTile() {
		const t = this._target;
		if (!t) return null;
		if (t.kind === 'tile') return { tx: t.tx, ty: t.ty };
		if (t.kind === 'node') { const v = this.nodeViews.get(t.id); if (!v || v.node.depleted) return null; return { tx: v.node.tx, ty: v.node.ty }; }
		if (t.kind === 'mob') { const v = this.mobViews.get(t.id); if (!v || v.mob.dead) return null; return { tx: v.mob.tx, ty: v.mob.ty }; }
		if (t.kind === 'npc') { const v = this.npcViews.get(t.id); if (!v) return null; return { tx: v.npc.tx, ty: v.npc.ty }; }
		return null;
	}

	// One greedy 8-way step toward the current target. For interact targets we
	// stop once adjacent (the action fires from _serviceInteraction); for a plain
	// move tile we stop on arrival.
	_stepTowardTarget(me) {
		const t = this._targetTile();
		if (!t) { this._target = null; return; }
		const interact = this._target.kind !== 'tile';
		const adx = Math.abs(me.tx - t.tx), ady = Math.abs(me.ty - t.ty);
		if (interact ? (adx <= 1 && ady <= 1) : (me.tx === t.tx && me.ty === t.ty)) {
			if (!interact) this._target = null; // arrived at a move tile
			return;
		}
		const dtx = Math.sign(t.tx - me.tx);
		const dty = Math.sign(t.ty - me.ty);
		const yaw = Math.atan2(dtx, dty);
		// Prefer the diagonal, then slide along whichever axis is clear; if fully
		// boxed in, give up on the target rather than jitter in place.
		if (dtx && dty && this._isWalkable(me.tx + dtx, me.ty + dty) &&
			(this._isWalkable(me.tx + dtx, me.ty) || this._isWalkable(me.tx, me.ty + dty))) {
			this._sendStep(me.tx + dtx, me.ty + dty, yaw);
		} else if (dtx && this._isWalkable(me.tx + dtx, me.ty)) {
			this._sendStep(me.tx + dtx, me.ty, yaw);
		} else if (dty && this._isWalkable(me.tx, me.ty + dty)) {
			this._sendStep(me.tx, me.ty + dty, yaw);
		} else if (dtx && dty && this._isWalkable(me.tx + dtx, me.ty + dty)) {
			this._sendStep(me.tx + dtx, me.ty + dty, yaw);
		} else {
			this._target = null; // boxed in — drop the target so we don't spin
		}
	}

	// When adjacent to an interact target, perform the action on the right cadence:
	// talk once (NPC), or repeatedly gather/attack (auto-equipping the matching
	// tool) until the node depletes / mob dies. Driven each frame from the loop.
	_serviceInteraction(dt) {
		const t = this._target;
		if (!t || t.kind === 'tile') return;
		const me = this._localView();
		const ps = this.net?.state?.players?.get(this.myId);
		if (!me || !ps || me.dead) return;
		const tile = this._targetTile();
		if (!tile) { this._target = null; return; }
		if (Math.abs(me.tx - tile.tx) > 1 || Math.abs(me.ty - tile.ty) > 1) return; // not there yet

		if (t.kind === 'npc') { this.net?.npcTalk(t.id); this._target = null; return; }

		this._interactAccum += dt * 1000;
		if (this._interactAccum < INTERACT_ACTION_MS) return;
		this._interactAccum = 0;
		if (t.kind === 'node') {
			const v = this.nodeViews.get(t.id);
			if (!v || v.node.depleted) { this._target = null; return; }
			this._equipForGather(ps, v.node.kind);
			this.net?.gather(t.id);
		} else if (t.kind === 'mob') {
			const v = this.mobViews.get(t.id);
			if (!v || v.mob.dead) { this._target = null; return; }
			this._equipTool(ps, 'sword');
			this.net?.attack(t.id);
		}
	}

	// Auto-equip the tool a node kind needs (axe for trees, pickaxe for rock/coal),
	// mirroring the rod auto-equip the fishing flow uses, so a click just works.
	_equipForGather(ps, kind) {
		this._equipTool(ps, kind === 'tree' ? 'axe' : 'pickaxe');
	}
	_equipTool(ps, tool) {
		if (ps.hotbar[ps.activeSlot]?.item === tool) return;
		for (let i = 0; i < ps.hotbar.length; i++) {
			if (ps.hotbar[i].item === tool) { this.net?.equip(i); return; }
		}
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
		for (const [, v] of this.npcViews) {
			if (v.npc.tx === tx && v.npc.ty === ty) return false;
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
			skillsBtn: document.getElementById('kg-skills-btn'),
			skillsPanel: document.getElementById('kg-skills'),
			skillsClose: document.getElementById('kg-skills-close'),
			skillsList: document.getElementById('kg-skills-list'),
			skillsTotal: document.getElementById('kg-skills-total'),
			skillsAvg: document.getElementById('kg-skills-avg'),
			skillsCap: document.getElementById('kg-skills-cap'),
			levelups: document.getElementById('kg-levelups'),
			actions: document.getElementById('kg-actions'),
			cookBtn: document.getElementById('kg-cook'),
			eatBtn: document.getElementById('kg-eat'),
			castBtn: document.getElementById('kg-cast'),
			chat: document.getElementById('kg-chat'),
			chatLog: document.getElementById('kg-chat-log'),
			chatForm: document.getElementById('kg-chat-form'),
			chatInput: document.getElementById('kg-chat-input'),
			chatMutedBtn: document.getElementById('kg-chat-muted-btn'),
			chatMutedN: document.getElementById('kg-chat-muted-n'),
			chatMutedList: document.getElementById('kg-chat-muted'),
			death: document.getElementById('kg-death'),
			deathMsg: document.getElementById('kg-death-msg'),
			deathCount: document.getElementById('kg-death-count'),
			tombPanel: document.getElementById('kg-tomb-panel'),
			tombOwner: document.getElementById('kg-tomb-owner'),
			tombItems: document.getElementById('kg-tomb-items'),
			tombTtl: document.getElementById('kg-tomb-ttl'),
			tombTake: document.getElementById('kg-tomb-take'),
			tombClose: document.getElementById('kg-tomb-close'),
			mount: document.getElementById('kg-mount'),
			mountName: document.getElementById('kg-mount-name'),
			dismountBtn: document.getElementById('kg-dismount'),
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

		this.hud.skillsBtn?.addEventListener('click', () => this._toggleSkills());
		this.hud.skillsClose?.addEventListener('click', () => this._toggleSkills(false));

		// Death-bag recovery panel: "Take all" re-sends tombLoot (useful once the
		// pack has space again); the X just dismisses the panel (the bag stays).
		this.hud.tombTake?.addEventListener('click', () => { if (this._lootTombId) this.net?.tombLoot(this._lootTombId); });
		this.hud.tombClose?.addEventListener('click', () => this._closeLootPanel());

		// Contextual action bar: cook a batch of fish, or eat the first food slot.
		this.hud.cookBtn?.addEventListener('click', () => this.net?.cook(5));
		this.hud.eatBtn?.addEventListener('click', () => { if (this._eatRef) this.net?.consume(this._eatRef); });
		this.hud.dismountBtn?.addEventListener('click', () => this.net?.dismount());
		this.hud.castBtn?.addEventListener('click', () => this._attemptCast());

		this._bindChat();
		this._setHudPhase('start');
	}

	_setHudPhase(phase) {
		this.hud.start.hidden = phase !== 'start';
		this.hud.offline.hidden = phase !== 'offline';
		this.hud.topbar.hidden = !(phase === 'world' || phase === 'connecting');
		this.hud.hint.hidden = phase !== 'world';
		// The contextual action bar only makes sense in-world; hide it elsewhere so
		// a reconnect/offline screen never shows stale Cook/Eat buttons.
		if (this.hud.actions && phase !== 'world') this.hud.actions.hidden = true;
		if (this.hud.mount && phase !== 'world') this.hud.mount.hidden = true;
		// The skills toggle is only meaningful once in the world; leaving it closes
		// the panel so a reconnect/offline screen never shows a stale drawer.
		if (phase !== 'world') this._toggleSkills(false);
		// World chat shows only in-world. Reveal the panel on entry; on exit close
		// and hide it so the start/offline screens stay clean.
		if (this.hud.chat) {
			this.hud.chat.hidden = phase !== 'world';
			if (phase !== 'world') this._closeChat(true);
		}
		// Death overlay + bag panel are world-only; clear them on any exit so a
		// reconnect never strands a respawn countdown or an orphaned bag panel.
		if (phase !== 'world') {
			this._deathInfo = null; this._deathShown = false;
			if (this.hud.death) this.hud.death.hidden = true;
			this._closeLootPanel();
		}
		document.body.classList.toggle('kg-loading-cursor', phase === 'connecting');
	}

	// ---------------------------------------------------------------- chat
	// World chat: send/receive realm-wide messages, route `/commands` through the
	// server command system, and mute players client-side. The panel is collapsed
	// (click-through) until focused so it never blocks the world.

	_loadMuted() {
		try {
			const raw = JSON.parse(localStorage.getItem('kg-muted') || '[]');
			return new Set(Array.isArray(raw) ? raw.filter((n) => typeof n === 'string') : []);
		} catch { return new Set(); }
	}

	_saveMuted() {
		try { localStorage.setItem('kg-muted', JSON.stringify([...this.muted])); } catch { /* storage may be unavailable */ }
	}

	_bindChat() {
		if (!this.hud.chat) return;
		this.hud.chatForm?.addEventListener('submit', (e) => { e.preventDefault(); this._sendChat(); });
		// Focusing the input expands the panel; blurring with nothing typed collapses it.
		this.hud.chatInput?.addEventListener('focus', () => this._openChat());
		this.hud.chatInput?.addEventListener('blur', (e) => {
			// Stay open if focus moved to another chat control (a sender name, the
			// Muted button, the mute menu) — only collapse when focus truly leaves.
			if (this.hud.chat?.contains(e.relatedTarget)) return;
			if (!this.hud.chatInput.value.trim()) this._closeChat();
		});
		this.hud.chatInput?.addEventListener('keydown', (e) => {
			// Esc clears + closes; everything else stays in the field (the global
			// keydown bails on _typing(), so movement keys never fire while chatting).
			if (e.key === 'Escape') { e.preventDefault(); this.hud.chatInput.value = ''; this._closeChat(); }
			e.stopPropagation();
		});
		this.hud.chatMutedBtn?.addEventListener('click', () => this._toggleMutedList());
		this._updateMutedCount();
	}

	_openChat() {
		if (!this.hud.chat || this.phase !== 'world') return;
		this.keys.clear(); // drop held movement keys so the avatar doesn't walk while typing
		if (!this._chatOpen) {
			this._chatOpen = true;
			this.hud.chat.classList.add('kg-chat--open');
			this._scrollChat();
		}
		if (document.activeElement !== this.hud.chatInput) this.hud.chatInput?.focus();
	}

	_closeChat(force) {
		this._closeMuteMenu();
		this._toggleMutedList(false);
		if (!this._chatOpen && !force) return;
		this._chatOpen = false;
		this.hud.chat?.classList.remove('kg-chat--open');
		if (document.activeElement === this.hud.chatInput) this.hud.chatInput.blur();
	}

	_sendChat() {
		const input = this.hud.chatInput;
		if (!input) return;
		const text = input.value.trim();
		input.value = '';
		if (!text) { this._closeChat(); return; }
		// Server is authoritative: it sanitizes, rate-limits, routes `/commands`, and
		// echoes accepted messages back to everyone (us included) as 'chat' events.
		this.net?.chat(text);
		input.focus(); // keep the field hot for a flowing conversation
	}

	_onChat(msg) {
		if (!msg || typeof msg.text !== 'string') return;
		const line = this._appendChatLine(msg);
		if (!line) return;
		// Hide muted senders (but never our own messages, even to a namesake).
		if (!msg.system && msg.id !== this.myId && this.muted.has(msg.name)) {
			line.classList.add('kg-chat-line--muted');
			return;
		}
		this._scrollChat();
	}

	_appendChatLine(msg) {
		const log = this.hud.chatLog;
		if (!log) return null;
		const line = document.createElement('div');
		line.className = 'kg-chat-line';
		if (msg.system) {
			line.classList.add('kg-chat-line--system');
			if (msg.kind === 'error') line.classList.add('kg-chat-line--error');
			const t = document.createElement('span');
			t.className = 'kg-chat-text';
			t.textContent = msg.text;
			line.appendChild(t);
		} else {
			const name = msg.name || 'player';
			line.dataset.name = name;
			const isMe = msg.id && msg.id === this.myId;
			const nameEl = document.createElement('button');
			nameEl.type = 'button';
			nameEl.className = 'kg-chat-name' + (isMe ? ' kg-chat-name--me' : '');
			nameEl.textContent = name;
			if (isMe) {
				nameEl.disabled = true;
			} else {
				nameEl.title = `Mute ${name}`;
				nameEl.setAttribute('aria-label', `Mute ${name}`);
				nameEl.addEventListener('click', (e) => this._openMuteMenu(e, name));
			}
			const t = document.createElement('span');
			t.className = 'kg-chat-text';
			t.textContent = msg.text;
			line.append(nameEl, t);
		}
		log.appendChild(line);
		// Bound the scrollback so a long session can't grow the DOM without limit.
		while (log.children.length > 120) log.removeChild(log.firstChild);
		return line;
	}

	// Local-only system line (mute confirmations) — same look as server replies.
	_sysLine(text, kind) {
		this._onChat({ system: true, kind: kind || 'system', text, ts: Date.now() });
	}

	_scrollChat() {
		const log = this.hud.chatLog;
		if (!log) return;
		// Auto-scroll only when already near the bottom (or collapsed, which always
		// pins to the latest) so reading scrollback isn't yanked away.
		const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
		if (nearBottom || !this._chatOpen) log.scrollTop = log.scrollHeight;
	}

	// ----- mute ------------------------------------------------------------

	_openMuteMenu(e, name) {
		if (!name || !this.hud.chat) return;
		this._closeMuteMenu();
		const muted = this.muted.has(name);
		const menu = document.createElement('div');
		menu.className = 'kg-chat-menu';
		menu.setAttribute('role', 'menu');
		const btn = document.createElement('button');
		btn.type = 'button';
		btn.className = 'kg-chat-menu-btn';
		btn.setAttribute('role', 'menuitem');
		btn.textContent = (muted ? 'Unmute ' : 'Mute ') + name;
		btn.addEventListener('click', () => {
			if (muted) this._unmute(name); else this._mute(name);
			this._closeMuteMenu();
		});
		menu.appendChild(btn);
		this.hud.chat.appendChild(menu);
		// Float the popover just above the clicked name, clamped inside the panel.
		const target = e.currentTarget.getBoundingClientRect();
		const host = this.hud.chat.getBoundingClientRect();
		const left = Math.max(0, Math.min(target.left - host.left, host.width - menu.offsetWidth));
		menu.style.left = `${left}px`;
		menu.style.bottom = `${host.bottom - target.top + 4}px`;
		this._muteMenu = menu;
		btn.focus();
		// Dismiss on outside click or Escape.
		this._muteMenuCloser = (ev) => {
			if (ev.type === 'keydown' && ev.key !== 'Escape') return;
			if (ev.type === 'pointerdown' && menu.contains(ev.target)) return;
			this._closeMuteMenu();
		};
		setTimeout(() => {
			document.addEventListener('pointerdown', this._muteMenuCloser, true);
			document.addEventListener('keydown', this._muteMenuCloser, true);
		}, 0);
	}

	_closeMuteMenu() {
		if (this._muteMenuCloser) {
			document.removeEventListener('pointerdown', this._muteMenuCloser, true);
			document.removeEventListener('keydown', this._muteMenuCloser, true);
			this._muteMenuCloser = null;
		}
		if (this._muteMenu) { this._muteMenu.remove(); this._muteMenu = null; }
	}

	_mute(name) {
		if (!name) return;
		this.muted.add(name);
		this._saveMuted();
		this._applyMuteState(name);
		this._updateMutedCount();
		if (this._mutedListOpen) this._renderMutedList();
		this._sysLine(`Muted ${name}. Their messages are hidden.`);
	}

	_unmute(name) {
		if (!this.muted.delete(name)) return;
		this._saveMuted();
		this._applyMuteState(name);
		this._updateMutedCount();
		if (this._mutedListOpen) this._renderMutedList();
		this._sysLine(`Unmuted ${name}.`);
	}

	// Reveal or hide every existing line from a sender as their mute state flips —
	// so unmuting restores the scrollback, not just future messages.
	_applyMuteState(name) {
		const muted = this.muted.has(name);
		for (const line of this.hud.chatLog?.children || []) {
			if (line.dataset && line.dataset.name === name) {
				line.classList.toggle('kg-chat-line--muted', muted);
			}
		}
		if (!muted) this._scrollChat();
	}

	_updateMutedCount() {
		if (this.hud.chatMutedN) this.hud.chatMutedN.textContent = String(this.muted.size);
	}

	_toggleMutedList(force) {
		const list = this.hud.chatMutedList;
		if (!list) return;
		const open = force === undefined ? list.hidden : !!force;
		this._mutedListOpen = open;
		this.hud.chatMutedBtn?.setAttribute('aria-expanded', String(open));
		if (open) { this._renderMutedList(); list.hidden = false; }
		else list.hidden = true;
	}

	_renderMutedList() {
		const list = this.hud.chatMutedList;
		if (!list) return;
		list.replaceChildren();
		if (!this.muted.size) {
			const empty = document.createElement('div');
			empty.className = 'kg-chat-muted-empty';
			empty.textContent = 'No muted players.';
			list.appendChild(empty);
			return;
		}
		for (const name of [...this.muted].sort((a, b) => a.localeCompare(b))) {
			const row = document.createElement('div');
			row.className = 'kg-chat-muted-row';
			const nm = document.createElement('span');
			nm.className = 'kg-chat-muted-name';
			nm.textContent = name;
			const btn = document.createElement('button');
			btn.type = 'button';
			btn.className = 'kg-chat-unmute';
			btn.textContent = 'Unmute';
			btn.setAttribute('aria-label', `Unmute ${name}`);
			btn.addEventListener('click', () => this._unmute(name));
			row.append(nm, btn);
			list.appendChild(row);
		}
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
			if (this._stepAccum >= this._stepInterval()) { this._stepAccum = 0; this._attemptStep(); }
			this._serviceInteraction(dt);
			for (const [, v] of this.players) v.tick(dt);
			this._updateCamera();
			this._updateLabels();
			this._updateNpcLabels();
			this._updateTombLabels();
			this._updateDeathOverlay();
			this._updateActions();
			this._tickCast(now);
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

	// Project each NPC's nameplate + quest marker to screen space.
	_updateNpcLabels() {
		if (!this.npcViews.size) return;
		const w = window.innerWidth, h = window.innerHeight;
		const v = new Vector3();
		for (const [, nv] of this.npcViews) {
			v.set(nv.group.position.x, nv.height + 0.5, nv.group.position.z).project(this.camera);
			if (v.z > 1) { nv.label.style.display = 'none'; continue; }
			nv.label.style.display = '';
			const sx = (v.x * 0.5 + 0.5) * w;
			const sy = (-v.y * 0.5 + 0.5) * h;
			nv.label.style.transform = `translate(-50%, -100%) translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px)`;
		}
	}

	// Project each tombstone's headstone to screen space, place its DOM label, and
	// tick the live "expires in Xs" countdown straight off the synced expiresAt.
	_updateTombLabels() {
		if (!this.tombViews.size) return;
		const w = window.innerWidth, h = window.innerHeight;
		const now = Date.now();
		const v = new Vector3();
		for (const [, tv] of this.tombViews) {
			v.set(tv.group.position.x, 1.2, tv.group.position.z).project(this.camera);
			if (v.z > 1) { tv.label.style.display = 'none'; continue; }
			tv.label.style.display = '';
			const sx = (v.x * 0.5 + 0.5) * w;
			const sy = (-v.y * 0.5 + 0.5) * h;
			tv.label.style.transform = `translate(-50%, -100%) translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px)`;
			const secs = Math.max(0, Math.ceil((tv.tomb.expiresAt - now) / 1000));
			tv.ttlEl.textContent = `${secs}s`;
			tv.label.classList.toggle('kg-tomb-soon', secs <= 45);
		}
		if (this._lootTombId) this._updateTombPanelTtl();
	}

	// Show/hide the respawn overlay from the local player's authoritative state.
	// The countdown reads the synced respawnAt; the overlay clears the instant the
	// server marks us alive again (the schema flip), never a client-side guess.
	_updateDeathOverlay() {
		const me = this._localView();
		const death = this.hud.death;
		if (!death) return;
		if (me?.dead) {
			if (!this._deathShown) {
				this._deathShown = true;
				death.hidden = false;
				this.hud.deathMsg.textContent = this._deathMessage();
			}
			const ms = Math.max(0, (me.respawnAt || 0) - Date.now());
			this.hud.deathCount.textContent = me.respawnAt ? `Respawning in ${Math.ceil(ms / 1000)}s` : 'Respawning…';
		} else if (this._deathShown) {
			this._deathShown = false;
			this._deathInfo = null;
			death.hidden = true;
		}
	}

	_onResize() {
		this.camera.aspect = window.innerWidth / window.innerHeight;
		this.camera.updateProjectionMatrix();
		this.renderer.setSize(window.innerWidth, window.innerHeight);
	}

	destroy() {
		clearInterval(this._skillsTimer);
		this._skillsTimer = null;
		this._closeMuteMenu();
		this.net?.destroy();
		for (const [, v] of this.players) v.dispose();
		this.players.clear();
		for (const [, tv] of this.tombViews) { this.objectGroup.remove(tv.group); tv.label.remove(); }
		this.tombViews.clear();
		this._disposeNpcs();
		this.q?.destroy();
		this._clearCast();
		this._nipple?.destroy();
	}
}

const canvas = document.getElementById('kg-canvas');
if (canvas) {
	const game = new IsoGame(canvas);
	if (typeof window !== 'undefined') window.__ISO__ = game;
}
