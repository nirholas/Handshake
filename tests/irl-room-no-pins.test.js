// IrlRoom — structural "no pin transport" regression fence (task 07).
//
// The privacy invariant of /irl is that a placed agent's coordinates are revealed
// ONLY through the per-viewer /api/irl/pins proximity read — never broadcast over
// the realtime socket as a browseable roster. An earlier design DID sync a geocell
// window of pins into IrlState.pins and delta-broadcast it; that path is gone.
//
// tests/irl-presence-privacy.test.js proves the *behaviour* (state.pins stays empty
// after joins). This file is the *structural* lock: it fails loudly if a future
// edit reintroduces a pin-publish path — a new message handler, a write into the
// dormant pins map, a `broadcast('pin…')`, or an `_loadPins`/`applyPublish` hydrate.
// A behavioural test can be sidestepped by a path no test happens to drive; pinning
// the room's *shape* (its exact message surface + a source scan) cannot.
//
// Pure/offline: instantiates the real IrlRoom and drives onCreate with a stubbed
// Colyseus base so we observe exactly which message types it registers — no server.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, it, expect, beforeEach } from 'vitest';

import { IrlRoom } from '../multiplayer/src/rooms/IrlRoom.js';
import { IrlState } from '../multiplayer/src/irl-schemas.js';
import { encodeGeohash } from '../multiplayer/src/geohash.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOM_SRC = readFileSync(
	resolve(__dirname, '../multiplayer/src/rooms/IrlRoom.js'),
	'utf8',
);

const CELL = encodeGeohash(37.7749, -122.4194, 6);

// A fake Colyseus client.
function client(sessionId) {
	return { sessionId, userData: {} };
}

// Boot the REAL IrlRoom.onCreate against a stubbed Room base so we can observe its
// message surface and broadcasts without a running server. Returns the room plus
// the captured message-handler types and any broadcasts emitted.
async function bootRoom() {
	const room = new IrlRoom();
	const messageTypes = [];
	const broadcasts = [];
	room.setState = (s) => { room.state = s; };
	room.setPatchRate = () => {};
	room.onMessage = (type, handler) => { messageTypes.push(type); room._handlers ??= {}; room._handlers[type] = handler; };
	room.broadcast = (event, payload) => { broadcasts.push({ event, payload }); };
	room.clock = { setInterval: () => 0 };
	await room.onCreate({ geocell: CELL });
	return { room, messageTypes, broadcasts };
}

describe('IrlRoom message surface — exactly presence + reactions, never a pin channel', () => {
	let booted;
	beforeEach(async () => { booted = await bootRoom(); });

	it('registers exactly the three privacy-clean handlers — and nothing that could publish a pin', () => {
		// If a future edit adds onMessage('publish', …) / onMessage('pin', …) to re-open
		// a pin broadcast, this set changes and the test fails. The room's whole socket
		// surface is these three types plus the '*' compat fallback (room-compat.js),
		// which ignores unknown types and can never publish anything.
		expect(booted.messageTypes.slice().sort()).toEqual(['*', 'heartbeat', 'interaction', 'set_ghost']);
		// Defensive: no message type even mentions a pin/publish/window concept.
		for (const t of booted.messageTypes) {
			expect(/pin|publish|window|roster|feed/i.test(t)).toBe(false);
		}
	});

	it('the dormant pins map is never written, even after joins + a heartbeat', () => {
		booted.room.onJoin(client('s1'), { lat: 37.7749, lng: -122.4194, agent: 'a1' });
		booted.room.onJoin(client('s2'), { lat: 37.7750, lng: -122.4195, agent: 'a2' });
		booted.room._handlers.heartbeat(client('s1'), { heading: 90 });
		// Presence populated…
		expect(booted.room.state.viewers.size).toBe(2);
		// …but the pin roster stays empty: no coordinate ever entered the synced state.
		expect(booted.room.state.pins.size).toBe(0);
	});

	it('an interaction fans out only a privacy-clean reaction — never a pin payload', () => {
		booted.room._handlers.interaction(client('s1'), { type: 'open', pinId: 'pin-xyz' });
		expect(booted.broadcasts).toHaveLength(1);
		const { event, payload } = booted.broadcasts[0];
		expect(event).toBe('reaction');
		// The reaction is exactly { pinId, type, ts } — a pinId is an opaque id, never
		// a location. No lat/lng/coordinate rides this channel.
		expect(Object.keys(payload).sort()).toEqual(['pinId', 'ts', 'type']);
		expect(payload).not.toHaveProperty('lat');
		expect(payload).not.toHaveProperty('lng');
	});
});

describe('IrlRoom source — no pin-publish / hydrate path can be reintroduced unnoticed', () => {
	// A behavioural test only fails for a path some test drives. These scan the source
	// so even an un-exercised reintroduction of the roster broadcast turns the build red.

	it('never writes the dormant pins MapSchema', () => {
		// `state.pins.set(…)` / `.pins.set(` is the one way a pin enters synced state.
		// The room must never call it (pins ride the REST proximity read).
		expect(ROOM_SRC).not.toMatch(/\.pins\s*\.\s*set\s*\(/);
		expect(ROOM_SRC).not.toMatch(/state\.pins\b(?!\.size)/);
	});

	it('carries no pin-publish / hydrate symbols (applyPublish, _loadPins, pin broadcast)', () => {
		expect(ROOM_SRC).not.toMatch(/applyPublish/);
		expect(ROOM_SRC).not.toMatch(/_loadPins/);
		expect(ROOM_SRC).not.toMatch(/loadPins/);
		// No broadcast of a pin/roster/window event — the only broadcast is 'reaction'.
		expect(ROOM_SRC).not.toMatch(/broadcast\s*\(\s*['"`](?:pin|pins|roster|window)/i);
		// No message handler for a pin-publish/window channel.
		expect(ROOM_SRC).not.toMatch(/onMessage\s*\(\s*['"`](?:publish|pin|window)/i);
	});

	it('the ONLY broadcast the room emits is the ambient reaction', () => {
		const events = [...ROOM_SRC.matchAll(/broadcast\s*\(\s*['"`]([^'"`]+)['"`]/g)].map((m) => m[1]);
		expect(events).toEqual(['reaction']);
	});
});

// Belt-and-braces: the wire schema still DECLARES the dormant pins map (kept for
// binary-layout stability across deploys), but a fresh IrlState must never carry a
// populated pins map. If someone "revives" it by seeding rows in the constructor,
// this fails.
describe('IrlState — the pins map is declared dormant, born empty', () => {
	it('a fresh state has an empty pins map and an empty viewers map', () => {
		const s = new IrlState();
		expect(s.pins.size).toBe(0);
		expect(s.viewers.size).toBe(0);
	});
});
