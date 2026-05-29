// Game schema — authoritative state for the Kintara isometric MMO realm.
//
// Mirrors the design notes in the player guide: a tile world where players
// gather resources, manage an inventory + hotbar, fight, bank items, and earn
// gold. Like schemas.js (the /walk experience), every field here is paid for
// on each delta patch, so we keep types primitive and the shapes flat.
//
// @colyseus/schema sends only the fields that changed since the last patch,
// so large-but-stable structures (a 24-slot inventory) are cheap once synced.

import { Schema, MapSchema, ArraySchema, defineTypes } from '@colyseus/schema';

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

// A single inventory / hotbar / bank slot. `item` is '' for an empty slot.
// `qty` stacks up to 999 for stackable items (wood, stone, coal, fish, gold);
// tools (axe, pickaxe, rod, hammer, sword) are non-stackable (qty stays 1).
export class Slot extends Schema {
	constructor(item = '', qty = 0) {
		super();
		this.item = item;
		this.qty = qty;
	}
}
defineTypes(Slot, { item: 'string', qty: 'uint16' });

// ---------------------------------------------------------------------------
// Player
// ---------------------------------------------------------------------------

export class GamePlayer extends Schema {
	constructor() {
		super();
		this.id = '';
		this.name = 'guest';
		this.color = 0xffffff;

		// Tile position (grid coordinates) + a render-facing yaw for facing.
		this.tx = 0;
		this.ty = 0;
		this.yaw = 0;
		this.motion = 'idle'; // 'idle' | 'walk'

		// Vitals + currency.
		this.hp = 100;
		this.maxHp = 100;
		this.gold = 0;
		this.dead = false;
		this.respawnAt = 0; // epoch ms the player can act again after dying

		// Skills (levels). XP is tracked server-side off-schema; only the level
		// is broadcast since that's all clients render.
		this.combat = 1;
		this.woodcutting = 1;
		this.mining = 1;
		this.fishing = 1;
		this.cooking = 1;
		this.cosmetic = ''; // equipped cosmetic id ('' = default)

		// 24-slot backpack + 6 hotbar slots. Fixed length so indices are stable
		// references the client can drag between.
		this.inv = new ArraySchema();
		this.hotbar = new ArraySchema();
		this.activeSlot = -1; // index into hotbar; -1 = nothing equipped

		this.tsServer = 0;
	}
}
defineTypes(GamePlayer, {
	id: 'string',
	name: 'string',
	color: 'uint32',
	tx: 'int16',
	ty: 'int16',
	yaw: 'float32',
	motion: 'string',
	hp: 'int16',
	maxHp: 'int16',
	gold: 'uint32',
	dead: 'boolean',
	respawnAt: 'float64',
	combat: 'uint16',
	woodcutting: 'uint16',
	mining: 'uint16',
	fishing: 'uint16',
	cooking: 'uint16',
	cosmetic: 'string',
	inv: [Slot],
	hotbar: [Slot],
	activeSlot: 'int8',
	tsServer: 'float64',
});

// ---------------------------------------------------------------------------
// World objects
// ---------------------------------------------------------------------------

// A harvestable node (tree, rock, coal). When `depleted` it renders as a stump
// and respawns at `respawnAt`. `kind` drives which tool + skill applies.
export class ResourceNode extends Schema {
	constructor() {
		super();
		this.id = '';
		this.kind = 'tree'; // 'tree' | 'rock' | 'coal'
		this.tx = 0;
		this.ty = 0;
		this.depleted = false;
		this.respawnAt = 0; // epoch ms it comes back
	}
}
defineTypes(ResourceNode, {
	id: 'string',
	kind: 'string',
	tx: 'int16',
	ty: 'int16',
	depleted: 'boolean',
	respawnAt: 'float64',
});

// A combat target — training dummy (static) or a roaming/aggressive mob.
export class Mob extends Schema {
	constructor() {
		super();
		this.id = '';
		this.kind = 'dummy';
		this.tx = 0;
		this.ty = 0;
		this.hp = 50;
		this.maxHp = 50;
		this.dead = false;
		this.respawnAt = 0;
		this.hitTs = 0; // epoch ms of last hit, for client flash
		this.aggroId = ''; // session id of the player this mob is chasing ('' = none)
	}
}
defineTypes(Mob, {
	id: 'string',
	kind: 'string',
	tx: 'int16',
	ty: 'int16',
	hp: 'int16',
	maxHp: 'int16',
	dead: 'boolean',
	respawnAt: 'float64',
	hitTs: 'float64',
	aggroId: 'string',
});

// A death-drop bag left where a player died in a danger realm. Holds the items
// that fell out of the inventory; the owner (and, after a grace window, anyone)
// can recover them before it expires.
export class Tombstone extends Schema {
	constructor() {
		super();
		this.id = '';
		this.owner = '';
		this.ownerName = '';
		this.tx = 0;
		this.ty = 0;
		this.items = new ArraySchema();
		this.expiresAt = 0;
	}
}
defineTypes(Tombstone, {
	id: 'string',
	owner: 'string',
	ownerName: 'string',
	tx: 'int16',
	ty: 'int16',
	items: [Slot],
	expiresAt: 'float64',
});

// ---------------------------------------------------------------------------
// Root state
// ---------------------------------------------------------------------------

export class GameState extends Schema {
	constructor() {
		super();
		this.realm = 'mainland';
		this.players = new MapSchema();
		this.nodes = new MapSchema();
		this.mobs = new MapSchema();
		this.tombstones = new MapSchema();
	}
}
defineTypes(GameState, {
	realm: 'string',
	players: { map: GamePlayer },
	nodes: { map: ResourceNode },
	mobs: { map: Mob },
	tombstones: { map: Tombstone },
});
