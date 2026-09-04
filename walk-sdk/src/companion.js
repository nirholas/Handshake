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
import { LookAtController } from './internal/runtime.js';
import { createAvatarPicker } from './picker.js';
import { resolveConfig, resolveAvatarEntry } from './config.js';

const CANVAS_W = 200;
const CANVAS_H = 280;
// Identifies this widget's claim on the corner in window.twsCornerStack.
const CORNER_RESERVE_KEY = 'walk-companion';
const CURSOR_IDLE_MS = 450; // cursor still longer than this → stop walking
const GAZE_IDLE_MS = 4000; // cursor still longer than this → gaze drifts back to the clip
const GAZE_PX_PER_M = 260; // page pixels per scene metre when aiming the head at the cursor
const BUBBLE_HOLD_MS = 5200; // default speech-bubble dwell before it retracts
// An announced message the companion was summoned for retreats this long after
// its bubble does, so the visitor sees the avatar acknowledge and walk off
// rather than vanish mid-sentence.
const ANNOUNCE_RETREAT_MS = 700;

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
		this._cursorY = window.innerHeight * 0.5;
		this._cursorMovedAt = 0;
		// Bubble arbitration: what is on screen now and until when (see say()).
		this._bubblePriority = 0;
		this._bubbleUntil = 0;
		this._yaw = 0;
		this._targetYaw = 0;
		this._lookAt = null;
		this._gazeTarget = new Vector3();
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
		this._syncCornerReserve = this._syncCornerReserve.bind(this);
	}

	/**
	 * Tell the host page's corner stack how much of the bottom-right corner this
	 * companion occupies, so its cards ("Getting started", feature discovery)
	 * stack above the avatar instead of underneath it.
	 *
	 * Measured from computed style rather than getBoundingClientRect(): the host
	 * animates in with a translateY, and a rect read mid-transition would report
	 * a short-changed height that the stack would then settle into.
	 *
	 * Optional by design. The SDK ships standalone, so a page without the corner
	 * stack simply skips this.
	 */
	_syncCornerReserve() {
		const stack = typeof window !== 'undefined' ? window.twsCornerStack : null;
		if (!stack || typeof stack.reserve !== 'function' || !this.host) return;
		const cs = getComputedStyle(this.host);
		const bottom = parseFloat(cs.bottom) || 0;
		const height = parseFloat(cs.height) || 0;
		if (height <= 0) return;
		// Width as well as height: on a phone the stack goes full-width, and a
		// lift tall enough to clear the companion would strand its chips in the
		// middle of the page. With the width declared, the stack can step aside
		// and stay at the bottom instead.
		const right = parseFloat(cs.right) || 0;
		const width = parseFloat(cs.width) || 0;
		stack.reserve(CORNER_RESERVE_KEY, {
			height: bottom + height,
			width: width > 0 ? right + width : 0,
			// The host is a bottom-anchored fixed box, which is exactly the shape
			// the stack's dock probe looks for. Handing it over means the claim is
			// counted once (here) instead of twice, which is what used to lift the
			// stack into the middle of a phone screen.
			el: this.host,
		});
	}

	/**
	 * Mount the corner companion.
	 * @param {{greet?: boolean}} [opts] `greet: false` skips the page greeting
	 *   and the follow-up invite bubble, used when the companion is summoned to
	 *   deliver a specific message (see the control object's `announce`), where a
	 *   greeting would talk over it.
	 */
	async mount({ greet = true } = {}) {
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
		if (greet) this._greetForRoute();
		else this._orientToContext();
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
		window.removeEventListener('resize', this._syncCornerReserve);
		window.removeEventListener('tws-corner-stack:ready', this._syncCornerReserve);
		window.twsCornerStack?.release?.(CORNER_RESERVE_KEY);
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
			<div class="walk-companion-bubble" role="status" aria-live="polite" aria-atomic="true" hidden></div>
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
		// Claim the corner before anything else settles there, and re-measure on
		// resize: the narrow-viewport rule shrinks the companion to 148x208.
		// Bound here rather than in _bindEvents() so the claim survives the
		// avatar-failed-to-load path, where the host stays on the page.
		this._syncCornerReserve();
		window.addEventListener('resize', this._syncCornerReserve);
		// If the corner stack has not booted yet, claim the corner the moment it
		// does. Without this the companion could win the load race and silently
		// keep no reservation at all.
		window.addEventListener('tws-corner-stack:ready', this._syncCornerReserve);
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

		// Procedural cursor gaze (config-gated, humanoid rigs only): the head
		// turns to follow the visitor's pointer on top of whatever clip plays.
		// A rig with no mappable head reports enabled=false and stays null, so
		// embedded props (robot, fox) keep their baked motion untouched. Rebuilt
		// here on every load so an avatar swap re-resolves its own bones.
		this._lookAt = null;
		if (this.config.lookAt && !this._reduced) {
			const lookAt = new LookAtController(model);
			if (lookAt.enabled) this._lookAt = lookAt;
		}
	}

	// ── Live avatar swap (from the picker) ────────────────────────────────────
	/**
	 * @param {string|object} idOrEntry roster id, or a roster-shaped entry.
	 * @param {object} [opts]
	 * @param {boolean} [opts.persist=true] remember the choice for next page.
	 *   A guest delivery (announce({ avatar })) swaps without persisting, so the
	 *   visitor's own companion is still theirs after the message is over.
	 * @param {boolean} [opts.chatter=true] say the "Switching…" / "Say hi" lines.
	 */
	async setAvatar(idOrEntry, { persist = true, chatter = true } = {}) {
		const entry =
			typeof idOrEntry === 'string' ? resolveAvatarEntry(idOrEntry, this.config) : idOrEntry;
		if (!entry) return;
		if (persist) lsSet(this.config.keys.avatar, entry.id);
		if (persist) this._picker?.setCurrent(entry.id);
		if (!this.mounted || !this.rig) return; // will apply on next mount
		if (chatter) this._say('Switching…');
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
			if (chatter) this._say(`Say hi to ${active.name}!`);
		} catch (err) {
			log.warn('avatar swap failed:', err?.message || err);
			if (chatter) this._say('Couldn’t load that one. Try another.');
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
		this._lookAt = null;
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
		this._cursorY = e.clientY;
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
		this.say(text);
	}

	/**
	 * Show a speech bubble over the companion.
	 *
	 * The greeting flow calls this with no options (5.2s, plain text). Callers
	 * that deliver something the visitor may want to act on pass `actions`:
	 * up to two links/buttons rendered under the line, which also switches the
	 * bubble to pointer-events:auto so they are clickable.
	 *
	 * @param {string} text
	 * @param {object} [opts]
	 * @param {number} [opts.hold=5200] ms before the bubble retracts; 0 keeps it
	 *   up until the next say()/hideBubble().
	 * @param {'neutral'|'alert'} [opts.tone='neutral'] 'alert' tints the bubble.
	 * @param {Array<{label:string, href?:string, title?:string, onClick?:Function}>} [opts.actions]
	 * @param {number} [opts.priority=0] higher wins: a line at a lower priority
	 *   is dropped while a higher-priority one is still showing. Deliveries
	 *   (announce) speak at 1, ambient chatter at 0.
	 * @returns {boolean} false when there is no bubble to render into.
	 */
	say(text, { hold = BUBBLE_HOLD_MS, tone = 'neutral', actions = null, priority = 0 } = {}) {
		if (!this.bubble || !text) return false;
		// The companion has more than one voice: the page greeting, the invite
		// nudge, the identity introduction, and a delivered message all reach for
		// the same bubble. A lower-priority line must never overwrite a delivery
		// while it is still on screen, whichever fires first.
		if (priority < this._bubblePriority && Date.now() < this._bubbleUntil) return false;
		const bubble = this.bubble;
		clearTimeout(this._bubbleTimer);
		bubble.textContent = '';

		const line = document.createElement('span');
		line.className = 'walk-companion-bubble-line';
		line.textContent = text;
		bubble.appendChild(line);

		const rendered = (actions || []).filter((a) => a && a.label).slice(0, 2);
		if (rendered.length) {
			const row = document.createElement('span');
			row.className = 'walk-companion-bubble-actions';
			for (const action of rendered) {
				// An href makes it a real link (middle-click, copy, keyboard);
				// otherwise it is a button so it never navigates by accident.
				const el = document.createElement(action.href ? 'a' : 'button');
				el.className = 'walk-companion-bubble-action';
				el.textContent = action.label;
				// A two-word pill is all that fits beside an avatar, so the full
				// intent lives on the accessible name and the tooltip.
				if (action.title) {
					el.title = action.title;
					el.setAttribute('aria-label', action.title);
				}
				if (action.href) el.href = action.href;
				else el.type = 'button';
				if (typeof action.onClick === 'function') {
					el.addEventListener('click', (e) => {
						e.stopPropagation();
						action.onClick(e);
					});
				}
				row.appendChild(el);
			}
			bubble.appendChild(row);
		}

		bubble.classList.toggle('is-alert', tone === 'alert');
		bubble.classList.toggle('has-actions', rendered.length > 0);
		bubble.hidden = false;
		bubble.classList.add('is-in');
		this._bubblePriority = priority;
		this._bubbleUntil = hold > 0 ? Date.now() + hold : Number.MAX_SAFE_INTEGER;
		if (hold > 0) this._bubbleTimer = setTimeout(() => this.hideBubble(), hold);
		return true;
	}

	/** Retract the speech bubble now. */
	hideBubble() {
		clearTimeout(this._bubbleTimer);
		this._bubblePriority = 0;
		this._bubbleUntil = 0;
		if (!this.bubble) return;
		const bubble = this.bubble;
		bubble.classList.remove('is-in');
		setTimeout(() => {
			// A newer say() may have re-opened it while this retraction ran.
			if (bubble && !bubble.classList.contains('is-in')) bubble.hidden = true;
		}, 300);
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
		this._updateGaze(now, dt);
		this.renderer.render(this.scene, this.camera);
		this._raf = requestAnimationFrame(this._tick);
	}

	// Head tracking: map the page cursor into a scene-space point in front of
	// the avatar and let the IK layer chase it. Runs AFTER controller.update()
	// (the mixer tick) per the procedural-layer contract. When the cursor has
	// been still for a while, or there is no fine pointer at all, the target
	// clears and the gaze fades back to the clip's own head motion.
	_updateGaze(now, dt) {
		if (!this._lookAt) return;
		const cursorLive = !this._autonomous && now - this._cursorMovedAt < GAZE_IDLE_MS;
		if (cursorLive && this.host) {
			const rect = this.host.getBoundingClientRect();
			const dx = this._cursorX - (rect.left + rect.width / 2);
			const dy = this._cursorY - (rect.top + rect.height * 0.35);
			const h = this._height || 1.6;
			this._gazeTarget.set(
				dx / GAZE_PX_PER_M,
				h * 0.85 - dy / GAZE_PX_PER_M,
				h * 2,
			);
			this._lookAt.setTarget(this._gazeTarget);
		} else {
			this._lookAt.setTarget(null);
		}
		this._lookAt.update(dt);
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
.walk-companion-canvas{position:absolute;inset:0;width:100%;height:100%;z-index:1;pointer-events:auto;cursor:pointer;touch-action:pan-y;filter:drop-shadow(0 18px 22px rgba(0,0,0,.32))}
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
.walk-companion-bubble.is-alert{background:rgba(20,18,32,.96);border-color:rgba(122,162,255,.5);box-shadow:0 10px 28px rgba(0,0,0,.45),0 0 0 1px rgba(122,162,255,.18)}
.walk-companion-bubble.is-alert::after{border-top-color:rgba(20,18,32,.96)}
.walk-companion-bubble.has-actions{pointer-events:auto;z-index:4}
/* z-index 4 puts an actionable bubble ABOVE the chrome control row (z-index 3).
   Without it the controls sit over the bubble's own buttons and swallow the
   click: the buttons render, highlight on hover, and do nothing. Only bubbles
   that HAVE actions are raised, so a plain caption never covers the close or
   swap controls. */
.walk-companion-bubble-line{display:block}
.walk-companion-bubble-actions{display:flex;gap:6px;justify-content:center;flex-wrap:wrap;margin-top:7px}
.walk-companion-bubble-action{appearance:none;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.06);color:#dbe6ff;font:600 11.5px/1 system-ui,-apple-system,'Segoe UI',sans-serif;padding:5px 9px;border-radius:999px;cursor:pointer;text-decoration:none;transition:background .15s ease,border-color .15s ease,color .15s ease}
.walk-companion-bubble-action:hover{background:rgba(122,162,255,.22);border-color:rgba(122,162,255,.55);color:#fff}
.walk-companion-bubble-action:active{background:rgba(122,162,255,.34)}
.walk-companion-bubble-action:focus-visible{outline:2px solid #7aa2ff;outline-offset:2px}
@media (pointer:coarse){.walk-companion-bubble-action{padding:9px 12px;font-size:12.5px}}
.walk-companion-bubble::after{content:'';position:absolute;left:50%;top:100%;transform:translateX(-50%);border:6px solid transparent;border-top-color:rgba(18,20,28,.94)}
@media (max-width:520px){.walk-companion{width:148px;height:208px;right:10px;bottom:10px}.walk-companion-bubble{font-size:11.5px;max-width:min(156px,calc(100vw - 12px))}}
@media (pointer:coarse){.walk-companion-close,.walk-companion-swap{opacity:1;width:44px;height:44px;top:-7px;border:9px solid transparent;background-clip:padding-box}.walk-companion-close{right:-7px}.walk-companion-swap{right:23px}}
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

		/**
		 * Deliver a message in person.
		 *
		 * If the companion is already on screen it turns to the visitor, plays a
		 * gesture and says the line. If it is not (the visitor never turned it on,
		 * or closed it), it is summoned silently for this one message and walks
		 * off again afterwards, without flipping the persisted enabled flag, so
		 * "off" stays off once the message is delivered.
		 *
		 * @param {string} message the line to speak. Rendered as text, never HTML.
		 * @param {object} [opts]
		 * @param {number} [opts.hold=7000] ms the bubble stays up.
		 * @param {'neutral'|'alert'} [opts.tone='alert']
		 * @param {string} [opts.emote='wave'] gesture played on arrival; falls back
		 *   to a wave on rigs that don't carry it.
		 * @param {Array<{label:string, href?:string, onClick?:Function}>} [opts.actions]
		 * @param {string|object} [opts.avatar] deliver as somebody else: a roster
		 *   id, or an entry from `makeGuestAvatarEntry(glbUrl, { name })`. The
		 *   swap is not persisted and the visitor's own avatar comes back once
		 *   the message is over, which is what lets a message from a contact be
		 *   delivered by that contact's own body.
		 * @returns {Promise<boolean>} false when no avatar could be shown (route
		 *   excluded, no WebGL, inside an iframe) so the caller can fall back to
		 *   its own UI. True once the message is on screen.
		 */
		async announce(message, { hold = 7000, tone = 'alert', emote = 'wave', actions, avatar = null } = {}) {
			if (!message) return false;
			const summoned = !instance?.mounted;
			// Transient only when the visitor has not turned the companion on: an
			// enabled-but-unmounted companion (excluded route, playground) stays
			// mounted afterwards exactly as if it had mounted normally.
			const transient = summoned && !isEnabled();
			if (summoned) {
				if (!instance) instance = new WalkCompanion(config, control);
				await instance.mount({ greet: false });
				if (!instance.mounted) return false;
			}
			const inst = instance;

			// Guest delivery: whoever the message is from arrives in their own
			// body, and the visitor's companion is restored afterwards. A swap
			// that fails leaves the current avatar in place and the line is
			// still delivered, so a missing GLB never costs the message.
			let restore = null;
			if (avatar) {
				const guest = typeof avatar === 'string' ? resolveAvatarEntry(avatar, config) : avatar;
				const currentId = inst._currentEntry?.id || lsGet(config.keys.avatar) || config.defaultAvatarId;
				if (guest && guest.id !== currentId) {
					restore = inst._currentEntry || resolveAvatarEntry(currentId, config);
					await inst.setAvatar(guest, { persist: false, chatter: false });
				}
			}

			try {
				if (!inst.controller?.playEmote?.(emote)) inst.controller?.playWave?.();
			} catch {
				/* rig without emotes: the bubble still carries the message */
			}
			inst.say(message, { hold, tone, actions, priority: 1 });

			const settle = async () => {
				await new Promise((r) => setTimeout(r, hold + ANNOUNCE_RETREAT_MS));
				if (instance !== inst || !inst.mounted) return;
				if (restore) await inst.setAvatar(restore, { persist: false, chatter: false });
				// The visitor may have turned the companion on (or swapped
				// instances) while it was delivering; never yank it away then.
				if (transient && !isEnabled() && instance === inst && inst.mounted) inst.unmount();
			};
			// A persistent companion returns as soon as the line is up; only a
			// summoned-for-this-message one waits for its own retreat.
			if (!transient) {
				if (restore) settle();
				return true;
			}
			await settle();
			return true;
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
