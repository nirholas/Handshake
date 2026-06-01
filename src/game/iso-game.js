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
	HemisphereLight, DirectionalLight, AmbientLight, PointLight, PCFSoftShadowMap, SRGBColorSpace,
	Mesh, MeshStandardMaterial, MeshBasicMaterial, PlaneGeometry, BoxGeometry,
	CylinderGeometry, ConeGeometry, DodecahedronGeometry, IcosahedronGeometry,
	CircleGeometry, CanvasTexture, RepeatWrapping, DoubleSide,
	Raycaster, Vector2, SphereGeometry, RingGeometry,
	BufferGeometry, Line, LineBasicMaterial, Float32BufferAttribute,
} from 'three';
import nipplejs from 'nipplejs';

import { GameNet, fetchServers } from './game-net.js';
import { getPresenceTicket } from '../friends.js';
import {
	loadManifest, resolveAvatarUrl, buildAvatar, newAnim, CLIP_IDLE, CLIP_WALK,
} from './avatar-rig.js';
import { GUEST_SENTINEL, uploadPendingGuestAvatar } from './play-handoff.js';
import { GameHud } from './game-hud.js';
import { applyCosmetic } from './cosmetics-visual.js';

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

// Mirrors items.js#scaledHeal so the Eat button can preview the exact heal value
// without a round-trip. Must stay in sync with the server formula.
function clientScaledHeal(item, baseHeal, cookingLevel) {
	if (item === 'cookedFish') return (baseHeal || 0) + Math.floor((Math.max(1, cookingLevel | 0) - 1) * 0.3);
	return baseHeal || 0;
}

// Player-built structures (Task 07): presentation only — icon, label, and a short
// pitch for the build menu. The realm's allowed kinds and the authoritative costs
// arrive from the server (the realm message's `buildCatalog`), so this never
// hard-codes prices and never drifts from what the server will actually charge.
const STRUCTURE_META = {
	firepit: { icon: '🔥', label: 'Firepit', desc: 'Heals allies beside it for ~30s, then burns out.' },
	shack: { icon: '🛖', label: 'Shack', desc: 'A permanent landmark. One per builder.' },
};
// Material icons for the build-menu cost chips (mirrors items.js labels/icons; the
// HUD has its own copy for backpack rendering — this keeps the scene self-contained).
const MATERIAL_ICON = { wood: '🪵', stone: '🪨', coal: '⚫' };

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
	constructor(scene, tileToWorld, player, isLocal, cosmeticFor) {
		this.scene = scene;
		this.tileToWorld = tileToWorld;
		this.isLocal = isLocal;
		this.id = player.id;
		// Resolver (id → visual spec) from the server cosmetics catalogue. Lets this
		// view layer any peer's equipped cosmetic (tint / prop / aura) over the base
		// avatar. Strictly visual — never consulted for anything gameplay-affecting.
		this._cosmeticFor = cosmeticFor || (() => null);

		this.rig = new Group();
		// Tag the rig so a PvP-realm raycast can resolve a click on this body back to its
		// player id (the local player is filtered out at the call site, you can't hit yourself).
		this.rig.userData.playerId = player.id;
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

		// Speech bubble: floats just above the nameplate when this player chats.
		// Positioned each frame alongside the nameplate so it tracks movement.
		this.bubble = document.createElement('div');
		this.bubble.className = 'kg-chat-bubble';
		this.bubble.hidden = true;
		document.getElementById('kg-labels')?.appendChild(this.bubble);
		this._bubbleTimer = null;

		// Mount visuals (Task 09): a steed mesh + saddle lift, attached in applyMount.
		this.mounted = false;
		this._steed = null;
		this._saddleY = 0;
		this._rideRate = 1.5;
		this._avatarUrl = null;
		// Equipped cosmetic (Task 21): the id and the live visual handle layered over
		// the avatar. Re-applied after every avatar (re)load, since loading clears the
		// rig. Both local player and peers render their equipped look.
		this._cosmeticId = player.cosmeticId || '';
		this._cosmeticHandle = null;
		// Wardrobe try-before-equip (local player only): the server-authoritative
		// equipped id, plus a non-null pin that overrides it while previewing a look
		// before committing, so movement patches don't snap the preview back.
		this._serverCosmeticId = this._cosmeticId;
		this._cosmeticPin = null;
		this.setAvatar(player.cosmetic || '');
	}

	// Preview a look locally with no server round-trip. `id` is a cosmetic id (or ''
	// for the default look); null clears the preview and reverts to the equipped id.
	previewCosmetic(id) {
		this._cosmeticPin = id;
		this.setCosmetic(id == null ? this._serverCosmeticId : id);
	}

	setAvatar(url) {
		const next = url || AVATAR_DEFAULT;
		if (next === this._avatarUrl) return;
		this._avatarUrl = next;
		// Loading rebuilds the rig from scratch, so drop the cosmetic layer first
		// (restoring any tinted materials) and re-mount it once the new model lands.
		this._disposeCosmetic();
		this.rig.clear();
		this.anim = newAnim();
		resolveAvatarUrl(next).then((u) => buildAvatar(this.rig, u, this.anim).then(({ height }) => {
			this.height = height;
			this.anim.crossfadeTo(this.motion === 'walk' ? CLIP_WALK : CLIP_IDLE, 0);
			this._mountCosmetic();
		}));
	}

	// Equip (or clear) the cosmetic this view renders. No-op if unchanged; mounts
	// the new look immediately when the model is already loaded (re-mounts after a
	// reload via setAvatar's callback otherwise).
	setCosmetic(id) {
		const next = id || '';
		if (next === this._cosmeticId) return;
		this._cosmeticId = next;
		this._mountCosmetic();
	}

	_mountCosmetic() {
		this._disposeCosmetic();
		const visual = this._cosmeticId ? this._cosmeticFor(this._cosmeticId) : null;
		if (visual) this._cosmeticHandle = applyCosmetic(this.rig, this.height, visual);
	}

	_disposeCosmetic() {
		if (this._cosmeticHandle) { this._cosmeticHandle.dispose(); this._cosmeticHandle = null; }
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
		// The equipped cosmetic is server-authoritative for everyone (including us,
		// after an equip round-trips), so peers AND the local player track it here.
		// setCosmetic self-guards, so it's a no-op until the equipped id changes.
		this._serverCosmeticId = player.cosmeticId || '';
		this.setCosmetic(this._cosmeticPin != null ? this._cosmeticPin : this._serverCosmeticId);
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
		// Animate the equipped cosmetic (e.g. a slowly-spinning, pulsing aura).
		this._cosmeticHandle?.tick(dt);
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

	// Show a speech bubble above this avatar for a few seconds, then fade it out.
	showBubble(text) {
		if (this._bubbleTimer) { clearTimeout(this._bubbleTimer); this._bubbleTimer = null; }
		this.bubble.textContent = text;
		this.bubble.hidden = false;
		this.bubble.classList.remove('kg-chat-bubble--fade');
		this._bubbleTimer = setTimeout(() => {
			this.bubble.classList.add('kg-chat-bubble--fade');
			this._bubbleTimer = setTimeout(() => {
				this.bubble.hidden = true;
				this.bubble.classList.remove('kg-chat-bubble--fade');
				this._bubbleTimer = null;
			}, 400);
		}, 5000);
	}

	dispose() {
		this._disposeCosmetic();
		if (this._bubbleTimer) clearTimeout(this._bubbleTimer);
		this.scene.remove(this.rig);
		if (this._steed) this.scene.remove(this._steed);
		this.label.remove();
		this.bubble.remove();
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
		this.wheelViews = new Map(); // id -> { group, landmark } — interactable wheels (Task 19)
		this._landmarkGroups = []; // decorative landmark meshes (casino), cleared per realm
		this._casinoLabels = []; // [{ label, x, z, height }] — decorative landmark nameplates
		this.tombViews = new Map(); // id -> { group, tomb, label, nameEl, ttlEl }
		this.structViews = new Map(); // id -> { group, struct, ring, flame } (Task 07)
		this.keys = new Set();
		this.realm = null;
		this.myId = null;

		// Build mode (Task 07): when non-null we're placing a structure — a ghost
		// preview snaps to the tile under the cursor and turns green/red for valid/
		// invalid placement; a tap places it, right-click/Esc cancels, and movement
		// clicks are suppressed until we exit. `_buildCatalog` is the server-sent cost
		// table for the current realm; `_hoverPtr` tracks the cursor so the ghost
		// follows it without a drag.
		this._buildMode = null; // { kind, ghost } | null
		this._buildCatalog = {};
		this._hoverPtr = null;

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
		// state) and the per-account mute set. Mutes are keyed by display name and
		// persisted under the player's stable account id (Task 16) — wallet, else a
		// durable guest id — so a block list follows the account across sessions and
		// two accounts on one machine never share one. The closer fn is the document
		// listener that dismisses an open mute popover.
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
			onBuildSelect: (kind) => this._enterBuildMode(kind),
			onBuildCancel: () => this._exitBuildMode(),
			// Cosmetics shop (Task 21): open re-fetches the live board; buy/equip/
			// unequip route to the authoritative server, which echoes a fresh board.
			onShopOpen: () => this.net?.shopOpen(),
			onBuyCosmetic: (id) => this.net?.buyCosmetic(id),
			onEquipCosmetic: (id) => this.net?.equipCosmetic(id),
			onUnequipCosmetic: () => this.net?.unequipCosmetic(),
			// Wardrobe try-before-equip: preview a look on the local avatar with no
			// server round-trip; null reverts to the server-authoritative equipped look.
			onPreviewCosmetic: (id) => this._previewLocalCosmetic(id),
			onStopPreview: () => this._previewLocalCosmetic(null),
			// Marketplace (Task 20): open fetches the live board; list/cancel/buy-gold
			// route straight to the authoritative server. A token buy is a multi-step
			// on-chain flow the controller drives (_buyTokenListing): quote → wallet
			// sign+send → server-verified settle.
			onMarketOpen: () => this.net?.marketOpen(),
			onMarketListGold: (item, qty, price) => this.net?.marketListGold(item, qty, price),
			onMarketListToken: (gold, usd) => this.net?.marketListToken(gold, usd),
			onMarketCancel: (id) => this.net?.marketCancel(id),
			onMarketBuyGold: (id) => this.net?.marketBuyGold(id),
			onMarketBuyToken: (id) => this._buyTokenListing(id),
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

		const hemi = new HemisphereLight(0xdcebff, 0x49603a, 1.0);
		scene.add(hemi);
		this._hemi = hemi;
		const ambient = new AmbientLight(0xffffff, 0.28);
		scene.add(ambient);
		this._ambient = ambient;
		const sun = new DirectionalLight(0xfff0d4, 1.25);
		sun.position.set(24, 40, 18); sun.castShadow = true;
		sun.shadow.mapSize.set(2048, 2048);
		const s = sun.shadow.camera; s.left = -40; s.right = 40; s.top = 40; s.bottom = -40; s.near = 1; s.far = 140;
		sun.shadow.bias = -0.0004;
		scene.add(sun, sun.target);
		this._sun = sun;
		// Cave torches: warm PointLights added/removed alongside the mine geometry.
		// Stored so _buildRealm can repopulate them on every handoff without leaking.
		this._caveLights = [];

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
		const isCave = !!layout.cave || layout.name === 'mine';
		this.scene.background.set(isCave ? 0x130f0b : 0x223a55);
		this.scene.fog.color.set(isCave ? 0x130f0b : 0x223a55);
		this.scene.fog.near = isCave ? 16 : 48;
		this.scene.fog.far = isCave ? 70 : 120;

		// Scene lighting: underground the sun doesn't reach. Dim the directional
		// and hemi lights to near-zero, deepen the ambient, and scatter warm torch
		// PointLights around the cave so dark corners read as firelit rather than
		// just black. Restoring surface values on exit means the Mainland always
		// looks like open daylight again, never the cave's warmth.
		this._sun.intensity = isCave ? 0.0 : 1.25;
		this._hemi.intensity = isCave ? 0.06 : 1.0;
		this._ambient.intensity = isCave ? 0.18 : 0.28;
		this._ambient.color.set(isCave ? 0x4a3020 : 0xffffff);
		// Remove previous cave lights before adding new ones (handles realm→realm hop).
		for (const l of this._caveLights) this.scene.remove(l);
		this._caveLights = [];
		if (isCave) {
			// Torch positions: corners of each chamber + one near the entrance.
			// Colours alternate between deep orange and warm amber for visual variety.
			const torchTiles = [
				[4, 3, 0xff6a1a], [27, 3, 0xffaa30], [4, 9, 0xffaa30], [27, 9, 0xff6a1a],
				[4, 18, 0xff6a1a], [27, 18, 0xffaa30], [5, 27, 0xffaa30], [27, 27, 0xff6a1a],
				[16, 28, 0xffcc55], // entrance torch — brightest, marks the way out
			];
			for (const [tx, ty, color] of torchTiles) {
				const pt = new PointLight(color, 2.8, 8.0, 1.4);
				const wp = this._tileToWorld(tx, ty);
				pt.position.set(wp.x, 1.6, wp.z);
				this.scene.add(pt);
				this._caveLights.push(pt);
			}
		}

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
		// Portals. An open portal glows violet; a combat-gated one is barred with a
		// red archway. The mine entrance on the Mainland gets a cave-mouth arch so
		// it reads as a tunnel opening rather than a plain glowing tile.
		for (const p of layout.portals || []) {
			const tiles = this._rectTiles(p);
			if (p.gate) { this._paintTiles(tiles, 0xd0455a, 0.75); this._buildGateArch(p); }
			else {
				this._paintTiles(tiles, 0xae7bff, 0.7);
				if (p.to === 'mine') this._buildMineEntrance(p);
			}
		}
		// Arena fittings: spectator stands (no-PvP), the practice boxing ring, and the
		// moving floor rollers — drawn with directional chevrons so the flow is legible.
		this._buildSeating(layout.seating);
		this._buildRing(layout.ring);
		this._buildRollers(layout.rollers);

		// Fixed NPCs (Aldric the Guide, …) — distinct characters with a nameplate +
		// quest marker. Rebuilt with the realm since they ride in the realm layout.
		this._buildNpcs(layout);

		// Fixed landmarks (Task 19): the casino building + its Wheel of Fortune.
		// The wheel is interactable — clicking it walks the player adjacent and opens
		// the spinner; the casino is decorative (its footprint is blocked server-side).
		this._buildLandmarks(layout);

		// Frame the camera on the spawn before the local player exists.
		const sp = this._tileToWorld(layout.spawn?.tx ?? grid / 2, layout.spawn?.ty ?? grid / 2);
		this._camTarget.set(sp.x, 0, sp.z);

		this.hud.realm.textContent = this._realmLabel(layout.name);

		// Topbar world-instance chip (Task 23). Read the server off the synced state
		// (authoritative — confirms which instance we actually landed on) so it can
		// never disagree with what the login picker requested.
		this._updateServerChip();

		// Building (Task 07): the realm's authoritative cost table + allowed kinds.
		// Show the Build button only where this realm permits building, and leave any
		// build mode from a previous realm — its ghost no longer matches these rules.
		this._buildCatalog = layout.buildCatalog || {};
		this._exitBuildMode();
		this.q?.setBuildAvailable(Object.keys(this._buildCatalog).length > 0);
		this._refreshBuildMenu();
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

	// ---------------------------------------------------------------- landmarks
	// Fixed world landmarks (Task 19). The casino is a decorative building; the
	// wheel is an interactable object (tagged for raycast → walk-and-spin). Rebuilt
	// with the realm since they ride in the realm layout.
	_buildLandmarks(layout) {
		this._disposeLandmarks();
		for (const lm of layout.landmarks || []) {
			if (lm.kind === 'wheel') {
				const group = this._buildWheelView();
				const w = this._tileToWorld(lm.tx, lm.ty);
				group.position.set(w.x, 0, w.z);
				group.traverse((o) => { o.userData.wheelId = lm.id; }); // raycast → spin target
				this.objectGroup.add(group);

				const label = document.createElement('div');
				label.className = 'kg-npc-label kg-wheel-label';
				label.innerHTML = `<span class="kg-npc-tag"></span>`;
				label.querySelector('.kg-npc-tag').textContent = lm.label || 'Wheel of Fortune';
				document.getElementById('kg-labels')?.appendChild(label);

				this.wheelViews.set(lm.id, { group, landmark: lm, label, height: 2.2, spin: 0 });
			} else if (lm.kind === 'casino') {
				const group = this._buildCasinoView();
				const w = this._tileToWorld(lm.tx, lm.ty);
				group.position.set(w.x, 0, w.z);
				this.staticGroup.add(group);
				this._landmarkGroups.push(group);

				const label = document.createElement('div');
				label.className = 'kg-npc-label kg-casino-label';
				label.innerHTML = `<span class="kg-npc-tag"></span>`;
				label.querySelector('.kg-npc-tag').textContent = lm.label || 'Casino';
				document.getElementById('kg-labels')?.appendChild(label);
				this._casinoLabels.push({ label, x: w.x, z: w.z, height: 3.0 });
			}
		}
	}

	// A carnival prize wheel: an upright disc with alternating gold/teal sectors, a
	// hub, and a top pointer. Low-poly, no asset load. Slowly idles via _updateLandmarks.
	_buildWheelView() {
		const g = new Group();
		const post = new Mesh(new CylinderGeometry(0.12, 0.16, 1.5, 10),
			new MeshStandardMaterial({ color: 0x5a4632, roughness: 0.9 }));
		post.position.y = 0.75; post.castShadow = true;
		const disc = new Group();
		disc.position.y = 1.7;
		const n = 12, seg = (Math.PI * 2) / n;
		for (let i = 0; i < n; i++) {
			const wedge = new Mesh(
				new CylinderGeometry(0.78, 0.78, 0.12, 24, 1, false, i * seg, seg),
				new MeshStandardMaterial({
					color: i % 2 ? 0xf5c542 : 0x2b9fa8,
					emissive: i % 2 ? 0x4a3a08 : 0x0a3034, emissiveIntensity: 0.5, roughness: 0.5,
				}),
			);
			wedge.rotation.x = Math.PI / 2;
			disc.add(wedge);
		}
		const hub = new Mesh(new SphereGeometry(0.16, 16, 12),
			new MeshStandardMaterial({ color: 0xfff1c0, emissive: 0x6b5410, emissiveIntensity: 0.9, roughness: 0.3 }));
		hub.position.z = 0.08;
		disc.add(hub);
		disc.rotation.y = 0; // faces +Z; idles around Z in _updateLandmarks
		const pointer = new Mesh(new ConeGeometry(0.12, 0.28, 4),
			new MeshStandardMaterial({ color: 0xff5a3a, roughness: 0.5 }));
		pointer.position.set(0, 2.56, 0.06); pointer.rotation.x = Math.PI;
		g.add(post, disc, pointer);
		g.userData.disc = disc;
		g.castShadow = true;
		return g;
	}

	// A small casino pavilion: a warm-lit body with a striped awning and a glowing
	// sign cube, so the wheel reads as part of a venue, not a stray object.
	_buildCasinoView() {
		const g = new Group();
		const body = new Mesh(new BoxGeometry(3.2, 2.0, 2.4),
			new MeshStandardMaterial({ color: 0x6a2b4a, roughness: 0.85 }));
		body.position.y = 1.0; body.castShadow = true; body.receiveShadow = true;
		const roof = new Mesh(new CylinderGeometry(1.9, 1.9, 0.5, 6),
			new MeshStandardMaterial({ color: 0x3a1830, roughness: 0.8 }));
		roof.position.y = 2.25; roof.rotation.y = Math.PI / 6; roof.castShadow = true;
		const sign = new Mesh(new BoxGeometry(1.4, 0.5, 0.18),
			new MeshStandardMaterial({ color: 0xffce5c, emissive: 0xffae3a, emissiveIntensity: 1.1, roughness: 0.4 }));
		sign.position.set(0, 2.0, 1.25);
		const doorway = new Mesh(new BoxGeometry(0.9, 1.3, 0.12),
			new MeshStandardMaterial({ color: 0x140a12, roughness: 1 }));
		doorway.position.set(0, 0.65, 1.21);
		g.add(body, roof, sign, doorway);
		return g;
	}

	_disposeLandmarks() {
		for (const [, v] of this.wheelViews) { this.objectGroup.remove(v.group); v.label?.remove(); }
		this.wheelViews.clear();
		for (const group of this._landmarkGroups) this.staticGroup.remove(group);
		this._landmarkGroups = [];
		for (const cl of this._casinoLabels) cl.label?.remove();
		this._casinoLabels = [];
	}

	// Open the Wheel of Fortune (Task 19). The heavy Solana signing path lives in a
	// lazy chunk, so it only loads the first time a player reaches the wheel. The UI
	// owns its own server subscriptions; we just hand it the net and clear our handle
	// when it closes.
	async _openSpinWheel() {
		if (this._spinUI) { this._spinUI.focus(); return; }
		if (this._spinUILoading) return;
		this._spinUILoading = true;
		try {
			const { openSpinWheel } = await import('./spin-wheel-ui.js');
			this._spinUI = openSpinWheel({ net: this.net, onClose: () => { this._spinUI = null; } });
		} catch (err) {
			console.warn('[spin] failed to open wheel:', err?.message);
			this._toast({ kind: 'spin', text: 'Could not open the wheel. Try again.' });
		} finally {
			this._spinUILoading = false;
		}
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

	// Title-case a realm id for the HUD, turning multi-word ids into readable labels
	// ('wilderness_north' → 'Wilderness North', 'arena' → 'Arena').
	_realmLabel(name) {
		return (name || 'realm').split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
	}

	// A red barred archway over a combat-gated portal — the locked-gate state, drawn
	// so a player reads "you can't just walk in here" before stepping onto the tile.
	_buildGateArch(p) {
		const cx = (p.x0 + p.x1) / 2, cy = (p.y0 + p.y1) / 2;
		const c = this._tileToWorld(cx, cy);
		const g = new Group();
		const mat = new MeshStandardMaterial({ color: 0x7a1f2a, roughness: 0.7, emissive: 0x5a0f1a, emissiveIntensity: 0.5 });
		const postGeo = new BoxGeometry(0.3, 2.4, 0.3);
		const left = new Mesh(postGeo, mat); left.position.set(-TILE * 0.5, 1.2, 0);
		const right = new Mesh(postGeo, mat); right.position.set(TILE * 0.5, 1.2, 0);
		const lintel = new Mesh(new BoxGeometry(TILE * 1.2, 0.35, 0.35), mat); lintel.position.set(0, 2.45, 0);
		left.castShadow = right.castShadow = lintel.castShadow = true;
		g.add(left, right, lintel);
		g.position.set(c.x, 0, c.z);
		this.staticGroup.add(g);
	}

	// A jagged cave-mouth arch over the Mainland mine entrance so the portal reads
	// as a tunnel opening rather than a plain glowing tile. Rock-textured posts,
	// rough lintel, and a warm torch glow at the apex.
	_buildMineEntrance(p) {
		const cx = (p.x0 + p.x1) / 2, cy = (p.y0 + p.y1) / 2;
		const c = this._tileToWorld(cx, cy);
		const g = new Group();
		const rockMat = new MeshStandardMaterial({ map: this._rockTexture(), color: 0x5a4f40, roughness: 1 });
		const w = (p.x1 - p.x0 + 1) * TILE;
		// Posts — flanking pillars, slightly wider than a gate arch for a tunnel feel.
		const postGeo = new CylinderGeometry(0.22, 0.3, 2.6, 7);
		const left = new Mesh(postGeo, rockMat); left.position.set(-w / 2 - 0.1, 1.3, 0);
		const right = new Mesh(postGeo, rockMat); right.position.set(w / 2 + 0.1, 1.3, 0);
		// Keystone lintel — a chunky rock span across the top.
		const lintel = new Mesh(new BoxGeometry(w + 0.9, 0.55, 0.6), rockMat);
		lintel.position.set(0, 2.7, 0);
		// Rough cap stones on each post.
		const capGeo = new DodecahedronGeometry(0.32, 0);
		const capL = new Mesh(capGeo, rockMat); capL.position.set(-w / 2 - 0.1, 2.7, 0);
		const capR = new Mesh(capGeo, rockMat); capR.position.set(w / 2 + 0.1, 2.7, 0);
		for (const m of [left, right, lintel, capL, capR]) { m.castShadow = true; m.receiveShadow = true; }
		g.add(left, right, lintel, capL, capR);
		g.position.set(c.x, 0, c.z);
		this.staticGroup.add(g);
		// A warm torch-point at the keystone so the entrance glow reads even at
		// a distance — the mine is dark; this is the last light before you go in.
		const torch = new PointLight(0xff8c30, 2.2, 6.5, 1.6);
		torch.position.set(c.x, 3.1, c.z);
		this.scene.add(torch);
		this._caveLights.push(torch); // reuse the cave-lights list so it's cleaned on next _buildRealm
	}

	// Spectator stands: a cool slate tint over the walkable seating tiles plus a corner
	// post at each end, so the stands read as off-floor (and the server keeps them PvP-free).
	_buildSeating(rects) {
		if (!rects?.length) return;
		const postMat = new MeshStandardMaterial({ color: 0x44516a, roughness: 0.9 });
		for (const r of rects) {
			this._paintTiles(this._rectTiles(r), 0x5b7fa6, 0.5);
			for (const [px, py] of [[r.x0, r.y0], [r.x1, r.y0], [r.x0, r.y1], [r.x1, r.y1]]) {
				const post = new Mesh(new CylinderGeometry(0.12, 0.12, 1.0, 8), postMat);
				const w = this._tileToWorld(px, py);
				post.position.set(w.x, 0.5, w.z); post.castShadow = true;
				this.staticGroup.add(post);
			}
		}
	}

	// The practice boxing ring (Mainland plaza): a canvas mat with four corner posts
	// and two rope heights. Purely cosmetic + walkable — no death risk on the safe hub.
	_buildRing(ring) {
		if (!ring) return;
		const w = (ring.x1 - ring.x0 + 1) * TILE, d = (ring.y1 - ring.y0 + 1) * TILE;
		const cx = (ring.x0 + ring.x1) / 2, cy = (ring.y0 + ring.y1) / 2;
		const c = this._tileToWorld(cx, cy);
		const g = new Group();
		this._paintTiles(this._rectTiles(ring), 0x2f6b8a, 0.45); // the canvas
		const postMat = new MeshStandardMaterial({ color: 0xb23b3b, roughness: 0.6 });
		const ropeMat = new MeshStandardMaterial({ color: 0xe6e6e6, roughness: 0.5 });
		const hx = w / 2 - 0.3, hz = d / 2 - 0.3;
		const corners = [[-hx, -hz], [hx, -hz], [hx, hz], [-hx, hz]];
		for (const [sx, sz] of corners) {
			const post = new Mesh(new CylinderGeometry(0.1, 0.1, 1.3, 8), postMat);
			post.position.set(sx, 0.65, sz); post.castShadow = true; g.add(post);
		}
		for (const h of [0.5, 0.95]) {
			for (let i = 0; i < 4; i++) {
				const a = corners[i], b = corners[(i + 1) % 4];
				const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
				const rope = new Mesh(new BoxGeometry(len, 0.05, 0.05), ropeMat);
				rope.position.set((a[0] + b[0]) / 2, h, (a[1] + b[1]) / 2);
				rope.rotation.y = Math.atan2(b[1] - a[1], b[0] - a[0]);
				g.add(rope);
			}
		}
		g.position.set(c.x, 0, c.z);
		this.staticGroup.add(g);
	}

	// Moving-floor rollers (Arena): a hot conveyor tint over each strip with a flat
	// chevron on every tile pointing the way the server pushes — read the flow, ride it.
	_buildRollers(rollers) {
		if (!rollers?.length) return;
		for (const r of rollers) {
			const tiles = this._rectTiles(r);
			this._paintTiles(tiles, 0xff9a3a, 0.85);
			const [dx, dy] = this._rollerDelta(r.dir);
			const yaw = Math.atan2(-dy, dx); // map the push delta to a flat-XZ heading
			for (const t of tiles) {
				const chevron = this._rollerChevron(yaw);
				const w = this._tileToWorld(t.tx, t.ty);
				chevron.position.set(w.x, 0.07, w.z);
				this.staticGroup.add(chevron);
			}
		}
	}

	_rollerDelta(dir) {
		return dir === 'n' ? [0, -1] : dir === 's' ? [0, 1] : dir === 'e' ? [1, 0] : dir === 'w' ? [-1, 0] : [0, 0];
	}

	// A flat '>' chevron (two angled bars) lying on the ground, apex toward +X, then
	// turned by yaw so it points the roller's way.
	_rollerChevron(yaw) {
		const g = new Group();
		const mat = new MeshBasicMaterial({ color: 0x3a2410 });
		const barGeo = new BoxGeometry(0.34, 0.05, 0.1);
		const a = new Mesh(barGeo, mat); a.position.set(-0.05, 0, -0.1); a.rotation.y = -Math.PI / 4;
		const b = new Mesh(barGeo, mat); b.position.set(-0.05, 0, 0.1); b.rotation.y = Math.PI / 4;
		g.add(a, b);
		g.rotation.y = yaw;
		return g;
	}

	// Climb a raycast hit up to the player rig it belongs to, returning that player's
	// id (set on the rig in GamePlayerView) — used to resolve a PvP tap to a target.
	_playerIdOf(obj) {
		let o = obj;
		while (o) { if (o.userData && o.userData.playerId) return o.userData.playerId; o = o.parent; }
		return null;
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
		// World instance (Task 23) chosen at the login picker — pins every realm room
		// of this session to one server. The server validates/defaults it regardless.
		const server = this._resolveServerChoice();
		this.net = new GameNet({ name, avatar: netAvatar, realm, server, pid: this._playerId(), getPresence: getPresenceTicket });
		if (isGuest) uploadPendingGuestAvatar((publicUrl) => this.net?.setAvatar(publicUrl));

		// Fade-to-black during portal room swaps so the geometry rebuild is hidden.
		// onBeforeHandoff is awaited by _handlePortal, so the overlay is fully opaque
		// before the old room tears down. onAfterHandoff is called once _onHandoff
		// has cleared the dynamic views and the new realm is on its way in.
		this._portalFadeEl = document.getElementById('kg-portal-fade');
		this.net.onBeforeHandoff = () => new Promise((resolve) => {
			const el = this._portalFadeEl;
			if (!el) { resolve(); return; }
			el.classList.add('kg-fading-out');
			const done = () => { el.removeEventListener('transitionend', done); resolve(); };
			el.addEventListener('transitionend', done, { once: true });
			// Safety: resolve after transition duration + slack even if event misfires.
			setTimeout(resolve, 500);
		});
		this.net.onAfterHandoff = () => {
			// Brief pause so the scene has one frame to finish the geometry rebuild
			// before we reveal it, avoiding a half-populated flash.
			setTimeout(() => {
				const el = this._portalFadeEl;
				if (!el) return;
				el.classList.remove('kg-fading-out');
			}, 80);
		};

		this.net.on('status', ({ status, error }) => this._onStatus(status, error));
		this.net.on('realm', (layout) => this._buildRealm(layout));
		this.net.on('items', (r) => this._onItems(r));
		this.net.on('commands', (c) => this._onCommands(c));
		this.net.on('notice', (n) => this._onNotice(n));
		this.net.on('cooked', (c) => this._onCooked(c));
		this.net.on('chat', (m) => this._onChat(m));
		this.net.on('bank', (b) => this._onBank(b));
		this.net.on('skills', (s) => this._onSkills(s));
		this.net.on('xpgain', (g) => this._onXpGain(g));
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
		this.net.on('structAdd', (s, id) => this._structAdd(s, id));
		this.net.on('structChange', (s, id) => this._structChange(s, id));
		this.net.on('structRemove', (id) => this._structRemove(id));
		this.net.on('died', (d) => this._onDied(d));
		this.net.on('quests', (q) => this._onQuests(q));
		this.net.on('cosmetics', (c) => this._onCosmetics(c));
		this.net.on('shop', (s) => this._onShop(s));
		this.net.on('market', (m) => this.q?.setMarket(m));
		this.net.on('marketDirty', () => this.q?.marketDirty());
		this.net.on('marketQuote', (qd) => this._onMarketQuote(qd));
		this.net.on('marketSettled', (s) => this._onMarketSettled(s));
		this.net.on('marketBuyFail', (f) => this._onMarketBuyFail(f));
		this.net.on('marketPayout', (p) => this._onMarketPayout(p));
		this.net.on('handoff', (info) => this._onHandoff(info));
		this.net.on('takeover', (m) => this._onTakeover(m));

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

	// The same account just signed in on another server or tab (Task 23 single
	// active session). game-net already suppressed the auto-reconnect; pull the
	// player out of the world to the offline screen with an honest, actionable
	// reason. The Reconnect button reclaims the seat (game-net clears the flag).
	_onTakeover() {
		this.phase = 'offline';
		this._setHudPhase('offline');
		if (this.hud.offlineMsg) {
			this.hud.offlineMsg.textContent =
				'Your account signed in on another server or tab. Only one session can be active at a time.';
		}
		if (this.hud.retryBtn) this.hud.retryBtn.textContent = 'Reconnect here';
	}

	// ---------------------------------------------------------------- server picker
	// Login-time world-instance chooser (Task 23). Lists the real roster with live
	// population from the multiplayer host's /servers endpoint; the choice is
	// remembered per browser and pins the whole session to one instance.

	// The active choice: an explicit picker selection wins, then a ?server= deep
	// link, then the remembered choice, else '' (server resolves its default).
	_resolveServerChoice() {
		if (this._chosenServer) return this._chosenServer;
		const urlS = new URLSearchParams(location.search).get('server');
		if (urlS) return urlS;
		try { return localStorage.getItem('kg-server') || ''; } catch { return ''; }
	}

	_initServerPicker() {
		this._serverList = null;
		this._serverPollTimer = null;
		this._chosenServer = this._resolveServerChoice();
		this._refreshServers();
	}

	_startServerPolling() {
		if (this._serverPollTimer || !this.hud?.serversList) return;
		// Refresh live counts every 10s while the picker is visible so the numbers
		// the player chooses from stay honest without hammering the endpoint.
		this._serverPollTimer = setInterval(() => this._refreshServers(), 10_000);
	}

	_stopServerPolling() {
		if (this._serverPollTimer) { clearInterval(this._serverPollTimer); this._serverPollTimer = null; }
	}

	async _refreshServers() {
		if (!this.hud?.serversList) return;
		let list;
		try {
			list = await fetchServers(this.net?.url);
		} catch {
			// Host unreachable: still let the player in via a single default world
			// rather than blocking on a count we can't get. Never fake a number.
			if (!this._serverList) this._renderServerFallback();
			return;
		}
		if (!Array.isArray(list) || !list.length) { this._renderServerFallback(); return; }
		this._serverList = list;
		// Pre-select the remembered/url choice if it's still a real instance, else
		// the recommended (least-full) one, else the first.
		const ids = new Set(list.map((s) => s.id));
		if (!this._chosenServer || !ids.has(this._chosenServer)) {
			this._chosenServer = (list.find((s) => s.recommended) || list[0]).id;
		}
		this._renderServers(list, false);
	}

	_renderServerFallback() {
		this._serverList = [{ id: '', name: 'Default world', blurb: '', players: null, recommended: false }];
		this._chosenServer = '';
		this._renderServers(this._serverList, true);
	}

	_renderServers(list, isFallback) {
		const host = this.hud.serversList;
		if (!host) return;
		host.setAttribute('aria-busy', 'false');
		host.textContent = '';
		for (const s of list) {
			const known = Number.isFinite(s.players);
			const selected = s.id === this._chosenServer;

			const opt = document.createElement('label');
			opt.className = 'kg-server-opt';
			opt.dataset.selected = String(selected);
			opt.dataset.empty = String(known && s.players === 0);

			const input = document.createElement('input');
			input.type = 'radio';
			input.name = 'kg-server';
			input.value = s.id;
			input.checked = selected;
			input.addEventListener('change', () => this._selectServer(s.id));
			opt.appendChild(input);

			const dot = document.createElement('span');
			dot.className = 'kg-server-dot';
			dot.setAttribute('aria-hidden', 'true');
			opt.appendChild(dot);

			const main = document.createElement('span');
			main.className = 'kg-server-main';
			const nameRow = document.createElement('span');
			nameRow.className = 'kg-server-name';
			nameRow.append(document.createTextNode(s.name || s.id || 'World'));
			if (s.recommended && !isFallback) {
				const rec = document.createElement('span');
				rec.className = 'kg-server-rec';
				rec.textContent = 'Recommended';
				nameRow.appendChild(rec);
			}
			main.appendChild(nameRow);
			if (s.blurb) {
				const blurb = document.createElement('div');
				blurb.className = 'kg-server-blurb';
				blurb.textContent = s.blurb;
				main.appendChild(blurb);
			}
			opt.appendChild(main);

			if (known) {
				const pop = document.createElement('span');
				pop.className = 'kg-server-pop';
				const b = document.createElement('b');
				b.textContent = String(s.players);
				pop.append(b, document.createTextNode(s.players === 1 ? 'player' : 'players'));
				opt.appendChild(pop);
			}

			opt.addEventListener('click', (e) => {
				// The label already toggles the radio; guard against a double-fire.
				if (e.target !== input) this._selectServer(s.id);
			});
			host.appendChild(opt);
		}
		this._updateServerChip();
	}

	_selectServer(id) {
		this._chosenServer = id;
		try { localStorage.setItem('kg-server', id); } catch {}
		// Repaint just the selection state so live counts + focus survive.
		this.hud.serversList?.querySelectorAll('.kg-server-opt').forEach((el) => {
			el.dataset.selected = String((el.querySelector('input')?.value ?? '') === id);
		});
	}

	// Topbar chip naming the world instance the player is on. Reads the synced,
	// authoritative server id; only shown when there's a real choice of instances.
	_updateServerChip() {
		const chip = this.hud.server;
		if (!chip) return;
		const id = this.net?.state?.server || this._chosenServer || '';
		const name = this._serverList?.find((s) => s.id === id)?.name || id;
		const multi = (this._serverList?.length || 0) > 1;
		if (name && multi) { chip.textContent = name; chip.hidden = false; }
		else { chip.hidden = true; }
	}

	// A portal moved us into a different realm room. The new room replays its own
	// players/nodes/mobs/tombs from scratch, so tear down every dynamic view tied
	// to the old realm (otherwise they linger as ghosts) and adopt the new session
	// id before those replays arrive. The fresh 'realm' message rebuilds the static
	// geometry; the loop's pending target is dropped so we don't chase a stale tile.
	_onHandoff({ sessionId } = {}) {
		for (const id of [...this.players.keys()]) this._playerRemove(id);
		for (const id of [...this.nodeViews.keys()]) this._nodeRemove(id);
		for (const id of [...this.mobViews.keys()]) this._mobRemove(id);
		for (const id of [...this.tombViews.keys()]) this._tombRemove(id);
		for (const id of [...this.structViews.keys()]) this._structRemove(id);
		this._exitBuildMode();
		// The wheel lives only on the Mainland — close an open spinner on a realm hop.
		this._spinUI?.close();
		this._target = null;
		this._lootTombId = null;
		this.myId = sessionId || this.net?.sessionId || this.myId;
		this._updateOnline();
		// Lift the blackout overlay once views are cleared — the new realm layout
		// arrives via the 'realm' message moments later and rebuilds the geometry.
		if (this.net?.onAfterHandoff) this.net.onAfterHandoff();
	}

	// ---------------------------------------------------------------- players
	_playerAdd(p, id) {
		if (this.players.has(id)) { this.players.get(id).apply(p); return; }
		const isLocal = id === this.myId;
		const view = new GamePlayerView(this.scene, (tx, ty) => this._tileToWorld(tx, ty), p, isLocal, (cid) => this._cosmeticVisual(cid));
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
		// Keep the persistent gold readout + any open shop's affordability in sync as
		// the purse changes (mob/quest rewards, a purchase).
		this.q.setGold(p.gold);
		// Affordability of buildables shifts as materials are gained/spent — keep the
		// build menu live (no-op in realms that don't permit building).
		this._refreshBuildMenu();
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

	// ------------------------------------------------------------ cosmetics (Task 21)
	// The cosmetics catalogue (id → name/rarity/price/rotation/visual) arrives once
	// on join. Index it, hand it to the HUD so the shop/wardrobe render real data,
	// and re-apply every avatar's equipped look now that visuals are resolvable.
	_onCosmetics(catalog) {
		const list = catalog?.cosmetics || [];
		this.cosmetics = new Map(list.map((c) => [c.id, c]));
		this.cosmeticRarities = catalog?.rarities || {};
		this.q?.setCosmeticCatalog(list, this.cosmeticRarities);
		const players = this.net?.state?.players;
		for (const [id, v] of this.players) {
			const sp = players?.get(id);
			v.setCosmetic(sp?.cosmeticId || '');
		}
	}

	// Resolve a cosmetic id to its visual spec for the avatar renderer. Returns null
	// for the empty/default look or before the catalogue has loaded.
	_cosmeticVisual(id) {
		return id ? (this.cosmetics?.get(id)?.visual || null) : null;
	}

	// The live shop board (offers + rotation countdowns + owned + gold) — straight
	// through to the HUD's shop surface.
	_onShop(snapshot) {
		this.q?.setShop(snapshot || null);
	}

	// Preview a cosmetic on the local avatar (wardrobe try-before-equip). `id` is
	// a cosmetic id or '' (default look); null clears the preview. Local-only —
	// peers see nothing until the player actually equips (server-authoritative).
	_previewLocalCosmetic(id) {
		this.players.get(this.myId)?.previewCosmetic?.(id);
	}

	// ---------------------------------------------------------------- marketplace (Task 20)

	// Begin an on-chain token purchase. We allow one in flight at a time so the
	// per-listing busy state and the wallet handshake stay unambiguous. The server
	// replies with a 'marketQuote' (unsigned split tx + signed quote) which
	// _onMarketQuote then drives through the wallet and back as a settle.
	async _buyTokenListing(id) {
		if (this._tokenBuy) { this._toast({ kind: 'market', text: 'Finish your current purchase first.' }); return; }
		let wallet = null;
		try {
			const { detectSolanaWallet } = await import('../erc8004/solana-deploy.js');
			wallet = detectSolanaWallet();
		} catch { wallet = null; }
		if (!wallet || !wallet.publicKey) {
			this._toast({ kind: 'market', text: 'Connect a Solana wallet to buy with tokens.' });
			return;
		}
		this._tokenBuy = { id };
		this.q?.setMarketBusy(id, 'Preparing…');
		this.net?.marketTokenQuote(id);
	}

	// The server quoted the token amount and built the split transaction. Sign it in
	// the wallet, broadcast through our same-origin RPC proxy, wait for confirmation,
	// then hand the signature back for server-side verification + gold release.
	async _onMarketQuote(qd) {
		if (!qd || !this._tokenBuy || this._tokenBuy.id !== qd.id) return; // stale/unsolicited
		const id = qd.id;
		try {
			const { detectSolanaWallet, SOLANA_RPC } = await import('../erc8004/solana-deploy.js');
			const { Transaction, Connection } = await import('@solana/web3.js');
			const wallet = detectSolanaWallet();
			if (!wallet || !wallet.publicKey) throw new Error('wallet-missing');
			this.q?.setMarketBusy(id, 'Confirm in wallet…');
			const bytes = Uint8Array.from(atob(qd.tx), (c) => c.charCodeAt(0));
			const tx = Transaction.from(bytes);
			const signed = await wallet.signTransaction(tx);
			this.q?.setMarketBusy(id, 'Confirming…');
			const conn = new Connection(SOLANA_RPC.mainnet, 'confirmed');
			const sig = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: false, maxRetries: 3 });
			const latest = await conn.getLatestBlockhash('confirmed');
			await conn.confirmTransaction({ signature: sig, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight }, 'confirmed');
			this.q?.setMarketBusy(id, 'Settling…');
			this.net?.marketTokenSettle(qd.quote, sig);
		} catch (err) {
			const msg = String(err?.message || err);
			const friendly = /reject|denied|cancell?ed|user/i.test(msg) ? 'Cancelled in wallet.' : 'Payment failed — no gold was charged.';
			this._tokenBuy = null;
			this.q?.clearMarketBusy(id);
			this._toast({ kind: 'market', text: friendly });
		}
	}

	// Server verified the payment and released the gold (it also sends a notice +
	// fresh board). Clear the in-flight buy + its busy spinner.
	_onMarketSettled(s) {
		const id = s?.id || this._tokenBuy?.id;
		this._tokenBuy = null;
		if (id) this.q?.clearMarketBusy(id);
	}

	// Server rejected a token quote/settle (price feed down, expired quote, failed
	// verification). The accompanying notice explains why; here we just release the
	// spinner so the card returns to a buyable state.
	_onMarketBuyFail(info) {
		const id = info?.id || this._tokenBuy?.id;
		this._tokenBuy = null;
		if (id) this.q?.clearMarketBusy(id);
	}

	// Proceeds from a sale that completed while this account was offline or in
	// another realm, delivered on login / via a live nudge.
	_onMarketPayout(p) {
		if (!p) return;
		const parts = [];
		if (p.gold) parts.push(`${(p.gold | 0).toLocaleString('en-US')} gold`);
		if (Array.isArray(p.items)) for (const it of p.items) parts.push(`${it.qty}× ${itemLabel(it.item)}`);
		if (parts.length) this._toast({ kind: 'market', text: `Sale settled: +${parts.join(', ')}.` });
	}

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
		const color = mob.kind === 'troll' ? 0x6f5b8e : mob.kind === 'ogre' ? 0x9c5a3c : mob.kind === 'goblin' ? 0x5a8c3c : 0x9aa0ac;
		const scale = mob.kind === 'troll' ? 1.7 : mob.kind === 'ogre' ? 1.4 : 1;
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

	// ---------------------------------------------------------------- structures
	// Player-built firepits + shacks (Task 07), synced via the structures map. A
	// firepit carries a flat countdown ring that drains with its remaining lifetime
	// (read off the authoritative expiresAt); a shack is a permanent little hut.
	_structAdd(struct, id) {
		if (this.structViews.has(id)) { this._structChange(struct, id); return; }
		const view = this._buildStructView(struct, id);
		const w = this._tileToWorld(struct.tx, struct.ty);
		view.group.position.set(w.x, 0, w.z);
		view.group.traverse((o) => { o.userData.structId = id; });
		this.objectGroup.add(view.group);
		this.structViews.set(id, { ...view, struct });
		// A new structure changes which tiles are buildable + (if mine) pickup state.
		this._refreshBuildMenu();
	}
	_structChange(struct, id) {
		const v = this.structViews.get(id);
		if (!v) return;
		v.struct = struct;
		const w = this._tileToWorld(struct.tx, struct.ty);
		v.group.position.set(w.x, 0, w.z);
	}
	_structRemove(id) {
		const v = this.structViews.get(id);
		if (v) {
			this.objectGroup.remove(v.group);
			// Dispose the per-structure geometry/materials (a firepit rebuilds its
			// countdown ring each frame, so free the live one on teardown).
			v.group.traverse((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
			this.structViews.delete(id);
		}
		this._refreshBuildMenu();
	}

	// Build the mesh for a structure. Returns { group, ring?, flame?, lifetime } so
	// the loop can animate a firepit's flame + countdown ring.
	_buildStructView(struct) {
		const g = new Group();
		if (struct.kind === 'firepit') {
			// A ring of stones, a glowing ember bed, and a flickering flame cone.
			const stoneMat = new MeshStandardMaterial({ color: 0x6b6f7a, roughness: 0.95 });
			const ringN = 8;
			for (let i = 0; i < ringN; i++) {
				const a = (i / ringN) * Math.PI * 2;
				const stone = new Mesh(new DodecahedronGeometry(0.16, 0), stoneMat);
				stone.position.set(Math.cos(a) * 0.42, 0.12, Math.sin(a) * 0.42);
				stone.castShadow = true;
				g.add(stone);
			}
			const embers = new Mesh(new CylinderGeometry(0.34, 0.34, 0.06, 12),
				new MeshStandardMaterial({ color: 0x3a1c0c, emissive: 0xff5a1e, emissiveIntensity: 0.9, roughness: 0.6 }));
			embers.position.y = 0.1;
			const flame = new Mesh(new ConeGeometry(0.26, 0.8, 10),
				new MeshStandardMaterial({ color: 0xffae3a, emissive: 0xff7a1e, emissiveIntensity: 1.3, roughness: 0.4, transparent: true, opacity: 0.92 }));
			flame.position.y = 0.62;
			// A flat countdown ring around the pit — drains from full to empty over the
			// firepit's lifetime. Rebuilt each frame via _updateStructures.
			const ring = new Mesh(
				new RingGeometry(0.5, 0.62, 28),
				new MeshBasicMaterial({ color: 0xffce5c, transparent: true, opacity: 0.85, side: DoubleSide }),
			);
			ring.rotation.x = -Math.PI / 2;
			ring.position.y = 0.06;
			g.add(embers, flame, ring);
			const lifetime = this._buildCatalog?.firepit?.lifetimeMs || 30000;
			return { group: g, ring, flame, lifetime };
		}
		// Shack: a timber cabin with a pitched roof and a dark doorway.
		const wall = new Mesh(new BoxGeometry(0.92, 0.8, 0.92),
			new MeshStandardMaterial({ color: 0x8a5a32, roughness: 0.9 }));
		wall.position.y = 0.4; wall.castShadow = true; wall.receiveShadow = true;
		const roof = new Mesh(new ConeGeometry(0.85, 0.6, 4),
			new MeshStandardMaterial({ color: 0x5a3a20, roughness: 0.9 }));
		roof.position.y = 1.1; roof.rotation.y = Math.PI / 4; roof.castShadow = true;
		const door = new Mesh(new BoxGeometry(0.26, 0.46, 0.06),
			new MeshStandardMaterial({ color: 0x2a1a0e, roughness: 1 }));
		door.position.set(0, 0.23, 0.47);
		g.add(wall, roof, door);
		return { group: g, lifetime: 0 };
	}

	// Animate firepits: flicker the flame and drain the countdown ring from its
	// remaining lifetime fraction. Shacks are static. Cheap; runs each frame.
	_updateStructures(now) {
		if (!this.structViews.size) return;
		const t = now / 1000;
		for (const [, v] of this.structViews) {
			if (!v.ring) continue;
			const exp = v.struct?.expiresAt || 0;
			const frac = exp ? Math.max(0, Math.min(1, (exp - Date.now()) / (v.lifetime || 30000))) : 1;
			// Redraw the ring as an arc covering the remaining fraction.
			v.ring.geometry.dispose();
			v.ring.geometry = new RingGeometry(0.5, 0.62, 40, 1, -Math.PI / 2, frac * Math.PI * 2);
			// Warm→red as it runs low; flame shrinks + flickers.
			v.ring.material.color.setHex(frac > 0.33 ? 0xffce5c : 0xff5a3a);
			if (v.flame) {
				const flick = 0.85 + Math.sin(t * 12 + v.group.position.x) * 0.12;
				v.flame.scale.set(1, (0.5 + frac * 0.5) * flick, 1);
				v.flame.material.opacity = 0.8 + Math.sin(t * 9) * 0.12;
			}
		}
	}

	// ---------------------------------------------------------------- build mode
	// Enter placement for `kind`: spawn a ghost the loop snaps to the hovered tile,
	// tinting green/red for valid/invalid. Tap places; right-click/Esc cancels.
	_enterBuildMode(kind) {
		if (this.phase !== 'world') return;
		if (!this._buildCatalog?.[kind]) return;
		this._exitBuildMode();
		const ghost = this._makeGhost(kind);
		this.objectGroup.add(ghost);
		this._buildMode = { kind, ghost, valid: false, tile: null };
		this.q?.closeBuild();
		this.q?.showBuildBanner(STRUCTURE_META[kind]);
		this._toast({ kind: 'build', text: `Tap a tile beside you to place the ${STRUCTURE_META[kind]?.label || kind}.` });
	}

	_exitBuildMode() {
		if (!this._buildMode) { this.q?.hideBuildBanner?.(); return; }
		this.objectGroup.remove(this._buildMode.ghost);
		this._buildMode.ghost.traverse((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
		this._buildMode = null;
		this.q?.hideBuildBanner();
	}

	// A translucent footprint + a faint silhouette of the structure, tinted by
	// validity. Kept light — it's built only on enter, recoloured each frame.
	_makeGhost(kind) {
		const g = new Group();
		const pad = new Mesh(new PlaneGeometry(TILE * 0.94, TILE * 0.94),
			new MeshBasicMaterial({ color: 0x55ff99, transparent: true, opacity: 0.4, side: DoubleSide }));
		pad.rotation.x = -Math.PI / 2; pad.position.y = 0.05;
		const silMat = new MeshBasicMaterial({ color: 0x55ff99, transparent: true, opacity: 0.35, depthWrite: false });
		const sil = kind === 'shack'
			? new Mesh(new BoxGeometry(0.9, 0.8, 0.9), silMat)
			: new Mesh(new ConeGeometry(0.3, 0.7, 10), silMat);
		sil.position.y = kind === 'shack' ? 0.4 : 0.45;
		g.add(pad, sil);
		g._pad = pad; g._sil = sil; g._silMat = silMat;
		return g;
	}

	// Each frame in build mode: snap the ghost to the tile under the cursor and
	// recolour by validity. With no cursor yet, park it on the tile in front of us.
	_updateBuildGhost() {
		const bm = this._buildMode;
		if (!bm) return;
		const tile = this._buildHoverTile();
		if (!tile) { bm.ghost.visible = false; return; }
		bm.ghost.visible = true;
		const w = this._tileToWorld(tile.tx, tile.ty);
		bm.ghost.position.set(w.x, 0, w.z);
		const valid = this._buildValid(bm.kind, tile.tx, tile.ty);
		bm.valid = valid; bm.tile = tile;
		const col = valid ? 0x55ff99 : 0xff5a5a;
		bm.ghost._pad.material.color.setHex(col);
		bm.ghost._silMat.color.setHex(col);
	}

	// The tile the ghost should occupy: under the cursor if we have one, else the
	// tile directly in front of the player.
	_buildHoverTile() {
		if (this._hoverPtr) {
			this._ptr.x = (this._hoverPtr.x / window.innerWidth) * 2 - 1;
			this._ptr.y = -(this._hoverPtr.y / window.innerHeight) * 2 + 1;
			this._raycaster.setFromCamera(this._ptr, this.camera);
			const t = this._pickGroundTile();
			if (t) return t;
		}
		const me = this._localView();
		if (!me) return null;
		return { tx: me.tx, ty: me.ty - 1 };
	}

	// Client mirror of the server's build gates for instant ghost feedback: adjacent
	// (but not under the player), a free/buildable tile, and affordable. The server
	// re-checks all of it authoritatively on the actual 'build'.
	_buildValid(kind, tx, ty) {
		const ps = this.net?.state?.players?.get(this.myId);
		if (!ps) return false;
		const dx = Math.abs(tx - ps.tx), dy = Math.abs(ty - ps.ty);
		if (dx === 0 && dy === 0) return false;
		if (dx > 1 || dy > 1) return false;
		if (!this._isBuildableTile(tx, ty)) return false;
		return this._canAffordBuild(kind);
	}

	// A tile clear for building: walkable (bounds + not blocked + no node/mob/
	// structure) and not a portal/bank/fountain/fishing/cooking tile or a standing
	// player — mirrors the server's _isBuildable.
	_isBuildableTile(tx, ty) {
		if (!this._isWalkable(tx, ty)) return false;
		for (const [, v] of this.structViews) if (v.struct.tx === tx && v.struct.ty === ty) return false;
		for (const [, pv] of this.players) if (!pv.dead && pv.tx === tx && pv.ty === ty) return false;
		const r = this.realm || {};
		for (const p of r.portals || []) {
			if (tx >= p.x0 && tx <= p.x1 && ty >= p.y0 && ty <= p.y1) return false;
		}
		if ((r.bankZone || []).some((t) => t.tx === tx && t.ty === ty)) return false;
		if (r.fountain && r.fountain.tx === tx && r.fountain.ty === ty) return false;
		for (const f of r.fishing || []) if (f.tx === tx && f.ty === ty) return false;
		for (const c of r.cooking || []) if (c.tx === tx && c.ty === ty) return false;
		return true;
	}

	_canAffordBuild(kind) {
		const ps = this.net?.state?.players?.get(this.myId);
		const cost = this._buildCatalog?.[kind]?.cost;
		if (!ps || !cost) return false;
		for (const [item, qty] of Object.entries(cost)) {
			if (this._countItem(ps, item) < qty) return false;
		}
		return true;
	}

	// Place the ghost: validate client-side for instant feedback, then send the
	// authoritative 'build'. Stays honest — a red ghost explains why instead of
	// firing a doomed request. Exits build mode on a successful send.
	_attemptBuild(tile) {
		const bm = this._buildMode;
		if (!bm || !tile) return;
		const ps = this.net?.state?.players?.get(this.myId);
		const dx = Math.abs(tile.tx - (ps?.tx ?? 0)), dy = Math.abs(tile.ty - (ps?.ty ?? 0));
		if (dx === 0 && dy === 0) { this._toast({ kind: 'build', text: 'Step back a tile to place it.' }); return; }
		if (dx > 1 || dy > 1) { this._toast({ kind: 'build', text: 'Build on a tile right beside you.' }); return; }
		if (!this._isBuildableTile(tile.tx, tile.ty)) { this._toast({ kind: 'build', text: 'You can’t build there.' }); return; }
		if (!this._canAffordBuild(bm.kind)) {
			this._toast({ kind: 'build', text: `Not enough materials for a ${STRUCTURE_META[bm.kind]?.label || bm.kind}.` });
			return;
		}
		this.net?.build(bm.kind, tile.tx, tile.ty);
		this._exitBuildMode();
	}

	// Toggle the build menu (B key / toolbar). Refreshes affordability first so the
	// menu opens with live costs. In build mode, B cancels placement instead.
	_toggleBuildMenu() {
		if (this.phase !== 'world') return;
		if (this._buildMode) { this._exitBuildMode(); return; }
		this._refreshBuildMenu();
		this.q?.toggleBuild();
	}

	// Recompute the buildable list (kinds + live affordability) and hand it to the
	// HUD. Driven by the realm catalogue + the player's current materials.
	_refreshBuildMenu() {
		const kinds = Object.keys(this._buildCatalog || {});
		if (!kinds.length) { this.q?.setBuildables([]); return; }
		const ps = this.net?.state?.players?.get(this.myId);
		const items = kinds.map((kind) => {
			const def = this._buildCatalog[kind] || {};
			const meta = STRUCTURE_META[kind] || { icon: '🔨', label: kind, desc: '' };
			const costs = Object.entries(def.cost || {}).map(([item, need]) => {
				const have = ps ? this._countItem(ps, item) : 0;
				return { item, icon: MATERIAL_ICON[item] || '📦', need, have, ok: have >= need };
			});
			const owned = this._countOwnedStructures(kind);
			const capped = !!def.cap && owned >= def.cap;
			const affordable = costs.every((c) => c.ok) && !capped;
			const capNote = def.cap ? (capped ? 'placed' : `${owned}/${def.cap}`) : '';
			return { kind, icon: meta.icon, label: meta.label, desc: meta.desc, costs, affordable, capNote };
		});
		this.q?.setBuildables(items);
	}

	_countOwnedStructures(kind) {
		let n = 0;
		for (const [, v] of this.structViews) if (v.struct.kind === kind && v.struct.owner === this.myId) n++;
		return n;
	}

	// A structure of mine I'm standing beside (for the /pickup affordance), nearest
	// first. Null if none in reach.
	_adjacentOwnedStructure() {
		const ps = this.net?.state?.players?.get(this.myId);
		if (!ps) return null;
		let best = null, bd = Infinity;
		for (const [, v] of this.structViews) {
			const s = v.struct;
			if (s.owner !== this.myId) continue;
			if (Math.abs(ps.tx - s.tx) > 1 || Math.abs(ps.ty - s.ty) > 1) continue;
			const d = (ps.tx - s.tx) ** 2 + (ps.ty - s.ty) ** 2;
			if (d < bd) { bd = d; best = s; }
		}
		return best;
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

		// Build mode (Task 07) owns the tap: a click places the structure on the
		// ghost's tile; movement/gather clicks are suppressed until we exit.
		if (this._buildMode) {
			const tile = this._pickGroundTile() || this._buildMode.tile;
			this._attemptBuild(tile);
			return;
		}

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
			if (ud.wheelId && this.wheelViews.has(ud.wheelId)) { this._setTarget('wheel', ud.wheelId); return; }
		}

		// 2b) In a PvP realm, a tap on another living player marks them as an attack
		// target the loop closes on and strikes (the server enforces range + safe zones).
		if (this.realm?.pvp) {
			const rigs = [];
			for (const [pid, pv] of this.players) if (pid !== this.myId && !pv.dead) rigs.push(pv.rig);
			if (rigs.length) {
				for (const h of this._raycaster.intersectObjects(rigs, true)) {
					const pid = this._playerIdOf(h.object);
					if (pid && this.players.has(pid)) { this._setTarget('player', pid); return; }
				}
			}
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
		const eatLabel = showEat
			? `Eat ${edible.label} (+${edible.healEst} HP, ${edible.count} left)`
			: 'Eat';
		this._toggleAction(this.hud.eatBtn, showEat, eatLabel);

		// Cast: standing beside fishable water. The rod auto-equips on cast, so the
		// button just reflects whether the player owns one — when they don't, it
		// reads "Need a rod" and explains on click (casting is gated, not silent).
		const showCast = this._nearFishingSpot(ps.tx, ps.ty);
		const hasRod = this._hasRod(ps);
		this._toggleAction(this.hud.castBtn, showCast, hasRod ? 'Cast line 🎣' : 'Need a rod 🎣');
		if (this.hud.castBtn) this.hud.castBtn.classList.toggle('kg-action--muted', showCast && !hasRod);

		// Pick up: standing beside a structure I placed (Task 07). Routes to /pickup;
		// a locked structure tells the player to /unlock first (server enforces it).
		const mine = this._adjacentOwnedStructure();
		const showPickup = !!mine;
		this._toggleAction(this.hud.pickupBtn, showPickup, mine ? `Pick up ${STRUCTURE_META[mine.kind]?.label || mine.kind}${mine.locked ? ' 🔒' : ''}` : 'Pick up');

		bar.hidden = !(showCook || showEat || showCast || showPickup);
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
	// {zone,i} ref, a friendly label, how many of that food the player holds, and
	// an estimated heal value so the Eat button can show "+N HP" without a server
	// round-trip (mirrors the scaledHeal formula in items.js).
	_findEdibleSlot(ps) {
		const reg = this.items || {};
		const cookLvl = ps.cooking || 1;
		const scan = (arr, zone) => {
			for (let i = 0; i < arr.length; i++) {
				const it = arr[i].item;
				if (!it || !EDIBLE.has(it)) continue;
				const baseHeal = reg[it]?.heal || 0;
				const healEst = clientScaledHeal(it, baseHeal, cookLvl);
				return { ref: { zone, i }, item: it, label: FOOD_LABEL[it] || 'food', count: this._countItem(ps, it), healEst };
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

	// Server pushes xpgain after every XP grant. Delta-patch the cached snapshot so
	// the panel stays live without a round-trip, then show a "+N XP" float chip.
	_onXpGain({ skill, amount, xp, level, levelXp, nextXp } = {}) {
		const meta = SKILL_META[skill];
		if (!meta || !Number.isFinite(amount)) return;
		if (this._skills?.skills?.[skill]) {
			const s = this._skills.skills[skill];
			s.xp = xp; s.level = level; s.levelXp = levelXp; s.nextXp = nextXp ?? null;
		} else if (!this._skills) {
			// Seed a minimal snapshot so the panel paints immediately on first open.
			this._skills = {
				cap: 99, total: null, average: null,
				skills: Object.fromEntries(SKILL_ORDER.map((sk) => [
					sk, { level: 1, xp: 0, levelXp: 0, nextXp: null },
				])),
			};
			this._skills.skills[skill] = { xp, level, levelXp, nextXp: nextXp ?? null };
		}
		if (this._skillsOpen) this._renderSkills();
		this._showXpDrop(meta, amount);
	}

	// Float a "+N XP" chip near the Skills button. Rapid same-skill hits within 400ms
	// merge into the live chip instead of spawning a new one.
	_showXpDrop(meta, amount) {
		if (!this.hud.xpdrops) return;
		if (!this._xpDropQueue) this._xpDropQueue = new Map();
		const key = meta.label;
		const now = Date.now();
		const pending = this._xpDropQueue.get(key);
		if (pending && now - pending.ts < 400) {
			pending.amount += amount;
			pending.ts = now;
			if (pending.el) pending.el.textContent = `+${fmtXp(pending.amount)} XP`;
			return;
		}
		const el = document.createElement('div');
		el.className = 'kg-xpdrop';
		el.style.setProperty('--kg-hue', meta.hue);
		el.textContent = `+${fmtXp(amount)} XP`;
		this.hud.xpdrops.appendChild(el);
		const entry = { amount, ts: now, el };
		this._xpDropQueue.set(key, entry);
		requestAnimationFrame(() => el.classList.add('kg-xpdrop--in'));
		setTimeout(() => {
			this._xpDropQueue?.delete(key);
			entry.el = null;
			el.classList.remove('kg-xpdrop--in');
			setTimeout(() => el.remove(), 350);
		}, 1200);
	}

	// A real server 'levelup' event: patch the cached snapshot level and celebrate.
	// No longer needs a round-trip skills() request — xpgain keeps bars current.
	_onLevelup({ skill, level } = {}) {
		const meta = SKILL_META[skill];
		if (!meta || !Number.isFinite(level)) return;
		if (this._skills?.skills?.[skill]) this._skills.skills[skill].level = level;
		if (this._skillsOpen) this._renderSkills();

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

	// Open/close the skills drawer. Panel is event-driven via xpgain — one snapshot
	// request on open seeds it; no poll needed.
	_toggleSkills(force) {
		const next = force === undefined ? !this._skillsOpen : !!force;
		if (next === this._skillsOpen) return;
		if (next && this.phase !== 'world') return;
		this._skillsOpen = next;

		const panel = this.hud.skillsPanel;
		this.hud.skillsBtn?.setAttribute('aria-expanded', String(next));
		if (!panel) return;

		if (next) {
			panel.hidden = false;
			void panel.offsetWidth;
			panel.classList.add('kg-skills--open');
			this._renderSkills();
			this.net?.skills();
			this.hud.skillsClose?.focus();
		} else {
			panel.classList.remove('kg-skills--open');
			if (document.activeElement && panel.contains(document.activeElement)) this.hud.skillsBtn?.focus();
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
			// iso-controls (capture-phase) owns all discrete actions: hotbar 1-6/0,
			// I, Q, M, B, C, F, K, R. This listener only handles keys it passes through.
			//
			// Skills drawer: Escape closes it. iso-controls intercepts Escape only for
			// its own surfaces; the skills drawer lives here in iso-game.
			if (k === 'escape' && this._skillsOpen) { e.preventDefault(); this._toggleSkills(false); return; }
			// Escape cancels an in-progress build placement before closing panels.
			if (k === 'escape' && this._buildMode) { e.preventDefault(); this._exitBuildMode(); return; }
			// Escape closes game-hud panels (quests/bank/NPC/build/shop/market).
			if (k === 'escape') { this.q?.closeQuests(); this.q?.closeBank(); this.q?.closeNpc(); this.q?.closeBuild?.(); this.q?.closeShop?.(); this.q?.closeMarket?.(); }
			// Enter opens chat. iso-controls passes Enter through when no surface is open.
			if (this.phase === 'world' && k === 'enter') { e.preventDefault(); this._openChat(); return; }
			this.keys.add(k);
		});
		window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
		window.addEventListener('blur', () => this.keys.clear());

		this.canvas.addEventListener('pointerdown', (e) => {
			this._dragging = true; this._lastPtr = { x: e.clientX, y: e.clientY };
			this._hoverPtr = { x: e.clientX, y: e.clientY }; // build ghost follows the press point
			this._downAt = performance.now(); this._dragMoved = 0;
		});
		// Right-click cancels build placement (the desktop counterpart to the banner's
		// Cancel button on touch). Only swallow the context menu while building.
		this.canvas.addEventListener('contextmenu', (e) => {
			if (this._buildMode) { e.preventDefault(); this._exitBuildMode(); }
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
			// Track the cursor always (even without a drag) so the build ghost can
			// follow it on desktop hover.
			this._hoverPtr = { x: e.clientX, y: e.clientY };
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
		if (t.kind === 'player') { const v = this.players.get(t.id); if (!v || v.dead) return null; return { tx: v.tx, ty: v.ty }; }
		if (t.kind === 'npc') { const v = this.npcViews.get(t.id); if (!v) return null; return { tx: v.npc.tx, ty: v.npc.ty }; }
		if (t.kind === 'wheel') { const v = this.wheelViews.get(t.id); if (!v) return null; return { tx: v.landmark.tx, ty: v.landmark.ty }; }
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
		if (t.kind === 'wheel') { this._openSpinWheel(); this._target = null; return; }

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
		} else if (t.kind === 'player') {
			const v = this.players.get(t.id);
			if (!v || v.dead) { this._target = null; return; }
			this._equipTool(ps, 'sword');
			this.net?.attack(t.id); // PvP — server validates realm/range/safe-zone
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
			serversList: document.getElementById('kg-servers-list'),
			topbar: document.getElementById('kg-topbar'),
			realm: document.getElementById('kg-realm'),
			server: document.getElementById('kg-server'),
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
			xpdrops: document.getElementById('kg-xpdrops'),
			actions: document.getElementById('kg-actions'),
			cookBtn: document.getElementById('kg-cook'),
			eatBtn: document.getElementById('kg-eat'),
			castBtn: document.getElementById('kg-cast'),
			pickupBtn: document.getElementById('kg-pickup'),
			chat: document.getElementById('kg-chat'),
			chatLog: document.getElementById('kg-chat-log'),
			chatForm: document.getElementById('kg-chat-form'),
			chatInput: document.getElementById('kg-chat-input'),
			chatHint: document.getElementById('kg-chat-hint'),
			chatCounter: document.getElementById('kg-chat-counter'),
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

		// World-instance picker (Task 23): render the live roster + populations and
		// remember the player's choice. Polling starts/stops with the start screen.
		this._initServerPicker();

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
		// Pick up a structure I'm standing beside — the server action is /pickup.
		this.hud.pickupBtn?.addEventListener('click', () => this.net?.command('/pickup'));

		this._bindChat();
		this._setHudPhase('start');
	}

	_setHudPhase(phase) {
		this.hud.start.hidden = phase !== 'start';
		this.hud.offline.hidden = phase !== 'offline';
		// Poll live server populations only while the picker is on screen.
		if (phase === 'start') this._startServerPolling();
		else this._stopServerPolling();
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

	// Storage key for the mute list — scoped to the stable account id (Task 16) so
	// each account keeps its own block list, matching how keybindings persist.
	_mutedKey() {
		return 'kg-muted:' + (this._playerId() || '_');
	}

	_loadMuted() {
		try {
			const key = this._mutedKey();
			let raw = localStorage.getItem(key);
			// Migrate the pre-account global list (kg-muted) into this account once.
			if (raw == null) {
				const legacy = localStorage.getItem('kg-muted');
				if (legacy != null) { raw = legacy; localStorage.setItem(key, legacy); localStorage.removeItem('kg-muted'); }
			}
			const parsed = JSON.parse(raw || '[]');
			return new Set(Array.isArray(parsed) ? parsed.filter((n) => typeof n === 'string') : []);
		} catch { return new Set(); }
	}

	_saveMuted() {
		try { localStorage.setItem(this._mutedKey(), JSON.stringify([...this.muted])); } catch { /* storage may be unavailable */ }
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
		// Slash-command autocomplete + character counter: refresh on every edit.
		// Also reset the history cursor so a manual edit breaks out of recall mode.
		this.hud.chatInput?.addEventListener('input', () => {
			this._chatHistoryCursor = -1;
			this._refreshCmdHint();
			this._updateChatCounter();
		});
		this.hud.chatInput?.addEventListener('keydown', (e) => {
			// Esc: first dismiss an open command hint, otherwise clear + close chat.
			if (e.key === 'Escape') {
				e.preventDefault();
				if (this._cmdHint) this._hideCmdHint();
				else { this.hud.chatInput.value = ''; this._closeChat(); }
				e.stopPropagation();
				return;
			}
			// When the hint is open, the arrow/Tab keys drive it instead of the field.
			if (this._cmdHint) {
				if (e.key === 'ArrowDown') { e.preventDefault(); this._moveCmdHint(1); e.stopPropagation(); return; }
				if (e.key === 'ArrowUp') { e.preventDefault(); this._moveCmdHint(-1); e.stopPropagation(); return; }
				if (e.key === 'Tab') { e.preventDefault(); this._completeCmdHint(); e.stopPropagation(); return; }
				// Enter on a highlighted suggestion completes it, then falls through to
				// the form submit so the command sends in a single keystroke.
				if (e.key === 'Enter' && this._cmdHint.active >= 0) {
					const c = this._cmdHint.items[this._cmdHint.active];
					if (c) this.hud.chatInput.value = '/' + c.name;
					this._hideCmdHint();
					this._updateChatCounter();
				}
			} else {
				// History navigation: ↑/↓ when the hint is closed steps through the
				// last 50 sent messages. ↑ at the top of history is a no-op; ↓ at the
				// bottom restores the in-progress draft.
				if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
					const hist = this._chatHistory;
					if (hist?.length) {
						e.preventDefault();
						e.stopPropagation();
						const input = this.hud.chatInput;
						if (this._chatHistoryCursor === -1) this._chatHistoryDraft = input.value;
						// cursor=0 → most recent (hist[hist.length-1]); cursor=max → oldest.
						// ArrowUp moves toward older (increases cursor); ArrowDown toward newer.
						const max = hist.length - 1;
						let next;
						if (e.key === 'ArrowUp') {
							next = this._chatHistoryCursor === -1 ? 0 : Math.min(max, this._chatHistoryCursor + 1);
						} else {
							next = this._chatHistoryCursor <= 0 ? -1 : this._chatHistoryCursor - 1;
						}
						this._chatHistoryCursor = next;
						input.value = next === -1 ? (this._chatHistoryDraft || '') : hist[hist.length - 1 - next];
						this._updateChatCounter();
						// Hide the hint while scrolling history — it would open for any '/…'
						// entry and steal subsequent ArrowUp/Down from the history path.
						// When the user stops navigating and edits manually the hint reopens.
						this._hideCmdHint();
						return;
					}
				}
			}
			// Everything else stays in the field (the global keydown bails on
			// _typing(), so movement keys never fire while chatting).
			e.stopPropagation();
		});
		this.hud.chatMutedBtn?.addEventListener('click', () => this._toggleMutedList());
		this._updateMutedCount();
	}

	// Slash-command manifest (Task 13) — the same registry that powers /help and the
	// server router, so the autocomplete can never list a command that doesn't exist.
	_onCommands(manifest) {
		this._cmds = Array.isArray(manifest)
			? manifest
					.map((c) => ({
						name: String(c?.name || ''),
						args: String(c?.args || ''),
						desc: String(c?.desc || ''),
						aliases: Array.isArray(c?.aliases) ? c.aliases.map(String) : [],
					}))
					.filter((c) => c.name)
			: [];
	}

	// Recompute the hint list from the current input. Suggestions show only while
	// typing a command NAME — a leading '/' with no space yet. Once a space (args)
	// or a non-command line is typed, the hint hides.
	_refreshCmdHint() {
		const input = this.hud.chatInput;
		if (!input) return;
		const m = /^\/(\S*)$/.exec(input.value);
		if (!m || !this._cmds?.length) { this._hideCmdHint(); return; }
		const frag = m[1].toLowerCase();
		const matches = this._cmds
			.filter((c) => c.name.startsWith(frag) || c.aliases.some((a) => a.startsWith(frag)))
			.slice(0, 8);
		if (!matches.length) { this._hideCmdHint(); return; }
		// Keep the highlighted command across keystrokes when it's still a match, so
		// narrowing the list doesn't reset the user's selection out from under them.
		const prev = this._cmdHint?.active >= 0 ? this._cmdHint.items[this._cmdHint.active]?.name : null;
		const active = prev ? matches.findIndex((c) => c.name === prev) : -1;
		this._cmdHint = { items: matches, active };
		this._renderCmdHint();
	}

	_renderCmdHint() {
		const hint = this.hud.chatHint;
		const input = this.hud.chatInput;
		if (!hint || !this._cmdHint) return;
		hint.replaceChildren();
		this._cmdHint.items.forEach((c, i) => {
			const li = document.createElement('li');
			const on = i === this._cmdHint.active;
			li.className = 'kg-chat-hint-item' + (on ? ' kg-chat-hint-item--active' : '');
			li.id = 'kg-chat-hint-' + i;
			li.setAttribute('role', 'option');
			li.setAttribute('aria-selected', on ? 'true' : 'false');
			const sig = document.createElement('span');
			sig.className = 'kg-chat-hint-cmd';
			sig.textContent = '/' + c.name + (c.args ? ' ' + c.args : '');
			const desc = document.createElement('span');
			desc.className = 'kg-chat-hint-desc';
			desc.textContent = c.desc;
			li.append(sig, desc);
			// mousedown (before the input's blur) so a click completes + sends without
			// the panel collapsing first.
			li.addEventListener('mousedown', (e) => { e.preventDefault(); this._chooseCmdHint(i); });
			hint.appendChild(li);
		});
		hint.hidden = false;
		input?.setAttribute('aria-expanded', 'true');
		if (this._cmdHint.active >= 0) {
			input?.setAttribute('aria-activedescendant', 'kg-chat-hint-' + this._cmdHint.active);
			hint.children[this._cmdHint.active]?.scrollIntoView({ block: 'nearest' });
		} else {
			input?.removeAttribute('aria-activedescendant');
		}
	}

	_moveCmdHint(dir) {
		if (!this._cmdHint) return;
		const n = this._cmdHint.items.length;
		const cur = this._cmdHint.active;
		this._cmdHint.active = cur < 0 ? (dir > 0 ? 0 : n - 1) : (cur + dir + n) % n;
		this._renderCmdHint();
	}

	// Tab: fill the field with the (highlighted, else first) command. Append a space
	// when it takes args so the player keeps typing; refresh then hides or re-narrows.
	_completeCmdHint() {
		if (!this._cmdHint || !this.hud.chatInput) return;
		const idx = this._cmdHint.active >= 0 ? this._cmdHint.active : 0;
		const c = this._cmdHint.items[idx];
		if (!c) return;
		// Tab fills the chosen command in full. For an arg-taking command, append a
		// space and re-narrow so the player keeps typing; for a complete no-arg
		// command there's nothing left to suggest, so dismiss the hint.
		this.hud.chatInput.value = '/' + c.name + (c.args ? ' ' : '');
		if (c.args) this._refreshCmdHint();
		else this._hideCmdHint();
	}

	// Mouse pick: complete + send in one action.
	_chooseCmdHint(i) {
		const c = this._cmdHint?.items[i];
		if (!c || !this.hud.chatInput) return;
		this.hud.chatInput.value = '/' + c.name;
		this._hideCmdHint();
		this._sendChat();
	}

	_hideCmdHint() {
		this._cmdHint = null;
		if (this.hud.chatHint) { this.hud.chatHint.hidden = true; this.hud.chatHint.replaceChildren(); }
		if (this.hud.chatInput) {
			this.hud.chatInput.setAttribute('aria-expanded', 'false');
			this.hud.chatInput.removeAttribute('aria-activedescendant');
		}
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
		this._hideCmdHint();
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
		this._hideCmdHint();
		this._updateChatCounter();
		if (!text) { this._closeChat(); return; }
		// Push into history (max 50), deduplicate adjacent identical entries.
		if (!this._chatHistory) this._chatHistory = [];
		if (this._chatHistory[this._chatHistory.length - 1] !== text) {
			this._chatHistory.push(text);
			if (this._chatHistory.length > 50) this._chatHistory.shift();
		}
		this._chatHistoryCursor = -1; // reset to "live" position after send
		this._chatHistoryDraft = '';
		// Server is authoritative: it sanitizes, rate-limits, routes `/commands`, and
		// echoes accepted messages back to everyone (us included) as 'chat' events.
		this.net?.chat(text);
		input.focus(); // keep the field hot for a flowing conversation
	}

	// Show remaining-character count once the player has used ≥ 160 chars (the
	// last 40 chars matter). Turns amber at 180, red at 195. Hidden when empty or
	// well under the limit so it never clutters a short message.
	_updateChatCounter() {
		const el = this.hud.chatCounter;
		const input = this.hud.chatInput;
		if (!el || !input) return;
		const len = input.value.length;
		const max = input.maxLength || 200;
		const rem = max - len;
		if (len < 160) {
			el.textContent = '';
			el.dataset.state = '';
			return;
		}
		el.textContent = String(rem);
		el.dataset.state = rem <= 5 ? 'danger' : rem <= 20 ? 'warn' : 'ok';
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
		// Show a speech bubble above the sender's avatar in the 3D world (non-system
		// messages only; commands/errors stay in the panel). Local player included so
		// they see their own message confirmed above their head immediately.
		if (!msg.system && msg.id) {
			const pv = this.players.get(msg.id);
			pv?.showBubble(msg.text);
		}
	}

	_appendChatLine(msg) {
		const log = this.hud.chatLog;
		if (!log) return null;
		const line = document.createElement('div');
		line.className = 'kg-chat-line';
		if (msg.system) {
			line.classList.add('kg-chat-line--system');
			if (msg.kind === 'error') line.classList.add('kg-chat-line--error');
			if (msg.kind === 'help') line.classList.add('kg-chat-line--help');
			if (msg.kind === 'who') line.classList.add('kg-chat-line--who');
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
			// Apply the sender's world-assigned color so the name in chat matches the
			// floating nameplate above their avatar. Falls back to the CSS accent color
			// when the player isn't in the current state (e.g., they left mid-session).
			if (!isMe && msg.id) {
				const col = this.net?.state?.players?.get(msg.id)?.color;
				if (col) nameEl.style.color = '#' + col.toString(16).padStart(6, '0');
			}
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
			this._updateLandmarks(dt);
			this._updateTombLabels();
			this._updateStructures(now);
			this._updateBuildGhost();
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
			if (pv.dead) {
				pv.label.style.display = 'none';
				pv.bubble.style.display = 'none';
				continue;
			}
			v.set(pv.rig.position.x, pv.height + 0.35, pv.rig.position.z).project(this.camera);
			const behind = v.z > 1;
			if (behind) {
				pv.label.style.display = 'none';
				pv.bubble.style.display = 'none';
				continue;
			}
			const sx = (v.x * 0.5 + 0.5) * w;
			const sy = (-v.y * 0.5 + 0.5) * h;
			const t = `translate(-50%, -100%) translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px)`;
			pv.label.style.display = '';
			pv.label.style.transform = t;
			// Speech bubble sits above the nameplate — offset up by an extra ~30px so
			// it clears the name row and reads distinctly.
			if (!pv.bubble.hidden) {
				pv.bubble.style.display = '';
				pv.bubble.style.transform = `translate(-50%, -100%) translate(${sx.toFixed(1)}px, ${(sy - 32).toFixed(1)}px)`;
			} else {
				pv.bubble.style.display = 'none';
			}
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

	// Idle-spin each wheel disc for a touch of life, and project the wheel + casino
	// nameplates to screen space (Task 19).
	_updateLandmarks(dt) {
		const w = window.innerWidth, h = window.innerHeight;
		const v = new Vector3();
		for (const [, wv] of this.wheelViews) {
			const disc = wv.group.userData.disc;
			if (disc) disc.rotation.z += dt * 0.6;
			v.set(wv.group.position.x, wv.height + 0.6, wv.group.position.z).project(this.camera);
			if (v.z > 1) { wv.label.style.display = 'none'; continue; }
			wv.label.style.display = '';
			const sx = (v.x * 0.5 + 0.5) * w, sy = (-v.y * 0.5 + 0.5) * h;
			wv.label.style.transform = `translate(-50%, -100%) translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px)`;
		}
		for (const cl of this._casinoLabels) {
			v.set(cl.x, cl.height, cl.z).project(this.camera);
			if (v.z > 1) { cl.label.style.display = 'none'; continue; }
			cl.label.style.display = '';
			const sx = (v.x * 0.5 + 0.5) * w, sy = (-v.y * 0.5 + 0.5) * h;
			cl.label.style.transform = `translate(-50%, -100%) translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px)`;
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
		for (const [, sv] of this.structViews) this.objectGroup.remove(sv.group);
		this.structViews.clear();
		this._exitBuildMode();
		this._disposeNpcs();
		this._disposeLandmarks();
		this._spinUI?.close();
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
