import { apiFetch } from './account.js';

const viewer      = document.getElementById('avatar-viewer');
const avatarBar   = document.getElementById('avatar-bar');
const barLoading  = document.getElementById('avatar-bar-loading');
const audioDrop   = document.getElementById('audio-drop');
const audioInput  = document.getElementById('audio-input');
const audioName   = document.getElementById('audio-file-name');
const audioFname  = document.getElementById('audio-fname');
const audioClear  = document.getElementById('audio-clear');
const promptInput = document.getElementById('prompt-input');
const generateBtn = document.getElementById('generate-btn');
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
let selectedThumbnail  = null;
let audioFile          = null;
let currentJobId       = null;
let pollTimer          = null;

// ── Boot ──────────────────────────────────────────────────────────────────────

async function boot() {
	// Auth gate — redirect to login if not signed in.
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

	await loadAvatars();
	wireControls();
}

// ── Avatar loading ─────────────────────────────────────────────────────────────

async function loadAvatars() {
	let avatars = [];
	try {
		const res = await apiFetch('/api/avatars');
		if (res.ok) avatars = (await res.json()) ?? [];
	} catch {
		// fall through — show default avatar only
	}

	barLoading.remove();

	if (avatars.length === 0) {
		addDefaultThumb();
		return;
	}

	for (const av of avatars) {
		addThumb(av.id, av.glb_url ?? av.storage_url, av.thumbnail_url, av.display_name || 'Avatar');
	}

	// Auto-select the first one.
	const first = avatars[0];
	selectAvatar(first.id, first.glb_url ?? first.storage_url, first.thumbnail_url);
}

function addDefaultThumb() {
	const url = '/avatars/default.glb';
	const thumb = createThumb('default', url, null, 'Default');
	avatarBar.appendChild(thumb);
	selectAvatar('default', url, null);
}

function addThumb(id, glbUrl, thumbUrl, label) {
	const el = createThumb(id, glbUrl, thumbUrl, label);
	avatarBar.appendChild(el);
}

function createThumb(id, glbUrl, thumbUrl, label) {
	const el = document.createElement('div');
	el.className = 'avatar-thumb';
	el.title = label;
	el.setAttribute('role', 'button');
	el.setAttribute('tabindex', '0');
	el.setAttribute('aria-label', `Select ${label}`);
	el.dataset.id = id;
	el.dataset.glb = glbUrl;
	el.dataset.thumb = thumbUrl || '';

	if (thumbUrl) {
		const img = document.createElement('img');
		img.src = thumbUrl;
		img.alt = label;
		el.appendChild(img);
	} else {
		el.innerHTML = `<div class="avatar-thumb-placeholder"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.58-7 8-7s8 3 8 7"/></svg></div>`;
	}

	el.addEventListener('click', () => selectAvatar(id, glbUrl, thumbUrl));
	el.addEventListener('keydown', (e) => {
		if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectAvatar(id, glbUrl, thumbUrl); }
	});
	return el;
}

function selectAvatar(id, glbUrl, thumbUrl) {
	selectedAvatarId  = id;
	selectedGlbUrl    = glbUrl;
	selectedThumbnail = thumbUrl;

	viewer.src = glbUrl;

	document.querySelectorAll('.avatar-thumb').forEach((el) => {
		el.classList.toggle('is-selected', el.dataset.id === String(id));
	});

	updateGenerateBtn();
}

// ── Audio handling ─────────────────────────────────────────────────────────────

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
		if (file && file.type.startsWith('audio/')) setAudioFile(file);
		else showToast('Please drop an audio file (WAV, MP3, M4A…).', 'error');
	});

	audioClear.addEventListener('click', clearAudio);
	generateBtn.addEventListener('click', startGeneration);
	newVideoBtn.addEventListener('click', resetToIdle);
	retryBtn.addEventListener('click', resetToIdle);
}

function setAudioFile(file) {
	audioFile = file;
	audioFname.textContent = file.name;
	audioDrop.style.display = 'none';
	audioName.classList.add('is-visible');
	updateGenerateBtn();
}

function clearAudio() {
	audioFile = null;
	audioInput.value = '';
	audioDrop.style.display = '';
	audioName.classList.remove('is-visible');
	updateGenerateBtn();
}

function updateGenerateBtn() {
	generateBtn.disabled = !(selectedGlbUrl && audioFile);
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
		const res = await apiFetch('/api/avatar/video-generate', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				image_url:  selectedThumbnail || selectedGlbUrl,
				audio_url:  audioUrl,
				avatar_id:  selectedAvatarId !== 'default' ? selectedAvatarId : undefined,
				prompt:     promptInput.value.trim() || undefined,
			}),
		});

		if (!res.ok) {
			const e = await res.json().catch(() => ({}));
			if (res.status === 402 && e.error === 'free_trial_used') {
				showResult('error', 'You've used your 1 free video. Upgrade to generate more.');
				retryBtn.textContent = 'Upgrade plan';
				retryBtn.onclick = () => { window.location.href = '/dashboard'; };
				generateBtn.disabled = false;
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
	pollTimer = setInterval(() => pollJob(jobId), 5000);
}

async function pollJob(jobId) {
	if (currentJobId !== jobId) return;

	let data;
	try {
		const res = await apiFetch(`/api/avatar/video-status?job_id=${encodeURIComponent(jobId)}`);
		if (!res.ok) return;
		data = await res.json();
	} catch {
		return;
	}

	if (data.status === 'running') {
		setProgressLabel('Rendering frames…');
	} else if (data.status === 'done' && data.video_url) {
		clearInterval(pollTimer);
		pollTimer = null;
		currentJobId = null;
		showVideo(data.video_url);
	} else if (data.status === 'failed') {
		clearInterval(pollTimer);
		pollTimer = null;
		currentJobId = null;
		showResult('error', 'Generation failed on the server. Please try again.');
		generateBtn.disabled = false;
	}
}

function showVideo(url) {
	resultVideo.src = url;
	downloadBtn.href = url;
	showResult('video');
}

function resetToIdle() {
	if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
	currentJobId = null;
	resultVideo.src = '';
	resultBlock.classList.remove('is-visible');
	progressArea.classList.remove('is-visible');
	videoArea.classList.remove('is-visible');
	errorArea.classList.remove('is-visible');
	generateBtn.disabled = !(selectedGlbUrl && audioFile);
}

// ── Audio upload ──────────────────────────────────────────────────────────────
// Uploads the audio file and returns a publicly accessible URL.
// Uses the existing presigned-upload flow via R2/S3.

async function uploadAudio(file) {
	// Get a presigned upload URL from the server.
	const presignRes = await apiFetch('/api/avatars/presign', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ filename: file.name, content_type: file.type || 'audio/mpeg', kind: 'audio' }),
	});

	if (!presignRes.ok) {
		// Fallback: convert to data URI if presign endpoint isn't available yet.
		// The LongCat worker supports downloading from data URIs via httpx.
		return await fileToDataUri(file);
	}

	const { upload_url, public_url } = await presignRes.json();

	const uploadRes = await fetch(upload_url, {
		method: 'PUT',
		headers: { 'content-type': file.type || 'audio/mpeg' },
		body: file,
	});

	if (!uploadRes.ok) throw new Error(`Upload failed: HTTP ${uploadRes.status}`);
	return public_url;
}

function fileToDataUri(file) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result);
		reader.onerror = () => reject(new Error('FileReader failed'));
		reader.readAsDataURL(file);
	});
}

// ── UI helpers ────────────────────────────────────────────────────────────────

function showResult(state, msg) {
	resultBlock.classList.add('is-visible');
	progressArea.classList.toggle('is-visible', state === 'progress');
	videoArea.classList.toggle('is-visible', state === 'video');
	errorArea.classList.toggle('is-visible', state === 'error');
	if (state === 'error' && msg) errorMsg.textContent = msg;
}

function setProgressLabel(text) {
	progressLabel.textContent = text;
}

function showToast(msg, type = 'info') {
	statusToast.textContent = msg;
	statusToast.className = `status-toast ${type}`;
	statusToast.hidden = false;
	setTimeout(() => { statusToast.hidden = true; }, 4000);
}

boot();
