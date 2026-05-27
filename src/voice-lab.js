const $ = (id) => document.getElementById(id);

// ── Reading scripts ──────────────────────────────────────────────────────────

const SCRIPTS = [
	"Welcome to three.ws, the home of agentic 3D characters. I'm recording my voice to create a digital clone that will bring my avatar to life. This voice will power real-time conversations and text-to-speech synthesis across the platform.",
	"The quick brown fox jumps over the lazy dog. She sells seashells by the seashore. Peter Piper picked a peck of pickled peppers. How much wood would a woodchuck chuck if a woodchuck could chuck wood?",
	"Technology should serve people, not the other way around. When we build tools that feel intuitive and accessible, everyone benefits. The future of human-computer interaction lies in natural, conversational interfaces — less like commanding a machine, more like talking to a friend.",
	"Three dot ws uses WebGL and Three.js to render real-time 3D avatars directly in the browser. Combined with instant voice cloning, speech recognition, and AI-powered conversation, we create fully interactive digital characters that can see, hear, and respond to people naturally.",
];

// ── Voice library (localStorage) ─────────────────────────────────────────────

const STORAGE_KEY = 'voicelab_voices_v1';

function loadVoices() {
	try {
		return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
	} catch { return []; }
}

function saveVoices(voices) {
	try { localStorage.setItem(STORAGE_KEY, JSON.stringify(voices)); } catch {}
}

function addVoice(voice) {
	const voices = loadVoices();
	voices.unshift(voice);
	if (voices.length > 20) voices.length = 20;
	saveVoices(voices);
}

function removeVoice(voiceId) {
	const voices = loadVoices().filter((v) => v.voiceId !== voiceId);
	saveVoices(voices);
}

// ── State ────────────────────────────────────────────────────────────────────

let state = 'idle';
let mediaStream = null;
let recorder = null;
let audioCtx = null;
let analyser = null;
let recordedBlob = null;
let recordedUrl = null;
let startTs = 0;
let rafId = 0;
let scriptIdx = 0;
let lastClonedVoiceId = null;

const MAX_RECORD_S = 60;
const RECOMMENDED_S = 25;

// ── Canvas setup ─────────────────────────────────────────────────────────────

const canvas = $('waveCanvas');
const ctx = canvas.getContext('2d');
let cW = 0;
let cH = 0;

function fitCanvas() {
	const dpr = window.devicePixelRatio || 1;
	cW = canvas.clientWidth;
	cH = canvas.clientHeight;
	canvas.width = cW * dpr;
	canvas.height = cH * dpr;
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
fitCanvas();
window.addEventListener('resize', fitCanvas);

// ── Level meter setup ────────────────────────────────────────────────────────

const levelMeter = $('levelMeter');
const LEVEL_BARS = 8;
for (let i = 0; i < LEVEL_BARS; i++) {
	const bar = document.createElement('div');
	bar.className = 'vl-level-bar';
	bar.style.height = '3px';
	levelMeter.appendChild(bar);
}

// ── Waveform visualization ───────────────────────────────────────────────────

const BAR_COUNT = 64;
let idlePhase = 0;
let smoothBars = new Float32Array(BAR_COUNT);

function roundRect(x, y, w, h, r) {
	if (ctx.roundRect) {
		ctx.roundRect(x, y, w, h, r);
	} else {
		ctx.moveTo(x + r, y);
		ctx.arcTo(x + w, y, x + w, y + h, r);
		ctx.arcTo(x + w, y + h, x, y + h, r);
		ctx.arcTo(x, y + h, x, y, r);
		ctx.arcTo(x, y, x + w, y, r);
		ctx.closePath();
	}
}

function lerpColor(t) {
	const r = Math.round(61 + t * (167 - 61));
	const g = Math.round(193 + t * (139 - 193));
	const b = 255;
	return `rgba(${r},${g},${b},`;
}
const barColors = Array.from({ length: BAR_COUNT }, (_, i) => lerpColor(i / BAR_COUNT));

function drawIdle() {
	idlePhase += 0.015;
	ctx.clearRect(0, 0, cW, cH);

	const centerY = cH / 2;
	const totalW = cW * 0.85;
	const startX = (cW - totalW) / 2;
	const barW = (totalW / BAR_COUNT) * 0.65;
	const gap = (totalW / BAR_COUNT) * 0.35;

	for (let i = 0; i < BAR_COUNT; i++) {
		const t = i / BAR_COUNT;
		const ambient = (Math.sin(idlePhase + t * 6) * 0.5 + 0.5) * 0.08 + 0.02;
		smoothBars[i] += (ambient - smoothBars[i]) * 0.08;
		const h = smoothBars[i] * centerY;
		const x = startX + i * (barW + gap);
		const alpha = 0.4 + smoothBars[i] * 3;

		ctx.fillStyle = barColors[i] + alpha + ')';
		ctx.beginPath();
		roundRect(x, centerY - h, barW, h, 2);
		ctx.fill();
		ctx.beginPath();
		roundRect(x, centerY + 1, barW, h, 2);
		ctx.fill();
	}
}

function drawLive() {
	if (!analyser) return;
	const data = new Uint8Array(analyser.frequencyBinCount);
	analyser.getByteFrequencyData(data);

	ctx.clearRect(0, 0, cW, cH);

	const centerY = cH / 2;
	const totalW = cW * 0.85;
	const startX = (cW - totalW) / 2;
	const barW = (totalW / BAR_COUNT) * 0.65;
	const gap = (totalW / BAR_COUNT) * 0.35;
	const binsPerBar = Math.floor(data.length / BAR_COUNT);

	let rmsSum = 0;

	for (let i = 0; i < BAR_COUNT; i++) {
		let sum = 0;
		const start = i * binsPerBar;
		for (let j = start; j < start + binsPerBar; j++) sum += data[j];
		const raw = (sum / binsPerBar) / 255;
		rmsSum += raw * raw;
		smoothBars[i] += (raw - smoothBars[i]) * 0.25;
		const val = smoothBars[i];
		const h = Math.max(2, val * centerY * 0.92);
		const x = startX + i * (barW + gap);
		const alpha = 0.5 + val * 0.5;

		ctx.fillStyle = barColors[i] + alpha + ')';
		ctx.beginPath();
		roundRect(x, centerY - h, barW, h, 2);
		ctx.fill();
		ctx.beginPath();
		roundRect(x, centerY + 1, barW, h, 2);
		ctx.fill();
	}

	updateLevelMeter(Math.sqrt(rmsSum / BAR_COUNT));
}

function updateLevelMeter(rms) {
	const bars = levelMeter.children;
	for (let i = 0; i < LEVEL_BARS; i++) {
		const threshold = (i + 1) / LEVEL_BARS;
		const active = rms > threshold * 0.6;
		const h = active ? Math.min(20, 4 + rms * 20) : 3;
		bars[i].style.height = h + 'px';
		if (i >= LEVEL_BARS - 2 && active) {
			bars[i].style.background = '#ef4444';
		} else if (i >= LEVEL_BARS - 4 && active) {
			bars[i].style.background = '#fbbf24';
		} else {
			bars[i].style.background = '#3dc1ff';
		}
	}
}

function animationLoop() {
	rafId = requestAnimationFrame(animationLoop);
	if (state === 'recording' && analyser) {
		drawLive();
		updateTimer();
	} else {
		drawIdle();
	}
}
animationLoop();

// ── Timer ────────────────────────────────────────────────────────────────────

function updateTimer() {
	const elapsed = (performance.now() - startTs) / 1000;
	const m = Math.floor(elapsed / 60);
	const s = Math.floor(elapsed % 60);
	$('timer').textContent = `${m}:${s.toString().padStart(2, '0')}`;

	const pct = Math.min(100, (elapsed / RECOMMENDED_S) * 100);
	$('progress').style.width = pct + '%';

	if (elapsed >= RECOMMENDED_S) {
		$('timerSub').textContent = 'Great length! You can stop whenever you\'re ready.';
		$('timerSub').style.color = '#34d399';
	} else {
		const remaining = Math.ceil(RECOMMENDED_S - elapsed);
		$('timerSub').textContent = `${remaining}s more recommended`;
		$('timerSub').style.color = '';
	}

	if (elapsed >= MAX_RECORD_S) {
		setStatus('info', `Reached ${MAX_RECORD_S}s limit — stopping automatically.`);
		stopRecording();
	}
}

// ── Scripts ──────────────────────────────────────────────────────────────────

function renderScript() {
	$('scriptText').textContent = `"${SCRIPTS[scriptIdx]}"`;
	const dotsEl = $('scriptDots');
	dotsEl.innerHTML = '';
	for (let i = 0; i < SCRIPTS.length; i++) {
		const dot = document.createElement('div');
		dot.className = 'vl-script-dot' + (i === scriptIdx ? ' active' : '');
		dotsEl.appendChild(dot);
	}
}
renderScript();

$('scriptNext').addEventListener('click', () => {
	scriptIdx = (scriptIdx + 1) % SCRIPTS.length;
	renderScript();
});

// ── Recording ────────────────────────────────────────────────────────────────

function pickMime() {
	const candidates = [
		'audio/webm;codecs=opus',
		'audio/webm',
		'audio/ogg;codecs=opus',
		'audio/mp4',
	];
	for (const m of candidates) {
		if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
	}
	return '';
}

async function startRecording() {
	try {
		mediaStream = await navigator.mediaDevices.getUserMedia({
			audio: {
				channelCount: 1,
				echoCancellation: true,
				noiseSuppression: true,
				autoGainControl: true,
				sampleRate: 48000,
			},
		});
	} catch (err) {
		setStatus('err', `Microphone access denied: ${err.message}`);
		return;
	}

	audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
	const src = audioCtx.createMediaStreamSource(mediaStream);
	analyser = audioCtx.createAnalyser();
	analyser.fftSize = 2048;
	analyser.smoothingTimeConstant = 0.75;
	src.connect(analyser);

	const mime = pickMime();
	const chunks = [];
	try {
		recorder = mime
			? new MediaRecorder(mediaStream, { mimeType: mime })
			: new MediaRecorder(mediaStream);
	} catch (err) {
		setStatus('err', `Could not start recorder: ${err.message}`);
		return;
	}

	recorder.ondataavailable = (e) => {
		if (e.data?.size) chunks.push(e.data);
	};
	recorder.onstop = () => {
		const blobMime = recorder.mimeType || mime || 'audio/webm';
		recordedBlob = new Blob(chunks, { type: blobMime });
		if (recordedUrl) URL.revokeObjectURL(recordedUrl);
		recordedUrl = URL.createObjectURL(recordedBlob);
		$('reviewAudio').src = recordedUrl;

		const elapsed = (performance.now() - startTs) / 1000;
		if (elapsed < 3) {
			setStatus('err', 'Recording too short. Please record at least 3 seconds.');
			setState('idle');
			return;
		}

		setStatus('ok', `Captured ${(recordedBlob.size / 1024).toFixed(0)} KB (${Math.round(elapsed)}s). Review and clone below.`);
		setState('review');
	};

	recorder.start(250);
	startTs = performance.now();
	setState('recording');
	setStatus('info', 'Recording... read the script aloud or speak naturally.');
}

function stopRecording() {
	if (recorder?.state === 'recording') recorder.stop();
	mediaStream?.getTracks().forEach((t) => t.stop());
	audioCtx?.close().catch(() => {});
	analyser = null;
	audioCtx = null;
	mediaStream = null;
}

function resetRecording() {
	recordedBlob = null;
	if (recordedUrl) { URL.revokeObjectURL(recordedUrl); recordedUrl = null; }
	$('reviewAudio').removeAttribute('src');
	$('progress').style.width = '0%';
	$('timer').textContent = '0:00';
	$('timerSub').textContent = 'Recommended: 20-30 seconds';
	$('timerSub').style.color = '';
	smoothBars.fill(0);
	setState('idle');
	setStatus('info', 'Ready to record.');
}

// ── Clone ────────────────────────────────────────────────────────────────────

async function cloneVoice() {
	if (!recordedBlob) return;
	const name = $('voiceName').value.trim();
	if (!name) {
		setStatus('err', 'Enter a name for your voice.');
		$('voiceName').focus();
		return;
	}

	setState('cloning');
	setStatus('info', 'Uploading sample and cloning...');

	const ext = recordedBlob.type.includes('mp4') ? 'm4a'
		: recordedBlob.type.includes('ogg') ? 'ogg'
		: recordedBlob.type.includes('wav') ? 'wav'
		: 'webm';

	const fd = new FormData();
	fd.append('audio', recordedBlob, `sample.${ext}`);
	fd.append('name', name);

	let res;
	try {
		res = await fetch('/api/tts/eleven-clone', {
			method: 'POST',
			credentials: 'include',
			body: fd,
		});
	} catch (err) {
		setStatus('err', `Network error: ${err.message}`);
		setState('review');
		return;
	}

	let body;
	try {
		body = await res.json();
	} catch {
		body = { error_description: await res.text().catch(() => '') };
	}

	if (!res.ok) {
		const msg = body.error_description || body.error || `HTTP ${res.status}`;
		setStatus('err', `Clone failed: ${msg}`);
		setState('review');
		return;
	}

	const voiceId = body.voice_id;
	lastClonedVoiceId = voiceId;

	addVoice({
		voiceId,
		name,
		createdAt: Date.now(),
		status: body.status || 'ready',
	});

	$('doneText').textContent = `"${name}" cloned successfully`;
	setStatus('ok', `Voice cloned. ID: ${voiceId}`);
	setState('done');
	renderLibrary();
	renderPlaygroundVoices();
}

// ── State machine ────────────────────────────────────────────────────────────

function setState(newState) {
	state = newState;
	$('recorder').dataset.state = newState;
}

function setStatus(type, text) {
	const el = $('status');
	el.className = 'vl-status' + (type !== 'info' ? ` ${type}` : '');
	el.textContent = text;
}

// ── Voice library rendering ──────────────────────────────────────────────────

function renderLibrary() {
	const voices = loadVoices();
	const container = $('voiceLibrary');

	if (!voices.length) {
		container.innerHTML = `
			<div class="vl-empty">
				<div class="vl-empty-title">No cloned voices yet</div>
				Record a voice sample above to get started.
			</div>`;
		return;
	}

	container.innerHTML = `<div class="vl-voices">${
		voices.map((v) => {
			const age = timeAgo(v.createdAt);
			return `
				<div class="vl-voice-card" data-vid="${esc(v.voiceId)}">
					<div class="vl-voice-name">${esc(v.name)}</div>
					<div class="vl-voice-meta">
						<span>${age}</span>
					</div>
					<div class="vl-voice-id">${esc(v.voiceId)}</div>
					<div class="vl-voice-actions">
						<button class="vl-btn vl-btn-ghost vl-btn-sm" data-play="${esc(v.voiceId)}">Play sample</button>
						<button class="vl-btn vl-btn-danger vl-btn-sm" data-del="${esc(v.voiceId)}">Remove</button>
					</div>
				</div>`;
		}).join('')
	}</div>`;
}

function esc(s) {
	return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function timeAgo(ts) {
	const diff = Date.now() - ts;
	if (diff < 60000) return 'Just now';
	if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
	if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
	return `${Math.floor(diff / 86400000)}d ago`;
}

// ── Playground ───────────────────────────────────────────────────────────────

function renderPlaygroundVoices() {
	const voices = loadVoices();
	const sel = $('pgVoice');
	const prev = sel.value;

	sel.innerHTML = '';
	if (!voices.length) {
		sel.innerHTML = '<option value="" disabled selected>Clone a voice first</option>';
		$('pgSpeak').disabled = true;
		return;
	}

	voices.forEach((v) => {
		const opt = document.createElement('option');
		opt.value = v.voiceId;
		opt.textContent = v.name;
		sel.appendChild(opt);
	});

	if (lastClonedVoiceId && voices.find((v) => v.voiceId === lastClonedVoiceId)) {
		sel.value = lastClonedVoiceId;
	} else if (prev && voices.find((v) => v.voiceId === prev)) {
		sel.value = prev;
	} else {
		sel.value = voices[0].voiceId;
	}

	$('pgSpeak').disabled = false;
}

async function speakPlayground() {
	const voiceId = $('pgVoice').value;
	const text = $('pgText').value.trim();
	if (!voiceId || !text) return;

	$('pgSpeak').disabled = true;
	$('pgHint').textContent = 'Synthesizing...';

	try {
		const r = await fetch('/api/tts/eleven', {
			method: 'POST',
			credentials: 'include',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ voiceId, text }),
		});

		if (!r.ok) {
			const errText = await r.text().catch(() => '');
			throw new Error(`HTTP ${r.status}: ${errText.slice(0, 200)}`);
		}

		const cacheHit = r.headers.get('x-tts-cache') === 'hit';
		const buf = await r.arrayBuffer();
		const blob = new Blob([buf], { type: 'audio/mpeg' });
		const url = URL.createObjectURL(blob);

		const audio = $('pgAudio');
		if (audio.src) URL.revokeObjectURL(audio.src);
		audio.src = url;
		$('pgOutput').classList.add('visible');
		audio.play().catch(() => {});

		$('pgHint').textContent = `${(buf.byteLength / 1024).toFixed(0)} KB · ${cacheHit ? 'cached' : 'generated'}`;
	} catch (err) {
		$('pgHint').textContent = `Error: ${err.message}`;
	} finally {
		$('pgSpeak').disabled = false;
	}
}

async function playVoiceSample(voiceId) {
	const voice = loadVoices().find((v) => v.voiceId === voiceId);
	if (!voice) return;

	const btn = document.querySelector(`[data-play="${voiceId}"]`);
	if (btn) { btn.disabled = true; btn.textContent = 'Loading...'; }

	try {
		const r = await fetch('/api/tts/eleven', {
			method: 'POST',
			credentials: 'include',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				voiceId,
				text: "Hello, I'm your cloned voice. How does this sound?",
			}),
		});
		if (!r.ok) throw new Error(`HTTP ${r.status}`);
		const blob = await r.blob();
		const audio = new Audio(URL.createObjectURL(blob));
		audio.onended = () => URL.revokeObjectURL(audio.src);
		audio.play();
	} catch (err) {
		setStatus('err', `Playback failed: ${err.message}`);
	} finally {
		if (btn) { btn.disabled = false; btn.textContent = 'Play sample'; }
	}
}

function deleteVoice(voiceId) {
	removeVoice(voiceId);
	renderLibrary();
	renderPlaygroundVoices();
	setStatus('info', 'Voice removed from library.');
}

// ── Event wiring ─────────────────────────────────────────────────────────────

$('btnRecord').addEventListener('click', startRecording);
$('btnStop').addEventListener('click', stopRecording);
$('btnRerecord').addEventListener('click', resetRecording);
$('btnClone').addEventListener('click', cloneVoice);

$('btnTryPlayground').addEventListener('click', () => {
	$('playgroundSection').scrollIntoView({ behavior: 'smooth', block: 'center' });
});
$('btnRecordAnother').addEventListener('click', resetRecording);

$('pgSpeak').addEventListener('click', speakPlayground);

$('pgText').addEventListener('keydown', (e) => {
	if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
		e.preventDefault();
		speakPlayground();
	}
});

document.querySelectorAll('.vl-pg-sample').forEach((btn) => {
	btn.addEventListener('click', () => {
		$('pgText').value = btn.dataset.text;
	});
});

$('voiceLibrary').addEventListener('click', (e) => {
	const playBtn = e.target.closest('[data-play]');
	if (playBtn) { playVoiceSample(playBtn.dataset.play); return; }
	const delBtn = e.target.closest('[data-del]');
	if (delBtn) { deleteVoice(delBtn.dataset.del); }
});

$('pgVoice').addEventListener('change', () => {
	$('pgSpeak').disabled = !$('pgVoice').value;
});

// Keyboard shortcut: Space to toggle record/stop when not in an input
document.addEventListener('keydown', (e) => {
	if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
	if (e.code === 'Space') {
		e.preventDefault();
		if (state === 'idle') startRecording();
		else if (state === 'recording') stopRecording();
	}
});

// ── Init ─────────────────────────────────────────────────────────────────────

renderLibrary();
renderPlaygroundVoices();

// Auto-populate voice name with a sensible default
const now = new Date();
$('voiceName').value = `My Voice ${now.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
