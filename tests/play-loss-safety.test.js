// The /play "never destroy what a player earned" contract.
//
// Each case here corresponds to a real way the world used to take something a
// player had legitimately earned and give nothing back. They are grouped
// because they share one rule: a server action that cannot complete must leave
// the player's things where they were, not delete them and move on.

import { describe, it, expect } from 'vitest';
import { handleLoot } from '../multiplayer/src/combat-handlers.js';
import {
	newProfile, restoreProfile, serializeProfile, addItem, creditGold, countItem, INV_SIZE, MAX_STACK,
} from '../multiplayer/src/economy.js';
import { vehicleMaxSpeedMps } from '../multiplayer/src/vehicles.js';
import { WalkRoom } from '../multiplayer/src/rooms/WalkRoom.js';

// A room stand-in carrying only what handleLoot touches.
function makeRoom({ profile, drop, tombstone }) {
	const sent = [];
	const client = { sessionId: 's1', send: (type, msg) => sent.push({ type, msg }) };
	const room = {
		state: {
			players: new Map([['s1', { x: 0, z: 0 }]]),
			tombstones: new Map([['t1', tombstone]]),
		},
		econ: new Map([['s1', profile]]),
		_tombLoot: new Map([['t1', drop]]),
		_actionOk: () => true,
		_sendInv: () => {},
		_questEvent: () => {},
		_persistEcon: () => {},
	};
	return { room, client, sent };
}

// Fill every inventory slot so nothing new can be absorbed.
function packedFull(profile) {
	for (let i = 0; i < INV_SIZE; i++) profile.inv[i] = { item: 'stone', qty: MAX_STACK };
	return profile;
}

describe('loot never destroys an overflowing drop', () => {
	it('leaves what does not fit standing in the marker instead of deleting it', () => {
		const profile = packedFull(newProfile('acct'));
		const drop = { gold: 120, items: [{ item: 'wood', qty: 9 }, { item: 'coal', qty: 4 }] };
		const tombstone = { x: 0, z: 0, count: 13 };
		const { room, client, sent } = makeRoom({ profile, drop, tombstone });

		handleLoot(room, client, { id: 't1' });

		// Gold is a scalar and always lands.
		expect(profile.gold).toBe(120);
		// The marker survives, still holding everything the pack could not take.
		expect(room.state.tombstones.has('t1')).toBe(true);
		expect(room._tombLoot.get('t1').items).toEqual([{ item: 'wood', qty: 9 }, { item: 'coal', qty: 4 }]);
		// ...and its peer-visible count reflects what is genuinely left.
		expect(tombstone.count).toBe(13);
		// The player is told, rather than silently robbed.
		const notice = sent.find((s) => s.type === 'notice');
		expect(notice.msg.text).toMatch(/pack is full/i);
	});

	it('takes the part that fits and keeps only the remainder', () => {
		const profile = newProfile('acct');
		// One free slot, everything else occupied by a full stack of something else.
		for (let i = 0; i < INV_SIZE - 1; i++) profile.inv[i] = { item: 'stone', qty: MAX_STACK };
		const drop = { gold: 0, items: [{ item: 'wood', qty: 5 }, { item: 'coal', qty: 7 }] };
		const { room, client } = makeRoom({ profile, drop, tombstone: { x: 0, z: 0, count: 12 } });

		handleLoot(room, client, { id: 't1' });

		expect(countItem(profile, 'wood')).toBe(5);          // the free slot took the wood
		expect(room.state.tombstones.has('t1')).toBe(true);   // coal had nowhere to go
		expect(room._tombLoot.get('t1').items).toEqual([{ item: 'coal', qty: 7 }]);
	});

	it('clears the marker only once it is genuinely drained', () => {
		const profile = newProfile('acct');
		const drop = { gold: 30, items: [{ item: 'wood', qty: 2 }] };
		const { room, client } = makeRoom({ profile, drop, tombstone: { x: 0, z: 0, count: 2 } });

		handleLoot(room, client, { id: 't1' });

		expect(profile.gold).toBe(30);
		expect(countItem(profile, 'wood')).toBe(2);
		expect(room.state.tombstones.has('t1')).toBe(false);
		expect(room._tombLoot.has('t1')).toBe(false);
	});

	it('does not re-credit gold when a second loot drains the remainder', () => {
		const profile = packedFull(newProfile('acct'));
		const drop = { gold: 50, items: [{ item: 'wood', qty: 3 }] };
		const { room, client } = makeRoom({ profile, drop, tombstone: { x: 0, z: 0, count: 3 } });

		handleLoot(room, client, { id: 't1' });   // gold taken, wood left behind
		expect(profile.gold).toBe(50);

		handleLoot(room, client, { id: 't1' });   // still full: nothing more to take
		expect(profile.gold).toBe(50);            // gold is not paid twice
		expect(room.state.tombstones.has('t1')).toBe(true);
	});
});

describe('a balance saturates instead of wrapping to zero', () => {
	it('keeps a balance past 2^31 intact instead of wiping it to 0', () => {
		// `saved.gold | 0` is ToInt32 and ran BEFORE the ceiling, so anything past
		// 2^31 wrapped negative and then "clamped" to 0: a wiped fortune on the
		// next reload. Below the 2^32 ceiling the value must survive exactly.
		const restored = restoreProfile({ gold: 3_000_000_000, bank: 2_500_000_000 }, 'acct');
		expect(restored.gold).toBe(3_000_000_000);
		expect(restored.bank).toBe(2_500_000_000);
	});

	it('saturates a balance past the 2^32 ceiling rather than wrapping', () => {
		const restored = restoreProfile({ gold: 9_000_000_000, bank: 5_000_000_000 }, 'acct');
		expect(restored.gold).toBe(0xffffffff);
		expect(restored.bank).toBe(0xffffffff);
	});

	it('round-trips an ordinary balance untouched', () => {
		const p = newProfile('acct');
		p.gold = 12_345;
		p.bank = 6_789;
		const restored = restoreProfile(serializeProfile(p), 'acct');
		expect(restored.gold).toBe(12_345);
		expect(restored.bank).toBe(6_789);
	});

	it('creditGold saturates at the ceiling and ignores junk', () => {
		const p = newProfile('acct');
		p.gold = 0xffffffff - 5;
		creditGold(p, 100);
		expect(p.gold).toBe(0xffffffff);

		const q = newProfile('acct');
		creditGold(q, Number.NaN);
		creditGold(q, -50);
		expect(q.gold).toBe(0); // never negative, never NaN
	});
});

describe('the vehicle clamp is derived from real elapsed time', () => {
	// _applyVehicleTransform only reads the vehicle object, so it can be driven
	// directly off the prototype.
	const apply = WalkRoom.prototype._applyVehicleTransform;
	const car = (over = {}) => ({
		type: 'coupe', x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, speed: 0,
		tsServer: Date.now(), ...over,
	});
	const move = (dz, speed = 0) => ({ x: 0, y: 0, z: dz, qx: 0, qy: 0, qz: 0, qw: 1, speed });

	it('THE EXPLOIT: a burst of max-step messages can no longer outrun top speed', () => {
		// The old clamp allowed a fixed step PER MESSAGE, and vsync permits 30/s,
		// so maxing every message covered roughly 10x the car's top speed. With the
		// clamp derived from elapsed time, a message arriving immediately after the
		// last one may only cover what the car could really travel in that gap.
		const v = car({ tsServer: Date.now() }); // no time has passed
		const farButUnderOldClamp = 9.0;         // inside the old ~9.86m per-message budget
		expect(apply.call({}, v, move(farButUnderOldClamp), false)).toBe(false);
		expect(v.z).toBe(0); // rejected outright, the vehicle is untouched
	});

	it('accepts a step that real elapsed time genuinely allows', () => {
		const v = car({ tsServer: Date.now() - 300 }); // 0.3s of travel
		const reach = vehicleMaxSpeedMps('coupe') * 0.3;
		expect(apply.call({}, v, move(reach * 0.8), 0)).toBe(true);
		expect(v.z).toBeCloseTo(reach * 0.8, 3);
	});

	it('still rejects a self-reported speed above the type ceiling', () => {
		const v = car({ tsServer: Date.now() - 300 });
		const overSpeed = vehicleMaxSpeedMps('coupe') * 2;
		expect(apply.call({}, v, move(0.5, overSpeed), false)).toBe(false);
	});

	it('rejects malformed payloads rather than writing NaN into the world', () => {
		const v = car();
		expect(apply.call({}, v, null, false)).toBe(false);
		expect(apply.call({}, v, { x: 'a', y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 }, false)).toBe(false);
		expect(apply.call({}, v, { x: NaN, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 }, false)).toBe(false);
		expect(v.x).toBe(0);
	});
});
