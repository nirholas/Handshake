// Walk Companion — a persistent 3D avatar that walks and talks over your pages.
// =============================================================================
// A small avatar idles in the corner of every page, turns to follow the cursor,
// waves when you navigate, and greets you with a page-aware line. Click it and
// it detaches into the full-page Playground. An avatar picker lets each visitor
// choose who walks with them, from a diverse roster, and hot-swaps the rig live.
//
// This module is side-effect free on import: call `createWalkCompanion(config)`
// to get a controller, then `.bootstrap()` (or `.enable()`) to mount. That keeps
// it safe to `import` from a bundler while still supporting the app's
// inject-on-demand delivery.

import {
	AmbientLight,
	Box3,
	Timer,
	DirectionalLight,
	Group,
	HemisphereLight,
	PerspectiveCamera,
	Scene,
	Vector3,
	WebGLRenderer,
} from 'three';
import { reserveWebGLContext, releaseWebGLContext } from './internal/budget.js';
import { log } from './internal/log.js';
import {
	lsGet,
	lsSet,
	ssGet,
	ssSet,
	ssDel,
	prefersReducedMotion,
	webglSupported,
	clamp,
} from './internal/storage.js';
import { loadWalkAvatar } from './internal/load-avatar.js';
import { createAvatarPicker } from './picker.js';
import { resolveConfig, resolveAvatarEntry } from './config.js';

const CANVAS_W = 200;
const CANVAS_H = 280;
const CURSOR_IDLE_MS = 450; // cursor still longer than this → stop walking

function isExcludedRoute(config) {
	if (typeof window === 'undefined') return true;
	if (window.top !== window.self) return true; // never inside an iframe/embed
	const path = location.pathname.replace(/\/$/, '') || '/';
	return config.excludedRoutes.some((p) => path === p || path.startsWith(p + '/'));
}

// ── Default page-context greeting (overridable via config.greeting) ───────────
function defaultGreeting(path) {
	if (path === '/pricing' || path === '/x-pricing')
		return 'Picking a plan? I can point you to the popular one.';
	if (path === '/features') return 'Tap any feature card to see it in action.';
	if (path.startsWith('/agent') || path.startsWith('/a/') || path.startsWith('/marketplace')) {
		const name = pageSubjectName();
		return name ? `Say hi to ${name}!` : 'Browse agents — I’ll tag along.';
	}
	if (path === '/' || path.startsWith('/home')) return 'Hey! I’m your guide. I’ll walk with you.';
	return 'I’ll walk along while you explore.';
}

function pageSubjectName() {
	const el = document.querySelector('[data-agent-name], .agent-name, h1');
	const txt = el?.textContent?.trim();
	if (!txt || txt.length > 40) return null;
	return txt;
}

function contextTargetEl() {
	const path = location.pathname.replace(/\/$/, '') || '/';
	if (path === '/pricing' || path === '/x-pricing') {
		return document.querySelector(
			'[data-recommended], .pricing-card.is-featured, .plan.is-popular, .pricing-card--popular',
		);
	}
	if (path === '/features') return document.querySelector('.feature-card, [data-feature]');
	return null;
}

// ── The companion instance ───────────────────────────────────────────────────
class WalkCompanion {
	constructor(config, owner) {
		this.config = config;
		this.owner = owner; // the factory control object (for playground hand-off)
		this.mounted = false;
		this.host = null;
		this.renderer = null;
		this.scene = null;
		this.camera = null;
		this.rig = null;
		this.model = null;
		this.controller = null;
		this.clock = null;
		this._raf = 0;
		this._reduced = prefersReducedMotion();
		this._currentEntry = null;
		this._picker = null;

		this._cursorX = window.innerWidth * 0.5;
		this._cursorMovedAt = 0;
		this._yaw = 0;
		this._targetYaw = 0;
		// Touch devices have no hovering cursor to follow, so the companion would
		// sit frozen in idle. On a coarse pointer it wanders on its own instead —
		// switched off the moment a real (fine) pointer moves it.
		this._autonomous =
			typeof matchMedia === 'function' ? !matchMedia('(pointer: fine)').matches : false;
		this._autoWalking = false;
		this._autoUntil = 0;
		this._onPointerMove = this._onPointerMove.bind(this);
		this._onLinkClick = this._onLinkClick.bind(this);
		this._onVisibility = this._onVisibility.bind(this);
		this._onPageHide = this._onPageHide.bind(this);
		this._tick = this._tick.bind(this);
	}

	async mount() {
		if (this.mounted || isExcludedRoute(this.config)) return;
		if (!webglSupported()) return;
		this.mounted = true;

		this._buildDom();
		try {
			await this._buildScene();
		} catch (err) {
			log.warn('companion failed to load avatar:', err?.message || err);
			this._teardownScene();
			this._showError();
			return;
		}

		this.host?.classList.remove('is-loading');
		this._restoreState();
		this._bindEvents();
		this._greetForRoute();
		this.clock = new Timer();
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
		clearTimeout(this._inviteTimer);
		clearTimeout(this._orientTimer);
		clearTimeout(this._bubbleTimer);
		this._picker?.destroy();
		this._picker = null;
		this._teardownScene();
		if (this.host && this.host.parentNode) this.host.parentNode.removeChild(this.host);
		this.host = null;
	}

	// ── DOM / styles ──────────────────────────────────────────────────────────
	_buildDom() {
		ensureStyles();
		const host = document.createElement('div');
		host.className = 'walk-companion is-loading';
		host.setAttribute('role', 'complementary');
		host.setAttribute('aria-label', 'Walk companion');
		const pickerBtn = this.config.enablePicker
			? `<button type="button" class="walk-companion-swap" data-walk-picker-toggle aria-label="Choose a different avatar" title="Choose avatar">⇄</button>`
			: '';
		host.innerHTML = `
			<button type="button" class="walk-companion-close" aria-label="Dismiss walk companion" title="Dismiss">×</button>
			${pickerBtn}
			<div class="walk-companion__skel" aria-hidden="true"></div>
			<div class="walk-companion-bubble" hidden></div>
			<canvas class="walk-companion-canvas" width="${CANVAS_W}" height="${CANVAS_H}"></canvas>
		`;
		document.body.appendChild(host);
		this.host = host;
		this.canvas = host.querySelector('.walk-companion-canvas');
		this.bubble = host.querySelector('.walk-companion-bubble');
		host.querySelector('.walk-companion-close').addEventListener('click', (e) => {
			e.stopPropagation();
			this.owner.disable();
		});
		host.querySelector('.walk-companion-swap')?.addEventListener('click', (e) => {
			e.stopPropagation();
			this.openPicker();
		});
		// Clicking the avatar detaches it into Playground mode.
		this.canvas.addEventListener('click', () => this.owner._detachToPlayground(this));
		requestAnimationFrame(() => host.classList.add('is-in'));
	}

	_showError() {
		if (this.host && this.host.parentNode) this.host.parentNode.removeChild(this.host);
		this.host = null;
		this.mounted = false;
	}

	// ── Three.js scene ────────────────────────────────────────────────────────
	async _buildScene() {
		const renderer = new WebGLRenderer({ canvas: this.canvas, alpha: true, antialias: true });
		renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
		renderer.setSize(CANVAS_W, CANVAS_H, false);
		this.renderer = renderer;
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

		const entry = this._resolveEntry();
		await this._loadInto(entry);
	}

	_resolveEntry() {
		const param =
			typeof location !== 'undefined'
				? new URLSearchParams(location.search).get('avatar')
				: null;
		if (param) lsSet(this.config.keys.avatar, param);
		const id = param || lsGet(this.config.keys.avatar) || this.config.defaultAvatarId;
		return resolveAvatarEntry(id, this.config);
	}

	async _loadInto(entry) {
		const fallback = resolveAvatarEntry(this.config.defaultAvatarId, this.config);
		const {
			model,
			controller,
			entry: active,
		} = await loadWalkAvatar(entry, {
			assetBase: this.config.assetBase,
			apiBase: this.config.apiBase,
			manifestUrl: this.config.manifestUrl,
			fallbackEntry: fallback,
		});
		this.model = model;
		this.controller = controller;
		this._currentEntry = active;
		this._frame(model, this.rig, this.camera);
	}

	// Center on X/Z, drop feet to the floor, frame the camera on the full body.
	_frame(model, rig, camera) {
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

	// ── Live avatar swap (from the picker) ────────────────────────────────────
	async setAvatar(idOrEntry) {
		const entry =
			typeof idOrEntry === 'string' ? resolveAvatarEntry(idOrEntry, this.config) : idOrEntry;
		if (!entry) return;
		lsSet(this.config.keys.avatar, entry.id);
		this._picker?.setCurrent(entry.id);
		if (!this.mounted || !this.rig) return; // will apply on next mount
		this._say('Switching…');
		try {
			const fallback = resolveAvatarEntry(this.config.defaultAvatarId, this.config);
			const {
				model,
				controller,
				entry: active,
			} = await loadWalkAvatar(entry, {
				assetBase: this.config.assetBase,
				apiBase: this.config.apiBase,
				manifestUrl: this.config.manifestUrl,
				fallbackEntry: fallback,
			});
			if (!this.mounted) {
				disposeObject(model);
				controller.dispose?.();
				return;
			}
			if (this.model) {
				this.rig.remove(this.model);
				disposeObject(this.model);
			}
			this.controller?.dispose();
			this._yaw = 0;
			this._targetYaw = 0;
			this.rig.rotation.y = 0;
			this.model = model;
			this.controller = controller;
			this._currentEntry = active;
			this._frame(model, this.rig, this.camera);
			this._say(`Say hi to ${active.name}!`);
		} catch (err) {
			log.warn('avatar swap failed:', err?.message || err);
			this._say('Couldn’t load that one — try another.');
		}
	}

	openPicker() {
		if (!this.config.enablePicker) return;
		if (!this._picker) {
			this._picker = createAvatarPicker({
				avatars: this.config.avatars,
				currentId: this._currentEntry?.id || this.config.defaultAvatarId,
				assetBase: this.config.assetBase,
				docsUrl: this.config.docsUrl,
				anchor: { right: 16, bottom: CANVAS_H + 28 },
				onSelect: (entry) => this.setAvatar(entry),
			});
		}
		this._picker.toggle();
	}

	_teardownScene() {
		try {
			this.controller?.dispose();
		} catch {
			/* non-fatal */
		}
		this.controller = null;
		this.model = null;
		if (this.scene) {
			this.scene.traverse((n) => {
				if (n.isMesh) disposeMesh(n);
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
		// A genuine fine pointer (mouse/trackpad/stylus) takes over cursor-follow;
		// touch-drag (pointerType 'touch') leaves the autonomous wander in charge.
		if (e.pointerType && e.pointerType !== 'touch') this._autonomous = false;
		this._cursorX = e.clientX;
		this._cursorMovedAt = performance.now();
	}

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
		ssSet(this.config.keys.greet, '1');
	}

	_onVisibility() {
		if (document.hidden) {
			cancelAnimationFrame(this._raf);
			this._raf = 0;
		} else if (this.mounted && !this._raf) {
			this.clock?.update();
			this._raf = requestAnimationFrame(this._tick);
		}
	}

	_onPageHide() {
		this._persistState();
	}

	// ── Greeting / speech bubble ──────────────────────────────────────────────
	_greetForRoute() {
		const arrivedByNav = ssGet(this.config.keys.greet) === '1';
		ssDel(this.config.keys.greet);
		if (arrivedByNav) this.controller?.playWave();
		this._orientToContext();
		const path = location.pathname.replace(/\/$/, '') || '/';
		const greet = (this.config.greeting && this.config.greeting(path)) ?? defaultGreeting(path);
		this._say(greet);
		if (ssGet(this.config.keys.invited) !== '1') {
			ssSet(this.config.keys.invited, '1');
			clearTimeout(this._inviteTimer);
			this._inviteTimer = setTimeout(() => {
				if (this.mounted)
					this._say(this._autonomous ? 'Tap me to walk the whole page →' : 'Click me to walk the whole page →');
			}, 5600);
		}
	}

	_orientToContext() {
		const el = contextTargetEl();
		if (!el) return;
		const rect = el.getBoundingClientRect();
		const elCenterX = rect.left + rect.width / 2;
		const hostRect = this.host.getBoundingClientRect();
		const hostCenterX = hostRect.left + hostRect.width / 2;
		this._targetYaw = clamp((elCenterX - hostCenterX) / window.innerWidth, -0.6, 0.6);
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

	// ── Persistence ───────────────────────────────────────────────────────────
	_persistState() {
		if (!this.controller) return;
		lsSet(this.config.keys.state, JSON.stringify({ yaw: this._yaw }));
	}

	_restoreState() {
		try {
			const raw = lsGet(this.config.keys.state);
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
		this.clock.update();
		const dt = Math.min(this.clock.getDelta(), 0.05);

		const now = performance.now();
		const movingRecently = now - this._cursorMovedAt < CURSOR_IDLE_MS;
		if (this._autonomous) {
			if (!this._reduced && !this._orientLock && now >= this._autoUntil) {
				this._autoWalking = !this._autoWalking;
				if (this._autoWalking) {
					// Stroll toward a fresh heading, then pause and face it.
					this._targetYaw = clamp(Math.random() * 1.2 - 0.6, -0.6, 0.6);
					this._autoUntil = now + 1800 + Math.random() * 2200;
				} else {
					this._autoUntil = now + 900 + Math.random() * 1600;
				}
			}
		} else if (!this._reduced && !this._orientLock) {
			const rel = (this._cursorX - window.innerWidth / 2) / (window.innerWidth / 2);
			this._targetYaw = clamp(rel * 0.7, -0.7, 0.7);
		}
		const turning = Math.abs(this._targetYaw - this._yaw) > 0.04;
		const walkCue = this._autonomous ? this._autoWalking : movingRecently;
		const shouldWalk = !this._reduced && (walkCue || turning);
		this.controller?.setState(shouldWalk ? 'walk' : 'idle');

		this._yaw += (this._targetYaw - this._yaw) * 0.12;
		if (this.rig) this.rig.rotation.y = this._yaw;

		this.controller?.update(dt);
		this.renderer.render(this.scene, this.camera);
		this._raf = requestAnimationFrame(this._tick);
	}
}

// ── Shared disposal helpers ───────────────────────────────────────────────────
function disposeMesh(n) {
	n.geometry?.dispose?.();
	const mats = Array.isArray(n.material) ? n.material : [n.material];
	mats.forEach((m) => {
		if (!m) return;
		for (const v of Object.values(m)) if (v && v.isTexture) v.dispose();
		m.dispose?.();
	});
}
function disposeObject(obj) {
	obj?.traverse?.((n) => {
		if (n.isMesh) disposeMesh(n);
	});
}

// ── Scoped styles (injected once) ─────────────────────────────────────────────
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
.walk-companion__skel{position:absolute;left:50%;bottom:8%;z-index:0;width:46%;height:70%;transform:translateX(-50%);border-radius:46% 46% 40% 40%/55% 55% 45% 45%;overflow:hidden;opacity:0;transition:opacity .25s ease;pointer-events:none;background:linear-gradient(180deg,rgba(122,162,255,.18),rgba(18,20,28,.10))}
.walk-companion.is-loading .walk-companion__skel{opacity:1}
.walk-companion.is-loading .walk-companion-canvas{opacity:0}
.walk-companion__skel::after{content:'';position:absolute;inset:0;background:linear-gradient(110deg,transparent 18%,rgba(255,255,255,.22) 46%,transparent 72%);transform:translateX(-120%);animation:walk-companion-shimmer 1.2s ease-in-out infinite}
.walk-companion-close,.walk-companion-swap{position:absolute;top:2px;z-index:3;width:22px;height:22px;border:none;border-radius:50%;background:rgba(12,14,20,.55);color:#fff;font-size:14px;line-height:1;cursor:pointer;pointer-events:auto;opacity:0;transition:opacity .2s ease,background .2s ease;display:grid;place-items:center;padding:0}
.walk-companion-close{right:2px;font-size:15px}
.walk-companion-swap{right:28px}
.walk-companion:hover .walk-companion-close,.walk-companion:focus-within .walk-companion-close,.walk-companion:hover .walk-companion-swap,.walk-companion:focus-within .walk-companion-swap{opacity:1}
.walk-companion-close:hover{background:rgba(220,60,60,.85)}
.walk-companion-swap:hover{background:rgba(122,162,255,.85)}
.walk-companion-close:focus-visible,.walk-companion-swap:focus-visible{outline:2px solid #7aa2ff;outline-offset:2px;opacity:1}
.walk-companion-bubble{position:absolute;left:50%;bottom:calc(100% - 38px);z-index:2;transform:translateX(-50%) translateY(6px);box-sizing:border-box;max-width:min(216px,calc(100vw - 16px));width:max-content;background:rgba(18,20,28,.94);color:#f2f4f8;font:500 12.5px/1.4 system-ui,-apple-system,'Segoe UI',sans-serif;padding:8px 11px;border-radius:12px;border:1px solid rgba(255,255,255,.1);box-shadow:0 10px 28px rgba(0,0,0,.35);pointer-events:none;opacity:0;transition:opacity .3s ease,transform .3s ease;text-align:center}
.walk-companion-bubble.is-in{opacity:1;transform:translateX(-50%) translateY(0)}
.walk-companion-bubble::after{content:'';position:absolute;left:50%;top:100%;transform:translateX(-50%);border:6px solid transparent;border-top-color:rgba(18,20,28,.94)}
@media (max-width:520px){.walk-companion{width:148px;height:208px;right:10px;bottom:10px}.walk-companion-bubble{font-size:11.5px;max-width:min(156px,calc(100vw - 12px))}}
@media (pointer:coarse){.walk-companion-close,.walk-companion-swap{opacity:1;width:26px;height:26px}.walk-companion-swap{right:32px}}
@keyframes walk-companion-shimmer{to{transform:translateX(120%)}}
@media (prefers-reduced-motion:reduce){.walk-companion,.walk-companion-bubble{transition:none}.walk-companion__skel::after{animation:none;opacity:.5}}
`;
	document.head.appendChild(style);
}

// ── Factory + control object ──────────────────────────────────────────────────
/**
 * Create a Walk Companion controller. Side-effect free: nothing mounts until
 * `enable()` or `bootstrap()` is called.
 * @param {object} [opts] see config.js / README for the full option set
 */
export function createWalkCompanion(opts = {}) {
	const config = resolveConfig(opts);
	let instance = null;
	let pgWired = false;

	const isEnabled = () => lsGet(config.keys.enabled) === '1';

	function emitChange() {
		try {
			window.dispatchEvent(
				new CustomEvent('walk-companion:change', { detail: { enabled: isEnabled() } }),
			);
		} catch {
			/* non-fatal */
		}
	}

	const control = {
		config,
		get instance() {
			return instance;
		},
		isEnabled,
		enable() {
			lsSet(config.keys.enabled, '1');
			if (!instance) instance = new WalkCompanion(config, control);
			instance.mount();
			emitChange();
		},
		disable() {
			lsSet(config.keys.enabled, '0');
			if (instance) instance.unmount();
			emitChange();
		},
		toggle() {
			if (isEnabled()) control.disable();
			else control.enable();
		},
		setAvatar(idOrEntry) {
			lsSet(config.keys.avatar, typeof idOrEntry === 'string' ? idOrEntry : idOrEntry?.id);
			if (instance) instance.setAvatar(idOrEntry);
		},
		openPicker() {
			instance?.openPicker();
		},

		// Re-mount the corner companion when the playground exits.
		_wirePlaygroundReturn() {
			if (pgWired) return;
			pgWired = true;
			window.addEventListener('walk-playground:exit', () => {
				if (isEnabled()) {
					if (!instance) instance = new WalkCompanion(config, control);
					instance.mount();
				}
			});
		},

		async _detachToPlayground(companion) {
			control._wirePlaygroundReturn();
			let startScreen = null;
			try {
				const r = companion.host.getBoundingClientRect();
				startScreen = { x: r.left + r.width / 2, y: r.top + r.height * 0.86 };
			} catch {
				/* fall back to centered spawn */
			}
			const avatarId = companion._currentEntry?.id || lsGet(config.keys.avatar) || null;
			if (instance) instance.unmount(); // free the corner WebGL context first
			try {
				const mod = await import('./playground.js');
				mod.launchPlayground({ avatarId, startScreen, config });
			} catch (err) {
				log.warn('playground failed to load:', err?.message || err);
				if (isEnabled()) {
					if (!instance) instance = new WalkCompanion(config, control);
					instance.mount();
				}
			}
		},

		async _tryDropIn() {
			try {
				const mod = await import('./playground.js');
				if (!mod.consumeDropIn(config)) return false;
				control._wirePlaygroundReturn();
				mod.launchPlayground({
					avatarId: lsGet(config.keys.avatar) || null,
					dropIn: true,
					config,
				});
				return true;
			} catch (err) {
				log.warn('drop-in failed:', err?.message || err);
				return false;
			}
		},

		// Replicates the app's auto-mount + deep-link behaviour. Safe to call once
		// on load; reads ?walk= and the saved enabled flag.
		bootstrap() {
			if (typeof window === 'undefined') return;
			const params = new URLSearchParams(location.search);
			const walk = params.get('walk');
			if (walk === '0') {
				control.disable();
			} else if (walk === 'play') {
				lsSet(config.keys.enabled, '1');
				import('./playground.js')
					.then((mod) => {
						control._wirePlaygroundReturn();
						mod.launchPlayground({
							avatarId: lsGet(config.keys.avatar) || null,
							config,
						});
					})
					.catch((err) => {
						log.warn('playground deep-link failed:', err?.message || err);
						control.enable();
					});
			} else if (walk === '1' || isEnabled()) {
				control._tryDropIn().then((dropped) => {
					if (!dropped) control.enable();
				});
			}
		},
	};

	return control;
}
