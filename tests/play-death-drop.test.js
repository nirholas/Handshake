// Death, the drop, and what the dying player is actually told (W07).
//
// The bank exists because dying costs you the purse you are carrying. That trade
// is only legible if the client is told the truth at the moment it happens: the
// old flow flagged the player dead and then sat on the pre-death purse for the
// whole respawn delay, so the HUD showed cash that was already lying in a
// tombstone. These tests pin the drop itself (carried gone, banked untouched,
// tools kept) and the snapshot + message that report it.

import { describe, it, expect, vi } from 'vitest';

const { killPlayer, PLAYER_RESPAWN_MS } = await import('../multiplayer/src/combat-handlers.js');
const { newProfile } = await import('../multiplayer/src/economy.js');
const { SPAWN_POINT } = await import('../multiplayer/src/world-features.js');

// A room with only what killPlayer touches. `clock.setTimeout` collects the
// pending callbacks so a test can run the respawn deliberately instead of
// waiting 5.5 real seconds.
function makeRoom(profile) {
	const sent = [];
	const timers = [];
	const player = { x: 12, z: -4, name: 'Ada', dead: false, tsServer: 0 };
	const client = { sessionId: 's1', send: (type, msg) => sent.push({ type, msg }) };
	const room = {
		state: { players: new Map([['s1', player]]), tombstones: new Map() },
		econ: new Map([['s1', profile]]),
		clients: [client],
		clock: { setTimeout: (fn, ms) => { timers.push({ fn, ms }); return { clear() {} }; } },
		_tombLoot: new Map(),
		_sendInv: vi.fn(),
		_persistEcon: vi.fn(),
	};
	return { room, client, player, sent, timers };
}

// A player mid-run: 240 carried, 500 banked, a stack of gathered goods, tools on
// the hotbar.
function loadedProfile() {
	const p = newProfile('acct-death');
	p.gold = 240;
	p.bank = 500;
	p.inv[2] = { item: 'wood', qty: 30 };
	p.inv[3] = { item: 'cookedFish', qty: 4 };
	return p;
}

describe('killPlayer — the drop', () => {
	it('drops carried cash and the pack, keeps banked cash and hotbar tools', () => {
		const profile = loadedProfile();
		const { room } = makeRoom(profile);
		killPlayer(room, 's1', 'a goblin');

		expect(profile.gold).toBe(0);
		expect(profile.bank).toBe(500);
		expect(profile.inv.every((s) => !s.item)).toBe(true);
		// The starter kit lives on the hotbar and survives, so a respawn isn't toothless.
		expect(profile.hotbar.some((s) => s.item === 'sword')).toBe(true);
	});

	it('spills exactly what was carried into a lootable tombstone where the player fell', () => {
		const profile = loadedProfile();
		const { room, player } = makeRoom(profile);
		killPlayer(room, 's1', 'a goblin');

		expect(room.state.tombstones.size).toBe(1);
		const tomb = [...room.state.tombstones.values()][0];
		expect(tomb.gold).toBe(240);
		expect(tomb.x).toBe(player.x);
		expect(tomb.z).toBe(player.z);
		const loot = [...room._tombLoot.values()][0];
		expect(loot.gold).toBe(240);
		expect(loot.items).toEqual(
			expect.arrayContaining([{ item: 'wood', qty: 30 }, { item: 'cookedFish', qty: 4 }]),
		);
	});
});

describe('killPlayer — what the dying player is told', () => {
	it('pushes the emptied purse immediately, not at respawn', () => {
		const profile = loadedProfile();
		const { room, client } = makeRoom(profile);
		killPlayer(room, 's1', 'a goblin');

		expect(room._sendInv).toHaveBeenCalledWith(client, profile);
		// The snapshot is taken from the already-emptied profile, so a HUD reading it
		// can never show cash that is lying in the tombstone.
		expect(profile.gold).toBe(0);
	});

	it('names what was lost and what the bank protected', () => {
		const profile = loadedProfile();
		const { sent, room } = makeRoom(profile);
		killPlayer(room, 's1', 'a goblin');

		const deaths = sent.filter((m) => m.type === 'notice' && m.msg.kind === 'death');
		expect(deaths.length).toBe(2);
		expect(deaths[0].msg.text).toContain('killed by a goblin');
		expect(deaths[1].msg.text).toContain('240 cash');
		expect(deaths[1].msg.text).toContain('2 items');
		expect(deaths[1].msg.text).toContain('500 cash stayed safe in the bank');
	});

	it('says so plainly when there was nothing on you to lose', () => {
		const profile = newProfile('acct-broke');
		profile.bank = 75;
		const { sent, room } = makeRoom(profile);
		killPlayer(room, 's1', null);

		const deaths = sent.filter((m) => m.type === 'notice' && m.msg.kind === 'death');
		expect(deaths[1].msg.text).toContain('nothing to drop');
		expect(deaths[1].msg.text).toContain('75 cash is safe in the bank');
		// Nothing carried means nothing to loot; no empty tombstone litters the world.
		expect(room.state.tombstones.size).toBe(0);
	});
});

describe('killPlayer — respawn', () => {
	it('revives at full health at the safe spawn and persists the emptied profile', () => {
		const profile = loadedProfile();
		const { room, timers, sent } = makeRoom(profile);
		killPlayer(room, 's1', 'a troll');

		const respawn = timers.find((t) => t.ms === PLAYER_RESPAWN_MS);
		expect(respawn).toBeTruthy();
		respawn.fn();

		const player = room.state.players.get('s1');
		expect(player.dead).toBe(false);
		expect(player.x).toBe(SPAWN_POINT.x);
		expect(player.z).toBe(SPAWN_POINT.z);
		expect(profile.hp).toBe(profile.maxHp);
		// The vest is gone with the rest of the pack; the armour bar starts empty.
		expect(profile.armor).toBe(0);
		expect(room._persistEcon).toHaveBeenCalledWith('s1');
		const snap = sent.find((m) => m.type === 'profile');
		expect(snap.msg.gold).toBe(0);
		expect(snap.msg.bank).toBe(500);
	});
});
