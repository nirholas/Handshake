// Schema definitions shared between the WalkRoom (server) and the client.
//
// @colyseus/schema uses delta encoding: only fields that changed since the
// last patch are sent over the wire. Keep this schema small and primitive,
// every field here is paid for on every state diff.

import { Schema, MapSchema, defineTypes } from '@colyseus/schema';

export class Player extends Schema {
	constructor() {
		super();
		this.id = '';
		this.name = 'guest';
		this.color = 0xffffff;
		this.x = 0;
		this.y = 0;
		this.z = 0;
		this.yaw = 0;
		this.motion = 'idle'; // 'idle' | 'walk' | 'run'
		this.emote = '';       // animation name or '' when not emoting
		this.emoteTs = 0;      // epoch ms when the emote was triggered
		// Loadable GLB URL for this player's avatar / 3D agent, so every other
		// client renders them as their real avatar instead of a stand-in. Empty
		// string → the client falls back to the default avatar.
		this.avatar = '';
		// Optional three.ws agent id this player is embodying (for cross-links).
		this.agent = '';
		// True while this player is in spatial voice chat, so peers know to open a
		// WebRTC connection to them and the UI can mark their nameplate.
		this.voice = false;
		this.tsServer = 0;     // server-side last-update epoch ms (for interpolation)
		// Verified Solana wallet address bound at sign-in, the account id this
		// player persists under and is known by in the social graph. Empty in the
		// open (un-gated) world; set from the play pass when the token gate is on.
		this.account = '';
		// Combat (W07). HP/armor stay PRIVATE (off-schema, streamed only to the
		// owner) so peers can't read exact vitals, but two states MUST be visible to
		// everyone: whether you're downed (peers render the ragdoll + skip you as a
		// target) and your wanted level (0, 5 stars peers can see to bounty you). Both
		// are tiny and authoritative, set only by the server's combat resolution.
		this.dead = false;
		this.heat = 0; // wanted/heat stars (0, 5), derived from the private heat meter
		// Equipped cosmetic loadout (R03/R23) as the compact wire string peers render
		//, the worn ids in slot order, comma-joined, `none` defaults dropped (see
		// cosmetics-catalog.serializeLoadout). Set authoritatively from the owner's
		// persisted, ownership-validated loadout so a peer can trust the look and an
		// unowned cosmetic can never appear on anyone. Empty ⇒ the bare avatar.
		this.cosmetics = '';
		// Tag mini-game (R08). `it` is the server-authoritative "it" flag visible to
		// all peers so they can render the glow ring + 🏃 marker. `itSince` is the
		// epoch ms when this player last became "it" (0 = not it); a strict integer
		// type would lose precision past 2^53 but float64 covers epoch ms safely.
		this.it = false;
		this.itSince = 0;
		// Verified three.ws username (W10), set only from a signed presence
		// ticket, never from a raw client option, so peers can trust it enough to
		// open the real /u/<username> profile, follow, and DM this player. Empty
		// for guests and wallet-only sessions.
		this.username = '';
	}
}
// IMPORTANT: append-only. Field indices are positional in @colyseus/schema's
// binary protocol. Inserting in the middle shifts all subsequent indices and
// breaks clients connected to older deployed servers. Always add new fields
// at the end so existing deployments remain compatible until redeployed.
defineTypes(Player, {
	id: 'string',
	name: 'string',
	color: 'uint32',
	x: 'float32',
	y: 'float32',
	z: 'float32',
	yaw: 'float32',
	motion: 'string',
	emote: 'string',
	emoteTs: 'float64',
	avatar: 'string',
	agent: 'string',
	voice: 'boolean',
	tsServer: 'float64',
	account: 'string',
	// Append-only (W07): downed state + wanted stars. See the constructor note.
	dead: 'boolean',
	heat: 'uint8',
	// Append-only (R23): equipped cosmetic loadout wire string. See the constructor.
	cosmetics: 'string',
	// Append-only (R08): tag mini-game "it" state. Visible to all peers so they
	// render the glow ring + 🏃 marker without a separate broadcast channel.
	it: 'boolean',
	itSince: 'float64',
	// Append-only (W10): verified three.ws username from the signed presence
	// ticket. See the constructor note.
	username: 'string',
});

// A single placed voxel in a coin's world. Keyed in the blocks MapSchema by its
// packed grid coordinate ("gx,gy,gz"), so the position never has to ride on the
// wire, only the block type does. Delta encoding then makes a place/break a
// one-entry patch. `t` is the palette index (see build-voxels.js BLOCK_TYPES).
export class Block extends Schema {
	constructor() {
		super();
		this.t = 0;
	}
}
defineTypes(Block, {
	t: 'uint8',
});

// A drivable vehicle living in the shared world. Unlike a player's private
// economy (off-schema), a vehicle is a world entity everyone must see, so it
// rides on the synced state. The driver's client simulates it with Rapier and
// streams the authoritative transform (full quaternion, cars pitch/roll over
// the ground, a single yaw can't express that); the server validates per-type
// speed/bounds and relays. `driver` is the sessionId at the wheel ('' = parked),
// the field that gates who is allowed to write this vehicle's transform.
export class Vehicle extends Schema {
	constructor() {
		super();
		this.id = '';
		this.type = 'trench'; // VEHICLE_TYPES key, picks the mesh + handling profile
		this.color = 0xffffff;
		this.x = 0;
		this.y = 0;
		this.z = 0;
		// Orientation as a quaternion so peers reproduce body tilt, not just heading.
		this.qx = 0;
		this.qy = 0;
		this.qz = 0;
		this.qw = 1;
		this.speed = 0;        // signed forward speed (m/s), drives wheel spin + audio
		this.driver = '';      // sessionId at the wheel; '' when parked
		this.health = 100;     // damage hooks for W07 (combat); full here
		this.tsServer = 0;     // last authoritative update (epoch ms) for interpolation
	}
}
defineTypes(Vehicle, {
	id: 'string',
	type: 'string',
	color: 'uint32',
	x: 'float32',
	y: 'float32',
	z: 'float32',
	qx: 'float32',
	qy: 'float32',
	qz: 'float32',
	qw: 'float32',
	speed: 'float32',
	driver: 'string',
	health: 'float32',
	tsServer: 'float64',
});

// A PvE enemy in the shared world (W07). Unlike a player's private vitals, a mob
// is a world entity everyone must see and fight, so it rides on the synced state.
// The SERVER owns every field, spawns it, runs its AI, applies damage, so a
// client can never move, heal, or kill a mob by writing state; it only renders
// what the room replicates. Keyed in the mobs MapSchema by its id.
export class Mob extends Schema {
	constructor() {
		super();
		this.id = '';
		this.kind = 'goblin'; // MOB_STATS key, picks stats, mesh, loot table
		this.x = 0;
		this.y = 0;
		this.z = 0;
		this.yaw = 0;
		this.hp = 1;
		this.maxHp = 1;
		this.state = 'idle'; // 'idle' | 'chase' | 'attack' | 'dead'
		this.tsServer = 0;   // last authoritative update (epoch ms) for interpolation
	}
}
defineTypes(Mob, {
	id: 'string',
	kind: 'string',
	x: 'float32',
	y: 'float32',
	z: 'float32',
	yaw: 'float32',
	hp: 'uint16',
	maxHp: 'uint16',
	state: 'string',
	tsServer: 'float64',
});

// A death-drop marker (W07). When a player or mob dies in a danger zone its carried
// cash + items spill into a lootable tombstone the killer and others can claim. The
// synced fields are only what peers must SEE to find and read it (where it is, how
// much cash, how many item lines, whose it was); the actual item manifest stays
// off-schema on the room so the wire stays cheap and contents can't be inspected
// without walking up and looting. Keyed in the tombstones MapSchema by its id.
export class Tombstone extends Schema {
	constructor() {
		super();
		this.id = '';
		this.x = 0;
		this.z = 0;
		this.gold = 0;     // carried cash inside (display + claim)
		this.count = 0;    // number of item lines inside (for the "N items" pip)
		this.owner = '';   // display name of who dropped it
		this.ts = 0;       // epoch ms it was created (clients fade it as it ages)
	}
}
defineTypes(Tombstone, {
	id: 'string',
	x: 'float32',
	z: 'float32',
	gold: 'uint32',
	count: 'uint8',
	owner: 'string',
	ts: 'float64',
});

// A generic networked world object (R01), the single shared channel every later
// object feature reuses: thrown balls, placed build props, pickups, confetti.
// Unlike a player's private economy (off-schema), an object is a world entity
// everyone must see, so it rides on the synced state. Keyed in the `objects`
// MapSchema by its id. `ownerId` is the account/session allowed to move or remove
// it; the sentinel 'server' means the room owns it (clients can't write it, e.g.
// the R05 physics ball). `kind` is the category, build props persist across a
// server restart (R17); transient kinds like 'ball' are never saved.
export class WorldObject extends Schema {
	constructor() {
		super();
		this.id = '';
		this.type = '';     // model/variant within a kind (e.g. 'crate', 'lamp')
		this.x = 0;
		this.y = 0;
		this.z = 0;
		this.yaw = 0;
		this.scale = 1;
		this.ownerId = '';  // account/session allowed to move/remove ('server' = room-owned)
		this.vx = 0;
		this.vy = 0;
		this.vz = 0;
		this.kind = '';     // category: '' / 'prop' persist; 'ball'/'fx' are transient
		this.ts = 0;        // last authoritative update (epoch ms)
		// P3.3: a player-uploaded model this prop renders instead of a catalog
		// primitive. Empty for every built-in prop. Validated server-side against
		// the storage allow-list (build-limits.normalizePropAssetUrl) before it is
		// ever published to the other clients in the world.
		this.url = '';
	}
}
defineTypes(WorldObject, {
	id: 'string',
	type: 'string',
	x: 'float32',
	y: 'float32',
	z: 'float32',
	yaw: 'float32',
	scale: 'float32',
	ownerId: 'string',
	vx: 'float32',
	vy: 'float32',
	vz: 'float32',
	kind: 'string',
	ts: 'float64',
	url: 'string',
});

export class WalkState extends Schema {
	constructor() {
		super();
		this.players = new MapSchema();
		// Coin identity for this room. A walk_world room is keyed by `coin`
		// (filterBy) so everyone who entered the same coin's community shares one
		// instance; these fields theme the world (banner, totem, cross-links).
		this.coin = '';        // mint address ('' = the default mainland world)
		this.coinName = '';
		this.coinSymbol = '';
		this.coinImage = '';
		// Access tier for this instance. '' = the open General world anyone can
		// enter; 'holders' = a gated world only wallets holding ≥ holderMinUsd of
		// `coin` can join (enforced in WalkRoom.onAuth). The same coin therefore has
		// two isolated rooms, General and Holders, kept apart by filterBy.
		this.tier = '';
		this.holderMinUsd = 0; // USD floor for the holder world (0 in General)
		// Creator-set token threshold for this coin's holder world (R24): hold ≥ this
		// many of `coin` to enter. 0 = no creator threshold, so holderMinUsd applies.
		this.holderMinTokens = 0;
		// Collaborative voxel builds for this coin's world. Keyed by packed grid
		// coordinate; the value carries only the block type. Persisted per coin so
		// a community's build survives the room emptying and the server restarting.
		this.blocks = new MapSchema();
		// True when this world's build is backed by durable cross-restart storage
		// (Upstash Redis). False = memory-only: the build survives the room emptying
		// but not a full server restart. The client surfaces this so builders know
		// whether their creation is saved for keeps.
		this.persistent = false;
		// Drivable vehicles in this world, keyed by vehicle id. Seeded on room create
		// from the vehicle spawn registry; transforms driven by whoever is at the
		// wheel and validated server-side.
		this.vehicles = new MapSchema();
		// Authoritative time of day for the open-world day/night cycle, as a day
		// fraction in [0,1): 0 = midnight, 0.25 = sunrise, 0.5 = noon, 0.75 = sunset.
		// The server advances it (see WalkRoom) so every client in the world renders
		// the same sky and two players always agree on whether it's night.
		this.worldTime = 0;
		// Combat world entities (W07), both server-owned: roaming PvE mobs in the
		// danger zones, and death-drop tombstones anyone can loot. Kept at the end of
		// the schema (append-only) so an older client isn't shifted off the format.
		this.mobs = new MapSchema();
		this.tombstones = new MapSchema();
		// Generic placed/networked world objects (R01), balls, props, pickups,
		// keyed by object id. Durable build props in here are persisted per coin
		// world (R17); transient ones (the R05 ball) are not. Append-only at the end.
		this.objects = new MapSchema();
	}
}
defineTypes(WalkState, {
	players: { map: Player },
	coin: 'string',
	coinName: 'string',
	coinSymbol: 'string',
	coinImage: 'string',
	tier: 'string',
	holderMinUsd: 'float32',
	blocks: { map: Block },
	persistent: 'boolean',
	// Append-only: keep new collections at the end so a still-running older client
	// (pre-vehicles) isn't shifted off the wire format mid-deploy.
	vehicles: { map: Vehicle },
	worldTime: 'float32',
	mobs: { map: Mob },
	tombstones: { map: Tombstone },
	objects: { map: WorldObject },
	// Append-only (R24): a new scalar at the end so a still-running older client
	// isn't shifted off the wire format mid-deploy.
	holderMinTokens: 'float32',
	// Append-only: this room build understands the 'ready' join-snapshot handshake.
	// The client MUST check this before sending 'ready', because an older room
	// build answers an unknown message type by closing the socket with 4002, which
	// would kick every player on a client-before-server deploy.
	acceptsReady: 'boolean',
});

