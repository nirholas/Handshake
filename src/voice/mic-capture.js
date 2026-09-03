/**
 * MicCapture — cross-browser microphone capture for the NVIDIA Riva ASR lane.
 *
 * The browser's MediaRecorder produces WebM/Opus, which Riva ASR rejects, so we
 * capture raw PCM via the Web Audio graph instead and resample it to the 16 kHz
 * mono LINEAR_PCM that /api/asr expects. This works in every browser — including
 * Firefox, where window.SpeechRecognition does not exist — which is the whole
 * reason the Riva lane exists.
 *
 * Capture path:
 *   getUserMedia ─▶ MediaStreamSource ─▶ AudioWorklet (or ScriptProcessor) ─▶ Float32 chunks
 *                                    └─▶ AnalyserNode (live RMS for the UI mic meter)
 *
 * The AudioContext runs at the device's native rate; we accumulate Float32
 * samples and downsample to 16 kHz only when a WAV is built (final on release,
 * or an interim snapshot mid-hold), so no per-sample resampling runs on the
 * audio thread. AudioWorklet is preferred; ScriptProcessorNode is the fallback
 * for Safari/older browsers where addModule isn't available.
 *
 * Usage:
 *   const mic = new MicCapture();
 *   await mic.start();                 // throws 'permission-denied' | 'no-mic' | 'unsupported'
 *   mic.getLevel();                    // 0..1 RMS, drive a live indicator
 *   const interim = mic.snapshotWav(); // Blob | null — audio so far, for a partial pass
 *   const final = await mic.stop();    // Blob | null — the full utterance as a 16 kHz WAV
 *   mic.dispose();                     // idempotent teardown
 *
 * Streaming, for callers that push audio somewhere live instead of recording it
 * (the Home Assistant voice satellite, src/home/satellite.js):
 *
 *   const down = new PcmDownsampler(48000);
 *   const mic = new MicCapture({ retain: false, onFrame: (f) => send(down.push(f)) });
 *
 * `retain: false` is what keeps an always-on microphone from growing without
 * bound; `PcmDownsampler` is the streaming counterpart of the WAV builder's
 * resample and carries its phase across frames so the output has no seams.
 */

const TARGET_RATE = 16000;

// Posts mono Float32 frames from the audio thread to the main thread. Kept tiny
// and dependency-free so it survives being inlined as a Blob module URL.
const WORKLET_SRC = /* js */ `
class MicCaptureProcessor extends AudioWorkletProcessor {
	process(inputs) {
		const ch = inputs[0] && inputs[0][0];
		if (ch && ch.length) this.port.postMessage(ch.slice(0));
		return true;
	}
}
registerProcessor('mic-capture', MicCaptureProcessor);
`;

export class MicCapture {
	/**
	 * @param {object} [options]
	 * @param {(frame: Float32Array) => void} [options.onFrame]
	 *        Live capture. Every frame the audio thread produces is handed over
	 *        at the device's native rate, as it arrives. Used by anything that
	 *        streams rather than records: the Home Assistant voice satellite
	 *        (src/home/satellite.js) pushes these straight into a pipeline.
	 * @param {boolean} [options.retain=true]
	 *        Keep every frame so `stop()` and `snapshotWav()` can build a WAV.
	 *        A streaming caller passes false: an always-on satellite that
	 *        retained its microphone would grow by 5 MB an hour forever, and it
	 *        never asks for the WAV.
	 */
	constructor({ onFrame = null, retain = true } = {}) {
		this._onFrame = typeof onFrame === 'function' ? onFrame : null;
		this._retain = retain !== false;
		this._stream = null;
		this._ctx = null;
		this._source = null;
		this._node = null; // AudioWorkletNode | ScriptProcessorNode
		this._analyser = null;
		this._chunks = [];
		this._length = 0;
		this._sourceRate = TARGET_RATE;
		this._levelBuf = null;
		this._started = false;
		this._disposed = false;
	}

	get capturing() {
		return this._started;
	}

	/**
	 * The device's native capture rate, known once `start()` has built the audio
	 * context. A streaming caller needs it to size its resampler, and guessing
	 * it wrong produces a transcript at the wrong pitch rather than an error.
	 */
	get sampleRate() {
		return this._sourceRate;
	}

	/** Whether the environment can capture at all (no mic UI on insecure origins). */
	static isSupported() {
		return (
			typeof navigator !== 'undefined' &&
			!!navigator.mediaDevices?.getUserMedia &&
			!!(window.AudioContext || window.webkitAudioContext)
		);
	}

	/**
	 * Acquire the mic and begin buffering. Rejects with an Error whose `.code` is
	 * one of: 'unsupported' | 'permission-denied' | 'no-mic' | 'capture-failed'
	 * so the caller can message each case precisely.
	 */
	async start() {
		if (this._started) return;
		if (!MicCapture.isSupported()) throw codedError('Microphone capture is not supported in this browser.', 'unsupported');

		let stream;
		try {
			stream = await navigator.mediaDevices.getUserMedia({
				audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
			});
		} catch (err) {
			const name = err?.name || '';
			if (name === 'NotAllowedError' || name === 'SecurityError') {
				throw codedError('Microphone access was blocked. Allow the mic, or type your message instead.', 'permission-denied');
			}
			if (name === 'NotFoundError' || name === 'OverconstrainedError') {
				throw codedError('No microphone was found. Plug one in, or type your message instead.', 'no-mic');
			}
			throw codedError(`Could not start the microphone: ${err?.message || name || 'unknown error'}`, 'capture-failed');
		}
		this._stream = stream;

		const AC = window.AudioContext || window.webkitAudioContext;
		const ctx = new AC();
		this._ctx = ctx;
		this._sourceRate = ctx.sampleRate || TARGET_RATE;
		if (ctx.state === 'suspended') await ctx.resume().catch(() => {});

		this._source = ctx.createMediaStreamSource(stream);

		this._analyser = ctx.createAnalyser();
		this._analyser.fftSize = 512;
		this._levelBuf = new Uint8Array(this._analyser.fftSize);
		this._source.connect(this._analyser);

		const onFrame = (frame) => {
			if (!this._started) return;
			// Copy — the worklet transfers a view backed by a reused buffer.
			const copy = frame instanceof Float32Array ? frame : new Float32Array(frame);
			const owned = copy.slice ? copy.slice(0) : new Float32Array(copy);
			if (this._retain) {
				this._chunks.push(owned);
				this._length += owned.length;
			}
			// A throw from a subscriber must not kill the capture graph: the
			// microphone would go silent with no error anywhere near the cause.
			if (this._onFrame) {
				try {
					this._onFrame(owned);
				} catch {
					/* a subscriber's failure is its own problem */
				}
			}
		};

		let usedWorklet = false;
		if (ctx.audioWorklet?.addModule) {
			try {
				const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
				await ctx.audioWorklet.addModule(url);
				URL.revokeObjectURL(url);
				const node = new AudioWorkletNode(ctx, 'mic-capture');
				node.port.onmessage = (e) => onFrame(e.data);
				this._source.connect(node);
				// A muted sink keeps the worklet pulling frames without echoing the mic.
				const sink = ctx.createGain();
				sink.gain.value = 0;
				node.connect(sink).connect(ctx.destination);
				this._node = node;
				usedWorklet = true;
			} catch {
				usedWorklet = false; // fall through to ScriptProcessor
			}
		}

		if (!usedWorklet) {
			const node = ctx.createScriptProcessor(4096, 1, 1);
			node.onaudioprocess = (e) => onFrame(e.inputBuffer.getChannelData(0));
			this._source.connect(node);
			node.connect(ctx.destination); // ScriptProcessor needs a destination to fire
			this._node = node;
		}

		this._started = true;
	}

	/** Live capture level, 0..1 RMS. Returns 0 before start / after stop. */
	getLevel() {
		if (!this._analyser || !this._levelBuf) return 0;
		this._analyser.getByteTimeDomainData(this._levelBuf);
		let sum = 0;
		for (let i = 0; i < this._levelBuf.length; i++) {
			const v = (this._levelBuf[i] - 128) / 128;
			sum += v * v;
		}
		return Math.min(1, Math.sqrt(sum / this._levelBuf.length) * 1.8);
	}

	/** Seconds of audio buffered so far. */
	get durationSec() {
		return this._length / this._sourceRate;
	}

	/**
	 * A WAV of everything captured so far WITHOUT stopping — used to fire an
	 * interim recognition pass mid-hold so partial words can surface. Returns null
	 * until there is enough audio (≈0.4 s) to be worth a round-trip.
	 */
	snapshotWav() {
		if (this._length < this._sourceRate * 0.4) return null;
		return this._buildWav();
	}

	/**
	 * Stop capture and return the full utterance as a 16 kHz mono WAV Blob, or
	 * null if nothing audible was captured. Releases the mic immediately; call
	 * dispose() to also close the audio context.
	 */
	async stop() {
		if (!this._started) return null;
		this._started = false;
		// Drop the live mic; the buffered samples are already ours.
		for (const track of this._stream?.getTracks() || []) {
			try {
				track.stop();
			} catch {}
		}
		const wav = this._length > 0 ? this._buildWav() : null;
		return wav;
	}

	/** Idempotent teardown of every audio resource. */
	dispose() {
		if (this._disposed) return;
		this._disposed = true;
		this._started = false;
		this._onFrame = null;
		try {
			if (this._node) {
				this._node.onaudioprocess = null;
				if (this._node.port) this._node.port.onmessage = null;
				this._node.disconnect();
			}
		} catch {}
		try {
			this._source?.disconnect();
		} catch {}
		try {
			this._analyser?.disconnect();
		} catch {}
		for (const track of this._stream?.getTracks() || []) {
			try {
				track.stop();
			} catch {}
		}
		if (this._ctx && this._ctx.state !== 'closed') {
			this._ctx.close().catch(() => {});
		}
		this._chunks = [];
		this._length = 0;
		this._node = null;
		this._source = null;
		this._analyser = null;
		this._stream = null;
		this._ctx = null;
	}

	// ── internal ──────────────────────────────────────────────────────────

	_flatten() {
		const out = new Float32Array(this._length);
		let offset = 0;
		for (const chunk of this._chunks) {
			out.set(chunk, offset);
			offset += chunk.length;
		}
		return out;
	}

	// Native-rate Float32 → 16 kHz mono → little-endian s16 → RIFF/WAVE Blob.
	_buildWav() {
		const native = this._flatten();
		const pcm16 = floatTo16kPcm(native, this._sourceRate);
		return new Blob([pcm16Wav(pcm16, TARGET_RATE)], { type: 'audio/wav' });
	}
}

/**
 * Streaming version of the conversion above.
 *
 * Resampling frame by frame with a stateless call is subtly wrong: 128 native
 * samples at 48 kHz is 42.67 output samples, and a function that floors that on
 * every frame drops two thirds of a sample 375 times a second. Over a sentence
 * that is an audible click track and a transcript that quietly gets worse. This
 * class carries the fractional read position and one sample of overlap across
 * calls, so the output is a continuous resample of a continuous input.
 */
export class PcmDownsampler {
	/** @param {number} sourceRate  The AudioContext's native sample rate. */
	constructor(sourceRate) {
		this.ratio = Math.max(0.01, sourceRate / TARGET_RATE);
		this._phase = 0;
		this._tail = new Float32Array(0);
	}

	/**
	 * Convert one frame. Returns little-endian s16 at 16 kHz, mono, ready to be
	 * put on a wire. An empty result is normal for very short frames.
	 * @param {Float32Array} frame
	 * @returns {Int16Array}
	 */
	push(frame) {
		if (!frame?.length) return new Int16Array(0);
		const src = new Float32Array(this._tail.length + frame.length);
		src.set(this._tail, 0);
		src.set(frame, this._tail.length);

		const out = [];
		let pos = this._phase;
		// Stop one sample short of the end so the interpolation always has a
		// right-hand neighbour; the remainder is carried into the next call.
		while (pos < src.length - 1) {
			const idx = Math.floor(pos);
			const frac = pos - idx;
			const s = src[idx] + (src[idx + 1] - src[idx]) * frac;
			out.push(Math.max(-32768, Math.min(32767, Math.round(s * 32767))));
			pos += this.ratio;
		}

		const consumed = Math.floor(pos);
		this._phase = pos - consumed;
		this._tail = src.slice(Math.min(consumed, src.length));
		return Int16Array.from(out);
	}

	/** Forget the carried state, e.g. between two separate utterances. */
	reset() {
		this._phase = 0;
		this._tail = new Float32Array(0);
	}
}

function codedError(message, code) {
	const err = new Error(message);
	err.code = code;
	return err;
}

/**
 * Linear-interpolating resample of mono Float32 from `inRate` to 16 kHz, then
 * quantize to little-endian s16. Linear interpolation is more than adequate for
 * speech recognition and avoids pulling in a filter library.
 *
 * Exported because streaming callers need the same conversion the WAV builder
 * uses; see PcmDownsampler below, which is the one to reach for when the audio
 * arrives in frames rather than all at once.
 */
export function floatTo16kPcm(samples, inRate) {
	if (!samples.length) return new Int16Array(0);
	const ratio = inRate / TARGET_RATE;
	const outLen = ratio <= 1 ? samples.length : Math.floor(samples.length / ratio);
	const out = new Int16Array(outLen);
	for (let i = 0; i < outLen; i++) {
		const pos = i * ratio;
		const idx = Math.floor(pos);
		const frac = pos - idx;
		const a = samples[idx] || 0;
		const b = samples[idx + 1] !== undefined ? samples[idx + 1] : a;
		const s = a + (b - a) * frac;
		out[i] = Math.max(-32768, Math.min(32767, Math.round(s * 32767)));
	}
	return out;
}

// Wrap s16 PCM in a 44-byte RIFF/WAVE header. /api/asr strips this header back to
// raw LINEAR_PCM server-side (api/_lib/asr-nvidia.js parseWav).
function pcm16Wav(pcm16, sampleRate) {
	const channels = 1;
	const bytesPerSample = 2;
	const blockAlign = channels * bytesPerSample;
	const byteRate = sampleRate * blockAlign;
	const dataBytes = pcm16.length * bytesPerSample;
	const buffer = new ArrayBuffer(44 + dataBytes);
	const view = new DataView(buffer);
	writeAscii(view, 0, 'RIFF');
	view.setUint32(4, 36 + dataBytes, true);
	writeAscii(view, 8, 'WAVE');
	writeAscii(view, 12, 'fmt ');
	view.setUint32(16, 16, true); // PCM fmt chunk size
	view.setUint16(20, 1, true); // audio format: PCM
	view.setUint16(22, channels, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, byteRate, true);
	view.setUint16(32, blockAlign, true);
	view.setUint16(34, bytesPerSample * 8, true);
	writeAscii(view, 36, 'data');
	view.setUint32(40, dataBytes, true);
	let offset = 44;
	for (let i = 0; i < pcm16.length; i++, offset += 2) view.setInt16(offset, pcm16[i], true);
	return buffer;
}

function writeAscii(view, offset, str) {
	for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}
