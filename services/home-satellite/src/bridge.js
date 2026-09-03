/**
 * The bridge between one Wyoming session and the browsers watching it.
 *
 * Three pieces live here and they are deliberately the same code path:
 *
 *   `attachViewer(satellite, socket)`  binds a viewer socket to the satellite.
 *   `createViewerServer(...)`          serves that directly on the LAN.
 *   `createHubLink(...)` / `createHub(...)`  do it through a hosted room when
 *                                      the browser is on https://three.ws and
 *                                      the satellite is on a home network that
 *                                      an https page cannot reach.
 *
 * The satellite never knows which of the two it is talking to. It has one
 * viewer socket, it writes state and audio to it, and it reads microphone audio
 * and acknowledgements back. The hub fans that single stream out to however
 * many screens are showing the agent and funnels the microphone back from
 * whichever one is holding the lease. One house, one microphone, many faces.
 *
 * Why a hub exists at all: Home Assistant lives on a LAN, three.ws is served
 * over https, and a browser refuses `ws://192.168.x.x` from an https page. The
 * satellite therefore dials out. Nothing listens on the user's network, no port
 * is forwarded, and the voice path itself never needs the hub: if three.ws is
 * unreachable the pipeline still runs, the house still responds, and the only
 * thing missing is the face.
 */

import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';

import { DOWN, UP, STATE, readViewerMessage } from './session.js';
import { ROLE, verifyToken } from './token.js';
import { WYOMING_VERSION } from './protocol.js';

/** Close codes. 4000+ is the application range. */
export const CLOSE = Object.freeze({
	UNAUTHORIZED: 4401,
	FORBIDDEN: 4403,
	REPLACED: 4409,
	PROTOCOL: 4400,
	GOING_AWAY: 1001,
});

/** Mic audio arriving faster than this is not a microphone. 16 kHz mono s16 is
 * 32 kB/s; the ceiling is generous enough for a burst and small enough that a
 * hostile page cannot use a house as an upload target. */
const MAX_MIC_BYTES_PER_SECOND = 200_000;

/**
 * Bind a viewer socket to a satellite session.
 *
 * @param {import('./satellite.js').WyomingSatellite} satellite
 * @param {import('ws').WebSocket} socket
 * @param {object} options
 * @param {object} options.identity     `{ name, agent, version }` for the hello.
 * @param {(entry: object) => void} [options.onLog]
 * @returns {{ detach: () => void }}
 */
export function attachViewer(satellite, socket, { identity, onLog = () => {} } = {}) {
	let detached = false;
	let micBudget = MAX_MIC_BYTES_PER_SECOND;
	const budgetTimer = setInterval(() => {
		micBudget = MAX_MIC_BYTES_PER_SECOND;
	}, 1000);
	budgetTimer.unref?.();

	const send = (message) => {
		if (detached || socket.readyState !== WebSocket.OPEN) return;
		socket.send(JSON.stringify(message));
	};

	send({
		t: DOWN.HELLO,
		satellite: {
			name: identity?.name || satellite.name,
			agent: identity?.agent || null,
			version: identity?.version || satellite.version,
			wyoming: WYOMING_VERSION,
		},
		state: satellite.state,
		viewers: 1,
	});

	const onState = ({ state, detail }) => send({ t: DOWN.STATE, state, detail });
	const onWake = ({ name }) => send({ t: DOWN.WAKE, name });
	const onVoice = ({ speaking }) => send({ t: DOWN.VOICE, speaking });
	const onTranscript = ({ text, final }) => send({ t: DOWN.TRANSCRIPT, text, final });
	const onSpeech = ({ text }) => send({ t: DOWN.SPEECH, text });
	const onAudioStart = (format) => send({ t: DOWN.AUDIO_START, ...format });
	const onAudioStop = () => send({ t: DOWN.AUDIO_STOP });
	const onError = ({ text, code }) => send({ t: DOWN.ERROR, text, code });
	const onAudio = ({ audio }) => {
		if (detached || socket.readyState !== WebSocket.OPEN) return;
		socket.send(audio, { binary: true });
	};
	const onHaDisconnected = () => send({ t: DOWN.STATE, state: STATE.DISCONNECTED, detail: 'Home Assistant is not connected' });

	satellite.on('state', onState);
	satellite.on('wake', onWake);
	satellite.on('voice', onVoice);
	satellite.on('transcript', onTranscript);
	satellite.on('speech', onSpeech);
	satellite.on('audio-start', onAudioStart);
	satellite.on('audio', onAudio);
	satellite.on('audio-stop', onAudioStop);
	satellite.on('pipeline-error', onError);
	satellite.on('ha-disconnected', onHaDisconnected);

	socket.on('message', (raw, isBinary) => {
		if (detached) return;
		if (isBinary) {
			const bytes = raw.length ?? raw.byteLength ?? 0;
			micBudget -= bytes;
			if (micBudget < 0) {
				onLog({ level: 'warn', event: 'viewer.mic_flood' });
				socket.close(CLOSE.PROTOCOL, 'microphone rate');
				return;
			}
			satellite.pushMic(raw);
			return;
		}
		let parsed;
		try {
			parsed = JSON.parse(raw.toString('utf8'));
		} catch {
			socket.close(CLOSE.PROTOCOL, 'bad json');
			return;
		}
		const message = readViewerMessage(parsed);
		if (!message) {
			socket.close(CLOSE.PROTOCOL, 'unknown message');
			return;
		}
		switch (message.t) {
			case UP.MIC_START:
				if (!satellite.startMic(message.mode)) {
					send({ t: DOWN.ERROR, code: 'not_connected', text: 'Home Assistant is not connected, so there is nothing to listen with.' });
				}
				return;
			case UP.MIC_STOP:
				satellite.stopMic();
				return;
			case UP.PLAYED:
				satellite.reportPlayed();
				return;
			case UP.PING:
				send({ t: DOWN.PONG, at: message.at });
				return;
			default:
				return;
		}
	});

	const detach = () => {
		if (detached) return;
		detached = true;
		clearInterval(budgetTimer);
		satellite.off('state', onState);
		satellite.off('wake', onWake);
		satellite.off('voice', onVoice);
		satellite.off('transcript', onTranscript);
		satellite.off('speech', onSpeech);
		satellite.off('audio-start', onAudioStart);
		satellite.off('audio', onAudio);
		satellite.off('audio-stop', onAudioStop);
		satellite.off('pipeline-error', onError);
		satellite.off('ha-disconnected', onHaDisconnected);
		satellite.stopMic();
	};

	socket.on('close', detach);
	socket.on('error', detach);
	return { detach };
}

/**
 * Serve viewers directly from the satellite, on the same network as the house.
 * This is the local-first path: no cloud, no relay, no account, and it keeps
 * working when three.ws does not.
 *
 * @param {object} options
 * @param {import('./satellite.js').WyomingSatellite} options.satellite
 * @param {string} options.satelliteId
 * @param {string} options.secret        Viewer-token signing key for this satellite.
 * @param {object} options.identity
 * @param {(entry: object) => void} [options.onLog]
 */
export function createViewerServer({ satellite, satelliteId, secret, identity, onLog = () => {} }) {
	const http = createServer((req, res) => {
		if (req.url === '/healthz' || req.url === '/') {
			const body = JSON.stringify({ ok: true, satellite_id: satelliteId, ...satellite.snapshot(), viewers: viewers.size });
			res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
			res.end(body);
			return;
		}
		res.writeHead(404, { 'content-type': 'application/json' });
		res.end('{"error":"not_found"}');
	});

	const wss = new WebSocketServer({ noServer: true });
	const viewers = new Set();

	http.on('upgrade', (req, socket, head) => {
		let url;
		try {
			url = new URL(req.url, 'http://satellite.local');
		} catch {
			socket.destroy();
			return;
		}
		if (url.pathname !== '/viewer') {
			socket.destroy();
			return;
		}
		const check = verifyToken(url.searchParams.get('token') || '', secret);
		if (!check.ok || check.claims.role !== ROLE.VIEWER || check.claims.sid !== satelliteId) {
			onLog({ level: 'warn', event: 'viewer.rejected', reason: check.ok ? 'wrong_room' : check.reason });
			// A rejection has to be a WebSocket close, not a destroyed socket: a
			// browser reports a destroyed socket as a generic network failure and
			// the person on the other end has no idea their session expired.
			wss.handleUpgrade(req, socket, head, (ws) => ws.close(CLOSE.UNAUTHORIZED, check.ok ? 'wrong satellite' : check.reason));
			return;
		}
		wss.handleUpgrade(req, socket, head, (ws) => {
			const bound = attachViewer(satellite, ws, { identity, onLog });
			viewers.add(ws);
			ws.on('close', () => {
				viewers.delete(ws);
				bound.detach();
			});
			onLog({ level: 'info', event: 'viewer.attached', viewers: viewers.size });
		});
	});

	return {
		listen: (port, host = '0.0.0.0') => new Promise((resolve, reject) => {
			http.on('error', reject);
			http.listen(port, host, () => {
				http.off('error', reject);
				resolve(http.address());
			});
		}),
		close: () => new Promise((resolve) => {
			for (const ws of viewers) ws.close(CLOSE.GOING_AWAY, 'shutting down');
			viewers.clear();
			wss.close(() => http.close(resolve));
		}),
		get viewers() {
			return viewers.size;
		},
	};
}

/**
 * The hosted room. Joins one satellite to the browsers allowed to watch it.
 *
 * It holds no database and no Home Assistant credential. Membership is proved
 * by the signature on the token each socket presents, and the only thing it can
 * do is move bytes between two sockets that presented tokens for the same room.
 */
export function createHub({ secret, onLog = () => {} } = {}) {
	if (!secret) throw new Error('createHub: secret required');
	const rooms = new Map();

	const room = (sid) => {
		let r = rooms.get(sid);
		if (!r) {
			r = { sid, satellite: null, viewers: new Set(), hello: null, state: null, micHolder: null };
			rooms.set(sid, r);
		}
		return r;
	};

	const http = createServer((req, res) => {
		if (req.url === '/healthz') {
			res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
			res.end(JSON.stringify({
				ok: true,
				rooms: rooms.size,
				satellites: [...rooms.values()].filter((r) => r.satellite).length,
				viewers: [...rooms.values()].reduce((n, r) => n + r.viewers.size, 0),
			}));
			return;
		}
		res.writeHead(404, { 'content-type': 'application/json' });
		res.end('{"error":"not_found"}');
	});

	const wss = new WebSocketServer({ noServer: true });

	http.on('upgrade', (req, socket, head) => {
		let url;
		try {
			url = new URL(req.url, 'http://hub.local');
		} catch {
			socket.destroy();
			return;
		}
		if (url.pathname !== '/room') {
			socket.destroy();
			return;
		}
		const check = verifyToken(url.searchParams.get('token') || '', secret);
		if (!check.ok) {
			onLog({ level: 'warn', event: 'hub.rejected', reason: check.reason });
			wss.handleUpgrade(req, socket, head, (ws) => ws.close(CLOSE.UNAUTHORIZED, check.reason));
			return;
		}
		wss.handleUpgrade(req, socket, head, (ws) => join(ws, check.claims));
	});

	function join(ws, claims) {
		const r = room(claims.sid);
		if (claims.role === ROLE.SATELLITE) {
			if (r.satellite && r.satellite.readyState === WebSocket.OPEN) {
				// The house reconnected before the hub noticed the old socket died.
				// The newest socket is the live one.
				r.satellite.close(CLOSE.REPLACED, 'replaced by a newer connection');
			}
			r.satellite = ws;
			onLog({ level: 'info', event: 'hub.satellite_joined', sid: claims.sid, viewers: r.viewers.size });
			ws.on('message', (raw, isBinary) => {
				if (!isBinary) cacheDownstream(r, raw);
				for (const viewer of r.viewers) {
					if (viewer.readyState === WebSocket.OPEN) viewer.send(raw, { binary: isBinary });
				}
			});
			ws.on('close', () => {
				if (r.satellite !== ws) return;
				r.satellite = null;
				r.hello = null;
				const gone = JSON.stringify({ t: DOWN.STATE, state: STATE.DISCONNECTED, detail: 'The satellite went offline' });
				for (const viewer of r.viewers) {
					if (viewer.readyState === WebSocket.OPEN) viewer.send(gone);
				}
				onLog({ level: 'info', event: 'hub.satellite_left', sid: claims.sid });
				if (!r.viewers.size) rooms.delete(claims.sid);
			});
			return;
		}

		r.viewers.add(ws);
		onLog({ level: 'info', event: 'hub.viewer_joined', sid: claims.sid, viewers: r.viewers.size });
		// Replay what a joining viewer missed. Without this a browser that opens
		// after the satellite has already announced itself sits on a blank screen
		// until the next state change, which on a quiet house can be hours.
		if (r.hello) ws.send(r.hello);
		if (r.state) ws.send(r.state);
		if (!r.satellite) ws.send(JSON.stringify({ t: DOWN.STATE, state: STATE.DISCONNECTED, detail: 'The satellite is offline' }));

		ws.on('message', (raw, isBinary) => {
			if (!r.satellite || r.satellite.readyState !== WebSocket.OPEN) return;
			// One house has one microphone. The first viewer to open it holds the
			// lease until it closes it or leaves; everyone else watches. Without
			// this, two open tabs stream two microphones into one pipeline and the
			// transcript is a duet.
			if (isBinary) {
				if (r.micHolder !== ws) return;
				r.satellite.send(raw, { binary: true });
				return;
			}
			let parsed;
			try {
				parsed = JSON.parse(raw.toString('utf8'));
			} catch {
				ws.close(CLOSE.PROTOCOL, 'bad json');
				return;
			}
			const message = readViewerMessage(parsed);
			if (!message) {
				ws.close(CLOSE.PROTOCOL, 'unknown message');
				return;
			}
			if (message.t === UP.MIC_START) {
				if (r.micHolder && r.micHolder !== ws && r.micHolder.readyState === WebSocket.OPEN) return;
				r.micHolder = ws;
			}
			if (message.t === UP.MIC_STOP) {
				if (r.micHolder !== ws) return;
				r.micHolder = null;
			}
			r.satellite.send(JSON.stringify(message));
		});

		ws.on('close', () => {
			r.viewers.delete(ws);
			if (r.micHolder === ws) {
				r.micHolder = null;
				if (r.satellite?.readyState === WebSocket.OPEN) r.satellite.send(JSON.stringify({ t: UP.MIC_STOP }));
			}
			onLog({ level: 'info', event: 'hub.viewer_left', sid: claims.sid, viewers: r.viewers.size });
			if (!r.viewers.size && !r.satellite) rooms.delete(claims.sid);
		});
	}

	function cacheDownstream(r, raw) {
		const text = raw.toString('utf8');
		let parsed;
		try {
			parsed = JSON.parse(text);
		} catch {
			return;
		}
		if (parsed?.t === DOWN.HELLO) r.hello = text;
		else if (parsed?.t === DOWN.STATE) r.state = text;
	}

	return {
		listen: (port, host = '0.0.0.0') => new Promise((resolve, reject) => {
			http.on('error', reject);
			http.listen(port, host, () => {
				http.off('error', reject);
				resolve(http.address());
			});
		}),
		close: () => new Promise((resolve) => {
			for (const r of rooms.values()) {
				r.satellite?.close(CLOSE.GOING_AWAY, 'shutting down');
				for (const v of r.viewers) v.close(CLOSE.GOING_AWAY, 'shutting down');
			}
			rooms.clear();
			wss.close(() => http.close(resolve));
		}),
		stats: () => ({
			rooms: rooms.size,
			satellites: [...rooms.values()].filter((r) => r.satellite).length,
			viewers: [...rooms.values()].reduce((n, r) => n + r.viewers.size, 0),
		}),
	};
}

/**
 * Dial out to a hub and present that socket to the satellite as one viewer.
 *
 * Reconnects with a bounded exponential backoff. The backoff matters more than
 * it looks: a thousand kitchen displays reconnecting in lockstep after a hub
 * restart is a self-inflicted outage, so the delay is jittered.
 */
export function createHubLink({ satellite, url, token, identity, onLog = () => {} }) {
	let socket = null;
	let bound = null;
	let stopped = false;
	let attempt = 0;
	let timer = null;

	const connect = () => {
		if (stopped) return;
		const target = `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token())}`;
		socket = new WebSocket(target);

		socket.on('open', () => {
			attempt = 0;
			bound = attachViewer(satellite, socket, { identity, onLog });
			onLog({ level: 'info', event: 'hub.link_open' });
		});
		socket.on('close', (code, reason) => {
			bound?.detach();
			bound = null;
			socket = null;
			onLog({ level: 'warn', event: 'hub.link_closed', code, reason: reason?.toString() });
			schedule();
		});
		socket.on('error', (err) => {
			onLog({ level: 'warn', event: 'hub.link_error', message: err.message });
		});
	};

	const schedule = () => {
		if (stopped) return;
		attempt += 1;
		const base = Math.min(30_000, 500 * 2 ** Math.min(attempt, 6));
		const delay = Math.round(base * (0.5 + Math.random() / 2));
		timer = setTimeout(connect, delay);
		timer.unref?.();
	};

	connect();

	return {
		close: () => {
			stopped = true;
			if (timer) clearTimeout(timer);
			bound?.detach();
			socket?.close(CLOSE.GOING_AWAY, 'shutting down');
		},
		get connected() {
			return socket?.readyState === WebSocket.OPEN;
		},
	};
}
