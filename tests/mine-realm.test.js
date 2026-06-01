// Task 08 — Mainland mine interior. These cover the dependency-free core the
// mine rests on: the realm geometry + portal wiring (which the GameRoom validates
// movement and traversal against) and the realm-transfer token (which carries a
// player's haul between realm rooms without trusting the client). Both live in
// plain modules, so they assert without standing up a Colyseus room — mirroring
// fishing.test.js / cooking.test.js.
import { describe, it, expect } from 'vitest';
import { REALMS, portalAt, isBlocked, inBounds } from '../multiplayer/src/rooms/realms.js';
import { signTransfer, verifyTransfer } from '../multiplayer/src/rooms/realm-transfer.js';

const MINE = REALMS.mine;
const MAINLAND = REALMS.mainland;

describe('mine realm — an enclosed, safe cave dense with ore', () => {
	it('exists and is a safe, non-pvp, non-danger resource area', () => {
		expect(MINE).toBeTruthy();
		expect(MINE.safe).toBe(true);
		expect(MINE.pvp).toBe(false);
		expect(MINE.danger).toBe(false);
	});

	it('has no bank or fountain — you carry the haul back up to the Mainland', () => {
		expect(MINE.fountain).toBeNull();
		expect(MINE.bankZone).toEqual([]);
	});

	it('is denser in ore than the Mainland surface (the whole point of the mine)', () => {
		const count = (realm, kind) => realm.nodes.filter((n) => n.kind === kind).length;
		const mineRock = count(MINE, 'rock'), mineCoal = count(MINE, 'coal');
		const surfRock = count(MAINLAND, 'rock'), surfCoal = count(MAINLAND, 'coal');
		expect(mineRock).toBeGreaterThan(surfRock);
		expect(mineCoal).toBeGreaterThan(surfCoal);
		// Only rock and coal grow down here — no trees in a cave.
		expect(MINE.nodes.every((n) => n.kind === 'rock' || n.kind === 'coal')).toBe(true);
	});

	it('keeps every node id unique and every node on a walkable, in-bounds tile', () => {
		const ids = MINE.nodes.map((n) => n.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const n of MINE.nodes) {
			expect(inBounds(MINE, n.tx, n.ty)).toBe(true);
			// A node may not sit inside a wall/ridge/pillar (it would be unreachable).
			expect(isBlocked(MINE, n.tx, n.ty)).toBe(false);
		}
	});

	it('spawns the player on a walkable interior tile, not in a wall', () => {
		expect(inBounds(MINE, MINE.spawn.tx, MINE.spawn.ty)).toBe(true);
		expect(isBlocked(MINE, MINE.spawn.tx, MINE.spawn.ty)).toBe(false);
	});

	it('walls its entire edge except the entrance mouth', () => {
		const g = MINE.grid;
		// Corners are always wall.
		for (const [x, y] of [[0, 0], [g - 1, 0], [0, g - 1], [g - 1, g - 1]]) {
			expect(isBlocked(MINE, x, y)).toBe(true);
		}
		// The south edge has a walkable gap (the entrance/return mouth) AND wall.
		let gap = 0, wall = 0;
		for (let x = 0; x < g; x++) (isBlocked(MINE, x, g - 1) ? wall++ : gap++);
		expect(gap).toBeGreaterThan(0);
		expect(wall).toBeGreaterThan(0);
	});

	it('permits no player building down a working mine', () => {
		expect(MINE.structures).toEqual([]);
	});
});

describe('mine portals — round-trip between the Mainland entrance and the cave', () => {
	it('Mainland has a mine entrance that targets the mine spawn area', () => {
		const entrance = MAINLAND.portals.find((p) => p.to === 'mine');
		expect(entrance).toBeTruthy();
		// The entrance tile is walkable so a player can actually step onto it.
		expect(isBlocked(MAINLAND, entrance.x0, entrance.y0)).toBe(false);
		// Its destination lands inside the mine, on a walkable tile.
		expect(inBounds(MINE, entrance.toTx, entrance.toTy)).toBe(true);
		expect(isBlocked(MINE, entrance.toTx, entrance.toTy)).toBe(false);
	});

	it('the mine has exactly one portal — a return to the Mainland', () => {
		expect(MINE.portals).toHaveLength(1);
		const ret = MINE.portals[0];
		expect(ret.to).toBe('mainland');
		expect(inBounds(MAINLAND, ret.toTx, ret.toTy)).toBe(true);
		expect(isBlocked(MAINLAND, ret.toTx, ret.toTy)).toBe(false);
	});

	it('return tile is clear of the entrance rect, so stepping out never bounces back in', () => {
		const entrance = MAINLAND.portals.find((p) => p.to === 'mine');
		const ret = MINE.portals[0];
		// Landing back on the Mainland must NOT be on a portal tile.
		expect(portalAt(MAINLAND, ret.toTx, ret.toTy)).toBeNull();
		// And the entrance's own destination must not sit on the mine's return rect.
		expect(portalAt(MINE, entrance.toTx, entrance.toTy)).toBeNull();
	});

	it('portalAt resolves the entrance rect and rejects ordinary tiles', () => {
		const entrance = MAINLAND.portals.find((p) => p.to === 'mine');
		expect(portalAt(MAINLAND, entrance.x0, entrance.y0)?.to).toBe('mine');
		expect(portalAt(MAINLAND, MAINLAND.spawn.tx, MAINLAND.spawn.ty)).toBeNull();
	});
});

describe('realm-transfer token — the trust boundary for carrying a haul across realms', () => {
	const carry = {
		inv: [{ item: 'coal', qty: 17 }, { item: 'stone', qty: 9 }],
		hotbar: [{ item: 'pickaxe', qty: 1 }],
		activeSlot: 0,
		bank: [{ item: 'gold', qty: 250 }],
		gold: 1234,
		hp: 73,
		maxHp: 100,
		xp: { mining: 4200, combat: 0, woodcutting: 0, fishing: 0, cooking: 0 },
		mounted: false,
		mount: '',
	};

	it('round-trips a signed carry intact', () => {
		const token = signTransfer({ to: 'mine', tx: 16, ty: 28, carry });
		const out = verifyTransfer(token);
		expect(out).toBeTruthy();
		expect(out.to).toBe('mine');
		expect(out.tx).toBe(16);
		expect(out.ty).toBe(28);
		expect(out.carry).toEqual(carry);
	});

	it('rejects a tampered payload (forged items can never ride in)', () => {
		const token = signTransfer({ to: 'mine', tx: 16, ty: 28, carry });
		const [body, sig] = token.split('.');
		const forged = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
		forged.carry.gold = 9_999_999;
		const rebody = Buffer.from(JSON.stringify(forged)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
		expect(verifyTransfer(`${rebody}.${sig}`)).toBeNull();
	});

	it('rejects garbage, empty, and structurally-invalid tokens', () => {
		expect(verifyTransfer('')).toBeNull();
		expect(verifyTransfer('not-a-token')).toBeNull();
		expect(verifyTransfer('abc.def')).toBeNull();
		expect(verifyTransfer(null)).toBeNull();
		expect(verifyTransfer(undefined)).toBeNull();
	});
});
