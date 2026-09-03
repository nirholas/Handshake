/**
 * The browser's end of a satellite session.
 *
 * Owns one WebSocket to the satellite service (directly on the LAN, or through
 * the hub), the microphone that feeds it, and the audio that comes back. It
 * knows nothing about the DOM: it emits state and the page renders it, which is
 * what makes the ten states testable and what stops "the socket dropped" and
 * "the avatar looks wrong" from being the same bug.
 *
 * The one behaviour worth stating loudly: **this connection is optional.** Home
 * Assistant's pipeline runs whether or not this page exists. Losing the socket
 * loses the face, never the voice, and the UI is written to say so rather than
 * to look broken.
 */

import { MicCapture, PcmDownsampler } from '../voice/mic-capture.js';
import { PcmPlayer } from './pcm-player.js';

/** Mirrors services/home-satellite/src/session.js. Both ends validate. */
export const STATE = Object.freeze({
	UNPAIRED: 'unpaired',
	PAIRING: 'pairing',
	IDLE: 'idle',
	WAKE: 'wake',
	LISTENING: 'listening',
	THINKING: 'thinking',
	SPEAKING: 'speaking',
	ERROR: 'error',
	DISCONNECTED: 'disconnected',
	OFFLINE: 'offline',
});

const RECONNECT_BASE_MS = 700;
const RECONNECT_MAX_MS = 20_000;

export class SatelliteLink extends EventTarget {
	/**
	 * @param {object} options
	 * @param {() => Promise<{url: string, token: string}>} options.resolve
	 *        Fetches a fresh socket URL and token. Called on every connect, not
	 *        once: viewer tokens are deliberately short lived, so a reconnect an
	 *        hour later has to mint a new one rather than replay a dead one.
	 */
	constructor({ resolve }) {
		super();
		this._resolve = resolve;
		this._socket = null;
		this._stopped = false;
		this._attempt = 0;
		this._timer = 0;

		this.state = STATE.OFFLINE;
		this.detail = null;
		this.satellite = null;
		this.transcript = '';
		this.answer = '';
		this.wakeWord = null;
		this.lastError = null;

		this._player = new PcmPlayer();
		this._mic = null;
		this._micMode = null;
	}

	/** The analyser the lipsync driver reads. Null until the agent first speaks. */
	get analyser() {
		return this._player.analyser;
	}

	get micOpen() {
		return !!this._mic;
	}

	get connected() {
		return this._socket?.readyState === WebSocket.OPEN;
	}

	_emit(type, detail = {}) {
		this.dispatchEvent(new CustomEvent(type, { detail }));
	}

	_setState(state, detail = null) {
		this.state = state;
		this.detail = detail;
		this._emit('state', { state, detail });
	}

	async connect() {
		this._stopped = false;
		clearTimeout(this._timer);

		let target;
		try {
			target = await this._resolve();
		} catch (err) {
			this.lastError = err;
			this._setState(STATE.ERROR, err.message);
			this._scheduleReconnect();
			return;
		}
		if (this._stopped) return;

		// The API hands back an origin, which is http(s) because that is what the
		// hub is deployed behind. A WebSocket needs the ws(s) scheme for the same
		// origin, and `new WebSocket('http://…')` throws a SyntaxError rather than
		// connecting, so normalize rather than trusting the caller.
		const url = new URL(target.url);
		url.protocol = url.protocol === 'https:' ? 'wss:' : url.protocol === 'http:' ? 'ws:' : url.protocol;
		url.searchParams.set('token', target.token);
		const socket = new WebSocket(url.toString());
		socket.binaryType = 'arraybuffer';
		this._socket = socket;

		socket.onopen = () => {
			this._attempt = 0;
			this._emit('open', {});
		};

		socket.onmessage = (event) => {
			if (event.data instanceof ArrayBuffer) {
				this._player.push(event.data);
				return;
			}
			let message;
			try {
				message = JSON.parse(event.data);
			} catch {
				return;
			}
			this._handle(message);
		};

		socket.onerror = () => {
			// `error` on a WebSocket carries nothing useful; `close` follows with
			// the code that does.
		};

		socket.onclose = (event) => {
			if (this._socket !== socket) return;
			this._socket = null;
			this._stopMic();
			this._player.stop();
			if (this._stopped) return;
			// 4401 is the service refusing the token. Reconnecting on a loop with
			// a token it has already rejected is a busy wait; the page has to send
			// the user somewhere instead, so this surfaces rather than retries.
			if (event.code === 4401 || event.code === 4403) {
				this._setState(STATE.ERROR, 'This session is no longer allowed to watch that satellite.');
				this._emit('unauthorized', { code: event.code, reason: event.reason });
				return;
			}
			this._setState(STATE.OFFLINE, 'Reconnecting');
			this._scheduleReconnect();
		};
	}

	_scheduleReconnect() {
		if (this._stopped) return;
		this._attempt += 1;
		const base = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.min(this._attempt, 5));
		this._timer = setTimeout(() => this.connect(), Math.round(base * (0.6 + Math.random() * 0.4)));
	}

	_handle(message) {
		switch (message?.t) {
			case 'hello':
				this.satellite = message.satellite || null;
				this._setState(message.state || STATE.IDLE, null);
				this._emit('hello', { satellite: this.satellite });
				return;
			case 'state':
				this._setState(message.state, message.detail || null);
				return;
			case 'wake':
				this.wakeWord = message.name || null;
				this.transcript = '';
				this.answer = '';
				this._emit('wake', { name: this.wakeWord });
				return;
			case 'voice':
				this._emit('voice', { speaking: !!message.speaking });
				return;
			case 'transcript':
				this.transcript = typeof message.text === 'string' ? message.text : '';
				this._emit('transcript', { text: this.transcript, final: !!message.final });
				return;
			case 'speech':
				this.answer = typeof message.text === 'string' ? message.text : '';
				this._emit('speech', { text: this.answer });
				return;
			case 'audio-start':
				this._startPlayback(message);
				return;
			case 'audio-stop':
				this._finishPlayback();
				return;
			case 'error':
				this.lastError = new Error(message.text || 'The pipeline reported an error.');
				this.lastError.code = message.code || null;
				this._emit('pipeline-error', { text: message.text, code: message.code });
				return;
			default:
		}
	}

	async _startPlayback(format) {
		try {
			await this._player.start({ rate: format.rate, width: format.width, channels: format.channels });
			this._emit('speaking', { analyser: this._player.analyser });
		} catch (err) {
			this._emit('pipeline-error', { text: err.message, code: 'audio_unavailable' });
		}
	}

	async _finishPlayback() {
		await this._player.finish();
		// Tell the service the answer finished so it can tell Home Assistant. The
		// service has its own timeout for exactly the case where this never
		// arrives, so a closed tab cannot leave a pipeline hanging.
		this._send({ t: 'played' });
		this._emit('spoken', {});
	}

	_send(message) {
		if (this._socket?.readyState !== WebSocket.OPEN) return false;
		this._socket.send(JSON.stringify(message));
		return true;
	}

	/**
	 * Open the microphone and stream it into the pipeline.
	 * @param {'wake'|'command'} mode
	 */
	async startMic(mode = 'wake') {
		if (this._mic) return true;
		if (!this.connected) throw new Error('Not connected to the satellite yet.');

		// The resampler is built on the first frame, not before `start()`: the
		// device's real capture rate is only known once the audio context exists,
		// and a resampler sized from a guess produces a transcript at the wrong
		// pitch rather than an error anyone can trace.
		let down = null;
		const mic = new MicCapture({
			retain: false,
			onFrame: (frame) => {
				if (!down) down = new PcmDownsampler(mic.sampleRate);
				const pcm = down.push(frame);
				if (pcm.length && this._socket?.readyState === WebSocket.OPEN) {
					this._socket.send(pcm.buffer);
				}
			},
		});
		await mic.start();

		this._mic = mic;
		this._micMode = mode;
		this._send({ t: 'mic-start', mode });
		this._emit('mic', { open: true, mode });
		return true;
	}

	stopMic() {
		if (!this._mic) return false;
		this._send({ t: 'mic-stop' });
		this._stopMic();
		this._emit('mic', { open: false, mode: this._micMode });
		return true;
	}

	_stopMic() {
		if (!this._mic) return;
		this._mic.dispose();
		this._mic = null;
	}

	/** Live microphone level, 0..1, for the listening indicator. */
	micLevel() {
		return this._mic?.getLevel?.() ?? 0;
	}

	close() {
		this._stopped = true;
		clearTimeout(this._timer);
		this._stopMic();
		this._player.dispose();
		this._socket?.close(1000, 'leaving');
		this._socket = null;
		this._setState(STATE.OFFLINE, null);
	}
}
