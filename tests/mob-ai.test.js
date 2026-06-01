// Task 03 — Mob AI: roam, aggro, chase, contact damage.
//
// These drive the real GameRoom mob simulation (`_mobTick` and its helpers)
// against the real realm data. The simulation is server-authoritative and pure
// w.r.t. the schema state, so we build a minimal GameRoom harness (a real
// instance whose state maps and realm we populate via `_seedWorld`) and step the
// tick by hand. No colyseus networking, no browser — the gameplay contract is:
//
//   • hostile mobs in a danger realm acquire, chase, and deal contact damage;
//   • a player inside a safe camp is never aggroed;
//   • inert mobs (roam:false, aggro:false — e.g. Mainland dummies) never move;
//   • roamers wander but stay leashed near home and never stand on a player.

import { describe, it, expect } from 'vitest';
import { GameRoom } from '../multiplayer/src/rooms/GameRoom.js';
import { REALMS, inRect } from '../multiplayer/src/rooms/realms.js';
import { GamePlayer } from '../multiplayer/src/schemas/game.js';

function makeRoom(realmName) {
	const room = Object.create(GameRoom.prototype);
	room.realm = REALMS[realmName];
	room.clients = [];
	room.priv = new Map();
	room.state = {
		players: new Map(),
		mobs: new Map(),
		nodes: new Map(),
		structures: new Map(),
		tombstones: new Map(),
	};
	room._seedWorld(); // seeds nodes + mobs + per-mob AI exactly like onCreate
	return room;
}

function addPlayer(room, sid, tx, ty, hp = 200) {
	const p = new GamePlayer();
	p.id = sid;
	p.name = sid;
	p.tx = tx;
	p.ty = ty;
	p.hp = p.maxHp = hp;
	p.dead = false;
	room.state.players.set(sid, p);
	return p;
}

// Find a walkable tile at (roughly) Chebyshev distance `dist` from (cx,cy) by
// spiraling outward — keeps the tests robust to the realm's exact obstacle map.
function walkableNear(room, cx, cy, dist) {
	for (let r = dist; r <= dist + 4; r++) {
		for (let dx = -r; dx <= r; dx++) {
			for (let dy = -r; dy <= r; dy++) {
				if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
				const tx = cx + dx, ty = cy + dy;
				if (room._mobCanStand(tx, ty)) return { tx, ty };
			}
		}
	}
	return null;
}

describe('Mob AI — Wilderness goblins are hostile', () => {
	it('acquires, chases, and deals contact damage to a nearby player', () => {
		const room = makeRoom('wilderness');
		const g0 = room.state.mobs.get('g0'); // goblin, roam+aggro
		expect(g0).toBeTruthy();

		const spot = walkableNear(room, g0.tx, g0.ty, 3); // inside aggro radius (6)
		expect(spot).toBeTruthy();
		const p = addPlayer(room, 'p1', spot.tx, spot.ty);
		expect(inRect(room.realm.safeCamp, p.tx, p.ty)).toBe(false); // not sheltered

		let now = 1000;
		let reachedMelee = false;
		const startDist = room._cheb(g0, p);
		for (let i = 0; i < 40; i++) {
			now += 600;
			room._mobTick(now);
			expect(room._cheb(g0, p)).toBeGreaterThanOrEqual(1); // never stands ON the player
			if (room._cheb(g0, p) <= 1) { reachedMelee = true; break; }
		}

		expect(g0.aggroId).toBe('p1'); // acquired the target
		expect(reachedMelee).toBe(true); // closed the gap
		expect(startDist).toBeGreaterThan(1);

		const before = p.hp;
		now += MOB_ATTACK_GAP;
		room._mobTick(now);
		expect(p.hp).toBeLessThan(before); // took real contact damage
	});

	it('never aggros a player standing inside the safe camp', () => {
		const room = makeRoom('wilderness');
		const g0 = room.state.mobs.get('g0');
		const camp = room.realm.safeCamp;
		const safeTx = Math.floor((camp.x0 + camp.x1) / 2);
		const safeTy = Math.floor((camp.y0 + camp.y1) / 2);
		expect(inRect(camp, safeTx, safeTy)).toBe(true);
		addPlayer(room, 'safe', safeTx, safeTy);

		let now = 1000;
		for (let i = 0; i < 20; i++) { now += 600; room._mobTick(now); }
		for (const [, m] of room.state.mobs) expect(m.aggroId).toBe(''); // none locked on
	});
});

describe('Mob AI — inert mobs stay put', () => {
	it('Mainland dummies and tutorial goblins never move or aggro', () => {
		const room = makeRoom('mainland');
		// Drop a player right next to every mob.
		const homes = new Map();
		for (const [id, m] of room.state.mobs) {
			homes.set(id, { tx: m.tx, ty: m.ty });
			const spot = walkableNear(room, m.tx, m.ty, 1);
			if (spot) addPlayer(room, `near_${id}`, spot.tx, spot.ty);
		}
		let now = 1000;
		for (let i = 0; i < 25; i++) { now += 600; room._mobTick(now); }
		for (const [id, m] of room.state.mobs) {
			const h = homes.get(id);
			expect({ id, tx: m.tx, ty: m.ty }).toEqual({ id, tx: h.tx, ty: h.ty }); // never moved
			expect(m.aggroId).toBe(''); // never aggroed
		}
	});
});

describe('Mob AI — roamers wander but stay leashed', () => {
	it('a roamer stays within the roam radius of home with no players present', () => {
		const room = makeRoom('wilderness');
		const g0 = room.state.mobs.get('g0');
		const home = { tx: g0.tx, ty: g0.ty };
		let now = 1000;
		let everMoved = false;
		for (let i = 0; i < 200; i++) {
			now += 600;
			room._mobTick(now);
			if (g0.tx !== home.tx || g0.ty !== home.ty) everMoved = true;
			// Roam stays bounded — never exceeds the roam radius from home.
			expect(room._cheb(g0, home)).toBeLessThanOrEqual(4);
		}
		expect(everMoved).toBe(true); // it actually wandered (roam:true)
	});
});

// Mirrors MOB_ATTACK_COOLDOWN_MS in GameRoom — large enough to clear the gate.
const MOB_ATTACK_GAP = 1100;
