// AgoraRoom — shared human presence for the playable Agora Commons (/agora).
//
// A deliberately slim sibling of WalkRoom: the Commons is a CITY-scale world
// (the OSM Manhattan square, ±680 m) where the NPCs — the AI-agent citizens and
// their on-chain economy — are driven entirely by the three.ws projection APIs
// every client already polls. This room replicates only the HUMANS walking the
// square: position/motion state, chat, avatar swaps. No voxels, vehicles,
// quests, economy, or gates — those are walk_world/coin-world features and the
// Agora economy is real (on-chain), not a room simulation.
//
// Why not a walk_world coin shard: WalkRoom's anti-cheat assumes a plaza-sized
// world (MAX_STEP_M 1.2 at a 5 m/s walk; WORLD_BOUND_M ≈ ±198). The Commons
// player sprints at 8.5 m/s across a ±680 m city, so those clamps would
// rubber-band every runner. Same protocol, city-scale constants.

import { Room } from '@colyseus/core';
import { Schema, MapSchema, defineTypes } from '@colyseus/schema';
import { Player } from '../schemas.js';
import { cleanAvatarUrl } from '../avatar-url.js';
import { installUnknownMessageGuard } from '../room-compat.js';

const MAX_CLIENTS = 50; // the server's proven per-room ceiling (WalkRoom)
const PATCH_RATE_HZ = 15;
const PATCH_RATE_MS = 1000 / PATCH_RATE_HZ;
// Clients send at ≤15 Hz; twice that tolerates bursts after a stall.
const MOVES_PER_SEC_LIMIT = PATCH_RATE_HZ * 2;
const MOVE_WINDOW_MS = 1000;
// The Commons runner tops out at 8.5 m/s → 0.57 m per 15 Hz tick. 1.5 m/step
// gives ×2.5 headroom for frame hitches without permitting teleports.
const MAX_STEP_M = 1.5;
// City bounds: CITY_HALF (700) − 20, matching the client's world edge exactly
// (src/agora/player-logic BOUNDS via CITY_HALF − 20).
const WORLD_BOUND_M = 680;
const MOTION_VALUES = new Set(['idle', 'walk', 'run']);
const CHAT_COOLDOWN_MS = 700;

function clean(str, maxLen) {
	if (typeof str !== 'string') return '';
	// Strip control chars, collapse whitespace, trim, cap length — WalkRoom's rule.
	return str
		.replace(/[\x00-\x1f\x7f]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, maxLen);
}

function pickPlayerColor(sessionId) {
	// Deterministic pleasant hue from sessionId — every client renders the
	// same player in the same color without us needing to sync it explicitly.
	let h = 0;
	for (let i = 0; i < sessionId.length; i++) {
		h = (h * 31 + sessionId.charCodeAt(i)) >>> 0;
	}
	const hue = h % 360;
	return hslToHex(hue / 360, 0.65, 0.6);
}

function hslToHex(h, s, l) {
	const k = (n) => (n + h * 12) % 12;
	const a = s * Math.min(l, 1 - l);
	const f = (n) => {
		const v = l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
		return Math.round(v * 255);
	};
	return (f(0) << 16) | (f(8) << 8) | f(4);
}

// One shared Commons: just the humans. Reuses the walk Player schema so the
// client's reflected-schema decode path (walk-net.js) works unchanged.
export class AgoraState extends Schema {
	constructor() {
		super();
		this.players = new MapSchema();
	}
}
defineTypes(AgoraState, {
	players: { map: Player },
});

export class AgoraRoom extends Room {
	constructor() {
		super();
		this.maxClients = MAX_CLIENTS;
		this._moveCounters = new Map(); // sessionId → { windowStart, count }
		this._chatCooldowns = new Map();
	}

	onCreate() {
		this.setState(new AgoraState());
		this.setPatchRate(PATCH_RATE_MS);
		this.autoDispose = true;
		// Unknown message types are ignored, never a session kill (room-compat.js).
		installUnknownMessageGuard(this, 'agora_world');

		this.onMessage('move', (client, payload) => this._handleMove(client, payload));
		this.onMessage('rename', (client, payload) => this._handleRename(client, payload));
		this.onMessage('emote', (client, payload) => this._handleEmote(client, payload));
		this.onMessage('chat', (client, payload) => this._handleChat(client, payload));
		this.onMessage('avatar', (client, payload) => this._handleAvatar(client, payload));

		console.log('[agora_world] room created');
	}

	onJoin(client, options) {
		const name = clean(options?.name, 24) || `visitor-${client.sessionId.slice(0, 4)}`;
		const player = new Player();
		player.id = client.sessionId;
		player.name = name;
		player.color = pickPlayerColor(client.sessionId);
		// Spawn beside the job board (the client's SPAWN) — peers appear where
		// newcomers actually stand rather than flashing at the origin first.
		player.x = 3.5;
		player.y = 0;
		player.z = -2.5;
		player.yaw = 0;
		player.motion = 'idle';
		player.avatar = cleanAvatarUrl(options?.avatar);
		// The agora citizen id this human is (or becomes) in the projection —
		// lets peers open each other's living passports from the square.
		player.agent = clean(options?.agent, 64);
		player.tsServer = Date.now();
		this.state.players.set(client.sessionId, player);
		console.log(`[agora_world] +${name} (${client.sessionId}) — ${this.state.players.size} in the square`);
	}

	onLeave(client) {
		const player = this.state.players.get(client.sessionId);
		this.state.players.delete(client.sessionId);
		this._moveCounters.delete(client.sessionId);
		this._chatCooldowns.delete(client.sessionId);
		console.log(`[agora_world] -${player?.name || client.sessionId} — ${this.state.players.size} in the square`);
	}

	_rateOk(sessionId) {
		const now = Date.now();
		let bucket = this._moveCounters.get(sessionId);
		if (!bucket || now - bucket.windowStart > MOVE_WINDOW_MS) {
			bucket = { windowStart: now, count: 0 };
			this._moveCounters.set(sessionId, bucket);
		}
		bucket.count++;
		return bucket.count <= MOVES_PER_SEC_LIMIT;
	}

	_handleMove(client, payload) {
		const player = this.state.players.get(client.sessionId);
		if (!player) return;
		if (!this._rateOk(client.sessionId)) return;
		if (!payload || typeof payload !== 'object') return;
		const { x, y, z, yaw, motion } = payload;
		if (
			typeof x !== 'number' || typeof y !== 'number' ||
			typeof z !== 'number' || typeof yaw !== 'number' ||
			!Number.isFinite(x) || !Number.isFinite(y) ||
			!Number.isFinite(z) || !Number.isFinite(yaw)
		) {
			return;
		}

		// Max-step clamp — reject teleports, allow yaw/motion (respawn recovery).
		const dx = x - player.x;
		const dz = z - player.z;
		if (Math.hypot(dx, dz) > MAX_STEP_M) {
			player.yaw = yaw;
			if (MOTION_VALUES.has(motion)) player.motion = motion;
			player.tsServer = Date.now();
			return;
		}

		player.x = Math.max(-WORLD_BOUND_M, Math.min(WORLD_BOUND_M, x));
		player.z = Math.max(-WORLD_BOUND_M, Math.min(WORLD_BOUND_M, z));
		// Ground is flat at y=0; the jump apex is ~1.7 m. A little slack, never sky.
		player.y = Math.max(-2, Math.min(10, y));
		player.yaw = yaw;
		if (MOTION_VALUES.has(motion)) player.motion = motion;
		player.tsServer = Date.now();
	}

	_handleRename(client, payload) {
		const player = this.state.players.get(client.sessionId);
		if (!player) return;
		const name = clean(payload?.name, 24);
		if (name) player.name = name;
	}

	_handleEmote(client, payload) {
		const player = this.state.players.get(client.sessionId);
		if (!player) return;
		const name = clean(payload?.name, 32);
		if (!name) return;
		player.emote = name;
		player.emoteTs = Date.now();
	}

	_handleChat(client, payload) {
		const player = this.state.players.get(client.sessionId);
		if (!player) return;
		const text = clean(payload?.text, 200);
		if (!text) return;
		// One message per 700ms per client — conversation, not spam.
		const now = Date.now();
		const last = this._chatCooldowns.get(client.sessionId) || 0;
		if (now - last < CHAT_COOLDOWN_MS) return;
		this._chatCooldowns.set(client.sessionId, now);
		// Relay to everyone (including the sender, so their own line is driven by
		// the same authoritative event the others see).
		this.broadcast('chat', { id: client.sessionId, name: player.name, text, ts: now });
	}

	_handleAvatar(client, payload) {
		const player = this.state.players.get(client.sessionId);
		if (!player) return;
		const url = cleanAvatarUrl(payload?.avatar);
		if (url) player.avatar = url;
		if (typeof payload?.agent === 'string') player.agent = clean(payload.agent, 64);
	}
}
