// VoiceSetup — capture a voice sample and bind it to an agent.
//
// One component, two binding modes, because the two surfaces that need this
// have opposite timing:
//
//   bind: 'now'    — an agent already exists (the talk-mode clone modal, the
//                    editor). Recording or uploading clones immediately.
//   bind: 'later'  — the /create-agent wizard, where the agent does not exist
//                    until the ship step. The sample is held in memory and the
//                    host calls bindTo(agentId) once the agent is real.
//
// Credentials. Cloning is a paid ElevenLabs feature and there is no free lane
// (owner policy 2026-08-06), so the panel resolves which lane is open before it
// lets anyone record:
//
//   owner     — the user saved an ElevenLabs key at /dashboard/account. Their
//               ElevenLabs account is billed; no $THREE credits are spent.
//   platform  — the server has ELEVENLABS_API_KEY. Metered to $THREE credits.
//   none      — neither. The panel renders inline key entry (PATCH
//               /api/user/provider-keys, AES-256-GCM encrypted at rest) rather
//               than a dead "not configured" message.
//
// Every state here is designed: signed out, no key, recording, sample too short,
// sample too large, wrong file type, upstream provider failure, and bound.

import { apiFetch } from '../api.js';
import { log } from '../shared/log.js';

/** ElevenLabs Instant Voice Cloning needs a real sample, not a hello. */
export const MIN_SAMPLE_SECONDS = 30;
/** Matches MAX_AUDIO_BYTES in api/agents/_id/voice.js. */
export const MAX_SAMPLE_BYTES = 10 * 1024 * 1024;

const SCRIPT_LINE =
	"Hello, I'm building this agent on three.ws. I want it to speak with my own voice so it " +
	'can hold a real conversation. I will keep talking for about half a minute so the model has ' +
	'enough material to learn from, because the more natural my intonation is, the better the ' +
	'clone sounds when it answers someone.';

const KEY_HELP_URL = 'https://elevenlabs.io/app/settings/api-keys';

export class VoiceSetup {
	/**
	 * @param {HTMLElement} host
	 * @param {object} opts
	 * @param {'now'|'later'} [opts.bind='now']
	 * @param {string} [opts.agentId]    required for bind:'now'
	 * @param {string} [opts.agentName]  names the cloned voice in ElevenLabs
	 * @param {boolean} [opts.authed=true]  false renders the signed-out state
	 * @param {(state: {hasSample:boolean, seconds:number, bound:boolean}) => void} [opts.onChange]
	 */
	constructor(host, { bind = 'now', agentId = '', agentName = 'Agent', authed = true, onChange } = {}) {
		this.host = host;
		this.bindMode = bind;
		this.agentId = agentId;
		this.agentName = agentName;
		this.authed = authed;
		this.onChange = onChange || (() => {});

		/** @type {{blob: Blob, seconds: number, mimeType: string}|null} */
		this.sample = null;
		this.boundVoiceId = null;
		/** @type {'owner'|'platform'|null} */
		this.keySource = null;
		this.keyProbed = false;

		this._recorder = null;
		this._chunks = [];
		this._recording = false;
		this._startedAt = 0;
		this._timer = null;
		this._stream = null;
		this._destroyed = false;
		this._el = null;
	}

	async mount() {
		injectStylesOnce();
		this._el = document.createElement('div');
		this._el.className = 'vs-root';
		this.host.appendChild(this._el);
		this._render();
		if (this.authed) await this._probeKey();
	}

	destroy() {
		this._destroyed = true;
		this._stopTimer();
		this._releaseMic();
		this._el?.remove();
		this._el = null;
	}

	/** True once a usable sample is held (or a voice is already bound). */
	get ready() {
		return !!this.boundVoiceId || !!this.sample;
	}

	/**
	 * Clone the held sample onto a now-existing agent. Used by bind:'later' hosts
	 * after the agent is created.
	 * @param {string} agentId
	 * @returns {Promise<{voice_id:string, billing:string}>}
	 * @throws {Error & { code?: string }} with a user-facing message on failure.
	 */
	async bindTo(agentId) {
		if (!this.sample) throw new Error('No voice sample was recorded.');
		this.agentId = agentId;
		return this._clone(this.sample);
	}

	// ── Credential probe ─────────────────────────────────────────────────────

	async _probeKey() {
		try {
			const r = await apiFetch('/api/tts/eleven/voices', { allowAnonymous: true });
			if (r.status === 401) {
				this.authed = false;
			} else if (r.ok) {
				const j = await r.json().catch(() => ({}));
				this.keySource = j.enabled ? j.key_source || 'platform' : null;
			}
		} catch (err) {
			log.warn('[voice-setup] key probe failed', err?.message);
		}
		this.keyProbed = true;
		if (!this._destroyed) this._render();
	}

	async _saveKey(key) {
		const r = await apiFetch('/api/user/provider-keys', {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ elevenlabs: key }),
		});
		if (!r.ok) {
			const j = await r.json().catch(() => ({}));
			throw new Error(j.error_description || j.error || `Could not save the key (${r.status}).`);
		}
		this.keySource = 'owner';
	}

	// ── Rendering ────────────────────────────────────────────────────────────

	_render() {
		if (!this._el) return;
		// The previous render's preview URL is about to be detached with its
		// <audio> element; release it so repeated re-renders can't leak blobs.
		if (this._sampleUrl) {
			URL.revokeObjectURL(this._sampleUrl);
			this._sampleUrl = null;
		}
		this._el.innerHTML = `
			${this._credentialHtml()}
			${this._captureHtml()}
			<p class="vs-status" data-ref="status" role="status" aria-live="polite"></p>
		`;
		this._wire();
	}

	_credentialHtml() {
		if (!this.authed) {
			return `
				<div class="vs-note vs-note-info">
					<strong>Sign in to add a voice.</strong>
					Cloning runs against a real ElevenLabs account, so it needs to know whose.
					Everything else in this wizard keeps working while signed out, and your agent
					starts on the built-in voice.
				</div>`;
		}
		if (!this.keyProbed) {
			return `<div class="vs-note vs-note-info vs-skeleton">Checking which voice provider is available…</div>`;
		}
		if (this.keySource === 'owner') {
			return `
				<div class="vs-note vs-note-ok">
					<strong>Using your ElevenLabs key.</strong>
					Clones land in your own ElevenLabs account and are billed there, so no $THREE
					credits are spent. <a href="/dashboard/account">Manage key</a>
				</div>`;
		}
		if (this.keySource === 'platform') {
			return `
				<div class="vs-note vs-note-ok">
					<strong>Using the three.ws voice provider.</strong>
					Cloning is metered to your credit balance. Top up with $THREE at
					<a href="/credits">/credits</a>, or
					<button type="button" class="vs-link" data-ref="show-key">use your own ElevenLabs key</button>.
				</div>`;
		}
		return this._keyFormHtml();
	}

	_keyFormHtml() {
		return `
			<div class="vs-note vs-note-warn">
				<strong>Bring your ElevenLabs key.</strong>
				Voice cloning runs on ElevenLabs. Paste an API key from
				<a href="${KEY_HELP_URL}" target="_blank" rel="noopener">your ElevenLabs dashboard</a>
				and your agent speaks in the cloned voice everywhere on three.ws. The key is
				encrypted at rest and never shown again.
				<div class="vs-key-row">
					<input class="vs-key-input" data-ref="key" type="password" autocomplete="off"
						spellcheck="false" placeholder="sk_…" aria-label="ElevenLabs API key" />
					<button type="button" class="vs-btn primary" data-ref="save-key">Save key</button>
				</div>
			</div>`;
	}

	_captureHtml() {
		const canCapture = this.authed && !!this.keySource;
		if (this.boundVoiceId) {
			return `
				<div class="vs-note vs-note-ok">
					<strong>Voice bound.</strong> This agent now speaks in the cloned voice.
					<button type="button" class="vs-btn ghost" data-ref="reset">Record a different one</button>
				</div>`;
		}
		if (this.sample) {
			this._sampleUrl = URL.createObjectURL(this.sample.blob);
			return `
				<div class="vs-sample">
					<div class="vs-sample-head">
						<span class="vs-dot"></span>
						<strong>Sample ready</strong>
						<span class="vs-sample-meta">${formatSeconds(this.sample.seconds)} · ${formatBytes(this.sample.blob.size)}</span>
					</div>
					<audio class="vs-audio" controls src="${this._sampleUrl}"></audio>
					<div class="vs-controls">
						<button type="button" class="vs-btn ghost" data-ref="reset">Discard and redo</button>
						${this.bindMode === 'now' ? '<button type="button" class="vs-btn primary" data-ref="clone-now">Clone this voice</button>' : ''}
					</div>
					${this.bindMode === 'later' ? '<p class="vs-hint">Your voice is cloned and bound the moment the agent is created.</p>' : ''}
				</div>`;
		}
		return `
			<div class="vs-capture" ${canCapture ? '' : 'data-disabled="true"'}>
				<p class="vs-script-label">Read this out loud, at your normal pace:</p>
				<blockquote class="vs-script">${SCRIPT_LINE}</blockquote>
				<div class="vs-controls">
					<button type="button" class="vs-btn primary" data-ref="record" ${canCapture ? '' : 'disabled'}>
						Record ${MIN_SAMPLE_SECONDS}s
					</button>
					<button type="button" class="vs-btn danger" data-ref="stop" disabled hidden>Stop</button>
					<span class="vs-timer" data-ref="timer" hidden>0:00</span>
					<span class="vs-or">or</span>
					<label class="vs-btn ghost ${canCapture ? '' : 'is-disabled'}">
						Upload audio
						<input type="file" accept="audio/*" data-ref="file" ${canCapture ? '' : 'disabled'} hidden />
					</label>
				</div>
				<p class="vs-hint">
					At least ${MIN_SAMPLE_SECONDS} seconds, under ${Math.round(MAX_SAMPLE_BYTES / 1024 / 1024)} MB.
					Quiet room, one speaker, no music.
				</p>
			</div>`;
	}

	_wire() {
		const ref = (name) => this._el?.querySelector(`[data-ref="${name}"]`);

		ref('save-key')?.addEventListener('click', async () => {
			const input = /** @type {HTMLInputElement|null} */ (ref('key'));
			const value = input?.value.trim();
			if (!value) {
				this._status('err', 'Paste your ElevenLabs API key first.');
				input?.focus();
				return;
			}
			const btn = /** @type {HTMLButtonElement} */ (ref('save-key'));
			btn.disabled = true;
			btn.textContent = 'Saving…';
			try {
				await this._saveKey(value);
				this._render();
				this._status('ok', 'Key saved. You can record your voice now.');
			} catch (err) {
				btn.disabled = false;
				btn.textContent = 'Save key';
				this._status('err', err.message);
			}
		});

		ref('show-key')?.addEventListener('click', () => {
			this.keySource = null;
			this._render();
		});

		ref('record')?.addEventListener('click', () => this._startRecording());
		ref('stop')?.addEventListener('click', () => this._stopRecording());
		ref('file')?.addEventListener('change', (e) => {
			const file = /** @type {HTMLInputElement} */ (e.target).files?.[0];
			if (file) this._acceptFile(file);
		});
		ref('reset')?.addEventListener('click', () => {
			this.sample = null;
			this.boundVoiceId = null;
			this._render();
			this._emit();
		});
		ref('clone-now')?.addEventListener('click', () => this._cloneHeldSample());
	}

	_status(kind, text) {
		const el = this._el?.querySelector('[data-ref="status"]');
		if (!el) return;
		el.className = `vs-status ${kind}`;
		el.textContent = text;
	}

	_emit() {
		this.onChange({
			hasSample: !!this.sample,
			seconds: this.sample?.seconds || 0,
			bound: !!this.boundVoiceId,
		});
	}

	// ── Recording ────────────────────────────────────────────────────────────

	async _startRecording() {
		if (this._recording) return;
		let stream;
		try {
			stream = await navigator.mediaDevices.getUserMedia({ audio: true });
		} catch {
			this._status(
				'err',
				'Microphone blocked. Allow mic access in your browser, or upload an audio file instead.',
			);
			return;
		}
		this._stream = stream;
		this._chunks = [];

		const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find(
			(t) => window.MediaRecorder?.isTypeSupported?.(t),
		);
		this._recorder = mimeType
			? new MediaRecorder(stream, { mimeType })
			: new MediaRecorder(stream);
		this._recorder.ondataavailable = (e) => {
			if (e.data.size > 0) this._chunks.push(e.data);
		};
		this._recorder.start(250);
		this._recording = true;
		this._startedAt = Date.now();

		const ref = (n) => this._el?.querySelector(`[data-ref="${n}"]`);
		const record = /** @type {HTMLButtonElement} */ (ref('record'));
		const stop = /** @type {HTMLButtonElement} */ (ref('stop'));
		record.hidden = true;
		stop.hidden = false;
		stop.disabled = false;
		/** @type {HTMLElement} */ (ref('timer')).hidden = false;
		this._status('info', 'Recording. Speak naturally until the timer turns green.');
		this._startTimer();
	}

	_startTimer() {
		const el = this._el?.querySelector('[data-ref="timer"]');
		const tick = () => {
			if (!this._recording || !el) return;
			const elapsed = (Date.now() - this._startedAt) / 1000;
			el.textContent = formatSeconds(elapsed);
			el.classList.toggle('is-enough', elapsed >= MIN_SAMPLE_SECONDS);
			this._timer = requestAnimationFrame(tick);
		};
		this._timer = requestAnimationFrame(tick);
	}

	_stopTimer() {
		if (this._timer) cancelAnimationFrame(this._timer);
		this._timer = null;
	}

	_releaseMic() {
		try {
			this._stream?.getTracks().forEach((t) => t.stop());
		} catch {
			// The tracks are already gone; nothing left to release.
		}
		this._stream = null;
	}

	async _stopRecording() {
		if (!this._recorder || !this._recording) return;
		const seconds = (Date.now() - this._startedAt) / 1000;
		this._recording = false;
		this._stopTimer();

		await new Promise((resolve) => {
			this._recorder.onstop = resolve;
			this._recorder.stop();
		});
		const mimeType = this._recorder.mimeType || 'audio/webm';
		this._releaseMic();

		const blob = new Blob(this._chunks, { type: mimeType });
		this._accept({ blob, seconds, mimeType });
	}

	// ── Upload ───────────────────────────────────────────────────────────────

	async _acceptFile(file) {
		if (!file.type.startsWith('audio/')) {
			this._status('err', `That is a ${file.type || 'non-audio'} file. Upload an audio recording.`);
			return;
		}
		if (file.size > MAX_SAMPLE_BYTES) {
			this._status(
				'err',
				`That file is ${formatBytes(file.size)}. Trim it under ${Math.round(MAX_SAMPLE_BYTES / 1024 / 1024)} MB and try again.`,
			);
			return;
		}
		const seconds = await audioDuration(file);
		this._accept({ blob: file, seconds, mimeType: file.type });
	}

	/**
	 * Shared validation gate for both capture paths. Every rejection re-renders
	 * back to a clean capture panel first, so a bad sample leaves the recorder
	 * usable instead of stranded mid-recording, and the message survives.
	 */
	_accept({ blob, seconds, mimeType }) {
		const reject = (message) => {
			this._render();
			this._status('err', message);
		};
		const maxMb = Math.round(MAX_SAMPLE_BYTES / 1024 / 1024);

		if (blob.size === 0) return reject('That recording came back empty. Try again.');
		if (blob.size > MAX_SAMPLE_BYTES)
			return reject(`That sample is ${formatBytes(blob.size)}. Keep it under ${maxMb} MB.`);
		if (seconds > 0 && seconds < MIN_SAMPLE_SECONDS)
			return reject(
				`That is ${formatSeconds(seconds)}. ElevenLabs needs at least ${MIN_SAMPLE_SECONDS} seconds to build a usable voice.`,
			);
		// A duration of 0 means the browser could not decode a length; fall back to
		// the byte-size floor the server uses so we never block a valid upload.
		if (!seconds && blob.size < 50_000)
			return reject(`That sample is too short. Record at least ${MIN_SAMPLE_SECONDS} seconds.`);

		this.sample = { blob, seconds, mimeType };
		this._render();
		this._status(
			'ok',
			this.bindMode === 'later'
				? 'Sample captured. It gets cloned when you create the agent.'
				: 'Sample captured. Clone it to bind the voice.',
		);
		this._emit();
	}

	// ── Cloning ──────────────────────────────────────────────────────────────

	async _cloneHeldSample() {
		const btn = this._el?.querySelector('[data-ref="clone-now"]');
		if (btn) {
			btn.setAttribute('disabled', 'true');
			btn.textContent = 'Cloning…';
		}
		this._status('info', 'Cloning your voice. This takes a few seconds.');
		try {
			await this._clone(this.sample);
			this._render();
			this._status('ok', 'Voice cloned and bound to this agent.');
			this._emit();
		} catch (err) {
			this._render();
			this._status('err', err.message);
		}
	}

	/**
	 * POST the sample to the real clone endpoint.
	 * @param {{blob: Blob, seconds: number, mimeType: string}} sample
	 */
	async _clone(sample) {
		if (!this.agentId) throw new Error('No agent to bind this voice to.');
		const qs = new URLSearchParams({ name: `${this.agentName} voice` });
		const headers = { 'content-type': sample.mimeType || 'audio/webm' };
		if (sample.seconds > 0) headers['x-recording-duration'] = String(Math.round(sample.seconds));

		const res = await apiFetch(`/api/agents/${this.agentId}/voice/clone?${qs}`, {
			method: 'POST',
			headers,
			body: sample.blob,
		});
		const data = await res.json().catch(() => ({}));
		if (!res.ok) throw cloneError(res.status, data);

		this.boundVoiceId = data.voice_id;
		return data;
	}
}

/** Turn a clone failure into a message that names the actual next step. */
function cloneError(status, data) {
	const detail = data?.error_description || data?.message || '';
	if (status === 402) {
		return Object.assign(
			new Error('Not enough credits to clone a voice. Top up with $THREE at /credits, or save your own ElevenLabs key.'),
			{ code: 'insufficient_credits' },
		);
	}
	if (status === 429) {
		return Object.assign(new Error('Voice clone limit reached (3 per day). Try again tomorrow.'), {
			code: 'rate_limited',
		});
	}
	if (status === 503) {
		return Object.assign(
			new Error(detail || 'No ElevenLabs key is available. Save yours at /dashboard/account.'),
			{ code: 'not_configured' },
		);
	}
	return Object.assign(new Error(detail || `Voice cloning failed (${status}).`), {
		code: data?.error || 'clone_failed',
	});
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Decode an audio file's duration in the browser. Resolves 0 when it can't. */
export function audioDuration(file) {
	return new Promise((resolve) => {
		const url = URL.createObjectURL(file);
		const audio = new Audio();
		const done = (value) => {
			URL.revokeObjectURL(url);
			resolve(value);
		};
		audio.addEventListener('loadedmetadata', () =>
			done(Number.isFinite(audio.duration) ? audio.duration : 0),
		);
		audio.addEventListener('error', () => done(0));
		audio.src = url;
	});
}

export function formatSeconds(total) {
	const s = Math.max(0, Math.floor(total));
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function formatBytes(bytes) {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function injectStylesOnce() {
	if (typeof document === 'undefined' || document.getElementById('vs-css')) return;
	const s = document.createElement('style');
	s.id = 'vs-css';
	s.textContent = `
.vs-root { display: grid; gap: 12px; font-family: inherit; }
.vs-note {
	border-radius: 10px; padding: 12px 14px; font-size: 13px; line-height: 1.55;
	border: 1px solid rgba(255,255,255,0.12); background: rgba(255,255,255,0.03);
}
.vs-note strong { display: block; margin-bottom: 2px; font-weight: 600; }
.vs-note a { color: inherit; text-decoration: underline; text-underline-offset: 2px; }
.vs-note-ok   { border-color: rgba(74,222,128,0.32); background: rgba(74,222,128,0.07); }
.vs-note-warn { border-color: rgba(251,191,36,0.32); background: rgba(251,191,36,0.07); }
.vs-note-info { border-color: rgba(125,211,252,0.28); background: rgba(125,211,252,0.06); }
.vs-skeleton { opacity: 0.6; }
.vs-key-row { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
.vs-key-input {
	flex: 1 1 200px; min-width: 0; padding: 8px 11px; border-radius: 8px;
	border: 1px solid rgba(255,255,255,0.18); background: rgba(0,0,0,0.35);
	color: inherit; font: inherit; font-size: 13px;
}
.vs-key-input:focus-visible { outline: 2px solid rgba(125,211,252,0.7); outline-offset: 1px; }
.vs-capture[data-disabled="true"] { opacity: 0.45; }
.vs-script-label { margin: 0 0 6px; font-size: 12px; opacity: 0.7; }
.vs-script {
	margin: 0 0 12px; padding: 12px 14px; border-radius: 10px; font-size: 13px; line-height: 1.6;
	border: 1px solid rgba(255,255,255,0.1); background: rgba(255,255,255,0.03);
}
.vs-controls { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.vs-btn {
	display: inline-flex; align-items: center; gap: 6px; padding: 9px 16px; border: 0;
	border-radius: 9px; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer;
	transition: transform 0.12s ease, opacity 0.12s ease, background 0.12s ease;
}
.vs-btn:not(:disabled):hover { transform: translateY(-1px); }
.vs-btn:not(:disabled):active { transform: translateY(0); }
.vs-btn:focus-visible { outline: 2px solid rgba(125,211,252,0.8); outline-offset: 2px; }
.vs-btn:disabled, .vs-btn.is-disabled { opacity: 0.45; cursor: not-allowed; }
.vs-btn.primary { background: #f5f5f5; color: #0a0a0a; }
.vs-btn.primary:not(:disabled):hover { background: #ffffff; }
.vs-btn.danger  { background: #ef4444; color: #fff; }
.vs-btn.ghost   { background: rgba(255,255,255,0.07); color: inherit; border: 1px solid rgba(255,255,255,0.16); }
.vs-btn.ghost:not(.is-disabled):hover { background: rgba(255,255,255,0.13); }
.vs-link {
	background: none; border: 0; padding: 0; font: inherit; color: inherit; cursor: pointer;
	text-decoration: underline; text-underline-offset: 2px;
}
.vs-or { font-size: 12px; opacity: 0.55; }
.vs-timer { font: 600 15px/1 ui-monospace, SFMono-Regular, monospace; min-width: 46px; opacity: 0.8; }
.vs-timer.is-enough { color: #4ade80; opacity: 1; }
.vs-hint { margin: 10px 0 0; font-size: 12px; line-height: 1.5; opacity: 0.6; }
.vs-sample {
	border-radius: 10px; padding: 12px 14px;
	border: 1px solid rgba(74,222,128,0.3); background: rgba(74,222,128,0.06);
}
.vs-sample-head { display: flex; align-items: center; gap: 8px; font-size: 13px; margin-bottom: 10px; }
.vs-sample-meta { opacity: 0.65; font-size: 12px; }
.vs-dot { width: 8px; height: 8px; border-radius: 50%; background: #4ade80; flex-shrink: 0; }
.vs-audio { width: 100%; margin-bottom: 10px; }
.vs-status { margin: 0; font-size: 12.5px; line-height: 1.5; min-height: 18px; }
.vs-status.ok   { color: #4ade80; }
.vs-status.err  { color: #f87171; }
.vs-status.info { opacity: 0.7; }
@media (max-width: 480px) {
	.vs-controls { gap: 8px; }
	.vs-btn { flex: 1 1 auto; justify-content: center; }
	.vs-or { display: none; }
}
`;
	document.head.appendChild(s);
}
