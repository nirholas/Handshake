/**
 * GeminiLiveClient — real-time bidirectional voice with Google Gemini Live API.
 *
 * Handles:
 *   - WebSocket connection to the Gemini Multimodal Live endpoint
 *   - AudioWorklet microphone capture at 16 kHz PCM
 *   - Scheduled PCM audio playback (24 kHz) via AudioContext
 *   - AnalyserNode tap on output (wire to LipsyncDriver)
 *   - AnalyserNode tap on mic input (wire to level meter)
 *   - Input + output audio transcription (show both sides of conversation)
 *   - Image frames for webcam context
 *
 * Usage:
 *   const client = new GeminiLiveClient({ apiKey, systemInstruction, voiceName });
 *   await client.connect();
 *   const analyser    = client.analyser;    // output — LipsyncDriver
 *   const micAnalyser = client.micAnalyser; // input  — level meter (after startMic)
 *   await client.startMic();
 *   client.on('input_transcript',  (ev) => console.log(ev.detail));  // { text, finished }
 *   client.on('output_transcript', (ev) => console.log(ev.detail));  // { text, finished }
 *   client.on('audio',  () => ...);   // avatar started speaking
 *   client.on('audio_end', () => ...);
 *   client.on('turn_complete', () => ...);
 *   client.sendImage(dataUrl);
 *   client.sendText(text);
 *   client.stopMic();
 *   client.disconnect();
 *
 * Events (CustomEvent — access payload via ev.detail):
 *   'ready'             — WS open + setupComplete received
 *   'audio'             — avatar audio playback started
 *   'audio_end'         — audio playback queue drained
 *   'input_transcript'  — { text: string, finished: boolean } user speech transcript
 *   'output_transcript' — { text: string, finished: boolean } model audio transcript
 *   'turn_complete'     — model finished its turn
 *   'interrupted'       — model interrupted by user speech
 *   'error'             — { message: string }
 */

const WS_BASE = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const MODEL   = 'models/gemini-2.0-flash-live-001';

const MIC_SAMPLE_RATE      = 16000;
const PLAYBACK_SAMPLE_RATE = 24000;
const CHUNK_INTERVAL_MS    = 100;

const WORKLET_SRC = /* js */`
class PCMCaptureProcessor extends AudioWorkletProcessor {
	constructor() {
		super();
		this._buf = [];
		this._samplesPerChunk = Math.round(${MIC_SAMPLE_RATE} * ${CHUNK_INTERVAL_MS} / 1000);
	}
	process(inputs) {
		const ch = inputs[0]?.[0];
		if (!ch) return true;
		for (let i = 0; i < ch.length; i++) this._buf.push(ch[i]);
		while (this._buf.length >= this._samplesPerChunk) {
			const slice = this._buf.splice(0, this._samplesPerChunk);
			const pcm   = new Int16Array(slice.length);
			for (let i = 0; i < slice.length; i++) {
				pcm[i] = Math.max(-32768, Math.min(32767, slice[i] * 32768));
			}
			this.port.postMessage(pcm.buffer, [pcm.buffer]);
		}
		return true;
	}
}
registerProcessor('pcm-capture', PCMCaptureProcessor);
`;

function toBase64(buffer) {
	// Use Blob + FileReader for large buffers to avoid call-stack limits
	const bytes = new Uint8Array(buffer);
	let s = '';
	const CHUNK = 0x8000;
	for (let i = 0; i < bytes.length; i += CHUNK) {
		s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	}
	return btoa(s);
}

function fromBase64(b64) {
	const bin = atob(b64);
	const buf = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
	return buf.buffer;
}

// ── AudioStreamer ─────────────────────────────────────────────────────────────

class AudioStreamer {
	constructor(ctx) {
		this._ctx           = ctx;
		this._nextTime      = 0;
		this._playing       = false;
		this._activeSources = new Set();
		this._gainNode      = ctx.createGain();
		this.analyser       = ctx.createAnalyser();
		this.analyser.fftSize = 256;
		this._gainNode.connect(this.analyser);
		this.analyser.connect(ctx.destination);
	}

	queue(int16Buffer) {
		const int16  = new Int16Array(int16Buffer);
		const float  = new Float32Array(int16.length);
		for (let i = 0; i < int16.length; i++) float[i] = int16[i] / 32768;

		const audioBuf = this._ctx.createBuffer(1, float.length, PLAYBACK_SAMPLE_RATE);
		audioBuf.copyToChannel(float, 0);

		const src = this._ctx.createBufferSource();
		src.buffer = audioBuf;
		src.connect(this._gainNode);
		this._activeSources.add(src);

		const now = this._ctx.currentTime;
		if (this._nextTime < now) this._nextTime = now + 0.05;
		src.start(this._nextTime);
		this._nextTime += audioBuf.duration;

		if (!this._playing) {
			this._playing = true;
			this._onPlayStart?.();
		}

		src.onended = () => {
			this._activeSources.delete(src);
			if (this._activeSources.size === 0 && this._nextTime <= this._ctx.currentTime + 0.05) {
				this._playing = false;
				this._onPlayEnd?.();
			}
		};
	}

	/** Immediately cancel all scheduled audio (on interrupt). */
	stop() {
		for (const src of this._activeSources) {
			try { src.stop(); } catch {}
		}
		this._activeSources.clear();
		this._nextTime = 0;
		this._playing  = false;
	}

	get isPlaying() { return this._playing; }
	onPlayStart(fn) { this._onPlayStart = fn; }
	onPlayEnd(fn)   { this._onPlayEnd   = fn; }
}

// ── GeminiLiveClient ──────────────────────────────────────────────────────────

export class GeminiLiveClient extends EventTarget {
	/**
	 * @param {object} opts
	 * @param {string}  opts.apiKey
	 * @param {string}  [opts.systemInstruction]
	 * @param {string}  [opts.voiceName]  — see VOICES export for valid names
	 */
	constructor({ apiKey, systemInstruction = '', voiceName = 'Aoede' } = {}) {
		super();
		if (!apiKey) throw new Error('GeminiLiveClient: apiKey required');
		this._apiKey            = apiKey;
		this._systemInstruction = systemInstruction;
		this._voiceName         = voiceName;

		this._ws            = null;
		this._audioCtx      = null;
		this._streamer      = null;
		this._micStream     = null;
		this._workletNode   = null;
		this._micSource     = null;
		this._captureCtx    = null;
		this._micAnalyser   = null;
		this._ready         = false;
		this._workletUrl    = null;
		this._intentionalClose = false;
	}

	/** AnalyserNode for avatar audio output — wire to LipsyncDriver. */
	get analyser() { return this._streamer?.analyser ?? null; }

	/** AnalyserNode for mic input — wire to level meter. Available after startMic(). */
	get micAnalyser() { return this._micAnalyser ?? null; }

	// ── Connection ──────────────────────────────────────────────────────────

	connect() {
		return new Promise((resolve, reject) => {
			if (this._ws) { reject(new Error('already connected')); return; }

			const url = `${WS_BASE}?key=${encodeURIComponent(this._apiKey)}`;
			const ws  = new WebSocket(url);
			this._ws  = ws;

			this._audioCtx = new AudioContext({ sampleRate: PLAYBACK_SAMPLE_RATE });
			this._streamer = new AudioStreamer(this._audioCtx);
			this._streamer.onPlayStart(() => this._emit('audio'));
			this._streamer.onPlayEnd(()   => this._emit('audio_end'));

			ws.addEventListener('open', () => {
				ws.send(JSON.stringify({
					setup: {
						model: MODEL,
						generation_config: {
							response_modalities: ['AUDIO'],
							speech_config: {
								voice_config: {
									prebuilt_voice_config: { voice_name: this._voiceName },
								},
							},
						},
						input_audio_transcription:  {},
						output_audio_transcription: {},
						...(this._systemInstruction ? {
							system_instruction: { parts: [{ text: this._systemInstruction }] },
						} : {}),
					},
				}));
			});

			ws.addEventListener('message', (ev) => {
				let msg;
				try { msg = JSON.parse(ev.data); } catch { return; }

				if (msg.setupComplete !== undefined) {
					this._ready = true;
					this._emit('ready');
					resolve();
					return;
				}

				const sc = msg.serverContent;
				if (!sc) return;

				if (sc.interrupted) {
					this._streamer?.stop();
					this._emit('interrupted');
					return;
				}

				// Audio + inline text parts
				if (sc.modelTurn?.parts) {
					for (const part of sc.modelTurn.parts) {
						if (part.inlineData?.mimeType?.startsWith('audio/pcm')) {
							this._streamer.queue(fromBase64(part.inlineData.data));
						}
					}
				}

				// User speech transcript (incremental)
				if (sc.inputTranscription) {
					const text     = sc.inputTranscription.text ?? sc.inputTranscription.parts?.[0]?.text ?? '';
					const finished = sc.inputTranscription.finished ?? false;
					if (text) this._emit('input_transcript', { text, finished });
				}

				// Model audio transcript (incremental — more accurate than inline text parts)
				if (sc.outputTranscription) {
					const text     = sc.outputTranscription.text ?? sc.outputTranscription.parts?.[0]?.text ?? '';
					const finished = sc.outputTranscription.finished ?? false;
					if (text) this._emit('output_transcript', { text, finished });
				}

				if (sc.turnComplete) {
					this._emit('turn_complete');
				}
			});

			ws.addEventListener('error', () => {
				const err = new Error('WebSocket error');
				this._emit('error', { message: err.message });
				reject(err);
			});

			ws.addEventListener('close', (ev) => {
				this._ready = false;
				if (!this._intentionalClose) {
					this._emit('error', { message: `Connection closed (${ev.code})` });
				}
			});
		});
	}

	disconnect() {
		this._intentionalClose = true;
		this.stopMic();
		this._streamer?.stop();
		this._ws?.close();
		this._ws      = null;
		this._streamer = null;
		this._audioCtx?.close();
		this._audioCtx = null;
		if (this._workletUrl) {
			URL.revokeObjectURL(this._workletUrl);
			this._workletUrl = null;
		}
	}

	// ── Microphone ──────────────────────────────────────────────────────────

	async startMic() {
		if (this._micStream) return;

		this._micStream = await navigator.mediaDevices.getUserMedia({
			audio: { channelCount: 1, sampleRate: MIC_SAMPLE_RATE, echoCancellation: true, noiseSuppression: true },
			video: false,
		});

		const captureCtx = new AudioContext({ sampleRate: MIC_SAMPLE_RATE });
		this._captureCtx = captureCtx;

		if (!this._workletUrl) {
			const blob       = new Blob([WORKLET_SRC], { type: 'application/javascript' });
			this._workletUrl = URL.createObjectURL(blob);
		}
		await captureCtx.audioWorklet.addModule(this._workletUrl);

		this._micSource   = captureCtx.createMediaStreamSource(this._micStream);
		this._workletNode = new AudioWorkletNode(captureCtx, 'pcm-capture');

		// Level meter tap
		this._micAnalyser         = captureCtx.createAnalyser();
		this._micAnalyser.fftSize = 64;
		this._micSource.connect(this._micAnalyser);
		this._micSource.connect(this._workletNode);

		this._workletNode.port.onmessage = (ev) => {
			if (!this._ready || !this._ws || this._ws.readyState !== WebSocket.OPEN) return;
			this._ws.send(JSON.stringify({
				realtime_input: {
					media_chunks: [{ data: toBase64(ev.data), mime_type: `audio/pcm;rate=${MIC_SAMPLE_RATE}` }],
				},
			}));
		};
	}

	stopMic() {
		this._workletNode?.disconnect();
		this._micSource?.disconnect();
		this._micStream?.getTracks().forEach((t) => t.stop());
		this._captureCtx?.close();
		this._workletNode = null;
		this._micSource   = null;
		this._micStream   = null;
		this._captureCtx  = null;
		this._micAnalyser = null;
	}

	// ── Inputs ──────────────────────────────────────────────────────────────

	sendText(text) {
		if (!this._ready) return;
		this._ws.send(JSON.stringify({
			client_content: { turns: [{ role: 'user', parts: [{ text }] }], turn_complete: true },
		}));
	}

	sendImage(dataUrl) {
		if (!this._ready) return;
		const base64 = dataUrl.split(',')[1];
		if (!base64) return;
		this._ws.send(JSON.stringify({
			realtime_input: { media_chunks: [{ data: base64, mime_type: 'image/jpeg' }] },
		}));
	}

	// ── Internals ────────────────────────────────────────────────────────────

	_emit(type, detail = null) {
		this.dispatchEvent(new CustomEvent(type, detail ? { detail } : {}));
	}

	on(type, fn) {
		this.addEventListener(type, fn);
		return this;
	}
}

/** All available Gemini prebuilt voice names. */
export const VOICES = ['Aoede', 'Charon', 'Fenrir', 'Kore', 'Leda', 'Orus', 'Puck', 'Zephyr'];
