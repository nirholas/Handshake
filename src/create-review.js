/**
 * /create-review — preview the in-progress avatar before it touches the server.
 *
 * Flow:
 *   1. Read the staged blob from IndexedDB via guest-avatar.js.
 *   2. Render it in the page's <model-viewer> from an object URL.
 *   3. "Save to my account":
 *        - If unauthed: redirect to /login?next=/create-review with a sentinel
 *          flag so we auto-resume the save when the user returns.
 *        - If authed: presign + upload + attach to default agent, then go to /app.
 *   4. "Start over": clear the staged record and bounce back to /create.
 *   5. On post-login resume, the sentinel triggers the save automatically.
 */

import { saveRemoteGlbToAccount } from './account.js';
import { attachAvatarToAgent } from './attach-avatar-to-agent.js';
import { load as loadGuest, clear as clearGuest } from './guest-avatar.js';
import { TalkScene } from './voice/talk-scene.js';
import { IdleAnimation } from './idle-animation.js';

const RESUME_KEY = '3dagent:guest-avatar-resume';
const $ = (sel) => document.querySelector(sel);

let staged = /** @type {Awaited<ReturnType<typeof loadGuest>>} */ (null);
let objectUrl = /** @type {string | null} */ (null);
let viewerScene = /** @type {TalkScene | null} */ (null);
let viewerIdle = /** @type {IdleAnimation | null} */ (null);
let viewerIdleDispose = /** @type {(() => void) | null} */ (null);

async function boot() {
	staged = await loadGuest();
	if (!staged) {
		$('#content').hidden = true;
		$('#empty-card').hidden = false;
		return;
	}

	$('#content').hidden = false;
	$('#empty-card').hidden = true;

	// Kick off the 3D mount but don't block UI wiring on it — the loading
	// overlay stays up until renderPreview() resolves and hides it.
	renderPreview(staged).catch((err) => {
		console.error('[create-review] renderPreview failed', err);
	});
	wireControls();

	// Auth state is resolved async via /api/auth/me from the page's inline
	// script. If it's already resolved (cache hit), apply now; otherwise wait
	// for the dispatched event.
	if (window.__authed === null) {
		document.addEventListener('three-ws:auth-resolved', applyAuthState, { once: true });
	} else {
		applyAuthState({ detail: { authed: window.__authed } });
	}
}

async function renderPreview(record) {
	$('#avatar-name').textContent = record.name;
	$('#f-name').value = record.name;
	$('#tag-source').textContent = record.meta?.source || record.meta?.provider || 'glb';
	$('#tag-size').textContent =
		record.size > 0 ? `${Math.round(record.size / 1024)} KB` : '— KB';

	objectUrl = URL.createObjectURL(record.blob);
	const container = $('#mv-container');

	viewerScene = new TalkScene();
	try {
		await viewerScene.mount({ container, glbUrl: objectUrl, cameraPreset: 'full' });
	} catch (err) {
		console.error('[create-review] failed to mount viewer', err);
		$('#viewer-loading').innerHTML =
			'<span style="color:#ffb3b3">Couldn\'t render this model.</span>';
		return;
	}

	$('#viewer-loading').hidden = true;

	// Procedural idle layer — breathing (spine), micro-saccades, blink, weight shift.
	// No AgentProtocol on this static preview; IdleAnimation's no-op stub covers it.
	viewerIdle = new IdleAnimation({
		getRoot: () => viewerScene?.root || null,
		seed: record.id || 'create-review',
	});
	viewerIdleDispose = viewerScene.addOnTick((dt) => viewerIdle.update(dt));
}

function wireControls() {
	const saveBtn = $('#save-btn');
	const startOverBtn = $('#start-over-btn');
	const nameInput = $('#f-name');

	nameInput.addEventListener('input', () => {
		const value = nameInput.value.trim();
		$('#avatar-name').textContent = value || 'Your avatar';
	});

	saveBtn.addEventListener('click', () => onSave());
	startOverBtn.addEventListener('click', () => onStartOver());
}

function applyAuthState({ detail }) {
	const saveBtn = $('#save-btn');
	const guestNote = $('#guest-note');
	saveBtn.disabled = false;
	if (detail.authed) {
		saveBtn.textContent = 'Save to my account';
		guestNote.hidden = true;
		// Returning from a /login round-trip with the resume flag set — finish
		// what the user started.
		if (sessionStorage.getItem(RESUME_KEY) === '1') {
			sessionStorage.removeItem(RESUME_KEY);
			onSave({ auto: true });
		}
	} else {
		saveBtn.textContent = 'Sign in to save';
		guestNote.hidden = false;
	}
}

async function onSave({ auto = false } = {}) {
	if (!staged) return;
	const saveBtn = $('#save-btn');
	const startOverBtn = $('#start-over-btn');

	if (window.__authed === false) {
		// Stash a sentinel so the post-login round-trip auto-resumes the save.
		sessionStorage.setItem(RESUME_KEY, '1');
		const next = encodeURIComponent('/create-review');
		window.location.href = `/login?next=${next}`;
		return;
	}

	saveBtn.disabled = true;
	startOverBtn.disabled = true;
	showSaveOverlay('Saving your avatar…', 'Uploading to your account.');

	try {
		const name = $('#f-name').value.trim() || staged.name;
		const meta = {
			...staged.meta,
			name,
		};
		const avatar = await saveRemoteGlbToAccount(staged.blob, meta);
		updateSaveOverlay('Preparing your agent…');
		const agent = await attachAvatarToAgent(avatar.id, name);
		updateSaveOverlay('Opening your avatar…');
		await clearGuest();
		releaseObjectUrl();
		window.location.href = '/app?agent=' + agent.id;
	} catch (err) {
		hideSaveOverlay();
		saveBtn.disabled = false;
		startOverBtn.disabled = false;
		console.error('[create-review] save failed', err);

		if (err.code === 'not_signed_in') {
			// Session expired between the cached auth hint and the actual save.
			sessionStorage.setItem(RESUME_KEY, '1');
			const next = encodeURIComponent('/create-review');
			window.location.href = `/login?next=${next}`;
			return;
		}

		if (err.data?.error === 'plan_limit_count') {
			showStatus(
				"You've reached your avatar limit. Delete an avatar first, then come back to save this one.",
				'error',
			);
			return;
		}

		showStatus(
			auto
				? "Save couldn't finish automatically — try the button again."
				: err.message || 'Save failed. Try again.',
			'error',
		);
	}
}

async function onStartOver() {
	const ok = window.confirm('Discard this avatar and start over?');
	if (!ok) return;
	await clearGuest();
	releaseObjectUrl();
	window.location.href = '/create';
}

function releaseObjectUrl() {
	if (viewerIdleDispose) {
		viewerIdleDispose();
		viewerIdleDispose = null;
	}
	viewerIdle?.dispose();
	viewerIdle = null;
	viewerScene?.unmount?.();
	viewerScene = null;
	if (objectUrl) {
		URL.revokeObjectURL(objectUrl);
		objectUrl = null;
	}
}

function showSaveOverlay(label, sublabel) {
	let el = document.getElementById('save-loading');
	if (!el) {
		el = document.createElement('div');
		el.id = 'save-loading';
		el.setAttribute('role', 'status');
		el.setAttribute('aria-live', 'polite');
		el.setAttribute('aria-busy', 'true');
		el.innerHTML = `
			<img src="/three.svg" alt="" />
			<div class="label"></div>
			<div class="sublabel"></div>
		`;
		document.body.appendChild(el);
		document.documentElement.style.overflow = 'hidden';
		document.body.style.overflow = 'hidden';
	}
	el.querySelector('.label').textContent = label;
	el.querySelector('.sublabel').textContent = sublabel || '';
}

function updateSaveOverlay(label, sublabel) {
	const el = document.getElementById('save-loading');
	if (!el) return;
	el.querySelector('.label').textContent = label;
	if (sublabel !== undefined) el.querySelector('.sublabel').textContent = sublabel;
}

function hideSaveOverlay() {
	const el = document.getElementById('save-loading');
	if (!el) return;
	el.remove();
	document.documentElement.style.overflow = '';
	document.body.style.overflow = '';
}

function showStatus(msg, type = 'info') {
	const el = document.getElementById('status-toast');
	el.textContent = msg;
	el.className = 'status-toast ' + type;
	el.hidden = false;
	setTimeout(() => {
		el.hidden = true;
	}, 5000);
}

window.addEventListener('beforeunload', releaseObjectUrl);

boot().catch((err) => {
	console.error('[create-review] boot failed', err);
	$('#content').hidden = true;
	$('#empty-card').hidden = false;
});
