// Combat handlers for the /play coin worlds (W07), the network-and-AI half of
// combat.js's pure math. Mirrors activities.js's split: the room registers a
// couple of message handlers and two ticks here, and this file reaches back into
// the room's authoritative helpers (`_actionOk`, `_grantXp`, `_sendInv`,
// `_questEvent`, `_persistEcon`, `econ`, `clients`) rather than duplicating them.
//
// Three things live here:
//   1. Mob AI, roaming PvE enemies confined to the named DANGER_ZONES, chasing
//      and attacking the nearest player through the SAME damage path an 'attack'
//      intent uses, so a mob hit and a player hit are one code path
//      (combat.js applyDamage), not two.
//   2. The 'attack' intent, validate weapon/ammo/cooldown/zone, pick a target
//      with combat.selectTarget, roll damage, apply it, and (on a kill) spill a
//      lootable tombstone.
//   3. The 'loot' intent, claim a tombstone's cash + items when standing beside
//      it.
//
// Authority model mirrors _handleFish/activities.js: the client only ever sends
// an intent; every roll, target pick and damage application happens here, and
// the result rides back over the room's existing profile/inv/notice/combat
// channels. Nothing here trusts a client-sent position, target or damage number.

import {
	addItem, hasRoomFor, removeItem, countItem, dropCarried, reviveProfile, creditGold,
} from './economy.js';
import { weaponDef, mobStats, rollLoot, itemLabel } from './items.js';
import {
	DANGER_ZONES, SPAWN_POINT, isDangerZone, dangerZoneAt, randomPointInZone,
} from './world-features.js';
import {
	selectTarget, rollDamage, applyDamage, addHeat, decayHeat, heatStars,
} from './combat.js';
import { Mob, Tombstone } from './schemas.js';

// How often the mob AI advances (ms). Coarser than the 15 Hz move rate, mobs
// don't need move-grade smoothness, and the client interpolates between ticks.
export const MOB_TICK_MS = 200;
// Wanted/heat decay cadence (ms). Independent of the mob tick so tuning one
// never nudges the other.
export const HEAT_TICK_MS = 1000;
// How long a killed mob stays gone before it respawns fresh, at a new random
// point in the same zone.
export const MOB_RESPAWN_MS = 26_000;
// How long a downed player stays dead before respawning at the safe spawn.
export const PLAYER_RESPAWN_MS = 5_500;
// How long an unlooted tombstone lingers before the world reclaims it.
export const TOMBSTONE_TTL_MS = 180_000;
// How close a player must stand to a tombstone to loot it.
export const LOOT_REACH_M = 3.2;

// This zone's PvE roster, by DANGER_ZONES id, a difficulty gradient across the
// three named wilds so a player has somewhere easier to start and something to
// grow into, matching the loot tables' own "richer than an ogre" framing for the
// troll. Kept here (not in world-features.js) since it's a combat-only concern.
const ZONE_ROSTER = {
	'southern-wilds': ['goblin', 'goblin'],
	'northern-wilds': ['goblin', 'ogre'],
	'eastern-marches': ['ogre', 'troll'],
};

let _mobSeq = 0;

// --- Mob lifecycle ----------------------------------------------------------

// Spawn one fresh mob of `kind` at a random point in `zone`, tracked in the
// room's schema + the off-schema home-zone/cooldown maps a fresh mob needs.
function spawnMob(room, zone, kind) {
	const stats = mobStats(kind);
	if (!stats) return;
	const p = randomPointInZone(zone, Math.random);
	const id = `mob-${zone.id}-${_mobSeq++}`;
	const m = new Mob();
	m.id = id;
	m.kind = kind;
	m.x = p.x; m.y = 0; m.z = p.z;
	m.yaw = Math.random() * Math.PI * 2;
	m.hp = stats.hp;
	m.maxHp = stats.hp;
	m.state = 'idle';
	m.tsServer = Date.now();
	room.state.mobs.set(id, m);
	room._mobZone.set(id, zone);
}

// Seed the world's full PvE roster from ZONE_ROSTER. Called once from
// WalkRoom.onCreate, mirroring _seedVehicles.
export function seedMobs(room) {
	room._mobZone = new Map();     // mobId -> its home DANGER_ZONES entry
	room._mobAtkCd = new Map();    // mobId -> next-swing epoch ms
	for (const zone of DANGER_ZONES) {
		for (const kind of (ZONE_ROSTER[zone.id] || [])) spawnMob(room, zone, kind);
	}
}

// Advance every live mob one AI step: idle, chase the nearest in-range player,
// or swing at one already in range. Confined to its home zone (a chase never
// steps outside the circle it spawned in) so the town stays lawful by
// construction, not by a separate check on every player action.
export function tickMobs(room, dtMs) {
	const now = Date.now();
	for (const [id, mob] of room.state.mobs) {
		if (mob.state === 'dead') continue;
		const stats = mobStats(mob.kind);
		if (!stats) continue;

		let target = null;
		let bestD = Infinity;
		if (stats.hostile) {
			for (const [sid, p] of room.state.players) {
				if (p.dead) continue;
				const d = Math.hypot(p.x - mob.x, p.z - mob.z);
				if (d <= stats.aggro && d < bestD) { bestD = d; target = { sid, p, d }; }
			}
		}

		if (!target) {
			// Stamp tsServer only on the transition to idle, never every tick: an
			// unconditional write dirties a synced float64 for every alive mob at
			// 5Hz, which kept every state patch non-empty for every client even in
			// an empty world. An idle mob's fields are static; peers need no tick.
			if (mob.state !== 'idle') { mob.state = 'idle'; mob.tsServer = now; }
			continue;
		}

		if (target.d > stats.atkRange) {
			// Chase, clamped to the home zone so it can never wander into town.
			const dx = target.p.x - mob.x, dz = target.p.z - mob.z;
			const len = Math.hypot(dx, dz) || 1;
			const step = stats.speed * (dtMs / 1000);
			let nx = mob.x + (dx / len) * step;
			let nz = mob.z + (dz / len) * step;
			const zone = room._mobZone.get(id);
			if (zone) {
				const zdx = nx - zone.x, zdz = nz - zone.z;
				const zlen = Math.hypot(zdx, zdz);
				const maxR = Math.max(0, zone.r - 0.5);
				if (zlen > maxR) { nx = zone.x + (zdx / zlen) * maxR; nz = zone.z + (zdz / zlen) * maxR; }
			}
			mob.x = nx; mob.z = nz;
			mob.yaw = Math.atan2(dx, dz);
			mob.state = 'chase';
		} else {
			mob.yaw = Math.atan2(target.p.x - mob.x, target.p.z - mob.z);
			mob.state = 'attack';
			const cd = room._mobAtkCd.get(id) || 0;
			if (now >= cd && stats.dmg > 0) {
				room._mobAtkCd.set(id, now + stats.atkCd);
				const profile = room.econ.get(target.sid);
				if (profile) {
					const dmg = rollDamage({ dmg: stats.dmg }, 1, Math.random);
					const res = applyDamage(profile, dmg);
					const client = room.clients.find((c) => c.sessionId === target.sid);
					client?.send('combat', {
						role: 'victim', target: 'mob', kind: mob.kind, mobHp: mob.hp, mobMaxHp: mob.maxHp,
						playerHp: profile.hp, playerMaxHp: profile.maxHp, dealt: res.dealt, dead: res.killed,
					});
					client?.send('inv', {
						inv: profile.inv.map((s) => ({ item: s.item, qty: s.qty })),
						hotbar: profile.hotbar.map((s) => ({ item: s.item, qty: s.qty })),
						activeSlot: profile.activeSlot, gold: profile.gold,
						hp: profile.hp, maxHp: profile.maxHp, armor: profile.armor, maxArmor: profile.maxArmor, heat: profile.heat,
					});
					if (res.killed) killPlayer(room, target.sid, `the ${itemLabel(mob.kind) || mob.kind}`);
					room._persistEcon(target.sid);
				}
			}
		}
		mob.tsServer = now;
	}
}

// Respawn a mob that died, fresh, at a new random point in the same zone it
// belongs to. Scheduled once per kill via room.clock.setTimeout (auto-cleared
// with the room, so a dead room never leaks a pending respawn).
function respawnMob(room, id) {
	const mob = room.state.mobs.get(id);
	const zone = room._mobZone.get(id);
	if (!mob || !zone) return;
	const stats = mobStats(mob.kind);
	const p = randomPointInZone(zone, Math.random);
	mob.x = p.x; mob.z = p.z;
	mob.yaw = Math.random() * Math.PI * 2;
	mob.hp = stats?.hp || mob.maxHp;
	mob.maxHp = stats?.hp || mob.maxHp;
	mob.state = 'idle';
	mob.tsServer = Date.now();
}

// --- Heat decay --------------------------------------------------------------

// Decay every online player's wanted meter, faster while they're lying low in
// town. Republishes the public star count on the schema only when it actually
// moved, so an unwanted player costs the wire nothing every tick.
export function tickHeat(room, dtMs) {
	for (const [sid, profile] of room.econ) {
		if (!profile || !(profile.heat > 0)) continue;
		const player = room.state.players.get(sid);
		if (!player) continue;
		profile.heat = decayHeat(profile.heat, dtMs, !isDangerZone(player.x, player.z));
		const stars = heatStars(profile.heat);
		if (player.heat !== stars) player.heat = stars;
	}
}

// --- Death & tombstones ------------------------------------------------------

// One id sequence for tombstones, independent of mobs.
let _tsSeq = 0;

// Spill a death's carried valuables into a lootable tombstone at (x,z). The
// synced fields are the display slice (schema Tombstone); the actual item
// manifest stays off-schema on the room (room._tombLoot) so contents can't be
// read without walking up and looting, mirroring the schema's own doc comment.
function spillTombstone(room, x, z, ownerName, drop) {
	if (!drop || (drop.gold <= 0 && !drop.items.length)) return;
	const id = `ts-${Date.now()}-${_tsSeq++}`;
	const t = new Tombstone();
	t.id = id;
	t.x = x; t.z = z;
	t.gold = drop.gold;
	t.count = drop.items.length;
	t.owner = ownerName || 'Unknown';
	t.ts = Date.now();
	room.state.tombstones.set(id, t);
	room._tombLoot.set(id, drop);
	room.clock.setTimeout(() => {
		room.state.tombstones.delete(id);
		room._tombLoot.delete(id);
	}, TOMBSTONE_TTL_MS);
}

// Kill a player: drop their carried gold + pack into a tombstone (banked cash
// and equipped hotbar tools/weapons are untouched, dropCarried's own risk/
// reward contract), flag them downed on the shared schema so peers stop
// targeting them and render the ragdoll, and schedule a clean respawn at the
// safe spawn point.
export function killPlayer(room, sessionId, killerLabel) {
	const player = room.state.players.get(sessionId);
	const profile = room.econ.get(sessionId);
	if (!player || !profile || player.dead) return;
	const drop = dropCarried(profile);
	spillTombstone(room, player.x, player.z, player.name, drop);
	player.dead = true;
	const client = room.clients.find((c) => c.sessionId === sessionId);
	client?.send('notice', { kind: 'death', ok: false, text: killerLabel ? `You were killed by ${killerLabel}.` : 'You died.' });
	// The purse and pack emptied into the tombstone THIS instant, so push the
	// emptied snapshot now rather than at respawn: the HUD spent the whole death
	// screen showing cash the player no longer had, which reads as the drop having
	// failed. The banked balance rides along, because it is exactly what survived.
	if (client) {
		room._sendInv?.(client, profile);
		const lostItems = drop.items.reduce((n, e) => n + e.qty, 0);
		const lostParts = [];
		if (drop.gold > 0) lostParts.push(`${drop.gold} cash`);
		if (lostItems > 0) lostParts.push(`${lostItems} item${lostItems === 1 ? '' : 's'}`);
		client.send('notice', {
			kind: 'death', ok: false,
			text: lostParts.length
				? `You dropped ${lostParts.join(' and ')} where you fell. ${profile.bank} cash stayed safe in the bank.`
				: `You were carrying nothing to drop. ${profile.bank} cash is safe in the bank.`,
		});
	}
	room.clock.setTimeout(() => {
		// The profile is revived UNCONDITIONALLY: a player who disconnects inside
		// the respawn window used to skip this whole block, persist hp 0, and come
		// back permanently bricked at zero health (WalkRoom.onJoin also self-heals
		// this on restore, as the second belt). Only the schema/teleport half needs
		// the session to still be present.
		reviveProfile(profile);
		if (!room.state.players.has(sessionId)) {
			room._persistEcon(sessionId);
			return;
		}
		player.dead = false;
		player.x = SPAWN_POINT.x; player.y = 0; player.z = SPAWN_POINT.z;
		player.tsServer = Date.now();
		const c2 = room.clients.find((c) => c.sessionId === sessionId);
		c2?.send('notice', { kind: 'respawn', ok: true, text: 'You respawned in town.' });
		c2?.send('profile', {
			gold: profile.gold, bank: profile.bank, hp: profile.hp, maxHp: profile.maxHp,
			armor: profile.armor, maxArmor: profile.maxArmor, heat: profile.heat,
			inv: profile.inv.map((s) => ({ item: s.item, qty: s.qty })),
			hotbar: profile.hotbar.map((s) => ({ item: s.item, qty: s.qty })),
			activeSlot: profile.activeSlot, cap: 99,
		});
		room._persistEcon(sessionId);
	}, PLAYER_RESPAWN_MS);
}

// --- The 'attack' intent -----------------------------------------------------

export function handleAttack(room, client) {
	const player = room.state.players.get(client.sessionId);
	const profile = room.econ.get(client.sessionId);
	if (!player || !profile || player.dead) return;
	if (!room._actionOk(client.sessionId, 'attack')) return;

	const active = profile.hotbar[profile.activeSlot];
	const weapon = weaponDef(active?.item);
	if (!weapon) {
		client.send('notice', { kind: 'tool', ok: false, text: 'Equip a weapon to attack.' });
		return;
	}
	if (!isDangerZone(player.x, player.z)) {
		client.send('notice', { kind: 'attack', ok: false, text: 'The wilds are past the edge of town, fights only break out there.' });
		return;
	}
	const now = Date.now();
	if (now < (profile.cd.attack || 0)) return; // mid-swing/recovering

	if (weapon.kind === 'ranged') {
		if (countItem(profile, weapon.ammo) <= 0) {
			client.send('notice', { kind: 'attack', ok: false, text: `Out of ${itemLabel(weapon.ammo).toLowerCase()}.` });
			return;
		}
	}

	profile.cd.attack = now + weapon.cooldownMs;
	if (weapon.kind === 'ranged') removeItem(profile, weapon.ammo, 1);

	const attackerPose = { x: player.x, z: player.z, yaw: player.yaw };
	const candidates = [];
	for (const [id, mob] of room.state.mobs) {
		if (mob.state === 'dead') continue;
		candidates.push({ type: 'mob', id, x: mob.x, z: mob.z });
	}
	for (const [sid, p] of room.state.players) {
		if (sid === client.sessionId || p.dead) continue;
		if (!isDangerZone(p.x, p.z)) continue; // never damaged from town
		candidates.push({ type: 'player', id: sid, x: p.x, z: p.z });
	}

	const hit = selectTarget(attackerPose, weapon, candidates);
	if (weapon.kind === 'ranged') room._sendInv(client, profile); // reflect the spent ammo
	if (!hit) {
		client.send('notice', { kind: 'attack', ok: false, text: 'No target in range.' });
		return;
	}

	const dmg = rollDamage(weapon, profile.levels.combat || 1);

	if (hit.type === 'mob') {
		const mob = room.state.mobs.get(hit.id);
		if (!mob || mob.state === 'dead') return;
		const vitals = { hp: mob.hp, armor: 0 };
		const res = applyDamage(vitals, dmg);
		mob.hp = vitals.hp;
		client.send('combat', {
			role: 'attacker', target: 'mob', kind: mob.kind, mobHp: mob.hp, mobMaxHp: mob.maxHp,
			playerHp: profile.hp, playerMaxHp: profile.maxHp, dealt: res.dealt, dead: res.killed,
		});
		if (res.killed) {
			mob.state = 'dead';
			const stats = mobStats(mob.kind);
			room._grantXp(client, profile, 'combat', 8 + (stats?.xp || 0));
			if (stats?.gold) creditGold(profile, stats.gold);
			const loot = rollLoot(mob.kind, Math.random);
			spillTombstone(room, mob.x, mob.z, itemLabel(mob.kind), { gold: 0, items: loot });
			room._sendInv(client, profile);
			room.clock.setTimeout(() => respawnMob(room, hit.id), MOB_RESPAWN_MS);
			// Quest progress: a real kill advances any active "defeat N foes" objective.
			// The danger zone comes from the MOB's authoritative position at the moment
			// it died, so a zone-pinned bounty can only be filled where it was posted.
			room._questEvent(client, profile, {
				type: 'defeat',
				target: 'mob',
				kind: mob.kind,
				zone: dangerZoneAt(mob.x, mob.z)?.id || null,
			});
		}
		room._persistEcon(client.sessionId);
		return;
	}

	// PvP: apply to the target's own off-schema vitals, tell them their new hp,
	// raise the attacker's heat, and (on a kill) spill their carried valuables.
	const targetProfile = room.econ.get(hit.id);
	const targetPlayer = room.state.players.get(hit.id);
	if (!targetProfile || !targetPlayer) return;
	const res = applyDamage(targetProfile, dmg);
	profile.heat = addHeat(profile.heat, { killed: res.killed });
	player.heat = heatStars(profile.heat);

	client.send('combat', {
		role: 'attacker', target: 'player', dealt: res.dealt, dead: res.killed, playerHp: profile.hp, playerMaxHp: profile.maxHp,
	});
	const victimClient = room.clients.find((c) => c.sessionId === hit.id);
	victimClient?.send('combat', {
		role: 'victim', target: 'player', dealt: res.dealt, dead: res.killed, playerHp: targetProfile.hp, playerMaxHp: targetProfile.maxHp,
		attacker: player.name,
	});
	victimClient?.send('inv', {
		inv: targetProfile.inv.map((s) => ({ item: s.item, qty: s.qty })),
		hotbar: targetProfile.hotbar.map((s) => ({ item: s.item, qty: s.qty })),
		activeSlot: targetProfile.activeSlot, gold: targetProfile.gold,
		hp: targetProfile.hp, maxHp: targetProfile.maxHp, armor: targetProfile.armor, maxArmor: targetProfile.maxArmor, heat: targetProfile.heat,
	});
	if (res.killed) killPlayer(room, hit.id, player.name || 'another player');
	room._persistEcon(client.sessionId);
	room._persistEcon(hit.id);
}

// --- The 'loot' intent -------------------------------------------------------

export function handleLoot(room, client, payload) {
	const player = room.state.players.get(client.sessionId);
	const profile = room.econ.get(client.sessionId);
	if (!player || !profile) return;
	if (!room._actionOk(client.sessionId, 'loot')) return;

	const id = typeof payload?.id === 'string' ? payload.id : '';
	const ts = room.state.tombstones.get(id);
	const drop = room._tombLoot.get(id);
	if (!ts || !drop) {
		client.send('notice', { kind: 'loot', ok: false, text: 'That marker is gone.' });
		return;
	}
	const dist = Math.hypot(player.x - ts.x, player.z - ts.z);
	if (dist > LOOT_REACH_M) {
		client.send('notice', { kind: 'loot', ok: false, text: 'Move closer to loot it.' });
		return;
	}

	// Absorb what fits FIRST, and only remove the tombstone once it is fully
	// drained. Deleting up front destroyed every item that didn't fit a nearly
	// full pack, with no warning: a player looting their own death drop with one
	// free slot lost the rest of their run for good. Whatever doesn't fit stays
	// in the marker for another trip (or another looter).
	const goldGained = drop.gold > 0 ? drop.gold : 0;
	if (goldGained > 0) {
		creditGold(profile, goldGained);
		drop.gold = 0;
	}
	const gained = [];
	const remaining = [];
	for (const { item, qty } of drop.items) {
		const leftover = hasRoomFor(profile, item) ? addItem(profile, item, qty) : qty;
		const got = qty - leftover;
		if (got > 0) {
			gained.push(`${got > 1 ? got + ' ' : ''}${itemLabel(item).toLowerCase()}`);
			room._questEvent(client, profile, { type: 'collect', item, qty: got });
		}
		if (leftover > 0) remaining.push({ item, qty: leftover });
	}
	drop.items = remaining;
	const drained = remaining.length === 0;
	if (drained) {
		room.state.tombstones.delete(id);
		room._tombLoot.delete(id);
	} else {
		// Keep the schema marker's count honest so peers see what's left.
		ts.count = remaining.reduce((n, e) => n + e.qty, 0);
	}
	room._sendInv(client, profile);
	const parts = [];
	if (goldGained > 0) parts.push(`$${goldGained}`);
	if (gained.length) parts.push(gained.join(' + '));
	const leftBehind = drained ? '' : ' Your pack is full; the rest is still in the marker.';
	client.send('notice', {
		kind: 'loot',
		ok: parts.length > 0,
		text: parts.length ? `Looted ${parts.join(' and ')}.${leftBehind}` : drained ? 'The marker was already picked clean.' : 'Your pack is full. Make room, the marker will wait.',
	});
	room._persistEcon(client.sessionId);
}

// Wire the two intents onto a room. Called once from WalkRoom.onCreate.
export function registerCombatHandlers(room) {
	room._tombLoot = new Map(); // tombstone id -> { gold, items:[{item,qty}] } (off-schema manifest)
	room.onMessage('attack', (client) => handleAttack(room, client));
	room.onMessage('loot', (client, payload) => handleLoot(room, client, payload));
}
