/**
 * The message set spoken between the satellite service and a browser.
 *
 * Wyoming stops at the service. What crosses to the browser is this: a small
 * set of JSON control messages plus raw PCM in binary frames. It is a separate
 * protocol on purpose. Wyoming carries things a browser has no business
 * receiving (and a compromised page no business sending), and a browser needs
 * things Wyoming has no concept of, like "which of the ten states are you in".
 *
 * Both ends validate. The service validates what a viewer sends because a
 * viewer is a web page and web pages are the least trusted thing in the
 * system; the browser validates what the service sends because a message that
 * does not typecheck should paint an honest error rather than a broken face.
 */

/** The state machine the avatar renders. Every state here has a design. */
export const STATE = Object.freeze({
	/** No Home Assistant has ever paired with this service. */
	UNPAIRED: 'unpaired',
	/** A pairing code has been presented and is being redeemed. */
	PAIRING: 'pairing',
	/** Paired, Home Assistant connected, nothing happening. */
	IDLE: 'idle',
	/** Home Assistant reported its wake word fired. */
	WAKE: 'wake',
	/** Streaming microphone audio into the pipeline. */
	LISTENING: 'listening',
	/** Audio stopped, the pipeline is deciding what to do. */
	THINKING: 'thinking',
	/** Playing the pipeline's own text to speech, lip-synced. */
	SPEAKING: 'speaking',
	/** The pipeline failed and said why. */
	ERROR: 'error',
	/** Paired, but Home Assistant is not connected right now. */
	DISCONNECTED: 'disconnected',
	/** The viewer's own socket to the service is gone. */
	OFFLINE: 'offline',
});

/** Messages the service sends to a viewer. */
export const DOWN = Object.freeze({
	HELLO: 'hello',
	STATE: 'state',
	WAKE: 'wake',
	VOICE: 'voice',
	TRANSCRIPT: 'transcript',
	SPEECH: 'speech',
	AUDIO_START: 'audio-start',
	AUDIO_STOP: 'audio-stop',
	ERROR: 'error',
	PONG: 'pong',
});

/** Messages a viewer sends to the service. */
export const UP = Object.freeze({
	MIC_START: 'mic-start',
	MIC_STOP: 'mic-stop',
	PLAYED: 'played',
	PING: 'ping',
});

/** Microphone modes a viewer may ask for. */
export const MIC_MODE = Object.freeze({
	/** Stream continuously and let Home Assistant's wake word decide. */
	WAKE: 'wake',
	/** Push to talk: skip the wake stage and go straight to speech to text. */
	COMMAND: 'command',
});

const STATES = new Set(Object.values(STATE));

/**
 * Validate one message from a viewer. Returns the normalized message, or null.
 * Anything unrecognized returns null and the caller closes the socket: there is
 * no forward-compatibility story worth the risk of forwarding an unknown
 * message into a Wyoming session that can actuate a house.
 *
 * @param {unknown} raw  Parsed JSON from a text frame.
 */
export function readViewerMessage(raw) {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
	switch (raw.t) {
		case UP.MIC_START: {
			const mode = raw.mode === MIC_MODE.COMMAND ? MIC_MODE.COMMAND : MIC_MODE.WAKE;
			return { t: UP.MIC_START, mode };
		}
		case UP.MIC_STOP:
			return { t: UP.MIC_STOP };
		case UP.PLAYED:
			return { t: UP.PLAYED };
		case UP.PING:
			return { t: UP.PING, at: Number.isFinite(raw.at) ? raw.at : null };
		default:
			return null;
	}
}

/**
 * Validate one message from the service. Same reasoning in the other
 * direction: a browser that trusts a malformed frame paints a lie.
 * @param {unknown} raw
 */
export function readServiceMessage(raw) {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
	switch (raw.t) {
		case DOWN.HELLO:
			return {
				t: DOWN.HELLO,
				satellite: sanitizeSatellite(raw.satellite),
				state: STATES.has(raw.state) ? raw.state : STATE.IDLE,
				viewers: Number.isInteger(raw.viewers) ? raw.viewers : 1,
			};
		case DOWN.STATE:
			return STATES.has(raw.state) ? { t: DOWN.STATE, state: raw.state, detail: str(raw.detail) } : null;
		case DOWN.WAKE:
			return { t: DOWN.WAKE, name: str(raw.name) };
		case DOWN.VOICE:
			return { t: DOWN.VOICE, speaking: !!raw.speaking };
		case DOWN.TRANSCRIPT:
			return typeof raw.text === 'string' ? { t: DOWN.TRANSCRIPT, text: raw.text, final: !!raw.final } : null;
		case DOWN.SPEECH:
			return typeof raw.text === 'string' ? { t: DOWN.SPEECH, text: raw.text } : null;
		case DOWN.AUDIO_START: {
			const rate = Number(raw.rate);
			const width = Number(raw.width);
			const channels = Number(raw.channels);
			if (!Number.isFinite(rate) || rate < 4000 || rate > 192000) return null;
			if (width !== 1 && width !== 2 && width !== 4) return null;
			if (!Number.isInteger(channels) || channels < 1 || channels > 2) return null;
			return { t: DOWN.AUDIO_START, rate, width, channels };
		}
		case DOWN.AUDIO_STOP:
			return { t: DOWN.AUDIO_STOP };
		case DOWN.ERROR:
			return { t: DOWN.ERROR, code: str(raw.code) || 'pipeline_error', text: str(raw.text) || 'Something went wrong in the pipeline.' };
		case DOWN.PONG:
			return { t: DOWN.PONG, at: Number.isFinite(raw.at) ? raw.at : null };
		default:
			return null;
	}
}

function str(value) {
	return typeof value === 'string' ? value : null;
}

function sanitizeSatellite(value) {
	if (!value || typeof value !== 'object') return { name: 'Satellite', agent: null, version: null, wyoming: null };
	return {
		name: str(value.name) || 'Satellite',
		agent: value.agent && typeof value.agent === 'object'
			? { id: str(value.agent.id), name: str(value.agent.name), avatarUrl: str(value.agent.avatarUrl) }
			: null,
		version: str(value.version),
		wyoming: str(value.wyoming),
	};
}
