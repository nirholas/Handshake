// R08 — Tag mini-game: server-authoritative "it" assignment, proximity-gated
// transfer, and tag-back immunity. The full WalkRoom needs the Colyseus runtime,
// so these tests drive the pure tag helpers against a minimal stand-in
// (Object.create avoids the Room constructor). They lock the invariants a
// malicious client must not be able to break: exactly one "it", no across-map
// tag, and no instant tag-back inside the immunity window.

import { describe, it, expect, beforeEach } from 'vitest';
import { WalkRoom } from '../multiplayer/src/rooms/WalkRoom.js';

// A Player-like record carrying only the fields the tag helpers read/write.
function player(name, x, z) {
	return { name, x, y: 0, z, it: false, itSince: 0 };
}

// Build a WalkRoom instance without the Colyseus constructor, wiring only the
// state + broadcast surface the tag helpers touch. `broadcasts` captures room
// broadcasts and `sent` captures per-client sends (recorded on each fake
// client's own send), so tests can assert what peers and individuals receive.
function makeRoom() {
	const room = Object.create(WalkRoom.prototype);
	room.state = { players: new Map() };
	room._tagImmunity = new Map();
	room._tagTime = new Map();
	room.clients = [];
	room.broadcasts = [];
	room.sent = [];
	room.broadcast = (type, msg) => room.broadcasts.push({ type, msg });
	return room;
}

// Seat a player and register their tag time tracker, mirroring onJoin.
function seat(room, id, name, x, z) {
	room.state.players.set(id, player(name, x, z));
	room._tagTime.set(id, { timeMs: 0, becameIt: null });
	// A targeted message goes out as client.send(type, msg): Colyseus deprecated
	// room.send(client, ...), so the recorder belongs on the client, not the room.
	const client = { sessionId: id };
	client.send = (type, msg) => room.sent.push({ client, type, msg });
	room.clients.push(client);
}

function itCount(room) {
	let n = 0;
	for (const [, p] of room.state.players) if (p.it) n++;
	return n;
}

describe('WalkRoom tag mini-game (R08)', () => {
	let room;
	beforeEach(() => { room = makeRoom(); });

	it('assigns exactly one "it" and alerts only that client', () => {
		seat(room, 'a', 'Alice', 0, 0);
		seat(room, 'b', 'Bob', 10, 10);
		room._assignIt('a');

		expect(itCount(room)).toBe(1);
		expect(room.state.players.get('a').it).toBe(true);
		expect(room.state.players.get('a').itSince).toBeGreaterThan(0);
		expect(room._itPlayer()).toBe('a');
		// The became-it alert goes only to the newly tagged client.
		const becameIt = room.sent.filter(s => s.msg?.event === 'became-it');
		expect(becameIt).toHaveLength(1);
		expect(becameIt[0].client.sessionId).toBe('a');
		// A full state broadcast follows so every client refreshes the HUD.
		expect(room.broadcasts.some(b => b.msg?.event === 'state' && b.msg.itId === 'a')).toBe(true);
	});

	it('transfers "it" only to a player within range', () => {
		seat(room, 'a', 'Alice', 0, 0);
		seat(room, 'b', 'Bob', 1.0, 0);   // 1.0m away — inside TAG_RANGE_M (2.0)
		seat(room, 'c', 'Cara', 50, 50);  // far away — must never be tagged
		room._assignIt('a');

		room._checkTag('a', room.state.players.get('a'));

		expect(room.state.players.get('b').it).toBe(true);
		expect(room.state.players.get('a').it).toBe(false);
		expect(room.state.players.get('c').it).toBe(false);
		expect(itCount(room)).toBe(1); // never double-it
	});

	it('does not tag across the map (server proximity is authoritative)', () => {
		seat(room, 'a', 'Alice', 0, 0);
		seat(room, 'b', 'Bob', 5, 0);   // 5m away — out of range
		room._assignIt('a');

		room._checkTag('a', room.state.players.get('a'));

		expect(room.state.players.get('a').it).toBe(true);  // still it
		expect(room.state.players.get('b').it).toBe(false);
	});

	it('applies tag-back immunity so "it" cannot bounce instantly', () => {
		seat(room, 'a', 'Alice', 0, 0);
		seat(room, 'b', 'Bob', 1.0, 0);
		room._assignIt('a');

		// a tags b — a is now immune for TAG_IMMUNITY_MS.
		room._checkTag('a', room.state.players.get('a'));
		expect(room.state.players.get('b').it).toBe(true);

		// b immediately tries to tag a back while a is still adjacent — blocked.
		room._checkTag('b', room.state.players.get('b'));
		expect(room.state.players.get('b').it).toBe(true);  // b keeps it
		expect(room.state.players.get('a').it).toBe(false);

		// Once a's immunity has lapsed, a tag-back is allowed again.
		room._tagImmunity.set('a', Date.now() - 1);
		room._checkTag('b', room.state.players.get('b'));
		expect(room.state.players.get('a').it).toBe(true);
		expect(itCount(room)).toBe(1);
	});

	it('accumulates per-session time-as-it across stints', () => {
		seat(room, 'a', 'Alice', 0, 0);
		seat(room, 'b', 'Bob', 1.0, 0);
		room._assignIt('a');

		// Simulate a having been "it" for 1.2s, then a tags b (finalizes a's stint).
		const ta = room._tagTime.get('a');
		ta.becameIt = Date.now() - 1200;
		room._checkTag('a', room.state.players.get('a'));

		expect(room._tagTime.get('a').timeMs).toBeGreaterThanOrEqual(1200);
		expect(room._tagTime.get('a').becameIt).toBeNull(); // stint closed
		// b's stint is now open.
		expect(room._tagTime.get('b').becameIt).not.toBeNull();
	});

	it('orders the leaderboard by total time and caps it at 8 rows', () => {
		for (let i = 0; i < 10; i++) seat(room, `p${i}`, `P${i}`, i * 100, 0);
		// Give each player a distinct accumulated time, ascending with index.
		for (let i = 0; i < 10; i++) room._tagTime.get(`p${i}`).timeMs = (i + 1) * 1000;
		room._broadcastTagState();

		const state = room.broadcasts.find(b => b.msg?.event === 'state');
		expect(state.msg.leaderboard).toHaveLength(8); // top 8 only
		// Descending by time: p9 (10000ms) first.
		expect(state.msg.leaderboard[0].id).toBe('p9');
		const times = state.msg.leaderboard.map(r => r.timeMs);
		expect(times).toEqual([...times].sort((a, b) => b - a));
	});

	it('_randomTagPlayer never returns the excluded id', () => {
		seat(room, 'a', 'Alice', 0, 0);
		seat(room, 'b', 'Bob', 1, 0);
		seat(room, 'c', 'Cara', 2, 0);
		for (let i = 0; i < 50; i++) {
			expect(room._randomTagPlayer('a')).not.toBe('a');
		}
	});
});
