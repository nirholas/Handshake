// R19 — build netcode hardening: ownership, per-player + density caps, protected
// zones, and creator moderation. The full WalkRoom needs the Colyseus runtime, so
// these tests drive the pure permission helpers directly against a minimal stand-in
// (Object.create avoids the Room constructor). They lock the server-authoritative
// invariants a malicious client must not be able to break.

import { describe, it, expect, beforeEach } from 'vitest';
import { WalkRoom, BLOCK_SIZE_M } from '../multiplayer/src/rooms/WalkRoom.js';
import { PLAZA_STAGE } from '../multiplayer/src/world-features.js';

// Build a WalkRoom instance without the Colyseus constructor, wiring only the state
// the permission helpers touch.
function makeRoom({ creator = '' } = {}) {
	const room = Object.create(WalkRoom.prototype);
	room.blockOwners = new Map();
	room.blockCounts = new Map();
	room.columnCounts = new Map();
	room.coinCreator = creator;
	room.econ = new Map();
	room.state = { players: new Map() };
	return room;
}

// Register a seated player with a stable owner id and (optionally) a verified wallet.
function seat(room, sessionId, { playerId = sessionId, account = '' } = {}) {
	room.econ.set(sessionId, { playerId });
	room.state.players.set(sessionId, { account });
	return { sessionId };
}

describe('WalkRoom build permissions (R19)', () => {
	let room;
	beforeEach(() => { room = makeRoom(); });

	it('protects the spawn and totem columns at every height', () => {
		expect(room._isProtectedColumn(0, 0)).toBe(true);   // spawn
		expect(room._isProtectedColumn(0, -8)).toBe(true);  // totem (world z=-12 → grid -8)
		expect(room._isProtectedColumn(2, -1)).toBe(true);  // within the spawn disc
		expect(room._isProtectedColumn(40, 40)).toBe(false); // open plaza, clear of every disc
	});

	// The Living Stage is where a show (and the meetup agenda) actually happens, so
	// its guard disc is derived from world-features.PLAZA_STAGE rather than written
	// out twice. Pinning the derivation here is what stops a builder walling the
	// venue off, and stops the two definitions drifting if the venue ever moves.
	it('protects the plaza stage disc, derived from the venue itself', () => {
		const cx = Math.round(PLAZA_STAGE.x / BLOCK_SIZE_M);
		const cz = Math.round(PLAZA_STAGE.z / BLOCK_SIZE_M);
		const cells = Math.ceil(PLAZA_STAGE.r / BLOCK_SIZE_M);
		expect(room._isProtectedColumn(cx, cz)).toBe(true);
		expect(room._isProtectedColumn(cx + cells, cz)).toBe(true);      // the disc edge
		expect(room._isProtectedColumn(cx + cells + 1, cz)).toBe(false); // just outside it
	});

	it('refuses placement in a protected column', () => {
		seat(room, 's1');
		const owner = room._ownerKey('s1');
		expect(room._placementBlock(owner, 0, 0)).toBe('protected');
		expect(room._placementBlock(owner, 20, 20)).toBe(null);
	});

	it('enforces the per-player ownership cap', () => {
		seat(room, 's1');
		const owner = room._ownerKey('s1');
		room.blockCounts.set(owner, 1200); // at the cap
		expect(room._placementBlock(owner, 20, 20)).toBe('playercap');
		room.blockCounts.set(owner, 1199);
		expect(room._placementBlock(owner, 20, 20)).toBe(null);
	});

	it('enforces the per-column density cap (anti-wall)', () => {
		seat(room, 's1');
		const owner = room._ownerKey('s1');
		room.columnCounts.set('20,20', 14); // at the column cap
		expect(room._placementBlock(owner, 20, 20)).toBe('dense');
		room.columnCounts.set('20,20', 13);
		expect(room._placementBlock(owner, 20, 20)).toBe(null);
	});

	it('accounts for in-batch additions so a composite stamp cannot straddle a cap', () => {
		seat(room, 's1');
		const owner = room._ownerKey('s1');
		room.columnCounts.set('20,20', 13); // one slot left in the column
		// First cell of the batch is allowed; the second (extraColumn=1) trips 'dense'.
		expect(room._placementBlock(owner, 20, 20, 0, 0)).toBe(null);
		expect(room._placementBlock(owner, 20, 20, 0, 1)).toBe('dense');
	});

	it('lets only the placer (or the creator) modify a piece', () => {
		const alice = seat(room, 'sA', { playerId: 'alice' });
		const bob = seat(room, 'sB', { playerId: 'bob' });
		room._trackPlacement('20,0,20', 'alice');

		expect(room._mayModify(alice, '20,0,20')).toBe(true);  // owner
		expect(room._mayModify(bob, '20,0,20')).toBe(false);   // stranger — denied
	});

	it('treats an ownerless (restored) cell as creator-only', () => {
		const bob = seat(room, 'sB', { playerId: 'bob' });
		room._trackPlacement('20,0,20', ''); // legacy / pre-ownership restore
		expect(room._mayModify(bob, '20,0,20')).toBe(false);
	});

	it('grants the verified coin creator world-wide modify rights', () => {
		room = makeRoom({ creator: 'CREATORWALLET' });
		const creator = seat(room, 'sC', { playerId: 'cc', account: 'CREATORWALLET' });
		const someone = seat(room, 'sX', { playerId: 'xx', account: 'OTHERWALLET' });
		room._trackPlacement('20,0,20', 'yy'); // a third party's block — not someone's

		expect(room._isCreator(creator)).toBe(true);
		expect(room._isCreator(someone)).toBe(false);
		expect(room._mayModify(creator, '20,0,20')).toBe(true);  // creator moderates
		expect(room._mayModify(someone, '20,0,20')).toBe(false);
	});

	it('a spoofed account cannot impersonate the creator', () => {
		room = makeRoom({ creator: 'CREATORWALLET' });
		// A player whose verified account is NOT the creator wallet — even if a client
		// claimed otherwise, the server reads the bound account, so this is false.
		const faker = seat(room, 'sF', { playerId: 'ff', account: '' });
		expect(room._isCreator(faker)).toBe(false);
	});

	it('keeps owner + column tallies consistent across place and remove', () => {
		room._trackPlacement('3,0,3', 'alice');
		room._trackPlacement('3,1,3', 'alice'); // same column, stacked
		expect(room.blockCounts.get('alice')).toBe(2);
		expect(room.columnCounts.get('3,3')).toBe(2);

		room._untrackPlacement('3,1,3', 'alice', 3, 3);
		expect(room.blockCounts.get('alice')).toBe(1);
		expect(room.columnCounts.get('3,3')).toBe(1);

		room._untrackPlacement('3,0,3', 'alice', 3, 3);
		expect(room.blockCounts.has('alice')).toBe(false); // last one removed → key dropped
		expect(room.columnCounts.has('3,3')).toBe(false);
	});
});
