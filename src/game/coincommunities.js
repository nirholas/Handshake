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
import { normalizeGatewayURL } from '../ipfs.js';
import {
	loadManifest, getEmoteDefs, resolveAvatarUrl, buildAvatar, playEmoteClip,
	CLIP_IDLE, CLIP_WALK,
} from './avatar-rig.js';

const WORLD_RADIUS = 58; // a touch inside the server's 60m clamp
const MOVE_SPEED = 4.2;
const RUN_SPEED = 8.0; // hold Shift to sprint
const RUN_TIMESCALE = 1.7; // speed the walk cycle up so a sprint reads as a run
const JUMP_VELOCITY = 5.5; // m/s upward kick on Space; ~1m apex under GRAVITY
const GRAVITY = 15; // m/s^2 pulling the jumper back down
const REMOTE_LERP = 0.18;
const JOY_DEADZONE = 0.12; // swallow tiny stick grazes so the avatar doesn't drift
const TRENDING_URL = '/api/pump/trending?limit=30';
const SEARCH_URL = '/api/pump/search';

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

		this.setAvatar(player.avatar);
	}
	setAvatar(url) {
		if (url === this._avatarUrl) return;
		this._avatarUrl = url;
		// rebuild model
		this.rig.clear();
		this.anim = new AnimationManager();
		resolveAvatarUrl(url).then((u) => buildAvatar(this.rig, u, this.anim).then(({ height }) => {
			this.height = height;
			this.anim.crossfadeTo(this.motion === 'walk' || this.motion === 'run' ? CLIP_WALK : CLIP_IDLE, 0);
		}));
	}
	apply(player) {
		this.targetX = player.x; this.targetY = player.y; this.targetZ = player.z; this.targetYaw = player.yaw;
		if (player.name) this.label.textContent = player.name;
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
			onEnter: (coin) => this.enter(coin),
			onLeave: () => this.leave(),
			onChat: (t) => this._sendChat(t),
			onEmote: (n) => this._emote(n),
			onSearch: (q) => this._searchCoins(q),
			onRetry: () => this.net?.retry(),
			onAvatarChange: (url) => { this.net?.setAvatar(url); },
		});

		this._hideBootLoader();
		this._loadCoins();
		this._bindInput();

		this._loop = this._loop.bind(this);
		requestAnimationFrame(this._loop);

		// Deep link: /play?coin=<mint>&name=&symbol=&image= drops straight into a
		// coin's community, so a community is a shareable URL.
		const p = new URLSearchParams(location.search);
		const mint = p.get('coin');
		if (mint) {
			this.enter({ mint, name: p.get('name') || '', symbol: p.get('symbol') || '', image: normalizeGatewayURL(p.get('image') || '') });
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
	}

	// Central coin totem — the community's banner in 3D.
	_buildTotem(coin) {
		const g = new Group();
		const pillar = new Mesh(new CylinderGeometry(1.1, 1.4, 6, 24),
			new MeshStandardMaterial({ color: 0x2a2a30, roughness: 0.7, metalness: 0.1 }));
		pillar.position.y = 3; pillar.castShadow = true; pillar.receiveShadow = true;
		g.add(pillar);
		// Floating coin disc with the token image — polished chrome that catches the
		// moonlight key, slowly turning. Monochrome: the only colour is the light it
		// reflects (and the token art on its faces).
		const spin = new Group(); spin.position.y = 7.5;
		const disc = new Mesh(new CylinderGeometry(2.2, 2.2, 0.3, 40),
			new MeshStandardMaterial({ color: 0xd8d8de, roughness: 0.22, metalness: 0.95, emissive: 0x202024, emissiveIntensity: 0.25 }));
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
		x.font = 'bold 32px Inter, system-ui, sans-serif'; x.fillStyle = 'rgba(255,255,255,0.6)';
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
	async enter(coin) {
		if (this.phase !== 'lobby') return;
		this.phase = 'loading';
		this.coin = coin;
		this.ui.enterWorld(coin);
		// Reflect the community in the URL so it can be shared / refreshed into.
		try {
			const q = new URLSearchParams({ coin: coin.mint });
			if (coin.name) q.set('name', coin.name);
			if (coin.symbol) q.set('symbol', coin.symbol);
			if (coin.image) q.set('image', coin.image);
			history.replaceState(null, '', location.pathname + '?' + q.toString());
		} catch { /* non-fatal */ }
		await loadManifest();
		this.ui.setEmotes(getEmoteDefs().map((d) => ({ name: d.name, icon: d.icon || '🙂', label: d.label })));

		// Build the coin's world + local avatar.
		this._buildTotem(coin);
		this._buildScreen(coin);
		// Live trading terminal facing the spawn from past the totem: the coin's
		// price chart, % change, volume, buy/sell flow, and a ticker of real
		// on-chain trades — a second screen players can walk up to and tap to open
		// the coin on pump.fun. Identity jumbotron behind, market chart ahead.
		this._chartScreen = createChartScreen(this.scene, coin, { position: [0, 0, -30], width: 18 });
		this.localRig = new Group();
		this.localRig.position.copy(this.localPos);
		this.scene.add(this.localRig);
		this.localAnim = new AnimationManager();
		const avatarInput = this.ui.getAvatar();
		const url = await resolveAvatarUrl(avatarInput);
		const { height: localHeight } = await buildAvatar(this.localRig, url, this.localAnim);
		this.localHeight = localHeight;

		// Connect to this coin's room.
		const name = localStorage.getItem('cc-name') || ('guest-' + Math.random().toString(36).slice(2, 6));
		localStorage.setItem('cc-name', name);
		this.net = new CommunityNet({
			name, avatar: /^https?:\/\//i.test(avatarInput) || avatarInput.startsWith('/') ? avatarInput : url,
			coin: { mint: coin.mint, name: coin.name, symbol: coin.symbol, image: coin.image },
		});
		this.net.on('status', ({ status }) => { this.ui.setStatus(status); this._updateOnline(); });
		this.net.on('add', (p, id) => this._onAdd(p, id));
		this.net.on('change', (p, id) => this._onChange(p, id));
		this.net.on('remove', (id) => this._onRemove(id));
		this.net.on('chat', (m) => this._onChat(m));
		await this.net.connect();
		this.phase = 'world';
		this._initJoystick();
	}

	leave() {
		if (this.net) { this.net.destroy(); this.net = null; }
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
	}
	_onChat(m) {
		const mine = m.id === this.net.sessionId;
		this.ui.addChat({ name: m.name, text: m.text, mine });
		if (mine) this._sayLocal(m.text);
		else this.remotes.get(m.id)?.say(m.text);
	}
	_sendChat(text) { this.net?.sendChat(text); }
	_emote(name) { this.net?.sendEmote(name); playEmoteClip(this.localAnim, name, this.motion); }

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
			this.keys.add(e.key.toLowerCase());
		});
		window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
		this.canvas.addEventListener('pointerdown', (e) => {
			this._dragging = true; this._lastPtr = { x: e.clientX, y: e.clientY };
			this._downPtr = { x: e.clientX, y: e.clientY };
		});
		window.addEventListener('pointerup', () => { this._dragging = false; });
		// A tap (negligible drag) on the live chart screen opens the coin on pump.fun.
		this.canvas.addEventListener('pointerup', (e) => {
			if (!this._downPtr) return;
			const moved = Math.hypot(e.clientX - this._downPtr.x, e.clientY - this._downPtr.y);
			this._downPtr = null;
			if (moved < 6 && this._raycastScreen(e.clientX, e.clientY)) this._chartScreen.openExternal();
		});
		window.addEventListener('pointermove', (e) => {
			if (!this._dragging) {
				// Hover cursor over the clickable screen (throttled).
				const now = performance.now();
				if (this.phase === 'world' && this._chartScreen && now - (this._hoverAt || 0) > 80) {
					this._hoverAt = now;
					this.canvas.style.cursor = this._raycastScreen(e.clientX, e.clientY) ? 'pointer' : '';
				}
				return;
			}
			const dx = e.clientX - this._lastPtr.x, dy = e.clientY - this._lastPtr.y;
			this._lastPtr = { x: e.clientX, y: e.clientY };
			this.camYaw -= dx * 0.005;
			this.camPitch = Math.max(0.1, Math.min(1.2, this.camPitch + dy * 0.004));
		});
		this.canvas.addEventListener('wheel', (e) => {
			e.preventDefault();
			this.camDist = Math.max(4, Math.min(20, this.camDist * (e.deltaY > 0 ? 1.1 : 0.9)));
		}, { passive: false });
	}

	// Cast a ray from a screen-space point into the world and report whether it
	// hits the live chart screen's face — powers tap-to-open and the hover cursor.
	_raycastScreen(clientX, clientY) {
		if (!this._chartScreen?.mesh) return false;
		this._raycaster = this._raycaster || new Raycaster();
		this._ndc = this._ndc || new Vector2();
		const rect = this.canvas.getBoundingClientRect();
		this._ndc.set(
			((clientX - rect.left) / rect.width) * 2 - 1,
			-((clientY - rect.top) / rect.height) * 2 + 1,
		);
		this._raycaster.setFromCamera(this._ndc, this.camera);
		return this._raycaster.intersectObject(this._chartScreen.mesh, false).length > 0;
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
