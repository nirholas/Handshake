// Task 22 — additional realms (Wilderness North/East, the gated Cave) and the
// Arena (rollers + seating). These tests pin the realm DATA contract the server
// and client both depend on: every realm is internally walkable, every portal is a
// real two-way link that lands on solid ground (never inside a wall, a node, or a
// return portal that would bounce you), the northern cave is combat-gated, and the
// Arena's rollers + spectator stands carry the right shape + push semantics.

import { describe, it, expect } from 'vitest';
import {
	REALMS, isBlocked, inBounds, portalAt, inRect, inAnyRect,
	rollerAt, rollerDelta, inNoPvpZone, realmLayout,
} from '../multiplayer/src/rooms/realms.js';

// A tile is walkable on the server if it's in bounds, not blocked, and not sitting
// under a resource node (nodes occupy their tile — see GameRoom._isWalkable).
function nodeSet(realm) {
	return new Set((realm.nodes || []).map((n) => `${n.tx},${n.ty}`));
}
function walkable(realm, tx, ty, nodes = nodeSet(realm)) {
	return inBounds(realm, tx, ty) && !isBlocked(realm, tx, ty) && !nodes.has(`${tx},${ty}`);
}

const NEW = ['wilderness_north', 'wilderness_cave', 'wilderness_east', 'arena'];

describe('new realms exist with the right rule flags', () => {
	it('all four are registered', () => {
		for (const name of NEW) expect(REALMS[name], name).toBeTruthy();
	});

	it('Wilderness North is PvP + danger with NO safe camp', () => {
		const r = REALMS.wilderness_north;
		expect(r.pvp).toBe(true);
		expect(r.danger).toBe(true);
		expect(r.safe).toBe(false);
		expect(r.safeCamp).toBeNull();
	});

	it('the Cave is a PvP + danger cavern (rendered enclosed)', () => {
		const r = REALMS.wilderness_cave;
		expect(r.pvp).toBe(true);
		expect(r.danger).toBe(true);
		expect(r.cave).toBe(true);
	});

	it('Wilderness East is a full PvP + danger realm, no safe camp', () => {
		const r = REALMS.wilderness_east;
		expect(r.pvp).toBe(true);
		expect(r.danger).toBe(true);
		expect(r.safeCamp).toBeNull();
		expect(r.grid).toBeGreaterThanOrEqual(40); // full-size, like the main Wilderness
	});

	it('the Arena is PvP but NOT danger (a sporting bout — no item loss)', () => {
		const r = REALMS.arena;
		expect(r.pvp).toBe(true);
		expect(r.danger).toBe(false);
		expect(r.rollers?.length).toBeGreaterThan(0);
		expect(r.seating?.length).toBeGreaterThan(0);
	});

	it('Wilderness North has a LOWER mob count than the main Wilderness', () => {
		expect(REALMS.wilderness_north.mobs.length).toBeLessThan(REALMS.wilderness.mobs.length);
	});
});

describe('every realm spawn stands on walkable ground', () => {
	for (const [name, r] of Object.entries(REALMS)) {
		it(`${name} spawn (${r.spawn.tx},${r.spawn.ty}) is walkable`, () => {
			expect(walkable(r, r.spawn.tx, r.spawn.ty)).toBe(true);
		});
	}
});

describe('portals are real two-way links that land on solid ground', () => {
	for (const [name, r] of Object.entries(REALMS)) {
		for (const p of r.portals) {
			it(`${name} → ${p.to} lands cleanly and is reciprocated`, () => {
				const dest = REALMS[p.to];
				expect(dest, `destination realm ${p.to} must exist`).toBeTruthy();

				// Landing tile is in bounds, not a wall, and not under a node.
				expect(walkable(dest, p.toTx, p.toTy), `landing (${p.toTx},${p.toTy}) in ${p.to} walkable`).toBe(true);

				// Landing tile is NOT inside a portal of the destination (no instant bounce).
				const bounced = portalAt(dest, p.toTx, p.toTy);
				expect(bounced, `landing in ${p.to} must not sit on a return portal`).toBeNull();

				// Some portal in the destination points back to this realm (a real round trip).
				const back = dest.portals.some((q) => q.to === name);
				expect(back, `${p.to} should have a portal back to ${name}`).toBe(true);
			});
		}
	}
});

describe('the guide-specified connectivity is wired', () => {
	const links = (from) => new Set(REALMS[from].portals.map((p) => p.to));
	it('Wilderness connects north and east', () => {
		expect(links('wilderness').has('wilderness_north')).toBe(true);
		expect(links('wilderness').has('wilderness_east')).toBe(true);
	});
	it('the Pond also reaches Wilderness East off its north shore', () => {
		expect(links('pond').has('wilderness_east')).toBe(true);
	});
	it('Wilderness North reaches the Cave; the Cave returns to the North', () => {
		expect(links('wilderness_north').has('wilderness_cave')).toBe(true);
		expect(links('wilderness_cave').has('wilderness_north')).toBe(true);
	});
	it('the Mainland plaza opens into the Arena and the Arena returns to it', () => {
		expect(links('mainland').has('arena')).toBe(true);
		expect(links('arena').has('mainland')).toBe(true);
	});
});

describe('the northern cave is combat-LEVEL gated', () => {
	const cavePortal = REALMS.wilderness_north.portals.find((p) => p.to === 'wilderness_cave');

	it('the cave portal carries a combat gate', () => {
		expect(cavePortal.gate).toBeTruthy();
		expect(cavePortal.gate.combat).toBeGreaterThan(1);
	});

	it('no OTHER portal in the world is gated (only the cave guards entry)', () => {
		const gated = [];
		for (const [name, r] of Object.entries(REALMS)) {
			for (const p of r.portals) if (p.gate) gated.push(`${name}->${p.to}`);
		}
		expect(gated).toEqual(['wilderness_north->wilderness_cave']);
	});

	// Mirrors GameRoom._meetsGate, the server's authoritative check.
	const meetsGate = (combat, gate) => !(gate && Number.isFinite(gate.combat) && combat < gate.combat);

	it('an under-level fighter is refused and a qualified one admitted', () => {
		const gate = cavePortal.gate;
		expect(meetsGate(gate.combat - 1, gate)).toBe(false);
		expect(meetsGate(gate.combat, gate)).toBe(true);
		expect(meetsGate(gate.combat + 5, gate)).toBe(true);
	});
});

describe('Arena rollers — direction + walkable footprint', () => {
	const arena = REALMS.arena;

	it('rollerDelta maps each compass direction to a unit step', () => {
		expect(rollerDelta('n')).toEqual([0, -1]);
		expect(rollerDelta('s')).toEqual([0, 1]);
		expect(rollerDelta('e')).toEqual([1, 0]);
		expect(rollerDelta('w')).toEqual([-1, 0]);
		expect(rollerDelta('?')).toEqual([0, 0]); // unknown never moves
	});

	it('every roller tile is itself walkable and uses a known direction', () => {
		const nodes = nodeSet(arena);
		for (const r of arena.rollers) {
			expect(['n', 's', 'e', 'w']).toContain(r.dir);
			for (let tx = r.x0; tx <= r.x1; tx++) {
				for (let ty = r.y0; ty <= r.y1; ty++) {
					expect(walkable(arena, tx, ty, nodes), `roller tile (${tx},${ty})`).toBe(true);
					expect(rollerAt(arena, tx, ty)).toBeTruthy();
				}
			}
		}
	});

	it('a push never shoves a player out of bounds (the strip stays inside the bowl)', () => {
		for (const r of arena.rollers) {
			const [dx, dy] = rollerDelta(r.dir);
			for (let tx = r.x0; tx <= r.x1; tx++) {
				for (let ty = r.y0; ty <= r.y1; ty++) {
					expect(inBounds(arena, tx + dx, ty + dy)).toBe(true);
				}
			}
		}
	});

	it('the four circuit corners all connect to the next strip (no broken corners)', () => {
		const corners = [
			{ tx: 8,  ty: 10, name: 'top-left'  },
			{ tx: 19, ty: 10, name: 'top-right' },
			{ tx: 19, ty: 16, name: 'bot-right' },
			{ tx: 8,  ty: 16, name: 'bot-left'  },
		];
		for (const c of corners) {
			const r = rollerAt(arena, c.tx, c.ty);
			expect(r, `${c.name} (${c.tx},${c.ty}) must be on a roller`).toBeTruthy();
			const [dx, dy] = rollerDelta(r.dir);
			const next = rollerAt(arena, c.tx + dx, c.ty + dy);
			expect(next, `${c.name} push must land on the next strip, not dead floor`).toBeTruthy();
		}
	});

	it('a full circuit trace from the top-left returns to start (closed loop)', () => {
		const DELTA = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0] };
		let tx = 8, ty = 10;
		for (let step = 0; step < 60; step++) {
			const r = rollerAt(arena, tx, ty);
			if (!r) throw new Error(`lost circuit at (${tx},${ty}) after ${step} steps`);
			const [dx, dy] = DELTA[r.dir];
			tx += dx; ty += dy;
			if (tx === 8 && ty === 10) return; // closed
		}
		throw new Error('circuit did not close within 60 steps');
	});

	it('rollerAt is null off the belts (the spawn floor is free)', () => {
		expect(rollerAt(arena, arena.spawn.tx, arena.spawn.ty)).toBeNull();
	});
});

describe('PvP-immune zones (safe camps + spectator stands)', () => {
	it('Arena seating is a no-PvP zone; the open floor is fair game', () => {
		const seat = REALMS.arena.seating[0];
		expect(inNoPvpZone(REALMS.arena, seat.x0, seat.y0)).toBe(true);
		expect(inNoPvpZone(REALMS.arena, REALMS.arena.spawn.tx, REALMS.arena.spawn.ty)).toBe(false);
	});

	it('the Wilderness safe camp is still a no-PvP zone', () => {
		const camp = REALMS.wilderness.safeCamp;
		expect(inNoPvpZone(REALMS.wilderness, camp.x0, camp.y0)).toBe(true);
	});

	it('seating tiles are walkable (spectators stand on them)', () => {
		for (const stand of REALMS.arena.seating) {
			expect(walkable(REALMS.arena, stand.x0, stand.y0)).toBe(true);
		}
	});
});

describe('realmLayout carries the new client-render fields', () => {
	it('the Arena layout exposes rollers (with dir), seating, and PvP flag', () => {
		const L = realmLayout(REALMS.arena);
		expect(L.pvp).toBe(true);
		expect(L.rollers.length).toBe(REALMS.arena.rollers.length);
		expect(L.rollers[0].dir).toBeTruthy();
		expect(L.seating.length).toBe(REALMS.arena.seating.length);
	});

	it('the cave layout is flagged for enclosed rendering', () => {
		expect(realmLayout(REALMS.wilderness_cave).cave).toBe(true);
		expect(realmLayout(REALMS.mainland).cave).toBe(false);
	});

	it('a gated portal forwards its gate to the client; an open one sends null', () => {
		const north = realmLayout(REALMS.wilderness_north);
		const gated = north.portals.find((p) => p.to === 'wilderness_cave');
		expect(gated.gate.combat).toBe(REALMS.wilderness_north.portals.find((p) => p.to === 'wilderness_cave').gate.combat);
		const open = realmLayout(REALMS.mainland).portals.find((p) => p.to === 'pond');
		expect(open.gate).toBeNull();
	});

	it('the Mainland layout exposes the practice boxing ring', () => {
		expect(realmLayout(REALMS.mainland).ring).toEqual(REALMS.mainland.ring);
	});
});
