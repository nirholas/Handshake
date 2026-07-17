// Schema definitions for the shared AR Studio world (studio_world room), shared
// between StudioRoom (server) and src/ar/studio-net.js (client, bundled by Vite
// the same way it bundles the irl/walk schemas).
//
// Unlike irl_world (presence + reactions only, pins are private-by-location and
// REST-gated), studio_world IS a shared scene transport by design: a studio room
// is an INTENTIONAL collaborative session two or more people opt into by holding
// the same room key (a shared code, or the same QR marker they both scan). So the
// placed models ARE the synced state — every add/move/scale/rotate/remove
// delta-broadcasts to everyone in the room, and a late joiner receives the whole
// current scene on join. This lives on the WalkRoom side of the privacy line
// (an opted-into shared world), never by loosening irl_world.
//
// Coordinate frame: relEast / relNorth are shared LOGICAL metres from the room's
// common origin, decoupled from any one device's camera. A plain (non-co-located)
// viewer maps them to their own local floor (origin = where they started); two
// phones that scanned the same QR marker map them to the SAME physical spot via
// the marker frame (src/irl/marker-anchor.js). Yaw is degrees. This is the one
// schema-level difference from WalkRoom's world-frame x/z — everything else
// (owner gating, caps, rate limits, delta sync) mirrors it.
//
// IMPORTANT: @colyseus/schema's binary protocol is POSITIONAL. Field indices are
// load-bearing across a rolling deploy — always APPEND new fields at the end,
// never insert in the middle, or an older still-connected client is shifted off
// the wire format mid-deploy.

import { Schema, MapSchema, defineTypes } from '@colyseus/schema';

// One placed model in the shared scene. `src` is the GLB URL every client loads
// (validated server-side: https or site-relative, length-capped). Transforms are
// in the room's shared logical frame (see header). `ownerId` is a stable per-
// browser key (the studio's forge:cid), so a reconnecting author keeps ownership.
export class StudioModel extends Schema {
	constructor() {
		super();
		this.id = '';
		this.src = '';        // GLB url (https or site-relative)
		this.title = '';      // human label, for the remote-model UI
		this.relEast = 0;     // shared logical metres, +east
		this.relNorth = 0;    // shared logical metres, +north
		this.yawDeg = 0;      // 0–360 heading
		this.scale = 1;       // uniform scale, clamped [0.25, 4]
		this.height = 0;      // fitted model height (m), for spawn-distance parity
		this.ownerId = '';    // stable browser key of the placer
		this.ts = 0;          // server epoch ms of the last change
	}
}
defineTypes(StudioModel, {
	id: 'string',
	src: 'string',
	title: 'string',
	relEast: 'float32',
	relNorth: 'float32',
	yawDeg: 'float32',
	scale: 'float32',
	height: 'float32',
	ownerId: 'string',
	ts: 'float64',
});

// A live participant in the room. Presence only — count + optional display name,
// so the studio can show "3 people building here." No location ever rides this.
export class StudioViewer extends Schema {
	constructor() {
		super();
		this.id = '';        // ephemeral session id
		this.name = '';      // short display name (optional)
		this.ownerId = '';   // stable browser key (ties a viewer to their models)
		this.tsServer = 0;   // last heartbeat epoch ms (drives the reaper)
	}
}
defineTypes(StudioViewer, {
	id: 'string',
	name: 'string',
	ownerId: 'string',
	tsServer: 'float64',
});

export class StudioState extends Schema {
	constructor() {
		super();
		// The room key (shared code or marker id) this instance serves — the
		// filterBy match key, identical for every participant in the instance.
		this.roomKey = '';
		// The shared scene: every placed model, keyed by id. Populated by
		// StudioRoom on model:spawn and pruned on model:remove / owner cleanup.
		this.models = new MapSchema();
		// Live participants, keyed by session id (presence + reaper).
		this.viewers = new MapSchema();
	}
}
defineTypes(StudioState, {
	roomKey: 'string',
	models: { map: StudioModel },
	viewers: { map: StudioViewer },
});
