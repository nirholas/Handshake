// mocap-studio.js — record, save, and replay face-mocap clips on a three.ws avatar.
//
// Pipeline:
//   1. Load an avatar (handle-resolved, or the user's primary public avatar).
//   2. Initialize FaceMocap (MediaPipe FaceLandmarker @ ~30Hz, GPU delegate).
//   3. Calibrate to a neutral pose (subtracts resting-face baseline).
//   4. Record / stop — uses FaceMocap's built-in clip buffer.
//   5. Replay any saved clip via FaceMocap.playback().
//   6. Save to /api/mocap/clips with metadata.
//   7. List + replay anyone's public clips, plus your own private ones.

import { Viewer } from './viewer.js';
import { FaceMocap } from './face-mocap.js';
import { IdleAnimation } from './idle-animation.js';

const $ = (sel) => document.querySelector(sel);

const stage = $('#stage');
const pip = $('#webcam-pip');
const recPill = $('#rec-pill');
const recTime = $('#rec-time');
const timer = $('#timer');

const startCamBtn = $('#start-cam');
const calibrateBtn = $('#calibrate');
const recordBtn = $('#record');
const replayBtn = $('#replay');
const discardBtn = $('#discard');
const saveBtn = $('#save-clip');
const downloadBtn = $('#download-clip');
const nameInput = $('#clip-name');
const descInput = $('#clip-desc');
const tagsInput = $('#clip-tags');
const visibilityInput = $('#clip-visibility');
const handleInput = $('#avatar-handle');
const loadAvatarBtn = $('#load-avatar');
const avatarInfo = $('#avatar-info');
const clipListEl = $('#clip-list');
const authWarning = $('#auth-warning');

const state = {
	viewer: null,
	avatar: null, // { id, modelUrl, name, handle }
	mocap: null,
	idle: null,
	lastClip: null,
	recording: false,
	tStart: 0,
	rafId: 0,
	playback: null,
	signedIn: false,
};

// ── Bring up the Three.js scene ────────────────────────────────────────────
const viewer = new Viewer(stage, { kiosk: true });
viewer.renderer?.setClearAlpha(0);
if (viewer.scene) viewer.scene.background = null;
state.viewer = viewer;

// Reasonable defaults
handleInput.value = '';
nameInput.value = '';

// ── Auth state ────────────────────────────────────────────────────────────
detectAuth().then((ok) => {
	state.signedIn = ok;
	authWarning.classList.toggle('visible', !ok);
});

// ── Boot: try to load user's primary public avatar ────────────────────────
bootAvatar().catch((err) => {
	avatarInfo.textContent = err?.message || 'No avatar loaded — enter a handle above.';
});

refreshClipList();

// ── Button wiring ─────────────────────────────────────────────────────────
loadAvatarBtn.addEventListener('click', () => loadByHandle());
handleInput.addEventListener('keydown', (e) => {
	if (e.key === 'Enter') {
		e.preventDefault();
		loadByHandle();
	}
});

startCamBtn.addEventListener('click', () => startMocap().catch(showErr));
calibrateBtn.addEventListener('click', () => {
	if (!state.mocap) return;
	const ok = state.mocap.calibrate();
	calibrateBtn.textContent = ok ? 'Recalibrate' : 'Calibrate (no face yet)';
	setTimeout(() => (calibrateBtn.textContent = 'Calibrate neutral'), 1400);
});
recordBtn.addEventListener('click', () => {
	if (state.recording) stopRecording();
	else startRecording();
});
replayBtn.addEventListener('click', () => {
	if (state.lastClip) replay(state.lastClip);
});
discardBtn.addEventListener('click', () => {
	state.lastClip = null;
	updateButtons();
	timer.textContent = '00.0s';
});
saveBtn.addEventListener('click', () => saveClip().catch(showErr));
downloadBtn.addEventListener('click', () => downloadClip());

// ── Functions ──────────────────────────────────────────────────────────────

async function fetchMe() {
	try {
		const r = await fetch('/api/auth/me', { credentials: 'include' });
		if (!r.ok) return null;
		const data = await r.json().catch(() => null);
		return data?.user || null;
	} catch {
		return null;
	}
}

async function detectAuth() {
	return !!(await fetchMe());
}

async function bootAvatar() {
	const params = new URLSearchParams(location.search);
	const handle = params.get('handle') || params.get('h');
	if (handle) {
		handleInput.value = handle.replace(/^@/, '');
		try {
			await loadByHandle();
			if (state.avatar) return;
		} catch {}
		return loadDefaultAvatar();
	}
	// Try the signed-in user's username — auto-load their public avatar.
	const user = await fetchMe();
	if (user?.username) {
		handleInput.value = user.username;
		try {
			await loadByHandle();
			if (state.avatar) return;
		} catch {}
	}
	// Nothing to resolve (signed out, or no public avatar): drop in the
	// platform's default avatar so the camera + mocap pipeline is usable now.
	return loadDefaultAvatar();
}

// Bring a freshly loaded model into the scene and (re)wire idle + mocap to its
// skeleton. Shared by handle-resolved loads and the default-avatar fallback.
async function applyLoadedAvatar(modelUrl, meta) {
	await viewer.load(modelUrl, '', new Map());
	state.avatar = meta;
	if (state.idle) state.idle.dispose();
	if (!viewer._afterAnimateHooks) viewer._afterAnimateHooks = [];
	if (state._idleHook) {
		const idx = viewer._afterAnimateHooks.indexOf(state._idleHook);
		if (idx !== -1) viewer._afterAnimateHooks.splice(idx, 1);
	}
	state.idle = new IdleAnimation({ getRoot: () => viewer.content, seed: meta.id });
	state._idleHook = (dt) => state.idle?.update(dt);
	viewer._afterAnimateHooks.push(state._idleHook);
	if (state.mocap) reattachMocap();
	else startCamBtn.disabled = false;
}

async function loadDefaultAvatar() {
	avatarInfo.textContent = 'Loading default avatar…';
	try {
		await applyLoadedAvatar('/avatars/default.glb', {
			id: 'default',
			modelUrl: '/avatars/default.glb',
			name: 'Default avatar',
			handle: null,
		});
		avatarInfo.textContent = 'Default avatar · enter a handle above to load your own';
	} catch (err) {
		avatarInfo.textContent = err?.message || 'Failed to load the default avatar.';
	}
}

async function loadByHandle() {
	const raw = (handleInput.value || '').trim().replace(/^@/, '').toLowerCase();
	if (!/^[a-z0-9_-]{3,30}$/.test(raw)) {
		avatarInfo.textContent = `Invalid handle: ${raw || '(empty)'}`;
		return;
	}
	avatarInfo.textContent = `Loading @${raw}…`;
	try {
		const r = await fetch(`/api/users/${encodeURIComponent(raw)}/avatar`);
		if (!r.ok) throw new Error(`@${raw} has no public avatar`);
		const data = await r.json();
		const avatar = data.avatar;
		await applyLoadedAvatar(avatar.model_url, {
			id: avatar.id,
			modelUrl: avatar.model_url,
			name: data.user.display_name || data.user.username,
			handle: data.user.username,
		});
		avatarInfo.textContent = `${state.avatar.name} · @${state.avatar.handle}`;
	} catch (err) {
		state.avatar = null;
		avatarInfo.textContent = err?.message || 'Failed to load.';
	}
}

async function startMocap() {
	if (state.mocap) return;
	if (!viewer.content) throw new Error('Load an avatar first.');
	startCamBtn.disabled = true;
	startCamBtn.textContent = 'Starting…';
	const mocap = new FaceMocap();
	await mocap.init();
	const video = await mocap.startWebcam();
	pip.srcObject = video.srcObject;
	pip.classList.add('live');
	// Idle pauses saccade + blink while we drive the head.
	state.idle?.setChannels({ saccade: false, blink: false });
	reattachMocapRoot(mocap);
	mocap.start();
	state.mocap = mocap;
	// Hook into viewer's per-frame loop for FaceMocap.update().
	viewer._afterAnimateHooks.push(() => state.mocap?.update());
	startCamBtn.textContent = 'Camera live';
	startCamBtn.disabled = true;
	calibrateBtn.disabled = false;
	recordBtn.disabled = false;
}

function reattachMocap() {
	if (!state.mocap || !viewer.content) return;
	reattachMocapRoot(state.mocap);
}
function reattachMocapRoot(mocap) {
	let head = null;
	let neck = null;
	viewer.content.traverse((node) => {
		if (!node.isBone) return;
		const canon = node.name
			.replace(/^mixamorig:?/i, '')
			.replace(/^[A-Za-z0-9]+[_:]/, '')
			.toLowerCase();
		if (!head && canon === 'head') head = node;
		else if (!neck && canon === 'neck') neck = node;
	});
	mocap.attach(viewer.content, head || neck);
}

function startRecording() {
	if (!state.mocap) return;
	if (state.playback) {
		state.playback.stop();
		state.playback = null;
	}
	state.mocap.startRecording();
	state.recording = true;
	state.tStart = performance.now();
	recPill.classList.add('on');
	recordBtn.textContent = 'Stop';
	recordBtn.classList.add('danger');
	timer.classList.add('recording');
	loopTimer();
}

function stopRecording() {
	if (!state.mocap || !state.recording) return;
	state.recording = false;
	const clip = state.mocap.stopRecording();
	state.lastClip = clip;
	recPill.classList.remove('on');
	timer.classList.remove('recording');
	recordBtn.textContent = 'Record';
	if (state.rafId) cancelAnimationFrame(state.rafId);
	timer.textContent = formatTime(clip.duration || 0);
	updateButtons();
}

function loopTimer() {
	if (!state.recording) return;
	const dt = (performance.now() - state.tStart) / 1000;
	timer.textContent = formatTime(dt);
	recTime.textContent = `${dt.toFixed(1)}s`;
	state.rafId = requestAnimationFrame(loopTimer);
}

function replay(clip) {
	if (!state.mocap) return;
	if (state.playback) state.playback.stop();
	state.playback = state.mocap.playback(clip, {
		onEnd: () => {
			state.playback = null;
		},
	});
}

function updateButtons() {
	const has = !!state.lastClip;
	saveBtn.disabled = !has || !state.signedIn;
	downloadBtn.disabled = !has;
	replayBtn.disabled = !has || !state.mocap;
	discardBtn.disabled = !has;
}

async function saveClip() {
	if (!state.lastClip) return;
	const name = (nameInput.value || '').trim();
	if (!name) {
		alert('Give the clip a name first.');
		nameInput.focus();
		return;
	}
	const tags = (tagsInput.value || '')
		.split(',')
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean)
		.slice(0, 20);
	const payload = {
		name,
		description: (descInput.value || '').trim() || undefined,
		tags,
		visibility: visibilityInput.value,
		avatar_id: state.avatar?.id,
		clip: state.lastClip,
	};
	saveBtn.disabled = true;
	saveBtn.textContent = 'Saving…';
	try {
		const r = await fetch('/api/mocap/clips', {
			method: 'POST',
			credentials: 'include',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(payload),
		});
		if (!r.ok) {
			const body = await r.json().catch(() => null);
			throw new Error(body?.message || `save failed (${r.status})`);
		}
		saveBtn.textContent = 'Saved';
		nameInput.value = '';
		descInput.value = '';
		tagsInput.value = '';
		setTimeout(() => {
			saveBtn.textContent = 'Save clip';
			updateButtons();
		}, 1400);
		refreshClipList();
	} catch (err) {
		saveBtn.disabled = false;
		saveBtn.textContent = 'Save clip';
		alert(err?.message || 'Save failed.');
	}
}

function downloadClip() {
	if (!state.lastClip) return;
	const blob = new Blob([JSON.stringify(state.lastClip, null, 2)], {
		type: 'application/json',
	});
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = `three-ws-mocap-${Date.now()}.json`;
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function refreshClipList() {
	clipListEl.innerHTML = '<div class="empty-state">Loading…</div>';
	try {
		const r = await fetch('/api/mocap/clips?include_public=true&limit=30', {
			credentials: 'include',
		});
		if (!r.ok) throw new Error(`list failed (${r.status})`);
		const { items } = await r.json();
		if (!items || items.length === 0) {
			clipListEl.innerHTML = '<div class="empty-state">No clips saved yet. Record one above.</div>';
			return;
		}
		clipListEl.innerHTML = '';
		for (const c of items) {
			const el = document.createElement('div');
			el.className = 'clip';
			el.innerHTML = `
				<div class="meta">
					<div class="n">${escapeHtml(c.name)} <span class="v-pill ${escapeAttr(c.visibility)}">${escapeHtml(c.visibility)}</span></div>
					<div class="d">${escapeHtml(c.kind)} · ${formatTime((c.duration_ms || 0) / 1000)} · ${c.frame_count} frames${c.owner === 'self' ? '' : ' · public'}</div>
				</div>
				<div class="clip-actions">
					<button class="clip-btn" data-act="play" data-id="${escapeAttr(c.id)}">Replay</button>
					${c.owner === 'self' ? `<button class="clip-btn" data-act="delete" data-id="${escapeAttr(c.id)}">Delete</button>` : ''}
				</div>
			`;
			clipListEl.appendChild(el);
		}
		clipListEl.querySelectorAll('button[data-act]').forEach((btn) => {
			btn.addEventListener('click', () => {
				const id = btn.dataset.id;
				if (btn.dataset.act === 'play') playSavedClip(id);
				else if (btn.dataset.act === 'delete') deleteSavedClip(id);
			});
		});
	} catch (err) {
		clipListEl.innerHTML = `<div class="empty-state">${escapeHtml(err?.message || 'Could not load clips.')}</div>`;
	}
}

async function playSavedClip(id) {
	if (!state.mocap) {
		alert('Start the camera first so the playback driver is attached.');
		return;
	}
	try {
		const r = await fetch(`/api/mocap/clips/${encodeURIComponent(id)}`, { credentials: 'include' });
		if (!r.ok) throw new Error(`fetch failed (${r.status})`);
		const { clip } = await r.json();
		replay({ format: clip.format, duration: clip.duration, frames: clip.frames });
	} catch (err) {
		alert(err?.message || 'Could not load clip.');
	}
}

async function deleteSavedClip(id) {
	if (!confirm('Delete this clip?')) return;
	try {
		const r = await fetch(`/api/mocap/clips/${encodeURIComponent(id)}`, {
			method: 'DELETE',
			credentials: 'include',
		});
		if (!r.ok) throw new Error(`delete failed (${r.status})`);
		refreshClipList();
	} catch (err) {
		alert(err?.message || 'Could not delete.');
	}
}

function formatTime(seconds) {
	const s = Math.max(0, Number(seconds) || 0);
	return `${s.toFixed(1)}s`;
}

function showErr(err) {
	console.error('[mocap-studio]', err);
	alert(err?.message || String(err));
	startCamBtn.disabled = false;
	startCamBtn.textContent = 'Start camera';
}

function escapeHtml(s) {
	if (s == null) return '';
	return String(s)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}
function escapeAttr(s) { return escapeHtml(s); }
