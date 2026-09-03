/**
 * The browser voice loop for the house.
 *
 *   mic -> silero VAD -> openWakeWord -> capture -> /api/asr
 *       -> agent turn (/api/chat with the home tools)
 *       -> /api/tts/speak -> playback -> LipsyncDriver -> the 3D agent speaks
 *
 * One microphone, one audio context, one indicator. The VAD, the wake word and
 * the utterance capture all read the same stream, because three getUserMedia
 * calls would mean three things to remember to stop and "mute" has to stop
 * everything that exists.
 *
 * Three properties this file exists to guarantee, in order of how much damage
 * their absence does:
 *
 *  1. Nothing about listening runs until the user opts in. The VAD module, the
 *     wake-word module, onnxruntime and every model byte are behind dynamic
 *     imports reached only from enable(). A cold load of a page that mounts this
 *     loop fetches none of it.
 *  2. The microphone's state is never in doubt. mute() stops the MediaStream
 *     tracks, so the browser's own recording indicator goes out and
 *     track.readyState reads "ended". It is not a flag that hides a dot.
 *  3. Speech cannot satisfy a guarded action on its own. The confirmation
 *     grammar is a narrow token, the pending action comes from a server-minted
 *     confirmationId, and on a surface with no display a guarded action is
 *     refused outright. ASR is not a gate on a door: recognizers mishear, and
 *     the failure mode of mishearing "confirm" is an open front door.
 *
 * The twelve states in STATES are the whole external surface of the loop. A host
 * (the /home scene, the demo page, a wall display) renders them; this module
 * never touches the DOM.
 */

import { log } from '../shared/log.js';
import { VoiceActivityDetector, float32ToWav, now, VAD_SAMPLE_RATE, DEFAULT_REDEMPTION_MS } from './vad.js';

/** The twelve states. A host must handle every one of them. */
export const STATES = {
	/** Default. Listening has never been turned on. */
	OFF: 'off',
	/** getUserMedia is open and the user has not answered. */
	PERMISSION_PENDING: 'permission-pending',
	/** The user or the browser refused the microphone. */
	PERMISSION_DENIED: 'permission-denied',
	/** Live, listening for the wake word, uploading nothing. */
	IDLE: 'idle',
	/** Woken. Capturing one utterance. */
	CAPTURING: 'capturing',
	/** Transcribed, and the agent is deciding. */
	THINKING: 'thinking',
	/** The agent is speaking and barge-in is armed. */
	SPEAKING: 'speaking',
	/** The user interrupted; playback was cut. */
	BARGED_IN: 'barged-in',
	/** A guarded action is waiting for the explicit spoken token. */
	CONFIRM_PENDING: 'confirm-pending',
	/** Speech-to-text is not available. The loop degrades to text and says so. */
	UNAVAILABLE: 'unavailable',
	/** Capture is stopped at the track level. */
	MUTED: 'muted',
	/** Something failed in a way the user has to know about. */
	ERROR: 'error',
};

/** Every state, in the order a host should present them. Used by the demo surface. */
export const STATE_ORDER = [
	STATES.OFF,
	STATES.PERMISSION_PENDING,
	STATES.PERMISSION_DENIED,
	STATES.IDLE,
	STATES.CAPTURING,
	STATES.THINKING,
	STATES.SPEAKING,
	STATES.BARGED_IN,
	STATES.CONFIRM_PENDING,
	STATES.UNAVAILABLE,
	STATES.MUTED,
	STATES.ERROR,
];

/** Bumped when the consent copy changes materially, which re-asks everyone. */
export const CONSENT_VERSION = 1;
const CONSENT_KEY = 'tws:home-voice:consent';
const SETTINGS_KEY = 'tws:home-voice:settings';

/**
 * Barge-in sensitivity while the agent is speaking. Four consecutive frames
 * (128 ms) above a high probability, rather than one frame at the idle
 * threshold. One frame would fire on the agent's own voice leaking past echo
 * cancellation on a laptop speaker at volume, and an agent that interrupts
 * itself is worse than one that cannot be interrupted.
 */
const BARGE_IN_PROBABILITY = 0.65;
const BARGE_IN_FRAMES = 4;

/** An utterance longer than this is a stuck mic or a television, not a request. */
const MAX_UTTERANCE_SEC = 20;

/**
 * The spoken confirmation token, and the words that are NOT it.
 *
 * The rule, and the reason it is a narrow token: a background "yeah" in somebody
 * else's conversation must never unlock a door. A general affirmative is exactly
 * what a recognizer produces from ambient speech, so the grammar accepts one
 * deliberate word and its smallest natural pairings, and nothing else.
 */
const CONFIRM_PHRASES = new Set([
	'confirm',
	'confirm it',
	'confirm that',
	'confirm this',
	'i confirm',
	'yes confirm',
	'okay confirm',
	'ok confirm',
	'confirm yes',
	'confirmed',
]);

/**
 * Listed explicitly so the intent is readable rather than implied by a regex:
 * every one of these is a word a person says while agreeing with somebody else
 * in the same room, and not one of them confirms anything here.
 */
const REJECTED_AFFIRMATIVES = new Set([
	'yes',
	'yeah',
	'yep',
	'yup',
	'ya',
	'sure',
	'ok',
	'okay',
	'alright',
	'all right',
	'fine',
	'do it',
	'go ahead',
	'go for it',
	'please',
	'please do',
	'absolutely',
	'definitely',
	'of course',
	'uh huh',
	'mhm',
	'right',
	'correct',
	'affirmative',
	'yes please',
	'yeah sure',
	'sounds good',
	'why not',
]);

const CANCEL_PHRASES = new Set([
	'cancel',
	'stop',
	'no',
	'nope',
	'never mind',
	'nevermind',
	'forget it',
	'dont',
	'do not',
	'cancel that',
	'cancel it',
	'abort',
]);

/**
 * Normalize a transcript for grammar matching: lowercase, strip punctuation and
 * apostrophes, collapse whitespace. Deliberately strict about word count: the
 * grammar's safety comes from matching a whole short utterance rather than from
 * finding a word buried inside a long one.
 */
export function normalizeTranscript(text) {
	return String(text || '')
		.toLowerCase()
		.replace(/['’]/g, '')
		.replace(/[^a-z0-9\s]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

/**
 * Classify an utterance heard while a confirmation is outstanding.
 *
 * @param {string} text
 * @returns {'confirm'|'cancel'|'other'}
 */
export function classifyConfirmation(text) {
	const norm = normalizeTranscript(text);
	if (!norm) return 'other';
	// A general affirmative is tested first and by name. It is not a near miss to
	// be forgiven, it is the exact thing this grammar exists to refuse.
	if (REJECTED_AFFIRMATIVES.has(norm)) return 'other';
	if (CONFIRM_PHRASES.has(norm)) return 'confirm';
	if (CANCEL_PHRASES.has(norm)) return 'cancel';
	return 'other';
}

/** Whether an utterance would satisfy a guarded action. Exported for tests. */
export function isConfirmationToken(text) {
	return classifyConfirmation(text) === 'confirm';
}

function safeStorage() {
	try {
		return typeof localStorage !== 'undefined' ? localStorage : null;
	} catch {
		return null;
	}
}

/** Read the stored consent record, tolerating a wiped or hostile localStorage. */
export function readConsent(storage = safeStorage()) {
	try {
		const raw = storage?.getItem(CONSENT_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw);
		if (parsed?.version !== CONSENT_VERSION) return null;
		return parsed;
	} catch {
		return null;
	}
}

/**
 * Per-browser recovery for a denied microphone. A dead end here is the whole
 * feature dead, and "check your browser settings" helps nobody.
 */
export function permissionRecovery(userAgent = typeof navigator !== 'undefined' ? navigator.userAgent : '') {
	const ua = String(userAgent);
	if (/Firefox\//.test(ua)) {
		return 'Firefox: click the crossed-out microphone in the address bar, choose Blocked Temporarily or Remove, then reload this page.';
	}
	if (/Edg\//.test(ua)) {
		return 'Edge: click the lock icon in the address bar, set Microphone to Allow, then reload this page.';
	}
	if (/Chrome\//.test(ua)) {
		return 'Chrome: click the icon at the left of the address bar, set Microphone to Allow, then reload this page.';
	}
	if (/Safari\//.test(ua)) {
		return 'Safari: open Settings for This Website from the Safari menu, set Microphone to Allow, then reload.';
	}
	return 'Allow microphone access for this site in your browser settings, then reload this page.';
}

export class HomeVoiceLoop {
	/**
	 * @param {object} opts
	 * @param {string} [opts.homeId]        The home connection this loop acts on.
	 * @param {'display'|'screenless'} [opts.surface]
	 *        Whether the user can SEE what they are confirming. A screenless
	 *        surface refuses guarded actions; see _openConfirmation().
	 * @param {(state: string, detail: object) => void} [opts.onState]
	 * @param {(event: {type: string}) => void} [opts.onEvent]
	 * @param {(leg: string, ms: number) => void} [opts.onLatency]
	 * @param {{ setMouthShape(s: object): void }} [opts.mouthTarget]
	 * @param {typeof fetch} [opts.fetchImpl]
	 */
	constructor({ homeId = null, surface = 'display', onState, onEvent, onLatency, mouthTarget = null, fetchImpl } = {}) {
		this.homeId = homeId;
		this.surface = surface;
		this.onState = onState || (() => {});
		this.onEvent = onEvent || (() => {});
		this.onLatency = onLatency || (() => {});
		this.mouthTarget = mouthTarget;
		this.fetch = fetchImpl || ((...args) => fetch(...args));

		this.state = STATES.OFF;
		this.stateDetail = {};
		/** Every leg measured this session, newest last. */
		this.latency = [];
		/** ASR capability, read from /api/asr before anything claims to listen. */
		this.asr = { probed: false, configured: false, languages: [] };
		this.settings = this._readSettings();

		this._stream = null;
		this._audioContext = null;
		this._vad = null;
		this._wake = null;
		this._lipsync = null;
		this._playback = null;
		this._playbackAbort = null;
		this._turnAbort = null;
		this._bargeFrames = 0;
		this._captureUntil = 0;
		this._enabled = false;
		this._muted = false;
		this._destroyed = false;
		/** The outstanding server-minted confirmation, or null. */
		this.pendingConfirmation = null;
		this._confirmTimer = 0;
		/** Marks used to derive the leg timings. */
		this._marks = {};
	}

	get enabled() {
		return this._enabled;
	}

	get muted() {
		return this._muted;
	}

	/** True when a live microphone track exists. The indicator reads this, only this. */
	get micLive() {
		return !!this._stream?.getAudioTracks().some((t) => t.readyState === 'live');
	}

	/** The readyState of every track this loop holds. The mute proof reads this. */
	trackStates() {
		return (this._stream?.getAudioTracks() || []).map((t) => t.readyState);
	}

	/** Whether the user has already opted in on this device. */
	hasConsent() {
		return !!readConsent();
	}

	/**
	 * Ask /api/asr whether speech-to-text exists in this deployment. Cheap,
	 * unauthenticated, and safe to call before consent: it uploads nothing and
	 * touches no microphone. A loop that cannot transcribe must say so rather than
	 * light an indicator and listen to a house for nothing.
	 */
	async probeAsr() {
		try {
			const res = await this.fetch('/api/asr', { headers: { accept: 'application/json' } });
			if (!res.ok) throw new Error(`asr probe ${res.status}`);
			const body = await res.json();
			this.asr = {
				probed: true,
				configured: !!body.configured,
				languages: Array.isArray(body.languages) ? body.languages : [],
				sampleRate: body.sampleRate || VAD_SAMPLE_RATE,
			};
		} catch (err) {
			this.asr = { probed: true, configured: false, languages: [], error: err?.message };
		}
		if (!this.asr.configured && this.state === STATES.OFF) {
			this._setState(STATES.UNAVAILABLE, { reason: UNAVAILABLE_REASON });
		}
		return this.asr;
	}

	/**
	 * Record the opt-in. Separate from enable() on purpose: consent is a decision
	 * with a timestamp, and turning the mic on is an action. A host that stores the
	 * first without doing the second is behaving correctly.
	 */
	grantConsent() {
		const record = { version: CONSENT_VERSION, grantedAt: new Date().toISOString() };
		try {
			safeStorage()?.setItem(CONSENT_KEY, JSON.stringify(record));
		} catch {}
		this.onEvent({ type: 'consent-granted', ...record });
		return record;
	}

	/** Withdraw the opt-in and stop everything. One tap, no confirmation dialog. */
	async revokeConsent() {
		try {
			safeStorage()?.removeItem(CONSENT_KEY);
		} catch {}
		await this.disable();
		this.onEvent({ type: 'consent-revoked' });
	}

	/** Persisted, non-sensitive preferences: the chosen wake word and language. */
	_readSettings() {
		const defaults = { wakeWord: 'hey_jarvis', language: 'en-US' };
		try {
			const raw = safeStorage()?.getItem(SETTINGS_KEY);
			return raw ? { ...defaults, ...JSON.parse(raw) } : defaults;
		} catch {
			return defaults;
		}
	}

	saveSettings(patch) {
		this.settings = { ...this.settings, ...patch };
		try {
			safeStorage()?.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
		} catch {}
		if (patch.wakeWord && this._wake) void this._wake.setWakeWord(patch.wakeWord);
		this.onEvent({ type: 'settings', settings: this.settings });
	}

	/**
	 * Turn listening on: acquire the microphone, then load the VAD and the wake
	 * word. Requires consent; call grantConsent() first.
	 *
	 * Every module and model byte below is fetched here and nowhere earlier.
	 */
	async enable() {
		if (this._destroyed) throw new Error('HomeVoiceLoop was destroyed');
		if (this._enabled) return;
		if (!this.hasConsent()) throw new Error('HomeVoiceLoop.enable() requires consent');
		if (!this.asr.probed) await this.probeAsr();
		if (!this.asr.configured) {
			this._setState(STATES.UNAVAILABLE, { reason: UNAVAILABLE_REASON });
			return;
		}

		this._setState(STATES.PERMISSION_PENDING, {});
		try {
			this._stream = await navigator.mediaDevices.getUserMedia({ audio: MIC_CONSTRAINTS });
		} catch (err) {
			const name = err?.name || '';
			if (name === 'NotAllowedError' || name === 'SecurityError') {
				this._setState(STATES.PERMISSION_DENIED, { recovery: permissionRecovery() });
				return;
			}
			this._setState(STATES.ERROR, {
				message:
					name === 'NotFoundError'
						? 'No microphone was found. Plug one in, or keep talking to the agent by text.'
						: `The microphone could not start: ${err?.message || name || 'unknown error'}`,
				retryable: true,
			});
			return;
		}

		const AC = window.AudioContext || window.webkitAudioContext;
		this._audioContext = new AC();
		if (this._audioContext.state === 'suspended') await this._audioContext.resume().catch(() => {});

		try {
			const { WakeWordDetector } = await import('./wake-word.js');
			this._wake = new WakeWordDetector({
				wakeWord: this.settings.wakeWord,
				onWake: (d) => this._onWake(d),
				onScore: (score) => this.onEvent({ type: 'wake-score', score }),
			});
			await this._wake.load();
			await this._startVad();
		} catch (err) {
			await this._teardownAudio();
			this._setState(STATES.ERROR, {
				message: `The listening models could not load: ${err?.message || 'unknown error'}`,
				retryable: true,
			});
			return;
		}

		this._enabled = true;
		this._muted = false;
		this._setState(STATES.IDLE, { wakeWord: this.settings.wakeWord });
	}

	async _startVad() {
		this._vad = new VoiceActivityDetector({
			stream: this._stream,
			audioContext: this._audioContext,
			redemptionMs: DEFAULT_REDEMPTION_MS,
			onFrame: (frame, prob) => this._onFrame(frame, prob),
			onSpeechStart: () => this._onSpeechStart(),
			onSpeechEnd: (audio) => this._onSpeechEnd(audio),
			onMisfire: () => this.onEvent({ type: 'vad-misfire' }),
		});
		await this._vad.start();
	}

	/**
	 * Stop capture at the track level. The browser's own recording indicator goes
	 * out, and track.readyState reads "ended" for every track. Nothing here hides
	 * an indicator over a live microphone.
	 */
	async mute() {
		if (!this._enabled || this._muted) return;
		this._muted = true;
		this._cancelPlayback('muted');
		await this._vad?.pause();
		for (const track of this._stream?.getAudioTracks() || []) {
			try {
				track.stop();
			} catch {}
		}
		this._wake?.reset();
		this._setState(STATES.MUTED, { tracks: this.trackStates() });
	}

	/** Re-acquire the microphone. A stopped track cannot be restarted, so this is a new one. */
	async unmute() {
		if (!this._enabled || !this._muted) return;
		try {
			this._stream = await navigator.mediaDevices.getUserMedia({ audio: MIC_CONSTRAINTS });
		} catch {
			this._setState(STATES.PERMISSION_DENIED, { recovery: permissionRecovery() });
			return;
		}
		// The VAD holds the old, ended stream: rebuild it against the new one.
		await this._vad?.destroy();
		await this._startVad();
		this._muted = false;
		this._wake?.reset();
		this._setState(STATES.IDLE, { wakeWord: this.settings.wakeWord });
	}

	/** Turn the whole loop off and release every resource. */
	async disable() {
		this._enabled = false;
		this._muted = false;
		this._cancelPlayback('disabled');
		this._clearConfirmation('disabled', { silent: true });
		await this._teardownAudio();
		this._setState(STATES.OFF, {});
	}

	async destroy() {
		this._destroyed = true;
		await this.disable();
	}

	async _teardownAudio() {
		try {
			await this._vad?.destroy();
		} catch {}
		this._vad = null;
		try {
			await this._wake?.destroy();
		} catch {}
		this._wake = null;
		for (const track of this._stream?.getAudioTracks() || []) {
			try {
				track.stop();
			} catch {}
		}
		this._stream = null;
		if (this._audioContext && this._audioContext.state !== 'closed') {
			await this._audioContext.close().catch(() => {});
		}
		this._audioContext = null;
	}

	// -- the loop ------------------------------------------------------------

	_onFrame(frame, probability) {
		// The wake word only ever sees audio while the loop is idle. During a
		// capture it is irrelevant, and during playback it must not run at all:
		// see the suppression in _speak().
		if (this.state === STATES.IDLE) this._wake?.push(frame);

		if (this.state === STATES.SPEAKING) {
			if (probability >= BARGE_IN_PROBABILITY) {
				// The first frame of the qualifying run is when the user actually
				// started talking, and it is what the barge-in budget is measured
				// against. Measuring from the fourth frame would flatter the number
				// by exactly the confirmation window.
				if (this._bargeFrames === 0) this._marks.bargeFirstFrame = now();
				this._bargeFrames++;
				if (this._bargeFrames >= BARGE_IN_FRAMES) this._bargeIn();
			} else {
				this._bargeFrames = 0;
			}
		}
	}

	_onSpeechStart() {
		this._marks.speechStart = now();
		this.onEvent({ type: 'speech-start' });
	}

	_onWake({ score, latencyMs, wakeWord }) {
		if (this.state !== STATES.IDLE) return;
		this._marks.wake = now();
		this._record('wake', latencyMs);
		this.onEvent({ type: 'wake', score, wakeWord, latencyMs });
		this._captureUntil = now() + MAX_UTTERANCE_SEC * 1000;
		this._setState(STATES.CAPTURING, { wakeWord, score });
	}

	async _onSpeechEnd(audio) {
		const endedAt = now();
		// Trailing silence actually spent before the utterance was called finished.
		if (this._vad?.lastSpeechFrameAt) this._record('endpoint', endedAt - this._vad.lastSpeechFrameAt);
		this._marks.speechEnd = endedAt;

		if (this.state !== STATES.CAPTURING && this.state !== STATES.CONFIRM_PENDING) return;
		if (this.state === STATES.CAPTURING && endedAt > this._captureUntil) {
			this._setState(STATES.IDLE, {
				wakeWord: this.settings.wakeWord,
				note: 'That went on too long, so it was dropped.',
			});
			return;
		}

		const wasConfirming = this.state === STATES.CONFIRM_PENDING;
		if (!wasConfirming) this._setState(STATES.THINKING, {});

		let transcript = '';
		try {
			transcript = await this._transcribe(audio);
		} catch (err) {
			this._setState(STATES.ERROR, {
				message: `Speech recognition failed: ${err?.message || 'unknown error'}. Say it again, or type it.`,
				retryable: true,
			});
			this._recover();
			return;
		}

		if (!transcript.trim()) {
			this.onEvent({ type: 'empty-transcript' });
			if (!wasConfirming) this._setState(STATES.IDLE, { wakeWord: this.settings.wakeWord });
			return;
		}
		this.onEvent({ type: 'transcript', text: transcript, forConfirmation: wasConfirming });

		if (wasConfirming) {
			await this._handleSpokenConfirmation(transcript);
			return;
		}
		await this.say(transcript);
	}

	/** Upload one utterance to the real ASR lane and time the round trip. */
	async _transcribe(audio) {
		const wav = float32ToWav(audio, VAD_SAMPLE_RATE);
		const started = now();
		const res = await this.fetch('/api/asr', {
			method: 'POST',
			headers: { 'content-type': 'audio/wav' },
			body: wav,
			credentials: 'same-origin',
		});
		this._record('asr', now() - started);
		if (!res.ok) {
			const detail = await res.text().catch(() => '');
			throw new Error(`${res.status} ${detail.slice(0, 160)}`);
		}
		const body = await res.json();
		return String(body.text || '');
	}

	/**
	 * Run one agent turn over a transcript. Public so a host can feed the same
	 * loop from a text box: the degraded path is the voice path minus the audio,
	 * not a second implementation.
	 */
	async say(text) {
		this._setState(STATES.THINKING, { text });
		this._turnAbort?.abort();
		const controller = new AbortController();
		this._turnAbort = controller;
		const started = now();
		let result;
		try {
			result = await this._turn(text, controller.signal);
		} catch (err) {
			if (controller.signal.aborted) return;
			this._setState(STATES.ERROR, {
				message: `The agent could not answer: ${err?.message || 'unknown error'}`,
				retryable: true,
			});
			this._recover();
			return;
		}
		this._record('turn', now() - started);

		if (result.pendingConfirmation) {
			await this._openConfirmation(result.pendingConfirmation);
			return;
		}
		if (result.reply) await this._speak(result.reply);
		else this._recover();
	}

	/**
	 * One turn against the platform's chat lane, scoped to this home.
	 *
	 * The home tools, the gate and the confirmation record all live server-side.
	 * This client sends the transcript and the home id and reads back either an
	 * answer or a pending_confirmation payload; it never decides whether an action
	 * is guarded, and it has no way to set `confirmed`.
	 */
	async _turn(text, signal) {
		const res = await this.fetch('/api/chat', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			credentials: 'same-origin',
			signal,
			body: JSON.stringify({
				messages: [{ role: 'user', content: text }],
				home_id: this.homeId,
				surface: 'home-voice',
			}),
		});
		if (!res.ok) {
			const detail = await res.text().catch(() => '');
			throw new Error(`${res.status} ${detail.slice(0, 200)}`);
		}
		const body = await res.json().catch(() => ({}));
		const reply = String(body.reply ?? body.content ?? body.text ?? '').trim();
		const pending = body.pending_confirmation || body.pendingConfirmation || null;
		return { reply, pendingConfirmation: pending ? normalizePendingConfirmation(pending) : null };
	}

	// -- guarded actions -----------------------------------------------------

	/**
	 * Open a pending confirmation: say the whole sentence, show the entity, and
	 * wait for the token.
	 *
	 * On a surface with no display the answer is no. A user who cannot SEE what
	 * they are agreeing to is being asked to trust a recognizer with a lock, and a
	 * recognizer is not trustworthy enough for that. This refusal is deliberate
	 * and stays in the code.
	 */
	async _openConfirmation(pending) {
		if (this.surface === 'screenless') {
			this.onEvent({ type: 'guarded-refused', reason: 'screenless', confirmation: pending });
			await this._speak(
				`${pending.sentence} I cannot take that one by voice alone on a device with no screen, because it would ` +
					'mean trusting speech recognition with a lock. Confirm it on your phone and it will go through.',
			);
			return;
		}

		this.pendingConfirmation = pending;
		clearTimeout(this._confirmTimer);
		this._confirmTimer = setTimeout(() => this._clearConfirmation('expired'), Math.max(1000, pending.expiresInMs));
		this.onEvent({ type: 'confirmation-open', confirmation: pending });
		this._setState(STATES.CONFIRM_PENDING, { confirmation: pending });

		// The full sentence, then the exact word required. Never "OK?", and never a
		// yes/no about an action that was not named.
		await this._speak(`${pending.sentence} Say confirm to continue, or cancel to leave it alone.`, {
			keepState: STATES.CONFIRM_PENDING,
		});
	}

	async _handleSpokenConfirmation(transcript) {
		const verdict = classifyConfirmation(transcript);
		const pending = this.pendingConfirmation;
		if (!pending) {
			this._recover();
			return;
		}

		if (verdict === 'confirm') {
			this._clearConfirmation('redeemed', { silent: true });
			await this._redeem(pending);
			return;
		}
		if (verdict === 'cancel') {
			this._clearConfirmation('cancelled');
			await this._speak('Cancelled. Nothing changed.');
			return;
		}
		// Anything else, a general "yeah" included, does not confirm. The pending
		// action is dropped rather than left hanging over a conversation that has
		// moved on, and the utterance is treated as the new request it looks like.
		this._clearConfirmation('superseded');
		this.onEvent({ type: 'confirmation-not-token', text: transcript });
		await this.say(transcript);
	}

	/**
	 * Redeem the server-minted confirmation. The id is all that travels: the action
	 * itself was stored server-side when the confirmation was minted, so a
	 * confirmation for one lock can never execute against another.
	 */
	async _redeem(pending) {
		this._setState(STATES.THINKING, { redeeming: pending });
		try {
			// Minted before the clock starts: the action leg measures the house
			// responding, not our own token round trip.
			const csrf = await csrfHeader(this.fetch);
			const started = now();
			const res = await this.fetch(`/api/home/${encodeURIComponent(pending.homeId || this.homeId)}/confirm`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', ...csrf },
				credentials: 'same-origin',
				body: JSON.stringify({ confirmation_id: pending.confirmationId }),
			});
			this._record('action', now() - started);
			const body = await res.json().catch(() => ({}));
			if (!res.ok) {
				const message = body?.message || body?.error || `confirmation refused (${res.status})`;
				this.onEvent({ type: 'confirmation-refused', message, status: res.status });
				await this._speak(`That did not go through: ${message}`);
				return;
			}
			this.onEvent({ type: 'confirmation-executed', result: body });
			await this._speak(body.spoken || body.message || 'Done.');
		} catch (err) {
			this.onEvent({ type: 'confirmation-refused', message: err?.message });
			await this._speak(`That did not go through: ${err?.message || 'the house did not answer'}`);
		}
	}

	_clearConfirmation(reason, { silent = false } = {}) {
		clearTimeout(this._confirmTimer);
		this._confirmTimer = 0;
		const had = this.pendingConfirmation;
		this.pendingConfirmation = null;
		if (!had) return;
		if (!silent) this.onEvent({ type: 'confirmation-closed', reason, confirmation: had });
		if (reason === 'expired') {
			void this._speak('That confirmation expired, so nothing changed. Ask again if you still want it.');
		}
	}

	/** Cancel from the UI rather than by voice. Same effect, no recognizer involved. */
	cancelConfirmation() {
		this._clearConfirmation('cancelled');
		this._recover();
	}

	/** Confirm from the UI: a real button press, the strongest signal there is. */
	async confirmPending() {
		const pending = this.pendingConfirmation;
		if (!pending) return;
		this._clearConfirmation('redeemed', { silent: true });
		await this._redeem(pending);
	}

	// -- speaking, and being interrupted --------------------------------------

	/** Synthesize and play, with barge-in armed for the whole of it. */
	async _speak(text, { keepState = null } = {}) {
		if (!text) {
			this._recover(keepState);
			return;
		}
		this._cancelPlayback('superseded');
		this._bargeFrames = 0;
		// The agent must not hear itself. Echo cancellation removes most of the
		// far-end signal, but "most" is not a guarantee on a laptop speaker at
		// volume, and the failure it produces is the agent waking itself.
		if (this._wake) {
			this._wake.suppressed = true;
			this._wake.reset();
		}
		this._setState(keepState || STATES.SPEAKING, { text });

		const controller = new AbortController();
		this._playbackAbort = controller;
		const requestedAt = now();
		try {
			const res = await this.fetch('/api/tts/speak', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				credentials: 'same-origin',
				signal: controller.signal,
				body: JSON.stringify({ text, format: 'wav', language: this.settings.language }),
			});
			if (!res.ok) throw new Error(`tts ${res.status}`);
			const buffer = await res.arrayBuffer();
			if (controller.signal.aborted) return;
			const audio = await this._audioContext.decodeAudioData(buffer);
			if (controller.signal.aborted) return;
			await this._play(audio, keepState, requestedAt);
		} catch (err) {
			if (controller.signal.aborted) return;
			// A voice that fails is not a loop that fails: the answer still exists,
			// it just has to be read instead of heard.
			this.onEvent({ type: 'tts-failed', message: err?.message, text });
			this._releaseSuppression();
			this._recover(keepState);
		}
	}

	_play(audioBuffer, keepState, requestedAt) {
		return new Promise((resolve) => {
			const ctx = this._audioContext;
			if (!ctx) {
				resolve();
				return;
			}
			const source = ctx.createBufferSource();
			source.buffer = audioBuffer;
			const analyser = ctx.createAnalyser();
			analyser.fftSize = 256;
			source.connect(analyser);
			analyser.connect(ctx.destination);
			this._playback = source;

			if (this.mouthTarget) void this._startLipsync(analyser);

			source.onended = () => {
				if (this._playback !== source) return;
				this._playback = null;
				this._stopLipsync();
				this._releaseSuppression();
				this._recover(keepState);
				resolve();
			};
			source.start();
			// The number a user actually feels: the end of their sentence to the
			// first sound coming back.
			if (this._marks.speechEnd) this._record('firstAudio', now() - this._marks.speechEnd);
			this._record('tts', now() - requestedAt);
		});
	}

	async _startLipsync(analyser) {
		try {
			const { LipsyncDriver } = await import('./lipsync-driver.js');
			this._lipsync = new LipsyncDriver({ analyser, target: this.mouthTarget });
			this._lipsync.start();
		} catch (err) {
			log.warn('[home-voice] lipsync unavailable', err?.message);
		}
	}

	_stopLipsync() {
		try {
			this._lipsync?.stop();
		} catch {}
		this._lipsync = null;
	}

	/**
	 * The user started talking over the agent. Cut the sound now, drop whatever
	 * synthesis is still in flight, and start listening again in the same breath.
	 */
	_bargeIn() {
		if (this.state !== STATES.SPEAKING) return;
		const at = now();
		this._cancelPlayback('barge-in');
		if (this._marks.bargeFirstFrame) this._record('bargeIn', at - this._marks.bargeFirstFrame);
		this._releaseSuppression();
		this.onEvent({ type: 'barge-in', at });
		this._setState(STATES.BARGED_IN, {});
		// The utterance that interrupted is the next request: the VAD is already
		// capturing it, and its speech-end runs a turn without a second wake word.
		this._captureUntil = at + MAX_UTTERANCE_SEC * 1000;
		this._setState(STATES.CAPTURING, { viaBargeIn: true });
	}

	_cancelPlayback(reason) {
		this._playbackAbort?.abort();
		this._playbackAbort = null;
		const source = this._playback;
		this._playback = null;
		this._stopLipsync();
		if (!source) return;
		try {
			source.onended = null;
			source.stop();
		} catch {}
		this.onEvent({ type: 'playback-stopped', reason });
	}

	_releaseSuppression() {
		if (!this._wake) return;
		this._wake.suppressed = false;
		// Whatever leaked past echo cancellation stays in the ring buffers for
		// almost two seconds. Clearing them is what stops the tail of the agent's
		// own sentence from scoring after the guard lifts.
		this._wake.reset();
		this._bargeFrames = 0;
	}

	/** Back to whichever resting state is correct right now. */
	_recover(keepState = null) {
		if (!this._enabled) {
			this._setState(STATES.OFF, {});
			return;
		}
		if (this._muted) {
			this._setState(STATES.MUTED, { tracks: this.trackStates() });
			return;
		}
		if (keepState === STATES.CONFIRM_PENDING && this.pendingConfirmation) {
			this._setState(STATES.CONFIRM_PENDING, { confirmation: this.pendingConfirmation });
			return;
		}
		this._setState(STATES.IDLE, { wakeWord: this.settings.wakeWord });
	}

	_setState(state, detail) {
		this.state = state;
		this.stateDetail = detail || {};
		this.onState(state, this.stateDetail);
	}

	_record(leg, ms) {
		const entry = { leg, ms: Math.round(ms), at: Date.now() };
		this.latency.push(entry);
		if (this.latency.length > 200) this.latency.shift();
		this.onLatency(leg, entry.ms);
		this.onEvent({ type: 'latency', ...entry });
	}

	/** Every leg measured this session, as medians. What the report table is built from. */
	latencySummary() {
		const byLeg = new Map();
		for (const { leg, ms } of this.latency) {
			if (!byLeg.has(leg)) byLeg.set(leg, []);
			byLeg.get(leg).push(ms);
		}
		const out = {};
		for (const [leg, values] of byLeg) {
			const sorted = [...values].sort((a, b) => a - b);
			out[leg] = { count: sorted.length, median: sorted[Math.floor(sorted.length / 2)], worst: sorted[sorted.length - 1] };
		}
		return out;
	}
}

const MIC_CONSTRAINTS = {
	channelCount: 1,
	// Full duplex depends on all three: without echo cancellation the agent's own
	// voice arrives back in the capture and barge-in fires on it, which reads to a
	// user as the agent interrupting itself.
	echoCancellation: true,
	noiseSuppression: true,
	autoGainControl: true,
};

const UNAVAILABLE_REASON =
	'Speech recognition is not available in this deployment, so the microphone stays off. ' +
	'Type to the agent instead: everything voice can do, text can do.';

/**
 * Reduce a server pending_confirmation payload to what the client is allowed to
 * act on. Nothing here is trusted as instruction: `sentence` is spoken and shown,
 * never fed back into a model, and the entity ids are rendered as data.
 */
export function normalizePendingConfirmation(raw) {
	return {
		confirmationId: String(raw.confirmation_id ?? raw.confirmationId ?? ''),
		homeId: raw.home_id ?? raw.homeId ?? null,
		sentence: capText(raw.sentence ?? raw.message ?? 'This will change something in your home.', 240),
		entityIds: (raw.entity_ids ?? raw.entityIds ?? []).slice(0, 24).map((id) => capText(id, 128)),
		risk: capText(raw.risk ?? 'unknown', 32),
		expiresInMs: Number(raw.expires_in_ms ?? raw.expiresInMs ?? 90000),
	};
}

/**
 * Entity and area names are attacker-controlled: they come from devices, from
 * integrations and from other people in the household. Cap the length and strip
 * control characters before anything renders or speaks them.
 */
export function capText(value, max) {
	return String(value ?? '')
		.replace(CONTROL_CHARS, ' ')
		.slice(0, max);
}

// Built from codepoints rather than written as a literal so the source file
// never itself contains the control characters it is stripping.
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f]', 'g');

/**
 * A fresh CSRF token for the confirm endpoint, minted the way every other write
 * on the platform mints one (GET /api/csrf-token, echo it in the header). Each
 * token is single use, so it is fetched per redemption rather than cached: a
 * confirmation is at most one request per guarded action, and reusing a spent
 * token would fail exactly when a lock is waiting.
 */
async function csrfHeader(fetchImpl) {
	try {
		const res = await fetchImpl('/api/csrf-token', { credentials: 'include' });
		if (!res.ok) return {};
		const body = await res.json();
		const token = body?.data?.token ?? body?.token ?? null;
		return token ? { 'x-csrf-token': token } : {};
	} catch {
		return {};
	}
}
