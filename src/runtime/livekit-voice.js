// LiveKit realtime voice — bidirectional audio via a LiveKit room.
// The agent server joins the same room, handles VAD/STT/TTS, and sends
// data-channel messages with transcript payloads.

import { Room, RoomEvent, Track } from 'livekit-client';

export class LiveKitVoice {
	/**
	 * @param {object} opts
	 * @param {string} opts.serverUrl  LiveKit server WebSocket URL (wss://…)
	 * @param {string} opts.token      Room access JWT
	 * @param {import('../agent-protocol.js').AgentProtocol} opts.protocol
	 */
	constructor({ serverUrl, token, protocol }) {
		this._serverUrl = serverUrl;
		this._token = token;
		this._protocol = protocol;
		this._room = null;
		this._audioEls = []; // { track, el }[]
		this._userSpeaking = false;
	}

	async connect() {
		const room = new Room();
		this._room = room;

		// Agent TTS audio — attach <audio> element when track arrives.
		// In the slim widget shell we still need the element to exist so the
		// browser plays the track, but it must be hidden (no DOM leak) and
		// detached from any user-visible layout. The audio is what the
		// embedder asked for; the <audio> tag itself is invisible chrome.
		room.on(RoomEvent.TrackSubscribed, (track, _pub, _participant) => {
			if (track.kind !== Track.Kind.Audio) return;
			const el = track.attach();
			if (window.__WIDGET_SHELL) {
				el.style.display = 'none';
				el.setAttribute('aria-hidden', 'true');
			}
			document.body.appendChild(el);
			this._audioEls.push({ track, el });
		});

		room.on(RoomEvent.TrackUnsubscribed, (track) => {
			const idx = this._audioEls.findIndex((e) => e.track === track);
			if (idx === -1) return;
			const { el } = this._audioEls.splice(idx, 1)[0];
			try { track.detach(el); } catch {}
			el.remove();
		});

		// Data messages from the agent server
		room.on(RoomEvent.DataReceived, (data, _participant) => {
			let msg;
			try {
				msg = JSON.parse(new TextDecoder().decode(data));
			} catch {
				return;
			}
			// Agent speaking — drive avatar lipsync + chat bubble
			if (msg.type === 'transcript' && msg.text) {
				this._protocol.emit({
					type: 'speak',
					payload: { text: msg.text, sentiment: 0 },
				});
			}
			// User speech boundaries (VAD from agent server)
			if (msg.type === 'speech_started') {
				this._userSpeaking = true;
				this._protocol.emit({ type: 'listen-start', payload: {} });
			}
			if (msg.type === 'speech_ended') {
				this._userSpeaking = false;
				this._protocol.emit({
					type: 'listen-end',
					payload: { text: msg.transcript || '' },
				});
			}
		});

		// Fallback: use LiveKit active-speaker VAD when agent doesn't send speech events
		room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
			const localId = room.localParticipant?.identity;
			const active = speakers.some((p) => p.identity === localId);
			if (active && !this._userSpeaking) {
				this._userSpeaking = true;
				this._protocol.emit({ type: 'listen-start', payload: {} });
			} else if (!active && this._userSpeaking) {
				this._userSpeaking = false;
				this._protocol.emit({ type: 'listen-end', payload: { text: '' } });
			}
		});

		await room.connect(this._serverUrl, this._token);
		await room.localParticipant.setMicrophoneEnabled(true);
	}

	async disconnect() {
		for (const { track, el } of this._audioEls) {
			try { track.detach(el); } catch {}
			try { el.remove(); } catch {}
		}
		this._audioEls = [];
		if (this._room) {
			try { await this._room.disconnect(); } catch {}
			this._room = null;
		}
		this._userSpeaking = false;
	}

	get connected() {
		return this._room?.state === 'connected';
	}
}
