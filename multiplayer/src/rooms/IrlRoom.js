// IrlRoom — the realtime presence + reaction hub for the three.ws /irl world.
//
// This room is deliberately NOT a pin transport. Placed agents are private by
// location: a pin's coordinates (and, for a shared room, its origin + offsets)
// are revealed only to a viewer who is physically within the nearby radius of it
// — through the per-viewer /api/irl/pins proximity read — never broadcast here as
// a browseable roster. An earlier design synced every pin in a ~3.6 km geocell
// window into this room's state and delta-broadcast it to every connected client,
// which handed anyone who joined a cell the exact GPS of every agent across a
// neighbourhood. That roster broadcast is gone: pins never enter the synced state
// and never leave the server over this socket.
//
// What this room DOES carry, both privacy-clean by construction:
//   - Presence (D2): each viewer is added at their own precision-6 cell centre +
//     bounded jitter (NEVER precise GPS), heartbeats refresh liveness, a reaper
//     prunes the stale ones; Colyseus delta-broadcasts the `viewers` map so every
//     client derives the "N viewing nearby" count and optional opt-in ghosts.
//   - Reactions (D3): an ambient { pinId, type, ts } flourish so a co-located
//     agent visibly emotes for bystanders. No GPS, no wallet, no actor identity.

import { Room } from '@colyseus/core';

import { IrlViewer, IrlState } from '../irl-schemas.js';
import { encodeGeohash, decodeGeohash } from '../geohash.js';
import { installUnknownMessageGuard } from '../room-compat.js';
import {
	isReactionType,
	reactionAllowed,
	pruneReactionLedger,
	REACTION_LEDGER_MAX,
} from '../irl-reactions.js';

const GEOCELL_RE = /^[0-9bcdefghjkmnpqrstuvwxyz]{6}$/; // precision-6 base32 (no a/i/l/o)
const PATCH_RATE_MS = 100;        // 10 Hz delta flush — well under the ~1 s liveness target
const MAX_CLIENTS = 200;          // a busy real-world spot; viewers only receive broadcasts

// ── D2 presence tuning ───────────────────────────────────────────────────────
const HEARTBEAT_STALE_MS = 30_000; // drop a viewer this long without a heartbeat
const REAPER_INTERVAL_MS = 10_000; // sweep cadence (≤ stale window, so a drop lands < HEARTBEAT_STALE_MS + this)
const MAX_VIEWERS = 200;           // cap the synced presence set (matches MAX_CLIENTS)
const GHOST_AVATAR_MAX = 1024;     // clamp a shared avatar URL
// Fraction of a cell's half-extent to jitter a viewer's marker within. < 1 keeps
// the marker inside the cell it claims, while spreading co-located viewers apart
// so two ghosts never stack perfectly. The jitter is set once on join and never
// moves (a heartbeat only refreshes heading/tsServer), so a ghost holds still.
const VIEWER_JITTER_FRAC = 0.55;

// Normalize an arbitrary heading input to an integer compass bearing 0–359, or 0.
function coerceHeading(v) {
	const n = Number(v);
	return Number.isFinite(n) ? ((Math.round(n) % 360) + 360) % 360 : 0;
}

export class IrlRoom extends Room {
	constructor() {
		super();
		this.maxClients = MAX_CLIENTS;
		this.geocell = '';
		// D3 debounce ledger: `${sessionId} ${pinId}` → lastTs of the last open/view
		// reaction, so a jittery tap can't spam every co-located phone (pay/message
		// bypass this entirely). Pruned when it crosses REACTION_LEDGER_MAX.
		this._reactionLedger = new Map();
	}

	async onCreate(options) {
		const cell = String(options?.geocell || '').toLowerCase();
		this.geocell = GEOCELL_RE.test(cell) ? cell : '';

		this.setState(new IrlState());
		this.state.geocell = this.geocell;
		this.setPatchRate(PATCH_RATE_MS);
		this.autoDispose = true;
		// Unknown message types are ignored, never a session kill (room-compat.js).
		installUnknownMessageGuard(this, 'irl');

		// D3 — a viewer interacted with a pin in this cell. Fan an ambient `reaction`
		// to everyone here so the agent visibly emotes for bystanders. This is the
		// flourish only; the durable record + owner notification ride the REST
		// `/api/irl/interactions` path, so we never write the DB here (no double count).
		this.onMessage('interaction', this._guard('interaction', (client, payload) => this._handleInteraction(client, payload)));

		// D2 presence — a heartbeat refreshes liveness + facing (so a backgrounded
		// tab that stops firing is reaped), and set_ghost flips a viewer's "appear to
		// others" opt-in live so the marker shows/hides without a reconnect.
		this.onMessage('heartbeat', this._guard('heartbeat', (client, payload) => this._handleHeartbeat(client, payload)));
		this.onMessage('set_ghost', this._guard('set_ghost', (client, payload) => this._handleSetGhost(client, payload)));

		// Reaper: drop viewers whose last heartbeat is stale. Covers silent
		// disconnects and backgrounded mobile tabs that never fire onLeave. The
		// clock is owned by the room and torn down automatically on dispose.
		this.clock.setInterval(() => this._reapStaleViewers(), REAPER_INTERVAL_MS);

		console.log(`${this._tag()} created (presence + reactions)`);
	}

	// Stable, PII-free log prefix for this room. The geocell is a coarse (~1 km)
	// public cell label, never a viewer's precise location, so it is safe to log.
	_tag() {
		return `[irl_world ${this.roomId} cell=${this.geocell || 'invalid'}]`;
	}

	// Wrap a message handler so a thrown error is logged (with context, no PII) and
	// contained — one malformed payload can never take down the room loop or leak a
	// stack to other viewers. Only the error message is logged, never the payload
	// (which could carry a device token) or any viewer coordinate.
	_guard(label, fn) {
		return (client, payload) => {
			try {
				fn(client, payload);
			} catch (err) {
				console.error(`${this._tag()} ${label} handler error:`, err?.message || err);
			}
		};
	}

	// D3 — turn a viewer's interaction into an ambient reaction for the whole cell.
	// Validates the type, debounces the noisy open/view types per (session, pin),
	// then broadcasts a privacy-clean { pinId, type, ts } to everyone in the room
	// (the sender included, so their own tap is driven by the same authoritative
	// event the others see). No GPS, no wallet, no actor identity ever rides this
	// channel — and because the room holds no pin state, a reaction for a pinId a
	// given client isn't rendering is simply a no-op on that client.
	_handleInteraction(client, payload) {
		const type = typeof payload?.type === 'string' ? payload.type : '';
		if (!isReactionType(type)) return;
		const pinId = String(payload?.pinId || '').slice(0, 64);
		if (!pinId) return;

		const now = Date.now();
		if (this._reactionLedger.size > REACTION_LEDGER_MAX) {
			pruneReactionLedger(this._reactionLedger, now);
		}
		if (!reactionAllowed(this._reactionLedger, client.sessionId, pinId, type, now)) return;

		this.broadcast('reaction', { pinId, type, ts: now }, { afterNextPatch: false });
	}

	onJoin(client, options) {
		// Bind the join context: the device token (D4 moderation attribution) and the
		// agent this viewer embodies. Nothing here ever reaches the synced state.
		client.userData = {
			deviceToken: typeof options?.deviceToken === 'string' ? options.deviceToken.slice(0, 80) : '',
			agentId: typeof options?.agent === 'string' ? options.agent.slice(0, 64) : '',
		};

		// D2 presence — add this viewer to the synced map so everyone in the cell
		// gets the live count (and, if they opted in, a ghost marker). The position
		// is the viewer's OWN precision-6 cell centre plus bounded jitter, computed
		// here and the raw GPS immediately discarded: the only location that leaves
		// the server is "somewhere in this ~1 km cell." Guarded by MAX_VIEWERS so a
		// flood can't bloat the state handed to every client.
		if (this.state.viewers.size >= MAX_VIEWERS) {
			// At capacity the join is accepted as a client (it still receives broadcasts)
			// but not synced into presence. Worth a warn — a cell pinned at the cap means
			// real viewers are missing from the "N nearby" count.
			console.warn(`${this._tag()} presence cap reached (${MAX_VIEWERS}) — join not synced to viewers`);
			return;
		}
		const ghost = options?.ghost === true;
		const viewer = new IrlViewer();
		viewer.id = client.sessionId;
		const pos = this._coarseViewerPos(Number(options?.lat), Number(options?.lng));
		viewer.lat = pos.lat;
		viewer.lng = pos.lng;
		viewer.agentId = client.userData.agentId;
		viewer.heading = coerceHeading(options?.heading);
		viewer.ghost = ghost;
		// A viewer only reveals an avatar when they opted into being seen.
		viewer.avatar = ghost && typeof options?.avatar === 'string' ? options.avatar.slice(0, GHOST_AVATAR_MAX) : '';
		viewer.tsServer = Date.now();
		this.state.viewers.set(client.sessionId, viewer);
		// Anonymous, aggregate-only: viewer COUNT and the coarse cell. No device token,
		// no agent id, no coordinate — presence is anonymous by construction and the log
		// keeps it that way. Lets ops see room liveness + spot a join/leave imbalance.
		console.log(`${this._tag()} +join (viewers=${this.state.viewers.size})`);
	}

	onLeave(client) {
		const had = this.state.viewers.delete(client.sessionId);
		if (had) console.log(`${this._tag()} -leave (viewers=${this.state.viewers.size})`);
	}

	// Heartbeat: prove the viewer is still here and refresh their facing. Updating
	// tsServer is what keeps the reaper from dropping them; heading rides along so a
	// shared ghost can be oriented. Never touches position — the join-time jitter is
	// the viewer's fixed coarse spot.
	_handleHeartbeat(client, payload) {
		const viewer = this.state.viewers.get(client.sessionId);
		if (!viewer) return;
		viewer.tsServer = Date.now();
		if (payload && payload.heading !== undefined) viewer.heading = coerceHeading(payload.heading);
	}

	// Live opt-in toggle: flip whether this viewer is rendered as a ghost for others
	// and carry the avatar to show (cleared the moment they opt out), so "Appear to
	// others nearby" takes effect immediately without a room rejoin.
	_handleSetGhost(client, payload) {
		const viewer = this.state.viewers.get(client.sessionId);
		if (!viewer) return;
		const ghost = payload?.ghost === true;
		viewer.ghost = ghost;
		viewer.avatar = ghost && typeof payload?.avatar === 'string' ? payload.avatar.slice(0, GHOST_AVATAR_MAX) : '';
		viewer.tsServer = Date.now();
	}

	// Snap a viewer's reported GPS to their own precision-6 cell centre and add
	// bounded jitter so the stored/broadcast coordinate is coarse by construction.
	// Falls back to this room's centre cell when the GPS is missing/invalid, so a
	// viewer with no fix still counts (at the cell centre) rather than at (0,0).
	_coarseViewerPos(lat, lng) {
		let cell = this.geocell;
		if (Number.isFinite(lat) && Number.isFinite(lng)) {
			const own = encodeGeohash(lat, lng, 6);
			if (GEOCELL_RE.test(own)) cell = own;
		}
		const c = decodeGeohash(cell || this.geocell || '');
		const jLat = (Math.random() * 2 - 1) * c.latErr * VIEWER_JITTER_FRAC;
		const jLng = (Math.random() * 2 - 1) * c.lngErr * VIEWER_JITTER_FRAC;
		return { lat: c.lat + jLat, lng: c.lng + jLng };
	}

	// Drop viewers whose last heartbeat is older than the stale window. The client
	// heartbeats every 15 s, so a live viewer never trips this; only a silent drop
	// (closed laptop, backgrounded tab that stopped firing) does, within one sweep.
	_reapStaleViewers() {
		const cutoff = Date.now() - HEARTBEAT_STALE_MS;
		for (const [id, viewer] of this.state.viewers) {
			if (viewer.tsServer < cutoff) this.state.viewers.delete(id);
		}
	}

	onDispose() {
		this._reactionLedger.clear();
		console.log(`${this._tag()} disposed`);
	}
}

// Re-exported so callers (and tests) can derive a centre cell without importing
// geohash separately. Keeps the room's precision the single source of truth.
export { encodeGeohash };
