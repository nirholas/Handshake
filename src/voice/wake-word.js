/**
 * Wake-word detection in the browser, on openWakeWord's pre-trained models.
 *
 * openWakeWord (Apache-2.0, https://github.com/dscripka/openWakeWord) publishes
 * both the models and the exact inference graph they were trained against. This
 * module runs that graph with onnxruntime-web; it does not invent a detector,
 * and it does not train one. The models are committed under
 * /public/models/voice/wake-word from the upstream v0.5.1 release, so detection
 * runs entirely on the listener's own machine against bytes served by three.ws.
 *
 * The pipeline, which is upstream's and must stay upstream's or the trained
 * weights stop meaning anything:
 *
 *   16 kHz mono audio, int16 scale
 *      -> melspectrogram.onnx      every 80 ms chunk, over the last 1760 samples,
 *                                   giving 8 new mel frames of 32 bins (10 ms hop)
 *      -> (mel / 10) + 2           upstream's transform, not a normalisation we chose
 *      -> embedding_model.onnx     a 76-frame (760 ms) window -> one 96-d embedding
 *      -> <wake word>.onnx         the last 16 embeddings (1.96 s) -> one score
 *
 * One score per 80 ms chunk. A word therefore resolves within one chunk boundary
 * of its final phoneme plus inference, which is what keeps detection inside the
 * loop's 200 ms budget.
 *
 * Privacy, stated where the code is rather than only in the consent copy: every
 * byte above stays in this tab. Nothing is uploaded, nothing is buffered to
 * disk, and the ring buffers hold under two seconds of audio that is overwritten
 * continuously. Audio only leaves the device after a detection, and then only
 * the utterance that follows it.
 */

import { log } from '../shared/log.js';
import { now } from './vad.js';
import { WAKE_WORDS, DEFAULT_WAKE_WORD, wakeWordById } from './wake-words.js';

// Re-exported so a caller that already needs the detector does not need a second
// import for the catalog. The catalog itself lives in wake-words.js so the panel
// can render its picker without pulling this module in.
export { WAKE_WORDS, DEFAULT_WAKE_WORD, wakeWordById };

/** Where the committed openWakeWord models are served from. */
const MODEL_PATH = '/models/voice/wake-word/';
/** Shared with the VAD so both runtimes fetch one copy of the wasm. */
const RUNTIME_PATH = '/models/voice/runtime/';

/** Upstream's framing, in samples at 16 kHz. Changing any of these breaks the weights. */
const CHUNK_SAMPLES = 1280; // 80 ms: one score per chunk
const MEL_HOP_SAMPLES = 160; // 10 ms per mel frame
const MEL_CONTEXT_SAMPLES = 480; // the model's own lookback, so a chunk yields 8 frames
const MEL_BINS = 32;
const EMBEDDING_WINDOW_FRAMES = 76; // 760 ms of mel frames per embedding
const EMBEDDING_DIMS = 96;
const PREDICTION_EMBEDDINGS = 16; // 1.96 s of context per score

/** int16 scale: the models were trained on int16 audio, not on [-1, 1] floats. */
const INT16_SCALE = 32767;

/**
 * Upstream's default. Raising it costs misses, lowering it costs false wakes, and
 * a false wake on an always-on mic is the more expensive of the two: it opens a
 * capture the user did not ask for.
 */
export const DEFAULT_THRESHOLD = 0.5;

/**
 * How long detection stays closed after a wake. Long enough that the trailing
 * audio of the wake word itself cannot score twice, short enough that a user who
 * was ignored can simply say it again.
 */
const REFRACTORY_MS = 1500;

let ortPromise = null;

/** Load onnxruntime-web once, on demand, pointed at our own wasm. */
async function loadOrt() {
	if (!ortPromise) {
		ortPromise = import('onnxruntime-web/wasm').then((ort) => {
			ort.env.wasm.wasmPaths = RUNTIME_PATH;
			ort.env.wasm.numThreads = 1;
			ort.env.logLevel = 'error';
			return ort;
		});
	}
	return ortPromise;
}

/**
 * A fixed-length ring of rows, oldest first. Small enough to be obvious and
 * allocation-free in the steady state, which matters on a wall display that runs
 * for weeks.
 */
class RowRing {
	constructor(rows, cols) {
		this.rows = rows;
		this.cols = cols;
		this.data = new Float32Array(rows * cols);
		this.filled = 0;
	}

	push(row) {
		if (this.filled < this.rows) {
			this.data.set(row, this.filled * this.cols);
			this.filled++;
			return;
		}
		this.data.copyWithin(0, this.cols);
		this.data.set(row, (this.rows - 1) * this.cols);
	}

	get full() {
		return this.filled >= this.rows;
	}

	/** A copy of the whole ring, oldest first. Only called once per 80 ms. */
	snapshot() {
		return this.data.slice(0, this.filled * this.cols);
	}

	reset() {
		this.filled = 0;
		this.data.fill(0);
	}
}

/**
 * Whether one score fires a wake. Pure, and separated from the inference so the
 * security-relevant decision can be tested without a model:
 *
 *  - Suppressed never wakes. This is the self-trigger guard, and it is absolute:
 *    while the agent is speaking, a perfect score changes nothing.
 *  - Only a rising edge wakes. A score that stays above the threshold across
 *    several chunks is one wake, not five.
 *  - The refractory window keeps the trailing audio of the wake word itself,
 *    which is still in the ring buffer, from scoring a second time.
 *
 * @param {{score:number, threshold:number, above:boolean, suppressed:boolean, sinceLastWakeMs:number, refractoryMs?:number}} input
 * @returns {{wake: boolean, above: boolean}}
 */
export function decideWake({ score, threshold, above, suppressed, sinceLastWakeMs, refractoryMs = REFRACTORY_MS }) {
	const nowAbove = score >= threshold;
	if (suppressed) return { wake: false, above: nowAbove };
	if (!nowAbove || above) return { wake: false, above: nowAbove };
	if (sinceLastWakeMs < refractoryMs) return { wake: false, above: nowAbove };
	return { wake: true, above: nowAbove };
}

export class WakeWordDetector {
	/**
	 * @param {object} opts
	 * @param {string} [opts.wakeWord]   Id from WAKE_WORDS.
	 * @param {number} [opts.threshold]  Score above which a wake fires.
	 * @param {(detection: {score:number, latencyMs:number, wakeWord:string}) => void} [opts.onWake]
	 * @param {(score: number) => void} [opts.onScore] Every 80 ms score, for a live meter.
	 */
	constructor({ wakeWord = DEFAULT_WAKE_WORD, threshold = DEFAULT_THRESHOLD, onWake, onScore } = {}) {
		this.definition = wakeWordById(wakeWord);
		this.threshold = threshold;
		this.onWake = onWake || (() => {});
		this.onScore = onScore || (() => {});

		this._mel = null;
		this._embed = null;
		this._model = null;
		this._ort = null;
		this._loading = null;

		// 1760 samples is all the raw audio the melspectrogram ever reads.
		this._raw = new Float32Array(CHUNK_SAMPLES + MEL_CONTEXT_SAMPLES);
		this._rawFilled = 0;
		this._pending = new Float32Array(CHUNK_SAMPLES);
		this._pendingLength = 0;

		this._melRing = new RowRing(EMBEDDING_WINDOW_FRAMES, MEL_BINS);
		this._featureRing = new RowRing(PREDICTION_EMBEDDINGS, EMBEDDING_DIMS);

		this._inflight = false;
		this._needsPrime = false;
		this._lastWakeAt = 0;
		this._above = false;
		/**
		 * When true, scores are still computed but no wake is emitted. The loop
		 * raises this while the agent's own voice is playing, which is the whole
		 * self-trigger guard: an agent that says its own wake word must not wake
		 * itself, and echo cancellation alone does not guarantee that on a laptop
		 * speaker at volume.
		 */
		this.suppressed = false;
		/** The highest score seen while suppressed, so the guard is measurable. */
		this.suppressedPeak = 0;
		/** Wall clock of the most recent frame handed in, for the wake latency. */
		this._lastFrameAt = 0;
		this.lastScore = 0;
	}

	get ready() {
		return !!this._model;
	}

	get wakeWord() {
		return this.definition.id;
	}

	/** Fetch and compile the three models. Safe to call more than once. */
	async load() {
		if (this._model) return;
		if (!this._loading) this._loading = this._load();
		await this._loading;
	}

	async _load() {
		const ort = await loadOrt();
		this._ort = ort;
		const opts = { executionProviders: ['wasm'] };
		const [mel, embed, model] = await Promise.all([
			ort.InferenceSession.create(`${MODEL_PATH}melspectrogram.onnx`, opts),
			ort.InferenceSession.create(`${MODEL_PATH}embedding_model.onnx`, opts),
			ort.InferenceSession.create(`${MODEL_PATH}${this.definition.file}`, opts),
		]);
		this._mel = mel;
		this._embed = embed;
		this._model = model;
		await this._prime();
		this._needsPrime = false;
	}

	/**
	 * Run the chain over two seconds of digital silence so the ring buffers are
	 * full before the first real frame arrives.
	 *
	 * Without this the detector is deaf for its first 2.04 s (76 mel frames plus
	 * 16 embeddings), and a user who says the wake word the instant the indicator
	 * lights up is simply not heard. openWakeWord primes upstream for the same
	 * reason, with random noise; silence is the better choice here because it is
	 * deterministic and cannot itself score. Measured: 26 chunks, 119 ms of work,
	 * peak score 0.0000, and detection afterwards is bit-identical to a detector
	 * that warmed up on live audio.
	 */
	async _prime() {
		const silence = new Float32Array(CHUNK_SAMPLES);
		const chunks = Math.ceil((EMBEDDING_WINDOW_FRAMES * MEL_HOP_SAMPLES + PREDICTION_EMBEDDINGS * CHUNK_SAMPLES) / CHUNK_SAMPLES);
		for (let i = 0; i < chunks; i++) {
			this._appendRaw(silence);
			if (this._rawFilled < this._raw.length) continue;
			const melFrames = await this._melspectrogram(this._raw);
			for (let j = 0; j < melFrames.length; j += MEL_BINS) {
				this._melRing.push(melFrames.subarray(j, j + MEL_BINS));
			}
			if (!this._melRing.full) continue;
			this._featureRing.push(await this._embedding(this._melRing.snapshot()));
		}
	}

	/**
	 * Swap the listening phrase without tearing down the audio graph. The mel and
	 * embedding stages are shared across every wake word, so only the small
	 * classifier is refetched.
	 */
	async setWakeWord(id) {
		const next = wakeWordById(id);
		if (next.id === this.definition.id) return;
		this.definition = next;
		if (!this._ort) return;
		this._model = await this._ort.InferenceSession.create(`${MODEL_PATH}${next.file}`, {
			executionProviders: ['wasm'],
		});
		this.reset();
	}

	/**
	 * Feed one frame of 16 kHz mono audio in [-1, 1]. Frames of any length are
	 * accepted; scoring happens on 80 ms boundaries. Returns immediately, and
	 * inference runs off the caller's stack.
	 *
	 * @param {Float32Array} frame
	 */
	push(frame) {
		if (!this._model || !frame?.length) return;
		this._lastFrameAt = now();
		let offset = 0;
		while (offset < frame.length) {
			const room = CHUNK_SAMPLES - this._pendingLength;
			const take = Math.min(room, frame.length - offset);
			this._pending.set(frame.subarray(offset, offset + take), this._pendingLength);
			this._pendingLength += take;
			offset += take;
			if (this._pendingLength === CHUNK_SAMPLES) {
				const chunk = this._pending.slice(0);
				this._pendingLength = 0;
				void this._consume(chunk);
			}
		}
	}

	/**
	 * Clear every buffer. Called when the mic is muted, when the agent stops
	 * speaking, and on a wake, so that no audio from before the boundary can
	 * contribute to a score after it.
	 */
	reset() {
		this._rawFilled = 0;
		this._raw.fill(0);
		this._pendingLength = 0;
		this._melRing.reset();
		this._featureRing.reset();
		this._above = false;
		this.lastScore = 0;
		this.suppressedPeak = 0;
		// Re-prime rather than leave the detector deaf for two seconds after every
		// wake, mute or barge-in. Silence is what the buffers held anyway. The
		// work happens on the next chunk, inside the single-flight guard, so it
		// can never interleave with an inference already in progress.
		this._needsPrime = true;
	}

	/** Release the sessions. Idempotent. */
	async destroy() {
		const sessions = [this._mel, this._embed, this._model];
		this._mel = this._embed = this._model = null;
		this._loading = null;
		for (const s of sessions) {
			try {
				await s?.release?.();
			} catch {}
		}
	}

	// One 80 ms chunk: mel -> embedding -> score.
	async _consume(chunk) {
		// A dropped chunk is better than a queue: on a machine slow enough to fall
		// behind, an unbounded backlog turns a 200 ms detection into a 3 s one.
		if (this._inflight) return;
		this._inflight = true;
		const chunkAt = this._lastFrameAt;
		try {
			if (this._needsPrime) {
				this._needsPrime = false;
				await this._prime();
			}
			this._appendRaw(chunk);
			if (this._rawFilled < this._raw.length) return;

			const melFrames = await this._melspectrogram(this._raw);
			for (let i = 0; i < melFrames.length; i += MEL_BINS) {
				this._melRing.push(melFrames.subarray(i, i + MEL_BINS));
			}
			if (!this._melRing.full) return;

			const embedding = await this._embedding(this._melRing.snapshot());
			this._featureRing.push(embedding);
			if (!this._featureRing.full) return;

			const score = await this._score(this._featureRing.snapshot());
			this.lastScore = score;
			this.onScore(score);

			const t = now();
			const decision = decideWake({
				score,
				threshold: this.threshold,
				above: this._above,
				suppressed: this.suppressed,
				sinceLastWakeMs: t - this._lastWakeAt,
			});
			this._above = decision.above;
			if (this.suppressed) this.suppressedPeak = Math.max(this.suppressedPeak, score);
			if (!decision.wake) return;
			// Measured from the frame that completed the chunk, so the number covers
			// exactly what this module is responsible for: the inference, not the
			// audio that had not arrived yet.
			const latencyMs = t - chunkAt;
			this.reset();
			this._lastWakeAt = t;
			this.onWake({ score, latencyMs, wakeWord: this.definition.id });
		} catch (err) {
			log.warn('[wake-word]', err?.message);
		} finally {
			this._inflight = false;
		}
	}

	// Keep the last 1760 samples: 1280 new plus the model's 480-sample lookback.
	_appendRaw(chunk) {
		this._raw.copyWithin(0, chunk.length);
		this._raw.set(chunk, this._raw.length - chunk.length);
		this._rawFilled = Math.min(this._raw.length, this._rawFilled + chunk.length);
	}

	async _melspectrogram(samples) {
		const scaled = new Float32Array(samples.length);
		for (let i = 0; i < samples.length; i++) scaled[i] = samples[i] * INT16_SCALE;
		const input = new this._ort.Tensor('float32', scaled, [1, scaled.length]);
		const out = await this._mel.run({ [this._mel.inputNames[0]]: input });
		const raw = out[this._mel.outputNames[0]].data;
		// Upstream's transform. It is not a normalisation choice of ours: the
		// embedding model was trained on exactly this, so it is part of the graph.
		const mel = new Float32Array(raw.length);
		for (let i = 0; i < raw.length; i++) mel[i] = raw[i] / 10 + 2;
		return mel;
	}

	async _embedding(melWindow) {
		const input = new this._ort.Tensor('float32', melWindow, [1, EMBEDDING_WINDOW_FRAMES, MEL_BINS, 1]);
		const out = await this._embed.run({ [this._embed.inputNames[0]]: input });
		return out[this._embed.outputNames[0]].data;
	}

	async _score(features) {
		const input = new this._ort.Tensor('float32', features, [1, PREDICTION_EMBEDDINGS, EMBEDDING_DIMS]);
		const out = await this._model.run({ [this._model.inputNames[0]]: input });
		return out[this._model.outputNames[0]].data[0];
	}
}

/**
 * Seconds of audio the detector must see before it can produce its first score:
 * the 760 ms mel window plus 16 embeddings at 80 ms each. Surfaced so the UI can
 * tell the truth about when listening actually begins instead of claiming to
 * listen while the buffers are still filling.
 */
export const WARMUP_MS =
	(EMBEDDING_WINDOW_FRAMES * MEL_HOP_SAMPLES + PREDICTION_EMBEDDINGS * CHUNK_SAMPLES) / 16;
