// VoiceRecorder — inline editor section for recording and cloning an agent's voice.
//
// Usage:
//   const recorder = new VoiceRecorder(containerEl, { agentId: '...', agentName: '...' });
//   recorder.mount();   // renders into containerEl
//   recorder.destroy(); // removes listeners + DOM

import { apiFetch } from '../api.js';

const MIN_DURATION = 30; // seconds — warn if below this
const SAMPLE_TEXT = "Hello, I'm your agent. How can I help you today?";

const CSS = `
.vr-section {
	font-family: system-ui, -apple-system, sans-serif;
	color: #f9fafb;
	background: rgba(17, 24, 39, 0.85);
	border: 1px solid rgba(255,255,255,0.1);
	border-radius: 12px;
	padding: 16px 20px;
	margin: 12px 0;
}
.vr-section h3 {
	margin: 0 0 4px;
	font-size: 14px;
	font-weight: 600;
	letter-spacing: 0.02em;
}
.vr-section .vr-sub {
	margin: 0 0 14px;
	font-size: 12px;
	opacity: 0.55;
}
.vr-controls {
	display: flex;
	align-items: center;
	gap: 10px;
	flex-wrap: wrap;
}
.vr-btn {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	padding: 8px 16px;
	border: 0;
	border-radius: 8px;
	font: 600 13px system-ui, sans-serif;
	cursor: pointer;
	transition: opacity 0.12s;
}
.vr-btn:disabled { opacity: 0.4; cursor: default; }
.vr-btn:not(:disabled):hover { opacity: 0.85; }
.vr-btn.primary { background: #3b82f6; color: #fff; }
.vr-btn.danger  { background: #ef4444; color: #fff; }
.vr-btn.ghost   { background: rgba(255,255,255,0.08); color: #f9fafb; border: 1px solid rgba(255,255,255,0.15); }
.vr-timer {
	font: 600 16px/1 'SF Mono', 'Fira Mono', monospace;
	color: #f9fafb;
	min-width: 52px;
	display: none;
}
.vr-timer.active { display: block; }
.vr-timer.warn   { color: #f59e0b; }
.vr-status {
	font-size: 12px;
	margin-top: 10px;
	min-height: 18px;
	display: flex;
	align-items: center;
	gap: 6px;
}
.vr-status .spin {
	width: 12px; height: 12px;
	border-radius: 50%;
	border: 2px solid rgba(255,255,255,0.2);
	border-top-color: #3b82f6;
	animation: vr-spin 0.9s linear infinite;
	flex-shrink: 0;
}
@keyframes vr-spin { to { transform: rotate(360deg); } }
.vr-status.ok   { color: #4ade80; }
.vr-status.err  { color: #f87171; }
.vr-status.info { color: #94a3b8; }
.vr-current {
	font-size: 12px;
	margin-top: 10px;
	padding: 8px 12px;
	background: rgba(59,130,246,0.12);
	border: 1px solid rgba(59,130,246,0.3);
	border-radius: 8px;
	display: none;
}
.vr-current.visible { display: block; }
.vr-current .label { opacity: 0.55; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; }
`;

export class VoiceRecorder {
	constructor(containerEl, { agentId, agentName = 'Agent' } = {}) {
		this._container = containerEl;
		this._agentId = agentId;
		this._agentName = agentName;

		this._recorder = null;
		this._chunks = [];
		this._recording = false;
		this._startTime = 0;
		this._timerRaf = null;

		// Current cloned state (fetched on mount)
		this._voiceId = null;
		this._voiceProvider = 'browser';

		// DOM refs (set after mount)
		this._el = null;
		this._btnRecord = null;
		this._btnStop = null;
		this._btnRemove = null;
		this._btnPlay = null;
		this._timerEl = null;
		this._statusEl = null;
		this._currentEl = null;
	}

	async mount() {
		this._injectStyle();
		this._el = document.createElement('div');
		this._el.className = 'vr-section';
		this._el.innerHTML = `
			<h3>Voice Clone</h3>
			<p class="vr-sub">Record 30–60 seconds of speech to give this agent a unique voice.</p>
			<div class="vr-controls">
				<button class="vr-btn primary" data-ref="record">Record</button>
				<button class="vr-btn danger" data-ref="stop" disabled>Stop &amp; Clone</button>
				<span class="vr-timer" data-ref="timer">0:00</span>
			</div>
			<div class="vr-current" data-ref="current">
				<div class="label">Current voice</div>
				<div data-ref="currentLabel"></div>
			</div>
			<div class="vr-status info" data-ref="status"></div>
		`;
		this._container.appendChild(this._el);

		this._btnRecord = this._el.querySelector('[data-ref="record"]');
		this._btnStop = this._el.querySelector('[data-ref="stop"]');
		this._timerEl = this._el.querySelector('[data-ref="timer"]');
		this._statusEl = this._el.querySelector('[data-ref="status"]');
		this._currentEl = this._el.querySelector('[data-ref="current"]');
		this._currentLabelEl = this._el.querySelector('[data-ref="currentLabel"]');

		this._btnRecord.addEventListener('click', () => this._startRecording());
		this._btnStop.addEventListener('click', () => this._stopAndClone());

		await this._fetchStatus();
	}

	destroy() {
		this._stopTimer();
		if (this._recorder && this._recording) {
			try { this._recorder.stop(); } catch {}
		}
		this._el?.remove();
		this._el = null;
	}

	// ── Private ──────────────────────────────────────────────────────────────

	_injectStyle() {
		const id = 'vr-styles';
		if (!document.getElementById(id)) {
			const s = document.createElement('style');
			s.id = id;
			s.textContent = CSS;
			document.head.appendChild(s);
		}
	}

	async _fetchStatus() {
		if (!this._agentId) return;
		try {
			const res = await fetch(`/api/agents/${this._agentId}/voice`, { credentials: 'include' });
			if (!res.ok) return;
			const data = await res.json();
			this._voiceId = data.voice_id;
			this._voiceProvider = data.voice_provider;
			this._renderCurrentVoice();
		} catch {}
	}

	_renderCurrentVoice() {
		if (this._voiceId && this._voiceProvider === 'elevenlabs') {
			this._currentEl.classList.add('visible');
			this._currentLabelEl.innerHTML = `
				Cloned voice (ElevenLabs)
				<button class="vr-btn ghost" style="margin-left:8px;padding:4px 10px;font-size:11px" data-ref="play">Play sample</button>
				<button class="vr-btn danger" style="margin-left:6px;padding:4px 10px;font-size:11px" data-ref="remove">Remove</button>
			`;
			this._currentLabelEl.querySelector('[data-ref="play"]')
				?.addEventListener('click', () => this._playSample());
			this._currentLabelEl.querySelector('[data-ref="remove"]')
				?.addEventListener('click', () => this._removeVoice());
		} else {
			this._currentEl.classList.remove('visible');
		}
	}

	async _startRecording() {
		let stream;
		try {
			stream = await navigator.mediaDevices.getUserMedia({ audio: true });
		} catch {
			this._setStatus('err', 'Microphone access denied.');
			return;
		}

		this._chunks = [];
		const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
			? 'audio/webm;codecs=opus'
			: MediaRecorder.isTypeSupported('audio/webm')
				? 'audio/webm'
				: '';

		this._recorder = mimeType
			? new MediaRecorder(stream, { mimeType })
			: new MediaRecorder(stream);

		this._recorder.ondataavailable = (e) => {
			if (e.data.size > 0) this._chunks.push(e.data);
		};

		this._recorder.start(250); // collect in 250ms chunks
		this._recording = true;
		this._startTime = Date.now();

		this._btnRecord.disabled = true;
		this._btnStop.disabled = false;
		this._timerEl.classList.add('active');
		this._setStatus('info', 'Recording… speak naturally for 30–60 seconds.');
		this._startTimer();
	}

	_startTimer() {
		const tick = () => {
			if (!this._recording) return;
			const elapsed = (Date.now() - this._startTime) / 1000;
			const m = Math.floor(elapsed / 60);
			const s = Math.floor(elapsed % 60);
			this._timerEl.textContent = `${m}:${s.toString().padStart(2, '0')}`;
			this._timerEl.classList.toggle('warn', elapsed < MIN_DURATION);
			this._timerRaf = requestAnimationFrame(tick);
		};
		this._timerRaf = requestAnimationFrame(tick);
	}

	_stopTimer() {
		if (this._timerRaf) {
			cancelAnimationFrame(this._timerRaf);
			this._timerRaf = null;
		}
	}

	async _stopAndClone() {
		if (!this._recorder || !this._recording) return;

		const durationSec = (Date.now() - this._startTime) / 1000;
		this._recording = false;
		this._stopTimer();

		await new Promise((resolve) => {
			this._recorder.onstop = resolve;
			this._recorder.stop();
			// Stop microphone tracks
			this._recorder.stream?.getTracks().forEach((t) => t.stop());
		});

		this._btnRecord.disabled = false;
		this._btnStop.disabled = true;
		this._timerEl.classList.remove('active', 'warn');

		if (durationSec < MIN_DURATION) {
			this._setStatus('err', `Recording too short (${Math.round(durationSec)}s). Please record at least 30 seconds.`);
			return;
		}

		const mimeType = this._recorder.mimeType || 'audio/webm';
		const blob = new Blob(this._chunks, { type: mimeType });

		this._setStatus('spin', 'Cloning voice…');
		this._btnRecord.disabled = true;

		try {
			const url =
				`/api/agents/${this._agentId}/voice/clone` +
				`?name=${encodeURIComponent(this._agentName + ' Voice')}`;

			const res = await fetch(url, {
				method: 'POST',
				credentials: 'include',
				headers: {
					'content-type': mimeType,
					'x-recording-duration': String(Math.round(durationSec)),
				},
				body: blob,
			});

			if (!res.ok) {
				const err = await res.json().catch(() => ({}));
				const msg = err.error_description || `Error ${res.status}`;
				this._setStatus('err', msg);
				this._btnRecord.disabled = false;
				return;
			}

			const data = await res.json();
			this._voiceId = data.voice_id;
			this._voiceProvider = 'elevenlabs';
			this._setStatus('ok', 'Voice cloned successfully.');
			this._renderCurrentVoice();
		} catch {
			this._setStatus('err', 'Clone failed. Check your connection and try again.');
		} finally {
			this._btnRecord.disabled = false;
		}
	}

	async _playSample() {
		if (!this._voiceId) return;
		this._setStatus('spin', 'Generating sample…');
		try {
			const res = await fetch('/api/tts/eleven', {
				method: 'POST',
				credentials: 'include',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ voiceId: this._voiceId, text: SAMPLE_TEXT }),
			});
			if (!res.ok) {
				this._setStatus('err', 'Could not generate sample.');
				return;
			}
			const blob = await res.blob();
			const audio = new Audio(URL.createObjectURL(blob));
			audio.onended = () => URL.revokeObjectURL(audio.src);
			audio.play();
			this._setStatus('ok', 'Playing sample…');
		} catch {
			this._setStatus('err', 'Playback failed.');
		}
	}

	async _removeVoice() {
		if (!confirm('Remove this agent\'s cloned voice? It will revert to browser TTS.')) return;
		this._setStatus('spin', 'Removing voice…');
		try {
			const res = await apiFetch(`/api/agents/${this._agentId}/voice`, {
				method: 'DELETE',
				credentials: 'include',
			});
			if (!res.ok) {
				this._setStatus('err', 'Could not remove voice.');
				return;
			}
			this._voiceId = null;
			this._voiceProvider = 'browser';
			this._renderCurrentVoice();
			this._setStatus('info', 'Voice removed. Agent will use browser TTS.');
		} catch {
			this._setStatus('err', 'Remove failed.');
		}
	}

	_setStatus(type, text) {
		if (!this._statusEl) return;
		this._statusEl.className = `vr-status ${type}`;
		if (type === 'spin') {
			this._statusEl.innerHTML = `<span class="spin"></span>${text}`;
		} else {
			this._statusEl.textContent = text;
		}
	}
}
