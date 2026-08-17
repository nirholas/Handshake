import { apiFetch } from './account.js';

const viewer      = document.getElementById('avatar-viewer');
const avatarBar   = document.getElementById('avatar-bar');
const barLoading  = document.getElementById('avatar-bar-loading');
const barEmpty    = document.getElementById('avatar-bar-empty');
const barError    = document.getElementById('avatar-bar-error');
const barRetry    = document.getElementById('avatar-bar-retry');
const offlineBanner = document.getElementById('offline-banner');
const audioDrop   = document.getElementById('audio-drop');
const audioInput  = document.getElementById('audio-input');
const audioName   = document.getElementById('audio-file-name');
const audioFname  = document.getElementById('audio-fname');
const audioFmeta  = document.getElementById('audio-fmeta');
const audioClear  = document.getElementById('audio-clear');
const audioPreview = document.getElementById('audio-preview');
const promptInput = document.getElementById('prompt-input');
const generateBtn = document.getElementById('generate-btn');
const generateHint = document.getElementById('generate-hint');
const resultBlock = document.getElementById('result-block');
const progressArea = document.getElementById('progress-area');
const progressLabel = document.getElementById('progress-label');
const videoArea   = document.getElementById('video-area');
const resultVideo = document.getElementById('result-video');
const downloadBtn = document.getElementById('download-btn');
const newVideoBtn = document.getElementById('new-video-btn');
const errorArea   = document.getElementById('error-area');
const errorMsg    = document.getElementById('error-msg');
const retryBtn    = document.getElementById('retry-btn');
const statusToast = document.getElementById('status-toast');

// ── State ──────────────────────────────────────────────────────────────────────

let selectedAvatarId   = null;
let selectedGlbUrl     = null;
let audioFile          = null;
let audioSeconds       = null;
let audioObjectUrl     = null;
let currentJobId       = null;
let pollTimer          = null;
let pollDeadline       = null;   // ms timestamp after which we give up polling
let pollFailures       = 0;      // consecutive non-2xx / network failures
let rendererAvailable  = true;
let errorAction        = null;   // {label, href} when the error's fix is a link

const POLL_TIMEOUT_MS  = 20 * 60 * 1000;  // 20 minutes: safety net for hung jobs
const POLL_FAIL_LIMIT  = 6;               // 30 s of unbroken polling failures

// The worker renders a fixed-length clip per segment, so the audio length is
// what decides how long a generation runs. Mirrors SEGMENT_SECONDS in
// workers/longcat/main.py.
const SEGMENT_SECONDS  = 3.72;

// ── Boot ──────────────────────────────────────────────────────────────────────

async function boot() {
	// Auth gate: redirect to login if not signed in.
	const authRes = await fetch('/api/auth/me', { credentials: 'include' }).catch(() => null);
	if (!authRes?.ok) {
		window.location.replace(`/login?next=${encodeURIComponent('/create/video')}`);
		return;
	}
	const authData = await authRes.json().catch(() => null);
	if (!authData?.user) {
		window.location.replace(`/login?next=${encodeURIComponent('/create/video')}`);
		return;
	}

	wireControls();
	await Promise.all([checkRenderer(), loadAvatars()]);
}

// The generation worker is a separate GPU service. When it is not reachable a
// POST only fails after the audio has been uploaded, so ask up front and say so
// instead of letting someone spend a file picker and a wait on a dead lane.
async function checkRenderer() {
	try {
		const res = await apiFetch('/api/avatar/video-generate', { method: 'GET' });
		if (!res.ok) return;
		const data = await res.json().catch(() => null);
		if (data && data.available === false) {
			rendererAvailable = false;
			offlineBanner.classList.add('is-visible');
		}
	} catch {
		// A failed probe is not proof of an outage: leave generation enabled and
		// let the real POST report what actually happened.
	}
	updateGenerateBtn();
}

// ── Avatar loading ─────────────────────────────────────────────────────────────

async function loadAvatars() {
	barLoading.hidden = false;
	barEmpty.classList.remove('is-visible');
	barError.classList.remove('is-visible');
	clearThumbs();

	let avatars;
	try {
		const res = await apiFetch('/api/avatars');
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		// GET /api/avatars responds with an envelope: { avatars: [...], next_cursor }.
		// Unwrap it, tolerating a bare array so the page keeps working either way.
		const data = await res.json().catch(() => null);
		if (Array.isArray(data?.avatars)) avatars = data.avatars;
		else if (Array.isArray(data)) avatars = data;
		else throw new Error('unreadable response');
	} catch {
		// A failed list is not an empty list. Showing the "create your first
		// avatar" empty state here sent people off to build an avatar they
		// already had; say what broke and offer the retry instead.
		barLoading.hidden = true;
		barError.classList.add('is-visible');
		showPlaceholderModel();
		updateGenerateBtn();
		return;
	}

	barLoading.hidden = true;

	if (avatars.length === 0) {
		barEmpty.classList.add('is-visible');
		showPlaceholderModel();
		updateGenerateBtn();
		return;
	}

	for (const av of avatars) {
		addThumb(av.id, avatarGlbUrl(av), av.thumbnail_url, av.name || 'Avatar');
	}

	// Auto-select the first one.
	const first = avatars[0];
	selectAvatar(first.id, avatarGlbUrl(first), first.thumbnail_url);
}

function clearThumbs() {
	avatarBar.querySelectorAll('.avatar-thumb').forEach((el) => el.remove());
	selectedAvatarId = null;
	selectedGlbUrl = null;
	viewer.removeAttribute('src');
}

// Keeps the preview panel from being an empty box when there is nothing to
// select. The stock model is decoration only: it is never a generation source,
// which is why it gets no thumbnail and never sets selectedGlbUrl.
function showPlaceholderModel() {
	viewer.setAttribute('src', '/avatars/default.glb');
	viewer.setAttribute('alt', 'Sample avatar preview');
}

// The list endpoint only carries a CDN model_url for public/unlisted avatars;
// private ones come back with model_url null and need a short-lived signed URL
// from the single-avatar endpoint (resolved lazily in selectAvatar).
function avatarGlbUrl(av) {
	return av.model_url || av.base_model_url || null;
}

async function fetchSignedGlbUrl(id) {
	try {
		const res = await apiFetch(`/api/avatars/${encodeURIComponent(id)}`);
		if (!res.ok) return null;
		const data = await res.json().catch(() => null);
		return data?.avatar?.url || data?.avatar?.model_url || null;
	} catch {
		return null;
	}
}

// The viewer starts with no src: this page redirects a signed-out visitor to
// /login, and a model download started before that check is torn down by the
// redirect, which model-viewer reports as an uncaught "Failed to fetch" (once
// more per texture it was mid-way through decoding). Every path out of
// loadAvatars() either selects an avatar or shows the placeholder model, so the
// panel still fills in the moment the account is known.
function addThumb(id, glbUrl, thumbUrl, label) {
	avatarBar.appendChild(createThumb(id, glbUrl, thumbUrl, label));
}

function createThumb(id, glbUrl, thumbUrl, label) {
	const el = document.createElement('button');
	el.type = 'button';
	el.className = 'avatar-thumb';
	el.title = label;
	el.setAttribute('aria-label', `Select ${label}`);
	el.dataset.id = id;

	if (thumbUrl) {
		const img = document.createElement('img');
		img.src = thumbUrl;
		img.alt = label;
		el.appendChild(img);
	} else {
		el.innerHTML = `<div class="avatar-thumb-placeholder"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.58-7 8-7s8 3 8 7"/></svg></div>`;
	}

	el.addEventListener('click', () => selectAvatar(id, glbUrl, thumbUrl));
	return el;
}

async function selectAvatar(id, glbUrl, thumbUrl) {
	selectedAvatarId  = id;
	selectedGlbUrl    = null;

	avatarBar.querySelectorAll('.avatar-thumb').forEach((el) => {
		const on = el.dataset.id === String(id);
		el.classList.toggle('is-selected', on);
		el.setAttribute('aria-pressed', on ? 'true' : 'false');
	});
	updateGenerateBtn();

	// Private avatars have no CDN URL in the list payload: resolve a signed one.
	if (!glbUrl) glbUrl = await fetchSignedGlbUrl(id);
	if (selectedAvatarId !== id) return; // user picked a different avatar meanwhile

	if (!glbUrl) {
		showToast('Could not load this avatar\'s 3D model. Pick another one.', 'error');
		updateGenerateBtn();
		return;
	}

	selectedGlbUrl = glbUrl;
	viewer.setAttribute('alt', 'Selected avatar preview');
	// setAttribute (not the .src property): if model-viewer hasn't upgraded yet,
	// a property assignment lands on the plain element and is shadowed once the
	// custom element upgrades, leaving the default GLB on screen.
	viewer.setAttribute('src', glbUrl);
	updateGenerateBtn();
}

// ── Audio handling ─────────────────────────────────────────────────────────────

// Files dragged out of some file managers arrive with an empty `type`, so a
// MIME-only test rejects perfectly good .wav/.m4a drops. Accept either signal,
// and keep the extension list in step with the input's `accept` attribute.
const AUDIO_EXTENSIONS = /\.(wav|mp3|m4a|ogg|oga|flac|aac|opus|webm)$/i;

function looksLikeAudio(file) {
	return file.type.startsWith('audio/') || AUDIO_EXTENSIONS.test(file.name);
}

function wireControls() {
	audioInput.addEventListener('change', () => {
		if (audioInput.files?.[0]) setAudioFile(audioInput.files[0]);
	});

	audioDrop.addEventListener('dragover', (e) => { e.preventDefault(); audioDrop.classList.add('is-dragover'); });
	audioDrop.addEventListener('dragleave', () => audioDrop.classList.remove('is-dragover'));
	audioDrop.addEventListener('drop', (e) => {
		e.preventDefault();
		audioDrop.classList.remove('is-dragover');
		const file = e.dataTransfer?.files?.[0];
		if (file && looksLikeAudio(file)) setAudioFile(file);
		else showToast('Please drop an audio file (WAV, MP3, M4A, OGG, FLAC).', 'error');
	});

	audioClear.addEventListener('click', clearAudio);
	generateBtn.addEventListener('click', startGeneration);
	newVideoBtn.addEventListener('click', resetToIdle);
	retryBtn.addEventListener('click', () => {
		if (errorAction?.href) {
			window.location.href = errorAction.href;
			return;
		}
		resetToIdle();
	});
	barRetry.addEventListener('click', loadAvatars);
}

function setAudioFile(file) {
	audioFile = file;
	audioSeconds = null;
	audioFname.textContent = file.name;
	audioFmeta.textContent = formatBytes(file.size);
	audioDrop.style.display = 'none';
	audioName.classList.add('is-visible');

	if (audioObjectUrl) URL.revokeObjectURL(audioObjectUrl);
	audioObjectUrl = URL.createObjectURL(file);
	audioPreview.src = audioObjectUrl;
	audioPreview.classList.add('is-visible');
	audioPreview.onloadedmetadata = () => {
		if (!Number.isFinite(audioPreview.duration)) return;
		audioSeconds = audioPreview.duration;
		audioFmeta.textContent = `${formatDuration(audioSeconds)} · ${formatBytes(file.size)}`;
		updateGenerateBtn();
	};

	updateGenerateBtn();
}

function clearAudio() {
	audioFile = null;
	audioSeconds = null;
	audioInput.value = '';
	audioDrop.style.display = '';
	audioName.classList.remove('is-visible');
	audioFmeta.textContent = '';
	audioPreview.classList.remove('is-visible');
	audioPreview.removeAttribute('src');
	if (audioObjectUrl) {
		URL.revokeObjectURL(audioObjectUrl);
		audioObjectUrl = null;
	}
	updateGenerateBtn();
}

function formatBytes(n) {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
	return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(seconds) {
	const total = Math.round(seconds);
	return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function setHint(text) {
	generateHint.textContent = text;
	generateHint.setAttribute('data-i18n-owned', '1');
}

function updateGenerateBtn() {
	const ready = Boolean(selectedGlbUrl && audioFile) && rendererAvailable;
	generateBtn.disabled = !ready;

	if (!rendererAvailable) {
		setHint('Generation is paused while the renderer is offline.');
		return;
	}
	if (!selectedGlbUrl && !audioFile) {
		setHint('Pick an avatar and add an audio clip to generate.');
		return;
	}
	if (!selectedGlbUrl) {
		setHint('Pick an avatar to generate.');
		return;
	}
	if (!audioFile) {
		setHint('Add an audio clip to generate.');
		return;
	}
	const clips = audioSeconds ? Math.max(1, Math.ceil(audioSeconds / SEGMENT_SECONDS)) : null;
	setHint(
		clips
			? `Ready: about ${clips} ${clips === 1 ? 'clip' : 'clips'} of video from this audio.`
			: 'Ready to generate.',
	);
}

// ── Generation flow ────────────────────────────────────────────────────────────

async function startGeneration() {
	if (!selectedGlbUrl || !audioFile) return;

	generateBtn.disabled = true;
	showResult('progress');
	setProgressLabel('Uploading audio…');

	let audioUrl;
	try {
		audioUrl = await uploadAudio(audioFile);
	} catch (err) {
		showResult('error', `Audio upload failed: ${err.message}`);
		generateBtn.disabled = false;
		return;
	}

	setProgressLabel('Queuing generation job…');

	let jobId;
	try {
		// Only the avatar id goes over the wire: the server resolves it to a real
		// reference image (stored thumbnail, else a portrait render). Sending a
		// client-side URL here used to hand the worker the avatar's .glb, which it
		// wrote into ref_image.png and then failed on, minutes later.
		const res = await apiFetch('/api/avatar/video-generate', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				audio_url:  audioUrl,
				avatar_id:  selectedAvatarId,
				prompt:     promptInput.value.trim() || undefined,
			}),
		});

		if (!res.ok) {
			const e = await res.json().catch(() => ({}));
			if (res.status === 402 && e.error === 'free_trial_used') {
				showResult('error', 'You have used your 1 free video. Upgrade to generate more.', {
					label: 'Upgrade plan',
					href: '/dashboard',
				});
				generateBtn.disabled = false;
				return;
			}
			if (res.status === 503) {
				rendererAvailable = false;
				offlineBanner.classList.add('is-visible');
				showResult(
					'error',
					'Video rendering is offline right now, so this job could not start. Your audio was saved, so retrying later costs nothing extra.',
				);
				updateGenerateBtn();
				return;
			}
			throw new Error(e.error_description || `HTTP ${res.status}`);
		}

		const data = await res.json();
		jobId = data.job_id;
		currentJobId = jobId;
	} catch (err) {
		showResult('error', `Could not start generation: ${err.message}`);
		generateBtn.disabled = false;
		return;
	}

	setProgressLabel('Generating video…');
	pollDeadline = Date.now() + POLL_TIMEOUT_MS;
	pollFailures = 0;
	pollTimer = setInterval(() => pollJob(jobId), 5000);
}

async function pollJob(jobId) {
	if (currentJobId !== jobId) return;

	if (pollDeadline && Date.now() > pollDeadline) {
		stopPolling();
		showResult('error', 'Generation timed out. Please try again.');
		generateBtn.disabled = false;
		return;
	}

	let data;
	try {
		const res = await apiFetch(`/api/avatar/video-status?job_id=${encodeURIComponent(jobId)}`);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		data = await res.json();
	} catch (err) {
		// A transient 5xx or a dropped connection resolves on the next tick, but
		// a job that is gone (404) or a session that expired answers the same way
		// forever. Ride out a short run of failures, then say so rather than
		// spinning silently until the 20-minute deadline.
		pollFailures += 1;
		if (pollFailures >= POLL_FAIL_LIMIT) {
			stopPolling();
			showResult('error', `Lost contact with the render job (${err.message}). Please try again.`);
			generateBtn.disabled = false;
		}
		return;
	}

	pollFailures = 0;

	if (data.status === 'queued' || data.status === 'running') {
		const pct = data.progress != null ? ` ${Math.round(data.progress * 100)}%` : '';
		// The worker renders one 3.72 s clip per segment and reports how many it
		// planned for this audio, so name them instead of showing a bare percent
		// on a job that can legitimately run for minutes.
		const clips = Number(data.segments) > 1 ? `${data.segments} clips` : 'frames';
		setProgressLabel(`Rendering ${clips}…${pct}`);
	} else if (data.status === 'done' && data.video_url) {
		stopPolling();
		showVideo(data.video_url);
	} else if (data.status === 'failed') {
		stopPolling();
		showResult('error', data.error
			? `Generation failed on the server: ${data.error}`
			: 'Generation failed on the server. Please try again.');
		generateBtn.disabled = false;
	}
}

function stopPolling() {
	if (pollTimer) clearInterval(pollTimer);
	pollTimer = null;
	currentJobId = null;
	pollDeadline = null;
	pollFailures = 0;
}

function showVideo(url) {
	resultVideo.src = url;
	downloadBtn.href = url;
	showResult('video');
}

function resetToIdle() {
	stopPolling();
	resultVideo.removeAttribute('src');
	resultBlock.classList.remove('is-visible');
	progressArea.classList.remove('is-visible');
	videoArea.classList.remove('is-visible');
	errorArea.classList.remove('is-visible');
	updateGenerateBtn();
}

// ── Audio upload ──────────────────────────────────────────────────────────────
// Uploads the audio file and returns a publicly accessible URL.
// Uses the existing presigned-upload flow via R2/S3.

async function uploadAudio(file) {
	const contentType = file.type || 'audio/mpeg';

	// Get a presigned upload URL from the dedicated audio presign endpoint.
	const presignRes = await apiFetch('/api/avatar/presign-audio', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ filename: file.name, content_type: contentType, bytes: file.size }),
	});

	// No data-URI fallback: /api/avatar/video-generate only accepts an https
	// audio_url on a three.ws-controlled host (the worker fetches it server-side,
	// so anything else would hand it an SSRF primitive), so a data: URI is
	// rejected with a 400 before the worker ever sees it. A failed presign is a
	// real failure and is reported as one.
	if (!presignRes.ok) {
		const e = await presignRes.json().catch(() => ({}));
		if (presignRes.status === 413) {
			throw new Error('That clip is too large to upload. Trim it and try again.');
		}
		if (presignRes.status === 429) {
			throw new Error('Too many uploads just now. Wait a minute and try again.');
		}
		throw new Error(e.error_description || `could not get an upload URL (HTTP ${presignRes.status})`);
	}

	const { upload_url, public_url } = await presignRes.json();

	const uploadRes = await fetch(upload_url, {
		method: 'PUT',
		headers: { 'content-type': contentType },
		body: file,
	});

	if (!uploadRes.ok) throw new Error(`Audio upload failed: HTTP ${uploadRes.status}`);
	return public_url;
}

// ── UI helpers ────────────────────────────────────────────────────────────────

// `action` retargets the button under the error message when retrying is not
// the fix (a spent free trial needs an upgrade, not another attempt). Setting
// it through here is what keeps the label and the click handler in step: the
// old code rewrote the label and bolted on a second handler, so every later
// error still offered "Upgrade plan" and running it also reset the form.
function showResult(state, msg, action = null) {
	resultBlock.classList.add('is-visible');
	progressArea.classList.toggle('is-visible', state === 'progress');
	videoArea.classList.toggle('is-visible', state === 'video');
	errorArea.classList.toggle('is-visible', state === 'error');
	if (state !== 'error') return;
	if (msg) errorMsg.textContent = msg;
	errorAction = action;
	retryBtn.textContent = action?.label || 'Try again';
	retryBtn.setAttribute('data-i18n-owned', '1');
}

function setProgressLabel(text) {
	progressLabel.textContent = text;
	progressLabel.setAttribute('data-i18n-owned', '1');
}

let toastTimer = null;
function showToast(msg, type = 'info') {
	statusToast.textContent = msg;
	statusToast.className = `status-toast ${type}`;
	statusToast.hidden = false;
	if (toastTimer) clearTimeout(toastTimer);
	toastTimer = setTimeout(() => {
		statusToast.hidden = true;
		toastTimer = null;
	}, 4000);
}

boot();
