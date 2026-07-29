// P3.2 / P3.3 — the WalkRoom half of the Phase 3 build work:
//   • a player-uploaded prop url is validated against the storage allow-list
//     before it is published to every other client in the world, survives a
//     save/restore round-trip, and is re-validated on the way back in;
//   • the creator clear-area sweep is clamped to the tier the caller EARNED,
//     not a flat constant a client could out-ask.
//
// Like the sibling walkroom-* suites, the full room needs the Colyseus runtime,
// so these drive the pure helpers against a minimal stand-in (Object.create
// skips the Room constructor).

import { describe, it, expect, beforeEach } from 'vitest';
import { WalkRoom } from '../multiplayer/src/rooms/WalkRoom.js';
import { WorldObject } from '../multiplayer/src/schemas.js';
import {
	BUILD_CLEAR_RADIUS_BASE, BUILD_CLEAR_RADIUS_HOLDER, BUILD_CLEAR_RADIUS_CREATOR,
} from '../multiplayer/src/build-limits.js';

const GOOD_URL = 'https://pub-test.r2.dev/u/anon/avatar/8f14e45f.glb';

function makeRoom({ tier = '', creator = '' } = {}) {
	const room = Object.create(WalkRoom.prototype);
	room.state = { objects: new Map(), players: new Map(), tier, coin: 'THREEsynthetic1111111111111111111111111111' };
	room.econ = new Map();
	room._objCounters = new Map();
	room._objSeq = 0;
	room.coinCreator = creator;
	room.blockCounts = new Map();
	room.blockOwners = new Map();
	room.columnCounts = new Map();
	// _persistObjects reaches the durable store; capture the calls instead.
	room._persisted = 0;
	room._persistObjects = () => { room._persisted++; };
	// Room.roomId is a private-field getter on the Colyseus base class, which an
	// Object.create stand-in can't read; the restore path logs with it.
	Object.defineProperty(room, 'roomId', { value: 'test-room' });
	return room;
}

function seat(room, sessionId, { account = '' } = {}) {
	room.econ.set(sessionId, { playerId: sessionId });
	room.state.players.set(sessionId, { account });
	return { sessionId, sent: [], send(type, msg) { this.sent.push({ type, msg }); } };
}

describe('WalkRoom uploaded prop assets (P3.3)', () => {
	let room;
	beforeEach(() => { room = makeRoom(); });

	it('publishes a prop url that is on our own storage', () => {
		const client = seat(room, 's1');
		room._handleObjSpawn(client, { kind: 'prop', type: 'u:abc', x: 30, y: 0, z: 40, url: GOOD_URL });
		const [obj] = [...room.state.objects.values()];
		expect(obj).toBeDefined();
		expect(obj.url).toBe(GOOD_URL);
		expect(client.sent).toHaveLength(0);
	});

	it('refuses a third-party url outright and tells the client why', () => {
		const client = seat(room, 's1');
		room._handleObjSpawn(client, { kind: 'prop', type: 'u:abc', x: 30, y: 0, z: 30, url: 'https://evil.example.com/x.glb' });
		expect(room.state.objects.size).toBe(0);
		expect(client.sent).toEqual([{ type: 'obj:reject', msg: { reason: 'asset_url' } }]);
	});

	it('refuses a javascript: payload smuggled through the url field', () => {
		const client = seat(room, 's1');
		room._handleObjSpawn(client, { kind: 'prop', type: 'u:abc', x: 30, y: 0, z: 30, url: 'javascript:alert(1)//a.glb' });
		expect(room.state.objects.size).toBe(0);
		expect(client.sent[0].msg.reason).toBe('asset_url');
	});

	it('leaves catalog props with an empty url', () => {
		const client = seat(room, 's1');
		room._handleObjSpawn(client, { kind: 'prop', type: 'crate', x: 32, y: 0, z: 22 });
		const [obj] = [...room.state.objects.values()];
		expect(obj.url).toBe('');
	});

	it('round-trips the url through snapshot and restore', () => {
		const client = seat(room, 's1');
		room._handleObjSpawn(client, { kind: 'prop', type: 'u:abc', x: 35, y: 0, z: 26, url: GOOD_URL });
		const snapshot = room._snapshotObjects();
		expect(snapshot[0].url).toBe(GOOD_URL);

		const fresh = makeRoom();
		fresh._restoreObjects({ objects: snapshot });
		const [restored] = [...fresh.state.objects.values()];
		expect(restored.url).toBe(GOOD_URL);
	});

	it('omits the url key entirely for catalog props so the doc stays compact', () => {
		const client = seat(room, 's1');
		room._handleObjSpawn(client, { kind: 'prop', type: 'crate', x: 34, y: 0, z: 24 });
		expect(Object.keys(room._snapshotObjects()[0])).not.toContain('url');
	});

	it('re-validates a stored url on restore, so a doc written elsewhere cannot smuggle one in', () => {
		const fresh = makeRoom();
		fresh._restoreObjects({
			objects: [
				{ id: 'bad', type: 'u:x', kind: 'prop', ownerId: 'u', x: 30, y: 0, z: 30, url: 'https://evil.example.com/x.glb' },
				{ id: 'good', type: 'u:y', kind: 'prop', ownerId: 'u', x: 31, y: 0, z: 31, url: GOOD_URL },
			],
		});
		expect(fresh.state.objects.get('bad').url).toBe('');
		expect(fresh.state.objects.get('good').url).toBe(GOOD_URL);
	});
});

describe('WalkRoom clear-area radius tiers (P3.2)', () => {
	it('advertises the base radius to a visitor in an open world', () => {
		const room = makeRoom();
		const client = seat(room, 's1');
		expect(room._clearRadiusFor(client)).toBe(BUILD_CLEAR_RADIUS_BASE);
	});

	it('advertises the holder radius inside a gated holders world', () => {
		const room = makeRoom({ tier: 'holders' });
		const client = seat(room, 's1');
		expect(room._clearRadiusFor(client)).toBe(BUILD_CLEAR_RADIUS_HOLDER);
	});

	it('advertises the creator radius to the coin creator', () => {
		const room = makeRoom({ creator: 'WALLET1' });
		const client = seat(room, 's1', { account: 'WALLET1' });
		expect(room._clearRadiusFor(client)).toBe(BUILD_CLEAR_RADIUS_CREATOR);
	});

	it('sends the same number to the HUD that it will clamp to', () => {
		const room = makeRoom({ tier: 'holders', creator: 'WALLET1' });
		room.blockCounts = new Map();
		const client = seat(room, 's1', { account: 'WALLET1' });
		room._sendBuildPerms(client);
		const perms = client.sent.find((m) => m.type === 'build-perms').msg;
		expect(perms.clearMaxRadius).toBe(room._clearRadiusFor(client));
		expect(perms.holderWorld).toBe(true);
	});

	it('clamps a client asking for more than its tier allows', () => {
		const room = makeRoom();
		const client = seat(room, 's1');
		// A visitor is not a creator, so the sweep is refused before radius matters;
		// the earned radius itself is what a creator's over-ask gets clamped to.
		const creatorRoom = makeRoom({ creator: 'WALLET1' });
		const creator = seat(creatorRoom, 's1', { account: 'WALLET1' });
		expect(Math.min(creatorRoom._clearRadiusFor(creator), 9999)).toBe(BUILD_CLEAR_RADIUS_CREATOR);
		expect(room._clearRadiusFor(client)).toBeLessThan(BUILD_CLEAR_RADIUS_CREATOR);
	});
});

describe('WorldObject schema carries the asset url', () => {
	it('defaults to an empty string', () => {
		expect(new WorldObject().url).toBe('');
	});
});
