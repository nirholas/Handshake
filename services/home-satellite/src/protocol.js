/**
 * The Wyoming protocol, implemented (not vendored).
 *
 * Wyoming is the wire Home Assistant speaks to voice satellites, ASR services,
 * TTS services and wake-word services. It is MIT licensed and the reference
 * implementation lives at https://github.com/rhasspy/wyoming (protocol) and
 * https://github.com/rhasspy/wyoming-satellite (a device runtime). We use
 * neither at runtime: the reference satellite is a Python program for a
 * Raspberry Pi with a microphone soldered to it, and what three.ws needs is a
 * client in our own stack that puts a 3D body on the far end of somebody's
 * existing pipeline. So this file re-implements the framing and the event set
 * from the reference source, and the rest of the service is ours.
 *
 * THE FRAMING, exactly as `wyoming/event.py` writes it:
 *
 *   <header JSON>\n            {"type": "...", "version": "...",
 *                               "data_length": N?, "payload_length": M?}
 *   <N bytes of JSON>          the event's `data`, merged over any inline
 *                              `data` key in the header
 *   <M bytes of binary>        the event's `payload` (raw PCM, for audio)
 *
 * Two details are easy to get wrong and both are load-bearing:
 *
 *   1. `data_length` and `payload_length` are BYTE counts, not character
 *      counts. The reference encodes with `ensure_ascii=False`, so a non-ASCII
 *      transcript ("¿Encendiste la luz?") makes the two differ. We measure with
 *      Buffer.byteLength for the same reason.
 *   2. The reader accepts `data` inline in the header AND as a length-prefixed
 *      block, merging the block over the inline copy. The writer only ever
 *      emits the block. We read both and write the block, so we interoperate
 *      with anything on either side of that line.
 *
 * Everything here is pure: bytes in, objects out. No sockets, no timers, no
 * global state. `server.js` owns all of the I/O.
 */

/**
 * The wyoming protocol package version this implementation was written and
 * tested against. It travels in every header we write, exactly as the
 * reference does, and it is reported in the info handshake so a mismatch is
 * visible from the Home Assistant side instead of showing up as a mystery.
 */
export const WYOMING_VERSION = '1.10.2';

/** Every event type this service reads or writes. */
export const EVENT = Object.freeze({
	// Discovery
	DESCRIBE: 'describe',
	INFO: 'info',
	// Liveness
	PING: 'ping',
	PONG: 'pong',
	// Satellite lifecycle
	RUN_SATELLITE: 'run-satellite',
	PAUSE_SATELLITE: 'pause-satellite',
	STREAMING_STARTED: 'streaming-started',
	STREAMING_STOPPED: 'streaming-stopped',
	// Pipeline control
	RUN_PIPELINE: 'run-pipeline',
	// Audio, both directions
	AUDIO_START: 'audio-start',
	AUDIO_CHUNK: 'audio-chunk',
	AUDIO_STOP: 'audio-stop',
	PLAYED: 'played',
	// Wake word
	DETECT: 'detect',
	DETECTION: 'detection',
	NOT_DETECTED: 'not-detected',
	// Speech to text
	TRANSCRIBE: 'transcribe',
	TRANSCRIPT: 'transcript',
	TRANSCRIPT_START: 'transcript-start',
	TRANSCRIPT_CHUNK: 'transcript-chunk',
	TRANSCRIPT_STOP: 'transcript-stop',
	// Voice activity
	VOICE_STARTED: 'voice-started',
	VOICE_STOPPED: 'voice-stopped',
	// Text to speech
	SYNTHESIZE: 'synthesize',
	// Failure
	ERROR: 'error',
});

/** Pipeline stages, from `wyoming/pipeline.py`. */
export const STAGE = Object.freeze({
	WAKE: 'wake',
	ASR: 'asr',
	INTENT: 'intent',
	HANDLE: 'handle',
	TTS: 'tts',
});

/**
 * Which end stages each start stage permits. The reference raises on an invalid
 * pair rather than sending it, and so do we: a satellite that asks for an
 * impossible run gets a `ValueError` traceback out of Home Assistant and no
 * explanation of which side was wrong.
 */
const VALID_END_STAGES = Object.freeze({
	[STAGE.WAKE]: [STAGE.WAKE, STAGE.ASR, STAGE.INTENT, STAGE.HANDLE, STAGE.TTS],
	[STAGE.ASR]: [STAGE.ASR, STAGE.INTENT, STAGE.HANDLE, STAGE.TTS],
	[STAGE.INTENT]: [STAGE.INTENT, STAGE.HANDLE, STAGE.TTS],
	[STAGE.HANDLE]: [STAGE.HANDLE, STAGE.TTS],
	[STAGE.TTS]: [STAGE.TTS],
});

/**
 * The audio format a Home Assistant pipeline wants on the way in. The
 * integration resamples whatever it receives, but sending it what it already
 * wants keeps a conversion out of the hot path on somebody's home server.
 */
export const MIC_FORMAT = Object.freeze({ rate: 16000, width: 2, channels: 1 });

/**
 * The audio format Home Assistant's TTS stage sends back. Declared in
 * `homeassistant/components/wyoming/assist_satellite.py` as `_TTS_SAMPLE_RATE`
 * with the shared `SAMPLE_WIDTH` / `SAMPLE_CHANNELS`. We advertise it as our
 * `snd` format so the far end has no reason to transcode.
 */
export const SND_FORMAT = Object.freeze({ rate: 22050, width: 2, channels: 1 });

const NEWLINE = 0x0a;

/**
 * Serialize one event to the bytes that go on the wire.
 *
 * @param {{type: string, data?: object, payload?: Uint8Array|null}} event
 * @returns {Buffer}
 */
export function encodeEvent(event) {
	if (!event || typeof event.type !== 'string' || !event.type) {
		throw new Error('encodeEvent: an event needs a non-empty string type');
	}

	const header = { type: event.type, version: WYOMING_VERSION };

	let dataBytes = null;
	if (event.data && Object.keys(event.data).length > 0) {
		dataBytes = Buffer.from(JSON.stringify(event.data), 'utf8');
		header.data_length = dataBytes.length;
	}

	const payload = event.payload ? (Buffer.isBuffer(event.payload) ? event.payload : Buffer.from(event.payload)) : null;
	if (payload && payload.length > 0) {
		header.payload_length = payload.length;
	}

	const parts = [Buffer.from(`${JSON.stringify(header)}\n`, 'utf8')];
	if (dataBytes) parts.push(dataBytes);
	if (payload && payload.length > 0) parts.push(payload);
	return Buffer.concat(parts);
}

/**
 * Incremental decoder. TCP hands you arbitrary slices of the stream, so the
 * decoder has to survive a header split mid-key, a `data` block split from its
 * header, and four events arriving in one 8 KB read.
 *
 * Usage:
 *   const decoder = new EventDecoder();
 *   for (const event of decoder.push(chunk)) { ... }
 */
export class EventDecoder {
	/**
	 * @param {object} [options]
	 * @param {number} [options.maxHeaderBytes=65536]
	 *        A header line this long is not a header: it is a peer writing
	 *        something that is not Wyoming into our socket, and reading it
	 *        forever is how a listener becomes a memory exhaustion bug.
	 * @param {number} [options.maxDataBytes=1048576]
	 * @param {number} [options.maxPayloadBytes=4194304]
	 */
	constructor({ maxHeaderBytes = 65536, maxDataBytes = 1024 * 1024, maxPayloadBytes = 4 * 1024 * 1024 } = {}) {
		this.maxHeaderBytes = maxHeaderBytes;
		this.maxDataBytes = maxDataBytes;
		this.maxPayloadBytes = maxPayloadBytes;
		this._buf = Buffer.alloc(0);
		this._pending = null;
	}

	/**
	 * Feed bytes in, get whole events out.
	 * @param {Uint8Array} chunk
	 * @returns {Array<{type: string, data: object, payload: Buffer|null}>}
	 */
	push(chunk) {
		if (chunk && chunk.length) {
			this._buf = this._buf.length ? Buffer.concat([this._buf, Buffer.from(chunk)]) : Buffer.from(chunk);
		}

		const events = [];
		for (;;) {
			if (!this._pending) {
				const nl = this._buf.indexOf(NEWLINE);
				if (nl === -1) {
					if (this._buf.length > this.maxHeaderBytes) {
						throw new Error(`wyoming header exceeded ${this.maxHeaderBytes} bytes without a newline`);
					}
					break;
				}
				const line = this._buf.subarray(0, nl).toString('utf8');
				this._buf = this._buf.subarray(nl + 1);

				let header;
				try {
					header = JSON.parse(line);
				} catch {
					throw new Error('wyoming header was not valid JSON');
				}
				if (!header || typeof header.type !== 'string') {
					throw new Error('wyoming header had no type');
				}

				const dataLength = lengthOf(header.data_length, this.maxDataBytes, 'data');
				const payloadLength = lengthOf(header.payload_length, this.maxPayloadBytes, 'payload');
				this._pending = {
					type: header.type,
					inlineData: header.data && typeof header.data === 'object' ? header.data : null,
					version: typeof header.version === 'string' ? header.version : null,
					dataLength,
					payloadLength,
				};
			}

			const need = this._pending.dataLength + this._pending.payloadLength;
			if (this._buf.length < need) break;

			const p = this._pending;
			let data = p.inlineData ? { ...p.inlineData } : {};
			if (p.dataLength > 0) {
				const raw = this._buf.subarray(0, p.dataLength).toString('utf8');
				let block;
				try {
					block = JSON.parse(raw);
				} catch {
					this._pending = null;
					throw new Error(`wyoming ${p.type} data block was not valid JSON`);
				}
				if (block && typeof block === 'object') data = { ...data, ...block };
			}
			// Copy rather than subarray: a view would keep the whole read buffer
			// alive for the life of an audio chunk, which at 50 chunks a second is
			// how a satellite grows to a gigabyte over an afternoon.
			const payload = p.payloadLength > 0 ? Buffer.from(this._buf.subarray(p.dataLength, need)) : null;
			this._buf = this._buf.subarray(need);
			this._pending = null;
			events.push({ type: p.type, data, payload, version: p.version });
		}
		return events;
	}

	/** Bytes held back waiting for the rest of an event. Exposed for health output. */
	get buffered() {
		return this._buf.length;
	}
}

function lengthOf(value, max, what) {
	if (value === undefined || value === null) return 0;
	if (!Number.isInteger(value) || value < 0) {
		throw new Error(`wyoming ${what}_length was not a non-negative integer`);
	}
	if (value > max) {
		throw new Error(`wyoming ${what}_length ${value} exceeds the ${max} byte limit`);
	}
	return value;
}

/* -------------------------------------------------------------------------- */
/* Event builders                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The `info` handshake. This is the event that makes Home Assistant list us in
 * its voice assistant settings, so every field here is user-visible somewhere.
 *
 * `satellite` is what turns a plain Wyoming service into a satellite: without
 * it the integration sets up an ASR/TTS/wake service and never creates a
 * satellite device. See `homeassistant/components/wyoming/__init__.py`.
 *
 * @param {object} options
 * @param {string} options.name          Shown as the device name in Home Assistant.
 * @param {string} options.description   Shown under the name.
 * @param {string} [options.area]        Suggested area for the device.
 * @param {string} options.version       This service's version.
 * @param {boolean} [options.hasVad=false]
 */
export function infoEvent({ name, description, area = null, version, hasVad = false }) {
	const attribution = {
		name: 'three.ws',
		url: 'https://three.ws',
	};
	const satellite = {
		name,
		description,
		attribution,
		installed: true,
		version,
		has_vad: hasVad,
		// We do no wake-word detection locally: Home Assistant's pipeline owns
		// every stage. Reporting zero (rather than omitting it) is what tells the
		// integration not to offer a local wake-word picker that would do nothing.
		max_active_wake_words: 0,
		active_wake_words: [],
	};
	if (area) satellite.area = area;

	return {
		type: EVENT.INFO,
		data: {
			asr: [],
			tts: [],
			handle: [],
			intent: [],
			wake: [],
			mic: [
				{
					name,
					description: 'Microphone streamed from the browser showing the agent',
					attribution,
					installed: true,
					version,
					mic_format: { ...MIC_FORMAT },
				},
			],
			snd: [
				{
					name,
					description: 'Speech played by the agent, lip-synced to its face',
					attribution,
					installed: true,
					version,
					snd_format: { ...SND_FORMAT },
				},
			],
			satellite,
		},
	};
}

export function describeEvent() {
	return { type: EVENT.DESCRIBE };
}

export function pingEvent(text = null) {
	return { type: EVENT.PING, data: { text } };
}

export function pongEvent(text = null) {
	return { type: EVENT.PONG, data: { text } };
}

/**
 * Ask Home Assistant to run a pipeline.
 *
 * @param {object} options
 * @param {string} options.startStage
 * @param {string} options.endStage
 * @param {boolean} [options.restartOnEnd=false]
 * @param {string[]|null} [options.wakeWordNames=null]
 */
export function runPipelineEvent({ startStage, endStage, restartOnEnd = false, wakeWordNames = null }) {
	const allowed = VALID_END_STAGES[startStage];
	if (!allowed) throw new Error(`run-pipeline: unknown start stage ${startStage}`);
	if (!allowed.includes(endStage)) {
		throw new Error(`run-pipeline: ${startStage} cannot end at ${endStage}`);
	}
	const data = { start_stage: startStage, end_stage: endStage, restart_on_end: !!restartOnEnd };
	if (wakeWordNames && wakeWordNames.length) data.wake_word_names = wakeWordNames;
	return { type: EVENT.RUN_PIPELINE, data };
}

export function audioStartEvent({ rate, width, channels, timestamp = 0 }) {
	return { type: EVENT.AUDIO_START, data: { rate, width, channels, timestamp } };
}

export function audioChunkEvent({ rate, width, channels, timestamp = null, audio }) {
	return { type: EVENT.AUDIO_CHUNK, data: { rate, width, channels, timestamp }, payload: audio };
}

export function audioStopEvent(timestamp = null) {
	return { type: EVENT.AUDIO_STOP, data: { timestamp } };
}

export function playedEvent() {
	return { type: EVENT.PLAYED };
}

export function streamingStartedEvent() {
	return { type: EVENT.STREAMING_STARTED };
}

export function streamingStoppedEvent() {
	return { type: EVENT.STREAMING_STOPPED };
}

export function errorEvent(text, code = null) {
	const data = { text: String(text) };
	if (code) data.code = String(code);
	return { type: EVENT.ERROR, data };
}

/* -------------------------------------------------------------------------- */
/* Event readers                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Read an audio format off an `audio-start` or `audio-chunk` event, refusing
 * anything that would make a WebAudio graph on the browser side throw. A
 * malformed rate here would surface three hops away as a silent avatar.
 */
export function readAudioFormat(data) {
	const rate = Number(data?.rate);
	const width = Number(data?.width);
	const channels = Number(data?.channels);
	if (!Number.isFinite(rate) || rate < 4000 || rate > 192000) return null;
	if (width !== 2 && width !== 1 && width !== 4) return null;
	if (!Number.isInteger(channels) || channels < 1 || channels > 2) return null;
	return { rate, width, channels };
}

/** Text of a `transcript` / `transcript-chunk` event, or null. */
export function readText(data) {
	const text = data?.text;
	return typeof text === 'string' ? text : null;
}

/** `{ text, code }` of an `error` event. */
export function readError(data) {
	return {
		text: typeof data?.text === 'string' ? data.text : 'Home Assistant reported an error',
		code: typeof data?.code === 'string' ? data.code : null,
	};
}

/** Wake word name off a `detection` event, or null. */
export function readDetection(data) {
	const name = data?.name;
	return typeof name === 'string' && name ? name : null;
}
