/**
 * The three.ws home relay.
 *
 * A house that only exists on a LAN cannot be reached from Cloud Run, so the
 * house dials out instead: the three.ws integration inside Home Assistant opens
 * one outbound WebSocket to this service and keeps it. The platform then asks
 * this service to open a session over that socket. Nothing listens on the
 * user's network, no port is forwarded, and no inbound firewall rule exists.
 *
 * This service is deliberately small and deliberately dumb:
 *
 *   * It holds no database. Ownership is proved by the signature on the install
 *     token the house presents (`token.js`), so the connect path never queries
 *     anything.
 *   * It holds no Home Assistant credential, ever. Authentication happens
 *     locally inside the house and never crosses this process.
 *   * It forwards only the message types in `protocol.js`, in the direction
 *     that protocol permits, and the integration enforces the same list again
 *     at the far end so that compromising this service does not compromise a
 *     house.
 *
 * Read `docs/home-relay-threat-model.md` before changing anything here.
 */

import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';

import { CODE, FRAME, LIMITS, checkInbound, checkOutbound, decodeFrame, encodeFrame, frames, negotiate } from './protocol.js';
import { constantTimeEquals, verifyInstallToken } from './token.js';

const SERVICE_VERSION = '1.0.0';

/**
 * A token bucket. Used per install for both frame rate and actuation rate,
 * because a bug in an integration must not be able to flood a house and a
 * compromised platform caller must not be able to hammer a lock.
 */
class Bucket {
	constructor(capacity, refillPerSecond) {
		this.capacity = capacity;
		this.refillPerSecond = refillPerSecond;
		this.tokens = capacity;
		this.last = Date.now();
	}

	take(now = Date.now()) {
		const elapsed = Math.max(0, now - this.last) / 1000;
		this.last = now;
		this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSecond);
		if (this.tokens < 1) return false;
		this.tokens -= 1;
		return true;
	}
}

/** One dialled-in house. */
class Install {
	constructor(relayId, socket, claims, agentInfo) {
		this.relayId = relayId;
		this.socket = socket;
		this.claims = claims;
		this.agent = agentInfo;
		this.connectedAt = Date.now();
		this.sessions = new Map();
		this.frameBucket = new Bucket(LIMITS.outboundFramesPerSecond, LIMITS.outboundFramesPerSecond);
		this.callBucket = new Bucket(LIMITS.serviceCallsPerMinute, LIMITS.serviceCallsPerMinute / 60);
		this.alive = true;
		this.counters = { framesIn: 0, framesOut: 0, denied: 0, sessions: 0 };
	}

	send(frame) {
		if (this.socket.readyState !== this.socket.OPEN) return false;
		this.socket.send(encodeFrame(frame));
		this.counters.framesOut += 1;
		return true;
	}
}

export function createRelay(options = {}) {
	const signingKey = options.signingKey || process.env.HOME_RELAY_SIGNING_KEY;
	const serviceToken = options.serviceToken || process.env.HOME_RELAY_SERVICE_TOKEN;
	if (!signingKey || signingKey.length < 32) throw new Error('HOME_RELAY_SIGNING_KEY must be set to at least 32 characters.');
	if (!serviceToken || serviceToken.length < 32) throw new Error('HOME_RELAY_SERVICE_TOKEN must be set to at least 32 characters.');
	const log = options.log || ((event, fields) => console.log(JSON.stringify({ event, ...fields })));

	/** relayId to Install. One socket per house: a second dial-in replaces the first. */
	const installs = new Map();
	/** relayId to the epoch ms it was revoked, so a race cannot re-register it. */
	const revoked = new Map();
	const startedAt = Date.now();

	const server = createServer((req, res) => handleHttp(req, res));
	const agentWss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.maxFrameBytes });
	const bridgeWss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.maxFrameBytes });

	server.on('upgrade', (req, socket, head) => {
		let url;
		try {
			url = new URL(req.url, 'http://relay.invalid');
		} catch {
			return refuseUpgrade(socket, 400, 'Bad request');
		}
		if (url.pathname === '/v1/agent') {
			const auth = bearer(req);
			const verdict = verifyInstallToken(auth, signingKey);
			if (!verdict.ok) {
				log('agent.rejected', { reason: verdict.reason });
				return refuseUpgrade(socket, 401, 'Unauthorized');
			}
			if (revoked.has(verdict.claims.relayId)) {
				log('agent.rejected', { relayId: verdict.claims.relayId, reason: 'revoked' });
				return refuseUpgrade(socket, 403, 'Revoked');
			}
			return agentWss.handleUpgrade(req, socket, head, (ws) => onAgent(ws, verdict.claims));
		}
		if (url.pathname === '/v1/bridge') {
			if (!constantTimeEquals(bearer(req), serviceToken)) {
				log('bridge.rejected', { reason: 'bad service token' });
				return refuseUpgrade(socket, 401, 'Unauthorized');
			}
			const relayId = url.searchParams.get('relay_id') || '';
			return bridgeWss.handleUpgrade(req, socket, head, (ws) => onBridge(ws, relayId));
		}
		return refuseUpgrade(socket, 404, 'Not found');
	});

	// ---------------------------------------------------------------- the house

	function onAgent(ws, claims) {
		const { relayId } = claims;
		let install = null;
		let helloTimer = setTimeout(() => {
			if (!install) {
				ws.send(encodeFrame(frames.helloErr(CODE.MALFORMED, 'No hello frame within 10 seconds.')));
				ws.close(4000, CODE.MALFORMED);
			}
		}, 10_000);

		ws.on('message', (raw) => {
			const decoded = decodeFrame(raw);
			if (!decoded.ok) {
				log('agent.malformed', { relayId, reason: decoded.message });
				ws.close(4000, decoded.code);
				return;
			}
			const frame = decoded.frame;

			if (!install) {
				if (frame.t !== FRAME.HELLO) {
					ws.send(encodeFrame(frames.helloErr(CODE.MALFORMED, 'The first frame must be hello.')));
					ws.close(4000, CODE.MALFORMED);
					return;
				}
				const agreed = negotiate(frame.protocol);
				if (!agreed.ok) {
					log('agent.protocol', { relayId, code: agreed.code });
					ws.send(encodeFrame(frames.helloErr(agreed.code, agreed.message)));
					ws.close(4001, agreed.code);
					return;
				}
				if (revoked.has(relayId)) {
					ws.send(encodeFrame(frames.helloErr(CODE.REVOKED, 'This home was disconnected in three.ws. Remove and re-add the integration to pair it again.')));
					ws.close(4003, CODE.REVOKED);
					return;
				}
				clearTimeout(helloTimer);
				helloTimer = null;
				// One house, one socket. A stale socket from a crashed container
				// would otherwise shadow the live one forever.
				const previous = installs.get(relayId);
				if (previous && previous.socket !== ws) {
					closeInstall(previous, CODE.GOING_AWAY, 'Replaced by a newer connection from this home.');
				}
				install = new Install(relayId, ws, claims, sanitizeAgentInfo(frame.agent));
				installs.set(relayId, install);
				ws.send(encodeFrame(frames.helloOk(relayId, { version: SERVICE_VERSION })));
				log('agent.online', { relayId, agent: install.agent, protocol: agreed.protocol });
				return;
			}

			install.counters.framesIn += 1;
			routeFromAgent(install, frame);
		});

		ws.on('pong', () => {
			if (install) install.alive = true;
		});

		ws.on('close', () => {
			if (helloTimer) clearTimeout(helloTimer);
			if (install && installs.get(relayId) === install) {
				installs.delete(relayId);
				for (const session of install.sessions.values()) {
					session.bridge.send(encodeFrame(frames.sessionClose(session.sid, CODE.AGENT_OFFLINE, 'The three.ws integration in this home went offline.')));
					session.bridge.close(1000, CODE.AGENT_OFFLINE);
				}
				install.sessions.clear();
				log('agent.offline', { relayId, uptimeMs: Date.now() - install.connectedAt, counters: install.counters });
			}
		});

		ws.on('error', (err) => log('agent.error', { relayId, message: err?.message }));
	}

	function routeFromAgent(install, frame) {
		if (frame.t === FRAME.PONG || frame.t === FRAME.PING) {
			if (frame.t === FRAME.PING) install.send(frames.pong(frame.ts));
			return;
		}
		const session = install.sessions.get(frame.sid);
		if (!session) return; // A reply for a session the platform already dropped.

		if (frame.t === FRAME.SESSION_READY) {
			session.ready = true;
			session.bridge.send(encodeFrame(frames.sessionReady(session.sid, String(frame.haVersion || ''))));
			return;
		}
		if (frame.t === FRAME.SESSION_CLOSE) {
			session.bridge.send(encodeFrame(frames.sessionClose(session.sid, String(frame.code || CODE.OK), String(frame.reason || ''))));
			session.bridge.close(1000, String(frame.code || CODE.OK));
			return;
		}
		if (frame.t === FRAME.HA) {
			const verdict = checkInbound(frame.msg);
			if (!verdict.allowed) {
				install.counters.denied += 1;
				log('relay.denied', { relayId: install.relayId, direction: 'inbound', code: verdict.code, reason: verdict.reason });
				return;
			}
			session.bridge.send(encodeFrame(frames.ha(session.sid, frame.msg)));
		}
	}

	// ------------------------------------------------------------- the platform

	function onBridge(ws, relayId) {
		const install = installs.get(relayId);
		if (!relayId || !install) {
			ws.send(encodeFrame(frames.sessionClose('pending', CODE.AGENT_OFFLINE, 'No three.ws integration is connected for this home right now.')));
			ws.close(1000, CODE.AGENT_OFFLINE);
			return;
		}
		if (install.sessions.size >= LIMITS.maxSessionsPerInstall) {
			ws.send(encodeFrame(frames.sessionClose('pending', CODE.TOO_MANY_SESSIONS, `This home already has ${install.sessions.size} open sessions.`)));
			ws.close(1000, CODE.TOO_MANY_SESSIONS);
			return;
		}

		const sid = `s_${randomBytes(9).toString('base64url')}`;
		const session = { sid, bridge: ws, install, ready: false, openedAt: Date.now() };
		install.sessions.set(sid, session);
		install.counters.sessions += 1;
		install.send(frames.sessionOpen(sid));
		log('session.open', { relayId, sid });

		ws.on('message', (raw) => {
			const decoded = decodeFrame(raw);
			if (!decoded.ok) {
				ws.send(encodeFrame(frames.sessionClose(sid, decoded.code, decoded.message)));
				ws.close(4000, decoded.code);
				return;
			}
			const frame = decoded.frame;
			if (frame.t === FRAME.SESSION_CLOSE) {
				ws.close(1000, CODE.OK);
				return;
			}
			if (frame.t !== FRAME.HA) return;

			if (!install.frameBucket.take()) {
				install.counters.denied += 1;
				log('relay.rate_limited', { relayId, kind: 'frames' });
				replyRefusal(ws, sid, frame.msg, CODE.RATE_LIMITED, 'Too many requests into this home. Slow down.');
				return;
			}
			const verdict = checkOutbound(frame.msg);
			if (!verdict.allowed) {
				install.counters.denied += 1;
				log('relay.denied', { relayId, direction: 'outbound', code: verdict.code, reason: verdict.reason, type: typeof frame.msg?.type === 'string' ? frame.msg.type.slice(0, 64) : null });
				replyRefusal(ws, sid, frame.msg, verdict.code, verdict.reason);
				return;
			}
			if (frame.msg.type === 'call_service' && !install.callBucket.take()) {
				install.counters.denied += 1;
				log('relay.rate_limited', { relayId, kind: 'call_service' });
				replyRefusal(ws, sid, frame.msg, CODE.RATE_LIMITED, 'Too many service calls into this home in the last minute.');
				return;
			}
			install.send(frames.ha(sid, frame.msg));
		});

		ws.on('close', () => {
			if (install.sessions.get(sid) === session) {
				install.sessions.delete(sid);
				install.send(frames.sessionClose(sid, CODE.OK, 'The platform closed this session.'));
				log('session.close', { relayId, sid, ms: Date.now() - session.openedAt });
			}
		});

		ws.on('error', (err) => log('bridge.error', { relayId, sid, message: err?.message }));
	}

	/**
	 * A refused frame gets a Home Assistant shaped error result rather than a
	 * dropped connection, so the client's own promise rejects with a real
	 * message instead of hanging until its timeout. The session survives: one
	 * bad call is not a reason to tear down a live house.
	 */
	function replyRefusal(ws, sid, msg, code, reason) {
		const id = Number.isInteger(msg?.id) ? msg.id : null;
		if (id === null) return;
		ws.send(encodeFrame(frames.ha(sid, { id, type: 'result', success: false, error: { code, message: reason } })));
	}

	// ------------------------------------------------------------------- admin

	function handleHttp(req, res) {
		const url = new URL(req.url || '/', 'http://relay.invalid');
		if (req.method === 'GET' && (url.pathname === '/healthz' || url.pathname === '/')) {
			return sendJson(res, 200, {
				ok: true,
				service: 'home-relay',
				version: SERVICE_VERSION,
				uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
				installs: installs.size,
				sessions: [...installs.values()].reduce((n, i) => n + i.sessions.size, 0),
			});
		}
		if (!constantTimeEquals(bearer(req), serviceToken)) return sendJson(res, 401, { error: 'unauthorized' });

		if (req.method === 'GET' && url.pathname === '/v1/status') {
			const relayId = url.searchParams.get('relay_id');
			if (relayId) {
				const install = installs.get(relayId);
				return sendJson(res, 200, { relayId, online: Boolean(install), ...(install ? describeInstall(install) : { revokedAt: revoked.get(relayId) || null }) });
			}
			return sendJson(res, 200, { installs: [...installs.values()].map((i) => ({ relayId: i.relayId, ...describeInstall(i) })) });
		}
		if (req.method === 'POST' && url.pathname === '/v1/revoke') {
			return readJson(req, (body) => {
				const relayId = body?.relayId;
				if (typeof relayId !== 'string' || !relayId) return sendJson(res, 400, { error: 'relayId is required' });
				revoked.set(relayId, Date.now());
				const install = installs.get(relayId);
				if (install) closeInstall(install, CODE.REVOKED, 'This home was disconnected in three.ws.');
				log('relay.revoked', { relayId, wasOnline: Boolean(install) });
				return sendJson(res, 200, { relayId, revoked: true, wasOnline: Boolean(install) });
			}, res);
		}
		if (req.method === 'POST' && url.pathname === '/v1/unrevoke') {
			return readJson(req, (body) => {
				const relayId = body?.relayId;
				if (typeof relayId !== 'string' || !relayId) return sendJson(res, 400, { error: 'relayId is required' });
				const had = revoked.delete(relayId);
				log('relay.unrevoked', { relayId, had });
				return sendJson(res, 200, { relayId, revoked: false });
			}, res);
		}
		return sendJson(res, 404, { error: 'not found' });
	}

	function describeInstall(install) {
		return {
			agent: install.agent,
			connectedAt: new Date(install.connectedAt).toISOString(),
			sessions: install.sessions.size,
			counters: { ...install.counters },
		};
	}

	function closeInstall(install, code, reason) {
		for (const session of install.sessions.values()) {
			try {
				session.bridge.send(encodeFrame(frames.sessionClose(session.sid, code, reason)));
				session.bridge.close(1000, code);
			} catch {
				// A bridge socket that is already gone needs no further closing.
			}
		}
		install.sessions.clear();
		if (installs.get(install.relayId) === install) installs.delete(install.relayId);
		try {
			install.socket.send(encodeFrame(frames.sessionClose('all', code, reason)));
			install.socket.close(4003, code);
		} catch {
			// Same: the socket may already be dead, which is the outcome we wanted.
		}
	}

	// --------------------------------------------------------------- heartbeat

	const heartbeat = setInterval(() => {
		for (const install of installs.values()) {
			if (!install.alive) {
				log('agent.timeout', { relayId: install.relayId });
				install.socket.terminate();
				continue;
			}
			install.alive = false;
			try {
				install.socket.ping();
			} catch {
				install.socket.terminate();
			}
		}
	}, LIMITS.heartbeatMs);
	heartbeat.unref?.();

	return {
		server,
		installs,
		revoked,
		stats: () => ({
			installs: installs.size,
			sessions: [...installs.values()].reduce((n, i) => n + i.sessions.size, 0),
			revoked: revoked.size,
		}),
		listen: (port, host = '0.0.0.0') => new Promise((resolve) => server.listen(port, host, () => resolve(server.address()))),
		close: async () => {
			clearInterval(heartbeat);
			for (const install of [...installs.values()]) closeInstall(install, CODE.GOING_AWAY, 'The relay is shutting down.');
			agentWss.close();
			bridgeWss.close();
			await new Promise((resolve) => server.close(resolve));
		},
	};
}

function sanitizeAgentInfo(agent) {
	if (!agent || typeof agent !== 'object') return { name: 'unknown', version: 'unknown' };
	const trim = (value, max) => (typeof value === 'string' ? value.slice(0, max) : 'unknown');
	return { name: trim(agent.name, 64), version: trim(agent.version, 32), ha: trim(agent.ha, 32) };
}

function bearer(req) {
	const header = req.headers?.authorization || '';
	return header.startsWith('Bearer ') ? header.slice(7) : '';
}

function refuseUpgrade(socket, status, text) {
	socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`);
	socket.destroy();
}

function sendJson(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
	res.end(payload);
}

function readJson(req, onBody, res) {
	const chunks = [];
	let size = 0;
	req.on('data', (chunk) => {
		size += chunk.length;
		if (size > 64 * 1024) {
			req.destroy();
			return;
		}
		chunks.push(chunk);
	});
	req.on('end', () => {
		try {
			onBody(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
		} catch {
			sendJson(res, 400, { error: 'body must be JSON' });
		}
	});
}
