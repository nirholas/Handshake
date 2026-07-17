// StudioRoom — the realtime shared scene for the AR Studio (studio_world room).
//
// A studio room is an INTENTIONAL collaborative session: two or more people opt
// in by holding the same room key (a shared code, or the same QR marker they both
// scan). Unlike irl_world (presence only; pins are private-by-location, REST-
// gated), the placed models here ARE the synced state — every add / move / scale
// / rotate / remove delta-broadcasts to the room, and a late joiner gets the whole
// scene on join. This sits on the WalkRoom side of the privacy line (an opted-into
// shared world), and reuses that room's discipline: finite-only payloads, owner-
// gated edits, per-client rate limiting, and per-room / per-owner caps.
//
// Transforms ride in the room's shared LOGICAL frame (relEast / relNorth metres,
// yawDeg) — see studio-schemas.js. The client maps them to its own local floor,
// or, when co-located via a QR marker, to the same physical spot.

import { Room } from '@colyseus/core';

import { StudioModel, StudioViewer, StudioState } from '../studio-schemas.js';
import { installUnknownMessageGuard } from '../room-compat.js';

const PATCH_RATE_MS = 100;         // 10 Hz delta flush
const MAX_CLIENTS = 32;            // a friendly shared build session, not a crowd
const MAX_MODELS = 48;             // per-room ceiling — keeps late-joiner load sane
const MAX_MODELS_PER_OWNER = 24;   // one person can't fill the room alone
const OPS_PER_SEC = 25;            // per-client message budget (spawn/update/remove)
const HEARTBEAT_STALE_MS = 30_000; // reap a participant silent this long
const REAPER_INTERVAL_MS = 10_000;
const MAX_VIEWERS = MAX_CLIENTS;

const SRC_MAX = 512;               // GLB url length cap
const STR_MAX = 120;               // title / name length cap
const OWNER_MAX = 80;
const ID_RE = /^[A-Za-z0-9_-]{1,48}$/;
const SCALE_MIN = 0.25;
const SCALE_MAX = 4;
const COORD_BOUND = 60;            // clamp placements to ±60 m of the shared origin

// Accept only a GLB the client could also load: an https URL or a site-relative
// path. Everything else (http, data:, blob:, javascript:, protocol-relative) is
// rejected — these arrive over the wire and are re-broadcast to every peer, so
// they are untrusted input. Mirrors normalizeGlbUrl in src/ar/studio-scene.js.
function validSrc(raw) {
	const s = String(raw || '').trim();
	if (!s || s.length > SRC_MAX) return '';
	if (s.startsWith('/') && !s.startsWith('//')) return s;
	try {
		const u = new URL(s);
		return u.protocol === 'https:' ? u.href : '';
	} catch {
		return '';
	}
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const num = (v, d = 0) => (Number.isFinite(v) ? v : d);

export class StudioRoom extends Room {
	constructor() {
		super();
		this.maxClients = MAX_CLIENTS;
		this.roomKey = '';
		this._modelSeq = 0;
		// Per-session op-rate ledger: sessionId → { windowStart, count }.
		this._opLedger = new Map();
	}

	onCreate(options) {
		this.roomKey = String(options?.roomKey || '').slice(0, 64);
		this.setState(new StudioState());
		this.state.roomKey = this.roomKey;
		this.setPatchRate(PATCH_RATE_MS);
		this.autoDispose = true;
		installUnknownMessageGuard(this, 'studio');

		this.onMessage('model:spawn', this._guard('model:spawn', (c, p) => this._handleSpawn(c, p)));
		this.onMessage('model:update', this._guard('model:update', (c, p) => this._handleUpdate(c, p)));
		this.onMessage('model:remove', this._guard('model:remove', (c, p) => this._handleRemove(c, p)));
		this.onMessage('heartbeat', this._guard('heartbeat', (c) => this._handleHeartbeat(c)));

		this.clock.setInterval(() => this._reapStaleViewers(), REAPER_INTERVAL_MS);
		console.log(`${this._tag()} created (shared scene)`);
	}

	_tag() {
		return `[studio_world ${this.roomId} key=${this.roomKey || '?'}]`;
	}

	// Contain a malformed payload: log the message, never the payload (which could
	// carry a client id), and keep the room loop alive.
	_guard(label, fn) {
		return (client, payload) => {
			try {
				fn(client, payload);
			} catch (err) {
				console.error(`${this._tag()} ${label} handler error:`, err?.message || err);
			}
		};
	}

	// Stable owner key: the browser's persistent studio client id when supplied,
	// else the ephemeral session id. Lets a reconnecting author keep ownership of
	// the models they placed.
	_ownerKey(client) {
		return client.userData?.ownerId || client.sessionId;
	}

	// Token-bucket-ish per-second op gate. Returns false (drop) when a client
	// exceeds OPS_PER_SEC in the current 1 s window — a flood can't spam the room.
	_opOk(sessionId) {
		const now = Date.now();
		let rec = this._opLedger.get(sessionId);
		if (!rec || now - rec.windowStart >= 1000) {
			rec = { windowStart: now, count: 0 };
			this._opLedger.set(sessionId, rec);
		}
		rec.count++;
		return rec.count <= OPS_PER_SEC;
	}

	_handleSpawn(client, payload) {
		if (!this.state.viewers.has(client.sessionId)) return;
		if (!this._opOk(client.sessionId)) return;
		if (!payload || typeof payload !== 'object') return;

		const src = validSrc(payload.src);
		if (!src) return; // never re-broadcast an unvetted URL
		if (!Number.isFinite(payload.relEast) || !Number.isFinite(payload.relNorth)) return;
		if (this.state.models.size >= MAX_MODELS) {
			client.send('model:reject', { reason: 'room_full' });
			return;
		}
		const owner = this._ownerKey(client);
		let owned = 0;
		for (const [, m] of this.state.models) if (m.ownerId === owner) owned++;
		if (owned >= MAX_MODELS_PER_OWNER) {
			client.send('model:reject', { reason: 'owner_full' });
			return;
		}

		const m = new StudioModel();
		// Accept a sane, unused client id, else mint a collision-free one — ids stay
		// server-controlled so a client can't overwrite a peer's model by id.
		let id = (typeof payload.id === 'string' && ID_RE.test(payload.id)) ? payload.id : '';
		if (!id || this.state.models.has(id)) id = `m_${client.sessionId.slice(0, 6)}_${++this._modelSeq}`;
		m.id = id;
		m.src = src;
		m.title = String(payload.title || '').slice(0, STR_MAX);
		m.relEast = clamp(num(payload.relEast), -COORD_BOUND, COORD_BOUND);
		m.relNorth = clamp(num(payload.relNorth), -COORD_BOUND, COORD_BOUND);
		m.yawDeg = ((num(payload.yawDeg) % 360) + 360) % 360;
		m.scale = clamp(num(payload.scale, 1), SCALE_MIN, SCALE_MAX);
		m.height = clamp(num(payload.height, 0), 0, 20);
		m.ownerId = owner;
		m.ts = Date.now();
		this.state.models.set(m.id, m);
	}

	_handleUpdate(client, payload) {
		if (!this._opOk(client.sessionId)) return;
		if (!payload || typeof payload.id !== 'string') return;
		const m = this.state.models.get(payload.id);
		if (!m) return;
		if (m.ownerId !== this._ownerKey(client)) return; // owner-only moves
		if (Number.isFinite(payload.relEast)) m.relEast = clamp(payload.relEast, -COORD_BOUND, COORD_BOUND);
		if (Number.isFinite(payload.relNorth)) m.relNorth = clamp(payload.relNorth, -COORD_BOUND, COORD_BOUND);
		if (Number.isFinite(payload.yawDeg)) m.yawDeg = ((payload.yawDeg % 360) + 360) % 360;
		if (Number.isFinite(payload.scale)) m.scale = clamp(payload.scale, SCALE_MIN, SCALE_MAX);
		m.ts = Date.now();
	}

	_handleRemove(client, payload) {
		if (!this._opOk(client.sessionId)) return;
		if (!payload || typeof payload.id !== 'string') return;
		const m = this.state.models.get(payload.id);
		if (!m) return;
		if (m.ownerId !== this._ownerKey(client)) return; // owner-only removes
		this.state.models.delete(payload.id);
	}

	_handleHeartbeat(client) {
		const v = this.state.viewers.get(client.sessionId);
		if (v) v.tsServer = Date.now();
	}

	onJoin(client, options) {
		client.userData = {
			ownerId: typeof options?.clientId === 'string' ? options.clientId.slice(0, OWNER_MAX) : '',
		};
		if (this.state.viewers.size >= MAX_VIEWERS) {
			console.warn(`${this._tag()} viewer cap reached (${MAX_VIEWERS})`);
			return;
		}
		const v = new StudioViewer();
		v.id = client.sessionId;
		v.name = String(options?.name || '').slice(0, STR_MAX);
		v.ownerId = client.userData.ownerId;
		v.tsServer = Date.now();
		this.state.viewers.set(client.sessionId, v);
		console.log(`${this._tag()} +join (viewers=${this.state.viewers.size}, models=${this.state.models.size})`);
	}

	onLeave(client) {
		// Presence goes; the models a departing author placed STAY for the room's
		// life so a shared scene doesn't collapse when one person drops (they can
		// rejoin and still own them). autoDispose clears everything once empty.
		const had = this.state.viewers.delete(client.sessionId);
		this._opLedger.delete(client.sessionId);
		if (had) console.log(`${this._tag()} -leave (viewers=${this.state.viewers.size})`);
	}

	_reapStaleViewers() {
		const cutoff = Date.now() - HEARTBEAT_STALE_MS;
		for (const [id, v] of this.state.viewers) {
			if (v.tsServer < cutoff) {
				this.state.viewers.delete(id);
				this._opLedger.delete(id);
			}
		}
	}

	onDispose() {
		this._opLedger.clear();
		console.log(`${this._tag()} disposed`);
	}
}
