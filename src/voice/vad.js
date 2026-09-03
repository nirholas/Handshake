/**
 * Voice activity detection for the browser voice loop.
 *
 * A thin, lazily loaded wrapper over silero-vad (MIT,
 * https://github.com/snakers4/silero-vad) through @ricky0123/vad-web. We do not
 * write a detector: silero is a trained model with years of tuning behind it and
 * an energy threshold is not a substitute.
 *
 * Two things this wrapper adds over calling MicVAD directly, and both are
 * load-bearing for the home voice loop:
 *
 *  1. It never opens the microphone itself. The caller passes the MediaStream
 *     and the AudioContext it already owns, so the VAD, the wake word and the
 *     utterance capture all read ONE mic. Three getUserMedia calls would mean
 *     three indicator dots in the browser chrome and three tracks to remember to
 *     stop, and "mute" has to stop every track that exists.
 *  2. It surfaces every 512-sample, 16 kHz frame to the caller. The wake word
 *     needs exactly that feed, and running a second resampler for it would
 *     double the audio work for no gain.
 *
 * Everything here loads on demand. Nothing in this module's dependency graph is
 * fetched until start() is called, which is what makes "nothing about listening
 * loads before you opt in" a true statement rather than a promise.
 *
 * Model: silero v5, 512-sample frames at 16 kHz, so 32 ms per frame. The v5
 * frame is the reason we do not use the legacy model: its 1536-sample frame is
 * 96 ms, which is a quarter of the entire end-of-speech budget in granularity
 * alone.
 */

import { log } from '../shared/log.js';

/** Where copy-voice-models.mjs stages the VAD model and its worklet. */
export const VAD_ASSET_PATH = '/models/voice/runtime/';

/** Silero v5 reads 512 samples at a time; the loop's timing math depends on it. */
export const VAD_FRAME_SAMPLES = 512;
export const VAD_SAMPLE_RATE = 16000;
export const VAD_MS_PER_FRAME = (VAD_FRAME_SAMPLES / VAD_SAMPLE_RATE) * 1000;

/**
 * Trailing silence before an utterance is called finished.
 *
 * The budget is "under 400 ms": longer and the agent feels broken, shorter and it
 * clips people mid-sentence. 352 ms is 11 whole frames, and the frame count is
 * what matters because the deadline is checked once per frame. It is not 12
 * frames (384 ms) because the wall-clock gap a user actually experiences runs
 * from the last frame silero rated as speech to the moment the utterance closes,
 * and that is one frame period longer than the configured window: measured at
 * 412 to 424 ms with 12 frames, which misses the budget. Eleven frames measures
 * in the high 380s. Widening the budget was the alternative, and it was the wrong
 * one.
 */
export const DEFAULT_REDEMPTION_MS = 352;

/**
 * Audio kept from BEFORE speech was detected. Silero fires a frame or two into a
 * word, so without this the transcript loses the first consonant.
 */
const PRE_SPEECH_PAD_MS = 480;

/** Shorter than a syllable; anything under this is a cough, a door, a keyboard. */
const MIN_SPEECH_MS = 250;

/**
 * Silero's own defaults, restated here rather than inherited invisibly, because
 * the endpoint measurement depends on knowing which of the two governs the
 * countdown. Speech is declared above the positive threshold and the redemption
 * clock starts below the negative one; the band between them is hysteresis, and
 * it is what stops a breath inside a word from ending the utterance.
 */
const POSITIVE_SPEECH_THRESHOLD = 0.3;
const NEGATIVE_SPEECH_THRESHOLD = 0.25;

let vadModulePromise = null;

/** Load @ricky0123/vad-web once, on demand. */
function loadVadModule() {
	if (!vadModulePromise) vadModulePromise = import('@ricky0123/vad-web');
	return vadModulePromise;
}

export class VoiceActivityDetector {
	/**
	 * @param {object} opts
	 * @param {MediaStream} opts.stream          The caller's single mic stream.
	 * @param {AudioContext} opts.audioContext   The caller's single audio context.
	 * @param {(frame: Float32Array, probability: number) => void} [opts.onFrame]
	 *        Every 512-sample 16 kHz frame, with silero's speech probability.
	 * @param {() => void} [opts.onSpeechStart]  Speech probably started.
	 * @param {() => void} [opts.onSpeechRealStart] Speech passed the minimum length.
	 * @param {(audio: Float32Array) => void} [opts.onSpeechEnd]
	 *        The finished utterance, pre-roll included, at 16 kHz.
	 * @param {() => void} [opts.onMisfire]      Speech started but was too short.
	 * @param {number} [opts.redemptionMs]       Trailing silence before end-of-speech.
	 */
	constructor({
		stream,
		audioContext,
		onFrame,
		onSpeechStart,
		onSpeechRealStart,
		onSpeechEnd,
		onMisfire,
		redemptionMs = DEFAULT_REDEMPTION_MS,
	} = {}) {
		if (!stream) throw new Error('VoiceActivityDetector requires a MediaStream');
		if (!audioContext) throw new Error('VoiceActivityDetector requires an AudioContext');
		this.stream = stream;
		this.audioContext = audioContext;
		this.onFrame = onFrame || (() => {});
		this.onSpeechStart = onSpeechStart || (() => {});
		this.onSpeechRealStart = onSpeechRealStart || (() => {});
		this.onSpeechEnd = onSpeechEnd || (() => {});
		this.onMisfire = onMisfire || (() => {});
		this.redemptionMs = redemptionMs;
		this._vad = null;
		this._running = false;
		this._destroyed = false;
		/** Wall clock of the last frame that carried speech, for the end-of-speech measurement. */
		this.lastSpeechFrameAt = 0;
	}

	get running() {
		return this._running;
	}

	/** Load the model and begin reading the caller's stream. */
	async start() {
		if (this._destroyed) throw new Error('VoiceActivityDetector was destroyed');
		if (this._vad) {
			await this._vad.start();
			this._running = true;
			return;
		}

		const { MicVAD } = await loadVadModule();

		this._vad = await MicVAD.new({
			model: 'v5',
			baseAssetPath: VAD_ASSET_PATH,
			onnxWASMBasePath: VAD_ASSET_PATH,
			// The caller owns the mic. Handing MicVAD the existing stream and
			// context is what keeps this to one getUserMedia for the whole loop.
			getStream: async () => this.stream,
			resumeStream: async () => this.stream,
			// Never stop the caller's tracks on pause: mute owns that, and a
			// paused VAD must not silently release a mic the capture still needs.
			pauseStream: async () => {},
			audioContext: this.audioContext,
			startOnLoad: false,
			redemptionMs: this.redemptionMs,
			preSpeechPadMs: PRE_SPEECH_PAD_MS,
			minSpeechMs: MIN_SPEECH_MS,
			// Silero's own defaults, restated so a future tuning pass has one place
			// to argue with rather than an invisible import.
			positiveSpeechThreshold: POSITIVE_SPEECH_THRESHOLD,
			negativeSpeechThreshold: NEGATIVE_SPEECH_THRESHOLD,
			onFrameProcessed: ({ isSpeech }, frame) => {
				// Marked at the NEGATIVE threshold, because that is the one the
				// redemption countdown actually starts from. Marking at the positive
				// threshold instead would count the frames between the two as part of
				// the trailing silence and report a gap the user never waited through.
				if (isSpeech >= NEGATIVE_SPEECH_THRESHOLD) this.lastSpeechFrameAt = now();
				this.onFrame(frame, isSpeech);
			},
			onSpeechStart: () => this.onSpeechStart(),
			onSpeechRealStart: () => this.onSpeechRealStart(),
			onSpeechEnd: (audio) => this.onSpeechEnd(audio),
			onVADMisfire: () => this.onMisfire(),
			ortConfig: (ort) => {
				ort.env.logLevel = 'error';
				// One thread: the loop shares the machine with a WebGL scene, and
				// cross-origin isolation (which multi-threaded wasm needs) is not
				// something a page embedding third-party avatars can assume.
				ort.env.wasm.numThreads = 1;
			},
		});

		await this._vad.start();
		this._running = true;
	}

	/** Stop reading frames. The caller's mic tracks are left alone. */
	async pause() {
		if (!this._vad || !this._running) return;
		this._running = false;
		try {
			await this._vad.pause();
		} catch (err) {
			log.warn('[vad] pause failed', err?.message);
		}
	}

	/** Release the model and the worklet. Idempotent. */
	async destroy() {
		this._destroyed = true;
		this._running = false;
		if (!this._vad) return;
		const vad = this._vad;
		this._vad = null;
		try {
			await vad.destroy();
		} catch (err) {
			log.warn('[vad] destroy failed', err?.message);
		}
	}
}

/** Monotonic where available so a clock change cannot corrupt a latency number. */
export function now() {
	return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
}

/**
 * Float32 [-1, 1] at 16 kHz to a 16-bit mono RIFF/WAVE buffer, the one format
 * /api/asr documents as accepted without a sample-rate query parameter.
 */
export function float32ToWav(samples, sampleRate = VAD_SAMPLE_RATE) {
	const bytesPerSample = 2;
	const dataBytes = samples.length * bytesPerSample;
	const buffer = new ArrayBuffer(44 + dataBytes);
	const view = new DataView(buffer);
	const ascii = (offset, str) => {
		for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
	};
	ascii(0, 'RIFF');
	view.setUint32(4, 36 + dataBytes, true);
	ascii(8, 'WAVE');
	ascii(12, 'fmt ');
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true); // PCM
	view.setUint16(22, 1, true); // mono
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * bytesPerSample, true);
	view.setUint16(32, bytesPerSample, true);
	view.setUint16(34, 16, true);
	ascii(36, 'data');
	view.setUint32(40, dataBytes, true);
	let offset = 44;
	for (let i = 0; i < samples.length; i++, offset += 2) {
		const s = Math.max(-1, Math.min(1, samples[i]));
		view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
	}
	return buffer;
}
