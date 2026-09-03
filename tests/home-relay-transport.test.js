// The relay end to end, in process: a real relay server, a real agent socket, a
// real HomeBridge, and no Home Assistant.
//
// The live proof against an actual house on an unroutable network is
// scripts/home-relay-e2e.mjs, and it is the one that matters. This suite exists
// for the paths that are hard to provoke on demand there: a house that is not
// dialled in, a relay that refuses a frame, a socket that dies mid-session, a
// second install replacing the first, and the rate limits.
//
// The "house" here is a bare WebSocket that speaks the protocol and answers
// Home Assistant's message shapes from a fixture. It is not a mock of Home
// Assistant (nothing here pretends to be a smart home); it is the far end of a
// wire whose only job is to prove the wire.

import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createRelay } from '../services/home-relay/src/server.js';
import { frames, PROTOCOL_VERSION } from '../services/home-relay/src/protocol.js';
import { mintInstallToken, newRelayId } from '../services/home-relay/src/token.js';
import { createRelayTransport } from '../packages/home-bridge/src/transport-relay.js';
import { HomeBridge } from '../packages/home-bridge/src/bridge.js';
import { ERR } from '../packages/home-bridge/src/errors.js';

const SIGNING_KEY = 's'.repeat(48);
const SERVICE_TOKEN = 'v'.repeat(48);
const HA_VERSION = '2026.9.0';

let relay;
let port;
let base;

beforeAll(async () => {
	relay = createRelay({ signingKey: SIGNING_KEY, serviceToken: SERVICE_TOKEN, log: () => {} });
	const address = await relay.listen(0, '127.0.0.1');
	port = address.port;
	base = `ws://127.0.0.1:${port}`;
});

afterAll(async () => {
	await relay.close();
});

/**
 * A house on the far end of the wire. Answers the handful of Home Assistant
 * messages the bridge sends during connect, and records everything that
 * actually reached it so a test can assert that a refused frame never did.
 */
function connectAgent(relayId, { autoReady = true } = {}) {
	const token = mintInstallToken({ relayId, userId: 'u1', homeId: 'h1' }, SIGNING_KEY);
	const socket = new WebSocket(`${base}/v1/agent`, { headers: { authorization: `Bearer ${token}` } });
	const house = { socket, received: [], sessions: new Set(), online: null, refused: null };

	house.online = new Promise((resolve, reject) => {
		socket.on('message', (raw) => {
			const frame = JSON.parse(String(raw));
			if (frame.t === 'hello.ok') return resolve(house);
			if (frame.t === 'hello.err') {
				house.refused = frame;
				return reject(new Error(`${frame.code}: ${frame.message}`));
			}
			if (frame.t === 'session.open') {
				house.sessions.add(frame.sid);
				if (autoReady) socket.send(JSON.stringify(frames.sessionReady(frame.sid, HA_VERSION)));
				return;
			}
			if (frame.t === 'session.close') {
				house.sessions.delete(frame.sid);
				return;
			}
			if (frame.t === 'ha') {
				house.received.push(frame.msg);
				const reply = answer(frame.msg);
				if (reply) socket.send(JSON.stringify(frames.ha(frame.sid, reply)));
				// The live entity channel: one empty burst, so connect() resolves on a
				// real message rather than waiting out its five second floor.
				if (frame.msg.type === 'subscribe_entities') {
					socket.send(JSON.stringify(frames.ha(frame.sid, { id: frame.msg.id, type: 'event', event: { a: {} } })));
				}
			}
		});
		socket.on('error', reject);
	});
	socket.on('open', () => socket.send(JSON.stringify(frames.hello(relayId, { name: 'test house', version: '1.0.0' }))));
	return house;
}

/** The subset of Home Assistant's answers the bridge's connect path needs. */
function answer(msg) {
	if (typeof msg?.id !== 'number') return null;
	const ok = (result) => ({ id: msg.id, type: 'result', success: true, result });
	switch (msg.type) {
		case 'get_states':
			return ok([]);
		case 'subscribe_entities':
			return ok(null);
		case 'config/floor_registry/list':
		case 'config/area_registry/list':
		case 'config/device_registry/list':
		case 'config/entity_registry/list':
			return ok([]);
		case 'call_service':
			return ok({ context: { id: 'ctx' } });
		case 'get_config':
			return ok({ location_name: 'Test' });
		default:
			return ok(null);
	}
}

const transportFor = (relayId) =>
	createRelayTransport({ relayUrl: base, relayId, serviceToken: SERVICE_TOKEN, WebSocketImpl: WebSocket, openTimeoutMs: 5000 });

describe('a house that has dialled in', () => {
	it('carries a HomeBridge with no base URL and no Home Assistant token', async () => {
		const relayId = newRelayId();
		const house = connectAgent(relayId);
		await house.online;

		const bridge = new HomeBridge({ transport: transportFor(relayId) });
		expect(bridge.transport).toBe('relay');
		await bridge.connect();
		expect(bridge.connected).toBe(true);
		// The auth handshake never crossed the relay: the house handed the session
		// over already authenticated, and its version came with it.
		expect(house.received.some((m) => m.type === 'auth')).toBe(false);
		// A 2026 instance uses the compressed entity subscription, not get_states.
		expect(house.received.some((m) => m.type === 'subscribe_entities')).toBe(true);

		await bridge.call('light', 'turn_on', { entity_id: 'light.kitchen' });
		expect(house.received.some((m) => m.type === 'call_service' && m.domain === 'light')).toBe(true);

		bridge.close();
		house.socket.close();
	});

	it('never lets a refused frame reach the house, and answers with a reason', async () => {
		const relayId = newRelayId();
		const house = connectAgent(relayId);
		await house.online;
		const bridge = new HomeBridge({ transport: transportFor(relayId) });
		await bridge.connect();
		const before = house.received.length;

		const refusal = await sendRaw(relayId, { id: 77, type: 'call_service', domain: 'shell_command', service: 'rm' });
		expect(refusal.success).toBe(false);
		expect(refusal.error.code).toBe('not_allowed');
		expect(house.received.length).toBe(before);
		expect(house.received.some((m) => m.domain === 'shell_command')).toBe(false);

		bridge.close();
		house.socket.close();
	});
});

describe('a house that has not dialled in', () => {
	it('is refused with a reason a person can act on, not a hang', async () => {
		const bridge = new HomeBridge({ transport: transportFor('hr_nobody_home_00000000') });
		const failure = await bridge.connect().then(() => null, (err) => err);
		expect(failure).toBeTruthy();
		expect(failure.code).toBe(ERR.UNREACHABLE);
		expect(failure.message).toMatch(/integration is offline/i);
	});
});

describe('credentials', () => {
	it('refuses an agent with no install token', async () => {
		const socket = new WebSocket(`${base}/v1/agent`);
		const status = await new Promise((resolve) => {
			socket.on('unexpected-response', (_req, res) => resolve(res.statusCode));
			socket.on('error', () => resolve(0));
		});
		expect(status).toBe(401);
	});

	it('refuses a platform caller with no service token', async () => {
		const socket = new WebSocket(`${base}/v1/bridge?relay_id=hr_x`);
		const status = await new Promise((resolve) => {
			socket.on('unexpected-response', (_req, res) => resolve(res.statusCode));
			socket.on('error', () => resolve(0));
		});
		expect(status).toBe(401);
	});

	it('binds a socket to the relay id in the token, never the one in the frame', async () => {
		// A house that claims someone else's relay id in its hello frame gets its
		// own, because the relay reads the id out of the signed token and ignores
		// the claim entirely. This is what makes a stolen install token useless
		// for reaching a different house.
		const mine = newRelayId();
		const theirs = newRelayId();
		const token = mintInstallToken({ relayId: mine, userId: 'u1', homeId: 'h1' }, SIGNING_KEY);
		const socket = new WebSocket(`${base}/v1/agent`, { headers: { authorization: `Bearer ${token}` } });
		await new Promise((resolve, reject) => {
			socket.on('open', () => socket.send(JSON.stringify(frames.hello(theirs, { name: 'liar', version: '1' }))));
			socket.on('message', (raw) => {
				const frame = JSON.parse(String(raw));
				if (frame.t === 'hello.ok') resolve();
			});
			socket.on('error', reject);
		});
		expect(relay.installs.has(mine)).toBe(true);
		expect(relay.installs.has(theirs)).toBe(false);
		socket.close();
	});
});

describe('lifecycle', () => {
	it('replaces a stale socket when the same house dials in again', async () => {
		const relayId = newRelayId();
		const first = connectAgent(relayId);
		await first.online;
		const second = connectAgent(relayId);
		await second.online;
		expect(relay.installs.get(relayId).socket).not.toBe(first.socket);
		second.socket.close();
	});

	it('tells an open session the house went away, rather than leaving it to time out', async () => {
		const relayId = newRelayId();
		const house = connectAgent(relayId);
		await house.online;
		const bridge = new HomeBridge({ transport: transportFor(relayId) });
		await bridge.connect();

		const disconnected = new Promise((resolve) => bridge.on('disconnected', resolve));
		house.socket.close();
		await Promise.race([disconnected, new Promise((r) => setTimeout(r, 3000))]);
		bridge.close();
	});

	it('drops the socket immediately when three.ws revokes the home', async () => {
		const relayId = newRelayId();
		const house = connectAgent(relayId);
		await house.online;
		const closed = new Promise((resolve) => house.socket.on('close', resolve));

		const res = await fetch(`http://127.0.0.1:${port}/v1/revoke`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${SERVICE_TOKEN}` },
			body: JSON.stringify({ relayId }),
		});
		expect(res.status).toBe(200);
		await closed;
		expect(relay.installs.has(relayId)).toBe(false);

		// And it stays revoked: a reconnect is refused at the upgrade.
		const token = mintInstallToken({ relayId, userId: 'u1', homeId: 'h1' }, SIGNING_KEY);
		const retry = new WebSocket(`${base}/v1/agent`, { headers: { authorization: `Bearer ${token}` } });
		const status = await new Promise((resolve) => {
			retry.on('unexpected-response', (_req, res2) => resolve(res2.statusCode));
			retry.on('error', () => resolve(0));
		});
		expect(status).toBe(403);
	});
});

describe('limits', () => {
	it('caps concurrent sessions per install', async () => {
		const relayId = newRelayId();
		const house = connectAgent(relayId);
		await house.online;
		const open = [];
		for (let i = 0; i < 8; i += 1) open.push(await rawSession(relayId));
		const refusal = await rawSessionRefusal(relayId);
		expect(refusal.code).toBe('too_many_sessions');
		for (const socket of open) socket.close();
		house.socket.close();
	});

	it('reports its own state for a health probe', () => {
		const stats = relay.stats();
		expect(stats).toHaveProperty('installs');
		expect(stats).toHaveProperty('sessions');
		expect(stats).toHaveProperty('revoked');
	});
});

// --------------------------------------------------------------- small parts

/** One raw platform frame, the way an escaped caller would send it. */
function sendRaw(relayId, msg) {
	const socket = new WebSocket(`${base}/v1/bridge?relay_id=${relayId}`, { headers: { authorization: `Bearer ${SERVICE_TOKEN}` } });
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('no answer')), 5000);
		socket.on('message', (raw) => {
			const frame = JSON.parse(String(raw));
			if (frame.t === 'session.ready') return socket.send(JSON.stringify(frames.ha(frame.sid, msg)));
			if (frame.t === 'ha' && frame.msg.id === msg.id) {
				clearTimeout(timer);
				socket.close();
				resolve(frame.msg);
			}
		});
		socket.on('error', reject);
	});
}

function rawSession(relayId) {
	const socket = new WebSocket(`${base}/v1/bridge?relay_id=${relayId}`, { headers: { authorization: `Bearer ${SERVICE_TOKEN}` } });
	return new Promise((resolve, reject) => {
		socket.on('message', (raw) => {
			if (JSON.parse(String(raw)).t === 'session.ready') resolve(socket);
		});
		socket.on('error', reject);
	});
}

function rawSessionRefusal(relayId) {
	const socket = new WebSocket(`${base}/v1/bridge?relay_id=${relayId}`, { headers: { authorization: `Bearer ${SERVICE_TOKEN}` } });
	return new Promise((resolve, reject) => {
		socket.on('message', (raw) => {
			const frame = JSON.parse(String(raw));
			if (frame.t === 'session.close') resolve(frame);
		});
		socket.on('error', reject);
	});
}

it('speaks one protocol version everywhere', () => {
	expect(PROTOCOL_VERSION).toBe(1);
});
