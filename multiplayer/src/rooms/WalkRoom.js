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
import { socialHub } from '../social-hub.js';
import { verifyPresenceTicket } from '../presence-token.js';
import { verifyPlayPass } from '../play-pass.js';
import {
	restoreProfile, serializeProfile, profileSnapshot,
	addItem, hasRoomFor, resolveSlot, grantXp, consumeSlot,
	HOTBAR_SIZE,
} from '../economy.js';
import { itemLabel, fishCatchChance, fishDoubleChance } from '../items.js';
import { fishingSpotInRange } from '../world-features.js';
import { hydratePlayer, loadPlayer, savePlayer, flushPlayer } from '../playerStore.js';

// Platform entry gate (wallet-first sign-in + game-token balance). When a game
// token is pinned (PLAY_GATE_MINT, falling back to THREE_MINT) every join must
// carry a valid play pass — minted by api/play/verify after proving wallet
// ownership and a balance ≥ PLAY_GATE_MIN of that token. An unset mint leaves
// walk_world open exactly as before, so /walk and un-pinned deploys are
// unaffected. Read at boot: gate config doesn't change without a redeploy.
const PLAY_GATE_MINT = (process.env.PLAY_GATE_MINT || process.env.THREE_MINT || '').trim();
const PLAY_GATE_MIN = (() => {
	const n = Number(process.env.PLAY_GATE_MIN);
	return Number.isFinite(n) && n > 0 ? n : 1;
})();

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

// --- Economy & activities (off-schema) ------------------------------------
// A player's pack, purse and skills are PRIVATE to them — peers never render
// them in this free-roam world — so they live off the synced WalkState schema
// (kept in this.econ) and stream to the owning client via targeted messages.
// This keeps the shared /walk schema untouched and peers' wire cost at zero.
const FISH_COOLDOWN_MS = 1500;   // per-cast reel time (cadence on the real clock)
const CONSUME_COOLDOWN_MS = 1100; // pace between bites — no instant heal-spam
// Per-action rate ceilings (messages/sec/client) — a flooding client is dropped.
const ACTION_RATES = { fish: 6, consume: 6, equip: 30 };

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
		// Platform token gate (orthogonal to the per-coin holder tier below). When a
		// game token is pinned, no client reaches any world — General or Holders —
		// without a play pass proving a signed-in wallet holds ≥ the floor. Throw
		// (not return false) so a refusal arrives as a `play_pass`-prefixed error the
		// client routes back to its sign-in gate. The verified wallet is bound to the
		// session as the account id, never taken from an unsigned join option.
		if (PLAY_GATE_MINT) {
			const pass = verifyPlayPass(options?.playPass);
			if (!pass) throw new Error('play_pass_required');
			if (pass.mint !== PLAY_GATE_MINT) throw new Error('play_pass_mismatch');
			if (!(typeof pass.balance === 'number' && pass.balance >= PLAY_GATE_MIN)) {
				throw new Error('play_pass_required');
			}
			client.userData = { ...(client.userData || {}), account: pass.wallet, playBalance: pass.balance, playExp: pass.exp };
		}

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
		client.userData = { ...(client.userData || {}), holderUsd: pass.usd, holderWallet: pass.wallet, holderMinUsd: pass.minUsd };
		return true;
	}

	constructor() {
		super();
		this.maxClients = MAX_CLIENTS_PER_ROOM;
		this._moveCounters = new Map(); // sessionId → { windowStart, count }
		this._chatCooldowns = new Map();
		// Off-schema economy: sessionId → runtime profile (pack/purse/skills + the
		// stable persistence id + per-action cooldowns). Never synced to peers.
		this.econ = new Map();
		this._actionCounters = new Map(); // sessionId → { [action]: { windowStart, count } }
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
		// Economy & activities (off-schema). The owning client drives these and
		// receives the authoritative result via profile/inv/xpgain/levelup/notice.
		this.onMessage('fish', (client) => this._handleFish(client));
		this.onMessage('equip', (client, payload) => this._handleEquip(client, payload));
		this.onMessage('consume', (client, payload) => this._handleConsume(client, payload));
		this.onMessage('profileReq', (client) => this._sendProfile(client));
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

		// Re-check policy for the token gate. The game server has no RPC of its own,
		// so "still holding the token" is re-proven by the client minting a fresh
		// play pass (which re-reads the chain) before the current one's 10-min TTL
		// runs out and reconnecting — onAuth then re-validates. To actively evict a
		// wallet that offloaded below the floor mid-session, we sweep once a minute
		// and disconnect any client whose bound pass has expired without a refresh.
		// The client refreshes ahead of expiry, so a holder never sees this; only a
		// wallet that stopped qualifying (or a forged-then-expired pass) gets dropped.
		if (PLAY_GATE_MINT) {
			this.clock.setInterval(() => {
				const nowS = Date.now() / 1000;
				for (const client of this.clients) {
					const exp = client.userData?.playExp;
					if (typeof exp === 'number' && exp < nowS) {
						try { client.leave(4002, 'play_pass_required'); } catch {}
					}
				}
			}, 60_000);
		}
	}

	async onJoin(client, options) {
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
		// The account id is the wallet verified in onAuth — bound server-side, never
		// from a client option, so it's a trustworthy persistence + social-graph key.
		player.account = clean(client.userData?.account, 64);
		player.tsServer = Date.now();
		this.state.players.set(client.sessionId, player);

		// Friends presence (Task 15): a presence ticket signed by the three.ws API
		// proves which account this socket belongs to, independent of the wallet
		// holder gate. Register it so friends see this player as online in this
		// coin world and can DM them live. Spoof-proof — the account id comes from
		// the verified ticket, never a raw client option.
		const accountUid = verifyPresenceTicket(options?.presence);
		if (accountUid) {
			client.userData = { ...(client.userData || {}), accountUid };
			socialHub.register(accountUid, client, this.state.coinName || 'Mainland');
		}

		// Economy profile (off-schema). Keyed to a stable account: the wallet verified
		// in onAuth when the platform gate is on, else a client-persisted guest id, so
		// a player's pack/purse/skills survive a disconnect and follow them between
		// coin worlds. Hydrate the durable record before the synchronous load so a
		// returning player on a fresh process isn't reset to the starter kit.
		const playerId = clean(client.userData?.account, 80) || clean(options?.pid, 80) || client.sessionId;
		try { await hydratePlayer(playerId); } catch { /* memory-only fallback */ }
		// A slower-arriving leave could fire while we awaited; bail if so.
		if (!this.state.players.has(client.sessionId)) return;
		const saved = loadPlayer(playerId);
		const profile = restoreProfile(saved?.profile, playerId);
		profile.cd = { fish: 0, consume: 0 }; // per-action cooldown clocks (runtime only)
		this.econ.set(client.sessionId, profile);
		this._sendProfile(client);

		const tierTag = this.state.tier === 'holders' ? ' tier=holders' : '';
		console.log(
			`[walk_world ${this.roomId} coin=${this.state.coin || 'mainland'}${tierTag}] +join ${client.sessionId} ${name} (n=${this.state.players.size})`,
		);
	}

	onLeave(client) {
		if (client.userData?.accountUid) socialHub.unregister(client.userData.accountUid, client);
		// Persist the final economy state and arm a durable flush so progress survives
		// the disconnect and the room being torn down when the last player leaves.
		const profile = this.econ.get(client.sessionId);
		if (profile) {
			this._persistEcon(client.sessionId);
			if (profile.playerId) { try { flushPlayer(profile.playerId); } catch { /* best-effort */ } }
			this.econ.delete(client.sessionId);
		}
		this.state.players.delete(client.sessionId);
		this._moveCounters.delete(client.sessionId);
		this._chatCooldowns.delete(client.sessionId);
		this._editCounters?.delete(client.sessionId);
		this._emoteCooldowns?.delete(client.sessionId);
		this._voiceCounters?.delete(client.sessionId);
		this._actionCounters.delete(client.sessionId);
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
		// Flush any economy profiles still resident (a redeploy can dispose a room
		// with players mid-session) so no progression is lost between the last
		// change and the room going away.
		try {
			await Promise.allSettled([...this.econ.values()]
				.map((p) => p.playerId && flushPlayer(p.playerId)).filter(Boolean));
		} catch { /* best-effort */ }
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

	// --- Economy & activities ------------------------------------------------

	// Send the owning client its full economy snapshot (purse, vitals, pack,
	// hotbar, per-skill level + bar boundaries). Sent on join and on demand.
	_sendProfile(client) {
		const profile = this.econ.get(client.sessionId);
		if (!profile) return;
		client.send('profile', profileSnapshot(profile));
	}

	// Send just the mutable economy slice after a change the client can't infer
	// (a catch, an eat, a purse change) — lighter than a full profile resend.
	_sendInv(client, profile) {
		client.send('inv', {
			inv: profile.inv.map((s) => ({ item: s.item, qty: s.qty })),
			hotbar: profile.hotbar.map((s) => ({ item: s.item, qty: s.qty })),
			activeSlot: profile.activeSlot,
			gold: profile.gold,
			hp: profile.hp,
			maxHp: profile.maxHp,
		});
	}

	// Grant XP and tell the earner: the gain (for the float), their new cumulative
	// XP + level boundaries (for an exact bar), and a level-up when one is crossed.
	_grantXp(client, profile, skill, amount) {
		const res = grantXp(profile, skill, amount);
		if (!res) return;
		client.send('xpgain', {
			skill: res.skill, amount: res.amount, xp: res.xp,
			level: res.level, levelXp: res.levelXp, nextXp: res.nextXp,
		});
		if (res.leveledUp) client.send('levelup', { skill: res.skill, level: res.level });
	}

	// Cast a line. Validates (rod on the active slot, beside a pond, off cooldown,
	// room in the pack) then rolls a catch against fishing skill + pond quality.
	// Every cast arms the per-cast cooldown so casting has cadence on the real
	// clock; the client renders the line/bobber while the result rides back here.
	_handleFish(client) {
		const player = this.state.players.get(client.sessionId);
		const profile = this.econ.get(client.sessionId);
		if (!player || !profile) return;
		if (!this._actionOk(client.sessionId, 'fish')) return;

		const now = Date.now();
		if (now < profile.cd.fish) return; // still reeling in the previous cast

		const active = profile.hotbar[profile.activeSlot];
		if (!active || active.item !== 'rod') {
			client.send('notice', { kind: 'tool', text: 'Equip a fishing rod to cast.' });
			return;
		}
		const spot = fishingSpotInRange(player.x, player.z);
		if (!spot) {
			client.send('notice', { kind: 'fish', text: 'Move next to the water to cast.' });
			return;
		}
		if (!hasRoomFor(profile, 'fish')) {
			client.send('notice', { kind: 'full', text: 'Your inventory is full.' });
			return;
		}

		profile.cd.fish = now + FISH_COOLDOWN_MS;
		const lvl = profile.levels.fishing || 1;
		const quality = spot.quality || 1;

		if (Math.random() < fishCatchChance(lvl, quality)) {
			const want = 1 + (Math.random() < fishDoubleChance(lvl, quality) ? 1 : 0);
			const leftover = addItem(profile, 'fish', want);
			const caught = want - leftover;
			if (caught <= 0) {
				client.send('notice', { kind: 'full', text: 'Your inventory is full.' });
				return;
			}
			const xp = Math.round((10 + Math.floor(Math.random() * 6) + lvl * 0.3) * quality) * caught;
			this._grantXp(client, profile, 'fishing', xp);
			this._sendInv(client, profile);
			client.send('notice', { kind: 'fish', caught, text: caught > 1 ? `Caught ${caught} ${itemLabel('fish').toLowerCase()}!` : `Caught a ${itemLabel('fish').toLowerCase()}.` });
		} else {
			this._grantXp(client, profile, 'fishing', 2);
			client.send('notice', { kind: 'fish', caught: 0, text: 'The fish got away.' });
		}
		this._persistEcon(client.sessionId);
	}

	// Select a hotbar slot (what the player is "holding"). -1 clears the hand.
	_handleEquip(client, payload) {
		const profile = this.econ.get(client.sessionId);
		if (!profile) return;
		if (!this._actionOk(client.sessionId, 'equip')) return;
		const i = payload?.slot | 0;
		if (i < -1 || i >= HOTBAR_SIZE) return;
		profile.activeSlot = i;
		this._sendInv(client, profile);
	}

	// Eat an edible from a referenced slot, healing scaled by cooking level.
	_handleConsume(client, payload) {
		const profile = this.econ.get(client.sessionId);
		if (!profile) return;
		if (!this._actionOk(client.sessionId, 'consume')) return;
		const now = Date.now();
		if (now < profile.cd.consume) return;
		const slot = resolveSlot(profile, payload?.slot);
		if (!slot) return;
		const res = consumeSlot(profile, slot);
		if (!res.ok) {
			const text = res.reason === 'full' ? 'You’re already at full health.' : 'That can’t be eaten.';
			client.send('notice', { kind: 'eat', text });
			return;
		}
		profile.cd.consume = now + CONSUME_COOLDOWN_MS;
		this._sendInv(client, profile);
		client.send('notice', { kind: 'eat', text: `+${res.gained} HP.` });
		this._persistEcon(client.sessionId);
	}

	// Write this session's economy profile through to the account-keyed store,
	// merging onto any existing record so non-economy fields (e.g. a /game profile
	// for the same account) are preserved. Synchronous + debounced like GameRoom.
	_persistEcon(sessionId) {
		const profile = this.econ.get(sessionId);
		if (!profile || !profile.playerId) return;
		const player = this.state.players.get(sessionId);
		const prev = loadPlayer(profile.playerId) || {};
		savePlayer(profile.playerId, {
			...prev,
			name: player?.name || prev.name,
			gold: profile.gold,
			profile: serializeProfile(profile),
		});
	}

	// Per-action sliding-window rate limit (messages/sec/client). A flooding client
	// is silently dropped for the offending action; legitimate cadence passes.
	_actionOk(sessionId, action) {
		const limit = ACTION_RATES[action] || 10;
		const now = Date.now();
		let buckets = this._actionCounters.get(sessionId);
		if (!buckets) { buckets = {}; this._actionCounters.set(sessionId, buckets); }
		let b = buckets[action];
		if (!b || now - b.windowStart > 1000) { b = { windowStart: now, count: 0 }; buckets[action] = b; }
		b.count++;
		return b.count <= limit;
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
