/**
 * The Wyoming side of the satellite: a TCP listener that Home Assistant dials
 * into, and the session state machine on the other side of that socket.
 *
 * Home Assistant is the client here, not the server. Its `wyoming` integration
 * connects out to `host:port`, asks us to describe ourselves, and then drives
 * the whole voice pipeline from its own side: wake word, speech to text,
 * intent, and text to speech all happen on the user's own hardware. We supply
 * two things and only two: a microphone (streamed from the browser showing the
 * agent) and a speaker (that browser's audio output, with the agent's face
 * moving in front of it).
 *
 * The one rule that shapes this file: **the pipeline must never depend on the
 * face.** A satellite that hangs Home Assistant because a browser tab closed is
 * a satellite that breaks somebody's house, and that is not a trade we make for
 * a nicer demo. So every acknowledgement Home Assistant waits on is produced
 * here, in the service, whether or not anybody is watching:
 *
 *   * `pong` answers `ping` from the socket, not from the browser.
 *   * `played` is sent when the audio has been consumed. With a viewer attached
 *     we wait for it to finish playing, but only up to the audio's own duration
 *     plus a grace period. With no viewer, we send it immediately, because
 *     there is nothing left to wait for.
 *
 * Audio in is gated while we are speaking. Home Assistant restarts an always-on
 * pipeline the instant the previous run ends, and a display with speakers a
 * metre from its microphone will otherwise hear its own answer and wake itself
 * up. The reference satellite solves this the same way.
 */

import { createServer } from 'node:net';
import { EventEmitter } from 'node:events';

import {
	EVENT,
	STAGE,
	MIC_FORMAT,
	WYOMING_VERSION,
	EventDecoder,
	encodeEvent,
	infoEvent,
	pongEvent,
	runPipelineEvent,
	audioStartEvent,
	audioChunkEvent,
	audioStopEvent,
	playedEvent,
	streamingStartedEvent,
	streamingStoppedEvent,
	errorEvent,
	readAudioFormat,
	readText,
	readError,
	readDetection,
} from './protocol.js';
import { STATE, MIC_MODE } from './session.js';

/** How long we wait for a viewer to report playback before assuming it cannot. */
const PLAYED_GRACE_MS = 2000;

/** A socket that has said nothing for this long is not a Home Assistant. */
const IDLE_SOCKET_MS = 60_000;

export class WyomingSatellite extends EventEmitter {
	/**
	 * @param {object} options
	 * @param {string} options.name         Device name shown in Home Assistant.
	 * @param {string} options.description  Sub-line shown under it.
	 * @param {string} options.version      This service's version.
	 * @param {string|null} [options.area]  Suggested area for the device.
	 * @param {boolean} [options.paired=true]
	 *        An unpaired service accepts the connection only to say why it is
	 *        refusing it. Silently dropping the socket would leave the person
	 *        who mistyped a pairing code staring at "Unable to connect" with no
	 *        idea which half was wrong.
	 * @param {() => boolean} [options.hasViewer]  Whether a browser is attached.
	 */
	constructor({ name, description, version, area = null, paired = true, hasViewer = () => false }) {
		super();
		this.name = name;
		this.description = description;
		this.version = version;
		this.area = area;
		this.paired = paired;
		this._hasViewer = hasViewer;

		this._server = null;
		this._socket = null;
		this._decoder = null;
		this._idleTimer = null;

		this._state = paired ? STATE.DISCONNECTED : STATE.UNPAIRED;
		this._micOpen = false;
		this._micTimestamp = 0;
		this._speaking = false;
		this._playedTimer = null;
		this._playedSent = true;
		this._incomingAudioMs = 0;

		this.counters = { eventsIn: 0, eventsOut: 0, micChunks: 0, ttsChunks: 0, pipelines: 0, connections: 0 };
	}

	get state() {
		return this._state;
	}

	get connected() {
		return !!this._socket && !this._socket.destroyed;
	}

	get micOpen() {
		return this._micOpen;
	}

	/**
	 * Start listening. Resolves with the bound address so a caller that asked
	 * for port 0 (every test in this repo) learns what it actually got.
	 * @param {number} port
	 * @param {string} [host='0.0.0.0']
	 */
	listen(port, host = '0.0.0.0') {
		return new Promise((resolve, reject) => {
			const server = createServer((socket) => this._accept(socket));
			server.on('error', reject);
			server.listen(port, host, () => {
				this._server = server;
				server.off('error', reject);
				server.on('error', (err) => this.emit('log', { level: 'error', event: 'wyoming.server_error', message: err.message }));
				resolve(server.address());
			});
		});
	}

	async close() {
		this._clearPlayedTimer();
		if (this._idleTimer) clearTimeout(this._idleTimer);
		this._idleTimer = null;
		if (this._socket) this._socket.destroy();
		this._socket = null;
		if (!this._server) return;
		await new Promise((resolve) => this._server.close(resolve));
		this._server = null;
	}

	/* ---------------------------------------------------------------- socket */

	_accept(socket) {
		this.counters.connections += 1;

		if (!this.paired) {
			// Refuse, but say why. Home Assistant logs the error text, so the
			// person who set this up sees "this satellite has not been paired"
			// rather than a bare connection reset.
			socket.write(encodeEvent(errorEvent('This three.ws satellite has not been paired. Run it with a pairing code from three.ws/home/satellite.', 'unpaired')));
			this.emit('log', { level: 'warn', event: 'wyoming.refused_unpaired', remote: socket.remoteAddress });
			socket.end();
			return;
		}

		if (this._socket && !this._socket.destroyed) {
			// Home Assistant opens exactly one socket per satellite and reconnects
			// on failure. A second one is either a stale socket the far end has
			// already forgotten or somebody else; the newest wins, because the
			// stale case is the common one and leaving it in place would keep a
			// reconnected Home Assistant permanently locked out.
			this.emit('log', { level: 'warn', event: 'wyoming.replacing_socket', remote: socket.remoteAddress });
			this._socket.destroy();
		}

		socket.setNoDelay(true);
		this._socket = socket;
		this._decoder = new EventDecoder();
		this._micOpen = false;
		this._speaking = false;
		this._bumpIdle();
		this._setState(STATE.IDLE, 'Home Assistant connected');
		this.emit('ha-connected', { remote: socket.remoteAddress });
		this.emit('log', { level: 'info', event: 'wyoming.connected', remote: socket.remoteAddress });

		socket.on('data', (chunk) => {
			this._bumpIdle();
			let events;
			try {
				events = this._decoder.push(chunk);
			} catch (err) {
				this.emit('log', { level: 'error', event: 'wyoming.decode_failed', message: err.message });
				socket.destroy();
				return;
			}
			for (const event of events) {
				this.counters.eventsIn += 1;
				try {
					this._handle(event);
				} catch (err) {
					this.emit('log', { level: 'error', event: 'wyoming.handler_failed', type: event.type, message: err.message });
				}
			}
		});

		const done = (reason) => {
			if (this._socket !== socket) return;
			this._socket = null;
			this._decoder = null;
			this._micOpen = false;
			this._speaking = false;
			this._clearPlayedTimer();
			if (this._idleTimer) clearTimeout(this._idleTimer);
			this._idleTimer = null;
			this._setState(STATE.DISCONNECTED, reason);
			this.emit('ha-disconnected', { reason });
			this.emit('log', { level: 'info', event: 'wyoming.disconnected', reason });
		};

		socket.on('close', () => done('Home Assistant closed the connection'));
		socket.on('error', (err) => {
			this.emit('log', { level: 'warn', event: 'wyoming.socket_error', message: err.message });
			socket.destroy();
		});
	}

	_bumpIdle() {
		if (this._idleTimer) clearTimeout(this._idleTimer);
		this._idleTimer = setTimeout(() => {
			this.emit('log', { level: 'warn', event: 'wyoming.idle_timeout' });
			this._socket?.destroy();
		}, IDLE_SOCKET_MS);
		this._idleTimer.unref?.();
	}

	_send(event) {
		const socket = this._socket;
		if (!socket || socket.destroyed) return false;
		socket.write(encodeEvent(event));
		this.counters.eventsOut += 1;
		return true;
	}

	/* --------------------------------------------------------------- inbound */

	_handle(event) {
		switch (event.type) {
			case EVENT.DESCRIBE:
				this._send(infoEvent({
					name: this.name,
					description: this.description,
					area: this.area,
					version: this.version,
				}));
				return;

			case EVENT.PING:
				this._send(pongEvent(typeof event.data?.text === 'string' ? event.data.text : null));
				return;

			case EVENT.PONG:
				return;

			case EVENT.RUN_SATELLITE:
				this._setState(STATE.IDLE, 'Ready');
				this.emit('log', { level: 'info', event: 'wyoming.run_satellite' });
				return;

			case EVENT.PAUSE_SATELLITE:
				// Home Assistant muted or disabled the satellite. Stop streaming so
				// we are not shipping somebody's kitchen audio to a pipeline that
				// has been told to stop listening.
				this.stopMic();
				this._setState(STATE.IDLE, 'Paused by Home Assistant');
				this.emit('log', { level: 'info', event: 'wyoming.pause_satellite' });
				return;

			case EVENT.DETECT:
				// The pipeline entered its wake stage.
				this._setState(STATE.LISTENING, 'Waiting for the wake word');
				return;

			case EVENT.DETECTION: {
				const name = readDetection(event.data);
				this.counters.pipelines += 1;
				this.emit('wake', { name });
				this._setState(STATE.WAKE, name ? `Heard "${name}"` : 'Wake word detected');
				return;
			}

			case EVENT.NOT_DETECTED:
				this._setState(STATE.LISTENING, 'Waiting for the wake word');
				return;

			case EVENT.TRANSCRIBE:
				this._setState(STATE.LISTENING, 'Listening');
				return;

			case EVENT.VOICE_STARTED:
				this.emit('voice', { speaking: true });
				this._setState(STATE.LISTENING, 'Hearing you');
				return;

			case EVENT.VOICE_STOPPED:
				this.emit('voice', { speaking: false });
				this._setState(STATE.THINKING, 'Working out what you asked for');
				return;

			case EVENT.TRANSCRIPT_START:
				this.emit('transcript', { text: '', final: false });
				return;

			case EVENT.TRANSCRIPT_CHUNK: {
				const text = readText(event.data);
				if (text !== null) this.emit('transcript', { text, final: false, chunk: true });
				return;
			}

			case EVENT.TRANSCRIPT: {
				const text = readText(event.data) ?? '';
				this.emit('transcript', { text, final: true });
				this._setState(STATE.THINKING, 'Thinking');
				return;
			}

			case EVENT.TRANSCRIPT_STOP:
				return;

			case EVENT.SYNTHESIZE: {
				const text = readText(event.data);
				if (text !== null) this.emit('speech', { text });
				this._setState(STATE.THINKING, 'Preparing the answer');
				return;
			}

			case EVENT.AUDIO_START: {
				const format = readAudioFormat(event.data);
				if (!format) {
					this.emit('log', { level: 'warn', event: 'wyoming.bad_audio_start', data: event.data });
					return;
				}
				this._speaking = true;
				this._playedSent = false;
				this._incomingAudioMs = 0;
				this._clearPlayedTimer();
				this.emit('audio-start', format);
				this._setState(STATE.SPEAKING, 'Speaking');
				return;
			}

			case EVENT.AUDIO_CHUNK: {
				if (!event.payload || !event.payload.length) return;
				const format = readAudioFormat(event.data);
				if (!format) return;
				this.counters.ttsChunks += 1;
				this._incomingAudioMs += (event.payload.length / (format.width * format.channels) / format.rate) * 1000;
				this.emit('audio', { ...format, audio: event.payload });
				return;
			}

			case EVENT.AUDIO_STOP:
				this.emit('audio-stop', { durationMs: Math.round(this._incomingAudioMs) });
				this._finishSpeaking();
				return;

			case EVENT.ERROR: {
				const { text, code } = readError(event.data);
				this.emit('pipeline-error', { text, code });
				this._setState(STATE.ERROR, text);
				// A pipeline error ends the run. Come back to a usable state rather
				// than leaving the avatar frozen mid-sentence.
				this._speaking = false;
				return;
			}

			default:
				this.emit('log', { level: 'debug', event: 'wyoming.unhandled', type: event.type });
		}
	}

	/**
	 * Decide when to tell Home Assistant the answer finished playing.
	 *
	 * With a viewer attached we wait for `reportPlayed()`, but never longer than
	 * the audio's own duration plus a grace period: a viewer that crashed
	 * mid-sentence must not leave an announcement blocking somebody's
	 * automation. With no viewer we answer immediately, because the audio has
	 * already been consumed by nothing and there is nothing to wait for.
	 */
	_finishSpeaking() {
		if (!this._hasViewer()) {
			this._sendPlayed('no viewer attached');
			return;
		}
		const wait = Math.round(this._incomingAudioMs) + PLAYED_GRACE_MS;
		this._clearPlayedTimer();
		this._playedTimer = setTimeout(() => this._sendPlayed('viewer playback timed out'), wait);
		this._playedTimer.unref?.();
	}

	/** Called when the browser says it finished playing the answer. */
	reportPlayed() {
		this._sendPlayed('viewer finished playback');
	}

	_sendPlayed(reason) {
		this._clearPlayedTimer();
		if (this._playedSent) return;
		this._playedSent = true;
		this._speaking = false;
		this._send(playedEvent());
		this.emit('log', { level: 'debug', event: 'wyoming.played', reason });
		this._setState(this.connected ? STATE.IDLE : STATE.DISCONNECTED, 'Ready');
	}

	_clearPlayedTimer() {
		if (this._playedTimer) clearTimeout(this._playedTimer);
		this._playedTimer = null;
	}

	/* -------------------------------------------------------------- outbound */

	/**
	 * Ask Home Assistant to start a pipeline and begin streaming microphone
	 * audio into it.
	 *
	 * @param {string} [mode]  'wake' streams continuously and lets Home
	 *                         Assistant's own wake word decide; 'command' skips
	 *                         the wake stage for a push-to-talk button.
	 * @returns {boolean} false when Home Assistant is not connected.
	 */
	startMic(mode = MIC_MODE.WAKE) {
		if (!this.connected) return false;
		if (this._micOpen) return true;

		const run = mode === MIC_MODE.COMMAND
			? runPipelineEvent({ startStage: STAGE.ASR, endStage: STAGE.TTS, restartOnEnd: false })
			: runPipelineEvent({ startStage: STAGE.WAKE, endStage: STAGE.TTS, restartOnEnd: true });

		this._send(run);
		this._send(streamingStartedEvent());
		this._send(audioStartEvent({ ...MIC_FORMAT, timestamp: 0 }));
		this._micOpen = true;
		this._micTimestamp = 0;
		this._setState(STATE.LISTENING, mode === MIC_MODE.COMMAND ? 'Listening' : 'Waiting for the wake word');
		this.emit('log', { level: 'info', event: 'wyoming.mic_start', mode });
		return true;
	}

	/**
	 * Forward one chunk of microphone audio. Expected to be 16 kHz, 16-bit,
	 * mono, which is what Home Assistant's pipeline wants and what the browser
	 * capture produces.
	 * @param {Buffer|Uint8Array} pcm
	 */
	pushMic(pcm) {
		if (!this._micOpen || !pcm?.length) return false;
		// Drop our own voice. See the note at the top of this file.
		if (this._speaking) return false;
		this._send(audioChunkEvent({ ...MIC_FORMAT, timestamp: this._micTimestamp, audio: pcm }));
		this._micTimestamp += Math.round((pcm.length / (MIC_FORMAT.width * MIC_FORMAT.channels) / MIC_FORMAT.rate) * 1000);
		this.counters.micChunks += 1;
		return true;
	}

	/** Stop streaming. Home Assistant treats `audio-stop` as end of utterance. */
	stopMic() {
		if (!this._micOpen) return false;
		this._micOpen = false;
		this._send(audioStopEvent(this._micTimestamp));
		this._send(streamingStoppedEvent());
		this.emit('log', { level: 'info', event: 'wyoming.mic_stop' });
		if (this._state === STATE.LISTENING) this._setState(STATE.IDLE, 'Ready');
		return true;
	}

	_setState(state, detail = null) {
		if (this._state === state && !detail) return;
		this._state = state;
		this.emit('state', { state, detail });
	}

	/** A snapshot for the health endpoint. */
	snapshot() {
		return {
			name: this.name,
			version: this.version,
			wyoming: WYOMING_VERSION,
			paired: this.paired,
			state: this._state,
			ha_connected: this.connected,
			mic_open: this._micOpen,
			counters: { ...this.counters },
		};
	}
}
