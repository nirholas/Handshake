// Verifies Task 02 (player death & tombstone death-bags) server logic directly
// against GameRoom's real methods — no mocks of the logic, only thin stubs for
// the Colyseus transport (client.send / this.clients) that the methods touch.
//
// We drive _killPlayer / _damagePlayer / _handleTombLoot / _tick exactly as the
// live room would and assert the invariants from the task's Definition of Done:
//   • danger realm drops a tombstone with the right items; safe realm does not
//   • tools are kept, non-tool items dropped, gold untouched
//   • ownership holds until the grace window, then anyone adjacent may loot
//   • adjacency is enforced
//   • inventory math is exact (no duplication, no loss) including a full pack
//   • expired bags vanish in the sim tick; respawn returns to the realm spawn
//
// Run: node scripts/test-tombstone.mjs

import { GameRoom } from '../multiplayer/src/rooms/GameRoom.js';
import { REALMS } from '../multiplayer/src/rooms/realms.js';
import { GameState, GamePlayer, Slot } from '../multiplayer/src/schemas/game.js';

const INV_SIZE = 24;
const HOTBAR_SIZE = 6;
const TTL = 120000;
const GRACE = 45000;

let passed = 0;
let failed = 0;
function ok(cond, label) {
	if (cond) { passed++; console.log(`  ✓ ${label}`); }
	else { failed++; console.error(`  ✗ ${label}`); }
}
function eq(a, b, label) { ok(a === b, `${label} (got ${a}, want ${b})`); }

// Build a GameRoom without running Colyseus' lifecycle: we only need its
// methods + a state container + the priv/clients maps the methods read.
function makeRoom(realmName) {
	const room = Object.create(GameRoom.prototype);
	room.realm = REALMS[realmName];
	room.state = new GameState();
	room.state.realm = realmName;
	room.priv = new Map();
	room.clients = [];
	room._tombSeq = 0;
	return room;
}

function addPlayer(room, id, name, tx, ty) {
	const p = new GamePlayer();
	p.id = id; p.name = name; p.tx = tx; p.ty = ty;
	p.hp = p.maxHp = 100; p.gold = 1234;
	for (let i = 0; i < INV_SIZE; i++) p.inv.push(new Slot());
	for (let i = 0; i < HOTBAR_SIZE; i++) p.hotbar.push(new Slot());
	room.state.players.set(id, p);
	const messages = [];
	const client = { sessionId: id, send: (type, data) => messages.push({ type, data }), messages };
	room.clients.push(client);
	room.priv.set(id, { xp: {}, bank: [], cooldowns: { gather: 0, attack: 0 }, rate: new Map() });
	return { p, client };
}

function firstTomb(room) {
	for (const [, t] of room.state.tombstones) return t;
	return null;
}
function tombItems(t) {
	const out = {};
	for (const s of t.items) if (s.item) out[s.item] = (out[s.item] || 0) + s.qty;
	return out;
}
function invCount(p, item) {
	let n = 0;
	for (const s of [...p.inv, ...p.hotbar]) if (s.item === item) n += s.qty;
	return n;
}

// --------------------------------------------------------------------------
console.log('Test 1 — danger realm drops a tombstone (tools kept, loot dropped)');
{
	const room = makeRoom('wilderness');
	const { p, client } = addPlayer(room, 'A', 'Alice', 12, 12);
	p.inv[0].item = 'wood'; p.inv[0].qty = 500;
	p.inv[1].item = 'stone'; p.inv[1].qty = 10;
	p.inv[2].item = 'pickaxe'; p.inv[2].qty = 1; // a TOOL sitting in the backpack
	p.hotbar[0].item = 'axe'; p.hotbar[0].qty = 1;
	p.hotbar[1].item = 'sword'; p.hotbar[1].qty = 1;
	p.hotbar[2].item = 'fish'; p.hotbar[2].qty = 3;
	const goldBefore = p.gold;

	room._killPlayer(p, { byName: 'a goblin' });

	ok(p.dead === true, 'player is dead');
	ok(p.respawnAt > 0, 'respawnAt scheduled');
	eq(p.gold, goldBefore, 'gold is NOT dropped');
	ok(invCount(p, 'axe') === 1 && invCount(p, 'sword') === 1 && invCount(p, 'pickaxe') === 1, 'all tools kept');
	ok(invCount(p, 'wood') === 0 && invCount(p, 'stone') === 0 && invCount(p, 'fish') === 0, 'non-tool items removed from pack');
	const t = firstTomb(room);
	ok(!!t, 'tombstone created');
	eq(t.owner, 'A', 'tombstone owner');
	eq(t.ownerName, 'Alice', 'tombstone ownerName');
	eq(t.tx, 12, 'tombstone tx = death tile'); eq(t.ty, 12, 'tombstone ty = death tile');
	ok(Math.abs(t.expiresAt - (p.respawnAt - 4000 + TTL)) < 5, 'expiresAt ~ now + TTL');
	const items = tombItems(t);
	ok(items.wood === 500 && items.stone === 10 && items.fish === 3, 'bag holds exactly the dropped loot');
	eq(t.items.length, 3, 'bag has 3 slots');
	const died = client.messages.find((m) => m.type === 'died');
	ok(!!died && died.data.dropped === 3 && died.data.danger === true, "'died' notice carries dropped count + danger");
}

console.log('Test 2 — safe realm: no tombstone, no items lost');
{
	const room = makeRoom('mainland');
	const { p, client } = addPlayer(room, 'B', 'Bob', 24, 30);
	p.inv[0].item = 'wood'; p.inv[0].qty = 99;
	room._killPlayer(p);
	ok(p.dead === true, 'player is dead');
	eq(room.state.tombstones.size, 0, 'no tombstone in a safe realm');
	eq(invCount(p, 'wood'), 99, 'items retained in a safe realm');
	const died = client.messages.find((m) => m.type === 'died');
	ok(!!died && died.data.danger === false && died.data.dropped === 0, "'died' notice marks safe realm");
}

console.log('Test 3 — _damagePlayer funnels into death at 0 HP');
{
	const room = makeRoom('wilderness');
	const { p } = addPlayer(room, 'C', 'Cara', 5, 5);
	p.hp = 8;
	const fatal1 = room._damagePlayer(p, 3);
	ok(fatal1 === false && p.hp === 5 && !p.dead, 'non-fatal hit reduces HP');
	const fatal2 = room._damagePlayer(p, 999);
	ok(fatal2 === true && p.hp === 0 && p.dead, 'lethal hit kills + clamps HP at 0');
	const again = room._damagePlayer(p, 10);
	ok(again === false, 'damaging an already-dead player is a no-op');
}

console.log('Test 4 — ownership: only owner loots before grace; adjacency enforced');
{
	const room = makeRoom('wilderness');
	const { p: owner } = addPlayer(room, 'O', 'Owner', 10, 10);
	owner.inv[0].item = 'wood'; owner.inv[0].qty = 50;
	room._killPlayer(owner);
	const t = firstTomb(room);

	// A thief joins, NOT adjacent → denied with an adjacency notice.
	const { p: thief, client: thiefC } = addPlayer(room, 'T', 'Thief', 20, 20);
	room._handleTombLoot(thiefC, { id: t.id });
	ok(thiefC.messages.some((m) => m.data?.text?.includes('Walk up')), 'far player told to walk up');
	eq(tombItems(t).wood, 50, 'bag untouched when not adjacent');

	// Thief walks adjacent but it's still the owner-only window → ownership notice.
	thief.tx = 11; thief.ty = 10;
	room._handleTombLoot(thiefC, { id: t.id });
	ok(thiefC.messages.some((m) => m.data?.text?.includes('belongs to Owner')), 'adjacent non-owner blocked pre-grace');
	eq(tombItems(t).wood, 50, 'bag untouched by non-owner pre-grace');

	// Owner respawns far away (cannot loot until they walk back).
	owner.dead = false; owner.hp = 100; owner.tx = 20; owner.ty = 36;
	const ownerC = room.clients.find((c) => c.sessionId === 'O');
	room._handleTombLoot(ownerC, { id: t.id });
	ok(ownerC.messages.some((m) => m.data?.text?.includes('Walk up')), 'owner must be adjacent too');

	// Owner walks back adjacent → recovers everything, bag removed.
	owner.tx = 10; owner.ty = 11;
	room._handleTombLoot(ownerC, { id: t.id });
	eq(invCount(owner, 'wood'), 50, 'owner recovered all wood');
	eq(room.state.tombstones.size, 0, 'emptied bag removed');
}

console.log('Test 5 — grace window opens the bag to anyone adjacent');
{
	const room = makeRoom('wilderness');
	const { p: owner } = addPlayer(room, 'O', 'Owner', 10, 10);
	owner.inv[0].item = 'coal'; owner.inv[0].qty = 20;
	room._killPlayer(owner);
	const t = firstTomb(room);
	// Force the bag into its final grace window.
	t.expiresAt = Date.now() + GRACE - 1000;
	const { p: looter, client: looterC } = addPlayer(room, 'L', 'Looter', 11, 10);
	room._handleTombLoot(looterC, { id: t.id });
	eq(invCount(looter, 'coal'), 20, 'non-owner loots during grace window');
	eq(room.state.tombstones.size, 0, 'emptied bag removed');
}

console.log('Test 6 — inventory math is exact (full pack + partial fit)');
{
	const { Tombstone } = await import('../multiplayer/src/schemas/game.js');
	// Full pack: every backpack + hotbar slot maxed with wood. Nothing can fit;
	// the bag must keep everything (no loss) and survive.
	const room = makeRoom('wilderness');
	const { p: owner, client } = addPlayer(room, 'O', 'Owner', 10, 11);
	for (const s of [...owner.inv, ...owner.hotbar]) { s.item = 'wood'; s.qty = 999; }
	const t = new Tombstone();
	t.id = 'tomb_manual'; t.owner = 'O'; t.ownerName = 'Owner'; t.tx = 10; t.ty = 10;
	t.expiresAt = Date.now() + TTL; t.items.push(new Slot('wood', 500));
	room.state.tombstones.set(t.id, t);

	const totalBefore = invCount(owner, 'wood') + 500;
	room._handleTombLoot(client, { id: t.id });
	eq(invCount(owner, 'wood') + (tombItems(t).wood || 0), totalBefore, 'no duplication/loss with a full pack');
	eq(tombItems(t).wood, 500, 'full pack leaves all 500 in the bag');
	ok(room.state.tombstones.has(t.id), 'bag remains when nothing could be taken');
	ok(client.messages.some((m) => m.data?.text?.includes('pack is full')), 'full-pack notice shown');

	// Partial fit: free exactly 499 of room in one backpack stack.
	owner.inv[0].qty = 500; // room for 499 more in this stack
	const total2 = invCount(owner, 'wood') + (tombItems(t).wood || 0);
	room._handleTombLoot(client, { id: t.id });
	eq(invCount(owner, 'wood') + (tombItems(t).wood || 0), total2, 'conserved across a partial recovery');
	eq(tombItems(t).wood || 0, 1, 'exactly the overflow (1) remains in the bag');
	ok(room.state.tombstones.has(t.id), 'partially-emptied bag remains');
}

console.log('Test 7 — expiry in _tick + realm-aware respawn');
{
	const room = makeRoom('wilderness');
	const { p } = addPlayer(room, 'O', 'Owner', 10, 10);
	p.inv[0].item = 'wood'; p.inv[0].qty = 5;
	room._killPlayer(p);
	const t = firstTomb(room);
	t.expiresAt = Date.now() - 1; // already crumbled
	p.respawnAt = Date.now() - 1; // due to respawn
	room._tick();
	eq(room.state.tombstones.size, 0, 'expired bag removed in the sim tick');
	ok(!p.dead && p.hp === p.maxHp, 'player respawned at full HP');
	eq(p.tx, REALMS.wilderness.spawn.tx, 'respawn tx = THIS realm spawn');
	eq(p.ty, REALMS.wilderness.spawn.ty, 'respawn ty = THIS realm spawn');
}

console.log('Test 8 — a bag with zero droppable loot is never created');
{
	const room = makeRoom('wilderness');
	const { p } = addPlayer(room, 'O', 'Owner', 10, 10);
	// Only tools on board — nothing to drop.
	p.hotbar[0].item = 'axe'; p.hotbar[0].qty = 1;
	room._killPlayer(p);
	eq(room.state.tombstones.size, 0, 'no empty bag spawned');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
