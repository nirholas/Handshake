/**
 * The three.ws home relay wire protocol, version 1.
 *
 * This module is pure. It owns the framing, the version negotiation and, most
 * importantly, the allowlist. It has no sockets, no timers and no I/O, so the
 * one part of this system that must never be wrong can be tested exhaustively
 * without a network.
 *
 * ## Why a relay exists at all
 *
 * Home Assistant lives on a LAN. three.ws is served over https from Cloud Run
 * and cannot route to RFC1918 space. The house therefore dials out to us: one
 * outbound WebSocket from a three.ws integration running inside Home Assistant,
 * to this relay. No port is forwarded, nothing listens on the user's network,
 * and no inbound firewall rule is needed.
 *
 * ## Why this is not an HTTP proxy
 *
 * The obvious implementation is "forward any HTTP request into the LAN". That
 * would be the single worst thing this platform could ship: a caller-chosen
 * path into someone's home network. This protocol instead carries a fixed,
 * enumerated set of Home Assistant WebSocket message types, and refuses
 * everything else at both ends.
 *
 * The allowlist below is derived from what `packages/home-bridge` actually
 * sends, which in turn is what `home-assistant-js-websocket` emits for the
 * three channels the product uses: the entity subscription, the four registry
 * reads, and service calls. Nothing else has ever been needed, so nothing else
 * is permitted.
 *
 * ## Where the allowlist is enforced
 *
 * Twice, independently:
 *
 *   1. In the relay (`server.js`), so a compromised or buggy platform-side
 *      caller cannot reach past it.
 *   2. In the integration inside the house (`relay_client.py`), so a compromised
 *      relay cannot either. This is the property that matters: the relay is
 *      operated by us and is therefore exactly the component a user has to
 *      trust least. See `docs/home-relay-threat-model.md`.
 *
 * Both enforcement points import their rules from the same enumeration: this
 * file is the source of truth, and `services/home-relay/allowlist.json` is the
 * generated copy the Python side reads, kept honest by a test.
 */

/** The only protocol version this build speaks. */
export const PROTOCOL_VERSION = 1;

/**
 * The oldest integration build the relay will still talk to. Bumping this is
 * how an old add-on is told to upgrade, which is state 5 in the connect UI:
 * a named version and an upgrade path, never a silent failure.
 */
export const MIN_AGENT_PROTOCOL = 1;

/** Frame types on the control and session planes. */
export const FRAME = {
	/** agent to relay: I am here, this is my build. */
	HELLO: 'hello',
	/** relay to agent: accepted, here is the heartbeat interval. */
	HELLO_OK: 'hello.ok',
	/** relay to agent: refused, with a reason a human can act on. */
	HELLO_ERR: 'hello.err',
	/** either direction: liveness. */
	PING: 'ping',
	PONG: 'pong',
	/** bridge to agent: open a Home Assistant session for this sid. */
	SESSION_OPEN: 'session.open',
	/** agent to bridge: the session is live, and this is the house's HA version. */
	SESSION_READY: 'session.ready',
	/** either direction: this session is over, with a coded reason. */
	SESSION_CLOSE: 'session.close',
	/** either direction: one Home Assistant WebSocket message, allowlisted. */
	HA: 'ha',
};

const FRAME_TYPES = new Set(Object.values(FRAME));

/** Coded close and refusal reasons. The UI maps these to real sentences. */
export const CODE = {
	OK: 'ok',
	/** The integration is older than MIN_AGENT_PROTOCOL. */
	PROTOCOL_TOO_OLD: 'protocol_too_old',
	/** The relay is older than the integration expects. */
	PROTOCOL_TOO_NEW: 'protocol_too_new',
	/** The bearer token did not verify. */
	UNAUTHORIZED: 'unauthorized',
	/** This relay id has been revoked in three.ws. */
	REVOKED: 'revoked',
	/** No integration is currently dialled in for this relay id. */
	AGENT_OFFLINE: 'agent_offline',
	/** A frame carried a message type outside the allowlist. */
	NOT_ALLOWED: 'not_allowed',
	/** The frame was not valid protocol. */
	MALFORMED: 'malformed',
	/** Per-install rate limit tripped. */
	RATE_LIMITED: 'rate_limited',
	/** Home Assistant itself refused or dropped the local connection. */
	HA_UNREACHABLE: 'ha_unreachable',
	/** The relay or the integration is shutting down. */
	GOING_AWAY: 'going_away',
	/** Too many concurrent sessions for one install. */
	TOO_MANY_SESSIONS: 'too_many_sessions',
};

/**
 * Home Assistant WebSocket message types the platform may send INTO a house.
 *
 * Every entry is justified by a real call site in `packages/home-bridge`:
 *
 *   supported_features        sent once after auth by home-assistant-js-websocket
 *   get_states                the initial entity snapshot
 *   get_config                the instance's own name, unit system and location
 *   subscribe_entities        the live state channel (HA 2022.4 and newer)
 *   subscribe_events          the legacy live state channel, state_changed only
 *   unsubscribe_events        tearing either of those down
 *   ping                      liveness
 *   config/floor_registry/list
 *   config/area_registry/list      the room graph the 3D scene renders
 *   config/device_registry/list
 *   config/entity_registry/list
 *   call_service              the only type that actuates anything
 *
 * Notably absent, and deliberately: `auth`, because authentication never
 * crosses the relay (the integration authenticates locally, inside the house);
 * `get_services`, `auth/current_user`, and every `config/*` write.
 */
export const OUTBOUND_TYPES = Object.freeze([
	'supported_features',
	'get_states',
	'get_config',
	'subscribe_entities',
	'subscribe_events',
	'unsubscribe_events',
	'ping',
	'config/floor_registry/list',
	'config/area_registry/list',
	'config/device_registry/list',
	'config/entity_registry/list',
	'call_service',
]);

/**
 * Message types the house may send OUT. Home Assistant's WebSocket API answers
 * in exactly three shapes plus the pong, so nothing else needs to leave.
 */
export const INBOUND_TYPES = Object.freeze(['result', 'event', 'pong']);

/**
 * `subscribe_events` without an event type subscribes to EVERY event in the
 * house, which is a far larger read surface than the room graph needs (it would
 * carry, for example, every `call_service` another integration makes). Only the
 * one event the legacy state channel uses is permitted.
 */
export const ALLOWED_EVENT_TYPES = Object.freeze(['state_changed']);

/**
 * Service domains that administer the Home Assistant install or execute
 * arbitrary code on the host, rather than controlling a device.
 *
 * The physical-action gate in `packages/home-bridge/src/safety.js` is about
 * doors, locks and alarms. This list is about the box itself: a relayed
 * `shell_command.*` is remote code execution on the user's server, and no
 * amount of user confirmation in a chat window makes that a smart-home feature.
 * Neither three.ws nor the relay has any reason to reach these, so the protocol
 * refuses them outright and the refusal is not overridable by a confirmation.
 */
export const DENIED_SERVICE_DOMAINS = Object.freeze([
	'shell_command',
	'python_script',
	'hassio',
	'supervisor',
	'backup',
	'update',
	'cloud',
	'config',
	'auth',
	'command_line',
]);

/**
 * Individual services on otherwise legitimate domains that restart, stop or
 * reconfigure the instance. `homeassistant.turn_on` is a normal device call;
 * `homeassistant.restart` is not.
 */
export const DENIED_SERVICES = Object.freeze([
	'homeassistant.restart',
	'homeassistant.stop',
	'homeassistant.check_config',
	'homeassistant.reload_all',
	'homeassistant.reload_core_config',
	'persistent_notification.create',
]);

const OUTBOUND_SET = new Set(OUTBOUND_TYPES);
const INBOUND_SET = new Set(INBOUND_TYPES);
const EVENT_SET = new Set(ALLOWED_EVENT_TYPES);
const DENIED_DOMAIN_SET = new Set(DENIED_SERVICE_DOMAINS);
const DENIED_SERVICE_SET = new Set(DENIED_SERVICES);

/** Hard ceilings, so a bug on either side cannot exhaust the other's memory. */
export const LIMITS = Object.freeze({
	/** One frame. A large house's `get_states` result is the biggest legitimate
	 *  payload and measures a few hundred kilobytes; 4 MB is generous headroom
	 *  without being an amplification target. */
	maxFrameBytes: 4 * 1024 * 1024,
	/** Concurrent Home Assistant sessions per install. One three.ws instance
	 *  holds one; the cap exists so a reconnect storm cannot open hundreds. */
	maxSessionsPerInstall: 8,
	/** Frames per second into one house, averaged over the window below. A
	 *  relayed house is a physical building: nothing legitimate needs more. */
	outboundFramesPerSecond: 40,
	/** Actuating calls per minute into one house. */
	serviceCallsPerMinute: 60,
	/** How long the relay waits for a pong before dropping a socket. */
	heartbeatMs: 25_000,
	heartbeatTimeoutMs: 60_000,
});

/**
 * Encode one frame. Always returns a string: the protocol is JSON text frames,
 * because every payload it carries is already JSON and a binary framing would
 * buy nothing but a second parser to get wrong.
 */
export function encodeFrame(frame) {
	return JSON.stringify(frame);
}

/**
 * Parse and structurally validate one inbound frame.
 *
 * @param {string|Buffer} raw
 * @returns {{ ok: true, frame: object } | { ok: false, code: string, message: string }}
 */
export function decodeFrame(raw) {
	const text = typeof raw === 'string' ? raw : String(raw);
	if (text.length > LIMITS.maxFrameBytes) {
		return refuse(CODE.MALFORMED, `Frame of ${text.length} bytes exceeds the ${LIMITS.maxFrameBytes} byte limit.`);
	}
	let frame;
	try {
		frame = JSON.parse(text);
	} catch {
		return refuse(CODE.MALFORMED, 'Frame was not valid JSON.');
	}
	if (!frame || typeof frame !== 'object' || Array.isArray(frame)) {
		return refuse(CODE.MALFORMED, 'Frame must be a JSON object.');
	}
	if (frame.v !== PROTOCOL_VERSION) {
		return refuse(CODE.MALFORMED, `Frame version ${JSON.stringify(frame.v)} is not ${PROTOCOL_VERSION}.`);
	}
	if (!FRAME_TYPES.has(frame.t)) {
		return refuse(CODE.MALFORMED, `Unknown frame type ${JSON.stringify(frame.t)}.`);
	}
	if (needsSid(frame.t) && !isSid(frame.sid)) {
		return refuse(CODE.MALFORMED, `Frame type ${frame.t} requires a session id.`);
	}
	if (frame.t === FRAME.HA && (!frame.msg || typeof frame.msg !== 'object' || Array.isArray(frame.msg))) {
		return refuse(CODE.MALFORMED, 'A ha frame must carry a msg object.');
	}
	return { ok: true, frame };
}

function needsSid(type) {
	return type === FRAME.SESSION_OPEN || type === FRAME.SESSION_READY || type === FRAME.SESSION_CLOSE || type === FRAME.HA;
}

function isSid(sid) {
	return typeof sid === 'string' && sid.length > 0 && sid.length <= 64 && /^[A-Za-z0-9_-]+$/.test(sid);
}

function refuse(code, message) {
	return { ok: false, code, message };
}

/**
 * The allowlist decision for one Home Assistant message travelling INTO a house.
 *
 * @param {object} msg a Home Assistant WebSocket message
 * @returns {{ allowed: true } | { allowed: false, code: string, reason: string }}
 */
export function checkOutbound(msg) {
	if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
		return deny(CODE.MALFORMED, 'A Home Assistant message must be an object.');
	}
	const type = msg.type;
	if (typeof type !== 'string' || !OUTBOUND_SET.has(type)) {
		return deny(CODE.NOT_ALLOWED, `"${describe(type)}" is not a message type this relay carries into a home.`);
	}
	if (type === 'subscribe_events') {
		const eventType = msg.event_type;
		if (typeof eventType !== 'string' || !EVENT_SET.has(eventType)) {
			return deny(
				CODE.NOT_ALLOWED,
				`subscribe_events is limited to ${ALLOWED_EVENT_TYPES.join(', ')}; "${describe(eventType)}" would subscribe to more of the house than the room graph needs.`,
			);
		}
	}
	if (type === 'call_service') {
		return checkServiceCall(msg);
	}
	return { allowed: true };
}

function checkServiceCall(msg) {
	const domain = typeof msg.domain === 'string' ? msg.domain : '';
	const service = typeof msg.service === 'string' ? msg.service : '';
	if (!domain || !service) {
		return deny(CODE.MALFORMED, 'call_service needs a domain and a service.');
	}
	if (DENIED_DOMAIN_SET.has(domain)) {
		return deny(
			CODE.NOT_ALLOWED,
			`The "${domain}" domain administers the Home Assistant install rather than a device, so the relay never carries it. Run it from Home Assistant itself.`,
		);
	}
	if (DENIED_SERVICE_SET.has(`${domain}.${service}`)) {
		return deny(
			CODE.NOT_ALLOWED,
			`"${domain}.${service}" changes the Home Assistant install itself, so the relay never carries it. Run it from Home Assistant itself.`,
		);
	}
	if (msg.return_response !== undefined && typeof msg.return_response !== 'boolean') {
		return deny(CODE.MALFORMED, 'call_service return_response must be a boolean when present.');
	}
	return { allowed: true };
}

/**
 * The allowlist decision for one Home Assistant message travelling OUT of a
 * house. Narrower than it looks: this is the direction that carries the user's
 * own data, so it is capped at the three reply shapes the client understands.
 */
export function checkInbound(msg) {
	if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
		return deny(CODE.MALFORMED, 'A Home Assistant message must be an object.');
	}
	if (typeof msg.type !== 'string' || !INBOUND_SET.has(msg.type)) {
		return deny(CODE.NOT_ALLOWED, `"${describe(msg.type)}" is not a message type this relay carries out of a home.`);
	}
	return { allowed: true };
}

function deny(code, reason) {
	return { allowed: false, code, reason };
}

/** Renders an arbitrary caller-supplied value for an error string, bounded. */
function describe(value) {
	if (typeof value !== 'string') return typeof value === 'undefined' ? 'undefined' : JSON.stringify(value);
	return value.length > 64 ? `${value.slice(0, 64)}...` : value;
}

/**
 * Version negotiation, run once per agent connection.
 *
 * @param {number} agentProtocol the version the integration claims
 */
export function negotiate(agentProtocol) {
	if (!Number.isInteger(agentProtocol)) {
		return { ok: false, code: CODE.MALFORMED, message: 'hello.protocol must be an integer.' };
	}
	if (agentProtocol < MIN_AGENT_PROTOCOL) {
		return {
			ok: false,
			code: CODE.PROTOCOL_TOO_OLD,
			message: `This three.ws integration speaks relay protocol ${agentProtocol}; the relay needs ${MIN_AGENT_PROTOCOL} or newer. Update the integration in HACS.`,
		};
	}
	if (agentProtocol > PROTOCOL_VERSION) {
		return {
			ok: false,
			code: CODE.PROTOCOL_TOO_NEW,
			message: `This three.ws integration speaks relay protocol ${agentProtocol}; this relay speaks ${PROTOCOL_VERSION}. The relay is being upgraded, so retrying shortly will succeed.`,
		};
	}
	return { ok: true, protocol: agentProtocol };
}

/** Frame builders, so no call site hand-writes a frame shape. */
export const frames = {
	hello: (relayId, agent) => ({ v: PROTOCOL_VERSION, t: FRAME.HELLO, relayId, protocol: PROTOCOL_VERSION, agent }),
	helloOk: (relayId, relay) => ({ v: PROTOCOL_VERSION, t: FRAME.HELLO_OK, relayId, relay, heartbeatMs: LIMITS.heartbeatMs }),
	helloErr: (code, message) => ({ v: PROTOCOL_VERSION, t: FRAME.HELLO_ERR, code, message }),
	ping: (ts) => ({ v: PROTOCOL_VERSION, t: FRAME.PING, ts }),
	pong: (ts) => ({ v: PROTOCOL_VERSION, t: FRAME.PONG, ts }),
	sessionOpen: (sid) => ({ v: PROTOCOL_VERSION, t: FRAME.SESSION_OPEN, sid }),
	sessionReady: (sid, haVersion) => ({ v: PROTOCOL_VERSION, t: FRAME.SESSION_READY, sid, haVersion }),
	sessionClose: (sid, code, reason) => ({ v: PROTOCOL_VERSION, t: FRAME.SESSION_CLOSE, sid, code, reason }),
	ha: (sid, msg) => ({ v: PROTOCOL_VERSION, t: FRAME.HA, sid, msg }),
};

/**
 * The machine-readable form of everything above, for the Python side and for
 * the threat-model doc. `tests/home-relay-protocol.test.js` asserts the
 * generated `allowlist.json` still matches this, so the two enforcement points
 * can never silently diverge.
 */
export function allowlistManifest() {
	return {
		protocolVersion: PROTOCOL_VERSION,
		minAgentProtocol: MIN_AGENT_PROTOCOL,
		frameTypes: Object.values(FRAME),
		outboundTypes: [...OUTBOUND_TYPES],
		inboundTypes: [...INBOUND_TYPES],
		allowedEventTypes: [...ALLOWED_EVENT_TYPES],
		deniedServiceDomains: [...DENIED_SERVICE_DOMAINS],
		deniedServices: [...DENIED_SERVICES],
		limits: { ...LIMITS },
	};
}
