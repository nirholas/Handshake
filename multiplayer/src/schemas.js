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
		this.tsServer = 0;     // server-side last-update epoch ms (for interpolation)
	}
}
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
	tsServer: 'float64',
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
	}
}
defineTypes(WalkState, {
	players: { map: Player },
	coin: 'string',
	coinName: 'string',
	coinSymbol: 'string',
	coinImage: 'string',
});
