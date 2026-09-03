/**
 * The relay transport: the same `HomeBridge`, reaching a house that dialled out
 * to us instead of one we dialled into.
 *
 * Most Home Assistant installs are only reachable from inside the house. A
 * public server cannot route to them, so for those homes the house opens one
 * outbound WebSocket to the three.ws relay and the platform reaches it through
 * that. To everything above this file that is a transport swap and nothing
 * more: the room graph, the physical-action gate, the intent resolution, the
 * agent tools and the UI are identical, because `home-assistant-js-websocket`
 * already takes a `createSocket` and this module is one.
 *
 * ## What is different, and it is a feature
 *
 * A direct connection carries a Home Assistant long-lived access token that
 * three.ws stores encrypted. A relay connection carries none: the integration
 * inside the house authenticates to Home Assistant locally, on the user's own
 * machine, and no Home Assistant credential ever reaches us. That is why
 * `HomeBridge` accepts a transport in place of a token rather than in addition
 * to one, and why `home_connections.access_token_enc` is empty for a relay
 * home.
 *
 * ## The shim
 *
 * `Connection` uses a small, stable slice of the WebSocket surface:
 * `readyState`, `OPEN`, `addEventListener` and `removeEventListener` for
 * "message" and "close", `send(string)`, `close()` and the `haVersion` property
 * the auth phase would normally have set. This module presents exactly that
 * over a relay session, so the client library reconnects, resubscribes and
 * recovers on its own, with no second reconnect loop written on top of it.
 *
 * The authentication handshake never happens here, because it already happened
 * inside the house: the session is handed over post-auth with the real
 * instance's version attached. No `auth` frame ever crosses the relay.
 */

import { ERR, HomeBridgeError } from './errors.js';

/** Must match services/home-relay/src/protocol.js. */
export const RELAY_PROTOCOL_VERSION = 1;

const FRAME = {
	SESSION_READY: 'session.ready',
	SESSION_CLOSE: 'session.close',
	HA: 'ha',
};

/**
 * Resolve the WebSocket constructor. Node 22 has a global `WebSocket`, and a
 * caller can inject one (a test double, or `ws`) instead.
 */
function resolveWebSocket(injected) {
	const impl = injected || globalThis.WebSocket;
	if (typeof impl !== 'function') {
		throw new HomeBridgeError(ERR.UNREACHABLE, 'No WebSocket implementation is available for the relay transport. Pass WebSocketImpl.');
	}
	return impl;
}

/**
 * Build the `createSocket` a `HomeBridge` needs to reach a relayed home.
 *
 * @param {object} options
 * @param {string} options.relayUrl   the relay's base URL, e.g. wss://home-relay.three.ws
 * @param {string} options.relayId    the house's public routing handle
 * @param {string} options.serviceToken the platform's credential for the relay
 * @param {number} [options.openTimeoutMs] how long to wait for session.ready
 * @param {Function} [options.WebSocketImpl]
 * @returns {{ createSocket: Function }}
 */
export function createRelayTransport({ relayUrl, relayId, serviceToken, openTimeoutMs = 15_000, WebSocketImpl } = {}) {
	if (!relayUrl) throw new HomeBridgeError(ERR.BAD_URL, 'The relay transport needs a relayUrl.');
	if (!relayId) throw new HomeBridgeError(ERR.BAD_URL, 'The relay transport needs a relayId.');
	if (!serviceToken) throw new HomeBridgeError(ERR.AUTH, 'The relay transport needs the relay service token.');
	const WS = resolveWebSocket(WebSocketImpl);
	const endpoint = buildEndpoint(relayUrl, relayId);

	/**
	 * `home-assistant-js-websocket` calls this for the first connection and for
	 * every reconnect, so a house that goes offline and comes back recovers with
	 * no action from the user and no code above this line.
	 */
	const createSocket = () =>
		new Promise((resolve, reject) => {
			let socket;
			try {
				socket = new WS(endpoint, { headers: { authorization: `Bearer ${serviceToken}` } });
			} catch (cause) {
				reject(new HomeBridgeError(ERR.UNREACHABLE, `Could not open a relay session at ${endpoint}.`, cause));
				return;
			}

			const shim = new RelaySocket(socket, relayId);
			let settled = false;
			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				shim.destroy();
				reject(new HomeBridgeError(ERR.UNREACHABLE, `This home did not answer through the relay within ${Math.round(openTimeoutMs / 1000)} seconds. Its three.ws integration may be offline.`));
			}, openTimeoutMs);

			shim.onOpen = (haVersion) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				shim.haVersion = haVersion;
				resolve(shim);
			};
			shim.onOpenFailed = (err) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				reject(err);
			};
		});

	return { createSocket, endpoint, relayId };
}

function buildEndpoint(relayUrl, relayId) {
	let url;
	try {
		url = new URL(relayUrl);
	} catch (cause) {
		throw new HomeBridgeError(ERR.BAD_URL, `"${relayUrl}" is not a valid relay URL.`, cause);
	}
	if (url.protocol === 'http:') url.protocol = 'ws:';
	if (url.protocol === 'https:') url.protocol = 'wss:';
	if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
		throw new HomeBridgeError(ERR.BAD_URL, `Unsupported relay scheme "${url.protocol}".`);
	}
	url.pathname = `${url.pathname.replace(/\/+$/, '')}/v1/bridge`;
	url.searchParams.set('relay_id', relayId);
	return url.href;
}

/**
 * A WebSocket-shaped view of one relay session.
 *
 * Everything the transport does is here: unwrap `ha` frames into the messages
 * the client expects, wrap outgoing messages back into frames, and translate a
 * `session.close` into a socket close with a reason a person can read.
 */
class RelaySocket {
	haVersion = '';
	onOpen = null;
	onOpenFailed = null;

	#socket;
	#relayId;
	#listeners = { message: new Set(), close: new Set() };
	#ready = false;
	#closed = false;

	constructor(socket, relayId) {
		this.#socket = socket;
		this.#relayId = relayId;
		// `ws` uses Node's EventEmitter; a browser/Node global WebSocket uses
		// addEventListener. Support both so the same transport runs in the API
		// container and in a browser doing a local direct connect.
		bind(socket, 'message', (event) => this.#onFrame(event));
		bind(socket, 'close', (event) => this.#onClose(event));
		bind(socket, 'error', (event) => this.#onError(event));
	}

	/** The two constants Connection reads off the socket. */
	get OPEN() {
		return 1;
	}

	get readyState() {
		if (this.#closed) return 3;
		return this.#ready ? 1 : 0;
	}

	addEventListener(type, handler) {
		this.#listeners[type]?.add(handler);
	}

	removeEventListener(type, handler) {
		this.#listeners[type]?.delete(handler);
	}

	send(data) {
		if (this.#closed) return;
		let msg;
		try {
			msg = JSON.parse(typeof data === 'string' ? data : String(data));
		} catch {
			// The client only ever sends JSON it built itself, so this cannot
			// happen in practice; dropping beats forwarding an unparsed string
			// into a house.
			return;
		}
		this.#raw({ v: RELAY_PROTOCOL_VERSION, t: FRAME.HA, sid: this.sid, msg });
	}

	close() {
		if (this.#closed) return;
		this.#raw({ v: RELAY_PROTOCOL_VERSION, t: FRAME.SESSION_CLOSE, sid: this.sid || 'pending', code: 'ok', reason: 'The platform closed this session.' });
		this.destroy();
	}

	destroy() {
		this.#closed = true;
		this.#ready = false;
		try {
			this.#socket.close();
		} catch {
			// A socket that is already gone needs no further closing.
		}
	}

	#raw(frame) {
		try {
			this.#socket.send(JSON.stringify(frame));
		} catch {
			// Send on a dying socket: the close handler below is what recovers,
			// and the client library reconnects from there.
		}
	}

	#onFrame(event) {
		let frame;
		try {
			frame = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
		} catch {
			return;
		}
		if (frame?.v !== RELAY_PROTOCOL_VERSION) return;

		if (frame.t === FRAME.SESSION_READY) {
			this.sid = frame.sid;
			this.#ready = true;
			this.onOpen?.(String(frame.haVersion || ''));
			return;
		}
		if (frame.t === FRAME.SESSION_CLOSE) {
			this.#failOrClose(frame.code, frame.reason);
			return;
		}
		if (frame.t === FRAME.HA) {
			// The sid arrives on session.ready, but a well-behaved relay stamps
			// every frame, so honour it if the session has not been named yet.
			if (!this.sid) this.sid = frame.sid;
			this.#emit('message', { data: JSON.stringify(frame.msg) });
		}
	}

	#failOrClose(code, reason) {
		if (!this.#ready && this.onOpenFailed) {
			this.onOpenFailed(relayCloseError(code, reason, this.#relayId));
			this.#closed = true;
			try {
				this.#socket.close();
			} catch {
				// Already gone.
			}
			return;
		}
		this.destroy();
		this.#emit('close', { code: 1000, reason: String(reason || code || '') });
	}

	#onClose(event) {
		if (this.#closed && !this.#ready) return;
		const wasReady = this.#ready;
		this.#closed = true;
		this.#ready = false;
		if (!wasReady && this.onOpenFailed) {
			this.onOpenFailed(relayCloseError('agent_offline', event?.reason, this.#relayId));
			return;
		}
		this.#emit('close', { code: event?.code ?? 1006, reason: String(event?.reason || '') });
	}

	#onError(event) {
		if (!this.#ready && this.onOpenFailed) {
			this.onOpenFailed(new HomeBridgeError(ERR.UNREACHABLE, `The relay connection for this home failed: ${event?.message || 'socket error'}.`));
			this.#closed = true;
		}
	}

	#emit(type, event) {
		for (const handler of this.#listeners[type]) {
			try {
				handler(event);
			} catch {
				// A listener that throws must not take the socket down with it.
			}
		}
	}
}

/**
 * The relay's coded close reasons, turned into the sentences a connect screen
 * shows. Each one names a state the user can act on, never a stack trace.
 */
export function relayCloseError(code, reason, relayId) {
	switch (code) {
		case 'agent_offline':
			return new HomeBridgeError(ERR.UNREACHABLE, 'This home is not connected right now. Its three.ws integration is offline, which usually means Home Assistant is restarting or the machine is off. It reconnects on its own.');
		case 'revoked':
			return new HomeBridgeError(ERR.AUTH, 'This home was disconnected. Add it again in three.ws to pair a new code.');
		case 'protocol_too_old':
			return new HomeBridgeError(ERR.AUTH, reason || 'The three.ws integration in this home is too old for the relay. Update it in HACS.');
		case 'protocol_too_new':
			return new HomeBridgeError(ERR.UNREACHABLE, reason || 'The relay is being upgraded. This home reconnects on its own shortly.');
		case 'rate_limited':
			return new HomeBridgeError(ERR.CALL_FAILED, 'Too many requests reached this home at once. It accepts requests again in a moment.');
		case 'too_many_sessions':
			return new HomeBridgeError(ERR.UNREACHABLE, reason || 'This home already has as many open sessions as the relay allows.');
		case 'ha_unreachable':
			return new HomeBridgeError(ERR.UNREACHABLE, 'The three.ws integration is connected but Home Assistant itself did not answer it. Check that Home Assistant finished starting.');
		case 'unauthorized':
			return new HomeBridgeError(ERR.AUTH, 'The relay refused this connection. Reconnect this home in three.ws.');
		default:
			return new HomeBridgeError(ERR.UNREACHABLE, reason || `The relay closed the session for ${relayId}.`);
	}
}

/** `ws` speaks EventEmitter; a WHATWG WebSocket speaks addEventListener. */
function bind(socket, type, handler) {
	if (typeof socket.addEventListener === 'function') {
		socket.addEventListener(type, handler);
		return;
	}
	socket.on(type, (a, b) => {
		if (type === 'message') return handler({ data: a });
		if (type === 'close') return handler({ code: a, reason: String(b || '') });
		return handler(a);
	});
}
