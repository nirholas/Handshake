// Site-wide Walk Companion — three.ws integration entry.
// ======================================================
// The companion/playground engine now lives in the publishable SDK at
// walk-sdk/ (@three-ws/walk). This file is the thin three.ws wiring: it builds
// the platform-specific config, exposes the window API public/nav.js expects,
// and kicks off the app's auto-mount/deep-link behaviour.
//
// Delivery is unchanged: Vite emits this module to the stable, unhashed path
// /walk-companion.js (see vite.config.js → rollupOptions.output.entryFileNames),
// and public/nav.js injects it with <script type="module"> only when the
// companion is enabled — so a page that never turns it on pays nothing. We
// import from companion.js (not the package index) so the playground stays a
// lazy import() chunk and isn't pulled in until the avatar detaches.

import { createWalkCompanion } from '../walk-sdk/src/companion.js';
import { installTransitions } from './walk-companion-transitions.js';
import { createWalkTrails2D, createTrailSetting, TRAIL_STYLE_LABELS } from './walk-trails.js';
import { installClickToWalk } from './walk-companion-click-to-walk.js';
import { installNarrator } from './walk-companion-narrator.js';
import { installIdentity } from './walk-companion-identity.js';
// The companion is the site-wide "your agent" body. Booting the mood embodiment
// here makes it reflect the agent's live emotional state (aura + breathing) on
// every page the companion runs — and starts the mood engine for the session.
import './agents/mood-embodiment.js';

const walk = createWalkCompanion({
	// Static GLBs and the animation manifest are served from this origin.
	assetBase: '',
	apiBase: '',
	manifestUrl: '/animations/manifest.json',
	// "Make your own" link in the avatar picker → the avatar builder.
	docsUrl: '/avatar-studio',
});

// public/nav.js drives the companion through this global (toggle from the nav
// Walk button, react to ?walk= overrides). Keep the surface it relies on.
window.__walkCompanion = walk;

// Walk-aware page transitions (task 33): dress the jump between pages to match
// the destination. The runner needs the companion's host element — both for the
// camera-zoom-into-avatar preset and for slotting the "Themed transitions"
// settings pill into the companion's existing control cluster. We read it lazily
// off the live instance so this survives avatar swaps and playground round-trips.
const companionHost = () => walk.instance?.host || null;

// When a themed transition takes over a link click it preventDefaults, which
// would suppress the SDK companion's own _onLinkClick (task 32: wave goodbye +
// set the sessionStorage greet flag the destination reads to wave hello). We
// reproduce that single behaviour here so it still fires exactly once.
const GREET_KEY = walk.config?.keys?.greet || 'walk:companion:greet';
function onTransitionNavStart() {
	try {
		walk.instance?.controller?.playWave();
	} catch {
		/* controller may not be ready — non-fatal */
	}
	try {
		sessionStorage.setItem(GREET_KEY, '1');
	} catch {
		/* private mode / disabled storage — non-fatal */
	}
}

installTransitions({
	getAvatarEl: companionHost,
	getHostEl: companionHost,
	onNavStart: onTransitionNavStart,
});

// ── Path-trail visualization (Task 36) ──────────────────────────────────────
// Paint where the companion has been: footprints / glow / line dropped into an
// overlay glued behind the avatar canvas while the avatar is in its walk state.
// The companion avatar walks in place (it rotates to follow the cursor rather
// than translating), so the trail synthesizes a gentle path beneath its feet.
//
// Integration is non-invasive: we never edit the SDK. We observe the live
// instance — its host element (for the overlay rect + a small style toggle), its
// current roster entry (for the avatar accent), and its controller (whose
// setState we wrap to learn when it's walking). All three are re-resolved as the
// companion mounts, swaps avatars, and tears down, so the trail follows along.
const TRAIL_KEY = `${(walk.config?.keys?.enabled || 'three:companion:enabled').split(':')[0]}:companion:trail`;
const trailSetting = createTrailSetting(TRAIL_KEY, 'footprints');

let trail2d = null; // active createWalkTrails2D handle
let trailHost = null; // host element the current trail is glued to
let trailRaf = 0;
let trailClock = 0;
let isWalking = false; // captured from the patched controller.setState
let patchedController = null; // controller whose setState we've wrapped
let trailToggleBtn = null; // the small style switch added to the host chrome
let trailAccentId = null; // entry id whose accent the trail currently uses

function companionAccent() {
	const inst = walk.instance;
	const entry = inst?._currentEntry;
	const a = entry?.accent;
	return typeof a === 'string' || typeof a === 'number' ? a : null;
}

// Wrap the controller's setState exactly once per controller instance so we know
// when the avatar is walking without touching the SDK. Re-runs after avatar
// swaps (which mint a fresh controller).
function syncControllerPatch() {
	const ctrl = walk.instance?.controller;
	if (!ctrl || ctrl === patchedController) return;
	patchedController = ctrl;
	const original = ctrl.setState.bind(ctrl);
	ctrl.setState = (next) => {
		isWalking = next === 'walk' || next === 'run';
		return original(next);
	};
}

// A small style switch slotted into the companion's chrome, styled to match its
// close/swap buttons. Tap to cycle off → footprints → glow → line.
function ensureToggleButton(host) {
	if (trailToggleBtn && trailToggleBtn.isConnected) return;
	const btn = document.createElement('button');
	btn.type = 'button';
	btn.className = 'walk-companion-trail';
	btn.setAttribute('aria-label', 'Cycle companion path trail style');
	btn.title = `Path trail: ${TRAIL_STYLE_LABELS[trailSetting.get()]}`;
	btn.textContent = '∿';
	btn.style.cssText = [
		'position:absolute',
		'top:2px',
		'right:54px',
		'z-index:3',
		'width:22px',
		'height:22px',
		'border:none',
		'border-radius:50%',
		'background:rgba(12,14,20,.55)',
		'color:#fff',
		'font-size:13px',
		'line-height:1',
		'cursor:pointer',
		'pointer-events:auto',
		'opacity:0',
		'transition:opacity .2s ease,background .2s ease',
		'display:grid',
		'place-items:center',
		'padding:0',
	].join(';');
	btn.addEventListener('click', (e) => {
		e.stopPropagation();
		const next = trailSetting.cycle();
		trail2d?.setStyle(next);
		btn.title = `Path trail: ${TRAIL_STYLE_LABELS[next]}`;
		btn.style.background = next === 'off' ? 'rgba(12,14,20,.55)' : 'rgba(122,162,255,.85)';
	});
	// Reveal the button on hover/focus of the companion, matching its siblings.
	const styleId = 'walk-companion-trail-style';
	if (!document.getElementById(styleId)) {
		const s = document.createElement('style');
		s.id = styleId;
		s.textContent =
			'.walk-companion:hover .walk-companion-trail,.walk-companion:focus-within .walk-companion-trail{opacity:1}' +
			'.walk-companion-trail:hover{background:rgba(122,162,255,.85)}' +
			'.walk-companion-trail:focus-visible{outline:2px solid #7aa2ff;outline-offset:2px;opacity:1}' +
			'@media (pointer:coarse){.walk-companion-trail{opacity:1}}';
		document.head.appendChild(s);
	}
	if (trailSetting.get() !== 'off') btn.style.background = 'rgba(122,162,255,.85)';
	host.appendChild(btn);
	trailToggleBtn = btn;
}

function teardownTrail() {
	if (trailRaf) cancelAnimationFrame(trailRaf);
	trailRaf = 0;
	trail2d?.dispose();
	trail2d = null;
	trailHost = null;
	trailToggleBtn = null;
	patchedController = null;
	trailAccentId = null;
}

function trailTick(now) {
	const inst = walk.instance;
	const host = inst?.host;
	// The companion came or went (enable/disable, detach to playground, swap) —
	// (re)bind the trail to whatever host is live now.
	if (!host || !inst.mounted) {
		if (trail2d) teardownTrail();
		trailRaf = requestAnimationFrame(trailTick);
		return;
	}
	if (host !== trailHost) {
		teardownTrail();
		trailHost = host;
		trail2d = createWalkTrails2D({
			host,
			getColor: companionAccent,
			getWalking: () => isWalking,
			initialStyle: trailSetting.get(),
		});
		ensureToggleButton(host);
		trailClock = now;
	}
	ensureToggleButton(host);
	syncControllerPatch();
	// Re-read the accent only when the avatar actually changed (avoids a
	// getComputedStyle / parse on every frame).
	const entryId = inst._currentEntry?.id ?? null;
	if (entryId !== trailAccentId) {
		trailAccentId = entryId;
		trail2d.refreshColor();
	}
	const dt = Math.min(0.05, (now - trailClock) / 1000) || 0;
	trailClock = now;
	if (trailSetting.get() !== 'off') trail2d.update(dt);
	else trail2d.clear();
	trailRaf = requestAnimationFrame(trailTick);
}

// Expose a tiny programmatic surface so hosts / the console can drive the trail.
walk.trails = {
	get style() {
		return trailSetting.get();
	},
	setStyle(next) {
		const applied = trailSetting.set(next);
		trail2d?.setStyle(applied);
		if (trailToggleBtn) {
			trailToggleBtn.title = `Path trail: ${TRAIL_STYLE_LABELS[applied]}`;
			trailToggleBtn.style.background =
				applied === 'off' ? 'rgba(12,14,20,.55)' : 'rgba(122,162,255,.85)';
		}
		return applied;
	},
	cycle() {
		const next = trailSetting.cycle();
		trail2d?.setStyle(next);
		if (trailToggleBtn) {
			trailToggleBtn.title = `Path trail: ${TRAIL_STYLE_LABELS[next]}`;
			trailToggleBtn.style.background =
				next === 'off' ? 'rgba(12,14,20,.55)' : 'rgba(122,162,255,.85)';
		}
		return next;
	},
};

trailRaf = requestAnimationFrame(trailTick);

// ── Click-to-walk navigation (Task 35) ──────────────────────────────────────
// Clicking an empty patch of the page (or long-pressing on touch) sends the
// companion avatar gliding to that spot, routing around [data-walk-block]
// elements, facing its heading, and easing into arrival. We never edit the SDK:
// the walker translates the live instance's host element and drives its
// controller's walk/idle state + yaw. The on/off pref persists under the
// companion's own key namespace (`${prefix}:companion:clicktowalk`), and the
// settings pill is slotted into the same chrome as the trails/transitions
// toggles. We hand it the live instance getter so it survives avatar swaps and
// playground round-trips.
const C2W_KEY = `${(walk.config?.keys?.enabled || 'three:companion:enabled').split(':')[0]}:companion:clicktowalk`;
installClickToWalk({
	getInstance: () => walk.instance,
	getHostEl: companionHost,
	storageKey: C2W_KEY,
});

// ── Section narration (Task 34) ──────────────────────────────────────────────
// As the companion walks the page, it reads the section nearest it: a caption
// bubble (always-on, aria-live) and — strictly opt-in — spoken audio from the
// real /api/tts/speak endpoint. Authors mark what to read with
// [data-walk-narrate] (and optional [data-walk-script] copy); unmarked pages
// fall back to heading/paragraph detection. An IntersectionObserver picks the
// most-visible section, debounced so each narrates once. The off/caption/voice
// mode persists under the companion's own key namespace
// (`${prefix}:companion:narrate`); its settings pill slots into the same chrome
// as the trails/click-to-walk toggles. We pass the live instance getter so it
// survives avatar swaps and playground round-trips. Default is caption-only —
// audio never plays without an explicit opt-in and a real user gesture.
const NARRATE_KEY = `${(walk.config?.keys?.enabled || 'three:companion:enabled').split(':')[0]}:companion:narrate`;
installNarrator({
	getInstance: () => walk.instance,
	getHostEl: companionHost,
	storageKey: NARRATE_KEY,
});

// ── Identity ─────────────────────────────────────────────────────────────────
// The corner avatar is "your agent", not a mascot: guests get a named
// ephemeral agent (claimable into a real one), signed-in visitors see their
// canonical agent, and the avatar reacts when ⌘K commands finish. See
// src/walk-companion-identity.js.
installIdentity({ getInstance: () => walk.instance });

walk.bootstrap();
