/**
 * Streaming PCM playback with an analyser the lipsync driver can read.
 *
 * Home Assistant's pipeline sends its answer as raw 16-bit PCM in Wyoming audio
 * chunks, not as a file. There is no `<audio>` element to hand to
 * `tapAudioElement()`, so this builds the same shape of graph a level down:
 *
 *   AudioBufferSourceNode (one per chunk, scheduled back to back)
 *        └─▶ GainNode ─▶ AnalyserNode ─▶ destination
 *                              └─▶ LipsyncDriver reads this every frame
 *
 * Scheduling is the whole job. Chunks arrive over a network at whatever rate
 * the pipeline produces them, and playing each one "now" on arrival produces
 * gaps and overlaps that sound like a bad phone line. Each buffer is instead
 * scheduled at the end of the previous one, on the AudioContext's own clock,
 * with a small lead so a late chunk does not get scheduled in the past.
 */

/** Start playback this far ahead of `currentTime` so the first chunk is not late. */
const START_LEAD_SECONDS = 0.08;

/** If the schedule falls behind the clock, restart from here rather than the past. */
const CATCHUP_LEAD_SECONDS = 0.04;

export class PcmPlayer {
	/**
	 * @param {object} [options]
	 * @param {AudioContext} [options.context]  Reused across utterances.
	 * @param {number} [options.fftSize=256]    Matches the lipsync driver's default.
	 */
	constructor({ context = null, fftSize = 256 } = {}) {
		this.context = context;
		this._fftSize = fftSize;
		this.analyser = null;
		this._gain = null;
		this._format = null;
		this._nextTime = 0;
		this._pending = new Set();
		this._endsAt = 0;
		this._playing = false;
	}

	get playing() {
		return this._playing;
	}

	/** Seconds of audio scheduled but not yet played. */
	get bufferedSeconds() {
		if (!this.context) return 0;
		return Math.max(0, this._nextTime - this.context.currentTime);
	}

	/**
	 * Open a stream. Safe to call again for a new utterance.
	 * @param {{rate:number, width:number, channels:number}} format
	 */
	async start(format) {
		const AC = window.AudioContext || window.webkitAudioContext;
		if (!AC) throw new Error('This browser has no Web Audio support, so the agent cannot speak here.');
		if (!this.context) this.context = new AC();
		// Browsers suspend a context created outside a gesture. The satellite view
		// only ever starts one after the user has pressed something, but a tab
		// restored from the back/forward cache comes back suspended too.
		if (this.context.state === 'suspended') await this.context.resume().catch(() => {});

		if (!this.analyser) {
			this.analyser = this.context.createAnalyser();
			this.analyser.fftSize = this._fftSize;
			this.analyser.smoothingTimeConstant = 0.4;
			this._gain = this.context.createGain();
			this._gain.connect(this.analyser);
			this.analyser.connect(this.context.destination);
		}

		this._format = format;
		this._nextTime = this.context.currentTime + START_LEAD_SECONDS;
		this._endsAt = this._nextTime;
		this._playing = true;
	}

	/**
	 * Queue one chunk of interleaved little-endian PCM.
	 * @param {ArrayBuffer|Uint8Array} bytes
	 */
	push(bytes) {
		if (!this._playing || !this.context || !this._format) return false;
		const { rate, width, channels } = this._format;
		const view = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
		const frames = Math.floor(view.byteLength / (width * channels));
		if (frames <= 0) return false;

		const buffer = this.context.createBuffer(channels, frames, rate);
		const data = new DataView(view.buffer, view.byteOffset, view.byteLength);
		for (let ch = 0; ch < channels; ch += 1) {
			const out = buffer.getChannelData(ch);
			for (let i = 0; i < frames; i += 1) {
				const offset = (i * channels + ch) * width;
				out[i] = width === 2
					? data.getInt16(offset, true) / 32768
					: width === 1
						? (data.getUint8(offset) - 128) / 128
						: data.getInt32(offset, true) / 2147483648;
			}
		}

		const source = this.context.createBufferSource();
		source.buffer = buffer;
		source.connect(this._gain);
		const startAt = Math.max(this._nextTime, this.context.currentTime + CATCHUP_LEAD_SECONDS);
		source.start(startAt);
		this._nextTime = startAt + buffer.duration;
		this._endsAt = this._nextTime;
		this._pending.add(source);
		source.onended = () => this._pending.delete(source);
		return true;
	}

	/**
	 * Stop accepting audio and resolve once everything queued has played.
	 * Resolving on the schedule rather than on the last `onended` matters: a
	 * suspended tab never fires `onended`, and the caller uses this to tell Home
	 * Assistant its answer finished. It must always resolve.
	 * @returns {Promise<void>}
	 */
	async finish() {
		if (!this._playing || !this.context) return;
		this._playing = false;
		const remaining = Math.max(0, this._endsAt - this.context.currentTime);
		if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining * 1000 + 40));
	}

	/** Cut playback off immediately. Used when a run is cancelled or errors. */
	stop() {
		this._playing = false;
		for (const source of this._pending) {
			try {
				source.stop();
			} catch {
				/* already ended */
			}
		}
		this._pending.clear();
		if (this.context) this._nextTime = this.context.currentTime;
	}

	/** Release the graph. The AudioContext is kept: reopening one costs a gesture. */
	dispose() {
		this.stop();
		try {
			this._gain?.disconnect();
			this.analyser?.disconnect();
		} catch {
			/* already disconnected */
		}
		this._gain = null;
		this.analyser = null;
	}
}
