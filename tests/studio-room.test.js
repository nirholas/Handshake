// StudioRoom server-authoritative invariants (multiplayer/src/rooms/StudioRoom.js).
//
// The full room needs the Colyseus runtime, so — mirroring walkroom-worldobjects
// — these drive the message handlers directly against a minimal stand-in
// (Object.create avoids the Room constructor). They lock what a malicious or
// buggy client must NOT be able to do over the shared-scene socket: spawn an
// unvetted (non-https) GLB url, move/remove a model it doesn't own, exceed the
// per-room or per-owner caps, flood past the rate limit, or slip a NaN/out-of-
// bounds transform through.

import { beforeEach, describe, expect, it } from 'vitest';
import { StudioRoom } from '../multiplayer/src/rooms/StudioRoom.js';

function makeRoom() {
	const room = Object.create(StudioRoom.prototype);
	room.roomKey = 'c-ABCDEF';
	room._modelSeq = 0;
	room._opLedger = new Map();
	const models = new Map();
	const viewers = new Map();
	room.state = { models, viewers, roomKey: room.roomKey };
	// The reject channel: record what the server tells a client.
	room._rejects = [];
	return room;
}

// A fake client whose send() records reject reasons.
function makeClient(room, { sessionId = 's_alice', ownerId = 'alice' } = {}) {
	return {
		sessionId,
		userData: { ownerId },
		send: (type, payload) => room._rejects.push({ type, payload, sessionId }),
	};
}

// Register a viewer so spawn's "must be in the room" gate passes.
function join(room, client) {
	room.state.viewers.set(client.sessionId, { id: client.sessionId, ownerId: client.userData.ownerId, tsServer: Date.now() });
}

const HTTPS = 'https://cdn.three.ws/model.glb';

describe('StudioRoom — model:spawn', () => {
	let room, alice;
	beforeEach(() => { room = makeRoom(); alice = makeClient(room); join(room, alice); });

	it('accepts a valid https GLB and assigns a server-controlled id + owner', () => {
		room._handleSpawn(alice, { src: HTTPS, relEast: 1, relNorth: 2, yawDeg: 90, scale: 1.5, title: 'crate' });
		expect(room.state.models.size).toBe(1);
		const m = [...room.state.models.values()][0];
		expect(m.src).toBe(HTTPS);
		expect(m.ownerId).toBe('alice'); // stable owner key, not sessionId
		expect(m.relEast).toBe(1);
		expect(m.scale).toBe(1.5);
	});

	it('accepts a site-relative GLB path', () => {
		room._handleSpawn(alice, { src: '/avatars/default.glb', relEast: 0, relNorth: 0 });
		expect(room.state.models.size).toBe(1);
	});

	it('never re-broadcasts an unvetted url (http/data/js/protocol-relative)', () => {
		for (const bad of ['http://x.co/a.glb', 'data:model/gltf-binary;base64,AAAA', 'javascript:alert(1)', '//x.co/a.glb', 'ftp://x/a.glb']) {
			room._handleSpawn(alice, { src: bad, relEast: 0, relNorth: 0 });
		}
		expect(room.state.models.size).toBe(0);
	});

	it('drops a spawn with a non-finite position (a NaN slips past clamps)', () => {
		room._handleSpawn(alice, { src: HTTPS, relEast: NaN, relNorth: 0 });
		room._handleSpawn(alice, { src: HTTPS, relEast: 0, relNorth: undefined });
		expect(room.state.models.size).toBe(0);
	});

	it('clamps position to bounds and scale to [0.25, 4]', () => {
		room._handleSpawn(alice, { src: HTTPS, relEast: 999, relNorth: -999, scale: 50 });
		const m = [...room.state.models.values()][0];
		expect(m.relEast).toBe(60);
		expect(m.relNorth).toBe(-60);
		expect(m.scale).toBe(4);
	});

	it('ignores a spawn from a client that has not joined', () => {
		const ghost = makeClient(room, { sessionId: 's_ghost', ownerId: 'ghost' });
		room._handleSpawn(ghost, { src: HTTPS, relEast: 0, relNorth: 0 });
		expect(room.state.models.size).toBe(0);
	});

	it('rejects when the owner is at their per-owner cap', () => {
		for (let i = 0; i < 24; i++) room._handleSpawn(alice, { src: HTTPS, relEast: 0, relNorth: 0 });
		expect(room.state.models.size).toBe(24);
		room._handleSpawn(alice, { src: HTTPS, relEast: 0, relNorth: 0 });
		expect(room.state.models.size).toBe(24);
		expect(room._rejects.some((r) => r.payload?.reason === 'owner_full')).toBe(true);
	});
});

describe('StudioRoom — ownership gating', () => {
	let room, alice, bob;
	beforeEach(() => {
		room = makeRoom();
		alice = makeClient(room, { sessionId: 's_a', ownerId: 'alice' });
		bob = makeClient(room, { sessionId: 's_b', ownerId: 'bob' });
		join(room, alice); join(room, bob);
		room._handleSpawn(alice, { src: HTTPS, relEast: 0, relNorth: 0, id: 'M1' });
	});

	it('lets the owner move their model', () => {
		room._handleUpdate(alice, { id: 'M1', relEast: 5 });
		expect(room.state.models.get('M1').relEast).toBe(5);
	});

	it('refuses a non-owner move', () => {
		room._handleUpdate(bob, { id: 'M1', relEast: 5 });
		expect(room.state.models.get('M1').relEast).toBe(0);
	});

	it('refuses a non-owner remove, allows the owner', () => {
		room._handleRemove(bob, { id: 'M1' });
		expect(room.state.models.has('M1')).toBe(true);
		room._handleRemove(alice, { id: 'M1' });
		expect(room.state.models.has('M1')).toBe(false);
	});
});

describe('StudioRoom — rate limiting', () => {
	it('allows 25 ops per session per second, then drops', () => {
		const room = makeRoom();
		let ok = 0;
		for (let i = 0; i < 40; i++) if (room._opOk('s_a')) ok++;
		expect(ok).toBe(25);
	});

	it('gives each session its own independent budget', () => {
		const room = makeRoom();
		for (let i = 0; i < 25; i++) room._opOk('s_a'); // exhaust alice
		expect(room._opOk('s_a')).toBe(false);
		expect(room._opOk('s_b')).toBe(true); // bob unaffected
	});

	it('blocks a flooding spawn past the budget without touching state', () => {
		const room = makeRoom();
		const alice = makeClient(room);
		join(room, alice);
		for (let i = 0; i < 25; i++) room._opOk(alice.sessionId); // spend the budget
		room._handleSpawn(alice, { src: HTTPS, relEast: 0, relNorth: 0 });
		expect(room.state.models.size).toBe(0); // rate-limited before any write
	});
});
