// Site-wide Walk Companion
// =========================
// A persistent 3D avatar mascot that idles in the corner of every standard
// three.ws page, turns to follow your cursor, waves when you navigate between
// pages, and greets you with a page-aware tip. Opt-in: toggled from the nav
// "Walk" button or with ?walk=1, and remembered across page loads via
// localStorage (`walk:companion:enabled`).
//
// Delivery mirrors /footer-bot.js: this file is a Vite-bundled ES module
// emitted to the stable, unhashed path /walk-companion.js (see
// vite.config.js → rollupOptions.output.entryFileNames), and public/nav.js
// injects it with <script type="module" src="/walk-companion.js"> only when the
// companion is enabled — so there is zero footprint (no Three.js fetch) when
// it's off.
//
// Motion reuses the same building blocks as the rest of the platform: the
// default mascot is the shared RobotExpressive rig (also used by the footer
// bot) with its embedded Idle / Walking / Wave clips, and a ?avatar=<id>
// override loads that avatar's GLB and drives it with the retargeted shared
// clip library via AnimationManager — the exact flow src/walk-embed.js uses.

import {
	AmbientLight,
	AnimationMixer,
	Box3,
	Clock,
	DirectionalLight,
	Group,
	HemisphereLight,
	LoopOnce,
	LoopRepeat,
	PerspectiveCamera,
	Scene,
	Vector3,
	WebGLRenderer,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { AnimationManager } from './animation-manager.js';
import { getMeshoptDecoder } from './viewer/internal.js';
import { reserveWebGLContext, releaseWebGLContext } from './webgl-budget.js';

// ── Config ──────────────────────────────────────────────────────────────────
const ENABLED_KEY = 'walk:companion:enabled';
const STATE_KEY = 'walk:companion:state';
const AVATAR_KEY = 'walk:companion:avatar';
const GREET_KEY = 'walk:companion:greet'; // sessionStorage flag set on internal nav
const ROBOT_URL = '/animations/robotexpressive.glb';
const MANIFEST_URL = '/animations/manifest.json';

// Retargeted shared-library clip names for the ?avatar= path (verified present
// in /animations/manifest.json + /animations/clips/*.json).
const AVATAR_CLIPS = { idle: 'idle', walk: 'av-walk-feminine', wave: 'wave' };

const CANVAS_W = 200;
const CANVAS_H = 280;
const WAVE_MS = 1500;
const CURSOR_IDLE_MS = 450; // cursor still longer than this → stop walking

// Routes that already own the viewport with their own 3D / full-screen
// experience, where a corner mascot would be redundant or intrusive.
const EXCLUDED_PREFIXES = [
	'/walk',
	'/walk-embed',
	'/embed',
	'/game',
	'/play',
	'/club',
	'/city',
	'/xr',
	'/ar',
	'/pose',
	'/mocap-studio',
	'/avatar-studio',
];

// ── Small storage helpers (private-mode safe) ───────────────────────────────
function lsGet(key) {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}
function lsSet(key, val) {
	try {
		localStorage.setItem(key, val);
	} catch {
		/* private mode / disabled storage — non-fatal */
	}
}
function ssGet(key) {
	try {
		return sessionStorage.getItem(key);
	} catch {
		return null;
	}
}
function ssSet(key, val) {
	try {
		sessionStorage.setItem(key, val);
	} catch {
		/* non-fatal */
	}
}
function ssDel(key) {
	try {
		sessionStorage.removeItem(key);
	} catch {
		/* non-fatal */
	}
}

function prefersReducedMotion() {
	try {
		return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
	} catch {
		return false;
	}
}

function isExcludedRoute() {
	if (window.top !== window.self) return true; // never inside an iframe/embed
	const path = location.pathname.replace(/\/$/, '') || '/';
	return EXCLUDED_PREFIXES.some((p) => path === p || path.startsWith(p + '/'));
}

// ── Page-context greeting ───────────────────────────────────────────────────
// Real DOM reads, not canned data: the agent/avatar name comes from the page's
// own heading; the pricing/features tips reference what's actually on screen.
function contextGreeting() {
	const path = location.pathname.replace(/\/$/, '') || '/';
	if (path === '/pricing' || path === '/x-pricing') {
		return 'Picking a plan? I can point you to the popular one.';
	}
	if (path === '/features') {
		return 'Tap any feature card to see it in action.';
	}
	if (path.startsWith('/agent') || path.startsWith('/a/') || path.startsWith('/marketplace')) {
		const name = pageSubjectName();
		return name ? `Say hi to ${name}!` : 'Browse agents — I’ll tag along.';
	}
	if (path === '/' || path.startsWith('/home')) {
		return 'Hey! I’m your guide. I’ll walk with you.';
	}
	return 'I’ll walk along while you explore.';
}

function pageSubjectName() {
	const el = document.querySelector('[data-agent-name], .agent-name, h1');
	const txt = el?.textContent?.trim();
	if (!txt || txt.length > 40) return null;
	return txt;
}

// Element the avatar should orient toward for the current route, if present.
function contextTargetEl() {
	const path = location.pathname.replace(/\/$/, '') || '/';
	if (path === '/pricing' || path === '/x-pricing') {
		return document.querySelector(
			'[data-recommended], .pricing-card.is-featured, .plan.is-popular, .pricing-card--popular',
		);
	}
	if (path === '/features') {
		return document.querySelector('.feature-card, [data-feature]');
	}
	return null;
}

// ── Motion controllers ──────────────────────────────────────────────────────
// Both controllers expose the same interface: setBase('idle'|'walk'),
// playWave(), update(dt), dispose(). The companion logic never branches on
// which rig is loaded.

function makeMixerController(root, clips) {
	const mixer = new AnimationMixer(root);
	const byName = (name) =>
		clips.find((c) => c.name.toLowerCase() === name.toLowerCase());
	const pick = (candidates) => {
		for (const n of candidates) {
			const c = byName(n);
			if (c) return c;
		}
		return clips[0] || null;
	};

	const map = {
		idle: pick(['Idle', 'idle']),
		walk: pick(['Walking', 'Walk', 'walk']),
		wave: pick(['Wave', 'wave']),
	};
	const action = {};
	for (const [state, clip] of Object.entries(map)) {
		if (!clip) continue;
		const a = mixer.clipAction(clip);
		a.enabled = true;
		action[state] = a;
	}

	let base = 'idle';
	let current = null;
	let waving = false;

	function crossfade(next, { once = false } = {}) {
		const a = action[next] || action.idle;
		if (!a) return;
		a.reset();
		a.setLoop(once ? LoopOnce : LoopRepeat, once ? 1 : Infinity);
		a.clampWhenFinished = once;
		a.fadeIn(0.3).play();
		if (current && current !== a) current.fadeOut(0.3);
		current = a;
	}

	mixer.addEventListener('finished', () => {
		if (waving) {
			waving = false;
			crossfade(base);
		}
	});

	crossfade('idle');

	return {
		setBase(next) {
			if (next === base) return;
			base = next;
			if (!waving) crossfade(base);
		},
		playWave() {
			if (!action.wave || waving) return;
			waving = true;
			crossfade('wave', { once: true });
		},
		update(dt) {
			mixer.update(dt);
		},
		dispose() {
			mixer.stopAllAction();
			mixer.uncacheRoot(root);
		},
	};
}

function makeManagerController(manager, baseClipName) {
	let base = 'idle';
	let waveTimer = null;
	// crossfadeTo is async (it lazy-loads the clip); the clips are preloaded via
	// loadAll() so these won't reject in practice, but swallow to be safe.
	const fade = (name, dur) => Promise.resolve(manager.crossfadeTo(name, dur)).catch(() => {});

	fade(AVATAR_CLIPS.idle, 0.0);

	function targetClip(state) {
		return state === 'walk' ? baseClipName : AVATAR_CLIPS.idle;
	}

	return {
		setBase(next) {
			if (next === base) return;
			base = next;
			if (!waveTimer) fade(targetClip(base), 0.3);
		},
		playWave() {
			if (waveTimer) return;
			fade(AVATAR_CLIPS.wave, 0.25);
			waveTimer = setTimeout(() => {
				waveTimer = null;
				fade(targetClip(base), 0.3);
			}, WAVE_MS);
		},
		update(dt) {
			manager.update(dt);
		},
		dispose() {
			clearTimeout(waveTimer);
			manager.dispose();
		},
	};
}

// ── The companion instance ──────────────────────────────────────────────────
class WalkCompanion {
	constructor() {
		this.mounted = false;
		this.host = null;
		this.renderer = null;
		this.scene = null;
		this.camera = null;
		this.rig = null;
		this.controller = null;
		this.clock = null;
		this._raf = 0;
		this._reduced = prefersReducedMotion();

		// Cursor tracking (page coordinates), updated by a passive listener.
		this._cursorX = window.innerWidth * 0.5;
		this._cursorMovedAt = 0;
		this._yaw = 0;
		this._targetYaw = 0;
		this._onPointerMove = this._onPointerMove.bind(this);
		this._onLinkClick = this._onLinkClick.bind(this);
		this._onVisibility = this._onVisibility.bind(this);
		this._onPageHide = this._onPageHide.bind(this);
		this._tick = this._tick.bind(this);
	}

	async mount() {
		if (this.mounted || isExcludedRoute()) return;
		if (!this._webglSupported()) return;
		this.mounted = true;

		this._buildDom();

		try {
			await this._buildScene();
		} catch (err) {
			console.warn('[walk-companion] failed to load avatar:', err?.message || err);
			this._teardownScene();
			this._showError();
			return;
		}

		this._restoreState();
		this._bindEvents();
		this._greetForRoute();
		this.clock = new Clock();
		this._raf = requestAnimationFrame(this._tick);
	}

	unmount() {
		if (!this.mounted) return;
		this.mounted = false;
		cancelAnimationFrame(this._raf);
		this._raf = 0;

		window.removeEventListener('pointermove', this._onPointerMove);
		document.removeEventListener('click', this._onLinkClick, true);
		document.removeEventListener('visibilitychange', this._onVisibility);
		window.removeEventListener('pagehide', this._onPageHide);

		this._teardownScene();
		if (this.host && this.host.parentNode) this.host.parentNode.removeChild(this.host);
		this.host = null;
	}

	// ── DOM / styles ────────────────────────────────────────────────────────
	_buildDom() {
		ensureStyles();
		const host = document.createElement('div');
		host.className = 'walk-companion';
		host.setAttribute('role', 'complementary');
		host.setAttribute('aria-label', 'Walk companion');
		host.innerHTML = `
			<button type="button" class="walk-companion-close" aria-label="Dismiss walk companion" title="Dismiss">×</button>
			<div class="walk-companion-bubble" hidden></div>
			<canvas class="walk-companion-canvas" width="${CANVAS_W}" height="${CANVAS_H}"></canvas>
		`;
		document.body.appendChild(host);
		this.host = host;
		this.canvas = host.querySelector('.walk-companion-canvas');
		this.bubble = host.querySelector('.walk-companion-bubble');
		host.querySelector('.walk-companion-close').addEventListener('click', () => disable());
		// Clicking the avatar makes it wave + re-greet.
		this.canvas.addEventListener('click', () => {
			this.controller?.playWave();
			this._say(contextGreeting());
		});
		requestAnimationFrame(() => host.classList.add('is-in'));
	}

	_showError() {
		// Avatar couldn't load (offline / GLB 404). Don't leave a dead canvas —
		// remove the host entirely; the toggle stays available to retry. The
		// WebGL budget was already released by _teardownScene (called first).
		if (this.host && this.host.parentNode) this.host.parentNode.removeChild(this.host);
		this.host = null;
		this.mounted = false;
	}

	// ── Three.js scene ────────────────────────────────────────────────────────
	async _buildScene() {
		const renderer = new WebGLRenderer({
			canvas: this.canvas,
			alpha: true,
			antialias: true,
		});
		renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
		renderer.setSize(CANVAS_W, CANVAS_H, false);
		this.renderer = renderer;
		// Count this context against the shared budget, paired with the
		// release in _teardownScene so reserve/release always balance.
		reserveWebGLContext();

		const scene = new Scene();
		this.scene = scene;
		scene.add(new AmbientLight(0xffffff, 0.85));
		const hemi = new HemisphereLight(0xbcd6ff, 0x202830, 0.7);
		hemi.position.set(0, 4, 0);
		scene.add(hemi);
		const sun = new DirectionalLight(0xffffff, 1.6);
		sun.position.set(2, 5, 4);
		scene.add(sun);

		const camera = new PerspectiveCamera(40, CANVAS_W / CANVAS_H, 0.05, 100);
		this.camera = camera;

		const rig = new Group();
		scene.add(rig);
		this.rig = rig;

		const avatarId = this._resolveAvatarId();
		if (avatarId) {
			await this._loadAvatar(avatarId, rig, camera);
		} else {
			await this._loadRobot(rig, camera);
		}
	}

	_resolveAvatarId() {
		const param = new URLSearchParams(location.search).get('avatar');
		if (param) {
			lsSet(AVATAR_KEY, param);
			return param;
		}
		return lsGet(AVATAR_KEY) || null;
	}

	// One GLTFLoader wired with the meshopt decoder only: the default robot rig
	// is uncompressed, but server-baked avatars (the ?avatar= path) emit
	// EXT_meshopt_compression — and crucially, draco/KTX2 are never used by the
	// bake, so we avoid pulling KTX2Loader (keeps the chunk small and dodges a
	// heavier decoder init). Mirrors src/voice/talk-scene.js.
	async _makeLoader() {
		const loader = new GLTFLoader();
		loader.setMeshoptDecoder(await getMeshoptDecoder());
		return loader;
	}

	async _loadRobot(rig, camera) {
		const loader = await this._makeLoader();
		const gltf = await loader.loadAsync(ROBOT_URL);
		const model = gltf.scene;
		this._frame(model, rig, camera);
		this.controller = makeMixerController(model, gltf.animations || []);
	}

	async _loadAvatar(id, rig, camera) {
		const url = `/api/avatars/${encodeURIComponent(id)}/glb`;
		const loader = await this._makeLoader();
		const gltf = await loader.loadAsync(url);
		const model = gltf.scene;
		this._frame(model, rig, camera);

		const manager = new AnimationManager();
		manager.attach(model);
		const manifest = await fetch(MANIFEST_URL, { cache: 'force-cache' }).then((r) => {
			if (!r.ok) throw new Error(`HTTP ${r.status} fetching animation manifest`);
			return r.json();
		});
		const wanted = new Set(Object.values(AVATAR_CLIPS));
		const defs = manifest.filter((d) => wanted.has(d.name));
		if (!defs.some((d) => d.name === AVATAR_CLIPS.idle)) {
			throw new Error('animation manifest missing idle clip');
		}
		manager.setAnimationDefs(defs);
		await manager.loadAll();
		const walkName = defs.some((d) => d.name === AVATAR_CLIPS.walk)
			? AVATAR_CLIPS.walk
			: AVATAR_CLIPS.idle;
		this.controller = makeManagerController(manager, walkName);
	}

	// Center the model on X/Z, drop its feet to the floor, and frame the camera
	// to show the full body within the portrait canvas.
	_frame(model, rig, camera) {
		model.traverse((n) => {
			if (n.isMesh) n.frustumCulled = false;
		});
		const box = new Box3().setFromObject(model);
		const size = box.getSize(new Vector3());
		const center = box.getCenter(new Vector3());
		model.position.x -= center.x;
		model.position.z -= center.z;
		model.position.y -= box.min.y;
		rig.add(model);

		const height = Math.max(0.6, size.y);
		camera.position.set(0, height * 0.62, height * 2.25);
		camera.lookAt(0, height * 0.52, 0);
		this._height = height;
	}

	_teardownScene() {
		try {
			this.controller?.dispose();
		} catch {
			/* non-fatal */
		}
		this.controller = null;
		if (this.scene) {
			this.scene.traverse((n) => {
				if (n.isMesh) {
					n.geometry?.dispose?.();
					const mats = Array.isArray(n.material) ? n.material : [n.material];
					mats.forEach((m) => {
						if (!m) return;
						for (const v of Object.values(m)) {
							if (v && v.isTexture) v.dispose();
						}
						m.dispose?.();
					});
				}
			});
		}
		this.scene = null;
		if (this.renderer) {
			this.renderer.dispose();
			this.renderer.forceContextLoss?.();
			this.renderer = null;
			releaseWebGLContext();
		}
	}

	// ── Events ────────────────────────────────────────────────────────────────
	_bindEvents() {
		window.addEventListener('pointermove', this._onPointerMove, { passive: true });
		document.addEventListener('click', this._onLinkClick, true);
		document.addEventListener('visibilitychange', this._onVisibility);
		window.addEventListener('pagehide', this._onPageHide);
	}

	_onPointerMove(e) {
		this._cursorX = e.clientX;
		this._cursorMovedAt = performance.now();
	}

	// Wave goodbye + flag the next page so the companion waves hello on arrival,
	// giving the cross-navigation continuity. Never blocks the navigation.
	_onLinkClick(e) {
		const a = e.target.closest?.('a[href]');
		if (!a) return;
		if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
		const href = a.getAttribute('href');
		if (!href || href.startsWith('#')) return;
		if (a.target && a.target !== '_self') return;
		let url;
		try {
			url = new URL(href, location.href);
		} catch {
			return;
		}
		if (url.origin !== location.origin) return;
		if (url.pathname === location.pathname) return;
		this.controller?.playWave();
		ssSet(GREET_KEY, '1');
	}

	_onVisibility() {
		if (document.hidden) {
			cancelAnimationFrame(this._raf);
			this._raf = 0;
		} else if (this.mounted && !this._raf) {
			this.clock?.getDelta(); // discard the idle gap so dt stays bounded
			this._raf = requestAnimationFrame(this._tick);
		}
	}

	_onPageHide() {
		this._persistState();
	}

	// ── Greeting / speech bubble ──────────────────────────────────────────────
	_greetForRoute() {
		const arrivedByNav = ssGet(GREET_KEY) === '1';
		ssDel(GREET_KEY);
		if (arrivedByNav) this.controller?.playWave();
		// Orient toward a route-relevant element if there is one.
		this._orientToContext();
		this._say(contextGreeting());
	}

	_orientToContext() {
		const el = contextTargetEl();
		if (!el) return;
		const rect = el.getBoundingClientRect();
		const elCenterX = rect.left + rect.width / 2;
		const hostRect = this.host.getBoundingClientRect();
		const hostCenterX = hostRect.left + hostRect.width / 2;
		this._targetYaw = clamp((elCenterX - hostCenterX) / window.innerWidth, -0.6, 0.6);
		// Hold the context-facing pose briefly before cursor-follow takes over.
		this._orientLock = true;
		clearTimeout(this._orientTimer);
		this._orientTimer = setTimeout(() => {
			this._orientLock = false;
		}, 4000);
	}

	_say(text) {
		if (!this.bubble || !text) return;
		this.bubble.textContent = text;
		this.bubble.hidden = false;
		this.bubble.classList.add('is-in');
		clearTimeout(this._bubbleTimer);
		this._bubbleTimer = setTimeout(() => {
			this.bubble.classList.remove('is-in');
			setTimeout(() => {
				if (this.bubble) this.bubble.hidden = true;
			}, 300);
		}, 5200);
	}

	// ── Persistence (Option B: localStorage resume) ───────────────────────────
	_persistState() {
		if (!this.controller) return;
		lsSet(STATE_KEY, JSON.stringify({ yaw: this._yaw }));
	}

	_restoreState() {
		try {
			const raw = lsGet(STATE_KEY);
			if (!raw) return;
			const s = JSON.parse(raw);
			if (typeof s.yaw === 'number') {
				this._yaw = s.yaw;
				this._targetYaw = s.yaw;
			}
		} catch {
			/* corrupt state — ignore */
		}
	}

	// ── Render loop ───────────────────────────────────────────────────────────
	_tick() {
		if (!this.mounted) return;
		const dt = Math.min(this.clock.getDelta(), 0.05);

		// Decide motion: walking while the cursor is in motion and off to one
		// side; idling once it settles. Reduced-motion users get a calm idle.
		const movingRecently = performance.now() - this._cursorMovedAt < CURSOR_IDLE_MS;
		if (!this._reduced && !this._orientLock) {
			const rel = (this._cursorX - window.innerWidth / 2) / (window.innerWidth / 2);
			this._targetYaw = clamp(rel * 0.7, -0.7, 0.7);
		}
		const turning = Math.abs(this._targetYaw - this._yaw) > 0.04;
		const shouldWalk = !this._reduced && (movingRecently || turning);
		this.controller?.setBase(shouldWalk ? 'walk' : 'idle');

		// Smoothly turn the rig toward the cursor side.
		this._yaw += (this._targetYaw - this._yaw) * 0.12;
		if (this.rig) this.rig.rotation.y = this._yaw;

		this.controller?.update(dt);
		this.renderer.render(this.scene, this.camera);
		this._raf = requestAnimationFrame(this._tick);
	}

	_webglSupported() {
		try {
			const c = document.createElement('canvas');
			return !!(
				window.WebGLRenderingContext &&
				(c.getContext('webgl2') || c.getContext('webgl'))
			);
		} catch {
			return false;
		}
	}
}

function clamp(v, lo, hi) {
	return Math.max(lo, Math.min(hi, v));
}

// ── Scoped styles (injected once) ───────────────────────────────────────────
let _stylesInjected = false;
function ensureStyles() {
	if (_stylesInjected) return;
	_stylesInjected = true;
	const style = document.createElement('style');
	style.id = 'walk-companion-style';
	style.textContent = `
.walk-companion{position:fixed;right:16px;bottom:16px;width:${CANVAS_W}px;height:${CANVAS_H}px;z-index:2147483000;pointer-events:none;opacity:0;transform:translateY(12px);transition:opacity .35s ease,transform .35s ease;-webkit-user-select:none;user-select:none}
.walk-companion.is-in{opacity:1;transform:translateY(0)}
.walk-companion-canvas{position:absolute;inset:0;width:100%;height:100%;z-index:1;pointer-events:auto;cursor:pointer;filter:drop-shadow(0 18px 22px rgba(0,0,0,.32))}
.walk-companion-close{position:absolute;top:2px;right:2px;z-index:3;width:22px;height:22px;border:none;border-radius:50%;background:rgba(12,14,20,.55);color:#fff;font-size:15px;line-height:1;cursor:pointer;pointer-events:auto;opacity:0;transition:opacity .2s ease,background .2s ease;display:grid;place-items:center;padding:0}
.walk-companion:hover .walk-companion-close,.walk-companion:focus-within .walk-companion-close{opacity:1}
.walk-companion-close:hover{background:rgba(220,60,60,.85)}
.walk-companion-close:focus-visible{outline:2px solid #7aa2ff;outline-offset:2px;opacity:1}
.walk-companion-bubble{position:absolute;left:50%;bottom:calc(100% - 38px);z-index:2;transform:translateX(-50%) translateY(6px);max-width:230px;width:max-content;background:rgba(18,20,28,.94);color:#f2f4f8;font:500 12.5px/1.4 system-ui,-apple-system,'Segoe UI',sans-serif;padding:8px 11px;border-radius:12px;border:1px solid rgba(255,255,255,.1);box-shadow:0 10px 28px rgba(0,0,0,.35);pointer-events:none;opacity:0;transition:opacity .3s ease,transform .3s ease;text-align:center}
.walk-companion-bubble.is-in{opacity:1;transform:translateX(-50%) translateY(0)}
.walk-companion-bubble::after{content:'';position:absolute;left:50%;top:100%;transform:translateX(-50%);border:6px solid transparent;border-top-color:rgba(18,20,28,.94)}
@media (max-width:520px){.walk-companion{width:148px;height:208px;right:10px;bottom:10px}.walk-companion-bubble{font-size:11.5px;max-width:170px}}
@media (prefers-reduced-motion:reduce){.walk-companion,.walk-companion-bubble{transition:none}}
`;
	document.head.appendChild(style);
}

// ── Public API (driven by public/nav.js) ────────────────────────────────────
let _instance = null;

function emitChange() {
	try {
		window.dispatchEvent(
			new CustomEvent('walk-companion:change', { detail: { enabled: isEnabled() } }),
		);
	} catch {
		/* non-fatal */
	}
}

function isEnabled() {
	return lsGet(ENABLED_KEY) === '1';
}

function enable() {
	lsSet(ENABLED_KEY, '1');
	if (!_instance) _instance = new WalkCompanion();
	_instance.mount();
	emitChange();
}

function disable() {
	lsSet(ENABLED_KEY, '0');
	if (_instance) _instance.unmount();
	emitChange();
}

function toggle() {
	if (isEnabled() && _instance && _instance.mounted) disable();
	else enable();
}

window.__walkCompanion = { enable, disable, toggle, isEnabled };

// Auto-mount on load when enabled (nav.js only injects this module when the
// flag is set or the user just toggled it on, so this is the common path).
const _params = new URLSearchParams(location.search);
if (_params.get('walk') === '0') {
	disable();
} else if (_params.get('walk') === '1' || isEnabled()) {
	enable();
}
