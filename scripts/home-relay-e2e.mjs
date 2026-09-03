#!/usr/bin/env node
/**
 * Prove the dial-out relay against a Home Assistant this process cannot route to.
 *
 * The whole point of the relay is reaching a house on a LAN, so a test that
 * talks to Home Assistant on localhost proves nothing. This script therefore
 * begins by FAILING to reach the instance directly, from the same process that
 * then drives it through the relay, and refuses to continue if that first
 * attempt succeeds.
 *
 * How the unroutable network is built (docs/home-relay.md has the full recipe):
 *
 *   docker network create house-net      # the house's LAN
 *   docker network create cloud-net      # where three.ws runs
 *   docker run --network house-net --add-host relay.host:host-gateway \
 *          --name threews-ha-relay ...ghcr.io/home-assistant/home-assistant:stable
 *   # note: no -p, so nothing is published
 *
 * Docker isolates user-defined bridges from each other, so a container on
 * cloud-net has no route to a container on house-net. The relay runs on the
 * host, which both networks reach through host-gateway, exactly as a real house
 * reaches a public service through its own NAT.
 *
 * Run it from inside cloud-net:
 *
 *   docker run --rm --network cloud-net --add-host relay.host:host-gateway \
 *     -v /workspaces/three.ws:/app -w /app node:24-slim \
 *     node scripts/home-relay-e2e.mjs \
 *       --relay ws://relay.host:8899 --relay-id <id> --service-token <token> \
 *       --unroutable http://172.20.0.2:8123
 */

import { HomeBridge, createRelayTransport, ERR } from '../packages/home-bridge/src/index.js';

const args = parseArgs(process.argv.slice(2));
const need = (name) => {
	const value = args[name];
	if (!value) {
		console.error(`Missing --${name}. See the header of this file for the full command.`);
		process.exit(2);
	}
	return value;
};

const relayUrl = need('relay');
const relayId = need('relay-id');
const serviceToken = need('service-token');
const unroutable = args.unroutable;

const results = [];
let failures = 0;

function step(name, ok, detail) {
	results.push({ name, ok, detail });
	if (!ok) failures += 1;
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`);
}

// 1. The premise. If this process CAN reach the house, nothing below means
//    anything, so the script stops rather than reporting a false success.
if (unroutable) {
	const started = Date.now();
	let reachable = false;
	try {
		await fetch(unroutable, { signal: AbortSignal.timeout(6000) });
		reachable = true;
	} catch {
		reachable = false;
	}
	step(
		'the house is genuinely unreachable from here',
		!reachable,
		reachable
			? `${unroutable} answered this process directly, so this run proves nothing about the relay. Re-run from a network with no route to the house.`
			: `direct fetch of ${unroutable} failed after ${Date.now() - started} ms, as it must`,
	);
	if (reachable) process.exit(1);
}

// 2. The same house, through the relay. Note what is NOT passed: no baseUrl and
//    no Home Assistant token, because three.ws holds neither for a relayed home.
const transport = createRelayTransport({ relayUrl, relayId, serviceToken });
const bridge = new HomeBridge({ transport, allowedEntities: [] });

const connectStarted = Date.now();
const graph = await bridge.connect();
step(
	'connected through the relay',
	bridge.connected,
	`${Date.now() - connectStarted} ms, transport=${bridge.transport}, rooms=${graph.rooms.length}, floors=${graph.floors.length}, entities=${Object.keys(bridge.states).length}`,
);

// 3. A real light, really toggled.
const light = pick(bridge.states, 'light.');
if (!light) {
	step('a light exists to drive', false, 'no light.* entity in this instance');
} else {
	const before = bridge.states[light].state;
	await bridge.call('light', before === 'on' ? 'turn_off' : 'turn_on', { entity_id: light });
	const after = await settle(() => bridge.states[light].state, before);
	step('toggled a real light through the relay', after !== before, `${light}: ${before} -> ${after}`);
}

// 4. The physical-action gate, unchanged, over the new transport. An unlock is
//    refused without a human's yes and performed with one, exactly as it is on a
//    direct connection: the transport is not allowed to weaken this.
const lock = pick(bridge.states, 'lock.');
if (!lock) {
	step('a lock exists to gate', false, 'no lock.* entity in this instance');
} else {
	await bridge.call('lock', 'lock', { entity_id: lock }).catch(() => null);
	await settle(() => bridge.states[lock].state, 'unlocked');

	let refused = null;
	try {
		await bridge.call('lock', 'unlock', { entity_id: lock });
	} catch (err) {
		refused = err;
	}
	step(
		'an unconfirmed unlock is refused over the relay',
		refused?.code === ERR.NEEDS_CONFIRMATION,
		refused ? `${refused.code}: ${refused.message}` : 'the call was NOT refused, which is a security regression',
	);

	const lockedBefore = bridge.states[lock].state;
	await bridge.call('lock', 'unlock', { entity_id: lock }, { confirmed: true });
	const unlocked = await settle(() => bridge.states[lock].state, lockedBefore);
	step('a confirmed unlock really unlocks the door', unlocked === 'unlocked', `${lock}: ${lockedBefore} -> ${unlocked}`);
	await bridge.call('lock', 'lock', { entity_id: lock }, { confirmed: true }).catch(() => null);
}

// 5. The allowlist, tested the way it would actually be attacked: not through
//    the client library, which would never build these messages, but by a caller
//    holding the relay's own credential and sending whatever it likes.
for (const [label, msg] of [
	['a message type outside the allowlist', { id: 9001, type: 'get_services' }],
	['a subscription to every event in the house', { id: 9002, type: 'subscribe_events' }],
	['a service call that would run code on the house', { id: 9003, type: 'call_service', domain: 'shell_command', service: 'anything' }],
	['a service call that would restart the house', { id: 9004, type: 'call_service', domain: 'homeassistant', service: 'restart' }],
]) {
	const refusal = await rawRelayCall(msg);
	step(
		`the relay refuses ${label}`,
		refusal?.error?.code === 'not_allowed',
		refusal?.error ? `${refusal.error.code}: ${refusal.error.message}` : `NOT refused: ${JSON.stringify(refusal)}`,
	);
}

// And one that IS allowed, through the same raw path, so the refusals above are
// the allowlist working rather than the channel being broken.
const permitted = await rawRelayCall({ id: 9005, type: 'get_config' });
step(
	'the same raw channel still carries an allowlisted message',
	permitted?.success === true,
	`get_config -> ${permitted?.success ? `location_name=${permitted.result?.location_name}` : JSON.stringify(permitted)}`,
);

bridge.close();
console.log(`\n${results.length - failures}/${results.length} checks passed.`);
process.exit(failures ? 1 : 0);

// ---------------------------------------------------------------- small parts

function parseArgs(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i += 1) {
		if (!argv[i].startsWith('--')) continue;
		const key = argv[i].slice(2);
		const next = argv[i + 1];
		if (next && !next.startsWith('--')) {
			out[key] = next;
			i += 1;
		} else {
			out[key] = true;
		}
	}
	return out;
}

function pick(states, prefix) {
	return Object.keys(states)
		.filter((id) => id.startsWith(prefix) && states[id].state !== 'unavailable')
		.sort()[0];
}

/** Waits for the live state channel to report a change, not for a fixed delay. */
async function settle(read, was, timeoutMs = 8000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const now = read();
		if (now !== was) return now;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return read();
}

/**
 * Opens its own relay session, holding the platform's credential, and sends one
 * arbitrary Home Assistant message. This is the threat the allowlist exists for:
 * not the client library, which would never build these, but a caller inside
 * three.ws that has the relay token and does whatever it likes with it.
 *
 * @returns {Promise<object|null>} the Home Assistant shaped result, refused or not
 */
async function rawRelayCall(msg) {
	const { WebSocket } = await import('ws');
	const url = new URL(relayUrl);
	url.protocol = url.protocol === 'https:' ? 'wss:' : url.protocol === 'http:' ? 'ws:' : url.protocol;
	url.pathname = '/v1/bridge';
	url.searchParams.set('relay_id', relayId);
	const socket = new WebSocket(url.href, { headers: { authorization: `Bearer ${serviceToken}` } });

	return new Promise((resolve) => {
		const timer = setTimeout(() => finish(null), 10_000);
		const finish = (value) => {
			clearTimeout(timer);
			try {
				socket.close();
			} catch {
				// Already gone.
			}
			resolve(value);
		};
		socket.on('message', (raw) => {
			let frame;
			try {
				frame = JSON.parse(String(raw));
			} catch {
				return;
			}
			if (frame.t === 'session.ready') {
				socket.send(JSON.stringify({ v: 1, t: 'ha', sid: frame.sid, msg }));
				return;
			}
			if (frame.t === 'ha' && frame.msg?.id === msg.id) finish(frame.msg);
			if (frame.t === 'session.close') finish({ error: { code: frame.code, message: frame.reason } });
		});
		socket.on('error', (err) => finish({ error: { code: 'socket', message: err?.message } }));
	});
}
