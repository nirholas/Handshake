// src/irl/onboarding.js — IRL permission + first-run onboarding (E1)
//
// IRL is a phone-camera product riding on three sensors: the camera
// (getUserMedia), motion/orientation (DeviceOrientationEvent — the gyro
// world-lock), and location (geolocation — real-world pins + nearby discovery).
// Every one of them can be prompted, granted, denied, or simply absent, and a
// denied prompt used to strand the user behind a 3-second toast. This module is
// the single source of truth for asking: a designed card per state (prompt /
// granted / denied-with-recovery / unsupported), an iOS-correct motion gesture,
// a first-run sequence, persisted outcomes so we never re-nag, and a topbar
// re-request chip so recovery is always one tap away.
//
// irl.js never re-implements permission logic — enableAR(), setLocked(), and the
// boot path call ensurePermission()/startOnboarding() and react to the result.

import { emptyStateHTML, errorStateHTML, ensureStateKitStyles } from '../shared/state-kit.js';

// ── Permission catalogue ────────────────────────────────────────────────────
export const PERMS = {
	camera:   { label: 'Camera',   why: 'See your agents anchored in the real world through your camera.' },
	motion:   { label: 'Motion',   why: 'Turn your phone to look around — agents stay pinned to real space.' },
	location: { label: 'Location', why: 'Place agents at real spots and discover the ones others left nearby.' },
};

// Feature detection — drives the "unsupported" state per sensor.
export const support = {
	camera:   () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
	motion:   () => typeof DeviceOrientationEvent !== 'undefined',
	location: () => 'geolocation' in navigator,
};

// iOS 13+ gates motion behind an explicit gesture-bound requestPermission().
export const needsMotionGesture = () =>
	typeof DeviceOrientationEvent !== 'undefined' &&
	typeof DeviceOrientationEvent.requestPermission === 'function';

const KINDS = ['camera', 'motion', 'location'];
const SAVE_KEY = 'irl_onboarded_v1';
const VALID = new Set(['granted', 'denied', 'unsupported', 'skip']);

// ── Platform hints (recovery copy) ──────────────────────────────────────────
const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
const isIOS = () =>
	/iP(hone|ad|od)/.test(ua) ||
	(/Macintosh/.test(ua) && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1); // iPadOS desktop UA
const isAndroid = () => /Android/.test(ua);
const isTouch = () =>
	typeof window !== 'undefined' &&
	(('ontouchstart' in window) || (navigator.maxTouchPoints || 0) > 0);
// Motion is only worth prompting on devices that actually move; desktops use
// drag-to-orbit, so we skip the motion card + chip there entirely.
const motionRelevant = () => needsMotionGesture() || isTouch();
const reducedMotion = () =>
	typeof window !== 'undefined' &&
	window.matchMedia &&
	window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ── Sensor SVGs (stroke = currentColor; tuned for the state-kit icon slot) ───
const ICONS = {
	camera: '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M23 7 16 12l7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2.5"/></svg>',
	motion: '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><polygon points="16 8 13.5 13.5 8 16 10.5 10.5 16 8"/></svg>',
	location: '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/></svg>',
};

function recoverySteps(kind) {
	if (kind === 'camera') {
		if (isIOS()) return 'Open <b>Settings › Safari › Camera</b> and choose <b>Allow</b>, then tap Try again.';
		if (isAndroid()) return 'Tap the lock icon in the address bar › <b>Permissions › Camera › Allow</b>, then tap Try again.';
		return 'Click the camera icon in your browser’s address bar and choose <b>Allow</b>, then tap Try again.';
	}
	if (kind === 'motion') {
		if (isIOS()) return 'Open <b>Settings › Safari › Motion &amp; Orientation Access</b> and turn it on, then tap Try again.';
		return 'Reload the page and allow motion access when your browser asks, then tap Try again.';
	}
	if (kind === 'location') {
		if (isIOS()) return 'Open <b>Settings › Privacy &amp; Security › Location Services › Safari Websites</b> and pick <b>While Using</b>, then tap Try again.';
		if (isAndroid()) return 'Tap the lock icon in the address bar › <b>Permissions › Location › Allow</b>, then tap Try again.';
		return 'Click the location icon in your browser’s address bar and choose <b>Allow</b>, then tap Try again.';
	}
	return 'Update your browser permissions, then tap Try again.';
}

function unsupportedBody(kind) {
	if (kind === 'camera') return 'This device can’t open a camera here, so the live camera view isn’t available — you can still explore your agent in orbit view.';
	if (kind === 'motion') return 'This device doesn’t report motion, so look-around is off. Drag to orbit the scene instead.';
	if (kind === 'location') return 'This device can’t share location, so pinning to real spots and nearby discovery are off — everything else still works.';
	return 'This feature isn’t available on this device.';
}

// ── Sensor requests (the only place each browser API is asked for permission) ─
async function requestCamera() {
	if (!support.camera()) return 'unsupported';
	try {
		const stream = await navigator.mediaDevices.getUserMedia({
			video: { facingMode: { ideal: 'environment' } },
			audio: false,
		});
		// Permission-prime only — enableAR() acquires the real stream it renders.
		stream.getTracks().forEach((t) => { try { t.stop(); } catch {} });
		return 'granted';
	} catch (err) {
		const name = err && err.name;
		if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied';
		if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'unsupported';
		return 'error';
	}
}

function probeOrientation() {
	// Android / non-gated: no permission API, so confirm the sensor actually
	// fires. A real reading resolves 'granted'; silence for 1.5s → 'denied'.
	return new Promise((resolve) => {
		let settled = false;
		const onEvt = (e) => {
			if (settled || !e) return;
			if (e.alpha != null || e.beta != null || e.gamma != null) {
				settled = true; cleanup(); resolve('granted');
			}
		};
		const to = setTimeout(() => { if (!settled) { settled = true; cleanup(); resolve('denied'); } }, 1500);
		function cleanup() {
			clearTimeout(to);
			window.removeEventListener('deviceorientation', onEvt, true);
			window.removeEventListener('deviceorientationabsolute', onEvt, true);
		}
		window.addEventListener('deviceorientation', onEvt, true);
		window.addEventListener('deviceorientationabsolute', onEvt, true);
	});
}

async function requestMotion() {
	if (!support.motion()) return 'unsupported';
	if (needsMotionGesture()) {
		try {
			const res = await DeviceOrientationEvent.requestPermission(); // MUST run inside a user gesture
			return res === 'granted' ? 'granted' : 'denied';
		} catch {
			return 'denied'; // throws if not called from a gesture, or the user declined
		}
	}
	return probeOrientation();
}

function requestLocation() {
	if (!support.location()) return Promise.resolve('unsupported');
	return new Promise((resolve) => {
		let done = false;
		navigator.geolocation.getCurrentPosition(
			() => { if (!done) { done = true; resolve('granted'); } },
			(err) => {
				if (done) return;
				done = true;
				resolve(err && err.code === 1 /* PERMISSION_DENIED */ ? 'denied' : 'error');
			},
			{ enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
		);
	});
}

const REQUESTERS = { camera: requestCamera, motion: requestMotion, location: requestLocation };

// Live permission read without a prompt (Chromium/Android). Lets "Try again"
// after a Settings fix succeed silently, and skips a redundant card when the OS
// already granted access. Returns null where the Permissions API is absent
// (Safari) or doesn't know the name (camera on some engines).
async function queryPermission(kind) {
	const name = kind === 'camera' ? 'camera' : kind === 'location' ? 'geolocation' : null;
	if (!name || !navigator.permissions || !navigator.permissions.query) return null;
	try {
		const status = await navigator.permissions.query({ name });
		return status.state; // 'granted' | 'denied' | 'prompt'
	} catch {
		return null;
	}
}

// ── State + persistence ─────────────────────────────────────────────────────
const state = { camera: null, motion: null, location: null };
let onGrant = null;
let started = false;

function persist() {
	try {
		localStorage.setItem(SAVE_KEY, JSON.stringify({
			camera: state.camera, motion: state.motion, location: state.location, ts: Date.now(),
		}));
	} catch {}
}
function readSaved() {
	try { const raw = localStorage.getItem(SAVE_KEY); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
function fireGrant(kind) {
	if (typeof onGrant === 'function') { try { onGrant(kind); } catch {} }
}
function applyResult(kind, result) {
	if (!KINDS.includes(kind) || !VALID.has(result)) return;
	const prev = state[kind];
	state[kind] = result;
	persist();
	renderChips();
	if (result === 'granted' && prev !== 'granted') fireGrant(kind);
}

/** Push a runtime outcome irl.js learns on its own (e.g. a revoked GPS watch). */
export function setPermissionState(kind, result) {
	applyResult(kind, result);
}

// ── CSS (injected once, co-located with the module like state-kit) ───────────
const STYLE_ID = 'irl-onboard-styles';
function ensureStyles() {
	ensureStateKitStyles();
	if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
	const style = document.createElement('style');
	style.id = STYLE_ID;
	style.textContent = ONBOARD_CSS;
	(document.head || document.documentElement).appendChild(style);
}

// ── Overlay shell ────────────────────────────────────────────────────────────
let overlayEl = null;
let cardSlot = null;
let cardActionHandler = null;
let currentDone = null;
let bailed = false;

function getOverlay() {
	if (!overlayEl) overlayEl = document.getElementById('irl-onboard');
	return overlayEl;
}

function buildShell(opts) {
	const el = getOverlay();
	if (!el) return null;
	const multi = !opts.single;
	el.innerHTML = `
		<div class="irl-ob-scrim"></div>
		<div class="irl-ob-panel" role="document">
			<div class="irl-ob-head">
				<span class="irl-ob-badge"><svg class="irl-ob-badge-mark" viewBox="0 0 26 28" fill="none" aria-hidden="true"><path class="irl-mark-cube" d="M13 2.5 4 7v9l9 4.5 9-4.5V7Z"/><path class="irl-mark-cube" d="M13 2.5v9M4 7l9 4.5M22 7l-9 4.5"/><path class="irl-mark-beam" d="M13 20.5v1.9"/><ellipse class="irl-mark-anchor" cx="13" cy="24.3" rx="7.4" ry="1.9"/><circle class="irl-mark-dot" cx="13" cy="24.3" r="1" stroke="none"/></svg> IRL</span>
				<h2 class="irl-ob-title">${multi ? 'Bring your agents into the real world' : 'Permission needed'}</h2>
				<p class="irl-ob-sub">${multi ? 'Three quick permissions power the camera, look-around, and real-world pins. You stay in control.' : 'Grant access to continue — you can change this anytime.'}</p>
				<a class="irl-ob-learn" href="/irl-privacy" target="_blank" rel="noopener">How location works <span aria-hidden="true">↗</span></a>
			</div>
			<div class="irl-ob-card" aria-live="polite"></div>
			<div class="irl-ob-progress"${multi ? '' : ' hidden'} aria-hidden="true"></div>
		</div>`;
	cardSlot = el.querySelector('.irl-ob-card');
	cardSlot.addEventListener('click', onCardClick);
	el.querySelector('.irl-ob-scrim').addEventListener('click', () => { if (currentDone) { bailed = true; currentDone(); } });
	return el;
}

function onCardClick(e) {
	const btn = e.target.closest('[data-sk-action]');
	if (!btn) return;
	if (cardActionHandler) cardActionHandler(btn.dataset.skAction);
}

function onKeydown(e) {
	if (e.key === 'Escape' && currentDone) { bailed = true; currentDone(); }
}

function openOverlay() {
	const el = getOverlay();
	if (!el) return;
	bailed = false;
	el.hidden = false;
	document.addEventListener('keydown', onKeydown, true);
	const reveal = () => el.classList.add('is-open');
	if (reducedMotion()) reveal(); else requestAnimationFrame(reveal);
}

function closeOverlay() {
	const el = getOverlay();
	if (!el) return;
	document.removeEventListener('keydown', onKeydown, true);
	el.classList.remove('is-open');
	currentDone = null;
	cardActionHandler = null;
	const after = () => { el.hidden = true; el.innerHTML = ''; cardSlot = null; };
	if (reducedMotion()) after(); else setTimeout(after, 260);
}

function updateProgress(opts) {
	const el = getOverlay();
	const bar = el && el.querySelector('.irl-ob-progress');
	if (!bar || opts.single || !Number.isFinite(opts.total)) return;
	bar.innerHTML = Array.from({ length: opts.total }, (_, i) =>
		`<span class="irl-ob-dot${i === opts.index ? ' is-active' : ''}${i < opts.index ? ' is-done' : ''}"></span>`,
	).join('');
}

function focusPrimary() {
	const btn = cardSlot && (cardSlot.querySelector('.tws-es-btn--primary') || cardSlot.querySelector('.tws-es-btn'));
	if (btn) { try { btn.focus(); } catch {} }
}

// ── Per-card flow ─────────────────────────────────────────────────────────────
function runCard(kind, opts = {}) {
	return new Promise((resolve) => {
		const finish = () => { if (currentDone === doneRef) currentDone = null; resolve(state[kind] || 'skip'); };
		const doneRef = finish;
		currentDone = doneRef;
		present(kind, opts, finish);
	});
}

function present(kind, opts, done) {
	const meta = PERMS[kind];
	let busy = false;

	const stage = (html) => { if (cardSlot) cardSlot.innerHTML = html; };

	const stagePrompt = () => {
		updateProgress(opts);
		stage(emptyStateHTML({
			icon: ICONS[kind],
			title: `Enable ${meta.label}`,
			body: meta.why,
			actions: [
				{ label: `Enable ${meta.label}`, id: 'enable', primary: true },
				...(opts.allowSkip ? [{ label: opts.single ? 'Not now' : 'Skip for now', id: 'skip' }] : []),
			],
		}));
		focusPrimary();
	};

	const stageRequesting = () => {
		stage(`<div class="tws-es" role="status" aria-live="polite">
			<div class="irl-ob-spinner" aria-hidden="true"></div>
			<h3 class="tws-es-title">Requesting ${meta.label}…</h3>
			<p class="tws-es-body">Confirm the permission prompt to continue.</p>
		</div>`);
	};

	const stageGranted = () => {
		stage(`<div class="tws-es irl-ob-granted" role="status">
			<div class="irl-ob-check" aria-hidden="true"><svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div>
			<h3 class="tws-es-title">${meta.label} enabled</h3>
			<p class="tws-es-body">You’re all set.</p>
		</div>`);
		setTimeout(done, reducedMotion() ? 120 : 720);
	};

	const stageDenied = () => {
		stage(errorStateHTML({
			title: `${meta.label} is blocked`,
			body: recoverySteps(kind),
			actions: [
				{ label: 'Try again', id: 'retry', primary: true },
				{ label: kind === 'motion' ? 'Use orbit instead' : 'Continue without', id: 'continue' },
			],
		}));
		focusPrimary();
	};

	const stageError = () => {
		stage(errorStateHTML({
			title: `Couldn’t reach ${meta.label.toLowerCase()}`,
			body: kind === 'location'
				? 'We couldn’t get a location fix. Move somewhere with a clearer view of the sky, then try again.'
				: 'Something interrupted the request. Try again in a moment.',
			actions: [
				{ label: 'Try again', id: 'retry', primary: true },
				{ label: 'Continue without', id: 'continue' },
			],
		}));
		focusPrimary();
	};

	const stageUnsupported = () => {
		updateProgress(opts);
		stage(emptyStateHTML({
			icon: ICONS[kind],
			title: `${meta.label} isn’t available`,
			body: unsupportedBody(kind),
			compact: true,
			actions: [{ label: 'Got it', id: 'continue', primary: true }],
		}));
		focusPrimary();
	};

	cardActionHandler = async (action) => {
		if (busy) return;
		if (action === 'skip') { applyResult(kind, 'skip'); done(); return; }
		if (action === 'continue') { done(); return; }
		if (action === 'enable' || action === 'retry') {
			busy = true;
			stageRequesting();
			let result = 'error';
			try { result = await REQUESTERS[kind](); } catch { result = 'error'; }
			busy = false;
			if (bailed) return; // overlay dismissed mid-request
			if (VALID.has(result)) applyResult(kind, result);
			if (result === 'granted') stageGranted();
			else if (result === 'unsupported') stageUnsupported();
			else if (result === 'denied') stageDenied();
			else stageError();
		}
	};

	if (!support[kind]()) { applyResult(kind, 'unsupported'); stageUnsupported(); }
	else stagePrompt();
}

// ── First-run sequence ────────────────────────────────────────────────────────
async function runFirstRun() {
	ensureStyles();
	if (!buildShell({ single: false })) return; // no overlay element in DOM
	openOverlay();
	try {
		const kinds = ['camera', 'location'];
		if (motionRelevant()) kinds.push('motion');
		else applyResult('motion', 'unsupported');
		for (let i = 0; i < kinds.length; i++) {
			if (bailed) break;
			await runCard(kinds[i], { index: i, total: kinds.length, allowSkip: true });
		}
	} finally {
		persist();
		closeOverlay();
	}
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * On-demand permission gate used by enableAR()/setLocked(): resolves the cached
 * or live-granted state immediately, otherwise opens the designed card and
 * resolves once the user acts. Always resolves to a state string.
 */
export async function ensurePermission(kind) {
	if (!KINDS.includes(kind)) return 'unsupported';
	if (!support[kind]()) { applyResult(kind, 'unsupported'); return 'unsupported'; }
	if (state[kind] === 'granted') return 'granted';
	const live = await queryPermission(kind);
	if (live === 'granted') { applyResult(kind, 'granted'); return 'granted'; }
	ensureStyles();
	if (!buildShell({ single: true })) {
		// No overlay in the DOM — fall back to a bare request so we never dead-end.
		let result = 'error';
		try { result = await REQUESTERS[kind](); } catch {}
		if (VALID.has(result)) applyResult(kind, result);
		return result;
	}
	openOverlay();
	let result;
	try { result = await runCard(kind, { single: true, allowSkip: true }); }
	finally { closeOverlay(); }
	return result || state[kind] || 'denied';
}

/**
 * Boot entry. First visit → runs the onboarding overlay; repeat visit → hydrates
 * saved outcomes, renders re-request chips for denied sensors, and replays grants
 * (so a previously-granted location restarts GPS). Idempotent.
 *
 * @param {{ onGrant?: (kind: string) => void }} [opts]
 */
export async function startOnboarding(opts = {}) {
	if (started) return state;
	started = true;
	onGrant = typeof opts.onGrant === 'function' ? opts.onGrant : null;
	ensureStyles();
	wireChips();

	const saved = readSaved();
	if (saved) {
		for (const k of KINDS) if (VALID.has(saved[k])) state[k] = saved[k];
		renderChips();
		for (const k of KINDS) if (state[k] === 'granted') fireGrant(k);
		return state;
	}

	try { await runFirstRun(); } catch { closeOverlay(); }
	return state;
}

// ── Re-request chips (topbar) ─────────────────────────────────────────────────
let chipsEl = null;
function wireChips() {
	chipsEl = document.getElementById('irl-perm-chips');
	if (!chipsEl || chipsEl._wired) return;
	chipsEl._wired = true;
	chipsEl.addEventListener('click', async (e) => {
		const chip = e.target.closest('[data-perm]');
		if (!chip) return;
		await ensurePermission(chip.dataset.perm);
	});
}
function renderChips() {
	if (!chipsEl) chipsEl = document.getElementById('irl-perm-chips');
	if (!chipsEl) return;
	const denied = KINDS.filter((k) => state[k] === 'denied');
	if (!denied.length) { chipsEl.hidden = true; chipsEl.innerHTML = ''; return; }
	chipsEl.innerHTML = denied.map((k) =>
		`<button type="button" class="irl-perm-chip" data-perm="${k}" aria-label="Enable ${PERMS[k].label}">
			<span class="irl-perm-chip-icon" aria-hidden="true">${ICONS[k]}</span>
			Enable ${PERMS[k].label}
		</button>`,
	).join('');
	chipsEl.hidden = false;
}

// ── CSS ────────────────────────────────────────────────────────────────────────
const ONBOARD_CSS = `
#irl-onboard {
	position: fixed; inset: 0; z-index: 120;
	display: flex; align-items: center; justify-content: center;
	padding: 24px;
	opacity: 0; pointer-events: none;
	transition: opacity .26s ease;
}
#irl-onboard[hidden] { display: none; } /* honour the attr — the id rule above would otherwise force display:flex */
#irl-onboard.is-open { opacity: 1; pointer-events: auto; }
#irl-onboard .irl-ob-scrim {
	position: absolute; inset: 0;
	background: radial-gradient(120% 90% at 50% 0%, rgba(20,26,40,0.72), rgba(6,8,13,0.92));
	backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
}
#irl-onboard .irl-ob-panel {
	position: relative;
	width: min(440px, 100%);
	max-height: calc(100dvh - 48px);
	overflow-y: auto;
	background: linear-gradient(180deg, rgba(15,18,27,0.98), rgba(9,11,17,0.99));
	border: 1px solid rgba(255,255,255,0.10);
	border-radius: 22px;
	box-shadow: 0 24px 70px rgba(0,0,0,0.6);
	padding: 22px 22px 18px;
	transform: translateY(10px) scale(.99);
	transition: transform .28s cubic-bezier(.22,.61,.36,1);
}
#irl-onboard.is-open .irl-ob-panel { transform: none; }
.irl-ob-head { text-align: center; padding: 0 4px 4px; }
.irl-ob-badge {
	display: inline-flex; align-items: center; gap: 6px;
	font: 600 11px/1 var(--font-body, system-ui, sans-serif);
	letter-spacing: .09em; text-transform: uppercase;
	color: #7dd3fc;
	background: rgba(125,211,252,0.10);
	border: 1px solid rgba(125,211,252,0.28);
	border-radius: 999px; padding: 5px 10px; margin-bottom: 12px;
}
.irl-ob-badge-mark {
	width: 15px; height: 16px; flex-shrink: 0; overflow: visible;
	stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round;
}
.irl-ob-badge-mark .irl-mark-cube { opacity: .95; }
.irl-ob-badge-mark .irl-mark-beam { opacity: .45; }
.irl-ob-badge-mark .irl-mark-anchor { opacity: .6; }
.irl-ob-badge-mark .irl-mark-dot { fill: currentColor; opacity: .8; }
.irl-ob-title { margin: 0 0 6px; font-size: 18px; font-weight: 700; letter-spacing: -.015em; color: #f1f4fa; line-height: 1.25; }
.irl-ob-sub { margin: 0; font-size: 13px; line-height: 1.5; color: #93a1b5; }
.irl-ob-learn {
	display: inline-flex; align-items: center; gap: 5px;
	min-height: 32px; margin: 5px -6px 0; padding: 0 6px;
	font: 500 12px/1 var(--font-body, system-ui, sans-serif);
	color: #7dd3fc; text-decoration: none;
	transition: color .15s;
}
.irl-ob-learn:hover { color: #a6dcee; }
.irl-ob-learn:focus-visible { outline: 2px solid #7dd3fc; outline-offset: 3px; border-radius: 6px; }
.irl-ob-card .tws-es { padding: 22px 8px 6px; }
.irl-ob-card .tws-es-icon { color: #cdd6e4; opacity: .92; }
.irl-ob-card .tws-es-icon--err { color: #f87171; }
.irl-ob-card .tws-es-actions { width: 100%; flex-direction: column; gap: 8px; margin-top: 14px; }
.irl-ob-card .tws-es-btn { width: 100%; padding: 12px 16px; font-size: 14px; }
.irl-ob-card .tws-es-body b { color: #cdd6e4; font-weight: 600; }
.irl-ob-progress { display: flex; gap: 7px; justify-content: center; padding: 14px 0 4px; }
.irl-ob-progress[hidden] { display: none; }
.irl-ob-dot { width: 7px; height: 7px; border-radius: 50%; background: rgba(255,255,255,0.16); transition: background .2s, transform .2s; }
.irl-ob-dot.is-active { background: #7dd3fc; transform: scale(1.25); }
.irl-ob-dot.is-done { background: rgba(125,211,252,0.5); }
.irl-ob-granted .irl-ob-check {
	width: 52px; height: 52px; border-radius: 50%;
	display: flex; align-items: center; justify-content: center;
	color: #34d399; background: rgba(52,211,153,0.14); border: 1px solid rgba(52,211,153,0.4);
	margin-bottom: 6px;
}
.irl-ob-spinner {
	width: 30px; height: 30px; border-radius: 50%;
	border: 2.5px solid rgba(255,255,255,0.14); border-top-color: #7dd3fc;
	animation: irl-ob-spin .8s linear infinite; margin-bottom: 8px;
}
@keyframes irl-ob-spin { to { transform: rotate(360deg); } }

/* ── Topbar re-request chips ── */
.irl-perm-chips {
	position: fixed; left: 0; right: 0;
	top: calc(env(safe-area-inset-top, 0px) + 52px);
	z-index: 11;
	display: flex; gap: 8px; justify-content: center; flex-wrap: wrap;
	padding: 0 12px; pointer-events: none;
}
.irl-perm-chips[hidden] { display: none; }
.irl-perm-chip {
	pointer-events: auto;
	display: inline-flex; align-items: center; gap: 6px;
	padding: 7px 13px 7px 10px;
	font: 600 12.5px/1 var(--font-body, system-ui, sans-serif);
	color: #fde68a;
	background: rgba(251,191,36,0.14);
	border: 1px solid rgba(251,191,36,0.42);
	border-radius: 999px;
	cursor: pointer;
	box-shadow: 0 4px 16px rgba(0,0,0,0.35);
	transition: background .15s, border-color .15s, transform .12s;
}
.irl-perm-chip:hover { background: rgba(251,191,36,0.22); border-color: rgba(251,191,36,0.6); }
.irl-perm-chip:active { transform: translateY(1px); }
.irl-perm-chip:focus-visible { outline: 2px solid rgba(251,191,36,0.7); outline-offset: 2px; }
.irl-perm-chip-icon { display: inline-flex; }
.irl-perm-chip-icon svg { width: 14px; height: 14px; }

@media (prefers-reduced-motion: reduce) {
	#irl-onboard, #irl-onboard .irl-ob-panel { transition: none; }
	.irl-ob-spinner { animation: none; border-top-color: rgba(255,255,255,0.4); }
	.irl-ob-dot { transition: none; }
}
`;

if (typeof window !== 'undefined') {
	window.irlOnboarding = { PERMS, support, needsMotionGesture, ensurePermission, startOnboarding, setPermissionState };
}
