// Coin Communities — 3D metaverse client (the /play scene).
//
// Each pump.fun coin is its own multiplayer 3D world. You pick an avatar (or
// bring your own / your 3D agent), choose a coin in the lobby, and drop into
// that coin's community: a shared space where everyone walks around as real
// GLB avatars, emotes, and chats. The server (WalkRoom, keyed by coin) is
// authoritative for position/avatar/chat; this client predicts local movement
// and interpolates everyone else.
//
// Built on the same proven engine as /walk (GLTF avatars + AnimationManager +
// Colyseus), reused here so a coin community is a first-class 3D space.

import {
	Scene, WebGLRenderer, PerspectiveCamera, Group, Vector3, PCFShadowMap, SRGBColorSpace,
	ACESFilmicToneMapping,
	Mesh, MeshStandardMaterial, MeshBasicMaterial, CircleGeometry, RingGeometry,
	CylinderGeometry, PlaneGeometry,
	CanvasTexture, TextureLoader, DoubleSide,
	PointLight,
	Raycaster, Vector2, WebGLRenderTarget,
} from 'three';

import { AnimationManager } from '../animation-manager.js';
import { CommunityNet } from './community-net.js';
import { CommunityUI } from './coincommunities-ui.js';
import { createWorldEnvironment, seedFromString } from './world-env.js';
import { createDistrict } from './district.js';
import { DISTRICT, clampToBounds } from './world-zones.js';
import { PhysicsWorld } from '../physics/physics-world.js';
import { createDayNightCycle } from './day-night.js';
import { worldClock } from '../shared/world-clock.js';
import { createCameraModeController, CAMERA_MODE_LABELS } from './camera-modes.js';
import { createChartScreen } from './chart-screen.js';
import { mountOracleRibbon } from './oracle-ribbon.js';
import { MarketReactor } from './market-reactor.js';
import {
	VoxelWorld, createBuildHud, parseKey, keyOf, MAX_BLOCKS, BLOCK,
	COMPOSITE_PIECES, compositeCells,
} from './build-voxels.js';
import { WorldObjects, PropGhost, propDef } from './world-objects.js';
import { proxiedImageURL } from '../ipfs.js';
import {
	loadManifest, getEmoteDefs, getAllEmoteDefs, resolveAvatarUrl, buildAvatar, playEmoteClip,
	CLIP_IDLE, CLIP_WALK,
} from './avatar-rig.js';
import { GUEST_SENTINEL, uploadPendingGuestAvatar, getPlayCosmetics, setPlayCosmetics } from './play-handoff.js';
import { getPresenceTicket, friendsClient } from '../friends.js';
import { FriendsPanel } from './friends-panel.js';
import { showPlayIntro, makeIntroReopener } from './play-intro.js';
import { applyLoadout } from './cosmetics-loadout.js';
import { serializeLoadout, getCosmetic } from '../../multiplayer/src/cosmetics-catalog.js';
import { AccessoryManager } from '../agent-accessories.js';
import { CosmeticsShop } from './cosmetics-shop.js';
import { CosmeticsWardrobe } from './cosmetics-wardrobe.js';
import { HOME_TOWN, isHomeTown } from './home-town.js';

// A Robinhood Chain coin is an EVM address (pump.fun mints are Solana base58).
// Every RH-chain world pins the 'hoodchain' biome (world-env.js) so the chain
// reads as a recognisable family; per-coin hue jitter (also in world-env.js)
// still keeps two RH coins from looking identical.
const isRobinhoodCoin = (mint) => /^0x[a-fA-F0-9]{40}$/.test(mint || '');
import { AgentCommerce } from './agent-commerce.js';
import { IntelKiosk } from './intel-kiosk.js';
import { WorldLife } from './npc/world-life.js';
import { isChatPanelOpen } from './npc/npc-chat.js';
import { isServicePanelOpen } from './npc/npc-services.js';
import { isAixbtPanelOpen } from './npc/npc-aixbt.js';
import { isZauthPanelOpen } from './npc/npc-zauth.js';
import { VoiceChat, voiceSupported } from './voice-chat.js';
import { requestHolderPass, signInWithX, ensureSolanaWallet, relinkSolanaWallet, getSession, getWorldGate, setWorldGate } from '../community/town-auth.js';
import { ensurePlayAccess } from './play-gate.js';
import { clearStoredPass, refreshPlayPass, loadStoredPass, storePass } from './play-auth.js';
import { PlaySystems } from './play-systems.js';
import { PlayActivities } from './play-activities.js';
import { WheelStation } from './wheel-station.js';
import { PlayOnboard } from './play-onboard.js';
import { log } from '../shared/log.js';
import { openAvatarInspector, isAvatarInspectorOpen, closeAvatarInspector } from '../shared/avatar-inspector.js';
import { createAgentDesk } from './agent-desk.js';
import { VehicleManager } from './vehicles.js';
import { CombatSystem } from './combat-system.js';

// localStorage throws in private mode and in third-party iframe contexts where
// storage is blocked — exactly the `?bg=transparent` embed case (e.g. the IBM
// x402 showcase). Guard every access so a blocked store degrades to defaults
// instead of throwing mid-boot. Same contract as the lsGet/lsSet helpers in
// play-onboard.js / play-intro.js / play-handoff.js.
function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch { /* storage disabled */ } }

// True when the keystroke belongs to an editable surface — a DM input in the
// friends panel, a search box, a modal field. World hotkeys must never fire
// there: `b` would toggle build mode mid-word and Space would be swallowed
// before it reached the caret. `chatFocused` covers only the in-world chat bar,
// so this is the general guard for every other input the HUD can open.
function isTypingTarget(t) {
	if (!t || t.nodeType !== 1) return false;
	if (t.isContentEditable) return true;
	const tag = t.tagName;
	return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

// Reaction bar (R04): the 6 emoji available to all players.
const REACTIONS = [
	{ emoji: '🎉', label: 'Celebrate' },
	{ emoji: '😂', label: 'Laugh' },
	{ emoji: '🔥', label: 'Fire' },
	{ emoji: '❤️', label: 'Love' },
	{ emoji: '👏', label: 'Clap' },
	{ emoji: '🤔', label: 'Think' },
];
// Confetti palette: monochrome-ish whites + very faint warm/cool accents.
const CONFETTI_COLORS = ['#ffffff', '#e8e8e8', '#fff8e1', '#e3f2fd', '#f3e5f5', '#e8f5e9'];

// King of the Totem (R07): the hold-the-totem zone, centred on the coin totem
// (built at world (0, -12) in _buildTotem). Mirrors the server's KING_ZONE so the
// rendered ring and the authoritative scoring area are the same circle. The server
// also sends these bounds in every game:king message; this is the render default.
const KING_ZONE = { x: 0, z: -12, r: 3.5 };

// The Downtown plaza radius (matches world-zones.js DISTRICT.plazaRadius) — the
// dressed circle world-env.js/district.js build around. W01: movement itself is
// no longer clamped to this disc; it's bounded by the much larger square
// DISTRICT/WORLD_BOUND (world-zones.js), which mirrors the server's own clamp so
// players can walk/drive the full district, not just the plaza.
const WORLD_RADIUS = 58;
const MOVE_SPEED = 4.2;
const RUN_SPEED = 8.0; // hold Shift to sprint
const RUN_TIMESCALE = 1.7; // speed the walk cycle up so a sprint reads as a run
const JUMP_VELOCITY = 5.5; // m/s upward kick on Space; ~1m apex under GRAVITY
const GRAVITY = 15; // m/s^2 pulling the jumper back down
const REMOTE_LERP = 0.18;
const JOY_DEADZONE = 0.12; // swallow tiny stick grazes so the avatar doesn't drift
const UNDO_LIMIT = 50; // how many build actions Ctrl/Cmd+Z can walk back
const LONG_PRESS_MS = 420; // hold-to-break threshold for touch (no right-click there)
const TRENDING_URL = '/api/pump/trending?limit=30';
const SEARCH_URL = '/api/pump/search';
const COIN_URL = '/api/pump/coin';

// Normalize a raw pump.fun coin (trending feed or search results — both share
// the same upstream shape) into the compact record the lobby/world consume.
function mapCoins(raw) {
	const list = Array.isArray(raw) ? raw : raw.data || raw.coins || raw.items || [];
	return list.map((c) => ({
		mint: c.mint || c.address,
		name: (c.name || '').trim() || 'Unnamed coin',
		symbol: (c.symbol || '').trim(),
		image: proxiedImageURL(c.image_uri || c.image || c.imageUri || c.logo || '', c.mint || c.address || ''),
		marketCap: c.usd_market_cap || c.market_cap_usd || c.marketCap || 0,
	})).filter((c) => c.mint);
}

// Compact USD for the jumbotron's market-cap readout: $1.2B / $940M / $12K.
function formatUsd(n) {
	const v = Number(n) || 0;
	if (v <= 0) return '';
	if (v >= 1e9) return '$' + (v / 1e9).toFixed(v >= 1e10 ? 0 : 1) + 'B';
	if (v >= 1e6) return '$' + (v / 1e6).toFixed(v >= 1e7 ? 0 : 1) + 'M';
	if (v >= 1e3) return '$' + Math.round(v / 1e3) + 'K';
	return '$' + Math.round(v);
}

// A networked peer: their own avatar rig + animation + name label + chat bubble.
class RemotePlayer {
	constructor(scene, player) {
		this.scene = scene;
		this.rig = new Group();
		this.anim = new AnimationManager();
		this.targetX = player.x; this.targetY = player.y; this.targetZ = player.z; this.targetYaw = player.yaw;
		this.curYaw = player.yaw; this.motion = player.motion || 'idle';
		this.rig.position.set(player.x, player.y, player.z);
		scene.add(this.rig);

		// Public identity riding the server schema — who this peer is (name), the
		// three.ws agent they pilot, and their verified account wallet. These feed
		// the avatar inspector (I / click a nameplate), never invented client-side.
		this.name = player.name || 'guest';
		this.agent = player.agent || '';
		this.account = player.account || '';
		this.onInspect = null; // set by CoinCommunities right after construction

		this.label = document.createElement('div');
		this.label.className = 'cc-label';
		this.label.textContent = player.name || 'guest';
		// The nameplate doubles as the peer's click target: labels are cheap,
		// always visible, and don't need a skinned-mesh raycast. pointer-events is
		// off for .cc-label globally (bubbles must never block the look-drag), so
		// re-enable it just for this element.
		this.label.style.pointerEvents = 'auto';
		this.label.style.cursor = 'pointer';
		this.label.title = 'Inspect this player (I)';
		this.label.addEventListener('click', (e) => { e.stopPropagation(); this.onInspect?.(); });
		document.body.appendChild(this.label);

		this.bubble = null;
		this._bubbleTimer = null;
		this.height = 1.7; // avatar head height; updated once the GLB measures

		this.voice = !!player.voice;
		this.label.classList.toggle('cc-invoice', this.voice);
		// This peer's equipped cosmetic loadout (R23), as the wire string the server
		// publishes on the schema. Applied once the GLB measures (setAvatar), and
		// re-applied whenever they change their fit (apply()).
		this._cosWire = player.cosmetics || '';
		this.setAvatar(player.avatar);
		// Tag mini-game (R08): red glow ring + 🏃 label for the "it" player.
		this.isIt = !!player.it;
		if (this.isIt) { this._addGlowRing(); this._addItLabel(); }
		// Combat (W07): downed peers lie flat (a lightweight ragdoll — no physics
		// sim, just an honest "you're out" pose) and stop being nameplate-clickable
		// targets; a wanted peer's nameplate carries their star count.
		this.isDead = !!player.dead;
		this.heat = player.heat | 0;
		if (this.isDead) this._applyDowned(true);
		this._updateWantedBadge();
	}
	setAvatar(url) {
		if (url === this._avatarUrl) return;
		this._avatarUrl = url;
		// rebuild model — clearing the rig takes any worn cosmetics with it, so drop
		// the old handle and re-apply once the new GLB has measured.
		try { this.cosmetics?.dispose(); } catch {}
		this.cosmetics = null;
		this._cosApplied = null;
		this.rig.clear();
		this.anim = new AnimationManager();
		// Tag this load so a slower in-flight GLB can't attach to the rig after the
		// peer disposed or swapped avatars again — otherwise the resolved model
		// lands on a cleared/removed rig (orphaned mesh, or two models at once).
		const token = (this._avatarToken = (this._avatarToken || 0) + 1);
		const anim = this.anim;
		resolveAvatarUrl(url).then((u) => buildAvatar(this.rig, u, anim).then(({ height }) => {
			if (this._disposed || token !== this._avatarToken) return;
			this.height = height;
			anim.crossfadeTo(this.motion === 'walk' || this.motion === 'run' ? CLIP_WALK : CLIP_IDLE, 0);
			this.applyCosmetics();
		})).catch(() => {});
	}
	// Dress this peer in their equipped loadout. Idempotent — re-applies only when
	// the wire actually changed, and waits for the avatar to measure (setAvatar
	// calls it post-load). Reuses the same applyLoadout the local player and the
	// creator use, so one wardrobe renders identically everywhere.
	applyCosmetics(wire) {
		const next = typeof wire === 'string' ? wire : (this._cosWire || '');
		this._cosWire = next;
		if (this._disposed || !this.height) return;
		if (this.cosmetics && this._cosApplied === next) return;
		this._cosApplied = next;
		try { this.cosmetics?.dispose(); } catch {}
		this.cosmetics = applyLoadout(this.rig, this.height, next);
	}
	_addGlowRing() {
		if (this._glowRing) return;
		const geo = new RingGeometry(0.5, 0.75, 32);
		const mat = new MeshBasicMaterial({ color: 0xff2222, transparent: true, opacity: 0.72, depthWrite: false });
		this._glowRing = new Mesh(geo, mat);
		this._glowRing.rotation.x = -Math.PI / 2;
		this._glowRing.position.y = 0.02;
		this.rig.add(this._glowRing);
	}
	_removeGlowRing() {
		if (!this._glowRing) return;
		this.rig.remove(this._glowRing);
		this._glowRing.geometry.dispose();
		this._glowRing.material.dispose();
		this._glowRing = null;
	}
	_addItLabel() {
		if (this._itLabel) return;
		this._itLabel = document.createElement('div');
		this._itLabel.className = 'cc-it-marker';
		this._itLabel.textContent = '🏃 IT';
		document.body.appendChild(this._itLabel);
	}
	_removeItLabel() {
		if (!this._itLabel) return;
		this._itLabel.remove();
		this._itLabel = null;
	}
	_updateItMarker(isIt) {
		if (!!isIt === this.isIt) return;
		this.isIt = !!isIt;
		if (this.isIt) { this._addGlowRing(); this._addItLabel(); }
		else { this._removeGlowRing(); this._removeItLabel(); }
	}
	// Downed pose (W07): tilt the rig onto its side rather than faking a physics
	// ragdoll no other part of the client has — an honest, cheap "you're out"
	// read that's unmistakable at a glance and costs nothing to reverse.
	_applyDowned(down) {
		this.rig.rotation.x = down ? -Math.PI / 2 : 0;
		this.rig.position.y = down ? 0.15 : this.rig.position.y;
		this.rig.traverse((o) => { if (o.material && 'opacity' in o.material) { o.material.transparent = true; o.material.opacity = down ? 0.55 : 1; } });
	}
	_updateWantedBadge() {
		if (this.heat > 0) {
			this.label.dataset.wanted = '★'.repeat(Math.min(5, this.heat));
			this.label.classList.add('cc-wanted');
		} else {
			delete this.label.dataset.wanted;
			this.label.classList.remove('cc-wanted');
		}
	}
	apply(player) {
		this.targetX = player.x; this.targetY = player.y; this.targetZ = player.z; this.targetYaw = player.yaw;
		if (player.name) { this.name = player.name; this.label.textContent = player.name; }
		if (player.agent !== undefined) this.agent = player.agent || '';
		if (player.account !== undefined) this.account = player.account || '';
		if (player.voice !== undefined && !!player.voice !== this.voice) {
			this.voice = !!player.voice;
			this.label.classList.toggle('cc-invoice', this.voice);
			if (!this.voice) this.setSpeaking(false);
		}
		if (player.avatar !== this._avatarUrl) this.setAvatar(player.avatar);
		if (player.cosmetics !== undefined && player.cosmetics !== this._cosWire) this.applyCosmetics(player.cosmetics);
		if (player.it !== undefined) this._updateItMarker(player.it);
		if (player.dead !== undefined && !!player.dead !== this.isDead) {
			this.isDead = !!player.dead;
			this._applyDowned(this.isDead);
		}
		if (player.heat !== undefined && (player.heat | 0) !== this.heat) {
			this.heat = player.heat | 0;
			this._updateWantedBadge();
		}
		if (player.motion !== this.motion) {
			this.motion = player.motion;
			this.anim.crossfadeTo(this.motion === 'walk' || this.motion === 'run' ? CLIP_WALK : CLIP_IDLE, 0.18);
		}
		if (player.emote && player.emoteTs && player.emoteTs !== this._emoteTs) {
			this._emoteTs = player.emoteTs;
			playEmoteClip(this.anim, player.emote, this.motion);
		}
	}
	say(text) {
		if (this.bubble) this.bubble.remove();
		this.bubble = document.createElement('div');
		this.bubble.className = 'cc-bubble';
		this.bubble.textContent = text;
		document.body.appendChild(this.bubble);
		clearTimeout(this._bubbleTimer);
		this._bubbleTimer = setTimeout(() => { this.bubble?.remove(); this.bubble = null; }, 5000);
	}
	// Pulse this peer's nameplate while they're talking, so you can see who's
	// speaking in a crowd, not just hear them.
	setSpeaking(on) {
		if (on === this._speaking) return;
		this._speaking = on;
		this.label.classList.toggle('cc-speaking', on);
	}
	tick(dt) {
		this.rig.position.x += (this.targetX - this.rig.position.x) * REMOTE_LERP;
		this.rig.position.y += (this.targetY - this.rig.position.y) * REMOTE_LERP;
		this.rig.position.z += (this.targetZ - this.rig.position.z) * REMOTE_LERP;
		let d = this.targetYaw - this.curYaw;
		while (d > Math.PI) d -= Math.PI * 2;
		while (d < -Math.PI) d += Math.PI * 2;
		this.curYaw += d * 0.2;
		this.rig.rotation.y = this.curYaw;
		if (this.anim.currentName === CLIP_WALK) this.anim.setSpeed(this.motion === 'run' ? RUN_TIMESCALE : 1);
		this.anim.update(dt);
		this.cosmetics?.tick(dt);
	}
	dispose() {
		this._disposed = true;
		try { this.cosmetics?.dispose(); } catch {}
		this._removeGlowRing();
		this._removeItLabel();
		this.scene.remove(this.rig);
		this.label.remove();
		this.bubble?.remove();
		clearTimeout(this._bubbleTimer);
	}
}

export class CoinCommunities {
	constructor(canvas) {
		this.canvas = canvas;
		this.phase = 'lobby';
		this.remotes = new Map();
		this.keys = new Set();
		this.input = new Vector3(); // joystick/keys movement intent (x,z in [-1,1])
		this.camYaw = 0.6; this.camPitch = 0.5; this.camDist = 9;
		// Spawn within the server's 1.2m max-step radius of its origin (0,0,0) so
		// our first authoritative move isn't rejected as a teleport. A small
		// random offset keeps players from stacking exactly on each other.
		const a = Math.random() * Math.PI * 2, rad = 0.4 + Math.random() * 0.5;
		this.localPos = new Vector3(Math.cos(a) * rad, 0, Math.sin(a) * rad);
		this.localYaw = Math.PI;
		this.motion = 'idle';
		this.vy = 0;            // vertical velocity for jumps
		this.grounded = true;   // false while airborne
		this._dragging = false; this._lastPtr = null;
		this._last = performance.now();
		this._lastKick = 0; // R05: timestamp of last ball:kick intent (client-side rate limit)

		// W01: real Rapier collision. A single physics world + character controller
		// persist for the whole session (Rapier's WASM init is memoized globally);
		// district building colliders are rebuilt per coin in enter(). Movement in
		// _stepLocal falls back to the legacy direct-mutation path until this
		// resolves, so the first frame or two before Rapier's WASM loads still play.
		this._physicsOk = false;
		this._physics = null;
		this._character = null;
		this._physicsActivePrev = false;
		this._physicsReady = this._initPhysics();

		// W01: four-mode chase camera (follow/cinematic/firstperson/topdown),
		// shared with /walk via camera-modes.js. 'c' cycles it (see _bindInput).
		this._camModes = createCameraModeController({
			storageKey: 'play:camera-mode',
			onChange: (m) => this.ui?.toast(`Camera: ${CAMERA_MODE_LABELS[m]}`, 'info'),
		});

		// Embed mode: `?bg=transparent` clears the canvas to alpha 0 and drops the
		// graded sky + fog so the world composites onto the host page (e.g. the IBM
		// x402 showcase) instead of sitting in its own black box. Default play is
		// unaffected.
		this._transparentBg = new URLSearchParams(location.search).get('bg') === 'transparent';

		// Embed mode: `?biome=<id>` pins every world this session renders to one
		// curated look (e.g. `noir` for a dark host surface) instead of the per-coin
		// seeded biome — so a /play embed on a partner page stays visually consistent
		// with that page. Validated against the biome table; an unknown id is ignored
		// and the normal seeded look is used, so default play is unaffected.
		this._biomePin = new URLSearchParams(location.search).get('biome') || null;

		this._initRenderer();
		this._initScene();

		this.ui = new CommunityUI({
			onEnter: (coin, tier) => this.enter(coin, { tier }),
			// Holder gate overlay → the scene's gate state machine resolves on each
			// action (sign in, link wallet, buy, recheck, cancel).
			onHolderAction: (action) => { const r = this._holderGateResolve; this._holderGateResolve = null; r?.(action); },
			onLeave: () => this.leave(),
			onChat: (t) => this._sendChat(t),
			onEmote: (n) => this._emote(n),
			onReaction: (emoji) => this.net?.sendReaction(emoji),
			onSearch: (q) => this._searchCoins(q),
			onRetry: () => this.net?.retry(),
			// Resolve the picked value (avatar id, gallery pick, URL) to a loadable,
			// host-whitelisted URL before broadcasting, so a mid-session avatar swap
			// actually reaches peers (the server rejects bare ids / blob: URLs).
			onAvatarChange: (val) => {
				if (!this.net || val === GUEST_SENTINEL) return;
				resolveAvatarUrl(val).then((u) => this.net?.setAvatar(u));
			},
			onRename: (name) => this._rename(name),
			onBuy: () => this._openBuy(),
			onShop: () => this._toggleShop(),
			onWardrobe: () => this._toggleWardrobe(),
			onJobs: () => this._toggleQuests(),
			// Friends panel (W09) — presence + DMs across every coin world.
			onFriends: () => this._toggleFriends(),
			// Cold-open intro's zero-friction path — drop straight into the $THREE
			// home town with whatever avatar/name is already defaulted, no picking
			// required. See play-intro.js and _dropIn() below.
			onDropIn: () => this._dropIn(),
			// Creator-only (R24): set/clear the token threshold for the Holders world.
			onConfigureGate: () => this._configureGate(),
			onVoiceToggle: () => this._toggleVoice(),
			// Build structures toolbar (R20): pick a composite piece, rotate it, share a
			// screenshot of the build, or open this coin's featured builds.
			onPickPiece: (id) => this._pickPiece(id),
			onRotateBuild: () => this._rotateBuild(),
			// Build props (R18): arm/disarm a placeable prop and rotate the armed one.
			onPickProp: (id) => this._pickProp(id),
			onRotateProp: () => this._rotateProp(),
			onShareBuild: () => this._shareBuild(),
			onOpenFeatured: () => this._openFeatured(),
			onPublishBuild: (meta) => this._publishBuild(meta),
			onDance: () => this._triggerDance(),
			onFeaturedClosed: () => { this._featuredOpen = false; },
		});

		// Collaborative building HUD (hotbar + place/break toggle). Hidden until the
		// player is in a world and connected — there's nowhere to build otherwise.
		this.buildType = 0;
		// R20 structures: which composite piece is armed (null = single block) and the
		// quarter-turn rotation (0–3) applied to it. Both drive the ghost preview.
		this.buildPiece = null;
		this.buildRot = 0;
		// R18 props: which placeable prop is armed (null = voxel layer active), its
		// quarter-turn rotation, and current scale. When a prop is armed, build clicks
		// place free-standing objects through the R01 object channel instead of voxels.
		this.buildProp = null;
		this.buildPropRot = 0;
		this.buildPropScale = 1;
		this.buildHud = createBuildHud({
			onToggle: (on) => this._onBuildToggle(on),
			onPick: (i) => { this.buildType = i; this._refreshGhost(); },
			onModeChange: () => this._refreshGhost(),
			onClearArea: (scope) => this._onClearArea(scope),
		});
		// Build permissions (R19) — refreshed from the server's build-perms snapshot:
		// the player's per-world block cap + usage, and whether they're the coin creator
		// (which unlocks the clear-area moderation tool). Solo builds carry no cap.
		this._buildPerms = { creator: false, cap: 0, used: 0, clearMaxRadius: 12 };
		this.buildHud.root.hidden = true;
		this.buildHud.setEnabled(false);

		this._hideBootLoader();
		this._loadHomeTown();
		this._loadCoins();
		this._bindInput();

		// First-ten-seconds cold open (see play-intro.js header for the audit finding
		// this fixes): a first-time visitor otherwise lands on a bare coin grid with
		// no context and bounces. Shown once per browser; the reopener in the lobby
		// header brings it back any time. NOT shown on a `?coin=<mint>` deep link —
		// that visitor already made their choice (a shared world link) and "Drop in
		// now" would silently redirect them to the $THREE home town instead of the
		// world they clicked into, on top of it already loading behind the modal.
		if (!new URLSearchParams(location.search).get('coin')) {
			showPlayIntro({ onDropIn: () => this._dropIn() });
		}

		this._loop = this._loop.bind(this);
		requestAnimationFrame(this._loop);

		// Wallet-first entry: when the platform has pinned a game token, the sign-in
		// gate stands in front of everything — connect a wallet, sign a nonce, and
		// hold ≥ the floor before any world opens. The verified wallet becomes the
		// account id we carry into every room. When no token is pinned the gate
		// resolves instantly (open /play) and nothing below changes. enter() awaits
		// this, so a deep link still drops in — just after the gate clears.
		this.playPass = '';
		this.account = '';
		this._playReady = this._ensurePlayAccess();

		// Deep link: /play?coin=<mint>&name=&symbol=&image= drops straight into a
		// coin's community, so a community is a shareable URL. An optional
		// `?avatar=<glb|id>` rides along (used by "See in 3D" links) and is shown
		// for this session only — never persisted over the player's saved avatar.
		const p = new URLSearchParams(location.search);
		this._urlAvatar = (p.get('avatar') || '').trim();
		const mint = p.get('coin');
		if (mint) {
			const tier = p.get('tier') === 'holders' ? 'holders' : 'general';
			this.enter({ mint, name: p.get('name') || '', symbol: p.get('symbol') || '', image: proxiedImageURL(p.get('image') || '', mint) }, { tier });
		}
	}

	// W01: boot the shared Rapier world once. A flat ground collider covers the
	// whole district (buildings are added per-coin in enter(), once the district
	// grid is built). Never throws — a WASM failure (unsupported browser, blocked
	// worker) degrades to the legacy direct-mutation movement path instead of
	// wedging boot.
	async _initPhysics() {
		try {
			this._physics = await PhysicsWorld.create({ gravity: { x: 0, y: -GRAVITY, z: 0 } });
			this._physics.addGround(0, DISTRICT.half + 40);
			this._physicsOk = true;
		} catch (err) {
			log.warn('[coincommunities] physics init failed — falling back to legacy movement:', err?.message);
			this._physicsOk = false;
		}
	}

	async _hideBootLoader() {
		const l = document.getElementById('kx-loading');
		if (!l) return;
		// Hold the loader until the boot avatar's first frame has rendered so the
		// character is actually seen, not flashed away. `ready` always resolves
		// (even on WebGL/asset failure) and carries its own 6s safety timeout, so
		// this can never wedge the loader open.
		const boot = window.__ccBootAvatar;
		try { await boot?.ready; } catch { /* proceed regardless */ }
		l.classList.add('kx-hidden');
		setTimeout(() => { boot?.dispose?.(); l.remove(); }, 600);
	}

	async _loadCoins(attempt = 0) {
		this.ui.setCoinsLoading();
		try {
			const r = await fetch(TRENDING_URL, { headers: { accept: 'application/json' } });
			if (!r.ok) {
				// A 429/5xx here is almost always a blip (rate-limit window, deploy churn):
				// the feed sits behind a 30s server cache, so one delayed retry usually
				// lands. Only after that does the manual-retry error card appear.
				if (attempt === 0 && (r.status === 429 || r.status >= 500)) {
					const after = Number(r.headers.get('retry-after'));
					const delayMs = Number.isFinite(after) && after > 0 ? Math.min(after, 30) * 1000 : 2500;
					setTimeout(() => this._loadCoins(1), delayMs);
					return;
				}
				throw new Error('HTTP ' + r.status);
			}
			const raw = await r.json();
			this.ui.setCoins(mapCoins(raw));
		} catch (err) {
			log.warn('[coincommunities] coin load failed:', err?.message);
			this.ui.setCoinsError(() => this._loadCoins());
		}
	}

	// The flagship $THREE town is always pinned to the top of the lobby, even when
	// it isn't trending — it's the platform's front door. Show the static identity
	// instantly so the card never flashes empty, then refresh name/art/market-cap
	// live from pump.fun so the pin is real, not a hardcoded snapshot.
	async _loadHomeTown() {
		this.ui.setFeatured({ ...HOME_TOWN, official: true });
		try {
			const r = await fetch(`${COIN_URL}?mint=${HOME_TOWN.mint}`, { headers: { accept: 'application/json' } });
			if (!r.ok) throw new Error('HTTP ' + r.status);
			const [coin] = mapCoins([await r.json()]);
			if (coin?.mint) this.ui.setFeatured({ ...HOME_TOWN, ...coin, official: true });
		} catch (err) {
			// Non-fatal: the static pin from above stands in until next load.
			log.warn('[coincommunities] home town refresh failed:', err?.message);
		}
	}

	// Live search across ALL of pump.fun (not just the trending grid) so any
	// coin can be turned into a world. Returns mapped coins; throws on failure
	// so the UI can distinguish "no matches" from "search unavailable".
	async _searchCoins(query) {
		const q = (query || '').trim();
		if (!q) return [];
		const r = await fetch(`${SEARCH_URL}?q=${encodeURIComponent(q)}`, { headers: { accept: 'application/json' } });
		if (!r.ok) throw new Error('HTTP ' + r.status);
		return mapCoins(await r.json());
	}

	// ---------------------------------------------------------------- render
	_initRenderer() {
		let r;
		try {
			r = new WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: this._transparentBg });
		} catch (err) {
			// WebGL context creation fails on blocklisted GPUs, machines with
			// hardware acceleration disabled, and some in-app/embedded browsers.
			// Tag the failure so the boot guard can show a recovery message instead
			// of leaving the player on a dead loader — boot-avatar.js already
			// degrades gracefully, and the main scene must too.
			const e = new Error('WebGL unavailable: ' + (err?.message || err));
			e.code = 'NO_WEBGL';
			throw e;
		}
		r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
		r.setSize(window.innerWidth, window.innerHeight);
		if (this._transparentBg) r.setClearColor(0x000000, 0);
		r.shadowMap.enabled = true; r.shadowMap.type = PCFShadowMap;
		r.outputColorSpace = SRGBColorSpace;
		// ACES keeps the cool moonlight key and the bright avatars from clipping;
		// exposure is tuned for the dark monochrome arena (the LDR gradient backdrop
		// doesn't need the heavy pull the old HDR daylight sky did).
		r.toneMapping = ACESFilmicToneMapping;
		r.toneMappingExposure = 1.0;
		this.renderer = r;
		window.addEventListener('resize', () => this._onResize());
	}

	_initScene() {
		// Nocturnal monochrome arena that flows out of the lobby: near-black ground
		// with a technical hairline grid, a glowing boundary ring, a silhouette
		// treeline melting into fog, under a single cool moonlight key. The whole
		// environment lives in world-env.js so this file stays focused on players,
		// the coin totem, and netcode.
		const scene = new Scene();
		this.scene = scene;

		// Far plane reaches the sky dome; near stays tight for close avatars.
		this.camera = new PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 9000);

		// Transparent embed (`?bg=transparent`): the environment skips the sky
		// backdrop so the host page shows through; ground, ring, and avatars render.
		this.env = createWorldEnvironment(scene, this.renderer, WORLD_RADIUS, { transparent: this._transparentBg, biome: this._biomePin || undefined });

		this.world = new Group();
		scene.add(this.world);
	}

	// Animate the world each frame: drifting clouds (owned by the environment)
	// and the slowly turning coin totem.
	_tickEnv(dt) {
		this.env?.update(dt);
		// W01: real time of day, deterministic from wall-clock time (worldClock) —
		// every client in every world computes the identical sun/sky/lamp state
		// with zero network sync, exactly like the /agent-screen ambient stage.
		this._dayNight?.setTime(worldClock(Date.now()));
		if (this._coinSpin) this._coinSpin.rotation.y += dt * 0.5;
		if (this._screenPulse) {
			this._screenT = (this._screenT || 0) + dt;
			this._screenPulse.material.opacity = 0.35 + 0.35 * (0.5 + 0.5 * Math.sin(this._screenT * 2.4));
		}
		this._chartScreen?.update(dt);
		this._oracleRibbon?.update(dt);
		this._reactor?.update(dt);
		if (this._agentDesks?.length) {
			for (const desk of this._agentDesks) desk.update(dt, this.localPos);
		}
		this._tickDanceFloor(dt);
	}

	// Central coin totem — the community's banner in 3D.
	_buildTotem(coin) {
		const g = new Group();
		const pillar = new Mesh(new CylinderGeometry(1.1, 1.4, 6, 24),
			new MeshStandardMaterial({ color: 0x3a4a72, roughness: 0.6, metalness: 0.2 }));
		pillar.position.y = 3; pillar.castShadow = true; pillar.receiveShadow = true;
		g.add(pillar);
		// Floating coin disc with the token image — a warm gold coin that catches the
		// sun key, slowly turning. The token art rides on its faces.
		const spin = new Group(); spin.position.y = 7.5;
		const disc = new Mesh(new CylinderGeometry(2.2, 2.2, 0.3, 40),
			new MeshStandardMaterial({ color: 0xffce5c, roughness: 0.35, metalness: 0.7, emissive: 0x3a2e00, emissiveIntensity: 0.3 }));
		disc.rotation.x = Math.PI / 2; disc.castShadow = true;
		spin.add(disc);
		this._totemDisc = disc;
		if (coin.image) {
			new TextureLoader().load(coin.image, (tex) => {
				tex.colorSpace = SRGBColorSpace;
				const face = new Mesh(new CircleGeometry(1.9, 40), new MeshBasicMaterial({ map: tex }));
				face.position.set(0, 0, 0.18); spin.add(face);
				const back = new Mesh(new CircleGeometry(1.9, 40), new MeshBasicMaterial({ map: tex }));
				back.position.set(0, 0, -0.18); back.rotation.y = Math.PI; spin.add(back);
			}, undefined, () => { /* image blocked — totem still shows */ });
		}
		g.add(spin);
		this._coinSpin = spin;
		// Name banner texture.
		g.add(this._textBanner(coin.name || 'Community', coin.symbol ? '$' + coin.symbol : ''));
		// Place the totem as a landmark away from the spawn point so players don't
		// spawn inside the pillar.
		g.position.set(0, 0, -12);
		this.world.add(g);
		this._totem = g;
	}

	_textBanner(name, sym) {
		const c = document.createElement('canvas'); c.width = 512; c.height = 128;
		const x = c.getContext('2d');
		x.fillStyle = 'rgba(11,16,32,0.0)'; x.fillRect(0, 0, 512, 128);
		x.textAlign = 'center'; x.fillStyle = '#fff';
		x.font = '800 50px Inter, system-ui, sans-serif';
		x.fillText(name.slice(0, 18).toUpperCase(), 256, 56);
		x.font = 'bold 32px Inter, system-ui, sans-serif'; x.fillStyle = '#5fc8ff';
		x.fillText(sym, 256, 100);
		const tex = new CanvasTexture(c); tex.colorSpace = SRGBColorSpace;
		const m = new Mesh(new PlaneGeometry(6, 1.5), new MeshBasicMaterial({ map: tex, transparent: true, side: DoubleSide }));
		m.position.y = 10.2;
		return m;
	}

	// Stadium-style jumbotron — the coin's giant LED screen, towering over the
	// plaza so it's the first thing players see on entry. It shows the coin art,
	// name, market cap, and a LIVE readout of how many are in the community right
	// now (redrawn from _updateOnline as people join and leave). Built as a dark
	// panel on two posts at the far edge of the plaza, angled to face the spawn.
	_buildScreen(coin) {
		const W = 24, H = 13.5; // 16:9 panel, in metres
		const g = new Group();

		// Dark bezel behind the lit panel so the screen reads as a framed display.
		const bezel = new Mesh(new PlaneGeometry(W + 0.7, H + 0.7),
			new MeshStandardMaterial({ color: 0x070708, roughness: 0.6, metalness: 0.3 }));
		bezel.position.set(0, 11, -0.06); g.add(bezel);

		// The lit panel: a canvas texture (name / market cap / live count) drawn by
		// _drawScreen. Unlit material so it glows like an LED wall at any distance.
		const canvas = document.createElement('canvas');
		canvas.width = 1600; canvas.height = 900;
		const tex = new CanvasTexture(canvas); tex.colorSpace = SRGBColorSpace;
		const panel = new Mesh(new PlaneGeometry(W, H), new MeshBasicMaterial({ map: tex }));
		panel.position.set(0, 11, 0); g.add(panel);
		this._screenCanvas = canvas; this._screenTex = tex;

		// Coin artwork as its own textured plane (loaded the same CORS-safe way as
		// the totem) overlaid on the panel's left third, so compositing the image
		// into the canvas can never taint it.
		if (coin.image) {
			new TextureLoader().load(coin.image, (imgTex) => {
				imgTex.colorSpace = SRGBColorSpace;
				const art = new Mesh(new PlaneGeometry(8.4, 8.4), new MeshBasicMaterial({ map: imgTex }));
				art.position.set(-6.7, 11, 0.04); g.add(art);
				this._screenArt = art;
			}, undefined, () => { /* image blocked — panel still shows text */ });
		}

		// A LIVE bar that pulses along the panel's base (animated in _tickEnv) — the
		// cheap, always-moving signal that the room is live without redrawing canvas.
		const pulse = new Mesh(new PlaneGeometry(W - 1.2, 0.16),
			new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6 }));
		pulse.position.set(0, 11 - H / 2 + 0.5, 0.05); g.add(pulse);
		this._screenPulse = pulse;

		// Two posts carrying the panel down to the ground.
		const postMat = new MeshStandardMaterial({ color: 0x131316, roughness: 0.5, metalness: 0.5 });
		const postH = 11 - H / 2;
		for (const sx of [-1, 1]) {
			const post = new Mesh(new CylinderGeometry(0.32, 0.42, postH, 18), postMat);
			post.position.set(sx * (W / 2 - 1.4), postH / 2, -0.1);
			post.castShadow = true; g.add(post);
		}

		// Far edge of the plaza, facing back toward the spawn/camera (+Z view).
		g.position.set(0, 0, 34);
		g.rotation.y = Math.PI;
		this.world.add(g);
		this._screen = g;
		this._drawScreen();
	}

	// Render the jumbotron's text layer: coin name, symbol, market cap, and the
	// live community count. Cheap and event-driven — only called on build and when
	// the online count changes, never per-frame.
	_drawScreen() {
		const canvas = this._screenCanvas;
		if (!canvas) return;
		const coin = this.coin || {};
		const x = canvas.getContext('2d');
		x.clearRect(0, 0, 1600, 900);

		// Panel background + inner frame.
		const bg = x.createLinearGradient(0, 0, 0, 900);
		bg.addColorStop(0, '#101013'); bg.addColorStop(1, '#050506');
		x.fillStyle = bg; x.fillRect(0, 0, 1600, 900);
		x.strokeStyle = 'rgba(255,255,255,0.10)'; x.lineWidth = 3;
		x.strokeRect(14, 14, 1572, 872);

		// Art well on the left (the coin-image plane sits over this region).
		x.beginPath(); x.roundRect(96, 210, 600, 600, 20);
		x.fillStyle = 'rgba(255,255,255,0.04)';
		x.fill(); x.strokeStyle = 'rgba(255,255,255,0.12)'; x.lineWidth = 2; x.stroke();
		if (!coin.image) {
			x.fillStyle = 'rgba(255,255,255,0.28)';
			x.font = '300 200px Inter, system-ui, sans-serif';
			x.textAlign = 'center'; x.textBaseline = 'middle';
			x.fillText('◎', 396, 500);
		}

		const colX = 770; // right text column
		x.textAlign = 'left'; x.textBaseline = 'alphabetic';

		// Coin name — shrink the font until it fits the column width.
		const name = (coin.name || 'Community').toUpperCase();
		let nameSize = 116;
		x.fillStyle = '#f5f5f6';
		do { x.font = `800 ${nameSize}px Inter, system-ui, sans-serif`; nameSize -= 4; }
		while (x.measureText(name).width > 740 && nameSize > 48);
		x.fillText(name, colX, 300);

		// $SYMBOL.
		if (coin.symbol) {
			x.fillStyle = '#8c8c92';
			x.font = '600 52px Inter, system-ui, sans-serif';
			x.fillText('$' + coin.symbol.toUpperCase(), colX, 372);
		}

		// Divider.
		x.strokeStyle = 'rgba(255,255,255,0.10)'; x.lineWidth = 2;
		x.beginPath(); x.moveTo(colX, 430); x.lineTo(1500, 430); x.stroke();

		// Market cap (only when we have it).
		const mcap = formatUsd(coin.marketCap);
		if (mcap) {
			x.fillStyle = '#5a5a60';
			x.font = '600 34px Inter, system-ui, sans-serif';
			x.fillText('MARKET CAP', colX, 500);
			x.fillStyle = '#f5f5f6';
			x.font = '800 92px Inter, system-ui, sans-serif';
			x.fillText(mcap, colX, 588);
		}

		// LIVE — N in this community.
		const n = this._online || 1;
		const baseY = 740;
		x.fillStyle = '#ffffff';
		x.beginPath(); x.arc(colX + 11, baseY - 13, 11, 0, Math.PI * 2); x.fill();
		x.font = '800 38px Inter, system-ui, sans-serif';
		x.fillText('LIVE', colX + 38, baseY);
		x.fillStyle = '#8c8c92';
		x.font = '500 38px Inter, system-ui, sans-serif';
		const label = n === 1 ? '1 in this community' : `${n} in this community`;
		x.fillText(label, colX + 150, baseY);

		this._screenTex.needsUpdate = true;
	}

	// ---------------------------------------------------------------- enter/leave
	async enter(coin, opts = {}) {
		if (this.phase !== 'lobby') return;
		// Clear the platform sign-in gate before anything else. Resolves instantly
		// when /play is open (no token pinned) or when we already hold a fresh pass.
		if (this._playReady) { try { await this._playReady; } catch { /* gate self-heals */ } }
		if (this.phase !== 'lobby') return; // backed out / re-entered while the gate was up
		const tier = opts.tier === 'holders' ? 'holders' : 'general';
		// Entry does several awaits (gate, manifest, avatar GLB, room connect) and
		// the Leave button goes live the moment the HUD shows — well before connect
		// resolves. Stamp this attempt so a continuation that resumes after the
		// player has backed out (leave() bumps the epoch) bails instead of
		// resurrecting a torn-down world on a null `this.net`.
		const epoch = (this._enterEpoch = (this._enterEpoch || 0) + 1);

		// Holder worlds are gated: prove the player holds ≥ the floor of this coin
		// before we build anything. The gate runs entirely in the lobby so a refusal
		// leaves them exactly where they were, free to enter the General world
		// instead. A null result means they cancelled — stay put.
		let holderPass = '';
		let holderMinUsd = 0;
		let holderMinTokens = 0;
		if (tier === 'holders') {
			const pass = await this._passHolderGate(coin);
			if (!pass) return;
			holderPass = pass.holderPass;
			holderMinUsd = pass.minUsd;
			holderMinTokens = pass.minTokens || 0;
		}

		this.phase = 'loading';
		// A bare deep link (/play?coin=<home mint>) carries no name/art; backfill the
		// flagship town's identity so its totem, jumbotron, and HUD are never blank.
		if (isHomeTown(coin.mint)) {
			coin = {
				...coin,
				name: coin.name || HOME_TOWN.name,
				symbol: coin.symbol || HOME_TOWN.symbol,
				image: coin.image || HOME_TOWN.image,
				biome: HOME_TOWN.biome,
				official: true,
			};
		}
		coin = { ...coin, tier, holderMinUsd, holderMinTokens };
		this.coin = coin;
		this.ui.enterWorld(coin);
		document.body.classList.toggle('cc-holders', tier === 'holders');
		// Reflect the community in the URL so it can be shared / refreshed into. A
		// holder-world link carries &tier=holders so refreshing re-runs the gate.
		try {
			const q = new URLSearchParams({ coin: coin.mint });
			if (coin.name) q.set('name', coin.name);
			if (coin.symbol) q.set('symbol', coin.symbol);
			if (coin.image) q.set('image', coin.image);
			if (tier === 'holders') q.set('tier', 'holders');
			history.replaceState(null, '', location.pathname + '?' + q.toString());
		} catch { /* non-fatal */ }
		await loadManifest();
		this.ui.setEmotes(getEmoteDefs().map((d) => ({ name: d.name, icon: d.icon || '🙂', label: d.label })));
		this.ui.setAllEmotes(getAllEmoteDefs().map((d) => ({ name: d.name, icon: d.icon || '🙂', label: d.label })));
		this.ui.setReactions(REACTIONS);

		// Re-theme the environment for this specific community: a distinct biome,
		// palette, and flora derived deterministically from the coin's mint, so
		// every community has its own recognisable world.
		this.env?.dispose();
		this._district?.dispose();
		// The flagship town pins its signature biome; Robinhood Chain coins pin the
		// chain-flavored 'hoodchain' biome; every other coin draws its look from
		// the mint seed.
		const biomeOverride = this._biomePin
			|| (isHomeTown(coin.mint) ? (coin.biome || HOME_TOWN.biome) : undefined)
			|| (isRobinhoodCoin(coin.mint) ? 'hoodchain' : undefined);
		this.env = createWorldEnvironment(this.scene, this.renderer, WORLD_RADIUS, { mint: coin.mint, biome: biomeOverride });
		this.ui.toast(`${coin.symbol ? '$' + coin.symbol : coin.name || 'Community'} — ${this.env.biome.label}`, 'info');

		// W01: the drivable street grid ringing Downtown — same seed as the biome
		// so it's identical for every client, themed from the same palette. The
		// day/night cycle drives its window/streetlamp glow via setNight().
		this._district = createDistrict(this.scene, {
			seed: this.env.seed, biome: this.env.biome, playRadius: WORLD_RADIUS,
		});
		this._dayNight = createDayNightCycle(this.env, this._district);

		// W01: real collision. Await the one-time Rapier boot (usually long since
		// resolved by the time a player clears the lobby + avatar load), then swap
		// in this coin's building colliders and (re)place the kinematic character
		// at the fresh spawn point. The character controller persists across coin
		// switches — only its colliders and position change.
		await this._physicsReady;
		if (this._physicsOk && this._physics) {
			this._physics.clearObstacles();
			for (const c of this._district.colliders) this._physics.addStaticBox(c);
			// W02: the coin totem (built below by _buildTotem, always at (0,0,-12))
			// isn't part of the district grid, so give it its own collider — keeps
			// both pedestrians and driven vehicles from passing through the landmark.
			this._physics.addStaticCylinder({ position: { x: 0, y: 3, z: -12 }, radius: 1.6, halfHeight: 3.2 });
			const spawn = { x: this.localPos.x, y: 0, z: this.localPos.z };
			if (!this._character) this._character = this._physics.createCharacter({ position: spawn });
			else this._character.setPosition(spawn);
			this._physicsActivePrev = false; // resync _stepLocal to this fresh spawn next frame
			this.vy = 0; this.grounded = true;
		}
		if (epoch !== this._enterEpoch) return; // backed out during the physics await

		// Build the coin's world + local avatar.
		this._buildTotem(coin);
		this._buildScreen(coin);
		this._buildDanceFloor();
		this._buildKingZone();
		// The market reactor turns the live trade tape into world behaviour: buys
		// ripple green and kick the boundary ring, sells ripple red, volume spins
		// the totem, the rolling % drives the weather, and whales detonate a beam
		// of light with a shower of coins. It's fed by the chart screen's onTrades.
		this._reactor = new MarketReactor({
			scene: this.scene,
			env: this.env,
			totem: this._coinSpin,
			totemPos: [0, 0, -12],
			onWhale: (tr) => {
				const usd = formatUsd(tr.usd);
				const who = tr.isBuy ? 'bought' : 'sold';
				this.ui.toast(`🐋 Whale ${who}${usd ? ' ' + usd : ''} of ${coin.symbol ? '$' + coin.symbol : coin.name || 'this coin'}`, 'info');
			},
		});
		// Live trading terminal facing the spawn from past the totem: the coin's
		// price chart, % change, volume, buy/sell flow, and a ticker of real
		// on-chain trades — a second screen players can walk up to and tap to open
		// the coin on pump.fun. Identity jumbotron behind, market chart ahead. Its
		// freshly-landed trades feed the reactor so the world reacts to the tape.
		this._chartScreen = createChartScreen(this.scene, coin, {
			position: [0, 0, -30], width: 18,
			onTrades: (trades, metrics) => this._reactor?.ingestTrades(trades, metrics),
		});
		// The /ibm/oracle 3D forecast line — the live $THREE price history + IBM
		// Granite TimeSeries forecast, rendered as a glowing ribbon standing in the
		// world (no backdrop, just the line) that players can walk around.
		this._oracleRibbon = mountOracleRibbon(this.scene, { x: 17, y: 4.2, z: -20, scale: 0.7 });
		this.localRig = new Group();
		this.localRig.position.copy(this.localPos);
		this.scene.add(this.localRig);
		// Cosmetics preview rig (R21) re-binds to whatever avatar is current —
		// drop any prior session's manager so it attaches to this fresh skeleton.
		this._accessoryMgr = null;
		this._previewItem = null;
		this.localAnim = new AnimationManager();
		// An `?avatar=` deep link (a "See in 3D" link carrying an agent's GLB) shows
		// that avatar for the session without overwriting the player's saved pick;
		// otherwise use whatever they selected in the lobby (preset / paste / upload).
		const avatarInput = this._urlAvatar || this.ui.getAvatar();
		const url = await resolveAvatarUrl(avatarInput);
		const { height: localHeight, fallback: avatarFallback } = await buildAvatar(this.localRig, url, this.localAnim);
		// Backed out while the avatar GLB was loading — stop before we open a room.
		if (epoch !== this._enterEpoch) return;
		this.localHeight = localHeight;
		// Dress the local avatar in the loadout the player last equipped (carried
		// across sessions and worlds via the cc-cosmetics mirror). The server echoes
		// the authoritative, ownership-validated loadout right after join — which
		// re-applies here through _onCosmeticsProfile — but applying the cached wire
		// now means the player sees their fit immediately, not a flash of bare avatar.
		this._localCosWire = null;
		this._applyLocalCosmetics(getPlayCosmetics());
		// Don't silently swap a broken model for the stand-in — tell the player so
		// they know to pick another avatar.
		if (avatarFallback && avatarInput !== GUEST_SENTINEL) {
			this.ui.toast('Couldn’t load that avatar — using a stand-in. Try another in the lobby.', 'warn');
		}

		// Connect to this coin's room. A locally-staged guest avatar (just created,
		// not yet uploaded) can't be loaded by peers, so we join without one and
		// upload in the background — then broadcast the public URL so everyone sees
		// it. Otherwise broadcast a loadable URL/path directly.
		const isGuest = avatarInput === GUEST_SENTINEL;
		const netAvatar = isGuest
			? ''
			: (/^https?:\/\//i.test(avatarInput) || avatarInput.startsWith('/') ? avatarInput : url);
		// Prefer the name the player typed in the lobby; only mint a guest id when
		// they left it blank, and reflect that id back into the field so it's theirs.
		let name = this.ui.getName();
		if (!name) {
			name = lsGet('cc-name') || ('guest-' + Math.random().toString(36).slice(2, 6));
			this.ui.setName(name);
		}
		lsSet('cc-name', name);
		// Fresh voxel build layer for this coin. The server is authoritative: it
		// streams the persisted build in on join and every live edit after, so the
		// geometry is driven entirely by these block events (local clicks only send).
		this.voxels = new VoxelWorld(this.scene);

		this.net = new CommunityNet({
			name, avatar: netAvatar,
			coin: { mint: coin.mint, name: coin.name, symbol: coin.symbol, image: coin.image },
			tier: tier === 'holders' ? 'holders' : '',
			holderPass, holderMinUsd,
			// Platform token gate: the verified wallet + signed pass from sign-in. The
			// server binds the wallet (inside the pass) as the account id; harmless
			// when the server isn't gated.
			playPass: this.playPass, account: this.account,
			// Pre-join cosmetic loadout (R23): the fit the player last equipped, so
			// peers see it the instant we appear. The server validates each id against
			// what the account owns before publishing it, so it can't dress us in
			// anything unowned.
			cosmetics: getPlayCosmetics(),
			// Friends presence (W09): a signed, short-lived account ticket. WalkRoom
			// verifies it and registers this account with the social hub under this
			// coin world's name, so friends see the player as "Online · <coin>" and
			// DMs route straight to this socket. Resolves to null when anonymous.
			getPresence: getPresenceTicket,
		});
		// Generic networked-object layer for this coin (R02): mirrors the server's
		// authoritative `objects` map into the scene — build props (R18), and any
		// future ball/pickup — interpolated like the avatars. Delete-own keys on the
		// net's ownership check. Built per world; disposed alongside voxels on leave.
		this.worldObjects = new WorldObjects(this.scene, this.net, {
			isMine: (obj) => !!this.net?.ownsObject(obj),
		});
		this.propGhost = new PropGhost(this.scene);
		this.net.on('objectReject', ({ reason }) => this._onObjectReject(reason));

		if (isGuest) uploadPendingGuestAvatar((publicUrl) => this.net?.setAvatar(publicUrl));
		this.net.on('status', ({ status }) => {
			this.ui.setStatus(status);
			this._updateOnline();
			// Reconnect exhausted: the player is now alone in a local-only world.
			// The small status pill alone is easy to miss, so explain the drop once —
			// other players, chat and shared building are off, and how to recover.
			if (status === 'failed' && !this._failedNotified) {
				this._failedNotified = true;
				this.ui.toast('Lost the connection to the world — chat and shared builds are paused. Tap the status pill to reconnect.', 'warn');
			}
			if (status === 'online') this._failedNotified = false;
			// Every (re)connect re-streams the server's authoritative build, so wipe
			// the local layer first. On a manual retry out of single-player this also
			// hands authority back: the solo build gives way to the shared world's.
			if (status === 'connecting') { this.voxels?.clear(); this._undoStack = []; this._syncBudget(); this._resetBuildPerms(); }
			// Building is available with a live server (synced + persisted for
			// everyone) and in solo single-player mode (local-only) once multiplayer
			// has been given up. The connecting window is the only time it's off, so
			// the toggle never becomes a dead, silent button.
			this.buildHud.setEnabled(this._buildableConnection(), 'Connecting to the world…');
			// Durability badge: online reflects the server's persistent flag; solo
			// single-player isn't saved at all, so hide it (null) to avoid a false
			// promise. Re-sync the budget meter against whatever layer is now live.
			this.buildHud.setPersistent(status === 'online' ? this.net?.persistent : (status === 'offline' || status === 'unavailable' ? false : null));
			this._syncBudget();
			// A reconnect reissues every sessionId, stranding the voice mesh — refresh
			// our id, drop the stale peers, and re-announce so it re-forms.
			if (status === 'online' && this.voice?.joined && this.net.sessionId !== this.voice.selfId) {
				this.voice.setSelfId(this.net.sessionId);
				this.voice.resetPeers();
				this.net.setVoiceActive(true);
			}
		});
		// A holder pass can expire (10 min) between minting and a mid-session
		// reconnect; if the server then refuses the join, drop the player back to
		// the lobby with a clear reason rather than looping on a dead pass.
		this.net.on('denied', (reason) => {
			// The platform token gate evicted us (pass expired, or the wallet dropped
			// below the floor): force a fresh sign-in before they can play again — the
			// cached pass is now void, so clear it so the gate re-checks the chain.
			if (/play_pass/i.test(reason || '')) {
				clearStoredPass();
				this.playPass = '';
				this.account = '';
				this.ui.toast('Your session expired — sign in again to keep playing.', 'warn');
				this.leave();
				this._playReady = this._ensurePlayAccess();
				return;
			}
			this.ui.toast('Your holder pass expired — re-enter to verify your holdings.', 'warn');
			this.leave();
		});
		this.net.on('add', (p, id) => this._onAdd(p, id));
		this.net.on('change', (p, id) => this._onChange(p, id));
		this.net.on('remove', (id) => this._onRemove(id));
		this.net.on('chat', (m) => this._onChat(m));
		this.net.on('reaction', (m) => this._onReaction(m));
		this.net.on('tag', (msg) => this._onTagMessage(msg)); // R08 tag mini-game
		this.net.on('king', (msg) => this._onKing(msg)); // R07 King of the Totem
		this.net.on('ping', (ms) => this.ui.setPing(ms));
		// W02 vehicles: the parked fleet + any driver changes are synced world
		// entities (add/change/remove mirror the player callbacks above); `vehicle`
		// is the server's targeted enter/exit/deny ack for our own request.
		this.net.on('vehicleAdd', (v, id) => this.vehicles?.addVehicle(v, id));
		this.net.on('vehicleChange', (v, id) => this.vehicles?.changeVehicle(v, id));
		this.net.on('vehicleRemove', (id) => this.vehicles?.removeVehicle(id));
		this.net.on('vehicle', (msg) => this.vehicles?.onAck(msg));
		this.net.on('blockAdd', (key, t) => { const [x, y, z] = parseKey(key); this.voxels?.setBlock(x, y, z, t); this._syncBudget(); });
		this.net.on('blockChange', (key, t) => { const [x, y, z] = parseKey(key); this.voxels?.setBlock(x, y, z, t); });
		this.net.on('blockRemove', (key) => { const [x, y, z] = parseKey(key); this.voxels?.removeBlock(x, y, z); this._syncBudget(); });
		this.net.on('editReject', ({ reason }) => this._onEditReject(reason));
		// Build permissions: the per-player cap/usage + creator flag drive the HUD's
		// allowance meter and reveal the creator-only clear-area control. build-cleared
		// confirms a creator sweep landed.
		this.net.on('buildPerms', (p) => this._onBuildPerms(p));
		this.net.on('buildCleared', ({ count, all }) => {
			this.ui.toast(all ? `Cleared the whole world (${count|0} blocks).` : `Cleared ${count|0} block${(count|0) === 1 ? '' : 's'} nearby.`, 'info');
		});
		// Durability flag for this world's build — drives the HUD "Saved" badge.
		this.net.on('persistent', (durable) => { if (this.net?.status === 'online') this.buildHud.setPersistent(durable); });
		this.net.on('floorBeat', (msg) => this._onFloorBeat(msg));

		// Game systems (economy + activities). The server streams this player's own
		// pack/purse/skills here; PlaySystems renders the HUD, ponds, and cast visual,
		// and re-anchors fishing to fixed world features. Built per-world, torn down on
		// leave() so coins never share a pond or an inventory panel.
		this.playSystems = new PlaySystems({
			scene: this.scene,
			getPlayer: () => ({ x: this.localPos.x, y: this.localPos.y, z: this.localPos.z, yaw: this.localYaw, height: this.localHeight || 1.6 }),
			net: this.net,
			ui: this.ui,
			env: this.env,
		});
		// W06: gather/craft stations (trees, rocks, roast pits) and the fishing-rod
		// pickups scattered around the world. Sibling of PlaySystems — see
		// play-activities.js's header for why they stay decoupled.
		this.playActivities = new PlayActivities({
			scene: this.scene,
			getPlayer: () => ({ x: this.localPos.x, y: this.localPos.y, z: this.localPos.z, yaw: this.localYaw, height: this.localHeight || 1.6 }),
			net: this.net,
			ui: this.ui,
		});
		// W09: Fortune's Folly, the Mainland Wheel of Fortune. Another sibling —
		// its own landmark, its own prompt, lazy-loads the actual spin UI (and the
		// @solana/web3.js it drags in for the paid path) only on first interact.
		this.wheelStation = new WheelStation({
			scene: this.scene,
			getPlayer: () => ({ x: this.localPos.x, y: this.localPos.y, z: this.localPos.z }),
			net: this.net,
		});
		this.net.on('profile', (snap) => { this.playSystems?.setProfile(snap); this._onCosmeticsProfile(snap); });
		this.net.on('inv', (delta) => this.playSystems?.applyInv(delta));
		this.net.on('xpgain', (g) => this.playSystems?.onXpGain(g));
		this.net.on('levelup', (l) => this.playSystems?.onLevelup(l));
		this.net.on('notice', (n) => this.playSystems?.onNotice(n));
		// Friends (W09): live DMs + request/accept pushed by the social hub over this
		// world's socket. The FriendsClient owns all social state — it updates its
		// threads/unread counts and notifies the panel, open or not, so a DM that
		// arrives while the panel is closed still lights the badge.
		this.net.on('social', (m) => {
			friendsClient().handleSocial(m);
			if (m?.type === 'dm') this._bumpFriendsBadge();
		});
		this._initFriends();
		// Job completion has no generic 'notice' twin (WalkRoom sends only
		// 'questComplete') — toast it globally so a payout lands even when the
		// Jobs Board panel isn't open, the same way every other reward does.
		this.net.on('questComplete', (c) => {
			if (!c) return;
			const gold = c.reward?.gold ?? 0;
			const crew = c.coop && c.crew > 1 ? ` (crew of ${c.crew})` : '';
			this.ui?.toast?.(`${c.title} complete${crew} — +${gold} cash`, 'success');
		});

		this.buildHud.root.hidden = false;
		await this.net.connect();
		// Player backed out mid-connect: leave() already tore everything down and
		// nulled this.net. Bail rather than dereference it / re-enter 'world'.
		if (epoch !== this._enterEpoch || !this.net) return;
		this._initVoice();
		this.phase = 'world';
		this._initJoystick();
		this._onboardBuild();
		// W02: drivable vehicles — the parked fleet the server seeds every world
		// with (multiplayer/src/vehicles.js VEHICLE_SPAWNS, mirrored from this
		// district's own avenue bays in world-zones.js). Constructed after the
		// physics boot above has resolved, so it can borrow this._physics straight
		// away instead of waiting on it itself. Torn down in leave().
		this.vehicles = new VehicleManager({ host: this });
		// W07: roaming PvE mobs, lootable tombstones, the danger-zone ground, and
		// the GTA-style vitals HUD (health/armor/wanted). Built after the connect
		// above so its net.on(...) subscriptions catch the join-time 'profile'
		// re-send below. Torn down in leave().
		// Defensive boundary: W07 is still under active concurrent development in
		// this shared worktree (CLAUDE.md "known traps") — a bug in it must never
		// take down the rest of world entry (NPCs, vehicles, economy) for every
		// player. Fails closed to no combat HUD/mobs rather than an unusable world.
		try {
			this.combat = new CombatSystem({
				scene: this.scene,
				camera: this.camera,
				renderer: this.renderer,
				getPlayer: () => ({ x: this.localPos.x, y: this.localPos.y, z: this.localPos.z, yaw: this.localYaw, height: this.localHeight || 1.6 }),
				net: this.net,
				ui: this.ui,
			});
		} catch (e) {
			log.error('[coincommunities] CombatSystem failed to init — continuing without it:', e?.message);
			this.combat = null;
		}
		// playSystems already cached a 'profile' snapshot before combat subscribed;
		// re-request so the vitals HUD isn't blank until the next server-side change.
		this.net.requestProfile();
		// The legacy gold purse HUD folds into WorldHud's unified money readout.
		this.playSystems?.setGoldVisible(false);
		// Every town hosts the live Agent Exchange: two NPC agents who pay each
		// other on-chain via x402. Torn down in leave().
		this.agentCommerce = new AgentCommerce({
			scene: this.scene,
			camera: this.camera,
			renderer: this.renderer,
			getPlayer: () => this.localPos,
			ui: this.ui,
		});
		// …and the Intel Kiosk: the player pays a real x402 endpoint ($0.01 USDC)
		// from their own wallet for live market intel on the town's own coin —
		// the flagship $THREE oracle at home, the generic token oracle elsewhere.
		this.intelKiosk = new IntelKiosk({
			scene: this.scene,
			camera: this.camera,
			renderer: this.renderer,
			getPlayer: () => this.localPos,
			ui: this.ui,
			coin,
		});
		// Agent desks — visible in every world. Seats the platform's most recently
		// ACTIVE public agents (the same ranking as the /agents-live wall) at
		// working desks with live CanvasTexture monitors streaming their real
		// activity. Players can walk up and press E (or tap) to open the full 2D
		// watch view. Must be the public directory, not /api/agents: that route
		// lists the CALLER'S OWN agents and 401s for the anonymous players who make
		// up most of /play, which silently left every world deskless.
		this._agentDesks = [];
		fetch(`/api/agents/public?sort=live&limit=3`)
			.then((r) => r.ok ? r.json() : null)
			.then((d) => {
				const agents = d?.agents || d?.data || [];
				agents.slice(0, 3).forEach((a, i) => {
					const offsets = [[-14, 0, -10], [14, 0, -10], [0, 0, -14]];
					const rotations = [Math.PI * 0.15, -Math.PI * 0.15, Math.PI];
					const desk = createAgentDesk(this.scene, {
						agentId: a.id,
						agentName: a.name || 'Agent',
					}, {
						position: offsets[i],
						rotationY: rotations[i],
					});
					this._agentDesks.push(desk);
				});
			})
			.catch(() => { /* non-critical — world works without desks */ });

		// Living world (W08): ambient pedestrians + traffic, interactive vendor /
		// quest / flavor NPCs, and (gated behind W07) hostile mobs — all on a
		// deterministic nav graph so every client sees the same crowd without
		// syncing it. Built for every world, same as the Agent Exchange and the
		// Intel Kiosk above. Torn down in leave(). name/symbol ride along so the
		// NPC chat can speak about the town it's actually standing in.
		this.worldLife = new WorldLife({
			scene: this.scene,
			camera: this.camera,
			renderer: this.renderer,
			getPlayer: () => this.localPos,
			ui: this.ui,
			net: this.net,
			world: {
				mint: coin.mint,
				name: coin.name,
				symbol: coin.symbol,
				seed: seedFromString(coin.mint) >>> 0,
				biome: this.env?.biome,
				// Boutique NPCs (W03) call these to open the real cosmetics shop /
				// wardrobe panels — same panels the HUD buttons drive.
				openShop: () => this._toggleShop(),
				openWardrobe: () => this._toggleWardrobe(),
				// Quest-giver NPCs (W08 hooking W05) call this to open the real Jobs
				// Board, optionally scrolled straight to the mission that giver offers.
				openQuests: (highlight) => this._toggleQuests(highlight),
			},
			radius: WORLD_RADIUS - 4,
		});
		// Start the silent pass-refresh cycle. The play pass has a 10-min server
		// TTL; the server sweeps expired passes every minute. We refresh 2 min early
		// so a player in a long session is never evicted mid-build. The refresh
		// re-reads the chain (via /api/play/verify) so a wallet that offloaded its
		// tokens is refused rather than silently let through on a stale pass.
		this._schedulePassRefresh();

		// First-join onboarding: overlay + economy clarity strip + controls help.
		// Created per-world so the economy copy is always specific to this coin.
		// Torn down in leave() along with all other per-world objects.
		if (this._onboard) { this._onboard.dispose(); }
		this._onboard = new PlayOnboard({ coin });
	}

	// First-run nudge so players discover building exists — the HUD's ⛏ toggle is
	// easy to miss. Shown once ever, a few seconds after the world settles so it
	// doesn't collide with the entry toast.
	_onboardBuild() {
		try { if (localStorage.getItem('cc-build-onboarded')) return; } catch { return; }
		clearTimeout(this._onboardTimer);
		this._onboardTimer = setTimeout(() => {
			if (this.phase !== 'world') return;
			const touch = typeof matchMedia === 'function' && matchMedia('(hover: none), (pointer: coarse)').matches;
			this.ui.toast(touch ? 'Tip: tap ⛏ to build this world together.' : 'Tip: press B (or tap ⛏) to build this world together.', 'info');
			try { localStorage.setItem('cc-build-onboarded', '1'); } catch {}
		}, 4200);
	}

	// Silent mid-session pass refresh. Runs once the player is in a world; wakes
	// up 2 min before the pass expires and renews it off the still-valid pass — no
	// wallet prompt, since possession of an unexpired pass already proves the wallet.
	// Updates this.playPass so the next reconnect uses the fresh token, and re-checks
	// the chain, so a wallet that offloaded its tokens gets evicted here rather than
	// on the next reconnect. Cancels automatically when leave() tears the net down.
	_schedulePassRefresh() {
		clearTimeout(this._passRefreshTimer);
		if (!this.playPass || !this.account) return; // gate was off when we entered
		const cached = loadStoredPass();
		if (!cached?.expiresAt) return;
		const msLeft = new Date(cached.expiresAt).getTime() - Date.now();
		const delay = Math.max(0, msLeft - 2 * 60 * 1000); // 2 min before expiry
		this._passRefreshTimer = setTimeout(() => this._doPassRefresh(), delay);
	}

	async _doPassRefresh() {
		if (this.phase !== 'world' || !this.account || !this.playPass) return;
		try {
			// Silent renewal: the current pass is still valid (we fire 2 min early), so
			// the server re-issues off it after re-reading the chain — no wallet prompt.
			const res = await refreshPlayPass(this.playPass);
			if (res.ok && res.playPass) {
				this.playPass = res.playPass;
				storePass(res);
				this.net?.updatePlayPass?.(res.playPass);
				this._schedulePassRefresh();
			} else {
				// Below the floor mid-session: clear state and surface the gate.
				clearStoredPass();
				this.playPass = '';
				this.ui.toast('Your token balance dropped — sign in again to keep playing.', 'warn');
				this.leave();
				this._playReady = this._ensurePlayAccess();
			}
		} catch (err) {
			// The pass expired or was rejected (we missed the window): a silent renew is
			// impossible now, so a fresh signed sign-in is the only way back. Surface the
			// gate once rather than retrying a renewal that can never succeed.
			if (err?.code === 'pass_invalid') {
				clearStoredPass();
				this.playPass = '';
				this.ui.toast('Your session expired — sign in again to keep playing.', 'warn');
				this.leave();
				this._playReady = this._ensurePlayAccess();
				return;
			}
			// Network hiccup — try again in 30 s rather than breaking the session.
			clearTimeout(this._passRefreshTimer);
			this._passRefreshTimer = setTimeout(() => this._doPassRefresh(), 30_000);
		}
	}

	// Wallet-first platform gate. Shows the sign-in screen (connect → sign nonce →
	// verify token balance) when the server requires it, and caches the verified
	// wallet + signed pass we attach to every room join. Self-healing: any failure
	// resolves to "open" rather than bricking /play, since the server is the real
	// authority — an unsigned join is refused there regardless.
	async _ensurePlayAccess() {
		try {
			const access = await ensurePlayAccess();
			if (access?.required) {
				this.playPass = access.playPass || '';
				this.account = access.wallet || '';
			}
			return access;
		} catch (err) {
			log.warn('[coincommunities] play gate error:', err?.message);
			return { required: false };
		}
	}

	// Run the holder gate for a coin's Holders world. Drives the overlay through
	// its states and resolves to the verified pass data ({ holderPass, minUsd, … })
	// once the player clears the floor, or null if they back out. All the on-chain
	// truth is computed server-side (api/community/holder-pass); here we only
	// orchestrate the sign-in / wallet-link / buy steps a player may need first.
	async _passHolderGate(coin) {
		const symbol = coin.symbol || '';
		this.ui.openHolderGate(coin);
		let skipCheck = false;     // set after 'buy' so we re-show the shortfall, not recheck
		let carryError = '';       // surfaces a failed sign-in/link on the next state
		let state = 'checking';
		let data = { symbol };
		try {
			for (;;) {
				if (!skipCheck) {
					this.ui.setHolderGate('checking', { symbol });
					try {
						const res = await requestHolderPass(coin.mint);
						if (res?.eligible && res.holderPass) {
							this.ui.setHolderGate('granted', { symbol, usd: res.usd, amount: res.amount, minUsd: res.minUsd, minTokens: res.minTokens });
							// Let the "verified" state land for a beat before the world builds.
							await new Promise((r) => setTimeout(r, 650));
							this.ui.closeHolderGate();
							return res;
						}
						state = 'short';
						data = { symbol, usd: res?.usd ?? 0, amount: res?.amount ?? 0, minUsd: res?.minUsd ?? 8, minTokens: res?.minTokens ?? 0 };
					} catch (err) {
						if (err?.code === 'auth_required') { state = 'auth'; data = { symbol, error: carryError }; }
						else if (err?.code === 'wallet_required') { state = 'wallet'; data = { symbol, error: carryError }; }
						else { state = 'error'; data = { symbol, error: err?.message || 'Could not verify your holdings.' }; }
						carryError = '';
					}
				}
				skipCheck = false;

				const action = await this._holderGateWait(state, data);
				if (action === 'cancel') return null;
				if (action === 'signin') {
					this.ui.setHolderGate('working', { symbol, msg: 'Opening X sign-in…' });
					try { await signInWithX(); } catch (e) { carryError = e?.message || 'Sign-in was cancelled.'; }
					continue;
				}
				if (action === 'wallet') {
					this.ui.setHolderGate('working', { symbol, msg: 'Connecting your wallet…' });
					try {
						const session = await getSession();
						await ensureSolanaWallet(session);
					} catch (e) { carryError = e?.message || 'Could not link a wallet.'; }
					continue;
				}
				if (action === 'switch') {
					// Drop the linked wallet and connect a different one, then re-check —
					// the way out of a short balance when the coin lives in another wallet.
					this.ui.setHolderGate('working', { symbol, msg: 'Switching wallet…' });
					try {
						await relinkSolanaWallet();
					} catch (e) { carryError = e?.message || 'Could not switch wallet.'; }
					continue;
				}
				if (action === 'buy') { this._openBuy(coin); skipCheck = true; continue; }
				// 'recheck' (or any other) → loop and re-run the on-chain check.
			}
		} finally {
			// Guarantee the overlay never lingers if we bailed via return.
			if (this.phase === 'lobby') this.ui.closeHolderGate();
		}
	}

	// Park the gate on a state and resolve when the player picks an action. The UI
	// buttons fire onHolderAction → resolves this promise.
	_holderGateWait(state, data) {
		this.ui.setHolderGate(state, data);
		return new Promise((resolve) => { this._holderGateResolve = resolve; });
	}

	// Stand up spatial voice for this community. Voice starts OFF (no mic access
	// until the player opts in); the mic button drives join/mute through here.
	_initVoice() {
		if (this.voice) { this.voice.dispose(); this.voice = null; }
		if (!voiceSupported()) { this.ui.setVoiceState('unsupported'); return; }
		this.voice = new VoiceChat({
			selfId: this.net.sessionId,
			sendSignal: (to, data) => this.net?.sendVoiceSignal(to, data),
			onStateChange: (s) => {
				this.ui.setVoiceState(s);
				this.net?.setVoiceActive(s === 'on' || s === 'muted');
			},
			onPeerSpeaking: (id, sp) => this.remotes.get(id)?.setSpeaking(sp),
			onLocalSpeaking: (sp) => this.ui.setMicSpeaking(sp),
		});
		// Relay signals from peers into the voice engine.
		this.net.on('voiceSignal', (msg) => this.voice?.onSignal(msg));
		this.ui.setVoiceState('off');
	}

	// Mic button: first tap joins voice (asks for the mic); later taps mute/unmute.
	async _toggleVoice() {
		if (!this.voice) return;
		if (this.voice.state === 'off') {
			this.ui.setVoiceState('connecting');
			try {
				await this.voice.join();
			} catch (err) {
				log.warn('[coincommunities] voice join failed:', err?.name, err?.message);
				this.ui.setVoiceState(err?.name === 'NotAllowedError' ? 'denied' : 'error');
			}
		} else {
			this.voice.toggleMute();
		}
	}

	leave() {
		// Invalidate any in-flight enter() so a connect/avatar continuation that
		// resolves after this teardown bails instead of rebuilding the world.
		this._enterEpoch = (this._enterEpoch || 0) + 1;
		// Tear voice down before the socket so our final "left voice" flag still
		// sends, and peers' connections close cleanly.
		clearTimeout(this._passRefreshTimer);
		this._passRefreshTimer = null;
		if (this.voice) { this.voice.dispose(); this.voice = null; }
		if (this.net) { this.net.destroy(); this.net = null; }
		if (this.vehicles) { this.vehicles.dispose(); this.vehicles = null; }
		if (this.combat) { this.combat.dispose(); this.combat = null; }
		if (this.playSystems) { this.playSystems.dispose(); this.playSystems = null; }
		if (this.playActivities) { this.playActivities.dispose(); this.playActivities = null; }
		if (this.wheelStation) { this.wheelStation.dispose(); this.wheelStation = null; }
		this._disposeFriends();
		if (this.agentCommerce) { this.agentCommerce.dispose(); this.agentCommerce = null; }
		if (this.intelKiosk) { this.intelKiosk.dispose(); this.intelKiosk = null; }
		if (this.worldLife) { this.worldLife.dispose(); this.worldLife = null; }
		if (this._onboard) { this._onboard.dispose(); this._onboard = null; }
		// Close the shop + wardrobe and drop the rig binding — the next world rebuilds both.
		if (this._shop?.isOpen()) this._shop.close();
		if (this._wardrobe?.isOpen()) this._wardrobe.close();
		this._accessoryMgr = null;
		this._previewPresetId = null; this._previewLayers = false; this._previewItem = null;
		for (const [, r] of this.remotes) r.dispose();
		this.remotes.clear();
		closeAvatarInspector(); // whoever it showed just left the world with us
		if (this._totem) { this.world.remove(this._totem); this._totem = null; this._coinSpin = null; }
		if (this._screen) {
			this.world.remove(this._screen);
			this._screenTex?.dispose();
			this._screen = null; this._screenCanvas = null; this._screenTex = null;
			this._screenArt = null; this._screenPulse = null;
		}
		if (this._chartScreen) { this._chartScreen.dispose(); this._chartScreen = null; }
		if (this._oracleRibbon) { this._oracleRibbon.dispose(); this._oracleRibbon = null; }
		if (this._agentDesks?.length) {
			for (const desk of this._agentDesks) desk.dispose();
			this._agentDesks = [];
		}
		if (this._danceFloor) { this.world.remove(this._danceFloor); this._danceFloor = null; }
		this._floorLights = null; this._floorTiles = null; this._floorCenterMat = null;
		this._danceFloorPos = null; this._onFloor = false; this._wantsDance = false;
		this.ui.setOnFloor(false);
		if (this._reactor) { this._reactor.dispose(); this._reactor = null; }
		if (this.voxels) { this.voxels.dispose(); this.voxels = null; }
		if (this.worldObjects) { this.worldObjects.dispose(); this.worldObjects = null; }
		if (this.propGhost) { this.propGhost.dispose(); this.propGhost = null; }
		this._cancelLongPress();
		clearTimeout(this._onboardTimer);
		this._undoStack = []; // history is per-world; don't carry edits across coins
		this.buildHud.setActive(false);
		this.buildHud.setEnabled(false);
		this.buildHud.setPersistent(null);
		this._resetBuildPerms();
		this.buildHud.root.hidden = true;
		// Reset the structures toolbar back to single-block and close any open
		// share / featured surfaces — they're scoped to the world we're leaving.
		this.buildPiece = null; this.buildRot = 0;
		this.buildProp = null; this.buildPropRot = 0; this.buildPropScale = 1;
		this.ui.setBuildPiece(null);
		this.ui.setPropSelected(null);
		this.ui.setBuildToolsVisible(false);
		this.ui.setPropPaletteVisible(false);
		this.propGhost?.hide();
		this.ui.closeShareSheet();
		this.ui.closeFeatured();
		try { this.localCosmetics?.dispose(); } catch {}
		this.localCosmetics = null; this._localCosWire = null;
		// Tag mini-game (R08): remove local glow ring + label on world exit.
		this._removeLocalGlowRing();
		this._removeLocalItLabel();
		this._localIsIt = false;
		// King of the Totem (R07): tear down the zone + crown marker and hide the HUD.
		this._disposeKingZone();
		this.ui.hideKingHud();
		if (this.localRig) { this.scene.remove(this.localRig); this.localRig = null; }
		if (this._nipple) { this._nipple.destroy(); this._nipple = null; }
		this.phase = 'lobby';
		try { history.replaceState(null, '', location.pathname); } catch { /* non-fatal */ }
		this.ui.showLobby();
	}

	_updateOnline() {
		const n = (this.remotes.size + (this.net?.status === 'online' ? 1 : 0)) || 1;
		this._online = n;
		this.ui.setOnline(n);
		this._drawScreen(); // keep the jumbotron's LIVE count in sync
	}

	// ------------------------------------------------------------- avatar inspector
	// I (or clicking a nameplate / avatar) opens the shared inspector on whoever
	// you're looking at: identity, reputation, wallet — the same server truth every
	// other surface reads. See src/shared/avatar-inspector.js.
	_worldFacts() {
		const coin = this.coin || {};
		return coin.name || coin.symbol
			? [{ label: 'World', value: coin.symbol ? `$${coin.symbol}` : coin.name, href: coin.mint ? `/play?coin=${encodeURIComponent(coin.mint)}` : undefined }]
			: [];
	}
	_inspectRemote(id, trigger) {
		const rp = this.remotes.get(id);
		if (!rp) return;
		openAvatarInspector({
			kind: 'peer',
			name: rp.name,
			world: 'play',
			agentId: rp.agent,
			wallet: rp.account,
			avatarUrl: rp._avatarUrl,
			facts: [
				...this._worldFacts(),
				...(rp.voice ? [{ label: 'Voice', value: 'in voice chat' }] : []),
			],
		}, { trigger: trigger || this.canvas });
	}
	_inspectNpc(npc) {
		openAvatarInspector({
			kind: 'npc',
			name: npc.name,
			world: 'play',
			facts: [
				{ label: 'Role', value: npc.role === 'vendor' ? 'Vendor — real paid service' : npc.role === 'quest' ? 'Quest giver' : 'Townsperson' },
				...(npc.def?.prompt ? [{ label: 'Offers', value: npc.def.prompt }] : []),
				{ label: 'Talk', value: 'walk up and press E' },
				...this._worldFacts(),
			],
		}, { trigger: this.canvas });
	}
	_inspectSelf() {
		openAvatarInspector({
			kind: 'self',
			name: this.net?.name || lsGet('cc-name') || 'You',
			world: 'play',
			wallet: this.account || '',
			avatarUrl: this.net?.avatar,
			facts: this._worldFacts(),
		}, { trigger: this.canvas });
	}
	// Nearest inspectable within reach: real players first beat scenery — an NPC
	// only wins when it is strictly closer. Falls back to yourself so the key
	// always answers.
	_inspectNearest() {
		if (isAvatarInspectorOpen()) { closeAvatarInspector(); return; }
		const MAX_M = 10;
		let best = null; // { d, open }
		for (const [id, rp] of this.remotes) {
			const d = Math.hypot(rp.rig.position.x - this.localPos.x, rp.rig.position.z - this.localPos.z);
			if (d <= MAX_M && (!best || d < best.d)) best = { d, open: () => this._inspectRemote(id) };
		}
		for (const npc of this.worldLife?.npcs || []) {
			const d = npc.distanceTo(this.localPos);
			if (d <= MAX_M && (!best || d < best.d)) best = { d, open: () => this._inspectNpc(npc) };
		}
		if (best) best.open();
		else this._inspectSelf();
	}
	// Raycast pick for taps directly on a peer's 3D body (labels are the fast
	// path; this catches clicks on the avatar itself). Click-only — never run
	// per-frame, skinned-mesh raycasts are too heavy for hover.
	_remoteAt(clientX, clientY) {
		if (!this.remotes.size) return null;
		const ray = this._pointerRay(clientX, clientY);
		let best = null;
		for (const [id, rp] of this.remotes) {
			const hits = ray.intersectObject(rp.rig, true);
			if (hits.length && (!best || hits[0].distance < best.d)) best = { d: hits[0].distance, id };
		}
		return best?.id || null;
	}

	// ---------------------------------------------------------------- net events
	_onAdd(player, id) {
		if (id === this.net.sessionId) return; // that's us
		const rp = new RemotePlayer(this.scene, player);
		rp.onInspect = () => this._inspectRemote(id, rp.label);
		this.remotes.set(id, rp);
		this._updateOnline();
	}
	_onChange(player, id) {
		if (id === this.net.sessionId) {
			// Tag mini-game (R08): the local player isn't a RemotePlayer, so drive
			// our own glow ring + head label off our authoritative schema "it" flag.
			this._updateLocalItMarker(player.it);
			return;
		}
		this.remotes.get(id)?.apply(player);
	}
	_onRemove(id) {
		const r = this.remotes.get(id);
		if (r) { r.dispose(); this.remotes.delete(id); this._updateOnline(); }
		this.voice?.removePeer(id);
	}
	_onChat(m) {
		const mine = m.id === this.net.sessionId;
		this.ui.addChat({ name: m.name, text: m.text, mine });
		if (mine) this._sayLocal(m.text);
		else { this.remotes.get(m.id)?.say(m.text); this._bumpTabUnread(); }
	}
	_sendChat(text) { this.net?.sendChat(text); }
	_emote(name) { this.net?.sendEmote(name); playEmoteClip(this.localAnim, name, this.motion); }

	// ── Tag mini-game (R08) ─────────────────────────────────────────────────────

	_onTagMessage(msg) {
		if (!msg || !msg.event) return;
		if (msg.event === 'became-it') {
			this.ui.showYoureIt();
		} else if (msg.event === 'state') {
			const localId = this.net?.sessionId;
			this.ui.setTagState({ itId: msg.itId, leaderboard: msg.leaderboard || [], localId });
		}
	}
	_updateLocalItMarker(isIt) {
		if (!!isIt === !!this._localIsIt) return;
		this._localIsIt = !!isIt;
		if (this._localIsIt) { this._addLocalGlowRing(); this._addLocalItLabel(); }
		else { this._removeLocalGlowRing(); this._removeLocalItLabel(); }
	}
	_addLocalGlowRing() {
		if (this._localGlowRing || !this.localRig) return;
		const geo = new RingGeometry(0.5, 0.75, 32);
		const mat = new MeshBasicMaterial({ color: 0xff2222, transparent: true, opacity: 0.72, depthWrite: false });
		this._localGlowRing = new Mesh(geo, mat);
		this._localGlowRing.rotation.x = -Math.PI / 2;
		this._localGlowRing.position.y = 0.02;
		this.localRig.add(this._localGlowRing);
	}
	_removeLocalGlowRing() {
		if (!this._localGlowRing) return;
		this.localRig?.remove(this._localGlowRing);
		this._localGlowRing.geometry.dispose();
		this._localGlowRing.material.dispose();
		this._localGlowRing = null;
	}
	_addLocalItLabel() {
		if (this._localItLabel) return;
		this._localItLabel = document.createElement('div');
		this._localItLabel.className = 'cc-it-marker cc-it-marker--local';
		this._localItLabel.textContent = "🏃 YOU'RE IT!";
		document.body.appendChild(this._localItLabel);
	}
	_removeLocalItLabel() {
		if (!this._localItLabel) return;
		this._localItLabel.remove();
		this._localItLabel = null;
	}

	// ── Reactions (R04) ──────────────────────────────────────────────────────
	// The server broadcasts a validated 'reaction' to all clients in the room,
	// including the sender, so every client runs this once per event.
	_onReaction({ id, emoji }) {
		let pos, height;
		if (id === this.net?.sessionId) {
			pos = this.localPos;
			height = this.localHeight || 1.7;
		} else {
			const r = this.remotes.get(id);
			if (!r) return;
			pos = r.rig.position;
			height = r.height;
		}
		this._spawnReactionSprite(pos, height, emoji);
		if (emoji === '🎉') this._spawnConfetti(pos, height);
	}

	_spawnReactionSprite(pos, height, emoji) {
		if (!this.camera || !this.renderer) return;
		const w = this.renderer.domElement.clientWidth;
		const h = this.renderer.domElement.clientHeight;
		const v = new Vector3(pos.x, pos.y + height + 0.55, pos.z).project(this.camera);
		if (v.z > 1 || v.z < -1) return; // avatar behind camera
		const sx = (v.x * 0.5 + 0.5) * w;
		const sy = (-v.y * 0.5 + 0.5) * h;
		const sprite = document.createElement('div');
		sprite.className = 'cc-reaction-sprite';
		sprite.textContent = emoji;
		sprite.style.left = sx + 'px';
		sprite.style.top = sy + 'px';
		document.body.appendChild(sprite);
		const remove = () => sprite.isConnected && sprite.remove();
		sprite.addEventListener('animationend', remove, { once: true });
		setTimeout(remove, 1400);
	}

	_spawnConfetti(pos, height) {
		if (!this.camera || !this.renderer) return;
		const w = this.renderer.domElement.clientWidth;
		const h = this.renderer.domElement.clientHeight;
		const v = new Vector3(pos.x, pos.y + height + 0.55, pos.z).project(this.camera);
		if (v.z > 1 || v.z < -1) return;
		const sx = (v.x * 0.5 + 0.5) * w;
		const sy = (-v.y * 0.5 + 0.5) * h;
		const COLORS = CONFETTI_COLORS;
		for (let i = 0; i < 18; i++) {
			const p = document.createElement('div');
			p.className = 'cc-confetti';
			const angle = (Math.PI * 2 * i) / 18 - Math.PI / 2;
			const spread = 38 + Math.random() * 44;
			const tx = Math.cos(angle) * spread;
			const ty = Math.sin(angle) * spread - 30; // bias upward
			const dur = 0.7 + Math.random() * 0.5;
			p.style.cssText = `left:${sx}px;top:${sy}px;background:${COLORS[i % COLORS.length]};` +
				`--tx:${tx.toFixed(1)}px;--ty:${ty.toFixed(1)}px;--dur:${dur.toFixed(2)}s;`;
			document.body.appendChild(p);
			const remove = () => p.isConnected && p.remove();
			p.addEventListener('animationend', remove, { once: true });
			setTimeout(remove, (dur + 0.1) * 1000);
		}
	}

	// ── Cosmetics live preview (R21) ──────────────────────────────────────────
	// The shop previews a catalog item on YOUR OWN avatar before any purchase.
	// This is the local R03 rig hook: bone-attach GLBs, drive outfit morphs,
	// recolour garment layers, or play premium emote clips — never broadcast,
	// never persisted (a purchase is R22/R23). Selecting reverts the previous
	// preview first, so only one item previews at a time.

	// Bind an AccessoryManager to the live local skeleton. localRig holds the
	// avatar model + its bones, which is all the rig needs; invalidate is a no-op
	// because /play renders every frame (no on-demand invalidation loop).
	_ensureAccessoryMgr() {
		if (!this.localRig) return null;
		if (!this._accessoryMgr) {
			this._accessoryMgr = new AccessoryManager({ content: this.localRig, invalidate: () => {} });
		}
		return this._accessoryMgr;
	}

	// Preview a catalog item live. Returns true if something visible happened.
	async equipCosmeticPreview(item) {
		if (!item) return false;
		this.unequipCosmeticPreview();
		this._previewItem = item;
		// Emotes preview as a one-shot clip that naturally returns to locomotion.
		if (item.kind === 'emote' && item.emote) {
			playEmoteClip(this.localAnim, item.emote, this.motion);
			return true;
		}
		const mgr = this._ensureAccessoryMgr();
		if (!mgr) return false;
		// Skins recolour the avatar's own garment layers (absolute state).
		if (item.kind === 'skin' && item.colors) {
			mgr.applyLayers({ colors: item.colors, hidden: [] });
			this._previewLayers = true;
			return true;
		}
		// Hats / glasses / earrings (GLB) and outfits (morph) go through presets.
		if (item.glbUrl || item.morphBinding) {
			await mgr.applyPreset({
				id: item.id, kind: item.kind, name: item.name,
				glbUrl: item.glbUrl, attachBone: item.attachBone, morphBinding: item.morphBinding,
			});
			this._previewPresetId = item.id;
			return true;
		}
		return false;
	}

	// Open/close the cosmetics shop (R21 browse/preview + R22 buy). Lazy-built;
	// previews route to the local rig hooks above, and a settled purchase records
	// ownership server-side. Reverts any preview when it closes.
	_toggleShop() {
		if (!this._shop) {
			this._shop = new CosmeticsShop({
				// Key ownership + purchases on the verified wallet when we have one;
				// the shop falls back to the persisted guest id otherwise.
				account: this.account || '',
				// The coin world we're in (R25): ties a cosmetic sale to this coin so a
				// configurable share of the settled USDC pays out to the coin's creator.
				coinMint: this.coin?.mint || '',
				onPreview: (item) => this.equipCosmeticPreview(item),
				onEndPreview: () => this.unequipCosmeticPreview(),
				// A premium item was just bought (R22) — permanently equip it so the
				// buyer immediately sees their new look AND it persists across worlds
				// (R23 durable equip: server validates, writes to account, echoes a
				// fresh profile which re-renders the wardrobe and local avatar).
				onPurchased: (item) => { this._equipCosmeticDurable(item.id); },
			});
		}
		// The shop is built once and reused across worlds, so refresh the coin tie
		// each open — a sale always credits the world the player is currently in.
		this._shop.h.coinMint = this.coin?.mint || '';
		this._shop.toggle();
	}

	// Zero-friction entry from the cold-open intro card: the $THREE home town,
	// general tier, whatever avatar/name is already defaulted (no picker forced).
	// Mirrors the bare `?coin=<home mint>` deep link's backfill in enter().
	_dropIn() {
		this.enter({ mint: HOME_TOWN.mint }, { tier: 'general' });
	}

	// ── Friends (W09) ─────────────────────────────────────────────────────────
	// The account-level social graph inside the world: who's online, which coin
	// world they're standing in, and DM threads. `FriendsPanel` is a pure view over
	// the shared `friendsClient`, so the same graph backs /play, /walk and the
	// standalone /friends page — a DM read here is read everywhere.
	//
	// Presence is published by the room, not this panel: CommunityNet now carries a
	// signed presence ticket into the join, so a player is visible to friends the
	// moment they enter a world, whether or not they ever open this panel.

	// Seed the graph once per world entry so the unread badge is honest before the
	// panel is ever opened, and keep it live from the client's change signal. Silent
	// no-op when signed out — `refresh()` short-circuits without a request.
	_initFriends() {
		const fc = friendsClient();
		this._offFriends = fc.subscribe(() => this._bumpFriendsBadge());
		fc.refresh();
		this._bumpFriendsBadge();
	}

	_bumpFriendsBadge() {
		this.ui?.setFriendsUnread?.(friendsClient().totalUnread);
	}

	_toggleFriends() {
		if (this._friendsOpen) this._closeFriends();
		else this._openFriends();
	}

	_openFriends() {
		if (this._friendsOpen) return;
		if (!this._friendsEl) {
			// Right-docked drawer. The panel renders its own tabs/list/threads into
			// `body`; we own only the frame, the close affordance and the hotkey hint.
			const close = document.createElement('button');
			close.className = 'cc-friends-panel-close';
			close.type = 'button';
			close.setAttribute('aria-label', 'Close friends panel');
			close.textContent = '✕';
			close.addEventListener('click', () => this._closeFriends());

			const title = document.createElement('div');
			title.className = 'cc-friends-panel-title';
			title.textContent = 'Friends';

			const head = document.createElement('div');
			head.className = 'cc-friends-panel-head';
			head.append(title, close);

			const body = document.createElement('div');
			body.className = 'cc-friends-panel-body';

			const hint = document.createElement('div');
			hint.className = 'cc-friends-panel-hint';
			hint.textContent = 'Press J to toggle · Esc to close';

			const root = document.createElement('aside');
			root.className = 'cc-friends-panel';
			root.setAttribute('role', 'dialog');
			root.setAttribute('aria-modal', 'false');
			root.setAttribute('aria-label', 'Friends');
			root.append(head, body, hint);
			document.body.appendChild(root);

			this._friendsEl = root;
			this._friendsBodyEl = body;
			this._friendsCloseEl = close;
			this._friends = new FriendsPanel(body);
		}
		this._friends.mount();
		this._friendsOpen = true;
		// Next frame, so the transform transition runs from its closed state rather
		// than being collapsed into the same style recalculation as the insert.
		requestAnimationFrame(() => this._friendsEl?.classList.add('is-open'));
		this.ui?.setFriendsOpen?.(true);
		// The world swallows WASD/F/X while the panel has focus; releasing the held
		// keys stops the avatar sliding when focus moves into a DM input.
		this.keys.clear();
		this._friendsCloseEl?.focus();
	}

	_closeFriends() {
		if (!this._friendsOpen) return;
		this._friendsOpen = false;
		this._friendsEl?.classList.remove('is-open');
		this._friends?.unmount();
		this.ui?.setFriendsOpen?.(false);
		this._bumpFriendsBadge();
	}

	// Full teardown — the panel and its client subscription must not outlive the
	// world (a coin switch rebuilds both, and a stale subscription would repaint a
	// disposed HUD).
	_disposeFriends() {
		if (this._offFriends) { try { this._offFriends(); } catch {} this._offFriends = null; }
		this._friends?.unmount();
		this._friends = null;
		this._friendsEl?.remove();
		this._friendsEl = null;
		this._friendsBodyEl = null;
		this._friendsCloseEl = null;
		this._friendsOpen = false;
	}

	// Open/close the "My Cosmetics" wardrobe panel (R23). Lazy-built on first open;
	// each profile echo from the server keeps it fresh so the equipped state always
	// reflects the server-authoritative result.
	_toggleWardrobe() {
		if (!this._wardrobe) {
			this._wardrobe = new CosmeticsWardrobe({
				onEquip: (id) => { this._equipCosmeticDurable(id); },
				onShop: () => { this._wardrobe?.close(); this._toggleShop(); },
			});
		}
		this._wardrobe.toggle();
	}

	// Open/close the Jobs Board (W08 hooking W05). Lazy-imported so the panel
	// chunk stays out of the initial bundle until a player actually walks up to
	// a quest-giver or opens Jobs from the HUD. `highlight` scrolls straight to
	// one mission when a specific giver NPC opened the board.
	async _toggleQuests(highlight) {
		if (!this.net) return;
		const { openQuestsPanel } = await import('./quests-ui.js');
		openQuestsPanel({ ui: this.ui, net: this.net }, highlight);
	}

	// Equip `id` durably: send to the server (authoritative validation + persistence)
	// so the fit survives logout, world switches, and is visible to peers immediately.
	// The server echoes a fresh profile which updates the wardrobe and local avatar.
	// Only forward ids the rig can actually wear — a purchase of an item outside the
	// worn-cosmetics catalog (its ownership still records server-side) must not fire
	// a spurious "that cosmetic doesn't exist" notice from the equip authority.
	_equipCosmeticDurable(id) {
		if (this.net && getCosmetic(id)) this.net.equipCosmetic(id);
	}

	// Revert the active preview, leaving the avatar exactly as it was.
	unequipCosmeticPreview() {
		const mgr = this._accessoryMgr;
		if (mgr) {
			if (this._previewLayers) { mgr.applyLayers({ colors: {}, hidden: [] }); this._previewLayers = false; }
			if (this._previewPresetId) { mgr.removePreset(this._previewPresetId); this._previewPresetId = null; }
		}
		this._previewItem = null;
	}

	// ── Owned-cosmetics: persisted equip on the LOCAL avatar (R23) ─────────────
	// Dress the local avatar in `wire` (an equipped loadout, slot→id map or wire
	// string). Idempotent — re-applies only when it actually changed — and reuses
	// the shared applyLoadout so the local body, peers and the creator preview all
	// render the same wardrobe. Separate from the R21 shop's ephemeral preview
	// above (AccessoryManager): this is the durable, equipped look.
	_applyLocalCosmetics(wire) {
		const next = typeof wire === 'string' ? wire : serializeLoadout(wire);
		if (this.localCosmetics && this._localCosWire === next) return;
		this._localCosWire = next;
		try { this.localCosmetics?.dispose(); } catch {}
		this.localCosmetics = (this.localRig && this.localHeight)
			? applyLoadout(this.localRig, this.localHeight, next)
			: null;
	}

	// The server echoes the authoritative profile on join and after every equip.
	// Mirror the equipped loadout to the cross-world store (so /walk and the next
	// session restore the same fit) and re-dress the local avatar. This is the one
	// place equip state flows client-side, so the wardrobe panel, the 3D body and
	// the persisted mirror never drift apart.
	_onCosmeticsProfile(snap) {
		const equipped = snap?.cosmetics?.equipped;
		if (!equipped || typeof equipped !== 'object') return;
		setPlayCosmetics(equipped);
		this._applyLocalCosmetics(equipped);
		// Relay the full cosmetics snapshot to the wardrobe panel (if open) so
		// it reflects owned + equipped state without a separate API call.
		this._wardrobe?.setProfile(snap);
	}

	// Surface unread chat in the tab title when the page is backgrounded, so a
	// new message pulls the user back. Cleared the moment they refocus the tab.
	_bumpTabUnread() {
		if (!document.hidden) return;
		this._tabUnread = (this._tabUnread || 0) + 1;
		if (!this._baseTitle) this._baseTitle = document.title;
		document.title = `(${this._tabUnread}) ${this._baseTitle}`;
		if (!this._tabFocusBound) {
			this._tabFocusBound = true;
			const clear = () => {
				if (document.hidden) return;
				this._tabUnread = 0;
				if (this._baseTitle) document.title = this._baseTitle;
			};
			document.addEventListener('visibilitychange', clear);
			window.addEventListener('focus', clear);
		}
	}

	// ── Dance floor (R06) ───────────────────────────────────────────────────────
	// A circular emissive pad placed beside the coin totem. Eight coloured tile
	// dots and four coloured point lights pulse on the server's floor:beat tick.
	// Standing inside the pad enables the Dance button; pressing it toggles the
	// "wants to dance" flag so the next beat crossfades this avatar (and everyone
	// else on the floor who pressed Dance) to the same clip simultaneously.

	_buildDanceFloor() {
		const CX = 14, CZ = -10; // world-space pad centre (right of totem)
		const R = 4;              // pad radius in metres

		const g = new Group();
		g.position.set(CX, 0, CZ);

		// Rim disc — slightly larger, defines the pad boundary with a subtle glow.
		const rimMat = new MeshStandardMaterial({ color: 0x0a0a14, emissive: 0x180840, emissiveIntensity: 0.55, roughness: 0.3, metalness: 0.7 });
		const rim = new Mesh(new CircleGeometry(R + 0.18, 48), rimMat);
		rim.rotation.x = -Math.PI / 2;
		g.add(rim);

		// Base pad — dark polished surface.
		const baseMat = new MeshStandardMaterial({ color: 0x0d0d1c, emissive: 0x100828, emissiveIntensity: 0.28, roughness: 0.2, metalness: 0.85 });
		const base = new Mesh(new CircleGeometry(R, 48), baseMat);
		base.rotation.x = -Math.PI / 2;
		base.position.y = 0.005;
		base.receiveShadow = true;
		g.add(base);

		// 8 emissive tile dots at r = 2.5m, each a distinct hue.
		const TILE_COLS = [0xff44cc, 0x44aaff, 0xffdd22, 0x44ffcc, 0xff6633, 0x88ff44, 0xaa44ff, 0x22ddff];
		this._floorTiles = [];
		for (let i = 0; i < 8; i++) {
			const angle = (i / 8) * Math.PI * 2;
			const mat = new MeshStandardMaterial({ color: TILE_COLS[i], emissive: TILE_COLS[i], emissiveIntensity: 0.45, roughness: 0.1, metalness: 0.88 });
			const tile = new Mesh(new CircleGeometry(0.38, 20), mat);
			tile.rotation.x = -Math.PI / 2;
			tile.position.set(Math.cos(angle) * 2.5, 0.01, Math.sin(angle) * 2.5);
			g.add(tile);
			this._floorTiles.push({ mat, idx: i });
		}

		// Centre disc — pure white / violet, most dramatic on beat.
		const centerMat = new MeshStandardMaterial({ color: 0xffffff, emissive: 0xaa55ff, emissiveIntensity: 0.65, roughness: 0.06, metalness: 0.96 });
		const center = new Mesh(new CircleGeometry(0.55, 32), centerMat);
		center.rotation.x = -Math.PI / 2;
		center.position.y = 0.012;
		g.add(center);
		this._floorCenterMat = centerMat;

		// 4 coloured point lights above the pad corners — pink / cyan / yellow / mint.
		const LIGHT_COLS = [0xff44cc, 0x44aaff, 0xffdd22, 0x44ffcc];
		this._floorLights = [];
		for (let i = 0; i < 4; i++) {
			const angle = (i / 4) * Math.PI * 2 + Math.PI / 4;
			const light = new PointLight(LIGHT_COLS[i], 0.5, 14);
			light.position.set(Math.cos(angle) * 3.3, 2.6, Math.sin(angle) * 3.3);
			g.add(light);
			this._floorLights.push(light);
		}

		this.world.add(g);
		this._danceFloor = g;
		this._danceFloorPos = { x: CX, z: CZ };
		this._floorRadius = R;
		this._beatT = 999; // no visual pulse until the first beat arrives
		this._onFloor = false;
		this._wantsDance = false;
		this._danceClip = 'av-dance-shuffle';
	}

	// Animate the dance floor each frame: exponential decay from the beat,
	// staggered across tiles to produce a ripple effect outward from centre.
	_tickDanceFloor(dt) {
		if (!this._danceFloor) return;
		this._beatT = (this._beatT ?? 999) + dt;
		const t = this._beatT;
		const pulse = t < 2 ? Math.exp(-t * 2.6) : 0;

		for (const tile of this._floorTiles) {
			const off = (tile.idx / this._floorTiles.length) * 0.28;
			const tp = t > off ? Math.exp(-(t - off) * 3.4) : 0;
			tile.mat.emissiveIntensity = 0.28 + tp * 1.0;
		}
		if (this._floorCenterMat) this._floorCenterMat.emissiveIntensity = 0.5 + pulse * 1.4;
		for (const l of this._floorLights) l.intensity = 0.5 + pulse * 2.8;
	}

	// Per-tick: check whether the local player stepped onto / off the pad and
	// update the UI button accordingly.
	_checkFloorOccupancy() {
		if (!this._danceFloorPos) return;
		const dx = this.localPos.x - this._danceFloorPos.x;
		const dz = this.localPos.z - this._danceFloorPos.z;
		const onFloor = Math.hypot(dx, dz) <= this._floorRadius;
		if (onFloor === this._onFloor) return;
		this._onFloor = onFloor;
		this.ui.setOnFloor(onFloor);
		if (!onFloor && this._wantsDance) {
			this._wantsDance = false;
			this.ui.setDancing(false);
		}
	}

	// Server beat tick: reset the visual pulse and, for players who pressed
	// Dance, crossfade to this beat's clip in lockstep with all other clients.
	_onFloorBeat(msg) {
		this._beatT = 0;
		if (!this._onFloor || !this._wantsDance) return;
		const clip = msg?.clip || 'av-dance-shuffle';
		this._danceClip = clip;
		// Local avatar: start the clip now, aligned to the server beat.
		playEmoteClip(this.localAnim, clip, this.motion);
		// Broadcast so peers see us dancing — 2-second emote cooldown in WalkRoom
		// is well under the 4-second beat interval, so this always lands.
		this.net?.sendEmote(clip);
	}

	// Toggle "wants to dance" when the button is pressed. An immediate preview
	// kick plays the current clip so the player sees something happen right away;
	// subsequent beats keep re-aligning everyone in lockstep.
	_triggerDance() {
		if (!this._onFloor) return;
		this._wantsDance = !this._wantsDance;
		this.ui.setDancing(this._wantsDance);
		if (this._wantsDance) {
			const clip = this._danceClip || 'av-dance-shuffle';
			playEmoteClip(this.localAnim, clip, this.motion);
			this.net?.sendEmote(clip);
		}
	}

	// ── King of the Totem (R07) ──────────────────────────────────────────────────
	// A round-based area-control game. The server is the sole authority: it tracks
	// who's inside the king-zone at the totem base, awards points to a SOLE occupant
	// each second (contested = nobody scores), runs 90 s rounds, and broadcasts the
	// timer, scoreboard, current king and winner. This client only renders: the
	// ground ring, a crown that follows the current king, the HUD, and a confetti
	// burst on the winner. It never computes or trusts a score.

	_buildKingZone() {
		const { x, z, r } = KING_ZONE;
		const g = new Group();
		g.position.set(x, 0, z);

		// Boundary ring on the ground — a warm gold annulus that reads as the coin's
		// own colour (matches the totem disc), so the zone clearly belongs to the totem.
		const ringMat = new MeshBasicMaterial({ color: 0xffce5c, transparent: true, opacity: 0.42, depthWrite: false, side: DoubleSide });
		const ring = new Mesh(new RingGeometry(r - 0.2, r, 72), ringMat);
		ring.rotation.x = -Math.PI / 2;
		ring.position.y = 0.03;
		g.add(ring);
		this._kingRingMat = ringMat;

		// Soft fill so the contested area is legible from above without hiding the ground.
		const fillMat = new MeshBasicMaterial({ color: 0xffce5c, transparent: true, opacity: 0.05, depthWrite: false, side: DoubleSide });
		const fill = new Mesh(new CircleGeometry(r - 0.1, 72), fillMat);
		fill.rotation.x = -Math.PI / 2;
		fill.position.y = 0.02;
		g.add(fill);
		this._kingFillMat = fillMat;

		this.world.add(g);
		this._kingZone = g;
		this._kingZoneT = 0;
		this._kingId = null;

		// A crown ring that follows whoever currently holds the zone. Lives in world
		// space (not parented to an avatar) and is repositioned each frame, so a king
		// leaving never strands geometry on a disposed rig.
		const crownMat = new MeshBasicMaterial({ color: 0xffd86b, transparent: true, opacity: 0.85, depthWrite: false });
		this._kingCrownRing = new Mesh(new RingGeometry(0.46, 0.72, 36), crownMat);
		this._kingCrownRing.rotation.x = -Math.PI / 2;
		this._kingCrownRing.position.y = 0.05;
		this._kingCrownRing.visible = false;
		this.world.add(this._kingCrownRing);

		// A 👑 that floats above the king's head, projected to screen each frame.
		this._kingCrownLabel = document.createElement('div');
		this._kingCrownLabel.className = 'cc-king-crown';
		this._kingCrownLabel.textContent = '👑';
		this._kingCrownLabel.style.display = 'none';
		document.body.appendChild(this._kingCrownLabel);
	}

	// World/screen position of a player (local or remote) by session id, or null if
	// they aren't in our view (left, or their avatar hasn't loaded yet).
	_kingPlayerPos(id) {
		if (!id) return null;
		if (id === this.net?.sessionId) return { pos: this.localPos, height: this.localHeight || 1.7 };
		const r = this.remotes.get(id);
		if (r) return { pos: r.rig.position, height: r.height || 1.7 };
		return null;
	}

	// Per-frame: pulse the zone (brighter while held, brightest when YOU hold it) and
	// move the crown to the current king. Pure rendering off the last server snapshot.
	_tickKingZone(dt) {
		if (!this._kingZone) return;
		this._kingZoneT += dt;
		const held = !!this._kingId;
		const mine = held && this._kingId === this.net?.sessionId;
		const breathe = 0.34 + 0.12 * Math.sin(this._kingZoneT * 2);
		this._kingRingMat.opacity = breathe + (held ? 0.2 : 0) + (mine ? 0.2 : 0);
		this._kingFillMat.opacity = 0.05 + (held ? 0.05 : 0) + (mine ? 0.07 : 0);

		const kp = held ? this._kingPlayerPos(this._kingId) : null;
		if (kp) {
			this._kingCrownRing.visible = true;
			this._kingCrownRing.position.set(kp.pos.x, 0.05, kp.pos.z);
			this._kingCrownRing.material.opacity = 0.62 + 0.3 * (0.5 + 0.5 * Math.sin(this._kingZoneT * 5));
			this._projectKingCrown(kp.pos, kp.height);
		} else {
			this._kingCrownRing.visible = false;
			if (this._kingCrownLabel) this._kingCrownLabel.style.display = 'none';
		}
	}

	// Project the floating 👑 above the king's head to a screen position, reusing the
	// same camera projection as the reaction sprites / nameplate labels.
	_projectKingCrown(pos, height) {
		const lbl = this._kingCrownLabel;
		if (!lbl || !this.camera || !this.renderer) return;
		const w = this.renderer.domElement.clientWidth;
		const h = this.renderer.domElement.clientHeight;
		const v = new Vector3(pos.x, pos.y + height + 0.42, pos.z).project(this.camera);
		if (v.z > 1 || v.z < -1) { lbl.style.display = 'none'; return; }
		lbl.style.left = ((v.x * 0.5 + 0.5) * w) + 'px';
		lbl.style.top = ((-v.y * 0.5 + 0.5) * h) + 'px';
		lbl.style.display = '';
	}

	// Authoritative game state from the server (round start/tick/end + join sync).
	_onKing(msg) {
		if (!msg || !msg.event) return;
		const localId = this.net?.sessionId;
		this._kingId = msg.kingId || null;
		this.ui.setKingState({ ...msg, localId });
		if (msg.event === 'end' && msg.winner) {
			const isMe = msg.winner.id === localId;
			const wp = this._kingPlayerPos(msg.winner.id);
			if (wp) this._spawnConfetti(wp.pos, wp.height);
			// Make sure the local champion always gets a burst even if their avatar is
			// off the winner-position path above (e.g. camera angle), so winning feels good.
			if (isMe && (!wp || wp.pos !== this.localPos)) this._spawnConfetti(this.localPos, this.localHeight || 1.7);
			this.ui.showKingWinner(msg.winner, isMe);
		}
	}

	_disposeKingZone() {
		if (this._kingZone) {
			this._kingZone.traverse((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
			this.world?.remove(this._kingZone);
			this._kingZone = null;
		}
		if (this._kingCrownRing) {
			this._kingCrownRing.geometry.dispose();
			this._kingCrownRing.material.dispose();
			this.world?.remove(this._kingCrownRing);
			this._kingCrownRing = null;
		}
		if (this._kingCrownLabel) { this._kingCrownLabel.remove(); this._kingCrownLabel = null; }
		this._kingRingMat = null;
		this._kingFillMat = null;
		this._kingId = null;
	}

	// Live rename: persist and broadcast so peers' nameplates update instantly.
	_rename(name) {
		const clean = (name || '').trim().slice(0, 24);
		if (clean) lsSet('cc-name', clean);
		if (this.net && clean) this.net.rename(clean);
	}

	// Open the native on-chain buy for the current coin. Lazy-loaded so the
	// Solana/pump SDKs never weigh down the main /play bundle.
	async _openBuy(coin = this.coin) {
		if (!coin?.mint) return;
		try {
			const { openBuyModal } = await import('./coin-buy.js');
			openBuyModal(coin);
		} catch (err) {
			log.warn('[coincommunities] buy modal failed to load:', err?.message);
			this.ui.toast('Couldn’t open the buy panel. Trade on pump.fun instead.', 'warn');
		}
	}

	_sayLocal(text) {
		if (this._localBubble) this._localBubble.remove();
		this._localBubble = document.createElement('div');
		this._localBubble.className = 'cc-bubble';
		this._localBubble.textContent = text;
		document.body.appendChild(this._localBubble);
		clearTimeout(this._localBubbleTimer);
		this._localBubbleTimer = setTimeout(() => { this._localBubble?.remove(); this._localBubble = null; }, 5000);
	}

	// ---------------------------------------------------------------- input
	_bindInput() {
		window.addEventListener('keydown', (e) => {
			if (this.ui.chatFocused) return;
			// Typing anywhere else (friends DM box, search fields, modal inputs) must
			// reach the caret untouched — no hotkeys, no Enter hijack, no Space eaten.
			if (isTypingTarget(e.target)) return;
			// Esc closes the friends drawer before anything else claims the key.
			if (e.key === 'Escape' && this._friendsOpen) { e.preventDefault(); this._closeFriends(); return; }
			if (e.key === 'Enter' && this.phase === 'world') { e.preventDefault(); this.ui.focusChat(); return; }
			// Space jumps on foot; while driving it's the handbrake instead (held,
			// released in the keyup handler below) — never scrolls the page either way.
			if (e.code === 'Space') {
				e.preventDefault();
				if (this.vehicles?.isDriving()) { this.vehicles.setHandbrake(true); return; }
				this._jump();
				return;
			}
			const k = e.key.toLowerCase();
			if (this.phase === 'world') {
				// B toggles build mode; while it's on, 1–0 pick the active block.
				if (k === 'b') {
					e.preventDefault();
					if (this._buildableConnection() || this.buildHud.active) this.buildHud.setActive(!this.buildHud.active);
					return;
				}
				// Ctrl/Cmd+Z walks back the player's own recent build edits.
				if (k === 'z' && (e.ctrlKey || e.metaKey) && this.buildHud.active) {
					e.preventDefault();
					this._undo();
					return;
				}
				if (this.buildHud.active && k.length === 1 && k >= '0' && k <= '9') {
					e.preventDefault();
					this.buildHud.select(k === '0' ? 9 : Number(k) - 1);
					return;
				}
				// R rotates the armed prop or composite piece a quarter-turn while building.
				if (k === 'r' && this.buildHud.active && (this.buildProp || this.buildPiece)) {
					e.preventDefault();
					if (this.buildProp) this._rotateProp(); else this._rotateBuild();
					return;
				}
				// E interacts with whatever the player stands near — a townsperson,
				// the Intel Kiosk, or the Agent Exchange (all built in every world).
				// Not while building.
				if (k === 'e' && !this.buildHud.active) {
					e.preventDefault();
					// A conversation or counter is already open — let it own the moment
					// instead of reopening on top of itself.
					if (isChatPanelOpen() || isServicePanelOpen() || isAixbtPanelOpen() || isZauthPanelOpen()) return;
					// Talk to the nearest townsperson (vendor/quest/flavor); if none is
					// in range, try the Intel Kiosk, then fall through to the Agent
					// Exchange.
					if (!this.worldLife?.interact() && !this.intelKiosk?.interact() && !this.combat?.interact() && !this.wheelStation?.interact()) this.agentCommerce?.interact();
					return;
				}
				// F is contextual: enter/exit a nearby vehicle takes priority (the
				// on-screen prompt already says "F — Drive" / "F — Exit"); then a
				// gather/craft/pickup station (chop, mine, cook, grab a rod); otherwise
				// it casts a line when standing by a pond (no-op elsewhere). Not while
				// building, where keys drive the block palette.
				if (k === 'f' && !this.buildHud.active) {
					e.preventDefault();
					if (!this.vehicles?.interact() && !this.playActivities?.doAction()) this.playSystems?.castFish();
					return;
				}
				// I inspects the nearest avatar — player, townsperson, or yourself:
				// identity, reputation, wallet. Press again to close.
				if (k === 'i' && !this.buildHud.active && !e.repeat) {
					e.preventDefault();
					this._inspectNearest();
					return;
				}
				// J toggles the friends drawer (W09). F — the /walk binding — is already
				// this world's contextual action key (drive / gather / cast), so /play
				// takes the next free slot; the HUD button carries the same hint.
				if (k === 'j' && !this.buildHud.active && !e.repeat) {
					e.preventDefault();
					this._toggleFriends();
					return;
				}
				// C cycles the camera: follow → cinematic → first person → top down.
				if (k === 'c' && !this.buildHud.active && !e.repeat) {
					e.preventDefault();
					this._camModes.cycle(this.camera);
					return;
				}
				// X swings/fires the equipped weapon (W07). No-op with bare hands or
				// while building; the touch equivalent is the Attack button that
				// appears whenever a weapon is on the active hotbar slot.
				if (k === 'x' && !this.buildHud.active) {
					e.preventDefault();
					this.combat?.attack();
					return;
				}
				// Q — hold to open the emote wheel, release to play the selected clip.
				// Ignore auto-repeat (held key fires many keydowns) and build mode.
				if (k === 'q' && !this.buildHud.active && !e.repeat) {
					e.preventDefault();
					this._ewHeld = false;
					clearTimeout(this._ewHoldTimer);
					this._ewHoldTimer = setTimeout(() => {
						this._ewHeld = true;
						this.ui.openEmoteWheel();
					}, 340);
					return;
				}
				// 1–6 select a hotbar slot when not building.
				if (!this.buildHud.active && k.length === 1 && k >= '1' && k <= '6') {
					e.preventDefault();
					this.playSystems?.equipSlot(Number(k) - 1);
					return;
				}
			}
			this.keys.add(k);
		});
		window.addEventListener('keyup', (e) => {
			const k = e.key.toLowerCase();
			// Space release: let go of the handbrake (harmless no-op when not driving).
			if (e.code === 'Space') this.vehicles?.setHandbrake(false);
			// Q release: if the wheel opened via hold, close it and play the selected clip.
			if (k === 'q' && this.phase === 'world') {
				clearTimeout(this._ewHoldTimer);
				if (this._ewHeld) { this._ewHeld = false; this.ui.closeEmoteWheel(true); }
			}
			this.keys.delete(k);
		});
		this.canvas.addEventListener('pointerdown', (e) => {
			this._dragging = true; this._lastPtr = { x: e.clientX, y: e.clientY };
			this._downPtr = { x: e.clientX, y: e.clientY };
			this._longPressFired = false;
			// Touch has no hover, so seed the ghost on press so the first tap aims true.
			if (this.phase === 'world' && this.buildHud.active && e.button !== 2) {
				this._updateGhost(e.clientX, e.clientY);
				// Touch has no right-click; a hold breaks the targeted block. Mouse keeps
				// right-click / the mode toggle, but the hold works there too.
				if (e.button !== 2) this._armLongPressBreak(e.clientX, e.clientY);
			}
		});
		window.addEventListener('pointerup', () => { this._dragging = false; this._cancelLongPress(); });
		// A tap (negligible drag) builds in build mode, otherwise opens the coin on
		// pump.fun when it lands on the live chart screen.
		this.canvas.addEventListener('pointerup', (e) => {
			this._cancelLongPress();
			const consumed = this._longPressFired;
			this._longPressFired = false;
			if (!this._downPtr) return;
			const moved = Math.hypot(e.clientX - this._downPtr.x, e.clientY - this._downPtr.y);
			this._downPtr = null;
			if (consumed) return; // a hold already broke a block — don't also place
			if (moved >= 6 || e.button === 2) return; // a look-drag, or a right-click (handled by contextmenu)
			if (this.phase === 'world' && this.buildHud.active) { this._buildAt(e.clientX, e.clientY, false); return; }
			// Tap a nearby parked vehicle to take the wheel — the touch-native
			// equivalent of pressing F. Checked first: it only ever fires when a
			// vehicle is both in range and under the tap, so it can't shadow the
			// other tap targets below.
			if (this.vehicles?.tryActivateAt(this._pointerRay(e.clientX, e.clientY))) return;
			// Tap the agents (or their exchange ring) to watch a live payment — the
			// touch-native equivalent of pressing E. Checked before the chart screen.
			if (this.worldLife?.tryActivateAt(e.clientX, e.clientY)) return;
			// Tap a nearby tombstone to loot it — the touch-native equivalent of
			// pressing E on a death-drop (W07).
			if (this.combat?.tryActivateAt(this._pointerRay(e.clientX, e.clientY))) return;
			if (this.agentCommerce?.tryActivateAt(this._pointerRay(e.clientX, e.clientY))) return;
			if (this.intelKiosk?.tryActivateAt(this._pointerRay(e.clientX, e.clientY))) return;
			// Tap an agent desk screen → open its full 2D watch view.
			if (this._agentDesks?.length) {
				const ray = this._pointerRay(e.clientX, e.clientY);
				for (const desk of this._agentDesks) {
					if (desk.screen && ray.intersectObject(desk.screen, false).length > 0) {
						desk.openWatch();
						return;
					}
				}
			}
			// Tap another player's avatar → the inspector (their nameplate is the
			// other click target; both land in the same panel).
			if (this.phase === 'world') {
				const peerId = this._remoteAt(e.clientX, e.clientY);
				if (peerId) { this._inspectRemote(peerId); return; }
			}
			if (this._raycastScreen(e.clientX, e.clientY)) this._chartScreen.openExternal();
		});
		// Right-click always breaks the targeted block while building.
		this.canvas.addEventListener('contextmenu', (e) => {
			if (this.phase === 'world' && this.buildHud.active) { e.preventDefault(); this._buildAt(e.clientX, e.clientY, true); }
		});
		window.addEventListener('pointermove', (e) => {
			if (!this._dragging) {
				// Throttled hover: drive the build ghost while building, else the
				// pointer cursor over the clickable chart screen.
				const now = performance.now();
				if (this.phase === 'world' && now - (this._hoverAt || 0) > 40) {
					this._hoverAt = now;
					this._lastHover = { x: e.clientX, y: e.clientY };
					if (this.buildHud.active) this._updateGhost(e.clientX, e.clientY);
					else {
						let overDesk = false;
						if (this._agentDesks?.length) {
							const ray = this._pointerRay(e.clientX, e.clientY);
							overDesk = this._agentDesks.some((d) => d.screen && ray.intersectObject(d.screen, false).length > 0);
						}
						this.canvas.style.cursor = overDesk || (this._chartScreen && this._raycastScreen(e.clientX, e.clientY)) ? 'pointer' : '';
					}
				}
				return;
			}
			const dx = e.clientX - this._lastPtr.x, dy = e.clientY - this._lastPtr.y;
			this._lastPtr = { x: e.clientX, y: e.clientY };
			// A real drag is a look, not a hold — cancel the pending break so panning
			// the camera in build mode never destroys a block.
			if (this._downPtr && Math.hypot(e.clientX - this._downPtr.x, e.clientY - this._downPtr.y) >= 8) this._cancelLongPress();
			this.camYaw -= dx * 0.005;
			this.camPitch = Math.max(0.1, Math.min(1.2, this.camPitch + dy * 0.004));
		});
		this.canvas.addEventListener('wheel', (e) => {
			e.preventDefault();
			this.camDist = Math.max(4, Math.min(20, this.camDist * (e.deltaY > 0 ? 1.1 : 0.9)));
		}, { passive: false });
	}

	// Build a camera ray through a screen-space point (shared by the chart-screen
	// hit test and the voxel targeting).
	_pointerRay(clientX, clientY) {
		this._raycaster = this._raycaster || new Raycaster();
		this._ndc = this._ndc || new Vector2();
		const rect = this.canvas.getBoundingClientRect();
		this._ndc.set(
			((clientX - rect.left) / rect.width) * 2 - 1,
			-((clientY - rect.top) / rect.height) * 2 + 1,
		);
		this._raycaster.setFromCamera(this._ndc, this.camera);
		return this._raycaster;
	}

	// Cast a ray from a screen-space point into the world and report whether it
	// hits the live chart screen's face — powers tap-to-open and the hover cursor.
	_raycastScreen(clientX, clientY) {
		if (!this._chartScreen?.mesh) return false;
		return this._pointerRay(clientX, clientY).intersectObject(this._chartScreen.mesh, false).length > 0;
	}

	// ---------------------------------------------------------------- building
	// A live server lets everyone build the same persistent world; with no server
	// reachable we still let a solo player build their own local copy. Either way
	// the connecting window (nothing to build into yet) is the only time off.
	_buildableConnection() {
		const s = this.net?.status;
		// 'unavailable' (no server configured for this env) is a solo session just
		// like 'offline' — let the player build their own local copy.
		return s === 'online' || s === 'offline' || s === 'unavailable';
	}

	// Place or break a block under the pointer. Online is server-authoritative: we
	// only send the intent, and the block appears/disappears when the server echoes
	// its blocks state back (see the blockAdd/blockRemove wiring in enter()). In
	// single-player (no server) we apply the edit straight to the local voxel layer
	// — same result on screen, just not synced or persisted.
	_buildAt(clientX, clientY, forceRemove) {
		if (this.phase !== 'world' || !this._buildableConnection()) return;
		// Prop layer (R18): a click places a free-standing object; right-click / hold
		// deletes one you own. Routed before the voxel path so the two never collide.
		if (this.buildProp) { this._buildPropAt(clientX, clientY, forceRemove); return; }
		if (!this.voxels) return;
		const target = this.voxels.raycast(this._pointerRay(clientX, clientY));
		if (!target) return;
		const removing = forceRemove || this.buildHud.mode === 'remove';
		// A composite piece stamps several cells at once — but only when placing.
		// Break mode always falls back to the single-cell path below.
		if (!removing && this.buildPiece && target.placeCell) {
			this._placeComposite(target.placeCell);
			this._updateGhost(clientX, clientY);
			return;
		}
		if (removing) {
			if (target.hit === 'block' && target.cell) {
				// Capture the type before it's gone so undo can put it back exactly.
				const prevType = this.voxels.typeAt(...target.cell);
				if (this._applyEdit('remove', target.cell) && prevType >= 0) {
					this._pushUndo({ kind: 'place', cell: target.cell.slice(), type: prevType });
				}
			}
		} else if (target.placeValid) {
			// The server enforces the build's block cap online; honour it locally too
			// so a solo build can't outgrow what a shared one is allowed to be.
			if (this.net?.status !== 'online' && this.voxels.count >= MAX_BLOCKS) {
				this.ui.toast(`Build limit reached (${MAX_BLOCKS} blocks).`, 'warn');
				return;
			}
			if (this._applyEdit('place', target.placeCell, this.buildType)) {
				this._pushUndo({ kind: 'remove', cell: target.placeCell.slice() });
			}
		} else if (target.placeCell) {
			// Aimed somewhere illegal (out of bounds / occupied) — flash the cursor.
			this.voxels.showGhost(target.placeCell, 'blocked');
			return;
		}
		this._updateGhost(clientX, clientY);
	}

	// Stamp a composite piece (wall / floor / stairs / doorway) anchored at `cell`,
	// rotated by the current quarter-turn. Validated as a whole: every cell must be
	// in bounds, empty, and fit the budget, or nothing lands — so a piece never
	// half-appears. Online it goes through the place-batch channel (server echoes
	// each block back); solo it's applied to the local layer directly. Undo records
	// just the cells this stamp actually created.
	_placeComposite(cell) {
		const cells = compositeCells(this.buildPiece, cell, this.buildRot, this.buildType);
		if (!cells.length) return;
		if (!this.voxels.canPlaceAll(cells, MAX_BLOCKS)) {
			this.voxels.showFootprint(cells, false);
			// Name the most likely reason so a blocked stamp isn't a silent no-op.
			const overBudget = this.voxels.count + cells.length > MAX_BLOCKS;
			this.ui.toast(overBudget
				? `Not enough room — that piece needs ${cells.length} blocks.`
				: 'That piece doesn’t fit here — rotate it or move back.', 'warn');
			return;
		}
		// The cells this stamp newly creates (a piece may overlap existing blocks);
		// only those are recorded for undo so we never break a neighbour's work.
		const fresh = cells.filter((c) => !this.voxels.hasBlock(keyOf(c.x, c.y, c.z)));
		const online = this.net?.status === 'online';
		if (online) {
			this.net.sendPlaceBatch(cells);
		} else {
			for (const c of cells) this.voxels.setBlock(c.x, c.y, c.z, c.t);
			this._syncBudget();
		}
		if (fresh.length) this._pushUndo({ kind: 'remove-batch', cells: fresh.map((c) => [c.x, c.y, c.z]) });
	}

	// Arm a composite piece (or null for single-block mode) and reflect it in the
	// toolbar + ghost. Resets rotation so each piece starts square-on.
	_pickPiece(id) {
		this.buildPiece = COMPOSITE_PIECES.some((p) => p.id === id) ? id : null;
		this.buildRot = 0;
		// Arming a voxel tool disarms the prop layer — the two placement modes are
		// mutually exclusive so a build click is never ambiguous.
		if (this.buildProp) { this.buildProp = null; this.ui.setPropSelected(null); this.propGhost?.hide(); }
		this.ui.setBuildPiece(this.buildPiece);
		this.ui.setBuildRotation(this.buildRot);
		this._refreshGhost();
	}

	// Rotate the armed piece a quarter-turn and re-preview it in place.
	_rotateBuild() {
		if (!this.buildPiece) return;
		this.buildRot = (this.buildRot + 1) % 4;
		this.ui.setBuildRotation(this.buildRot);
		this._refreshGhost();
	}

	// ── Props build layer (R18) ───────────────────────────────────────────────
	// Arm a placeable prop (or null to return to the voxel layer). Disarms any voxel
	// composite so the two placement modes never both fire on a click. Resets the
	// prop's rotation so each newly-picked prop starts square-on, and primes the
	// ghost so the preview appears without waiting for pointer motion.
	_pickProp(id) {
		const def = id ? propDef(id) : null;
		this.buildProp = def ? def.id : null;
		this.buildPropRot = 0;
		if (this.buildProp) {
			// Leaving the voxel layer: clear any armed composite + hide the voxel ghost.
			this.buildPiece = null; this.buildRot = 0;
			this.ui.setBuildPiece(null);
			this.voxels?.hideGhost(); this.voxels?.hideFootprint();
			this.propGhost?.setType(this.buildProp);
		} else {
			this.propGhost?.hide();
		}
		this.ui.setPropSelected(this.buildProp);
		this._refreshGhost();
	}

	// Rotate the armed prop a quarter-turn and re-preview it in place.
	_rotateProp() {
		if (!this.buildProp) return;
		this.buildPropRot = (this.buildPropRot + 1) % 4;
		this._refreshGhost();
	}

	// Where, in world space, is the player aiming a prop? A prop drops onto the
	// ground plane (props stand on the floor, they don't stack on cells), snapped to
	// a half-block grid so neighbouring props line up. Returns the snapped point + a
	// validity flag (inside the build radius), or null when aiming at the sky.
	_propTarget(clientX, clientY) {
		const ray = this._pointerRay(clientX, clientY).ray;
		if (ray.direction.y >= -1e-4) return null; // looking up / parallel — no floor
		const t = -ray.origin.y / ray.direction.y;
		if (t <= 0) return null;
		const px = ray.origin.x + ray.direction.x * t;
		const pz = ray.origin.z + ray.direction.z * t;
		const snap = BLOCK / 2;
		const x = Math.round(px / snap) * snap;
		const z = Math.round(pz / snap) * snap;
		const valid = Math.hypot(x, z) <= WORLD_RADIUS;
		return { x, y: 0, z, valid };
	}

	// Place or delete a prop under the pointer. Placing sends obj:spawn kind:'block'
	// (durable, server-persisted via R17); the prop appears for everyone when the
	// server echoes its objects state back. Right-click / hold deletes a prop YOU own
	// (server enforces ownership; we only offer it on your own pieces — R19 hardens it).
	_buildPropAt(clientX, clientY, forceRemove) {
		const removing = forceRemove || this.buildHud.mode === 'remove';
		if (removing) { this._deleteOwnPropAt(clientX, clientY); return; }
		const target = this._propTarget(clientX, clientY);
		if (!target) return;
		if (!target.valid) { this._updatePropGhost(clientX, clientY); return; }
		const online = this.net?.status === 'online';
		if (!online) {
			// Solo: there's no shared object channel to place into, so be honest rather
			// than faking a local-only prop that no one else will ever see.
			this.ui.toast('Props need a live connection — reconnect to place them.', 'warn');
			return;
		}
		const yaw = this.buildPropRot * (Math.PI / 2);
		this.net.spawnObject('block', { type: this.buildProp, x: target.x, y: target.y, z: target.z, yaw, scale: this.buildPropScale });
		// A short haptic tick confirms the place on touch devices.
		if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(12);
		this._updatePropGhost(clientX, clientY);
	}

	// Delete the nearest prop under the pointer that this client owns. Raycasts only
	// owned object nodes, so a click never offers to delete someone else's build.
	_deleteOwnPropAt(clientX, clientY) {
		if (!this.worldObjects) return;
		const owned = this.worldObjects.ownedNodes(this._ownedScratch || (this._ownedScratch = []));
		if (!owned.length) { this.ui.toast('Nothing of yours to remove here.', 'info'); return; }
		const hits = this._pointerRay(clientX, clientY).intersectObjects(owned, true);
		const id = hits.length ? this.worldObjects.idForHit(hits[0].object) : null;
		if (!id) return;
		this.net?.removeObject(id);
		if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(20);
	}

	// Drive the prop ghost: in place mode show the translucent prop at the snapped
	// pose (green valid / red blocked); in remove mode highlight nothing (the delete
	// raycast is per-click) and hide the place ghost.
	_updatePropGhost(clientX, clientY) {
		if (!this.propGhost || !this.buildProp) return;
		if (this.buildHud.mode === 'remove') { this.propGhost.hide(); return; }
		const target = this._propTarget(clientX, clientY);
		if (!target) { this.propGhost.hide(); return; }
		this.propGhost.setType(this.buildProp);
		this.propGhost.setPose(target.x, target.y, target.z, this.buildPropRot * (Math.PI / 2), this.buildPropScale);
		this.propGhost.setValid(target.valid && this.net?.status === 'online');
		this.propGhost.show();
	}

	// Explain a server-refused spawn (room full, or this player's object cap hit) so a
	// prop that never appeared isn't a silent mystery. Throttled like edit rejects.
	_onObjectReject(reason) {
		const now = performance.now();
		this._objRejectAt ||= {};
		if (now - (this._objRejectAt[reason] || 0) < 4000) return;
		this._objRejectAt[reason] = now;
		const msg = {
			world_full: 'This world is full of props — remove some to place more.',
			player_full: 'You’ve hit your prop limit for this world — remove some to place more.',
		}[reason] || 'That prop couldn’t be placed.';
		this.ui.toast(msg, 'warn');
	}

	// Arm a hold-to-break timer for the current press. If the player keeps the
	// pointer down and still (no drag) past LONG_PRESS_MS, break the targeted block
	// — the touch-native equivalent of a right-click. Cancelled by movement or release.
	_armLongPressBreak(clientX, clientY) {
		this._cancelLongPress();
		if (this.phase !== 'world' || !this.buildHud.active || !this._buildableConnection()) return;
		this._longPressTimer = setTimeout(() => {
			this._longPressTimer = null;
			if (!this._downPtr) return;
			this._longPressFired = true;
			this._buildAt(clientX, clientY, true);
			// A short haptic tick confirms the break on devices that support it.
			if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(28);
		}, LONG_PRESS_MS);
	}

	_cancelLongPress() {
		if (this._longPressTimer) { clearTimeout(this._longPressTimer); this._longPressTimer = null; }
	}

	// Apply one edit to whichever layer is authoritative: online sends the intent
	// (the block lands when the server echoes it); solo mutates the local layer
	// directly. Returns true if the edit was issued, so undo history only records
	// edits that actually happened.
	_applyEdit(kind, cell, type) {
		const online = this.net?.status === 'online';
		if (kind === 'remove') {
			if (online) this.net.sendRemove(cell[0], cell[1], cell[2]);
			else { this.voxels.removeBlock(cell[0], cell[1], cell[2]); this._syncBudget(); }
		} else {
			if (online) this.net.sendPlace(cell[0], cell[1], cell[2], type);
			else { this.voxels.setBlock(cell[0], cell[1], cell[2], type); this._syncBudget(); }
		}
		return true;
	}

	// Push an inverse action onto the bounded undo stack. Each entry is the edit
	// that *reverses* what the player just did, so Ctrl/Cmd+Z replays it.
	_pushUndo(action) {
		(this._undoStack ||= []).push(action);
		if (this._undoStack.length > UNDO_LIMIT) this._undoStack.shift();
	}

	// Reverse the player's most recent build action. Best-effort in a shared world:
	// if a peer has since changed that cell, the inverse simply overrides or no-ops,
	// which is the least-surprising outcome for a collaborative undo.
	_undo() {
		if (this.phase !== 'world' || !this.buildHud.active || !this._buildableConnection()) return;
		const action = this._undoStack?.pop();
		if (!action) { this.ui.toast('Nothing to undo.', 'info'); return; }
		if (action.kind === 'place') this._applyEdit('place', action.cell, action.type);
		else if (action.kind === 'remove-batch') for (const cell of action.cells) this._applyEdit('remove', cell);
		else this._applyEdit('remove', action.cell);
		this._refreshGhost();
	}

	// Keep the HUD's block-budget meter in step with the live build. voxels.count
	// mirrors the server's authoritative block count (every block streams in), so
	// this is accurate online and solo alike.
	_syncBudget() {
		this.buildHud?.setBudget(this.voxels?.count ?? 0, MAX_BLOCKS);
	}

	// Explain a server-refused edit so a block that never appeared isn't a mystery.
	// Throttled to one toast per reason per window — a flood reply can't spam.
	_onEditReject(reason) {
		const now = performance.now();
		this._rejectToastAt ||= {};
		if (now - (this._rejectToastAt[reason] || 0) < 4000) return;
		this._rejectToastAt[reason] = now;
		const msg = {
			budget: `Build limit reached (${MAX_BLOCKS} blocks) — break something to make room.`,
			rate: 'Building too fast — slow down a moment.',
			bounds: 'Can’t build there — outside the build area.',
			type: 'That block type isn’t available.',
			owned: 'That block belongs to another builder — you can’t change it.',
			column: 'That stack is too tall here — try building wider, not higher.',
			protected: 'That spot is protected — keep the spawn and totem clear.',
			player: 'You’ve hit your block limit for this world — break some to build more.',
			playercap: 'You’ve hit your block limit for this world — break some to build more.',
			dense: 'That stack is too tall here — try building wider, not higher.',
			notcreator: 'Only the coin’s creator can clear builds here.',
		}[reason] || 'That edit couldn’t be applied.';
		this.ui.toast(msg, 'warn');
	}

	// Move the ghost cursor to whatever the pointer aims at, tinted by intent
	// (green place / red break / amber blocked).
	_updateGhost(clientX, clientY) {
		if (this.buildProp) { this._updatePropGhost(clientX, clientY); return; }
		if (!this.voxels) return;
		const target = this.voxels.raycast(this._pointerRay(clientX, clientY));
		if (!target) { this.voxels.hideGhost(); this.voxels.hideFootprint(); return; }
		if (this.buildHud.mode === 'remove') {
			this.voxels.hideFootprint();
			if (target.hit === 'block') this.voxels.showGhost(target.cell, 'remove');
			else this.voxels.hideGhost();
		} else if (this.buildPiece && target.placeCell) {
			// Preview the whole composite footprint (rotated), tinted by whether it
			// can land in one piece.
			const cells = compositeCells(this.buildPiece, target.placeCell, this.buildRot, this.buildType);
			this.voxels.showFootprint(cells, this.voxels.canPlaceAll(cells, MAX_BLOCKS));
		} else {
			this.voxels.hideFootprint();
			this.voxels.showGhost(target.placeCell, target.placeValid ? 'place' : 'blocked');
		}
	}

	// Re-evaluate the ghost after a mode flip, without waiting for pointer motion.
	_refreshGhost() {
		if (this.buildHud.active && this._lastHover) this._updateGhost(this._lastHover.x, this._lastHover.y);
	}

	// Adopt the server's build-permission snapshot: drive the per-player allowance
	// meter and reveal the creator-only moderation control. Authoritative — the HUD
	// only surfaces what the server already enforces.
	_onBuildPerms(p) {
		if (!p || typeof p !== 'object') return;
		this._buildPerms = {
			creator: !!p.creator,
			cap: Number(p.cap) || 0,
			used: Number(p.used) || 0,
			clearMaxRadius: Number(p.clearMaxRadius) || 12,
		};
		this.buildHud.setCreator(this._buildPerms.creator);
		this.buildHud.setUsage(this._buildPerms.used, this._buildPerms.cap);
		// R24: the same server-proven creator flag reveals the holder-gate control.
		this.ui.setWorldCreator(this._buildPerms.creator);
	}

	// Clear the per-player meter + creator tool — on leave and on every (re)connect,
	// before fresh perms arrive, so a solo build or a different world never inherits
	// the last one's allowance or moderation control.
	_resetBuildPerms() {
		this._buildPerms = { creator: false, cap: 0, used: 0, clearMaxRadius: 12 };
		this.buildHud.setCreator(false);
		this.buildHud.setUsage(0, 0);
		this.ui.setWorldCreator(false);
	}

	// Creator gate config (R24): open the modal to set or clear the token threshold
	// a wallet must hold to enter this coin's Holders world. Reads the current value
	// first so the input is pre-filled, then writes through the creator-only
	// endpoint (which re-verifies ownership server-side). Only the coin's verified
	// creator ever reaches this — the button is hidden otherwise.
	async _configureGate() {
		const coin = this.coin;
		if (!coin?.mint) return;
		let current = 0;
		let unknown = false;
		try {
			const cfg = await getWorldGate(coin.mint);
			current = cfg?.minTokens || 0;
		} catch {
			// Couldn't read the current gate — open in an "unknown" state so the creator
			// can still overwrite or remove it, rather than a blank form that wrongly
			// implies the world is ungated. The save validates server-side regardless.
			unknown = true;
		}
		this.ui.openGateConfig(coin, {
			minTokens: current,
			unknown,
			onSave: async (minTokens) => {
				const saved = await setWorldGate(coin.mint, minTokens);
				const next = saved?.minTokens || 0;
				// Keep the in-world Holders badge honest without tearing down the HUD.
				if (this.coin) {
					this.coin = { ...this.coin, holderMinTokens: next };
					this.ui.refreshTierBadge(this.coin);
				}
				return saved;
			},
		});
	}

	// Creator moderation: clear a disc of blocks around where the player stands, or
	// the whole world. Both are confirmed (a clear is destructive) and validated again
	// server-side. Maps the avatar's world position to the build grid for the area
	// sweep; the radius is the server-advertised maximum so the tool's reach is honest.
	_onClearArea(scope) {
		if (!this._buildPerms.creator || this.net?.status !== 'online') {
			this.ui.toast('Clearing builds needs a live connection as the coin creator.', 'warn');
			return;
		}
		if (scope === 'all') {
			if (typeof confirm === 'function' && !confirm('Clear EVERY block in this world? This can\u2019t be undone.')) return;
			this.net.sendClearAll();
			return;
		}
		const r = this._buildPerms.clearMaxRadius || 12;
		if (typeof confirm === 'function' && !confirm(`Clear all blocks within ${r} cells of where you stand?`)) return;
		const gx = Math.round(this.localPos.x / BLOCK);
		const gz = Math.round(this.localPos.z / BLOCK);
		this.net.sendClearArea(gx, gz, r);
	}

	_onBuildToggle(on) {
		// The structures toolbar (composite pieces + rotate + share + featured) lives
		// or dies with build mode.
		this.ui.setBuildToolsVisible(on);
		this.ui.setPropPaletteVisible(on);
		if (!on) {
			this.voxels?.hideGhost(); this.voxels?.hideFootprint();
			this.propGhost?.hide(); this.canvas.style.cursor = '';
			return;
		}
		const touch = typeof matchMedia === 'function' && matchMedia('(hover: none), (pointer: coarse)').matches;
		const solo = this.net?.status !== 'online';
		const how = touch
			? 'tap to place, hold to break, pick a block, ⌘/Ctrl+Z to undo'
			: 'click to place, right-click to break, 1–0 pick a block, R rotates pieces, ⌘/Ctrl+Z to undo';
		this.ui.toast(`Build mode${solo ? ' (offline — reconnect to share)' : ''} — ${how}`, 'info');
		this._syncBudget();
		if (this._lastHover) this._updateGhost(this._lastHover.x, this._lastHover.y);
	}

	// ---------------------------------------------------------------- share builds
	// Render the current view into an offscreen target and return a JPEG data URL +
	// dimensions, or null if capture isn't possible. Uses a render target (not the
	// live canvas) so it works regardless of preserveDrawingBuffer, and downscales
	// to keep the thumbnail small enough to persist and share.
	_captureBuildShot(maxW = 720) {
		const r = this.renderer;
		if (!r || !this.scene || !this.camera) return null;
		const size = r.getSize(new Vector2());
		if (size.x < 1 || size.y < 1) return null;
		const scale = Math.min(1, maxW / size.x);
		const w = Math.max(1, Math.round(size.x * scale));
		const h = Math.max(1, Math.round(size.y * scale));
		let rt = null;
		try {
			rt = new WebGLRenderTarget(w, h, { samples: 4 });
			rt.texture.colorSpace = SRGBColorSpace;
			const prev = r.getRenderTarget();
			r.setRenderTarget(rt);
			r.render(this.scene, this.camera);
			const buf = new Uint8Array(w * h * 4);
			r.readRenderTargetPixels(rt, 0, 0, w, h, buf);
			r.setRenderTarget(prev);
			const c = document.createElement('canvas');
			c.width = w; c.height = h;
			const ctx = c.getContext('2d');
			const img = ctx.createImageData(w, h);
			// WebGL's origin is bottom-left; flip rows so the image isn't upside down.
			for (let y = 0; y < h; y++) {
				const src = (h - 1 - y) * w * 4;
				img.data.set(buf.subarray(src, src + w * 4), y * w * 4);
			}
			ctx.putImageData(img, 0, 0);
			return { dataUrl: c.toDataURL('image/jpeg', 0.72), width: w, height: h };
		} catch (err) {
			log.warn('[coincommunities] build capture failed:', err?.message);
			return null;
		} finally {
			rt?.dispose();
		}
	}

	// Capture a screenshot of the build and open the share sheet: copy a deep link,
	// download the image, or publish it to this coin's featured builds.
	_shareBuild() {
		if (this.phase !== 'world' || !this.coin) return;
		const shot = this._captureBuildShot();
		if (!shot) { this.ui.toast('Couldn’t capture the view — try again.', 'warn'); return; }
		const link = this._coinShareLink();
		const blocks = this.voxels?.count ?? 0;
		this.ui.openShareSheet({
			image: shot.dataUrl,
			link,
			blocks,
			coinName: this.coin.symbol ? '$' + this.coin.symbol : (this.coin.name || 'this world'),
			canPublish: blocks > 0,
		});
	}

	// A shareable deep link back into this exact community.
	_coinShareLink() {
		const q = new URLSearchParams({ coin: this.coin.mint });
		if (this.coin.name) q.set('name', this.coin.name);
		if (this.coin.symbol) q.set('symbol', this.coin.symbol);
		if (this.coin.image) q.set('image', this.coin.image);
		return `${location.origin}/play?${q.toString()}`;
	}

	// Publish the captured build to this coin's featured surface via the R17
	// persistence-backed endpoint. Returns a result the share sheet renders inline.
	async _publishBuild({ image, title }) {
		if (!this.coin?.mint) return { ok: false, error: 'No world to publish to.' };
		const author = this.ui.getName() || (this.account ? this.account.slice(0, 4) + '…' + this.account.slice(-4) : 'anon');
		try {
			const res = await fetch('/api/play/builds', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					mint: this.coin.mint,
					title: (title || '').trim().slice(0, 60),
					author: author.slice(0, 32),
					blocks: this.voxels?.count ?? 0,
					thumb: image,
				}),
			});
			if (!res.ok) {
				const reason = res.status === 429 ? 'Sharing too fast — give it a minute.'
					: res.status === 413 ? 'That screenshot was too large to share.'
					: `Couldn’t publish (error ${res.status}).`;
				return { ok: false, error: reason };
			}
			// A fresh publish belongs at the top of the featured list — refresh if open.
			if (this._featuredOpen) this._loadFeatured();
			return { ok: true };
		} catch (err) {
			log.warn('[coincommunities] publish build failed:', err?.message);
			return { ok: false, error: 'Network error — check your connection and retry.' };
		}
	}

	// Open this coin's featured builds surface and load it.
	_openFeatured() {
		if (!this.coin?.mint) return;
		this._featuredOpen = true;
		this.ui.openFeatured(this.coin.symbol ? '$' + this.coin.symbol : (this.coin.name || 'this world'));
		this._loadFeatured();
	}

	async _loadFeatured() {
		const mint = this.coin?.mint;
		if (!mint) return;
		this.ui.setFeaturedLoading();
		try {
			const res = await fetch(`/api/play/builds?mint=${encodeURIComponent(mint)}`, { headers: { accept: 'application/json' } });
			if (!res.ok) throw new Error('HTTP ' + res.status);
			const data = await res.json();
			this.ui.setFeaturedBuilds(Array.isArray(data?.builds) ? data.builds : []);
		} catch (err) {
			log.warn('[coincommunities] featured load failed:', err?.message);
			this.ui.setFeaturedError(() => this._loadFeatured());
		}
	}

	_initJoystick() {
		const zone = document.getElementById('cc-joystick');
		if (!zone || this._joyInit) return;
		this._joyInit = true;
		// Self-contained pointer-events joystick — no external lib, so the input
		// contract can never drift. Responds to BOTH touch and mouse-drag, so the
		// world is playable without a keyboard and verifiable on desktop. Desktop
		// also keeps WASD; the two intents simply sum in _stepLocal.
		const base = document.createElement('div');
		base.className = 'cc-joy-base';
		const thumb = document.createElement('div');
		thumb.className = 'cc-joy-thumb';
		base.appendChild(thumb);
		zone.appendChild(base);

		const RADIUS = 48; // px the thumb can travel from center before clamping
		let activeId = null;

		const setFromPointer = (clientX, clientY) => {
			const r = base.getBoundingClientRect();
			const cx = r.left + r.width / 2;
			const cy = r.top + r.height / 2;
			let dx = (clientX - cx) / RADIUS;
			let dy = (clientY - cy) / RADIUS;
			const m = Math.hypot(dx, dy);
			if (m > 1) { dx /= m; dy /= m; } // clamp to the unit circle
			thumb.style.transform = `translate(${dx * RADIUS}px, ${dy * RADIUS}px)`;
			const mag = Math.min(1, m);
			if (mag < JOY_DEADZONE) { this._joy = null; return; } // swallow drift
			const k = (mag - JOY_DEADZONE) / (1 - JOY_DEADZONE) / mag; // remap past deadzone
			// Screen-down (+dy) is "toward camera" = backward, so z = +dy.
			this._joy = { x: dx * k, z: dy * k };
		};
		const release = () => {
			activeId = null;
			this._joy = null;
			thumb.style.transform = 'translate(0px, 0px)';
			zone.classList.remove('cc-joy-active');
		};

		zone.addEventListener('pointerdown', (e) => {
			activeId = e.pointerId;
			zone.setPointerCapture(e.pointerId);
			zone.classList.add('cc-joy-active');
			setFromPointer(e.clientX, e.clientY);
			e.preventDefault();
		});
		zone.addEventListener('pointermove', (e) => {
			if (e.pointerId !== activeId) return;
			setFromPointer(e.clientX, e.clientY);
			e.preventDefault();
		});
		const onUp = (e) => { if (e.pointerId === activeId) release(); };
		zone.addEventListener('pointerup', onUp);
		zone.addEventListener('pointercancel', onUp);
		zone.addEventListener('lostpointercapture', onUp);
	}

	// ---------------------------------------------------------------- loop
	_loop() {
		requestAnimationFrame(this._loop);
		const now = performance.now();
		const dt = Math.min(0.05, (now - this._last) / 1000);
		this._last = now;

		if (this.phase === 'world') {
			// W02: while driving, the vehicle IS the local player's movement — skip
			// the on-foot character step (it would fight the car for localPos every
			// frame) and let VehicleManager feed this frame's throttle/steer/brake
			// into the Rapier vehicle controller instead.
			const driving = this.vehicles?.isDriving();
			if (driving) this.vehicles.tick(dt);
			else { this._stepLocal(dt); this.vehicles?.tick(dt); }
			// Step the Rapier world AFTER _stepLocal/vehicle input so it consumes the
			// character's queued kinematic move (or the vehicle's driver intent) from
			// this same frame, and advances every kinematic ghost of a remote vehicle.
			if (this._physicsOk && this._physics) this._physics.step(dt);
			// Read back the vehicle's post-step transform (mesh, camera, seat, HUD,
			// netcode) now that the world has actually advanced.
			if (driving) this.vehicles.postStep(dt);
			this._checkFloorOccupancy();
			this.localAnim?.update(dt);
			this.localCosmetics?.tick(dt);
			for (const [, r] of this.remotes) r.tick(dt);
			this.worldObjects?.update();
			this._updateLabels();
			this._tickKingZone(dt);
			this._updateVoice();
			this.playSystems?.tick(dt);
			this.playActivities?.tick(dt);
			this.wheelStation?.tick(dt);
			this.agentCommerce?.tick(dt);
			this.intelKiosk?.tick(dt);
			if (this.worldLife) { this.worldLife.setRealPeers(this.remotes.size); this.worldLife.tick(dt); }
			this.combat?.tick(dt);
			// Ordinary move sync is redundant (and would just get rejected by the
			// server's walking-speed step clamp) while driving — VehicleManager
			// streams the authoritative transform itself via sendVSync.
			if (this.net && !driving) this.net.sendMove({ x: this.localPos.x, y: this.localPos.y, z: this.localPos.z, yaw: this.localYaw, motion: this.motion });
			// Gamepad: north button (Y/△, 3) opens the emote wheel; once open, the left
			// stick steers and the south button (A/✕, 0) plays the selected clip. Edge-
			// detect the open button so holding it doesn't reopen on the frame it closes.
			const gp = navigator.getGamepads?.()[0];
			if (gp) {
				const openBtn = gp.buttons[3]?.pressed ?? false;
				if (openBtn && !this._ewPadOpenPrev && !this.ui.emoteWheelOpen && !this.buildHud.active) {
					this.ui.openEmoteWheel();
				}
				this._ewPadOpenPrev = openBtn;
				if (this.ui.emoteWheelOpen) {
					this.ui.ewGamepadTick(gp.axes[0] ?? 0, gp.axes[1] ?? 0, gp.buttons[0]?.pressed ?? false, gp.buttons[1]?.pressed ?? false);
				}
			}
		}
		this._tickEnv(dt);
		this._updateCamera(dt);
		this.renderer.render(this.scene, this.camera);
	}

	// Kick the avatar into the air. Ignored while already airborne so a held key
	// can't pogo. Replicated to peers via the y we stream in _loop's sendMove.
	_jump() {
		if (this.phase !== 'world' || !this.grounded) return;
		this.vy = JUMP_VELOCITY;
		this.grounded = false;
	}

	_stepLocal(dt) {
		// Build intent from keys + joystick, relative to camera yaw.
		let ix = 0, iz = 0;
		if (this.keys.has('w') || this.keys.has('arrowup')) iz -= 1;
		if (this.keys.has('s') || this.keys.has('arrowdown')) iz += 1;
		if (this.keys.has('a') || this.keys.has('arrowleft')) ix -= 1;
		if (this.keys.has('d') || this.keys.has('arrowright')) ix += 1;
		if (this._joy) { ix += this._joy.x; iz += this._joy.z; }
		const running = this.keys.has('shift');
		const mag = Math.hypot(ix, iz);
		const moving = mag > 0.05;
		let wx = 0, wz = 0;
		if (moving) {
			const nx = ix / Math.max(1, mag), nz = iz / Math.max(1, mag);
			// Map intent into world space using the camera's own basis so the
			// keys read screen-relative: forward (W/up) goes straight away from
			// the camera, D/right tracks screen-right. Camera forward is
			// (sinYaw, cosYaw) and camera-right is (cosYaw, -sinYaw) — see
			// _updateCamera. world = ix*right + (-iz)*forward.
			const sin = Math.sin(this.camYaw), cos = Math.cos(this.camYaw);
			wx = nx * cos - nz * sin;
			wz = -nx * sin - nz * cos;
			this.localYaw = Math.atan2(wx, wz);
			const want = running ? 'run' : 'walk';
			if (this.motion !== want) { this.motion = want; this.localAnim?.crossfadeTo(CLIP_WALK, 0.18); }
		} else if (this.motion !== 'idle') {
			this.motion = 'idle'; this.localAnim?.crossfadeTo(CLIP_IDLE, 0.2);
		}
		// Drive the walk cycle faster while sprinting so it reads as a run.
		if (this.localAnim?.currentName === CLIP_WALK) {
			this.localAnim.setSpeed(this.motion === 'run' ? RUN_TIMESCALE : 1);
		}

		const speed = running ? RUN_SPEED : MOVE_SPEED;
		// W01: the Rapier kinematic character controller is authoritative for
		// collision (district buildings, ground) once physics has booted; it
		// slides along walls, steps up curbs, and reports real ground contact
		// instead of the flat y<=0 assumption the legacy path used. physics.step()
		// (called from _loop, after this) consumes the queued move.
		if (this._physicsOk && this._character) {
			if (!this._physicsActivePrev) {
				this._character.setPosition({ x: this.localPos.x, y: this.localPos.y, z: this.localPos.z });
				this.vy = 0;
				this._physicsActivePrev = true;
			}
			this.vy -= GRAVITY * dt;
			if (this.vy < -40) this.vy = -40; // terminal velocity guard
			const res = this._character.move({
				x: moving ? wx * speed * dt : 0,
				y: this.vy * dt,
				z: moving ? wz * speed * dt : 0,
			});
			this.grounded = res.grounded;
			if (this.grounded && this.vy < 0) this.vy = 0;
			// Boundary safety — mirrors the server's square WORLD_BOUND clamp
			// (world-zones.js DISTRICT.half) so client and server never disagree
			// on the world's edge. Snap the body too so the next query starts clean.
			const clamped = clampToBounds(res.position.x, res.position.z);
			if (clamped.x !== res.position.x || clamped.z !== res.position.z) {
				this._character.setPosition({ x: clamped.x, y: res.position.y, z: clamped.z });
			}
			this.localPos.set(clamped.x, res.position.y, clamped.z);
		} else {
			this._physicsActivePrev = false;
			// Legacy direct-mutation fallback — only live for the brief window
			// before Rapier's WASM finishes loading (or if it fails to load at all).
			if (!this.grounded) {
				this.vy -= GRAVITY * dt;
				this.localPos.y += this.vy * dt;
				if (this.localPos.y <= 0) { this.localPos.y = 0; this.vy = 0; this.grounded = true; }
			}
			if (moving) {
				this.localPos.x += wx * speed * dt;
				this.localPos.z += wz * speed * dt;
				const clamped = clampToBounds(this.localPos.x, this.localPos.z);
				this.localPos.x = clamped.x; this.localPos.z = clamped.z;
			}
		}

		if (this.localRig) { this.localRig.position.copy(this.localPos); this.localRig.rotation.y = this.localYaw; }
		this._checkBallKick();
	}

	// R05: detect when the local player walks into the physics ball and send a kick
	// intent. The impulse is derived from the player's current heading and speed so
	// walking fast hits harder than ambling into it. The server is authoritative:
	// it validates magnitude, clamps the total speed, and integrates the physics.
	_checkBallKick() {
		if (!this.net || !this.worldObjects || this.motion === 'idle') return;
		const now = performance.now();
		if (now - this._lastKick < 320) return; // ~3 kicks/sec, matching server limit

		// Locate the ball by kind (there is exactly one per room).
		let ballEntry = null;
		for (const [, e] of this.worldObjects.entries) {
			if (e.kind === 'ball') { ballEntry = e; break; }
		}
		if (!ballEntry) return;

		const dx = ballEntry.tx - this.localPos.x;
		const dz = ballEntry.tz - this.localPos.z;
		if (Math.hypot(dx, dz) > 1.4) return; // not within kick range

		// Impulse: player's forward direction scaled by movement speed.
		const speed = this.motion === 'run' ? RUN_SPEED : MOVE_SPEED;
		const STRENGTH = Math.min(speed * 1.8, 14);
		const vx = Math.sin(this.localYaw) * STRENGTH;
		const vy = 3.2; // always pop the ball upward
		const vz = Math.cos(this.localYaw) * STRENGTH;

		this._lastKick = now;
		this.net.sendBallKick(vx, vy, vz);
	}

	// Feed the voice engine each frame: where the listener is (local avatar),
	// which way they're facing (camera forward, so left/right panning matches the
	// view), and every peer's live position + voice state.
	_updateVoice() {
		if (!this.voice) return;
		const peers = [];
		for (const [id, r] of this.remotes) {
			peers.push({ id, x: r.rig.position.x, y: r.rig.position.y, z: r.rig.position.z, voice: r.voice });
		}
		// Camera forward on the ground plane is (sin camYaw, cos camYaw) — see
		// _updateCamera, where the camera sits opposite this vector from the target.
		const forward = { x: Math.sin(this.camYaw), z: Math.cos(this.camYaw) };
		this.voice.update({ x: this.localPos.x, y: this.localPos.y, z: this.localPos.z }, peers, forward);
	}

	// W01: four-mode chase camera (follow/cinematic/firstperson/topdown) via the
	// shared camera-modes.js controller — see the constructor and the 'c' key in
	// _bindInput. 'follow' reproduces the original fixed orbit exactly, so the
	// default view is unchanged; the other three are new.
	_updateCamera(dt) {
		this._camTarget = this._camTarget || new Vector3();
		// Track the avatar on the ground plane only in follow/cinematic/topdown —
		// ignore jump height so those cameras stay planted while the character
		// hops. First person tracks the real (jump-inclusive) height for the eye.
		const inWorld = this.phase === 'world' && this.localRig;
		const fp = this._camModes.isFirstPerson();
		const target = inWorld
			? this._camTarget.set(this.localPos.x, fp ? this.localPos.y : 0, this.localPos.z)
			: this._camTarget.set(0, 2, 0);
		this._camModes.tick(dt || 0);
		this._camModes.apply(this.camera, target, this.localHeight || 1.7, {
			// First person looks where the avatar faces (localYaw); every other
			// mode orbits on the mouse-drag yaw (camYaw).
			yaw: fp ? this.localYaw : this.camYaw,
			pitch: this.camPitch, dist: this.camDist,
		});
		if (this.localRig) this.localRig.visible = !fp;
	}

	_updateLabels() {
		const w = this.renderer.domElement.clientWidth, h = this.renderer.domElement.clientHeight;
		const place = (node, pos, dy) => {
			const v = new Vector3(pos.x, pos.y + dy, pos.z).project(this.camera);
			if (v.z > 1 || v.z < -1) { node.style.display = 'none'; return; }
			node.style.display = '';
			node.style.transform = `translate(-50%, -100%) translate(${(v.x * 0.5 + 0.5) * w}px, ${(-v.y * 0.5 + 0.5) * h}px)`;
		};
		// Anchor name + bubble to each avatar's real head height so they sit just
		// above the head regardless of how tall/short the GLB is.
		for (const [, r] of this.remotes) {
			place(r.label, r.rig.position, r.height + 0.2);
			if (r.bubble) place(r.bubble, r.rig.position, r.height + 0.7);
			if (r._itLabel) place(r._itLabel, r.rig.position, r.height + 0.65);
		}
		if (this._localBubble && this.localRig) place(this._localBubble, this.localPos, (this.localHeight || 1.7) + 0.7);
		if (this._localItLabel && this.localRig) place(this._localItLabel, this.localPos, (this.localHeight || 1.7) + 0.65);
	}

	_onResize() {
		this.camera.aspect = window.innerWidth / window.innerHeight;
		this.camera.updateProjectionMatrix();
		this.renderer.setSize(window.innerWidth, window.innerHeight);
	}
}

// Swap the boot loader for an actionable error state. The scene constructor
// builds the renderer, scene, and HUD synchronously, so any failure there (most
// often WebGL being unavailable) would otherwise leave the player staring at a
// loader that never resolves. This replaces the spinner with a clear message and
// a recovery path instead of a dead screen.
function renderBootError(err) {
	log.error('[coincommunities] boot failed:', err);
	const noWebGL = err?.code === 'NO_WEBGL' || /webgl|context/i.test(err?.message || '');

	let overlay = document.getElementById('kx-loading');
	if (!overlay) {
		overlay = document.createElement('div');
		overlay.id = 'kx-loading';
		document.body.appendChild(overlay);
	}
	overlay.classList.remove('kx-hidden');
	overlay.replaceChildren();

	// The boot avatar's render loop targets a canvas we're about to remove — stop
	// it so it doesn't tick against a detached element.
	try { window.__ccBootAvatar?.dispose?.(); } catch { /* best-effort teardown */ }

	const card = document.createElement('div');
	card.className = 'kx-loading-card kx-boot-error';
	card.setAttribute('role', 'alert');

	const mark = document.createElement('div');
	mark.className = 'kx-loading-mark';
	mark.textContent = noWebGL ? 'WebGL unavailable' : 'Couldn’t load the world';
	card.appendChild(mark);

	const msg = document.createElement('p');
	msg.className = 'kx-boot-error-msg';
	msg.textContent = noWebGL
		? 'Your browser couldn’t start 3D graphics. Turn on hardware acceleration (or WebGL) and reload — on most browsers it’s under Settings › System.'
		: 'Something went wrong starting Coin Communities. Reload to try again — if it keeps happening, your browser may be out of date.';
	card.appendChild(msg);

	const actions = document.createElement('div');
	actions.className = 'kx-boot-error-actions';

	const retry = document.createElement('button');
	retry.type = 'button';
	retry.className = 'kx-boot-error-btn';
	retry.textContent = 'Try again';
	retry.addEventListener('click', () => location.reload());
	actions.appendChild(retry);

	const home = document.createElement('a');
	home.className = 'kx-boot-error-link';
	home.href = '/';
	home.textContent = 'Back to three.ws';
	actions.appendChild(home);

	card.appendChild(actions);
	overlay.appendChild(card);
	retry.focus();
}

const canvas = document.getElementById('kx-canvas') || document.getElementById('cc-canvas');
if (canvas) {
	try {
		const game = new CoinCommunities(canvas);
		if (typeof window !== 'undefined') window.__CC__ = game;
	} catch (err) {
		renderBootError(err);
	}
}
