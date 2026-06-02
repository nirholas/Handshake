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
	Scene, WebGLRenderer, PerspectiveCamera, Group, Vector3, PCFSoftShadowMap, SRGBColorSpace,
	ACESFilmicToneMapping,
	Mesh, MeshStandardMaterial, MeshBasicMaterial, CircleGeometry,
	CylinderGeometry, PlaneGeometry,
	CanvasTexture, TextureLoader, DoubleSide,
	Raycaster, Vector2,
} from 'three';

import { AnimationManager } from '../animation-manager.js';
import { CommunityNet } from './community-net.js';
import { CommunityUI } from './coincommunities-ui.js';
import { createWorldEnvironment } from './world-env.js';
import { createChartScreen } from './chart-screen.js';
import { MarketReactor } from './market-reactor.js';
import { VoxelWorld, createBuildHud, parseKey, MAX_BLOCKS } from './build-voxels.js';
import { normalizeGatewayURL } from '../ipfs.js';
import {
	loadManifest, getEmoteDefs, resolveAvatarUrl, buildAvatar, playEmoteClip,
	CLIP_IDLE, CLIP_WALK,
} from './avatar-rig.js';
import { GUEST_SENTINEL, uploadPendingGuestAvatar } from './play-handoff.js';
import { HOME_TOWN, isHomeTown } from './home-town.js';
import { VoiceChat, voiceSupported } from './voice-chat.js';
import { requestHolderPass, signInWithX, ensureSolanaWallet, relinkSolanaWallet, getSession } from '../community/town-auth.js';
import { ensurePlayAccess } from './play-gate.js';
import { clearStoredPass, fetchPlayConfig, signInToPlay, loadStoredPass, storePass } from './play-auth.js';
import { PlaySystems } from './play-systems.js';

const WORLD_RADIUS = 58; // a touch inside the server's 60m clamp
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
	return (Array.isArray(raw) ? raw : raw.coins || raw.items || []).map((c) => ({
		mint: c.mint || c.address,
		name: (c.name || '').trim() || 'Unnamed coin',
		symbol: (c.symbol || '').trim(),
		image: normalizeGatewayURL(c.image_uri || c.image || c.imageUri || ''),
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

		this.label = document.createElement('div');
		this.label.className = 'cc-label';
		this.label.textContent = player.name || 'guest';
		document.body.appendChild(this.label);

		this.bubble = null;
		this._bubbleTimer = null;
		this.height = 1.7; // avatar head height; updated once the GLB measures

		this.voice = !!player.voice;
		this.label.classList.toggle('cc-invoice', this.voice);
		this.setAvatar(player.avatar);
	}
	setAvatar(url) {
		if (url === this._avatarUrl) return;
		this._avatarUrl = url;
		// rebuild model
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
		})).catch(() => {});
	}
	apply(player) {
		this.targetX = player.x; this.targetY = player.y; this.targetZ = player.z; this.targetYaw = player.yaw;
		if (player.name) this.label.textContent = player.name;
		if (player.voice !== undefined && !!player.voice !== this.voice) {
			this.voice = !!player.voice;
			this.label.classList.toggle('cc-invoice', this.voice);
			if (!this.voice) this.setSpeaking(false);
		}
		if (player.avatar !== this._avatarUrl) this.setAvatar(player.avatar);
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
	}
	dispose() {
		this._disposed = true;
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
			onVoiceToggle: () => this._toggleVoice(),
		});

		// Collaborative building HUD (hotbar + place/break toggle). Hidden until the
		// player is in a world and connected — there's nowhere to build otherwise.
		this.buildType = 0;
		this.buildHud = createBuildHud({
			onToggle: (on) => this._onBuildToggle(on),
			onPick: (i) => { this.buildType = i; },
			onModeChange: () => this._refreshGhost(),
		});
		this.buildHud.root.hidden = true;
		this.buildHud.setEnabled(false);

		this._hideBootLoader();
		this._loadHomeTown();
		this._loadCoins();
		this._bindInput();

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
		// coin's community, so a community is a shareable URL.
		const p = new URLSearchParams(location.search);
		const mint = p.get('coin');
		if (mint) {
			const tier = p.get('tier') === 'holders' ? 'holders' : 'general';
			this.enter({ mint, name: p.get('name') || '', symbol: p.get('symbol') || '', image: normalizeGatewayURL(p.get('image') || '') }, { tier });
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

	async _loadCoins() {
		this.ui.setCoinsLoading();
		try {
			const r = await fetch(TRENDING_URL, { headers: { accept: 'application/json' } });
			if (!r.ok) throw new Error('HTTP ' + r.status);
			const raw = await r.json();
			this.ui.setCoins(mapCoins(raw));
		} catch (err) {
			console.warn('[coincommunities] coin load failed:', err?.message);
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
			console.warn('[coincommunities] home town refresh failed:', err?.message);
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
		const r = new WebGLRenderer({ canvas: this.canvas, antialias: true });
		r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
		r.setSize(window.innerWidth, window.innerHeight);
		r.shadowMap.enabled = true; r.shadowMap.type = PCFSoftShadowMap;
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

		this.env = createWorldEnvironment(scene, this.renderer, WORLD_RADIUS);

		this.world = new Group();
		scene.add(this.world);
	}

	// Animate the world each frame: drifting clouds (owned by the environment)
	// and the slowly turning coin totem.
	_tickEnv(dt) {
		this.env?.update(dt);
		if (this._coinSpin) this._coinSpin.rotation.y += dt * 0.5;
		if (this._screenPulse) {
			this._screenT = (this._screenT || 0) + dt;
			this._screenPulse.material.opacity = 0.35 + 0.35 * (0.5 + 0.5 * Math.sin(this._screenT * 2.4));
		}
		this._chartScreen?.update(dt);
		this._reactor?.update(dt);
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
		if (tier === 'holders') {
			const pass = await this._passHolderGate(coin);
			if (!pass) return;
			holderPass = pass.holderPass;
			holderMinUsd = pass.minUsd;
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
		coin = { ...coin, tier, holderMinUsd };
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

		// Re-theme the environment for this specific community: a distinct biome,
		// palette, and flora derived deterministically from the coin's mint, so
		// every community has its own recognisable world.
		this.env?.dispose();
		// The flagship town pins its signature biome; every other coin draws its
		// look from the mint seed.
		const biomeOverride = isHomeTown(coin.mint) ? (coin.biome || HOME_TOWN.biome) : undefined;
		this.env = createWorldEnvironment(this.scene, this.renderer, WORLD_RADIUS, { mint: coin.mint, biome: biomeOverride });
		this.ui.toast(`${coin.symbol ? '$' + coin.symbol : coin.name || 'Community'} — ${this.env.biome.label}`, 'info');

		// Build the coin's world + local avatar.
		this._buildTotem(coin);
		this._buildScreen(coin);
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
		this.localRig = new Group();
		this.localRig.position.copy(this.localPos);
		this.scene.add(this.localRig);
		this.localAnim = new AnimationManager();
		const avatarInput = this.ui.getAvatar();
		const url = await resolveAvatarUrl(avatarInput);
		const { height: localHeight, fallback: avatarFallback } = await buildAvatar(this.localRig, url, this.localAnim);
		// Backed out while the avatar GLB was loading — stop before we open a room.
		if (epoch !== this._enterEpoch) return;
		this.localHeight = localHeight;
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
			name = localStorage.getItem('cc-name') || ('guest-' + Math.random().toString(36).slice(2, 6));
			this.ui.setName(name);
		}
		localStorage.setItem('cc-name', name);
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
		});
		if (isGuest) uploadPendingGuestAvatar((publicUrl) => this.net?.setAvatar(publicUrl));
		this.net.on('status', ({ status }) => {
			this.ui.setStatus(status);
			this._updateOnline();
			// Reconnect exhausted: the player is now alone in a local-only world.
			// The small status pill alone is easy to miss, so explain the drop once —
			// other players, chat and shared building are off, and how to recover.
			if (status === 'failed' && !this._failedNotified) {
				this._failedNotified = true;
				this.ui.toast('Lost the connection — you’re in single-player. Builds here won’t be saved or seen by others. Tap the status pill to reconnect.', 'warn');
			}
			if (status === 'online') this._failedNotified = false;
			// Every (re)connect re-streams the server's authoritative build, so wipe
			// the local layer first. On a manual retry out of single-player this also
			// hands authority back: the solo build gives way to the shared world's.
			if (status === 'connecting') { this.voxels?.clear(); this._undoStack = []; this._syncBudget(); }
			// Building is available with a live server (synced + persisted for
			// everyone) and in solo single-player mode (local-only) once multiplayer
			// has been given up. The connecting window is the only time it's off, so
			// the toggle never becomes a dead, silent button.
			this.buildHud.setEnabled(this._buildableConnection(), 'Connecting to the world…');
			// Durability badge: online reflects the server's persistent flag; solo
			// single-player isn't saved at all, so hide it (null) to avoid a false
			// promise. Re-sync the budget meter against whatever layer is now live.
			this.buildHud.setPersistent(status === 'online' ? this.net?.persistent : (status === 'offline' ? false : null));
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
		this.net.on('ping', (ms) => this.ui.setPing(ms));
		this.net.on('blockAdd', (key, t) => { const [x, y, z] = parseKey(key); this.voxels?.setBlock(x, y, z, t); this._syncBudget(); });
		this.net.on('blockChange', (key, t) => { const [x, y, z] = parseKey(key); this.voxels?.setBlock(x, y, z, t); });
		this.net.on('blockRemove', (key) => { const [x, y, z] = parseKey(key); this.voxels?.removeBlock(x, y, z); this._syncBudget(); });
		this.net.on('editReject', ({ reason }) => this._onEditReject(reason));
		// Durability flag for this world's build — drives the HUD "Saved" badge.
		this.net.on('persistent', (durable) => { if (this.net?.status === 'online') this.buildHud.setPersistent(durable); });

		// Game systems (economy + activities). The server streams this player's own
		// pack/purse/skills here; PlaySystems renders the HUD, ponds, and cast visual,
		// and re-anchors fishing to fixed world features. Built per-world, torn down on
		// leave() so coins never share a pond or an inventory panel.
		this.playSystems = new PlaySystems({
			scene: this.scene,
			getPlayer: () => ({ x: this.localPos.x, y: this.localPos.y, z: this.localPos.z, yaw: this.localYaw, height: this.localHeight || 1.6 }),
			net: this.net,
			ui: this.ui,
		});
		this.net.on('profile', (snap) => this.playSystems?.setProfile(snap));
		this.net.on('inv', (delta) => this.playSystems?.applyInv(delta));
		this.net.on('xpgain', (g) => this.playSystems?.onXpGain(g));
		this.net.on('levelup', (l) => this.playSystems?.onLevelup(l));
		this.net.on('notice', (n) => this.playSystems?.onNotice(n));

		this.buildHud.root.hidden = false;
		await this.net.connect();
		// Player backed out mid-connect: leave() already tore everything down and
		// nulled this.net. Bail rather than dereference it / re-enter 'world'.
		if (epoch !== this._enterEpoch || !this.net) return;
		this._initVoice();
		this.phase = 'world';
		this._initJoystick();
		this._onboardBuild();
		// Start the silent pass-refresh cycle. The play pass has a 10-min server
		// TTL; the server sweeps expired passes every minute. We refresh 2 min early
		// so a player in a long session is never evicted mid-build. The refresh
		// re-reads the chain (via /api/play/verify) so a wallet that offloaded its
		// tokens is refused rather than silently let through on a stale pass.
		this._schedulePassRefresh();
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
	// up 2 min before the pass expires, re-runs the sign+verify flow silently (no
	// UI), and updates this.playPass so the next reconnect uses the fresh token.
	// Re-checks the chain, so a wallet that offloaded its tokens gets evicted here
	// rather than on the next reconnect. Cancels automatically when leave() tears
	// the net down.
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
		if (this.phase !== 'world' || !this.account) return;
		try {
			const cfg = await fetchPlayConfig();
			if (!cfg.required) return; // gate turned off — nothing to refresh
			const res = await signInToPlay({ nonce: cfg.nonce });
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
		} catch {
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
			console.warn('[coincommunities] play gate error:', err?.message);
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
							this.ui.setHolderGate('granted', { symbol, usd: res.usd, minUsd: res.minUsd });
							// Let the "verified" state land for a beat before the world builds.
							await new Promise((r) => setTimeout(r, 650));
							this.ui.closeHolderGate();
							return res;
						}
						state = 'short';
						data = { symbol, usd: res?.usd ?? 0, amount: res?.amount ?? 0, minUsd: res?.minUsd ?? 8 };
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
				console.warn('[coincommunities] voice join failed:', err?.name, err?.message);
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
		if (this.playSystems) { this.playSystems.dispose(); this.playSystems = null; }
		for (const [, r] of this.remotes) r.dispose();
		this.remotes.clear();
		if (this._totem) { this.world.remove(this._totem); this._totem = null; this._coinSpin = null; }
		if (this._screen) {
			this.world.remove(this._screen);
			this._screenTex?.dispose();
			this._screen = null; this._screenCanvas = null; this._screenTex = null;
			this._screenArt = null; this._screenPulse = null;
		}
		if (this._chartScreen) { this._chartScreen.dispose(); this._chartScreen = null; }
		if (this._reactor) { this._reactor.dispose(); this._reactor = null; }
		if (this.voxels) { this.voxels.dispose(); this.voxels = null; }
		this._cancelLongPress();
		clearTimeout(this._onboardTimer);
		this._undoStack = []; // history is per-world; don't carry edits across coins
		this.buildHud.setActive(false);
		this.buildHud.setEnabled(false);
		this.buildHud.setPersistent(null);
		this.buildHud.root.hidden = true;
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

	// ---------------------------------------------------------------- net events
	_onAdd(player, id) {
		if (id === this.net.sessionId) return; // that's us
		this.remotes.set(id, new RemotePlayer(this.scene, player));
		this._updateOnline();
	}
	_onChange(player, id) {
		if (id === this.net.sessionId) return;
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

	// Live rename: persist and broadcast so peers' nameplates update instantly.
	_rename(name) {
		const clean = (name || '').trim().slice(0, 24);
		if (clean) localStorage.setItem('cc-name', clean);
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
			console.warn('[coincommunities] buy modal failed to load:', err?.message);
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
			if (e.key === 'Enter' && this.phase === 'world') { e.preventDefault(); this.ui.focusChat(); return; }
			if (e.code === 'Space') { e.preventDefault(); this._jump(); return; } // don't scroll the page
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
				// F casts a line when standing by a pond (no-op elsewhere). Not while
				// building, where keys drive the block palette.
				if (k === 'f' && !this.buildHud.active) {
					e.preventDefault();
					this.playSystems?.castFish();
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
		window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
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
					else if (this._chartScreen) this.canvas.style.cursor = this._raycastScreen(e.clientX, e.clientY) ? 'pointer' : '';
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
		return s === 'online' || s === 'offline';
	}

	// Place or break a block under the pointer. Online is server-authoritative: we
	// only send the intent, and the block appears/disappears when the server echoes
	// its blocks state back (see the blockAdd/blockRemove wiring in enter()). In
	// single-player (no server) we apply the edit straight to the local voxel layer
	// — same result on screen, just not synced or persisted.
	_buildAt(clientX, clientY, forceRemove) {
		if (!this.voxels || this.phase !== 'world' || !this._buildableConnection()) return;
		const target = this.voxels.raycast(this._pointerRay(clientX, clientY));
		if (!target) return;
		if (forceRemove || this.buildHud.mode === 'remove') {
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
		}[reason] || 'That edit couldn’t be applied.';
		this.ui.toast(msg, 'warn');
	}

	// Move the ghost cursor to whatever the pointer aims at, tinted by intent
	// (green place / red break / amber blocked).
	_updateGhost(clientX, clientY) {
		if (!this.voxels) return;
		const target = this.voxels.raycast(this._pointerRay(clientX, clientY));
		if (!target) { this.voxels.hideGhost(); return; }
		if (this.buildHud.mode === 'remove') {
			if (target.hit === 'block') this.voxels.showGhost(target.cell, 'remove');
			else this.voxels.hideGhost();
		} else {
			this.voxels.showGhost(target.placeCell, target.placeValid ? 'place' : 'blocked');
		}
	}

	// Re-evaluate the ghost after a mode flip, without waiting for pointer motion.
	_refreshGhost() {
		if (this.buildHud.active && this._lastHover) this._updateGhost(this._lastHover.x, this._lastHover.y);
	}

	_onBuildToggle(on) {
		if (!on) { this.voxels?.hideGhost(); this.canvas.style.cursor = ''; return; }
		const touch = typeof matchMedia === 'function' && matchMedia('(hover: none), (pointer: coarse)').matches;
		const solo = this.net?.status !== 'online';
		const how = touch
			? 'tap to place, hold to break, pick a block, ⌘/Ctrl+Z to undo'
			: 'click to place, right-click to break, 1–0 pick a block, ⌘/Ctrl+Z to undo';
		this.ui.toast(`Build mode${solo ? ' (single-player)' : ''} — ${how}`, 'info');
		this._syncBudget();
		if (this._lastHover) this._updateGhost(this._lastHover.x, this._lastHover.y);
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
			this._stepLocal(dt);
			this.localAnim?.update(dt);
			for (const [, r] of this.remotes) r.tick(dt);
			this._updateLabels();
			this._updateVoice();
			this.playSystems?.tick(dt);
			if (this.net) this.net.sendMove({ x: this.localPos.x, y: this.localPos.y, z: this.localPos.z, yaw: this.localYaw, motion: this.motion });
		}
		this._tickEnv(dt);
		this._updateCamera();
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
		// Vertical integration first so a jump arcs even while standing still.
		if (!this.grounded) {
			this.vy -= GRAVITY * dt;
			this.localPos.y += this.vy * dt;
			if (this.localPos.y <= 0) { this.localPos.y = 0; this.vy = 0; this.grounded = true; }
		}

		// Build intent from keys + joystick, relative to camera yaw.
		let ix = 0, iz = 0;
		if (this.keys.has('w') || this.keys.has('arrowup')) iz -= 1;
		if (this.keys.has('s') || this.keys.has('arrowdown')) iz += 1;
		if (this.keys.has('a') || this.keys.has('arrowleft')) ix -= 1;
		if (this.keys.has('d') || this.keys.has('arrowright')) ix += 1;
		if (this._joy) { ix += this._joy.x; iz += this._joy.z; }
		const running = this.keys.has('shift');
		const mag = Math.hypot(ix, iz);
		if (mag > 0.05) {
			ix /= Math.max(1, mag); iz /= Math.max(1, mag);
			// Map intent into world space using the camera's own basis so the
			// keys read screen-relative: forward (W/up) goes straight away from
			// the camera, D/right tracks screen-right. Camera forward is
			// (sinYaw, cosYaw) and camera-right is (cosYaw, -sinYaw) — see
			// _updateCamera. world = ix*right + (-iz)*forward.
			const sin = Math.sin(this.camYaw), cos = Math.cos(this.camYaw);
			const wx = ix * cos - iz * sin;
			const wz = -ix * sin - iz * cos;
			const speed = running ? RUN_SPEED : MOVE_SPEED;
			this.localPos.x += wx * speed * dt;
			this.localPos.z += wz * speed * dt;
			// clamp to plaza
			const r = Math.hypot(this.localPos.x, this.localPos.z);
			if (r > WORLD_RADIUS) { this.localPos.x *= WORLD_RADIUS / r; this.localPos.z *= WORLD_RADIUS / r; }
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
		if (this.localRig) { this.localRig.position.copy(this.localPos); this.localRig.rotation.y = this.localYaw; }
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

	_updateCamera() {
		// Track the avatar on the ground plane only — ignore jump height so the
		// camera stays planted while the character hops.
		const target = this.phase === 'world' && this.localRig
			? new Vector3(this.localPos.x, 0, this.localPos.z)
			: new Vector3(0, 2, 0);
		const cp = Math.cos(this.camPitch), sp = Math.sin(this.camPitch);
		const ox = Math.sin(this.camYaw) * cp * this.camDist;
		const oz = Math.cos(this.camYaw) * cp * this.camDist;
		const oy = sp * this.camDist + 1.4;
		this.camera.position.set(target.x - ox, target.y + oy, target.z - oz);
		this.camera.lookAt(target.x, target.y + 1.4, target.z);
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
		}
		if (this._localBubble && this.localRig) place(this._localBubble, this.localPos, (this.localHeight || 1.7) + 0.7);
	}

	_onResize() {
		this.camera.aspect = window.innerWidth / window.innerHeight;
		this.camera.updateProjectionMatrix();
		this.renderer.setSize(window.innerWidth, window.innerHeight);
	}
}

const canvas = document.getElementById('kx-canvas') || document.getElementById('cc-canvas');
if (canvas) {
	const game = new CoinCommunities(canvas);
	if (typeof window !== 'undefined') window.__CC__ = game;
}
