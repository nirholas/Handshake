/**
 * GeminiLiveClient — real-time bidirectional voice with Google Gemini Live API.
 *
 * Handles:
 *   - WebSocket connection to the Gemini Multimodal Live endpoint
 *   - AudioWorklet microphone capture at 16 kHz PCM
 *   - Scheduled PCM audio playback (24 kHz) via AudioContext
 *   - AnalyserNode tap so callers can drive LipsyncDriver from the live output
 *   - Image frames for webcam context (sendImage)
 *
 * Usage:
 *   const client = new GeminiLiveClient({ apiKey, systemInstruction });
 *   await client.connect();          // opens WS, waits for setupComplete
 *   const analyser = client.analyser; // wire to LipsyncDriver
 *   await client.startMic();          // begin capturing + sending audio
 *   client.on('text',  ({ text }) => ...);
 *   client.on('audio', () => ...);    // avatar started speaking
 *   client.on('turn_complete', () => ...);
 *   client.sendImage(dataUrl);        // webcam frame (jpeg data URL)
 *   client.stopMic();
 *   client.disconnect();
 *
 * Events dispatched on the EventTarget:
 *   'ready'          — WS open + setupComplete received
 *   'audio'          — avatar is outputting audio (detail: null; use analyser)
 *   'audio_end'      — audio playback queue drained
 *   'text'           — { text: string } model text / transcript chunk
 *   'turn_complete'  — model finished its turn
 *   'interrupted'    — model was interrupted by user speech
 *   'error'          — { message: string }
 */

const WS_BASE = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const MODEL   = 'models/gemini-2.0-flash-live-001';

const MIC_SAMPLE_RATE      = 16000;
const PLAYBACK_SAMPLE_RATE = 24000;
const CHUNK_INTERVAL_MS    = 100; // send mic PCM every N ms

// AudioWorklet source code — runs in its own thread, emits 16 kHz Int16 chunks.
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
	const bytes = new Uint8Array(buffer);
	let s = '';
	for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
	return btoa(s);
}

function fromBase64(b64) {
	const bin  = atob(b64);
	const buf  = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
	return buf.buffer;
}

// ── AudioStreamer ─────────────────────────────────────────────────────────────
// Schedules incoming 24 kHz Int16 PCM chunks for glitch-free playback.

class AudioStreamer {
	constructor(ctx) {
		this._ctx        = ctx;
		this._nextTime   = 0;
		this._playing    = false;
		this._gainNode   = ctx.createGain();
		this.analyser    = ctx.createAnalyser();
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

		const now = this._ctx.currentTime;
		if (this._nextTime < now) this._nextTime = now + 0.05; // small buffer
		src.start(this._nextTime);
		this._nextTime += audioBuf.duration;

		if (!this._playing) {
			this._playing = true;
			this._onPlayStart?.();
		}

		src.onended = () => {
			if (this._nextTime <= this._ctx.currentTime + 0.05) {
				this._playing = false;
				this._onPlayEnd?.();
			}
		};
	}

	stop() {
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
	 * @param {string} opts.apiKey              — Gemini API key
	 * @param {string} [opts.systemInstruction] — system prompt for the avatar
	 * @param {string} [opts.voiceName]         — Gemini voice (default: 'Aoede')
	 */
	constructor({ apiKey, systemInstruction = '', voiceName = 'Aoede' } = {}) {
		super();
		if (!apiKey) throw new Error('GeminiLiveClient: apiKey required');
		this._apiKey            = apiKey;
		this._systemInstruction = systemInstruction;
		this._voiceName         = voiceName;

		this._ws           = null;
		this._audioCtx     = null;
		this._streamer     = null;
		this._micStream    = null;
		this._workletNode  = null;
		this._micSource    = null;
		this._ready        = false;
		this._workletUrl   = null;
	}

	/** The AnalyserNode fed by avatar audio output. Wire this to LipsyncDriver. */
	get analyser() {
		return this._streamer?.analyser ?? null;
	}

	// ── Connection ──────────────────────────────────────────────────────────

	/**
	 * Open the WebSocket and wait for Gemini's setupComplete handshake.
	 * @returns {Promise<void>}
	 */
	connect() {
		return new Promise((resolve, reject) => {
			if (this._ws) reject(new Error('already connected'));

			const url = `${WS_BASE}?key=${encodeURIComponent(this._apiKey)}`;
			const ws  = new WebSocket(url);
			this._ws  = ws;

			// Ensure AudioContext exists (must be created before/after user gesture;
			// callers should invoke connect() from a click handler).
			this._audioCtx  = new AudioContext({ sampleRate: PLAYBACK_SAMPLE_RATE });
			this._streamer  = new AudioStreamer(this._audioCtx);

			this._streamer.onPlayStart(() => this._emit('audio'));
			this._streamer.onPlayEnd(()   => this._emit('audio_end'));

			ws.addEventListener('open', () => {
				// Send setup
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
						...(this._systemInstruction ? {
							system_instruction: {
								parts: [{ text: this._systemInstruction }],
							},
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

				if (sc.modelTurn?.parts) {
					for (const part of sc.modelTurn.parts) {
						if (part.inlineData?.mimeType?.startsWith('audio/pcm')) {
							const buf = fromBase64(part.inlineData.data);
							this._streamer.queue(buf);
						}
						if (typeof part.text === 'string') {
							this._emit('text', { text: part.text });
						}
					}
				}

				if (sc.turnComplete) {
					this._emit('turn_complete');
				}
			});

			ws.addEventListener('error', (ev) => {
				const msg = ev.message || 'WebSocket error';
				this._emit('error', { message: msg });
				reject(new Error(msg));
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
		this._ws?.close();
		this._ws = null;
		this._audioCtx?.close();
		this._audioCtx = null;
		this._streamer  = null;
		if (this._workletUrl) {
			URL.revokeObjectURL(this._workletUrl);
			this._workletUrl = null;
		}
	}

	// ── Microphone ──────────────────────────────────────────────────────────

	/**
	 * Start capturing the user's microphone and streaming PCM to Gemini.
	 * Requires connect() to have resolved first.
	 * @returns {Promise<void>}
	 */
	async startMic() {
		if (this._micStream) return;

		this._micStream = await navigator.mediaDevices.getUserMedia({
			audio: {
				channelCount:     1,
				sampleRate:       MIC_SAMPLE_RATE,
				echoCancellation: true,
				noiseSuppression: true,
			},
			video: false,
		});

		// The mic AudioContext must match the capture sample rate.
		// We create a separate context for capture so playback stays at 24 kHz.
		const captureCtx = new AudioContext({ sampleRate: MIC_SAMPLE_RATE });
		this._captureCtx = captureCtx;

		// Register the worklet processor once per context.
		if (!this._workletUrl) {
			const blob        = new Blob([WORKLET_SRC], { type: 'application/javascript' });
			this._workletUrl  = URL.createObjectURL(blob);
		}
		await captureCtx.audioWorklet.addModule(this._workletUrl);

		this._micSource   = captureCtx.createMediaStreamSource(this._micStream);
		this._workletNode = new AudioWorkletNode(captureCtx, 'pcm-capture');

		this._workletNode.port.onmessage = (ev) => {
			if (!this._ready || !this._ws || this._ws.readyState !== WebSocket.OPEN) return;
			this._ws.send(JSON.stringify({
				realtime_input: {
					media_chunks: [{
						data:      toBase64(ev.data),
						mime_type: `audio/pcm;rate=${MIC_SAMPLE_RATE}`,
					}],
				},
			}));
		};

		this._micSource.connect(this._workletNode);
		// Don't connect worklet output to destination — we only need the side-effect
		// of the port messages.
	}

	/** Stop microphone capture (leaves WS open). */
	stopMic() {
		this._workletNode?.disconnect();
		this._micSource?.disconnect();
		this._micStream?.getTracks().forEach((t) => t.stop());
		this._captureCtx?.close();
		this._workletNode = null;
		this._micSource   = null;
		this._micStream   = null;
		this._captureCtx  = null;
	}

	// ── Inputs ──────────────────────────────────────────────────────────────

	/**
	 * Send a text message to Gemini.
	 * @param {string} text
	 */
	sendText(text) {
		if (!this._ready) return;
		this._ws.send(JSON.stringify({
			client_content: {
				turns: [{ role: 'user', parts: [{ text }] }],
				turn_complete: true,
			},
		}));
	}

	/**
	 * Send a JPEG image frame (e.g. from FaceMocap's webcam video).
	 * @param {string} dataUrl — data:image/jpeg;base64,...
	 */
	sendImage(dataUrl) {
		if (!this._ready) return;
		const base64 = dataUrl.split(',')[1];
		if (!base64) return;
		this._ws.send(JSON.stringify({
			realtime_input: {
				media_chunks: [{
					data:      base64,
					mime_type: 'image/jpeg',
				}],
			},
		}));
	}

	// ── Internals ────────────────────────────────────────────────────────────

	_emit(type, detail = null) {
		this.dispatchEvent(Object.assign(new Event(type), detail ? { detail } : {}));
	}

	/** Register an event listener with a shorter API. */
	on(type, fn) {
		this.addEventListener(type, fn);
		return this;
	}
}
