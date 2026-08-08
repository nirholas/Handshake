// The cash counters are two lists in two files that must stay identical.
//
// The general store and the bank/ATM are the only cash actions that used to have
// no proximity check: the server priced every trade correctly but never asked
// where the player stood, so a crafted client could bank its purse from the
// middle of a fight and never risk a coin to a death drop. Closing that meant the
// server needs the counter positions, and those positions already existed on the
// client (src/game/world-zones.js, where the NPCs are placed).
//
// Two copies of a coordinate is exactly the drift that produces "the shop refuses
// to serve me while I'm standing in it", so this suite pins them equal. If a stall
// moves on the client, this fails here rather than in a player's face.

import { describe, it, expect } from 'vitest';

const {
	VENDOR_STALLS, ATMS, COUNTER_REACH, vendorInRange, atmInRange,
} = await import('../multiplayer/src/world-features.js');
const { spawnsOfType } = await import('../src/game/world-zones.js');

const at = (list, id) => list.find((n) => n.id === id);

describe('counter positions mirror the client spawn table exactly', () => {
	it('every vendor stall the client places has a server-side counter at the same point', () => {
		const clientStalls = spawnsOfType('vendor');
		expect(clientStalls.length).toBeGreaterThan(0);
		expect(VENDOR_STALLS.length).toBe(clientStalls.length);
		for (const stall of clientStalls) {
			const server = at(VENDOR_STALLS, stall.id);
			expect(server, `no server counter for client stall ${stall.id}`).toBeTruthy();
			expect([server.x, server.z]).toEqual([stall.x, stall.z]);
		}
	});

	it('every ATM the client places has a server-side counter at the same point', () => {
		const clientAtms = spawnsOfType('atm');
		expect(clientAtms.length).toBeGreaterThan(0);
		expect(ATMS.length).toBe(clientAtms.length);
		for (const atm of clientAtms) {
			const server = at(ATMS, atm.id);
			expect(server, `no server counter for client ATM ${atm.id}`).toBeTruthy();
			expect([server.x, server.z]).toEqual([atm.x, atm.z]);
		}
	});
});

describe('counter reach', () => {
	it('covers a player standing on the NPC that opened the panel', () => {
		for (const stall of VENDOR_STALLS) expect(vendorInRange(stall.x, stall.z)).toBeTruthy();
		for (const atm of ATMS) expect(atmInRange(atm.x, atm.z)).toBeTruthy();
	});

	// The NPC's own walk-up prompt fires at 5m, so the counter has to reach past
	// that or a player who takes one step back mid-trade gets refused.
	it('reaches further than the 5m NPC prompt that opens the panel', () => {
		expect(COUNTER_REACH).toBeGreaterThan(5);
		const stall = VENDOR_STALLS[0];
		expect(vendorInRange(stall.x + 6, stall.z)).toBeTruthy();
	});

	it('does not reach across the world, which is the whole point', () => {
		const stall = VENDOR_STALLS[0];
		expect(vendorInRange(stall.x + COUNTER_REACH + 2, stall.z)).toBeNull();
		// Spawn is 60m+ from either stall, so a player at spawn is not at a counter.
		expect(vendorInRange(0, 0)).toBeNull();
		// The ATM sits at (0,-30): far enough from spawn that banking is a walk.
		expect(atmInRange(0, 0)).toBeNull();
	});

	it('the store and the bank are separate counters, not one shared spot', () => {
		for (const atm of ATMS) expect(vendorInRange(atm.x, atm.z)).toBeNull();
		for (const stall of VENDOR_STALLS) expect(atmInRange(stall.x, stall.z)).toBeNull();
	});
});
