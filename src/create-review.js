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
import {
	openDownloadModal,
	openEmbedModal,
	openIdentityModal,
	openPaidSkillsModal,
	openReputationModal,
	openVoicePreview,
	toggleEmoteStrip,
} from './create-review-features.js';

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
	// guest-avatar.stage() falls back to "Avatar #abc123" when no name was
	// supplied (Avaturn / generator flow). That string isn't something the user
	// chose, so don't pre-fill the input with it — leave the placeholder hint
	// visible and show a friendly heading until they type.
	const isAutoName = /^Avatar #[a-f0-9]{4,}$/i.test(record.name || '');
	const userFacingName = isAutoName ? '' : record.name;
	$('#avatar-name').textContent = userFacingName || 'Your new avatar';
	$('#f-name').value = userFacingName;
	$('#tag-source').textContent =
		prettySource(record.meta?.source || record.meta?.provider);
	$('#tag-size').textContent =
		record.size > 0 ? `${Math.round(record.size / 1024)} KB` : '— KB';

	// Keep an object URL around for downstream consumers (Voice preview hands
	// it to talk-mode, which loads via URL). The viewer itself now mounts
	// directly from the Blob — `loader.parse(buffer)` instead of fetching the
	// object URL — which sidesteps the "Failed to fetch" race when the page
	// reloads or unloads mid-mount.
	objectUrl = URL.createObjectURL(record.blob);
	const container = $('#mv-container');

	viewerScene = new TalkScene();
	try {
		await viewerScene.mount({ container, glbBlob: record.blob, cameraPreset: 'full' });
	} catch (err) {
		console.error('[create-review] failed to mount viewer', err);
		$('#viewer-loading').innerHTML =
			'<span style="color:#ffb3b3">Couldn\'t render this model.</span>';
		return;
	}

	const loadingEl = $('#viewer-loading');
	loadingEl.classList.add('is-hidden');

	// Procedural idle layer — breathing (spine), micro-saccades, blink, weight shift.
	// No AgentProtocol on this static preview; IdleAnimation's no-op stub covers it.
	viewerIdle = new IdleAnimation({
		getRoot: () => viewerScene?.root || null,
		seed: record.id || 'create-review',
	});
	viewerIdleDispose = viewerScene.addOnTick((dt) => viewerIdle.update(dt));

	// Pull the avatar out of T-pose. The GLB usually ships no clips, so we play
	// a baked external emote — TalkEmotes loads its manifest async, so wait for
	// it before requesting. Prefer the calmer breathing loop; fall back to the
	// plain idle clip if breathing isn't in the manifest.
	playBaseIdle().catch((err) =>
		console.warn('[create-review] base idle failed', err),
	);
}

function prettySource(raw) {
	if (!raw) return 'GLB';
	const key = String(raw).toLowerCase();
	const map = {
		avaturn: 'Avaturn',
		upload: 'Uploaded',
		import: 'Imported',
		'three-ws-studio': 'Studio',
		'three-ws-selfie': 'Selfie',
		glb: 'GLB',
	};
	return map[key] || raw;
}

async function playBaseIdle() {
	const emotes = viewerScene?.getEmoteController();
	if (!emotes) return;
	try {
		await emotes.loadManifest();
	} catch {
		return;
	}
	if (!viewerScene) return; // unmounted during await
	const started = await viewerScene.playEmote('av-idle-breath');
	if (!started && viewerScene) await viewerScene.playEmote('idle');
}

function wireControls() {
	const saveBtn = $('#save-btn');
	const startOverBtn = $('#start-over-btn');
	const nameInput = $('#f-name');

	nameInput.addEventListener('input', () => {
		const value = nameInput.value.trim();
		$('#avatar-name').textContent = value || 'Your new avatar';
	});

	saveBtn.addEventListener('click', () => onSave());
	startOverBtn.addEventListener('click', () => onStartOver());

	wireFeatureTiles();
}

function wireFeatureTiles() {
	document.querySelectorAll('.feature-tile[data-feature]').forEach((btn) => {
		btn.addEventListener('click', () => handleFeatureClick(btn.dataset.feature));
	});
}

function handleFeatureClick(feature) {
	switch (feature) {
		case 'body':
			toggleEmoteStrip({ scene: viewerScene, stripEl: $('#emote-strip') });
			return;
		case 'voice':
			if (!objectUrl) return;
			openVoicePreview({ glbUrl: objectUrl, name: $('#f-name').value });
			return;
		case 'identity':
			openIdentityModal();
			return;
		case 'paid':
			openPaidSkillsModal();
			return;
		case 'embed':
			openEmbedModal();
			return;
		case 'reputation':
			openReputationModal();
			return;
		case 'download':
			if (!staged?.blob) return;
			openDownloadModal({
				blob: staged.blob,
				name: $('#f-name').value.trim() || staged.name,
			});
			return;
	}
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
	showSaveOverlay('Preparing upload…', 'Optimizing your avatar.');

	// Arm the resume sentinel before we touch the network. If the session
	// expired between the cached auth hint and now, apiFetch redirects to
	// /login synchronously — we need the sentinel already set so the post-
	// login round-trip auto-resumes the save.
	sessionStorage.setItem(RESUME_KEY, '1');

	try {
		const name = $('#f-name').value.trim() || staged.name;
		const meta = {
			...staged.meta,
			name,
		};
		const avatar = await saveRemoteGlbToAccount(staged.blob, meta, {
			onProgress: (pct) => {
				updateSaveOverlay(
					pct >= 100 ? 'Finishing upload…' : 'Uploading your avatar…',
					pct >= 100 ? 'almost there' : `${pct}%`,
				);
				setSaveProgress(pct);
			},
		});
		setSaveProgress(null);
		updateSaveOverlay('Preparing your agent…', '');
		const agent = await attachAvatarToAgent(avatar.id, name);
		updateSaveOverlay('Opening your avatar…', '');
		await clearGuest();
		releaseObjectUrl();
		window.location.href = '/app?agent=' + agent.id;
	} catch (err) {
		console.error('[create-review] save failed', err);

		if (err.code === 'not_signed_in' || err.redirected) {
			// Session expired between the cached auth hint and the actual save.
			// The resume sentinel is already armed — kick over to /login and the
			// post-login round-trip will fire onSave() again automatically.
			const next = encodeURIComponent('/create-review');
			window.location.href = `/login?next=${next}`;
			return;
		}

		// Disarm the sentinel — without this, a plain reload would auto-fire
		// onSave again on the next visit and surprise the user.
		sessionStorage.removeItem(RESUME_KEY);

		if (err.data?.error === 'plan_limit_count') {
			hideSaveOverlay();
			saveBtn.disabled = false;
			startOverBtn.disabled = false;
			showStatus(
				"You've reached your avatar limit. Delete an avatar first, then come back to save this one.",
				'error',
			);
			return;
		}

		// Flip the overlay into an inline retry surface. The blob is still in
		// memory, so retry re-runs the whole pipeline (re-presign → fresh PUT
		// → fresh commit) without losing any user state.
		showSaveError({
			title: saveErrorTitle(err),
			detail: humanizeSaveError(err, auto),
			onRetry: () => onSave({ auto: false }),
			onCancel: () => {
				hideSaveOverlay();
				saveBtn.disabled = false;
				startOverBtn.disabled = false;
			},
		});
	}
}

function saveErrorTitle(err) {
	switch (err.code) {
		case 'upload_blocked':
			return 'Upload blocked';
		case 'upload_failed':
			return 'Upload rejected';
		case 'upload_aborted':
			return 'Upload cancelled';
		default:
			if (err.stage === 'presign') return "Couldn't reserve upload";
			if (err.stage === 'commit') return "Couldn't save record";
			if (err.stage === 'fetch') return "Couldn't read source";
			return "Save didn't finish";
	}
}

function humanizeSaveError(err, auto) {
	const status = err?.status;
	const stage = err?.stage;
	const code = err?.code;

	if (code === 'upload_blocked') {
		return "Couldn't reach storage. Check your network and try again.";
	}
	if (code === 'upload_failed') {
		return 'Storage rejected the upload. Try again — if it keeps happening, the file may be too large.';
	}
	if (code === 'upload_aborted') {
		return 'Upload was cancelled. Try again when you have a stable connection.';
	}

	if (status === 502 || status === 503 || status === 504) {
		return "We couldn't reach the server. Try again in a moment.";
	}
	if (status === 413) {
		return 'That avatar file is too large to save. Try a smaller GLB.';
	}
	if (status === 429) {
		return 'Too many requests right now — wait a few seconds and try again.';
	}

	if (stage === 'fetch') {
		return "Couldn't fetch the source model. Check the URL or try again.";
	}
	if (stage === 'commit') {
		return 'Uploaded, but the record didn\'t save. Try again — it won\'t re-upload.';
	}

	const msg = err?.message || '';
	if (err?.name === 'TypeError' || /Failed to fetch|NetworkError/i.test(msg)) {
		return 'Network looks offline. Check your connection and try again.';
	}
	if (auto) return "Save couldn't finish automatically — try the button again.";
	return 'Save failed. Try again, or refresh the page if it keeps happening.';
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
			<div class="progress" hidden>
				<div class="progress-bar"></div>
			</div>
			<div class="error-actions" hidden>
				<button type="button" class="retry-btn">Retry</button>
				<button type="button" class="cancel-btn">Cancel</button>
			</div>
		`;
		document.body.appendChild(el);
		document.documentElement.style.overflow = 'hidden';
		document.body.style.overflow = 'hidden';
	}
	el.removeAttribute('data-state');
	el.querySelector('.label').textContent = label;
	el.querySelector('.sublabel').textContent = sublabel || '';
	el.querySelector('.error-actions').hidden = true;
}

function updateSaveOverlay(label, sublabel) {
	const el = document.getElementById('save-loading');
	if (!el) return;
	el.querySelector('.label').textContent = label;
	if (sublabel !== undefined) el.querySelector('.sublabel').textContent = sublabel;
}

// pct: integer 0..100 to show a real progress bar, or null to hide it (used
// once the upload finishes and we move on to the commit / agent-attach hops).
function setSaveProgress(pct) {
	const el = document.getElementById('save-loading');
	if (!el) return;
	const wrap = el.querySelector('.progress');
	const bar = el.querySelector('.progress-bar');
	if (pct === null || pct === undefined) {
		wrap.hidden = true;
		bar.style.width = '0%';
		return;
	}
	wrap.hidden = false;
	bar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
}

// Reuses the existing fullscreen overlay as an error surface so the page
// background stays dim and the user can't accidentally double-trigger the
// save button underneath. Cancel restores the editing UI; Retry re-runs
// onSave with the staged blob still in memory.
function showSaveError({ title, detail, onRetry, onCancel }) {
	const el = document.getElementById('save-loading');
	if (!el) return;
	el.setAttribute('data-state', 'error');
	el.querySelector('.label').textContent = title;
	el.querySelector('.sublabel').textContent = detail || '';
	el.querySelector('.progress').hidden = true;
	const actions = el.querySelector('.error-actions');
	actions.hidden = false;
	const retryBtn = actions.querySelector('.retry-btn');
	const cancelBtn = actions.querySelector('.cancel-btn');
	// Replace nodes to drop any previous click handler from earlier failures.
	const freshRetry = retryBtn.cloneNode(true);
	const freshCancel = cancelBtn.cloneNode(true);
	retryBtn.replaceWith(freshRetry);
	cancelBtn.replaceWith(freshCancel);
	freshRetry.addEventListener('click', onRetry, { once: true });
	freshCancel.addEventListener('click', onCancel, { once: true });
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
