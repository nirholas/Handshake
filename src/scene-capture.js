// Scene Capture — drive the video → 3D point-cloud pipeline and render the result.
//
// Backend: POST /api/scene-capture { video_url, … } → 202 { job_id }, then poll
// GET /api/scene-capture?job=<id> until done. The result is a .ply point cloud we
// render with PointCloudViewer. Every state is designed: idle, submitting,
// processing (with elapsed timer + stage hints), live, and error. When the
// backend isn't configured, the sample cloud still proves the renderer end-to-end.

import { PointCloudViewer, sampleRoomCloud } from './pointcloud-viewer.js';

const $ = (s, r = document) => r.querySelector(s);

let viewer = null;
let pollTimer = null;
let elapsedTimer = null;
let downloadUrl = null;

const STAGE = () => $('#pc-stage');
const HOST = () => $('#pc-host');

// ── viewer lifecycle ──────────────────────────────────────────────────────────
const COLOR_LABELS = { rgb: 'Colour', mono: 'Mono', height: 'Height', depth: 'Depth' };
let baseLabel = '';

function ensureViewer() {
	if (!viewer) {
		viewer = new PointCloudViewer(HOST(), { background: '#0a0a0a' });
		viewer.onFps(() => refreshStats());
	}
	return viewer;
}

function refreshStats() {
	if (!viewer || !baseLabel) return;
	const s = viewer.stats();
	const bits = [baseLabel];
	// fps is only meaningful under continuous render (auto-rotate); render-on-demand
	// idles by design, so a static reading would misrepresent performance.
	if (s.autoRotate && s.fps) bits.push(`${s.fps} fps`);
	if (s.colorMode && s.colorMode !== 'rgb') bits.push(COLOR_LABELS[s.colorMode]);
	$('#pc-hud-label').textContent = bits.join(' · ');
}

// ── overlay states ────────────────────────────────────────────────────────────
function showOnly(id) {
	for (const k of ['pc-idle', 'pc-loading', 'pc-error']) {
		const node = $(`#${k}`);
		if (node) node.hidden = k !== id;
	}
	if (id !== null) $('#pc-hud').hidden = true;
}
// These two headings ship with a translatable placeholder but are rewritten from
// here on every state change. `data-i18n-owned` hands ownership to this script so
// the catalog pass (which lands after an async /api/locale fetch) cannot revert a
// live "Couldn't fetch that point cloud" back to "Something went wrong".
function own(el, text) {
	el.textContent = text;
	el.setAttribute('data-i18n-owned', '1');
}
function setLoading(title, sub) {
	own($('#pc-loading-title'), title);
	if (sub != null) $('#pc-loading-sub').textContent = sub;
	showOnly('pc-loading');
}
function setError(title, sub) {
	own($('#pc-error-title'), title);
	$('#pc-error-sub').textContent = sub || '';
	showOnly('pc-error');
}
function setLive(label) {
	baseLabel = label;
	$('#pc-hud-label').textContent = label;
	$('#pc-hud').hidden = false;
	for (const k of ['pc-idle', 'pc-loading', 'pc-error']) $(`#${k}`).hidden = true;
	for (const id of ['pc-size', 'pc-color', 'pc-rotate', 'pc-shot', 'pc-recenter']) {
		const el = $(`#${id}`); if (el) el.disabled = false;
	}
}

function setDownload(url, filename) {
	const btn = $('#pc-download');
	if (downloadUrl && downloadUrl !== url) URL.revokeObjectURL(downloadUrl);
	downloadUrl = url;
	if (!url) { btn.hidden = true; return; }
	btn.href = url;
	btn.download = filename || 'scene.ply';
	btn.hidden = false;
}

function fmt(n) { return n.toLocaleString('en-US'); }

// ── render a point cloud from an ArrayBuffer ──────────────────────────────────
const INVALID_PLY = 'Expected a binary or ASCII .ply with xyz + rgb vertices.';

function renderBuffer(buffer, label, downloadName, extra) {
	setLoading('Decoding point cloud…', `${(buffer.byteLength / 1024 / 1024).toFixed(1)} MB`);
	try {
		const v = ensureViewer();
		const { count } = v.loadBuffer(buffer);
		// A file that is not a PLY decodes to an empty geometry rather than throwing,
		// which used to read as a successful "0 points" render over a blank stage.
		if (!count) throw new Error('no vertices in point cloud');
		setLive([`${label} · ${fmt(count)} points`, extra].filter(Boolean).join(' · '));
		setDownload(URL.createObjectURL(new Blob([buffer])), downloadName);
		$('#pc-size').disabled = false;
	} catch (err) {
		console.error('[scene-capture] decode failed', err);
		setError('That isn’t a valid point cloud', INVALID_PLY);
	}
}

async function loadFromUrl(url, label, extra) {
	let parsed;
	try { parsed = new URL(url, location.href); } catch { setError('That doesn’t look like a URL', url); return; }
	setLoading('Fetching point cloud…', parsed.hostname);
	try {
		const res = await fetch(parsed.href);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const buffer = await res.arrayBuffer();
		renderBuffer(buffer, label || 'Point cloud', parsed.pathname.split('/').pop() || 'scene.ply', extra);
	} catch (err) {
		console.error('[scene-capture] fetch failed', err);
		setError('Couldn’t fetch that point cloud', `${err.message}. The host may block cross-origin reads (CORS).`);
	}
}

async function loadFromFile(file) {
	setLoading('Reading file…', file.name);
	try {
		const buffer = await file.arrayBuffer();
		renderBuffer(buffer, file.name.replace(/\.ply$/i, ''), file.name);
	} catch (err) {
		setError('Couldn’t read that file', err.message);
	}
}

function saveScreenshot() {
	const url = viewer?.screenshot();
	if (!url) return;
	const a = document.createElement('a');
	a.href = url;
	a.download = `scene-${Date.now()}.png`;
	a.click();
}

function loadSample() {
	setLoading('Building sample cloud…', 'Synthetic interior · monochrome');
	const v = ensureViewer();
	const { positions, colors, count } = sampleRoomCloud();
	v.setGeometryFromArrays(positions, colors);
	setLive(`Synthetic interior · ${fmt(count)} points`);
	setDownload(null);
	$('#pc-size').disabled = false;
}

// ── reconstruction job (real backend) ─────────────────────────────────────────
const POLL_INTERVAL_MS = 3000;
const MAX_POLL_MISSES = 8;      // ~24s of unreadable polls before we say so
const POLL_DEADLINE_MS = 20 * 60 * 1000;

function stopPolling() {
	if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
	if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
}

function processingCopy(seconds, eta) {
	// Honest, changing stage hints keyed to elapsed time — no fake progress bar.
	const stage = seconds < 8 ? 'Sampling frames and warming the model…'
		: seconds < 25 ? 'Streaming geometry — grounding coordinates and correcting drift…'
		: 'Fusing world points into a dense cloud…';
	const etaTxt = eta ? ` · ~${eta}s typical` : '';
	setLoading(`Reconstructing · ${seconds}s`, `${stage}${etaTxt}`);
}

// Upload a local video to R2 via a presigned PUT, then return its public URL so
// the capture job can be submitted with it. Mirrors the forge-upload flow.
async function uploadVideo(file) {
	setLoading('Uploading video…', `${file.name} · ${(file.size / 1024 / 1024).toFixed(1)} MB`);
	const presignRes = await fetch('/api/scene-upload', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ content_type: file.type, size_bytes: file.size }),
	});
	const presign = await presignRes.json().catch(() => ({}));
	if (presignRes.status === 503) {
		throw new Error(presign.message || 'Video upload is not configured here. Paste a public video URL instead.');
	}
	if (!presignRes.ok) throw new Error(presign.message || `Upload could not start (HTTP ${presignRes.status}).`);

	const put = await fetch(presign.upload_url, {
		method: 'PUT',
		headers: presign.headers || { 'content-type': file.type },
		body: file,
	});
	if (!put.ok) throw new Error(`Upload failed (HTTP ${put.status}).`);
	return presign.public_url;
}

async function startCaptureFromFile(file) {
	stopPolling();
	$('#pc-run').disabled = true;
	$('#pc-video-pick').disabled = true;
	let url;
	try {
		url = await uploadVideo(file);
	} catch (err) {
		setError('Couldn’t upload that video', err.message);
		$('#pc-run').disabled = false;
		$('#pc-video-pick').disabled = false;
		return;
	}
	$('#pc-url').value = url;
	$('#pc-video-pick').disabled = false;
	startCapture();
}

async function startCapture() {
	const url = $('#pc-url').value.trim();
	if (!url) { $('#pc-url').focus(); return; }

	stopPolling();
	$('#pc-run').disabled = true;
	setDownload(null);
	$('#pc-size').disabled = true;
	setLoading('Submitting…', 'Validating the video URL.');

	const params = {
		video_url: url,
		mode: $('#pc-mode').value,
		fps: Number($('#pc-fps').value) || 8,
		keyframe_interval: Number($('#pc-kf').value) || 4,
		mask_sky: $('#pc-sky').checked,
	};

	let started;
	try {
		const res = await fetch('/api/scene-capture', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(params),
		});
		started = await res.json().catch(() => ({}));
		if (res.status === 503) {
			setError('Scene capture isn’t live here', `${started.message || 'The reconstruction worker is not configured on this deployment.'} You can still load a .ply by URL or upload, or try the sample.`);
			$('#pc-run').disabled = false;
			return;
		}
		if (!res.ok) throw new Error(started.message || `HTTP ${res.status}`);
	} catch (err) {
		setError('Couldn’t start reconstruction', err.message);
		$('#pc-run').disabled = false;
		return;
	}

	const jobId = started.job_id;
	const eta = started.eta_seconds || 0;
	const t0 = Date.now();
	processingCopy(0, eta);
	elapsedTimer = setInterval(() => {
		processingCopy(Math.round((Date.now() - t0) / 1000), eta);
	}, 1000);

	// A job that never resolves must not poll forever behind a counter that only
	// climbs. Give up after a run of unreadable polls or past the wall clock.
	let misses = 0;
	const giveUp = (title, sub) => {
		stopPolling();
		$('#pc-run').disabled = false;
		setError(title, sub);
	};

	const poll = async () => {
		if (Date.now() - t0 > POLL_DEADLINE_MS) {
			giveUp('Reconstruction timed out', `The worker did not finish within ${Math.round(POLL_DEADLINE_MS / 60000)} minutes. Try a shorter clip, a lower sample FPS, or a wider keyframe interval.`);
			return;
		}
		let data;
		try {
			const res = await fetch(`/api/scene-capture?job=${encodeURIComponent(jobId)}`);
			data = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
			misses = 0;
		} catch (err) {
			if (++misses >= MAX_POLL_MISSES) {
				giveUp('Lost contact with the reconstruction', `${err.message}. The job may still be running; reload and paste the video URL again to restart it.`);
				return;
			}
			pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
			return;
		}
		if (data.status === 'done' && data.result_url) {
			stopPolling();
			$('#pc-run').disabled = false;
			const label = data.frames ? `Captured · ${fmt(data.frames)} frames` : 'Captured scene';
			// The worker caps a job at its frame budget. Say so, rather than let a
			// partial reconstruction pass for the whole clip.
			await loadFromUrl(data.result_url, label, data.frames_truncated ? 'clip truncated to the frame budget' : null);
			return;
		}
		if (data.status === 'failed') {
			giveUp('Reconstruction failed', data.error || 'The worker reported a failure. Try a shorter or steadier clip.');
			return;
		}
		pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
	};
	pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
}

// ── wiring ────────────────────────────────────────────────────────────────────
function init() {
	if (!STAGE()) return;

	$('#pc-run').addEventListener('click', startCapture);
	$('#pc-url').addEventListener('keydown', (e) => { if (e.key === 'Enter') startCapture(); });
	$('#pc-video-pick').addEventListener('click', () => $('#pc-video-file').click());
	$('#pc-video-file').addEventListener('change', (e) => {
		const file = e.target.files?.[0];
		if (file) startCaptureFromFile(file);
		e.target.value = '';
	});

	$('#pc-load-url').addEventListener('click', () => {
		const u = $('#pc-ply-url').value.trim();
		if (u) loadFromUrl(u);
	});
	$('#pc-ply-url').addEventListener('keydown', (e) => {
		if (e.key === 'Enter') { const u = e.target.value.trim(); if (u) loadFromUrl(u); }
	});

	$('#pc-pick').addEventListener('click', () => $('#pc-file').click());
	$('#pc-idle').addEventListener('click', () => $('#pc-file').click());
	$('#pc-file').addEventListener('change', (e) => {
		const file = e.target.files?.[0];
		if (file) loadFromFile(file);
		e.target.value = '';
	});

	$('#pc-sample').addEventListener('click', loadSample);
	$('#pc-error-retry').addEventListener('click', loadSample);
	$('#pc-recenter').addEventListener('click', () => viewer?.recenter());
	$('#pc-size').addEventListener('input', (e) => viewer?.setPointScale(Number(e.target.value)));
	$('#pc-color').addEventListener('click', () => { viewer?.cycleColorMode(); refreshStats(); });
	$('#pc-rotate').addEventListener('click', () => {
		const on = viewer?.toggleAutoRotate();
		$('#pc-rotate').classList.toggle('is-active', !!on);
	});
	$('#pc-shot').addEventListener('click', saveScreenshot);

	// Keyboard shortcuts (ignored while typing in an input/select).
	window.addEventListener('keydown', (e) => {
		const tag = (e.target.tagName || '').toLowerCase();
		if (tag === 'input' || tag === 'select' || tag === 'textarea' || e.metaKey || e.ctrlKey) return;
		if (!viewer || $('#pc-hud').hidden) return;
		const k = e.key.toLowerCase();
		if (k === 'r') viewer.recenter();
		else if (k === ' ') { e.preventDefault(); $('#pc-rotate').click(); }
		else if (k === 'c') $('#pc-color').click();
		else if (k === 's') saveScreenshot();
		else if (k === '[' || k === ']') {
			const s = $('#pc-size');
			s.value = String(Math.min(4, Math.max(0.25, Number(s.value) + (k === ']' ? 0.25 : -0.25))));
			s.dispatchEvent(new Event('input', { bubbles: true }));
		}
	});

	// Drag & drop a .ply onto the stage.
	const stage = STAGE();
	['dragenter', 'dragover'].forEach((ev) => stage.addEventListener(ev, (e) => {
		e.preventDefault(); stage.classList.add('is-dragover');
	}));
	stage.addEventListener('dragleave', (e) => { if (e.target === stage) stage.classList.remove('is-dragover'); });
	stage.addEventListener('drop', (e) => {
		e.preventDefault(); stage.classList.remove('is-dragover');
		const file = e.dataTransfer?.files?.[0];
		if (file) loadFromFile(file);
	});

	// Deep links: ?src=<ply-url> renders directly; ?video=<url> pre-fills capture.
	// ?embed=1 strips the chrome for the MCP / agent point-cloud artifact iframe.
	const p = new URLSearchParams(location.search);
	if (p.get('embed') === '1') document.body.classList.add('pc-embed');
	if (p.get('src')) { $('#pc-ply-url').value = p.get('src'); loadFromUrl(p.get('src'), p.get('name') || undefined); }
	if (p.get('video')) $('#pc-url').value = p.get('video');

	window.addEventListener('beforeunload', () => { stopPolling(); setDownload(null); viewer?.dispose(); });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
