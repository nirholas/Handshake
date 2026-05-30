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
	Scene, Color, Fog, WebGLRenderer, PerspectiveCamera, Group, Vector3,
	HemisphereLight, DirectionalLight, AmbientLight, PCFSoftShadowMap, SRGBColorSpace,
	Mesh, MeshStandardMaterial, MeshBasicMaterial, CircleGeometry, RingGeometry,
	CylinderGeometry, PlaneGeometry,
	CanvasTexture, TextureLoader, DoubleSide,
} from 'three';

import { AnimationManager } from '../animation-manager.js';
import { CommunityNet } from './community-net.js';
import { CommunityUI } from './coincommunities-ui.js';
import { normalizeGatewayURL } from '../ipfs.js';
import {
	loadManifest, getEmoteDefs, resolveAvatarUrl, buildAvatar, playEmoteClip,
	CLIP_IDLE, CLIP_WALK,
} from './avatar-rig.js';

const WORLD_RADIUS = 58; // a touch inside the server's 60m clamp
const MOVE_SPEED = 4.2;
const REMOTE_LERP = 0.18;
const JOY_DEADZONE = 0.12; // swallow tiny stick grazes so the avatar doesn't drift
const TRENDING_URL = '/api/pump/trending?limit=30';

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
		this._dragging = false; this._lastPtr = null;
		this._last = performance.now();

		this._initRenderer();
		this._initScene();

		this.ui = new CommunityUI({
			onEnter: (coin) => this.enter(coin),
			onLeave: () => this.leave(),
			onChat: (t) => this._sendChat(t),
			onEmote: (n) => this._emote(n),
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

	_hideBootLoader() {
		const l = document.getElementById('kx-loading');
		if (l) { l.classList.add('kx-hidden'); setTimeout(() => l.remove(), 600); }
	}

	async _loadCoins() {
		this.ui.setCoinsLoading();
		try {
			const r = await fetch(TRENDING_URL, { headers: { accept: 'application/json' } });
			if (!r.ok) throw new Error('HTTP ' + r.status);
			const raw = await r.json();
			const list = (Array.isArray(raw) ? raw : raw.coins || raw.items || []).map((c) => ({
				mint: c.mint || c.address,
				name: (c.name || '').trim() || 'Unnamed coin',
				symbol: (c.symbol || '').trim(),
				image: normalizeGatewayURL(c.image_uri || c.image || c.imageUri || ''),
				marketCap: c.usd_market_cap || c.market_cap_usd || c.marketCap || 0,
			})).filter((c) => c.mint);
			this.ui.setCoins(list);
		} catch (err) {
			console.warn('[coincommunities] coin load failed:', err?.message);
			this.ui.setCoinsError(() => this._loadCoins());
		}
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
		// Monochrome world: a near-black void, graphite plaza, light drawn only as
		// white. Keeps the avatars (full colour) reading as the focal subjects.
		const scene = new Scene();
		scene.background = new Color(0x060607);
		scene.fog = new Fog(0x060607, 55, 125);
		this.scene = scene;

		this.camera = new PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 500);

		scene.add(new HemisphereLight(0xffffff, 0x141416, 0.85));
		scene.add(new AmbientLight(0xffffff, 0.22));
		const sun = new DirectionalLight(0xffffff, 1.15);
		sun.position.set(30, 52, 20); sun.castShadow = true;
		sun.shadow.mapSize.set(2048, 2048);
		const s = sun.shadow.camera; s.left = -70; s.right = 70; s.top = 70; s.bottom = -70; s.near = 1; s.far = 200;
		sun.shadow.bias = -0.0004;
		scene.add(sun, sun.target);

		// Plaza floor — graphite.
		const floor = new Mesh(new CircleGeometry(WORLD_RADIUS + 2, 64),
			new MeshStandardMaterial({ color: 0x121214, roughness: 0.92, metalness: 0.0 }));
		floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true;
		scene.add(floor);
		// Crisp white boundary ring — the only "glow" in the scene.
		const ring = new Mesh(new RingGeometry(WORLD_RADIUS, WORLD_RADIUS + 0.6, 96),
			new MeshBasicMaterial({ color: 0xffffff, side: DoubleSide, transparent: true, opacity: 0.7 }));
		ring.rotation.x = -Math.PI / 2; ring.position.y = 0.02;
		scene.add(ring);
		// Concentric guide circles for depth — faint white hairlines.
		for (const rad of [14, 28, 42]) {
			const g = new Mesh(new RingGeometry(rad, rad + 0.06, 96),
				new MeshBasicMaterial({ color: 0xffffff, side: DoubleSide, transparent: true, opacity: 0.12 }));
			g.rotation.x = -Math.PI / 2; g.position.y = 0.015; scene.add(g);
		}

		this.world = new Group();
		scene.add(this.world);
	}

	// Central coin totem — the community's banner in 3D.
	_buildTotem(coin) {
		const g = new Group();
		const pillar = new Mesh(new CylinderGeometry(1.1, 1.4, 6, 24),
			new MeshStandardMaterial({ color: 0x1b1b1e, roughness: 0.5, metalness: 0.4 }));
		pillar.position.y = 3; pillar.castShadow = true; pillar.receiveShadow = true;
		g.add(pillar);
		// Floating coin disc with the token image — brushed silver.
		const disc = new Mesh(new CylinderGeometry(2.2, 2.2, 0.3, 40),
			new MeshStandardMaterial({ color: 0xd6d6da, roughness: 0.3, metalness: 0.85, emissive: 0x222226, emissiveIntensity: 0.3 }));
		disc.rotation.x = Math.PI / 2; disc.position.y = 7.5; disc.castShadow = true;
		g.add(disc);
		this._totemDisc = disc;
		if (coin.image) {
			new TextureLoader().load(coin.image, (tex) => {
				tex.colorSpace = SRGBColorSpace;
				const face = new Mesh(new CircleGeometry(1.9, 40), new MeshBasicMaterial({ map: tex }));
				face.position.set(0, 7.5, 0.18); g.add(face);
				const back = new Mesh(new CircleGeometry(1.9, 40), new MeshBasicMaterial({ map: tex }));
				back.position.set(0, 7.5, -0.18); back.rotation.y = Math.PI; g.add(back);
			}, undefined, () => { /* image blocked — totem still shows */ });
		}
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
		if (this._totem) { this.world.remove(this._totem); this._totem = null; }
		if (this.localRig) { this.scene.remove(this.localRig); this.localRig = null; }
		if (this._nipple) { this._nipple.destroy(); this._nipple = null; }
		this.phase = 'lobby';
		try { history.replaceState(null, '', location.pathname); } catch { /* non-fatal */ }
		this.ui.showLobby();
	}

	_updateOnline() {
		const n = (this.remotes.size + (this.net?.status === 'online' ? 1 : 0)) || 1;
		this.ui.setOnline(n);
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
			this.keys.add(e.key.toLowerCase());
		});
		window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
		this.canvas.addEventListener('pointerdown', (e) => { this._dragging = true; this._lastPtr = { x: e.clientX, y: e.clientY }; });
		window.addEventListener('pointerup', () => { this._dragging = false; });
		window.addEventListener('pointermove', (e) => {
			if (!this._dragging) return;
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
			if (this.net) this.net.sendMove({ x: this.localPos.x, y: 0, z: this.localPos.z, yaw: this.localYaw, motion: this.motion });
		}
		this._updateCamera();
		this.renderer.render(this.scene, this.camera);
	}

	_stepLocal(dt) {
		// Build intent from keys + joystick, relative to camera yaw.
		let ix = 0, iz = 0;
		if (this.keys.has('w') || this.keys.has('arrowup')) iz -= 1;
		if (this.keys.has('s') || this.keys.has('arrowdown')) iz += 1;
		if (this.keys.has('a') || this.keys.has('arrowleft')) ix -= 1;
		if (this.keys.has('d') || this.keys.has('arrowright')) ix += 1;
		if (this._joy) { ix += this._joy.x; iz += this._joy.z; }
		const mag = Math.hypot(ix, iz);
		if (mag > 0.05) {
			ix /= Math.max(1, mag); iz /= Math.max(1, mag);
			// rotate intent by camera yaw so W is "away from camera"
			const sin = Math.sin(this.camYaw), cos = Math.cos(this.camYaw);
			const wx = ix * cos - iz * sin;
			const wz = ix * sin + iz * cos;
			this.localPos.x += wx * MOVE_SPEED * dt;
			this.localPos.z += wz * MOVE_SPEED * dt;
			// clamp to plaza
			const r = Math.hypot(this.localPos.x, this.localPos.z);
			if (r > WORLD_RADIUS) { this.localPos.x *= WORLD_RADIUS / r; this.localPos.z *= WORLD_RADIUS / r; }
			this.localYaw = Math.atan2(wx, wz);
			if (this.motion !== 'walk') { this.motion = 'walk'; this.localAnim?.crossfadeTo(CLIP_WALK, 0.18); }
		} else if (this.motion !== 'idle') {
			this.motion = 'idle'; this.localAnim?.crossfadeTo(CLIP_IDLE, 0.2);
		}
		if (this.localRig) { this.localRig.position.copy(this.localPos); this.localRig.rotation.y = this.localYaw; }
	}

	_updateCamera() {
		const target = this.phase === 'world' && this.localRig ? this.localPos : new Vector3(0, 2, 0);
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
