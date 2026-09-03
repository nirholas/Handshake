/**
 * TalkController — orchestrates the live voice loop on /avatars/:id.
 *
 *   user mic ─▶ Web Speech API STT ─▶ /api/chat (SSE)
 *                                          │
 *                                          ▼
 *                          /api/tts/eleven (cloned voice)
 *                          /api/tts/edge   (fallback)
 *                                          │
 *                                          ▼
 *                                 audio element + analyser
 *                                          │
 *                                          ▼
 *                           LipsyncDriver ▶ AvatarMouthTarget
 *
 * Every piece is real:
 *   - Web Speech API mic capture (browser-native, no key)
 *   - /api/chat streams from Anthropic / OpenRouter / etc (existing)
 *   - /api/tts/eleven is the existing R2-cached ElevenLabs proxy
 *   - /api/tts/edge is the existing Microsoft Edge Neural TTS fallback
 *   - Voice ID is read from /api/agents/:agent_id/voice when the avatar is
 *     bound to an agent with a cloned voice; otherwise we use the Edge path
 *
 * The controller takes ownership of an AvatarMouthTarget — it doesn't own the
 * scene that drives the visuals. Tear down by calling stop().
 */

import { LipsyncDriver, tapAudioElement } from './lipsync-driver.js';
import { MicCapture } from './mic-capture.js';
import {
	detectTalkLanguage,
	edgeVoiceFor,
	languageInstruction,
	resolveTalkLanguage,
} from './talk-languages.js';
import { log } from '../shared/log.js';

// Riva interim recognition cadence. While holding to talk we fire a recognition
// pass over the audio-so-far on this interval so partial words surface live;
// MAX_INTERIMS caps the round-trips per utterance so a long hold can't drain the
// metered ASR budget. The release always runs one authoritative final pass.
const INTERIM_INTERVAL_MS = 1400;
const MAX_INTERIMS = 4;

const ELEVEN_DEFAULT_VOICE = 'EXAVITQu4vr4xnSDxMaL'; // Bella — ElevenLabs default voice

export class TalkController {
	/**
	 * @param {object} opts
	 * @param {object} opts.avatar       Avatar record (must include id; optionally agent_id, source_meta)
	 * @param {() => string} [opts.systemPromptFn]  Optional system prompt builder
	 * @param {(msg: { role: 'user'|'assistant', content: string }) => void} [opts.onMessage]
	 *        Hook so the host UI can append a transcript line.
	 * @param {(state: 'idle'|'listening'|'transcribing'|'thinking'|'speaking') => void} [opts.onStateChange]
	 * @param {(partial: string) => void} [opts.onInterim]  Live (non-final) transcript while listening.
	 * @param {(err: Error) => void} [opts.onError]
	 * @param {{ attach: Function, setMouthShape: Function }} opts.mouthTarget
	 */
	constructor({ avatar, systemPromptFn, onMessage, onStateChange, onInterim, onError, mouthTarget, commandInterceptor, language }) {
		if (!avatar?.id) throw new Error('TalkController: avatar.id required');
		if (!mouthTarget) throw new Error('TalkController: mouthTarget required');
		this.avatar = avatar;
		this.systemPromptFn = systemPromptFn || (() => '');
		this.onMessage = onMessage || (() => {});
		this.onStateChange = onStateChange || (() => {});
		this.onInterim = onInterim || (() => {});
		this.onError = onError || ((e) => log.warn('[talk]', e?.message));
		this.mouthTarget = mouthTarget;
		// Optional async hook: gets first crack at a final transcript. If it returns
		// true, the utterance was handled out-of-band (e.g. a wallet command) and the
		// normal chat round-trip is skipped. Used by the Conversational Wallet.
		this.commandInterceptor = commandInterceptor || null;

		this._state = 'idle';
		this._history = [];
		this._recognizer = null;
		this._audioCtx = null;
		this._currentAudioEl = null;
		this._currentTap = null;
		this._driver = null;
		// Playback gain for the spoken reply (0..1). Persists across turns so a
		// "quieter" instruction survives the next thing the avatar says.
		this._volume = 1;
		// Latched once /api/tts/edge answers 401/403: it needs a session, and an
		// anonymous listener should not pay a wasted round trip on every turn.
		this._edgeUnavailable = false;
		this._voicePromise = null; // resolves to { provider, voiceId } | null

		// Speech-to-text routing. 'riva' = server-side NVIDIA Riva (cross-browser),
		// 'browser' = window.SpeechRecognition (Chrome/Edge/Safari), 'none' = text
		// only. The right path depends on the CONVERSATION LANGUAGE, not just the
		// browser: the server lane recognizes the languages it advertises on
		// /api/asr, and the browser recognizer covers the rest. prepare() probes
		// once; the mode is then derived per language.
		this._probePromise = null;
		this._probeSettledFlag = false;
		this._serverAsr = null; // { configured, languages } from GET /api/asr
		this._hasBrowserSR = !!(
			typeof window !== 'undefined' &&
			(window.SpeechRecognition || window.webkitSpeechRecognition)
		);
		this._listenMode = null; // mode of the in-flight turn
		this._mic = null;
		this._interimTimer = null;
		this._interimBusy = false;
		this._interimCount = 0;

		// Conversation language: an explicit choice wins, else the language the
		// site is already displayed in, else the browser's own preference. Every
		// leg of the loop reads it: recognition, the reply, and the voice.
		this.language = resolveTalkLanguage(
			language ||
				detectTalkLanguage({
					uiLocale: siteLocale(),
					navLangs:
						typeof navigator !== 'undefined'
							? navigator.languages || [navigator.language]
							: [],
				}),
		);
	}

	/**
	 * Switch the conversation language mid-session. Takes effect on the next turn:
	 * recognition, the reply, and the voice all follow it.
	 * @returns {string} the resolved tag (never an unsupported one).
	 */
	setLanguage(tag) {
		this.language = resolveTalkLanguage(tag);
		return this.language;
	}

	get state() {
		return this._state;
	}

	/** STT path for the CURRENT language: 'riva' | 'browser' | 'none'. */
	get sttMode() {
		return this._modeFor(this.language);
	}

	/** True when the free server lane can hear the current language. */
	get serverHearsLanguage() {
		return this._serverSupports(this.language);
	}

	/**
	 * Recognizer a given language would use right now: 'riva' | 'browser' | 'none'.
	 * A picker calls this to label each option honestly before the user commits to
	 * one, instead of discovering the dead end by holding the mic.
	 */
	sttModeFor(language) {
		return this._modeFor(resolveTalkLanguage(language));
	}

	/** Live mic level (0..1) while the Riva lane is capturing; 0 otherwise. */
	get micLevel() {
		return this._mic ? this._mic.getLevel() : 0;
	}

	/**
	 * Decide the STT path before the first turn. Probes /api/asr once for the free
	 * NVIDIA Riva lane (works in every browser, including Firefox) and the set of
	 * languages that lane recognizes; falls back to the browser's own
	 * SpeechRecognition, then to text-only. Safe to call repeatedly; the probe
	 * runs at most once. Returns the mode for the current language.
	 */
	async prepare() {
		if (!this._probePromise) {
			this._probePromise = (async () => {
				if (!MicCapture.isSupported()) return;
				try {
					const r = await fetch('/api/asr', { headers: { accept: 'application/json' } });
					if (!r.ok) return;
					const j = await r.json();
					if (!j?.configured) return;
					this._serverAsr = {
						configured: true,
						// A deployment that predates language routing advertises no list;
						// treat that as the English-only lane it is rather than assuming
						// it can hear Mandarin and failing the first turn.
						languages: Array.isArray(j.languages) && j.languages.length
							? j.languages.map((t) => String(t).toLowerCase())
							: ['en-us'],
					};
				} catch {
					// Probe failure is not fatal: fall back to whatever the browser offers.
				} finally {
					this._probeSettledFlag = true;
				}
			})();
		}
		await this._probePromise;
		return this.sttMode;
	}

	/** Does the probed server lane advertise recognition for this language? */
	_serverSupports(language) {
		if (!this._serverAsr?.configured) return false;
		const tag = String(language || '').toLowerCase();
		const primary = tag.split('-')[0];
		return this._serverAsr.languages.some(
			(l) => l === tag || l.split('-')[0] === primary,
		);
	}

	/**
	 * Best recognizer for a language. The server lane leads where it can hear the
	 * language (cross-browser, and it does not ship the user's audio to Google);
	 * the browser's recognizer covers everything else, which is what makes a
	 * language the server lane never learned still usable in Chrome and Safari.
	 */
	_modeFor(language) {
		if (this._serverSupports(language)) return 'riva';
		if (this._hasBrowserSR) return 'browser';
		return 'none';
	}

	/**
	 * Begin a single push-to-talk turn. Returns immediately. The recognized speech
	 * triggers the chat call when stopListening() lands a final transcript (Riva)
	 * or on the recognizer's `end` event (browser). Routes by the mode resolved in
	 * prepare(), with a synchronous fallback if prepare() hasn't settled yet.
	 */
	startListening() {
		if (this._state !== 'idle') return false;

		const mode = this.probeSettled ? this.sttMode : this._fallbackSttMode();
		if (mode === 'riva') {
			this._listenMode = 'riva';
			this._startRivaListening();
			return true;
		}
		if (mode === 'browser') {
			this._listenMode = 'browser';
			return this._startBrowserListening();
		}
		this._listenMode = null;
		this.onError(coded('Voice input isn’t available here — type your message instead.', 'stt-unavailable'));
		return false;
	}

	/** Stop an in-flight recognition. State transitions to idle (or transcribing). */
	stopListening() {
		if (this._listenMode === 'riva') {
			this._stopRivaListening().catch((err) => {
				this._setState('idle');
				this.onError(err);
			});
			return;
		}
		if (this._recognizer) {
			try {
				this._recognizer.stop();
			} catch {}
		}
	}

	// Best mode to use before prepare() has resolved. Prefer the browser's own
	// recognizer (zero setup, instant) when present; otherwise attempt Riva if the
	// environment can capture audio at all.
	_fallbackSttMode() {
		if (this._hasBrowserSR) return 'browser';
		return MicCapture.isSupported() ? 'riva' : 'none';
	}

	/**
	 * True once the /api/asr probe has answered (or failed). Until it has, the
	 * language→recognizer mapping is a guess, so a UI should not tell the user a
	 * language is unusable yet.
	 */
	get probeSettled() {
		return this._probeSettledFlag;
	}

	// ── Browser SpeechRecognition path (Chrome/Edge/Safari) ────────────────
	_startBrowserListening() {
		const RecCls = window.SpeechRecognition || window.webkitSpeechRecognition;
		if (!RecCls) {
			this.onError(coded('Your browser does not support speech input. Try Chrome, Edge, or Safari.', 'stt-unavailable'));
			return false;
		}

		const rec = new RecCls();
		rec.lang = this.language;
		rec.continuous = false;
		rec.interimResults = true;
		rec.maxAlternatives = 1;
		this._recognizer = rec;

		let finalText = '';
		rec.onresult = (e) => {
			let interim = '';
			for (let i = e.resultIndex; i < e.results.length; i++) {
				const res = e.results[i];
				if (res.isFinal) finalText += res[0].transcript;
				else interim += res[0].transcript;
			}
			if (interim) this.onInterim(interim);
		};
		rec.onerror = (e) => {
			const kind = e.error || 'unknown';
			// 'no-speech'/'aborted' are benign end-of-hold outcomes, not failures.
			if (kind !== 'no-speech' && kind !== 'aborted') {
				this.onError(coded(`Speech recognition error: ${kind}`, kind === 'not-allowed' ? 'permission-denied' : 'stt-failed'));
			}
		};
		rec.onend = () => {
			this._recognizer = null;
			this.onInterim('');
			const transcript = finalText.trim();
			if (!transcript) {
				this._setState('idle');
				return;
			}
			this._handleTranscript(transcript).catch((err) => this.onError(err));
		};

		try {
			rec.start();
			this._setState('listening');
			return true;
		} catch (err) {
			this.onError(coded(`Could not start mic: ${err.message}`, 'capture-failed'));
			this._setState('idle');
			return false;
		}
	}

	// ── NVIDIA Riva path (cross-browser, server-side) ──────────────────────
	_startRivaListening() {
		const mic = new MicCapture();
		this._mic = mic;
		this._setState('listening'); // optimistic — the getUserMedia prompt is showing
		mic.start().then(
			() => {
				// stopListening() may have run during the permission prompt.
				if (this._mic !== mic) {
					mic.dispose();
					return;
				}
				this._interimCount = 0;
				this._interimBusy = false;
				this._interimTimer = setInterval(() => this._fireInterim(), INTERIM_INTERVAL_MS);
			},
			(err) => {
				if (this._mic === mic) this._mic = null;
				mic.dispose();
				this._setState('idle');
				this.onError(err); // .code: permission-denied | no-mic | unsupported | capture-failed
			},
		);
	}

	async _stopRivaListening() {
		this._clearInterim();
		const mic = this._mic;
		if (!mic) return;
		this._mic = null;

		// Nothing captured (released before the mic opened) — quietly reset.
		if (!mic.capturing) {
			mic.dispose();
			this._setState('idle');
			return;
		}

		this._setState('transcribing');
		let wav = null;
		try {
			wav = await mic.stop();
		} catch {
			// fall through — treated as no audio below
		} finally {
			mic.dispose();
		}
		this.onInterim('');

		if (!wav) {
			this._setState('idle');
			return;
		}

		let transcript = '';
		try {
			transcript = (await this._recognize(wav)).trim();
		} catch (err) {
			this._setState('idle');
			this.onError(err);
			return;
		}

		if (!transcript) {
			this._setState('idle');
			this.onError(coded('No speech detected — hold the button and speak, or type your message.', 'no-speech'));
			return;
		}

		this._handleTranscript(transcript).catch((err) => this.onError(err));
	}

	// Fire one interim recognition over the audio captured so far so partial words
	// surface live. Strictly best-effort: a failed or rate-limited interim is
	// swallowed; the authoritative transcript comes from the final pass on release.
	async _fireInterim() {
		if (!this._mic || this._interimBusy || this._interimCount >= MAX_INTERIMS) return;
		const snapshot = this._mic.snapshotWav();
		if (!snapshot) return;
		this._interimBusy = true;
		this._interimCount += 1;
		try {
			const text = await this._recognize(snapshot);
			if (this._mic && text) this.onInterim(text); // still listening
		} catch {
			// interim is optional — ignore
		} finally {
			this._interimBusy = false;
		}
	}

	_clearInterim() {
		if (this._interimTimer) {
			clearInterval(this._interimTimer);
			this._interimTimer = null;
		}
		this._interimBusy = false;
	}

	// POST a WAV clip to the free Riva ASR lane and return the transcript text.
	async _recognize(wavBlob) {
		const r = await fetch(`/api/asr?language=${encodeURIComponent(this.language)}`, {
			method: 'POST',
			headers: { 'content-type': 'audio/wav' },
			credentials: 'include',
			body: wavBlob,
		});
		if (!r.ok) {
			const j = await r.json().catch(() => ({}));
			const err = coded(
				j.error_description || j.error || `Speech recognition failed (${r.status})`,
				j.error || (r.status === 429 ? 'rate_limited' : 'asr_failed'),
			);
			err.status = r.status;
			throw err;
		}
		const j = await r.json();
		return j.text || '';
	}

	/**
	 * Force a turn from text (e.g. typed message). Same downstream path as
	 * speech input — chat → TTS → lipsync.
	 */
	async say(text) {
		const trimmed = String(text || '').trim();
		if (!trimmed) return;
		await this._handleTranscript(trimmed);
	}

	/** Stop everything immediately and detach. Idempotent. */
	stop() {
		this._clearInterim();
		if (this._mic) {
			this._mic.dispose();
			this._mic = null;
		}
		this.stopListening();
		this._stopPlayback();
		this._driver?.dispose();
		this._driver = null;
		this._setState('idle');
	}

	/**
	 * Cut the reply off mid-sentence and return to rest, WITHOUT tearing the
	 * session down the way stop() does. This is barge-in: the driver says
	 * "stop talking", the voice ends, and the very next turn still works.
	 */
	hush() {
		this._stopPlayback();
		this._driver?.dispose();
		this._driver = null;
		this._setState('idle');
	}

	/**
	 * Playback volume for spoken replies, 0..1. Applies to the line currently
	 * playing and to every line after it.
	 * @returns {number} the clamped value actually in force.
	 */
	setVolume(value) {
		const next = Math.min(1, Math.max(0, Number(value)));
		if (!Number.isFinite(next)) return this._volume;
		this._volume = next;
		if (this._currentAudioEl) this._currentAudioEl.volume = next;
		return next;
	}

	/** Current playback volume, 0..1. */
	get volume() {
		return this._volume;
	}

	/**
	 * Invalidate the cached voice lookup so the next turn re-checks the agent
	 * for a (possibly newly cloned) voice_id. Call after the user finishes a
	 * voice-clone flow inside the overlay.
	 */
	refreshVoice() {
		this._voicePromise = null;
	}

	/** Recent conversation turns (for grounding an out-of-band command parse). */
	get history() {
		return this._history.slice();
	}

	/**
	 * Voice a line through the avatar WITHOUT a chat round-trip — same TTS + lipsync
	 * path as a reply. Used by the Conversational Wallet to speak read-backs,
	 * clarifying questions, and confirmations in character.
	 */
	async speakText(text) {
		const trimmed = String(text || '').trim();
		if (!trimmed) return;
		try {
			await this._speak(trimmed);
		} catch (err) {
			this.onError(err);
		}
	}

	// ── pipeline ─────────────────────────────────────────────────────────

	async _handleTranscript(transcript) {
		this.onMessage({ role: 'user', content: transcript });
		this._history.push({ role: 'user', content: transcript });

		// Wallet commands (and any other registered interceptor) get first crack at
		// the utterance. A handled command never reaches the chat model — the
		// interceptor owns the read-back, confirm, and execution path.
		if (this.commandInterceptor) {
			this._setState('thinking');
			let handled = false;
			try {
				handled = await this.commandInterceptor(transcript);
			} catch (err) {
				this.onError(err);
			}
			if (handled) {
				this._setState('idle');
				return;
			}
		}

		this._setState('thinking');

		let replyText = '';
		try {
			replyText = await this._streamChat(transcript);
		} catch (err) {
			this.onError(err);
			this._setState('idle');
			return;
		}

		if (!replyText) {
			this._setState('idle');
			return;
		}

		this._history.push({ role: 'assistant', content: replyText });
		this.onMessage({ role: 'assistant', content: replyText });

		try {
			await this._speak(replyText);
		} catch (err) {
			this.onError(err);
		}
	}

	// The agent's own persona plus, for a non-English conversation, the one line
	// that makes the reply come back in the language the user is speaking.
	_systemPrompt() {
		return [this.systemPromptFn(), languageInstruction(this.language)]
			.filter(Boolean)
			.join('\n\n');
	}

	async _streamChat(message) {
		const isUuid =
			typeof this.avatar.id === 'string' &&
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(this.avatar.id);

		const r = await fetch('/api/chat', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			credentials: 'include',
			body: JSON.stringify({
				message,
				system_prompt: this._systemPrompt(),
				history: this._history.slice(-10, -1),
				...(isUuid ? { agentId: this.avatar.id } : {}),
				...(this.avatar.agent_id ? { agentId: this.avatar.agent_id } : {}),
			}),
		});
		if (!r.ok) {
			const j = await r.json().catch(() => ({}));
			throw new Error(j.error_description || j.error || `Chat failed (${r.status})`);
		}
		const reader = r.body.getReader();
		const decoder = new TextDecoder();
		let buf = '';
		let acc = '';
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			buf += decoder.decode(value, { stream: true });
			const blocks = buf.split('\n\n');
			buf = blocks.pop() || '';
			for (const block of blocks) {
				const dataLine = block.split('\n').find((l) => l.startsWith('data:'));
				if (!dataLine) continue;
				const payload = dataLine.slice(5).trim();
				if (!payload) continue;
				let evt;
				try {
					evt = JSON.parse(payload);
				} catch {
					continue;
				}
				if (evt.type === 'chunk' && evt.text) acc += evt.text;
				else if (evt.type === 'error') throw new Error(evt.message || evt.error || 'Stream error');
			}
		}
		return acc.trim();
	}

	async _resolveVoice() {
		if (this._voicePromise) return this._voicePromise;
		const agentId = this.avatar.agent_id;
		if (!agentId) {
			this._voicePromise = Promise.resolve(null);
			return this._voicePromise;
		}
		this._voicePromise = (async () => {
			try {
				const r = await fetch(`/api/agents/${encodeURIComponent(agentId)}/voice`, {
					credentials: 'include',
				});
				if (!r.ok) return null;
				const j = await r.json();
				if (j.voice_provider === 'elevenlabs' && j.voice_id) {
					return { provider: 'elevenlabs', voiceId: j.voice_id };
				}
				return null;
			} catch {
				return null;
			}
		})();
		return this._voicePromise;
	}

	async _speak(text) {
		// Stop any in-flight playback first so consecutive turns don't overlap.
		this._stopPlayback();

		const voice = await this._resolveVoice();
		const blob = voice
			? await this._fetchTtsEleven(text, voice.voiceId)
			: await this._fetchTtsFallback(text);

		const url = URL.createObjectURL(blob);
		const audio = new Audio();
		audio.crossOrigin = 'anonymous';
		audio.volume = this._volume;
		audio.src = url;
		this._currentAudioEl = audio;

		// Build the audio graph so the analyser can read what's about to play.
		// MediaElementSource can only be created once per element — we tear it
		// down on `ended` to free the slot for the next turn.
		if (!this._audioCtx) {
			this._audioCtx = new (window.AudioContext || window.webkitAudioContext)();
		}
		if (this._audioCtx.state === 'suspended') {
			await this._audioCtx.resume().catch(() => {});
		}
		this._currentTap = tapAudioElement(audio, this._audioCtx);

		// Drive the lipsync.
		this._driver?.dispose();
		this._driver = new LipsyncDriver({
			analyser: this._currentTap.analyser,
			target: this.mouthTarget,
		});

		this._setState('speaking');

		const cleanup = () => {
			URL.revokeObjectURL(url);
			this._driver?.stop();
			this._currentTap?.disconnect();
			this._currentTap = null;
			this._currentAudioEl = null;
			this._setState('idle');
		};
		audio.onended = cleanup;
		audio.onerror = () => {
			cleanup();
			this.onError(new Error('Audio playback failed'));
		};

		this._driver.start();
		try {
			await audio.play();
		} catch (err) {
			cleanup();
			throw err;
		}
	}

	_stopPlayback() {
		if (this._currentAudioEl) {
			try {
				this._currentAudioEl.pause();
			} catch {}
			this._currentAudioEl = null;
		}
		if (this._currentTap) {
			this._currentTap.disconnect();
			this._currentTap = null;
		}
		this._driver?.stop();
	}

	async _fetchTtsEleven(text, voiceId) {
		const r = await fetch('/api/tts/eleven', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			credentials: 'include',
			body: JSON.stringify({
				voiceId: voiceId || ELEVEN_DEFAULT_VOICE,
				text: text.slice(0, 500),
				// Names the agent whose voice this is, so the proxy can serve the
				// clip on its owner's own ElevenLabs key (BYOK) rather than the
				// platform key. Without it, an owner-cloned voice is unreachable.
				...(this.avatar?.agent_id ? { agentId: this.avatar.agent_id } : {}),
			}),
		});
		if (!r.ok) {
			// Fall through to the free lanes so the talk loop still completes
			// if ElevenLabs is rate-limited or down.
			log.warn('[talk] eleven TTS failed, falling back to the free lanes');
			return this._fetchTtsFallback(text);
		}
		return r.blob();
	}

	/**
	 * Voice for an avatar with no cloned voice of its own.
	 *
	 * Edge Neural leads when the session can reach it: it selects a voice per
	 * language and body type, which the generic lane cannot. But /api/tts/edge
	 * requires a signed-in session, so an anonymous listener (a public avatar
	 * page, an embed, the car surface) used to get a working reply with no
	 * voice at all. The free NVIDIA Magpie lane on /api/tts/speak has no such
	 * gate, so it backs the chain up rather than leaving silence.
	 */
	async _fetchTtsFallback(text) {
		if (!this._edgeUnavailable) {
			try {
				return await this._fetchTtsEdge(text);
			} catch (err) {
				const message = err?.message || '';
				if (/\((401|403)\)/.test(message)) this._edgeUnavailable = true;
				log.warn('[talk] edge TTS unavailable, using the free speak lane:', message);
			}
		}
		return this._fetchTtsSpeak(text);
	}

	async _fetchTtsSpeak(text) {
		const r = await fetch('/api/tts/speak', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			credentials: 'include',
			body: JSON.stringify({
				text: text.slice(0, 1500),
				language: this.language,
				format: 'wav',
			}),
		});
		if (!r.ok) throw new Error(`TTS failed (${r.status})`);
		return r.blob();
	}

	async _fetchTtsEdge(text) {
		const gender =
			this.avatar?.source_meta?.gender ||
			this.avatar?.source_meta?.bodyType ||
			'neutral';
		// Language first, body type second: an English voice reading Mandarin is
		// unintelligible, while a female voice reading a male avatar's line is
		// merely a mismatch.
		const voice = edgeVoiceFor(this.language, gender);
		const r = await fetch('/api/tts/edge', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			credentials: 'include',
			body: JSON.stringify({ voice, text: text.slice(0, 1500) }),
		});
		if (!r.ok) throw new Error(`TTS failed (${r.status})`);
		return r.blob();
	}

	_setState(state) {
		if (this._state === state) return;
		this._state = state;
		this.onStateChange(state);
	}
}

// The language the site UI is already displayed in, when the i18n runtime is on
// the page. Read through the global instead of importing src/i18n.js: talk mode
// also runs inside embeds that never boot the translation runtime, and a hard
// import would pull the whole catalogue loader into those bundles.
function siteLocale() {
	if (typeof window === 'undefined') return '';
	try {
		return window.threewsI18n?.getLocale?.() || document.documentElement?.lang || '';
	} catch {
		return '';
	}
}

// Error carrying a machine-readable `.code` so the host UI can route each
// failure precisely (mic denial → text input, rate limit → "try later", etc).
function coded(message, code) {
	const err = new Error(message);
	err.code = code;
	return err;
}
