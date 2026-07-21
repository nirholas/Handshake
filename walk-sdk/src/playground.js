// Walk Playground — the page becomes a place your avatar can roam.
// ================================================================
// Hands off from the corner companion: click it and the avatar "detaches" into
// a full-page character you steer around the site. Two movement models, switched
// live (the mode button, top-right, or the M key) and remembered across pages:
//
//   • Stroll — a gentle top-down aerial view. No gravity, nothing to fall off:
//              walk anywhere across the page; step on a link to dive into it.
//   • Platformer — the page's real DOM (headings, cards, buttons, links) becomes
//              solid ground. Gravity, jumping, falling; land on a link to dive in.
//
// Whatever avatar the visitor chose in the companion picker walks here too:
// loading goes through the shared unified loader, so a retarget-only humanoid
// (which would otherwise stand in a bind pose) animates exactly like the robot.

import {
	AmbientLight,
	Box3,
	CircleGeometry,
	DirectionalLight,
	DoubleSide,
	Group,
	HemisphereLight,
	Mesh,
	MeshBasicMaterial,
	OrthographicCamera,
	Scene,
	Timer,
	Vector3,
	WebGLRenderer,
} from 'three';
import { reserveWebGLContext, releaseWebGLContext } from './internal/budget.js';
import { log } from './internal/log.js';
import {
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

// Active config — set by launchPlayground. Defaults keep the module usable if a
// caller forgets to pass one (e.g. console-driven `__walkPlayground.launch()`).
let _config = resolveConfig();

// ── Stroll tuning (CSS-pixel units, seconds) ─────────────────────────────────
const CHAR_PX = 150;
const MOVE_ACCEL = 3600;
const MAX_SPEED = 360;
const RUN_SPEED = 250;
const FRICTION = 3200;
const EDGE_PAD = 30;
const CAM_PITCH = 0.5;
const SPAWN_GUARD_MS = 1100;
const ELEM_PROBE_MS = 90;

// ── Platformer tuning ────────────────────────────────────────────────────────
const PLAT_CHAR_PX = 138;
const GRAVITY = 2600;
const TERMINAL = 2400;
const MOVE_SPEED = 330;
const PLAT_RUN_SPEED = 250;
const JUMP_V = 1000;
const GROUND_ACCEL = 2600;
const AIR_ACCEL = 1400;
const PLAT_FRICTION = 2400;
const FOOT_PAD = 26;
const LAND_TOL = 14;

const SOLID_SELECTOR = [
	'a[href]',
	'button',
	'h1',
	'h2',
	'h3',
	'h4',
	'p',
	'li',
	'img',
	'figure',
	'.card',
	'[data-platform]',
].join(',');

let _cpStylesInjected = false;
function ensureCheckpointStyles() {
	if (_cpStylesInjected || typeof document === 'undefined') return;
	_cpStylesInjected = true;
	const style = document.createElement('style');
	style.id = 'walk-cp-style';
	style.textContent = `
.walk-cp{position:fixed;z-index:2147483080;width:74px;height:74px;margin:-37px 0 0 -37px;pointer-events:none;display:grid;place-items:center;transition:opacity .3s ease}
.walk-cp__ring{position:absolute;inset:0;border-radius:50%;border:2px dashed rgba(122,162,255,.5);background:radial-gradient(circle,rgba(122,162,255,.16),transparent 68%)}
.walk-cp__num{position:relative;z-index:1;width:30px;height:30px;border-radius:50%;display:grid;place-items:center;font:800 14px/1 system-ui,-apple-system,'Segoe UI',sans-serif;color:#fff;background:rgba(20,24,34,.85);border:1px solid rgba(122,162,255,.6);box-shadow:0 4px 14px rgba(0,0,0,.4)}
.walk-cp.is-locked{opacity:.42}
.walk-cp.is-active .walk-cp__ring{border-style:solid;border-color:rgba(110,231,183,.95);background:radial-gradient(circle,rgba(52,211,153,.3),transparent 66%);animation:walk-cp-pulse 1.4s ease-in-out infinite}
.walk-cp.is-active .walk-cp__num{background:linear-gradient(135deg,#34d399,#6ee7b7);color:#06231a;border-color:transparent}
.walk-cp.is-done .walk-cp__ring{border-style:solid;border-color:rgba(110,231,183,.5);background:none;animation:none}
.walk-cp.is-done .walk-cp__num{background:#34d399;color:#06231a;border-color:transparent;font-size:0}
.walk-cp.is-done .walk-cp__num::after{content:'✓';font-size:16px}
@keyframes walk-cp-pulse{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(1.14);opacity:.55}}
@media (prefers-reduced-motion:reduce){.walk-cp.is-active .walk-cp__ring{animation:none}}
.walk-pg.is-quest .walk-pg-pick,.walk-pg.is-quest .walk-pg-exit,.walk-pg.is-quest .walk-pg-mode{display:none!important}
`;
	document.head.appendChild(style);
}

// ── Checkpoint quest layer (shared by both movement modes) ────────────────────
// Opt-in: the host supplies target elements the visitor must reach (a guided
// store tour, say). Purely additive — with no checkpoints each playground
// behaves exactly as before. Both movement models carry the same quest state,
// so a live mode switch (M / the mode pill) keeps checkpoints and progress.
function questInit(pg, { checkpoints, onReach, onComplete, startCheckpoint } = {}) {
	pg._checkpoints = Array.isArray(checkpoints) && checkpoints.length ? checkpoints : null;
	pg._onReach = typeof onReach === 'function' ? onReach : null;
	pg._onComplete = typeof onComplete === 'function' ? onComplete : null;
	pg._activeCp = pg._checkpoints
		? Math.max(0, Math.min(startCheckpoint || 0, pg._checkpoints.length))
		: 0;
	pg._narrating = false;
	pg._cpMarkers = [];
}

function questBuild(pg) {
	if (!pg._checkpoints) return;
	ensureCheckpointStyles();
	pg._cpMarkers = pg._checkpoints.map((cp, i) => {
		const el = document.createElement('div');
		el.className = 'walk-cp is-locked';
		el.innerHTML = `<span class="walk-cp__num">${i + 1}</span><span class="walk-cp__ring"></span>`;
		el.setAttribute('aria-hidden', 'true');
		document.body.appendChild(el);
		return el;
	});
	questSync(pg);
	questUpdate(pg);
}

function questSync(pg) {
	pg._cpMarkers.forEach((m, i) => {
		const done = i < pg._activeCp;
		m.classList.toggle('is-done', done);
		m.classList.toggle('is-active', i === pg._activeCp && !done);
		m.classList.toggle('is-locked', i > pg._activeCp);
	});
}

function questUpdate(pg) {
	if (!pg._cpMarkers?.length) return;
	for (let i = 0; i < pg._cpMarkers.length; i++) {
		const target = pg._checkpoints[i]?.el;
		const marker = pg._cpMarkers[i];
		if (!target || !target.isConnected) {
			marker.style.opacity = '0';
			continue;
		}
		const r = target.getBoundingClientRect();
		const cx = r.left + r.width / 2;
		const cy = Math.min(window.innerHeight - 36, Math.max(36, r.bottom - 26));
		marker.style.left = cx + 'px';
		marker.style.top = cy + 'px';
		marker.style.opacity = cy < -60 || cy > window.innerHeight + 60 ? '0' : '';
	}
}

// When the character's feet reach the active checkpoint, freeze and hand off to
// the host's onReach(index, resume). The host narrates, then calls resume().
function questProbe(pg) {
	const i = pg._activeCp;
	const target = pg._checkpoints[i]?.el;
	if (!target || !target.isConnected) return;
	const feetX = pg.char.x - (window.scrollX || 0);
	const feetY = pg.char.y - (window.scrollY || 0);
	const r = target.getBoundingClientRect();
	const pad = 26;
	if (feetX >= r.left - pad && feetX <= r.right + pad && feetY >= r.top - pad && feetY <= r.bottom + pad) {
		pg._narrating = true;
		pg.char.vx = 0;
		pg.char.vy = 0;
		const resume = () => questResume(pg);
		if (pg._onReach) pg._onReach(i, resume);
		else resume();
	}
}

function questResume(pg) {
	pg._activeCp++;
	questSync(pg);
	pg._narrating = false;
	if (pg._activeCp >= pg._checkpoints.length) pg._onComplete?.();
}

function questDestroy(pg) {
	if (pg._cpMarkers?.length) {
		pg._cpMarkers.forEach((m) => m.remove());
		pg._cpMarkers = [];
	}
}

function getMode() {
	try {
		return localStorage.getItem(_config.keys.mode) === 'platformer' ? 'platformer' : 'stroll';
	} catch {
		return 'stroll';
	}
}
function setMode(m) {
	try {
		localStorage.setItem(_config.keys.mode, m === 'platformer' ? 'platformer' : 'stroll');
	} catch {
		/* non-fatal */
	}
}

function docWidth() {
	return Math.max(document.documentElement.clientWidth, window.innerWidth || 0);
}
function docHeight() {
	const el = document.scrollingElement || document.documentElement;
	return Math.max(el.scrollHeight, window.innerHeight || 0);
}
function maxScroll() {
	return Math.max(0, docHeight() - window.innerHeight);
}

function linkHrefAtPoint(sx, sy) {
	let el = document.elementFromPoint(sx, sy);
	if (!el) return null;
	const a = el.closest?.('a[href]');
	if (!a) return null;
	if (a.target && a.target !== '_self') return null;
	const raw = a.getAttribute('href') || '';
	if (!raw || raw.startsWith('#') || raw.startsWith('javascript:')) return null;
	try {
		const u = new URL(raw, location.href);
		if (u.origin !== location.origin) return null;
		return { href: u.href, el: a };
	} catch {
		return null;
	}
}

function modeButtonHTML(mode) {
	const label = mode === 'platformer' ? 'Platformer' : 'Stroll';
	const icon = mode === 'platformer' ? '🎮' : '🚶';
	return `<button type="button" class="walk-pg-mode" aria-label="Switch movement mode (currently ${label})" title="Switch mode (M)"><span class="walk-pg-mode-ic" aria-hidden="true">${icon}</span><span class="walk-pg-mode-tx">${label}</span></button>`;
}

// The "choose avatar" button shown in the playground toolbar. Only rendered when
// the picker is enabled; carries `data-walk-picker-toggle` so the picker's
// outside-click dismiss ignores re-clicks on the button itself.
function pickButtonHTML() {
	return `<button type="button" class="walk-pg-pick" data-walk-picker-toggle aria-label="Choose your avatar" title="Choose avatar (C)"><span class="walk-pg-pick-ic" aria-hidden="true">🧑</span><span class="walk-pg-pick-tx">Avatar</span></button>`;
}

// ── Emote rail (shared by both movement modes) ───────────────────────────────
// The big round tap-to-perform buttons pinned to the right edge: dance, punch,
// backflip, wave. Rendered only for emotes the CURRENT rig actually supports
// (controller.emotes()), so every visible button performs; rebuilt on avatar
// swap. Number keys 1-4 mirror the buttons.
const EMOTE_BUTTONS = [
	{ name: 'dance', icon: '🕺', label: 'Dance', key: '1' },
	{ name: 'punch', icon: '👊', label: 'Punch', key: '2' },
	{ name: 'backflip', icon: '🤸', label: 'Backflip', key: '3' },
	{ name: 'wave', icon: '👋', label: 'Wave', key: '4' },
];

function buildEmoteRail(pg) {
	if (!pg.host) return;
	pg.host.querySelector('.walk-pg-emotes')?.remove();
	const supported = pg.controller?.emotes?.() || [];
	const buttons = EMOTE_BUTTONS.filter((b) => supported.includes(b.name));
	if (!buttons.length) return;
	const rail = document.createElement('div');
	rail.className = 'walk-pg-emotes';
	rail.setAttribute('role', 'toolbar');
	rail.setAttribute('aria-label', 'Emotes: make the character perform');
	rail.innerHTML = buttons
		.map(
			(b) =>
				`<button type="button" class="walk-pg-emote" data-emote="${b.name}" aria-label="${b.label}" title="${b.label} (${b.key})"><span aria-hidden="true">${b.icon}</span></button>`,
		)
		.join('');
	rail.addEventListener('click', (e) => {
		const btn = e.target.closest('.walk-pg-emote');
		if (btn) triggerEmote(pg, btn.getAttribute('data-emote'));
	});
	pg.host.appendChild(rail);
}

function triggerEmote(pg, name) {
	if (pg._diving || pg._narrating) return;
	if (!pg.controller?.playEmote?.(name)) return;
	const btn = pg.host?.querySelector(`.walk-pg-emote[data-emote="${name}"]`);
	if (btn) {
		btn.classList.remove('is-playing');
		void btn.offsetWidth; // restart the pop on a repeat tap
		btn.classList.add('is-playing');
	}
}

// Number-key shortcut shared by both modes' keydown handlers. Returns true when
// the key mapped to a rendered emote (so the caller preventDefaults it).
function emoteHotkey(pg, key) {
	const btn = EMOTE_BUTTONS.find((b) => b.key === key);
	if (!btn || !pg.host?.querySelector(`.walk-pg-emote[data-emote="${btn.name}"]`)) return false;
	triggerEmote(pg, btn.name);
	return true;
}

// Free a model's GPU resources (geometries, materials, textures) when it leaves
// the rig after a live avatar swap. Mirrors the per-mesh disposal in teardown.
function disposeModel(model) {
	model.traverse((n) => {
		if (!n.isMesh) return;
		n.geometry?.dispose?.();
		const mats = Array.isArray(n.material) ? n.material : [n.material];
		mats.forEach((m) => {
			if (!m) return;
			for (const v of Object.values(m)) if (v && v.isTexture) v.dispose();
			m.dispose?.();
		});
	});
}

// Open (or toggle) the avatar picker for a running playground. Lazily builds the
// popover once, then reuses it. Selecting an avatar hot-swaps the live rig.
function openAvatarPicker(pg) {
	if (_config.enablePicker === false) return;
	if (!pg._picker) {
		pg._picker = createAvatarPicker({
			avatars: _config.avatars,
			currentId: pg._avatarId || _config.defaultAvatarId,
			assetBase: _config.assetBase,
			docsUrl: _config.docsUrl,
			onSelect: (entry) => swapAvatar(pg, entry),
		});
	}
	pg._picker.toggle();
}

// Reload the chosen avatar and swap it into the live rig without leaving the
// playground. Persists the selection to the shared companion/playground key so
// the choice carries across mode switches, the corner companion, and pages.
async function swapAvatar(pg, idOrEntry) {
	const entry =
		typeof idOrEntry === 'string' ? resolveAvatarEntry(idOrEntry, _config) : idOrEntry;
	if (!entry || !pg.mounted || !pg.rig) return;
	if (entry.id === pg._avatarId) return;
	pg._avatarId = entry.id;
	try {
		localStorage.setItem(_config.keys.avatar, entry.id);
	} catch {
		/* non-fatal — selection still applies for this session */
	}
	pg._picker?.setCurrent(entry.id);
	pg._say?.('Switching…', 4000);
	try {
		const next = await loadCharacter(entry.id, pg._charPx);
		if (!pg.mounted || !pg.rig) {
			disposeModel(next.model);
			next.controller?.dispose?.();
			return;
		}
		if (pg.model) {
			pg.rig.remove(pg.model);
			disposeModel(pg.model);
		}
		pg.controller?.dispose?.();
		pg.rig.add(next.model);
		pg.model = next.model;
		pg.controller = next.controller;
		pg.modelHalfW = next.halfW;
		if (typeof pg._shadowR === 'number') pg._shadowR = Math.max(22, next.halfW * 1.15);
		buildEmoteRail(pg); // the new rig may support a different emote set
		pg._say?.(`Say hi to ${entry.name}!`);
	} catch (err) {
		log.warn('avatar swap failed:', err?.message || err);
		pg._say?.('Couldn’t load that one — try another.');
	}
}

function destroyPicker(pg) {
	pg._picker?.destroy();
	pg._picker = null;
}

// Load + scale the chosen avatar to a fixed pixel height, feet at the rig
// origin. Goes through the shared unified loader so any roster avatar animates.
async function loadCharacter(avatarId, charPx) {
	const entry = resolveAvatarEntry(avatarId, _config);
	const fallback = resolveAvatarEntry(_config.defaultAvatarId, _config);
	const { model, controller } = await loadWalkAvatar(entry, {
		assetBase: _config.assetBase,
		apiBase: _config.apiBase,
		manifestUrl: _config.manifestUrl,
		fallbackEntry: fallback,
	});
	const box = new Box3().setFromObject(model);
	const size = box.getSize(new Vector3());
	const scale = charPx / Math.max(0.001, size.y);
	model.scale.setScalar(scale);
	const box2 = new Box3().setFromObject(model);
	const center = box2.getCenter(new Vector3());
	model.position.x -= center.x;
	model.position.z -= center.z;
	model.position.y -= box2.min.y;
	return { model, controller, halfW: (size.x * scale) / 2 };
}

// Deflection past which a stick axis counts as a held direction. High enough
// that a resting/drifting stick never walks the avatar on its own.
const PAD_DEADZONE = 0.45;

// Standard Gamepad → walk intents. Reads the first connected pad (null when
// none) so a controller drives the avatar exactly like the keyboard: left stick
// or d-pad to move, ✕/A (0) and ○/B (1) as face buttons. Each mode decides what
// counts as "dive" — so "joystick down" and "press O" map to entry, never a
// resting stick.
function readGamepad() {
	const pads = typeof navigator !== 'undefined' && navigator.getGamepads
		? navigator.getGamepads()
		: null;
	if (!pads) return null;
	let gp = null;
	for (const p of pads) {
		if (p && p.connected) { gp = p; break; }
	}
	if (!gp) return null;
	const ax = gp.axes[0] || 0;
	const ay = gp.axes[1] || 0;
	const btn = (i) => !!gp.buttons[i]?.pressed;
	return {
		left: ax < -PAD_DEADZONE || btn(14),
		right: ax > PAD_DEADZONE || btn(15),
		up: ay < -PAD_DEADZONE || btn(12),
		down: ay > PAD_DEADZONE || btn(13),
		faceA: btn(0), // ✕ / A
		faceB: btn(1), // ○ / B
	};
}

// Fold a gamepad's intents into a keyboard-driven `input` map without stomping
// keys the player is physically holding: `held` remembers which flags this pad
// asserted last frame, so releasing the stick only clears what the pad set.
function mergePad(input, held, next) {
	for (const k in next) {
		if (next[k]) { input[k] = true; held[k] = true; }
		else if (held[k]) { input[k] = false; held[k] = false; }
	}
}

// ═════════════════════════════════════════════════════════════════════════════
// Stroll mode — gentle top-down aerial view, no gravity, roam anywhere.
// ═════════════════════════════════════════════════════════════════════════════
class StrollPlayground {
	constructor() {
		this.mode = 'stroll';
		this.mounted = false;
		this._reduced = prefersReducedMotion();
		this._raf = 0;
		this._diveTimer = 0;
		this._hintTimer = 0;
		this._tick = this._tick.bind(this);
		this._onKeyDown = this._onKeyDown.bind(this);
		this._onKeyUp = this._onKeyUp.bind(this);
		this._onResize = this._onResize.bind(this);
		this._onVisibility = this._onVisibility.bind(this);
		this.char = { x: 0, y: 0, vx: 0, vy: 0, facing: 0 };
		this._yaw = 0;
		this.input = { up: false, down: false, left: false, right: false, dive: false };
		this._padHeld = {};
		this._armEl = null;
		this._armHref = null;
		this._lastProbe = 0;
		this._diving = false;
		this._spawnGuardUntil = 0;
		this._v0 = new Vector3();
		this._v1 = new Vector3();
		this._picker = null;
		this.model = null;
		this._charPx = CHAR_PX;
	}

	async mount({
		avatarId = null,
		startScreen = null,
		dropIn = false,
		switched = false,
		checkpoints = null,
		onReach = null,
		onComplete = null,
		startCheckpoint = 0,
	} = {}) {
		if (this.mounted) return;
		if (!webglSupported()) {
			log.warn('playground: WebGL unavailable');
			return;
		}
		this.mounted = true;
		this._avatarId = avatarId;
		questInit(this, { checkpoints, onReach, onComplete, startCheckpoint });
		this._buildDom();
		try {
			await this._buildScene();
		} catch (err) {
			log.warn('playground failed to load avatar:', err?.message || err);
			this._teardown();
			return;
		}
		if (!this.mounted) { this._teardown(); return; }
		buildEmoteRail(this);
		this._placeStart(startScreen, dropIn);
		questBuild(this);
		this._spawnGuardUntil = performance.now() + SPAWN_GUARD_MS;
		this._bindEvents();
		if (switched) this._sayModeIntro();
		else this._hintFor(dropIn);
		this.clock = new Timer();
		this._raf = requestAnimationFrame(this._tick);
	}

	// ── Checkpoint quest (opt-in) ─────────────────────────────────────────────
	// Freeze the character while the host narrates a reached checkpoint. Input is
	// ignored and velocity bleeds off, so the avatar stands still until resumed.
	setNarrating(on) {
		this._narrating = !!on;
	}

	unmount() {
		if (!this.mounted) return;
		this.mounted = false;
		cancelAnimationFrame(this._raf);
		this._raf = 0;
		clearTimeout(this._diveTimer);
		clearTimeout(this._hintTimer);
		window.removeEventListener('keydown', this._onKeyDown, true);
		window.removeEventListener('keyup', this._onKeyUp, true);
		window.removeEventListener('resize', this._onResize);
		document.removeEventListener('visibilitychange', this._onVisibility);
		this._clearArm();
		destroyPicker(this);
		questDestroy(this);
		this._teardown();
	}

	// Stop the render loop when the tab is backgrounded; resume on return.
	_onVisibility() {
		if (document.hidden) {
			cancelAnimationFrame(this._raf);
			this._raf = 0;
		} else if (this.mounted && !this._raf) {
			this._raf = requestAnimationFrame(this._tick);
		}
	}

	currentScreenPos() {
		return { x: this.char.x - (window.scrollX || 0), y: this.char.y - (window.scrollY || 0) };
	}

	_buildDom() {
		ensureStyles();
		const host = document.createElement('div');
		host.className = 'walk-pg walk-pg--stroll';
		// On a guided checkpoint quest, suppress the free-play chrome the host owns
		// (avatar picker, the playground's own exit) — the mode pill stays so the
		// visitor can hop between Stroll and Platformer mid-quest.
		if (this._checkpoints) host.classList.add('is-quest');
		host.setAttribute('role', 'application');
		host.setAttribute('aria-label', 'Page playground — walk the character with the arrow keys');
		host.innerHTML = `
			<canvas class="walk-pg-canvas"></canvas>
			<div class="walk-pg-hint" aria-live="polite"></div>
			${_config.enablePicker === false ? '' : pickButtonHTML()}
			${modeButtonHTML(this.mode)}
			<button type="button" class="walk-pg-exit" aria-label="Exit playground" title="Exit (Esc)">Exit ✕</button>
			<div class="walk-pg-pad" aria-hidden="true">
				<button type="button" class="walk-pg-btn" data-act="up" aria-label="Walk up">▲</button>
				<div class="walk-pg-pad-row">
					<button type="button" class="walk-pg-btn" data-act="left" aria-label="Walk left">◀</button>
					<button type="button" class="walk-pg-btn walk-pg-dive" data-act="dive" aria-label="Dive into link">⬇</button>
					<button type="button" class="walk-pg-btn" data-act="right" aria-label="Walk right">▶</button>
				</div>
				<button type="button" class="walk-pg-btn" data-act="down" aria-label="Walk down">▼</button>
			</div>
			<div class="walk-pg-flash" aria-hidden="true"></div>
		`;
		document.body.appendChild(host);
		this.host = host;
		this.canvas = host.querySelector('.walk-pg-canvas');
		this.hintEl = host.querySelector('.walk-pg-hint');
		this.flashEl = host.querySelector('.walk-pg-flash');
		host.querySelector('.walk-pg-exit').addEventListener('click', () => exitPlayground());
		host.querySelector('.walk-pg-mode').addEventListener('click', () => switchPlaygroundMode());
		host.querySelector('.walk-pg-pick')?.addEventListener('click', (e) => {
			e.stopPropagation();
			openAvatarPicker(this);
		});
		host.querySelectorAll('.walk-pg-btn').forEach((btn) => {
			const act = btn.getAttribute('data-act');
			const on = (e) => {
				e.preventDefault();
				this._setAct(act, true);
			};
			const off = (e) => {
				e.preventDefault();
				this._setAct(act, false);
			};
			btn.addEventListener('pointerdown', on);
			btn.addEventListener('pointerup', off);
			btn.addEventListener('pointerleave', off);
			btn.addEventListener('pointercancel', off);
		});
		requestAnimationFrame(() => host.classList.add('is-in'));
	}

	_setAct(act, val) {
		if (act in this.input) this.input[act] = val;
	}

	async _buildScene() {
		const renderer = new WebGLRenderer({ canvas: this.canvas, alpha: true, antialias: true });
		renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
		this.renderer = renderer;
		reserveWebGLContext();
		this._resizeRenderer();

		const scene = new Scene();
		this.scene = scene;
		scene.add(new AmbientLight(0xffffff, 0.9));
		const hemi = new HemisphereLight(0xbcd6ff, 0x1a2230, 0.75);
		hemi.position.set(0, 300, 0);
		scene.add(hemi);
		const sun = new DirectionalLight(0xffffff, 1.7);
		sun.position.set(80, 320, 260);
		scene.add(sun);

		this._setupCamera();

		const rig = new Group();
		scene.add(rig);
		this.rig = rig;

		const shadow = new Mesh(
			new CircleGeometry(1, 28),
			new MeshBasicMaterial({
				color: 0x05070c,
				transparent: true,
				opacity: 0.32,
				side: DoubleSide,
				depthWrite: false,
			}),
		);
		shadow.renderOrder = -1;
		scene.add(shadow);
		this.shadow = shadow;

		const { model, controller, halfW } = await loadCharacter(this._avatarId, CHAR_PX);
		this.modelHalfW = halfW;
		this._shadowR = Math.max(22, halfW * 1.15);
		rig.add(model);
		this.model = model;
		this.controller = controller;
	}

	_setupCamera() {
		const W = window.innerWidth;
		const H = window.innerHeight;
		const cam = new OrthographicCamera(-W / 2, W / 2, H / 2, -H / 2, -4000, 8000);
		const D = 3000;
		cam.position.set(0, Math.sin(CAM_PITCH) * D, Math.cos(CAM_PITCH) * D);
		cam.up.set(0, 1, 0);
		cam.lookAt(0, 0, 0);
		cam.updateProjectionMatrix();
		cam.updateMatrixWorld(true);
		this.camera = cam;
	}

	_pagePointAtScreen(sx, sy, out) {
		const W = window.innerWidth;
		const H = window.innerHeight;
		const ndcX = (sx / W) * 2 - 1;
		const ndcY = -((sy / H) * 2 - 1);
		const p0 = this._v0.set(ndcX, ndcY, -1).unproject(this.camera);
		const p1 = this._v1.set(ndcX, ndcY, 1).unproject(this.camera);
		const dz = p1.z - p0.z;
		const t = Math.abs(dz) < 1e-6 ? 0 : -p0.z / dz;
		return out.set(p0.x + (p1.x - p0.x) * t, p0.y + (p1.y - p0.y) * t, 0);
	}

	_placeStart(startScreen, dropIn) {
		const sx = window.scrollX || 0;
		const sy = window.scrollY || 0;
		const w = docWidth();
		if (startScreen) {
			this.char.x = clamp(startScreen.x + sx, EDGE_PAD, w - EDGE_PAD);
			this.char.y = clamp(startScreen.y + sy, EDGE_PAD, docHeight() - EDGE_PAD);
		} else {
			this.char.x = clamp(w * 0.5, EDGE_PAD, w - EDGE_PAD);
			this.char.y = clamp(
				sy + window.innerHeight * (dropIn ? 0.32 : 0.4),
				EDGE_PAD,
				docHeight() - EDGE_PAD,
			);
		}
		this.char.vx = 0;
		this.char.vy = 0;
		this._dropIn = dropIn;
	}

	_bindEvents() {
		window.addEventListener('keydown', this._onKeyDown, true);
		window.addEventListener('keyup', this._onKeyUp, true);
		window.addEventListener('resize', this._onResize);
		document.addEventListener('visibilitychange', this._onVisibility);
	}

	_onKeyDown(e) {
		const k = e.key;
		// While the picker is open it owns the keyboard (search, arrows, Escape).
		if (this._picker?.isOpen()) return;
		if (k === 'Escape') {
			exitPlayground();
			return;
		}
		if (k === 'm' || k === 'M') {
			e.preventDefault();
			switchPlaygroundMode();
			return;
		}
		if (k === 'c' || k === 'C') {
			e.preventDefault();
			openAvatarPicker(this);
			return;
		}
		if (emoteHotkey(this, k)) {
			e.preventDefault();
			return;
		}
		let handled = true;
		if (k === 'ArrowLeft' || k === 'a' || k === 'A') this.input.left = true;
		else if (k === 'ArrowRight' || k === 'd' || k === 'D') this.input.right = true;
		else if (k === 'ArrowUp' || k === 'w' || k === 'W') this.input.up = true;
		else if (k === 'ArrowDown' || k === 's' || k === 'S') this.input.down = true;
		else if (k === ' ' || k === 'Spacebar' || k === 'Enter' || k === 'e' || k === 'E')
			this.input.dive = true;
		else handled = false;
		if (handled) e.preventDefault();
	}

	_onKeyUp(e) {
		const k = e.key;
		if (k === 'ArrowLeft' || k === 'a' || k === 'A') this.input.left = false;
		else if (k === 'ArrowRight' || k === 'd' || k === 'D') this.input.right = false;
		else if (k === 'ArrowUp' || k === 'w' || k === 'W') this.input.up = false;
		else if (k === 'ArrowDown' || k === 's' || k === 'S') this.input.down = false;
		else if (k === ' ' || k === 'Spacebar' || k === 'Enter' || k === 'e' || k === 'E')
			this.input.dive = false;
	}

	_onResize() {
		this._resizeRenderer();
		this._setupCamera();
		this.char.x = clamp(this.char.x, EDGE_PAD, docWidth() - EDGE_PAD);
		this.char.y = clamp(this.char.y, EDGE_PAD, docHeight() - EDGE_PAD);
	}

	_resizeRenderer() {
		this.renderer.setSize(window.innerWidth, window.innerHeight, false);
	}

	_hintFor(dropIn) {
		const touch = matchMedia('(pointer: coarse)').matches;
		const move = touch ? 'Use the d-pad to walk' : 'Arrow keys / WASD to walk anywhere';
		if (this._checkpoints) {
			this._say(`${move} — reach the glowing checkpoint.`, 5200);
			return;
		}
		this._say(
			dropIn
				? `You're in! ${move}. Step on a link to dive deeper.`
				: `${move}. Step on a link to dive in.`,
			5200,
		);
	}

	_sayModeIntro() {
		this._say('Stroll mode — free roam, no falling. M to switch back.', 3800);
	}

	_say(text, ms = 3200) {
		if (!this.hintEl || !text) return;
		this.hintEl.textContent = text;
		this.hintEl.classList.add('is-in');
		clearTimeout(this._hintTimer);
		this._hintTimer = setTimeout(() => this.hintEl?.classList.remove('is-in'), ms);
	}

	_armLink(el, href) {
		if (this._armEl === el) return;
		this._clearArm();
		this._armEl = el;
		this._armHref = href;
		el.classList.add('walk-pg-portal');
		this._say('Press Space (or ⬇ / gamepad) to dive in', 2400);
	}

	_clearArm() {
		if (this._armEl) this._armEl.classList.remove('walk-pg-portal');
		this._armEl = null;
		this._armHref = null;
	}

	_dive(href) {
		if (this._diving || !href) return;
		this._diving = true;
		this.controller?.setState('jump');
		if (this._armEl) this._armEl.classList.add('is-open');
		ssSet(_config.keys.resume, '1');
		this.flashEl?.classList.add('is-on');
		const go = () => {
			location.href = href;
		};
		if (this._reduced) {
			go();
			return;
		}
		this.char.vx = 0;
		this.char.vy = 0;
		this._diveTimer = setTimeout(go, 560);
	}

	_tick() {
		if (!this.mounted) return;
		this.clock.update();
		const dt = Math.min(this.clock.getDelta(), 0.033);
		if (!this._diving) this._step(dt);
		this._follow();
		this._render(dt);
		if (this._checkpoints) questUpdate(this);
		this._raf = requestAnimationFrame(this._tick);
	}

	_pollGamepad() {
		const gp = readGamepad();
		mergePad(this.input, this._padHeld, {
			up: !!gp?.up,
			down: !!gp?.down,
			left: !!gp?.left,
			right: !!gp?.right,
			// Either face button is the deliberate "dive into this link" confirm.
			dive: !!(gp?.faceA || gp?.faceB),
		});
	}

	_step(dt) {
		this._pollGamepad();
		const c = this.char;
		let ix = (this.input.right ? 1 : 0) - (this.input.left ? 1 : 0);
		let iy = (this.input.down ? 1 : 0) - (this.input.up ? 1 : 0);
		// Frozen while the host narrates a reached checkpoint: ignore steering so
		// the character stands still (friction bleeds off any residual velocity).
		if (this._narrating) {
			ix = 0;
			iy = 0;
		}
		if (ix !== 0 && iy !== 0) {
			const inv = 1 / Math.SQRT2;
			ix *= inv;
			iy *= inv;
		}
		if (ix !== 0 || iy !== 0) {
			c.vx += ix * MOVE_ACCEL * dt;
			c.vy += iy * MOVE_ACCEL * dt;
			const sp = Math.hypot(c.vx, c.vy);
			if (sp > MAX_SPEED) {
				const k = MAX_SPEED / sp;
				c.vx *= k;
				c.vy *= k;
			}
		} else {
			const f = FRICTION * dt;
			const sp = Math.hypot(c.vx, c.vy);
			if (sp <= f) {
				c.vx = 0;
				c.vy = 0;
			} else {
				const k = (sp - f) / sp;
				c.vx *= k;
				c.vy *= k;
			}
		}
		c.x = clamp(c.x + c.vx * dt, EDGE_PAD, docWidth() - EDGE_PAD);
		c.y = clamp(c.y + c.vy * dt, EDGE_PAD, docHeight() - EDGE_PAD);
		const speed = Math.hypot(c.vx, c.vy);
		if (speed > 12) this.char.facing = Math.atan2(c.vx, c.vy);

		const now = performance.now();
		// On a checkpoint quest the visitor is following a guided path, so the
		// "walk onto a link → dive to another page" mechanic is suppressed — a
		// stray step onto a product link must never navigate them away mid-tour.
		if (!this._checkpoints && now - this._lastProbe > ELEM_PROBE_MS) {
			this._lastProbe = now;
			const feetX = c.x - (window.scrollX || 0);
			const feetY = c.y - (window.scrollY || 0);
			const hit = linkHrefAtPoint(feetX, feetY);
			if (hit) this._armLink(hit.el, hit.href);
			else if (this._armEl) this._clearArm();
		}

		// Diving is opt-in: standing on a link only arms it (the glow + hint). You
		// commit with a deliberate press — Space / Enter / E, the on-screen dive
		// button, or a gamepad face button — never by lingering on it.
		if (!this._checkpoints && this._armHref && this.input.dive && now > this._spawnGuardUntil) {
			this._dive(this._armHref);
			return;
		}

		let state = 'idle';
		if (speed > RUN_SPEED) state = 'run';
		else if (speed > 12) state = 'walk';
		this.controller?.setState(state);

		// Checkpoint quest: once the character is standing on the active checkpoint,
		// freeze and hand off to the host to narrate it.
		if (this._checkpoints && !this._narrating) questProbe(this);
	}

	_follow() {
		const vh = window.innerHeight;
		const cur = window.scrollY || 0;
		const screenY = this.char.y - cur;
		const top = vh * 0.3;
		const bottom = vh * 0.7;
		let next = cur;
		if (screenY < top) next = this.char.y - top;
		else if (screenY > bottom) next = this.char.y - bottom;
		next = clamp(next, 0, maxScroll());
		if (Math.abs(next - cur) > 0.5) window.scrollTo(0, next);
	}

	_render(dt) {
		const c = this.char;
		const feetX = c.x - (window.scrollX || 0);
		const feetY = c.y - (window.scrollY || 0);
		this._pagePointAtScreen(feetX, feetY, this._v0);
		this.rig.position.copy(this._v0);
		if (this.shadow) {
			this.shadow.position.set(this._v0.x, this._v0.y, this._v0.z + 0.5);
			this.shadow.scale.set(this._shadowR, this._shadowR * 0.5, 1);
		}
		if (this._diving) {
			this.rig.rotation.y += dt * 10;
			const s = Math.max(0.04, this.rig.scale.x - dt * 1.6);
			this.rig.scale.setScalar(s);
			if (this.shadow)
				this.shadow.material.opacity = Math.max(0, this.shadow.material.opacity - dt * 0.8);
		} else {
			let d = this.char.facing - this._yaw;
			while (d > Math.PI) d -= Math.PI * 2;
			while (d < -Math.PI) d += Math.PI * 2;
			this._yaw += d * Math.min(1, dt * 11);
			this.rig.rotation.y = this._yaw;
		}
		this.controller?.update(dt);
		this.renderer.render(this.scene, this.camera);
	}

	_teardown() {
		teardownScene(this);
	}
}

// ═════════════════════════════════════════════════════════════════════════════
// Platformer mode — the page's DOM is solid ground; gravity, jumping, falling.
// ═════════════════════════════════════════════════════════════════════════════
class PlatformerPlayground {
	constructor() {
		this.mode = 'platformer';
		this.mounted = false;
		this._reduced = prefersReducedMotion();
		this._raf = 0;
		this._diveTimer = 0;
		this._hintTimer = 0;
		this._tick = this._tick.bind(this);
		this._onKeyDown = this._onKeyDown.bind(this);
		this._onKeyUp = this._onKeyUp.bind(this);
		this._onResize = this._onResize.bind(this);
		this._onVisibility = this._onVisibility.bind(this);
		this._scheduleRescan = this._scheduleRescan.bind(this);
		this.char = { x: 0, y: 0, vx: 0, vy: 0, grounded: false, facing: 1 };
		this.platform = null;
		this.platforms = [];
		this._lastScan = 0;
		this._scrollY = 0;
		this.input = { left: false, right: false, jump: false, down: false };
		this._padHeld = {};
		this._jumpEdge = false;
		this._armEl = null;
		this._armHref = null;
		this._diving = false;
		this._picker = null;
		this.model = null;
		this._charPx = PLAT_CHAR_PX;
	}

	async mount({
		avatarId = null,
		startScreen = null,
		dropIn = false,
		switched = false,
		checkpoints = null,
		onReach = null,
		onComplete = null,
		startCheckpoint = 0,
	} = {}) {
		if (this.mounted) return;
		if (!webglSupported()) {
			log.warn('playground: WebGL unavailable');
			return;
		}
		this.mounted = true;
		this._avatarId = avatarId;
		questInit(this, { checkpoints, onReach, onComplete, startCheckpoint });
		this._buildDom();
		try {
			await this._buildScene();
		} catch (err) {
			log.warn('playground failed to load avatar:', err?.message || err);
			this._teardown();
			return;
		}
		if (!this.mounted) { this._teardown(); return; }
		buildEmoteRail(this);
		this._scrollY = window.scrollY || 0;
		this._scan(true);
		this._placeStart(startScreen, dropIn);
		questBuild(this);
		this._spawnGuardUntil = performance.now() + 1500;
		this._bindEvents();
		if (switched) this._sayModeIntro();
		else this._hintFor(dropIn);
		this.clock = new Timer();
		this._raf = requestAnimationFrame(this._tick);
	}

	// Freeze the character while the host narrates a reached checkpoint (input is
	// ignored; gravity keeps it planted on its platform until resumed).
	setNarrating(on) {
		this._narrating = !!on;
	}

	unmount() {
		if (!this.mounted) return;
		this.mounted = false;
		cancelAnimationFrame(this._raf);
		this._raf = 0;
		clearTimeout(this._diveTimer);
		clearTimeout(this._hintTimer);
		window.removeEventListener('keydown', this._onKeyDown, true);
		window.removeEventListener('keyup', this._onKeyUp, true);
		window.removeEventListener('resize', this._onResize);
		window.removeEventListener('scroll', this._scheduleRescan, true);
		document.removeEventListener('visibilitychange', this._onVisibility);
		this._clearArm();
		destroyPicker(this);
		questDestroy(this);
		this._teardown();
	}

	// Stop the render loop when the tab is backgrounded; resume on return.
	_onVisibility() {
		if (document.hidden) {
			cancelAnimationFrame(this._raf);
			this._raf = 0;
		} else if (this.mounted && !this._raf) {
			this._raf = requestAnimationFrame(this._tick);
		}
	}

	currentScreenPos() {
		return { x: this.char.x - (window.scrollX || 0), y: this.char.y - (window.scrollY || 0) };
	}

	_buildDom() {
		ensureStyles();
		const host = document.createElement('div');
		host.className = 'walk-pg walk-pg--plat';
		// On a guided checkpoint quest, suppress the free-play chrome the host owns
		// (avatar picker, the playground's own exit) — the mode pill stays so the
		// visitor can hop between Stroll and Platformer mid-quest.
		if (this._checkpoints) host.classList.add('is-quest');
		host.setAttribute('role', 'application');
		host.setAttribute(
			'aria-label',
			'Page playground — walk and jump the character with arrow keys',
		);
		host.innerHTML = `
			<canvas class="walk-pg-canvas"></canvas>
			<div class="walk-pg-hint" aria-live="polite"></div>
			${_config.enablePicker === false ? '' : pickButtonHTML()}
			${modeButtonHTML(this.mode)}
			<button type="button" class="walk-pg-exit" aria-label="Exit playground" title="Exit (Esc)">Exit ✕</button>
			<div class="walk-pg-pad" aria-hidden="true">
				<button type="button" class="walk-pg-btn" data-act="left" aria-label="Walk left">◀</button>
				<button type="button" class="walk-pg-btn" data-act="right" aria-label="Walk right">▶</button>
				<button type="button" class="walk-pg-btn walk-pg-jump" data-act="jump" aria-label="Jump">⤒</button>
				<button type="button" class="walk-pg-btn" data-act="down" aria-label="Dive into link">⤓</button>
			</div>
			<div class="walk-pg-flash" aria-hidden="true"></div>
		`;
		document.body.appendChild(host);
		this.host = host;
		this.canvas = host.querySelector('.walk-pg-canvas');
		this.hintEl = host.querySelector('.walk-pg-hint');
		this.flashEl = host.querySelector('.walk-pg-flash');
		host.querySelector('.walk-pg-exit').addEventListener('click', () => exitPlayground());
		host.querySelector('.walk-pg-mode').addEventListener('click', () => switchPlaygroundMode());
		host.querySelector('.walk-pg-pick')?.addEventListener('click', (e) => {
			e.stopPropagation();
			openAvatarPicker(this);
		});
		host.querySelectorAll('.walk-pg-btn').forEach((btn) => {
			const act = btn.getAttribute('data-act');
			const on = (e) => {
				e.preventDefault();
				this._setAct(act, true);
			};
			const off = (e) => {
				e.preventDefault();
				this._setAct(act, false);
			};
			btn.addEventListener('pointerdown', on);
			btn.addEventListener('pointerup', off);
			btn.addEventListener('pointerleave', off);
			btn.addEventListener('pointercancel', off);
		});
		requestAnimationFrame(() => host.classList.add('is-in'));
	}

	_setAct(act, val) {
		if (act === 'left') this.input.left = val;
		else if (act === 'right') this.input.right = val;
		else if (act === 'jump') {
			this.input.jump = val;
			if (!val) this._jumpEdge = false;
		} else if (act === 'down') this.input.down = val;
	}

	async _buildScene() {
		const renderer = new WebGLRenderer({ canvas: this.canvas, alpha: true, antialias: true });
		renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
		this.renderer = renderer;
		reserveWebGLContext();
		this._resizeRenderer();

		const scene = new Scene();
		this.scene = scene;
		scene.add(new AmbientLight(0xffffff, 0.9));
		const hemi = new HemisphereLight(0xbcd6ff, 0x1a2230, 0.75);
		hemi.position.set(0, 200, 0);
		scene.add(hemi);
		const sun = new DirectionalLight(0xffffff, 1.7);
		sun.position.set(120, 260, 220);
		scene.add(sun);

		this.camera = new OrthographicCamera(
			0,
			window.innerWidth,
			0,
			-window.innerHeight,
			-1000,
			2000,
		);
		this.camera.position.z = 600;

		const rig = new Group();
		scene.add(rig);
		this.rig = rig;

		const { model, controller, halfW } = await loadCharacter(this._avatarId, PLAT_CHAR_PX);
		this.modelHalfW = halfW;
		rig.add(model);
		this.model = model;
		this.controller = controller;
	}

	_placeStart(startScreen, dropIn) {
		const sy = window.scrollY || 0;
		if (dropIn) {
			this.char.x = clamp(docWidth() * 0.5, 40, docWidth() - 40);
			this.char.y = sy - PLAT_CHAR_PX;
			this.char.vy = 60;
			this.char.grounded = false;
		} else if (startScreen) {
			this.char.x = clamp(startScreen.x + (window.scrollX || 0), 40, docWidth() - 40);
			this.char.y = startScreen.y + sy;
			this.char.vy = 40;
			this.char.grounded = false;
		} else {
			this.char.x = clamp(docWidth() * 0.5, 40, docWidth() - 40);
			this.char.y = sy + window.innerHeight * 0.3;
			this.char.vy = 0;
		}
	}

	_scan(force = false) {
		const now = performance.now();
		if (!force && now - this._lastScan < 180) return;
		this._lastScan = now;
		const sx = window.scrollX || 0;
		const sy = window.scrollY || 0;
		const bandTop = sy - 1100;
		const bandBottom = sy + window.innerHeight + 1100;
		const out = [];
		const seen = new Set();
		const els = document.querySelectorAll(SOLID_SELECTOR);
		for (const el of els) {
			if (out.length >= 360) break;
			if (this.host.contains(el)) continue;
			const r = el.getBoundingClientRect();
			if (r.width < 38 || r.height < 14 || r.height > 520) continue;
			const top = r.top + sy;
			const bottom = r.bottom + sy;
			if (bottom < bandTop || top > bandBottom) continue;
			const style = el.ownerDocument.defaultView.getComputedStyle(el);
			if (style.visibility === 'hidden' || style.display === 'none' || +style.opacity === 0)
				continue;
			const left = r.left + sx;
			const right = r.right + sx;
			const key = `${Math.round(left)},${Math.round(top)},${Math.round(right)}`;
			if (seen.has(key)) continue;
			seen.add(key);
			const link = el.closest('a[href]');
			let href = null;
			if (link) {
				const raw = link.getAttribute('href') || '';
				if (raw && !raw.startsWith('#') && (!link.target || link.target === '_self')) {
					try {
						const u = new URL(raw, location.href);
						if (u.origin === location.origin) href = u.href;
					} catch {
						/* unparseable href — treat as plain platform */
					}
				}
			}
			out.push({ left, right, top, bottom, href, el });
		}
		const w = docWidth();
		out.push({
			left: -40,
			right: w + 40,
			top: docHeight() - 3,
			bottom: docHeight(),
			href: null,
			el: null,
		});
		this.platforms = out;
		if (this.platform && !out.includes(this.platform)) out.push(this.platform);
	}

	_scheduleRescan() {
		this._scrollY = window.scrollY || 0;
		this._scan();
	}

	_bindEvents() {
		window.addEventListener('keydown', this._onKeyDown, true);
		window.addEventListener('keyup', this._onKeyUp, true);
		window.addEventListener('resize', this._onResize);
		window.addEventListener('scroll', this._scheduleRescan, true);
		document.addEventListener('visibilitychange', this._onVisibility);
	}

	_onKeyDown(e) {
		const k = e.key;
		// While the picker is open it owns the keyboard (search, arrows, Escape).
		if (this._picker?.isOpen()) return;
		if (k === 'Escape') {
			exitPlayground();
			return;
		}
		if (k === 'm' || k === 'M') {
			e.preventDefault();
			switchPlaygroundMode();
			return;
		}
		if (k === 'c' || k === 'C') {
			e.preventDefault();
			openAvatarPicker(this);
			return;
		}
		if (emoteHotkey(this, k)) {
			e.preventDefault();
			return;
		}
		let handled = true;
		if (k === 'ArrowLeft' || k === 'a' || k === 'A') this.input.left = true;
		else if (k === 'ArrowRight' || k === 'd' || k === 'D') this.input.right = true;
		else if (k === ' ' || k === 'ArrowUp' || k === 'w' || k === 'W' || k === 'Spacebar')
			this.input.jump = true;
		else if (k === 'ArrowDown' || k === 's' || k === 'S') this.input.down = true;
		else handled = false;
		if (handled) e.preventDefault();
	}

	_onKeyUp(e) {
		const k = e.key;
		if (k === 'ArrowLeft' || k === 'a' || k === 'A') this.input.left = false;
		else if (k === 'ArrowRight' || k === 'd' || k === 'D') this.input.right = false;
		else if (k === ' ' || k === 'ArrowUp' || k === 'w' || k === 'W' || k === 'Spacebar') {
			this.input.jump = false;
			this._jumpEdge = false;
		} else if (k === 'ArrowDown' || k === 's' || k === 'S') this.input.down = false;
	}

	_onResize() {
		this._resizeRenderer();
		if (this.camera) {
			this.camera.right = window.innerWidth;
			this.camera.bottom = -window.innerHeight;
			this.camera.updateProjectionMatrix();
		}
		this._scan(true);
	}

	_resizeRenderer() {
		this.renderer.setSize(window.innerWidth, window.innerHeight, false);
	}

	_hintFor(dropIn) {
		const touch = matchMedia('(pointer: coarse)').matches;
		const move = touch ? 'Use the buttons' : 'Arrow keys / WASD to move, Space to jump';
		if (this._checkpoints) {
			this._say(`${move} — reach the glowing checkpoint.`, 5200);
			return;
		}
		this._say(
			dropIn
				? `You fell in! ${move}. Land on a link to dive deeper.`
				: `${move}. Land on a link to dive in.`,
			5200,
		);
	}

	_sayModeIntro() {
		const touch = matchMedia('(pointer: coarse)').matches;
		const jump = touch ? 'tap ⤒ to jump' : 'Space to jump';
		this._say(`Platformer mode — gravity on, ${jump}. M to switch back.`, 3800);
	}

	_say(text, ms = 3200) {
		if (!this.hintEl || !text) return;
		this.hintEl.textContent = text;
		this.hintEl.classList.add('is-in');
		clearTimeout(this._hintTimer);
		this._hintTimer = setTimeout(() => this.hintEl?.classList.remove('is-in'), ms);
	}

	_armLink(p) {
		if (this._armEl === p.el) return;
		this._clearArm();
		this._armEl = p.el;
		this._armHref = p.href;
		p.el.classList.add('walk-pg-portal');
		this._say('Press ↓ (or ⤓ / gamepad) to dive in', 2200);
	}

	_clearArm() {
		if (this._armEl) this._armEl.classList.remove('walk-pg-portal');
		this._armEl = null;
		this._armHref = null;
	}

	_dive(href) {
		if (this._diving || !href) return;
		this._diving = true;
		this.controller?.setState('jump');
		if (this._armEl) this._armEl.classList.add('is-open');
		ssSet(_config.keys.resume, '1');
		this.flashEl?.classList.add('is-on');
		const go = () => {
			location.href = href;
		};
		if (this._reduced) {
			go();
			return;
		}
		this.char.vx = 0;
		this.char.vy = TERMINAL;
		this.char.grounded = false;
		this._diveTimer = setTimeout(go, 620);
	}

	_tick() {
		if (!this.mounted) return;
		this.clock.update();
		const dt = Math.min(this.clock.getDelta(), 0.033);
		if (!this._diving) this._step(dt);
		this._follow(dt);
		this._render(dt);
		if (this._checkpoints) questUpdate(this);
		this._raf = requestAnimationFrame(this._tick);
	}

	_pollGamepad() {
		const gp = readGamepad();
		mergePad(this.input, this._padHeld, {
			left: !!gp?.left,
			right: !!gp?.right,
			jump: !!gp?.faceA, // ✕ / A leaps
			// Down on the stick/d-pad, or ○ / B, dives into the link platform.
			down: !!(gp?.down || gp?.faceB),
		});
	}

	_step(dt) {
		this._pollGamepad();
		const c = this.char;
		// Frozen while the host narrates a reached checkpoint: ignore steering,
		// jumping, and dropping so the character stands still (gravity still runs,
		// keeping it planted on its platform).
		const frozen = this._narrating;
		const dir = frozen ? 0 : (this.input.right ? 1 : 0) - (this.input.left ? 1 : 0);
		const accel = c.grounded ? GROUND_ACCEL : AIR_ACCEL;
		if (dir !== 0) {
			c.vx += dir * accel * dt;
			c.vx = clamp(c.vx, -MOVE_SPEED, MOVE_SPEED);
			c.facing = dir;
		} else if (c.grounded) {
			const f = PLAT_FRICTION * dt;
			if (Math.abs(c.vx) <= f) c.vx = 0;
			else c.vx -= Math.sign(c.vx) * f;
		}
		// Edge-trigger the jump from whichever source released it (keyup clears this
		// for the keyboard; the pad poll can't, so re-arm here when jump is idle).
		if (!this.input.jump) this._jumpEdge = false;
		if (this.input.jump && c.grounded && !this._jumpEdge && !frozen) {
			c.vy = -JUMP_V;
			c.grounded = false;
			this.platform = null;
			this._jumpEdge = true;
			this._clearArm();
		}
		if (this.input.down && c.grounded && !frozen) {
			// On a checkpoint quest the visitor is following a guided path, so the
			// "land on a link → dive to another page" mechanic is suppressed — ↓
			// always drops through, and never navigates them away mid-tour.
			if (this.platform?.href && !this._checkpoints) {
				// Down on a link platform dives — never drops through it. Held over
				// from a previous page? The spawn guard swallows it for a beat.
				if (performance.now() > this._spawnGuardUntil) {
					this._dive(this.platform.href);
					return;
				}
			} else {
				c.y += 4;
				c.grounded = false;
				const dropped = this.platform;
				this.platform = null;
				this._dropIgnore = dropped;
			}
		}
		c.vy = Math.min(c.vy + GRAVITY * dt, TERMINAL);
		const prevY = c.y;
		c.x = clamp(c.x + c.vx * dt, this.modelHalfW, docWidth() - this.modelHalfW);
		c.y = c.y + c.vy * dt;
		if (c.vy >= 0) {
			let best = null;
			for (const p of this.platforms) {
				if (p === this._dropIgnore) continue;
				if (c.x < p.left - FOOT_PAD || c.x > p.right + FOOT_PAD) continue;
				if (prevY <= p.top + LAND_TOL && c.y >= p.top) {
					if (!best || p.top < best.top) best = p;
				}
			}
			if (best) {
				c.y = best.top;
				c.vy = 0;
				c.grounded = true;
				this.platform = best;
				this._dropIgnore = null;
			} else if (c.grounded && this.platform) {
				const p = this.platform;
				if (c.x < p.left - FOOT_PAD || c.x > p.right + FOOT_PAD) {
					c.grounded = false;
					this.platform = null;
				} else {
					c.y = p.top;
				}
			} else {
				c.grounded = false;
			}
		}
		// Standing on a link platform only arms it (glow + "↓ to dive in"). The dive
		// itself is the deliberate ↓ / dive-button / gamepad-down press handled
		// above — resting on a platform never navigates on its own. Suppressed on a
		// checkpoint quest, where links are just ground.
		const pastGuard = performance.now() > this._spawnGuardUntil;
		if (
			!this._checkpoints &&
			pastGuard &&
			c.grounded &&
			this.platform?.href &&
			Math.abs(c.vx) < 30 &&
			dir === 0
		) {
			this._armLink(this.platform);
		} else if (this._armEl && (!c.grounded || this.platform?.el !== this._armEl || dir !== 0)) {
			this._clearArm();
		}
		let state = 'idle';
		if (!c.grounded) state = 'jump';
		else if (Math.abs(c.vx) > PLAT_RUN_SPEED) state = 'run';
		else if (Math.abs(c.vx) > 6) state = 'walk';
		this.controller?.setState(state);

		// Checkpoint quest: landing on (or walking into) the active checkpoint
		// freezes the character and hands off to the host to narrate it.
		if (this._checkpoints && !this._narrating && c.grounded) questProbe(this);
	}

	_follow(dt) {
		const want = clamp(this.char.y - window.innerHeight * 0.55, 0, maxScroll());
		const cur = window.scrollY || 0;
		const next = this._reduced ? want : cur + (want - cur) * Math.min(1, dt * 6);
		if (Math.abs(next - cur) > 0.5) window.scrollTo(0, next);
		this._scrollY = window.scrollY || 0;
		this._scan();
	}

	_render(dt) {
		const c = this.char;
		const sx = window.scrollX || 0;
		const sy = window.scrollY || 0;
		const screenX = c.x - sx;
		const screenY = c.y - sy;
		this.rig.position.set(screenX, -screenY, 0);
		if (this._diving) {
			this.rig.rotation.y += dt * 9;
			const s = Math.max(0.05, this.rig.scale.x - dt * 1.4);
			this.rig.scale.setScalar(s);
		} else {
			const targetYaw = c.facing >= 0 ? 0.6 : -0.6;
			this.rig.rotation.y += (targetYaw - this.rig.rotation.y) * Math.min(1, dt * 10);
		}
		this.controller?.update(dt);
		this.renderer.render(this.scene, this.camera);
	}

	_teardown() {
		teardownScene(this);
	}
}

// ── Shared scene teardown ─────────────────────────────────────────────────────
function teardownScene(pg) {
	try {
		pg.controller?.dispose();
	} catch {
		/* non-fatal */
	}
	pg.controller = null;
	if (pg.scene) {
		pg.scene.traverse((n) => {
			if (n.isMesh) {
				n.geometry?.dispose?.();
				const mats = Array.isArray(n.material) ? n.material : [n.material];
				mats.forEach((m) => {
					if (!m) return;
					for (const v of Object.values(m)) if (v && v.isTexture) v.dispose();
					m.dispose?.();
				});
			}
		});
	}
	pg.scene = null;
	if (pg.renderer) {
		pg.renderer.dispose();
		pg.renderer.forceContextLoss?.();
		pg.renderer = null;
		releaseWebGLContext();
	}
	if (pg.host?.parentNode) pg.host.parentNode.removeChild(pg.host);
	pg.host = null;
}

// ── Scoped styles ─────────────────────────────────────────────────────────────
let _stylesInjected = false;
function ensureStyles() {
	if (_stylesInjected) return;
	_stylesInjected = true;
	const style = document.createElement('style');
	style.id = 'walk-pg-style';
	style.textContent = `
.walk-pg{position:fixed;inset:0;z-index:2147483100;pointer-events:none;opacity:0;transition:opacity .3s ease}
.walk-pg.is-in{opacity:1}
.walk-pg-canvas{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;filter:drop-shadow(0 18px 22px rgba(0,0,0,.3))}
.walk-pg-exit{position:fixed;top:14px;right:14px;z-index:3;pointer-events:auto;border:1px solid rgba(255,255,255,.16);background:rgba(14,16,22,.72);color:#f2f4f8;font:600 12.5px/1 system-ui,sans-serif;padding:9px 13px;border-radius:999px;cursor:pointer;backdrop-filter:blur(6px);transition:background .2s ease,transform .15s ease}
.walk-pg-exit:hover{background:rgba(220,60,60,.85)}
.walk-pg-exit:active{transform:scale(.96)}
.walk-pg-exit:focus-visible{outline:2px solid #7aa2ff;outline-offset:2px}
.walk-pg-mode{position:fixed;top:14px;right:92px;z-index:3;pointer-events:auto;display:inline-flex;align-items:center;gap:6px;border:1px solid rgba(255,255,255,.16);background:rgba(14,16,22,.72);color:#f2f4f8;font:600 12.5px/1 system-ui,sans-serif;padding:9px 13px;border-radius:999px;cursor:pointer;backdrop-filter:blur(6px);transition:background .2s ease,transform .15s ease}
.walk-pg-mode:hover{background:rgba(122,162,255,.55)}
.walk-pg-mode:active{transform:scale(.96)}
.walk-pg-mode:focus-visible{outline:2px solid #7aa2ff;outline-offset:2px}
.walk-pg-mode-ic{font-size:14px;line-height:1}
.walk-pg-pick{position:fixed;top:14px;right:192px;z-index:3;pointer-events:auto;display:inline-flex;align-items:center;gap:6px;border:1px solid rgba(255,255,255,.16);background:rgba(14,16,22,.72);color:#f2f4f8;font:600 12.5px/1 system-ui,sans-serif;padding:9px 13px;border-radius:999px;cursor:pointer;backdrop-filter:blur(6px);transition:background .2s ease,transform .15s ease}
.walk-pg-pick:hover{background:rgba(122,162,255,.55)}
.walk-pg-pick:active{transform:scale(.96)}
.walk-pg-pick:focus-visible{outline:2px solid #7aa2ff;outline-offset:2px}
.walk-pg-pick-ic{font-size:14px;line-height:1}
.walk-pg-hint{position:fixed;left:50%;bottom:22px;transform:translateX(-50%) translateY(8px);z-index:3;pointer-events:none;max-width:88vw;width:max-content;background:rgba(18,20,28,.92);color:#f2f4f8;font:500 13px/1.4 system-ui,sans-serif;padding:9px 14px;border-radius:12px;border:1px solid rgba(255,255,255,.1);box-shadow:0 10px 28px rgba(0,0,0,.35);opacity:0;transition:opacity .3s ease,transform .3s ease;text-align:center}
.walk-pg-hint.is-in{opacity:1;transform:translateX(-50%) translateY(0)}
.walk-pg-btn{pointer-events:auto;border:1px solid rgba(255,255,255,.18);background:rgba(16,18,26,.78);color:#fff;display:grid;place-items:center;backdrop-filter:blur(6px);-webkit-user-select:none;user-select:none;touch-action:none}
.walk-pg-btn:active{background:rgba(122,162,255,.5)}
.walk-pg--stroll .walk-pg-pad{position:fixed;left:18px;bottom:18px;z-index:3;display:none;flex-direction:column;align-items:center;gap:8px;pointer-events:none}
.walk-pg--stroll .walk-pg-pad-row{display:flex;gap:8px;align-items:center}
.walk-pg--stroll .walk-pg-btn{width:54px;height:54px;border-radius:14px;font-size:20px}
.walk-pg-dive{border-radius:50%!important;background:rgba(122,162,255,.32)}
.walk-pg--plat .walk-pg-pad{position:fixed;left:0;right:0;bottom:18px;z-index:3;display:none;justify-content:center;gap:12px;pointer-events:none}
.walk-pg--plat .walk-pg-btn{width:60px;height:60px;border-radius:50%;font-size:22px}
.walk-pg-jump{background:rgba(122,162,255,.32)}
.walk-pg-emotes{position:fixed;right:14px;top:50%;transform:translateY(-50%);z-index:3;display:flex;flex-direction:column;gap:10px;pointer-events:none}
.walk-pg-emote{pointer-events:auto;width:54px;height:54px;border-radius:50%;border:1px solid rgba(255,255,255,.18);background:rgba(16,18,26,.78);color:#fff;font-size:24px;line-height:1;display:grid;place-items:center;cursor:pointer;backdrop-filter:blur(6px);transition:background .2s ease,transform .15s ease;-webkit-user-select:none;user-select:none;touch-action:manipulation;padding:0}
.walk-pg-emote:hover{background:rgba(122,162,255,.55);transform:scale(1.06)}
.walk-pg-emote:active{transform:scale(.92)}
.walk-pg-emote:focus-visible{outline:2px solid #7aa2ff;outline-offset:2px}
.walk-pg-emote.is-playing{animation:walk-pg-emote-pop .45s ease}
@keyframes walk-pg-emote-pop{0%{transform:scale(1)}40%{transform:scale(1.22)}100%{transform:scale(1)}}
@media (max-width:520px){.walk-pg-emotes{right:10px;gap:8px}.walk-pg-emote{width:46px;height:46px;font-size:20px}}
.walk-pg-flash{position:fixed;inset:0;z-index:2;pointer-events:none;background:radial-gradient(circle at 50% 50%,rgba(122,162,255,0) 0%,rgba(8,10,16,0) 60%);opacity:0;transition:opacity .5s ease}
.walk-pg-flash.is-on{background:radial-gradient(circle at 50% 50%,rgba(122,162,255,.25) 0%,rgba(6,8,14,.96) 70%);opacity:1}
.walk-pg-portal{outline:2px solid rgba(122,162,255,.9)!important;outline-offset:3px;border-radius:6px;box-shadow:0 0 0 4px rgba(122,162,255,.18),0 0 28px rgba(122,162,255,.45)!important;transition:box-shadow .2s ease,transform .25s ease;animation:walk-pg-pulse 1.1s ease-in-out infinite}
.walk-pg-portal.is-open{transform:scale(.94);box-shadow:0 0 0 6px rgba(122,162,255,.3),0 0 48px rgba(122,162,255,.7)!important}
@keyframes walk-pg-pulse{0%,100%{box-shadow:0 0 0 4px rgba(122,162,255,.16),0 0 22px rgba(122,162,255,.35)}50%{box-shadow:0 0 0 6px rgba(122,162,255,.3),0 0 36px rgba(122,162,255,.6)}}
@media (pointer: coarse){.walk-pg--stroll .walk-pg-pad,.walk-pg--plat .walk-pg-pad{display:flex}.walk-pg--stroll .walk-pg-hint{bottom:200px}.walk-pg--plat .walk-pg-hint{bottom:110px}.walk-pg-mode .walk-pg-mode-tx{display:none}.walk-pg-mode{right:84px}.walk-pg-pick .walk-pg-pick-tx{display:none}.walk-pg-pick{right:132px}}
@media (prefers-reduced-motion:reduce){.walk-pg,.walk-pg-hint,.walk-pg-flash{transition:none}.walk-pg-portal,.walk-pg-emote.is-playing{animation:none}}
`;
	document.head.appendChild(style);
}

// ── Public API ────────────────────────────────────────────────────────────────
let _instance = null;

function modeClass(mode) {
	return mode === 'platformer' ? PlatformerPlayground : StrollPlayground;
}

export function launchPlayground(opts = {}) {
	if (opts.config) _config = opts.config;
	if (_instance) return _instance;
	const mode = opts.mode || getMode();
	_instance = new (modeClass(mode))();
	_instance.mount({ ...opts, mode });
	return _instance;
}

export function exitPlayground() {
	if (_instance) {
		_instance.unmount();
		_instance = null;
	}
	try {
		window.dispatchEvent(new CustomEvent('walk-playground:exit'));
	} catch {
		/* non-fatal */
	}
}

export function switchPlaygroundMode(forceMode = null) {
	if (!_instance || !_instance.mounted) return null;
	const cur = _instance.mode;
	const next = forceMode || (cur === 'platformer' ? 'stroll' : 'platformer');
	if (next === cur) return _instance;
	setMode(next);
	const startScreen = _instance.currentScreenPos();
	const avatarId = _instance._avatarId || null;
	// A checkpoint quest survives the switch: same targets, same host callbacks,
	// same progress — only the movement model changes underneath it.
	const quest = _instance._checkpoints
		? {
				checkpoints: _instance._checkpoints,
				onReach: _instance._onReach,
				onComplete: _instance._onComplete,
				startCheckpoint: _instance._activeCp,
			}
		: null;
	_instance.unmount();
	_instance = new (modeClass(next))();
	_instance.mount({ avatarId, startScreen, switched: true, mode: next, ...quest });
	try {
		window.dispatchEvent(new CustomEvent('walk-playground:mode', { detail: { mode: next } }));
	} catch {
		/* non-fatal */
	}
	return _instance;
}

export function getPlaygroundMode() {
	return _instance?.mode || getMode();
}

export function shouldDropIn(config) {
	if (config) _config = config;
	return ssGet(_config.keys.resume) === '1';
}

export function consumeDropIn(config) {
	if (config) _config = config;
	const v = ssGet(_config.keys.resume) === '1';
	if (v) ssDel(_config.keys.resume);
	return v;
}

export function playgroundState() {
	if (!_instance || !_instance.mounted) return null;
	const c = _instance.char;
	const base = {
		mode: _instance.mode,
		x: Math.round(c.x),
		y: Math.round(c.y),
		vx: Math.round(c.vx),
		vy: Math.round(c.vy),
		diving: _instance._diving,
	};
	if (_instance._checkpoints) {
		base.quest = {
			checkpoint: _instance._activeCp,
			total: _instance._checkpoints.length,
			narrating: _instance._narrating,
		};
	}
	if (_instance.mode === 'platformer') {
		return {
			...base,
			grounded: c.grounded,
			facing: c.facing,
			platforms: _instance.platforms.length,
			onLink: !!_instance.platform?.href,
		};
	}
	return { ...base, speed: Math.round(Math.hypot(c.vx, c.vy)), onLink: !!_instance._armHref };
}

// Console/debug convenience + the surface a few pages (e.g. the IBM demo)
// drive directly. Set when this (lazy) module loads, in either host or
// standalone use.
if (typeof window !== 'undefined') {
	window.__walkPlayground = {
		launch: launchPlayground,
		exit: exitPlayground,
		switchMode: switchPlaygroundMode,
		mode: getPlaygroundMode,
		state: playgroundState,
	};
}
