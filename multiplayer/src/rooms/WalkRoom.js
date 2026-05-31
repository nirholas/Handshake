// WalkRoom — authoritative state for the three.ws /walk experience.
//
// Players send 'move' messages 15× per second. The server validates each
// update (max-step clamp, world bounds, name length, message rate) and
// merges the result into the shared MapSchema. Colyseus's binary delta
// protocol broadcasts only fields that actually changed to every other
// client in the same room, at the configured patch rate.

import { Room } from '@colyseus/core';

import { Player, Block, WalkState } from '../schemas.js';
import { cleanAvatarUrl } from '../avatar-url.js';
import { blockStore } from '../block-store.js';
import { verifyHolderPass } from '../holder-pass.js';

const MAX_CLIENTS_PER_ROOM = 50;
const PATCH_RATE_HZ = 15;
const PATCH_RATE_MS = 1000 / PATCH_RATE_HZ;

// --- Collaborative voxel building -----------------------------------------
// Builds live on an integer grid centred on the world origin. The server works
// purely in grid cells (unit-agnostic); the client maps a cell to metres via
// its BLOCK size. These caps must mirror the client's (build-voxels.js):
//   - a circular build area of MAX_GRID_XZ cells radius (keeps builds on the
//     plaza, away from the far hills),
//   - a height ceiling of MAX_GRID_Y cells,
//   - BLOCK_TYPE_COUNT palette entries,
//   - and a hard per-world block budget so one room can't balloon memory or the
//     join-time state sync.
const MAX_GRID_XZ = 30;
const MAX_GRID_Y = 24;
const BLOCK_TYPE_COUNT = 10;
const MAX_BLOCKS = 6000;
// Building is bursty (drag-to-place), so allow a higher rate than movement but
// still cap it so a scripted client can't flood the room.
const EDITS_PER_SEC_LIMIT = 20;

// Anti-cheat: reject any movement update that would move the player farther
// than this in a single message. The client sends moves at ~15Hz, so even at
// the run speed (4 m/s) a legitimate delta is ~0.27 m. We allow generous
// headroom for packet timing jitter.
const MAX_STEP_M = 1.2;

// World bounds — match the ground disc radius in src/walk.js so the visual
// ground and the authoritative area stay aligned. In AR mode the client lets
// the avatar roam freely, but we still clamp on the server so a malicious
// client can't broadcast nonsense positions.
const WORLD_RADIUS_M = 60;

// Rate limit incoming 'move' messages per client to twice the expected rate
// so legitimate jitter passes but a flooding client gets dropped.
const MOVES_PER_SEC_LIMIT = PATCH_RATE_HZ * 2;
const MOVE_WINDOW_MS = 1000;

const MOTION_VALUES = new Set(['idle', 'walk', 'run']);

// Spatial voice signaling. The room only relays SDP/ICE between two peers (the
// audio itself flows peer-to-peer over WebRTC), so the cap just has to clear a
// connection handshake's burst of candidates without letting a client flood the
// relay. SDP/ICE are small; anything larger than the cap is rejected outright.
const VOICE_SIGNALS_PER_SEC_LIMIT = 60;
const MAX_VOICE_SIGNAL_BYTES = 16_000;

// Solana mint addresses are base58, 32–44 chars. Anything else (including '')
// collapses to the default mainland world.
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
function cleanCoin(v) {
	const s = typeof v === 'string' ? v.trim() : '';
	return MINT_RE.test(s) ? s : '';
}

// Access tier. Only 'holders' is gated; anything else (including '') is the open
// General world. A coin's General and Holders worlds are kept in separate room
// instances by filterBy(['coin','tier']) — see multiplayer/src/index.js.
function cleanTier(v) {
	return v === 'holders' ? 'holders' : '';
}

function clean(str, maxLen) {
	if (typeof str !== 'string') return '';
	// Strip control chars, collapse whitespace, trim, cap length.
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
	// HSL → 0xRRGGBB. Sat 65%, lightness 60% gives high-contrast jersey colors.
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

export class WalkRoom extends Room {
	// Players are matched into the same room instance only when their `coin`
	// join option matches — so each coin community is an isolated world while a
	// single room definition serves them all. Coin-less players share the
	// default mainland instance.
	//
	// Tier gate: the General world ('') is open to everyone. The Holders world
	// ('holders') admits a client only with a valid holder pass — an HMAC-signed
	// token the API mints after pricing the user's authenticated wallet against
	// HOLDER_MIN_USD of this exact coin. We verify the pass here, before onJoin,
	// and reject otherwise. Returning false makes Colyseus answer the
	// matchmake/seat request with a 401 the client surfaces as the locked gate.
	static onAuth(client, options) {
		const tier = cleanTier(options?.tier);
		if (tier !== 'holders') return true; // open General world

		// A holder world must name a real coin. Throw (rather than return false) so
		// every holder-gate refusal reaches the client as a `holder_pass`-prefixed
		// error its gate UI routes on — a uniform denial contract.
		const coin = cleanCoin(options?.coin);
		if (!coin) throw new Error('holder_pass_required');

		const pass = verifyHolderPass(options?.holderPass);
		if (!pass) {
			throw new Error('holder_pass_required');
		}
		// The pass is for this exact coin's holder tier — a pass minted for coin A
		// can't unlock coin B's holder world.
		if (pass.mint !== coin || pass.tier !== 'holders') {
			throw new Error('holder_pass_mismatch');
		}
		// Carry the verified holding + signed floor through to onJoin/onCreate so
		// in-world affordances and the displayed requirement come from the pass,
		// never from unsigned client options.
		client.userData = { holderUsd: pass.usd, holderWallet: pass.wallet, holderMinUsd: pass.minUsd };
		return true;
	}

	constructor() {
		super();
		this.maxClients = MAX_CLIENTS_PER_ROOM;
		this._moveCounters = new Map(); // sessionId → { windowStart, count }
		this._chatCooldowns = new Map();
	}

	async onCreate(options) {
		this.setState(new WalkState());
		this.setPatchRate(PATCH_RATE_MS);
		this.autoDispose = true;

		// The first client to land in this coin's instance seeds its identity.
		this.state.coin = cleanCoin(options?.coin);
		this.state.coinName = clean(options?.coinName, 48);
		this.state.coinSymbol = clean(options?.coinSymbol, 16);
		this.state.coinImage = cleanAvatarUrl(options?.coinImage) || (
			typeof options?.coinImage === 'string' && options.coinImage.startsWith('http')
				? options.coinImage.slice(0, 1024) : '');
		// Tier identity. The Holders world records the USD floor it gated on (from
		// the joining pass) so the client HUD can state the requirement; the General
		// world leaves both blank/zero.
		this.state.tier = cleanTier(options?.tier);
		if (this.state.tier === 'holders') {
			// The displayed floor comes from the signed pass (the issuer's real
			// HOLDER_MIN_USD), not the client's unsigned `holderMinUsd` option which a
			// malicious first-joiner could otherwise use to misstate the requirement
			// for everyone in the room. Fall back to the server's own env, then 8.
			const signed = verifyHolderPass(options?.holderPass)?.minUsd;
			const envMin = Number(process.env.HOLDER_MIN_USD);
			this.state.holderMinUsd = Number.isFinite(signed) && signed > 0
				? signed
				: (Number.isFinite(envMin) && envMin > 0 ? envMin : 8);
		}
		// Persisted-build key. General and Holders are separate worlds for the same
		// coin, so their voxel builds must persist independently — otherwise the two
		// rooms would load and flush over each other's creation.
		this.worldKey = this.state.tier === 'holders' ? `${this.state.coin}#holders` : this.state.coin;

		this.onMessage('move', (client, payload) => this._handleMove(client, payload));
		this.onMessage('rename', (client, payload) => this._handleRename(client, payload));
		this.onMessage('emote', (client, payload) => this._handleEmote(client, payload));
		this.onMessage('chat', (client, payload) => this._handleChat(client, payload));
		this.onMessage('avatar', (client, payload) => this._handleAvatar(client, payload));
		this.onMessage('place', (client, payload) => this._handlePlace(client, payload));
		this.onMessage('remove', (client, payload) => this._handleRemove(client, payload));
		this.onMessage('voice-state', (client, payload) => this._handleVoiceState(client, payload));
		this.onMessage('voice-signal', (client, payload) => this._handleVoiceSignal(client, payload));
		this._emoteCooldowns = new Map();
		this._editCounters = new Map(); // sessionId → { windowStart, count }
		this._voiceCounters = new Map(); // sessionId → { windowStart, count }

		// Rehydrate this coin's persisted build before the first client renders the
		// world, so newcomers always drop into the community's existing creation.
		try {
			const saved = await blockStore.load(this.worldKey);
			for (const [key, type] of saved) {
				const b = new Block();
				b.t = type;
				this.state.blocks.set(key, b);
			}
			if (saved.size) {
				console.log(`[walk_world ${this.roomId} coin=${this.state.coin || 'mainland'}] restored ${saved.size} blocks`);
			}
		} catch (err) {
			console.warn(`[walk_world ${this.roomId}] block restore failed:`, err?.message);
		}
		// Tell builders, honestly, whether this world survives a server restart.
		// load() above already awaited the store's readiness probe, so durability
		// is settled by now.
		await blockStore.ready();
		this.state.persistent = blockStore.durable;
	}

	onJoin(client, options) {
		const name = clean(options?.name, 24) || `guest-${client.sessionId.slice(0, 4)}`;
		const player = new Player();
		player.id = client.sessionId;
		player.name = name;
		player.color = pickPlayerColor(client.sessionId);
		player.x = 0;
		player.y = 0;
		player.z = 0;
		player.yaw = 0;
		player.motion = 'idle';
		player.avatar = cleanAvatarUrl(options?.avatar);
		player.agent = clean(options?.agent, 64);
		player.tsServer = Date.now();
		this.state.players.set(client.sessionId, player);
		const tierTag = this.state.tier === 'holders' ? ' tier=holders' : '';
		console.log(
			`[walk_world ${this.roomId} coin=${this.state.coin || 'mainland'}${tierTag}] +join ${client.sessionId} ${name} (n=${this.state.players.size})`,
		);
	}

	onLeave(client) {
		this.state.players.delete(client.sessionId);
		this._moveCounters.delete(client.sessionId);
		this._chatCooldowns.delete(client.sessionId);
		this._editCounters?.delete(client.sessionId);
		this._emoteCooldowns?.delete(client.sessionId);
		this._voiceCounters?.delete(client.sessionId);
		console.log(
			`[walk_world ${this.roomId}] -leave ${client.sessionId} (n=${this.state.players.size})`,
		);
	}

	async onDispose() {
		// Persist the final build so the community's creation survives the room
		// being torn down when the last player leaves. Awaited (Colyseus waits on
		// the returned promise) so the Redis write lands before the room is gone —
		// fire-and-forget here would race the process exiting on a redeploy.
		try {
			await blockStore.flush(this.worldKey);
		} catch (err) {
			console.warn(`[walk_world ${this.roomId}] final flush failed:`, err?.message);
		}
		console.log(`[walk_world ${this.roomId}] disposed`);
	}

	_handleMove(client, payload) {
		const player = this.state.players.get(client.sessionId);
		if (!player) return;

		if (!this._rateOk(client.sessionId)) return;

		if (!payload || typeof payload !== 'object') return;
		const { x, y, z, yaw, motion } = payload;
		if (
			typeof x !== 'number' ||
			typeof y !== 'number' ||
			typeof z !== 'number' ||
			typeof yaw !== 'number' ||
			!Number.isFinite(x) ||
			!Number.isFinite(y) ||
			!Number.isFinite(z) ||
			!Number.isFinite(yaw)
		) {
			return;
		}

		// Max-step clamp — reject teleports.
		const dx = x - player.x;
		const dz = z - player.z;
		if (Math.hypot(dx, dz) > MAX_STEP_M) {
			// Don't update position, but allow yaw/motion changes (legitimate
			// when the client respawns or recovers from a temporary disconnect).
			player.yaw = yaw;
			if (MOTION_VALUES.has(motion)) player.motion = motion;
			player.tsServer = Date.now();
			return;
		}

		// World bounds clamp.
		const r = Math.hypot(x, z);
		if (r > WORLD_RADIUS_M) {
			const k = WORLD_RADIUS_M / r;
			player.x = x * k;
			player.z = z * k;
		} else {
			player.x = x;
			player.z = z;
		}
		player.y = Math.max(-10, Math.min(10, y)); // keep avatars near the ground plane
		player.yaw = yaw;
		if (MOTION_VALUES.has(motion)) player.motion = motion;
		player.tsServer = Date.now();
	}

	_handleRename(client, payload) {
		const player = this.state.players.get(client.sessionId);
		if (!player) return;
		const name = clean(payload?.name, 24);
		if (!name) return;
		player.name = name;
	}

	_handleEmote(client, payload) {
		const player = this.state.players.get(client.sessionId);
		if (!player) return;
		const name = clean(payload?.name, 32);
		if (!name) return;
		const now = Date.now();
		const lastEmote = this._emoteCooldowns.get(client.sessionId) || 0;
		if (now - lastEmote < 2000) return;
		this._emoteCooldowns.set(client.sessionId, now);
		player.emote = name;
		player.emoteTs = now;
	}

	_handleChat(client, payload) {
		const player = this.state.players.get(client.sessionId);
		if (!player) return;
		const text = clean(payload?.text, 200);
		if (!text) return;
		// One message per 700ms per client — enough for conversation, not spam.
		const now = Date.now();
		const last = this._chatCooldowns.get(client.sessionId) || 0;
		if (now - last < 700) return;
		this._chatCooldowns.set(client.sessionId, now);
		// Relay to everyone (including the sender, so their own bubble is driven
		// by the same authoritative event the others see).
		this.broadcast('chat', { id: client.sessionId, name: player.name, text, ts: now });
	}

	_handleAvatar(client, payload) {
		// Lets a client swap avatar mid-session (e.g. after picking a new one)
		// without rejoining the room.
		const player = this.state.players.get(client.sessionId);
		if (!player) return;
		const url = cleanAvatarUrl(payload?.avatar);
		if (url) player.avatar = url;
		if (typeof payload?.agent === 'string') player.agent = clean(payload.agent, 64);
	}

	// --- Spatial voice (WebRTC) ---------------------------------------------
	// The room never touches audio: it only flips a per-player "in voice" flag so
	// peers know who to connect to, and relays SDP/ICE between two specific peers.

	_handleVoiceState(client, payload) {
		const player = this.state.players.get(client.sessionId);
		if (!player) return;
		player.voice = !!(payload && payload.on);
	}

	_handleVoiceSignal(client, payload) {
		if (!this.state.players.has(client.sessionId)) return;
		if (!payload || typeof payload !== 'object') return;
		const to = typeof payload.to === 'string' ? payload.to : '';
		if (!to || to === client.sessionId) return;
		const data = payload.data;
		if (!data || typeof data !== 'object') return;
		if (!this._voiceOk(client.sessionId)) return;
		// SDP/ICE are small; reject anything oversized rather than relay it.
		let size = 0;
		try { size = JSON.stringify(data).length; } catch { return; }
		if (size > MAX_VOICE_SIGNAL_BYTES) return;
		const target = this.clients.find((c) => c.sessionId === to);
		if (!target) return;
		target.send('voice-signal', { from: client.sessionId, data });
	}

	_voiceOk(sessionId) {
		const now = Date.now();
		let bucket = this._voiceCounters.get(sessionId);
		if (!bucket || now - bucket.windowStart > 1000) {
			bucket = { windowStart: now, count: 0 };
			this._voiceCounters.set(sessionId, bucket);
		}
		bucket.count++;
		return bucket.count <= VOICE_SIGNALS_PER_SEC_LIMIT;
	}

	// Validate a {x,y,z} grid cell from a place/remove message. Returns the packed
	// key string when the cell is a legal, in-bounds integer coordinate, else null.
	_cellKey(payload) {
		if (!payload || typeof payload !== 'object') return null;
		const { x, y, z } = payload;
		if (![x, y, z].every((v) => Number.isInteger(v))) return null;
		if (y < 0 || y >= MAX_GRID_Y) return null;
		if (Math.abs(x) > MAX_GRID_XZ || Math.abs(z) > MAX_GRID_XZ) return null;
		// Circular build area, matching the round plaza the client clamps movement to.
		if (Math.hypot(x, z) > MAX_GRID_XZ) return null;
		return `${x},${y},${z}`;
	}

	// Tell one client an edit didn't land, and why, so the build HUD can explain a
	// block that never appeared instead of leaving the player guessing. The client
	// throttles these into a single toast, so a flood reply is harmless.
	_rejectEdit(client, reason) {
		client.send('edit-reject', { reason });
	}

	_handlePlace(client, payload) {
		if (!this.state.players.has(client.sessionId)) return;
		if (!this._editOk(client.sessionId)) { this._rejectEdit(client, 'rate'); return; }
		const key = this._cellKey(payload);
		if (key === null) { this._rejectEdit(client, 'bounds'); return; }
		const t = payload.t;
		if (!Number.isInteger(t) || t < 0 || t >= BLOCK_TYPE_COUNT) { this._rejectEdit(client, 'type'); return; }
		const existing = this.state.blocks.get(key);
		// New cell — enforce the per-world budget. Re-painting an existing cell
		// (changing its type) is always allowed since it doesn't grow the world.
		if (!existing && this.state.blocks.size >= MAX_BLOCKS) { this._rejectEdit(client, 'budget'); return; }
		if (existing) {
			if (existing.t === t) return; // no-op
			existing.t = t;
		} else {
			const b = new Block();
			b.t = t;
			this.state.blocks.set(key, b);
		}
		blockStore.set(this.worldKey, key, t);
	}

	_handleRemove(client, payload) {
		if (!this.state.players.has(client.sessionId)) return;
		if (!this._editOk(client.sessionId)) { this._rejectEdit(client, 'rate'); return; }
		const key = this._cellKey(payload);
		if (key === null) { this._rejectEdit(client, 'bounds'); return; }
		if (!this.state.blocks.has(key)) return;
		this.state.blocks.delete(key);
		blockStore.delete(this.worldKey, key);
	}

	_editOk(sessionId) {
		const now = Date.now();
		let bucket = this._editCounters.get(sessionId);
		if (!bucket || now - bucket.windowStart > 1000) {
			bucket = { windowStart: now, count: 0 };
			this._editCounters.set(sessionId, bucket);
		}
		bucket.count++;
		return bucket.count <= EDITS_PER_SEC_LIMIT;
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
}
