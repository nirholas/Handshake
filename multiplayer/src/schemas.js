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
	tsServer: 'float64',
});

export class WalkState extends Schema {
	constructor() {
		super();
		this.players = new MapSchema();
	}
}
defineTypes(WalkState, {
	players: { map: Player },
});
