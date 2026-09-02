// Coin Communities, 3D metaverse client (the /play scene).
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
	Scene, WebGLRenderer, PerspectiveCamera, Group, Vector3, SRGBColorSpace,
	Mesh, MeshStandardMaterial, MeshBasicMaterial, CircleGeometry, RingGeometry,
	CylinderGeometry, PlaneGeometry,
	TextureLoader, DoubleSide,
	PointLight,
	Raycaster, Vector2,
} from 'three';

import { captureSceneCanvas } from './scene-capture.js';
import { AnimationManager } from '../animation-manager.js';
import { CommunityNet } from './community-net.js';
import { CommunityUI } from './coincommunities-ui.js';
import { createWorldEnvironment, seedFromString } from './world-env.js';
import { createDistrict } from './district.js';
import { DISTRICT, clampToBounds } from './world-zones.js';
import { PhysicsWorld } from '../physics/physics-world.js';
import { detectProfile, createFrameWatchdog } from '../club-perf.js';
import { applyCinematicDefaults, loadEnvironment } from '../shared/cinematic-render.js';
import {
	createFrameGovernor, trackWindowFocus, getPowerSaver, onPowerSaverChange,
	FPS_ACTIVE, FPS_IDLE, FPS_SAVER,
} from '../shared/frame-governor.js';
import { createDayNightCycle } from './day-night.js';
import { worldClock } from '../shared/world-clock.js';
import { createCameraModeController, CAMERA_MODE_LABELS, CAMERA_MODE_FOV } from './camera-modes.js';
import { createChartScreen } from './chart-screen.js';
import { makeScreenCanvas, makeScreenTexture, screenMaterial, screenAnisotropy } from './screen-texture.js';
import { mountOracleRibbon } from './oracle-ribbon.js';
import { MarketReactor } from './market-reactor.js';
import {
	VoxelWorld, createBuildHud, parseKey, keyOf, MAX_BLOCKS, BLOCK,
	COMPOSITE_PIECES, compositeCells,
} from './build-voxels.js';
import { WorldObjects, PropGhost, propDef, registerUploadedProp } from './world-objects.js';
// P3.1: durable per-world build persistence (Postgres index + R2 blob), the same
// store the authoritative room writes through. See src/game/world-persist.js for
// which side is the writer when.
import { WorldBuildStore, worldIdForCoin, docObjects } from './world-persist.js';
import {
	MAX_WORLD_OBJECTS, MAX_OBJECTS_PER_PLAYER, OBJ_SCALE_MIN, OBJ_SCALE_MAX,
	buildClearRadius,
} from '../../multiplayer/src/build-limits.js';
import { proxiedImageURL } from '../ipfs.js';
import {
	loadManifest, getEmoteDefs, getAllEmoteDefs, resolveAvatarUrl, buildAvatar, releaseAvatar, playEmoteClip,
	crossfadeToMotion, CLIP_IDLE, CLIP_WALK,
} from './avatar-rig.js';
import { GUEST_SENTINEL, uploadPendingGuestAvatar, getPlayCosmetics, setPlayCosmetics, setPlayAvatar } from './play-handoff.js';
import { AvatarSwitcher } from './avatar-switcher.js';
import { getPresenceTicket, friendsClient } from '../friends.js';
import { getMe } from '../account.js';
import { showPlayIntro, makeIntroReopener } from './play-intro.js';
import { applyLoadout } from './cosmetics-loadout.js';
import { serializeLoadout, getCosmetic } from '../../multiplayer/src/cosmetics-catalog.js';
import { AccessoryManager } from '../agent-accessories.js';
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
import { requestHolderPass, signInWithX, ensureSolanaWallet, relinkSolanaWallet, getSession, getWorldGate, setWorldGate } from '../community/town-auth.js';
import { ensurePlayAccess } from './play-gate.js';
import { hasOpenOverlay } from './a11y.js';
import { clearStoredPass, refreshPlayPass, loadStoredPass, storePass } from './play-auth.js';
import { PlaySystems } from './play-systems.js';
import { PlayActivities } from './play-activities.js';
import { WheelStation } from './wheel-station.js';
import { WarPortal } from './war-portal.js';
import { PlayOnboard } from './play-onboard.js';
import { log } from '../shared/log.js';
import { openAvatarInspector, isAvatarInspectorOpen, closeAvatarInspector } from '../shared/avatar-inspector.js';
import { createAgentDesk } from './agent-desk.js';
import { VehicleManager } from './vehicles.js';
import { CombatSystem } from './combat-system.js';

// localStorage throws in private mode and in third-party iframe contexts where
// storage is blocked, exactly the `?bg=transparent` embed case (e.g. the IBM
// x402 showcase). Guard every access so a blocked store degrades to defaults
// instead of throwing mid-boot. Same contract as the lsGet/lsSet helpers in
// play-onboard.js / play-intro.js / play-handoff.js.
function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch { /* storage disabled */ } }

// Normalise one deep-link query parameter for display. A /play link is shared
// between strangers, so `coin`, `name` and `symbol` are arbitrary attacker text.
// They are only ever written with textContent (never innerHTML), so markup in
// them is inert; what still needs handling is shape. Line breaks and control
// characters would rewrap the HUD around a value the sender chose, and an
// unbounded length would push the coin banner off screen, so both are removed
// here and the result is cut to the same limit the room server enforces.
function clampParam(value, max) {
	return String(value ?? '')
		.replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029\u202a-\u202e]+/g, ' ')
		.trim()
		.slice(0, max);
}

// A mint we are willing to open a world for: a Solana base58 address (pump.fun
// mints, including $THREE) or an EVM 0x address (Robinhood Chain coins). Anything
// else came from a typo or a mangled share link, and building a full world for it
// is worse than saying so: the player would get a real district, a totem reading
// "COMMUNITY", a room keyed on garbage, and a build layer no other player will
// ever see, with nothing anywhere telling them the link was broken.
const SOLANA_MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
function isPlausibleMint(mint) {
	const v = String(mint || '').trim();
	return SOLANA_MINT_RE.test(v) || EVM_ADDRESS_RE.test(v);
}

// True when the keystroke belongs to an editable surface, a DM input in the
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

// Enter and Space are the browser's activation gesture for whatever control has
// focus. Binding them globally to "open chat" and "jump" meant a keyboard-only
// player could Tab to Shop, Friends, or any emote button and press Enter, and
// the world would swallow it, so the button never fired and the HUD was
// reachable but not operable. Every other hotkey (WASD, E, Q, Z…) still runs
// while a control is focused, because movement has to keep working; only the
// two activation keys defer to the focused control.
const ACTIVATION_TARGET = 'button,a[href],select,summary,[role="button"],[role="tab"],[role="menuitem"],[role="switch"],[role="checkbox"],[role="option"]';
function isActivationTarget(t) {
	if (!t || t.nodeType !== 1) return false;
	return !!t.closest?.(ACTIVATION_TARGET);
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

// The Downtown plaza radius (matches world-zones.js DISTRICT.plazaRadius), the
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
// Longest the canvas may hold its last frame while shaders pre-compile
// (_warmShaders), and how long after world entry the render-tier watchdog stays
// out of the way (_loop). See each for why.
const WARM_TIMEOUT_MS = 1200;
const WATCHDOG_GRACE_MS = 3000;
// Past this ground distance a peer's nameplate is a couple of unreadable pixels,
// so it isn't projected or written to the DOM at all. Bounds the per-frame label
// cost by how many people are NEAR you, not by how many are in the world.
const LABEL_RANGE_M = 60;
// Animation LOD thresholds for remote players (see RemotePlayer.tick). Inside
// 22m a peer fills enough of the screen that anything less than full rate is
// visible, so that band is never stepped down; past 55m a peer is a silhouette
// and 6fps of skeleton is indistinguishable from 60. Squared to keep the
// per-peer test to a multiply, since it runs for every peer every frame.
const ANIM_LOD_NEAR_SQ = 22 * 22;
const ANIM_LOD_FAR_SQ = 55 * 55;
const ANIM_LOD_MID_INTERVAL_S = 1 / 20;
const ANIM_LOD_FAR_INTERVAL_S = 1 / 6;
const JOY_DEADZONE = 0.12; // swallow tiny stick grazes so the avatar doesn't drift
const UNDO_LIMIT = 50; // how many build actions Ctrl/Cmd+Z can walk back
const LONG_PRESS_MS = 420; // hold-to-break threshold for touch (no right-click there)
const TRENDING_URL = '/api/pump/trending?limit=30';
const SEARCH_URL = '/api/pump/search';
const COIN_URL = '/api/pump/coin';

// Normalize a raw pump.fun coin (trending feed or search results, both share
// the same upstream shape) into the compact record the lobby/world consume.
// Delivered width for coin art fetched through the image proxy.
const COIN_ART_WIDTH = 512;

function mapCoins(raw) {
	const list = Array.isArray(raw) ? raw : raw.data || raw.coins || raw.items || [];
	return list.map((c) => ({
		mint: c.mint || c.address,
		name: (c.name || '').trim() || 'Unnamed coin',
		symbol: (c.symbol || '').trim(),
		// Coin art becomes a WebGL texture a few hundred pixels tall. 512 is
		// generous for that and keeps a creator's full-size upload out of both
		// the download and GPU memory.
		image: proxiedImageURL(c.image_uri || c.image || c.imageUri || c.logo || '', c.mint || c.address || '', { width: COIN_ART_WIDTH }),
		marketCap: c.usd_market_cap || c.market_cap_usd || c.marketCap || 0,
	})).filter((c) => c.mint);
}

// How long a bare deep link waits for the coin's identity before it gives up and
// builds the world anyway. Entry already has the sign-in gate, the manifest and
// an avatar GLB ahead of it, so this is the one place a slow upstream must never
// be allowed to hold the player on a loading screen.
const COIN_IDENTITY_TIMEOUT_MS = 6000;

// Fill in whatever a shared world link did not carry. The name/symbol/image on
// /play?coin=<mint>&name=…&symbol=…&image=… are decoration the sharer's client
// appended, and they go missing constantly: a hand-typed link, a chat client
// that truncated the query, an unfurl that kept only the mint. The mint alone
// still identifies the coin exactly, so a link without the decoration must build
// the same world as a link with it, not a nameless one titled "Community".
//
// Only blanks are filled: anything the link did carry is what every peer on that
// link already sees, so it stays authoritative here even if the feed disagrees.
function mergeCoinIdentity(coin, fetched) {
	if (!fetched) return coin;
	return {
		...coin,
		name: coin.name || fetched.name || '',
		symbol: coin.symbol || fetched.symbol || '',
		image: coin.image || fetched.image || '',
		marketCap: coin.marketCap || fetched.marketCap || 0,
	};
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

		// Public identity riding the server schema, who this peer is (name), the
		// three.ws agent they pilot, their verified account wallet, and their
		// verified three.ws username (W10, bound server-side from the signed
		// presence ticket). These feed the avatar inspector (I / click a
		// nameplate), never invented client-side.
		this.name = player.name || 'guest';
		this.agent = player.agent || '';
		this.account = player.account || '';
		this.username = player.username || '';
		this.onInspect = null; // set by CoinCommunities right after construction

		this.label = document.createElement('div');
		this.label.className = 'cc-label';
		// Two spans instead of bare textContent: a verified player's nameplate
		// carries their @handle beside the display name, and both voice (::before)
		// and wanted stars (::after) already occupy the label's pseudo-elements.
		this._nameEl = document.createElement('span');
		this._nameEl.className = 'cc-label-name';
		this._nameEl.textContent = player.name || 'guest';
		this.label.appendChild(this._nameEl);
		this._handleEl = null;
		// The nameplate doubles as the peer's click target: labels are cheap,
		// always visible, and don't need a skinned-mesh raycast. pointer-events is
		// off for .cc-label globally (bubbles must never block the look-drag), so
		// re-enable it just for this element.
		this.label.style.pointerEvents = 'auto';
		this.label.style.cursor = 'pointer';
		this.label.title = 'Inspect this player (I)';
		this.label.addEventListener('click', (e) => { e.stopPropagation(); this.onInspect?.(); });
		this._updateHandleBadge();
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
		// Combat (W07): downed peers lie flat (a lightweight ragdoll, no physics
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
		// rebuild model, clearing the rig takes any worn cosmetics with it, so drop
		// the old handle and re-apply once the new GLB has measured.
		try { this.cosmetics?.dispose(); } catch {}
		this.cosmetics = null;
		this._cosApplied = null;
		// Deref the shared template + free per-rig materials BEFORE the sweep;
		// rig.clear() alone leaks the old model's GPU buffers on every swap.
		releaseAvatar(this.rig);
		this.rig.clear();
		this.anim = new AnimationManager();
		// Tag this load so a slower in-flight GLB can't attach to the rig after the
		// peer disposed or swapped avatars again, otherwise the resolved model
		// lands on a cleared/removed rig (orphaned mesh, or two models at once).
		const token = (this._avatarToken = (this._avatarToken || 0) + 1);
		const anim = this.anim;
		// Locomotion clips only: a room of peers must not each download the whole
		// emote library at join. Emotes still lazy-load on first use (playEmoteClip
		// fetches a missing clip on demand), and the parsed-clip cache makes the
		// idle/walk pair free after the first rig.
		resolveAvatarUrl(url).then((u) => buildAvatar(this.rig, u, anim, { clips: 'locomotion' }).then(({ height }) => {
			if (this._disposed || token !== this._avatarToken) return;
			this.height = height;
			crossfadeToMotion(anim, this.motion, 0);
			this.applyCosmetics();
		})).catch(() => {});
	}
	// Dress this peer in their equipped loadout. Idempotent, re-applies only when
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
	// ragdoll no other part of the client has, an honest, cheap "you're out"
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
	// Verified three.ws identity on the nameplate (W10): the @handle beside the
	// display name marks a signed-in platform account, the signal that clicking
	// opens a real profile you can follow and message, not just a guest card.
	_updateHandleBadge() {
		if (this.username) {
			if (!this._handleEl) {
				this._handleEl = document.createElement('span');
				this._handleEl.className = 'cc-label-handle';
				this.label.appendChild(this._handleEl);
			}
			this._handleEl.textContent = `@${this.username}`;
			this.label.classList.add('cc-verified');
			this.label.title = `View @${this.username}'s profile (I)`;
		} else {
			this._handleEl?.remove();
			this._handleEl = null;
			this.label.classList.remove('cc-verified');
			this.label.title = 'Inspect this player (I)';
		}
	}
	apply(player) {
		this.targetX = player.x; this.targetY = player.y; this.targetZ = player.z; this.targetYaw = player.yaw;
		if (player.name) { this.name = player.name; this._nameEl.textContent = player.name; }
		if (player.agent !== undefined) this.agent = player.agent || '';
		if (player.account !== undefined) this.account = player.account || '';
		if (player.username !== undefined && (player.username || '') !== this.username) {
			this.username = player.username || '';
			this._updateHandleBadge();
		}
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
			crossfadeToMotion(this.anim, this.motion, 0.18);
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
	// `viewer` is the camera position, used only to pick an animation rate. Moving
	// and turning stay per-frame for every peer however far away they are: those
	// are three lerps, and a peer that slides at 12fps reads as broken from any
	// distance. What LOD drops is the expensive half, the skeleton update.
	tick(dt, viewer) {
		this.rig.position.x += (this.targetX - this.rig.position.x) * REMOTE_LERP;
		this.rig.position.y += (this.targetY - this.rig.position.y) * REMOTE_LERP;
		this.rig.position.z += (this.targetZ - this.rig.position.z) * REMOTE_LERP;
		let d = this.targetYaw - this.curYaw;
		while (d > Math.PI) d -= Math.PI * 2;
		while (d < -Math.PI) d += Math.PI * 2;
		this.curYaw += d * 0.2;
		this.rig.rotation.y = this.curYaw;
		if (this.anim.currentName === CLIP_WALK) this.anim.setSpeed(this.motion === 'run' ? RUN_TIMESCALE : 1);
		// Animation LOD. Posing a skinned avatar costs a bone-matrix pass per peer
		// per frame, so a plaza with a live-event crowd in it spends most of its
		// frame budget animating people who are specks on the horizon. Peers near
		// enough to read keep full-rate animation; the rest are stepped down. The
		// elapsed time is accumulated and handed over whole, so a stepped-down peer
		// plays its clip at the correct speed, just in coarser increments, and
		// crossing a threshold never skips or replays motion.
		this._animDue = (this._animDue || 0) + dt;
		const dx = this.rig.position.x - viewer.x;
		const dz = this.rig.position.z - viewer.z;
		const distSq = dx * dx + dz * dz;
		const interval = distSq < ANIM_LOD_NEAR_SQ ? 0
			: distSq < ANIM_LOD_FAR_SQ ? ANIM_LOD_MID_INTERVAL_S
				: ANIM_LOD_FAR_INTERVAL_S;
		if (this._animDue >= interval) {
			this.anim.update(this._animDue);
			this.cosmetics?.tick(this._animDue);
			this._animDue = 0;
		}
	}
	dispose() {
		this._disposed = true;
		try { this.cosmetics?.dispose(); } catch {}
		this._removeGlowRing();
		this._removeItLabel();
		// Free this peer's share of the avatar model before dropping the rig; a
		// join→leave churn cycle used to keep every departed peer's geometry and
		// textures on the GPU for the rest of the session.
		releaseAvatar(this.rig);
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
		this._zen = false;
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

		// Heat control (same system as /club): rAF fires at the display refresh
		// rate, so an uncapped loop on a 120/144Hz panel renders 2-2.4x the
		// frames of a 60Hz one for no visible gain, that alone makes laptops
		// run hot. The governor caps real frame work at 60fps in-world, 30 when
		// the window loses focus, 30 under the shared power-saver preference,
		// and a near-idle trickle while the opaque lobby fully covers the
		// canvas (the arena keeps rendering behind it otherwise, pure waste).
		this._governor = createFrameGovernor();
		this._focus = trackWindowFocus();
		this._powerSaver = getPowerSaver();
		// Boot-time quality tier from real capability signals (deviceMemory,
		// cores, coarse pointer, same detector /club uses), then a watchdog
		// that steps the tier down on sustained slow frames and climbs it
		// back (capped at the booted tier) once frames recover, so a single
		// load-time hitch doesn't pin the pixel ratio low, and the 3D soft,
		// for the whole session. Applied to the renderer in _applyPerfTier.
		this._perfTier = detectProfile();
		this._watchdog = createFrameWatchdog({
			initialTier: this._perfTier,
			onDowngrade: (tier) => {
				this._perfTier = tier;
				this._applyPerfTier();
				log.info('[coincommunities] downgrading render tier to', tier);
			},
			onUpgrade: (tier) => {
				this._perfTier = tier;
				this._applyPerfTier();
				log.info('[coincommunities] recovering render tier to', tier);
			},
		});
		onPowerSaverChange((on) => { this._powerSaver = on; this._applyPerfTier(); });

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
		// seeded biome, so a /play embed on a partner page stays visually consistent
		// with that page. Validated against the biome table; an unknown id is ignored
		// and the normal seeded look is used, so default play is unaffected.
		this._biomePin = new URLSearchParams(location.search).get('biome') || null;

		// True between webglcontextlost and webglcontextrestored (see _bindContextLoss).
		this._contextLost = false;
		// True while _warmShaders holds the canvas to pre-compile programs.
		this._warming = false;
		// When the current world became playable, so _loop can give the render-tier
		// watchdog a grace period over the tail of world entry. Infinity until then:
		// a world that has not opened yet has no frames worth judging.
		this._worldSince = Infinity;
		this._initRenderer();
		this._initScene();

		this.ui = new CommunityUI({
			onEnter: (coin, tier) => this.enter(coin, { tier }).catch((err) => this._onEnterFailed(err)),
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
				resolveAvatarUrl(val)
					.then((u) => this.net?.setAvatar(u))
					// A pick that fails to resolve keeps the current avatar; peers never
					// saw the swap, so there is nothing to roll back.
					.catch((err) => log.warn('[coincommunities] avatar swap failed to resolve:', err?.message));
			},
			onRename: (name) => this._rename(name),
			onBuy: () => this._openBuy(),
			onShop: () => this._toggleShop(),
			onWardrobe: () => this._toggleWardrobe(),
			// In-world avatar switcher: change your look without leaving the world.
			onAvatarPanel: () => this._toggleAvatarPanel(),
			onJobs: () => this._toggleQuests(),
			// Friends panel (W09), presence + DMs across every coin world.
			onFriends: () => this._toggleFriends(),
			// Cold-open intro's zero-friction path, drop straight into the $THREE
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
			// P3.3: bring your own prop: validate, upload, arm it for placement.
			onUploadProp: (file) => this._uploadProp(file),
			// Forge-in-world: generate a brand-new prop from a prompt or photo.
			onForgeProp: (req) => this._forgeProp(req),
			onShareBuild: () => this._shareBuild(),
			onOpenFeatured: () => this._openFeatured(),
			onPublishBuild: (meta) => this._publishBuild(meta),
			onDance: () => this._triggerDance(),
			// Zen mode: strip every overlay for a clean view of the world.
			// Photo mode: capture the world (never the chrome) onto a share card.
			onPhoto: () => this._openPhotoMode(),
			onZen: () => this._setZen(!this._zen),
			onFeaturedClosed: () => { this._featuredOpen = false; },
		});

		// Collaborative building HUD (hotbar + place/break toggle). Hidden until the
		// player is in a world and connected, there's nowhere to build otherwise.
		this.buildType = 0;
		// R20 structures: which composite piece is armed (null = single block) and the
		// quarter-turn rotation (0, 3) applied to it. Both drive the ghost preview.
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
		// Build permissions (R19), refreshed from the server's build-perms snapshot:
		// the player's per-world block cap + usage, and whether they're the coin creator
		// (which unlocks the clear-area moderation tool). Solo builds carry no cap.
		this._buildPerms = this._defaultBuildPerms();
		this.buildHud.root.hidden = true;
		this.buildHud.setEnabled(false);

		this._hideBootLoader();
		this._loadHomeTown();
		this._loadCoins();
		this._bindInput();

		// First-ten-seconds cold open (see play-intro.js header for the audit finding
		// this fixes): a first-time visitor otherwise lands on a bare coin grid with
		// no context and bounces. Shown once per browser; the reopener in the lobby
		// header brings it back any time. NOT shown on a `?coin=<mint>` deep link,
		// that visitor already made their choice (a shared world link) and "Drop in
		// now" would silently redirect them to the $THREE home town instead of the
		// world they clicked into, on top of it already loading behind the modal.
		if (!new URLSearchParams(location.search).get('coin')) {
			showPlayIntro({ onDropIn: () => this._dropIn() });
		}

		this._loop = this._loop.bind(this);
		requestAnimationFrame(this._loop);

		// Wallet-first entry: when the platform has pinned a game token, the sign-in
		// gate stands in front of everything, connect a wallet, sign a nonce, and
		// hold ≥ the floor before any world opens. The verified wallet becomes the
		// account id we carry into every room. When no token is pinned the gate
		// resolves instantly (open /play) and nothing below changes. enter() awaits
		// this, so a deep link still drops in, just after the gate clears.
		this.playPass = '';
		this.account = '';
		this._playReady = this._ensurePlayAccess();

		// Deep link: /play?coin=<mint>&name=&symbol=&image= drops straight into a
		// coin's community, so a community is a shareable URL. An optional
		// `?avatar=<glb|id>` rides along (used by "See in 3D" links) and is shown
		// for this session only, never persisted over the player's saved avatar.
		const p = new URLSearchParams(location.search);
		this._urlAvatar = (p.get('avatar') || '').trim();
		// Capture ?ui= before enter() canonicalises the URL (the share-link
		// rewrite drops unknown params); _restoreZen() reads it at world entry,
		// where the zen preference actually applies.
		this._urlUi = (p.get('ui') || '').trim();
		// Captured for the same reason: a player walking back out of a Coin Wars
		// battle returns on /play?…&war=<matchKey>, and the war portal echoes that
		// result into the world. enter() rewrites the URL before the portal is
		// built, so the key has to be read here or it is gone.
		this._urlWar = clampParam(p.get('war'), 200);
		// Everything past `coin` is decoration a stranger typed into a link they
		// shared: it is display-only, never trusted, and clamped to the exact
		// lengths the room server clamps to (WalkRoom.onCreate) so what this client
		// paints is what every peer will see. Without the clamp a 10 KB `name=`
		// tears the HUD apart locally and is silently truncated for everyone else.
		const mint = clampParam(p.get('coin'), 64);
		if (mint && !isPlausibleMint(mint)) {
			// A malformed mint means the link is broken, not that the world is empty.
			// Say so and leave them in the lobby, where every real world is one tap
			// away, instead of building a convincing world nobody else can join.
			// The toast is the signal; this line is telemetry for a designed path,
			// so it stays below warn level.
			log.info('[coincommunities] ignoring a malformed ?coin= mint:', mint);
			this.ui.toast('That world link looks broken, so we left you in the lobby. Pick a community below.', 'warn');
		} else if (mint) {
			const tier = p.get('tier') === 'holders' ? 'holders' : 'general';
			this.enter({
				mint,
				name: clampParam(p.get('name'), 48),
				symbol: clampParam(p.get('symbol'), 16),
				// proxiedImageURL drops anything that is not a renderable image
				// source (javascript:, data:text/html, an oversized URL), so a hostile
				// `image=` resolves to '' and the world takes its generated art path.
				image: proxiedImageURL(p.get('image') || '', mint),
			}, { tier })
				.catch((err) => this._onEnterFailed(err));
		}
	}

	// Both enter() call sites are fire-and-forget, so a throw mid-build would
	// otherwise wedge the phase at 'loading' behind a half-built world with no
	// feedback. Tear down whatever landed and hand back a working lobby.
	_onEnterFailed(err) {
		log.error('[coincommunities] enter() failed:', err);
		try {
			this.leave();
		} catch (e) {
			// leave() is defensive, but a teardown throw must not mask the lobby reset.
			log.warn('[coincommunities] teardown after failed enter():', e?.message);
			this.phase = 'lobby';
			this.ui?.showLobby?.();
		}
		this.ui?.toast?.('Could not open that world. Try again.', 'warn');
	}

	// W01: boot the shared Rapier world once. A flat ground collider covers the
	// whole district (buildings are added per-coin in enter(), once the district
	// grid is built). Never throws, a WASM failure (unsupported browser, blocked
	// worker) degrades to the legacy direct-mutation movement path instead of
	// wedging boot.
	async _initPhysics() {
		try {
			this._physics = await PhysicsWorld.create({ gravity: { x: 0, y: -GRAVITY, z: 0 } });
			this._physics.addGround(0, DISTRICT.half + 40);
			this._physicsOk = true;
		} catch (err) {
			log.warn('[coincommunities] physics init failed, falling back to legacy movement:', err?.message);
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
			// Designed failure state: the lobby shows its manual-retry error card,
			// so this is expected-path telemetry, not a warning.
			log.info('[coincommunities] coin load failed:', err?.message);
			this.ui.setCoinsError(() => this._loadCoins());
		}
	}

	// The flagship $THREE town is always pinned to the top of the lobby, even when
	// it isn't trending, it's the platform's front door. Show the static identity
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
			log.info('[coincommunities] home town refresh failed:', err?.message);
		}
	}

	// The identity behind a bare `?coin=<mint>` link, read from the same pump.fun
	// record the lobby cards are built from. Never throws and never stalls entry:
	// a miss returns null and the world falls back to its generated art and the
	// generic label, exactly as it did before.
	async _fetchCoinIdentity(mint) {
		// pump.fun's coin lookup is Solana-only, so an EVM world (Robinhood Chain)
		// has nothing to gain from the round trip.
		if (!SOLANA_MINT_RE.test(String(mint || '').trim())) return null;
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), COIN_IDENTITY_TIMEOUT_MS);
		try {
			const r = await fetch(`${COIN_URL}?mint=${encodeURIComponent(mint)}`, {
				headers: { accept: 'application/json' }, signal: ctrl.signal,
			});
			if (!r.ok) throw new Error('HTTP ' + r.status);
			const c = await r.json();
			if (!c || (c.mint && c.mint !== mint)) return null;
			return {
				// Clamped to the same caps the URL params are clamped to: the feed is
				// upstream text, and the room server truncates it for every peer.
				name: clampParam(c.name, 48),
				symbol: clampParam(c.symbol, 16),
				image: proxiedImageURL(c.image_uri || c.image || c.imageUri || c.logo || '', mint, { width: COIN_ART_WIDTH }),
				marketCap: c.usd_market_cap || c.market_cap_usd || c.marketCap || 0,
			};
		} catch (err) {
			// A designed miss: our own deadline fired, /api is blocked, or the feed
			// blipped. The world takes its generated-art fallback either way, so
			// this is expected-path telemetry, not a warning.
			const why = err?.name === 'AbortError'
				? `timed out after ${COIN_IDENTITY_TIMEOUT_MS}ms`
				: (err?.message || String(err));
			log.info('[coincommunities] coin identity lookup missed, using generated art:', why);
			return null;
		} finally {
			clearTimeout(timer);
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
			// of leaving the player on a dead loader, boot-avatar.js already
			// degrades gracefully, and the main scene must too.
			const e = new Error('WebGL unavailable: ' + (err?.message || err));
			e.code = 'NO_WEBGL';
			throw e;
		}
		r.setSize(window.innerWidth, window.innerHeight);
		if (this._transparentBg) r.setClearColor(0x000000, 0);
		// Cinematic defaults (ACES tone mapping, sRGB output, VSM soft shadows,
		// pixel-ratio cap) shared with every other viewer on the platform. Exposure
		// is tuned for the dark monochrome arena (the LDR gradient backdrop doesn't
		// need the heavy pull the old HDR daylight sky did). _applyPerfTier() below
		// still owns the final pixel-ratio/shadow-enabled call so power-saver mode
		// and the 'low' tier keep degrading exactly as before.
		applyCinematicDefaults(r, { exposure: 1.0, tier: this._perfTier === 'low' ? 'mobile' : this._perfTier });
		this.renderer = r;
		this._applyPerfTier();
		window.addEventListener('resize', () => this._onResize());
		this._watchDevicePixelRatio();
		this._bindContextLoss();
		this._trackSoftKeyboard();
	}

	// Keep bottom-docked HUD controls above the on-screen keyboard.
	//
	// The HUD is `position: fixed`, which anchors to the LAYOUT viewport. When a
	// phone keyboard opens it shrinks the VISUAL viewport instead, so the layout
	// viewport never changes and the chat input the player is typing into sits
	// calmly underneath the keyboard, invisible. `vh` units have the same blind
	// spot, which is why swapping in dvh does not fix a fixed element.
	//
	// visualViewport is the only API that reports the covered strip. Publish it as
	// --cc-kb and let the bottom-docked rules add it to their offset, so the chat
	// (and the emote/reaction rows stacked above it) ride up with the keyboard and
	// drop back when it closes. Desktop and any browser without visualViewport keep
	// --cc-kb at 0px and are untouched.
	_trackSoftKeyboard() {
		const vv = window.visualViewport;
		if (!vv) return;
		const root = document.documentElement;
		this._onKeyboard = () => {
			// The strip of layout viewport the keyboard (and any pinch-zoom offset)
			// is covering. Never negative: an over-scrolled URL bar can report a
			// visual viewport TALLER than the layout one, which would otherwise
			// yank the HUD downward off-screen.
			const covered = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
			// Sub-pixel churn on every scroll frame would thrash layout for no
			// visible gain; round and only write when it actually moved.
			const px = Math.round(covered);
			if (px === this._kbPx) return;
			this._kbPx = px;
			root.style.setProperty('--cc-kb', `${px}px`);
		};
		vv.addEventListener('resize', this._onKeyboard);
		vv.addEventListener('scroll', this._onKeyboard);
		this._onKeyboard();
	}

	// A browser may take the WebGL context away at any time. On phones it is the
	// usual response to memory pressure, and it arrives with no warning and no JS
	// error. Unhandled, the default action cancels restoration for good: the canvas
	// freezes on its last frame, three.js logs a flood of GL warnings, and the
	// player is left in a world that renders nothing while the socket, chat and
	// economy carry on underneath. Calling preventDefault() is what asks the
	// browser to give the context back; until it does, we stop drawing and say so.
	_bindContextLoss() {
		this.canvas.addEventListener('webglcontextlost', (e) => {
			e.preventDefault();
			this._contextLost = true;
			log.warn('[coincommunities] WebGL context lost, pausing rendering until it is restored');
			this.ui?.toast('Graphics paused: your device reclaimed 3D memory. Restoring…', 'warn');
		});
		this.canvas.addEventListener('webglcontextrestored', () => {
			this._contextLost = false;
			// The GPU-side objects three.js held are gone; it rebuilds them lazily
			// from the scene graph on the next render. Re-apply the tier so pixel
			// ratio and shadow state land on the fresh context, and resize so the
			// new drawing buffer matches the viewport.
			this._applyPerfTier();
			this._onResize();
			log.info('[coincommunities] WebGL context restored');
			this.ui?.toast('Graphics restored.', 'info');
		});
	}

	// devicePixelRatio changes when the window moves to a display with a
	// different density (retina laptop ↔ external 1x monitor) or the OS/browser
	// zoom changes. That does NOT reliably fire a 'resize' event, so without
	// this the canvas keeps rendering at the old ratio, sharp becomes blurry,
	// or a needlessly high ratio tanks the framerate. A resolution media query
	// fires once when the current ratio stops matching; we re-sync and re-arm.
	_watchDevicePixelRatio() {
		if (typeof window.matchMedia !== 'function') return;
		const arm = () => {
			const dpr = window.devicePixelRatio || 1;
			const mq = window.matchMedia(`(resolution: ${dpr}dppx)`);
			const onChange = () => { this._onResize(); arm(); };
			if (mq.addEventListener) mq.addEventListener('change', onChange, { once: true });
			else if (mq.addListener) { const h = () => { mq.removeListener(h); onChange(); }; mq.addListener(h); }
		};
		arm();
	}

	// Apply the current quality tier (or the power-saver floor) to the renderer.
	// Tier caps pixel ratio, the single biggest GPU cost on high-DPI screens,
	// and gates shadow maps. Power saver overrides everything with the cheapest
	// state; turning it off restores the tier the watchdog last settled on.
	_applyPerfTier() {
		const r = this.renderer;
		if (!r) return;
		if (this._powerSaver) {
			r.setPixelRatio(1);
			r.shadowMap.enabled = false;
			return;
		}
		const dprCap = this._perfTier === 'high' ? 2 : this._perfTier === 'medium' ? 1.5 : 1;
		r.setPixelRatio(Math.min(window.devicePixelRatio || 1, dprCap));
		r.shadowMap.enabled = this._perfTier !== 'low';
	}

	_initScene() {
		// Nocturnal monochrome arena that flows out of the lobby: near-black ground
		// with a technical hairline grid, a glowing boundary ring, a silhouette
		// treeline melting into fog, under a single cool moonlight key. The whole
		// environment lives in world-env.js so this file stays focused on players,
		// the coin totem, and netcode.
		const scene = new Scene();
		this.scene = scene;

		// Real HDRI image-based lighting for the plaza (falls back to procedural
		// RoomEnvironment on the 'low' tier or fetch failure). 'outdoor' fits the
		// open-air metaverse plaza better than a studio backdrop.
		loadEnvironment(this.renderer, scene, this._perfTier === 'low' ? null : 'outdoor');

		// Far plane reaches the sky dome; near stays tight for close avatars.
		// Initial FOV matches the follow mode's (camera-modes.js) so the first
		// rendered frame doesn't pop before _updateCamera applies the mode.
		this.camera = new PerspectiveCamera(CAMERA_MODE_FOV.follow, window.innerWidth / window.innerHeight, 0.1, 9000);

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
		// W01: real time of day, deterministic from wall-clock time (worldClock),
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

	// Compile the shader programs for everything currently in the scene, off the
	// render path, before the frame that would otherwise compile them mid-draw.
	//
	// three.js compiles a material's program the first time it draws it. World
	// entry adds the biome, the district grid, the totem, the jumbotron, the chart
	// screen, the oracle ribbon and the player's skinned avatar inside a couple of
	// synchronous bursts, so the very next rendered frame after each burst has to
	// compile and link all of it at once. That is a single multi-hundred-millisecond
	// stall, on the exact frame the player is first looking at the world, and it is
	// what makes /play feel slow for its first seconds and perfectly smooth after
	// (compiled programs are cached for the rest of the session).
	//
	// compileAsync does the same work through KHR_parallel_shader_compile where the
	// driver supports it, so linking happens on driver threads instead of blocking
	// the main one. Rendering is suspended for the duration (the canvas holds its
	// last frame) so a rAF tick can't slip in and force the synchronous compile we
	// are trying to avoid.
	async _warmShaders() {
		const r = this.renderer;
		if (!r || this._contextLost) return;
		this._warming = true;
		try {
			// A driver that never reports completion must not freeze the canvas: cap
			// the suspension and let the remaining programs compile on demand, which
			// is exactly the old behaviour and never worse than it.
			const compile = typeof r.compileAsync === 'function'
				? r.compileAsync(this.scene, this.camera)
				: Promise.resolve(r.compile(this.scene, this.camera));
			await Promise.race([compile, new Promise((res) => setTimeout(res, WARM_TIMEOUT_MS))]);
		} catch (err) {
			log.warn('[coincommunities] shader warm-up failed:', err?.message);
		} finally {
			this._warming = false;
		}
	}

	// One decode and one GPU upload of the coin's artwork, shared by every surface
	// that shows it: the totem's two faces and the jumbotron's art panel.
	//
	// Each surface used to run its own TextureLoader against the same URL. The
	// HTTP cache deduped the download, so this looked free, but it isn't: the
	// browser decoded the image twice and three.js uploaded two independent
	// textures to the GPU. Token art routinely runs past half a megabyte (the
	// flagship $THREE image is 567 KB), and that second decode + upload lands
	// squarely inside world entry, where the frame budget is already spent.
	//
	// The promise is memoized per URL for the life of the world and dropped in
	// leave(), so the next coin loads its own art and this one's texture is freed
	// with the meshes that carry it.
	_loadCoinArt(url) {
		if (!url) return Promise.resolve(null);
		if (this._coinArt?.url === url) return this._coinArt.promise;
		const promise = new Promise((resolve) => {
			new TextureLoader().load(
				url,
				(tex) => { tex.colorSpace = SRGBColorSpace; resolve(tex); },
				undefined,
				// Blocked or broken art is not fatal: the totem keeps its gold disc and
				// the jumbotron keeps its text. Resolve null so callers just skip.
				() => resolve(null),
			);
		});
		this._coinArt = { url, promise };
		return promise;
	}

	// Central coin totem, the community's banner in 3D.
	_buildTotem(coin) {
		const g = new Group();
		const pillar = new Mesh(new CylinderGeometry(1.1, 1.4, 6, 24),
			new MeshStandardMaterial({ color: 0x3a4a72, roughness: 0.6, metalness: 0.2 }));
		pillar.position.y = 3; pillar.castShadow = true; pillar.receiveShadow = true;
		g.add(pillar);
		// Floating coin disc with the token image, a warm gold coin that catches the
		// sun key, slowly turning. The token art rides on its faces.
		const spin = new Group(); spin.position.y = 7.5;
		const disc = new Mesh(new CylinderGeometry(2.2, 2.2, 0.3, 40),
			new MeshStandardMaterial({ color: 0xffce5c, roughness: 0.35, metalness: 0.7, emissive: 0x3a2e00, emissiveIntensity: 0.3 }));
		disc.rotation.x = Math.PI / 2; disc.castShadow = true;
		spin.add(disc);
		this._totemDisc = disc;
		if (coin.image) {
			this._loadCoinArt(coin.image).then((tex) => {
				// Left the world (or hopped coins) while the art was decoding: `spin` is
				// detached and already disposed, so anything added now would leak.
				if (!tex || this._coinSpin !== spin) return;
				const face = new Mesh(new CircleGeometry(1.9, 40), new MeshBasicMaterial({ map: tex }));
				face.position.set(0, 0, 0.18); spin.add(face);
				const back = new Mesh(new CircleGeometry(1.9, 40), new MeshBasicMaterial({ map: tex }));
				back.position.set(0, 0, -0.18); back.rotation.y = Math.PI; spin.add(back);
			});
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
		const { canvas, ctx: x } = makeScreenCanvas(512, 128, 2);
		x.fillStyle = 'rgba(11,16,32,0.0)'; x.fillRect(0, 0, 512, 128);
		x.textAlign = 'center'; x.fillStyle = '#fff';
		x.font = '800 50px Inter, system-ui, sans-serif';
		x.fillText(name.slice(0, 18).toUpperCase(), 256, 56);
		x.font = 'bold 32px Inter, system-ui, sans-serif'; x.fillStyle = '#5fc8ff';
		x.fillText(sym, 256, 100);
		const tex = makeScreenTexture(canvas);
		const m = new Mesh(new PlaneGeometry(6, 1.5), screenMaterial(tex, { transparent: true, side: DoubleSide }));
		m.position.y = 10.2;
		return m;
	}

	// Stadium-style jumbotron, the coin's giant LED screen, towering over the
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
		// Backed at 1.5x the 1600x900 layout grid and exempt from fog/tone mapping
		// (screen-texture.js) so the biggest screen in the town reads crisp, not hazed.
		const { canvas } = makeScreenCanvas(1600, 900, 1.5);
		const tex = makeScreenTexture(canvas);
		const panel = new Mesh(new PlaneGeometry(W, H), screenMaterial(tex));
		panel.position.set(0, 11, 0); g.add(panel);
		this._screenCanvas = canvas; this._screenTex = tex;

		// Coin artwork as its own textured plane (loaded the same CORS-safe way as
		// the totem) overlaid on the panel's left third, so compositing the image
		// into the canvas can never taint it.
		if (coin.image) {
			this._loadCoinArt(coin.image).then((imgTex) => {
				// Same guard as the totem: never graft art onto a disposed screen.
				if (!imgTex || this._screen !== g) return;
				imgTex.anisotropy = screenAnisotropy();
				const art = new Mesh(new PlaneGeometry(8.4, 8.4), screenMaterial(imgTex));
				art.position.set(-6.7, 11, 0.04); g.add(art);
				this._screenArt = art;
			});
		}

		// A LIVE bar that pulses along the panel's base (animated in _tickEnv), the
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
	// live community count. Cheap and event-driven, only called on build and when
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

		// Coin name, shrink the font until it fits the column width.
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

		// LIVE, N in this community.
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
		// Claim the phase before the first await: a double-click on a coin card
		// used to start two concurrent enter() flows (both reads of 'lobby' passed
		// while the gate await was in flight), and the losing flow leaked its
		// meshes and chart poller into the scene. The gate/holder paths below
		// restore 'lobby' on cancel so the lobby stays usable.
		this.phase = 'loading';
		// Clear the platform sign-in gate before anything else. Resolves instantly
		// when /play is open (no token pinned) or when we already hold a fresh pass.
		if (this._playReady) { try { await this._playReady; } catch { /* gate self-heals */ } }
		if (this.phase !== 'loading') return; // torn down while the gate was up
		let tier = opts.tier === 'holders' ? 'holders' : 'general';
		// Entry does several awaits (gate, manifest, avatar GLB, room connect) and
		// the Leave button goes live the moment the HUD shows, well before connect
		// resolves. Stamp this attempt so a continuation that resumes after the
		// player has backed out (leave() bumps the epoch) bails instead of
		// resurrecting a torn-down world on a null `this.net`.
		const epoch = (this._enterEpoch = (this._enterEpoch || 0) + 1);

		// Holder worlds are gated: prove the player holds ≥ the floor of this coin
		// before we build anything. The gate runs entirely in the lobby so a refusal
		// leaves them exactly where they were, free to enter the General world
		// instead. A null result means they cancelled, stay put.
		let holderPass = '';
		let holderMinUsd = 0;
		let holderMinTokens = 0;
		if (tier === 'holders') {
			const pass = await this._passHolderGate(coin);
			if (!pass) { if (this.phase === 'loading') this.phase = 'lobby'; return; }
			if (this.phase !== 'loading') return; // torn down while the gate was up
			if (pass === 'general') {
				// The player picked the open world from inside the gate (short
				// balance, or holder verification unavailable): keep this same
				// entry going as a General-world entry instead of bouncing them
				// back to the lobby to click again.
				tier = 'general';
			} else {
				holderPass = pass.holderPass;
				holderMinUsd = pass.minUsd;
				holderMinTokens = pass.minTokens || 0;
			}
		}

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
		if (!coin.name || !coin.symbol || !coin.marketCap) {
			// Any link that arrives short of a full identity. A bare mint
			// used to build a real district under a totem reading COMMUNITY, a
			// welcome card offering "the Community community", and a tab titled
			// Community, for a coin the platform can name in one request. Even a
			// full share link carries no market cap (the rewrite below cannot put a
			// number that moves onto a URL), so the jumbotron and the world's chart
			// screen both read blank on every link anyone has ever shared. One
			// lookup fixes both. Lobby cards arrive complete and skip it.
			const fetched = await this._fetchCoinIdentity(coin.mint);
			if (this.phase !== 'loading' || epoch !== this._enterEpoch) return; // backed out mid-lookup
			coin = mergeCoinIdentity(coin, fetched);
		}
		coin = { ...coin, tier, holderMinUsd, holderMinTokens };
		this.coin = coin;
		this.ui.enterWorld(coin);
		this._setTabTitle(coin.symbol ? '$' + coin.symbol.toUpperCase() : (coin.name || 'Community'));
		document.body.classList.toggle('cc-holders', tier === 'holders');
		// Reflect the community in the URL so it can be shared / refreshed into. A
		// holder-world link carries &tier=holders so refreshing re-runs the gate.
		try {
			const q = new URLSearchParams({ coin: coin.mint });
			if (coin.name) q.set('name', coin.name);
			if (coin.symbol) q.set('symbol', coin.symbol);
			if (coin.image) q.set('image', coin.image);
			if (tier === 'holders') q.set('tier', 'holders');
			// Keep ?ui= on the canonical URL so a shared zen link stays a zen link
			// when copied back out of the address bar (or refreshed).
			if (this._urlUi) q.set('ui', this._urlUi);
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
		this.ui.toast(`${coin.symbol ? '$' + coin.symbol : coin.name || 'Community'}, ${this.env.biome.label}`, 'info');

		// W01: the drivable street grid ringing Downtown, same seed as the biome
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
		// switches, only its colliders and position change.
		await this._physicsReady;
		if (this._physicsOk && this._physics) {
			this._physics.clearObstacles();
			for (const c of this._district.colliders) this._physics.addStaticBox(c);
			// W02: the coin totem (built below by _buildTotem, always at (0,0,-12))
			// isn't part of the district grid, so give it its own collider, keeps
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
		// on-chain trades, a second screen players can walk up to and tap to open
		// the coin on pump.fun. Identity jumbotron behind, market chart ahead. Its
		// freshly-landed trades feed the reactor so the world reacts to the tape.
		this._chartScreen = createChartScreen(this.scene, coin, {
			position: [0, 0, -30], width: 18,
			onTrades: (trades, metrics) => this._reactor?.ingestTrades(trades, metrics),
		});
		// The /ibm/oracle 3D forecast line, the live $THREE price history + IBM
		// Granite TimeSeries forecast, rendered as a glowing ribbon standing in the
		// world (no backdrop, just the line) that players can walk around.
		this._oracleRibbon = mountOracleRibbon(this.scene, { x: 17, y: 4.2, z: -20, scale: 0.7 });
		// Everything above landed in the scene inside one synchronous task, so no
		// frame has drawn any of it yet. Compile it now, off the render path.
		await this._warmShaders();
		if (epoch !== this._enterEpoch) return;
		this.localRig = new Group();
		this.localRig.position.copy(this.localPos);
		this.scene.add(this.localRig);
		// Cosmetics preview rig (R21) re-binds to whatever avatar is current,
		// drop any prior session's manager so it attaches to this fresh skeleton.
		this._accessoryMgr = null;
		this._previewItem = null;
		this.localAnim = new AnimationManager();
		// An `?avatar=` deep link (a "See in 3D" link carrying an agent's GLB) shows
		// that avatar for the session without overwriting the player's saved pick;
		// otherwise use whatever they selected in the lobby (preset / paste / upload).
		const avatarInput = this._urlAvatar || this.ui.getAvatar();
		const url = await resolveAvatarUrl(avatarInput);
		// Kick off the local avatar build (GLB + locomotion clips only; emotes
		// lazy-load on first use via playEmoteClip) WITHOUT awaiting it here. The
		// room join below runs concurrently, so a slow avatar download no longer
		// serializes ahead of the socket and delays the player's entry for everyone.
		if (epoch !== this._enterEpoch) return;
		const avatarBuild = buildAvatar(this.localRig, url, this.localAnim, { clips: 'locomotion' });

		// Connect to this coin's room. A locally-staged guest avatar (just created,
		// not yet uploaded) can't be loaded by peers, so we join without one and
		// upload in the background, then broadcast the public URL so everyone sees
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
		// authoritative `objects` map into the scene, build props (R18), and any
		// future ball/pickup, interpolated like the avatars. Delete-own keys on the
		// net's ownership check. Built per world; disposed alongside voxels on leave.
		this.worldObjects = new WorldObjects(this.scene, this.net, {
			isMine: (obj) => !!this.net?.ownsObject(obj),
		});
		this.propGhost = new PropGhost(this.scene);
		this.net.on('objectReject', ({ reason }) => this._onObjectReject(reason));

		// P3.1: the durable world store. Read it immediately (so the community's
		// persisted build is standing here before the room even answers), and keep it
		// as this client's writer for as long as the room is NOT the authority.
		this._openWorldStore(coin, tier);
		// The room's first full state snapshot has landed: it restored the same doc
		// we did, so our local copies are duplicates. Retire them, and hand any props
		// built while offline to the room so they become part of the shared world.
		this.net.on('synced', () => this._onRoomSynced());
		// Coming back from a backgrounded tab is the one drop the socket never
		// reports: iOS Safari suspends the page, the OS reaps the connection, and
		// no close event is ever delivered, the HUD keeps saying "connected" over
		// a dead wire. Probe on every return to the foreground (and on the network
		// coming back) so a two-minute tab switch resyncs like any other drop.
		this._onResume = () => { if (!document.hidden) this.net?.resume(); };
		document.addEventListener('visibilitychange', this._onResume);
		addEventListener('online', this._onResume);
		addEventListener('focus', this._onResume);

		if (isGuest) {
			uploadPendingGuestAvatar((publicUrl) => this.net?.setAvatar(publicUrl))
				// Upload failed: peers keep the stand-in they already render; the local
				// avatar is untouched, so there is nothing to recover beyond the log.
				.catch((err) => log.warn('[coincommunities] guest avatar upload failed:', err?.message));
		}
		this.net.on('status', ({ status, error }) => {
			this.ui.setStatus(status, error);
			this._updateOnline();
			// Reconnect exhausted (the net goes terminally 'offline' WITH an error;
			// a plain room drop reports 'offline' without one and retries silently,
			// and each 'failed' attempt is just backoff): the player is now alone in
			// a local-only world. The small status pill alone is easy to miss, so
			// explain the drop once, and how to recover.
			if (status === 'offline' && error && !this._failedNotified) {
				this._failedNotified = true;
				this.ui.toast('Lost the connection to the world: chat and shared builds are paused. Tap the status pill to reconnect.', 'warn');
			}
			// Retries exhausted: this is a single-player world now, so the peers
			// frozen mid-stride are a lie. Clear them rather than leave a crowd of
			// statues nobody can talk to. A manual retry re-streams the real roster.
			if (status === 'failed') { this._markRemotesStale(); this._pruneStaleRemotes(); }
			if (status === 'online') this._failedNotified = false;
			// Every (re)connect re-streams the server's authoritative build, so wipe
			// the local layer first. On a manual retry out of single-player this also
			// hands authority back: the solo build gives way to the shared world's.
			if (status === 'connecting') { this.voxels?.clear(); this._undoStack = []; this._syncBudget(); this._resetBuildPerms(); this._markRemotesStale(); }
			// Building is available with a live server (synced + persisted for
			// everyone) and in solo single-player mode (local-only) once multiplayer
			// has been given up. The connecting window is the only time it's off, so
			// the toggle never becomes a dead, silent button.
			this.buildHud.setEnabled(this._buildableConnection(), 'Connecting to the world…');
			// The room has stopped being the authority: take the pen back so a solo
			// session keeps building into the same durable document (P3.1).
			if (status !== 'online' && status !== 'connecting') this._armLocalWorldWriter();
			// Durability badge: online reflects the server's persistent flag. Offline,
			// props ARE durable now (they go straight to the world store), so the badge
			// reflects whether this client may actually write it, never a false promise.
			this.buildHud.setPersistent(
				status === 'online'
					? this.net?.persistent
					: (status === 'offline' || status === 'unavailable' || status === 'failed'
						? !!this._worldStore?.writable
						: null),
			);
			this._syncBudget();
			// A reconnect reissues every sessionId, stranding the voice mesh, refresh
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
			// below the floor): force a fresh sign-in before they can play again, the
			// cached pass is now void, so clear it so the gate re-checks the chain.
			if (/play_pass/i.test(reason || '')) {
				clearStoredPass();
				this.playPass = '';
				this.account = '';
				this.ui.toast('Your session expired, sign in again to keep playing.', 'warn');
				this.leave();
				this._playReady = this._ensurePlayAccess();
				return;
			}
			this.ui.toast('Your holder pass expired, re-enter to verify your holdings.', 'warn');
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
		// Durability flag for this world's build, drives the HUD "Saved" badge.
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
		// pickups scattered around the world. Sibling of PlaySystems, see
		// play-activities.js's header for why they stay decoupled.
		this.playActivities = new PlayActivities({
			scene: this.scene,
			getPlayer: () => ({ x: this.localPos.x, y: this.localPos.y, z: this.localPos.z, yaw: this.localYaw, height: this.localHeight || 1.6 }),
			net: this.net,
			ui: this.ui,
		});
		// W09: Fortune's Folly, the Mainland Wheel of Fortune. Another sibling,
		// its own landmark, its own prompt, lazy-loads the actual spin UI (and the
		// @solana/web3.js it drags in for the paid path) only on first interact.
		this.wheelStation = new WheelStation({
			scene: this.scene,
			getPlayer: () => ({ x: this.localPos.x, y: this.localPos.y, z: this.localPos.z }),
			net: this.net,
		});
		// F18: the War Portal, the door from this world into Coin Wars. Shows this
		// community's real league standing off /api/wars, queues it for a battle,
		// and hands the player to the arena at /play/war with a return link back
		// into this exact world. It runs THIS coin's holder gate before queueing
		// (the same overlay world entry uses), because ClashRoom only seats a
		// fighter under the community whose coin they actually hold.
		this.warPortal = new WarPortal({
			scene: this.scene,
			getPlayer: () => ({ x: this.localPos.x, y: this.localPos.y, z: this.localPos.z }),
			coin: this.coin,
			ui: this.ui,
			ensureHolderPass: () => this._passHolderGate(this.coin),
			returningMatchKey: this._urlWar,
		});
		// One echo per return: clear the key so re-entering another world from the
		// lobby does not replay a battle the player already saw.
		this._urlWar = '';
		this.net.on('profile', (snap) => { this.playSystems?.setProfile(snap); this._onCosmeticsProfile(snap); });
		this.net.on('inv', (delta) => this.playSystems?.applyInv(delta));
		this.net.on('xpgain', (g) => this.playSystems?.onXpGain(g));
		this.net.on('levelup', (l) => this.playSystems?.onLevelup(l));
		this.net.on('notice', (n) => {
			// Live-event announcements (an operator broadcast via the server's
			// /internal/announce) get the centre-screen treatment; every other
			// notice stays a play-systems activity toast.
			if (n?.kind === 'event') return this._onEventAnnounce(n);
			// A refused equip sends a notice and NO profile echo, so the wardrobe's
			// pending spinner had nothing to clear it and span forever on the card.
			// Hand it the refusal so it can drop the spinner and say why.
			if (n?.kind === 'cosmetic' && n.ok === false) this._wardrobe?.onRejected?.(n.text);
			this.playSystems?.onNotice(n);
		});
		// Event souvenir: the server granted this account a live event's free
		// commemorative wearable. Sent exactly once, on the join where the unlock
		// landed (never on a rejoin) so it is a moment to celebrate, not state
		// to reconcile.
		this.net.on('souvenir', (m) => this._onSouvenir(m));
		// Friends (W09): live DMs + request/accept pushed by the social hub over this
		// world's socket. The FriendsClient owns all social state, it updates its
		// threads/unread counts and notifies the panel, open or not, so a DM that
		// arrives while the panel is closed still lights the badge.
		this.net.on('social', (m) => {
			friendsClient().handleSocial(m);
			if (m?.type === 'dm') this._bumpFriendsBadge();
		});
		this._initFriends();
		// Job completion has no generic 'notice' twin (WalkRoom sends only
		// 'questComplete'), toast it globally so a payout lands even when the
		// Jobs Board panel isn't open, the same way every other reward does.
		this.net.on('questComplete', (c) => {
			if (!c) return;
			const gold = c.reward?.gold ?? 0;
			const crew = c.coop && c.crew > 1 ? ` (crew of ${c.crew})` : '';
			this.ui?.toast?.(`${c.title} complete${crew}, +${gold} cash`, 'success');
		});

		this.buildHud.root.hidden = false;
		// W02: drivable vehicles, the parked fleet the server seeds every world
		// with (multiplayer/src/vehicles.js VEHICLE_SPAWNS, mirrored from this
		// district's own avenue bays in world-zones.js). Constructed after the
		// physics boot above has resolved, so it can borrow this._physics straight
		// away instead of waiting on it itself, and BEFORE connect() below:
		// Colyseus replays each synced entity exactly once, from the first state
		// patch, and on a warm room that patch can land while the avatar GLB is
		// still downloading. A manager built after it would miss the whole fleet
		// for the session. Torn down in leave().
		this.vehicles = new VehicleManager({ host: this });
		// W07: roaming PvE mobs, lootable tombstones, the danger-zone ground, and
		// the GTA-style vitals HUD (health/armor/wanted). Constructed before the
		// join starts for the same first-patch reason as the vehicles above; it
		// also catches the join-time 'profile' send directly, and the re-request
		// after the join below stays as a backstop. Torn down in leave().
		// Defensive boundary: W07 is still under active concurrent development in
		// this shared worktree (CLAUDE.md "known traps"), and a bug in it must
		// never take down the rest of world entry (NPCs, vehicles, economy) for
		// every player. Fails closed to no combat HUD/mobs, not an unusable world.
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
			log.error('[coincommunities] CombatSystem failed to init; continuing without it:', e?.message);
			this.combat = null;
		}
		// Join the room and finish the local avatar in parallel. These used to run
		// serialized (avatar, then connect), which held the whole world entry on
		// "connecting" for the length of the avatar download; neither depends on
		// the other, so they overlap now and entry is gated on the slower of the
		// two, not the sum.
		const connectP = this.net.connect();
		const { height: localHeight, fallback: avatarFallback } = await avatarBuild;
		// Player backed out mid-load: leave() already tore everything down and
		// nulled this.net. Bail rather than dereference it / re-enter 'world'.
		if (epoch !== this._enterEpoch || !this.net) return;
		this.localHeight = localHeight;
		// Dress the local avatar in the loadout the player last equipped (carried
		// across sessions and worlds via the cc-cosmetics mirror). The server echoes
		// the authoritative, ownership-validated loadout right after join, which
		// re-applies through _onCosmeticsProfile; applying the cached wire now means
		// the player sees their fit immediately, not a flash of bare avatar.
		this._localCosWire = null;
		this._applyLocalCosmetics(getPlayCosmetics());
		// Don't silently swap a broken model for the stand-in: tell the player so
		// they know to pick another avatar.
		if (avatarFallback && avatarInput !== GUEST_SENTINEL) {
			this.ui.toast('Couldn’t load that avatar, so a stand-in is filling in. Try another in the lobby.', 'warn');
		}
		// Second warm pass: the avatar's skinned materials (and its cosmetics) are
		// the last thing added before the player takes control, and a skinned
		// program is among the most expensive to compile. Do it here so the first
		// frame the player actually steers is not the frame that compiles it.
		await this._warmShaders();
		if (epoch !== this._enterEpoch || !this.net) return;
		// The world is playable the moment the avatar stands. Don't freeze movement
		// behind the join handshake (up to 15s on a cold multiplayer instance):
		// everything below that touches the net only *subscribes*, so it works
		// while the join is still in flight, and the status pill narrates it.
		this.phase = 'world';
		// Frame health is judged from here, but not immediately: see _loop.
		this._worldSince = performance.now();
		this._initJoystick();
		this._restoreZen();
		this._onboardBuild();
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
		// from their own wallet for live market intel on the town's own coin,
		// the flagship $THREE oracle at home, the generic token oracle elsewhere.
		this.intelKiosk = new IntelKiosk({
			scene: this.scene,
			camera: this.camera,
			renderer: this.renderer,
			getPlayer: () => this.localPos,
			ui: this.ui,
			coin,
		});
		// Agent desks, visible in every world. Seats the platform's most recently
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
				// The player may have left (or hopped coins) while the fetch was in
				// flight: desks (and their SSE monitors) added now would leak into
				// the lobby scene with nothing left to dispose them.
				if (epoch !== this._enterEpoch) return;
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
			.catch(() => { /* non-critical, world works without desks */ });

		// Living world (W08): ambient pedestrians + traffic, interactive vendor /
		// quest / flavor NPCs, and (gated behind W07) hostile mobs, all on a
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
				// wardrobe panels, same panels the HUD buttons drive.
				openShop: () => this._toggleShop(),
				openWardrobe: () => this._toggleWardrobe(),
				// Quest-giver NPCs (W08 hooking W05) call this to open the real Jobs
				// Board, optionally scrolled straight to the mission that giver offers.
				openQuests: (highlight) => this._toggleQuests(highlight),
			},
			radius: WORLD_RADIUS - 4,
			// Selecting an interactive NPC from outside its range opens its profile
			// in the shared inspector (with a Talk action) instead of doing nothing.
			onInspectNpc: (npc) => this._inspectNpc(npc),
		});
		// Everything visual is up; now settle the join. Voice needs the live
		// sessionId, and the profile re-request needs an open socket (it is a
		// silent no-op otherwise), so both wait for the connect started above.
		await connectP;
		if (epoch !== this._enterEpoch || !this.net) return;
		this._initVoice();
		// playSystems and combat cached a 'profile' snapshot at join; re-request so
		// the vitals HUD is current even if that send raced their subscriptions.
		this.net.requestProfile();

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

	// First-run nudge so players discover building exists, the HUD's ⛏ toggle is
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
	// up 2 min before the pass expires and renews it off the still-valid pass, no
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
			// the server re-issues off it after re-reading the chain, no wallet prompt.
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
				this.ui.toast('Your token balance dropped, sign in again to keep playing.', 'warn');
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
				this.ui.toast('Your session expired, sign in again to keep playing.', 'warn');
				this.leave();
				this._playReady = this._ensurePlayAccess();
				return;
			}
			// Network hiccup, try again in 30 s rather than breaking the session.
			clearTimeout(this._passRefreshTimer);
			this._passRefreshTimer = setTimeout(() => this._doPassRefresh(), 30_000);
		}
	}

	// Wallet-first platform gate. Shows the sign-in screen (connect → sign nonce →
	// verify token balance) when the server requires it, and caches the verified
	// wallet + signed pass we attach to every room join. Self-healing: any failure
	// resolves to "open" rather than bricking /play, since the server is the real
	// authority, an unsigned join is refused there regardless.
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
						else if (err?.code === 'cc_unconfigured') {
							// Holder verification depends on the CoinCommunities API
							// key, which this deployment does not have yet. Nothing the
							// player does (retry, switch wallet) can succeed, so route
							// to the designed "verification offline" state that leads
							// them into the open world instead.
							state = 'unavailable'; data = { symbol };
						}
						else { state = 'error'; data = { symbol, error: err?.message || 'Could not verify your holdings.' }; }
						carryError = '';
					}
				}
				skipCheck = false;

				const action = await this._holderGateWait(state, data);
				if (action === 'cancel') return null;
				if (action === 'general') {
					// Continue this entry as the open General world. The caller
					// (enter()) downgrades the tier; close the gate ourselves since
					// the finally below only cleans up on a return to the lobby.
					this.ui.closeHolderGate();
					return 'general';
				}
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
					// Drop the linked wallet and connect a different one, then re-check,
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
			// Guarantee the overlay (and its focus trap) never lingers if we bailed
			// via return or a throw. Unconditional on purpose: enter() holds the
			// phase at 'loading' while this gate runs, so a phase check here never
			// fires and a cancel used to strand the modal forever. closeHolderGate()
			// is idempotent, so the paths above that already closed it are unharmed.
			this.ui.closeHolderGate();
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
	//
	// The WebRTC engine is imported here rather than statically, so its peer
	// connection / spatial-panner code is off the first-paint path; nothing in
	// the world reads `this.voice` without optional chaining, and no peer can
	// signal us before we have joined, so arriving a few ms later is safe.
	async _initVoice() {
		if (this.voice) { this.voice.dispose(); this.voice = null; }
		const epoch = this._enterEpoch;
		const { VoiceChat, voiceSupported } = await import('./voice-chat.js');
		if (epoch !== this._enterEpoch || !this.net) return; // left the world mid-import
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

	// Deep-free an Object3D built by this module: dispose every mesh's geometry,
	// its materials, and any textures those materials hold. Used on the totem,
	// jumbotron and dance floor at leave(), which previously were only detached
	// from the scene graph (`world.remove`), leaking their GPU buffers on every
	// world switch. Never called on shared/instanced world-env or district objects
	//, those own their own disposal.
	_disposeObject3D(obj) {
		if (!obj) return;
		obj.traverse((n) => {
			if (!n.isMesh && !n.isLine && !n.isPoints) return;
			n.geometry?.dispose?.();
			for (const mat of Array.isArray(n.material) ? n.material : [n.material]) {
				if (!mat) continue;
				for (const value of Object.values(mat)) if (value?.isTexture) value.dispose();
				mat.dispose?.();
			}
		});
	}

	leave() {
		// Invalidate any in-flight enter() so a connect/avatar continuation that
		// resolves after this teardown bails instead of rebuilding the world.
		this._enterEpoch = (this._enterEpoch || 0) + 1;
		// The lobby always shows its UI; zen re-applies on the next world entry.
		this._suspendZen();
		// Tear voice down before the socket so our final "left voice" flag still
		// sends, and peers' connections close cleanly.
		clearTimeout(this._passRefreshTimer);
		this._passRefreshTimer = null;
		if (this.voice) { this.voice.dispose(); this.voice = null; }
		if (this._onResume) {
			document.removeEventListener('visibilitychange', this._onResume);
			removeEventListener('online', this._onResume);
			removeEventListener('focus', this._onResume);
			this._onResume = null;
		}
		if (this._onKeyboard) {
			window.visualViewport?.removeEventListener('resize', this._onKeyboard);
			window.visualViewport?.removeEventListener('scroll', this._onKeyboard);
			this._onKeyboard = null;
			this._kbPx = 0;
			// Leaving the world must not strand a keyboard offset on <html>: the
			// lobby renders under the same :root and would sit shifted up.
			document.documentElement.style.removeProperty('--cc-kb');
		}
		if (this.net) { this.net.destroy(); this.net = null; }
		clearTimeout(this._announceTimer);
		if (this.vehicles) { this.vehicles.dispose(); this.vehicles = null; }
		if (this.combat) { this.combat.dispose(); this.combat = null; }
		if (this.playSystems) { this.playSystems.dispose(); this.playSystems = null; }
		if (this.playActivities) { this.playActivities.dispose(); this.playActivities = null; }
		if (this.wheelStation) { this.wheelStation.dispose(); this.wheelStation = null; }
		if (this.warPortal) { this.warPortal.dispose(); this.warPortal = null; }
		this._disposeFriends();
		this._disposeAvatarPanel();
		if (this.agentCommerce) { this.agentCommerce.dispose(); this.agentCommerce = null; }
		if (this.intelKiosk) { this.intelKiosk.dispose(); this.intelKiosk = null; }
		if (this.worldLife) { this.worldLife.dispose(); this.worldLife = null; }
		if (this._onboard) { this._onboard.dispose(); this._onboard = null; }
		// Close the shop + wardrobe and drop the rig binding, the next world rebuilds both.
		if (this._shop?.isOpen()) this._shop.close();
		if (this._wardrobe?.isOpen()) this._wardrobe.close();
		// A souvenir card is bound to the world that granted it; leaving mid-linger
		// must take it with us rather than float it over the lobby.
		if (this._souvenirDrop) { this._souvenirDrop.dispose(); this._souvenirDrop = null; }
		this._newCosmeticId = null;
		this._cosmeticsSnap = null;
		this._accessoryMgr = null;
		this._previewPresetId = null; this._previewLayers = false; this._previewItem = null;
		for (const [, r] of this.remotes) r.dispose();
		this.remotes.clear();
		closeAvatarInspector(); // whoever it showed just left the world with us
		if (this._totem) { this._disposeObject3D(this._totem); this.world.remove(this._totem); this._totem = null; this._coinSpin = null; }
		if (this._screen) {
			this._disposeObject3D(this._screen); // bezel/panel/pulse geometry + coin-art texture
			this.world.remove(this._screen);
			this._screenTex?.dispose();
			this._screen = null; this._screenCanvas = null; this._screenTex = null;
			this._screenArt = null; this._screenPulse = null;
		}
		// The shared coin-art texture is disposed with the meshes above (both the
		// totem and the screen carry it, and a second dispose() on an already-freed
		// texture is a no-op). Drop the memo so the next coin loads its own art
		// rather than inheriting a disposed texture from this world.
		this._coinArt = null;
		if (this._chartScreen) { this._chartScreen.dispose(); this._chartScreen = null; }
		if (this._oracleRibbon) { this._oracleRibbon.dispose(); this._oracleRibbon = null; }
		if (this._agentDesks?.length) {
			for (const desk of this._agentDesks) desk.dispose();
			this._agentDesks = [];
		}
		if (this._danceFloor) { this._disposeObject3D(this._danceFloor); this.world.remove(this._danceFloor); this._danceFloor = null; }
		this._floorLights = null; this._floorTiles = null; this._floorCenterMat = null;
		this._danceFloorPos = null; this._onFloor = false; this._wantsDance = false;
		this.ui.setOnFloor(false);
		if (this._reactor) { this._reactor.dispose(); this._reactor = null; }
		// Land any debounced world-store write before the objects it describes are
		// disposed (P3.1): leaving a world must not lose the last placement.
		this._closeWorldStore();
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
		// share / featured surfaces, they're scoped to the world we're leaving.
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
		// Tag mini-game (R08): remove local glow ring + label and drop the HUD
		// (scoreboard + "you're it" alert) on world exit.
		this._removeLocalGlowRing();
		this._removeLocalItLabel();
		this._localIsIt = false;
		this.ui.hideTagHud();
		// King of the Totem (R07): tear down the zone + crown marker and hide the HUD.
		this._disposeKingZone();
		this.ui.hideKingHud();
		if (this.localRig) { releaseAvatar(this.localRig); this.scene.remove(this.localRig); this.localRig = null; }
		// A joystick vector held at the moment of exit must not drift the avatar
		// in the next world; it belongs to the joystick session leave() just ended.
		this._joy = null;
		// The one-shot disconnect explainer re-arms per world.
		this._failedNotified = false;
		// The lobby has no current world: clear the coin so _worldFacts() (the
		// avatar inspector's World row) stops naming the one we just left.
		this.coin = null;
		this.phase = 'lobby';
		// Re-arm the watchdog grace so the next world entry gets its own runway.
		this._worldSince = Infinity;
		this._setTabTitle('');
		try { history.replaceState(null, '', location.pathname); } catch { /* non-fatal */ }
		this.ui.showLobby();
	}

	_updateOnline() {
		const n = (this.remotes.size + (this.net?.status === 'online' ? 1 : 0)) || 1;
		this._online = n;
		this.ui.setOnline(n);
		this._drawScreen(); // keep the jumbotron's LIVE count in sync
	}

	// A live-event announcement from the operator webhook. Always lands as a
	// toast; when it carries a title, the combat HUD's objective card doubles as
	// a centre-screen banner for the announcement's duration. The card has no
	// other writer in /play today, so a timed clear can't stomp anything.
	_onEventAnnounce(n) {
		if (n.text) this.ui?.toast?.(n.text, 'info');
		const hud = this.combat?.hud;
		if (!n.title || !hud?.setObjective) return;
		hud.setObjective({ title: n.title, detail: n.detail || n.text || '', color: '#ffd76a' });
		clearTimeout(this._announceTimer);
		const holdMs = Math.min(120_000, Number(n.durationMs) > 0 ? Number(n.durationMs) : 12_000);
		this._announceTimer = setTimeout(() => hud.clearObjective(), holdMs);
	}

	// ------------------------------------------------------------- avatar inspector
	// I (or clicking a nameplate / avatar) opens the shared inspector on whoever
	// you're looking at: identity, reputation, wallet, the same server truth every
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
			// Verified three.ws profile (W10): bound server-side from the signed
			// presence ticket, so the inspector can trust it enough to render the
			// real profile with follow / message / creations.
			username: rp.username,
			avatarUrl: rp._avatarUrl,
			facts: [
				...this._worldFacts(),
				...(rp.voice ? [{ label: 'Voice', value: 'in voice chat' }] : []),
			],
		}, {
			trigger: trigger || this.canvas,
			// "Message" on an already-friend profile jumps straight into the DM
			// thread in the in-world friends drawer instead of a page navigation.
			onOpenDM: (userId) => this._openDmWith(userId),
		});
	}
	_inspectNpc(npc) {
		openAvatarInspector({
			kind: 'npc',
			name: npc.name,
			world: 'play',
			facts: [
				{ label: 'Role', value: npc.role === 'vendor' ? 'Vendor, real paid service' : npc.role === 'quest' ? 'Quest giver' : 'Townsperson' },
				...(npc.def?.prompt ? [{ label: 'Offers', value: npc.def.prompt }] : []),
				...this._worldFacts(),
			],
			// Talk works from the card at any distance: it runs the NPC's real role
			// action (conversation, counter, board), the same as walking up for E.
			actions: [{
				label: npc.def?.prompt || 'Talk',
				primary: true,
				onClick: () => {
					try {
						npc.interact({
							player: this.localPos,
							ui: this.ui,
							net: this.net,
							world: this.worldLife?.world,
						});
					} catch { /* role action failed; the NPC stays silent rather than crash */ }
				},
			}],
		}, { trigger: this.canvas });
	}
	_inspectSelf() {
		openAvatarInspector({
			kind: 'self',
			name: this.net?.name || lsGet('cc-name') || 'You',
			world: 'play',
			wallet: this.account || '',
			username: this.me?.username || '',
			avatarUrl: this.net?.avatar,
			facts: this._worldFacts(),
		}, { trigger: this.canvas });
	}
	// Nearest inspectable within reach: real players first beat scenery, an NPC
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
	// path; this catches clicks on the avatar itself). Click-only, never run
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
		// A peer we already track (or one re-announced under the same id after a
		// resync) is live, not stale, clear any stale flag rather than doubling it.
		const existing = this.remotes.get(id);
		if (existing) { existing._stale = false; existing.apply?.(player); return; }
		const rp = new RemotePlayer(this.scene, player);
		rp.onInspect = () => this._inspectRemote(id, rp.label);
		this.remotes.set(id, rp);
		this._updateOnline();
	}

	// Flag every current peer as stale ahead of a reconnect. A reconnect is a fresh
	// joinOrCreate with new session ids, and the old room's listeners were removed
	// before it left, so `_onRemove` never fires for the peers we had, without
	// this they linger as frozen ghosts and inflate the online count. The fresh
	// room's `add` events clear the flag (above); whatever is still flagged when the
	// snapshot lands (`_pruneStaleRemotes`) genuinely left while we were offline.
	_markRemotesStale() {
		for (const [, rp] of this.remotes) rp._stale = true;
	}

	// Retire peers still flagged stale after a (re)sync: dispose their rig, drop the
	// label, close their voice channel, and correct the headcount.
	_pruneStaleRemotes() {
		for (const [id, rp] of [...this.remotes]) {
			if (!rp._stale) continue;
			rp.dispose();
			this.remotes.delete(id);
			this.voice?.removePeer(id);
		}
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
	// recolour garment layers, or play premium emote clips, never broadcast,
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
	//
	// The module itself is lazy-imported too: a first-time visitor walking into
	// the plaza should not pay for the shop's catalog rendering and checkout code
	// before the first frame. Concurrent opens share one in-flight import so a
	// double-click can't build two shops.
	async _toggleShop() {
		if (!this._shop) {
			if (!this._shopModule) this._shopModule = import('./cosmetics-shop.js');
			const { CosmeticsShop } = await this._shopModule;
			if (this._shop) { this._shop.toggle(); return; }
			this._shop = new CosmeticsShop({
				// Key ownership + purchases on the verified wallet when we have one;
				// the shop falls back to the persisted guest id otherwise.
				account: this.account || '',
				// The coin world we're in (R25): ties a cosmetic sale to this coin so a
				// configurable share of the settled USDC pays out to the coin's creator.
				coinMint: this.coin?.mint || '',
				onPreview: (item) => this.equipCosmeticPreview(item),
				onEndPreview: () => this.unequipCosmeticPreview(),
				// A premium item was just bought (R22), permanently equip it so the
				// buyer immediately sees their new look AND it persists across worlds
				// (R23 durable equip: server validates, writes to account, echoes a
				// fresh profile which re-renders the wardrobe and local avatar).
				onPurchased: (item) => { this._equipCosmeticDurable(item.id); },
			});
		}
		// The shop is built once and reused across worlds, so refresh the coin tie
		// each open, a sale always credits the world the player is currently in.
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
	// the shared `friendsClient`, so the same graph backs /play and /walk alike,
	// and a DM read here is read everywhere.
	//
	// Presence is published by the room, not this panel: CommunityNet now carries a
	// signed presence ticket into the join, so a player is visible to friends the
	// moment they enter a world, whether or not they ever open this panel.

	// Seed the graph once per world entry so the unread badge is honest before the
	// panel is ever opened, and keep it live from the client's change signal. Silent
	// no-op when signed out, `refresh()` short-circuits without a request.
	_initFriends() {
		const fc = friendsClient();
		this._offFriends = fc.subscribe(() => this._bumpFriendsBadge());
		fc.refresh();
		this._bumpFriendsBadge();
		// Own account profile (W10): who *we* are on the platform, for the self
		// inspector card. getMe() resolves null for anonymous visitors and caches
		// per page, so this is one cheap request per world entry.
		getMe().then((u) => { this.me = u || null; }).catch(() => { this.me = null; });
	}

	// Open the friends drawer directly on a DM thread, the inspector's
	// "Message" action for a player who is already a friend.
	_openDmWith(userId) {
		if (!userId) return;
		this._openFriends();
		friendsClient().openThread(userId);
	}

	_bumpFriendsBadge() {
		this.ui?.setFriendsUnread?.(friendsClient().totalUnread);
	}

	_toggleFriends() {
		if (this._friendsOpen) this._closeFriends();
		else this._openFriends();
	}

	// The drawer's view module (roster, DM threads, presence rendering) is only
	// needed once someone opens it, so it is imported on demand; the unread badge
	// is fed by `friendsClient` and never waits on this.
	//
	// The frame is built and slid in SYNCHRONOUSLY, before the chunk is asked for.
	// It used to be built after the await, which meant a slow chunk left the
	// button looking dead, and `_friendsOpen` (the flag `_closeFriends` and the
	// J hotkey both test) only flipped once the module landed, so an Escape while
	// it was in flight was swallowed and the drawer slid open seconds later
	// against the player's intent. Now the drawer answers the tap on the same
	// frame, shows a skeleton roster while the chunk travels, and a cancel during
	// the load is honoured.
	_openFriends() {
		if (this._friendsOpen) return;
		// Shares the right edge with the avatar switcher; never stack the drawers.
		this._closeAvatarPanel();
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

			// The other half of the social system. Friends are one-to-one and live
			// in this drawer; a crew is the group the same people fly as, and it has
			// its own headquarters. Without this link the two never meet, which is
			// how the crews backend sat shipped and unreachable for so long.
			const crew = document.createElement('a');
			crew.className = 'cc-friends-panel-crew';
			crew.href = '/crews';
			crew.target = '_blank';
			crew.rel = 'noopener';
			crew.textContent = 'Crew HQ';
			crew.title = 'Found a crew, invite these people, and see the roster in 3D';

			const head = document.createElement('div');
			head.className = 'cc-friends-panel-head';
			head.append(title, crew, close);

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
		}
		this._friendsOpen = true;
		// Next frame, so the transform transition runs from its closed state rather
		// than being collapsed into the same style recalculation as the insert.
		requestAnimationFrame(() => this._friendsEl?.classList.add('is-open'));
		this.ui?.setFriendsOpen?.(true);
		// The world swallows WASD/F/X while the panel has focus; releasing the held
		// keys stops the avatar sliding when focus moves into a DM input.
		this.keys.clear();
		this._friendsCloseEl?.focus();
		if (this._friends) this._friends.mount();
		else this._loadFriendsPanel();
	}

	// Fetch the drawer's view module and hand it the open drawer's body. Runs with
	// the frame already on screen, so everything here only ever swaps the body's
	// contents: a skeleton roster, then the real panel, or a designed failure with
	// a retry. A player who closed the drawer while the chunk was travelling gets
	// the panel built for their next open but never sees it mount behind them.
	_loadFriendsPanel() {
		if (this._friendsLoading) return;
		this._friendsLoading = true;
		this._renderFriendsSkeleton();
		if (!this._friendsModule) this._friendsModule = import('./friends-panel.js');
		this._friendsModule.then(({ FriendsPanel }) => {
			this._friendsLoading = false;
			if (!this._friendsBodyEl) return; // world torn down mid-load
			this._friendsBodyEl.textContent = '';
			this._friends = new FriendsPanel(this._friendsBodyEl);
			if (this._friendsOpen) this._friends.mount();
		}).catch((err) => {
			this._friendsLoading = false;
			// A dead chunk (stale deploy, offline, blocked CDN) must not leave the
			// drawer spinning forever. Say what happened and offer the retry, the
			// same contract every other panel on this surface keeps.
			this._friendsModule = null;
			log.warn('[coincommunities] friends panel failed to load:', err?.message);
			this._renderFriendsLoadError();
		});
	}

	// Skeleton roster: five rows shaped like the friend rows that replace them, so
	// the drawer reads as "your friends are arriving" rather than as a blank panel.
	_renderFriendsSkeleton() {
		const body = this._friendsBodyEl;
		if (!body) return;
		body.textContent = '';
		const wrap = document.createElement('div');
		wrap.className = 'cc-friends-skel';
		wrap.setAttribute('role', 'status');
		wrap.setAttribute('aria-label', 'Loading your friends');
		for (let i = 0; i < 5; i++) {
			const row = document.createElement('div');
			row.className = 'cc-friends-skel-row';
			const dot = document.createElement('span');
			dot.className = 'cc-friends-skel-dot';
			const main = document.createElement('div');
			main.className = 'cc-friends-skel-main';
			const a = document.createElement('span');
			a.className = 'cc-friends-skel-line';
			const b = document.createElement('span');
			b.className = 'cc-friends-skel-line cc-friends-skel-line-sm';
			main.append(a, b);
			row.append(dot, main);
			wrap.appendChild(row);
		}
		body.appendChild(wrap);
	}

	_renderFriendsLoadError() {
		const body = this._friendsBodyEl;
		if (!body) return;
		body.textContent = '';
		const wrap = document.createElement('div');
		wrap.className = 'cc-friends-loaderr';
		const glyph = document.createElement('div');
		glyph.className = 'cc-friends-loaderr-glyph';
		glyph.setAttribute('aria-hidden', 'true');
		glyph.textContent = '📡';
		const title = document.createElement('p');
		title.className = 'cc-friends-loaderr-title';
		title.textContent = 'Could not load your friends';
		const sub = document.createElement('p');
		sub.className = 'cc-friends-loaderr-sub';
		sub.textContent = 'The connection dropped on the way. Your friends list is safe, it just needs another go.';
		const retry = document.createElement('button');
		retry.className = 'cc-friends-loaderr-retry';
		retry.type = 'button';
		retry.textContent = 'Try again';
		retry.addEventListener('click', () => this._loadFriendsPanel());
		wrap.append(glyph, title, sub, retry);
		body.appendChild(wrap);
		retry.focus();
	}

	_closeFriends() {
		if (!this._friendsOpen) return;
		this._friendsOpen = false;
		this._friendsEl?.classList.remove('is-open');
		this._friends?.unmount();
		this.ui?.setFriendsOpen?.(false);
		this._bumpFriendsBadge();
	}

	// Full teardown, the panel and its client subscription must not outlive the
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
		// An in-flight chunk resolves into a body that no longer exists; clearing
		// the flag lets the next world's drawer start its own load.
		this._friendsLoading = false;
	}

	// ── In-world avatar switcher ──────────────────────────────────────────────
	// The lobby's avatar bar disappears the moment a world opens, which used to
	// mean changing your look required leaving (tearing the whole world down).
	// This drawer (HUD Avatar button / V) hosts AvatarSwitcher; every pick lands
	// in _applyAvatarSwap below, which rebuilds the local rig in place and
	// broadcasts the new look so peers re-render it live (the server has accepted
	// mid-session `avatar` messages all along; no client path ever used it).

	_toggleAvatarPanel() {
		if (this._avatarPanelOpen) this._closeAvatarPanel();
		else this._openAvatarPanel();
	}

	_openAvatarPanel() {
		if (this._avatarPanelOpen || this.phase !== 'world') return;
		// The two right-docked drawers share the same edge; never stack them.
		this._closeFriends();
		if (!this._avatarPanelEl) {
			// Same right-docked drawer frame as the friends panel: head, scrolling
			// body, hotkey hint. The panel content itself lives in avatar-switcher.js.
			const close = document.createElement('button');
			close.className = 'cc-friends-panel-close';
			close.type = 'button';
			close.setAttribute('aria-label', 'Close avatar panel');
			close.textContent = '✕';
			close.addEventListener('click', () => this._closeAvatarPanel());

			const title = document.createElement('div');
			title.className = 'cc-friends-panel-title';
			title.textContent = 'Avatar';

			const head = document.createElement('div');
			head.className = 'cc-friends-panel-head';
			head.append(title, close);

			const body = document.createElement('div');
			body.className = 'cc-friends-panel-body cc-avsw-body';

			const hint = document.createElement('div');
			hint.className = 'cc-friends-panel-hint';
			hint.textContent = 'Press V to toggle · Esc to close';

			const root = document.createElement('aside');
			root.className = 'cc-friends-panel cc-avatar-panel';
			root.setAttribute('role', 'dialog');
			root.setAttribute('aria-modal', 'false');
			root.setAttribute('aria-label', 'Change avatar');
			root.append(head, body, hint);
			document.body.appendChild(root);

			this._avatarPanelEl = root;
			this._avatarPanelCloseEl = close;
			this._avatarSwitcher = new AvatarSwitcher(body, {
				// A ?avatar= deep link is what the player is actually wearing this
				// session, so it wins the active-chip highlight until they pick.
				current: () => this._urlAvatar || this.ui.getAvatar(),
				onPick: (value) => this._applyAvatarSwap(value),
			});
		}
		this._avatarSwitcher.mount();
		this._avatarPanelOpen = true;
		requestAnimationFrame(() => this._avatarPanelEl?.classList.add('is-open'));
		this.ui?.setAvatarPanelOpen?.(true);
		// Release held WASD so the avatar doesn't keep walking while focus moves
		// into the panel's inputs (same rule as the friends drawer).
		this.keys.clear();
		this._avatarPanelCloseEl?.focus();
	}

	_closeAvatarPanel() {
		if (!this._avatarPanelOpen) return;
		this._avatarPanelOpen = false;
		this._avatarPanelEl?.classList.remove('is-open');
		this._avatarSwitcher?.unmount();
		this.ui?.setAvatarPanelOpen?.(false);
	}

	_disposeAvatarPanel() {
		this._avatarSwitcher?.dispose();
		this._avatarSwitcher = null;
		this._avatarPanelEl?.remove();
		this._avatarPanelEl = null;
		this._avatarPanelCloseEl = null;
		this._avatarPanelOpen = false;
	}

	// Swap the live local avatar to `input` (avatar id, GLB/VRM URL, or the guest
	// sentinel for a just-created model) without leaving the world. Builds the
	// replacement into a staging group first, so the current avatar keeps standing
	// while the new one downloads and a failed load costs nothing; then tears down
	// every bone-bound attachment (shop preview, accessory manager, durable
	// loadout), moves the new model onto the same rig, re-dresses it, persists the
	// pick, and broadcasts a peer-loadable URL (the server rejects ids and blob:
	// URLs, so the guest path uploads first, exactly like world entry).
	async _applyAvatarSwap(input) {
		const value = (input || '').trim();
		if (!value) return { ok: false, reason: 'empty' };
		const rig = this.localRig;
		if (this.phase !== 'world' || !rig) return { ok: false, reason: 'not-in-world' };
		const epoch = this._enterEpoch;
		const token = (this._avatarSwapToken = (this._avatarSwapToken || 0) + 1);
		const isGuest = value === GUEST_SENTINEL;
		const url = await resolveAvatarUrl(value);
		const staging = new Group();
		const anim = new AnimationManager();
		const built = await buildAvatar(staging, url, anim, { clips: 'locomotion' });
		// Stale: a newer swap superseded this one, or the world was left/re-entered
		// mid-download. Abandon the staged model; the rig it was meant for is gone
		// or already wearing something newer.
		const stale = token !== this._avatarSwapToken || epoch !== this._enterEpoch || this.localRig !== rig;
		if (stale || built.fallback) {
			releaseAvatar(staging);
			return stale ? { ok: false, reason: 'stale' } : { ok: false, reason: 'load-failed' };
		}
		// Old skeleton teardown. The R21 preview manager and the R23 durable
		// loadout are both bone-bound to the outgoing model; drop them before the
		// sweep and re-dress the new skeleton after.
		this.unequipCosmeticPreview();
		this._accessoryMgr = null;
		try { this.localCosmetics?.dispose(); } catch { /* already gone */ }
		this.localCosmetics = null; this._localCosWire = null;
		// releaseAvatar removes only what buildAvatar added (model clone or capsule
		// stand-in) and frees its GPU share; non-avatar rig children (tag glow
		// ring, "it" label anchor) stay put.
		releaseAvatar(rig);
		while (staging.children.length) rig.add(staging.children[0]);
		this.localAnim = anim;
		this.localHeight = built.height;
		this._applyLocalCosmetics(getPlayCosmetics());
		// An explicit pick outlives a ?avatar= deep link and becomes the saved
		// avatar every world reads next session; mirror it into the lobby bar so
		// leaving the world shows the same selection (without re-firing the lobby's
		// change handler, which would double-broadcast).
		this._urlAvatar = '';
		if (!isGuest) setPlayAvatar(value);
		this.ui.reflectAvatar?.(value);
		if (isGuest) {
			// Fire-and-forget like the world-entry upload: a failure keeps peers on
			// the stand-in they already render, so log it rather than reject unhandled.
			uploadPendingGuestAvatar((publicUrl) => this.net?.setAvatar(publicUrl))
				.catch((err) => log.warn('[coincommunities] guest avatar upload failed:', err?.message));
		} else this.net?.setAvatar(url);
		return { ok: true, downgraded: !!built.downgraded };
	}

	// Open/close the "My Cosmetics" wardrobe panel (R23). Lazy-built on first open;
	// each profile echo from the server keeps it fresh so the equipped state always
	// reflects the server-authoritative result.
	async _toggleWardrobe() {
		if (!this._wardrobe) {
			if (!this._wardrobeModule) this._wardrobeModule = import('./cosmetics-wardrobe.js');
			const { CosmeticsWardrobe } = await this._wardrobeModule;
			if (this._wardrobe) { this._wardrobe.toggle(); return; }
			this._wardrobe = new CosmeticsWardrobe({
				onEquip: (id) => { this._equipCosmeticDurable(id); },
				onShop: () => { this._wardrobe?.close(); this._toggleShop(); },
			});
			// A souvenir granted before the panel was ever opened still deserves the
			// "New" highlight: the flag waits here until the panel exists.
			if (this._newCosmeticId) this._wardrobe.markNew(this._newCosmeticId);
			if (this._cosmeticsSnap) this._wardrobe.setProfile(this._cosmeticsSnap);
		}
		this._wardrobe.toggle();
	}

	// A live event just handed this player a free commemorative wearable. Two
	// halves to the moment: a card that says what landed and offers to put it on,
	// and a highlight waiting in the wardrobe for whoever dismisses the card and
	// comes looking later. Both are lazy: the module only loads for the players
	// who actually earn something.
	async _onSouvenir(msg) {
		const id = typeof msg?.id === 'string' ? msg.id : '';
		if (!id) return;
		this._newCosmeticId = id;
		this._wardrobe?.markNew(id);
		try {
			if (!this._souvenirModule) this._souvenirModule = import('./event-souvenir.js');
			const { SouvenirDrop } = await this._souvenirModule;
			if (!this._souvenirDrop) {
				this._souvenirDrop = new SouvenirDrop({
					onEquip: (cid) => this._equipCosmeticDurable(cid),
					onWardrobe: () => this._toggleWardrobe(),
				});
			}
			this._souvenirDrop.show(msg);
		} catch (err) {
			// The item is already granted and persisted server-side; a failed chunk
			// load costs the announcement, never the souvenir. Say so plainly rather
			// than letting the grant pass in silence.
			log.warn('[souvenir] drop card failed to load:', err?.message);
			this.ui?.toast?.(`Souvenir unlocked: ${msg?.name || 'a commemorative item'}. Find it in My Fits.`, 'success');
		}
	}

	// Open/close the Jobs Board (W08 hooking W05). Lazy-imported so the panel
	// chunk stays out of the initial bundle until a player actually walks up to
	// a quest-giver or opens Jobs from the HUD. `highlight` scrolls straight to
	// one mission when a specific giver NPC opened the board.
	async _toggleQuests(highlight) {
		if (!this.net) return;
		// Both callers (the HUD's Jobs button and quest-giver NPCs) fire this
		// without awaiting, so a failed chunk load (stale deploy, offline) must be
		// caught here or it dies as an unhandled rejection with a dead button.
		try {
			const { openQuestsPanel } = await import('./quests-ui.js');
			openQuestsPanel({ ui: this.ui, net: this.net }, highlight);
		} catch (err) {
			log.warn('[coincommunities] jobs board failed to load:', err?.message);
			this.ui.toast('Could not open the jobs board. Refresh the page and try again.', 'warn');
		}
	}

	// Equip `id` durably: send to the server (authoritative validation + persistence)
	// so the fit survives logout, world switches, and is visible to peers immediately.
	// The server echoes a fresh profile which updates the wardrobe and local avatar.
	// Only forward ids the rig can actually wear, a purchase of an item outside the
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
	// string). Idempotent, re-applies only when it actually changed, and reuses
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
		// Keep the latest snapshot so a wardrobe built LATER (the panel is lazy, and
		// a souvenir card can be the thing that sends a player to it) opens on real
		// data instead of a loading skeleton that only clears on the next echo.
		this._cosmeticsSnap = snap;
		// Relay the full cosmetics snapshot to the wardrobe panel (if open) so
		// it reflects owned + equipped state without a separate API call.
		this._wardrobe?.setProfile(snap);
	}

	// Surface unread chat in the tab title when the page is backgrounded, so a
	// new message pulls the user back. Cleared the moment they refocus the tab.
	// Name the world in the tab. A shared /play link opened into a background tab
	// (the normal case at an event: paste, keep browsing, come back) read as a
	// generic "Play · Coin Communities" for every world; now the tab says which
	// one. pages/play.html sets a provisional title from the URL before the bundle
	// loads, and this replaces it with the resolved coin. Written through
	// _baseTitle so an unread-chat badge composes with it instead of fighting it.
	_setTabTitle(label) {
		// The lobby title is whatever pages/play.html shipped (localised by i18n.js),
		// stashed by the same inline script that sets the provisional per-coin title.
		if (this._lobbyTitle === undefined) {
			this._lobbyTitle = document.documentElement.dataset.lobbyTitle || document.title;
		}
		this._baseTitle = label ? `${label} · Play · three.ws` : this._lobbyTitle;
		document.title = this._tabUnread ? `(${this._tabUnread}) ${this._baseTitle}` : this._baseTitle;
	}

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

		// Rim disc, slightly larger, defines the pad boundary with a subtle glow.
		const rimMat = new MeshStandardMaterial({ color: 0x0a0a14, emissive: 0x180840, emissiveIntensity: 0.55, roughness: 0.3, metalness: 0.7 });
		const rim = new Mesh(new CircleGeometry(R + 0.18, 48), rimMat);
		rim.rotation.x = -Math.PI / 2;
		g.add(rim);

		// Base pad, dark polished surface.
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

		// Centre disc, pure white / violet, most dramatic on beat.
		const centerMat = new MeshStandardMaterial({ color: 0xffffff, emissive: 0xaa55ff, emissiveIntensity: 0.65, roughness: 0.06, metalness: 0.96 });
		const center = new Mesh(new CircleGeometry(0.55, 32), centerMat);
		center.rotation.x = -Math.PI / 2;
		center.position.y = 0.012;
		g.add(center);
		this._floorCenterMat = centerMat;

		// 4 coloured point lights above the pad corners, pink / cyan / yellow / mint.
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
		// Broadcast so peers see us dancing, 2-second emote cooldown in WalkRoom
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

		// Boundary ring on the ground, a warm gold annulus that reads as the coin's
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

	// ---------------------------------------------------------------- zen mode
	// Hides every overlay (HUD, chat, prompts, name tags) so the world renders
	// clean (the same body.is-zen contract /walk uses). Movement affordances
	// stay (joystick, driving pedals), and panels the player opens on purpose
	// (build palettes, shops, the emote wheel) still show. The preference
	// persists across sessions, and a shared ?ui=hidden link starts in zen.
	_setZen(on) {
		this._zen = !!on;
		document.body.classList.toggle('is-zen', this._zen);
		if (this._zen) {
			// Defer the reveal class one frame so the exit pill fades in.
			requestAnimationFrame(() => document.body.classList.add('zen-revealed'));
			// Close the drawers/wheels so they don't linger over the clean scene.
			if (this._friendsOpen) this._closeFriends();
			this.ui.closeEmoteWheel(false);
		} else {
			document.body.classList.remove('zen-revealed');
		}
		this.ui.setZen(this._zen);
		try { localStorage.setItem('play:zen', this._zen ? '1' : '0'); } catch {}
	}

	// Restore the zen preference on world entry: URL param wins (?ui=hidden for
	// shared links, ?ui=on to force chrome back), then the stored choice. Uses
	// the boot-time capture because enter() rewrites the URL before this runs.
	_restoreZen() {
		const param = this._urlUi;
		if (param === 'hidden' || param === 'off') { this._setZen(true); return; }
		if (param === 'on' || param === 'shown') return;
		try { if (localStorage.getItem('play:zen') === '1') this._setZen(true); } catch {}
	}

	// Drop the zen body classes without touching the stored preference: the
	// lobby always shows its UI; _restoreZen() re-applies zen next world entry.
	_suspendZen() {
		this._zen = false;
		document.body.classList.remove('is-zen', 'zen-revealed');
		this.ui.setZen(false);
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
			// reach the caret untouched, no hotkeys, no Enter hijack, no Space eaten.
			if (isTypingTarget(e.target)) return;
			// Esc closes the friends/avatar drawers before anything else claims the key.
			if (e.key === 'Escape' && this._friendsOpen) { e.preventDefault(); this._closeFriends(); return; }
			if (e.key === 'Escape' && this._avatarPanelOpen) { e.preventDefault(); this._closeAvatarPanel(); return; }
			// Enter/Space belong to a focused button or link (see isActivationTarget):
			// hijacking them there leaves the whole HUD un-operable by keyboard.
			const onControl = isActivationTarget(e.target);
			// A modal panel owns the keyboard while it is up, so `f` inside the store
			// must not also cast a fishing line at the avatar behind the card.
			if (hasOpenOverlay()) return;
			if (e.key === 'Enter' && this.phase === 'world' && !onControl) { e.preventDefault(); this.ui.focusChat(); return; }
			// Space jumps on foot; while driving it's the handbrake instead (held,
			// released in the keyup handler below), never scrolls the page either way.
			if (e.code === 'Space' && !onControl) {
				e.preventDefault();
				if (this.vehicles?.isDriving()) { this.vehicles.setHandbrake(true); return; }
				this._jump();
				return;
			}
			const k = e.key.toLowerCase();
			if (this.phase === 'world') {
				// B toggles build mode; while it's on, 1, 0 pick the active block.
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
				// E interacts with whatever the player stands near, a townsperson,
				// the Intel Kiosk, or the Agent Exchange (all built in every world).
				// Not while building.
				if (k === 'e' && !this.buildHud.active) {
					e.preventDefault();
					// A conversation or counter is already open, let it own the moment
					// instead of reopening on top of itself.
					if (isChatPanelOpen() || isServicePanelOpen() || isAixbtPanelOpen() || isZauthPanelOpen()) return;
					// Talk to the nearest townsperson (vendor/quest/flavor); if none is
					// in range, try the Intel Kiosk, then fall through to the Agent
					// Exchange.
					if (!this.worldLife?.interact() && !this.intelKiosk?.interact() && !this.combat?.interact()
						&& !this.wheelStation?.interact() && !this.warPortal?.interact()) this.agentCommerce?.interact();
					return;
				}
				// F is contextual: enter/exit a nearby vehicle takes priority (the
				// on-screen prompt already says "F, Drive" / "F, Exit"); then a
				// gather/craft/pickup station (chop, mine, cook, grab a rod); otherwise
				// it casts a line when standing by a pond (no-op elsewhere). Not while
				// building, where keys drive the block palette.
				if (k === 'f' && !this.buildHud.active) {
					e.preventDefault();
					if (!this.vehicles?.interact() && !this.playActivities?.doAction()) this.playSystems?.castFish();
					return;
				}
				// I inspects the nearest avatar, player, townsperson, or yourself:
				// identity, reputation, wallet. Press again to close.
				if (k === 'i' && !this.buildHud.active && !e.repeat) {
					e.preventDefault();
					this._inspectNearest();
					return;
				}
				// P photographs the world onto a share card. Deliberately live in
				// every mode, zen, building, driving, because the shot is an
				// offscreen render, so no panel is ever in the frame. Ctrl/Cmd+P
				// stays the browser's print dialog.
				if (k === 'p' && !e.repeat && !e.ctrlKey && !e.metaKey) {
					e.preventDefault();
					this._openPhotoMode();
					return;
				}
				// J toggles the friends drawer (W09). F, the /walk binding, is already
				// this world's contextual action key (drive / gather / cast), so /play
				// takes the next free slot; the HUD button carries the same hint.
				if (k === 'j' && !this.buildHud.active && !e.repeat) {
					e.preventDefault();
					this._toggleFriends();
					return;
				}
				// V opens the avatar switcher: change your look without leaving the
				// world. The HUD Avatar button is the touch equivalent.
				if (k === 'v' && !this.buildHud.active && !e.repeat) {
					e.preventDefault();
					this._toggleAvatarPanel();
					return;
				}
				// Z toggles zen mode (every overlay hidden, just the world). Plain Z
				// only: Ctrl/Cmd+Z stays the build-mode undo above.
				if (k === 'z' && !this.buildHud.active && !e.ctrlKey && !e.metaKey && !e.repeat) {
					e.preventDefault();
					this._setZen(!this._zen);
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
				// Q, hold to open the emote wheel, release to play the selected clip.
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
				// 1, 6 select a hotbar slot when not building.
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
			if (consumed) return; // a hold already broke a block, don't also place
			if (moved >= 6 || e.button === 2) return; // a look-drag, or a right-click (handled by contextmenu)
			if (this.phase === 'world' && this.buildHud.active) { this._buildAt(e.clientX, e.clientY, false); return; }
			// Tap a nearby parked vehicle to take the wheel, the touch-native
			// equivalent of pressing F. Checked first: it only ever fires when a
			// vehicle is both in range and under the tap, so it can't shadow the
			// other tap targets below.
			if (this.vehicles?.tryActivateAt(this._pointerRay(e.clientX, e.clientY))) return;
			// Tap the agents (or their exchange ring) to watch a live payment, the
			// touch-native equivalent of pressing E. Checked before the chart screen.
			if (this.worldLife?.tryActivateAt(e.clientX, e.clientY)) return;
			// Tap a nearby tombstone to loot it, the touch-native equivalent of
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
			// A real drag is a look, not a hold, cancel the pending break so panning
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
	// hits the live chart screen's face, powers tap-to-open and the hover cursor.
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
		// like 'offline', let the player build their own local copy.
		return s === 'online' || s === 'offline' || s === 'unavailable';
	}

	// Place or break a block under the pointer. Online is server-authoritative: we
	// only send the intent, and the block appears/disappears when the server echoes
	// its blocks state back (see the blockAdd/blockRemove wiring in enter()). In
	// single-player (no server) we apply the edit straight to the local voxel layer
	//, same result on screen, just not synced or persisted.
	_buildAt(clientX, clientY, forceRemove) {
		if (this.phase !== 'world' || !this._buildableConnection()) return;
		// Prop layer (R18): a click places a free-standing object; right-click / hold
		// deletes one you own. Routed before the voxel path so the two never collide.
		if (this.buildProp) { this._buildPropAt(clientX, clientY, forceRemove); return; }
		if (!this.voxels) return;
		const target = this.voxels.raycast(this._pointerRay(clientX, clientY));
		if (!target) return;
		const removing = forceRemove || this.buildHud.mode === 'remove';
		// A composite piece stamps several cells at once, but only when placing.
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
			// Aimed somewhere illegal (out of bounds / occupied), flash the cursor.
			this.voxels.showGhost(target.placeCell, 'blocked');
			return;
		}
		this._updateGhost(clientX, clientY);
	}

	// Stamp a composite piece (wall / floor / stairs / doorway) anchored at `cell`,
	// rotated by the current quarter-turn. Validated as a whole: every cell must be
	// in bounds, empty, and fit the budget, or nothing lands, so a piece never
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
				? `Not enough room, that piece needs ${cells.length} blocks.`
				: 'That piece doesn’t fit here, rotate it or move back.', 'warn');
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
		// Arming a voxel tool disarms the prop layer, the two placement modes are
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

	// P3.3: bring your own prop. Validate the model locally (size, geometry,
	// triangle budget, real-world scale), upload it through the same presigned-PUT
	// storage path avatars use, register it in the palette, and arm it so the next
	// click drops it into the world. Every failure state is reported in the palette's
	// own status line with a reason the uploader can act on.
	async _uploadProp(file) {
		if (this._propUploading) return;
		this._propUploading = true;
		this.ui.setPropUploadStatus('Checking your model…');
		try {
			// The validator pulls in its own GLTF/VRM parsing path; it is only
			// reachable from this file picker, so it loads with the picker's file.
			const { validatePropModel, uploadPropModel } = await import('./avatar-upload.js');
			const info = await validatePropModel(file);
			this.ui.setPropUploadStatus('Uploading… 0%');
			const url = await uploadPropModel(file, (p) => {
				this.ui.setPropUploadStatus(`Uploading… ${Math.round(p * 100)}%`);
			});
			const name = (file.name || 'Your model').replace(/\.(glb|vrm)$/i, '').slice(0, 24);
			const def = registerUploadedProp(url, { name });
			this.ui.addUploadedProp({ id: def.id, name: def.name });
			this._pickProp(def.id);
			this.ui.setPropUploadStatus('');
			this.ui.toast(
				`${name} is ready${info.vrm ? ' (VRM)' : ''}: click in the world to place it.`,
				'info',
			);
		} catch (err) {
			const message = err?.message || 'That model could not be uploaded.';
			this.ui.setPropUploadStatus(message, true);
			this.ui.toast(message, 'warn');
		} finally {
			this._propUploading = false;
		}
	}

	// Forge-in-world: generate a brand-new prop from a text prompt (or a reference
	// photo) on the free forge lane, then hand the finished GLB to the exact same
	// pipeline uploads use: register it in the palette, arm it, and the next click
	// places it into the shared world (obj:spawn carries the URL, so every player
	// in the server renders it, and the room persists it like any other build).
	// Reachable from the palette's Forge form and the chat command `/forge <prompt>`.
	async _forgeProp({ prompt, file, fromChat } = {}) {
		if (this._propForging) {
			this.ui.toast('One forge at a time: yours is still cooking.', 'warn');
			return;
		}
		this._propForging = true;
		this.ui.setForgeBusy(true);
		const status = (m) => this.ui.setPropUploadStatus(m || '');
		try {
			// Only reachable from the Forge form / `/forge` chat command, so the lane
			// client loads with the first forge rather than with the world.
			const { forgeWorldProp } = await import('./forge-prop.js');
			const out = await forgeWorldProp({ prompt, file, onStatus: status });
			const def = registerUploadedProp(out.url, { name: out.name });
			this.ui.addUploadedProp({ id: def.id, name: def.name });
			// A chat-forged item arrives with the palette closed: open build mode so
			// the armed ghost (and the palette entry) are actually visible.
			if (fromChat && this.buildHud && !this.buildHud.active && !this.buildHud.root.hidden) {
				this.buildHud.setActive(true);
			}
			this._pickProp(def.id);
			this.ui.clearForgeForm();
			status('');
			this.ui.toast(`"${out.name}" is forged: click in the world to place it for everyone.`, 'info');
			if (!out.durable) {
				this.ui.toast('This model is on temporary storage, so the world may refuse it. If placing fails, forge it again.', 'warn');
			}
		} catch (err) {
			// The lane client is loaded lazily above, so identify its errors by their
			// own name rather than by a class binding this scope may not hold.
			const fromLane = err?.name === 'ForgeError';
			if (fromLane && err.cancelled) return;
			const message = fromLane ? err.message : 'The forge hit an error. Try again in a moment.';
			this.ui.setPropUploadStatus(message, true);
			this.ui.toast(message, 'warn');
		} finally {
			this._propForging = false;
			this.ui.setForgeBusy(false);
		}
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
		if (ray.direction.y >= -1e-4) return null; // looking up / parallel, no floor
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
	// (server enforces ownership; we only offer it on your own pieces, R19 hardens it).
	_buildPropAt(clientX, clientY, forceRemove) {
		const removing = forceRemove || this.buildHud.mode === 'remove';
		if (removing) { this._deleteOwnPropAt(clientX, clientY); return; }
		const target = this._propTarget(clientX, clientY);
		if (!target) return;
		if (!target.valid) { this._updatePropGhost(clientX, clientY); return; }
		const yaw = this.buildPropRot * (Math.PI / 2);
		const url = propDef(this.buildProp)?.upload ? propDef(this.buildProp).glb : '';
		if (this._roomIsAuthority()) {
			this.net.spawnObject('block', {
				type: this.buildProp, x: target.x, y: target.y, z: target.z,
				yaw, scale: this.buildPropScale, url: url || undefined,
			});
		} else if (!this._placeLocalProp(target, yaw, url)) {
			return;
		}
		// A short haptic tick confirms the place on touch devices.
		if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(12);
		this._updatePropGhost(clientX, clientY);
	}

	// Place a prop with no authoritative room in the picture (P3.1). It is a real
	// object in the scene AND a real row in the durable world document: not a
	// local-only decoration that quietly disappears: so the same caps the server
	// enforces are enforced here before anything is written.
	_placeLocalProp(target, yaw, url) {
		const store = this._worldStore;
		if (!store) { this.ui.toast('This world’s build store is still loading, try again in a moment.', 'warn'); return false; }
		if (!store.writable) {
			this.ui.toast('Your build here can’t be saved yet, so props are off. Sign in and rejoin to build offline.', 'warn');
			return false;
		}
		const objs = this.worldObjects;
		if (!objs) return false;
		if (objs.localCount() >= MAX_WORLD_OBJECTS) {
			this.ui.toast('This world is full of props: remove some to place more.', 'warn');
			return false;
		}
		if (this._offlineBuilt.size >= MAX_OBJECTS_PER_PLAYER) {
			this.ui.toast('You’ve hit your prop limit for this world: remove some to place more.', 'warn');
			return false;
		}
		const rec = {
			id: `loc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
			type: this.buildProp,
			kind: 'block',
			ownerId: this._buildOwnerKey(),
			x: target.x, y: target.y, z: target.z,
			yaw,
			scale: Math.min(OBJ_SCALE_MAX, Math.max(OBJ_SCALE_MIN, this.buildPropScale)),
			url: url || '',
		};
		objs.addLocal(rec, { mine: true });
		this._offlineBuilt.set(rec.id, rec);
		this._persistLocalBuild();
		this._syncBudget();
		return true;
	}

	// The id an offline placement is owned by. Matches WalkRoom._ownerKey's
	// preference order (verified wallet → persisted economy id) so a prop built
	// offline is still recognisably yours once the room restores the doc.
	_buildOwnerKey() {
		return this.account || this.net?.pid || '';
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
		if (this.worldObjects.isLocal(id)) {
			// A locally-driven prop (restored from the world doc, or built offline):
			// remove it here and record the deletion so the next save doesn't just
			// resurrect it from the doc we loaded.
			this.worldObjects.removeLocal(id);
			this._offlineBuilt?.delete(id);
			this._removedPersisted?.add(id);
			this._persistLocalBuild();
			this._syncBudget();
		} else {
			this.net?.removeObject(id);
		}
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
		const def = propDef(this.buildProp);
		this.propGhost.setType(this.buildProp, def?.upload ? def.glb : '');
		this.propGhost.setPose(target.x, target.y, target.z, this.buildPropRot * (Math.PI / 2), this.buildPropScale);
		// Placement is valid online (the room takes it) or offline once the durable
		// world store is open and writable (P3.1): the ghost tells the truth about
		// which of those is actually available right now.
		this.propGhost.setValid(target.valid && (this._roomIsAuthority() || !!this._worldStore?.writable));
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
			world_full: 'This world is full of props, remove some to place more.',
			player_full: 'You’ve hit your prop limit for this world, remove some to place more.',
			asset_url: 'That model isn’t hosted where this world can load it. Re-upload it and try again.',
		}[reason] || 'That prop couldn’t be placed.';
		this.ui.toast(msg, 'warn');
	}

	// ---------------------------------------------------------------- durable world build (P3.1)
	// Two writers, never at once:
	//   • a live `walk_world` room is authoritative and persists the build itself
	//     (multiplayer/src/persistence.js), so this client only READS;
	//   • with no room, this client is the writer: it renders the persisted build
	//     locally and saves its own placements back through the same API.
	// `WorldBuildStore.setArmed()` is the handover, and `worldIdForCoin()` produces
	// byte-identical keys to WalkRoom's `worldKey`, so both writers touch one doc.

	/** Is the authoritative room currently the writer? */
	_roomIsAuthority() { return this.net?.status === 'online'; }

	// Open (and immediately read) this coin's durable build document.
	_openWorldStore(coin, tier) {
		this._closeWorldStore();
		this._roomSynced = false;
		this._offlineBuilt = new Map(); // id → record, props placed with no room
		this._removedPersisted = new Set(); // ids deleted locally out of the saved doc
		const worldId = worldIdForCoin(coin?.mint || '', tier === 'holders' ? 'holders' : '');
		const store = new WorldBuildStore({
			worldId,
			onDenied: (info) => this._onWorldSaveDenied(info),
			onError: (info) => this._onWorldSaveError(info),
			onSaved: () => { if (!this._roomIsAuthority()) this.buildHud.setPersistent(true); },
		});
		this._worldStore = store;
		// A closed tab must not eat the last few placements: the debounce window is
		// seconds long, so flush on the way out. `pagehide` fires for closes, reloads
		// and bfcache evictions alike, which `beforeunload` does not.
		this._worldStoreUnload = () => { if (store.pending) store.flush().catch(() => {}); };
		addEventListener('pagehide', this._worldStoreUnload);
		const epoch = this._enterEpoch;
		store.load().then(({ doc, error }) => {
			// The player may have left (or hopped coins) while the read was in flight.
			if (this._worldStore !== store || epoch !== this._enterEpoch) return;
			if (error) {
				// Designed degradation: the world opens without its persisted props
				// and the store keeps serving saves, so this is expected-path
				// telemetry rather than a warning, matching _loadCoins above.
				log.info('[coincommunities] world build load failed:', error);
				return;
			}
			this._restorePersistedBuild(doc);
		});
	}

	// Render a loaded doc's props locally. Skipped once the room has synced: from
	// that point the room's own restore of the SAME doc is already in the scene.
	_restorePersistedBuild(doc) {
		if (this._roomSynced || !this.worldObjects) return;
		const objects = docObjects(doc);
		if (!objects.length) return;
		let n = 0;
		for (const o of objects) {
			if (n >= MAX_WORLD_OBJECTS) break;
			this.worldObjects.addLocal(o, { mine: !!this.net?.ownsObject(o) });
			n++;
		}
		this._syncBudget();
		log.info('[coincommunities] restored', n, 'persisted props from the world store');
	}

	// The room finished its first state sync. It restored the same document, so our
	// local copies are duplicates, drop them, and anything we built while offline
	// is handed to the room as real spawn intents so it joins the shared world (and
	// gets persisted by the authority) instead of stranding in a local doc.
	_onRoomSynced() {
		this._roomSynced = true;
		// The roster in this snapshot is now the truth: retire anyone the server
		// didn't re-announce (they left while we were disconnected).
		this._pruneStaleRemotes();
		this._worldStore?.setArmed(false);
		const handoff = [...(this._offlineBuilt?.values() || [])];
		this.worldObjects?.dropLocal();
		this._offlineBuilt?.clear();
		this._removedPersisted?.clear();
		for (const rec of handoff.slice(0, MAX_OBJECTS_PER_PLAYER)) {
			this.net?.spawnObject(rec.kind || 'prop', {
				type: rec.type, x: rec.x, y: rec.y, z: rec.z,
				yaw: rec.yaw, scale: rec.scale, url: rec.url || undefined,
			});
		}
		if (handoff.length) {
			this.ui.toast(`Shared ${handoff.length} prop${handoff.length === 1 ? '' : 's'} you built offline with everyone here.`, 'info');
		}
		this._syncBudget();
	}

	// Hand the pen back to this client after the room drops, so a solo session can
	// keep building into the same durable document.
	_armLocalWorldWriter() {
		if (!this._worldStore) return;
		this._roomSynced = false;
		this._worldStore.setArmed(true);
	}

	// Arm a debounced durable save of the local build. The producer runs at flush
	// time against the FRESHEST doc the store has (re-run after a 409), so a
	// concurrent writer's props are merged rather than overwritten.
	_persistLocalBuild() {
		const store = this._worldStore;
		if (!store || this._roomIsAuthority()) return;
		store.queueSave((base) => {
			const mine = new Map();
			for (const rec of this.worldObjects?.localObjects() || []) mine.set(rec.id, rec);
			const kept = docObjects(base)
				.filter((o) => !this._removedPersisted.has(o.id) && !mine.has(o.id));
			const objects = [...kept, ...mine.values()].slice(0, MAX_WORLD_OBJECTS);
			return { ...(base && typeof base === 'object' ? base : {}), objects };
		});
	}

	// The store refused this client's identity. Terminal for the session, so say so
	// once, plainly, and stop claiming the build is saved.
	_onWorldSaveDenied({ reason }) {
		this.buildHud.setPersistent(false);
		this.ui.toast(reason === 'signin'
			? 'Sign in to save what you build here, until then it only exists in this tab.'
			: 'This world belongs to someone else, so your offline build can’t be saved to it.', 'warn');
	}

	_onWorldSaveError({ reason }) {
		this.buildHud.setPersistent(false);
		if (reason === 'too_large') {
			this.ui.toast('This world has hit its saved-build size limit: remove some props to save more.', 'warn');
			return;
		}
		// Network/server blips are transient: the next placement re-arms the save, so
		// don't shout. The unsaved badge already carries the state.
		log.warn('[coincommunities] world save failed:', reason);
	}

	// Flush anything pending and tear the store down (leaving a world / a coin hop).
	_closeWorldStore() {
		const store = this._worldStore;
		this._worldStore = null;
		this._roomSynced = false;
		this._offlineBuilt = null;
		this._removedPersisted = null;
		if (this._worldStoreUnload) {
			removeEventListener('pagehide', this._worldStoreUnload);
			this._worldStoreUnload = null;
		}
		if (!store) return;
		// Fire-and-forget: the flush is a real network write, but leaving must not
		// wait on it. dispose() after it settles so a late timer can't resurrect.
		store.flush().catch(() => {}).finally(() => store.dispose());
	}

	// Arm a hold-to-break timer for the current press. If the player keeps the
	// pointer down and still (no drag) past LONG_PRESS_MS, break the targeted block
	//, the touch-native equivalent of a right-click. Cancelled by movement or release.
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
	// Throttled to one toast per reason per window, a flood reply can't spam.
	_onEditReject(reason) {
		const now = performance.now();
		this._rejectToastAt ||= {};
		if (now - (this._rejectToastAt[reason] || 0) < 4000) return;
		this._rejectToastAt[reason] = now;
		const msg = {
			budget: `Build limit reached (${MAX_BLOCKS} blocks), break something to make room.`,
			rate: 'Building too fast, slow down a moment.',
			bounds: 'Can’t build there, outside the build area.',
			type: 'That block type isn’t available.',
			owned: 'That block belongs to another builder, you can’t change it.',
			column: 'That stack is too tall here, try building wider, not higher.',
			protected: 'That spot is protected, keep the spawn and totem clear.',
			player: 'You’ve hit your block limit for this world, break some to build more.',
			playercap: 'You’ve hit your block limit for this world, break some to build more.',
			dense: 'That stack is too tall here, try building wider, not higher.',
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
	// meter and reveal the creator-only moderation control. Authoritative, the HUD
	// only surfaces what the server already enforces.
	_onBuildPerms(p) {
		if (!p || typeof p !== 'object') return;
		this._buildPerms = {
			creator: !!p.creator,
			cap: Number(p.cap) || 0,
			used: Number(p.used) || 0,
			// P3.2: the server sends the radius this player earned (visitor / holder
			// world / coin creator). Falling back to the same tier function keeps an
			// older server's omitted field honest instead of guessing a flat number.
			clearMaxRadius: Number(p.clearMaxRadius) || buildClearRadius({
				creator: !!p.creator, holder: this.coin?.tier === 'holders',
			}),
		};
		this.buildHud.setCreator(this._buildPerms.creator);
		this.buildHud.setUsage(this._buildPerms.used, this._buildPerms.cap);
		// R24: the same server-proven creator flag reveals the holder-gate control.
		this.ui.setWorldCreator(this._buildPerms.creator);
	}

	// The permission snapshot before the server has spoken. The clear radius comes
	// from the SAME tier function the room enforces (P3.2), seeded with what this
	// client can honestly claim on its own: no proven creator standing, but it does
	// know which tier of world it asked to enter.
	_defaultBuildPerms() {
		return {
			creator: false,
			cap: 0,
			used: 0,
			clearMaxRadius: buildClearRadius({ creator: false, holder: this.coin?.tier === 'holders' }),
		};
	}

	// Clear the per-player meter + creator tool, on leave and on every (re)connect,
	// before fresh perms arrive, so a solo build or a different world never inherits
	// the last one's allowance or moderation control.
	_resetBuildPerms() {
		this._buildPerms = this._defaultBuildPerms();
		this.buildHud.setCreator(false);
		this.buildHud.setUsage(0, 0);
		this.ui.setWorldCreator(false);
	}

	// Creator gate config (R24): open the modal to set or clear the token threshold
	// a wallet must hold to enter this coin's Holders world. Reads the current value
	// first so the input is pre-filled, then writes through the creator-only
	// endpoint (which re-verifies ownership server-side). Only the coin's verified
	// creator ever reaches this, the button is hidden otherwise.
	async _configureGate() {
		const coin = this.coin;
		if (!coin?.mint) return;
		let current = 0;
		let unknown = false;
		try {
			const cfg = await getWorldGate(coin.mint);
			current = cfg?.minTokens || 0;
		} catch {
			// Couldn't read the current gate, open in an "unknown" state so the creator
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
		const r = this._buildPerms.clearMaxRadius || buildClearRadius({ creator: true, holder: this.coin?.tier === 'holders' });
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
			: 'click to place, right-click to break, 1, 0 pick a block, R rotates pieces, ⌘/Ctrl+Z to undo';
		this.ui.toast(`Build mode${solo ? ' (offline, reconnect to share)' : ''}, ${how}`, 'info');
		this._syncBudget();
		if (this._lastHover) this._updateGhost(this._lastHover.x, this._lastHover.y);
	}

	// ---------------------------------------------------------------- share builds
	// Render the current view into an offscreen target and return a JPEG data URL +
	// dimensions, or null if capture isn't possible. The offscreen render itself
	// lives in scene-capture.js, shared with photo mode, so the world has exactly
	// one answer to "how do you screenshot this"; the downscale here keeps the
	// thumbnail small enough to persist and share.
	_captureBuildShot(maxW = 720) {
		const shot = captureSceneCanvas(this.renderer, this.scene, this.camera, { maxWidth: maxW });
		if (!shot) return null;
		return { dataUrl: shot.canvas.toDataURL('image/jpeg', 0.72), width: shot.width, height: shot.height };
	}

	// ---------------------------------------------------------------- photo mode
	// Capture the world onto a share card the player can download or paste. The
	// whole feature (compositing, the preview sheet, its CSS) lives in
	// photo-mode.js and is imported on the FIRST press, so a session that never
	// takes a photo never downloads it and never pays a frame for it.
	async _openPhotoMode() {
		if (this.phase !== 'world' || this._photoLoading) return;
		this._photoLoading = true;
		try {
			const { takePhoto } = await import('./photo-mode.js');
			const shown = await takePhoto({
				renderer: this.renderer,
				scene: this.scene,
				camera: this.camera,
				coinLabel: this.coin?.symbol ? '$' + this.coin.symbol : '',
				worldLabel: this.coin?.name || '',
				toast: (msg, kind) => this.ui.toast(msg, kind),
				onClose: () => this.ui.setPhotoActive(false),
			});
			this.ui.setPhotoActive(shown);
		} catch (err) {
			log.warn('[coincommunities] photo mode failed to load:', err?.message);
			this.ui.toast('Photo mode couldn’t load, check your connection and try again.', 'warn');
		} finally {
			this._photoLoading = false;
		}
	}

	// Capture a screenshot of the build and open the share sheet: copy a deep link,
	// download the image, or publish it to this coin's featured builds.
	_shareBuild() {
		if (this.phase !== 'world' || !this.coin) return;
		const shot = this._captureBuildShot();
		if (!shot) { this.ui.toast('Couldn’t capture the view, try again.', 'warn'); return; }
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
				const reason = res.status === 429 ? 'Sharing too fast, give it a minute.'
					: res.status === 413 ? 'That screenshot was too large to share.'
					: `Couldn’t publish (error ${res.status}).`;
				return { ok: false, error: reason };
			}
			// A fresh publish belongs at the top of the featured list, refresh if open.
			if (this._featuredOpen) this._loadFeatured();
			return { ok: true };
		} catch (err) {
			log.warn('[coincommunities] publish build failed:', err?.message);
			return { ok: false, error: 'Network error, check your connection and retry.' };
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
		// Self-contained pointer-events joystick, no external lib, so the input
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
	_loop(frameNow) {
		requestAnimationFrame(this._loop);
		const now = frameNow ?? performance.now();
		// Frame cap (see constructor): 60 in-world, 30 blurred or power-saving,
		// and a 4fps trickle while the opaque lobby hides the canvas entirely
		// (the transparent embed keeps 30, its arena stays visible behind the
		// grid). Skipped frames are cheap: everything below is dt-based.
		const lobbyHidden = this.phase === 'lobby' && !this._transparentBg;
		let fpsCap = !this._focus.focused ? FPS_IDLE
			: lobbyHidden ? 4
			: this.phase === 'world' ? FPS_ACTIVE
			: FPS_IDLE;
		if (this._powerSaver) fpsCap = Math.min(fpsCap, FPS_SAVER);
		if (!this._governor.shouldRun(now, fpsCap)) return;
		const dt = Math.min(0.05, (now - this._last) / 1000);
		this._last = now;
		// Only judge frame health at the full-rate cap, a deliberately
		// throttled frame (blur, lobby, saver) is slow by design, not a
		// struggling GPU.
		// Frame health is judged at the full-rate cap only, and never during the
		// first seconds in a world. Entry keeps working after the player takes
		// control (agent desks arrive over the network, the NPC crowd builds, the
		// HDRI upgrade convolves), so frames there are slow because the world is
		// still assembling, not because the device can't draw it. Judged live, that
		// burst downgraded the render tier of machines that had no trouble at all,
		// and the tier only climbs back after six sustained fast seconds: the player
		// spent their first ten seconds looking at a needlessly soft world.
		if (this.phase === 'world' && fpsCap >= FPS_ACTIVE && now - this._worldSince > WATCHDOG_GRACE_MS) {
			this._watchdog.tick(dt);
		}

		if (this.phase === 'world') {
			// W02: while driving, the vehicle IS the local player's movement, skip
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
			for (const [, r] of this.remotes) r.tick(dt, this.camera.position);
			this.worldObjects?.update();
			this._updateLabels();
			this._tickKingZone(dt);
			this._updateVoice();
			this.playSystems?.tick(dt);
			this.playActivities?.tick(dt);
			this.wheelStation?.tick(dt);
			this.warPortal?.tick(dt);
			this.agentCommerce?.tick(dt);
			this.intelKiosk?.tick(dt);
			if (this.worldLife) { this.worldLife.setRealPeers(this.remotes.size); this.worldLife.tick(dt); }
			this.combat?.tick(dt);
			// Ordinary move sync is redundant (and would just get rejected by the
			// server's walking-speed step clamp) while driving, VehicleManager
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
		// Drawing into a lost context throws GL errors on every call and can keep
		// the browser from handing it back. Simulation above keeps running, so the
		// world is live and correct the instant the context returns.
		// _warmShaders holds the canvas on its last frame while it pre-compiles the
		// world's programs; drawing here would force the synchronous compile it is
		// there to prevent. Everything above still ticks, so no simulation time is
		// lost, and the suspension is capped at WARM_TIMEOUT_MS.
		if (!this._contextLost && !this._warming) this.renderer.render(this.scene, this.camera);
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
			// (sinYaw, cosYaw) and camera-right is (cosYaw, -sinYaw), see
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
			// Boundary safety, mirrors the server's square WORLD_BOUND clamp
			// (world-zones.js DISTRICT.half) so client and server never disagree
			// on the world's edge. Snap the body too so the next query starts clean.
			const clamped = clampToBounds(res.position.x, res.position.z);
			if (clamped.x !== res.position.x || clamped.z !== res.position.z) {
				this._character.setPosition({ x: clamped.x, y: res.position.y, z: clamped.z });
			}
			this.localPos.set(clamped.x, res.position.y, clamped.z);
		} else {
			this._physicsActivePrev = false;
			// Legacy direct-mutation fallback, only live for the brief window
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
		// Camera forward on the ground plane is (sin camYaw, cos camYaw), see
		// _updateCamera, where the camera sits opposite this vector from the target.
		const forward = { x: Math.sin(this.camYaw), z: Math.cos(this.camYaw) };
		this.voice.update({ x: this.localPos.x, y: this.localPos.y, z: this.localPos.z }, peers, forward);
	}

	// W01: four-mode chase camera (follow/cinematic/firstperson/topdown) via the
	// shared camera-modes.js controller, see the constructor and the 'c' key in
	// _bindInput. 'follow' reproduces the original fixed orbit exactly, so the
	// default view is unchanged; the other three are new.
	_updateCamera(dt) {
		this._camTarget = this._camTarget || new Vector3();
		// Track the avatar on the ground plane only in follow/cinematic/topdown,
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
		// One scratch vector for the whole sweep, and one style write per node only
		// when the value actually changed. This runs every frame for every peer, so
		// at event scale (100 in one plaza) the naive version allocated ~300 Vector3
		// per frame and re-wrote ~300 transforms whether or not anything moved, a
		// steady GC drip plus a style recalc on a crowd standing still.
		const v = this._labelProj || (this._labelProj = new Vector3());
		const cam = this.camera;
		const place = (node, pos, dy) => {
			v.set(pos.x, pos.y + dy, pos.z).project(cam);
			if (v.z > 1 || v.z < -1) {
				if (node._ccHidden !== true) { node.style.display = 'none'; node._ccHidden = true; }
				return;
			}
			if (node._ccHidden !== false) { node.style.display = ''; node._ccHidden = false; }
			const t = `translate(-50%, -100%) translate(${(v.x * 0.5 + 0.5) * w}px, ${(-v.y * 0.5 + 0.5) * h}px)`;
			if (node._ccT !== t) { node.style.transform = t; node._ccT = t; }
		};
		const hide = (node) => { if (node._ccHidden !== true) { node.style.display = 'none'; node._ccHidden = true; } };
		// Anchor name + bubble to each avatar's real head height so they sit just
		// above the head regardless of how tall/short the GLB is. Past LABEL_RANGE_M
		// a nameplate is a couple of unreadable pixels, so it is hidden rather than
		// projected: the cost of a distant crowd stops scaling with its size.
		const cx = this.localPos.x, cz = this.localPos.z;
		for (const [, r] of this.remotes) {
			const p = r.rig.position;
			if ((p.x - cx) ** 2 + (p.z - cz) ** 2 > LABEL_RANGE_M * LABEL_RANGE_M) {
				hide(r.label);
				if (r.bubble) hide(r.bubble);
				if (r._itLabel) hide(r._itLabel);
				continue;
			}
			place(r.label, p, r.height + 0.2);
			if (r.bubble) place(r.bubble, p, r.height + 0.7);
			if (r._itLabel) place(r._itLabel, p, r.height + 0.65);
		}
		if (this._localBubble && this.localRig) place(this._localBubble, this.localPos, (this.localHeight || 1.7) + 0.7);
		if (this._localItLabel && this.localRig) place(this._localItLabel, this.localPos, (this.localHeight || 1.7) + 0.65);
	}

	_onResize() {
		const w = window.innerWidth, h = window.innerHeight;
		// A minimized/hidden tab or an in-flight teardown can report a 0 dimension;
		// setting a 0 aspect NaNs the projection matrix and blanks the scene.
		if (!w || !h || !this.camera || !this.renderer) return;
		this.camera.aspect = w / h;
		this.camera.updateProjectionMatrix();
		this.renderer.setSize(w, h);
		// Re-apply the pixel ratio: setSize keeps the renderer's current ratio,
		// but devicePixelRatio may have changed (display move / zoom). _applyPerfTier
		// reads the live devicePixelRatio and re-clamps it to the active tier.
		this._applyPerfTier();
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

	// The boot avatar's render loop targets a canvas we're about to remove, stop
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
		? 'Your browser couldn’t start 3D graphics. Turn on hardware acceleration (or WebGL) and reload, on most browsers it’s under Settings › System.'
		: 'Something went wrong starting Coin Communities. Reload to try again, if it keeps happening, your browser may be out of date.';
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
