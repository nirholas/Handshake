// Speech I/O — TTS and STT. Browser-native by default; provider-swappable.

export { LiveKitVoice } from './livekit-voice.js';
export { NeuralTTS } from './neural-tts.js';
import { NeuralTTS } from './neural-tts.js';
import { startLipsync } from './lipsync.js';
import { ACTION_TYPES } from '../agent-protocol.js';

export class BrowserTTS {
	constructor({ voiceId = 'default', rate = 1, pitch = 1, lang = 'en-US' } = {}) {
		this.voiceId = voiceId;
		this.rate = rate;
		this.pitch = pitch;
		this.lang = lang;
		this._queue = [];
		this._speaking = false;
		this._lipsync = null;
		// Global hooks — set by callers that manage lipsync externally (e.g. AgentAvatar).
		this.onStart = null;
		this.onEnd = null;
	}

	async speak(text, { onStart, onEnd, scene } = {}) {
		if (!('speechSynthesis' in window)) return;
		return new Promise((resolve) => {
			const utter = new SpeechSynthesisUtterance(text);
			utter.rate = this.rate;
			utter.pitch = this.pitch;
			utter.lang = this.lang;
			const voice = this._pickVoice();
			if (voice) utter.voice = voice;
			utter.onstart = () => {
				this._speaking = true;
				if (scene) this._lipsync = startLipsync(text, scene);
				this.onStart?.();
				onStart?.();
			};
			utter.onend = () => {
				this._speaking = false;
				this._lipsync?.stop();
				this._lipsync = null;
				this.onEnd?.();
				onEnd?.();
				resolve();
			};
			utter.onerror = () => {
				this._speaking = false;
				this._lipsync?.stop();
				this._lipsync = null;
				resolve();
			};
			window.speechSynthesis.speak(utter);
		});
	}

	cancel(protocol) {
		const wasSpeak = this._speaking;
		if ('speechSynthesis' in window) window.speechSynthesis.cancel();
		this._lipsync?.stop();
		this._lipsync = null;
		this._speaking = false;
		if (wasSpeak && protocol) {
			protocol.emit({ type: ACTION_TYPES.INTERRUPTED, payload: {} });
		}
	}

	get speaking() {
		return this._speaking;
	}

	_pickVoice() {
		if (!('speechSynthesis' in window)) return null;
		const voices = window.speechSynthesis.getVoices();
		if (this.voiceId && this.voiceId !== 'default') {
			const found = voices.find(
				(v) => v.name === this.voiceId || v.voiceURI === this.voiceId,
			);
			if (found) return found;
		}
		return voices.find((v) => v.lang?.startsWith(this.lang.slice(0, 2))) || null;
	}
}

export class BrowserSTT {
	constructor({ language = 'en-US', continuous = false, interimResults = true } = {}) {
		this.language = language;
		this.continuous = continuous;
		this.interimResults = interimResults;
		this._recognition = null;
		this._listening = false;
	}

	_ensure() {
		if (this._recognition) return this._recognition;
		const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
		if (!SR) return null;
		const r = new SR();
		r.lang = this.language;
		r.continuous = this.continuous;
		r.interimResults = this.interimResults;
		this._recognition = r;
		return r;
	}

	async listen({ onInterim, onFinal } = {}) {
		const r = this._ensure();
		if (!r) throw new Error('SpeechRecognition unavailable in this browser');
		return new Promise((resolve, reject) => {
			let finalText = '';
			r.onresult = (ev) => {
				for (let i = ev.resultIndex; i < ev.results.length; i++) {
					const res = ev.results[i];
					const text = res[0].transcript;
					if (res.isFinal) {
						finalText += text;
						onFinal?.(text);
					} else {
						onInterim?.(text);
					}
				}
			};
			r.onerror = (e) => {
				this._listening = false;
				reject(e.error);
			};
			r.onend = () => {
				this._listening = false;
				resolve(finalText.trim());
			};
			this._listening = true;
			try {
				r.start();
			} catch (e) {
				this._listening = false;
				reject(e);
			}
		});
	}

	stop() {
		if (this._recognition && this._listening) this._recognition.stop();
	}

	get listening() {
		return this._listening;
	}
}

/**
 * ElevenLabs TTS — streaming MP3 playback via fetch + MediaSource.
 *
 * Wire format:
 *   POST {proxyURL || `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`}
 *   headers: { 'content-type': 'application/json',
 *              'accept': 'audio/mpeg',
 *              'xi-api-key': apiKey }   ← only when proxyURL is unset
 *   body:    { text, model_id, voice_settings: { stability, similarity_boost, style, use_speaker_boost } }
 *
 * Proxy contract (when proxyURL is set):
 *   The proxy receives the same JSON body and forwards it to ElevenLabs with a
 *   server-side key, then streams the audio response back unchanged. Clients
 *   never see the api key. The proxy may also accept `{ voiceId, modelId }` as
 *   top-level fields if it wants to encode the path itself.
 *
 * voice_settings mapping:
 *   `rate`  is mapped onto `style` (0..1) — ElevenLabs has no true playback-
 *           rate control on the Turbo/Flash models, but `style` shifts delivery
 *           pacing, so a higher rate translates to a more emphatic/faster
 *           feel. `rate` 0.5..1.5 → `style` 0..1, clamped.
 *   `pitch` has no analogue in ElevenLabs voice_settings, so it is dropped
 *           with a comment rather than silently misapplied. To get a higher
 *           voice, pick a different voiceId.
 *   `stability`, `similarity_boost`, `use_speaker_boost` use ElevenLabs'
 *   recommended defaults (0.5, 0.75, true) and can be overridden per instance.
 */
export class ElevenLabsTTS {
	constructor({
		voiceId,
		modelId = 'eleven_flash_v2_5',
		apiKey = null,
		proxyURL = null,
		agentId = null,
		rate = 1,
		pitch = 1,
		lang = 'en-US',
		stability = 0.5,
		similarityBoost = 0.75,
		style = null,
		useSpeakerBoost = true,
	} = {}) {
		if (!voiceId) throw new Error('ElevenLabsTTS requires voiceId');
		this.voiceId = voiceId;
		this.modelId = modelId;
		this.apiKey = apiKey;
		this.proxyURL = proxyURL;
		// The agent this voice belongs to. Forwarded to the proxy so it can serve
		// the clip on the agent owner's own ElevenLabs key, which is what lets a
		// bound voice speak to visitors and inside cross-origin embeds rather than
		// only to the signed-in owner.
		this.agentId = agentId;
		this.rate = rate;
		this.pitch = pitch; // unused — see class comment
		this.lang = lang;
		this.stability = stability;
		this.similarityBoost = similarityBoost;
		// Explicit style override (0..1). When null, style is derived from `rate`.
		this.style = style;
		this.useSpeakerBoost = useSpeakerBoost;

		this._speaking = false;
		this._abort = null; // current AbortController
		this._audio = null; // current <audio> element
		this._mediaSourceURL = null; // for revocation
		this._onEnd = null; // pending resolve
		this._lipsync = null;
		this._positionalAudio = null; // THREE.PositionalAudio, optional
		// Web Audio nodes for LipSyncAnalyser integration
		this._audioCtx = null;
		this._analyserNode = null;
		this._mediaSource = null;
		// Global hooks — set by callers that manage lipsync externally (e.g. AgentAvatar).
		this.onStart = null;
		this.onEnd = null;
	}

	/** Expose the shared AnalyserNode so LipSyncAnalyser can read frequency data. */
	get analyserNode() {
		return this._analyserNode;
	}

	/** @param {import('three').PositionalAudio|null} pa */
	setPositionalAudio(pa) {
		this._positionalAudio = pa;
	}

	async speak(text, { onStart, onEnd, scene } = {}) {
		this.cancel();
		if (!text) return;

		this._abort = new AbortController();
		this._speaking = true;

		const url =
			this.proxyURL ||
			`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(this.voiceId)}/stream`;

		const headers = { 'content-type': 'application/json', accept: 'audio/mpeg' };
		// apiKey is only sent when there's no proxy. Proxies must keep keys server-side.
		if (!this.proxyURL && this.apiKey) headers['xi-api-key'] = this.apiKey;

		// Explicit style wins; otherwise map rate (0.5..1.5) → style (0..1).
		const rateNorm = Math.min(1.5, Math.max(0.5, this.rate));
		const styleVal =
			this.style != null
				? Math.min(1, Math.max(0, Number(this.style)))
				: Math.min(1, Math.max(0, (rateNorm - 0.5) / 1.0));

		const body = JSON.stringify({
			text,
			model_id: this.modelId,
			voice_settings: {
				stability: this.stability,
				similarity_boost: this.similarityBoost,
				style: styleVal,
				use_speaker_boost: this.useSpeakerBoost,
			},
			// Forwarded for proxies that prefer a single endpoint
			voiceId: this.voiceId,
			modelId: this.modelId,
			...(this.agentId ? { agentId: this.agentId } : {}),
		});

		let resp;
		try {
			resp = await fetch(url, {
				method: 'POST',
				headers,
				body,
				signal: this._abort.signal,
			});
		} catch (err) {
			this._speaking = false;
			if (err.name === 'AbortError') return;
			throw err;
		}

		if (!resp.ok) {
			this._speaking = false;
			throw new Error(`ElevenLabs TTS HTTP ${resp.status}`);
		}

		// Try MediaSource first (low-latency streaming). Fall back to buffered
		// playback for browsers that don't support MSE for audio/mpeg (Safari).
		const supportsMSE =
			typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported('audio/mpeg');

		const playStarted = (cb) => {
			if (this._startedFired) return;
			this._startedFired = true;
			cb?.();
		};
		this._startedFired = false;

		return new Promise((resolve) => {
			this._onEnd = () => {
				this._speaking = false;
				this._lipsync?.stop();
				this._lipsync = null;
				this._cleanupAudio();
				this.onEnd?.();
				onEnd?.();
				this._onEnd = null;
				resolve();
			};

			const finishOnError = () => {
				if (this._onEnd) this._onEnd();
			};

			const lipsyncOnStart = () => {
				this.onStart?.();
				onStart?.();
			};

			if (supportsMSE && resp.body) {
				this._playStreamingMSE(resp.body, () => playStarted(lipsyncOnStart), finishOnError);
			} else {
				this._playBuffered(resp, () => playStarted(lipsyncOnStart), finishOnError);
			}
		});
	}

	cancel(protocol) {
		const wasSpeak = this._speaking;
		if (this._abort) {
			try {
				this._abort.abort();
			} catch {}
			this._abort = null;
		}
		this._lipsync?.stop();
		this._lipsync = null;
		this._cleanupAudio();
		this._speaking = false;
		// Resolve any pending speak() promise so callers don't hang
		if (this._onEnd) this._onEnd();
		if (wasSpeak && protocol) {
			protocol.emit({ type: ACTION_TYPES.INTERRUPTED, payload: {} });
		}
	}

	get speaking() {
		return this._speaking;
	}

	// ── Internal: Web Audio analyser for LipSyncAnalyser ──────────────────

	_setupAnalyser(audio) {
		const AC = window.AudioContext || window.webkitAudioContext;
		if (!AC) return;
		try {
			if (!this._audioCtx || this._audioCtx.state === 'closed') {
				this._audioCtx = new AC();
				this._analyserNode = this._audioCtx.createAnalyser();
				this._analyserNode.fftSize = 256;
				this._analyserNode.smoothingTimeConstant = 0.7;
				this._analyserNode.connect(this._audioCtx.destination);
			}
			this._mediaSource?.disconnect();
			this._mediaSource = this._audioCtx.createMediaElementSource(audio);
			this._mediaSource.connect(this._analyserNode);
			this._audioCtx.resume().catch(() => {});
		} catch {
			// Degrade silently — CORS, autoplay policy, or element already captured
		}
	}

	// ── Internal: spatial audio wiring ────────────────────────────────────

	_connectPositionalAudio(audioEl) {
		const pa = this._positionalAudio;
		if (!pa) return;
		// Disconnect any previous MediaElementSource from this PositionalAudio
		try {
			pa.source?.disconnect();
		} catch {}
		// Wire the new element through the spatial panner already set up by Three.js:
		// MediaElementSource → panner → audio.gain → listener.gain → context.destination
		pa.source = pa.context.createMediaElementSource(audioEl);
		pa.source.connect(pa.panner);
		// Resume context if suspended — required until first user interaction
		if (pa.context.state === 'suspended') pa.context.resume().catch(() => {});
	}

	// ── Internal: streaming via MediaSource ────────────────────────────────

	_playStreamingMSE(stream, onStart, onError) {
		const ms = new MediaSource();
		this._mediaSourceURL = URL.createObjectURL(ms);
		const audio = new Audio(this._mediaSourceURL);
		this._audio = audio;
		audio.preload = 'auto';
		// Wire Web Audio analyser before playback starts so analyserNode is ready
		// when the 'playing' event fires (which triggers onStart → avatar.connectLipSync).
		this._setupAnalyser(audio);

		audio.addEventListener('playing', onStart, { once: true });
		audio.addEventListener('ended', () => this._onEnd?.(), { once: true });
		audio.addEventListener('error', () => onError?.(), { once: true });

		this._connectPositionalAudio(audio);

		ms.addEventListener('sourceopen', async () => {
			let sb;
			try {
				sb = ms.addSourceBuffer('audio/mpeg');
			} catch (err) {
				onError?.();
				return;
			}

			const reader = stream.getReader();
			const queue = [];
			let reading = true;

			const pump = () => {
				if (!reading || sb.updating) return;
				const next = queue.shift();
				if (!next) return;
				try {
					sb.appendBuffer(next);
				} catch {
					reading = false;
					try {
						ms.endOfStream();
					} catch {}
				}
			};

			sb.addEventListener('updateend', pump);

			try {
				while (reading) {
					const { value, done } = await reader.read();
					if (done) {
						reading = false;
						const wait = () => {
							if (sb.updating || queue.length) {
								setTimeout(wait, 30);
							} else {
								try {
									ms.endOfStream();
								} catch {}
							}
						};
						wait();
						break;
					}
					queue.push(value);
					pump();
				}
			} catch (err) {
				if (err.name !== 'AbortError') onError?.();
			}
		});

		audio.play().catch(onError);
	}

	// ── Internal: buffered playback fallback (Safari) ──────────────────────

	async _playBuffered(resp, onStart, onError) {
		try {
			const blob = await resp.blob();
			const url = URL.createObjectURL(blob);
			this._mediaSourceURL = url;
			const audio = new Audio(url);
			this._audio = audio;
			this._setupAnalyser(audio);
			audio.addEventListener('playing', onStart, { once: true });
			audio.addEventListener('ended', () => this._onEnd?.(), { once: true });
			audio.addEventListener('error', () => onError?.(), { once: true });
			this._connectPositionalAudio(audio);
			await audio.play();
		} catch (err) {
			if (err.name !== 'AbortError') onError?.();
		}
	}

	_cleanupAudio() {
		// Disconnect the per-speak MediaElementSourceNode (analyser + ctx are reused).
		if (this._mediaSource) {
			try {
				this._mediaSource.disconnect();
			} catch {}
			this._mediaSource = null;
		}
		if (this._positionalAudio?.source) {
			try {
				this._positionalAudio.source.disconnect();
			} catch {}
			this._positionalAudio.source = null;
		}
		if (this._audio) {
			try {
				this._audio.pause();
			} catch {}
			this._audio.src = '';
			this._audio = null;
		}
		if (this._mediaSourceURL) {
			try {
				URL.revokeObjectURL(this._mediaSourceURL);
			} catch {}
			this._mediaSourceURL = null;
		}
		this._startedFired = false;
	}
}

const TTS_FACTORIES = {
	none: () => null,
	browser: (cfg) => new BrowserTTS(cfg),
	neural: (cfg) => new NeuralTTS(cfg),
	elevenlabs: (cfg) => new ElevenLabsTTS(cfg),
};

const STT_FACTORIES = {
	none: () => null,
	browser: (cfg) => new BrowserSTT(cfg),
};

export function createTTS(config = {}) {
	const provider = config.provider || 'browser';
	const factory = TTS_FACTORIES[provider];
	if (!factory) {
		throw new Error(
			`Unknown TTS provider "${provider}". Supported: ${Object.keys(TTS_FACTORIES).join(', ')}.`,
		);
	}
	return factory(config);
}

/**
 * Turn a public agent record into the TTS config that plays its bound voice.
 *
 * Every surface that speaks as an agent (the hosted embed, the SDK runtime)
 * needs the same three things from the agent row, and getting any of them
 * wrong is silent: the agent just falls back to a generic voice or goes mute.
 *
 *   voice_id       — which voice to speak with.
 *   agentId        — WHICH AGENT this voice belongs to. The /api/tts/eleven
 *                    proxy only serves an owner-BYOK clone when the request
 *                    names its agent, because that is what authorizes spending
 *                    the owner's ElevenLabs credential. Omit it and a bound
 *                    voice is unreachable to embed visitors and signed-out
 *                    listeners, which is exactly who embeds are for.
 *   voice_model /
 *   voice_settings — the tuning the owner saved in the editor. Dropping these
 *                    plays the right voice with the wrong delivery.
 *
 * Returns null when the agent has no ElevenLabs voice bound, so callers can
 * render their own "no voice configured" state rather than guessing a default.
 *
 * @param {{id?: string, voice_provider?: string, voice_id?: string|null,
 *          voice_model?: string|null, voice_settings?: object|null}|null} agent
 * @param {{ proxyURL?: string, agentId?: string }} [opts]
 * @returns {object|null} a createTTS config, or null when nothing is bound.
 */
export function agentVoiceConfig(agent, { proxyURL = '/api/tts/eleven', agentId } = {}) {
	const voiceId = agent?.voice_id || null;
	if (!voiceId || (agent?.voice_provider && agent.voice_provider !== 'elevenlabs')) return null;

	const id = agentId || agent?.id || null;
	const s = agent?.voice_settings && typeof agent.voice_settings === 'object' ? agent.voice_settings : null;

	return {
		provider: 'elevenlabs',
		voiceId,
		proxyURL,
		...(id ? { agentId: id } : {}),
		...(agent?.voice_model ? { modelId: agent.voice_model } : {}),
		...(s?.stability != null ? { stability: Number(s.stability) } : {}),
		...(s?.similarity_boost != null ? { similarityBoost: Number(s.similarity_boost) } : {}),
		...(s?.style != null ? { style: Number(s.style) } : {}),
		...(s?.use_speaker_boost != null ? { useSpeakerBoost: !!s.use_speaker_boost } : {}),
	};
}

export function createSTT(config = {}) {
	const provider = config.provider || 'browser';
	const factory = STT_FACTORIES[provider];
	if (!factory) {
		throw new Error(
			`Unknown STT provider "${provider}". Supported: ${Object.keys(STT_FACTORIES).join(', ')}.`,
		);
	}
	return factory(config);
}

export async function createVoice(config = {}) {
	if (config.provider !== 'livekit') return null;
	const { LiveKitVoice } = await import('./livekit-voice.js');
	return new LiveKitVoice(config);
}
