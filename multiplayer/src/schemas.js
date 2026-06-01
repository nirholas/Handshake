// Schema definitions shared between the WalkRoom (server) and the client.
//
// @colyseus/schema uses delta encoding: only fields that changed since the
// last patch are sent over the wire. Keep this schema small and primitive —
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
		// Verified Solana wallet address bound at sign-in — the account id this
		// player persists under and is known by in the social graph. Empty in the
		// open (un-gated) world; set from the play pass when the token gate is on.
		this.account = '';
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
});

// A single placed voxel in a coin's world. Keyed in the blocks MapSchema by its
// packed grid coordinate ("gx,gy,gz"), so the position never has to ride on the
// wire — only the block type does. Delta encoding then makes a place/break a
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
		// two isolated rooms — General and Holders — kept apart by filterBy.
		this.tier = '';
		this.holderMinUsd = 0; // USD floor for the holder world (0 in General)
		// Collaborative voxel builds for this coin's world. Keyed by packed grid
		// coordinate; the value carries only the block type. Persisted per coin so
		// a community's build survives the room emptying and the server restarting.
		this.blocks = new MapSchema();
		// True when this world's build is backed by durable cross-restart storage
		// (Upstash Redis). False = memory-only: the build survives the room emptying
		// but not a full server restart. The client surfaces this so builders know
		// whether their creation is saved for keeps.
		this.persistent = false;
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
});
